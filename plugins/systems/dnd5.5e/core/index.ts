import { campEffects, campFrames, sceneCastActions } from "./camp.ts";
import { reincarnateFrames } from "./reincarnate.ts";
import {
  type ContentAccess,
  type FrameDef,
  PLAYER_ACTOR,
  type SystemContext,
  type SystemResult,
  contentKind,
  defineSystem,
  encounterKind,
  frameHandler,
  storyEffect,
  storyPredicate,
} from "#sdk";
import { z } from "zod";
import {
  CREATE_CHARACTER,
  type Context,
  HitSchema,
  TakeActionSchema,
  nextDndDecision,
  runAfterAction,
  runTakeAction,
  startCombat,
} from "./combat.ts";
import { actionFrames } from "./combat/actions.ts";
import { deriveItem } from "./variants.ts";
import { attackFrames } from "./combat/attack.ts";
import { spellRiderFrames } from "./combat/spell-riders.ts";
import { movementFrames } from "./combat/movement.ts";
import { fallingFrames } from "./combat/falling.ts";
import { formFrames } from "./combat/form-choice.ts";
import { damageChoiceFrames } from "./combat/damage-choice.ts";
import { checkChoiceFrames } from "./combat/check-choice.ts";
import { confusionFrames } from "./combat/confusion.ts";
import { wishFrames } from "./combat/wish.ts";
import { reactionFrames } from "./combat/reactions.ts";
import { turnFrames } from "./combat/turn.ts";
import { areaFrames } from "./combat/areas.ts";
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
  abilityCheck,
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
import {
  ACCEPT,
  SHEET_KEY,
  beginSheet,
  sheetFrames,
} from "./character-sheet.ts";
import { gearEffects, gearFrames, sceneGearActions } from "./gear.ts";
import { sceneSwapActions, swapEffects, swapFrames } from "./swap.ts";
import { sceneEffects, scenePredicates } from "./scene.ts";
import { gearPolicy, isGearDecision } from "./policy.ts";
import { legendaryFrames, surpriseEffects } from "./legendary.ts";
import { shopEffects, shopFrames } from "./shop.ts";
import { availableRests, restEffects, restFrames } from "./rest.ts";
import {
  InspirationSchema,
  MissRerollSchema,
  PrecisionSchema,
  runInspiration,
  runMissReroll,
  runPrecision,
} from "./class-rules.ts";
import { classOptionFrames } from "./class-options.ts";
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
  DOWNTIME_KINDS,
  ENVIRONMENT_KINDS,
  GLOSSARY_KINDS,
  OPTION_KINDS,
  GlossaryEntrySchema,
  LairSchema,
  MonsterFamilySchema,
  HazardSchema,
  ItemSchema,
  MonsterSchema,
  LookupTableSchema,
  BastionEntrySchema,
  PoisonSchema,
  PregenSchema,
  RollTableSchema,
  SKILL_ABILITIES,
  ALL_SKILLS,
  CREATURE_TYPES,
  ConditionSchema,
  WeaponMasterySchema,
  WeaponPropertySchema,
  glossaryName,
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
  isDead,
  frame,
  freshActor,
} from "./state.ts";
import { afterActionEvents } from "./combat/durations.ts";
import { deriveStats, lookup } from "./stats.ts";
import { withReveal } from "./fog.ts";
import { actingEnds } from "./combat/effects.ts";
import {
  SKILLS_WITH_DIFFERENT_ABILITIES,
  VARIANT_SETTINGS,
  chosenVariants,
  playing,
  variantOn,
} from "./variant-rules.ts";

// Every step ends by revealing what the party sees once its events land, so the fog clears as it happens.
function revealing(
  frames: Readonly<Record<string, FrameDef<DndState>>>,
): Record<string, FrameDef<DndState>> {
  return Object.fromEntries(
    Object.entries(frames).map(([kind, definition]) => [
      kind,
      {
        ...definition,
        run: (payload, context) =>
          withReveal(definition.run(payload, context), context),
      },
    ]),
  );
}

// An action anyone can take, such as Dash, ends what ends as the creature acts, as Merge with Shadows' invisibility.
function tacticEnds(
  result: SystemResult,
  actorId: string,
  context: { readonly state: DndState },
): SystemResult {
  const actor = context.state.actors[actorId];
  const acted = (result.events ?? []).some(
    (event) => event.kind === `${NS}:budgetSpent`,
  );
  return actor && acted
    ? {
        ...result,
        events: [...actingEnds(actor, null), ...(result.events ?? [])],
      }
    : result;
}

// The conditions, weapon properties and masteries, skills and creature types the engine plays name their
// glossary entities.
const PLAYED: Partial<Record<string, readonly string[]>> = {
  condition: [...ConditionSchema.options, "exhaustion"],
  skill: ALL_SKILLS.map(glossaryName),
  "creature-type": CREATURE_TYPES,
  "weapon-property": WeaponPropertySchema.options.map(glossaryName),
  "weapon-mastery": WeaponMasterySchema.options,
};

// Text kinds, each entry the glossary's shape: content folder -> id kind.
function glossaryKinds(
  kinds: Readonly<Record<string, string>> = GLOSSARY_KINDS,
) {
  return Object.fromEntries(
    Object.entries(kinds).map(([folder, idPrefix]) => {
      const keys = PLAYED[idPrefix];
      return [
        folder,
        contentKind({
          idPrefix,
          schema: GlossaryEntrySchema,
          lore: true,
          ...(keys ? { keys } : {}),
        }),
      ];
    }),
  );
}

function buildReferences(pregen: z.infer<typeof PregenSchema>): string[] {
  return [
    pregen.build.speciesId,
    pregen.build.backgroundId,
    ...pregen.equipment,
    ...pregen.build.levels.flatMap((level) => [
      level.classId,
      ...level.answers.flatMap((answer) =>
        answer.kind === "skills" || !("values" in answer) ? [] : answer.values,
      ),
    ]),
  ];
}

function levelReferences(level: z.infer<typeof ClassSchema>["levels"][number]) {
  return [...level.grants, ...optionReferences(level.choices)];
}

function optionReferences(choices: readonly ChoiceDef[]): readonly string[] {
  return choices.flatMap((choice) =>
    choice.kind === "option"
      ? choice.from
      : choice.kind === "spells"
        ? [...(choice.from ?? []), ...(choice.listOf ? [choice.listOf] : [])]
        : [],
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
// An unset edition means 2024, apart from the older books listed above.
const editionOf = ({
  id,
  edition,
}: {
  id: string;
  edition?: string | undefined;
}) => edition ?? (OLDER_BOOKS.has(id) ? "2014" : "2024");

const CharacterChosenPayload = z.object({ answer: z.string() });
const ActorPayload = z.object({ actor: z.string() });

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
      references: (item) => [
        ...item.grants,
        ...optionReferences(item.choices),
        ...(typeof item.spellAbility === "object"
          ? [item.spellAbility.like]
          : []),
      ],
    }),
    features: contentKind({
      idPrefix: "feature",
      schema: FeatureSchema,
      references: (item) =>
        [item.spells, item.spellsBySlot, item.preparedWith?.spells].flatMap(
          (spells) => Object.values(spells ?? {}).flat(),
        ),
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
      derive: deriveItem,
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
    ...glossaryKinds(ENVIRONMENT_KINDS),
    poisons: contentKind({ idPrefix: "poison", schema: PoisonSchema }),
    budgets: contentKind({ idPrefix: "budget", schema: EncounterBudgetSchema }),
    pregens: contentKind({
      idPrefix: "pregen",
      schema: PregenSchema,
      references: buildReferences,
    }),
    ...glossaryKinds(),
    "monster-families": contentKind({
      idPrefix: "monster-family",
      schema: MonsterFamilySchema,
      lore: true,
      references: (item) => item.members,
    }),
    lairs: contentKind({
      idPrefix: "lair",
      schema: LairSchema,
      lore: true,
      references: (item) => item.owners,
    }),
    ...glossaryKinds(DOWNTIME_KINDS),
    ...glossaryKinds(OPTION_KINDS),
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
  edition: editionOf,
  precedence: (plugin) => {
    const { id } = plugin;
    if (editionOf(plugin) === "2014") return LEADING_BOOKS.length + 2;
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
    ...swapEffects,
    ...surpriseEffects,
    ...shopEffects,
    ...sceneEffects,
    ...campEffects,
  },
  storyPredicates: {
    [`${NS}:hasInspiration`]: storyPredicate({
      schema: z.strictObject({}),
      evaluate: (_args, state: DndState) =>
        state.actors[PLAYER_ACTOR]?.heroicInspiration ?? false,
    }),
    ...scenePredicates,
  },
  frames: revealing({
    [`${NS}:characterChosen`]: frameHandler({
      schema: CharacterChosenPayload,
      run: ({ answer }, context: SystemContext<DndState>) => {
        if (answer === CREATE_CHARACTER) return beginCreation();
        const sheet = beginSheet(PLAYER_ACTOR, answer, context);
        if (sheet) return sheet;
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
    ...sheetFrames,
    ...restFrames,
    ...gearFrames,
    ...swapFrames,
    ...legendaryFrames,
    ...actionFrames,
    ...movementFrames,
    ...fallingFrames,
    ...formFrames,
    ...damageChoiceFrames,
    ...checkChoiceFrames,
    ...confusionFrames,
    ...wishFrames,
    ...reactionFrames,
    ...attackFrames,
    ...spellRiderFrames,
    ...turnFrames,
    ...areaFrames,
    ...shopFrames,
    ...classOptionFrames,
    ...campFrames,
    ...reincarnateFrames,
    [`${NS}:takeAction`]: frameHandler({
      schema: TakeActionSchema,
      run: (payload, context: Context) =>
        isTactic(payload.answer)
          ? tacticEnds(runTactic(payload, context), payload.actor, context)
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
    [`${NS}:inspiration`]: frameHandler({
      schema: InspirationSchema,
      run: runInspiration,
    }),
    [`${NS}:missReroll`]: frameHandler({
      schema: MissRerollSchema,
      run: runMissReroll,
    }),
    [`${NS}:precision`]: frameHandler({
      schema: PrecisionSchema,
      run: runPrecision,
    }),
    [`${NS}:afterAction`]: frameHandler({
      schema: ActorPayload,
      run: (payload, context: Context) => {
        // Slow's one action, or Haste's extra one, settles first and is looked at again.
        const actor = context.state.actors[payload.actor];
        const limited = actor ? afterActionEvents(actor) : [];
        if (limited.length > 0) {
          return { events: limited, frames: [frame("afterAction", payload)] };
        }
        return keepsActing(payload.actor, context)
          ? {}
          : runAfterAction(payload, context);
      },
    }),
  }),
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
            "Your party takes a third of the damage, less in a fight far beyond it, and you can undo your last choice. For enjoying the story.",
          undo: true,
        },
        {
          id: "normal",
          label: "Normal",
          detail:
            "The book's monsters as written. A fight far beyond your party hits it softer, so it stays winnable.",
        },
        {
          id: "hard",
          label: "Hard",
          detail:
            "Your party takes half as much damage again, softened only in a fight it couldn't hope to win.",
        },
      ],
    },
    ...VARIANT_SETTINGS,
  ],
  createRun: ({ settings, actors, dice, content, contentIds, setting }) => {
    const access = { content, contentIds, setting };
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
    const variantRules = chosenVariants(settings);
    return {
      ...(difficulty ? { difficulty } : {}),
      ...(variantRules.length > 0 ? { variantRules } : {}),
      actors: state,
      combat: null,
    };
  },
  // Scene checks are made by the player's character, with the same roll as a check in a fight.
  resolveCheck: (check, context) => {
    const parsed = CheckSchema.parse(check);
    const player = context.state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("The player has no character");
    // A skill paired with another ability adds the skill's proficiency only with Skills with Different Abilities, and
    // is that ability's plain check without it.
    const paired =
      "skill" in parsed &&
      parsed.ability !== undefined &&
      parsed.ability !== SKILL_ABILITIES[parsed.skill];
    const skill =
      "skill" in parsed &&
      (!paired || variantOn(context, SKILLS_WITH_DIFFERENT_ABILITIES))
        ? parsed.skill
        : undefined;
    const ability =
      "skill" in parsed
        ? (parsed.ability ?? SKILL_ABILITIES[parsed.skill])
        : parsed.ability;
    const rolled = abilityCheck(
      player,
      skill,
      ability,
      parsed.dc,
      () => skill ?? ability,
      context,
    );
    return {
      outcome: rolled.success ? "success" : "failure",
      events: [
        ...rolled.events,
        ...(rolled.success ? [] : ([{ kind: "gmOpportunity" }] as const)),
      ],
    };
  },
  startEncounter: (encounter, context, options) =>
    withReveal(
      startCombat(EncounterSchema.parse(encounter), context, options),
      context,
    ),
  applyEvent: applyDndEvent,
  // The engine hands these the state and the access apart, so the access gets the state for the variant rules.
  nextDecision: (state, access) =>
    withTactics(
      nextDndDecision(state, playing(state, access)),
      state,
      playing(state, access),
    ),
  rests: availableRests,
  // Going to another scene takes about an hour, so the party's dead lie dead longer, past Revivify's minute, and
  // one with a finished clone wakes in it, whole (Clone).
  sceneEntered: (state, access) => {
    const dead = Object.values(state.actors).filter(
      (actor) => actor.side === "party" && isDead(actor),
    );
    return [
      ...dead.flatMap((actor) =>
        actor.clone === 0 && actor.source.kind === "character"
          ? [
              dndEvent(`${NS}:cloneAwakened`, {
                actor: actor.id,
                hp: deriveStats(actor, access).maxHp,
              }),
            ]
          : [],
      ),
      ...(dead.some((actor) => !actor.reposed && actor.clone !== 0)
        ? [dndEvent(`${NS}:timePassed`, { hours: 1 })]
        : []),
    ];
  },
  sceneActions: (state, bare) => {
    const access = playing(state, bare);
    return [
      ...sceneGearActions(state, access),
      ...sceneSwapActions(state, access),
      ...sceneCastActions(state, access),
    ];
  },
  decidePolicy: (decision, context) =>
    decision.id.endsWith(`:build:${decision.actor}:${SHEET_KEY}`)
      ? ACCEPT // the sheet is always a sound, recommended build
      : decision.id.startsWith(`${NS}:build:`)
        ? buildPolicy(decision, context)
        : isGearDecision(decision)
          ? gearPolicy(decision, context)
          : tacticalPolicy(decision, context),
  // Building steps (class, scores, subclass, spells, feats) are made as a companion's are, and a rest's
  // Hit Dice and gear as a careful player would.
  tactical: (decision) =>
    /^dnd5\.5e:(turn|moveTo|targets|aim|reaction|afterHit|strike|inspiration|deathSave|build|metamagic|precision|damageType|focus|wish|mastery|missReroll):/.test(
      decision.id,
    ) || isGearDecision(decision),
});
