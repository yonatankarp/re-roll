import { z } from "zod";
import {
  frameHandler,
  PLAYER_ACTOR,
  type Frame,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { distanceFeet, squareKey } from "../grid.ts";
import { blockingSet } from "../zones.ts";
import { finalDamage } from "../rules.ts";
import type { LeafEffect } from "../schemas.ts";
import { seeing } from "../sight.ts";
import {
  type Actor,
  type DndState,
  dndEvent,
  frame,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
} from "../state.ts";
import {
  damageResponses,
  deriveStats,
  evaluateFormula,
  type KnownAction,
} from "../stats.ts";
import {
  concentrationFrame,
  dealEvents,
  leafEvents,
  rollSave,
} from "./effects.ts";
import { canAfford, type Context } from "./queries.ts";
import { afterDamage, playerTakes, reactionCosts } from "./reactions.ts";

// Falling. Reverse Gravity lifts creatures up and drops them once it ends; a fall deals 1d6 Bludgeoning per 10 feet,
// at most 20d6, and leaves the creature Prone, unless a reaction such as Feather Fall lets it down gently.
// shortcut: the grid has no height. A lifted creature is out of reach of those below it (reaches), and nothing
// else reads how high it is.

const ALOFT = ":aloft";

// How far up a creature is: its lift's height while what holds it there lasts, else 0.
export function heightOf(actor: Actor): number {
  const aloft = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "aloft",
  );
  return aloft?.modifier.kind === "aloft" && held(actor, aloft)
    ? aloft.modifier.feet
    : 0;
}

function held(actor: Actor, aloft: Actor["activeEffects"][number]): boolean {
  const source = aloft.sourceId.slice(0, -ALOFT.length);
  return actor.activeEffects.some(
    ({ sourceId, casterId }) =>
      sourceId === source && casterId === aloft.casterId,
  );
}

// Reverse Gravity's lift: the creature can't move while the spell lasts, and keeps how high it went for when the
// spell is gone and it falls (fallFrames). One beside a wall may grab hold of it instead.
// shortcut: there are no ceilings to strike, and a creature that walks into the area later isn't lifted.
export function liftEvents(
  { feet, duration, grab }: Extract<LeafEffect, { kind: "lift" }>,
  sourceId: string,
  caster: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  if (target.activeEffects.some(({ modifier }) => modifier.kind === "aloft")) {
    return [];
  }
  const held =
    grab && besideWall(target, context.state)
      ? rollSave(
          target,
          grab.ability,
          evaluateFormula(grab.dc, deriveStats(caster, context)),
          context,
          true,
        )
      : null;
  if (held?.saved) return held.events;
  return [
    ...(held?.events ?? []),
    ...leafEvents(
      [
        {
          kind: "modifier",
          modifier: { kind: "actionLimit", speed: "none" },
          duration,
        },
      ],
      sourceId,
      caster,
      target,
      context,
    ),
    dndEvent(`${NS}:effectAdded`, {
      actor: target.id,
      effect: {
        sourceId: `${sourceId}${ALOFT}`,
        casterId: caster.id,
        modifier: { kind: "aloft", feet },
        ends: "spellDuration",
      },
    }),
  ];
}

function besideWall(actor: Actor, state: DndState): boolean {
  const at = actor.position;
  if (!at) return false;
  const walls = blockingSet(state);
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (walls.has(squareKey({ x: at.x + dx, y: at.y + dy }))) return true;
    }
  }
  return false;
}

// The creatures whose lift has ended fall together, one frame for each height, so one Feather Fall can catch them.
export function fallFrames(state: DndState): Frame[] {
  const heights = new Map<number, string[]>();
  for (const actor of Object.values(state.actors)) {
    const aloft = actor.activeEffects.find(
      ({ modifier }) => modifier.kind === "aloft",
    );
    if (aloft?.modifier.kind !== "aloft" || held(actor, aloft)) continue;
    const { feet } = aloft.modifier;
    heights.set(feet, [...(heights.get(feet) ?? []), actor.id]);
  }
  return [...heights].map(([feet, actors]) => frame("fall", { actors, feet }));
}

const FallSchema = z.object({ actors: z.array(z.string()), feet: z.number() });

// A reaction that answers a fall, and those of the fallers it can catch: on its own side, within its reach and seen.
function catcher(
  falling: readonly Actor[],
  passed: readonly string[],
  context: Context,
): {
  readonly bearer: Actor;
  readonly action: KnownAction;
  readonly caught: readonly Actor[];
} | null {
  for (const bearer of Object.values(context.state.actors)) {
    if (
      passed.includes(bearer.id) ||
      isDown(bearer) ||
      isDead(bearer) ||
      hasCondition(bearer, ...INCAPACITATING)
    ) {
      continue;
    }
    const stats = deriveStats(bearer, context);
    for (const action of stats.actions) {
      const trigger = action.activation.trigger;
      if (!trigger?.falls || !canAfford(action, bearer, stats)) continue;
      const within = trigger.within ?? 60;
      const slow = slowFallOf(action);
      const caught = falling
        .filter(
          (item) =>
            item.side === bearer.side &&
            distanceFeet(item.position, bearer.position) <= within &&
            (item.id === bearer.id ||
              seeing(bearer, item.position, context.state, context) !== "none"),
        )
        .slice(0, slow);
      if (caught.length > 0) return { bearer, action, caught };
    }
  }
  return null;
}

const slowFallOf = (action: KnownAction): number => {
  const { resolution } = action.activation;
  const effects = resolution.kind === "automatic" ? resolution.effects : [];
  const slow = effects.find((effect) => effect.kind === "slowFall");
  return slow?.kind === "slowFall" ? slow.creatures : 0;
};

export function runFall(
  payload: z.infer<typeof FallSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const falling = payload.actors.flatMap((id) => {
    const actor = state.actors[id];
    return actor ? [actor] : [];
  });
  const events: SystemEvent[] = falling.flatMap((actor) =>
    actor.activeEffects.flatMap(({ modifier, sourceId, casterId }) =>
      modifier.kind === "aloft"
        ? [
            dndEvent(`${NS}:effectEnded`, {
              actor: actor.id,
              sourceId,
              casterId,
            }),
          ]
        : [],
    ),
  );
  // Feather Fall: each bearer that can catches some of its side's fallers, the player once asked.
  const safe = new Set<string>();
  const passed: string[] = [];
  for (;;) {
    const left = falling.filter((item) => !safe.has(item.id));
    const found = catcher(left, passed, context);
    if (!found) break;
    passed.push(found.bearer.id);
    if (
      found.bearer.id === PLAYER_ACTOR &&
      !playerTakes(
        "falls",
        `${found.caught.map((item) => item.name).join(", ")} ${found.caught.length === 1 ? "falls" : "fall"} ${String(payload.feet)} feet. Use ${found.action.name}?`,
        found.action,
        context,
      )
    ) {
      continue;
    }
    events.push(...reactionCosts(found.bearer, found.action, context));
    for (const item of found.caught) safe.add(item.id);
  }
  const frames: Frame[] = [];
  const count = Math.min(20, Math.floor(payload.feet / 10));
  for (const actor of falling) {
    if (safe.has(actor.id) || count === 0) continue;
    let rolled = 0;
    for (let die = 0; die < count; die += 1) rolled += dice.roll(6);
    const amount = finalDamage(
      rolled,
      "bludgeoning",
      damageResponses(actor, context),
    );
    const dealt = dealEvents(
      actor,
      [{ amount, type: "bludgeoning" }],
      false,
      context,
    );
    events.push(...dealt.events);
    if (dealt.dealt > 0) {
      events.push(
        ...leafEvents(
          [
            {
              kind: "applyCondition",
              condition: "prone",
              duration: "instantaneous",
              repeatSave: false,
              endsOnDamage: false,
            },
          ],
          "fall",
          actor,
          actor,
          context,
        ),
      );
    }
    frames.push(
      ...afterDamage(
        actor,
        dealt.dealt,
        { types: ["bludgeoning"] },
        concentrationFrame(actor, dealt.dealt),
        context,
      ),
    );
  }
  return { events, frames };
}

export const fallingFrames = {
  [`${NS}:fall`]: frameHandler({ schema: FallSchema, run: runFall }),
};
