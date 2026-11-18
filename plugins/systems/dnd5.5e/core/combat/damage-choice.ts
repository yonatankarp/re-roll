import { awaitDecision, type Decision, type Frame, frameHandler } from "#sdk";
import { z } from "zod";
import {
  type DamageType,
  DamageTypeSchema,
  type LeafEffect,
  LeafEffectSchema,
  type Modifier,
} from "../schemas.ts";
import { type Actor, dndEvent, frame, isDown, NS } from "../state.ts";
import { damageResponses, deriveStats } from "../stats.ts";
import { leafEvents, leastResisted, retyped } from "./effects.ts";
import { type Context, enemies } from "./queries.ts";

// The damage type a caster picks as it casts, as Protection from Energy's, kept in the effect it gives.

type Choosing = Extract<LeafEffect, { kind: "modifier" }> & {
  readonly choose: readonly DamageType[];
};

const choosing = (effects: readonly LeafEffect[]): Choosing[] =>
  effects.filter(
    (effect): effect is Choosing =>
      effect.kind === "modifier" && effect.choose !== undefined,
  );

// The modifier dealing, resisting or lessening this type instead.
export function withType(modifier: Modifier, type: DamageType): Modifier {
  switch (modifier.kind) {
    case "resistance":
    case "vulnerability":
    case "immunity":
    case "damageReduction":
    case "grantedAction":
    case "bane":
      return { ...modifier, damage: type };
    case "retaliate":
      return {
        ...modifier,
        damage: modifier.damage.map((item) => ({ ...item, type })),
      };
    case "hitDamage":
      return { ...modifier, damage: { ...modifier.damage, type } };
    default:
      return modifier;
  }
}

function describe(modifier: Modifier, type: DamageType): string {
  const name = `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  switch (modifier.kind) {
    case "resistance":
      return `Resistance to ${name}`;
    case "immunity":
      return `Immunity to ${name}`;
    case "damageReduction":
      return `Less ${name} damage taken`;
    case "retaliate":
      return `${name} damage to attackers`;
    case "hitDamage":
      return `Extra ${name} damage`;
    case "bane":
      return `Bane of ${name}`;
    default:
      return `${name} damage`;
  }
}

// The caster's choice for one target, made once for every effect of the cast that asks for one.
export function damageTypeFrame(
  effects: readonly LeafEffect[],
  sourceId: string,
  caster: Actor,
  target: Actor,
  slotLevel?: number,
): Frame | null {
  const chosen = choosing(effects);
  const [first] = chosen;
  if (!first) return null;
  return awaitDecision({
    id: `${NS}:damageType:${target.id}`,
    actor: caster.id,
    prompt: `Which damage type for ${target.name}?`,
    options: first.choose.map((type, index) => ({
      id: type,
      label: chosen
        .map((effect) =>
          describe(effect.modifier, effect.choose[index] ?? type),
        )
        .join(", "),
    })),
    resume: frame("chooseDamageType", {
      effects: chosen,
      sourceId,
      caster: caster.id,
      target: target.id,
      ...(slotLevel === undefined ? {} : { slotLevel }),
    }),
  });
}

const GUARDS: readonly Modifier["kind"][] = [
  "resistance",
  "immunity",
  "damageReduction",
];

// A type to guard against is the one the target's foes deal most often; one to deal, the one they resist least.
export function damageTypePolicy(decision: Decision, context: Context): string {
  const { effects, target } = ChooseDamageTypeSchema.omit({
    answer: true,
  }).parse(decision.resume.payload);
  const [first] = choosing(effects);
  const bearer = context.state.actors[target];
  if (!first || !bearer) return decision.options[0]?.id ?? "";
  const foes = enemies(context.state, bearer).filter((foe) => !isDown(foe));
  const score = (type: DamageType): number =>
    GUARDS.includes(first.modifier.kind)
      ? foes
          .flatMap((foe) => deriveStats(foe, context).actions)
          .filter(({ activation: { resolution } }) =>
            resolution.damage.some((item) => item.type === type),
          ).length
      : -foes.reduce((sum, foe) => {
          const met = damageResponses(foe, context);
          return (
            sum +
            (met.immunities.includes(type) || met.absorbs.includes(type)
              ? 2
              : met.resistances.includes(type)
                ? 1
                : 0)
          );
        }, 0);
  return first.choose.reduce((best, type) =>
    score(type) > score(best) ? type : best,
  );
}

// The element of the area the cast left, as Conjure Elemental's, asked once the area stands.
export function zoneTypeFrame(
  effects: readonly LeafEffect[],
  sourceId: string,
  caster: Actor,
): Frame | null {
  const zone = effects.find(
    (effect) => effect.kind === "zone" && effect.choose !== undefined,
  );
  const choose = zone?.kind === "zone" ? zone.choose : undefined;
  if (!choose) return null;
  return awaitDecision({
    id: `${NS}:zoneType:${caster.id}`,
    actor: caster.id,
    prompt: "Which element?",
    options: choose.map((type) => ({
      id: type,
      label: `${type.charAt(0).toUpperCase()}${type.slice(1)} damage`,
    })),
    resume: frame("chooseZoneType", { caster: caster.id, sourceId, choose }),
  });
}

export function zoneTypePolicy(decision: Decision, context: Context): string {
  const { caster, choose } = ChooseZoneTypeSchema.omit({
    answer: true,
  }).parse(decision.resume.payload);
  const actor = context.state.actors[caster];
  return actor
    ? leastResisted(choose, actor, context)
    : (decision.options[0]?.id ?? "");
}

const ChooseZoneTypeSchema = z.object({
  caster: z.string(),
  sourceId: z.string(),
  choose: z.array(DamageTypeSchema),
  answer: z.string(),
});

const ChooseDamageTypeSchema = z.object({
  effects: z.array(LeafEffectSchema),
  sourceId: z.string(),
  caster: z.string(),
  target: z.string(),
  slotLevel: z.number().optional(),
  answer: z.string(),
});

export const damageChoiceFrames = {
  [`${NS}:chooseZoneType`]: frameHandler({
    schema: ChooseZoneTypeSchema,
    run: (payload, context: Context) => {
      const type = DamageTypeSchema.parse(payload.answer);
      if (!payload.choose.includes(type)) {
        throw new Error(`${payload.answer} isn't offered`);
      }
      const zone = context.state.actors[payload.caster]?.activeEffects.find(
        ({ sourceId, modifier }) =>
          sourceId === payload.sourceId &&
          modifier.kind === "zone" &&
          modifier.area !== undefined,
      )?.modifier;
      const area = zone?.kind === "zone" ? zone.area : undefined;
      // The spell may have ended before the answer, as when Concentration broke.
      if (!area) return {};
      const resolution = retyped(area.resolution, type);
      const holding = retyped(area.holding, type);
      return {
        events: [
          dndEvent(`${NS}:zoneRetyped`, {
            actor: payload.caster,
            sourceId: payload.sourceId,
            area: {
              ...area,
              ...(resolution ? { resolution } : {}),
              ...(holding ? { holding } : {}),
            },
          }),
        ],
      };
    },
  }),
  [`${NS}:chooseDamageType`]: frameHandler({
    schema: ChooseDamageTypeSchema,
    run: (payload, context: Context) => {
      const caster = context.state.actors[payload.caster];
      const target = context.state.actors[payload.target];
      const [first] = choosing(payload.effects);
      const index = first?.choose.indexOf(payload.answer as DamageType) ?? -1;
      if (!caster || !target) return {};
      if (index < 0) throw new Error(`${payload.answer} isn't offered`);
      const effects = choosing(payload.effects).map(
        ({ choose, ...effect }): LeafEffect => ({
          ...effect,
          modifier: withType(
            effect.modifier,
            choose[index] ?? (payload.answer as DamageType),
          ),
        }),
      );
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
