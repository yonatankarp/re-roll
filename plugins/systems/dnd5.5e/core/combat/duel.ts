import type { SystemEvent } from "#sdk";
import { distanceFeet } from "../grid.ts";
import { type Actor, type DndState, dndEvent, NS } from "../state.ts";

// Compelled Duel: the target has Disadvantage on attacks against anyone but the caster and stays within reach of it,
// and the caster's turning on someone else ends the spell.

const duelsOf = (actor: Actor) =>
  actor.activeEffects.flatMap(({ modifier, casterId }) =>
    modifier.kind === "duel" ? [{ casterId, feet: modifier.feet }] : [],
  );

export const duelHampers = (attacker: Actor, target: Actor): boolean =>
  duelsOf(attacker).some(({ casterId }) => casterId !== target.id);

// Squares too far from the caster for the target to walk to willingly.
export function leashed(actor: Actor, state: DndState) {
  const duels = duelsOf(actor).flatMap(({ casterId, feet }) => {
    const caster = state.actors[casterId];
    return caster?.position ? [{ at: caster.position, feet }] : [];
  });
  return (square: { readonly x: number; readonly y: number }): boolean =>
    duels.some(({ at, feet }) => distanceFeet(at, square) > feet);
}

// The caster's Concentration ends once it turns on another creature: `against` are those it attacks or casts at.
export function duelBroken(
  caster: Actor,
  against: readonly Actor[],
  state: DndState,
): SystemEvent[] {
  const dueled = Object.values(state.actors).filter((actor) =>
    duelsOf(actor).some(({ casterId }) => casterId === caster.id),
  );
  const turned = against.some(
    (item) =>
      item.side !== caster.side && !dueled.some(({ id }) => id === item.id),
  );
  return dueled.length > 0 && turned && caster.concentratingOn !== null
    ? [dndEvent(`${NS}:concentrationEnded`, { actor: caster.id })]
    : [];
}

// An ally of the caster damaging the target ends it too.
export function duelDamaged(
  source: Actor,
  target: Actor,
  dealt: number,
  state: DndState,
): SystemEvent[] {
  if (dealt <= 0) return [];
  return duelsOf(target).flatMap(({ casterId }) => {
    const caster = state.actors[casterId];
    return caster &&
      source.id !== caster.id &&
      source.side === caster.side &&
      caster.concentratingOn !== null
      ? [dndEvent(`${NS}:concentrationEnded`, { actor: caster.id })]
      : [];
  });
}

// As does the caster ending its turn more than the duel's reach away from the target.
export function duelStrayed(caster: Actor, state: DndState): SystemEvent[] {
  const far = Object.values(state.actors).some((actor) =>
    duelsOf(actor).some(
      ({ casterId, feet }) =>
        casterId === caster.id &&
        distanceFeet(actor.position, caster.position) > feet,
    ),
  );
  return far && caster.concentratingOn !== null
    ? [dndEvent(`${NS}:concentrationEnded`, { actor: caster.id })]
    : [];
}
