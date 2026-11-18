import {
  awaitDecision,
  type ContentAccess,
  type Frame,
  frameHandler,
  type SystemEvent,
} from "#sdk";
import { z } from "zod";
import { CharacterOptionSchema, LeafEffectSchema } from "../schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  dndEvent,
  frame,
  NS,
} from "../state.ts";
import { formsFor, type Polymorph } from "../forms.ts";
import { deriveStats, evaluateFormula, rollAmount } from "../stats.ts";
import type { Context } from "./queries.ts";

// Polymorph's family on the grid: the form a caster chooses for itself or an ally, and the events that give it.

// The form's effect and its Temporary Hit Points; a creature that can't cast in it stops concentrating, unless
// the form keeps its features, as Wild Shape doesn't break Concentration.
export function formEvents(
  effect: Polymorph,
  sourceId: string,
  caster: Actor,
  target: Actor,
  form: { readonly id: string; readonly hp: number },
  ends: ActiveEffect["ends"],
  context: Context,
): SystemEvent[] {
  const stats = deriveStats(caster, context);
  const ac = effect.acFloor && evaluateFormula(effect.acFloor, stats);
  // A new shape replaces the one it's in, as using Wild Shape again or Shapechange's Magic action.
  const old = target.activeEffects.find(
    ({ modifier }) => modifier.kind === "form",
  );
  // Reshaping a form the caster gave keeps what it hangs on, as Shapechange's Magic action keeps its Concentration.
  const kept = old?.casterId === caster.id ? old : undefined;
  const events = [
    ...(old
      ? [
          dndEvent(`${NS}:effectEnded`, {
            actor: target.id,
            sourceId: old.sourceId,
            casterId: old.casterId,
          }),
        ]
      : []),
    dndEvent(`${NS}:effectAdded`, {
      actor: target.id,
      effect: {
        sourceId: kept?.sourceId ?? sourceId,
        casterId: caster.id,
        modifier: {
          kind: "form",
          monster: form.id,
          ...(effect.keep ? { keep: effect.keep } : {}),
          ...(ac ? { ac } : {}),
          ...(effect.lasting ? { lasting: true } : {}),
        },
        ends: kept?.ends ?? ends,
        ...(kept?.lasts ? { lasts: kept.lasts } : {}),
        ...(effect.untilIncapacitated ? { untilIncapacitated: true } : {}),
      },
    }),
  ];
  const amount = effect.tempHpAmount
    ? rollAmount(effect.tempHpAmount, stats, context.dice)
    : form.hp + (effect.tempHpPlus ?? 0);
  if (effect.tempHp && amount > 0) {
    events.push(dndEvent(`${NS}:tempHpGained`, { actor: target.id, amount }));
  }
  if (
    target.concentratingOn !== null &&
    !effect.keep?.includes("spells") &&
    !effect.keep?.includes("features")
  ) {
    events.push(dndEvent(`${NS}:concentrationEnded`, { actor: target.id }));
  }
  return events;
}

// shortcut: the caster chooses among the strongest few forms allowed, as a long list of every stat block wouldn't help.
const FORMS_OFFERED = 8;

// The Beasts of the beast-shape lists for this fight's place: underwater the only one a fight names.
function beastsHere(access: ContentAccess): ReadonlySet<string> {
  const state = "state" in access ? (access.state as DndState) : undefined;
  if (!state?.combat?.underwater) return new Set();
  return new Set(
    access.contentIds().flatMap((id) => {
      if (!id.includes(":beast-shape-list/")) return [];
      const list = CharacterOptionSchema.safeParse(access.content(id)).data;
      return list?.underwater ? (list.beasts ?? []) : [];
    }),
  );
}

// The caster picks a form for itself or an ally, the strongest first.
export function formFrame(
  effect: Polymorph,
  sourceId: string,
  caster: Actor,
  target: Actor,
  ends: ActiveEffect["ends"],
  access: ContentAccess,
): Frame | null {
  // A beast-shape list for where the fight is, as Xanathar's Underwater list, comes first (#192).
  const listed = beastsHere(access);
  const allowed = formsFor(effect, target, access).toReversed();
  const offered = [
    ...allowed.filter((block) => listed.has(block.id)),
    ...allowed.filter((block) => !listed.has(block.id)),
  ].slice(0, FORMS_OFFERED);
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
    run: (payload, context: Context) => {
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
          context,
        ),
      };
    },
  }),
};
