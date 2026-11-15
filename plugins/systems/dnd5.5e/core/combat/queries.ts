import { type ContentAccess, type SystemContext, type SystemEvent } from "#sdk";
import { knownFoes, knows } from "../fog.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
  frame,
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
import type { Passive, Skill } from "../schemas.ts";
import {
  distanceFeet,
  rangeFeet,
  reachableSquares,
  type Square,
  squareKey,
} from "../grid.ts";
import { speedOf } from "../tactics.ts";
import {
  crossesDifficult,
  jumpOf,
  type Mode,
  speedsOf,
  type Through,
  throughOf,
} from "../movement-modes.ts";
import { behindTotalCover, difficultSquares } from "../sight.ts";
import { encodeOption } from "./ids.ts";
import { swallowerOf } from "./swallow.ts";
import {
  type Ability,
  CompanionSchema,
  ItemSchema,
  MonsterSchema,
  SpeciesSchema,
  type Targeting,
} from "../schemas.ts";
import { bossAction } from "../legendary.ts";
import { aimScore, aimSquares, caughtBy } from "../targeting.ts";

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
): boolean {
  return [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
  ].some(
    (modifier) =>
      modifier.kind === kind &&
      modifier.on === on &&
      (!modifier.ability || modifier.ability === ability) &&
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
  to: "attacks" | "saves" | "checks",
  context: Context,
  skill?: Skill, // the check's skill, for a bonus that only adds to one
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const effect of actor.activeEffects) {
    const { modifier } = effect;
    if (modifier.kind !== "bonus" || modifier.to !== to) continue;
    if (modifier.skill && modifier.skill !== skill) continue;
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
  for (const modifier of passiveModifiers(stats.passives)) {
    if (
      modifier.kind === "bonus" &&
      modifier.to === to &&
      (!modifier.skill || modifier.skill === skill)
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
  const distance = distanceFeet(actor.position, target.position);
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
  const held = hasCondition(actor, "grappled", "restrained", ...INCAPACITATING);
  return new Map(
    [...speedsOf(actor, stats)].map(([mode, feet]) => [
      mode,
      held || !actor.position
        ? 0
        : Math.max(0, speedOf(actor, { ...stats, speed: feet }) - actor.moved),
    ]),
  );
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
  if (through.creatures === "any" || throughOf(deriveStats(other, access)).open)
    return true;
  const size = sizeOf(other, access);
  const own = sizeOf(mover, access);
  return (
    size === 0 ||
    Math.abs(size - own) >= 2 ||
    (through.creatures === "larger" && size > own)
  );
}

// The ground as one creature moving finds it: what it can't enter, where it can't stop, and what costs double.
// Another creature's space costs double unless it's an ally's or a Tiny one's. Walls it passes through can't be
// stopped in. shortcut: nobody may stop in another's space, a swarm included; let two share a square once the board
// can draw them.
export function groundFor(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): {
  readonly blocked: ReadonlySet<string>;
  readonly occupied: ReadonlySet<string>;
  readonly terrain: ReadonlySet<string>; // difficult terrain on the ground
  readonly costly: ReadonlySet<string>; // squares that cost double however it moves
  readonly walls: ReadonlySet<string>;
  readonly squeeze: boolean;
  readonly overTerrain: boolean; // crosses difficult terrain at no extra cost, however it moves
} {
  const stats = deriveStats(actor, access);
  const through = throughOf(stats);
  const walls = state.combat?.walls ?? [];
  const blocked = new Set(through.walls ? [] : walls);
  const occupied = new Set(walls);
  const costly = new Set(through.costly ? walls : []);
  for (const other of Object.values(state.actors)) {
    if (other.id === actor.id || !other.position || isDead(other)) continue;
    const key = squareKey(other.position);
    occupied.add(key);
    if (!passes(actor, through, other, access)) blocked.add(key);
    else if (other.side !== actor.side && sizeOf(other, access) > 0) {
      costly.add(key);
    }
  }
  return {
    blocked,
    occupied,
    terrain: difficultSquares(state),
    costly,
    walls: new Set(walls),
    squeeze: through.squeeze,
    overTerrain: through.terrain,
  };
}

// Every square it can move to this turn, in whichever of its Speeds gets there cheapest. A flyer, climber or burrower
// crosses difficult terrain at no extra cost.
export function moveSquares(
  actor: Actor,
  state: DndState,
  stats: Stats,
  access: ContentAccess,
): ReturnType<typeof reachableSquares> {
  const grid = state.combat?.grid;
  if (!grid || !actor.position) return [];
  const ground = groundFor(actor, state, access);
  const jump = jumpOf(stats);
  const walking =
    ground.costly.size === 0
      ? ground.terrain
      : new Set([...ground.terrain, ...ground.costly]);
  const best = new Map<string, ReturnType<typeof reachableSquares>[number]>();
  for (const [mode, feet] of speedsLeft(actor, stats)) {
    if (feet <= 0) continue;
    const found = reachableSquares(
      actor.position,
      feet,
      grid,
      ground.blocked,
      ground.occupied,
      crossesDifficult(mode) || ground.overTerrain ? ground.costly : walking,
      ground.walls,
      { squeeze: ground.squeeze, jump },
    );
    for (const item of found) {
      const key = squareKey(item.square);
      if (item.feet < (best.get(key)?.feet ?? Infinity)) best.set(key, item);
    }
  }
  return [...best.values()];
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

// A creature's size, as its index in SIZES.
export function sizeOf(actor: Actor, access: ContentAccess): number {
  if (actor.source.kind === "monster") {
    const { size } = lookup(access, MonsterSchema, actor.source.statBlockId);
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
): boolean {
  if ("self" in targeting) return true;
  const gate = "targetConditions" in targeting && targeting.targetConditions;
  if (gate && !hasCondition(item, ...gate)) return false;
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
  const { carrying } = action.activation;
  if (carrying && !actor.inventory.includes(carrying)) return false;
  return action.activation.cost.every((cost) => {
    if (cost === "action") return actor.budget.action;
    if (cost === "bonusAction") return actor.budget.bonusAction;
    if (cost === "reaction") return actor.budget.reaction;
    if (cost === "slot") return slotToSpend(action, actor, stats) !== null;
    return (
      (actor.resourcesSpent[cost.resource] ?? 0) <
      (stats.resources[cost.resource] ?? 0)
    );
  });
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
  return (
    targeting.side === "enemy"
      ? knownFoes(state, actor, access).filter(
          (item) => !isDown(item) && !charmers.has(item.id),
        )
      : allies(state, actor)
  )
    .filter((item) => !isDead(item))
    .filter((item) => fitsType(item, targeting, access))
    .filter((item) => reaches(action, actor, item))
    .filter((item) => !behindTotalCover(state, actor, item));
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

// Every creature in the fight an area could catch.
export function areaPool(
  targeting: Targeting,
  context: ContentAccess & { readonly state: DndState },
): readonly Actor[] {
  return (context.state.combat?.order ?? []).flatMap((id) => {
    const item = context.state.actors[id];
    return item && !isDead(item) && fitsType(item, targeting, context)
      ? [item]
      : [];
  });
}

// A cast keeps its slot level in the frames it leaves behind, so later steps roll the same dice.
export function findAction(
  actor: Actor,
  id: string,
  context: Context,
  slotLevel?: number,
): KnownAction {
  const action =
    deriveStats(actor, context).actions.find((item) => item.id === id) ??
    bossAction(actor, id, context);
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
      resolution.attack.type === "spell")
  ) {
    return [action.id];
  }
  return (
    stats.routines?.[action.id] ??
    Array<string>(stats.multiattack).fill(action.id)
  );
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
  // catches them.
  const pool = areaPool(targeting, context).filter((item) =>
    knows(context.state, actor, item, context),
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
    (targeting.range === "touch" ||
      (typeof targeting.range === "number" && targeting.range <= 5))
  );
}

export function combatEnded(
  state: DndState,
  outcome?: "defeat" | "flee",
): SystemEvent[] {
  return [
    {
      kind: "encounterEnded",
      encounter: state.combat?.encounter ?? "",
      ...(outcome ? { outcome } : {}),
    },
    dndEvent(`${NS}:combatEnded`, {}),
  ];
}

export function currentActor(state: DndState): Actor | undefined {
  const actorId = state.combat?.order[state.combat.index];
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
  const itemId = action.id.startsWith("weapon:") ? action.id.slice(7) : "";
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
