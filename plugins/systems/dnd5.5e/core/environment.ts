import {
  type ContentAccess,
  type SystemContext,
  type SystemEvent,
  PLAYER_ACTOR,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import {
  type Check,
  type Disease,
  DiseaseSchema,
  DungeonFeatureSchema,
  type EnvironmentalEffect,
  EnvironmentalEffectSchema,
  type Passive,
} from "./schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  type DiseaseRecord,
  type DndState,
  type FightEnvironment,
  NS,
  dndEvent,
  hasCondition,
  isDead,
} from "./state.ts";
import {
  type Stats,
  damageResponses,
  deriveStats,
  lookup,
  rollDiceNotation,
} from "./stats.ts";
import { finalDamage } from "./rules.ts";
import { leafEvents, rollSave } from "./combat/effects.ts";

// Environmental effects, diseases and dungeon features in play (#191). A scene names the effects the party spends time
// in, an encounter the ones it's fought in, and a choice's check the dungeon feature it's made against; the entries
// hold the numbers.

type Context = SystemContext<DndState>;

const effectOf = (access: ContentAccess, id: string): EnvironmentalEffect =>
  lookup(access, EnvironmentalEffectSchema, id);
const diseaseOf = (access: ContentAccess, id: string): Disease =>
  lookup(access, DiseaseSchema, id);

function partyOf(state: DndState): Actor[] {
  return Object.values(state.actors).filter(
    (actor) =>
      actor.side === "party" &&
      actor.source.kind === "character" &&
      !isDead(actor),
  );
}

// The effects around a creature now: a fight's, or between fights the scene's.
export function environmentIds(state: DndState | undefined): readonly string[] {
  return state?.combat
    ? (state.combat.environment?.ids ?? [])
    : (state?.ambient ?? []);
}

// The passives the effects around it give a creature not of an excepted type, as Arcadian Vitality's Immunity to
// Frightened (stats.ts deriveStats).
export function environmentPassives(
  creatureType: string | undefined,
  access: ContentAccess,
): readonly Passive[] {
  const { state } = access as { state?: DndState };
  return environmentIds(state).flatMap((id) => {
    const effect = effectOf(access, id);
    return effect.except?.includes(creatureType ?? "") ? [] : effect.passives;
  });
}

// What an encounter's effects make of its fight, merged, as it starts (combat/start.ts).
export function fightEnvironment(
  ids: readonly string[] | undefined,
  access: ContentAccess,
): FightEnvironment | undefined {
  if (!ids || ids.length === 0) return undefined;
  return ids.reduce<FightEnvironment>(
    (merged, id) => {
      const { fight } = effectOf(access, id);
      if (!fight) return merged;
      const { conditions: _conditions, ...rest } = fight;
      return {
        ...merged,
        ...rest,
        ...(fight.forceFloor
          ? { forceFloor: Math.max(merged.forceFloor ?? 0, fight.forceFloor) }
          : {}),
      };
    },
    { ids: [...ids] },
  );
}

// The conditions an encounter's effects put on everyone in its fight as it starts, as Howling Wind's Deafened.
export function environmentConditionEvents(
  ids: readonly string[] | undefined,
  actors: readonly Actor[],
  access: ContentAccess,
): SystemEvent[] {
  return (ids ?? []).flatMap((id) => {
    const effect = effectOf(access, id);
    return actors.flatMap((actor) =>
      effect.except?.includes(deriveStats(actor, access).creatureType ?? "")
        ? []
        : (effect.fight?.conditions ?? []).map((condition) =>
            dndEvent(`${NS}:effectAdded`, {
              actor: actor.id,
              effect: {
                sourceId: `environment:${id}`,
                casterId: actor.id,
                modifier: { kind: "condition", condition },
                ends: "spellDuration",
              },
            }),
          ),
    );
  });
}

// Slippery Ice: a save as each turn starts, or the condition, as Prone. A creature that has it already makes none.
export function turnSaveEvents(actor: Actor, context: Context): SystemEvent[] {
  const save = context.state.combat?.environment?.turnSave;
  if (!save || isDead(actor) || hasCondition(actor, save.condition)) return [];
  const rolled = rollSave(actor, save.ability, save.dc, context);
  return rolled.saved
    ? rolled.events
    : [
        ...rolled.events,
        dndEvent(`${NS}:effectAdded`, {
          actor: actor.id,
          effect: {
            sourceId: "environment:turn-save",
            casterId: actor.id,
            modifier: { kind: "condition", condition: save.condition },
            ends: "spellDuration",
          },
        }),
      ];
}

// Every square of the map is Difficult Terrain, as on Slippery Ice (sight.ts difficultSquares).
export function everySquare(state: DndState): readonly string[] {
  const grid = state.combat?.grid;
  if (!grid || !state.combat?.environment?.difficult) return [];
  return Array.from({ length: grid.width * grid.height }, (_, index) =>
    [index % grid.width, Math.floor(index / grid.width)].join(","),
  );
}

// The saves of time spent exposed to an effect: each hour or minute, a failure giving a level of Exhaustion.
function exposureEvents(
  effect: EnvironmentalEffect,
  periods: number,
  context: Context,
): SystemEvent[] {
  const { exposure } = effect;
  if (!exposure || periods <= 0) return [];
  return partyOf(context.state).flatMap((actor) => {
    const stats = deriveStats(actor, context);
    if (exposure.swimSpeed && swims(actor, context)) return [];
    const responses = damageResponses(actor, context);
    if (
      exposure.resist &&
      (responses.resistances.includes(exposure.resist) ||
        responses.immunities.includes(exposure.resist))
    ) {
      return [];
    }
    const grace = exposure.graceCon ? stats.abilities.con : 0;
    const armored = heavyArmored(actor, context);
    const events: SystemEvent[] = [];
    let exhaustion = actor.exhaustion;
    for (let period = grace; period < periods; period += 1) {
      if (exhaustion >= (exposure.maxExhaustion ?? 6)) break;
      const dc = exposure.dc + (exposure.dcStep ?? 0) * period;
      const rolled = rollSave(
        actor,
        exposure.ability,
        dc,
        context,
        false,
        0,
        [],
        armored && exposure.armor === "disadvantage",
        armored && exposure.armor === "advantage",
      );
      events.push(...rolled.events);
      if (!rolled.saved) {
        exhaustion += 1;
        events.push(
          dndEvent(`${NS}:exhaustionChanged`, { actor: actor.id, levels: 1 }),
        );
      }
    }
    return events;
  });
}

// A Swim Speed, which Deep Water's saves skip.
// shortcut: only a stat block's is read, as a character's species Swim Speed isn't kept.
function swims(actor: Actor, access: ContentAccess): boolean {
  if (actor.source.kind !== "monster") return false;
  const entry = access.content(actor.source.statBlockId) as
    | { speeds?: { swim?: number } }
    | undefined;
  return (entry?.speeds?.swim ?? 0) > 0;
}

// Medium or Heavy armor worn, which some exposures' saves weigh.
function heavyArmored(actor: Actor, access: ContentAccess): boolean {
  const stowed = new Set(actor.stowed ?? []);
  return actor.inventory.some((id) => {
    if (stowed.has(id)) return false;
    const entry = access.content(id) as { armorType?: string } | undefined;
    return entry?.armorType === "medium" || entry?.armorType === "heavy";
  });
}

// An effect's tables, as a psychic wind's: a party roll whose row passes time, then each traveler's save, whose
// failure rolls the table for that traveler's damage and conditions.
function tableEvents(effect: EnvironmentalEffect, context: Context): SystemEvent[] {
  return (effect.tables ?? []).flatMap((table) => {
    const pick = (): (typeof table.rows)[number] | undefined => {
      const roll = context.dice.roll(table.die);
      return table.rows.find((row) => roll >= row.min && roll <= row.max);
    };
    if (!table.save) {
      const row = pick();
      if (!row?.hours) return [];
      const hours =
        (typeof row.hours === "number"
          ? row.hours
          : rollDiceNotation(row.hours, context.dice)) * (row.hoursTimes ?? 1);
      return [dndEvent(`${NS}:timePassed`, { hours })];
    }
    const { save } = table;
    return partyOf(context.state).flatMap((actor) => {
      const rolled = rollSave(actor, save.ability, save.dc, context);
      if (rolled.saved) return rolled.events;
      const row = pick();
      const responses = damageResponses(actor, context);
      const damage = (row?.damage ?? []).reduce((sum, { amount, type }) => {
        const dealt = amount.dice
          ? rollDiceNotation(amount.dice, context.dice)
          : 0;
        return sum + finalDamage(dealt, type, responses);
      }, 0);
      return [
        ...rolled.events,
        // shortcut: damage between fights leaves at least 1 Hit Point, as a scene's does (scene.ts).
        ...(damage > 0
          ? [
              dndEvent(`${NS}:damaged`, {
                actor: actor.id,
                amount: Math.min(damage, actor.hp + actor.tempHp - 1),
                type: row?.damage?.[0]?.type ?? "psychic",
                critical: false,
                massive: false,
              }),
            ]
          : []),
        ...(row?.conditions ?? []).map((condition) =>
          dndEvent(`${NS}:effectAdded`, {
            actor: actor.id,
            effect: {
              sourceId: `environment:${effect.id}`,
              casterId: actor.id,
              modifier: { kind: "condition", condition },
              ends: "spellDuration",
              endsOnDamage: true,
              shake: true,
              ...(row?.lingers
                ? { lingers: rollDiceNotation(row.lingers, context.dice) }
                : {}),
            },
          }),
        ),
      ];
    });
  });
}

// A scene's environment: the party is in these effects from now on (none leaves them), and spends this long in them.
const EnvironmentArgs = z.strictObject({
  effects: z.array(z.string()),
  hours: z.number().int().min(0).default(0),
  minutes: z.number().int().min(0).default(0),
});

export function environmentEvents(
  args: z.infer<typeof EnvironmentArgs>,
  context: Context,
): SystemEvent[] {
  const events: SystemEvent[] = [
    dndEvent(`${NS}:environmentEntered`, { effects: args.effects }),
  ];
  for (const id of args.effects) {
    const effect = effectOf(context, id);
    const periods =
      effect.exposure?.every === "minute" ? args.minutes : args.hours;
    events.push(...exposureEvents(effect, periods, context));
    events.push(...tableEvents(effect, context));
  }
  return events;
}

// Whether a creature can catch this disease: its type, and no species that's immune.
function canCatch(actor: Actor, disease: Disease, stats: Stats): boolean {
  const species =
    actor.source.kind === "character"
      ? actor.source.build?.speciesId.split("/").pop()
      : undefined;
  return (
    (!disease.creatureTypes ||
      disease.creatureTypes.includes(stats.creatureType ?? "")) &&
    !disease.immuneSpecies?.includes(species ?? "") &&
    !actor.diseases?.some((item) => item.disease === disease.id)
  );
}

// Exposure to a disease: each member it reaches saves or catches it, its symptoms coming at once with no onset.
const ContagionArgs = z.strictObject({
  disease: z.string(),
  who: z.enum(["player", "party"]).default("party"),
});

export function contagionEvents(
  args: z.infer<typeof ContagionArgs>,
  context: Context,
): SystemEvent[] {
  const disease = diseaseOf(context, args.disease);
  const members = partyOf(context.state).filter(
    (actor) => args.who === "party" || actor.id === PLAYER_ACTOR,
  );
  return members.flatMap((actor) => {
    if (!canCatch(actor, disease, deriveStats(actor, context))) return [];
    const rolled = disease.catch
      ? rollSave(actor, disease.catch.ability, disease.catch.dc, context)
      : { saved: false, events: [] };
    if (rolled.saved) return rolled.events;
    const record: DiseaseRecord = {
      disease: disease.id,
      onset: disease.onsetRests,
      saved: 0,
      failed: 0,
      streak: 0,
    };
    return [
      ...rolled.events,
      dndEvent(`${NS}:diseaseCaught`, { actor: actor.id, record }),
      ...(record.onset === 0 ? symptomEvents(actor, disease, record) : []),
    ];
  });
}

const diseaseEffect = (
  actor: Actor,
  disease: Disease,
  modifier: ActiveEffect["modifier"],
): SystemEvent =>
  dndEvent(`${NS}:effectAdded`, {
    actor: actor.id,
    effect: {
      sourceId: `disease:${disease.id}`,
      casterId: actor.id,
      modifier,
      ends: "spellDuration",
      lingers: "cured",
    },
  });

// A disease's symptoms as they set in: Exhaustion, blindness, a sight penalty, and fits of laughter.
function symptomEvents(
  actor: Actor,
  disease: Disease,
  record: DiseaseRecord,
): SystemEvent[] {
  const { symptoms } = disease;
  return [
    ...(symptoms.exhaustion > 0
      ? [
          dndEvent(`${NS}:exhaustionChanged`, {
            actor: actor.id,
            levels: symptoms.exhaustion,
          }),
        ]
      : []),
    ...(symptoms.blinded
      ? [diseaseEffect(actor, disease, { kind: "condition", condition: "blinded" })]
      : []),
    ...(symptoms.sightPenalty ? penaltyEvents(actor, disease, record.penalty ?? 1) : []),
    ...(symptoms.laughter
      ? [diseaseEffect(actor, disease, { kind: "laughter", ...symptoms.laughter })]
      : []),
  ];
}

// 2014 Sight Rot: the penalty on attack rolls and checks, as it stands now, Blinded once it reaches 5.
function penaltyEvents(
  actor: Actor,
  disease: Disease,
  penalty: number,
): SystemEvent[] {
  const amount = { bonus: { base: penalty, add: [] } };
  return [
    dndEvent(`${NS}:effectEnded`, {
      actor: actor.id,
      sourceId: `disease:${disease.id}`,
    }),
    ...(penalty >= 5
      ? [diseaseEffect(actor, disease, { kind: "condition", condition: "blinded" })]
      : [
          diseaseEffect(actor, disease, {
            kind: "bonus",
            to: "attacks",
            amount,
            subtract: true,
          }),
          diseaseEffect(actor, disease, {
            kind: "bonus",
            to: "checks",
            amount,
            subtract: true,
          }),
        ]),
  ];
}

// After a Long Rest: symptoms set in once the onset has passed, and those who have them fight the disease with a save.
// shortcut: the days a disease takes pass as Long Rests, so its 1d4 days are the next Long Rest, and its dawn saves
// come after each Long Rest. It doesn't spread from one party member to another, and a 2014 Cackle Fever's three failed
// saves bring no madness.
export function diseaseRestEvents(actor: Actor, context: Context): SystemEvent[] {
  return (actor.diseases ?? []).flatMap((record) => {
    const disease = diseaseOf(context, record.disease);
    if (record.onset > 0) {
      const next = { ...record, onset: record.onset - 1 };
      return [
        dndEvent(`${NS}:diseaseChanged`, { actor: actor.id, record: next }),
        ...(next.onset === 0 ? symptomEvents(actor, disease, next) : []),
      ];
    }
    const { fight, symptoms } = disease;
    const events: SystemEvent[] = [];
    let next = record;
    if (symptoms.sightPenalty) {
      next = { ...next, penalty: (next.penalty ?? 1) + 1 };
      events.push(...penaltyEvents(actor, disease, next.penalty ?? 1));
    }
    if (!fight) {
      return [
        ...events,
        dndEvent(`${NS}:diseaseChanged`, { actor: actor.id, record: next }),
      ];
    }
    const rolled = rollSave(actor, fight.ability, next.dc ?? fight.dc, context);
    events.push(...rolled.events);
    let exhaustion = actor.exhaustion;
    if (rolled.saved) {
      next = {
        ...next,
        saved: next.saved + 1,
        streak: next.streak + 1,
        ...(fight.dcDrop
          ? {
              dc:
                (next.dc ?? fight.dc) -
                rollDiceNotation(fight.dcDrop, context.dice),
            }
          : {}),
      };
      if (fight.successLessens && exhaustion > 0) {
        exhaustion -= 1;
        events.push(
          dndEvent(`${NS}:exhaustionChanged`, { actor: actor.id, levels: -1 }),
        );
      }
    } else {
      next = { ...next, failed: next.failed + 1, streak: 0 };
      if (fight.failExhaustion) {
        exhaustion += 1;
        events.push(
          dndEvent(`${NS}:exhaustionChanged`, { actor: actor.id, levels: 1 }),
        );
      }
    }
    const cured =
      (fight.cureAt !== undefined &&
        (fight.streak ? next.streak : next.saved) >= fight.cureAt) ||
      (fight.cureAtZero === true && exhaustion <= 0) ||
      (next.dc !== undefined && next.dc <= 0);
    return [
      ...events,
      cured
        ? dndEvent(`${NS}:diseaseCured`, {
            actor: actor.id,
            disease: disease.id,
          })
        : dndEvent(`${NS}:diseaseChanged`, { actor: actor.id, record: next }),
    ];
  });
}

// What a disease's symptoms and the effects around the party do to its Long Rest: no Hit Points back, and Exhaustion
// kept (runFinishRest).
export function restHampered(
  actor: Actor,
  access: ContentAccess & { readonly state: DndState },
): { readonly keepHp: boolean; readonly exhaustionFloor: number } {
  const showing = (actor.diseases ?? [])
    .filter((record) => record.onset === 0)
    .map((record) => diseaseOf(access, record.disease).symptoms);
  const exhausted = actor.exhaustion > 0;
  const held = showing.reduce(
    (sum, symptoms) => sum + (symptoms.holdsExhaustion ? symptoms.exhaustion : 0),
    0,
  );
  const kept =
    (exhausted && showing.some((symptoms) => symptoms.keepExhaustion)) ||
    (access.state.ambient ?? []).some(
      (id) => effectOf(access, id).rest?.keepExhaustion,
    );
  return {
    keepHp: exhausted && showing.some((symptoms) => symptoms.noRestHealing),
    exhaustionFloor: kept ? actor.exhaustion : held,
  };
}

// Sewer Plague's weakness: half the Hit Points from a Hit Point Die while Exhausted.
export function halvesHitDice(actor: Actor, access: ContentAccess): boolean {
  return (
    actor.exhaustion > 0 &&
    (actor.diseases ?? []).some(
      (record) =>
        record.onset === 0 &&
        diseaseOf(access, record.disease).symptoms.halfHitDice,
    )
  );
}

// What a Long Rest in the effects around the party gives: a Lesser Restoration, as Blessed Beneficence's, or a
// condition for the next fight, as a psionic field's fright.
// shortcut: the fright lasts into the next fight rather than 1d10 minutes, and Lesser Restoration ends every
// condition it could.
export function ambientRestEvents(actor: Actor, context: Context): SystemEvent[] {
  return (context.state.ambient ?? []).flatMap((id) => {
    const effect = effectOf(context, id);
    if (effect.except?.includes(deriveStats(actor, context).creatureType ?? "")) {
      return [];
    }
    const { rest } = effect;
    if (!rest) return [];
    return [
      ...(rest.restore
        ? (["blinded", "deafened", "paralyzed", "poisoned"] as const)
            .filter((condition) => hasCondition(actor, condition))
            .map((condition) =>
              dndEvent(`${NS}:conditionRemoved`, { actor: actor.id, condition }),
            )
        : []),
      ...(rest.condition
        ? [
            dndEvent(`${NS}:effectAdded`, {
              actor: actor.id,
              effect: {
                sourceId: `environment:${id}`,
                casterId: actor.id,
                modifier: { kind: "condition", condition: rest.condition },
                ends: "spellDuration",
              },
            }),
          ]
        : []),
    ];
  });
}

// Lesser Restoration or Heal ends a disease that magic cures.
export function curedDiseaseEvents(actor: Actor, access: ContentAccess): SystemEvent[] {
  return (actor.diseases ?? []).flatMap((record) =>
    diseaseOf(access, record.disease).cureSpells
      ? [
          dndEvent(`${NS}:diseaseCured`, {
            actor: actor.id,
            disease: record.disease,
          }),
        ]
      : [],
  );
}

// A check against a dungeon feature takes its skill and ability, at the DC the scene prints.
export function featureCheck(check: Check, access: ContentAccess): Check {
  if (!("feature" in check)) return check;
  const feature = lookup(access, DungeonFeatureSchema, check.feature);
  if (!feature.check) throw new Error(`${check.feature} has no check`);
  return feature.check.skill
    ? { skill: feature.check.skill, ability: feature.check.ability, dc: check.dc }
    : { ability: feature.check.ability, dc: check.dc };
}

export const environmentEffects = {
  [`${NS}:environment`]: storyEffect({
    schema: EnvironmentArgs,
    apply: (args, context: Context) => ({
      events: environmentEvents(args, context),
    }),
  }),
  [`${NS}:contagion`]: storyEffect({
    schema: ContagionArgs,
    apply: (args, context: Context) => ({
      events: contagionEvents(args, context),
    }),
  }),
};

// Unstable Gravity: Reverse Gravity's lift as each creature's turn starts on even rounds, with a save to grab hold.
// shortcut: gravity turns every other round, where the book has it suppressed for 1d4 rounds every 1d4 rounds.
export function reverseGravityEvents(
  actor: Actor,
  context: Context,
): SystemEvent[] {
  const combat = context.state.combat;
  const reverse = combat?.environment?.reverseGravity;
  if (!combat || !reverse || combat.round % 2 !== 0 || isDead(actor)) return [];
  const lifted = actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "aloft",
  );
  return lifted
    ? []
    : leafEvents(
        [
          {
            kind: "lift",
            feet: 60,
            duration: { until: "itsNextTurnStart" },
            grab: { ability: "dex", dc: { base: reverse.dc, add: [] } },
          },
        ],
        "environment:unstable-gravity",
        actor,
        actor,
        context,
      );
}

// A Strong Wind: a flyer comes down to land at the end of its turn.
export function groundedEvents(actor: Actor, state: DndState): SystemEvent[] {
  if (!state.combat?.environment?.grounded) return [];
  return actor.activeEffects.flatMap(({ modifier, sourceId, casterId }) =>
    modifier.kind === "aloft" && modifier.mode === "fly"
      ? [dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId, casterId })]
      : [],
  );
}
