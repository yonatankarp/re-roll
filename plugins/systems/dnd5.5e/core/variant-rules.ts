import type { ContentAccess, SystemSetting } from "#sdk";

// The books' variant rules (#190): the ones a run can turn on at setup, and why each other one has no rules
// effect here. A run's choice is in its start settings, kept in its state as `variantRules`.

export const ENCUMBRANCE = "basic-rules-2014:variant-rule/encumbrance";
export const SKILLS_WITH_DIFFERENT_ABILITIES =
  "basic-rules-2014:variant-rule/skills-with-different-abilities";

const OFF = { id: "off", label: "Off", detail: "As the rules are written." };

export const VARIANT_SETTINGS: readonly SystemSetting[] = [
  {
    id: ENCUMBRANCE,
    label: "Encumbrance",
    variant: true,
    default: "off",
    options: [
      OFF,
      {
        id: "on",
        label: "On",
        detail:
          "Carrying over a third of your capacity costs 10 feet of Speed. Over two thirds costs 20 and gives Disadvantage on Strength, Dexterity and Constitution rolls. Armor's Strength score no longer slows you.",
      },
    ],
  },
  {
    id: SKILLS_WITH_DIFFERENT_ABILITIES,
    label: "Skills with Different Abilities",
    variant: true,
    default: "off",
    options: [
      OFF,
      {
        id: "on",
        label: "On",
        detail:
          "A check that pairs a skill with another ability, such as Constitution (Athletics), adds your proficiency in the skill.",
      },
    ],
  },
];

// The rest, complete as text: each one's reason it changes nothing in play.
export const NO_RULES_EFFECT: Readonly<Record<string, string>> = {
  "basic-rules-2014:variant-rule/playing-on-a-grid":
    "Always on: every fight is played on a grid of 5-foot squares.",
  "basic-rules-2014:variant-rule/customizing-ability-scores":
    "Always on: point buy is one of the character builder's ways to set ability scores.",
  "arcana-unleashed:variant-rule/make-your-patron-mysterious":
    "Story advice for a group patron, with no rules in it.",
  "dmg:variant-rule/training-to-gain-levels":
    "Levels come where the adventure puts them, with no downtime between to train in.",
  "xanathars-guide:variant-rule/buying-and-selling":
    "A shared-campaign rule: a run isn't one, and its merchants sell what the adventure gives them.",
  "xanathars-guide:variant-rule/character-advancement":
    "A shared-campaign rule: a run isn't one, and its levels come where the adventure puts them.",
  "xanathars-guide:variant-rule/individual-treasure":
    "A shared-campaign rule: a run isn't one, and its gold is the treasure the adventure gives.",
  "xanathars-guide:variant-rule/magic-items":
    "A shared-campaign rule: a run isn't one, and its magic items are the treasure the adventure gives.",
  "project-lamordia:variant-rule/kinetic-creations":
    "A way to remake monsters, and encounters keep the adventure's own.",
};

// The rules the run plays, from its settings.
export function chosenVariants(
  settings: Readonly<Record<string, string>>,
): string[] {
  return VARIANT_SETTINGS.filter(
    (setting) => settings[setting.id] === setting.options[1]?.id,
  ).map((setting) => setting.id);
}

// The access with the run's state beside it, as the engine's context has it, for a hook or the ui handed the two
// apart, so stats play the run's variant rules.
export function playing(
  rawState: unknown,
  access: ContentAccess,
): ContentAccess {
  const withState = { ...access, state: rawState };
  return withState;
}

// Whether the run plays a variant rule. The engine's context carries the run's state, and so does access passed
// through playing(); access with no state, as in character creation's preview, plays none.
export function variantOn(access: ContentAccess, id: string): boolean {
  const { state } = access as { state?: { variantRules?: unknown } };
  return Array.isArray(state?.variantRules) && state.variantRules.includes(id);
}
