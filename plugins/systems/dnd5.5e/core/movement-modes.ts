// How a creature gets about the grid beyond walking: its other Speeds, what it moves through, how far it jumps, and
// what its Tremorsense finds. Player characters, monsters and the tactics all read it, so they move alike.
import type { Actor } from "./state.ts";
import type { Passive } from "./schemas.ts";
import { passiveModifiers, type Stats } from "./stats.ts";

export type Mode = "walk" | "fly" | "climb" | "burrow";

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
    const feet = modifier.feet ?? stats.speed;
    speeds.set(modifier.mode, Math.max(speeds.get(modifier.mode) ?? 0, feet));
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

// Whether Difficult Terrain costs it nothing extra, as with Freedom of Movement.
export function unhindered(actor: Actor, stats: Stats): boolean {
  return modifiersOf(actor, stats).some(
    (modifier) => modifier.kind === "unhindered",
  );
}

export function bestSpeed(actor: Actor, stats: Stats): number {
  return Math.max(...speedsOf(actor, stats).values());
}

// A flyer goes over the ground, and a burrower under it. shortcut: the map has no heights, so a climber is taken to
// go up and over what slows a walker too; give squares a height if a map needs climbing told apart.
export function crossesDifficult(mode: Mode): boolean {
  return mode !== "walk";
}

export type Through = Omit<Extract<Passive, { kind: "moveThrough" }>, "kind">;

// Everything its traits let it move through, together.
export function throughOf(stats: Stats): Through {
  const all = stats.passives.flatMap((passive) =>
    passive.kind === "moveThrough" ? [passive] : [],
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
  const standing = runUp === 0 ? running : Math.floor(running / 2);
  return { standing, running, runUp };
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
