import { z } from "zod";
import {
  type ContentAccess,
  frameHandler,
  PLAYER_ACTOR,
  type Frame,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { distanceFeet, squareKey } from "../grid.ts";
import { blockingSet, inZone, zonesOf } from "../zones.ts";
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
import { climbsCeilings, hovers, speedsOf } from "../movement-modes.ts";
import { speedOf } from "../tactics.ts";
import { canAfford, type Context, hasPassive, speedsLeft } from "./queries.ts";
import { afterDamage, playerTakes, reactionCosts } from "./reactions.ts";

// Height and falling. A flyer or a climber goes up on its turn, and Reverse Gravity or Levitate lifts creatures up.
// One up there is that much farther from those below (reaches, provokers). A lifted creature falls once its lift
// ends, and a flyer once it's Prone, Incapacitated or can't move, unless it hovers, or once it loses its Fly Speed.
// A fall deals 1d6 Bludgeoning per 10 feet, at most 20d6, and leaves the creature Prone, unless a reaction such as
// Feather Fall lets it down gently, or Levitate floats it down.
// shortcut: a square holds the creatures above it as well as those on the ground, so one up there still blocks the
// way and takes a space.

const ALOFT = ":aloft";
// The source of a height a creature reached on its own Speed.
export const FLIGHT = "flight";
const STEP = 10;

// How far up a creature is: its height while what holds it there lasts, else 0. One that went up itself stays until
// it lands or falls (fallFrames).
export function heightOf(actor: Actor): number {
  const aloft = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "aloft",
  );
  return aloft?.modifier.kind === "aloft" &&
    (aloft.modifier.mode !== undefined || held(actor, aloft))
    ? aloft.modifier.feet
    : 0;
}

// The Speed it went up with, while it's up on its own.
export function aloftMode(actor: Actor): "fly" | "climb" | null {
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "aloft" && modifier.mode) return modifier.mode;
  }
  return null;
}

// Whether a creature up on its own stays there: it still has that Speed and can move, and a flyer isn't Prone or
// Incapacitated unless it hovers. A climber holds on the same way.
function staysUp(
  actor: Actor,
  mode: "fly" | "climb",
  access: ContentAccess,
): boolean {
  const stats = deriveStats(actor, access);
  const feet = speedsOf(actor, stats).get(mode) ?? 0;
  const stuck =
    feet <= 0 ||
    speedOf(actor, { ...stats, speed: feet }) <= 0 ||
    hasCondition(actor, "grappled", "restrained");
  const down = isDown(actor) || hasCondition(actor, "prone", ...INCAPACITATING);
  return mode === "fly" && hovers(actor, stats) ? feet > 0 : !stuck && !down;
}

// Going up or down `STEP` feet with a fly or climb Speed, which costs that much movement: up from where it stands
// (a climber beside a wall, or anywhere if it climbs ceilings), or down while it's up on its own.
export function heightChoices(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): readonly { readonly mode: "fly" | "climb"; readonly up: boolean }[] {
  if (!state.combat || !actor.position) return [];
  const height = heightOf(actor);
  const own = aloftMode(actor);
  if (height > 0 && !own) return []; // held up by a spell
  const stats = deriveStats(actor, access);
  const left = speedsLeft(actor, stats);
  const choices: { mode: "fly" | "climb"; up: boolean }[] = [];
  for (const mode of ["fly", "climb"] as const) {
    if ((own && own !== mode) || (left.get(mode) ?? 0) < STEP) continue;
    const grips =
      mode === "fly" ||
      climbsCeilings(actor, stats) ||
      besideWall(actor, state);
    if (grips && staysUp(actor, mode, access)) choices.push({ mode, up: true });
    if (own === mode) choices.push({ mode, up: false });
  }
  return choices;
}

const HeightSchema = z.object({
  actor: z.string(),
  mode: z.enum(["fly", "climb"]),
  up: z.boolean(),
});

// One such step, after the Opportunity Attacks it provokes, unless one of them stopped or felled it.
function runChangeHeight(
  payload: z.infer<typeof HeightSchema>,
  context: Context,
): SystemResult {
  const actor = context.state.actors[payload.actor];
  if (!actor || isDown(actor) || isDead(actor)) return {};
  const left = speedsLeft(actor, deriveStats(actor, context)).get(payload.mode);
  if (
    (left ?? 0) < STEP ||
    (payload.up && !staysUp(actor, payload.mode, context))
  )
    return {};
  return { events: heightEvents(actor, payload) };
}

// The events of one such step: the new height, and the movement it costs.
export function heightEvents(
  actor: Actor,
  { mode, up }: { readonly mode: "fly" | "climb"; readonly up: boolean },
): SystemEvent[] {
  const feet = heightOf(actor) + (up ? STEP : -STEP);
  return [
    ...(aloftMode(actor)
      ? [
          dndEvent(`${NS}:effectEnded`, {
            actor: actor.id,
            sourceId: FLIGHT,
            casterId: actor.id,
          }),
        ]
      : []),
    ...(feet > 0
      ? [
          dndEvent(`${NS}:effectAdded`, {
            actor: actor.id,
            effect: {
              sourceId: FLIGHT,
              casterId: actor.id,
              modifier: { kind: "aloft", feet, mode },
              ends: "spellDuration",
            },
          }),
        ]
      : []),
    ...(actor.position
      ? [
          dndEvent(`${NS}:moved`, {
            actor: actor.id,
            to: actor.position,
            feet: STEP,
          }),
        ]
      : []),
  ];
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
  { feet, duration, grab, gentle }: Extract<LeafEffect, { kind: "lift" }>,
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
        modifier: { kind: "aloft", feet, ...(gentle ? { gentle } : {}) },
        ends: "spellDuration",
      },
    }),
  ];
}

function besideWall(actor: Actor, state: DndState): boolean {
  const at = actor.position;
  if (!at) return false;
  const walls = blockingSet(state, "walking");
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (walls.has(squareKey({ x: at.x + dx, y: at.y + dy }))) return true;
    }
  }
  return false;
}

// The creatures whose lift has ended or who can't stay up fall together, one frame for each height, so one Feather
// Fall can catch them. Those Levitate held float down in a frame of their own.
export function fallFrames(context: Context): Frame[] {
  const heights = new Map<string, string[]>();
  for (const actor of Object.values(context.state.actors)) {
    const aloft = actor.activeEffects.find(
      ({ modifier }) => modifier.kind === "aloft",
    );
    if (aloft?.modifier.kind !== "aloft") continue;
    const { feet, mode } = aloft.modifier;
    if (mode ? staysUp(actor, mode, context) : held(actor, aloft)) continue;
    // Earthbind brings a flyer down safely.
    const gentle =
      aloft.modifier.gentle === true ||
      actor.activeEffects.some(({ modifier }) => modifier.kind === "grounded");
    const key = `${String(feet)}${gentle ? ":gentle" : ""}`;
    heights.set(key, [...(heights.get(key) ?? []), actor.id]);
  }
  return [...heights].map(([key, actors]) =>
    frame("fall", {
      actors,
      feet: Number.parseInt(key, 10),
      ...(key.endsWith(":gentle") ? { gentle: true } : {}),
    }),
  );
}

// Landing in an updraft, as Control Winds', hurts half as much.
const softLanding = (actor: Actor, state: DndState): boolean =>
  zonesOf(state).some(
    (zone) => zone.area?.softFalls === true && inZone(zone, actor.position),
  );

const FallSchema = z.object({
  actors: z.array(z.string()),
  feet: z.number(),
  gentle: z.boolean().optional(), // floats down unhurt, as from Levitate
});

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
      const own = slowFallReduce(action) !== undefined; // Slow Fall eases only its bearer
      const caught = falling
        .filter(
          (item) =>
            (!own || item.id === bearer.id) &&
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

const slowFallReduce = (action: KnownAction) => {
  const { resolution } = action.activation;
  const effects = resolution.kind === "automatic" ? resolution.effects : [];
  const slow = effects.find((effect) => effect.kind === "slowFall");
  return slow?.kind === "slowFall" ? slow.reduce : undefined;
};

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
  if (payload.gentle) return { events };
  // A Ring of Feather Falling's wearer comes down unhurt.
  const safe = new Set<string>(
    falling.flatMap((actor) =>
      hasPassive(deriveStats(actor, context), "featherFall") ? [actor.id] : [],
    ),
  );
  // Slow Fall lessens the damage by its bearer's amount.
  const lessened = new Map<string, number>();
  // Feather Fall: each bearer that can catches some of its side's fallers, the player once asked.
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
    const reduce = slowFallReduce(found.action);
    for (const item of found.caught) {
      if (reduce) {
        lessened.set(
          item.id,
          (lessened.get(item.id) ?? 0) +
            evaluateFormula(reduce, deriveStats(found.bearer, context)),
        );
      } else safe.add(item.id);
    }
  }
  const frames: Frame[] = [];
  const count = Math.min(20, Math.floor(payload.feet / 10));
  for (const actor of falling) {
    if (safe.has(actor.id) || count === 0) continue;
    let rolled = 0;
    for (let die = 0; die < count; die += 1) rolled += dice.roll(6);
    // Low Gravity: falls hurt half as much.
    const fallen = Math.max(
      0,
      (context.state.combat?.environment?.halfFalls ||
      softLanding(actor, context.state)
        ? Math.floor(rolled / 2)
        : rolled) - (lessened.get(actor.id) ?? 0),
    );
    const amount = finalDamage(
      fallen,
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
  [`${NS}:changeHeight`]: frameHandler({
    schema: HeightSchema,
    run: runChangeHeight,
  }),
};
