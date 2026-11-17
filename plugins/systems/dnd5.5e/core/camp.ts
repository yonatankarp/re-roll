import {
  type ContentAccess,
  PLAYER_ACTOR,
  type SceneAction,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import { ClassSchema, type LeafEffect, SpellSchema } from "./schemas.ts";
import { type Actor, type DndState, NS, frame, isDead } from "./state.ts";
import {
  type KnownAction,
  type Stats,
  deriveStats,
  scaleActivation,
} from "./stats.ts";
import {
  canAfford,
  deadWithin,
  fitsType,
  goldFor,
  upcastSlots,
} from "./combat/queries.ts";
import { leafEvents, payCosts, sharedHealing } from "./combat/effects.ts";
import { ITEM_PREFIX, spellOfSource } from "./combat/ids.ts";
import { SHORT_REST_GIVEN, canRegain, regainCap } from "./rest.ts";

// Healing between fights: a party member's spell or feature that heals or raises the dead, used on the party from
// the character sheet, as Cure Wounds after a fight or Raise Dead, which takes an hour. It costs what it costs in a
// fight, less the action, and reaches anyone in the party, who can walk over to be touched. A spell may be cast with
// a higher slot, and a ritual is cast as one, with no slot.

type Context = SystemContext<DndState>;

const CAST = "cast:";
const NEVER_MIND = "never-mind";

// Only effects that mean something outside a fight. Conditions all end with the fight, so curing them has
// nothing to do yet, and other effects would linger into the next fight.
const BETWEEN: ReadonlySet<LeafEffect["kind"]> = new Set([
  "heal",
  "hitDieHeal",
  "cure",
  "removeCondition",
  "ordeal",
  "repose",
  "shortRest",
  "regain",
  "transference",
  "reincarnate",
  "clone",
]);

// Whether the effect would do something for this creature between fights.
function helps(
  effect: LeafEffect,
  target: Actor,
  access: ContentAccess,
  slotLevel: number | null,
): boolean {
  switch (effect.kind) {
    case "heal":
    case "hitDieHeal":
    case "shortRest":
    case "transference":
      return target.hp < deriveStats(target, access).maxHp;
    case "repose":
      return !target.reposed;
    case "reincarnate":
      return true; // its targeting already asks for the dead
    case "clone":
      return target.clone === undefined;
    case "cure":
      return (
        (effect.exhaustion === true && target.exhaustion > 0) ||
        (effect.maxHp === true && (target.maxHpLoss ?? 0) > 0)
      );
    case "regain":
      return canRegain(
        target,
        effect.resource,
        deriveStats(target, access),
        regainCap(effect, slotLevel),
      );
    default:
      return false;
  }
}

// Whether the action is a spell that can be cast as a Ritual, with time to spare between fights.
function ritual(action: KnownAction, access: ContentAccess): boolean {
  const id = spellOfSource(action.id);
  return (
    id !== null &&
    SpellSchema.safeParse(access.content(id)).data?.ritual === true
  );
}

// The action with only what it costs between fights: its slot, uses and gold, not an action of a turn. A ritual
// needs no slot.
function between(action: KnownAction, access: ContentAccess): KnownAction {
  const free = ritual(action, access);
  return {
    ...action,
    activation: {
      ...action.activation,
      cost: action.activation.cost.filter(
        (cost) => typeof cost === "object" || (cost === "slot" && !free),
      ),
    },
  };
}

// The action as cast with this slot, its upcast applied.
function atSlot(action: KnownAction, slot: number | undefined): KnownAction {
  return slot !== undefined && action.upcast && action.spellLevel !== null
    ? {
        ...action,
        activation: scaleActivation(
          action.activation,
          action.upcast.perSlotLevel,
          slot - action.spellLevel,
        ),
      }
    : action;
}

function effectsOf(action: KnownAction): readonly LeafEffect[] {
  const { resolution } = action.activation;
  return resolution.kind === "automatic" ? resolution.effects : [];
}

// A potion is drunk from its own row (gear.ts), so only spells and features are used here.
function usable(action: KnownAction): boolean {
  const effects = effectsOf(action);
  return (
    !action.id.startsWith(ITEM_PREFIX) &&
    !action.activation.trigger &&
    !(
      "side" in action.activation.targeting &&
      action.activation.targeting.side === "enemy"
    ) &&
    effects.length > 0 &&
    effects.every((effect) => BETWEEN.has(effect.kind))
  );
}

function members(state: DndState): readonly Actor[] {
  return Object.values(state.actors).filter(
    (actor) => actor.side === "party" && actor.source.kind === "character",
  );
}

// Those it would do something for, such as the dead it's in time for, or the living missing Hit Points.
function targetsOf(
  action: KnownAction,
  caster: Actor,
  state: DndState,
  access: ContentAccess,
): readonly Actor[] {
  const { targeting } = action.activation;
  const dead = "dead" in targeting && targeting.dead === true;
  const pool = "self" in targeting ? [caster] : members(state);
  return pool.filter(
    (item) =>
      isDead(item) === dead &&
      deadWithin(item, targeting) &&
      fitsType(item, targeting, access, caster) &&
      // Prayer of Healing reaches no one it already gave a Short Rest's benefits since a Long Rest.
      !(
        item.resourcesSpent[SHORT_REST_GIVEN] &&
        effectsOf(action).some((effect) => effect.kind === "shortRest")
      ) &&
      effectsOf(action).some((effect) =>
        helps(effect, item, access, action.spellLevel),
      ),
  );
}

// Ritual spells a Ritual Adept casts from its list without having them prepared, of levels it has slots for.
// shortcut: the spellbook is the Wizard list, as it isn't kept apart from it (swap.ts says the same).
function ritualsOnHand(
  stats: Stats,
  access: ContentAccess,
): readonly KnownAction[] {
  const lists = stats.passives.flatMap((passive) =>
    passive.kind === "ritualAdept" ? [passive.list] : [],
  );
  if (lists.length === 0) return [];
  const highest = stats.slots.findLastIndex((count) => count > 0) + 1;
  const known = new Set(stats.actions.map((action) => action.id));
  const named = new Set(
    lists.flatMap(
      (list) =>
        ClassSchema.safeParse(access.content(list)).data?.spellList ?? [],
    ),
  );
  return access.contentIds().flatMap((id): KnownAction[] => {
    if (!id.includes(":spell/") || known.has(`spell:${id}`)) return [];
    const spell = SpellSchema.safeParse(access.content(id)).data;
    if (
      !spell?.ritual ||
      !spell.activation ||
      spell.level < 1 ||
      spell.level > highest ||
      !(named.has(id) || spell.classes.some((item) => lists.includes(item)))
    ) {
      return [];
    }
    return [
      {
        id: `spell:${id}`,
        name: spell.name,
        activation: spell.activation,
        spellLevel: spell.level,
        upcast: spell.upcast,
      },
    ];
  });
}

function castable(
  caster: Actor,
  state: DndState,
  access: ContentAccess,
): readonly KnownAction[] {
  if (isDead(caster) || caster.hp <= 0) return [];
  const stats = deriveStats(caster, access);
  return [...stats.actions, ...ritualsOnHand(stats, access)].filter(
    (action) =>
      usable(action) &&
      goldFor(action) <= (state.gold ?? 0) &&
      canAfford(between(action, access), caster, stats) &&
      targetsOf(action, caster, state, access).length > 0,
  );
}

export function castId(caster: string, action: string, slot?: number): string {
  return `${CAST}${caster}:${action}${slot === undefined ? "" : `@${String(slot)}`}`;
}

export function sceneCastActions(
  state: DndState,
  access: ContentAccess,
): SceneAction[] {
  const player = state.actors[PLAYER_ACTOR];
  if (
    state.combat ||
    player?.source.kind !== "character" ||
    !player.source.build
  ) {
    return [];
  }
  // Most scenes find the party whole and fresh, and then nothing here is worth working out.
  const needy = members(state).some(
    (item) =>
      item.hp < deriveStats(item, access).maxHp ||
      item.exhaustion > 0 ||
      Object.keys(item.resourcesSpent).some((key) => key.startsWith("slot:")),
  );
  if (!needy) return [];
  return members(state).flatMap((caster) => {
    const stats = deriveStats(caster, access);
    return castable(caster, state, access).flatMap((action) => {
      const name =
        caster.id === PLAYER_ACTOR
          ? action.name
          : `${caster.name}: ${action.name}`;
      // A ritual costs no slot, so a higher one is never worth it.
      const slots = ritual(action, access)
        ? []
        : upcastSlots(action, caster, stats);
      return [undefined, ...slots].map((slot) => ({
        id: castId(caster.id, action.id, slot),
        label:
          slot === undefined
            ? `${name}${ritual(action, access) ? " (ritual)" : ""}`
            : `${name} (level ${String(slot)} slot)`,
        effect: `${NS}:castBetween`,
        args: {
          caster: caster.id,
          action: action.id,
          ...(slot === undefined ? {} : { slot }),
        },
        // An hour's casting only where the scene leaves time to rest.
        ...(action.activation.outOfCombat ? { rest: true } : {}),
      }));
    });
  });
}

function found(
  casterId: string,
  actionId: string,
  context: Context,
): { caster: Actor; action: KnownAction } {
  const caster = context.state.actors[casterId];
  const action = caster
    ? castable(caster, context.state, context).find(
        (item) => item.id === actionId,
      )
    : undefined;
  if (!caster || !action) {
    throw new Error(`${casterId} can't use ${actionId} now`);
  }
  return { caster, action };
}

function resolve(
  caster: Actor,
  action: KnownAction, // as cast with `slot`
  targets: readonly Actor[],
  context: Context,
  slot?: number,
): SystemResult {
  const shared = sharedHealing(effectsOf(action), targets, caster, context);
  const events: SystemEvent[] = payCosts(
    between(action, context),
    caster,
    context,
    slot,
  );
  // The slot it's cast with, its own level's unless a higher one was picked, so Disciple of Life sees it.
  const spent =
    slot ??
    (between(action, context).activation.cost.includes("slot")
      ? (action.spellLevel ?? undefined)
      : undefined);
  for (const target of targets) {
    events.push(
      ...leafEvents(
        shared(target),
        action.id,
        caster,
        target,
        context,
        undefined,
        spent,
      ),
    );
  }
  // The player spends the Hit Dice a Short Rest it gave them, as they would in one (rest.ts), and picks what a
  // reincarnated body's species asks for (reincarnate.ts).
  const player = targets.some((target) => target.id === PLAYER_ACTOR);
  const given = (kind: LeafEffect["kind"]) =>
    player && effectsOf(action).some((effect) => effect.kind === kind);
  const frames = [
    ...(given("shortRest") ? [frame("givenDice")] : []),
    ...(given("reincarnate") ? [frame("reincarnate", { picks: {} })] : []),
  ];
  return { events, ...(frames.length > 0 ? { frames } : {}) };
}

const CastSchema = z.strictObject({
  caster: z.string(),
  action: z.string(),
  slot: z.number().int().min(1).max(9).optional(), // a higher slot it's cast with
});

function runCast(
  { caster: casterId, action: actionId, slot }: z.infer<typeof CastSchema>,
  context: Context,
): SystemResult {
  const { caster, action: unscaled } = found(casterId, actionId, context);
  const action = atSlot(unscaled, slot);
  const targets = targetsOf(action, caster, context.state, context);
  const { targeting } = action.activation;
  // Several at once go to the most hurt first, as in a fight.
  if (
    "area" in targeting ||
    ("creatures" in targeting && targeting.creatures > 1)
  ) {
    const most =
      "creatures" in targeting ? targeting.creatures : targets.length;
    const order = [...targets].sort((a, b) => a.hp - b.hp).slice(0, most);
    return resolve(caster, action, order, context, slot);
  }
  const [only] = targets;
  if (only && targets.length === 1)
    return resolve(caster, action, [only], context, slot);
  return {
    frames: [
      awaitDecision({
        id: `${NS}:castOn:${caster.id}:${action.id}`,
        actor: PLAYER_ACTOR,
        prompt: `${action.name}: on whom?`,
        options: [
          ...targets.map((item) => ({ id: item.id, label: item.name })),
          { id: NEVER_MIND, label: "Never mind" },
        ],
        resume: frame("castOn", {
          caster: caster.id,
          action: action.id,
          ...(slot === undefined ? {} : { slot }),
        }),
      }),
    ],
  };
}

const CastOnSchema = CastSchema.extend({ answer: z.string() });

function runCastOn(
  {
    caster: casterId,
    action: actionId,
    answer,
    slot,
  }: z.infer<typeof CastOnSchema>,
  context: Context,
): SystemResult {
  if (answer === NEVER_MIND) return {};
  const { caster, action: unscaled } = found(casterId, actionId, context);
  const action = atSlot(unscaled, slot);
  const target = targetsOf(action, caster, context.state, context).find(
    (item) => item.id === answer,
  );
  if (!target) throw new Error(`${action.name} can't reach ${answer}`);
  return resolve(caster, action, [target], context, slot);
}

export const campEffects = {
  [`${NS}:castBetween`]: storyEffect({
    schema: CastSchema,
    apply: runCast,
  }),
};

export const campFrames = {
  [`${NS}:castOn`]: frameHandler({ schema: CastOnSchema, run: runCastOn }),
};
