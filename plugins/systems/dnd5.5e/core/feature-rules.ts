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

const BARDIC_INSPIRATION_USES = {
  base: 0,
  add: [{ kind: "abilityMod", ability: "cha" }],
  min: 1,
};

// A subclass's always-prepared spells, by the class level each row of its table starts at.
const prepared = (spells: NonNullable<Rules["spells"]>): Rules => ({
  automation: "full",
  spells,
});

const improvedCritical = (from: number): Rules => ({
  automation: "full",
  passives: [{ kind: "criticalRange", from }],
});

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
  // shortcut: the die adds to the ally's next attack roll, not to any failed d20 test.
  "phb:feature/bard-bardic-inspiration": {
    automation: "partial",
    resources: [
      {
        id: "bardic-inspiration",
        max: BARDIC_INSPIRATION_USES,
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    activations: [
      {
        cost: ["bonusAction", { resource: "bardic-inspiration" }],
        targeting: { creatures: 1, range: 60, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              modifier: {
                kind: "bonus",
                to: "attacks",
                once: true,
                amount: { dice: "1d6", dieSize: "bardicDie" },
              },
              duration: { minutes: 60 },
            },
          ],
        },
      },
    ],
  },
  // The same uses as Bardic Inspiration, now also back on a Short Rest.
  "phb:feature/bard-font-of-inspiration": {
    automation: "partial",
    resources: [
      {
        id: "bardic-inspiration",
        max: BARDIC_INSPIRATION_USES,
        recharge: [{ on: "shortRest", amount: "all" }],
      },
    ],
  },
  // shortcut: no beast form, only the Temporary Hit Points.
  "phb:feature/druid-wild-shape": {
    automation: "partial",
    resources: [
      {
        id: "wild-shape",
        max: { base: 0, ...scaling("wildShape") },
        recharge: [
          { on: "shortRest", amount: 1 },
          { on: "longRest", amount: "all" },
        ],
      },
    ],
    activations: [
      {
        cost: ["bonusAction", { resource: "wild-shape" }],
        targeting: selfOnly,
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "tempHp",
              amount: {
                bonus: {
                  add: [{ kind: "classLevel", class: "phb:class/druid" }],
                },
              },
            },
          ],
        },
      },
    ],
  },
  "phb:feature/fighter-champion-improved-critical": improvedCritical(19),
  "phb:feature/fighter-champion-superior-critical": improvedCritical(18),
  "srd52:feature/improved-critical": improvedCritical(19),
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
  "phb:feature/paladin-paladin-s-smite": {
    automation: "partial",
    spells: { 2: ["phb:spell/divine-smite"] },
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
  // Subclass spell tables. Circle of the Land is left out, as its list depends on a land the player doesn't pick yet.
  "phb:feature/cleric-life-domain-life-domain-spells": prepared({
    3: [
      "phb:spell/aid",
      "phb:spell/bless",
      "phb:spell/cure-wounds",
      "phb:spell/lesser-restoration",
    ],
    5: ["phb:spell/mass-healing-word", "phb:spell/revivify"],
    7: ["phb:spell/aura-of-life", "phb:spell/death-ward"],
    9: ["phb:spell/greater-restoration", "phb:spell/mass-cure-wounds"],
  }),
  "phb:feature/cleric-light-domain-light-domain-spells": prepared({
    3: [
      "phb:spell/burning-hands",
      "phb:spell/faerie-fire",
      "phb:spell/scorching-ray",
      "phb:spell/see-invisibility",
    ],
    5: ["phb:spell/daylight", "phb:spell/fireball"],
    7: ["phb:spell/arcane-eye", "phb:spell/wall-of-fire"],
    9: ["phb:spell/flame-strike", "phb:spell/scrying"],
  }),
  "phb:feature/cleric-trickery-domain-trickery-domain-spells": prepared({
    3: [
      "phb:spell/charm-person",
      "phb:spell/disguise-self",
      "phb:spell/invisibility",
      "phb:spell/pass-without-trace",
    ],
    5: ["phb:spell/hypnotic-pattern", "phb:spell/nondetection"],
    7: ["phb:spell/confusion", "phb:spell/dimension-door"],
    9: ["phb:spell/dominate-person", "phb:spell/modify-memory"],
  }),
  "phb:feature/cleric-war-domain-war-domain-spells": prepared({
    3: [
      "phb:spell/guiding-bolt",
      "phb:spell/magic-weapon",
      "phb:spell/shield-of-faith",
      "phb:spell/spiritual-weapon",
    ],
    5: ["phb:spell/crusader-s-mantle", "phb:spell/spirit-guardians"],
    7: ["phb:spell/fire-shield", "phb:spell/freedom-of-movement"],
    9: ["phb:spell/hold-monster", "phb:spell/steel-wind-strike"],
  }),
  "phb:feature/druid-circle-of-the-moon-circle-of-the-moon-spells": prepared({
    3: ["phb:spell/cure-wounds", "phb:spell/moonbeam", "phb:spell/starry-wisp"],
    5: ["phb:spell/conjure-animals"],
    7: ["phb:spell/fount-of-moonlight"],
    9: ["phb:spell/mass-cure-wounds"],
  }),
  "phb:feature/druid-circle-of-the-sea-circle-of-the-sea-spells": prepared({
    3: [
      "phb:spell/fog-cloud",
      "phb:spell/gust-of-wind",
      "phb:spell/ray-of-frost",
      "phb:spell/shatter",
      "phb:spell/thunderwave",
    ],
    5: ["phb:spell/lightning-bolt", "phb:spell/water-breathing"],
    7: ["phb:spell/control-water", "phb:spell/ice-storm"],
    9: ["phb:spell/conjure-elemental", "phb:spell/hold-monster"],
  }),
  "phb:feature/paladin-oath-of-devotion-oath-of-devotion-spells": prepared({
    3: ["phb:spell/protection-from-evil-and-good", "phb:spell/shield-of-faith"],
    5: ["phb:spell/aid", "phb:spell/zone-of-truth"],
    9: ["phb:spell/beacon-of-hope", "phb:spell/dispel-magic"],
    13: ["phb:spell/freedom-of-movement", "phb:spell/guardian-of-faith"],
    17: ["phb:spell/commune", "phb:spell/flame-strike"],
  }),
  "phb:feature/paladin-oath-of-glory-oath-of-glory-spells": prepared({
    3: ["phb:spell/guiding-bolt", "phb:spell/heroism"],
    5: ["phb:spell/enhance-ability", "phb:spell/magic-weapon"],
    9: ["phb:spell/haste", "phb:spell/protection-from-energy"],
    13: ["phb:spell/compulsion", "phb:spell/freedom-of-movement"],
    17: ["phb:spell/legend-lore", "phb:spell/yolande-s-regal-presence"],
  }),
  "phb:feature/paladin-oath-of-the-ancients-oath-of-the-ancients-spells":
    prepared({
      3: ["phb:spell/ensnaring-strike", "phb:spell/speak-with-animals"],
      5: ["phb:spell/misty-step", "phb:spell/moonbeam"],
      9: ["phb:spell/plant-growth", "phb:spell/protection-from-energy"],
      13: ["phb:spell/ice-storm", "phb:spell/stoneskin"],
      17: ["phb:spell/commune-with-nature", "phb:spell/tree-stride"],
    }),
  "phb:feature/paladin-oath-of-vengeance-oath-of-vengeance-spells": prepared({
    3: ["phb:spell/bane", "phb:spell/hunter-s-mark"],
    5: ["phb:spell/hold-person", "phb:spell/misty-step"],
    9: ["phb:spell/haste", "phb:spell/protection-from-energy"],
    13: ["phb:spell/banishment", "phb:spell/dimension-door"],
    17: ["phb:spell/hold-monster", "phb:spell/scrying"],
  }),
  "phb:feature/ranger-fey-wanderer-fey-wanderer-spells": prepared({
    3: ["phb:spell/charm-person"],
    5: ["phb:spell/misty-step"],
    9: ["phb:spell/summon-fey"],
    13: ["phb:spell/dimension-door"],
    17: ["phb:spell/mislead"],
  }),
  "phb:feature/ranger-gloom-stalker-gloom-stalker-spells": prepared({
    3: ["phb:spell/disguise-self"],
    5: ["phb:spell/rope-trick"],
    9: ["phb:spell/fear"],
    13: ["phb:spell/greater-invisibility"],
    17: ["phb:spell/seeming"],
  }),
  "phb:feature/sorcerer-aberrant-sorcery-psionic-spells": prepared({
    3: [
      "phb:spell/arms-of-hadar",
      "phb:spell/calm-emotions",
      "phb:spell/detect-thoughts",
      "phb:spell/dissonant-whispers",
      "phb:spell/mind-sliver",
    ],
    5: ["phb:spell/hunger-of-hadar", "phb:spell/sending"],
    7: ["phb:spell/evard-s-black-tentacles", "phb:spell/summon-aberration"],
    9: ["phb:spell/rary-s-telepathic-bond", "phb:spell/telekinesis"],
  }),
  "phb:feature/sorcerer-clockwork-sorcery-clockwork-spells": prepared({
    3: [
      "phb:spell/aid",
      "phb:spell/alarm",
      "phb:spell/lesser-restoration",
      "phb:spell/protection-from-evil-and-good",
    ],
    5: ["phb:spell/dispel-magic", "phb:spell/protection-from-energy"],
    7: ["phb:spell/freedom-of-movement", "phb:spell/summon-construct"],
    9: ["phb:spell/greater-restoration", "phb:spell/wall-of-force"],
  }),
  "phb:feature/sorcerer-draconic-sorcery-draconic-spells": prepared({
    3: [
      "phb:spell/alter-self",
      "phb:spell/chromatic-orb",
      "phb:spell/command",
      "phb:spell/dragon-s-breath",
    ],
    5: ["phb:spell/fear", "phb:spell/fly"],
    7: ["phb:spell/arcane-eye", "phb:spell/charm-monster"],
    9: ["phb:spell/legend-lore", "phb:spell/summon-dragon"],
  }),
  "phb:feature/warlock-archfey-patron-archfey-spells": prepared({
    3: [
      "phb:spell/calm-emotions",
      "phb:spell/faerie-fire",
      "phb:spell/misty-step",
      "phb:spell/phantasmal-force",
      "phb:spell/sleep",
    ],
    5: ["phb:spell/blink", "phb:spell/plant-growth"],
    7: ["phb:spell/dominate-beast", "phb:spell/greater-invisibility"],
    9: ["phb:spell/dominate-person", "phb:spell/seeming"],
  }),
  "phb:feature/warlock-celestial-patron-celestial-spells": prepared({
    3: [
      "phb:spell/aid",
      "phb:spell/cure-wounds",
      "phb:spell/guiding-bolt",
      "phb:spell/lesser-restoration",
      "phb:spell/light",
      "phb:spell/sacred-flame",
    ],
    5: ["phb:spell/daylight", "phb:spell/revivify"],
    7: ["phb:spell/guardian-of-faith", "phb:spell/wall-of-fire"],
    9: ["phb:spell/greater-restoration", "phb:spell/summon-celestial"],
  }),
  "phb:feature/warlock-fiend-patron-fiend-spells": prepared({
    3: [
      "phb:spell/burning-hands",
      "phb:spell/command",
      "phb:spell/scorching-ray",
      "phb:spell/suggestion",
    ],
    5: ["phb:spell/fireball", "phb:spell/stinking-cloud"],
    7: ["phb:spell/fire-shield", "phb:spell/wall-of-fire"],
    9: ["phb:spell/geas", "phb:spell/insect-plague"],
  }),
  "phb:feature/warlock-great-old-one-patron-great-old-one-spells": prepared({
    3: [
      "phb:spell/detect-thoughts",
      "phb:spell/dissonant-whispers",
      "phb:spell/phantasmal-force",
      "phb:spell/tasha-s-hideous-laughter",
    ],
    5: ["phb:spell/clairvoyance", "phb:spell/hunger-of-hadar"],
    7: ["phb:spell/confusion", "phb:spell/summon-aberration"],
    9: ["phb:spell/modify-memory", "phb:spell/telekinesis"],
  }),
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

// shortcut: gated by character level, which is the class level until multiclassing.
export function grantedSpells(
  featureId: string,
  level: number,
): readonly string[] {
  return Object.entries(RULES[featureId]?.spells ?? {}).flatMap(
    ([from, ids]) => (Number(from) <= level ? ids : []),
  );
}
