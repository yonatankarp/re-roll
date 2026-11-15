import {
  awaitDecision,
  type ContentAccess,
  type Frame,
  frameHandler,
  type SystemEvent,
} from "#sdk";
import { z } from "zod";
import { LeafEffectSchema } from "../schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  dndEvent,
  type DndState,
  frame,
  NS,
} from "../state.ts";
import { formsFor, type Polymorph } from "../forms.ts";

// Polymorph's family on the grid: the form a caster chooses for itself or an ally, and the events that give it.

// The form's effect and its Temporary Hit Points; a creature that can't cast in it stops concentrating.
export function formEvents(
  effect: Polymorph,
  sourceId: string,
  caster: Actor,
  target: Actor,
  form: { readonly id: string; readonly hp: number },
  ends: ActiveEffect["ends"],
): SystemEvent[] {
  const events = [
    dndEvent(`${NS}:effectAdded`, {
      actor: target.id,
      effect: {
        sourceId,
        casterId: caster.id,
        modifier: {
          kind: "form",
          monster: form.id,
          ...(effect.keep ? { keep: effect.keep } : {}),
        },
        ends,
      },
    }),
  ];
  if (effect.tempHp) {
    events.push(
      dndEvent(`${NS}:tempHpGained`, { actor: target.id, amount: form.hp }),
    );
  }
  if (target.concentratingOn !== null && !effect.keep?.includes("spells")) {
    events.push(dndEvent(`${NS}:concentrationEnded`, { actor: target.id }));
  }
  return events;
}

// shortcut: the caster chooses among the strongest few forms allowed, as a long list of every stat block wouldn't help.
const FORMS_OFFERED = 8;

// The caster picks a form for itself or an ally, the strongest first.
export function formFrame(
  effect: Polymorph,
  sourceId: string,
  caster: Actor,
  target: Actor,
  ends: ActiveEffect["ends"],
  access: ContentAccess,
): Frame | null {
  const offered = formsFor(effect, target, access)
    .toReversed()
    .slice(0, FORMS_OFFERED);
  if (offered.length === 0) return null;
  return awaitDecision({
    id: `${NS}:form:${target.id}`,
    actor: caster.id,
    prompt: `What does ${target.name} become?`,
    options: offered.map((block) => ({
      id: block.id,
      label: `${block.name} (CR ${formatCr(block.cr)})`,
    })),
    resume: frame("chooseForm", {
      effect,
      sourceId,
      caster: caster.id,
      target: target.id,
      ends,
    }),
  });
}

const formatCr = (cr: number): string =>
  cr > 0 && cr < 1 ? `1/${String(Math.round(1 / cr))}` : String(cr);

const ChooseFormSchema = z.object({
  effect: LeafEffectSchema,
  sourceId: z.string(),
  caster: z.string(),
  target: z.string(),
  ends: z.enum([
    "concentration",
    "casterNextTurn",
    "casterNextTurnEnd",
    "spellDuration",
  ]),
  answer: z.string(),
});

export const formFrames = {
  [`${NS}:chooseForm`]: frameHandler({
    schema: ChooseFormSchema,
    run: (payload, context: ContentAccess & { readonly state: DndState }) => {
      const { effect } = payload;
      const caster = context.state.actors[payload.caster];
      const target = context.state.actors[payload.target];
      if (effect.kind !== "polymorph" || !caster || !target) return {};
      const form = formsFor(effect, target, context).find(
        ({ id }) => id === payload.answer,
      );
      if (!form)
        throw new Error(`${target.name} can't become ${payload.answer}`);
      return {
        events: formEvents(
          effect,
          payload.sourceId,
          caster,
          target,
          form,
          payload.ends,
        ),
      };
    },
  }),
};
