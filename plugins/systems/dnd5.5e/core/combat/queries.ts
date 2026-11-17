import { type ContentAccess, type SystemContext, type SystemEvent } from "#sdk";
import { leashed } from "./duel.ts";
import { knownFoes, knows } from "../fog.ts";
import {
  type Actor,
  ATTACK_ACTION,
  CAST_ACTION,
  LEVELED_CAST,
  MAGIC_ACTION,
  SLOT_CAST_ACTION,
  controllingRider,
  dndEvent,
  type DndState,
  equipped,
  forAttacker,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  mountOf,
  NS,
  frame,
  SURGED,
  turnId,
} from "../state.ts";
import {
  deriveStats,
  type KnownAction,
  lookup,
  passiveModifiers,
  rollAmount,
  scaleActivation,
  type Stats,
} from "../stats.ts";
import type { HitKind, Passive, Skill } from "../schemas.ts";
import {
  distanceFeet,
  rangeFeet,
  reachableSquares,
  type Square,
  SQUARE_FEET,
  squareKey,
} from "../grid.ts";
import { aloftMode, heightOf } from "./falling.ts";
import { speedOf } from "../tactics.ts";
import { heldBy } from "./grapple.ts";
import {
  climbsCeilings,
  crossesDifficult,
  jumpOf,
  unhindered,
  type Mode,
  speedsOf,
  type Through,
  throughOf,
  walksOnWater,
} from "../movement-modes.ts";
import { behindTotalCover, difficultSquares } from "../sight.ts";
import {
  encodeOption,
  spellOfSource,
  THROW_PREFIX,
  weaponItemId,
} from "./ids.ts";
import { markedBy } from "../trait-rules.ts";
import { swallowerOf } from "./swallow.ts";
import { hasteActing, limitsOf } from "./durations.ts";
import { ownZoneAction } from "./areas.ts";
import {
  barredKeys,
  blockedSquares,
  blockingSet,
  inZone,
  sealed,
  slowingKeys,
  zoneModifiers,
  zonesOn,
} from "../zones.ts";
import { spellLevelOf } from "./dispel.ts";
import { canRegain, regainCap } from "../rest.ts";
import {
  type Ability,
  CompanionSchema,
  ItemSchema,
  MonsterSchema,
  SpeciesSchema,
  type Targeting,
} from "../schemas.ts";
import { bossAction } from "../legendary.ts";
import { currentShape } from "../forms.ts";
import { aimScore, aimSquares, caughtBy } from "../targeting.ts";
import { breathAgainEvents } from "./water.ts";

// Questions about a fight that change nothing: who is an ally or a foe, what reaches, what an actor can afford.

export type Context = SystemContext<DndState>;

export function actorOf(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(`Unknown actor ${id}`);
  return actor;
}

export const CHECK_END = frame("checkCombatEnd", {});

// Whether a creature of one of these lowercase types or species never makes a hit's save, as an elf a ghoul's.
export function exemptFrom(
  exempt: readonly string[] | undefined,
  target: Actor,
  stats: Stats,
): boolean {
  const species =
    target.source.kind === "character"
      ? target.source.build?.speciesId.split("/").pop()
      : undefined;
  return (
    exempt?.some((kind) => kind === stats.creatureType || kind === species) ??
    false
  );
}

export function hasFlag(
  actor: Actor,
  kind: "advantage" | "disadvantage",
  on: "attacks" | "saves" | "checks" | "attacksAgainst",
  stats: Stats,
  ability?: Ability,
  attackerType?: string, // the attacker's creature type, for attacksAgainst
  // for attacksAgainst, which a caster's own Advantage needs; for attacks, the target, which Disadvantage on attacks
  // against a caster needs, as Bestow Curse's
  attackerId?: string,
  skill?: Skill, // the check's skill, for Advantage on only some, as Remarkable Athlete's Athletics
): boolean {
  return [
    ...actor.activeEffects
      .filter((effect) => forAttacker(effect, attackerId))
      .map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
  ].some(
    (modifier) =>
      modifier.kind === kind &&
      modifier.on === on &&
      (!modifier.ability || modifier.ability === ability) &&
      (!("except" in modifier) ||
        !modifier.except ||
        modifier.except !== ability) &&
      (!("skills" in modifier) ||
        !modifier.skills ||
        (skill !== undefined && modifier.skills.includes(skill))) &&
      // Advantage only against some conditions is the save's to weigh (placedFlag).
      (!("conditions" in modifier) || !modifier.conditions) &&
      (!("magical" in modifier) || !modifier.magical) &&
      // Disadvantage only on spell attacks is the attack's to weigh (combat/attack.ts), and on ranged weapon attacks,
      // spell attacks or Concentration saves too.
      (!("spells" in modifier) || !modifier.spells) &&
      (!("ranged" in modifier) || !modifier.ranged) &&
      (!("spellAttacks" in modifier) || !modifier.spellAttacks) &&
      (!("concentration" in modifier) || !modifier.concentration) &&
      (!("casterSpells" in modifier) || !modifier.casterSpells) &&
      (!("opportunity" in modifier) || !modifier.opportunity) &&
      (!("attackers" in modifier) ||
        !modifier.attackers ||
        modifier.attackers.includes(attackerType ?? "")),
  );
}

export function hasPassive(stats: Stats, kind: Passive["kind"]): boolean {
  return stats.passives.some((passive) => passive.kind === kind);
}

// Effects from one source count once, so casting Bless twice can't add two d4s.
export function rollBonus(
  actor: Actor,
  to: "attacks" | "saves" | "checks" | "attacksAgainst",
  context: Context,
  skill?: Skill, // the check's skill, for a bonus that only adds to one
  ability?: Ability, // the save's ability, for a bonus that only adds to one
  weapon = false, // a weapon attack roll, for a bonus to those only
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const effect of actor.activeEffects) {
    const { modifier } = effect;
    if (modifier.kind !== "bonus" || modifier.to !== to) continue;
    if (modifier.weapon && !weapon) continue;
    if (modifier.skill && modifier.skill !== skill) continue;
    if (modifier.ability && modifier.ability !== ability) continue;
    if (seen.has(effect.sourceId)) continue;
    seen.add(effect.sourceId);
    const caster = context.state.actors[effect.casterId] ?? actor;
    const rolled = rollAmount(
      modifier.amount,
      deriveStats(caster, context),
      context.dice,
    );
    total += modifier.subtract ? -rolled : rolled;
  }
  const stats = deriveStats(actor, context);
  // What a zone it stands in grants, as Pass without Trace's +10 to Stealth.
  const placed = context.state.combat
    ? zoneModifiers(actor, context.state, context)
    : [];
  for (const modifier of [...passiveModifiers(stats.passives), ...placed]) {
    if (
      modifier.kind === "bonus" &&
      modifier.to === to &&
      (!modifier.weapon || weapon) &&
      (!modifier.skill || modifier.skill === skill) &&
      (!modifier.ability || modifier.ability === ability)
    ) {
      total += rollAmount(modifier.amount, stats, context.dice);
    }
  }
  return total;
}

export function allies(state: DndState, actor: Actor): readonly Actor[] {
  return state.combat
    ? state.combat.order.flatMap((id) => {
        const other = actorOf(state, id);
        return other.side === actor.side ? [other] : [];
      })
    : [];
}

export function enemies(state: DndState, actor: Actor): readonly Actor[] {
  return state.combat
    ? state.combat.order.flatMap((id) => {
        const other = actorOf(state, id);
        return other.side !== actor.side ? [other] : [];
      })
    : [];
}

// A spell can use a slot of its own level or higher, which is also how Pact Magic casts low spells.
// The feet a melee action reaches, or null for a ranged one.
export function meleeReach(action: KnownAction): number | null {
  const { targeting } = action.activation;
  if (!("creatures" in targeting)) return null;
  const feet = rangeFeet(targeting.range);
  if (targeting.reach) return feet;
  return feet > 0 && feet <= 10 ? feet : null;
}

// Whether an action can reach this creature from where the actor stands. For an area, the creature is
// what it's aimed at: a sphere's centre must be in range, and a cone or line must reach it.
export function reaches(
  action: KnownAction,
  actor: Actor,
  target: Actor,
): boolean {
  const { targeting } = action.activation;
  if ("self" in targeting) return true;
  // From inside a swallower, it's the one creature within reach.
  const inside = swallowerOf(actor);
  if (inside !== undefined)
    return inside === target.id || target.id === actor.id;
  // A creature lifted by Reverse Gravity is that much farther from those below it (combat/falling.ts).
  const distance = Math.max(
    distanceFeet(actor.position, target.position),
    Math.abs(heightOf(actor) - heightOf(target)),
  );
  if ("area" in targeting && targeting.range === "self") {
    return distance <= targeting.area.radius;
  }
  return distance <= rangeFeet(targeting.range);
}

export function within5(a: Actor, b: Actor): boolean {
  return distanceFeet(a.position, b.position) <= 5;
}

// The feet left to move in each of its Speeds: that Speed and its Dashes, less what it has moved this turn, as when
// switching between Speeds.
export function speedsLeft(
  actor: Actor,
  stats: Stats,
): ReadonlyMap<Mode, number> {
  // Daze: once it has taken an action or a Bonus Action, it can't move.
  const dazed =
    (!actor.budget.action || !actor.budget.bonusAction) &&
    actor.activeEffects.some(
      ({ modifier }) => modifier.kind === "actionLimit" && modifier.oneThing,
    );
  const held =
    dazed || hasCondition(actor, "grappled", "restrained", ...INCAPACITATING);
  return new Map(
    [...speedsOf(actor, stats)].map(([mode, feet]) => [
      mode,
      held || !actor.position
        ? 0
        : Math.max(0, speedOf(actor, { ...stats, speed: feet }) - actor.moved),
    ]),
  );
}

// The mount a creature rides and controls, which carries it when it moves, or null.
export function ridden(actor: Actor, state: DndState): Actor | null {
  const id = mountOf(actor);
  const mount = id ? state.actors[id] : undefined;
  return mount && !isDown(mount) && controllingRider(state, mount.id) === actor
    ? mount
    : null;
}

export function speedLeft(actor: Actor, stats: Stats): number {
  return Math.max(...speedsLeft(actor, stats).values());
}

// Whether `mover` may pass through `other`'s space: an ally's, an Incapacitated or Tiny creature's, or one two sizes
// larger or smaller, as the rules allow, or anyone's its traits or the other's let it.
function passes(
  mover: Actor,
  through: Through,
  other: Actor,
  access: ContentAccess,
): boolean {
  if (other.side === mover.side || isDown(other)) return true;
  if (hasCondition(other, ...INCAPACITATING)) return true;
  if (through.creatures === "any") return true;
  const size = sizeOf(other, access);
  const own = sizeOf(mover, access);
  return (
    size === 0 ||
    Math.abs(size - own) >= 2 ||
    (through.creatures === "larger" && size > own) ||
    // Only a stat block opens its space, as a swarm's, so it's read without working out the creature's stats.
    (other.source.kind === "monster" &&
      lookup(access, MonsterSchema, other.source.statBlockId).passives.some(
        (passive) => passive.kind === "moveThrough" && passive.open,
      ))
  );
}

// A stat block's own traits, read without working out the creature's stats, or none for a character.
function statBlockPassives(
  actor: Actor,
  access: ContentAccess,
): readonly Passive[] {
  return actor.source.kind === "monster"
    ? lookup(access, MonsterSchema, actor.source.statBlockId).passives
    : [];
}

function sharesSpace(
  passives: readonly Passive[],
  who: "allies" | "self",
): boolean {
  return passives.some(
    (passive) => passive.kind === "shareSpace" && passive.who === who,
  );
}

// The ground as one creature moving finds it: what it can't enter, where it can't stop, and what costs double.
// Another creature's space costs double unless it's an ally's or a Tiny one's. Walls it passes through can't be
// stopped in, nor another's space unless a trait shares it (shareSpace) or opens it to anyone, as a swarm's.
export function groundFor(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats = deriveStats(actor, access),
): {
  readonly blocked: ReadonlySet<string>;
  readonly occupied: ReadonlySet<string>;
  readonly terrain: ReadonlySet<string>; // difficult terrain on the ground
  readonly costly: ReadonlySet<string>; // squares that cost double however it moves
  readonly walls: ReadonlySet<string>;
  readonly squeeze: boolean;
  readonly overTerrain: boolean; // crosses difficult terrain at no extra cost, however it moves
  readonly water: ReadonlySet<string>; // squares to swim in
  readonly waterWalks: boolean; // walks over water as on ground, as with Water Walk
} {
  const through = throughOf(stats, actor);
  // shortcut: going through walls means the map's own; a wall a spell raises stops it as it does anyone.
  const walls = state.combat?.walls ?? [];
  const solid = blockedSquares(state, "walking");
  const mapWalls = new Set(walls);
  // A barrier it can't cross stops it as a wall would, and a zone that slows it costs double however it moves.
  const barred = barredKeys(actor, state, access);
  const blocked = new Set([
    ...(through.walls ? solid.filter((key) => !mapWalls.has(key)) : solid),
    ...barred,
  ]);
  const occupied = new Set([...solid, ...barred]);
  const costly = new Set([
    ...(through.costly ? walls : []),
    ...slowingKeys(actor, state, access),
  ]);
  const enters = sharesSpace(stats.passives, "self");
  const there = new Map<string, Actor[]>();
  for (const other of Object.values(state.actors)) {
    if (other.id === actor.id || !other.position || isDead(other)) continue;
    const key = squareKey(other.position);
    there.set(key, [...(there.get(key) ?? []), other]);
    if (!enters && !passes(actor, through, other, access)) blocked.add(key);
    else if (other.side !== actor.side && sizeOf(other, access) > 0) {
      costly.add(key);
    }
  }
  // It may stop in another's space with Whirling Form, in an ally's that opens it to allies with only allies there,
  // or in a swarm's, which anyone may occupy.
  for (const [key, others] of there) {
    const hosted =
      (others.every((other) => other.side === actor.side) &&
        others.some((other) =>
          sharesSpace(statBlockPassives(other, access), "allies"),
        )) ||
      others.some((other) =>
        statBlockPassives(other, access).some(
          (passive) => passive.kind === "moveThrough" && passive.open,
        ),
      );
    if (!enters && !hosted) occupied.add(key);
  }
  return {
    blocked,
    occupied,
    terrain: difficultSquares(state),
    costly,
    walls: blockingSet(state, "walking"),
    squeeze: through.squeeze,
    overTerrain: through.terrain || unhindered(actor, stats),
    water: new Set(state.combat?.terrain?.water ?? []),
    waterWalks: walksOnWater(actor, stats),
  };
}

// The squares that aren't water, where a swimmer can't go on its Swim Speed.
function dryLand(
  grid: { readonly width: number; readonly height: number },
  water: ReadonlySet<string>,
  from: Square,
): Set<string> {
  const dry = new Set<string>();
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const key = squareKey({ x, y });
      if (!water.has(key) && (x !== from.x || y !== from.y)) dry.add(key);
    }
  }
  return dry;
}

// The squares with no wall beside them, where a climber has nothing to hold.
function offWalls(
  grid: { readonly width: number; readonly height: number },
  walls: ReadonlySet<string>,
): Set<string> {
  const off = new Set<string>();
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      let beside = false;
      for (let dy = -1; dy <= 1 && !beside; dy += 1) {
        for (let dx = -1; dx <= 1 && !beside; dx += 1) {
          beside = walls.has(squareKey({ x: x + dx, y: y + dy }));
        }
      }
      if (!beside) off.add(squareKey({ x, y }));
    }
  }
  return off;
}

// A square a move ends on, the feet it costs and the walk there. With `drag`, the creatures it grapples come along to
// these squares.
export type Walk = ReturnType<typeof reachableSquares>[number] & {
  readonly drag?: readonly { readonly actor: string; readonly to: Square }[];
};

// Every square it can move to this turn, in whichever of its Speeds gets there cheapest. A flyer, climber or burrower
// crosses difficult terrain at no extra cost. A grappler drags those it holds wherever it goes out of their reach, at
// double cost unless they're Tiny or two sizes smaller or it has Abduct, and walks farther only by letting go.
// shortcut: it can't let go to walk somewhere it could drag them to.
export function moveSquares(
  actor: Actor,
  state: DndState,
  stats: Stats,
  access: ContentAccess,
): readonly Walk[] {
  const grid = state.combat?.grid;
  const from = actor.position;
  if (!grid || !from) return [];
  // A rider goes where its mount can, with the mount's Speed.
  const mount = ridden(actor, state);
  if (mount)
    return moveSquares(mount, state, deriveStats(mount, access), access);
  const ground = groundFor(actor, state, access, stats);
  const jump = jumpOf(stats);
  // Up on its own, it moves only in the Speed it went up with; a climber keeps to the squares beside walls unless it
  // goes along ceilings too.
  const up = aloftMode(actor);
  const clings =
    up === "climb" && !climbsCeilings(actor, stats)
      ? offWalls(grid, ground.walls)
      : null;
  const blocked = clings
    ? new Set([...ground.blocked, ...clings])
    : ground.blocked;
  const walking =
    ground.costly.size === 0
      ? ground.terrain
      : new Set([...ground.terrain, ...ground.costly]);
  // Water: a walker swims it at double cost, unless it swims as fast as it walks or walks on water; a Swim Speed of
  // its own keeps to the water (the 2024 rules switch Speeds mid-move; shortcut: each Speed moves on its own here).
  const swimming = speedsOf(actor, stats).get("swim") ?? 0;
  const wet =
    ground.water.size > 0 && !ground.waterWalks && swimming < stats.speed;
  const dry = ground.water.size > 0 ? dryLand(grid, ground.water, from) : null;
  // Each square at its cheapest, with each foot of movement costing `cost` feet.
  const search = (cost: number): Map<string, Walk> => {
    const best = new Map<string, Walk>();
    for (const [mode, left] of speedsLeft(actor, stats)) {
      const feet = Math.floor(left / cost / SQUARE_FEET) * SQUARE_FEET;
      if (feet <= 0 || (up && mode !== up)) continue;
      if (mode === "swim" && !dry) continue;
      const rough =
        crossesDifficult(mode) || ground.overTerrain ? ground.costly : walking;
      const found = reachableSquares(
        from,
        feet,
        grid,
        mode === "swim" && dry ? new Set([...blocked, ...dry]) : blocked,
        ground.occupied,
        wet && mode !== "fly" && mode !== "swim"
          ? new Set([...rough, ...ground.water])
          : rough,
        ground.walls,
        { squeeze: ground.squeeze, jump },
      );
      for (const item of found) {
        const key = squareKey(item.square);
        const walk = { ...item, feet: item.feet * cost };
        if (walk.feet < (best.get(key)?.feet ?? Infinity)) best.set(key, walk);
      }
    }
    return best;
  };
  const plain = search(1);
  const holds = heldBy(actor, state, access).filter(
    ({ held }) => !isDead(held),
  );
  // Compelled Duel keeps its target within reach of the caster.
  const tooFar = leashed(actor, state);
  if (holds.length === 0) {
    return [...plain.values()].filter(({ square }) => !tooFar(square));
  }
  const own = sizeOf(actor, access);
  const light = ({ held }: { readonly held: Actor }): boolean => {
    const size = sizeOf(held, access);
    return size === 0 || own - size >= 2;
  };
  const dragging =
    hasPassive(stats, "abduct") || holds.every(light) ? plain : search(2);
  return [...plain.values()]
    .map((walk) => {
      const near = holds.every(
        ({ held, feet }) => distanceFeet(walk.square, held.position) <= feet,
      );
      const dragged = near ? undefined : dragging.get(squareKey(walk.square));
      const drag = dragged && dragSquares(dragged, from, holds, state);
      return dragged && drag ? { ...dragged, drag } : walk;
    })
    .filter(({ square }) => !tooFar(square));
}

// Where each grappled creature ends up: on the squares the walk left behind, last first, or else beside its end, each
// on an open square within its grapple's reach of the end. Null if one has nowhere to go.
function dragSquares(
  walk: Walk,
  from: Square,
  holds: readonly { readonly held: Actor; readonly feet: number }[],
  state: DndState,
): { readonly actor: string; readonly to: Square }[] | null {
  const grid = state.combat?.grid;
  if (!grid) return null;
  const moving = new Set(holds.map(({ held }) => held.id));
  const taken = new Set([
    ...blockedSquares(state, "walking"),
    squareKey(walk.square),
    ...Object.values(state.actors).flatMap((other) =>
      other.position && !isDead(other) && !moving.has(other.id)
        ? [squareKey(other.position)]
        : [],
    ),
  ]);
  taken.delete(squareKey(from)); // the grappler leaves it
  const beside: Square[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const square = { x: walk.square.x + dx, y: walk.square.y + dy };
      if (
        square.x >= 0 &&
        square.y >= 0 &&
        square.x < grid.width &&
        square.y < grid.height
      ) {
        beside.push(square);
      }
    }
  }
  const trail = [...walk.path.slice(0, -1).reverse(), from];
  const drag: { actor: string; to: Square }[] = [];
  for (const { held, feet } of holds) {
    const near = [...beside].sort(
      (a, b) => distanceFeet(a, held.position) - distanceFeet(b, held.position),
    );
    const to = [...trail, ...near].find(
      (square) =>
        !taken.has(squareKey(square)) &&
        distanceFeet(square, walk.square) <= feet,
    );
    if (!to) return null;
    taken.add(squareKey(to));
    drag.push({ actor: held.id, to });
  }
  return drag;
}

// The grappled creatures a move drags along, moved without spending their own movement.
export function dragEvents(walk: {
  readonly drag?: readonly { readonly actor: string; readonly to: Square }[];
}): SystemEvent[] {
  return (walk.drag ?? []).map(({ actor, to }) =>
    dndEvent(`${NS}:moved`, { actor, to, feet: 0 }),
  );
}

// "C7" for the third column of the seventh row, as on a battle map.
export function squareName(square: Square): string {
  return `${String.fromCharCode(65 + (square.x % 26))}${String(square.y + 1)}`;
}

export function slotToSpend(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): number | null {
  const lowest = action.spellLevel ?? 1;
  for (let level = lowest; level <= stats.slots.length; level += 1) {
    const spent = actor.resourcesSpent[`slot:${String(level)}`] ?? 0;
    if (spent < (stats.slots[level - 1] ?? 0)) return level;
  }
  return null;
}

// The higher slots worth offering: ones above the slot the spell would use anyway, if the spell gains from them.
export function upcastSlots(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): readonly number[] {
  const lowest = slotToSpend(action, actor, stats);
  if (!action.upcast || lowest === null) return [];
  return stats.slots.flatMap((count, index) => {
    const level = index + 1;
    return level > lowest &&
      (actor.resourcesSpent[`slot:${String(level)}`] ?? 0) < count
      ? [level]
      : [];
  });
}

export function withUpcasts(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
  target: string,
  label: string,
): { id: string; label: string }[] {
  const id = encodeOption(action.id, target);
  return [
    { id, label },
    ...upcastSlots(action, actor, stats).map((slot) => ({
      id: encodeOption(id, slot),
      label: `${label} (level ${String(slot)} slot)`,
    })),
  ];
}

// A Charmed creature can't target its charmer with attacks or harmful magic.
export function charmersOf(actor: Actor): ReadonlySet<string> {
  return new Set(
    actor.activeEffects.flatMap(({ modifier, casterId }) =>
      modifier.kind === "condition" && modifier.condition === "charmed"
        ? [casterId]
        : [],
    ),
  );
}

export const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

// How many times a creature has split, as a black pudding does (combat/reactions.ts), each one size smaller.
export const SPLITS = "splits";

// A creature's size, as its index in SIZES.
export function sizeOf(actor: Actor, access: ContentAccess): number {
  return Math.max(
    0,
    printedSize(actor, access) - (actor.resourcesSpent[SPLITS] ?? 0),
  );
}

function printedSize(actor: Actor, access: ContentAccess): number {
  if (actor.source.kind === "monster") {
    const monster = lookup(access, MonsterSchema, actor.source.statBlockId);
    const size = currentShape(monster, actor)?.size ?? monster.size;
    return SIZES.indexOf(size ?? "medium");
  }
  if (actor.source.kind === "summon") {
    const { size } = lookup(access, CompanionSchema, actor.source.companion);
    return SIZES.indexOf(size ?? "medium");
  }
  const { build } = actor.source;
  return build
    ? SIZES.indexOf(lookup(access, SpeciesSchema, build.speciesId).size)
    : SIZES.indexOf("medium");
}

export function fitsType(
  item: Actor,
  targeting: Targeting,
  access: ContentAccess,
  by?: Actor, // who aims it, for an `afflicted` gate
): boolean {
  if ("self" in targeting) return true;
  const gate = "targetConditions" in targeting && targeting.targetConditions;
  if (gate && !hasCondition(item, ...gate)) return false;
  if (
    "bloodied" in targeting &&
    targeting.bloodied &&
    item.hp * 2 > deriveStats(item, access).maxHp
  ) {
    return false;
  }
  if (
    targeting.afflicted &&
    by &&
    !afflictedBy(item, by, targeting.afflicted, access)
  ) {
    return false;
  }
  const largest = "maxSize" in targeting ? targeting.maxSize : undefined;
  if (largest && sizeOf(item, access) > SIZES.indexOf(largest)) return false;
  if (!targeting.creatureTypes) return true;
  return targeting.creatureTypes.includes(
    deriveStats(item, access).creatureType ?? "",
  );
}

export function canAfford(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): boolean {
  const { carrying, afterAction, resolution } = action.activation;
  if (carrying && !actor.inventory.includes(carrying)) return false;
  if (afterAction && actor.budget.action) return false;
  const used = actor.usedThisTurn;
  if (afterAction === "attack" && !used.includes(ATTACK_ACTION)) return false;
  if (
    afterAction === "attackOrMagic" &&
    !used.includes(ATTACK_ACTION) &&
    !used.includes(MAGIC_ACTION)
  ) {
    return false;
  }
  // only while Bloodied, as Unearthly Recovery
  if (action.activation.bloodied && actor.hp * 2 >= stats.maxHp) return false;
  if (action.activation.beforeAction && !actor.budget.action) return false;
  if (!gatesOpen(action, actor, stats)) return false;
  const limits = limitsOf(actor);
  // Befuddlement: no spells at all.
  if (limits.noSpells && action.spellLevel !== null) return false;
  // Abjure Foes: having moved this turn, it takes no action or Bonus Action.
  if (
    limits.oneThing &&
    actor.moved > 0 &&
    action.activation.cost.some(
      (cost) => cost === "action" || cost === "bonusAction",
    )
  ) {
    return false;
  }
  // Haste's additional action takes only a weapon attack, or Dash, Disengage or Hide (actions.ts).
  if (
    hasteActing(actor) &&
    action.activation.cost.includes("action") &&
    (resolution.kind !== "attack" || resolution.attack.type !== "weapon")
  ) {
    return false;
  }
  return (
    action.activation.cost.every((cost) => {
      if (cost === "action") return actor.budget.action;
      if (cost === "bonusAction") return actor.budget.bonusAction;
      if (cost === "reaction") return actor.budget.reaction;
      if (cost === "slot") return slotToSpend(action, actor, stats) !== null;
      if ("gold" in cost) return true; // the party's purse is checked where it's offered (goldFor)
      return (
        (actor.resourcesSpent[cost.resource] ?? 0) + (cost.count ?? 1) <=
        (stats.resources[cost.resource] ?? 0)
      );
    }) && poolsLeft(action, actor, stats)
  );
}

// What an activation needs this turn beyond its costs: Steady Aim's standing still, Battle Magic's spell, Fleet Step's
// Bonus Action, Travel along the Tree's Rage, and Action Surge's spent action, once a turn and never for magic.
function gatesOpen(action: KnownAction, actor: Actor, stats: Stats): boolean {
  const { activation } = action;
  const used = actor.usedThisTurn;
  if (activation.unmoved && actor.moved > 0) return false;
  if (activation.oncePerTurn && used.includes(onceKey(action))) return false;
  if (activation.afterCast === true && !used.includes(CAST_ACTION))
    return false;
  if (activation.afterCast === "slot" && !used.includes(SLOT_CAST_ACTION)) {
    return false;
  }
  if (activation.afterCast === "leveled" && !used.includes(LEVELED_CAST)) {
    return false;
  }
  if (activation.afterBonusAction && actor.budget.bonusAction) return false;
  if (activation.while && !underEffect(actor, activation.while)) return false;
  if (
    activation.minLevel &&
    (stats.classLevels[activation.minLevel.class] ?? 0) <
      activation.minLevel.level
  ) {
    return false;
  }
  if (
    activation.afterTargets !== undefined &&
    used.filter((key) => key.startsWith(ATTACKED)).length <
      activation.afterTargets
  ) {
    return false;
  }
  if (
    activation.afterUse &&
    !used.includes(
      usedKey(activation.afterUse.feature, activation.afterUse.label),
    )
  ) {
    return false;
  }
  if (
    activation.withAttack &&
    !actor.budget.action &&
    !actor.activeEffects.some(
      ({ modifier }) =>
        modifier.kind === "tactic" &&
        modifier.tactic === "attacksLeft" &&
        (modifier.value ?? 0) > 0,
    )
  ) {
    return false;
  }
  const { resolution, cost } = activation;
  if (
    resolution.kind === "automatic" &&
    resolution.effects.some((effect) => effect.kind === "extraAction") &&
    (actor.budget.action || used.includes(SURGED))
  ) {
    return false;
  }
  // shortcut: a magic item's Magic action is still allowed, as items don't say which action they take.
  return !(
    used.includes(SURGED) &&
    action.spellLevel !== null &&
    cost.includes("action")
  );
}

// The usedThisTurn mark of a creature attacked this turn, kept for Distant Strike's bearer (combat/actions.ts).
const ATTACKED = "attacked:";
export const attackedKey = (id: string): string => `${ATTACKED}${id}`;

// The usedThisTurn mark of an activation of a feature, with its label, used this turn (combat/actions.ts).
export const usedKey = (feature: string, label?: string): string =>
  `used:${feature}${label === undefined ? "" : `:${label}`}`;

// Whether an effect of one of these features' activations is on the actor, or it concentrates on one of these
// spells, as a Rage for Travel along the Tree or Divine Fury.
export function underEffect(actor: Actor, ids: readonly string[]): boolean {
  return ids.some(
    (id) =>
      actor.activeEffects.some(({ sourceId }) =>
        sourceId.startsWith(`feature:${id}:`),
      ) || spellOfSource(actor.concentratingOn ?? "") === id,
  );
}

// The melee weapon a Warlock's Pact of the Blade bonds with: the first one it holds.
export function pactWeaponId(
  actor: Actor,
  access: Pick<ContentAccess, "content">,
): string | undefined {
  return equipped(actor).find((id) => {
    const item = ItemSchema.safeParse(access.content(id)).data;
    // a melee weapon: no ammunition, and a range only for throwing it
    return (
      item?.type === "weapon" &&
      !item.properties.includes("ammunition") &&
      (item.range === undefined || item.properties.includes("thrown"))
    );
  });
}

// Whether a hit with this action is one a rider of this kind answers (schemas.ts HitKindSchema).
export function hitFits(
  kind: HitKind,
  hitWith: KnownAction,
  attacker: Actor,
  access: Pick<ContentAccess, "content">,
): boolean {
  const { resolution } = hitWith.activation;
  if (resolution.kind !== "attack") return false;
  if (kind === "attack") return true;
  if (resolution.attack.type !== "weapon") return false;
  if (kind === "finesseOrRanged") {
    return carriesExtraDice(attacker, hitWith, access);
  }
  const unarmed = resolution.attack.unarmed === true;
  const id = weaponItemId(hitWith.id);
  const item = id ? ItemSchema.safeParse(access.content(id)).data : undefined;
  const weapon = item?.type === "weapon" ? item : undefined;
  switch (kind) {
    case "weapon":
      return true;
    case "pactWeapon":
    case "heldMelee":
      return id === pactWeaponId(attacker, access);
    case "meleeWeapon":
      return isMelee(hitWith);
    case "rangedWeapon":
      return !isMelee(hitWith);
    case "unarmed":
      return unarmed;
    case "monkWeapon":
      return (
        unarmed ||
        (weapon !== undefined &&
          isMelee(hitWith) &&
          (weapon.category === "simple" || weapon.properties.includes("light")))
      );
    case "magicWeapon":
      return weapon?.baseWeapon !== undefined;
    case "strength":
      return (
        (resolution.attack.ability ?? (isMelee(hitWith) ? "str" : "dex")) ===
        "str"
      );
    case "heavy":
      return weapon?.properties.includes("heavy") === true;
    case "heavyOrVersatile":
      return (
        weapon?.properties.some(
          (property) => property === "heavy" || property === "versatile",
        ) === true
      );
  }
}

// Whether an extraDamage passive adds to this hit: `edge` is the roll's Advantage and Disadvantage.
export function extraFits(
  passive: Extract<Passive, { kind: "extraDamage" }>,
  attacker: Actor,
  target: Actor,
  hitWith: KnownAction,
  edge: {
    readonly advantage: boolean;
    readonly disadvantage: boolean;
    readonly natural?: number;
  },
  context: Context,
): boolean {
  const { state } = context;
  const turn = turnId(state.combat);
  if (passive.ownTurn && turn !== attacker.id) return false;
  if (passive.firstRound && (state.combat?.round ?? 1) > 1) return false;
  if (passive.while?.some((id) => !underEffect(attacker, [id]))) return false;
  if (passive.against && !markedBy(target, attacker, passive.against)) {
    return false;
  }
  const advantaged =
    passive.when === "advantage" || passive.when === "advantageOrAlly";
  const kind = passive.with ?? (advantaged ? "finesseOrRanged" : "attack");
  if (!hitFits(kind, hitWith, attacker, context)) return false;
  if (passive.when === "always") return true;
  if (passive.when === "natural20") return edge.natural === 20;
  // Rakish Audacity or Insightful Fighting: Sneak Attack without Advantage.
  if (
    passive.when === "advantageOrAlly" &&
    !edge.disadvantage &&
    deriveStats(attacker, context).passives.some(
      (item) =>
        item.kind === "sneakOpening" &&
        (!item.against || markedBy(target, attacker, item.against)) &&
        (!item.alone ||
          (within5(attacker, target) &&
            !Object.values(state.actors).some(
              (other) =>
                other.id !== attacker.id &&
                other.id !== target.id &&
                !isDown(other) &&
                within5(other, attacker),
            ))),
    )
  ) {
    return true;
  }
  if (passive.when === "targetHurt") {
    return target.hp < deriveStats(target, context).maxHp;
  }
  if (edge.advantage && !edge.disadvantage) return true;
  // Sneak Attack's ally must be able to act, and the ally never makes up for Disadvantage on the roll.
  return (
    passive.when === "advantageOrAlly" &&
    !edge.disadvantage &&
    allies(state, attacker).some(
      (item) =>
        item.id !== attacker.id &&
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING) &&
        within5(item, target),
    )
  );
}

// The usedThisTurn key of an activation limited to once a turn: its name, or its feature's (or its own) id.
export function onceKey(action: KnownAction): string {
  const once = action.activation.oncePerTurn;
  return typeof once === "string"
    ? `once:${once}`
    : `once:${action.id.replace(/^(feature:[^:]+:[^:]+):\d+$/, "$1")}`;
}

// A healing pool with nothing left in it can't heal, as Lay On Hands spent, and nothing is regained with nothing
// spent, as Font of Inspiration's use for a slot.
function poolsLeft(action: KnownAction, actor: Actor, stats: Stats): boolean {
  const { resolution } = action.activation;
  return (
    resolution.kind !== "automatic" ||
    resolution.effects.every((effect) =>
      effect.kind === "regain"
        ? canRegain(
            actor,
            effect.resource,
            stats,
            regainCap(effect, action.spellLevel),
          )
        : effect.kind === "cure" && effect.pool
          ? (actor.resourcesSpent[effect.pool.resource] ?? 0) +
              effect.pool.per <=
            (stats.resources[effect.pool.resource] ?? 0)
          : effect.kind !== "heal" ||
            !effect.pool ||
            (actor.resourcesSpent[effect.pool.resource] ?? 0) <
              (stats.resources[effect.pool.resource] ?? 0),
    )
  );
}

// The gold an action's costly component takes, which the party's purse must hold, as Revivify's diamond.
export function goldFor(action: KnownAction): number {
  return action.activation.cost.reduce(
    (sum, cost) =>
      typeof cost === "object" && "gold" in cost ? sum + cost.gold : sum,
    0,
  );
}

// A raising reaches only the dead it's in time for, as Raise Dead's 10 days.
export function deadWithin(item: Actor, targeting: Targeting): boolean {
  if (item.dust && !("dust" in targeting && targeting.dust)) return false;
  if (
    "diedWithinRounds" in targeting &&
    targeting.diedWithinRounds !== undefined &&
    (item.deadRounds ?? 0) > targeting.diedWithinRounds
  ) {
    return false;
  }
  return (
    !("diedWithin" in targeting) ||
    targeting.diedWithin === undefined ||
    (item.deadHours ?? 0) <= targeting.diedWithin
  );
}

// The creatures an action can be aimed at from where the actor stands.
export function inReach(
  action: KnownAction,
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): readonly Actor[] {
  const { targeting } = action.activation;
  if ("self" in targeting) return [actor];
  const charmers = charmersOf(actor);
  const downed = "downed" in targeting && targeting.downed === true;
  return (
    [
      ...(targeting.side !== "ally"
        ? knownFoes(state, actor, access).filter(
            (item) => isDown(item) === downed && !charmers.has(item.id),
          )
        : []),
      ...(targeting.side !== "enemy"
        ? allies(state, actor).filter((item) => !downed || isDown(item))
        : []),
    ]
      .filter(
        (item) =>
          isDead(item) === ("dead" in targeting && targeting.dead === true) &&
          deadWithin(item, targeting),
      )
      .filter((item) => fitsType(item, targeting, access, actor))
      // Distant Strike's third attack: only at one it hasn't attacked this turn.
      .filter(
        (item) =>
          action.activation.afterTargets === undefined ||
          !actor.usedThisTurn.includes(attackedKey(item.id)),
      )
      .filter((item) => reaches(action, actor, item))
      .filter((item) => !behindTotalCover(state, actor, item))
      .filter((item) => !walledApart(actor, item, action, state, access))
  );
}

// Whether something keeps `target` out of `actor`'s reach: either is shut away (Resilient Sphere, Maze), the actor
// stands in a zone where its spell can't be cast or the target in one its spell can't reach into (Antimagic Field,
// Globe of Invulnerability).
export function walledApart(
  actor: Actor,
  target: Actor,
  action: KnownAction,
  state: DndState,
  access: ContentAccess,
): boolean {
  if (actor.id !== target.id && (sealed(actor) || sealed(target))) return true;
  const guarding = zonesOn(target, state, access).filter(
    (zone) =>
      zone.area?.noSpells === "all" ||
      (zone.area?.spellShield !== undefined && !inZone(zone, actor.position)),
  );
  if (guarding.length === 0) return false;
  const level = spellLevelOf(action.id, actor, access);
  return (
    level !== null &&
    guarding.some(
      (zone) =>
        zone.area?.noSpells === "all" ||
        level <= (zone.area?.spellShield ?? -1),
    )
  );
}

// How many creatures, darts or rays an action takes when cast with this slot.
export function targetCount(
  action: KnownAction,
  slot: number | undefined,
): number {
  const above = (slot ?? 0) - (action.spellLevel ?? 0);
  const activation = action.upcast
    ? scaleActivation(action.activation, action.upcast.perSlotLevel, above)
    : action.activation;
  const { projectiles, targeting } = activation;
  return projectiles ?? ("creatures" in targeting ? targeting.creatures : 1);
}

// Whether `item` is under an effect `by` left with its action of this name, as a curse it laid.
export function afflictedBy(
  item: Actor,
  by: Actor,
  name: string,
  access: ContentAccess,
): boolean {
  const ids = new Set(
    deriveStats(by, access)
      .actions.filter((action) => action.name === name)
      .map((action) => action.id),
  );
  return item.activeEffects.some(
    (effect) => effect.casterId === by.id && ids.has(effect.sourceId),
  );
}

// Every creature in the fight an area could catch.
export function areaPool(
  targeting: Targeting,
  context: ContentAccess & { readonly state: DndState },
  by?: Actor,
): readonly Actor[] {
  return (context.state.combat?.order ?? []).flatMap((id) => {
    const item = context.state.actors[id];
    return item && !isDead(item) && fitsType(item, targeting, context, by)
      ? [item]
      : [];
  });
}

// A cast keeps its slot level in the frames it leaves behind, so later steps roll the same dice.
// A weapon stuck to a kuo-toa's shield isn't offered, but steps already under way still look it up.
function stuckAction(
  actor: Actor,
  id: string,
  context: Context,
): KnownAction | undefined {
  return isStuck(actor, id)
    ? deriveStats(
        {
          ...actor,
          activeEffects: actor.activeEffects.filter(
            ({ modifier }) => modifier.kind !== "stuck",
          ),
        },
        context,
      ).actions.find((item) => item.id === id)
    : undefined;
}

export const isStuck = (actor: Actor, actionId: string): boolean =>
  actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "stuck" && modifier.action === actionId,
  );

export function findAction(
  actor: Actor,
  id: string,
  context: Context,
  slotLevel?: number,
): KnownAction {
  const action =
    deriveStats(actor, context).actions.find((item) => item.id === id) ??
    bossAction(actor, id, context) ??
    ownZoneAction(actor, id, context) ??
    stuckAction(actor, id, context);
  if (!action) throw new Error(`${actor.id} has no action ${id}`);
  const above = (slotLevel ?? 0) - (action.spellLevel ?? 0);
  return action.upcast
    ? {
        ...action,
        activation: scaleActivation(
          action.activation,
          action.upcast.perSlotLevel,
          above,
        ),
      }
    : action;
}

export function spellSource(action: KnownAction): string {
  return action.id;
}

// Extra Attack only applies to the Attack action with a weapon, while a monster follows its stat block.
export function attackRoutine(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): readonly string[] {
  const { cost, resolution } = action.activation;
  if (
    !cost.includes("action") ||
    (actor.source.kind === "character" &&
      resolution.kind === "attack" &&
      resolution.attack.type === "spell" &&
      !action.activation.withExtraAttack)
  ) {
    return [action.id];
  }
  // Each throw lets go of one weapon, so it throws no more than it holds.
  const held = action.id.startsWith(THROW_PREFIX)
    ? throwsLeft(actor, action.id)
    : stats.multiattack;
  const routine =
    stats.routines?.[action.id] ??
    Array<string>(Math.min(stats.multiattack, held)).fill(action.id);
  // Slow, or Haste's extra action, allows one attack.
  return limitsOf(actor).oneAttack || hasteActing(actor)
    ? routine.slice(0, 1)
    : routine;
}

// The copies of a throw's weapon the actor holds.
export function throwsLeft(actor: Actor, actionId: string): number {
  const itemId = weaponItemId(actionId);
  return equipped(actor).filter((id) => id === itemId).length;
}

// The slot a cast spends: the one chosen, or else the lowest that will do.
export function slotLevelFor(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  context: Context,
): number | undefined {
  const known = findAction(actor, actionId, context);
  if (!known.activation.cost.includes("slot")) return undefined;
  return slot === undefined
    ? (slotToSpend(known, actor, deriveStats(actor, context)) ?? undefined)
    : Number(slot);
}

// Every square an area can be aimed at, with who it catches, the best for its caster first.
export function aimsFor(
  action: KnownAction,
  actor: Actor,
  context: ContentAccess & { readonly state: DndState },
): readonly {
  readonly square: Square;
  readonly caught: readonly Actor[];
  readonly score: number;
}[] {
  const { targeting } = action.activation;
  const grid = context.state.combat?.grid;
  if (!("area" in targeting) || !grid || !actor.position) return [];
  // Aimed by what the actor's side knows of: the party doesn't aim at foes in the fog, though the area still
  // catches them. One of creatures of the caster's choice catches only its side.
  const pool = areaPool(targeting, context, actor).filter(
    (item) =>
      knows(context.state, actor, item, context) &&
      (!targeting.choice ||
        (item.side === actor.side) === (targeting.side === "ally")),
  );
  return aimSquares(targeting, actor.position, grid)
    .map((square) => {
      const caught = caughtBy(targeting, actor, square, pool);
      return { square, caught, score: aimScore(targeting, actor, caught) };
    })
    .sort((a, b) => b.score - a.score);
}

export function isMelee(action: KnownAction): boolean {
  const { targeting } = action.activation;
  return (
    "creatures" in targeting &&
    (targeting.reach === true ||
      targeting.range === "touch" ||
      (typeof targeting.range === "number" && targeting.range <= 5))
  );
}

export function combatEnded(
  state: DndState,
  outcome?: "defeat" | "flee",
): SystemEvent[] {
  return [
    ...breathAgainEvents(state),
    {
      kind: "encounterEnded",
      encounter: state.combat?.encounter ?? "",
      ...(outcome ? { outcome } : {}),
    },
    dndEvent(`${NS}:combatEnded`, {}),
  ];
}

export function currentActor(state: DndState): Actor | undefined {
  const actorId = turnId(state.combat);
  return actorId === undefined ? undefined : state.actors[actorId];
}

// Whether a hit can carry extra dice such as Sneak Attack. A character's need a Finesse or a Ranged weapon,
// as the rogue's feature says; a monster's follow its own stat block.
export function carriesExtraDice(
  attacker: Actor,
  action: KnownAction,
  access: Pick<ContentAccess, "content">,
): boolean {
  if (attacker.source.kind !== "character") return true;
  const { resolution } = action.activation;
  if (resolution.kind === "attack" && resolution.attack.finesse) return true;
  const itemId = weaponItemId(action.id);
  const item =
    itemId && access.content(itemId)
      ? lookup(access, ItemSchema, itemId)
      : null;
  return (
    item?.type === "weapon" &&
    (item.properties.includes("finesse") ||
      item.properties.includes("ammunition"))
  );
}
