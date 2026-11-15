import { frameHandler, type SystemEvent, type SystemResult } from "#sdk";
import { z } from "zod";
import type { LeafEffect } from "../schemas.ts";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  frame,
  isDown,
  NS,
} from "../state.ts";
import { deriveStats } from "../stats.ts";
import { leafEvents } from "./effects.ts";
import { type Context, currentActor, moveSquares, reaches } from "./queries.ts";
import { strikeAction } from "./reactions.ts";

// Confusion: a d10 as each of the creature's turns starts says what it does that turn, and it takes no Bonus Action
// or Reaction (core/schemas.ts "confused").

export const confusedBy = (actor: Actor) =>
  actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "confused" && modifier.spell,
  );

const HELD: LeafEffect = {
  kind: "modifier",
  modifier: { kind: "actionLimit", noActions: true, speed: "none" },
  duration: { until: "turnEnd" },
};

// North, east, south and west on the map, for the d4.
const DIRECTIONS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
] as const;

const rolled = (actor: Actor, die: number, value: number, label: string) =>
  dndEvent(`${NS}:dieRolled`, { actor: actor.id, die, rolled: value, label });

export function runConfusedTurn(context: Context): SystemResult {
  const { state, dice } = context;
  const actor = currentActor(state);
  const effect = actor ? confusedBy(actor) : undefined;
  if (!actor || !effect || isDown(actor) || !actor.position) return {};
  const caster = state.actors[effect.casterId] ?? actor;
  const roll = dice.roll(10);
  const events: SystemEvent[] = [
    rolled(actor, 10, roll, "Confusion"),
    ...(actor.budget.reaction
      ? [dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: "reaction" })]
      : []),
  ];
  // 9-10: it acts as it chooses, without a Bonus Action.
  if (roll >= 9) {
    return {
      events: actor.budget.bonusAction
        ? [
            ...events,
            dndEvent(`${NS}:budgetSpent`, {
              actor: actor.id,
              kind: "bonusAction",
            }),
          ]
        : events,
    };
  }
  // 1: it uses all its movement in a direction the d4 picks, and takes no action.
  if (roll === 1) {
    const direction = dice.roll(4);
    events.push(rolled(actor, 4, direction, "Confusion's direction"));
    const { x, y } = DIRECTIONS[direction - 1] ?? DIRECTIONS[0];
    const from = actor.position;
    const [farthest] = moveSquares(
      actor,
      state,
      deriveStats(actor, context),
      context,
    )
      .filter(({ square }) => {
        const dx = square.x - from.x;
        const dy = square.y - from.y;
        return x === 0
          ? dx === 0 && Math.sign(dy) === y
          : dy === 0 && Math.sign(dx) === x;
      })
      .sort(
        (a, b) =>
          Math.abs(b.square.x - from.x) +
          Math.abs(b.square.y - from.y) -
          (Math.abs(a.square.x - from.x) + Math.abs(a.square.y - from.y)),
      );
    // shortcut: the wandering walk provokes no Opportunity Attacks.
    if (farthest) {
      events.push(
        dndEvent(`${NS}:moved`, {
          actor: actor.id,
          to: farthest.square,
          feet: farthest.feet,
        }),
      );
    }
  }
  const after = { ...context, state: events.reduce(applyDndEvent, state) };
  const moved = after.state.actors[actor.id] ?? actor;
  events.push(...leafEvents([HELD], effect.sourceId, caster, moved, after));
  if (roll < 7) return { events };
  // 7-8: one melee attack against a random creature within reach, if there is one.
  const melee = strikeAction(moved, undefined, after);
  const near = melee
    ? Object.values(after.state.actors).filter(
        (item) =>
          item.id !== actor.id &&
          !isDown(item) &&
          item.position !== null &&
          reaches(melee, moved, item),
      )
    : [];
  if (!melee || near.length === 0) return { events };
  const pick = dice.roll(near.length);
  const target = near[pick - 1];
  if (!target) return { events };
  events.push(rolled(actor, near.length, pick, "Confusion's target"));
  return {
    events,
    frames: [
      frame("attackRoll", {
        attacker: actor.id,
        actionId: melee.id,
        target: target.id,
      }),
    ],
  };
}

export const confusionFrames = {
  [`${NS}:confusedTurn`]: frameHandler({
    schema: z.object({}),
    run: (_payload, context: Context) => runConfusedTurn(context),
  }),
};
