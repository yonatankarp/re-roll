// Ability scores and their modifiers, and the Proficiency Bonus.
import type { z } from "zod";
import type { Actor } from "../state.ts";
import {
  ABILITIES,
  type Ability,
  type AbilityScores,
  ItemSchema,
  type CharacterBuild,
} from "../schemas.ts";

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((level - 1) / 4);
}

// The character's scores after every increase, including those raised for good, as by a Manual of Bodily Health.
export function ownAbilities(
  actor: Actor,
  build: CharacterBuild,
): AbilityScores {
  const scores = buildAbilities(build);
  for (const ability of ABILITIES) {
    scores[ability] += actor.raised?.[ability] ?? 0;
  }
  return scores;
}

// Scores the items worn set or raise, as Gauntlets of Ogre Power's Strength 19, never lowering one.
// An entry with versions counts as its first, as with its bonuses.
export function withItemAbilities(
  scores: AbilityScores,
  items: readonly Extract<
    z.infer<typeof ItemSchema>,
    { type: "magicItem" | "weapon" }
  >[],
  attuned: readonly string[] = [],
): AbilityScores {
  const raised = { ...scores };
  const changes = items.flatMap((item) =>
    item.type === "weapon"
      ? (item.abilities ?? [])
      : (item.abilities ?? item.variants?.[0]?.abilities ?? []),
  );
  // Setting comes after raising, so a set score is what the item says, unless the raised one is higher.
  for (const change of changes) {
    if ("raise" in change) {
      raised[change.ability] = Math.max(
        raised[change.ability],
        Math.min(change.max, raised[change.ability] + change.raise),
      );
    }
  }
  for (const change of changes) {
    if ("set" in change) {
      raised[change.ability] = Math.max(raised[change.ability], change.set);
    }
  }
  // Might of Giants: more on top, with the other item attuned.
  for (const change of changes) {
    if (
      "boost" in change &&
      attuned.some((id) =>
        change.attunedTo.some((to) => id === to || id.startsWith(`${to}--`)),
      )
    ) {
      raised[change.ability] = Math.min(
        change.max,
        raised[change.ability] + change.boost,
      );
    }
  }
  return raised;
}

// Scores an effect on the character sets while it lasts, as a Potion of Giant Strength's, never lowering one unless
// `exact`, as Wish's stress Strength of 3.
export function withEffectScores(
  scores: AbilityScores,
  actor: Actor,
): AbilityScores {
  const set = { ...scores };
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "setScore") {
      set[modifier.ability] = modifier.exact
        ? modifier.score
        : Math.max(set[modifier.ability], modifier.score);
    }
  }
  return set;
}

export function bestMentalAbility(abilities: AbilityScores): Ability {
  return (["int", "wis", "cha"] as const).reduce<Ability>(
    (best, ability) => (abilities[ability] > abilities[best] ? ability : best),
    "int",
  );
}

// Ability scores after every increase, never above 20, or 30 for an Epic Boon's.
export function buildAbilities(build: CharacterBuild): AbilityScores {
  const abilities = { ...build.baseAbilities };
  const increases = [
    { increases: build.backgroundIncrease, max: 20 },
    ...build.levels.flatMap((entry) =>
      entry.answers.flatMap((answer) =>
        answer.kind === "abilities"
          ? [{ increases: answer.increases, max: answer.max ?? 20 }]
          : [],
      ),
    ),
  ];
  for (const { increases: increase, max } of increases) {
    for (const ability of ABILITIES) {
      const score = abilities[ability];
      abilities[ability] = Math.max(
        score,
        Math.min(max, score + (increase[ability] ?? 0)),
      );
    }
  }
  return abilities;
}
