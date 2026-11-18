import { awaitDecision, type Frame, frameHandler } from "#sdk";
import { z } from "zod";
import type { LeafEffect } from "../schemas.ts";
import { SpellSchema } from "../schemas.ts";
import { type Actor, dndEvent, frame, NS } from "../state.ts";
import { doesSomething, onClassList } from "../stats.ts";
import type { Context } from "./queries.ts";

// Wish's copy of another spell: the caster picks one that plays on the grid, and casts it without its costs before
// its next turn (core/stats.ts "wished").

export function wishFrame(
  effect: Extract<LeafEffect, { kind: "copySpell" }>,
  sourceId: string,
  caster: Actor,
  context: Context,
): Frame | null {
  const spells = context.contentIds().flatMap((id) => {
    const spell = SpellSchema.safeParse(context.content(id)).data;
    return spell?.activation &&
      spell.level <= effect.maxLevel &&
      (spell.lasting || doesSomething(spell.activation.resolution)) &&
      (!effect.classes || onClassList(spell, effect.classes)) &&
      (!effect.noReaction || !spell.activation.cost.includes("reaction")) &&
      (!effect.spells || effect.spells.includes(spell.id))
      ? [spell]
      : [];
  });
  // The same spell from two books is offered once, from the one that wins, which is listed first.
  const offered = spells
    .filter(
      (spell, index) =>
        spells.findIndex(({ name }) => name === spell.name) === index,
    )
    .sort(
      (a, b) =>
        b.level - a.level || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  if (offered.length === 0) return null;
  return awaitDecision({
    id: `${NS}:wish:${caster.id}`,
    actor: caster.id,
    prompt: `Which spell does ${caster.name} wish for?`,
    options: offered.map((spell) => ({
      id: spell.id,
      label: `${spell.name} (level ${String(spell.level)})`,
    })),
    resume: frame("copySpell", { caster: caster.id, sourceId }),
  });
}

export const wishFrames = {
  [`${NS}:copySpell`]: frameHandler({
    schema: z.object({
      caster: z.string(),
      sourceId: z.string(),
      answer: z.string(),
    }),
    run: (payload) => ({
      events: [
        dndEvent(`${NS}:effectAdded`, {
          actor: payload.caster,
          effect: {
            sourceId: payload.sourceId,
            casterId: payload.caster,
            modifier: { kind: "wished", spell: payload.answer },
            ends: "casterNextTurn",
          },
        }),
      ],
    }),
  }),
};
