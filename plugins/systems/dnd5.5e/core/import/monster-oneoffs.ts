import {
  ConditionSchema,
  DAMAGE_TYPES,
  type Amount,
  type Condition,
  type Damage,
  type Duration,
  type LeafEffect,
  type Passive,
  type Resolution,
} from "../schemas.ts";
import { slugOf } from "./spells.ts";

// Monster entries that are one of a kind, or nearly (issue #117): the traits, actions and legendary actions the
// general readers in monsters.ts don't know, read from their own wording. Notes are in our own words.

type DamageType = Damage["type"];

interface Parsed {
  readonly targeting: unknown;
  readonly resolution: Resolution;
}

// The general readers, passed in so this module doesn't import monsters.ts.
export interface Readers {
  readonly parseSave: (text: string, left: string[]) => Parsed | null;
  readonly parseAttack: (text: string, left: string[]) => Parsed | null;
}

export interface OneOff {
  readonly actions: unknown[];
  readonly passives: Passive[];
  readonly notes: string[];
}

type AbilityKey = "str" | "dex" | "con" | "int" | "wis" | "cha";
const ABILITY: Readonly<Record<string, AbilityKey | undefined>> = {
  Strength: "str",
  Dexterity: "dex",
  Constitution: "con",
  Intelligence: "int",
  Wisdom: "wis",
  Charisma: "cha",
};

const typeOf = (word: string | undefined): DamageType | undefined =>
  DAMAGE_TYPES.find((type) => type === word?.toLowerCase());

const typesIn = (text: string): DamageType[] =>
  DAMAGE_TYPES.filter((type) => new RegExp(`\\b${type}\\b`, "i").test(text));

const conditionOf = (word: string | undefined): Condition | undefined =>
  ConditionSchema.safeParse(word?.toLowerCase()).data;

const flat = (value: number) => ({ bonus: { base: value, add: [] } });

// "16 (2d10 + 5)" as its dice, or a bare number.
function amountIn(printed: string): Amount {
  const [, dice, sign, plus] =
    /\((\d+d\d+)(?:\s*([+−-])\s*(\d+))?\)/.exec(printed) ?? [];
  if (!dice) return flat(Number(/\d+/.exec(printed)?.[0] ?? 0));
  return {
    dice,
    ...(plus
      ? { bonus: { base: Number(plus) * (sign === "+" ? 1 : -1), add: [] } }
      : {}),
  };
}

const self = { self: true } as const;

const automatic = (
  effects: LeafEffect[],
  damage: Damage[] = [],
): Resolution => ({
  kind: "automatic",
  damage,
  effects,
});

// "until the start of the giant's next turn" or "of its next turn", from the bearer's side.
function untilIn(text: string): Duration | null {
  const [, edge = "", whose = ""] =
    /\buntil the (start|end) of ([^.;]*?)\s*next turn\b/i.exec(text) ?? [];
  if (!edge) return null;
  const theirs = /^(?:its|the target[’']s|their)$/i.test(whose.trim());
  const start = edge.toLowerCase() === "start";
  return {
    until: theirs
      ? start
        ? "itsNextTurnStart"
        : "itsNextTurnEnd"
      : start
        ? "yourNextTurnStart"
        : "yourNextTurnEnd",
  };
}

const mark = (text: string): LeafEffect => ({
  kind: "modifier",
  modifier: { kind: "mark" },
  duration: untilIn(text) ?? { text: "until it ends" },
});

// Effects in a failed save or a hit the general readers don't take: Exhaustion levels, a curse or a hold another
// action looks for, and Confusion's roll for what the target does.
export function riderEffects(text: string): LeafEffect[] {
  const exhaustion = /\bgains (\d+|one) Exhaustion levels?\b/i.exec(text)?.[1];
  const cursed =
    /\b(?:the target is cursed|is cursed by|attaches (?:itself )?to the target)\b/i.exec(
      text,
    );
  const confused = /\brolls 1d8 to determine what it does\b/i.test(text);
  return [
    ...(exhaustion
      ? [
          {
            kind: "exhaustion" as const,
            levels: exhaustion === "one" ? 1 : Number(exhaustion),
          },
        ]
      : []),
    ...(cursed ? [mark(text.slice(cursed.index, cursed.index + 120))] : []),
    ...(confused
      ? [
          {
            kind: "modifier" as const,
            modifier: { kind: "confused" as const },
            duration: { until: "itsNextTurnEnd" as const },
          },
          // "can't take Reactions until the start of the umber hulk's next turn", which the d8 roll keeps from the
          // general reader.
          ...(/\bcan[’']t take Reactions\b/.test(text)
            ? [
                {
                  kind: "modifier" as const,
                  modifier: {
                    kind: "actionLimit" as const,
                    noReactions: true as const,
                  },
                  duration: untilIn(text) ?? { minutes: 1 },
                },
              ]
            : []),
        ]
      : []),
  ];
}

// What happens on either result of a save: riders as above, or Advantage on attacks against the target until a turn
// ends or starts, as an animal lord's Marked as Prey.
export function eitherEffects(text: string): LeafEffect[] {
  if (!text) return [];
  const prey =
    /\bhas Advantage on attack rolls against the target until the (?:start|end) of [^.]+? next turn\b/.test(
      text,
    );
  return [
    ...riderEffects(text),
    ...(prey
      ? [
          {
            kind: "modifier" as const,
            modifier: {
              kind: "advantage" as const,
              on: "attacksAgainst" as const,
              casterOnly: true as const,
            },
            duration: untilIn(text) ?? { until: "yourNextTurnStart" as const },
          },
        ]
      : []),
  ];
}

// Traits a grid fight never needs, beyond the ones monsters.ts knows: winding keys, senses for things far off,
// coming back days later, water and mirrors the map doesn't have, coven spells, heights the grid doesn't have.
export const NO_COMBAT_ONE_OFF =
  /^(?:Wind-Up Operation|Chardalyn Sense|Next of the Seven|Detect Intelligence|Mist Walker|Water Bound|Invisible in Water|Water Susceptibility|Transparent|Skeletonize|Cavities|Troll Spawn|Blight Seeds|Unholy Regrowth|Far Realm Parasite|Reborn by Blood|Coven Magic|Jiangshi Weaknesses|Fear of Its Own Reflection|Susceptible to Holy Symbols|Confer Fire Resistance|Shape Control)$/;

// Actions and Bonus Actions a grid fight never needs: telepathy, reading minds and emotions, objects, travel
// between planes or through trees, heights, lights it lights itself with, and Tool checks.
const NO_COMBAT_ACTION =
  /^(?:Rapport Spores|Animating Spores|Heart Sight|Destroy Metal|Weird Insight|Chime|Ethereal Stride|Fluid Form|Vow of Revenge|Ignited Illumination|Float|Ascend|Swoop|Tree Stride)$/;

// --- Traits ---

export function oneOffTrait(label: string, text: string): OneOff | null {
  const name = label.replace(/\s*\(.*$/, "");
  const passives = traitPassives(name, text);
  if (passives) {
    // A comeback with a random boon, as a priest of Osybus's tattoo, keeps only the comeback.
    const boon = /\brandom boon\b/.test(text)
      ? [
          `partial: ${name}: left out its random boon${/\bis now Undead\b/.test(text) ? " and becoming Undead" : ""}`,
        ]
      : [];
    return { actions: [], passives, notes: [...traitNotes(name), ...boon] };
  }
  if (NO_COMBAT_ONE_OFF.test(name)) {
    return { actions: [], passives: [], notes: [`no combat use: ${label}`] };
  }
  // Played by another entry: the cube's Engulf, the hydra's heads, the lord's Forager variant.
  const playedBy: Record<string, string> = {
    "Ooze Cube": "creatures walking into it, who meet its Engulf",
    "Reactive Heads": "",
    "Animal Lordship": `the other variants, as a ${VARIANT} is played`,
  };
  if (name in playedBy) {
    const left = playedBy[name];
    return {
      actions: [],
      passives: [],
      notes: left ? [`partial: ${name}: left out ${left}`] : [],
    };
  }
  // Another variant's effect than the one played.
  if (
    /\((?:Forager|Hunter|Sage) Only\)$/.test(label) &&
    !label.includes(`(${VARIANT} Only)`)
  ) {
    return {
      actions: [],
      passives: [],
      notes: [`no combat use: ${label} (another variant)`],
    };
  }
  return null;
}

function traitNotes(name: string): string[] {
  const left: Record<string, string> = {
    "Bloodied Wild Magic": "dealing Force damage instead",
    "Spiteful Escape": "its anathema",
    "Reflective Carapace": "turning a spell back on its caster",
    "Lightning Conduit":
      "passing the damage on and regaining Lightning Discharge",
    "Multiple Heads": "a turn's total damage, as one hit of it kills a head",
    "Aberrant Surge":
      "the odd rolls' Force damage, as every roll is taken as Temporary Hit Points",
    "False Appearance": "telling it apart by a check",
  };
  return left[name] ? [`partial: ${name}: left out ${left[name]}`] : [];
}

const whileBloodied = <T extends Passive>(passive: T): T => ({
  ...passive,
  bloodied: true,
});

function traitPassives(name: string, text: string): Passive[] | null {
  // "regains 10 Hit Points at the start of each of its turns if it is Bloodied and has at least 1 Hit Point"
  const survivor =
    /\bregains (\d+) Hit Points at the start of each of its turns if it is Bloodied\b/.exec(
      text,
    )?.[1];
  if (survivor) {
    return [
      whileBloodied({
        kind: "regeneration",
        hp: Number(survivor),
        stoppedBy: [],
      }),
    ];
  }
  // "At the start of each of its turns, if … has at least 1 Hit Point, it regains 10 Hit Points and can end one
  // condition on itself."
  const metabolic =
    /^At the start of each of its turns, if [^.]+ has at least 1 Hit Point, it regains (\d+) Hit Points and can end one condition on itself\b/.exec(
      text,
    )?.[1];
  if (metabolic) {
    return [
      {
        kind: "regeneration",
        hp: Number(metabolic),
        stoppedBy: [],
        cures: true,
      },
    ];
  }
  const bloodied =
    /^While Bloodied, [^.,]+? has (.+?)\.?$/.exec(text)?.[1] ?? "";
  if (/^Advantage on saving throws$/.test(bloodied)) {
    return [
      {
        kind: "saveAdvantage",
        abilities: ["str", "dex", "con", "int", "wis", "cha"],
        conditions: [],
        bloodied: true,
      },
    ];
  }
  const immune = /^Immunity to the (.+?) conditions?$/.exec(bloodied)?.[1];
  if (immune) {
    return immune.split(/,? and |, /).flatMap((word) => {
      const condition = conditionOf(word);
      return condition
        ? [whileBloodied({ kind: "conditionImmunity", condition })]
        : [];
    });
  }
  const resists = /^Resistance to (.+?) damage$/.exec(bloodied)?.[1];
  if (resists) {
    return typesIn(resists).map((damage) =>
      whileBloodied({
        kind: "modifier",
        modifier: { kind: "resistance", damage },
      }),
    );
  }
  // Undead Fortitude's save under another name, with the damage that gets through: Mechanical Determination.
  const fortitude =
    /^If damage reduces [^.]+ to 0 Hit Points, it makes a Constitution saving throw with a DC of 5 plus the damage taken,? unless the damage is (\w+) or from a Critical Hit\b/.exec(
      text,
    )?.[1];
  const fortitudeType = typeOf(fortitude);
  if (fortitudeType && name !== "Undead Fortitude") {
    return [{ kind: "undeadFortitude", except: [fortitudeType] }];
  }
  // "Magic can't put the drow to sleep", alone or after Fey Ancestry's Charmed saves.
  if (/\bmagic can[’']t put [^.]+ to sleep\b/i.test(text)) {
    return [
      ...(/Advantage on saving throws (?:it makes )?to avoid or end the Charmed condition/i.test(
        text,
      )
        ? [
            {
              kind: "saveAdvantage" as const,
              abilities: [],
              conditions: ["charmed" as const],
            },
          ]
        : []),
      { kind: "spellImmunity", spells: ["srd52:spell/sleep"] },
    ];
  }
  // "If the flumph receives the Prone condition, roll a die. On an odd number, it has the Incapacitated condition. At
  // the end of each of its turns, the flumph makes a DC 10 Dexterity saving throw, ending the Incapacitated …"
  const deficient =
    /^If [^.]+ receives the Prone condition, roll a die\. On an odd number, it has the Incapacitated condition\. At the end of each of its turns, [^.]+ makes a DC (\d+) (\w+) saving throw\b/.exec(
      text,
    );
  const deficientAbility = deficient?.[2];
  if (deficient && deficientAbility && ABILITY[deficientAbility]) {
    return [
      {
        kind: "proneDeficiency",
        ability: ABILITY[deficientAbility],
        dc: Number(deficient[1]),
      },
    ];
  }
  // "If targeted by dispel magic, the horror must succeed on a Constitution saving throw against the caster's spell
  // save DC or fall unconscious for 1 minute or until it takes any damage."
  if (
    /^If targeted by dispel magic, [^.]+ must succeed on a Constitution saving throw against the caster[’']s spell save DC or fall unconscious\b/i.test(
      text,
    )
  ) {
    return [{ kind: "dispelShutdown", condition: "unconscious" }];
  }
  // "… at the start of combat, it has advantage on its initiative roll." A monster stands still until the fight starts.
  if (
    /\bat the start of combat\b[^.]*\bhas advantage on its initiative roll\b/i.test(
      text,
    )
  ) {
    return [{ kind: "initiativeAdvantage" }];
  }
  // "When the ruffian casts Witch Bolt, roll 1d8. On an even number, the ruffian gains a number of Temporary Hit
  // Points equal to the number rolled."
  const surge =
    /^When [^.]+ casts ([^,]+), roll (1d\d+)\. On an even number, [^.]+ gains a number of Temporary Hit Points equal to the number rolled\./.exec(
      text,
    );
  const surgeType = typeOf(SPELL_DAMAGE[surge?.[1] ?? ""]);
  if (surge?.[2] && surgeType) {
    return [
      {
        kind: "castRider",
        damage: surgeType,
        effects: [{ kind: "tempHp", amount: { dice: surge[2] } }],
      },
    ];
  }
  if (name === "Evocation Sculptor") {
    const others = /\bup to (\w+) other creatures\b/.exec(text)?.[1];
    return [{ kind: "sculptor", creatures: countOf(others) ?? 1 }];
  }
  // "takes Cold damage, its Speed decreases by 20 feet until the end of its next turn", with Disadvantage on saves.
  const slowed =
    /^If (?:the|an?) [^.]+? takes (\w+) damage, (?:until the end of its next turn, )?its Speed decreases by (\d+) feet(?: until the end of its next turn)?( and it has Disadvantage on saving throws)?/.exec(
      text,
    );
  const slowedType = typeOf(slowed?.[1]);
  if (slowed && slowedType) {
    return [
      {
        kind: "onDamage",
        damage: [slowedType],
        modifiers: [
          {
            kind: "bonus",
            to: "speed",
            amount: flat(Number(slowed[2])),
            subtract: true,
          },
          ...(slowed[3]
            ? [{ kind: "disadvantage" as const, on: "saves" as const }]
            : []),
        ],
      },
    ];
  }
  if (
    /^Attack rolls against [^.]+ are made with Disadvantage unless [^.]+ has the Incapacitated condition\.?$/.test(
      text,
    )
  ) {
    return [{ kind: "ward", suppressed: "incapacitated" }];
  }
  if (
    /^Whenever [^.]+ starts its turn Bloodied, roll 1d6\. On a 6, [^.]+ goes berserk\b/.test(
      text,
    )
  ) {
    return [{ kind: "berserk" }];
  }
  if (
    /^[^.]+ has Disadvantage on saving throws to avoid or end the Charmed condition\.?$/.test(
      text,
    )
  ) {
    return [{ kind: "saveDisadvantage", conditions: ["charmed"] }];
  }
  // "The ground in a 10-foot Emanation originating from the mouther is Difficult Terrain."
  const ground =
    /^The ground in a (\d+)-foot Emanation originating from [^.]+ is Difficult Terrain\.?$/.exec(
      text,
    )?.[1];
  if (ground) {
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: Number(ground),
        area: { difficult: true },
      },
    ];
  }
  // "At the start of each of its turns, the devil deals 5 (1d10) Piercing damage to any creature it is grappling or
  // any creature grappling it."
  const barbs =
    /^At the start of each of its turns, [^.]+? deals (\d+ \(\d+d\d+(?: \+ \d+)?\)) (\w+) damage to any creature it is grappling or any creature grappling it\b/.exec(
      text,
    );
  const barbType = typeOf(barbs?.[2]);
  if (barbs?.[1] && barbType) {
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: 5,
        area: {
          when: "ownerTurnStart",
          grappling: true,
          resolution: automatic(
            [],
            [{ amount: amountIn(barbs[1]), type: barbType }],
          ),
        },
      },
    ];
  }
  // A gibbering mouther's babble: Confusion's roll for those that start their turns near it.
  const babble =
    /^[^.]+ babbles [^.]* while it doesn[’']t have the Incapacitated condition\. (\w+) Saving Throw: DC (\d+), any creature that starts its turn within (\d+) feet of\b/.exec(
      text,
    );
  const babbleAbility = babble?.[1];
  if (babble && babbleAbility && ABILITY[babbleAbility]) {
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: Number(babble[3]),
        area: {
          when: "turnStart",
          awake: true,
          // shortcut: a failure confuses its next turn, as the roll this one makes is already behind it.
          resolution: {
            kind: "save",
            ability: ABILITY[babbleAbility],
            dc: { base: Number(babble[2]), add: [] },
            damage: [],
            onSuccessDamage: "none",
            onFail: riderEffects(text),
            onSuccess: [],
          },
        },
      },
    ];
  }
  // "Wisdom Saving Throw: DC 11, any Beast or Humanoid that starts its turn within 30 feet of the hag and can see …
  // Failure: … Frightened condition until the start of its next turn. Success: … immune … for 24 hours."
  const appearance =
    /^(\w+) Saving Throw: DC (\d+), any ((?:\w+ or )?\w+) that starts its turn within (\d+) feet of [^.]+?\. Failure: The target has the (\w+) condition until the start of its next turn\. Success: The target is immune\b/.exec(
      text,
    );
  const appearanceAbility = appearance?.[1];
  const appearanceCondition = conditionOf(appearance?.[5]);
  if (
    appearance &&
    appearanceAbility &&
    ABILITY[appearanceAbility] &&
    appearanceCondition
  ) {
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: Number(appearance[4]),
        area: {
          when: "turnStart",
          creatureTypes: (appearance[3] ?? "").toLowerCase().split(" or "),
          resolution: {
            kind: "save",
            ability: ABILITY[appearanceAbility],
            dc: { base: Number(appearance[2]), add: [] },
            damage: [],
            onSuccessDamage: "none",
            onFail: [
              {
                kind: "applyCondition",
                condition: appearanceCondition,
                duration: { until: "itsNextTurnStart" },
                repeatSave: false,
                endsOnDamage: false,
              },
            ],
            onSuccess: [
              {
                kind: "modifier",
                modifier: { kind: "areaImmunity" },
                duration: { minutes: 1440 },
              },
            ],
          },
        },
      },
    ];
  }
  // A curse on everyone near when it dies: "Charisma Saving Throw: DC 13, each creature in a 5-foot Emanation
  // originating from the wanderer when it dies. Failure: The target is cursed. While cursed, … Blinded and Deafened".
  const curse =
    /^(\w+) Saving Throw: DC (\d+), each creature in a (\d+)-foot Emanation originating from [^.]+? when it dies\. Failure: The target is cursed\. While cursed, the target has the ((?:\w+ and )?\w+) conditions?\b/.exec(
      text,
    );
  const curseAbility = curse?.[1];
  if (curse && curseAbility && ABILITY[curseAbility]) {
    return [
      {
        kind: "deathBurst",
        name,
        radius: Number(curse[3]),
        resolution: {
          kind: "save",
          ability: ABILITY[curseAbility],
          dc: { base: Number(curse[2]), add: [] },
          damage: [],
          onSuccessDamage: "none",
          onFail: (curse[4] ?? "").split(" and ").flatMap((word) => {
            const condition = conditionOf(word);
            return condition
              ? [
                  {
                    kind: "applyCondition" as const,
                    condition,
                    duration: { text: "until the curse ends" },
                    repeatSave: false,
                    endsOnDamage: false,
                  },
                ]
              : [];
          }),
          onSuccess: [],
        },
      },
    ];
  }
  // A hag that drops goes away instead of dying, cursing those within 60 feet with Disadvantage on checks and saves.
  const escape =
    /\bdrops to 1 Hit Point and teleports to [^.]+?\..*?\beach creature within (\d+) feet of the space it left is cursed\. Until the curse ends, a creature has Disadvantage on ability checks and saving throws\b/.exec(
      text,
    )?.[1];
  if (escape) {
    return [
      {
        kind: "deathBurst",
        name,
        radius: Number(escape),
        resolution: automatic(
          (["checks", "saves"] as const).map((on) => ({
            kind: "modifier",
            modifier: { kind: "disadvantage", on },
            duration: { text: "until the curse ends" },
          })),
        ),
      },
    ];
  }
  // "The hydra has five heads. Whenever the hydra takes 25 damage or more on a single turn, one of its heads dies.
  // … grows two heads … unless it has taken Fire damage … regains 20 Hit Points when it grows new heads."
  const heads =
    /^The [^.]+ has (\w+) heads\. Whenever [^.]+ takes (\d+) damage or more on a single turn, one of its heads dies\..*?\bgrows (\w+) heads for each of its heads that died\b[^.]*?\bunless it has taken (\w+) damage\b.*?\bregains (\d+) Hit Points\b/s.exec(
      text,
    );
  if (heads) {
    const stop = typeOf(heads[4]);
    return [
      {
        kind: "heads",
        heads: countOf(heads[1]) ?? 1,
        damage: Number(heads[2]),
        regrow: countOf(heads[3]) ?? 1,
        heal: Number(heads[5]),
        stoppedBy: stop ? [stop] : [],
      },
    ];
  }
  // "If the tarrasque is targeted by a Magic Missile spell or a spell that requires a ranged attack roll, roll 1d6.
  // On a 1–5, the tarrasque is unaffected." A 6 leaves it unaffected too.
  if (
    /^If [^.]+ is targeted by a Magic Missile spell or a spell that requires a ranged attack roll, roll 1d6\. On a 1[–-]5, [^.]+ is unaffected\. On a 6, [^.]+ is unaffected\b/.test(
      text,
    )
  ) {
    return [
      {
        kind: "spellImmunity",
        spells: ["srd52:spell/magic-missile"],
        rangedAttacks: true,
      },
    ];
  }
  // "If the yggdrasti is subjected to lightning damage, it is unhurt"
  const unhurt = /^If [^.]+ is subjected to (\w+) damage, it is unhurt\b/i.exec(
    text,
  )?.[1];
  const unhurtType = typeOf(unhurt);
  if (unhurtType) {
    return [
      { kind: "modifier", modifier: { kind: "immunity", damage: unhurtType } },
    ];
  }
  // Coming back at once, as another stat block or as itself: Suppressed Lycanthropy, Tattoo of Osybus.
  const becomes =
    /^If reduced to 0 Hit Points, [^.]+ succumbs to lycanthropy\. Her statistics are replaced by those of the (\w+) stat block\b.*\brevives\b[^.]*\bwith all her Hit Points\b/s.exec(
      text,
    )?.[1];
  if (becomes) {
    return [
      {
        kind: "reborn",
        monster: `monster-manual:monster/${becomes.toLowerCase()}`,
        hp: "full",
      },
    ];
  }
  if (
    /^If damage reduces [^.]+ to 0 Hit Points, it receives a random boon\..*\brevives at the start of its next turn with half its Hit Points\b/s.test(
      text,
    )
  ) {
    return [{ kind: "reborn", hp: "half" }];
  }
  return null;
}

// The damage type of the spells a cast rider is printed for.
const SPELL_DAMAGE: Record<string, string> = { "Witch Bolt": "lightning" };

const COUNT: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const countOf = (word: string | undefined): number | undefined =>
  word === undefined
    ? undefined
    : (COUNT[word.toLowerCase()] ??
      (/^\d+$/.test(word) ? Number(word) : undefined));

// --- Actions and Bonus Actions ---

interface Known {
  readonly name: string;
  readonly activation: {
    readonly cost: readonly unknown[];
    readonly targeting: unknown;
    readonly resolution: Resolution;
  };
}

const COST = { actions: "action", "bonus actions": "bonusAction" } as const;

export function oneOffAction(
  label: string,
  text: string,
  section: "actions" | "bonus actions",
  known: readonly unknown[],
  readers: Readers,
  speed = 0, // its walking Speed
  block = "", // the whole stat block, for a choice a trait makes
): OneOff | null {
  const name = label.replace(/\s*\(.*$/, "");
  // Carrying a willing friend about, as a gadabout's Wrap, is no fight's business either.
  if (
    NO_COMBAT_ACTION.test(name) ||
    /^[^.]+ enters the space of a willing\b/.test(text)
  ) {
    return { actions: [], passives: [], notes: [`no combat use: ${label}`] };
  }
  const recharge = /\(Recharge (\d)/.exec(label)?.[1];
  const perDay = /\((\d+)\/Day\b/.exec(label)?.[1];
  const resource = `${perDay ? "day" : "recharge"}:${slugOf(name)}`;
  const cost = [COST[section], ...(recharge || perDay ? [{ resource }] : [])];
  const limits = {
    ...(recharge ? { recharge: Number(recharge) } : {}),
    ...(perDay ? { perDay: Number(perDay) } : {}),
  };
  const notes: string[] = [];
  const one = (
    targeting: unknown,
    resolution: Resolution,
    extra: Record<string, unknown> = {},
  ): OneOff => ({
    actions: [
      {
        name,
        ...limits,
        activation: { cost, ...extra, targeting, resolution },
      },
    ],
    passives: [],
    notes,
  });
  const passive = (item: Passive): OneOff => ({
    actions: [],
    passives: [item],
    notes,
  });
  const actions = known as readonly Known[];

  // Moves: "moves up to half its Swim Speed without provoking Opportunity Attacks" and the like, as a Dash.
  const moves =
    /^(?:While underwater, )?[^.]+? (?:moves|swims) up to (half )?its (?:\w+ )?Speed(?: straight toward an enemy it can see)?( without provoking Opportunity Attacks)?\.(.*)$/.exec(
      text,
    );
  // As an action it's the Dash and Disengage actions in one, as a seahorse's.
  if (
    section === "actions" &&
    moves?.[2] &&
    !moves[1] &&
    !recharge &&
    !perDay
  ) {
    if (text.startsWith("While underwater"))
      notes.push(`partial: ${name}: left out needing water`);
    return one(self, automatic([{ kind: "dash" }, { kind: "disengage" }]));
  }
  if (section === "bonus actions" && moves && !recharge && !perDay) {
    if (text.startsWith("While underwater"))
      notes.push(`partial: ${name}: left out needing water`);
    if ((moves[3] ?? "").trim())
      notes.push(`partial: ${name}: left out what follows it`);
    return passive({
      kind: "bonusTactics",
      tactics: ["dash"],
      ...(moves[1] ? { half: true as const } : {}),
      ...(moves[2] ? { safe: true as const } : {}),
    });
  }
  // "The jiangshi takes the Dash action." with a label that limits it.
  if (
    section === "bonus actions" &&
    /^[^.]+ takes the Dash action\.?$/.test(text)
  ) {
    notes.push(`partial: ${name}: left out what it requires`);
    return passive({ kind: "bonusTactics", tactics: ["dash"] });
  }
  // "The golem takes the Dash and Disengage actions."
  if (/^[^.]+ takes the Dash and Disengage actions\.?$/.test(text)) {
    return one(self, automatic([{ kind: "dash" }, { kind: "disengage" }]));
  }
  // Rampage: "Immediately after dealing damage to a creature that is already Bloodied, the gnoll moves up to half its
  // Speed, and it makes one Bite attack."
  const rampage =
    /^Immediately after dealing damage to a creature that (?:is|was) already Bloodied, [^.]+? makes one ([^.]+?) attack\.?$/.exec(
      text,
    )?.[1];
  const bite = rampage
    ? actions.find((action) => action.name === rampage)
    : undefined;
  if (bite?.activation.resolution.kind === "attack") {
    notes.push(`partial: ${name}: left out its move of half its Speed`);
    return one(
      { ...(bite.activation.targeting as object), bloodied: true },
      bite.activation.resolution,
      { afterAction: true },
    );
  }
  // "The gnoll targets another creature it can see within 60 feet of itself that has the Rampage Bonus Action. The
  // target can take a Reaction to make one melee attack."
  const incite =
    /^[^.]+ targets another creature it can see within (\d+) feet of itself that has the [^.]+\. The target can take a Reaction to make one melee attack\.?$/.exec(
      text,
    )?.[1];
  if (incite) {
    return one(
      { creatures: 1, range: Number(incite), side: "ally" },
      automatic([{ kind: "reactionAttack" }]),
    );
  }
  const slaying = slayingSave(text);
  if (slaying) {
    for (const reason of slaying.left)
      notes.push(`partial: ${name}: left out ${reason}`);
    return one(slaying.targeting, slaying.resolution);
  }
  // Temporary Hit Points for itself, or for itself or an ally, with what comes with them.
  const boon = boonOf(text);
  if (boon) {
    for (const reason of boon.left)
      notes.push(`partial: ${name}: left out ${reason}`);
    return one(boon.targeting, automatic(boon.effects));
  }
  // Invisible: "The agent has the Invisible condition until the start of its next turn. This invisibility ends early
  // immediately after the agent makes an attack roll."
  const unseen = invisibleOf(text);
  if (unseen) {
    for (const reason of unseen.left)
      notes.push(`partial: ${name}: left out ${reason}`);
    return one(self, automatic([unseen.effect]));
  }
  // "The ettercap pulls one creature within 30 feet of itself that is Restrained by its Web Strand up to 25 feet
  // straight toward itself." or "pulls each creature Grappled by it up to 30 feet straight toward it."
  const reel =
    /^[^.]+ pulls (one|each) creature (?:within (\d+) feet of itself )?(?:that is )?(Restrained|Grappled|grappled) by (?:it|its [^.]+?) up to (\d+) feet straight toward (?:it|itself)\.?$/.exec(
      text,
    );
  const reeled = conditionOf(reel?.[3]);
  if (reel && reeled) {
    return one(
      {
        creatures: reel[1] === "one" ? 1 : 6,
        range: Number(reel[2] ?? reel[4]),
        side: "enemy",
        targetConditions: [reeled],
      },
      automatic([
        { kind: "forcedMove", feet: Number(reel[4]), direction: "toward" },
      ]),
    );
  }
  // "magically animates up to two trees it can see within 60 feet of itself. Each tree uses the Treant stat block,
  // except … it lacks this action."
  const animates =
    /^[^.]+ magically animates (?:up to )?(one or two|\w+) [^.]+? it can see within (\d+) feet of itself\. Each [^.]+ uses the [^.]+ stat block, except\b[^.]*\blacks this action\b/.exec(
      text,
    );
  if (animates) {
    notes.push(`partial: ${name}: left out its end when the animator dies`);
    return one(
      self,
      automatic([
        {
          kind: "animate",
          count: animates[1] === "one or two" ? 2 : (countOf(animates[1]) ?? 1),
          range: Number(animates[2]),
          lacks: [name],
        },
      ]),
    );
  }
  // "animates a soul tattoo on its body that becomes a Shadow in an unoccupied space within 5 feet"
  const tattoo =
    /^[^.]+ magically animates [^.]+ that becomes an? (\w+) in an unoccupied space within (\d+) feet of\b/.exec(
      text,
    );
  if (tattoo?.[1]) {
    return one(
      self,
      automatic([
        {
          kind: "animate",
          monster: `monster-manual:monster/${tattoo[1].toLowerCase()}`,
          count: 1,
          range: Number(tattoo[2]),
          lacks: [],
        },
      ]),
    );
  }
  // "touches one creature within 5 feet. If the creature has 80 Hit Points or fewer, it dies. Otherwise, it takes 52
  // (8d12) Necrotic damage."
  const death =
    /^[^.]+ touches one creature within (\d+) feet\. If the creature has (\d+) Hit Points or fewer, it dies\. Otherwise, it takes (\d+ \(\d+d\d+(?: \+ \d+)?\)) (\w+) damage\.?$/.exec(
      text,
    );
  const deathType = typeOf(death?.[4]);
  if (death?.[3] && deathType) {
    return one(
      { creatures: 1, range: Number(death[1]), side: "enemy" },
      automatic(
        [{ kind: "slay", hpAtMost: Number(death[2]) }],
        [{ amount: amountIn(death[3]), type: deathType }],
      ),
    );
  }
  // Magical Darkness round itself while it concentrates: "Magical Darkness fills a 15-foot Emanation originating from
  // the darkmantle. This effect lasts while the darkmantle maintains Concentration on it, up to 10 minutes."
  const dark =
    /^Magical Darkness fills a (\d+)-foot Emanation originating from [^.]+\. This effect lasts while [^.]+ maintains Concentration on it, up to (\d+) minutes\b/.exec(
      text,
    );
  if (dark) {
    return one(
      self,
      automatic([
        {
          kind: "zone",
          zone: "darkness",
          radius: Number(dark[1]),
          duration: { concentration: true, minutes: Number(dark[2]) },
          follows: true,
        },
      ]),
    );
  }
  // "The K-Nine gains Blindsight to a range of 60 feet. … This benefit lasts for 1 minute": seeing what hides.
  const blindsight =
    /^[^.]+ gains Blindsight to a range of (\d+) feet\..*?\blasts for (\d+) minutes?\b/s.exec(
      text,
    );
  if (blindsight) {
    notes.push(`partial: ${name}: left out seeing through thin walls`);
    return one(
      self,
      automatic([
        {
          kind: "modifier",
          modifier: {
            kind: "darkvision",
            feet: Number(blindsight[1]),
            truesight: true,
          },
          duration: { minutes: Number(blindsight[2]) },
        },
      ]),
    );
  }
  // "Each creature with the Poisoned condition within a 30-foot Emanation originating from the priest takes 3 (1d6)
  // Poison damage."
  const intensify =
    /^Each creature with the (\w+) condition within a (\d+)-foot Emanation originating from [^.]+ takes (\d+ \(\d+d\d+(?: \+ \d+)?\)) (\w+) damage\.?$/.exec(
      text,
    );
  const intensified = conditionOf(intensify?.[1]);
  const intensifyType = typeOf(intensify?.[4]);
  if (intensify?.[3] && intensified && intensifyType) {
    return one(
      {
        area: { shape: "emanation", radius: Number(intensify[2]) },
        range: "self",
        side: "enemy",
        targetConditions: [intensified],
      },
      automatic([], [{ amount: amountIn(intensify[3]), type: intensifyType }]),
    );
  }
  // "Each creature cursed by the hag and within 60 feet of it takes 14 (4d6) Lightning damage."
  const strike =
    /^Each creature cursed by [^.]+? and within (\d+) feet of it takes (\d+ \(\d+d\d+(?: \+ \d+)?\)) (\w+) damage\.?$/.exec(
      text,
    );
  const strikeType = typeOf(strike?.[3]);
  const curser = actions.find((action) =>
    JSON.stringify(action.activation.resolution).includes('"mark"'),
  );
  if (strike?.[2] && strikeType && curser) {
    return one(
      {
        area: { shape: "emanation", radius: Number(strike[1]) },
        range: "self",
        side: "enemy",
        afflicted: curser.name,
      },
      automatic([], [{ amount: amountIn(strike[2]), type: strikeType }]),
    );
  }
  // "The beast shape-shifts into its land form, sea form, or sky form and regains 9 (2d8) Hit Points."
  const recuperates =
    /^[^.]+ shape-shifts into [^.]+? and regains (\d+ \(\d+d\d+(?: \+ \d+)?\)) Hit Points\b/.exec(
      text,
    )?.[1];
  if (recuperates) {
    notes.push(`partial: ${name}: left out the shape it takes`);
    return one(
      self,
      automatic([{ kind: "heal", amount: amountIn(recuperates) }]),
    );
  }
  // "28 (8d6) damage of the type chosen for the Draconic Origin trait": the first type that trait offers.
  const chosenType =
    /\bdamage of the type chosen for the ([^.]+?) trait\b/.exec(text);
  const offered = chosenType
    ? new RegExp(
        `${chosenType[1] ?? ""}\\. [^\\n]*?\\(DM[’']s choice\\): (\\w+)`,
      ).exec(block)?.[1]
    : undefined;
  if (chosenType && offered) {
    const left: string[] = [];
    const parsed = readers.parseSave(
      text.replace(chosenType[0], `${offered} damage`),
      left,
    );
    if (parsed) {
      notes.push(
        `partial: ${name}: left out the other types, as ${offered} is chosen`,
      );
      for (const reason of new Set(left))
        notes.push(`partial: ${name}: left out ${reason}`);
      return one(parsed.targeting, parsed.resolution);
    }
  }
  // "The spider teleports from the Material Plane to the Ethereal Plane or vice versa." Out and back in where it
  // wants, as a teleport as far as it walks.
  if (
    /^[^.]+ teleports from the Material Plane to the Ethereal Plane or vice versa\.?$/.test(
      text,
    ) &&
    speed > 0
  ) {
    notes.push(
      `partial: ${name}: left out its time out of reach on the Ethereal Plane`,
    );
    return one(
      self,
      automatic([{ kind: "teleport", feet: speed, movement: 0 }]),
    );
  }
  // Mother's Visage: an 8-hour form whose end frightens those near. "When Lorinda reverts to her true form, each
  // creature in a 30-foot Emanation originating from Lorinda is subjected to the following effect. Wisdom Saving Throw:
  // DC 14 (…). Failure: …"
  const reverts =
    /\bWhen [^.]+ reverts to (?:her|his|its) true form, each creature in a (\d+)-foot Emanation originating from [^.]+ is subjected to the following effect\. (\w+ Saving Throw: DC \d+)(?: \([^)]*\))?\. (Failure: .*)$/s.exec(
      text,
    );
  if (reverts) {
    const left: string[] = [];
    const parsed = readers.parseSave(
      `${reverts[2] ?? ""}, each creature in a ${reverts[1] ?? ""}-foot Emanation originating from it. ${reverts[3] ?? ""}`,
      left,
    );
    if (parsed) {
      notes.push(
        `partial: ${name}: left out the form and its Charm Person, as the fear of its end comes when it's taken`,
      );
      for (const reason of new Set(left))
        notes.push(`partial: ${name}: left out ${reason}`);
      return one(parsed.targeting, parsed.resolution);
    }
  }
  const more = particularAction(name, text, actions, readers, speed);
  if (more) {
    for (const reason of more.left)
      notes.push(`partial: ${name}: left out ${reason}`);
    return {
      actions: more.actions.map((item, index) => ({
        name: index === 0 ? name : `${name} (${String(index + 1)})`,
        ...limits,
        ...item,
        activation: { cost, ...(item.activation as object) },
      })),
      passives: [],
      notes,
    };
  }
  // First, Second and Third Roar: one use each, as the uses come in that order.
  // shortcut: their order isn't kept, so any one that's left can come next.
  const sequence = /^(.*?):\s*(•\s*First\b.*)$/s.exec(text);
  if (sequence && perDay) {
    const steps = optionsOf(sequence[2] ?? "");
    const parsed = steps.flatMap((step) => {
      const left: string[] = [];
      const item = readers.parseSave(step.text, left);
      for (const reason of new Set(left))
        notes.push(`partial: ${step.name}: left out ${reason}`);
      return item ? [{ step, item }] : [];
    });
    if (parsed.length === steps.length && parsed.length > 1) {
      return {
        actions: parsed.map(({ step, item }) => ({
          name: step.name, // "First Roar", as each was named before it was read

          perDay: 1,
          activation: {
            cost: [COST[section], { resource: `day:${slugOf(step.name)}` }],
            targeting: item.targeting,
            resolution: item.resolution,
          },
        })),
        passives: [],
        notes,
      };
    }
  }
  // A roll for one of several effects: "roll 1d4 to determine damage type: 1—Acid; 2—Fire; …", or numbered options
  // "1: Insect Hive. … 2: …", each its own action picked at random.
  const rolled = rolledOptions(label, name, text, cost, limits, readers);
  if (rolled) return rolled;
  // Options of a save's failure, the monster's choice: "Failure: The target is subjected to the song's effect:
  // Charming. … Frightening. …" or a Syringe's serums, each an action of its own sharing the recharge.
  const chosen = chosenOptions(name, text, cost, limits, readers);
  if (chosen) return chosen;
  return null;
}

// Temporary Hit Points, for itself ("the archmage gains 40 Temporary Hit Points") or for itself or one creature
// ("The giant or one creature of its choice … gains …", "The unicorn targets itself or one creature it can see
// within 60 feet of itself. The target gains …"), with Advantage, AC or a nap that comes with them.
function boonOf(text: string): {
  targeting: unknown;
  effects: LeafEffect[];
  left: string[];
} | null {
  const gains =
    /\bgains (\d+(?: \(\d+d\d+(?: \+ \d+)?\))?) Temporary Hit Points\b/.exec(
      text,
    );
  if (!gains?.[1] || /Saving Throw|Attack Roll|Hit:/.test(text)) return null;
  const range = /\bwithin (\d+) feet\b/.exec(text)?.[1];
  const shared =
    /\bor one creature\b/.test(text) ||
    /^The [^.]+ targets itself or\b/.test(text);
  const targeting = shared
    ? { creatures: 1, range: Number(range ?? 60), side: "ally" }
    : self;
  const until = untilIn(text);
  const lasting = until ?? { minutes: 1 };
  const effects: LeafEffect[] = [
    { kind: "tempHp", amount: amountIn(gains[1]) },
  ];
  const left: string[] = [];
  if (/\bhas Advantage on attack rolls\b/.test(text)) {
    effects.push({
      kind: "modifier",
      modifier: { kind: "advantage", on: "attacks" },
      duration: lasting,
    });
  }
  const ac = /\bAC increases by (\d+)\b/.exec(text)?.[1];
  if (ac) {
    effects.push({
      kind: "modifier",
      modifier: { kind: "bonus", to: "ac", amount: flat(Number(ac)) },
      duration: lasting,
    });
  }
  // "has the Unconscious condition until it takes damage or the end of its next turn"
  if (/\bhas the Unconscious condition until it takes damage\b/.test(text)) {
    effects.push({
      kind: "applyCondition",
      condition: "unconscious",
      duration: { until: "yourNextTurnEnd" },
      repeatSave: false,
      endsOnDamage: true,
    });
  }
  const edge =
    /\bhas Advantage on ability checks and saving throws for (\d+) minutes?\b/.exec(
      text,
    )?.[1];
  if (edge) {
    for (const on of ["checks", "saves"] as const) {
      effects.push({
        kind: "modifier",
        modifier: { kind: "advantage", on },
        duration: { minutes: Number(edge) },
      });
    }
  }
  // What else the sentence holds is reported, never guessed at.
  // A gain shared with others, "and each ally within 30 feet of it gain Advantage on D20 Tests", is left out.
  const gainSentence = /[^.]*\bgains \d+[^.]*\./.exec(text)?.[0] ?? "";
  if (
    /,? and (?:the [^.,]+ and )?each (?:ally|creature)\b/.test(gainSentence)
  ) {
    left.push("what it gives others");
  }
  const rest = text
    .replace(/[^.]*\bgains \d+[^.]*\./, "")
    .replace(/[^.]*\bhas Advantage on ability checks[^.]*\./, "")
    .replace(
      /^[^.]*\b(?:bolsters itself|restorative slumber|targets itself or one creature)[^.]*\./,
      "",
    )
    .replace(/[^.]*can[’']t take this action again[^.]*\./, "")
    .trim();
  if (rest) left.push("what follows it");
  return { targeting, effects, left };
}

// The Invisible condition on itself, until its next turn, while it concentrates, or until it ends it.
function invisibleOf(
  text: string,
): { effect: LeafEffect; left: string[] } | null {
  const [first = ""] = text.split(/\.\s/);
  const own =
    !/\b(?:target|teleports?)\b/.test(first) &&
    /^(?:The )?[^.]*?\b(?:(?:has|have|gives (?:itself|herself|himself)) the Invisible condition|magically turn invisible)\b/.test(
      first,
    );
  if (!own) return null;
  const left: string[] = [];
  if (/\bone creature riding it\b/.test(text)) left.push("its rider");
  if (/\bcan fly up to half\b/.test(text)) left.push("its flight");
  const duration = /\bConcentration\b|\bconcentration\b/.test(text)
    ? { concentration: true as const, minutes: 10 }
    : (untilIn(text) ?? { text: "until it ends it" });
  return {
    effect: {
      kind: "applyCondition",
      condition: "invisible",
      duration,
      repeatSave: false,
      endsOnDamage: false,
      ...(/\b(?:makes an attack roll|attacks|deals damage)\b/.test(text)
        ? { endsOn: "attack" as const }
        : {}),
    },
    left,
  };
}

// "(roll 1d4 to determine damage type: 1—Acid; 2—Fire; 3—Lightning; 4—Thunder)" in a save, or "roll 1d4" before
// numbered options "1: Insect Hive. …". The parent picks one at random at its target; the options are `rolled`.
function rolledOptions(
  label: string,
  name: string,
  text: string,
  cost: readonly unknown[],
  limits: Record<string, number>,
  readers: Readers,
): OneOff | null {
  const typed = /\(roll 1d\d+ to determine damage type: ([^)]+)\)/.exec(text);
  const notes: string[] = [];
  const options: { name: string; text: string }[] = [];
  let parentText = text;
  if (typed?.[1]) {
    const types = [...typed[1].matchAll(/\d+\s*[—–-]\s*(\w+)/g)].flatMap((m) =>
      typeOf(m[1]) ? [m[1] ?? ""] : [],
    );
    for (const type of types) {
      options.push({
        name: `${name} (${type})`,
        text: text.replace(/(\)) damage\s*\(roll [^)]*\)/, `$1 ${type} damage`),
      });
    }
  } else {
    // "1: Insect Hive. …" as printed in a line, or "• Insect Hive. …" from a list under the entry (monsters.ts).
    const parts = text.split(/\s(?:\d:|•) ([A-Z][^.:]{1,40})\.\s/);
    if (parts.length < 5 || !/\broll 1d\d+\b/.test(parts[0] ?? "")) return null;
    parentText = parts[0] ?? "";
    for (let at = 1; at + 1 < parts.length; at += 2) {
      options.push({ name: parts[at] ?? "", text: parts[at + 1] ?? "" });
    }
  }
  if (options.length < 2) return null;
  // The parent's own target: "targeting a creature he can see within 120 feet", or else the options' widest range.
  const reach = Number(/\bwithin (\d+) feet\b/.exec(parentText)?.[1] ?? 0);
  const rolled: unknown[] = [];
  for (const option of options) {
    const left: string[] = [];
    // An option with no target of its own takes the parent's.
    const withTarget =
      /Saving Throw: DC \d+\.\s/.test(option.text) && reach
        ? option.text.replace(
            /(Saving Throw: DC \d+)\.\s/,
            `$1, one creature it can see within ${String(reach)} feet. `,
          )
        : option.text;
    const parsed =
      readers.parseSave(withTarget, left) ??
      readers.parseAttack(withTarget, left);
    if (!parsed) {
      notes.push(`partial: ${name}: left out ${option.name}`);
      continue;
    }
    for (const reason of new Set(left)) {
      notes.push(`partial: ${option.name}: left out ${reason}`);
    }
    rolled.push({
      name: option.name,
      rolled: true,
      activation: {
        cost: [],
        targeting: parsed.targeting,
        resolution: parsed.resolution,
      },
    });
  }
  if (rolled.length < 2) return null;
  const widest = Math.max(
    reach,
    ...rolled.map((item) => {
      const targeting = (
        item as { activation: { targeting: { range?: unknown } } }
      ).activation.targeting;
      return typeof targeting.range === "number" ? targeting.range : 5;
    }),
  );
  if (/\bWhile Bloodied, [^.]+ manifests two\b/.test(parentText)) {
    notes.push(`partial: ${name}: left out a second roll while Bloodied`);
  }
  return {
    actions: [
      {
        name,
        ...limits,
        activation: {
          cost,
          targeting: { creatures: 1, range: widest, side: "enemy" },
          resolution: automatic([
            {
              kind: "randomAction",
              of: rolled.map((item) => (item as { name: string }).name),
              times: 1,
            },
          ]),
        },
      },
      ...rolled,
    ],
    passives: [],
    notes,
  };
}

// A save whose failure is one of the monster's choice of effects, printed after it as "Name. effect" entries: each
// is an action of its own, with the same save, sharing one recharge or use.
function chosenOptions(
  name: string,
  text: string,
  cost: readonly unknown[],
  limits: Record<string, number>,
  readers: Readers,
): OneOff | null {
  const split =
    /^(.*?\bFailure:\s*)(?:The target is subjected to [^.:]+:|(.*?)While [^.]+?, the target suffers one of the following effects \([^)]*\)\.(.*?):)\s*(•.+)$/s.exec(
      text,
    );
  if (!split) return null;
  const [, save = "", before = "", after = "", list = ""] = split;
  const options = optionsOf(list);
  if (options.length < 2) return null;
  const notes: string[] = [];
  const actions: unknown[] = [];
  options.forEach((option, index) => {
    const left: string[] = [];
    const parsed = readers.parseSave(
      `${save}${before}${option.text}${after}`,
      left,
    );
    if (!parsed) {
      notes.push(`partial: ${name}: left out ${option.name}`);
      return;
    }
    for (const reason of new Set(left)) {
      notes.push(`partial: ${option.name}: left out ${reason}`);
    }
    // An effect that comes with a condition the target repeats saves against ends with it, as a serum with its poison.
    const repeats = /\brepeats the save\b/.test(after);
    const resolution =
      repeats && parsed.resolution.kind === "save"
        ? {
            ...parsed.resolution,
            onFail: parsed.resolution.onFail.map((effect) =>
              effect.kind === "modifier"
                ? { ...effect, repeatSave: true }
                : effect,
            ),
          }
        : parsed.resolution;
    actions.push({
      name: `${name} (${option.name})`,
      // Options share one recharge, which only the first rolls for.
      ...(index === 0
        ? limits
        : "perDay" in limits
          ? { perDay: limits.perDay }
          : {}),
      activation: { cost, targeting: parsed.targeting, resolution },
    });
  });
  return actions.length > 0 ? { actions, passives: [], notes } : null;
}

// "• Charming. The target … • Frightening. …": the entries folded under their parent (monsters.ts).
export function optionsOf(list: string): { name: string; text: string }[] {
  return list.split(/\s*•\s*/).flatMap((item) => {
    const match = /^([^.]{1,60})\.\s+(.*)$/s.exec(item);
    return match
      ? [{ name: match[1] ?? "", text: (match[2] ?? "").trim() }]
      : [];
  });
}

// The variant a stat block that names several plays as ("(Hunter Only)"): the one it's DM's choice of. A Hunter's
// effects can all be played, while a Forager's Temporary Hit Points ride a save that can't give them.
export const VARIANT = "Hunter";

const damaged = (printed: string, type: DamageType): Damage => ({
  amount: amountIn(printed),
  type,
});
const DICE = String.raw`\d+ \(\d+d\d+(?: [+−-] \d+)?\)`;

// Actions worded too much their own way for any reader above: each returns the activation (without its cost).
function particularAction(
  name: string,
  text: string,
  actions: readonly Known[],
  readers: Readers,
  speed: number,
): {
  actions: { activation: unknown; name?: string; rolled?: true }[];
  left: string[];
} | null {
  const left: string[] = [];
  const done = (targeting: unknown, resolution: Resolution) => ({
    actions: [{ activation: { targeting, resolution } }],
    left,
  });
  // "raises a Medium or Small Humanoid corpse within 5 feet of itself and possesses it. … gains 50 Temporary Hit
  // Points, and its statistics are the same, except its Speed increases to 30 feet"
  const possess =
    /\braises a [^.]*?corpse within \d+ feet of itself and possesses it\..*?\bgains (\d+) Temporary Hit Points, and its statistics are the same, except its Speed increases to (\d+) feet\b/s.exec(
      text,
    );
  if (possess) {
    left.push("needing a corpse", "the possession's end");
    return done(
      self,
      automatic([
        { kind: "tempHp", amount: flat(Number(possess[1])) },
        {
          kind: "modifier",
          modifier: {
            kind: "bonus",
            to: "speed",
            amount: flat(Math.max(0, Number(possess[2]) - speed)),
          },
          duration: { text: "while it possesses the corpse" },
        },
      ]),
    );
  }
  // A spear whose hit leaves "a dire wound": its Speed is reduced by 10 feet, and it loses 5 (1d10) Hit Points at the
  // start of each of its turns, for a minute.
  const wound =
    /^(.*?Hit: [^.]*?damage) and the target receives a [^.]*wound[^.]*\. While the target is wounded, its speed is reduced by (\d+) feet, and it loses (\d+ \((\d+d\d+)\)) Hit Points at the start of each of its turns\. The wound closes after (\d+) minutes?\b/s.exec(
      text,
    );
  if (wound) {
    const parsed = readers.parseAttack(`${wound[1] ?? ""}.`, left);
    if (parsed?.resolution.kind === "attack") {
      left.push("closing the wound with a check or healing");
      const lasting = { minutes: Number(wound[5]) };
      const resolution: Resolution = {
        ...parsed.resolution,
        onHit: [
          ...parsed.resolution.onHit,
          {
            kind: "modifier",
            modifier: {
              kind: "bonus",
              to: "speed",
              amount: flat(Number(wound[2])),
              subtract: true,
            },
            duration: lasting,
          },
          // shortcut: Hit Points lost are taken as Necrotic damage, which few creatures resist.
          {
            kind: "modifier",
            modifier: {
              kind: "lingeringDamage",
              when: "turnStart",
              damage: [
                { amount: { dice: wound[4] ?? "1d10" }, type: "necrotic" },
              ],
              once: false,
            },
            duration: lasting,
          },
        ],
      };
      const ranged = (parsed as { thrownRange?: number }).thrownRange;
      return {
        actions: [
          { activation: { targeting: parsed.targeting, resolution } },
          ...(ranged
            ? [
                {
                  name: `${name} (ranged)`,
                  activation: {
                    targeting: {
                      ...(parsed.targeting as object),
                      range: ranged,
                    },
                    resolution,
                  },
                },
              ]
            : []),
        ],
        left,
      };
    }
  }
  // "Ez chooses up to six allies within 60 feet. Each target that can hear her has Ez's choice of (A) Advantage on the
  // next attack roll it makes before the end of its next turn or (B) Resistance to Acid, Necrotic, and Poison damage
  // until the end of its next turn."
  const bolster =
    /^[^.]+ chooses up to (\w+) allies within (\d+) feet\. Each target that can hear [^.]+ has [^.]+ choice of \(A\) Advantage on the next attack roll it makes before the end of its next turn or \(B\) Resistance to (.+?) damage until the end of its next turn\.?$/.exec(
      text,
    );
  if (bolster) {
    const targeting = {
      creatures: countOf(bolster[1]) ?? 1,
      range: Number(bolster[2]),
      side: "ally",
    };
    const until = { until: "itsNextTurnEnd" } as const;
    return {
      actions: [
        {
          activation: {
            targeting,
            resolution: automatic([
              {
                kind: "modifier",
                modifier: { kind: "advantage", on: "attacks", once: true },
                duration: until,
              },
            ]),
          },
        },
        {
          name: `${name} (Resistance)`,
          activation: {
            targeting,
            resolution: automatic(
              typesIn(bolster[3] ?? "").map((damage) => ({
                kind: "modifier",
                modifier: { kind: "resistance", damage },
                duration: until,
              })),
            ),
          },
        },
      ],
      left,
    };
  }
  // "Ez chooses up to six allies within 60 feet. Each target that can hear her can take a Reaction to move up to its
  // Speed without provoking Opportunity Attacks."
  const rally =
    /^[^.]+ chooses up to (\w+) allies within (\d+) feet\. Each target that can hear [^.]+ can take a Reaction to move up to its Speed without provoking Opportunity Attacks\.?$/.exec(
      text,
    );
  if (rally) {
    left.push("where they move, as each goes beside its nearest foe");
    return done(
      {
        creatures: countOf(rally[1]) ?? 1,
        range: Number(rally[2]),
        side: "ally",
      },
      automatic([{ kind: "reactionMove" }]),
    );
  }
  // "Ez chooses a damage type. Wisdom Saving Throw: DC 15, one target within 30 feet that Ez can see. Failure: The
  // target is cursed. Until the curse ends, the target has Vulnerability to the chosen damage type."
  const vulnerable =
    /^[^.]+ chooses a damage type\. (.*?Failure: The target is cursed\.) Until the curse ends, the target has Vulnerability to the chosen damage type\./s.exec(
      text,
    );
  if (vulnerable) {
    const own = actions
      .map((action) => action.activation.resolution)
      .flatMap((resolution) =>
        "damage" in resolution ? resolution.damage : [],
      )[0]?.type;
    const parsed = readers.parseSave(vulnerable[1] ?? "", left);
    if (parsed?.resolution.kind === "save" && own) {
      left.push("choosing the type, as its own damage's is chosen");
      return done(parsed.targeting, {
        ...parsed.resolution,
        onFail: [
          ...parsed.resolution.onFail,
          {
            kind: "modifier",
            modifier: { kind: "vulnerability", damage: own },
            duration: { text: "until the curse ends" },
          },
        ],
      });
    }
  }
  // "magically marks one creature it can see within 150 feet. The mark lasts for 1 hour … has Advantage on attack
  // rolls against the target"
  const marked =
    /^[^.]+ magically marks one creature it can see within (\d+) feet\. The mark lasts for (\d+) hours?\b.*?\bhas Advantage on attack rolls against the target\b/s.exec(
      text,
    );
  if (marked) {
    left.push("seeing it while it's Invisible");
    return done(
      { creatures: 1, range: Number(marked[1]), side: "enemy" },
      automatic([
        {
          kind: "modifier",
          modifier: {
            kind: "advantage",
            on: "attacksAgainst",
            casterOnly: true,
          },
          duration: { minutes: Number(marked[2]) * 60 },
        },
      ]),
    );
  }
  // "emits an antimagic wave in a 150-foot Cone. Until the start of the beholder's next turn, that area acts as an
  // Antimagic Field spell"
  const antimagic =
    /\bemits an antimagic wave in a (\d+)-foot Cone\. Until the start of [^.]+ next turn, that area acts as an Antimagic Field spell\b/.exec(
      text,
    )?.[1];
  if (antimagic) {
    left.push("magic items and effects in it", "its hold on its own rays");
    return done(
      {
        area: { shape: "cone", radius: Number(antimagic) },
        range: "self",
        side: "enemy",
      },
      automatic([
        {
          kind: "modifier",
          modifier: { kind: "actionLimit", spellFailure: 100 },
          duration: { until: "yourNextTurnStart" },
        },
      ]),
    );
  }
  // "targets one creature of its size or smaller in its space. The target must succeed on a DC 16 Dexterity saving
  // throw or be imprisoned in a demiplane."
  const prison =
    /^[^.]+ targets one creature of its size or smaller in its space\. The target must succeed on a DC (\d+) (\w+) saving throw or be imprisoned\b/.exec(
      text,
    );
  const prisonAbility = prison?.[2];
  if (prison && prisonAbility && ABILITY[prisonAbility]) {
    left.push("its release as a Bonus Action");
    return done(
      { creatures: 1, range: 5, side: "enemy" },
      {
        kind: "save",
        ability: ABILITY[prisonAbility],
        dc: { base: Number(prison[1]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        onFail: [
          {
            kind: "modifier",
            modifier: { kind: "sealed" },
            duration: { text: "until released" },
          },
        ],
        onSuccess: [],
      },
    );
  }
  // "Ranged Weapon Attack: +13 to hit, reach 120 ft., one creature. Hit: The target is grappled (escape DC 18)."
  const strand =
    /^(?:Melee|Ranged) Weapon Attack: \+(\d+) to hit, (?:reach|range) (\d+) ft\.[^.]*\. Hit: The target is grappled \(escape DC \d+\)\./.exec(
      text,
    );
  if (strand) {
    left.push("its own escape DC", "attacking the strand");
    return done(
      { creatures: 1, range: Number(strand[2]), side: "enemy" },
      {
        kind: "attack",
        attack: { type: "weapon", flatBonus: Number(strand[1]) },
        damage: [{ amount: flat(0), type: "bludgeoning" }],
        onHit: [
          {
            kind: "applyCondition",
            condition: "grappled",
            duration: { text: "until it escapes" },
            repeatSave: false,
            endsOnDamage: false,
          },
        ],
        onMiss: [],
      },
    );
  }
  // "Charisma Saving Throw: DC 17, each creature in a 60-foot Cone. Failure: The target is teleported inside the
  // revenant's space and swallowed."
  const invited =
    /^(\w+) Saving Throw: DC (\d+), each creature in a (\d+)-foot Cone\. Failure: The target is teleported inside [^.]+ space and swallowed\./.exec(
      text,
    );
  const invitedAbility = invited?.[1];
  if (invited && invitedAbility && ABILITY[invitedAbility]) {
    return done(
      {
        area: { shape: "cone", radius: Number(invited[3]) },
        range: "self",
        side: "enemy",
      },
      {
        kind: "save",
        ability: ABILITY[invitedAbility],
        dc: { base: Number(invited[2]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        // Taken out of any grapple and held inside: a swallow (combat/swallow.ts).
        onFail: [
          { kind: "removeCondition", condition: "grappled" },
          mark("until it gets out"),
        ],
        onSuccess: [],
      },
    );
  }
  // "moves up to its Speed and can move through the spaces of Huge or smaller creatures … Strength Saving Throw: DC
  // 23, each creature or object whose space the blob enters … Failure: The target is engulfed. … takes 21 (6d6) Force
  // damage at the start of each of its turns, is suffocating, has the Restrained condition, and repeats the save"
  const engulf = new RegExp(
    String.raw`^[^.]+ moves up to its Speed and can move through the spaces of [^.]+\. (\w+) Saving Throw: DC (\d+), each creature or object whose space [^.]+\. Failure: The target is engulfed\..*?\btakes (${DICE}) (\w+) damage at the start of each of its turns, is suffocating, has the Restrained condition, and repeats the save\b`,
    "s",
  ).exec(text);
  const engulfAbility = engulf?.[1];
  const engulfType = typeOf(engulf?.[4]);
  if (engulf?.[3] && engulfAbility && ABILITY[engulfAbility] && engulfType) {
    left.push(
      "its move through creatures, as it engulfs those beside it",
      "suffocating",
    );
    const lasting = { text: "while engulfed" } as const;
    return done(
      { area: { shape: "emanation", radius: 5 }, range: "self", side: "enemy" },
      {
        kind: "save",
        ability: ABILITY[engulfAbility],
        dc: { base: Number(engulf[2]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        onFail: [
          { kind: "removeCondition", condition: "grappled" },
          {
            kind: "applyCondition",
            condition: "restrained",
            duration: lasting,
            repeatSave: true,
            endsOnDamage: false,
          },
          {
            kind: "modifier",
            modifier: {
              kind: "lingeringDamage",
              when: "turnStart",
              damage: [damaged(engulf[3], engulfType)],
              once: false,
            },
            duration: lasting,
            repeatSave: true,
          },
        ],
        onSuccess: [],
      },
    );
  }
  // "Constitution Saving Throw: DC 15, one Bloodied creature within 5 feet. Constructs and Undead automatically
  // succeed on this save. Failure: The target is possessed by the necrichor"
  const puppet =
    /^(\w+) Saving Throw: DC (\d+), one Bloodied creature within (\d+) feet\. [^.]* automatically succeed on this save\. Failure: The target is possessed by\b/.exec(
      text,
    );
  const puppetAbility = puppet?.[1];
  if (puppet && puppetAbility && ABILITY[puppetAbility]) {
    left.push(
      "the possessor hiding in the body and moving it",
      "the types that succeed",
    );
    return done(
      { creatures: 1, range: Number(puppet[3]), side: "enemy", bloodied: true },
      {
        kind: "save",
        ability: ABILITY[puppetAbility],
        dc: { base: Number(puppet[2]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        onFail: [
          {
            kind: "applyCondition",
            condition: "incapacitated",
            duration: { text: "until the possession ends" },
            repeatSave: false,
            endsOnDamage: false,
          },
        ],
        onSuccess: [],
      },
    );
  }
  // "conjures a whirlwind at a point it can see within 120 feet. The whirlwind fills a 20-foot-radius, 60-foot-high
  // Cylinder … Strength Saving Throw: DC 17 (…). Failure: While in the whirlwind, the target has the Restrained
  // condition"
  const whirl =
    /^[^.]+ conjures a whirlwind at a point it can see within (\d+) feet\. The whirlwind fills a (\d+)-foot-radius\b.*?(\w+) Saving Throw: DC (\d+)\b[^.]*\. Failure: While in the whirlwind, the target has the Restrained condition\b/s.exec(
      text,
    );
  const whirlAbility = whirl?.[3];
  if (whirl && whirlAbility && ABILITY[whirlAbility]) {
    left.push(
      "moving the whirlwind and carrying those inside",
      "catching those who walk in later",
    );
    // "At the start of each of its turns, the Restrained target takes 21 (6d6) Thunder damage."
    const pounding = new RegExp(
      String.raw`\bAt the start of each of its turns, the Restrained target takes (${DICE}) (\w+) damage\b`,
    ).exec(text);
    const poundType = typeOf(pounding?.[2]);
    const whirled = { concentration: true, minutes: 1 } as const;
    return done(
      {
        area: { shape: "sphere", radius: Number(whirl[2]) },
        range: Number(whirl[1]),
        side: "enemy",
      },
      {
        kind: "save",
        ability: ABILITY[whirlAbility],
        dc: { base: Number(whirl[4]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        onFail: [
          {
            kind: "applyCondition",
            condition: "restrained",
            duration: whirled,
            repeatSave: true,
            endsOnDamage: false,
          },
          ...(pounding?.[1] && poundType
            ? [
                {
                  kind: "modifier" as const,
                  modifier: {
                    kind: "lingeringDamage" as const,
                    when: "turnStart" as const,
                    damage: [damaged(pounding[1], poundType)],
                    once: false,
                  },
                  duration: whirled,
                  repeatSave: true,
                },
              ]
            : []),
        ],
        onSuccess: [],
      },
    );
  }
  // "Dexterity Saving Throw: DC 10, one creature … within 15 feet. Failure: The target is coated in a foul-smelling
  // liquid, exudes a stench for 1d4 hours, and has the Poisoned condition while the stench lasts."
  const stench =
    /^(\w+ Saving Throw: DC \d+, [^.]+?\.) Failure: The target is coated in [^,]+, exudes a stench for 1d4 hours, and has the Poisoned condition while the stench lasts\./.exec(
      text,
    )?.[1];
  if (stench) {
    const parsed = readers.parseSave(
      `${stench} Failure: The target has the Poisoned condition for 1 hour.`,
      left,
    );
    if (parsed) {
      left.push("the stench round the target");
      return done(parsed.targeting, parsed.resolution);
    }
  }
  // "Strength Saving Throw: DC 15, one Medium or Small creature … within 5 feet. Failure: The target is pulled into
  // the necrohulk's space and becomes grafted to its body. … While grafted, the target has the Restrained condition and
  // Disadvantage on Constitution saving throws."
  const graft =
    /^(\w+ Saving Throw: DC \d+), one Medium or Small creature ([^.]+?)\. Failure: The target is pulled into [^.]+ and becomes grafted to its body\..*?While grafted, the target has the Restrained condition and Disadvantage on (\w+) saving throws\./s.exec(
      text,
    );
  const graftAbility = graft?.[3];
  if (graft && graftAbility && ABILITY[graftAbility]) {
    const parsed = readers.parseSave(
      `${graft[1] ?? ""}, one Medium or smaller creature ${graft[2] ?? ""}. Failure: The target has the Restrained condition.`,
      left,
    );
    if (parsed?.resolution.kind === "save") {
      left.push(
        "pulling it in and its escape check",
        "healing when the grafted dies",
      );
      const lasting = { text: "while grafted" } as const;
      return done(parsed.targeting, {
        ...parsed.resolution,
        onFail: [
          {
            kind: "applyCondition",
            condition: "restrained",
            duration: lasting,
            repeatSave: false,
            endsOnDamage: false,
          },
          {
            kind: "modifier",
            modifier: {
              kind: "disadvantage",
              on: "saves",
              ability: ABILITY[graftAbility],
            },
            duration: lasting,
          },
        ],
      });
    }
  }
  // "The parasite deals 12 (3d6 + 2) necrotic damage to one creature it is physically attached to … regains hit
  // points equal to the damage taken."
  const drains = new RegExp(
    String.raw`^[^.]+ deals (${DICE}) (\w+) damage to one creature it is physically attached to\b`,
    "i",
  ).exec(text);
  const drainType = typeOf(drains?.[2]);
  const holder = actions.find((action) =>
    JSON.stringify(action.activation.resolution).includes('"mark"'),
  );
  if (drains?.[1] && drainType && holder) {
    left.push("its healing", "the types it can't feed on");
    return done(
      { creatures: 1, range: 5, side: "enemy", afflicted: holder.name },
      automatic([], [damaged(drains[1], drainType)]),
    );
  }
  return null;
}

// --- Reactions ---

// Reactions no general reader takes: a gremishka's Magic Allergy, and Shape Control, which waits for a shape-shift
// that nothing a party fields makes yet.
export function oneOffReaction(label: string, text: string): OneOff | null {
  const name = label.replace(/\s*\(.*$/, "");
  if (/^Trigger: A creature [^.]+ shape-shifts\./.test(text)) {
    return { actions: [], passives: [], notes: [`no combat use: ${label}`] };
  }
  // "Trigger: A creature within 30 feet of the gremishka casts a spell. Response: The gremishka regains 15 Hit Points,
  // then becomes a Medium swarm of Tiny creatures."
  const allergy =
    /^Trigger: A creature within (\d+) feet of [^.]+ casts a spell\. Response: [^.]+ regains (\d+) Hit Points\b(.*)$/s.exec(
      text,
    );
  if (!allergy) return null;
  const perDay = /(\d+)\/Day\b/.exec(label)?.[1];
  return {
    actions: [
      {
        name,
        ...(perDay ? { perDay: Number(perDay) } : {}),
        activation: {
          cost: [
            "reaction",
            ...(perDay ? [{ resource: `day:${slugOf(name)}` }] : []),
          ],
          trigger: { spellCast: true },
          targeting: { creatures: 1, range: Number(allergy[1]), side: "enemy" },
          resolution: automatic([
            { kind: "heal", amount: flat(Number(allergy[2])) },
          ]),
        },
      },
    ],
    passives: [],
    notes: (allergy[3] ?? "").trim()
      ? [`partial: ${name}: left out what follows it`]
      : [],
  };
}

// --- Legendary actions ---

// What a legendary action's text holds that the general readers don't: a save after a lead-in ("uses Shape-Shift
// to return to his humanoid form, then uses the following effect."), Temporary Hit Points for a friend, going
// unseen, a target its curse marked, damage to those it holds.
export function oneOffLegendary(
  text: string,
  actionNames: readonly string[],
  readers: Readers,
): { activation: unknown; left: string[] } | null {
  const left: string[] = [];
  const lead =
    /^[^.]+ uses Shape-Shift to [^.]+, then uses the following effect\.\s*(.*)$/s.exec(
      text,
    )?.[1];
  if (lead) {
    const cleaned = lead.replace(/\s*\([^)]*automatically fail[^)]*\)/, "");
    const parsed = readers.parseSave(cleaned, left);
    if (parsed) {
      left.push("its change of shape first");
      return { activation: { cost: [], ...parsed }, left };
    }
  }
  // "(with Disadvantage if the target is holding or wearing chardalyn)" and "doesn't act as an ally" read as a charm.
  if (/\(with Disadvantage if [^)]*\)/.test(text)) {
    const parsed = readers.parseSave(
      text.replace(/\s*\(with Disadvantage if [^)]*\)/, ""),
      left,
    );
    if (parsed) {
      left.push("Disadvantage for what the target holds");
      return { activation: { cost: [], ...parsed }, left };
    }
  }
  const boon = boonOf(text);
  if (boon) {
    left.push(...boon.left);
    return {
      activation: {
        cost: [],
        targeting: boon.targeting,
        resolution: automatic(boon.effects),
      },
      left,
    };
  }
  const unseen = invisibleOf(text);
  if (unseen) {
    left.push(...unseen.left);
    return {
      activation: {
        cost: [],
        targeting: self,
        resolution: automatic([unseen.effect]),
      },
      left,
    };
  }
  // "Constitution Saving Throw: DC 23, each creature in a 15-foot Emanation originating from the kraken while it is
  // underwater. … The kraken then moves up to its Speed."
  if (text.includes(" while it is underwater.")) {
    const parsed = readers.parseSave(
      text
        .replace(/ while it is underwater\./, ".")
        .replace(/\s*The [^.]+ then moves up to its Speed\./, ""),
      left,
    );
    if (parsed) {
      left.push("needing water", "its move after");
      return { activation: { cost: [], ...parsed }, left };
    }
  }
  // "The nightmare targets one creature it can see within 120 feet that's cursed by its Haunter's Spear. The target
  // takes 7 (2d6) Psychic damage and has the Unconscious condition for 1 hour, until it takes damage, …"
  const cursed =
    /^[^.]+ targets one creature it can see within (\d+) feet that[’']s cursed by its ([^.]+?)\. The target takes (\d+ \(\d+d\d+(?: \+ \d+)?\)) (\w+) damage and has the (\w+) condition for (\d+) (hour|minute)s?, until it takes damage\b/.exec(
      text,
    );
  const cursedType = typeOf(cursed?.[4]);
  const cursedCondition = conditionOf(cursed?.[5]);
  if (cursed?.[3] && cursedType && cursedCondition) {
    left.push("waking by a shake");
    return {
      activation: {
        cost: [],
        targeting: {
          creatures: 1,
          range: Number(cursed[1]),
          side: "enemy",
          afflicted: cursed[2],
        },
        resolution: automatic(
          [
            {
              kind: "applyCondition",
              condition: cursedCondition,
              duration: {
                minutes: Number(cursed[6]) * (cursed[7] === "hour" ? 60 : 1),
              },
              repeatSave: false,
              endsOnDamage: true,
            },
          ],
          [{ amount: amountIn(cursed[3]), type: cursedType }],
        ),
      },
      left,
    };
  }
  // "The blob deals 14 (4d6) Necrotic damage to each creature engulfed by it."
  const inside =
    /^[^.]+ deals (\d+ \(\d+d\d+(?: \+ \d+)?\)) (\w+) damage to each creature (engulfed|swallowed) by it\./.exec(
      text,
    );
  const insideType = typeOf(inside?.[2]);
  const holder = actionNames.find((action) =>
    /^(?:Engulf|Swallow)\b/.test(action),
  );
  if (inside?.[1] && insideType && holder) {
    return {
      activation: {
        cost: [],
        targeting: {
          creatures: 6,
          range: 5,
          side: "enemy",
          afflicted: holder,
        },
        resolution: automatic(
          [],
          [{ amount: amountIn(inside[1]), type: insideType }],
        ),
      },
      left,
    };
  }
  // "The dragon uses Shadow Stealth, and one creature of its choice that it can see within 10 feet of it takes 10
  // (3d6) Necrotic damage."
  const veil =
    /^[^.]+ uses [^,]+, and one creature of its choice that it can see within (\d+) feet of it takes (\d+ \(\d+d\d+(?: \+ \d+)?\)) (\w+) damage\./.exec(
      text,
    );
  const veilType = typeOf(veil?.[3]);
  if (veil?.[2] && veilType) {
    left.push("hiding first");
    return {
      activation: {
        cost: [],
        targeting: { creatures: 1, range: Number(veil[1]), side: "enemy" },
        resolution: automatic(
          [],
          [{ amount: amountIn(veil[2]), type: veilType }],
        ),
      },
      left,
    };
  }
  // "The tarrasque moves up to its Speed. At the end of this movement, … shock wave in a 60-foot Emanation …
  // Creatures in that area lose Concentration and, if Medium or smaller, have the Prone condition."
  const quake =
    /^[^.]+ moves up to its Speed\. At the end of this movement, [^.]+ in a (\d+)-foot Emanation originating from itself\. Creatures in that area lose Concentration and, if (\w+) or smaller, have the Prone condition\b/.exec(
      text,
    );
  if (quake) {
    left.push(
      "breaking Concentration",
      "its size limit",
      "a full Speed's move",
    );
    return {
      activation: {
        cost: [],
        targeting: {
          area: { shape: "emanation", radius: Number(quake[1]) },
          range: "self",
          side: "enemy",
        },
        resolution: automatic([
          {
            kind: "applyCondition",
            condition: "prone",
            duration: { minutes: 1 },
            repeatSave: false,
            endsOnDamage: false,
          },
        ]),
      },
      left,
    };
  }
  return null;
}

// --- Actions taken from stat-block wording too particular for a general reader ---

// The intellect devourer's Steal Body, the will-o'-wisp's Consume Life and the like: a save whose failure kills.
export function slayingSave(
  text: string,
): { targeting: unknown; resolution: Resolution; left: string[] } | null {
  const steal =
    /^(\w+) Saving Throw: DC (\d+), one (\w+) or (\w+) creature within (\d+) feet that has the (\w+) condition, is an? (\w+) or (\w+), and has (\d+) Hit Points or fewer\. Failure: [^.]+ possesses the target\b/.exec(
      text,
    );
  const stealAbility = steal?.[1];
  const stealCondition = conditionOf(steal?.[6]);
  if (steal && stealAbility && ABILITY[stealAbility] && stealCondition) {
    return {
      targeting: {
        creatures: 1,
        range: Number(steal[5]),
        side: "enemy",
        maxSize: (steal[4] ?? "").toLowerCase(),
        targetConditions: [stealCondition],
        creatureTypes: [steal[7], steal[8]].map((word) =>
          (word ?? "").toLowerCase(),
        ),
      },
      resolution: {
        kind: "save",
        ability: ABILITY[stealAbility],
        dc: { base: Number(steal[2]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        onFail: [{ kind: "slay", hpAtMost: Number(steal[9]) }],
        onSuccess: [],
      },
      left: ["taking over the body it kills"],
    };
  }
  const consume =
    /^(\w+) Saving Throw: DC (\d+), one living creature [^.]*?within (\d+) feet that has 0 Hit Points\. Failure: The target dies, and [^.]+ regains\b/.exec(
      text,
    );
  const consumeAbility = consume?.[1];
  if (consume && consumeAbility && ABILITY[consumeAbility]) {
    return {
      targeting: {
        creatures: 1,
        range: Number(consume[3]),
        side: "enemy",
        downed: true,
      },
      resolution: {
        kind: "save",
        ability: ABILITY[consumeAbility],
        dc: { base: Number(consume[2]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        onFail: [{ kind: "slay", hpAtMost: 1 }],
        onSuccess: [],
      },
      left: ["its healing"],
    };
  }
  return null;
}
