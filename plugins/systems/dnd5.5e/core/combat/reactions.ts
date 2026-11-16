import { damageBurstFrames } from "./areas.ts";
import { z } from "zod";
import { blockedSquares } from "../zones.ts";
import {
  awaitDecision,
  type Frame,
  frameHandler,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import {
  type Actor,
  dndEvent,
  EffectAddedSchema,
  equipped,
  frame,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
} from "../state.ts";
import { distanceFeet, squareKey, type Square } from "../grid.ts";
import { seeing } from "../sight.ts";
import { DamageTypeSchema, type LeafEffect, WeaponSchema } from "../schemas.ts";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  rollAmount,
  type Stats,
} from "../stats.ts";
import { rollD20 } from "../rules.ts";
import { DECLINE } from "./ids.ts";
import { teleportFrame } from "./movement.ts";
import {
  actorOf,
  allies,
  canAfford,
  CHECK_END,
  type Context,
  meleeReach,
  sizeOf,
  SIZES,
  SPLITS,
} from "./queries.ts";
import {
  leafEvents,
  payCosts,
  resolveAction,
  resolveTargets,
} from "./effects.ts";

// Reactions that answer something another creature does: a d20 roll before its result applies, damage, an attack
// on the bearer or someone near it, a walk, a turn starting or a save to keep Concentration. The player is asked
// where the moment is a frame of its own; monsters and companions take a reaction by tactics, whenever it would
// help their side. Hits the bearer could still turn aside are answered in attack.ts.

type Trigger = NonNullable<KnownAction["activation"]["trigger"]>;

const effectsOf = (action: KnownAction): readonly LeafEffect[] => {
  const { resolution } = action.activation;
  return resolution.kind === "attack"
    ? resolution.onHit
    : resolution.kind === "save"
      ? resolution.onFail
      : resolution.effects;
};

// Whether a creature could take this action now: up, able to act, and able to pay for it.
function ready(actor: Actor, action: KnownAction, stats: Stats): boolean {
  return (
    !isDown(actor) &&
    !isDead(actor) &&
    !hasCondition(actor, ...INCAPACITATING) &&
    canAfford(action, actor, stats)
  );
}

const near = (a: Actor, b: Actor, feet: number | undefined): boolean =>
  feet === undefined || distanceFeet(a.position, b.position) <= feet;

const sees = (watcher: Actor, other: Actor, context: Context): boolean =>
  watcher.id === other.id ||
  seeing(watcher, other.position, context.state, context) !== "none";

// What taking a reaction costs, named so the log says which reaction it was.
export function reactionCosts(
  actor: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  return payCosts(action, actor, context).map((event) =>
    event.kind === `${NS}:budgetSpent`
      ? dndEvent(`${NS}:budgetSpent`, {
          actor: actor.id,
          kind: "reaction",
          label: action.name,
        })
      : event,
  );
}

// ---- A d20 roll, before its result applies ----

export interface Roll {
  readonly roller: Actor;
  readonly kind: "attack" | "save" | "check";
  readonly natural: number;
  readonly total: number;
  readonly success: boolean;
  readonly goal: number; // the AC or DC
  readonly against?: Actor; // an attack's target
  readonly magical?: boolean;
  readonly critical?: boolean;
}

export interface Edge {
  readonly advantage: boolean;
  readonly disadvantage: boolean;
}

// Whether the bearer wants this roll to succeed: its own side's roll, or else a foe's attack on someone else.
function wantsSuccess(bearer: Actor, roll: Roll): boolean {
  return roll.roller.side === bearer.side;
}

function matchesRoll(
  bearer: Actor,
  trigger: Trigger,
  roll: Roll,
  context: Context,
): boolean {
  const rolled = trigger.rolled;
  if (!rolled?.rolls.includes(roll.kind)) return false;
  // Defensive Divination's `magical` is for the saves it answers, not the hits.
  const asSave = rolled.when !== "hitOrFailed" || roll.kind !== "attack";
  if (rolled.magical && !roll.magical && asSave) return false;
  const self = bearer.id === roll.roller.id;
  const ally = !self && bearer.side === roll.roller.side;
  const foe = bearer.side !== roll.roller.side;
  const by = {
    self,
    ally,
    selfOrAlly: self || ally,
    foe,
    any: true,
  }[rolled.by];
  if (!by) return false;
  // A foe's attack is measured to the creature it's aimed at, which the bearer is looking after.
  const subject = foe && roll.kind === "attack" ? roll.against : roll.roller;
  if (!subject) return false;
  if (rolled.when === "hit") {
    if (roll.kind !== "attack" || !roll.success || !foe) return false;
    // A hit on the bearer, or with `within` on an ally that near it.
    if (subject.id !== bearer.id && trigger.within === undefined) return false;
    if (subject.side !== bearer.side) return false;
  }
  if (rolled.when === "hitOrFailed") {
    if (subject.id === bearer.id || subject.side !== bearer.side) return false;
    if (roll.kind === "attack" ? !foe || !roll.success : foe || roll.success) {
      return false;
    }
  }
  if (rolled.when === "natural1" && roll.natural !== 1) return false;
  if (rolled.when === "failed" && roll.success) return false;
  return (
    near(bearer, subject, trigger.within) && sees(bearer, subject, context)
  );
}

// The most a response could move the roll, for whether it can change the result at all.
function swing(
  effect: LeafEffect,
  stats: Stats,
): { readonly up: number; readonly down: number } | null {
  if (effect.kind === "reroll" || effect.kind === "replaceRoll") {
    return { up: 20, down: 20 };
  }
  if (effect.kind !== "rollBonus") return null;
  const most = rollAmount(effect.amount, stats, {
    roll: (sides: number) => sides,
    below: () => 0,
  });
  return { up: most, down: effect.either ? most : 0 };
}

function helps(
  bearer: Actor,
  action: KnownAction,
  roll: Roll,
  context: Context,
): boolean {
  const want = wantsSuccess(bearer, roll);
  if (want === roll.success) return false;
  const stats = deriveStats(bearer, context);
  return effectsOf(action).some((effect) => {
    const moves = swing(effect, stats);
    if (!moves) return false;
    if (want) {
      return effect.kind === "rollBonus"
        ? roll.natural !== 1 && roll.total + moves.up >= roll.goal
        : true;
    }
    // A natural 20 on an attack hits whatever is added to it.
    return effect.kind === "rollBonus"
      ? !roll.critical && roll.total - moves.down < roll.goal
      : true;
  });
}

// The first creature that would answer this roll, and with what.
export function rollResponder(
  roll: Roll,
  passed: readonly string[],
  context: Context,
): { readonly reactor: Actor; readonly action: KnownAction } | null {
  for (const bearer of Object.values(context.state.actors)) {
    if (
      passed.includes(bearer.id) ||
      (!bearer.position && context.state.combat)
    )
      continue;
    const stats = deriveStats(bearer, context);
    const action = stats.actions.find(
      (item) =>
        item.activation.trigger !== undefined &&
        matchesRoll(bearer, item.activation.trigger, roll, context) &&
        ready(bearer, item, stats) &&
        helps(bearer, item, roll, context),
    );
    if (action) return { reactor: bearer, action };
  }
  return null;
}

// Takes the response: what it costs, and the new natural roll and bonus it leaves.
export function respond(
  reactor: Actor,
  action: KnownAction,
  roll: Roll,
  edge: Edge,
  context: Context,
): {
  readonly events: SystemEvent[];
  readonly natural: number;
  readonly bonus: number;
} {
  const want = wantsSuccess(reactor, roll);
  const stats = deriveStats(reactor, context);
  let natural = roll.natural;
  let bonus = 0;
  for (const effect of effectsOf(action)) {
    if (effect.kind === "reroll") {
      natural = rollD20(context.dice, edge).natural;
    } else if (effect.kind === "replaceRoll") {
      const die = context.dice.roll(20);
      if (want ? die > natural : die < natural) natural = die;
    } else if (effect.kind === "rollBonus") {
      const amount = rollAmount(effect.amount, stats, context.dice);
      bonus += want || !effect.either ? amount : -amount;
    }
  }
  return { events: reactionCosts(reactor, action, context), natural, bonus };
}

const ROLL_WORDS = { attack: "an attack", save: "a save", check: "a check" };

// Asks the player whether to take a reaction in the middle of a step, as Lucky on a save. The step is run again
// once they answer (SystemContext.ask). Where nobody can be asked, it's taken, as tactics only offer what helps.
export function playerTakes(
  key: string,
  prompt: string,
  action: KnownAction,
  context: Context,
): boolean {
  if (!context.ask) return true;
  return (
    context.ask({
      id: `${NS}:reaction:${PLAYER_ACTOR}:${key}`,
      actor: PLAYER_ACTOR,
      prompt,
      options: [
        { id: action.id, label: action.name },
        { id: DECLINE, label: "Let it stand" },
      ],
    }) !== DECLINE
  );
}

// Settles a roll made inside other work, a save or a check: monsters and companions answer it by tactics, and
// the player is asked.
export function settleRoll(
  roll: Roll,
  edge: Edge,
  judge: (
    natural: number,
    bonus: number,
  ) => { total: number; success: boolean },
  context: Context,
): {
  readonly natural: number;
  readonly bonus: number;
  readonly events: SystemEvent[];
} {
  const passed: string[] = [];
  const events: SystemEvent[] = [];
  let current = roll;
  let bonus = 0;
  for (;;) {
    const found = rollResponder(current, passed, context);
    if (!found) break;
    passed.push(found.reactor.id);
    if (
      found.reactor.id === PLAYER_ACTOR &&
      !playerTakes(
        `${roll.kind}:${roll.roller.id}`,
        `${roll.roller.id === PLAYER_ACTOR ? "You roll" : `${roll.roller.name} rolls`} ${String(current.natural)} (${String(current.total)}) on ${ROLL_WORDS[roll.kind]} against ${String(roll.goal)}: ${current.success ? "a success" : "a failure"}. Use ${found.action.name}?`,
        found.action,
        context,
      )
    ) {
      continue;
    }
    const taken = respond(found.reactor, found.action, current, edge, context);
    events.push(...taken.events);
    bonus += taken.bonus;
    current = {
      ...current,
      natural: taken.natural,
      ...judge(taken.natural, bonus),
    };
  }
  return { natural: current.natural, bonus, events };
}

// ---- Moments: something happened that a reaction may answer ----

export const MomentSchema = z.object({
  kind: z.enum([
    "damaged",
    "struck",
    "missed",
    "hitOther",
    "entered",
    "endsMove",
    "turnStart",
    "concentrationSave",
    "saved",
    "studied",
  ]),
  actor: z.string(), // the creature it happened to, or the one walking or starting its turn
  source: z.string().optional(), // the creature that did it: the damager or the attacker
  types: z.array(DamageTypeSchema).optional(),
  melee: z.boolean().optional(),
  ranged: z.boolean().optional(),
  spell: z.boolean().optional(), // it came from a spell
  success: z.boolean().optional(), // a save's result, for "saved"
  from: z.object({ x: z.number(), y: z.number() }).optional(), // the square a walker entered from
  weapon: z.string().optional(), // the action of the weapon attack that missed, for Sticky Shield
  passed: z.array(z.string()).optional(), // creatures that already answered it or turned it down
});
export type Moment = z.infer<typeof MomentSchema>;

function reachOf(bearer: Actor, trigger: Trigger, stats: Stats): number | null {
  if (trigger.within !== undefined) return trigger.within;
  const reaches = stats.actions.flatMap((action) => {
    const reach = meleeReach(action);
    return reach !== null &&
      action.activation.resolution.kind === "attack" &&
      !action.activation.trigger
      ? [reach]
      : [];
  });
  return reaches.length > 0 ? Math.max(...reaches) : null;
}

// Whether the bearer holds what the reaction needs: a Quarterstaff, a Spear or a Heavy weapon with Reach.
function holdsPolearm(bearer: Actor, context: Context): boolean {
  return equipped(bearer).some((id) => {
    const weapon = WeaponSchema.safeParse(context.content(id)).data;
    return (
      weapon !== undefined &&
      (/(?:^|[:/-])(?:quarterstaff|spear)$/.test(id) ||
        (weapon.properties.includes("heavy") &&
          weapon.properties.includes("reach")))
    );
  });
}

// The creature a reaction to this moment is aimed back at.
function culprit(
  moment: Moment,
  context: Context,
  action?: KnownAction,
): Actor | undefined {
  // Bloodthirsty Slash goes for the creature that was hurt, not whoever hurt it.
  const other = action?.activation.trigger?.otherDamaged !== undefined;
  const id =
    !other &&
    (moment.kind === "damaged" ||
      moment.kind === "struck" ||
      moment.kind === "missed" ||
      moment.kind === "hitOther" ||
      moment.kind === "saved")
      ? moment.source
      : moment.actor;
  return id ? context.state.actors[id] : undefined;
}

function matchesMoment(
  bearer: Actor,
  trigger: Trigger,
  moment: Moment,
  stats: Stats,
  context: Context,
): boolean {
  const { state } = context;
  const subject = state.actors[moment.actor];
  if (!subject) return false;
  const self = subject.id === bearer.id;
  const source = moment.source ? state.actors[moment.source] : undefined;
  const typed =
    trigger.damagedBy === undefined ||
    trigger.damagedBy.some((type) => moment.types?.includes(type));
  const kindOk =
    (!trigger.bySpell || moment.spell === true) &&
    (!trigger.melee || moment.melee === true) &&
    (!trigger.ranged || moment.ranged === true) &&
    typed;
  const hostile = subject.side !== bearer.side;
  switch (moment.kind) {
    case "damaged":
      if (trigger.otherDamaged === "bloodied" && !self) {
        const max = deriveStats(subject, context).maxHp;
        return (
          subject.hp > 0 &&
          subject.hp * 2 <= max &&
          near(bearer, subject, trigger.within) &&
          sees(bearer, subject, context)
        );
      }
      return (
        self &&
        trigger.damaged === true &&
        !trigger.before &&
        (kindOk ||
          (trigger.bloodied === true &&
            subject.hp * 2 <= deriveStats(subject, context).maxHp)) &&
        (trigger.within === undefined ||
          (source !== undefined && near(bearer, source, trigger.within)))
      );
    case "struck":
    case "missed":
      return (
        self &&
        trigger[moment.kind] === true &&
        kindOk &&
        source !== undefined &&
        near(bearer, source, trigger.within) &&
        sees(bearer, source, context)
      );
    case "saved":
      return (
        self &&
        !trigger.before &&
        trigger.ownSave === (moment.success ? "succeeded" : "failed") &&
        kindOk &&
        source !== undefined &&
        source.id !== bearer.id
      );
    case "hitOther":
      return (
        !self &&
        trigger.foeHitsOther === true &&
        source !== undefined &&
        source.side !== bearer.side &&
        near(bearer, source, trigger.within ?? 5)
      );
    case "entered": {
      if (!trigger.entersReach || !hostile || !moment.from) return false;
      if (trigger.holding === "polearm" && !holdsPolearm(bearer, context)) {
        return false;
      }
      const reach = reachOf(bearer, trigger, stats);
      return (
        reach !== null &&
        distanceFeet(subject.position, bearer.position) <= reach &&
        distanceFeet(moment.from, bearer.position) > reach &&
        sees(bearer, subject, context)
      );
    }
    case "endsMove":
    case "turnStart":
    case "concentrationSave":
    case "studied":
      return (
        trigger[moment.kind] === true &&
        hostile &&
        near(bearer, subject, trigger.within) &&
        sees(bearer, subject, context) &&
        (moment.kind !== "turnStart" || sees(subject, bearer, context))
      );
  }
}

// Whether a reaction aimed at a creature can reach it.
function inRange(
  bearer: Actor,
  action: KnownAction,
  target: Actor | undefined,
): boolean {
  const { targeting } = action.activation;
  if ("self" in targeting || "area" in targeting) return true;
  if (!target || isDead(target)) return false;
  const range = targeting.range;
  return (
    typeof range !== "number" ||
    distanceFeet(bearer.position, target.position) <= Math.max(range, 5)
  );
}

// Whether a strike's attack can reach the culprit, or it can walk there first.
function strikeReaches(
  bearer: Actor,
  action: KnownAction,
  target: Actor | undefined,
  context: Context,
): boolean {
  const strike = effectsOf(action).find((effect) => effect.kind === "strike");
  if (strike?.kind !== "strike") return true;
  if (!target || isDown(target) || isDead(target)) return false;
  if (strike.approach) return true;
  const attack = strikeAction(bearer, strike.action, context);
  const jump = attack && teleportOf(attack);
  const reach = jump
    ? jump.feet + (strike.near ?? 0)
    : attack
      ? (meleeReach(attack) ?? rangeOf(attack))
      : null;
  return (
    reach !== null && distanceFeet(bearer.position, target.position) <= reach
  );
}

const rangeOf = (action: KnownAction): number | null => {
  const { targeting } = action.activation;
  return "range" in targeting && typeof targeting.range === "number"
    ? targeting.range
    : null;
};

// The attack a strike makes: the action named, or the bearer's best melee weapon attack.
export function strikeAction(
  bearer: Actor,
  name: string | undefined,
  context: Context,
): KnownAction | undefined {
  const { actions } = deriveStats(bearer, context);
  if (name !== undefined) {
    return actions.find(
      (item) => item.name === name && !item.activation.trigger,
    );
  }
  return actions.find(
    (item) =>
      meleeReach(item) !== null &&
      item.activation.resolution.kind === "attack" &&
      !item.activation.trigger &&
      item.spellLevel === null,
  );
}

function responderTo(
  moment: Moment,
  context: Context,
): { readonly reactor: Actor; readonly action: KnownAction } | null {
  const passed = moment.passed ?? [];
  for (const bearer of Object.values(context.state.actors)) {
    if (passed.includes(bearer.id) || !bearer.position) continue;
    const stats = deriveStats(bearer, context);
    const action = stats.actions.find(
      (item) =>
        item.activation.trigger !== undefined &&
        matchesMoment(
          bearer,
          item.activation.trigger,
          moment,
          stats,
          context,
        ) &&
        ready(bearer, item, stats) &&
        inRange(bearer, item, culprit(moment, context, item)) &&
        strikeReaches(bearer, item, culprit(moment, context, item), context) &&
        !healsCulprit(item, culprit(moment, context, item), context) &&
        !shrugsOff(culprit(moment, context, item), item, bearer),
    );
    if (action) return { reactor: bearer, action };
  }
  return null;
}

// A creature that saved against this bearer's reaction and so stopped minding it, as with Unnerving Gaze.
function shrugsOff(
  target: Actor | undefined,
  action: KnownAction,
  bearer: Actor,
): boolean {
  return (
    target?.activeEffects.some(
      ({ modifier, sourceId, casterId }) =>
        modifier.kind === "areaImmunity" &&
        sourceId === action.id &&
        casterId === bearer.id,
    ) ?? false
  );
}

// Hellish Rebuke's fire on an iron golem would only heal it, so it isn't offered.
function healsCulprit(
  action: KnownAction,
  target: Actor | undefined,
  context: Context,
): boolean {
  const { resolution, targeting } = action.activation;
  if (!target || "self" in targeting || !("damage" in resolution)) return false;
  const { absorbs } = damageResponses(target, context);
  return resolution.damage.some(({ type }) => absorbs.includes(type));
}

// The frame that offers this moment's reactions, or none when nobody could take one.
export function reactFrames(
  moment: Moment,
  context: Context,
): readonly Frame[] {
  if (!context.state.combat) return [];
  return responderTo(moment, context) ? [frame("react", moment)] : [];
}

// Where a reaction that walks to its target stops: the open square next to it nearest the bearer.
export function besideSquare(
  bearer: Actor,
  target: Actor,
  context: Context,
): Square | null {
  const { combat, actors } = context.state;
  if (!combat?.grid || !target.position || !bearer.position) return null;
  const blocked = new Set([
    ...blockedSquares(context.state, "walking"),
    ...Object.values(actors).flatMap((item) =>
      item.position && item.id !== bearer.id && !isDown(item)
        ? [squareKey(item.position)]
        : [],
    ),
  ]);
  const options: Square[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const square = { x: target.position.x + dx, y: target.position.y + dy };
      if (
        (dx !== 0 || dy !== 0) &&
        square.x >= 0 &&
        square.y >= 0 &&
        square.x < combat.grid.width &&
        square.y < combat.grid.height &&
        !blocked.has(squareKey(square))
      ) {
        options.push(square);
      }
    }
  }
  const speed = deriveStats(bearer, context).speed;
  return (
    options
      .filter((square) => distanceFeet(bearer.position, square) <= speed)
      .sort(
        (a, b) =>
          distanceFeet(bearer.position, a) - distanceFeet(bearer.position, b),
      )[0] ?? null
  );
}

// Takes the reaction: its costs, then what it does to the creature that set it off, or round the bearer.
export function takeReaction(
  reactor: Actor,
  action: KnownAction,
  moment: Moment,
  context: Context,
): SystemResult {
  const target = culprit(moment, context, action);
  const { targeting } = action.activation;
  const targets =
    "self" in targeting
      ? [reactor]
      : "area" in targeting
        ? resolveTargets("", action, reactor, context)
        : target
          ? [target]
          : [];
  const events: SystemEvent[] = [...reactionCosts(reactor, action, context)];
  const frames: Frame[] = [];
  const result = resolveAction(action, reactor, targets, context);
  events.push(...(result.events ?? []));
  frames.push(...(result.frames ?? []));
  events.push(...stuckEvents(action, moment, target, result.events ?? []));
  for (const effect of effectsOf(action)) {
    if (effect.kind === "strike" && target && !isDown(target)) {
      const attack = strikeAction(reactor, effect.action, context);
      if (!attack) continue;
      const to = effect.approach
        ? besideSquare(reactor, target, context)
        : null;
      if (
        to &&
        distanceFeet(reactor.position, target.position) >
          (meleeReach(attack) ?? 5)
      ) {
        events.push(
          dndEvent(`${NS}:moved`, { actor: reactor.id, to, feet: 0 }),
        );
      }
      if (effect.advantage) {
        events.push(
          ...leafEvents(
            [
              {
                kind: "modifier",
                modifier: { kind: "advantage", on: "attacks", once: true },
                duration: { until: "yourNextTurnStart" },
              },
            ],
            action.id,
            reactor,
            reactor,
            context,
          ),
        );
      }
      if (attack.activation.resolution.kind === "attack") {
        frames.push(
          frame("attackRoll", {
            attacker: reactor.id,
            actionId: attack.id,
            target: target.id,
          }),
        );
      } else if (effect.near !== undefined && teleportOf(attack)) {
        // Pursuit: the Teleport lands near the creature that set it off.
        const jump = teleportOf(attack);
        if (jump) {
          frames.push(
            teleportFrame(
              reactor,
              jump.feet,
              jump.movement,
              context,
              jump.provokes,
              { actor: target.id, feet: effect.near },
            ),
          );
        }
      } else {
        // Another action it uses, as a nalfeshnee's Teleport, costs nothing more than the Reaction.
        const used = resolveAction(
          attack,
          reactor,
          "self" in attack.activation.targeting ? [reactor] : [target],
          context,
        );
        events.push(...(used.events ?? []));
        frames.push(...(used.frames ?? []));
      }
    } else if (effect.kind === "split") {
      events.push(...splitEvents(reactor, effect.minHp, effect.times, context));
    }
  }
  return { events, frames };
}

// Sticky Shield: the weapon that missed sticks for as long as the grapple the reaction made holds.
function stuckEvents(
  action: KnownAction,
  moment: Moment,
  target: Actor | undefined,
  events: readonly SystemEvent[],
): SystemEvent[] {
  if (
    !moment.weapon ||
    !target ||
    !effectsOf(action).some((effect) => effect.kind === "stickWeapon")
  ) {
    return [];
  }
  return events.flatMap((event) => {
    const added = EffectAddedSchema.safeParse(
      event.kind === `${NS}:effectAdded` && "payload" in event
        ? event.payload
        : undefined,
    ).data;
    const { effect } = added ?? {};
    return added?.actor === target.id &&
      effect?.sourceId === action.id &&
      effect.modifier.kind === "condition" &&
      effect.modifier.condition === "grappled"
      ? [
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              ...effect,
              modifier: { kind: "stuck", action: moment.weapon ?? "" },
            },
          }),
        ]
      : [];
  });
}

const teleportOf = (action: KnownAction) =>
  effectsOf(action).find((effect) => effect.kind === "teleport");

// A creature that splits: it keeps half its Hit Points, and a copy with the other half stands next to it. Each
// split is counted on both halves, which makes each one size smaller (sizeOf), so they stop once they've shrunk as
// far as they can.

function splitEvents(
  actor: Actor,
  minHp: number,
  times: number,
  context: Context,
): SystemEvent[] {
  const done = actor.resourcesSpent[SPLITS] ?? 0;
  if (
    actor.hp < minHp ||
    !actor.position ||
    done >= times ||
    sizeOf(actor, context) < SIZES.indexOf("medium")
  ) {
    return [];
  }
  const half = Math.floor(actor.hp / 2);
  const square = besideSquare(
    { ...actor, position: actor.position },
    actor,
    context,
  );
  if (!square) return [];
  const count = Object.keys(context.state.actors).filter((id) =>
    id.startsWith(`${actor.id}~`),
  ).length;
  return [
    dndEvent(`${NS}:hpSet`, { actor: actor.id, hp: half }),
    dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource: SPLITS }),
    dndEvent(`${NS}:summoned`, {
      actor: {
        ...actor,
        resourcesSpent: { ...actor.resourcesSpent, [SPLITS]: done + 1 },
        id: `${actor.id}~${String(count + 1)}`,
        name: actor.name,
        hp: half,
        tempHp: 0,
        position: square,
        concentratingOn: null,
      },
      after: actor.id,
    }),
  ];
}

export const ReactAnswerSchema = MomentSchema.extend({
  reactor: z.string(),
  actionId: z.string(),
  answer: z.string(),
});

// Offers the moment to the next creature that could answer it: the player decides, the rest take it by tactics.
export function runReact(moment: Moment, context: Context): SystemResult {
  const found = responderTo(moment, context);
  if (!found) return {};
  const { reactor, action } = found;
  const passed = [...(moment.passed ?? []), reactor.id];
  if (reactor.id === PLAYER_ACTOR) {
    const by = culprit(moment, context);
    return {
      frames: [
        awaitDecision({
          id: `${NS}:reaction:${reactor.id}`,
          actor: reactor.id,
          prompt: `${by && by.id !== reactor.id ? `${by.name}: ` : ""}take ${action.name}?`,
          options: [
            { id: action.id, label: action.name },
            { id: DECLINE, label: "Let it pass" },
          ],
          resume: frame("reactAnswer", {
            ...moment,
            reactor: reactor.id,
            actionId: action.id,
          }),
        }),
      ],
    };
  }
  const taken = takeReaction(reactor, action, moment, context);
  return {
    events: taken.events ?? [],
    frames: [
      ...(taken.frames ?? []),
      frame("react", { ...moment, passed }),
      CHECK_END,
    ],
  };
}

export function runReactAnswer(
  payload: z.infer<typeof ReactAnswerSchema>,
  context: Context,
): SystemResult {
  const { reactor: reactorId, actionId, answer, ...moment } = payload;
  const passed = [...(moment.passed ?? []), reactorId];
  const next = frame("react", { ...moment, passed });
  if (answer === DECLINE) return { frames: [next] };
  const reactor = actorOf(context.state, reactorId);
  const action = deriveStats(reactor, context).actions.find(
    (item) => item.id === actionId,
  );
  if (!action) return { frames: [next] };
  const taken = takeReaction(reactor, action, moment, context);
  return {
    events: taken.events ?? [],
    frames: [...(taken.frames ?? []), next, CHECK_END],
  };
}

// The frames that follow damage: the save to keep Concentration, then whatever answers it.
export function afterDamage(
  target: Actor,
  dealt: number,
  cause: Omit<Moment, "kind" | "actor" | "passed">,
  concentration: readonly Frame[],
  context: Context,
): readonly Frame[] {
  if (dealt <= 0) return concentration;
  return [
    ...concentration,
    ...reactFrames({ kind: "damaged", actor: target.id, ...cause }, context),
    ...damageBurstFrames(target, cause.types ?? [], context),
  ];
}

// Before damage lands: a reaction that lessens it, as Vitality Ward or Elemental Absorption does. The player is
// asked; anyone else takes it whenever it applies.
export function beforeDamage(
  target: Actor,
  amount: number,
  type: z.infer<typeof DamageTypeSchema>,
  context: Context,
): { readonly amount: number; readonly events: SystemEvent[] } {
  if (amount <= 0 || !context.state.combat) return { amount, events: [] };
  const stats = deriveStats(target, context);
  const action = stats.actions.find((item) => {
    const trigger = item.activation.trigger;
    return (
      trigger?.damaged === true &&
      trigger.before === true &&
      (trigger.damagedBy?.includes(type) ?? true) &&
      ready(target, item, stats)
    );
  });
  if (
    !action ||
    (target.id === PLAYER_ACTOR &&
      !playerTakes(
        `damage:${type}`,
        `${String(amount)} ${type} damage is coming. Use ${action.name}?`,
        action,
        context,
      ))
  ) {
    return { amount, events: [] };
  }
  let left = amount;
  for (const effect of effectsOf(action)) {
    if (effect.kind === "resistTrigger") left = Math.floor(left / 2);
    if (effect.kind === "reduceDamage") {
      left = effect.halve ? Math.floor(left / 2) : left;
      if (effect.amount) left -= rollAmount(effect.amount, stats, context.dice);
    }
  }
  const lifted = effectsOf(action).filter((effect) => effect.kind === "tempHp");
  return {
    amount: Math.max(0, left),
    events: [
      ...reactionCosts(target, action, context),
      ...leafEvents(lifted, action.id, target, target, context),
    ],
  };
}

// A reaction's table, as Mythal Ward's: the die picks a row, which is resolved at those it names. `negate` says the
// spell that set it off does nothing to the bearer.
export function rollOnTable(
  action: KnownAction,
  bearer: Actor,
  source: Actor | undefined,
  spellLevel: number,
  context: Context,
): {
  readonly events: SystemEvent[];
  readonly frames: Frame[];
  readonly negate: boolean;
} {
  const { table } = action.activation;
  if (!table) return { events: [], frames: [], negate: false };
  const die = context.dice.roll(table.die);
  const events: SystemEvent[] = [
    dndEvent(`${NS}:rollReported`, {
      actor: bearer.id,
      against: bearer.id,
      natural: die,
      total: die,
      target: 0,
      success: true,
      label: action.name,
    }),
  ];
  const row = table.rows.find((item) => item.min <= die && die <= item.max);
  if (!row?.resolution) {
    return { events, frames: [], negate: row?.negate === true };
  }
  const within = row.within;
  const targets = [
    ...(row.targets.includes("self") ? [bearer] : []),
    ...(row.targets.includes("source") && source ? [source] : []),
    ...(within === undefined
      ? []
      : Object.values(context.state.actors).filter(
          (item) =>
            !isDown(item) && !isDead(item) && near(bearer, item, within),
        )),
  ].filter(
    (item, index, list) =>
      list.findIndex((other) => other.id === item.id) === index,
  );
  const { resolution } = row;
  const scaled =
    row.perSpellLevel && "damage" in resolution
      ? {
          ...resolution,
          damage: resolution.damage.map((item) => ({
            ...item,
            amount: {
              ...item.amount,
              ...(item.amount.dice
                ? {
                    dice: item.amount.dice.replace(
                      /^(\d+)d/,
                      (_, count: string) =>
                        `${String(Number(count) * Math.max(1, spellLevel))}d`,
                    ),
                  }
                : {}),
            },
          })),
        }
      : resolution;
  const rolled = resolveAction(
    {
      ...action,
      activation: {
        ...action.activation,
        cost: [],
        targeting: { self: true },
        resolution: scaled,
      },
    },
    bearer,
    targets,
    context,
  );
  return {
    events: [...events, ...(rolled.events ?? [])],
    frames: [...(rolled.frames ?? [])],
    negate: row.negate === true,
  };
}

// A spell turned aside by Mythal Ward gives its slot back.
export function slotRefund(
  caster: Actor,
  spell: KnownAction,
  level: number,
): SystemEvent[] {
  return level > 0 && spell.activation.cost.includes("slot")
    ? [
        dndEvent(`${NS}:resourceRestored`, {
          actor: caster.id,
          resource: `slot:${String(level)}`,
          amount: 1,
        }),
      ]
    : [];
}

// A reaction taken before a failed save against a spell lands, as Mythal Ward: the player is asked; anyone else
// takes it.
export function beforeFailedSave(
  target: Actor,
  caster: Actor,
  spellLevel: number,
  context: Context,
): {
  readonly events: SystemEvent[];
  readonly frames: Frame[];
  readonly negate: boolean;
} {
  const none = { events: [], frames: [], negate: false };
  if (!context.state.combat || target.id === caster.id) return none;
  const stats = deriveStats(target, context);
  const action = stats.actions.find((item) => {
    const trigger = item.activation.trigger;
    return (
      trigger?.ownSave === "failed" &&
      trigger.before === true &&
      ready(target, item, stats)
    );
  });
  if (
    !action ||
    (target.id === PLAYER_ACTOR &&
      !playerTakes(
        "failedSave",
        `You fail the save against ${caster.name}'s spell. Use ${action.name}?`,
        action,
        context,
      ))
  ) {
    return none;
  }
  const rolled = rollOnTable(action, target, caster, spellLevel, context);
  return {
    ...rolled,
    events: [...reactionCosts(target, action, context), ...rolled.events],
  };
}

// Tireless Reveler: an ally who spends Heroic Inspiration gives it to a bearer within range who has none.
export function inspirationEchoes(
  spender: Actor,
  context: Context,
): SystemEvent[] {
  return allies(context.state, spender).flatMap((bearer) => {
    if (bearer.id === spender.id || bearer.heroicInspiration) return [];
    const stats = deriveStats(bearer, context);
    const action = stats.actions.find(
      (item) =>
        item.activation.trigger?.inspirationSpent === true &&
        near(bearer, spender, item.activation.trigger.within) &&
        (!context.state.combat || sees(bearer, spender, context)) &&
        ready(bearer, item, stats),
    );
    return action
      ? [
          ...payCosts(action, bearer, context),
          dndEvent(`${NS}:inspirationGranted`, { actor: bearer.id }),
        ]
      : [];
  });
}

// Alert's Initiative Swap, right after Initiative: the player picks an ally or keeps their place. A companion keeps
// its place, since a swap inside the party only moves who goes first.
export function initiativeSwapFrames(
  party: readonly Actor[],
  context: Context,
): readonly Frame[] {
  const player = party.find((actor) => actor.id === PLAYER_ACTOR);
  if (!player || hasCondition(player, ...INCAPACITATING)) return [];
  const stats = deriveStats(player, context);
  const action = stats.actions.find(
    (item) =>
      item.activation.trigger?.initiative === true &&
      ready(player, item, stats),
  );
  const willing = party.filter(
    (item) =>
      item.id !== player.id &&
      !isDown(item) &&
      !hasCondition(item, ...INCAPACITATING),
  );
  if (!action || willing.length === 0) return [];
  return [
    awaitDecision({
      id: `${NS}:reaction:${player.id}:initiative`,
      actor: player.id,
      prompt: `${action.name}: swap Initiative with an ally?`,
      options: [
        { id: DECLINE, label: "Keep your place" },
        ...willing.map((item) => ({
          id: item.id,
          label: `Swap with ${item.name}`,
        })),
      ],
      resume: frame("swapInitiative", { actor: player.id }),
    }),
  ];
}

export const SwapSchema = z.object({ actor: z.string(), answer: z.string() });

export function runSwapInitiative(
  payload: z.infer<typeof SwapSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === DECLINE || !context.state.actors[payload.answer])
    return {};
  return {
    events: [
      dndEvent(`${NS}:initiativeSwapped`, {
        actor: payload.actor,
        with: payload.answer,
      }),
    ],
  };
}

export const reactionFrames = {
  [`${NS}:react`]: frameHandler({ schema: MomentSchema, run: runReact }),
  [`${NS}:reactAnswer`]: frameHandler({
    schema: ReactAnswerSchema,
    run: runReactAnswer,
  }),
  [`${NS}:swapInitiative`]: frameHandler({
    schema: SwapSchema,
    run: runSwapInitiative,
  }),
};
