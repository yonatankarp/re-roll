import type { Dice } from "../kernel/dice.ts";
import type { CompanionProfile } from "../kernel/events.ts";

export interface Companion {
  readonly name: string;
  readonly pronouns: string;
}

// Who joins when an adventure names no companions of its own (adventure.yaml's party.companions).
export const DEFAULT_COMPANIONS: readonly Companion[] = [
  { name: "Sera", pronouns: "she/her" },
  { name: "Tobin", pronouns: "he/him" },
  { name: "Oren", pronouns: "he/him" },
  { name: "Lys", pronouns: "she/her" },
  { name: "Bram", pronouns: "they/them" },
  { name: "Ivy", pronouns: "she/her" },
];

// The books' encounters are written for a party of four, so that is the size unless an adventure sets one.
export const DEFAULT_PARTY_SIZE = 4;

export function rollCompanions(
  dice: Dice,
  count = DEFAULT_PARTY_SIZE - 1,
  candidates: readonly Companion[] = DEFAULT_COMPANIONS,
): readonly CompanionProfile[] {
  const pool = [...candidates];
  const chosen: CompanionProfile[] = [];
  for (let index = 1; index <= count; index += 1) {
    const [candidate] = pool.splice(dice.below(pool.length), 1);
    if (candidate) {
      chosen.push({
        id: `companion-${String(index)}`,
        name: candidate.name,
        pronouns: candidate.pronouns,
      });
    }
  }
  return chosen;
}
