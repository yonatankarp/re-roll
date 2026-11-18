import { awaitDecision, type Frame, frameHandler } from "#sdk";
import { z } from "zod";
import {
  AbilitySchema,
  type LeafEffect,
  LeafEffectSchema,
} from "../schemas.ts";
import { type Actor, frame, NS } from "../state.ts";
import { focusFrame } from "./check-choice.ts";
import { leafEvents } from "./effects.ts";
import type { Context } from "./queries.ts";

// The caster's choice among an effect's options as it lands, by label (core/schemas.ts `option`): the effects sharing
// a label make one option, as Blindness/Deafness's Blinded or Deafened, or Bestow Curse's four curses.
// tacticalPolicy takes the first offered, so an entry lists its strongest option first.
// shortcut: on a save it's picked once the target has failed, not as the spell is cast, which changes nothing as the
// save is the same whichever is picked. Eyebite's later turns may aim at a creature that already saved against it.

const optioned = (effects: readonly LeafEffect[]): LeafEffect[] =>
  effects.filter((effect) => labelOf(effect) !== undefined);

const labelOf = (effect: LeafEffect): string | undefined =>
  effect.kind === "applyCondition" ||
  effect.kind === "modifier" ||
  effect.kind === "forcedMove"
    ? effect.option
    : undefined;

export function optionFrame(
  effects: readonly LeafEffect[],
  sourceId: string,
  caster: Actor,
  target: Actor,
  save?: {
    readonly ability: z.infer<typeof AbilitySchema>;
    readonly dc: number;
  },
  slotLevel?: number,
): Frame | null {
  const chosen = optioned(effects);
  const labels = [...new Set(chosen.flatMap((item) => labelOf(item) ?? []))];
  if (labels.length === 0) return null;
  return awaitDecision({
    id: `${NS}:option:${target.id}`,
    actor: caster.id,
    prompt: `Which effect on ${target.name}?`,
    options: labels.map((label) => ({ id: label, label })),
    resume: frame("chooseOption", {
      effects: chosen,
      sourceId,
      caster: caster.id,
      target: target.id,
      ...(save ? { save } : {}),
      ...(slotLevel === undefined ? {} : { slotLevel }),
    }),
  });
}

const ChooseOptionSchema = z.object({
  effects: z.array(LeafEffectSchema),
  sourceId: z.string(),
  caster: z.string(),
  target: z.string(),
  save: z.object({ ability: AbilitySchema, dc: z.number() }).optional(),
  slotLevel: z.number().optional(),
  answer: z.string(),
});

export const optionFrames = {
  [`${NS}:chooseOption`]: frameHandler({
    schema: ChooseOptionSchema,
    run: (payload, context: Context) => {
      const caster = context.state.actors[payload.caster];
      const target = context.state.actors[payload.target];
      if (!caster || !target) return {};
      const picked = payload.effects.flatMap((effect): LeafEffect[] =>
        (effect.kind === "applyCondition" ||
          effect.kind === "modifier" ||
          effect.kind === "forcedMove") &&
        effect.option === payload.answer
          ? [{ ...effect, option: undefined }]
          : [],
      );
      if (picked.length === 0) {
        throw new Error(`${payload.answer} isn't offered`);
      }
      // An option with an ability to pick asks for it next, as Bestow Curse's.
      const focus = focusFrame(
        picked,
        payload.sourceId,
        caster,
        target,
        payload.slotLevel,
      );
      return {
        events: leafEvents(
          picked,
          payload.sourceId,
          caster,
          target,
          context,
          payload.save,
          payload.slotLevel,
        ),
        ...(focus ? { frames: [focus] } : {}),
      };
    },
  }),
};
