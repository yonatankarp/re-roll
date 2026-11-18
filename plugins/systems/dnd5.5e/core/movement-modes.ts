// How a creature gets about the grid beyond walking: its other Speeds, what it moves through, how far it jumps, and
// what its Tremorsense finds. Player characters, monsters and the tactics all read it, so they move alike.
import type { Actor } from "./state.ts";
import type { Passive } from "./schemas.ts";
import { passiveModifiers, type Stats } from "./stats.ts";

export type Mode = "walk" | "fly" | "climb" | "burrow" | "swim";

function modifiersOf(actor: Actor, stats: Stats) {
  return [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
  ];
}

// Every Speed it has now, before Dashes: walking, the stat block's others, and any an effect or trait gives. One
// with no feet of its own is as fast as walking.
export function speedsOf(
  actor: Actor,
  stats: Stats,
): ReadonlyMap<Mode, number> {
  const speeds = new Map<Mode, number>([["walk", stats.speed]]);
  for (const [mode, feet] of Object.entries(stats.speeds) as [Mode, number][]) {
    speeds.set(mode, feet);
  }
  for (const modifier of modifiersOf(actor, stats)) {
    if (modifier.kind !== "movementMode") continue;
    const feet = modifier.feet ?? stats.speed * (modifier.times ?? 1);
    speeds.set(modifier.mode, Math.max(speeds.get(modifier.mode) ?? 0, feet));
  }
  // Earthbind: no Speed of that kind.
  for (const modifier of modifiersOf(actor, stats)) {
    if (modifier.kind !== "grounded") continue;
    const feet = speeds.get(modifier.mode);
    if (modifier.feet === undefined || feet === undefined) {
      speeds.delete(modifier.mode);
    } else speeds.set(modifier.mode, Math.min(feet, modifier.feet));
  }
  // A Speed bonus that goes to the other Speeds it has too, as Superior Mobility's, onto those of feet of their own.
  for (const modifier of passiveModifiers(stats.passives)) {
    if (modifier.kind !== "bonus" || modifier.to !== "speed") continue;
    const amount = modifier.amount.bonus?.base ?? 0;
    for (const mode of modifier.modes ?? []) {
      const feet = speeds.get(mode);
      if (feet !== undefined && feet !== stats.speed) {
        speeds.set(mode, feet + amount);
      }
    }
  }
  return speeds;
}

// Whether a flying Speed it has lets it hover, so it stays up while Prone or Incapacitated (combat/falling.ts).
// shortcut: a stat block's "(hover)" isn't read, since monsters never take off on their own.
export function hovers(actor: Actor, stats: Stats): boolean {
  return modifiersOf(actor, stats).some(
    (modifier) =>
      modifier.kind === "movementMode" &&
      modifier.mode === "fly" &&
      modifier.hover === true,
  );
}

// Whether it climbs along ceilings as well as walls, as with Spider Climb, so it can go up anywhere.
export function climbsCeilings(actor: Actor, stats: Stats): boolean {
  return modifiersOf(actor, stats).some(
    (modifier) =>
      modifier.kind === "movementMode" &&
      modifier.mode === "climb" &&
      modifier.ceiling === true,
  );
}

// Whether Difficult Terrain costs it nothing extra, as with Freedom of Movement, and with `slipping` whether it can also
// slip a grapple for 5 feet of movement.
export function unhindered(
  actor: Actor,
  stats: Stats,
  slipping = false,
): boolean {
  return modifiersOf(actor, stats).some(
    (modifier) =>
      modifier.kind === "unhindered" &&
      modifier.ice !== true &&
      (!slipping || !modifier.terrainOnly),
  );
}

// Whether ice and snow cost it no extra movement, as with Winter Strider.
export function stridesIce(actor: Actor, stats: Stats): boolean {
  return modifiersOf(actor, stats).some(
    (modifier) => modifier.kind === "unhindered" && modifier.ice === true,
  );
}

// Whether it walks on water as on ground, as with Water Walk.
export function walksOnWater(actor: Actor, stats: Stats): boolean {
  return modifiersOf(actor, stats).some(
    (modifier) => modifier.kind === "waterWalk",
  );
}

export function bestSpeed(actor: Actor, stats: Stats): number {
  return Math.max(...speedsOf(actor, stats).values());
}

// A flyer goes over the ground, and a burrower under it. shortcut: the map has no heights, so a climber is taken to
// go up and over what slows a walker too; give squares a height if a map needs climbing told apart.
export function crossesDifficult(mode: Mode): boolean {
  return mode !== "walk" && mode !== "swim";
}

export type Through = Omit<
  Extract<Passive, { kind: "moveThrough" }>,
  "kind" | "while" | "whileAspect"
>;

// Everything its traits let it move through, together; one held to a feature's effect only while that's on it.
export function throughOf(stats: Stats, actor?: Actor): Through {
  const all = stats.passives.flatMap((passive) =>
    passive.kind === "moveThrough" &&
    (!passive.while ||
      passive.while.some((id) =>
        actor?.activeEffects.some(({ sourceId }) =>
          sourceId.startsWith(`feature:${id}:`),
        ),
      )) &&
    (!passive.whileAspect ||
      actor?.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "aspect" && modifier.name === passive.whileAspect,
      ))
      ? [passive]
      : [],
  );
  const creatures = all.some((item) => item.creatures === "any")
    ? "any"
    : all.some((item) => item.creatures === "larger")
      ? "larger"
      : undefined;
  return {
    ...(creatures ? { creatures } : {}),
    walls: all.some((item) => item.walls),
    // Free passage through walls from one trait beats a costly one from another.
    costly:
      all.some((item) => item.walls && item.costly) &&
      !all.some((item) => item.walls && !item.costly),
    squeeze: all.some((item) => item.squeeze || item.walls),
    open: all.some((item) => item.open),
    terrain: all.some((item) => item.terrain),
  };
}

export interface Jump {
  readonly standing: number; // feet, with no run-up
  readonly running: number; // feet, after `runUp` feet of movement
  readonly runUp: number;
}

// A Long Jump: the Strength score in feet after a 10-foot run, or half that standing, unless a trait does better, as
// Jumper's Dexterity score. A jump only clears difficult terrain: passing a creature's space is up to their sizes, so
// the board needs no High Jump.
export function jumpOf(stats: Stats): Jump {
  const dex = stats.passives.some(
    (passive) => passive.kind === "jump" && passive.ability === "dex",
  );
  let running = dex
    ? Math.max(stats.abilities.str, stats.abilities.dex)
    : stats.abilities.str;
  let runUp = 10;
  for (const passive of stats.passives) {
    if (passive.kind !== "jump") continue;
    running = Math.max(running, passive.feet ?? running);
    runUp = Math.min(runUp, passive.runUp);
  }
  const times = stats.passives.reduce(
    (product, passive) =>
      passive.kind === "jump" && passive.times
        ? product * passive.times
        : product,
    1,
  );
  const standing = (runUp === 0 ? running : Math.floor(running / 2)) * times;
  return { standing, running: running * times, runUp };
}

// How far its Tremorsense reaches, in feet, or 0 with none.
export function tremorsenseOf(actor: Actor, stats: Stats): number {
  return Math.max(
    0,
    ...modifiersOf(actor, stats).flatMap((modifier) =>
      modifier.kind === "tremorsense" ? [modifier.feet] : [],
    ),
  );
}
