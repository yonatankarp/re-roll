import { awaitDecision, type Frame, frameHandler } from "#sdk";
import { z } from "zod";
import type { LeafEffect } from "../schemas.ts";
import { LeafEffectSchema, SpellSchema } from "../schemas.ts";
import { type Actor, dndEvent, frame, isDead, NS } from "../state.ts";
import { doesSomething, onClassList } from "../stats.ts";
import type { Context } from "./queries.ts";
import { leafEvents } from "./effects.ts";

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
  const extras = effect.extras ?? [];
  if (offered.length === 0 && extras.length === 0) return null;
  return awaitDecision({
    id: `${NS}:wish:${caster.id}`,
    actor: caster.id,
    prompt: `Which spell does ${caster.name} wish for?`,
    options: [
      ...offered.map((spell) => ({
        id: spell.id,
        label: `${spell.name} (level ${String(spell.level)})`,
      })),
      ...extras.map((extra, index) => ({
        id: `${EXTRA}${String(index)}`,
        label: extra.name,
      })),
    ],
    resume: frame("copySpell", {
      caster: caster.id,
      sourceId,
      ...(extras.length > 0 ? { extras, stress: effect.stress ?? [] } : {}),
    }),
  });
}

export const wishFrames = {
  [`${NS}:copySpell`]: frameHandler({
    schema: z.object({
      caster: z.string(),
      sourceId: z.string(),
      extras: z.array(z.unknown()).optional(),
      stress: z.array(z.unknown()).optional(),
      answer: z.string(),
    }),
    run: (payload, context: Context) => {
      // One of the other choices: its effects, then the stress it brings.
      if (payload.answer.startsWith(EXTRA)) {
        const extra = (payload.extras as Extra[] | undefined)?.[
          Number(payload.answer.slice(EXTRA.length))
        ];
        const caster = context.state.actors[payload.caster];
        if (!extra || !caster)
          throw new Error(`${payload.answer} isn't offered`);
        const targets = [
          caster,
          ...(extra.allies
            ? Object.values(context.state.actors).filter(
                (item) =>
                  item.id !== caster.id &&
                  item.side === caster.side &&
                  !isDead(item),
              )
            : []),
        ];
        return {
          events: [
            ...targets.flatMap((target) =>
              leafEvents(
                LeafEffectSchema.array().parse(extra.effects),
                payload.sourceId,
                caster,
                target,
                context,
              ),
            ),
            ...leafEvents(
              LeafEffectSchema.array().parse(payload.stress ?? []),
              payload.sourceId,
              caster,
              caster,
              context,
            ),
          ],
        };
      }
      return wished(payload);
    },
  }),
};

type Extra = NonNullable<
  Extract<LeafEffect, { kind: "copySpell" }>["extras"]
>[number];
const EXTRA = "extra:";

const wished = (payload: {
  caster: string;
  sourceId: string;
  answer: string;
}) => ({
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
});
