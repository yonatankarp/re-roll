// Rolling dice: notation, rerolls, exploding dice and scaled dice.
import type { Dice } from "#sdk";
import type { Amount } from "../schemas.ts";
import type { Stats } from "./model.ts";
import { evaluateFormula } from "./formulas.ts";

// How many dice a notation rolls, the least it can come to: 3 for "3d10".
export const diceCount = (notation: string): number =>
  Number(/^(\d+)d/.exec(notation)?.[1] ?? 1);

export function rollDiceNotation(
  notation: string,
  dice: Dice,
  multiplier = 1,
): number {
  const [count = "0", sides = "0"] = notation.split("d");
  let total = 0;
  for (let index = 0; index < Number(count) * multiplier; index += 1) {
    total += dice.roll(Number(sides));
  }
  return total;
}

// Rolls again, once, up to `reroll` of the dice that came up below average, the lowest first, and keeps the new rolls.
function rollRerolling(
  notation: string,
  dice: Dice,
  multiplier: number,
  reroll: number,
): number {
  const [count = "0", sides = "0"] = notation.split("d");
  const rolls = Array.from({ length: Number(count) * multiplier }, () =>
    dice.roll(Number(sides)),
  );
  const low = rolls
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value < (Number(sides) + 1) / 2)
    .sort((a, b) => a.value - b.value)
    .slice(0, reroll);
  for (const { index } of low) rolls[index] = dice.roll(Number(sides));
  return rolls.reduce((sum, value) => sum + value, 0);
}

// A scaling key can replace the number of dice (sneakAttackD6) or the die size (martialArtsDie).
export function scaledDice(
  source: {
    readonly dice?: string | undefined;
    readonly diceCount?: string | undefined;
    readonly dieSize?: string | undefined;
    readonly dieAtLeast?: string | undefined;
    readonly halfDice?: true | undefined;
  },
  scaling: Readonly<Record<string, number>>,
): string | undefined {
  if (!source.dice) return undefined;
  const [count = "0", sides = "0"] = source.dice.split("d");
  const dice = Number(scaling[source.diceCount ?? ""] ?? count);
  const rolled = source.halfDice ? Math.ceil(dice / 2) : dice;
  const size = Math.max(
    Number(scaling[source.dieSize ?? ""] ?? sides),
    scaling[source.dieAtLeast ?? ""] ?? 0,
  );
  return `${String(rolled)}d${String(size)}`;
}

// Dice whose 1s are rolled again once, the new roll standing, as with Healing Rerolls or Tavern Brawler.
export function rerollingOnes(dice: Dice): Dice {
  return {
    ...dice,
    roll: (sides) => {
      const rolled = dice.roll(sides);
      return rolled === 1 ? dice.roll(sides) : rolled;
    },
  };
}

export function rollAmount(
  amount: Amount,
  stats: Stats,
  dice: Dice,
  diceMultiplier = 1,
): number {
  const notation = scaledDice(amount, stats.scaling);
  const rolling = amount.highest
    ? { ...dice, roll: (sides: number) => sides }
    : amount.rerollOnes
      ? rerollingOnes(dice)
      : dice;
  const rolled = notation
    ? amount.reroll
      ? rollRerolling(notation, rolling, diceMultiplier, amount.reroll)
      : amount.explode
        ? rollExploding(
            notation,
            rolling,
            diceMultiplier,
            evaluateFormula(amount.explode, stats),
          )
        : rollDiceNotation(notation, rolling, diceMultiplier)
    : 0;
  return (
    rolled * (amount.times ?? 1) +
    (amount.bonus ? evaluateFormula(amount.bonus, stats) : 0)
  );
}

// Each die showing its highest face, the added ones too, adds another die, at most `most` more, as Sorcerous Burst's.
export function rollExploding(
  notation: string,
  dice: Dice,
  multiplier: number,
  most: number,
): number {
  const [count = "0", sides = "0"] = notation.split("d");
  let left = Number(count) * multiplier;
  let added = 0;
  let total = 0;
  while (left > 0) {
    left -= 1;
    const face = dice.roll(Number(sides));
    total += face;
    if (face === Number(sides) && added < most) {
      added += 1;
      left += 1;
    }
  }
  return total;
}
