import { type Frame, type SystemEvent } from "#sdk";
import { distanceFeet } from "../grid.ts";
import { type Actor, dndEvent, frame, isDown, NS } from "../state.ts";
import { deriveStats, type KnownAction } from "../stats.ts";
import { hasPassive, isMelee, reaches, type Context } from "./queries.ts";

// A mind not its own as a turn starts: Confusion's d8, as an umber hulk's Confusing Gaze or a gibbering mouther's
// Gibbering, and a golem's Berserk. The rolls are made here and kept as the effects they leave.

const MADNESS = "madness";

function meleeAttack(actor: Actor, context: Context): KnownAction | undefined {
  return deriveStats(actor, context).actions.find(
    (action) =>
      action.activation.resolution.kind === "attack" &&
      action.activation.cost.includes("action") &&
      isMelee(action),
  );
}

// Everyone else standing that its melee attack reaches, either side.
function withinReach(
  actor: Actor,
  action: KnownAction,
  context: Context,
): readonly Actor[] {
  return Object.values(context.state.actors).filter(
    (item) =>
      item.id !== actor.id &&
      item.position !== null &&
      !isDown(item) &&
      reaches(action, actor, item),
  );
}

const attackAt = (actor: Actor, action: KnownAction, target: Actor): Frame =>
  frame("useAction", {
    actor: actor.id,
    actionId: action.id,
    target: target.id,
    anyone: true,
  });

// Its turn spent doing nothing but what the roll said, with no Reactions.
const stunned = (actor: Actor): SystemEvent =>
  dndEvent(`${NS}:effectAdded`, {
    actor: actor.id,
    effect: {
      sourceId: MADNESS,
      casterId: actor.id,
      modifier: {
        kind: "actionLimit",
        noActions: true,
        noReactions: true,
        speed: "none",
      },
      ends: "casterTurnEnd",
    },
  });

// A fury's turn (passive `fury`): the nearest creature it reaches attacked if that's a friend, a foe left to the turn's
// own choice as the berserk's is, or the creature it's set on attacked while it reaches it. It ends as a turn starts
// with no one within 60 feet, or the one it's set on down or out of reach.
function furyStart(
  actor: Actor,
  action: KnownAction | undefined,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } | null {
  const fury = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "furious",
  )?.modifier;
  if (fury?.kind !== "furious") return null;
  const ended = {
    events: [
      dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId: "fury" }),
    ],
    frames: [],
  };
  const others = Object.values(context.state.actors).filter(
    (item) => item.id !== actor.id && item.position !== null && !isDown(item),
  );
  const reached = action ? withinReach(actor, action, context) : [];
  if (fury.at !== undefined) {
    const foe = reached.find((item) => item.id === fury.at);
    return foe && action
      ? {
          events: [
            dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: "action" }),
          ],
          frames: [attackAt(actor, action, foe)],
        }
      : ended;
  }
  if (
    !others.some((item) => distanceFeet(actor.position, item.position) <= 60)
  ) {
    return ended;
  }
  const [closest] = [...reached].sort(
    (a, b) =>
      distanceFeet(actor.position, a.position) -
      distanceFeet(actor.position, b.position),
  );
  return closest?.side === actor.side && action
    ? {
        events: [
          dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: "action" }),
        ],
        frames: [attackAt(actor, action, closest)],
      }
    : { events: [], frames: [] };
}

export function madnessStart(
  actor: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  if (isDown(actor)) return { events: [], frames: [] };
  const confused = actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "confused" && !modifier.spell,
  );
  const action = meleeAttack(actor, context);
  if (confused) {
    const roll = context.dice.roll(8);
    const reached = action ? withinReach(actor, action, context) : [];
    const struck =
      roll >= 7 && action && reached.length > 0
        ? reached[context.dice.roll(reached.length) - 1]
        : undefined;
    return {
      events: [stunned(actor)],
      frames: struck && action ? [attackAt(actor, action, struck)] : [],
    };
  }
  const fury = furyStart(actor, action, context);
  if (fury) return fury;
  const stats = deriveStats(actor, context);
  if (!hasPassive(stats, "berserk")) return { events: [], frames: [] };
  const bloodied = actor.hp * 2 <= stats.maxHp;
  const berserk = actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "berserk",
  );
  if (!bloodied) {
    return {
      events: berserk
        ? [
            dndEvent(`${NS}:effectEnded`, {
              actor: actor.id,
              sourceId: MADNESS,
            }),
          ]
        : [],
      frames: [],
    };
  }
  if (!berserk && context.dice.roll(6) < 6) return { events: [], frames: [] };
  const started = berserk
    ? []
    : [
        dndEvent(`${NS}:effectAdded`, {
          actor: actor.id,
          effect: {
            sourceId: MADNESS,
            casterId: actor.id,
            modifier: { kind: "berserk" },
            ends: "spellDuration",
          },
        }),
      ];
  // shortcut: berserk, it attacks the nearest creature it reaches when that's a friend, and otherwise plays its turn
  // as it would, since that already goes at its foes.
  const [closest] = action
    ? [...withinReach(actor, action, context)].sort(
        (a, b) =>
          distanceFeet(actor.position, a.position) -
          distanceFeet(actor.position, b.position),
      )
    : [];
  const nearest = closest?.side === actor.side ? closest : undefined;
  return {
    events: [
      ...started,
      ...(nearest
        ? [dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: "action" })]
        : []),
    ],
    frames: nearest && action ? [attackAt(actor, action, nearest)] : [],
  };
}
