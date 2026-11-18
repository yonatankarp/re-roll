import {
  type ContentAccess,
  type Decision,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
  frameHandler,
} from "#sdk";
import { z } from "zod";
import { type Context, canAfford } from "./combat.ts";
import { knownFoes } from "./fog.ts";
import { inReach } from "./combat/queries.ts";
import { distanceFeet } from "./grid.ts";
import { dealEvents } from "./combat/effects.ts";
import { encodeOption, parseOption, spellOfSource } from "./combat/ids.ts";
import { FeatureSchema, SpellSchema } from "./schemas.ts";
import {
  type CastOption,
  castOptionsOf,
  fitsOption,
  waitingOptions,
} from "./cast-options.ts";
import {
  type Actor,
  CAST_LEVELED,
  type DndState,
  INCAPACITATING,
  NS,
  dndEvent,
  frame,
  hasCondition,
  isDown,
} from "./state.ts";
import {
  type KnownAction,
  type Stats,
  deriveStats,
  circleOptions,
  lookup,
  onList,
  rollDiceNotation,
  maybeLookup,
} from "./stats.ts";
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
  freeOption,
  metamagicSpentEvents,
} from "./metamagic.ts";

// A Sorcerer's turn options: putting a Metamagic option on a spell before casting it, and Font of Magic's trades
// between spell slots and Sorcery Points. Each is an option of the turn decision, so a save replays it.

const METAMAGIC = `${TACTIC}metamagic`;
const CANCEL = `${TACTIC}metamagic-cancel`;
const TO_POINTS = `${TACTIC}font-points`;
const TO_SLOT = `${TACTIC}font-slot`;
const SLOT_POINTS = `${TACTIC}slot-points`; // a `slotToPoints` passive's trade, as Mystic Focus
const CAST_OPTION = `${TACTIC}cast-option`; // a feature's change to a spell as it's cast (cast-options.ts)

// Font of Magic's Creating Spell Slots table: the Sorcery Points a slot costs and the Sorcerer level it needs.
const CREATED_SLOTS = [
  { level: 1, points: 2, from: 2 },
  { level: 2, points: 3, from: 3 },
  { level: 3, points: 5, from: 5 },
  { level: 4, points: 6, from: 7 },
  { level: 5, points: 7, from: 9 },
] as const;

export function isClassOption(answer: string): boolean {
  return [
    METAMAGIC,
    CANCEL,
    TO_POINTS,
    TO_SLOT,
    SLOT_POINTS,
    CAST_OPTION,
  ].includes(parseOption(answer)[0] ?? "");
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
    if (
      typeof item === "object" &&
      "resource" in item &&
      item.resource === SORCERY_POINTS
    )
      return [];
    return [option === "quickened" && item === "action" ? "bonusAction" : item];
  });
  const waiting = markersOf(actor)
    .filter((item) => item.action === action.id)
    .map((item) => item.option);
  const two = stats.passives.some(
    (passive) =>
      passive.kind === "doubleMetamagic" &&
      actor.activeEffects.some(({ sourceId }) =>
        passive.while.some((id) => sourceId.startsWith(`feature:${id}:`)),
      ),
  );
  return (
    !action.activation.trigger &&
    // Quickened Spell can't follow a level 1+ spell cast this turn.
    !(option === "quickened" && actor.usedThisTurn.includes(CAST_LEVELED)) &&
    fits(option, action) &&
    joins(option, waiting, two) &&
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

// A slot spent for points of a `slotToPoints` resource, no action needed and no more than were spent.
function slotPointOptions(actor: Actor, stats: Stats): Decision["options"] {
  return stats.passives.flatMap((passive) => {
    if (passive.kind !== "slotToPoints") return [];
    const spent = actor.resourcesSpent[passive.resource] ?? 0;
    if (spent === 0 || stats.resources[passive.resource] === undefined) {
      return [];
    }
    return stats.slots.flatMap((count, index) => {
      const level = index + 1;
      const used = actor.resourcesSpent[`slot:${String(level)}`] ?? 0;
      return count - used > 0
        ? [
            {
              id: encodeOption(SLOT_POINTS, level, passive.resource),
              label: `Turn a level ${String(level)} slot into ${plural(Math.min(level, spent), "point")} of ${passive.resource.replace(/-/g, " ")}`,
            },
          ]
        : [];
    });
  });
}

// The bearer's cast options, with the spells each fits now.
function castOptionChoices(
  actor: Actor,
  stats: Stats,
  state: DndState,
  access: ContentAccess,
): readonly {
  readonly sourceId: string;
  readonly option: CastOption;
  readonly spells: readonly KnownAction[];
}[] {
  const options = castOptionsOf([
    ...stats.features.flatMap((id) => {
      const feature = maybeLookup(access, FeatureSchema, id);
      return feature ? [feature] : [];
    }),
    ...circleOptions(access),
  ]);
  const busy = new Set(
    waitingOptions(actor, options).map((item) => item.sourceId),
  );
  return options.flatMap(({ sourceId, option }) => {
    if (busy.has(sourceId)) return [];
    const spells = stats.actions.filter((action) => {
      const spellId = spellOfSource(action.id);
      if (spellId === null || action.activation.trigger) return false;
      const spell = maybeLookup(access, SpellSchema, spellId);
      return (
        fitsOption(option, action, spell, (list) =>
          onList(spellId, spell, list, access),
        ) &&
        canAfford(
          {
            ...action,
            activation: {
              ...action.activation,
              cost: [...action.activation.cost, ...option.cost],
            },
          },
          actor,
          stats,
        ) &&
        (!option.circle ||
          circleCasters(actor, option, action.spellLevel ?? 0, state, access)
            .length > 0) &&
        inReach(action, actor, state, access).length > 0
      );
    });
    return spells.length > 0 ? [{ sourceId, option, spells }] : [];
  });
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
  // Arcane Apotheosis: one option a turn needs no points, while none waits on a spell yet.
  const free = busy.size === 0 && freeOption(actor, stats.passives);
  for (const [featureId, option] of knownOptions(stats)) {
    const cost = METAMAGIC_COSTS[option];
    if (busy.has(featureId) || (cost > left && !free)) continue;
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
  for (const { sourceId, option } of castOptionChoices(
    actor,
    stats,
    state,
    access,
  )) {
    options.push({
      id: encodeOption(CAST_OPTION, sourceId),
      label: `${option.label}: change a spell as it's cast`,
    });
  }
  return [
    ...options,
    ...fontOptions(actor, stats),
    ...slotPointOptions(actor, stats),
  ];
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
    case CAST_OPTION: {
      const found = castOptionChoices(actor, stats, state, context).find(
        (item) => item.sourceId === detail,
      );
      if (!found) throw new Error(`${detail} fits no spell now`);
      return {
        frames: [
          awaitDecision({
            id: encodeOption(
              `${NS}:castOption:${actor.id}:${String(state.combat?.round ?? 0)}`,
              detail,
            ),
            actor: actor.id,
            prompt: `${found.option.label}: on which spell?`,
            options: [
              ...found.spells.map((spell) => ({
                id: spell.id,
                label: spell.name,
              })),
              { id: BACK, label: "Choose something else" },
            ],
            resume: frame("castOption", { actor: actor.id, source: detail }),
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
    case SLOT_POINTS: {
      const [, , resource = ""] = parseOption(payload.answer);
      const spent = actor.resourcesSpent[resource] ?? 0;
      return {
        events: [
          dndEvent(`${NS}:resourceSpent`, {
            actor: actor.id,
            resource: `slot:${detail}`,
          }),
          dndEvent(`${NS}:resourceRestored`, {
            actor: actor.id,
            resource,
            amount: Math.min(Number(detail), spent),
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

const CastOptionSchema = z.object({
  actor: z.string(),
  source: z.string(),
  answer: z.string(),
});

// Leaves the option waiting on the spell until the end of the turn, as a Metamagic option does.
// The party's other casters who can join a Circle casting of a spell of this level: within 30 feet, standing, with a
// Reaction left, and with the slot the option asks for.
function circleCasters(
  actor: Actor,
  option: CastOption,
  spellLevel: number,
  state: DndState,
  access: ContentAccess,
): { readonly id: string; readonly slot: number | null }[] {
  const least =
    option.circle?.slot === "spellLevel" ? Math.max(1, spellLevel) : 1;
  return Object.values(state.actors).flatMap(
    (other): { readonly id: string; readonly slot: number | null }[] => {
      if (
        other.id === actor.id ||
        other.side !== actor.side ||
        other.source.kind !== "character" ||
        isDown(other) ||
        hasCondition(other, ...INCAPACITATING) ||
        !other.budget.reaction ||
        distanceFeet(actor.position, other.position) > 30
      ) {
        return [];
      }
      const stats = deriveStats(other, access);
      const left = (level: number) =>
        (stats.slots[level - 1] ?? 0) -
        (other.resourcesSpent[`slot:${String(level)}`] ?? 0);
      // Spellcasting or Pact Magic shows in its slots.
      if (!stats.slots.some((count) => count > 0)) return [];
      if (!option.circle?.slot) return [{ id: other.id, slot: null }];
      const slot = stats.slots.findIndex(
        (_, index) => index + 1 >= least && left(index + 1) > 0,
      );
      return slot < 0 ? [] : [{ id: other.id, slot: slot + 1 }];
    },
  );
}

function runCastOption(
  payload: z.infer<typeof CastOptionSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === BACK) return {};
  const actor = context.state.actors[payload.actor];
  const option = actor
    ? castOptionsOf(circleOptions(context)).find(
        (item) => item.sourceId === payload.source,
      )?.option
    : undefined;
  // A Circle option: the others join now, each with its Reaction and any slot, and how many is kept.
  const joined =
    actor && option
      ? circleCasters(
          actor,
          option,
          deriveStats(actor, context).actions.find(
            (item) => item.id === payload.answer,
          )?.spellLevel ?? 0,
          context.state,
          context,
        )
      : [];
  return {
    events: [
      ...joined.flatMap((other) => [
        dndEvent(`${NS}:budgetSpent`, { actor: other.id, kind: "reaction" }),
        ...(other.slot === null
          ? []
          : [
              dndEvent(`${NS}:resourceSpent`, {
                actor: other.id,
                resource: `slot:${String(other.slot)}`,
              }),
            ]),
      ]),
      dndEvent(`${NS}:effectAdded`, {
        actor: payload.actor,
        effect: {
          sourceId: payload.source,
          casterId: payload.actor,
          modifier: {
            kind: "tactic",
            tactic: "metamagic",
            action: payload.answer,
            ...(option ? { value: joined.length } : {}),
          },
          ends: "casterTurnEnd",
        },
      }),
    ],
  };
}

const CastOptionSpentSchema = z.object({
  actor: z.string(),
  action: z.string(),
  slotLevel: z.number().int().optional(),
});

// Once the spell is cast its options are done, and an `escalate` price is paid: Overchannel's Necrotic, rolled
// for each slot level, more dice with each use since the Long Rest that ignores Resistance and Immunity.
function runCastOptionSpent(
  payload: z.infer<typeof CastOptionSpentSchema>,
  context: Context,
): SystemResult {
  const actor = context.state.actors[payload.actor];
  if (!actor) return {};
  const stats = deriveStats(actor, context);
  const options = castOptionsOf([
    ...stats.features.flatMap((id) => {
      const feature = maybeLookup(context, FeatureSchema, id);
      return feature ? [feature] : [];
    }),
    ...circleOptions(context),
  ]);
  const mine = waitingOptions(actor, options).filter(
    (item) => item.action === payload.action,
  );
  const events: SystemEvent[] = mine.map((item) =>
    dndEvent(`${NS}:effectEnded`, {
      actor: actor.id,
      sourceId: item.sourceId,
      casterId: actor.id,
    }),
  );
  for (const { option } of mine) {
    const price = option.escalate;
    if (!price) continue;
    const used = actor.resourcesSpent[price.resource] ?? 0;
    events.push(
      dndEvent(`${NS}:resourceSpent`, {
        actor: actor.id,
        resource: price.resource,
      }),
    );
    if (used === 0) continue;
    const count = (price.dice + used - 1) * (payload.slotLevel ?? 1);
    const amount = rollDiceNotation(
      `${String(count)}d${String(price.die)}`,
      context.dice,
    );
    // Rolled as dealt, past Resistance and Immunity: a price paid, not damage taken (no response).
    events.push(
      ...dealEvents(actor, [{ amount, type: price.type }], false, context)
        .events,
    );
  }
  return { events };
}

const SpentSchema = z.object({ actor: z.string(), action: z.string() });

export const classOptionFrames = {
  [`${NS}:metamagic`]: frameHandler({
    schema: MetamagicSchema,
    run: runMetamagic,
  }),
  [`${NS}:castOption`]: frameHandler({
    schema: CastOptionSchema,
    run: runCastOption,
  }),
  [`${NS}:castOptionSpent`]: frameHandler({
    schema: CastOptionSpentSchema,
    run: runCastOptionSpent,
  }),
  [`${NS}:metamagicSpent`]: frameHandler({
    schema: SpentSchema,
    run: (payload, context: Context) => {
      const actor = context.state.actors[payload.actor];
      return actor
        ? {
            events: metamagicSpentEvents(
              actor,
              payload.action,
              freeOption(actor, deriveStats(actor, context).passives),
            ),
          }
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
  const foes = knownFoes(state, actor, context).filter((item) => !isDown(item));
  if (twinned && actor.budget.action && foes.length >= 2) return twinned;
  return null;
}
