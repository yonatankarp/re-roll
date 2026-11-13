import {
  type ContentAccess,
  type Decision,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
  frameHandler,
} from "#sdk";
import { z } from "zod";
import { type Context, canAfford, enemies } from "./combat.ts";
import { inReach } from "./combat/queries.ts";
import { encodeOption, parseOption } from "./combat/ids.ts";
import { FeatureSchema } from "./schemas.ts";
import {
  type Actor,
  type DndState,
  INCAPACITATING,
  NS,
  dndEvent,
  frame,
  hasCondition,
  isDown,
} from "./state.ts";
import { type KnownAction, type Stats, deriveStats, lookup } from "./stats.ts";
import { BACK } from "./targeting.ts";
import { TACTIC } from "./tactics.ts";
import {
  METAMAGIC_COSTS,
  type Metamagic,
  SORCERY_POINTS,
  TRANSMUTED_TYPES,
  fits,
  joins,
  markersOf,
  metamagicOf,
  metamagicSpentEvents,
} from "./metamagic.ts";

// A Sorcerer's turn options: putting a Metamagic option on a spell before casting it, and Font of Magic's trades
// between spell slots and Sorcery Points. Each is an option of the turn decision, so a save replays it.

const METAMAGIC = `${TACTIC}metamagic`;
const CANCEL = `${TACTIC}metamagic-cancel`;
const TO_POINTS = `${TACTIC}font-points`;
const TO_SLOT = `${TACTIC}font-slot`;

// Font of Magic's Creating Spell Slots table: the Sorcery Points a slot costs and the Sorcerer level it needs.
const CREATED_SLOTS = [
  { level: 1, points: 2, from: 2 },
  { level: 2, points: 3, from: 3 },
  { level: 3, points: 5, from: 5 },
  { level: 4, points: 6, from: 7 },
  { level: 5, points: 7, from: 9 },
] as const;

export function isClassOption(answer: string): boolean {
  return [METAMAGIC, CANCEL, TO_POINTS, TO_SLOT].includes(
    parseOption(answer)[0] ?? "",
  );
}

// Points not spent and not already promised to an option waiting on its spell.
function pointsLeft(actor: Actor, stats: Stats): number {
  const promised = markersOf(actor).reduce(
    (sum, item) => sum + METAMAGIC_COSTS[item.option],
    0,
  );
  return (
    (stats.resources[SORCERY_POINTS] ?? 0) -
    (actor.resourcesSpent[SORCERY_POINTS] ?? 0) -
    promised
  );
}

// Whether the spell could be cast now with the option, its Sorcery Points aside.
function castable(
  action: KnownAction,
  option: Metamagic,
  actor: Actor,
  stats: Stats,
  state: DndState,
  access: ContentAccess,
): boolean {
  const cost = action.activation.cost.flatMap((item) => {
    if (typeof item === "object" && item.resource === SORCERY_POINTS) return [];
    return [option === "quickened" && item === "action" ? "bonusAction" : item];
  });
  const waiting = markersOf(actor)
    .filter((item) => item.action === action.id)
    .map((item) => item.option);
  return (
    !action.activation.trigger &&
    fits(option, action) &&
    joins(option, waiting) &&
    canAfford(
      { ...action, activation: { ...action.activation, cost } },
      actor,
      stats,
    ) &&
    (option === "distant" || inReach(action, actor, state, access).length > 0)
  );
}

function spellsFor(
  option: Metamagic,
  actor: Actor,
  stats: Stats,
  state: DndState,
  access: ContentAccess,
): readonly KnownAction[] {
  return stats.actions.filter((action) =>
    castable(action, option, actor, stats, state, access),
  );
}

function knownOptions(stats: Stats): readonly [string, Metamagic][] {
  return stats.features.flatMap((id) => {
    const option = metamagicOf(id);
    return option ? [[id, option] as [string, Metamagic]] : [];
  });
}

function sorcererLevel(stats: Stats): number {
  return Object.entries(stats.classLevels).reduce(
    (most, [id, level]) => (id.endsWith("/sorcerer") ? level : most),
    0,
  );
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

function fontOptions(actor: Actor, stats: Stats): Decision["options"] {
  if (!stats.features.some((id) => id.endsWith("-font-of-magic"))) return [];
  if (stats.resources[SORCERY_POINTS] === undefined) return [];
  const spentPoints = actor.resourcesSpent[SORCERY_POINTS] ?? 0;
  const slotsLeft = (level: number): number =>
    (stats.slots[level - 1] ?? 0) -
    (actor.resourcesSpent[`slot:${String(level)}`] ?? 0);
  const options: { id: string; label: string }[] = [];
  // No action is needed, and points can't go past the table's number.
  stats.slots.forEach((_, index) => {
    const level = index + 1;
    if (spentPoints === 0 || slotsLeft(level) <= 0) return;
    options.push({
      id: encodeOption(TO_POINTS, level),
      label: `Font of Magic: turn a level ${String(level)} slot into ${plural(Math.min(level, spentPoints), "Sorcery Point")}`,
    });
  });
  // shortcut: a made slot fills one spent earlier, since a slot beyond the table's number has nowhere to be kept.
  if (actor.budget.bonusAction) {
    for (const { level, points, from } of CREATED_SLOTS) {
      if (
        sorcererLevel(stats) >= from &&
        pointsLeft(actor, stats) >= points &&
        (actor.resourcesSpent[`slot:${String(level)}`] ?? 0) > 0
      ) {
        options.push({
          id: encodeOption(TO_SLOT, level),
          label: `Font of Magic: make a level ${String(level)} slot (${plural(points, "Sorcery Point")}, Bonus Action)`,
        });
      }
    }
  }
  return options;
}

export function classOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): Decision["options"] {
  if (!state.combat || isDown(actor) || hasCondition(actor, ...INCAPACITATING))
    return [];
  if (actor.source.kind !== "character") return [];
  const stats = deriveStats(actor, access);
  const left = pointsLeft(actor, stats);
  const busy = new Set(markersOf(actor).map((item) => item.featureId));
  const options: { id: string; label: string }[] = [];
  for (const [featureId, option] of knownOptions(stats)) {
    const cost = METAMAGIC_COSTS[option];
    if (busy.has(featureId) || cost > left) continue;
    if (spellsFor(option, actor, stats, state, access).length === 0) continue;
    options.push({
      id: encodeOption(METAMAGIC, featureId),
      label: `Metamagic: ${lookup(access, FeatureSchema, featureId).name} (${plural(cost, "Sorcery Point")})`,
    });
  }
  if (busy.size > 0) {
    options.push({
      id: CANCEL,
      label: "Metamagic: drop what waits on a spell",
    });
  }
  return [...options, ...fontOptions(actor, stats)];
}

export function runClassOption(
  payload: { readonly actor: string; readonly answer: string },
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = state.actors[payload.actor];
  if (!actor) throw new Error(`Unknown actor ${payload.actor}`);
  const [kind = "", detail = ""] = parseOption(payload.answer);
  const stats = deriveStats(actor, context);
  switch (kind) {
    case METAMAGIC: {
      const option = metamagicOf(detail);
      if (!option) throw new Error(`${detail} isn't a Metamagic option`);
      const spells = spellsFor(option, actor, stats, state, context);
      const name = lookup(context, FeatureSchema, detail).name;
      return {
        frames: [
          awaitDecision({
            id: encodeOption(
              `${NS}:metamagic:${actor.id}:${String(state.combat?.round ?? 0)}`,
              detail,
            ),
            actor: actor.id,
            prompt: `${name}: on which spell?`,
            options: [
              ...spells.flatMap((spell) =>
                option === "transmuted"
                  ? TRANSMUTED_TYPES.flatMap((type, index) =>
                      spell.activation.resolution.damage.some(
                        (item) =>
                          item.type !== type &&
                          (TRANSMUTED_TYPES as readonly string[]).includes(
                            item.type,
                          ),
                      )
                        ? [
                            {
                              id: encodeOption(spell.id, index),
                              label: `${spell.name} as ${type}`,
                            },
                          ]
                        : [],
                    )
                  : [{ id: spell.id, label: spell.name }],
              ),
              { id: BACK, label: "Choose something else" },
            ],
            resume: frame("metamagic", { actor: actor.id, feature: detail }),
          }),
        ],
      };
    }
    case CANCEL:
      return {
        events: markersOf(actor).map((item) =>
          dndEvent(`${NS}:effectEnded`, {
            actor: actor.id,
            sourceId: item.featureId,
          }),
        ),
      };
    case TO_POINTS: {
      const level = Number(detail);
      const spent = actor.resourcesSpent[SORCERY_POINTS] ?? 0;
      return {
        events: [
          dndEvent(`${NS}:resourceSpent`, {
            actor: actor.id,
            resource: `slot:${detail}`,
          }),
          dndEvent(`${NS}:resourceRestored`, {
            actor: actor.id,
            resource: SORCERY_POINTS,
            amount: Math.min(level, spent),
          }),
        ],
      };
    }
    case TO_SLOT: {
      const row = CREATED_SLOTS.find((item) => String(item.level) === detail);
      if (!row) throw new Error(`No slot of level ${detail} can be made`);
      return {
        events: [
          dndEvent(`${NS}:budgetSpent`, {
            actor: actor.id,
            kind: "bonusAction",
          }),
          ...Array.from({ length: row.points }, (): SystemEvent =>
            dndEvent(`${NS}:resourceSpent`, {
              actor: actor.id,
              resource: SORCERY_POINTS,
            }),
          ),
          dndEvent(`${NS}:resourceRestored`, {
            actor: actor.id,
            resource: `slot:${detail}`,
            amount: 1,
          }),
        ],
        frames: [frame("afterAction", { actor: actor.id })],
      };
    }
    default:
      throw new Error(`Unknown class option ${payload.answer}`);
  }
}

const MetamagicSchema = z.object({
  actor: z.string(),
  feature: z.string(),
  answer: z.string(),
});

// Leaves the option waiting on the spell until the end of the turn, so the turn lists the spell changed.
function runMetamagic(
  payload: z.infer<typeof MetamagicSchema>,
  _context: Context,
): SystemResult {
  if (payload.answer === BACK) return {};
  const [action = "", type] = parseOption(payload.answer);
  return {
    events: [
      dndEvent(`${NS}:effectAdded`, {
        actor: payload.actor,
        effect: {
          sourceId: payload.feature,
          casterId: payload.actor,
          modifier: {
            kind: "tactic",
            tactic: "metamagic",
            action,
            ...(type === undefined ? {} : { value: Number(type) }),
          },
          ends: "casterTurnEnd",
        },
      }),
    ],
  };
}

const SpentSchema = z.object({ actor: z.string(), action: z.string() });

export const classOptionFrames = {
  [`${NS}:metamagic`]: frameHandler({
    schema: MetamagicSchema,
    run: runMetamagic,
  }),
  [`${NS}:metamagicSpent`]: frameHandler({
    schema: SpentSchema,
    run: (payload, context: Context) => {
      const actor = context.state.actors[payload.actor];
      return actor
        ? { events: metamagicSpentEvents(actor, payload.action) }
        : {};
    },
  }),
};

function damages(action: KnownAction): boolean {
  return action.activation.resolution.damage.length > 0;
}

// How companions and the bot use Metamagic: Quickened Spell for a second spell once the action is spent, and
// Twinned Spell when two foes are standing. On which spell: the highest level that deals damage, or else the first.
// Null leaves the decision to the other tactics.
export function classOptionPolicy(
  decision: Decision,
  context: Context,
): string | null {
  const { state } = context;
  const actor = state.actors[decision.actor];
  if (!actor) return null;
  if (decision.id.startsWith(`${NS}:precision:`)) {
    return decision.options[0]?.id ?? null;
  }
  if (decision.id.startsWith(`${NS}:metamagic:`)) {
    const stats = deriveStats(actor, context);
    const spell = (id: string) =>
      stats.actions.find((item) => item.id === parseOption(id)[0]);
    const [best] = decision.options
      .filter((option) => option.id !== BACK)
      .sort((a, b) => {
        const first = spell(a.id);
        const second = spell(b.id);
        return (
          Number(second ? damages(second) : 0) -
            Number(first ? damages(first) : 0) ||
          (second?.spellLevel ?? 0) - (first?.spellLevel ?? 0)
        );
      });
    return best?.id ?? BACK;
  }
  if (!decision.id.startsWith(`${NS}:turn:`) || markersOf(actor).length > 0) {
    return null;
  }
  const offered = (option: Metamagic) =>
    decision.options.find(
      ({ id }) =>
        parseOption(id)[0] === METAMAGIC &&
        metamagicOf(parseOption(id)[1] ?? "") === option,
    )?.id;
  const quickened = offered("quickened");
  if (quickened && !actor.budget.action && actor.budget.bonusAction) {
    return quickened;
  }
  const twinned = offered("twinned");
  const foes = enemies(state, actor).filter((item) => !isDown(item));
  if (twinned && actor.budget.action && foes.length >= 2) return twinned;
  return null;
}
