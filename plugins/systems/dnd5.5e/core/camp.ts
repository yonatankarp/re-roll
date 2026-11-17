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
import type { LeafEffect } from "./schemas.ts";
import { type Actor, type DndState, NS, frame, isDead } from "./state.ts";
import { type KnownAction, deriveStats } from "./stats.ts";
import { canAfford, deadWithin, fitsType, goldFor } from "./combat/queries.ts";
import { leafEvents, payCosts, sharedHealing } from "./combat/effects.ts";
import { ITEM_PREFIX } from "./combat/ids.ts";
import { SHORT_REST_GIVEN } from "./rest.ts";

// Healing between fights: a party member's spell or feature that heals or raises the dead, used on the party from
// the character sheet, as Cure Wounds after a fight or Raise Dead, which takes an hour. It costs what it costs in a
// fight, less the action, and reaches anyone in the party, who can walk over to be touched.
// shortcut: a spell is cast with its lowest slot, never upcast, between fights.

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
]);

// Whether the effect would do something for this creature between fights.
function helps(
  effect: LeafEffect,
  target: Actor,
  access: ContentAccess,
): boolean {
  switch (effect.kind) {
    case "heal":
    case "hitDieHeal":
    case "shortRest":
      return target.hp < deriveStats(target, access).maxHp;
    case "repose":
      return !target.reposed;
    case "cure":
      return effect.exhaustion === true && target.exhaustion > 0;
    default:
      return false;
  }
}

// The action with only what it costs between fights: its slot, uses and gold, not an action of a turn.
function between(action: KnownAction): KnownAction {
  return {
    ...action,
    activation: {
      ...action.activation,
      cost: action.activation.cost.filter(
        (cost) => typeof cost === "object" || cost === "slot",
      ),
    },
  };
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
      effectsOf(action).some((effect) => helps(effect, item, access)),
  );
}

function castable(
  caster: Actor,
  state: DndState,
  access: ContentAccess,
): readonly KnownAction[] {
  if (isDead(caster) || caster.hp <= 0) return [];
  const stats = deriveStats(caster, access);
  return stats.actions.filter(
    (action) =>
      usable(action) &&
      goldFor(action) <= (state.gold ?? 0) &&
      canAfford(between(action), caster, stats) &&
      targetsOf(action, caster, state, access).length > 0,
  );
}

export function castId(caster: string, action: string): string {
  return `${CAST}${caster}:${action}`;
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
  // Most scenes find the party whole, and then nothing here is worth working out.
  const needy = members(state).some(
    (item) => item.hp < deriveStats(item, access).maxHp || item.exhaustion > 0,
  );
  if (!needy) return [];
  return members(state).flatMap((caster) =>
    castable(caster, state, access).map((action) => ({
      id: castId(caster.id, action.id),
      label:
        caster.id === PLAYER_ACTOR
          ? action.name
          : `${caster.name}: ${action.name}`,
      effect: `${NS}:castBetween`,
      args: { caster: caster.id, action: action.id },
      // An hour's casting only where the scene leaves time to rest.
      ...(action.activation.outOfCombat ? { rest: true } : {}),
    })),
  );
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
  action: KnownAction,
  targets: readonly Actor[],
  context: Context,
): SystemResult {
  const shared = sharedHealing(effectsOf(action), targets, caster, context);
  const events: SystemEvent[] = payCosts(between(action), caster, context);
  for (const target of targets) {
    events.push(
      ...leafEvents(shared(target), action.id, caster, target, context),
    );
  }
  return { events };
}

const CastSchema = z.strictObject({ caster: z.string(), action: z.string() });

function runCast(
  { caster: casterId, action: actionId }: z.infer<typeof CastSchema>,
  context: Context,
): SystemResult {
  const { caster, action } = found(casterId, actionId, context);
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
    return resolve(caster, action, order, context);
  }
  const [only] = targets;
  if (only && targets.length === 1)
    return resolve(caster, action, [only], context);
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
        resume: frame("castOn", { caster: caster.id, action: action.id }),
      }),
    ],
  };
}

const CastOnSchema = CastSchema.extend({ answer: z.string() });

function runCastOn(
  { caster: casterId, action: actionId, answer }: z.infer<typeof CastOnSchema>,
  context: Context,
): SystemResult {
  if (answer === NEVER_MIND) return {};
  const { caster, action } = found(casterId, actionId, context);
  const target = targetsOf(action, caster, context.state, context).find(
    (item) => item.id === answer,
  );
  if (!target) throw new Error(`${action.name} can't reach ${answer}`);
  return resolve(caster, action, [target], context);
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
