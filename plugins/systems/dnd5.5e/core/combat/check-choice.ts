import { awaitDecision, type Frame, frameHandler } from "#sdk";
import { z } from "zod";
import {
  ABILITY_NAMES,
  AbilitySchema,
  type LeafEffect,
  LeafEffectSchema,
  type Modifier,
  SkillSchema,
} from "../schemas.ts";
import { type Actor, frame, NS } from "../state.ts";
import { leafEvents } from "./effects.ts";
import type { Context } from "./queries.ts";

// The skill or ability a caster picks as it casts, as Guidance's skill or Enhance Ability's ability, kept in the
// effect it gives. tacticalPolicy takes the first offered, so a spell lists the one a fight uses most first.

type Picking = Extract<LeafEffect, { kind: "modifier" }> & {
  readonly pick: readonly string[];
};

const picking = (effects: readonly LeafEffect[]): Picking[] =>
  effects.filter(
    (effect): effect is Picking =>
      effect.kind === "modifier" &&
      effect.pick !== undefined &&
      effect.option === undefined, // an option's waits until it's picked (combat/options.ts)
  );

// The modifier limited to checks with that skill, or rolls with that ability.
export function withFocus(modifier: Modifier, focus: string): Modifier {
  const ability = AbilitySchema.safeParse(focus);
  const skill = SkillSchema.safeParse(focus);
  switch (modifier.kind) {
    case "bonus":
      return ability.success
        ? { ...modifier, ability: ability.data }
        : skill.success
          ? { ...modifier, skill: skill.data }
          : modifier;
    case "expertise":
      return skill.success ? { ...modifier, skills: [skill.data] } : modifier;
    case "advantage":
    case "disadvantage":
      return ability.success
        ? { ...modifier, ability: ability.data }
        : skill.success
          ? { ...modifier, skills: [skill.data] }
          : modifier;
    default:
      return modifier;
  }
}

const label = (focus: string): string => {
  const ability = AbilitySchema.safeParse(focus);
  if (ability.success) return ABILITY_NAMES[ability.data];
  const words = focus.replace(/([A-Z])/g, " $1").toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

export function focusFrame(
  effects: readonly LeafEffect[],
  sourceId: string,
  caster: Actor,
  target: Actor,
  slotLevel?: number,
  asker = caster.id, // who answers: the player, for a companion's cast between fights (camp.ts)
): Frame | null {
  const chosen = picking(effects);
  const [first] = chosen;
  if (!first) return null;
  return awaitDecision({
    id: `${NS}:focus:${target.id}`,
    actor: asker,
    prompt: `Which ${AbilitySchema.safeParse(first.pick[0]).success ? "ability" : "skill"} for ${target.name}?`,
    options: first.pick.map((focus) => ({ id: focus, label: label(focus) })),
    resume: frame("chooseFocus", {
      effects: chosen,
      sourceId,
      caster: caster.id,
      target: target.id,
      ...(slotLevel === undefined ? {} : { slotLevel }),
    }),
  });
}

const ChooseFocusSchema = z.object({
  effects: z.array(LeafEffectSchema),
  sourceId: z.string(),
  caster: z.string(),
  target: z.string(),
  slotLevel: z.number().optional(),
  answer: z.string(),
});

export const checkChoiceFrames = {
  [`${NS}:chooseFocus`]: frameHandler({
    schema: ChooseFocusSchema,
    run: (payload, context: Context) => {
      const caster = context.state.actors[payload.caster];
      const target = context.state.actors[payload.target];
      if (!caster || !target) return {};
      const chosen = picking(payload.effects);
      if (!chosen.some(({ pick }) => pick.includes(payload.answer))) {
        throw new Error(`${payload.answer} isn't offered`);
      }
      const effects = chosen.map(({ pick: _pick, ...effect }): LeafEffect => ({
        ...effect,
        modifier: withFocus(effect.modifier, payload.answer),
      }));
      return {
        events: leafEvents(
          effects,
          payload.sourceId,
          caster,
          target,
          context,
          undefined,
          payload.slotLevel,
        ),
      };
    },
  }),
};
