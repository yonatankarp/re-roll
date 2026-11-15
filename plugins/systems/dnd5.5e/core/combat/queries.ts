import { type ContentAccess, type SystemContext, type SystemEvent } from "#sdk";
import { knownFoes, knows } from "../fog.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  equipped,
  forAttacker,
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
import { heightOf } from "./falling.ts";
import { speedOf } from "../tactics.ts";
import { behindTotalCover, difficultSquares } from "../sight.ts";
import { encodeOption, THROW_PREFIX, weaponItemId } from "./ids.ts";
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
  zonesOn,
} from "../zones.ts";
import { spellLevelOf } from "./dispel.ts";
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
  attackerId?: string, // for attacksAgainst, which a caster's own Advantage needs
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
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const effect of actor.activeEffects) {
    const { modifier } = effect;
    if (modifier.kind !== "bonus" || modifier.to !== to) continue;
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
  for (const modifier of passiveModifiers(stats.passives)) {
    if (
      modifier.kind === "bonus" &&
      modifier.to === to &&
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

export function speedLeft(actor: Actor, stats: Stats): number {
  const held = hasCondition(actor, "grappled", "restrained", ...INCAPACITATING);
  return held || !actor.position
    ? 0
    : Math.max(0, speedOf(actor, stats) - actor.moved);
}

export function moveSquares(
  actor: Actor,
  state: DndState,
  stats: Stats,
  access?: ContentAccess, // for a monster's aura that slows or bars it, and the creature types a zone spares
): ReturnType<typeof reachableSquares> {
  const grid = state.combat?.grid;
  if (!grid || !actor.position) return [];
  const others = Object.values(state.actors).filter(
    (item) => item.id !== actor.id && item.position && !isDead(item),
  );
  const keys = (list: readonly Actor[]): Set<string> =>
    new Set(
      list.flatMap((item) => (item.position ? [squareKey(item.position)] : [])),
    );
  const walls = blockedSquares(state);
  // A barrier it can't cross stops it as a wall would, and a zone that slows it costs double.
  const barred = barredKeys(actor, state, access);
  const slowing = slowingKeys(actor, state, access);
  const difficult = difficultSquares(state);
  return reachableSquares(
    actor.position,
    speedLeft(actor, stats),
    grid,
    new Set([
      ...keys(
        others.filter((item) => item.side !== actor.side && !isDown(item)),
      ),
      ...walls,
      ...barred,
    ]),
    new Set([...keys(others), ...walls, ...barred]),
    slowing.length > 0 ? new Set([...difficult, ...slowing]) : difficult,
    blockingSet(state),
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
  const { carrying, afterAction, resolution } = action.activation;
  if (carrying && !actor.inventory.includes(carrying)) return false;
  if (afterAction && actor.budget.action) return false;
  // Haste's additional action takes only a weapon attack, or Dash, Disengage or Hide (actions.ts).
  if (
    hasteActing(actor) &&
    action.activation.cost.includes("action") &&
    (resolution.kind !== "attack" || resolution.attack.type !== "weapon")
  ) {
    return false;
  }
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
    .filter(
      (item) =>
        isDead(item) === ("dead" in targeting && targeting.dead === true),
    )
    .filter((item) => fitsType(item, targeting, access))
    .filter((item) => reaches(action, actor, item))
    .filter((item) => !behindTotalCover(state, actor, item))
    .filter((item) => !walledApart(actor, item, action, state, access));
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
    bossAction(actor, id, context) ??
    ownZoneAction(actor, id, context);
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
