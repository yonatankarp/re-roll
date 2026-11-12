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
  PickSchema,
  AimSchema,
  ReactionSchema,
  SmiteSchema,
  TakeActionSchema,
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
  runPickTargets,
  runAimArea,
  runProjectile,
  runRecheckHit,
  runSmite,
  runTakeAction,
  startCombat,
} from "./combat.ts";
import {
  AfterMoveSchema,
  MasteryHitSchema,
  isTactic,
  keepsActing,
  runAfterMove,
  runMasteryHit,
  runMasteryMiss,
  runTactic,
  tacticalPolicy,
  withTactics,
} from "./actions.ts";
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
import { libraryKindOf } from "./import/library.ts";
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
  buildPolicy,
  characterEffects,
  characterFrames,
} from "./character.ts";
import { gearEffects, gearFrames } from "./gear.ts";
import { legendaryFrames, surpriseEffects } from "./legendary.ts";
import { shopEffects, shopFrames } from "./shop.ts";
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
  type ChoiceDef,
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
  return [...level.grants, ...optionReferences(level.choices)];
}

function optionReferences(choices: readonly ChoiceDef[]): readonly string[] {
  return choices.flatMap((choice) =>
    choice.kind === "option" ? choice.from : [],
  );
}

// A pregen names a class from its own book. When a book with a class of the same name wins precedence,
// that class takes its place, as it does in character creation, so the character can level past
// where the SRD stops (its classes end at level 5).
function pregenBuild(pregenId: string, access: ContentAccess): CharacterBuild {
  const { build } = lookup(access, PregenSchema, pregenId);
  const classIds = access.contentIds().filter((id) => id.includes(":class/"));
  const fullest = (classId: string): string => {
    const { name } = lookup(access, ClassSchema, classId);
    // Content ids come in precedence order, and character creation also takes the first class of each name.
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

// Whose entry wins when books print the same name, highest first. Books not listed rank between these and the SRD.
const LEADING_BOOKS = ["phb", "monster-manual", "dmg"];
// shortcut: these 2014-edition books' manifests don't set edition. Set `edition: "2014"` there and drop the list.
const OLDER_BOOKS = new Set([
  "basic-rules-2014",
  "spelljammer-creatures",
  "sword-coast-guide",
  "xanathars-guide",
]);

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
      references: (item) => [...item.traits, ...optionReferences(item.choices)],
    }),
    backgrounds: contentKind({
      idPrefix: "background",
      schema: BackgroundSchema,
      references: (item) => [item.feat],
    }),
    feats: contentKind({
      idPrefix: "feat",
      schema: FeatSchema,
      references: (item) => [...item.grants, ...optionReferences(item.choices)],
    }),
    features: contentKind({
      idPrefix: "feature",
      schema: FeatureSchema,
      references: (item) => Object.values(item.spells ?? {}).flat(),
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
  // An unset edition means 2024, apart from the older books listed above.
  precedence: ({ id, edition = OLDER_BOOKS.has(id) ? "2014" : "2024" }) => {
    if (edition === "2014") return LEADING_BOOKS.length + 2;
    if (id === "srd52") return LEADING_BOOKS.length + 1;
    const index = LEADING_BOOKS.indexOf(id);
    return index === -1 ? LEADING_BOOKS.length : index;
  },
  libraryKind: libraryKindOf,
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
    ...shopEffects,
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
    ...shopFrames,
    [`${NS}:takeAction`]: frameHandler({
      schema: TakeActionSchema,
      run: (payload, context: Context) =>
        isTactic(payload.answer)
          ? runTactic(payload, context)
          : runTakeAction(payload, context),
    }),
    [`${NS}:afterMove`]: frameHandler({
      schema: AfterMoveSchema,
      run: runAfterMove,
    }),
    [`${NS}:masteryHit`]: frameHandler({
      schema: MasteryHitSchema,
      run: runMasteryHit,
    }),
    [`${NS}:masteryMiss`]: frameHandler({
      schema: HitSchema,
      run: runMasteryMiss,
    }),
    [`${NS}:move`]: frameHandler({ schema: MoveSchema, run: runMove }),
    [`${NS}:pickTargets`]: frameHandler({
      schema: PickSchema,
      run: runPickTargets,
    }),
    [`${NS}:aimArea`]: frameHandler({ schema: AimSchema, run: runAimArea }),
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
      run: (payload, context: Context) =>
        keepsActing(payload.actor, context)
          ? {}
          : runAfterAction(payload, context),
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
            "Your party takes a third of the damage, and you can undo your last choice. For enjoying the story.",
          undo: true,
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
      disadvantage:
        stats.untrainedArmor && (ability === "str" || ability === "dex"),
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
  nextDecision: (state, access) =>
    withTactics(nextDndDecision(state, access), state, access),
  rests: availableRests,
  decidePolicy: (decision, context) =>
    decision.id.startsWith(`${NS}:build:`)
      ? buildPolicy(decision, context)
      : tacticalPolicy(decision, context),
  // Building steps (class, scores, subclass, spells, feats) are made as a companion's are.
  tactical: (decision) =>
    /^dnd5\.5e:(turn|moveTo|targets|aim|reaction|afterHit|inspiration|deathSave|build):/.test(
      decision.id,
    ),
});
