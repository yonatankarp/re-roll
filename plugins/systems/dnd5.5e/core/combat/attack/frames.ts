import { z } from "zod";
import { NS } from "../../state.ts";
import { runReplaceHit } from "../ranged-smite.ts";
import { runApplyMiss } from "../spell-riders.ts";
import { frameHandler } from "#sdk";
import {
  runAttackRoll,
  AdvantageForgoneSchema,
  runAdvantageForgone,
  runAdvantageGained,
} from "./attack-roll.ts";
import { ConcentrationSchema, runConcentrationSave } from "./concentration.ts";
import {
  runApplyHit,
  runCriticalChosen,
  StrikeChosenSchema,
  runStrikeChosen,
} from "./hit.ts";
import {
  ReactionSchema,
  runAfterReaction,
  runRecheckHit,
} from "./hit-reactions.ts";
import { runMissRider } from "./miss.ts";
import { AttackSchema, HitSchema } from "./payloads.ts";
import { runProjectile } from "./projectile.ts";
import { RollReactionSchema, runRollReaction } from "./roll-reactions.ts";
import {
  AfterHitSchema,
  runAfterHit,
  SmiteSchema,
  CompanionSmiteSchema,
  runCompanionSmite,
  runSmite,
} from "./smite.ts";

export const attackFrames = {
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
  [`${NS}:companionSmite`]: frameHandler({
    schema: CompanionSmiteSchema,
    run: runCompanionSmite,
  }),
  [`${NS}:missRider`]: frameHandler({ schema: HitSchema, run: runMissRider }),
  [`${NS}:strikeChosen`]: frameHandler({
    schema: StrikeChosenSchema,
    run: runStrikeChosen,
  }),
  [`${NS}:criticalChosen`]: frameHandler({
    schema: StrikeChosenSchema,
    run: runCriticalChosen,
  }),
  [`${NS}:advantageGained`]: frameHandler({
    schema: AdvantageForgoneSchema,
    run: runAdvantageGained,
  }),
  [`${NS}:advantageForgone`]: frameHandler({
    schema: AdvantageForgoneSchema,
    run: runAdvantageForgone,
  }),
  [`${NS}:replaceHit`]: frameHandler({
    schema: HitSchema.extend({ landed: z.boolean(), answer: z.string() }),
    run: runReplaceHit,
  }),
  [`${NS}:rollReaction`]: frameHandler({
    schema: RollReactionSchema,
    run: runRollReaction,
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
  [`${NS}:applyMiss`]: frameHandler({ schema: HitSchema, run: runApplyMiss }),
  [`${NS}:concentrationSave`]: frameHandler({
    schema: ConcentrationSchema,
    run: runConcentrationSave,
  }),
};
