import {
  type ContentAccess,
  PLAYER_ACTOR,
  type SystemContext,
  contentKind,
  defineSystem,
  encounterKind,
  frameHandler,
  storyEffect,
  storyPredicate,
} from "#sdk";
import { z } from "zod";
import {
  AttackSchema,
  CREATE_CHARACTER,
  AfterHitSchema,
  ConcentrationSchema,
  type Context,
  FinishMoveSchema,
  HitSchema,
  LingeringSchema,
  MoveSchema,
  ReactionSchema,
  SmiteSchema,
  TakeActionSchema,
  choosePolicy,
  nextDndDecision,
  runAfterAction,
  runAfterHit,
  runAfterReaction,
  runAdvanceTurn,
  runAfterTurnStart,
  runApplyHit,
  runAttackRoll,
  runCheckCombatEnd,
  runConcentrationSave,
  runEndTurn,
  runFinishMove,
  runFinishTurn,
  runLingeringTick,
  runMove,
  runProjectile,
  runRecheckHit,
  runSmite,
  runTakeAction,
  startCombat,
} from "./combat.ts";
import {
  parseClassesFromHtml,
  parseFeaturesFromHtml,
  parseSubclassesFromHtml,
} from "./import/classes.ts";
import { parseCompanionsFromHtml } from "./import/companions.ts";
import { parseEquipmentFromHtml } from "./import/equipment.ts";
import { parseMonstersFromHtml } from "./import/monsters.ts";
import {
  parseBackgroundsFromHtml,
  parseFeatsFromHtml,
  parseSpeciesFromHtml,
} from "./import/origins.ts";
import { spellImportKind } from "./import/spells.ts";
import {
  parseBudgetsFromHtml,
  parseHazardsFromHtml,
  parsePoisonsFromHtml,
  parseTablesFromHtml,
  parseTrapsFromHtml,
  parseBastionsFromHtml,
  parseLookupsFromHtml,
} from "./import/tables.ts";
import {
  beginCreation,
  buildCompanion,
  characterEffects,
  characterFrames,
} from "./character.ts";
import { gearEffects, gearFrames } from "./gear.ts";
import { legendaryFrames, surpriseEffects } from "./legendary.ts";
import { availableRests, restEffects, restFrames } from "./rest.ts";
import { InspirationSchema, runInspiration } from "./class-rules.ts";
import { rollD20 } from "./rules.ts";
import {
  BackgroundSchema,
  CheckSchema,
  type CharacterBuild,
  ClassSchema,
  CompanionSchema,
  EncounterBudgetSchema,
  EncounterSchema,
  FeatSchema,
  FeatureSchema,
  HazardSchema,
  ItemSchema,
  MonsterSchema,
  LookupTableSchema,
  BastionEntrySchema,
  PoisonSchema,
  PregenSchema,
  RollTableSchema,
  SKILL_ABILITIES,
  SpeciesSchema,
  SpellSchema,
  SubclassSchema,
  TrapSchema,
} from "./schemas.ts";
import {
  type Actor,
  DIFFICULTIES,
  type DndState,
  EVENT_SCHEMAS,
  NS,
  StateSchema,
  applyDndEvent,
  dndEvent,
  freshActor,
} from "./state.ts";
import { checkBonus, deriveStats, lookup } from "./stats.ts";

function buildReferences(pregen: z.infer<typeof PregenSchema>): string[] {
  return [
    pregen.build.speciesId,
    pregen.build.backgroundId,
    ...pregen.equipment,
    ...pregen.build.levels.flatMap((level) => [
      level.classId,
      ...level.answers.flatMap((answer) =>
        answer.kind === "skills" || answer.kind === "abilities"
          ? []
          : answer.values,
      ),
    ]),
  ];
}

function levelReferences(level: z.infer<typeof ClassSchema>["levels"][number]) {
  return [
    ...level.grants,
    ...level.choices.flatMap((choice) =>
      choice.kind === "option" ? choice.from : [],
    ),
  ];
}

// A pregen names a class from its own book. When a fuller book with a class of the same name is loaded
// too, that class takes its place, as it does in character creation, so the character can level past
// where the first book stops (the SRD's classes end at level 5).
function pregenBuild(pregenId: string, access: ContentAccess): CharacterBuild {
  const { build } = lookup(access, PregenSchema, pregenId);
  const classIds = access.contentIds().filter((id) => id.includes(":class/"));
  const fullest = (classId: string): string => {
    const { name } = lookup(access, ClassSchema, classId);
    // Content ids are sorted, and character creation also takes the first class of each name.
    return (
      classIds.find((id) => lookup(access, ClassSchema, id).name === name) ??
      classId
    );
  };
  return {
    ...build,
    levels: build.levels.map((level) => ({
      ...level,
      classId: fullest(level.classId),
    })),
  };
}

function characterActor(
  id: string,
  name: string,
  pregenId: string,
  access: ContentAccess,
): Actor {
  const pregen = lookup(access, PregenSchema, pregenId);
  const actor = freshActor({
    id,
    name,
    side: "party",
    source: { kind: "character", build: pregenBuild(pregenId, access) },
    hp: 1,
    inventory: pregen.equipment,
  });
  return { ...actor, hp: deriveStats(actor, access).maxHp };
}

const CharacterChosenPayload = z.object({ answer: z.string() });
const ActorPayload = z.object({ actor: z.string() });
const EmptyPayload = z.object({});

export const dnd55e = defineSystem<DndState>({
  id: NS,
  version: "1.0.0",
  sdk: "^1",
  contentKinds: {
    classes: contentKind({
      idPrefix: "class",
      schema: ClassSchema,
      references: (item) => [
        ...(item.spellList ?? []),
        ...item.levels.flatMap(levelReferences),
      ],
    }),
    subclasses: contentKind({
      idPrefix: "subclass",
      schema: SubclassSchema,
      references: (item) => [
        item.class,
        ...item.levels.flatMap(levelReferences),
      ],
    }),
    species: contentKind({
      idPrefix: "species",
      schema: SpeciesSchema,
      references: (item) => item.traits,
    }),
    backgrounds: contentKind({
      idPrefix: "background",
      schema: BackgroundSchema,
      references: (item) => [item.feat],
    }),
    feats: contentKind({
      idPrefix: "feat",
      schema: FeatSchema,
      references: (item) => item.grants,
    }),
    features: contentKind({
      idPrefix: "feature",
      schema: FeatureSchema,
    }),
    spells: contentKind({
      idPrefix: "spell",
      schema: SpellSchema,
      references: (item) => item.classes,
    }),
    equipment: contentKind({
      idPrefix: "item",
      schema: ItemSchema,
      references: (item) =>
        item.type === "magicItem" && item.spell ? [item.spell] : [],
    }),
    monsters: contentKind({
      idPrefix: "monster",
      schema: MonsterSchema,
      references: (item) => item.features,
    }),
    companions: contentKind({ idPrefix: "companion", schema: CompanionSchema }),
    tables: contentKind({ idPrefix: "table", schema: RollTableSchema }),
    lookups: contentKind({ idPrefix: "lookup", schema: LookupTableSchema }),
    bastions: contentKind({ idPrefix: "bastion", schema: BastionEntrySchema }),
    traps: contentKind({ idPrefix: "trap", schema: TrapSchema }),
    hazards: contentKind({ idPrefix: "hazard", schema: HazardSchema }),
    poisons: contentKind({ idPrefix: "poison", schema: PoisonSchema }),
    budgets: contentKind({ idPrefix: "budget", schema: EncounterBudgetSchema }),
    pregens: contentKind({
      idPrefix: "pregen",
      schema: PregenSchema,
      references: buildReferences,
    }),
  },
  checkSchema: CheckSchema,
  encounters: encounterKind({
    schema: EncounterSchema,
    references: (encounter) => [
      ...encounter.monsters.map((entry) => entry.monster),
      ...(encounter.loot?.items ?? []),
    ],
  }),
  outcomes: { keys: ["success", "failure"] },
  importKinds: { spells: spellImportKind },
  htmlParsers: {
    monsters: parseMonstersFromHtml,
    classes: parseClassesFromHtml,
    subclasses: parseSubclassesFromHtml,
    features: parseFeaturesFromHtml,
    species: parseSpeciesFromHtml,
    backgrounds: parseBackgroundsFromHtml,
    feats: parseFeatsFromHtml,
    equipment: parseEquipmentFromHtml,
    companions: parseCompanionsFromHtml,
    tables: parseTablesFromHtml,
    lookups: parseLookupsFromHtml,
    bastions: parseBastionsFromHtml,
    traps: parseTrapsFromHtml,
    hazards: parseHazardsFromHtml,
    poisons: parsePoisonsFromHtml,
    budgets: parseBudgetsFromHtml,
  },
  stateSchema: StateSchema,
  eventSchemas: EVENT_SCHEMAS,
  storyEffects: {
    [`${NS}:grantInspiration`]: storyEffect({
      schema: z.strictObject({}),
      apply: (_args, _context: Context) => ({
        events: [dndEvent(`${NS}:inspirationGranted`, { actor: PLAYER_ACTOR })],
      }),
    }),
    ...characterEffects,
    ...restEffects,
    ...gearEffects,
    ...surpriseEffects,
  },
  storyPredicates: {
    [`${NS}:hasInspiration`]: storyPredicate({
      schema: z.strictObject({}),
      evaluate: (_args, state: DndState) =>
        state.actors[PLAYER_ACTOR]?.heroicInspiration ?? false,
    }),
  },
  frames: {
    [`${NS}:characterChosen`]: frameHandler({
      schema: CharacterChosenPayload,
      run: ({ answer }, context: SystemContext<DndState>) => {
        if (answer === CREATE_CHARACTER) return beginCreation();
        const pregen = lookup(context, PregenSchema, answer);
        const actor = characterActor(
          PLAYER_ACTOR,
          pregen.name,
          answer,
          context,
        );
        return {
          events: [
            dndEvent(`${NS}:characterChosen`, {
              actor: PLAYER_ACTOR,
              name: pregen.name,
              build: pregenBuild(answer, context),
              inventory: pregen.equipment,
              hp: actor.hp,
            }),
          ],
        };
      },
    }),
    ...characterFrames,
    ...restFrames,
    ...gearFrames,
    ...legendaryFrames,
    [`${NS}:advanceTurn`]: frameHandler({
      schema: EmptyPayload,
      run: (_payload, context: Context) => runAdvanceTurn(context),
    }),
    [`${NS}:takeAction`]: frameHandler({
      schema: TakeActionSchema,
      run: runTakeAction,
    }),
    [`${NS}:move`]: frameHandler({ schema: MoveSchema, run: runMove }),
    [`${NS}:finishMove`]: frameHandler({
      schema: FinishMoveSchema,
      run: runFinishMove,
    }),
    [`${NS}:attackRoll`]: frameHandler({
      schema: AttackSchema,
      run: runAttackRoll,
    }),
    [`${NS}:projectile`]: frameHandler({
      schema: AttackSchema,
      run: runProjectile,
    }),
    [`${NS}:afterHit`]: frameHandler({
      schema: AfterHitSchema,
      run: runAfterHit,
    }),
    [`${NS}:smite`]: frameHandler({ schema: SmiteSchema, run: runSmite }),
    [`${NS}:inspiration`]: frameHandler({
      schema: InspirationSchema,
      run: runInspiration,
    }),
    [`${NS}:lingeringTick`]: frameHandler({
      schema: LingeringSchema,
      run: runLingeringTick,
    }),
    [`${NS}:finishTurn`]: frameHandler({
      schema: EmptyPayload,
      run: (_payload, context: Context) => runFinishTurn(context),
    }),
    [`${NS}:afterTurnStart`]: frameHandler({
      schema: EmptyPayload,
      run: (_payload, context: Context) => runAfterTurnStart(context),
    }),
    [`${NS}:afterReaction`]: frameHandler({
      schema: ReactionSchema,
      run: runAfterReaction,
    }),
    [`${NS}:recheckHit`]: frameHandler({
      schema: HitSchema,
      run: runRecheckHit,
    }),
    [`${NS}:applyHit`]: frameHandler({ schema: HitSchema, run: runApplyHit }),
    [`${NS}:concentrationSave`]: frameHandler({
      schema: ConcentrationSchema,
      run: runConcentrationSave,
    }),
    [`${NS}:checkCombatEnd`]: frameHandler({
      schema: EmptyPayload,
      run: (_payload, context: Context) => runCheckCombatEnd(context),
    }),
    [`${NS}:afterAction`]: frameHandler({
      schema: ActorPayload,
      run: runAfterAction,
    }),
    [`${NS}:endTurn`]: frameHandler({
      schema: EmptyPayload,
      run: (_payload, context: Context) => runEndTurn(context),
    }),
  },
  settings: [
    {
      id: "difficulty",
      label: "Difficulty",
      default: "normal",
      options: [
        {
          id: "story",
          label: "Story",
          detail:
            "Your party takes a third of the damage. For enjoying the story.",
        },
        {
          id: "normal",
          label: "Normal",
          detail: "The book as written.",
        },
        {
          id: "hard",
          label: "Hard",
          detail: "Your party takes half as much damage again.",
        },
      ],
    },
  ],
  createRun: ({ settings, actors, dice, content, contentIds }) => {
    const access = { content, contentIds };
    const state: Record<string, Actor> = {};
    const takenClasses = new Set<string>();
    for (const { id, name, role } of actors) {
      if (role === "player") {
        state[id] = freshActor({
          id,
          name,
          side: "party",
          source: { kind: "character", build: null },
          hp: 1,
          inventory: [],
        });
      } else {
        const companion = buildCompanion(id, name, takenClasses, access, dice);
        state[id] = companion;
        if (companion.source.kind === "character") {
          const classId = companion.source.build?.levels[0]?.classId;
          if (classId !== undefined) takenClasses.add(classId);
        }
      }
    }
    const difficulty = DIFFICULTIES.find(
      (item) => item === settings.difficulty,
    );
    return {
      ...(difficulty ? { difficulty } : {}),
      actors: state,
      combat: null,
    };
  },
  // Scene checks are made by the player's character.
  resolveCheck: (check, context) => {
    const parsed = CheckSchema.parse(check);
    const player = context.state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("The player has no character");
    const stats = deriveStats(player, context);
    const ability =
      "skill" in parsed ? SKILL_ABILITIES[parsed.skill] : parsed.ability;
    const roll = rollD20(context.dice, {
      advantage: false,
      disadvantage: false,
    });
    const total =
      roll.natural +
      checkBonus(stats, player, {
        ability,
        ...("skill" in parsed ? { skill: parsed.skill } : {}),
      });
    const success = total >= parsed.dc;
    return {
      outcome: success ? "success" : "failure",
      events: [
        dndEvent(`${NS}:rollReported`, {
          actor: PLAYER_ACTOR,
          against: "check",
          natural: roll.natural,
          total,
          target: parsed.dc,
          success,
          label: "skill" in parsed ? parsed.skill : parsed.ability,
        }),
        ...(success ? [] : ([{ kind: "gmOpportunity" }] as const)),
      ],
    };
  },
  startEncounter: (encounter, context, options) =>
    startCombat(EncounterSchema.parse(encounter), context, options),
  applyEvent: applyDndEvent,
  nextDecision: nextDndDecision,
  rests: availableRests,
  decidePolicy: choosePolicy,
  tactical: (decision) =>
    /^dnd5\.5e:(turn|moveTo|reaction|afterHit|inspiration|deathSave):/.test(
      decision.id,
    ),
});
