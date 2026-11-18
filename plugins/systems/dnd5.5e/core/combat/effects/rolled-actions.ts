import { deriveStats, type KnownAction } from "../../stats.ts";
import { type Actor, dndEvent, NS, frame } from "../../state.ts";
import { type Frame, type SystemEvent } from "#sdk";
import { type LeafEffect, SpellSchema } from "../../schemas.ts";
import { spellOfSource } from "../ids.ts";
import { type Context } from "../queries.ts";
import { resolveAction } from "./resolution.ts";

// Actions picked by a roll, as Eye Rays or Prismatic Spray's rays.

// Each roll picks one of the actions it names, rolling again for one already used this turn, as Eye Rays do.
export function rolledActions(
  effect: Extract<LeafEffect, { kind: "randomAction" }>,
  action: KnownAction,
  actor: Actor,
  target: Actor,
  context: Context,
  slotLevel: number | undefined,
): { events: SystemEvent[]; frames: Frame[] } {
  const rays = spellRolls(action, context);
  if (rays) return rolledRays(effect, rays, actor, target, context, slotLevel);
  const known = deriveStats(actor, context).actions;
  const used = new Set(effect.repeats ? [] : actor.usedThisTurn);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  for (let time = 0; time < effect.times; time += 1) {
    if (effect.of.every((name) => used.has(`rolled:${name}`))) break;
    let name = "";
    do {
      name = effect.of[context.dice.roll(effect.of.length) - 1] ?? "";
    } while (used.has(`rolled:${name}`));
    used.add(`rolled:${name}`);
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: actor.id,
        key: `rolled:${name}`,
      }),
    );
    const action = known.find((item) => item.name === name);
    if (action) {
      frames.push(
        frame("useAction", {
          actor: actor.id,
          actionId: action.id,
          target: target.id,
        }),
      );
    }
  }
  return { events, frames };
}

// A spell's own rolled activations, as Prismatic Spray's rays, each made as the spell itself, named by its label.
function spellRolls(
  action: KnownAction,
  context: Context,
): readonly (KnownAction & { readonly label: string })[] | null {
  const id = spellOfSource(action.id);
  if (!id) return null;
  const spell = SpellSchema.safeParse(context.content(id)).data;
  return (
    spell?.rolled?.map((activation) => ({
      id: action.id,
      name: action.name,
      label: activation.label ?? "",
      activation,
      spellLevel: action.spellLevel,
    })) ?? null
  );
}

// Each target gets its own roll among them, and with `twiceOnTop` the die's top face strikes it with two,
// rolling that face again.
function rolledRays(
  effect: Extract<LeafEffect, { kind: "randomAction" }>,
  rays: readonly (KnownAction & { readonly label: string })[],
  actor: Actor,
  target: Actor,
  context: Context,
  slotLevel: number | undefined,
): { events: SystemEvent[]; frames: Frame[] } {
  const sides = effect.of.length + (effect.twiceOnTop ? 1 : 0);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  const roll = (): number => {
    const value = context.dice.roll(sides);
    events.push(
      dndEvent(`${NS}:dieRolled`, {
        actor: target.id,
        die: sides,
        rolled: value,
        label: rays[0]?.name ?? "",
      }),
    );
    return value;
  };
  const first = roll();
  const picks: number[] = [];
  if (effect.twiceOnTop && first === sides) {
    while (picks.length < 2) {
      const again = roll();
      if (again !== sides) picks.push(again);
    }
  } else {
    picks.push(first);
  }
  // shortcut: a creature struck by two rays saves against each.
  for (const pick of picks) {
    const ray = rays.find(({ label }) => label === effect.of[pick - 1]);
    if (!ray) continue;
    const result = resolveAction(ray, actor, [target], context, slotLevel);
    events.push(...(result.events ?? []));
    frames.push(...(result.frames ?? []));
  }
  return { events, frames };
}
