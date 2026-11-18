import { type Actor, turnId } from "../../state.ts";
import { passiveModifiers, evaluateFormula, type Stats } from "../../stats.ts";
import { actorOf, type Context, findAction, meleeReach } from "../queries.ts";

// AC that counts against melee attack rolls only, as Defensive Stance's, or ranged ones only, as an Arrow-Catching
// Shield's.
export function meleeAc(target: Actor, melee: boolean, stats: Stats): number {
  const sources = new Map<string, number>();
  for (const { modifier, sourceId } of [
    ...target.activeEffects,
    // Each passive counts as a source of its own.
    ...passiveModifiers(stats.passives).map((each, at) => ({
      modifier: each,
      sourceId: `passive:${String(at)}`,
    })),
  ]) {
    if (
      modifier.kind === "bonus" &&
      modifier.to === "ac" &&
      (melee ? modifier.melee : modifier.ranged)
    ) {
      sources.set(
        sourceId,
        evaluateFormula(modifier.amount.bonus ?? { base: 0, add: [] }, stats),
      );
    }
  }
  return [...sources.values()].reduce((sum, bonus) => sum + bonus, 0);
}

// How an attack came: in melee, at range, from a spell. Reactions such as Parry or Deflect Missile ask.
export function attackKind(
  hit: {
    readonly attacker: string;
    readonly actionId: string;
    readonly slotLevel?: number | undefined;
  },
  context: Context,
): { melee: boolean; ranged: boolean; spell: boolean } {
  const attacker = actorOf(context.state, hit.attacker);
  const action = findAction(attacker, hit.actionId, context, hit.slotLevel);
  const melee = meleeReach(action) !== null;
  return { melee, ranged: !melee, spell: action.spellLevel !== null };
}

// Whether it's the creature's own turn, so a hit on it is a reaction such as an Opportunity Attack.
export function inOwnTurn(target: Actor, context: Context): boolean {
  const { combat } = context.state;
  return turnId(combat) === target.id;
}
