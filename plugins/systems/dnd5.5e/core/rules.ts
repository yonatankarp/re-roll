import type { Dice } from "#sdk";
import type { DamageType } from "./schemas.ts";

export interface D20Roll {
  readonly natural: number;
  readonly rolls: readonly number[];
}

// Advantage never stacks, and one instance of each cancels out, however many apply.
// With `rerollOnes`, as with Halfling Luck, a die that comes up 1 is rolled again and the new roll stands.
export function rollD20(
  dice: Dice,
  options: {
    readonly advantage: boolean;
    readonly disadvantage: boolean;
    readonly rerollOnes?: boolean;
  },
): D20Roll {
  const roll = () => {
    const value = dice.roll(20);
    return value === 1 && options.rerollOnes ? dice.roll(20) : value;
  };
  const first = roll();
  if (options.advantage === options.disadvantage) {
    return { natural: first, rolls: [first] };
  }
  const second = roll();
  return {
    natural: options.advantage
      ? Math.max(first, second)
      : Math.min(first, second),
    rolls: [first, second],
  };
}

export interface DamageResponse {
  readonly adjustments?: readonly number[];
  readonly resistances?: readonly DamageType[];
  readonly vulnerabilities?: readonly DamageType[];
  readonly immunities?: readonly DamageType[];
}

// SRD order: adjustments, then Resistance (rounded down), then Vulnerability.
// Each counts once however many sources grant it, and Immunity means no damage at all.
export function finalDamage(
  amount: number,
  type: DamageType,
  response: DamageResponse,
): number {
  if (response.immunities?.includes(type)) return 0;
  const adjusted = (response.adjustments ?? []).reduce(
    (total, adjustment) => total + adjustment,
    amount,
  );
  let total = Math.max(0, adjusted);
  if (response.resistances?.includes(type)) total = Math.floor(total / 2);
  if (response.vulnerabilities?.includes(type)) total *= 2;
  return total;
}

export function halved(amount: number): number {
  return Math.floor(amount / 2);
}

export function concentrationDc(damage: number): number {
  return Math.min(30, Math.max(10, halved(damage)));
}
