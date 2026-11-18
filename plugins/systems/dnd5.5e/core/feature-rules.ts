import { type Feature, FeatureSchema } from "./schemas.ts";

// Mechanics for class features whose imported data is text only, by feature id, in the effect kinds the engine
// already runs. Ids and numbers only: a feature's text stays in its book. Data that already has mechanics wins.
interface Rules {
  readonly automation: "full" | "partial";
  readonly passives?: readonly unknown[];
  readonly activations?: readonly unknown[];
  readonly resources?: readonly unknown[];
  // Spell ids the feature keeps prepared, from the character level in the key.
  readonly spells?: Readonly<Record<number, readonly string[]>>;
}

const scaling = (key: string) => ({ add: [{ kind: "scaling", key }] });
const selfOnly = { self: true };
const untilNextTurn = { until: "yourNextTurnStart" };

const RULES: Readonly<Record<string, Rules>> = {
  // shortcut: any attack gains Advantage, not only Strength ones.
  "phb:feature/barbarian-reckless-attack": {
    automation: "partial",
    resources: [
      {
        id: "reckless-attack",
        max: { base: 1 },
        recharge: [{ on: "turnStart", amount: "all" }],
      },
    ],
    activations: [
      {
        cost: [{ resource: "reckless-attack" }],
        targeting: selfOnly,
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              modifier: { kind: "advantage", on: "attacks" },
              duration: untilNextTurn,
            },
            {
              kind: "modifier",
              modifier: { kind: "advantage", on: "attacksAgainst" },
              duration: untilNextTurn,
            },
          ],
        },
      },
    ],
  },
  "phb:feature/barbarian-fast-movement": {
    automation: "partial",
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "bonus",
          to: "speed",
          amount: { bonus: { base: 10 } },
        },
      },
    ],
  },
  // shortcut: armor and shields aren't checked.
  "phb:feature/monk-unarmored-movement": {
    automation: "partial",
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "bonus",
          to: "speed",
          amount: { bonus: scaling("unarmoredMovement") },
        },
      },
    ],
  },
  "phb:feature/ranger-favored-enemy": {
    automation: "partial",
    spells: { 1: ["phb:spell/hunter-s-mark"] },
  },
  // shortcut: each use heals one die, rather than spending several from the pool at once.
  "phb:feature/warlock-celestial-patron-healing-light": {
    automation: "partial",
    resources: [
      {
        id: "healing-light",
        max: {
          base: 1,
          add: [{ kind: "classLevel", class: "phb:class/warlock" }],
        },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    activations: [
      {
        cost: ["bonusAction", { resource: "healing-light" }],
        targeting: { creatures: 1, range: 60, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "heal", amount: { dice: "1d6" } }],
        },
      },
    ],
  },
};

export function featureRules(feature: Feature): Feature {
  const rules = RULES[feature.id];
  if (!rules || feature.automation !== "text") return feature;
  const { automation, passives, activations, resources } = rules;
  return FeatureSchema.parse({
    ...feature,
    automation,
    passives,
    activations,
    resources,
  });
}

// By the level in the key: the granting class's level (stats.ts levelFor).
export function grantedSpells(
  featureId: string,
  level: number,
): readonly string[] {
  return Object.entries(RULES[featureId]?.spells ?? {}).flatMap(
    ([from, ids]) => (Number(from) <= level ? ids : []),
  );
}
