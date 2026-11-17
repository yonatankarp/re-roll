import { awaitDecision, type Frame } from "#sdk";
import { type Actor, frame, isDown, NS } from "../state.ts";
import { deriveStats, type KnownAction, type Stats } from "../stats.ts";
import { DECLINE, encodeOption } from "./ids.ts";
import {
  actorOf,
  canAfford,
  type Context,
  extraFits,
  findAction,
  fitsType,
  hitFits,
  itemFits,
} from "./queries.ts";

// Strike options picked before a hit's dice are rolled: Cunning Strike's give up Sneak Attack dice (`trigger.forgo`),
// asked as the hit lands, and Brutal Strike's take the place of an attack roll's Advantage (`trigger.forgoAdvantage`),
// asked before the roll. Each one picked is resolved after the hit's damage, as a smite is (attack.ts runSmite).

interface Struck {
  readonly [key: string]: unknown;
  readonly attacker: string;
  readonly actionId: string;
  readonly target: string;
  readonly slotLevel?: number | undefined;
  readonly strikes?: readonly string[] | undefined;
}

// Sneak Attack's extra damage is the extraDamage passive whose dice count is this class scaling key.
export const SNEAK_DICE = "sneakAttackD6";

// How many strike options one hit takes.
export function strikeLimit(stats: Stats): number {
  return stats.passives.reduce(
    (most, passive) =>
      passive.kind === "strikeEffects" ? Math.max(most, passive.count) : most,
    1,
  );
}

// The Sneak Attack dice a hit carries before any are given up, or 0 when it carries none.
export function sneakDice(
  attacker: Actor,
  target: Actor,
  hitWith: KnownAction,
  edge: { readonly advantage: boolean; readonly disadvantage: boolean },
  stats: Stats,
  context: Context,
): number {
  const index = stats.passives.findIndex(
    (passive) =>
      passive.kind === "extraDamage" &&
      passive.diceCount === SNEAK_DICE &&
      !(
        passive.oncePerTurn &&
        attacker.usedThisTurn.includes(
          `extra:${String(stats.passives.indexOf(passive))}`,
        )
      ) &&
      extraFits(passive, attacker, target, hitWith, edge, context),
  );
  const passive = stats.passives[index];
  return passive?.kind === "extraDamage"
    ? Number((passive.dice ?? "0d6").split("d")[0])
    : 0;
}

function optionsFor(
  kind: "forgo" | "forgoAdvantage" | "gainsAdvantage" | "critical",
  hit: Struck,
  budget: number,
  context: Context,
): { readonly attacker: Actor; readonly options: readonly KnownAction[] } {
  const { state } = context;
  const attacker = actorOf(state, hit.attacker);
  const target = actorOf(state, hit.target);
  const stats = deriveStats(attacker, context);
  const hitWith = findAction(attacker, hit.actionId, context, hit.slotLevel);
  const chosen = hit.strikes ?? [];
  const options =
    isDown(attacker) || isDown(target) || chosen.length >= strikeLimit(stats)
      ? []
      : stats.actions.filter((action) => {
          const { trigger, targeting } = action.activation;
          const fits =
            kind === "forgo"
              ? trigger?.forgo !== undefined && trigger.forgo <= budget
              : kind === "gainsAdvantage"
                ? trigger?.gainsAdvantage === true
                : kind === "critical"
                  ? trigger?.critical === true
                  : trigger?.forgoAdvantage === true;
          return (
            fits &&
            !chosen.includes(action.id) &&
            // Stealth Attack only for an attack made from hiding.
            (!action.activation.keepsHidden || hit.hidden !== undefined) &&
            canAfford(action, attacker, stats) &&
            hitFits(
              trigger?.afterHit ?? "weapon",
              hitWith,
              attacker,
              context,
            ) &&
            itemFits(action, hitWith) &&
            fitsType(target, targeting, context, attacker)
          );
        });
  return { attacker, options };
}

function askFor(
  hit: Struck,
  attacker: Actor,
  options: readonly KnownAction[],
  prompt: string,
  resume: Frame,
  cost: (action: KnownAction) => string,
): Frame {
  return awaitDecision({
    id: `${NS}:strike:${attacker.id}`,
    actor: attacker.id,
    prompt,
    options: [
      ...options.map((action) => ({
        id: encodeOption(action.id, hit.target),
        label: `${action.name}${cost(action)}`,
      })),
      {
        id: DECLINE,
        label: (hit.strikes ?? []).length > 0 ? "No more" : "None",
      },
    ],
    resume,
  });
}

// Cunning Strike's question as a hit lands with Sneak Attack, or null when there's nothing to give its dice for.
export function forgoFrame(
  hit: Struck & {
    readonly hadAdvantage: boolean;
    readonly hadDisadvantage?: boolean | undefined;
    readonly forgone?: number | undefined;
  },
  context: Context,
): Frame | null {
  const { state } = context;
  const attacker = actorOf(state, hit.attacker);
  const target = actorOf(state, hit.target);
  const stats = deriveStats(attacker, context);
  // Most attackers have no such option, so that's looked at first.
  if (!stats.actions.some(({ activation }) => activation.trigger?.forgo)) {
    return null;
  }
  const hitWith = findAction(attacker, hit.actionId, context, hit.slotLevel);
  const dice = sneakDice(
    attacker,
    target,
    hitWith,
    {
      advantage: hit.hadAdvantage,
      disadvantage: hit.hadDisadvantage === true,
    },
    stats,
    context,
  );
  const left = dice - (hit.forgone ?? 0);
  const { options } = optionsFor("forgo", hit, left, context);
  if (options.length === 0) return null;
  return askFor(
    hit,
    attacker,
    options,
    `${attacker.name}'s Sneak Attack lands on ${target.name} (${String(left)} dice). Trade dice for a strike?`,
    frame("strikeChosen", hit),
    (action) => {
      const forgo = action.activation.trigger?.forgo ?? 0;
      return ` (${String(forgo)} ${forgo === 1 ? "die" : "dice"})`;
    },
  );
}

// Brutal Strike's question before an attack roll with Advantage, or null when there's nothing to give it up for.
export function forgoAdvantageFrame(
  attack: Struck,
  context: Context,
): Frame | null {
  const { state } = context;
  const attacker = actorOf(state, attack.attacker);
  const stats = deriveStats(attacker, context);
  if (
    !stats.actions.some(({ activation }) => activation.trigger?.forgoAdvantage)
  ) {
    return null;
  }
  const { options } = optionsFor("forgoAdvantage", attack, 0, context);
  if (options.length === 0) return null;
  const target = actorOf(state, attack.target);
  return askFor(
    attack,
    attacker,
    options,
    `${attacker.name} attacks ${target.name} with Advantage. Give it up for a strike?`,
    frame("advantageForgone", attack),
    () => "",
  );
}

// A Namer's Needle's Named Target asked as a hit lands that isn't a Critical Hit, or null with nothing to ask.
export function criticalFrame(
  hit: Struck & { readonly critical: boolean },
  context: Context,
): Frame | null {
  if (hit.critical) return null;
  const attacker = actorOf(context.state, hit.attacker);
  const stats = deriveStats(attacker, context);
  if (!stats.actions.some(({ activation }) => activation.trigger?.critical)) {
    return null;
  }
  const { options } = optionsFor("critical", hit, 0, context);
  if (options.length === 0) return null;
  const target = actorOf(context.state, hit.target);
  return askFor(
    hit,
    attacker,
    options,
    `${attacker.name} hits ${target.name}. Make it a Critical Hit?`,
    frame("criticalChosen", hit),
    () => "",
  );
}

// A Martialist's Trip's question before an attack roll without Advantage, or null when nothing gives it.
export function gainAdvantageFrame(
  attack: Struck,
  context: Context,
): Frame | null {
  const { state } = context;
  const attacker = actorOf(state, attack.attacker);
  const stats = deriveStats(attacker, context);
  if (
    !stats.actions.some(({ activation }) => activation.trigger?.gainsAdvantage)
  ) {
    return null;
  }
  const { options } = optionsFor("gainsAdvantage", attack, 0, context);
  if (options.length === 0) return null;
  const target = actorOf(state, attack.target);
  return askFor(
    attack,
    attacker,
    options,
    `${attacker.name} attacks ${target.name}. Use a strike for Advantage?`,
    frame("advantageGained", attack),
    () => "",
  );
}
