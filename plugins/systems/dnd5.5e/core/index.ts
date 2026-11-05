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
  ConcentrationSchema,
  type Context,
  HitSchema,
  ReactionSchema,
  TakeActionSchema,
  choosePolicy,
  nextDndDecision,
  runAfterAction,
  runAfterReaction,
  runApplyHit,
  runAttackRoll,
  runCheckCombatEnd,
  runConcentrationSave,
  runEndTurn,
  runRecheckHit,
  runTakeAction,
  startCombat,
} from "./combat.ts";
import { rollD20 } from "./rules.ts";
import {
  BackgroundSchema,
  CheckSchema,
  ClassSchema,
  EncounterSchema,
  FeatSchema,
  FeatureSchema,
  ItemSchema,
  MonsterSchema,
  PregenSchema,
  SKILL_ABILITIES,
  SpeciesSchema,
  SpellSchema,
} from "./schemas.ts";
import {
  type Actor,
  type DndState,
  EVENT_SCHEMAS,
  NS,
  StateSchema,
  applyDndEvent,
  dndEvent,
  freshActor,
} from "./state.ts";
import { deriveStats, lookup, modifierFor } from "./stats.ts";

function buildReferences(pregen: z.infer<typeof PregenSchema>): string[] {
  return [
    pregen.build.speciesId,
    pregen.build.backgroundId,
    ...pregen.equipment,
    ...pregen.build.levels.flatMap((level) => [
      level.classId,
      ...level.answers.flatMap((answer) =>
        answer.kind === "skills" ? [] : answer.values,
      ),
    ]),
  ];
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
    source: { kind: "character", build: pregen.build },
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
      references: (item) => item.levels.flatMap((level) => level.grants),
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
    equipment: contentKind({ idPrefix: "item", schema: ItemSchema }),
    monsters: contentKind({
      idPrefix: "monster",
      schema: MonsterSchema,
      references: (item) => item.features,
    }),
    pregens: contentKind({
      idPrefix: "pregen",
      schema: PregenSchema,
      references: buildReferences,
    }),
  },
  checkSchema: CheckSchema,
  encounters: encounterKind({
    schema: EncounterSchema,
    references: (encounter) => encounter.monsters.map((entry) => entry.monster),
  }),
  outcomes: { keys: ["success", "failure"] },
  stateSchema: StateSchema,
  eventSchemas: EVENT_SCHEMAS,
  storyEffects: {
    [`${NS}:grantInspiration`]: storyEffect({
      schema: z.strictObject({}),
      apply: (_args, _context: Context) => ({
        events: [dndEvent(`${NS}:inspirationGranted`, { actor: PLAYER_ACTOR })],
      }),
    }),
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
              build: pregen.build,
              inventory: pregen.equipment,
              hp: actor.hp,
            }),
          ],
        };
      },
    }),
    [`${NS}:takeAction`]: frameHandler({
      schema: TakeActionSchema,
      run: runTakeAction,
    }),
    [`${NS}:attackRoll`]: frameHandler({
      schema: AttackSchema,
      run: runAttackRoll,
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
  createRun: ({ actors, dice, content, contentIds }) => {
    const access = { content, contentIds };
    const pool = contentIds().filter((id) => id.includes(":pregen/"));
    const state: Record<string, Actor> = {};
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
        const [pregenId] = pool.splice(dice.below(pool.length), 1);
        if (pregenId === undefined) {
          throw new Error("There are too few pregens for the party");
        }
        state[id] = characterActor(id, name, pregenId, access);
      }
    }
    return { actors: state, combat: null };
  },
  // Scene checks are made by the player's character.
  resolveCheck: (check, context) => {
    const parsed = CheckSchema.parse(check);
    const player = context.state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("The player has no character");
    const stats = deriveStats(player, context);
    const ability =
      "skill" in parsed ? SKILL_ABILITIES[parsed.skill] : parsed.ability;
    const proficient = "skill" in parsed && stats.skills.includes(parsed.skill);
    const roll = rollD20(context.dice, {
      advantage: false,
      disadvantage: false,
    });
    const total =
      roll.natural +
      modifierFor(stats, ability) +
      (proficient ? stats.proficiency : 0) -
      2 * player.exhaustion;
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
  startEncounter: (encounter, context) =>
    startCombat(EncounterSchema.parse(encounter), context),
  applyEvent: applyDndEvent,
  nextDecision: nextDndDecision,
  decidePolicy: choosePolicy,
});
