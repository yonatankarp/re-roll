import type { Dice } from "../kernel/dice.ts";
import type { CompanionProfile } from "../kernel/events.ts";

// shortcut: one small built-in table. Let adventures add their own when real ones need them.
const CANDIDATES: readonly Omit<CompanionProfile, "id" | "loyalty">[] = [
  {
    name: "Sera",
    pronouns: "she/her",
    personality: "Sharp-tongued ex-soldier who trusts nobody.",
    goal: "Earn enough to disappear for good.",
    secret: "Deserted from the army she still talks about with pride.",
  },
  {
    name: "Tobin",
    pronouns: "he/him",
    personality: "Cheerful young healer who hates violence.",
    goal: "Prove to their family that this life isn't a mistake.",
    secret: "Once let a patient die to save a friend.",
  },
  {
    name: "Oren",
    pronouns: "he/him",
    personality: "Soft-spoken gravedigger with a morbid sense of humor.",
    goal: "Give the forgotten dead a proper burial.",
    secret: "Can't remember where he buried his own brother.",
  },
  {
    name: "Lys",
    pronouns: "she/her",
    personality: "Reckless thief who talks when she is scared.",
    goal: "Find one score big enough to stop stealing.",
    secret: "Is being hunted by the crew she robbed.",
  },
  {
    name: "Bram",
    pronouns: "they/them",
    personality: "Patient old sailor who answers questions with stories.",
    goal: "See the place on their last map before they die.",
    secret: "Sank their own ship for the insurance money.",
  },
  {
    name: "Ivy",
    pronouns: "she/her",
    personality: "Bookish scholar who is braver than she looks.",
    goal: "Publish the discovery her college stole from her.",
    secret: "Forged the letter that got her onto this job.",
  },
];

export const COMPANION_COUNT = 2;

export function rollCompanions(dice: Dice): readonly CompanionProfile[] {
  const pool = [...CANDIDATES];
  const chosen: CompanionProfile[] = [];
  for (let index = 1; index <= COMPANION_COUNT; index += 1) {
    const [candidate] = pool.splice(dice.below(pool.length), 1);
    if (candidate) {
      chosen.push({
        ...candidate,
        id: `companion-${String(index)}`,
        loyalty: 0,
      });
    }
  }
  return chosen;
}
