import type { ParsedImport } from "#sdk";
import type {
  AreaEffect,
  Condition,
  Damage,
  LeafEffect,
  Modifier,
  Passive,
  Resolution,
} from "../schemas.ts";
import { reactionOf } from "./monster-reactions.ts";
import {
  ABILITY_NAMES as ABILITIES,
  ConditionSchema,
  DAMAGE_TYPES,
} from "../schemas.ts";
import { dependsOnCaster, statBlocksIn } from "./book.ts";
import {
  type Caster,
  castActions,
  type MonsterAction,
  castItems,
  nothingToCast,
  casterIn,
  type SpellLookup,
  spellcastingActions,
  spellcastingItems,
  spellLookup,
} from "./monster-spells.ts";
import { plainText, slugOf } from "./spells.ts";
import { formsOnly, shapesIn, shapeShiftActions } from "./shapes.ts";
import {
  oneOffAction,
  oneOffLegendary,
  oneOffReaction,
  oneOffTrait,
  type Readers,
  eitherEffects,
  riderEffects,
  VARIANT,
} from "./monster-oneoffs.ts";

type AbilityKey = keyof typeof ABILITIES;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};
const NUMBER = Object.keys(NUMBER_WORDS).join("|");

const TYPES = DAMAGE_TYPES.join("|");
const DICE_DAMAGE = new RegExp(
  `(?:\\d+ \\((\\d+d\\d+)(?:\\s*([+−–-])\\s*(\\d+))?\\)|\\b(\\d+)) (${TYPES}) damage`,
  "gi",
);
const SAVE_LABEL = `(?:${Object.values(ABILITIES).join("|")}) Saving Throw:`;
const CREATURE_KIND =
  /^(Tiny|Small|Medium|Large|Huge|Gargantuan)\b.*?\b(Aberration|Beast|Celestial|Construct|Dragon|Elemental|Fey|Fiend|Giant|Humanoid|Monstrosity|Ooze|Plant|Undead)s?\b/i;

const OLDER_CONDITION =
  /\b(?:is|be) (?:knocked )?(?:blinded|charmed|deafened|frightened|grappled|incapacitated|paralyzed|petrified|poisoned|prone|restrained|stunned|unconscious)\b/;

const costOf = (section: string): "action" | "bonusAction" =>
  section === "bonus actions" ? "bonusAction" : "action";

const nonNull = <T extends object>(item: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== null),
  ) as Partial<T>;

const sentencesOf = (text: string): readonly string[] =>
  text.split(/(?<=\.)\s+/);

// Every hero is Small or Medium, so a limit of Medium or smaller, or anything larger, always holds.
const HERO_SIZES =
  "(?:(?:Medium|Large|Huge|Gargantuan) or smaller|Medium or Small|Small or Medium)\\b";
const withoutSizeLimits = (text: string): string =>
  text
    // "If the target is a Medium or smaller creature, it …" holds; "… and the monster had Advantage" keeps its "if".
    .replace(
      new RegExp(
        `\\bif (?:the )?(?:target|it) is (?:a )?${HERO_SIZES}(?!(?: creature)? and\\b)(?: creature)?,?`,
        "gi",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:the )?(?:target|it) is (?:a )?${HERO_SIZES}(?: creature)?`,
        "gi",
      ),
      "",
    )
    .replace(new RegExp(`\\b${HERO_SIZES} (creatures?)\\b`, "gi"), "$1");

const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

// "the monster's size or smaller" holds for every hero when the monster is Medium or larger.
const withOwnSize = (text: string, size: string | undefined): string =>
  SIZES.indexOf(size ?? "") >= SIZES.indexOf("medium")
    ? text.replace(
        /\bis (?:the [^,.]*?[’']s|its) size or smaller\b/gi,
        "is Medium or smaller",
      )
    : text;

// Why part of an effect only applies sometimes, in our own words so that a note never quotes the book.
function limitOn(text: string): string | null {
  // Every target in a fight is a creature, so this one always holds.
  const clause = withoutSizeLimits(
    text.replace(/\bif the target is a creature,/gi, ""),
  );
  if (/\bmov(?:ed|ing)\b/i.test(clause)) return "a charge requirement";
  if (/\bor (?:smaller|larger)\b|\bno larger than\b/i.test(clause)) {
    return "a size limit";
  }
  if (/\bHit Points? or (?:fewer|more)\b|\bBloodied\b/i.test(clause)) {
    return "a Hit Point threshold";
  }
  if (/saving throw|must succeed/i.test(clause)) return "a nested save";
  if (/\b(?:start|end) of each\b/i.test(clause)) return "an ongoing effect";
  return /\b(?:if|unless|while|when|whenever|against|otherwise)\b/i.test(clause)
    ? "another condition"
    : null;
}

// Dice that are only added when the attack roll had Advantage go to advantage, for an extraDamage passive.
function damageIn(
  sentence: string,
  left: string[],
  advantage: string[] = [],
): Damage[] {
  // "..., or 7 (1d8 + 3) Piercing damage if used with two hands" is an alternative, not extra damage.
  const [main = ""] = sentence
    .replace(/[—–]\s*or\b[^—–]*(?:[—–]\s*|$)/g, " ")
    .split(/,? or \d/);
  const matches = [...main.matchAll(DICE_DAMAGE)];
  return matches.flatMap((match, index) => {
    const previous = matches[index - 1];
    const end = match.index + match[0].length;
    const before = main.slice(
      previous ? previous.index + previous[0].length : 0,
      match.index,
    );
    const [after = ""] = main
      .slice(end, matches[index + 1]?.index)
      .split(/,|\s+plus\s/);
    const around = `${before} ${after}`;
    const limit = /\bat the (?:start|end) of\b/i.test(around)
      ? "an ongoing effect"
      : /\b(?:a|an|another|any|each|one|other|different|second)\s+(?:\w+\s+)?(?:creature|target)\b/i.test(
            around.replace(/\bif the target is a creature,/gi, ""),
          )
        ? "damage to another creature"
        : limitOn(around);
    const [, dice, sign, bonus, flat, type = ""] = match;
    if (
      limit === "another condition" &&
      dice &&
      !bonus &&
      /\bif the (?:attack (?:roll )?(?:had|was made with)|\w+ had) Advantage\b/i.test(
        around,
      )
    ) {
      advantage.push(dice);
      return [];
    }
    if (limit) {
      left.push(limit);
      return [];
    }
    const base = flat ?? (sign === "+" ? bonus : bonus && `-${bonus}`);
    return [
      {
        amount: {
          ...(dice ? { dice } : {}),
          ...(base ? { bonus: { base: Number(base), add: [] } } : {}),
        },
        type: type.toLowerCase() as Damage["type"],
      },
    ];
  });
}

// Only the first sentence holds an action's main damage, so anything later is reported rather than added.
function noteLaterDamage(sentences: readonly string[], left: string[]): void {
  for (const sentence of sentences.slice(1)) {
    if (sentence.search(DICE_DAMAGE) >= 0) {
      left.push(limitOn(sentence) ?? "extra damage");
    }
  }
}

const REPEAT_SAVE =
  /\brepeats? the sav(?:e|ing throw)\b(?:,|[^.]*?\b(?:at the end of|whenever it takes damage)\b)|\bat which point it repeats the save\b/i;

// "has Disadvantage on Strength-based D20 Tests and subtracts 3 (1d6) from its damage rolls", for the fight or until
// a repeated save ends it. shortcut: the penalty is taken off weapon damage only, as damageBonus is.
function modifiersIn(text: string): LeafEffect[] {
  const named = new RegExp(
    `\\bhas Disadvantage on (${ABILITY_NAMES})-based D20 Tests\\b`,
  ).exec(text)?.[1];
  const ability = (Object.keys(ABILITIES) as AbilityKey[]).find(
    (key) => ABILITIES[key] === named,
  );
  const penalty = /\bsubtracts \d+ \((\d+d\d+)\) from its damage rolls\b/.exec(
    text,
  )?.[1];
  const leaf = (modifier: Modifier): LeafEffect => ({
    kind: "modifier",
    modifier,
    duration: { minutes: 1 },
    ...(REPEAT_SAVE.test(text) ? { repeatSave: true } : {}),
  });
  // "can't regain Hit Points until the start of the scion's next turn": its owner's turn, as Culling Aura's.
  const unhealed =
    /\bcan[’']t regain Hit Points until the start of the [^.]+?[’']s next turn\b/.test(
      text,
    );
  return [
    ...actionLimitIn(text),
    ...(unhealed
      ? [
          {
            kind: "modifier" as const,
            modifier: { kind: "noHealing" as const },
            duration: { until: "yourNextTurnStart" as const },
          },
        ]
      : []),
    ...(ability
      ? (["attacks", "saves", "checks"] as const).map((on) =>
          leaf({ kind: "disadvantage", on, ability }),
        )
      : []),
    ...(penalty
      ? [
          leaf({
            kind: "damageBonus",
            amount: { dice: penalty },
            subtract: true,
          }),
        ]
      : []),
  ];
}

// "can't take Reactions; its Speed is halved; and it can take either an action or a Bonus Action on its turn, not
// both", as a copper dragon's Slowing Breath: Slow's limits, until its next turn or for a minute of repeated saves.
function actionLimitIn(text: string): LeafEffect[] {
  const oneAction =
    /\bcan take either an action or a Bonus Action on its turns?, not both\b/i.test(
      text,
    );
  const noReactions = /\bcan[’']t take Reactions\b/i.test(text);
  // A roll for what it does instead, as an umber hulk's Confusing Gaze, is more than these limits.
  if (
    (!oneAction && !noReactions) ||
    /\bto determine what it does\b/i.test(text)
  ) {
    return [];
  }
  const speed = /\bSpeed is halved\b/i.test(text)
    ? ("half" as const)
    : /\bSpeed is reduced to 0\b/i.test(text)
      ? ("none" as const)
      : undefined;
  // "until the end of its next turn" counts the target's turns; "of the enforcer's next turn" the monster's.
  const [, edge = "", whose = ""] =
    /\buntil the (start|end) of ([^.;]*?)\s*next turn\b/i.exec(text) ?? [];
  const theirs = /^(?:its|the target[’']s|their)$/i.test(whose.trim());
  const start = edge.toLowerCase() === "start";
  const until = theirs
    ? start
      ? ("itsNextTurnStart" as const)
      : ("itsNextTurnEnd" as const)
    : start
      ? ("yourNextTurnStart" as const)
      : ("yourNextTurnEnd" as const);
  return [
    {
      kind: "modifier",
      modifier: {
        kind: "actionLimit",
        ...(oneAction ? { oneAction: true } : {}),
        ...(noReactions ? { noReactions: true } : {}),
        ...(speed ? { speed } : {}),
      },
      duration: edge ? { until } : { minutes: 1 },
      ...(REPEAT_SAVE.test(text) ? { repeatSave: true } : {}),
    },
  ];
}

function conditionsIn(text: string, left: string[]): LeafEffect[] {
  const repeatSave = REPEAT_SAVE.test(text);
  const endsOnDamage =
    /\bends? (?:early )?(?:(?:on|for) the target )?(?:if|when) (?:the target|it) takes (?:any )?damage\b|\buntil (?:it|the target) takes (?:any )?damage\b/i.test(
      text,
    );
  // "The target wakes up if it takes damage" ends only the Unconscious condition.
  const wakes = /\bwakes up if it takes (?:any )?damage\b/i.test(text);
  // "While Poisoned, the target has the Paralyzed condition" lasts as that Poisoned condition does.
  const applied = new Map<string, LeafEffect>();
  return sentencesOf(text).flatMap((sentence) => {
    const whileHeld = WHILE_CONDITION.exec(sentence)?.[1]?.toLowerCase();
    const parent = whileHeld ? applied.get(whileHeld) : undefined;
    // "until the end of the spy's next turn" outlasts the spy's next turn, and the end of the target's own comes before it.
    const [, edge, whose = ""] =
      /until the (start|end) of ([^.]*?)\s*next turn/i.exec(sentence) ?? [];
    const until =
      edge?.toLowerCase() === "end" &&
      !/^(?:its|the target’s|the target's|their)$/i.test(whose)
        ? ("yourNextTurnEnd" as const)
        : ("yourNextTurnStart" as const);
    // "for 10 minutes" or "for 1 hour"; with no time printed, it lasts the fight.
    const [, count, unit = ""] =
      /\bfor (\d+) (minute|hour)s?\b/i.exec(sentence) ?? [];
    const minutes = count
      ? Number(count) * (unit.toLowerCase() === "hour" ? 60 : 1)
      : 1;
    // "While swallowed, a creature has …" describes the state the failure itself caused.
    const stated = sentence.replace(STATE_LEAD, "");
    // "which is no longer Grappled", or "and the Grappled condition ends": swallowing replaces the grapple.
    const released = [
      ...stated.matchAll(
        /\bno longer (Grappled)\b|\bthe (Grappled) condition ends\b|\bisn[’']t (Grappled)\b/g,
      ),
    ].map((match) => ({
      kind: "removeCondition" as const,
      condition: (
        match[1] ??
        match[2] ??
        match[3] ??
        ""
      ).toLowerCase() as Condition,
    }));
    return [
      ...released,
      // "has the Blinded condition", or "has the Blinded and Restrained conditions".
      ...[
        ...stated.matchAll(
          /\b(?:has|have) the ((?:\w+(?:,? and |, ))*\w+) conditions?\b/g,
        ),
      ].flatMap((match) => {
        const [after = ""] = stated
          .slice(match.index + match[0].length)
          .split(/,|\band\b/);
        const limit = limitOn(stated.slice(0, match.index)) ?? limitOn(after);
        const conditions = (match[1] ?? "")
          .split(/,? and |, /)
          .flatMap((word) => {
            const parsed = ConditionSchema.safeParse(word.toLowerCase());
            return parsed.success ? [parsed.data] : [];
          });
        if (conditions.length === 0) return [];
        if (limit || (whileHeld && parent?.kind !== "applyCondition")) {
          left.push(limit ?? "another condition");
          return [];
        }
        return conditions.map((condition) => {
          const effect = {
            kind: "applyCondition" as const,
            condition,
            duration:
              parent?.kind === "applyCondition"
                ? parent.duration
                : edge
                  ? { until }
                  : { minutes },
            repeatSave,
            endsOnDamage:
              endsOnDamage || (wakes && condition === "unconscious"),
          };
          applied.set(condition, effect);
          return effect;
        });
      }),
    ];
  });
}

const STATE_LEAD =
  /^\s*While (?:swallowed|engulfed|trapped|grafted|Restrained|Poisoned|Frightened)(?: in this way)?,\s*/i;
const WHILE_CONDITION =
  /^\s*While (Restrained|Poisoned|Frightened)(?: in this way)?,/i;

// "… takes 10 (3d6) Acid damage at the start of each of the monster's turns" while swallowed. shortcut: it ticks on the
// bearer's own turn rather than the monster's, which is one turn's difference at most.
function ongoingDamage(text: string, left: string[]): LeafEffect[] {
  const effects = sentencesOf(text).flatMap((sentence): LeafEffect[] => {
    const stated = sentence.replace(STATE_LEAD, "");
    const amount = `(?:\\d+ \\(\\d+d\\d+(?:\\s*[+−–-]\\s*\\d+)?\\)|\\d+) (?:${TYPES}) damage`;
    const match = new RegExp(
      `^(.*?)\\btakes? (${amount}(?: plus ${amount})*) at the (start|end) of each of [^.]*?\\bturns\\b`,
      "i",
    ).exec(stated);
    // "has Total Cover against attacks … outside the worm" is part of being swallowed, not a condition on the damage.
    const lead = (match?.[1] ?? "").replace(
      /\bhas (?:Total|Half|Three-Quarters) Cover against [^,]*/gi,
      "",
    );
    const whileHeld = WHILE_CONDITION.exec(sentence)?.[1];
    const held =
      !whileHeld ||
      new RegExp(
        `\\bhas the (?:\\w+ and )?${whileHeld} conditions?\\b`,
        "i",
      ).test(text);
    if (!match || limitOn(lead) || !held) return [];
    const damage = damageIn(match[2] ?? "", []);
    return damage.length > 0
      ? [
          {
            kind: "modifier",
            modifier: {
              kind: "lingeringDamage",
              when: match[3]?.toLowerCase() === "end" ? "turnEnd" : "turnStart",
              damage,
              once: false,
            },
            duration: { minutes: 1 },
          },
        ]
      : [];
  });
  // What would have been left out is now in.
  if (effects.length > 0) {
    for (let at = left.indexOf("an ongoing effect"); at >= 0;) {
      left.splice(at, 1);
      at = left.indexOf("an ongoing effect");
    }
  }
  return effects;
}

// "The toad swallows a Medium or smaller target it is grappling. While swallowed, …": no roll, and only a creature
// the monster is grappling can be chosen.
function parseSwallow(text: string, left: string[]): ParsedAction | null {
  const [first = "", ...rest] = sentencesOf(text);
  const swallows = new RegExp(
    `^The [^.]*? swallows (?:a|one) (?:${HERO_SIZES} |(Small|Tiny) or smaller )?(?:target|creature) (?:it is grappling|Grappled by [^.]*)\\.$`,
    "i",
  );
  const match = swallows.exec(first);
  if (!match) return null;
  // "a Small or smaller target" leaves out a Medium hero.
  const largest = match[1]?.toLowerCase() as "small" | "tiny" | undefined;
  const after = rest.join(" ");
  const effects = [...conditionsIn(after, left), ...ongoingDamage(after, left)];
  if (!effects.some((effect) => effect.kind === "removeCondition")) {
    return null;
  }
  return {
    targeting: {
      creatures: 1,
      range: 5,
      side: "enemy",
      targetConditions: ["grappled"],
      ...(largest ? { maxSize: largest } : {}),
    },
    resolution: { kind: "automatic", damage: [], effects },
  };
}

interface ParsedAction {
  readonly targeting: unknown;
  readonly resolution: Resolution;
  readonly advantageDice?: readonly string[];
  readonly thrownRange?: number; // a "Melee or Ranged" attack's range, for a second, ranged action
}

function parseAttack(text: string, left: string[]): ParsedAction | null {
  const match =
    /^(?:Melee or Ranged|Melee|Ranged)(?: Weapon| Spell)? Attack(?: Roll)?:\s*([+−-]?\s?\d+)/.exec(
      text,
    );
  if (!match) return null;
  const hitAt = text.indexOf("Hit:");
  if (hitAt < 0) return null;
  const afterHit = text.slice(hitAt + 4).trim();
  const nested = nestedSave(afterHit, left);
  if (/saving throw/i.test(afterHit) && !nested) left.push("a nested save");
  // Older books say "is grappled", which has no duration or end this parser can read reliably.
  if (OLDER_CONDITION.test(afterHit)) left.push("a condition in older wording");
  // "Critical Hit: …" only happens on a critical, which onHit can't tell apart.
  if (/\bCritical Hit:/.test(afterHit)) left.push("a Critical Hit rider");
  const [split = ""] = afterHit.split(
    new RegExp(`(?=${SAVE_LABEL}|(?:Hit or )?Miss:|Critical Hit:)`),
  );
  const hit = nested ? split.replace(nested.intro, "") : split;
  const sentences = sentencesOf(hit);
  const advantageDice: string[] = [];
  const damage = damageIn(sentences[0] ?? "", left, advantageDice);
  noteLaterDamage(sentences, left);
  const onHit = [...conditionsIn(hit, left), ...riderEffects(hit)];
  if (
    damage.length === 0 &&
    (onHit.length === 0 || hit.search(DICE_DAMAGE) >= 0)
  ) {
    return null;
  }
  const reach = /reach (\d+) ft/.exec(text)?.[1];
  const range = /range (\d+)(?:\/\d+)? ft/.exec(text)?.[1];
  const both = text.startsWith("Melee or Ranged") && reach && range;
  const distances = [reach, range].flatMap((item) =>
    item ? [Number(item)] : [],
  );
  return {
    ...(both ? { thrownRange: Number(range) } : {}),
    ...(advantageDice.length > 0 ? { advantageDice } : {}),
    targeting: {
      creatures: 1,
      range: both ? Number(reach) : Math.max(5, ...distances),
      side: "enemy",
    },
    resolution: {
      kind: "attack",
      attack: {
        type: "weapon",
        flatBonus: Number(
          (match[1] ?? "0").replace("−", "-").replace(/\s/g, ""),
        ),
      },
      // shortcut: the schema needs a damage entry, so a hit that only grapples deals 0, which raises no damage event.
      damage:
        damage.length > 0
          ? damage
          : [
              {
                amount: { bonus: { base: 0, add: [] } },
                type: "bludgeoning",
              },
            ],
      onHit,
      onMiss: [],
      ...(nested ? { onHitSave: nested.save } : {}),
    },
  };
}

// "If the target is a creature, it is subjected to the following effect. Constitution Saving Throw: DC 11. Failure: …"
// after a hit, or the save printed straight after the damage. Only a gate every hero meets, or one by creature type
// or species, is read.
function nestedSave(
  afterHit: string,
  left: string[],
): {
  readonly intro: string;
  readonly save: NonNullable<
    Extract<Resolution, { kind: "attack" }>["onHitSave"]
  >;
} | null {
  const at = afterHit.search(SAVE_START);
  const before = afterHit.slice(0, at);
  // "Hit or Miss: … the following effect" happens on a miss too, which a hit's save can't hold.
  if (at < 0 || /\bMiss:/.test(before)) return null;
  const intro =
    /(?:^|(?<=\.\s)|(?<=, and ))(?:If the target is ([^.,]*), )?(?:it|the target) (?:is (?:also )?subjected to the following effect|must make the following saving throw)[.:]\s*$/i.exec(
      before,
    );
  if (
    !intro &&
    /\bfollowing\b/i.test(sentencesOf(before.trim()).at(-1) ?? "")
  ) {
    return null;
  }
  const gate = (intro?.[1] ?? "a creature").replace(/’/g, "'");
  const exempt = /^a creature$/i.test(gate)
    ? []
    : /^a non-Undead creature$|^a creature that isn't an Undead$/i.test(gate)
      ? ["undead"]
      : /^a creature that isn't an Undead or elf$/i.test(gate)
        ? ["undead", "elf"]
        : null;
  if (!exempt) return null;
  const [saveText = ""] = afterHit
    .slice(at)
    .split(/(?=(?:Hit or )?Miss:|Critical Hit:)/);
  const parsed = parseSaveFrom(saveText, "", left);
  if (parsed?.resolution.kind !== "save") return null;
  const { ability, dc, damage, onSuccessDamage, onFail, onSuccess } =
    parsed.resolution;
  return {
    intro: intro?.[0] ?? "",
    save: {
      ability,
      dc,
      damage,
      onSuccessDamage,
      onFail,
      onSuccess,
      ...(exempt.length > 0 ? { exempt } : {}),
    },
  };
}

function targetingFor(rule: string): unknown {
  const area =
    /(\d+)-foot(?:-radius)?(?:,?[^.]*?)?[- ](Cone|Cube|Line|Sphere|Emanation|Cylinder)/i.exec(
      rule,
    );
  const within = /within (\d+) feet/.exec(rule)?.[1];
  const range = within ? Number(within) : "self";
  if (area) {
    const shape = (area[2] ?? "").toLowerCase();
    return {
      // shortcut: a cylinder is read as a sphere of its radius, since the grid has no height; give it a
      // shape of its own once heights matter.
      area: {
        shape: shape === "cylinder" ? "sphere" : shape,
        radius: Number(area[1]),
      },
      range,
      side: "enemy",
    };
  }
  // "each creature within 30 feet" is everyone around the monster, not one creature.
  if (
    within &&
    /\b(?:each|every|any|all)\b[^.]*?\bwithin \d+ feet/i.test(rule)
  ) {
    return {
      area: { shape: "emanation", radius: Number(within) },
      range: "self",
      side: "enemy",
    };
  }
  const count = /\b(one|two|three|four|five|six) (?:creature|target)/i.exec(
    rule,
  )?.[1];
  return {
    creatures: NUMBER_WORDS[(count ?? "one").toLowerCase()] ?? 1,
    range: within ? Number(within) : 5,
    side: "enemy",
  };
}

// "one creature within 5 feet that has the Prone condition", or "one creature Grappled by the chuul": only such a
// target can be chosen. The phrase is taken out, so the rest of the clause is read as usual.
const GATED =
  "(?:Charmed|Frightened|Grappled|Incapacitated|Prone|Restrained|Stunned)";
const GATES = [
  /,?\s*(?:or )?(?:that is willing or )?(?:that|who) (?:has|have) the ((?:\w+(?:,? or |, ))*\w+) conditions?\b/i,
  new RegExp(
    `\\s(?:that is )?(${GATED}(?: or ${GATED})*) by (?:the |its )?[\\w’' -]+?(?=[,.(]| or | within|$)`,
  ),
  new RegExp(
    `,?\\s*(?:that )?the [\\w’' -]+? (?:has (${GATED})|is (grappling))\\b`,
  ),
  new RegExp(`(?<=\\bone )(${GATED}) (?=creature)`),
];

function targetGate(printed: string): {
  readonly who: string;
  readonly conditions: readonly Condition[];
} {
  let who = printed;
  const conditions: Condition[] = [];
  for (const pattern of GATES) {
    const gate = pattern.exec(who);
    if (!gate) continue;
    for (const word of (gate[1] ?? gate[2] ?? "").split(/,? or |, /)) {
      const parsed = ConditionSchema.safeParse(
        word.trim().toLowerCase().replace("grappling", "grappled"),
      );
      if (parsed.success) conditions.push(parsed.data);
    }
    who = who.slice(0, gate.index) + who.slice(gate.index + gate[0].length);
  }
  return { who, conditions };
}

const SAVE_START = new RegExp(`\\b(?=${SAVE_LABEL})`);

const ABILITY_NAMES = Object.values(ABILITIES).join("|");
const OLDER_SAVE = new RegExp(
  `^(.*?)\\b((?:[Ee]ach|[Tt]he|[Aa]ny)\\b[^.]*?|\\bit) must (?:make|succeed on) a DC (\\d+) (${ABILITY_NAMES}) saving throw,?\\s*(.*)$`,
  "s",
);
const OLDER_CONDITIONS = new RegExp(
  `,?\\s*(?:and )?(?:be|is) (?:knocked )?(${ConditionSchema.options.join("|")})\\b`,
  "gi",
);
const capitalised = (word: string): string =>
  `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;

// Older books: "The target must make a DC 13 Dexterity saving throw, taking 9 (2d8) fire damage on a failed
// save, or half as much damage on a successful one", or "… must succeed on … or take … and be stunned". It's put
// in the newer shape, which the rest of the parser reads.
function newerSave(text: string): string {
  const match = OLDER_SAVE.exec(text);
  if (!match) return text;
  const [, lead = "", who = "", dc = "", ability = "", rest = ""] = match;
  const taking =
    /^taking (.*?) on a failed save(?:,? or (half as much damage|[^.]*?) on a successful one)?\.?(?:\s+(.*))?$/s.exec(
      rest,
    );
  const or = /^or (?:take )?(.*)$/s.exec(rest);
  const failure = taking
    ? `${taking[1] ?? ""}.${taking[3] ? ` ${taking[3]}` : ""}`
    : (or?.[1] ?? "");
  if (!failure) return text;
  // "The target" or "Any creature in that area" points back at the lead-in, which says where.
  const rule = /\d/.test(who) ? who : "";
  const success = /^half/i.test(taking?.[2] ?? "")
    ? " Success: Half damage."
    : "";
  return `${lead}${ability} Saving Throw: DC ${dc}, ${rule}. Failure: ${failure.replace(
    OLDER_CONDITIONS,
    (_, condition: string) =>
      `, and the target has the ${capitalised(condition)} condition`,
  )}${success}`;
}

export function parseSave(input: string, left: string[]): ParsedAction | null {
  const text = SAVE_START.test(input) ? input : newerSave(input);
  // "The ape hurls a boulder at a point within 90 feet. Dexterity Saving Throw: …": the lead-in says where.
  const at = text.search(SAVE_START);
  if (at < 0) return null;
  const lead = text.slice(0, at);
  if (/Attack Roll|Hit:|Saving Throw/.test(lead)) return null;
  if (/\b(?:teleports?|moves?|jumps?|leaps?|flies|charges?)\b/i.test(lead)) {
    left.push("its movement");
  }
  return parseSaveFrom(text.slice(at), lead, left);
}

function parseSaveFrom(
  text: string,
  lead: string,
  left: string[],
): ParsedAction | null {
  // A worse condition on a failed repeat save goes on the first one; any other later stage can't be tracked.
  const second = /\s*Second Failure:\s*(.*?)(?=\s*Success:|$)/s.exec(text)?.[1];
  const firstStage = text.replace(
    /\s*(?:Second Failure|Failure by \d+ or More):.*?(?=\s*Success:|$)/s,
    "",
  );
  const eitherResult = /\s*Failure or Success:.*$/s;
  // A curse or a mark on either result goes on both, as an arch-hag's Crackling Wave's.
  const both = eitherEffects(
    /\s*Failure or Success:\s*(.*)$/s.exec(firstStage)?.[1] ?? "",
  );
  if (eitherResult.test(firstStage) && both.length === 0) {
    left.push("an effect on either result");
  }
  const match =
    /^(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) Saving Throw:\s*DC (\d+),?\s*(.*?)\s*(?:First )?Failure:\s*(.*?)(?:\s*Success:\s*(.*))?$/s.exec(
      firstStage.replace(eitherResult, ""),
    );
  if (!match) return null;
  const [, abilityName, dc, rule = "", failure = "", success = ""] = match;
  const ability = (Object.keys(ABILITIES) as AbilityKey[]).find(
    (key) => ABILITIES[key] === abilityName,
  );
  if (!ability) return null;
  // Who can be targeted at all decides the whole action, so it can't be left out as a rider.
  // "originating from the marauder when it appears" says where the area is, not when the action works.
  const [printed = ""] = sentencesOf(
    rule.replace(/(\boriginating from [^.,]*?) when [^.,]*/i, "$1"),
  );
  const { who, conditions } = targetGate(printed);
  if (
    limitOn(who) ||
    /\b(?:Grappled|Restrained|Prone|Incapacitated|Charmed|Stunned|Paralyzed|Unconscious)\b/.test(
      who,
    )
  ) {
    return null;
  }
  // "If the target has 25 Hit Points or fewer, it drops to 0 Hit Points. Otherwise, the target takes …": the damage stands.
  const threshold =
    /^If the (?:target|creature) has \d+ Hit Points or fewer\b[^.]*\.\s*(?:It otherwise|Otherwise,)/i;
  if (threshold.test(failure)) left.push("a Hit Point threshold");
  const sentences = sentencesOf(failure.replace(threshold, ""));
  const damage = damageIn(sentences[0] ?? "", left);
  noteLaterDamage(sentences, left);
  const onFail = withSecondFailure(
    [
      ...conditionsIn(failure, left),
      ...ongoingDamage(failure, left),
      ...modifiersIn(failure),
      ...riderEffects(failure),
      ...both,
    ],
    second,
  );
  if (
    firstStage !== text &&
    !onFail.some((effect) => "secondFailure" in effect)
  ) {
    left.push("a later failure stage");
  }
  if (damage.length === 0 && onFail.length === 0) return null;
  // The lead-in gives the area or range when the save's own clause doesn't.
  const within = /within \d+ feet/.exec(lead)?.[0];
  const scope = !rule.replace(/[.\s]/g, "")
    ? lead
    : within && !/within \d+ feet/.test(rule)
      ? `${rule} ${within}`
      : rule;
  const targeting = targetingFor(
    who === printed ? scope : scope.replace(printed, who),
  ) as Record<string, unknown>;
  return {
    targeting:
      conditions.length > 0 && "creatures" in targeting
        ? { ...targeting, targetConditions: conditions }
        : targeting,
    resolution: {
      kind: "save",
      ability,
      dc: { base: Number(dc), add: [] },
      damage,
      onSuccessDamage: /half damage/i.test(success) ? "half" : "none",
      onFail,
      onSuccess: both,
    },
  };
}

// "First Failure: Restrained, and it repeats the save … Second Failure: Petrified instead": the one condition that's
// saved against again becomes the second one on a failure.
function withSecondFailure(
  onFail: LeafEffect[],
  second: string | undefined,
): LeafEffect[] {
  const [worse, ...more] = second
    ? conditionsIn(second, []).filter((item) => item.kind === "applyCondition")
    : [];
  const first = onFail.filter((item) => item.kind === "applyCondition");
  if (
    !worse ||
    more.length > 0 ||
    first.length !== 1 ||
    !first[0]?.repeatSave
  ) {
    return onFail;
  }
  return onFail.map((item) =>
    item.kind === "applyCondition"
      ? {
          ...item,
          secondFailure: {
            condition: worse.condition,
            duration: worse.duration,
            endsOnDamage: worse.endsOnDamage,
          },
        }
      : item,
  );
}

// null means the routine has a count that depends on something else, such as a spell's level.
function multiattackCount(text: string): number | null {
  const [first = ""] = sentencesOf(text);
  // "..., or it makes three Y attacks" is a different routine, not more attacks.
  const [routine = ""] = first.split(
    new RegExp(
      `,?\\s+or\\s+(?:it\\s+makes\\s+)?(?:(?=(?:${NUMBER})\\b)|uses\\b)`,
    ),
  );
  const counts = [
    ...routine.matchAll(
      new RegExp(
        `\\b(${NUMBER})\\b(?:(?!\\b(?:${NUMBER})\\b)[^.;])*?\\b(?:attacks?|times)\\b`,
        "gi",
      ),
    ),
  ].map((match) => NUMBER_WORDS[(match[1] ?? "").toLowerCase()] ?? 0);
  // "uses Eye Rays twice" counts as "three times" does.
  const twice = [...routine.matchAll(/\btwice\b/gi)].map(() => 2);
  if (counts.length === 0 && twice.length === 0) {
    return /\battacks?\b/i.test(routine) ? null : 1;
  }
  return [...counts, ...twice].reduce((sum, count) => sum + count, 0);
}

// "Breath Weapons (Recharge 5–6). ... Fire Breath. Dexterity Saving Throw: ... Cold Breath. ..." is several actions.
function optionsIn(
  label: string,
  text: string,
): readonly { readonly name: string; readonly text: string }[] {
  const [, ...parts] = text.split(
    new RegExp(`(?:^|\\s)((?:[A-Z][\\w’'-]* )+Breath)\\.\\s+(?=${SAVE_LABEL})`),
  );
  return parts.length === 0
    ? [{ name: label, text }]
    : parts.flatMap((name, index) =>
        index % 2 === 0 ? [{ name, text: parts[index + 1] ?? "" }] : [],
      );
}

function abilityRows(block: string): Map<string, readonly number[]> {
  const rows = new Map<string, readonly number[]>();
  // Some books put the ability name in a heading cell, and others in a plain one, which may be bold.
  for (const row of block.matchAll(
    /<tr[^>]*>\s*<t[hd][^>]*>(?:<strong>)?([^<]+)(?:<\/strong>)?<\/t[hd]>((?:\s*<td[^>]*>[^<]*<\/td>){3})/g,
  )) {
    const cells = [...(row[2] ?? "").matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(
      (cell) => Number((cell[1] ?? "").replace("−", "-").trim()),
    );
    rows.set((row[1] ?? "").trim().toLowerCase(), cells);
  }
  // Older books have no save column, so their saves come from a line of their own.
  for (const stat of block.matchAll(
    /ability-scores-heading"[^>]*>([^<]+)<[\s\S]*?ability-scores-score"[^>]*>\s*(\d+)/g,
  )) {
    rows.set((stat[1] ?? "").trim().toLowerCase(), [Number(stat[2])]);
  }
  return rows;
}

// Books close a label in several ways: "<em>Gore.</em>", "<em>Gore</em>.", "<em>Breath</em> (Recharge 5–6)."
// "<em>Gaze (Recharge</em> 5–6)." and "<em><strong>Gore.</strong> Melee Weapon Attack:</em>",
// so the label and body are put back together here.
function entryOf(
  inner: string,
): { readonly label: string; readonly text: string } | null {
  const match =
    /^\s*<strong><em>([\s\S]*?)<\/em>([^<]*)<\/strong>([\s\S]*)$/.exec(inner) ??
    /^\s*<em><strong>([\s\S]*?)<\/strong>()([\s\S]*)$/.exec(inner);
  if (!match) return null;
  const label = plainText(`${match[1] ?? ""}${match[2] ?? ""}`).replace(
    /\.$/,
    "",
  );
  const text = plainText(match[3] ?? "").replace(/^[.\s]+/, "");
  const spilled = /\([^)]*$/.test(label)
    ? /^(\d(?:[–-]\d)?\))\.?\s*/.exec(text)
    : null;
  return spilled
    ? {
        label: `${label} ${spilled[1] ?? ""}`,
        text: text.slice(spilled[0].length),
      }
    : { label, text };
}

// "(1d8 + 3) Necrotic or Radiant damage", or "(6d6 + 4) damage of a type chosen by it: Acid, Cold or Fire".
// A resolution holds one type, so the first one printed stands in for the choice.
function withFirstChosenType(text: string, left: string[]): string {
  const chosen = text
    .replace(
      new RegExp(`\\) (${TYPES})(?:(?:,| or)+ (?:${TYPES}))+ damage`, "gi"),
      ") $1 damage",
    )
    .replace(
      new RegExp(`\\) damage [^.:]*: (${TYPES})\\b[^.]*`, "gi"),
      ") $1 damage",
    );
  if (chosen !== text) left.push("a choice of damage type");
  return chosen;
}

const SECTION_LINE =
  /^(traits|actions|bonus actions|reactions|legendary actions|lair actions|mythic actions)$/i;
const COUNT = `\\d+|${NUMBER}`;
const countOf = (word: string): number =>
  NUMBER_WORDS[word.toLowerCase()] ?? Number(word);
const escaped = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "makes two Bite attacks", "makes one Rotting Fist or Channel Negative Energy attack" or "uses Dreadful Glare":
// the monster's own actions a legendary action takes, by name. Of a choice, the first printed is taken.
function actionsMade(
  text: string,
  names: readonly string[],
  left: string[],
): string[] {
  const named = (phrase: string): string | undefined =>
    names.find((name) => name.toLowerCase() === phrase.trim().toLowerCase());
  const made: string[] = [];
  for (const match of text.matchAll(
    new RegExp(`\\b(${COUNT}|a|an) ([^.,;]+?) attacks?\\b`, "gi"),
  )) {
    const choices = (match[2] ?? "").split(/\s+or\s+/);
    const name = choices.map(named).find(Boolean);
    if (!name) continue;
    if (choices.length > 1) left.push("a choice of attack");
    const word = (match[1] ?? "").toLowerCase();
    made.push(
      ...Array<string>(word === "a" || word === "an" ? 1 : countOf(word)).fill(
        name,
      ),
    );
  }
  for (const name of names) {
    if (new RegExp(`\\buses (?:its )?${escaped(name)}\\b`, "i").test(text)) {
      made.push(name);
    }
  }
  return made;
}

// Legendary actions, Legendary Resistance and lair actions, from the stat block's paragraphs as plain text.
// Older imports keep only that text, so the game reads them the same way at run time.
// `cast` reads "uses Spellcasting to cast Fear" as the spell's own effects, when the block's spells are known.
export function legendaryOf(
  lines: readonly string[],
  actionNames: readonly string[],
  cast?: (text: string) => readonly MonsterAction[],
): { readonly fields: Record<string, unknown>; readonly notes: string[] } {
  const fields: Record<string, unknown> = {};
  const notes: string[] = [];
  const legendary: unknown[] = [];
  const lair: unknown[] = [];
  let uses: { uses: number; usesInLair?: number } | null = null;
  let section = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (SECTION_LINE.test(line)) {
      section = line.toLowerCase();
      continue;
    }
    const resist =
      /^Legendary Resistance \((\d+)\/Day(?:, or (\d+)\/Day in Lair)?\)/i.exec(
        line,
      );
    if (resist) {
      fields.legendaryResistance = {
        perDay: Number(resist[1]),
        ...(resist[2] ? { inLair: Number(resist[2]) } : {}),
      };
      continue;
    }
    if (section !== "legendary actions" && section !== "lair actions") continue;
    const count =
      /Legendary Action Uses:?\s*(\d+)(?:\s*\((\d+) in Lair\))?/i.exec(line) ??
      new RegExp(`can take (${COUNT}) legendary actions`, "i").exec(line);
    if (section === "legendary actions" && count) {
      uses = {
        uses: countOf(count[1] ?? "0"),
        ...(count[2] ? { usesInLair: Number(count[2]) } : {}),
      };
      continue;
    }
    const entry = /^([^.:]{1,60})\.\s+(.+)$/s.exec(line);
    if (!entry) continue;
    const [, label = "", text = ""] = entry;
    const name = label.replace(/\s*\(.*$/, "");
    const left: string[] = [];
    const parsed = parseSave(text, left) ?? parseAttack(text, left);
    const activation = parsed ? { cost: [], ...parsed } : undefined;
    if (section === "lair actions") {
      if (activation) lair.push({ name, activation });
      else notes.push(`not automated: lair action ${name}`);
      continue;
    }
    const made = activation ? [] : actionsMade(text, actionNames, left);
    const spells = activation || made.length > 0 ? [] : (cast?.(text) ?? []);
    if (spells.length > 0) {
      const sentence = /[^.]*\bcasts?\b[^.]*\./.exec(text)?.[0] ?? "";
      // shortcut: "it can fly up to half its Fly Speed" moves it as half its Speed does.
      const flies = /\bcan fly up to half \w+ Fly Speed\b/.test(sentence);
      const rest = text
        .replace(sentence, "")
        .replace(/[^.]*can’?'?t take this action again[^.]*\.\s*/, "")
        .trim();
      if (rest || /, and (?!(?:it|he|she) can fly up to half)/.test(sentence)) {
        notes.push(`partial: ${name}: left out what follows it`);
      }
      for (const spell of spells) {
        legendary.push({
          name: spells.length > 1 ? `${name} (${spell.name})` : name,
          cost: Number(/\(Costs (\d+) Actions\)/i.exec(label)?.[1] ?? 1),
          oncePerRound: /again until the start of \w+ next turn/i.test(text),
          moves: flies,
          activation: { ...spell.activation, cost: [] },
        });
      }
      continue;
    }
    const move = activation || made.length > 0 ? null : teleportOf(text);
    if (move?.rest) left.push("what follows it");
    if (move?.others) left.push("teleporting a willing creature");
    const own = move
      ? {
          cost: [],
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            damage: [],
            effects: [
              { kind: "teleport", feet: move.feet, movement: move.movement },
            ],
          },
        }
      : activation;
    const special =
      own || made.length > 0
        ? null
        : oneOffLegendary(text, actionNames, { parseSave, parseAttack });
    if (special) left.push(...special.left);
    if (!own && !special && made.length === 0) {
      notes.push(`not automated: legendary action ${name}`);
      continue;
    }
    for (const reason of new Set(left)) {
      notes.push(`partial: ${name}: left out ${reason}`);
    }
    legendary.push({
      name,
      cost: Number(/\(Costs (\d+) Actions\)/i.exec(label)?.[1] ?? 1),
      oncePerRound: /again until the start of \w+ next turn/i.test(text),
      moves: /\bmoves? up to half \w+ Speed\b/i.test(text),
      ...(own
        ? { activation: own }
        : special
          ? { activation: special.activation }
          : { makes: made }),
    });
  }
  if (uses && legendary.length > 0) {
    fields.legendary = { ...uses, actions: legendary };
  }
  if (lair.length > 0) fields.lairActions = lair;
  return { fields, notes };
}

// "Resistances Cold, Fire", "Immunities Poison; Poisoned", or older "Damage Immunities poison" and
// "Condition Immunities poisoned". shortcut: "from nonmagical attacks" is read as all such damage.
function defencesOf(lines: readonly string[]): Passive[] {
  const passives: Passive[] = [];
  for (const line of lines) {
    const match =
      /^(Damage |Condition )?(Resistances?|Immunities|Vulnerabilities)\s+(.+)$/.exec(
        line,
      );
    if (!match) continue;
    const [, prefix, label = "", list = ""] = match;
    const words = new Set(list.toLowerCase().match(/[a-z]+/g) ?? []);
    if (prefix !== "Condition ") {
      const kind = label.startsWith("Resist")
        ? "resistance"
        : label === "Immunities"
          ? "immunity"
          : "vulnerability";
      for (const damage of DAMAGE_TYPES) {
        if (words.has(damage)) {
          passives.push({
            kind: "modifier",
            modifier: { kind, damage } as Modifier, // one of three kinds, which TypeScript can't narrow
          });
        }
      }
    }
    if (label !== "Immunities") continue;
    for (const word of words) {
      const condition = ConditionSchema.safeParse(word);
      if (condition.success) {
        passives.push({ kind: "conditionImmunity", condition: condition.data });
      }
    }
  }
  return passives;
}

// "Trigger: The knight is hit by a melee attack roll while holding a weapon. Response: The knight adds 2 to its
// AC against that attack", or "…halves the damage (round down) it takes from that attack."
// shortcut: a monster is taken to hold its weapons, so "while holding a weapon" is always met.
function guardOf(text: string): {
  readonly melee: boolean;
  readonly effect: LeafEffect;
  readonly left: string | null;
} | null {
  const trigger =
    /^Trigger: [^.:]*? is hit by an? (melee )?attack roll(?: while holding a weapon)?[.:]\s*Response: (.*)$/s.exec(
      text.trim(),
    );
  if (!trigger) return null;
  const [, melee, response = ""] = trigger;
  const ac =
    /^[^.]*? adds (\d+) to (?:its|his|her|their) AC against (?:that attack|melee attack rolls \(including the triggering attack\)[^.]*), (?:possibly|potentially) causing (?:it|the attacks) to miss\.\s*(.*)$/s.exec(
      response,
    );
  if (ac) {
    const rest = ac[2] ?? "";
    return {
      melee: Boolean(melee),
      effect: { kind: "acAgainstHit", bonus: Number(ac[1]) },
      left: response.includes("until the start of")
        ? "the bonus lasting until its next turn"
        : rest
          ? "an attack on a miss"
          : null,
    };
  }
  return /^[^.]*? halves the damage(?: \(round down\))? (?:it|he|she|they) takes? from that attack\.?$/.test(
    response.trim(),
  )
    ? {
        melee: Boolean(melee),
        effect: { kind: "reduceDamage", halve: true },
        left: null,
      }
    : null;
}

// "(Recharge 5–6)" as the lowest roll that brings it back.
function rechargeOf(label: string): number | undefined {
  const low = /\(Recharge (\d)/.exec(label)?.[1];
  return low ? Number(low) : undefined;
}

// Traits a grid fight never needs: breathing, telepathy and talk, senses for things the fight doesn't have, carrying,
// objects and homes, and coming back to life days later somewhere else.
const NO_COMBAT_TRAIT =
  /^(?:Amphibious|Water Breathing|Hold Breath|Limited Amphibiousness|Unusual Nature|Air Envelope|Mimicry|Siege Monster|Forbiddance|Beast of Burden|Increased Carrying Capacity|Inscrutable|Shielded Mind|Telepathic Shroud|Treasure Sense|Iron Scent|Lie Detector|Divine Awareness|Detect Life|Ethereal Sight|Sense Magic|Disintegration|Soul Gem|Spirit Jar|Wishes|Vampiric Connection|Podling Link|Bound|Semblance of Life|Speak with .+|.*Telepathy|Telepathic Bond|Vampire Weakness|Running Water|Stake to the Heart|Astral Implosion)$/;

function noCombatTrait(label: string, text: string): boolean {
  const name = label.replace(/\s*\(.*$/, "");
  return (
    NO_COMBAT_TRAIT.test(name) ||
    (/(?:Restoration|Immortality|Rejuvenation)$/.test(name) &&
      /\b(?:revives?|re-?forms|gains a new body|regains all its Hit Points in \d|returns to life in \d)/.test(
        text,
      ))
  );
}

// What a trait read as a passive still leaves out.
function traitLeftOut(label: string): string | null {
  if (label === "Sun Sickness") return "its death after an hour in sunlight";
  if (label === "Greater Magic Resistance") {
    return "succeeding on every save against spells";
  }
  if (label === "Superior Magic Resistance") {
    return "Disadvantage on spell attacks against it";
  }
  if (label === "Displacement") return "its end while Incapacitated";
  if (label === "Tunneler") return "the tunnel it leaves";
  if (label === "Corrosive Form")
    return "what it does to weapons and ammunition";
  if (label === "Greater Lightning Absorption") return "its Speed increase";
  return null;
}

// Moving through creatures, walls or narrow gaps, as a swarm, a ghost or an ooze does, or null for neither.
function moveThroughOf(text: string): Passive | null {
  const objects =
    /\bmove through other creatures and objects as if they were Difficult Terrain\b/i.test(
      text,
    );
  const creatures =
    objects ||
    /\boccupy another creature[’']s space and vice versa\b/.test(text) ||
    /\benter (?:a|an enemy[’']s|a creature[’']s) space and stop there\b/.test(
      text,
    );
  const earth = /\bburrow through nonmagical, unworked earth and stone\b/.test(
    text,
  );
  const rock = /\bburrow through solid rock at half its Burrow Speed\b/.test(
    text,
  );
  const squeeze =
    /\bmove through a space as narrow as 1 inch\b/.test(text) ||
    /\bmove through any opening large enough for a Tiny\b/.test(text);
  const terrain =
    /\bdoesn[’']t need to expend extra movement to move through Difficult Terrain\b/.test(
      text,
    );
  if (!creatures && !earth && !rock && !squeeze && !terrain) return null;
  return {
    kind: "moveThrough",
    ...(creatures ? { creatures: "any" as const } : {}),
    walls: objects || earth || rock,
    costly: objects || rock,
    squeeze,
    open: /\bvice versa\b/.test(text),
    terrain,
  };
}

// What a trait that moves through creatures adds: stopping in their space, as a swarm or an elemental's form does,
// burning those it enters with Fire Form, or moving without Opportunity Attacks.
function movingExtras(label: string, text: string): Passive[] {
  if (/^(?:Swarm|Air Form|Water Form|Two-Dimensionality)$/.test(label)) {
    return [{ kind: "shareSpace", who: "self", cover: false }];
  }
  const burn =
    label === "Fire Form"
      ? /\benters a creature[’']s space on a turn, that creature takes \d+ \((\d+d\d+)\) Fire damage\b/.exec(
          text,
        )?.[1]
      : undefined;
  if (burn) {
    return [
      {
        kind: "shareSpace",
        who: "self",
        cover: false,
        burn: [{ amount: { dice: burn }, type: "fire" }],
      },
    ];
  }
  return label === "Ephemeral Movement" &&
    /\bmovement doesn[’']t provoke Opportunity Attacks\b/.test(text)
    ? [{ kind: "noOpportunityAttacks" }]
    : [];
}

// Traits whose whole effect on the grid is a Speed the stat block already gives, as Spider Climb's Climb Speed.
const BY_SPEEDS = /^Spider Climb$/;

// "until the start of its next turn" in an aura's save is the target's turn, which the aura catches it on.
function theirTurns(effects: readonly LeafEffect[]): LeafEffect[] {
  return effects.map((effect) =>
    (effect.kind === "applyCondition" ||
      (effect.kind === "modifier" && effect.modifier.kind !== "noHealing")) &&
    typeof effect.duration === "object" &&
    "until" in effect.duration &&
    effect.duration.until === "yourNextTurnStart"
      ? { ...effect, duration: { until: "itsNextTurnStart" } }
      : effect,
  );
}

const IMMUNE_AFTER =
  /\bis immune to (?:this|the) [^.]*? for (?:24 hours|1 hour|\d+ hours?)\b/i;
const AWAKE =
  /\b(?:while|unless|provided) (?:it|he|she|they|the [^.,]+?) (?:doesn[’']t have|has) the Incapacitated condition\b|\bcan[’']t use this trait if (?:it|he|she|they) (?:has|have) the Incapacitated condition\b|\bdoesn[’']t function if [^.]+? has the Incapacitated condition\b/i;

// Traits that are areas: an aura that acts on whoever starts or ends a turn in it or on everyone in it as the
// monster's turn ends, one that gives those in it Advantage or stops their healing, the light it sheds, and a
// burst where it dies. Light or sunlight that hampers it is read here too. Null for any other trait.
function areaTrait(
  label: string,
  text: string,
  left: string[],
): Passive[] | null {
  const name = label.replace(/\s*\(.*$/, "");
  const awake = AWAKE.test(text) ? { awake: true as const } : {};
  const light =
    /\bsheds Bright Light in a (\d+)-foot radius and Dim Light for an additional (\d+) feet\b/.exec(
      text,
    );
  if (light) {
    const bright = Number(light[1]);
    return [
      { kind: "aura", name, zone: "light", radius: bright, area: {} },
      {
        kind: "aura",
        name,
        zone: "dim",
        radius: bright + Number(light[2]),
        area: {},
      },
    ];
  }
  const suppressed =
    /^Creatures within (\d+) feet of [^.]+? can[’']t regain Hit Points\.?$/.exec(
      text,
    );
  if (suppressed) {
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: Number(suppressed[1]),
        area: { noHealing: true },
      },
    ];
  }
  // Marshal Undead, Inspiring Presence, Aura of Authority.
  const presence =
    /^(?:(Undead) creatures|Creatures|Allies) of [^.]*?choice(?: \(excluding (?:itself|himself|herself)\))? in a (\d+)-foot Emanation originating from [^.]+? have Advantage on (attack rolls and saving throws|attack rolls|saving throws)(?: unless [^.]+? has the Incapacitated condition)?\./.exec(
      text,
    ) ??
    /^While in a (\d+)-foot Emanation originating from (?:the )?[^.,]+?, (?:the )?[^.,]+? and (?:its|his|her) allies have Advantage on (attack rolls and saving throws)\b/.exec(
      text,
    );
  if (presence) {
    const self = presence[0].startsWith("While");
    const [type, radius, rolls = ""] = self
      ? [undefined, presence[1], presence[2]]
      : [presence[1], presence[2], presence[3]];
    const grants: Modifier[] = [
      ...(rolls.includes("attack rolls")
        ? [{ kind: "advantage", on: "attacks" } as const]
        : []),
      ...(rolls.includes("saving throws")
        ? [{ kind: "advantage", on: "saves" } as const]
        : []),
    ];
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: Number(radius),
        area: {
          side: "ally",
          grants,
          ...(type ? { creatureTypes: [type.toLowerCase()] } : {}),
          ...(self ? { self: true as const } : {}),
          ...awake,
        },
      },
    ];
  }
  // Fire Aura, Heat Aura: damage to everyone close by as its turn ends.
  const burning =
    /^At the end of each of [^.]+? turns, each creature( of [^.]+? choice)? in an? (\d+)-foot Emanation originating from [^.]+? takes \d+ \((\d+d\d+)\) (\w+) damage(?: unless [^.]+? has the Incapacitated condition)?\.(.*)$/s.exec(
      text,
    );
  if (burning) {
    const [, chosen, radius, dice = "", type = ""] = burning;
    if ((burning[5] ?? "").trim()) left.push("what else it does");
    const damageType = type.toLowerCase() as Damage["type"];
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: Number(radius),
        area: {
          ...(chosen ? { side: "enemy" as const } : {}),
          when: "ownerTurnEnd",
          resolution: {
            kind: "automatic",
            damage: [{ amount: { dice }, type: damageType }],
            effects: [],
          },
          ...awake,
        },
      },
    ];
  }
  // Aura of Dread, Impossible Geometry: ground that slows, maybe with damage for whoever starts its turn there.
  const slowing =
    /^(?:Creatures in a (\d+)-foot Emanation originating from [^.]+? have their Speeds halved while in the Emanation\.(?: The [^.]+? can designate creatures to be unaffected by the aura\.)?|Ground, air, and water in a (\d+)-foot Emanation originating from [^.]+? is Difficult Terrain\.(?: A creature that starts its turn in the Emanation takes \d+ \((\d+d\d+)\) (\w+) damage\.)?)$/.exec(
      text,
    );
  if (slowing) {
    const [, halved, ground, dice, type = ""] = slowing;
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: Number(halved ?? ground),
        area: {
          ...(halved ? { side: "enemy" as const } : {}),
          difficult: true,
          ...(dice
            ? {
                when: "turnStart" as const,
                resolution: {
                  kind: "automatic" as const,
                  damage: [
                    {
                      amount: { dice },
                      type: type.toLowerCase() as Damage["type"],
                    },
                  ],
                  effects: [],
                },
              }
            : {}),
        },
      },
    ];
  }
  // Bolster Inventions: Temporary Hit Points for its allies of a kind as its turn ends.
  const bolster =
    /^At the end of each of [^.]+? turns, each of (?:its|his|her) (\w+) allies in a (\d+)-foot Emanation originating from [^.]+? gains (\d+) Temporary Hit Points\./.exec(
      text,
    );
  if (bolster) {
    const [, type = "", radius, amount] = bolster;
    return [
      {
        kind: "aura",
        name,
        zone: "area",
        radius: Number(radius),
        area: {
          side: "ally",
          creatureTypes: [type.toLowerCase()],
          when: "ownerTurnEnd",
          resolution: {
            kind: "automatic",
            damage: [],
            effects: [
              {
                kind: "tempHp",
                amount: { bonus: { base: Number(amount), add: [] } },
              },
            ],
          },
          ...awake,
        },
      },
    ];
  }
  // Death Burst, Death Throes: a save where it falls.
  const burst = /^The [^.]+? (?:explodes|bursts) when it dies\.\s*(.*)$/s.exec(
    text,
  );
  if (burst) {
    const parsed = parseSaveFrom(burst[1] ?? "", "", left);
    const area = (parsed?.targeting ?? {}) as {
      area?: { radius?: number };
    };
    if (!parsed || area.area?.radius === undefined) return null;
    return [
      {
        kind: "deathBurst",
        name,
        radius: area.area.radius,
        resolution: parsed.resolution,
      },
    ];
  }
  const placed = guardingTrait(name, text, awake);
  if (placed) return placed;
  // Stench, Terrifying Aura: a save for whoever starts or ends its turn in it, or for everyone in it as the
  // monster's turn ends. Culling Aura's acts only on the Bloodied.
  const bloodied = /\beach Bloodied creature\b/.test(text);
  const at = text.search(SAVE_START);
  const saving = (at >= 0 ? text.slice(at) : "").replace(
    /\beach Bloodied creature\b/,
    "each creature",
  );
  // Possessive Aura names the turn before its save.
  const lead = at >= 0 ? text.slice(0, at) : "";
  const turn =
    /\b(any|each) (creature|enemy)\b[^.]*?\b(starts|ends) its turn in (?:an? (\d+)-foot Emanation|the (?:aura|area))/i.exec(
      saving,
    ) ??
    /\beach (creature)\b() in an? (\d+)-foot Emanation originating from [^.]+? at the end of [^.]+? turn\b/i.exec(
      saving,
    ) ??
    /\b(a) (creature)\b that (starts|ends) its turn in (?:this|the) (?:aura|area)\b/i.exec(
      lead,
    );
  if (!turn) return null;
  const radius = Number(
    turn[4] ??
      (turn[3] && /^\d+$/.test(turn[3]) ? turn[3] : undefined) ??
      /\bin a (\d+)-foot Emanation\b/.exec(text)?.[1],
  );
  if (!radius) return null;
  const parsed = parseSaveFrom(
    saving.replace(IMMUNE_AFTER, "is unaffected"),
    "",
    left,
  );
  if (parsed?.resolution.kind !== "save") return null;
  const when = /\bstarts its turn\b/i.test(turn[0])
    ? ("turnStart" as const)
    : /\bends its turn\b/i.test(turn[0])
      ? ("turnEnd" as const)
      : ("ownerTurnEnd" as const);
  const immune = IMMUNE_AFTER.test(saving);
  return [
    {
      kind: "aura",
      name,
      zone: "area",
      radius,
      area: {
        ...(/enemy/i.test(turn[2] ?? "") ? { side: "enemy" as const } : {}),
        ...(bloodied ? { bloodied: true as const } : {}),
        when,
        resolution: {
          ...parsed.resolution,
          onFail: speedless(theirTurns(parsed.resolution.onFail), saving),
          onSuccess: immune
            ? [
                {
                  kind: "modifier",
                  modifier: { kind: "areaImmunity" },
                  duration: { minutes: 1440 },
                },
              ]
            : [],
        },
        ...awake,
      },
    },
  ];
}

// "While the creature is Charmed in this way, its Speed is reduced to 0": no walking while the condition lasts, gone
// with it, as Possessive Aura's.
function speedless(effects: LeafEffect[], text: string): LeafEffect[] {
  if (!/\bWhile [^.]+? in this way, its Speed is reduced to 0\b/.test(text)) {
    return effects;
  }
  const held = effects.find((effect) => effect.kind === "applyCondition");
  if (held?.kind !== "applyCondition") return effects;
  return [
    ...effects,
    {
      kind: "modifier",
      modifier: { kind: "actionLimit", speed: "none" },
      duration:
        typeof held.duration === "object"
          ? { ...held.duration }
          : held.duration,
      ...(held.repeatSave ? { repeatSave: true } : {}),
    },
  ];
}

// The one-off auras: immunity or Advantage for allies in it, a save that foils spells cast inside the creature's
// space, a burst when it takes damage of a type, a forced Reaction attack as its turn ends, and conditions in and
// out of fog. Null for any other trait.
function guardingTrait(
  name: string,
  text: string,
  awake: { readonly awake?: true },
): Passive[] | null {
  const aura = (radius: string | undefined, area: AreaEffect): Passive[] => [
    { kind: "aura", name, zone: "area", radius: Number(radius), area },
  ];
  const conditionsOf = (list: string): Condition[] =>
    list
      .split(/,\s*|\s+(?:and|or)\s+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item): item is Condition =>
        ConditionSchema.options.includes(item as Condition),
      );
  // Aura of Bravery.
  const brave =
    /^Creatures of [^.]*?choice in a (\d+)-foot Emanation originating from [^.]+? have Immunity to the ([\w ,]+?) conditions? while there\.$/.exec(
      text,
    );
  if (brave) {
    return aura(brave[1], {
      side: "ally",
      self: true,
      grants: conditionsOf(brave[2] ?? "").map((condition) => ({
        kind: "conditionImmunity" as const,
        condition,
      })),
      ...awake,
    });
  }
  // Words of Reason.
  const reason =
    /^Allies in a (\d+)-foot Emanation originating from [^.]+? have Advantage on saving throws to avoid or end the ([\w ,]+?) conditions?\./.exec(
      text,
    );
  if (reason) {
    const conditions = conditionsOf(reason[2] ?? "");
    return aura(reason[1], {
      side: "ally",
      grants: [{ kind: "advantage", on: "saves", conditions }],
      ...awake,
    });
  }
  // Haunted Zone. shortcut: a creature takes one square, so "inside its space" is within 10 feet of it, as a
  // Gargantuan creature's 20-foot space.
  const haunted = new RegExp(
    `^(${Object.values(ABILITIES).join("|")}) Saving Throw: DC (\\d+), any creature that casts a spell while inside [^.]+? space\\. Failure: The spell fails and is wasted\\.$`,
  ).exec(text);
  if (haunted) {
    const ability = (Object.keys(ABILITIES) as AbilityKey[]).find(
      (key) => ABILITIES[key] === haunted[1],
    );
    if (!ability) return null;
    return aura("10", {
      foilsSpells: { ability, dc: Number(haunted[2]) },
    });
  }
  // Explosive Core.
  const core =
    /^When [^.]+? is subjected to (\w+) damage, each creature in an? (\d+)-foot Emanation originating from [^.]+? takes \d+ \((\d+d\d+)\) (\w+) damage\.$/.exec(
      text,
    );
  if (core) {
    const [, trigger = "", radius, dice = "", type = ""] = core;
    return [
      {
        kind: "damageBurst",
        name,
        damage: [trigger.toLowerCase() as Damage["type"]],
        radius: Number(radius),
        resolution: {
          kind: "automatic",
          damage: [
            { amount: { dice }, type: type.toLowerCase() as Damage["type"] },
          ],
          effects: [],
        },
      },
    ];
  }
  // Aura of Violence.
  const violence =
    /^At the end of each of [^.]+? turns, each creature( of [^.]+? choice)? in an? (\d+)-foot Emanation originating from [^.]+? suffers the following effect\.\s*(.*)$/s.exec(
      text,
    );
  const forced =
    /\s*Failure: The target takes a Reaction to make a melee attack roll against a creature within reach\. If no creature is within reach, the target takes \d+ \((\d+d\d+)\) (\w+) damage\.$/;
  const save = /^(\w+) Saving Throw: DC (\d+)\./.exec(violence?.[3] ?? "");
  const saveAbility = (Object.keys(ABILITIES) as AbilityKey[]).find(
    (key) => ABILITIES[key] === save?.[1],
  );
  if (violence && save && saveAbility && forced.test(violence[3] ?? "")) {
    const [, dice = "", type = ""] = forced.exec(violence[3] ?? "") ?? [];
    return aura(violence[2], {
      ...(violence[1] ? { side: "enemy" as const } : {}),
      when: "ownerTurnEnd",
      resolution: {
        kind: "save",
        ability: saveAbility,
        dc: { base: Number(save[2]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        onFail: [
          {
            kind: "forcedAttack",
            otherwise: [
              { amount: { dice }, type: type.toLowerCase() as Damage["type"] },
            ],
          },
        ],
        onSuccess: [],
      },
      ...awake,
    });
  }
  // One with the Mists.
  const misty =
    /^While [^.]+? is in fog or mist, it has the (\w+) condition\. [^.]+? has the (\w+) condition while it is outside an area of fog or mist\.$/.exec(
      text,
    );
  if (misty) {
    return [
      {
        kind: "fogBound",
        inside: conditionsOf(misty[1] ?? ""),
        outside: conditionsOf(misty[2] ?? ""),
      },
    ];
  }
  return null;
}

// In sunlight, or in Bright Light: Disadvantage on its rolls, and damage as its turn starts there.
function lightTrait(text: string): Passive | null {
  const hampered =
    /\bWhile in (sunlight|Bright Light), [^.]+? has Disadvantage on (D20 Tests|ability checks and attack rolls|attack rolls and ability checks|attack rolls)\./.exec(
      text,
    );
  if (!hampered) return null;
  const rolls = hampered[2] ?? "";
  const disadvantage = [
    ...(/attack|D20/.test(rolls) ? (["attacks"] as const) : []),
    ...(rolls.includes("D20") ? (["saves"] as const) : []),
    ...(/check|D20/.test(rolls) ? (["checks"] as const) : []),
  ];
  const burn =
    /\btakes (\d+) Radiant damage if it starts its turn in sunlight\b/.exec(
      text,
    )?.[1];
  return {
    kind: "lightSensitive",
    light: hampered[1] === "sunlight" ? "sunlight" : "bright",
    disadvantage,
    damage: burn
      ? [
          {
            amount: { bonus: { base: Number(burn), add: [] } },
            type: "radiant",
          },
        ]
      : [],
  };
}

// The traits the engine already knows how to play, or null for one it doesn't.
export function traitPassive(label: string, text: string): Passive | null {
  const sensitive = lightTrait(text);
  if (sensitive) return sensitive;
  // Living Shadow: Resistance in Dim Light or Darkness.
  const shadow =
    /^While in Dim Light or Darkness, [^.]+? has Resistance to damage that isn[’']t ([^.]+)\.$/.exec(
      text,
    )?.[1];
  if (shadow) {
    return {
      kind: "resistAll",
      while: "shadows",
      except: DAMAGE_TYPES.filter((type) =>
        new RegExp(`\\b${type}\\b`, "i").test(shadow),
      ),
    };
  }
  if (/^(?:Greater |Superior )?Magic Resistance$/.test(label)) {
    return { kind: "magicResistance" };
  }
  if (
    /doesn[’']t provoke (?:an )?Opportunity Attacks? when it (?:flies|moves) out of an enemy[’']s reach/i.test(
      text,
    )
  ) {
    return { kind: "noOpportunityAttacks" };
  }
  const evasion =
    /subjected to an effect that allows \w+ to make an? (Dexterity )?saving throw to take only half damage/i.exec(
      text,
    );
  if (evasion) return { kind: "evasion", anySave: !evasion[1] };
  if (
    /Advantage on (?:melee )?attack rolls against any creature that doesn[’']t have all its Hit Points/i.test(
      text,
    )
  ) {
    return { kind: "attackAdvantage", when: "targetHurt" };
  }
  if (
    /^While Bloodied, [^.,]+ has Advantage on attack rolls(?: and saving throws)?\.?$/i.test(
      text,
    ) ||
    /has Advantage on (?:melee )?attack rolls while (?:it|he|she|they) (?:is|are) Bloodied\.?$/.test(
      text,
    )
  ) {
    return { kind: "attackAdvantage", when: "bloodied" };
  }
  if (
    /Advantage on attack rolls against (?:targets|creatures) that have the Frightened condition/i.test(
      text,
    )
  ) {
    return { kind: "attackAdvantage", when: "targetFrightened" };
  }
  if (label === "Immutable Form") return { kind: "immutableForm" };
  const absorbed =
    /\bregains a number of Hit Points equal to the (\w+) damage dealt\b/.exec(
      text,
    )?.[1];
  const absorbedType = DAMAGE_TYPES.find(
    (type) => type === absorbed?.toLowerCase(),
  );
  if (label.endsWith("Absorption") && absorbedType) {
    return { kind: "absorb", damage: [absorbedType] };
  }
  if (
    /^Attack rolls against [^.]+ have Disadvantage\. If [^.]+ makes an attack roll, this trait is suppressed/.test(
      text,
    )
  ) {
    return { kind: "ward", suppressed: "attacking" };
  }
  if (
    /^Attack rolls against [^.]+ have Disadvantage\. This trait is suppressed while [^.]+ has the Incapacitated condition/.test(
      text,
    )
  ) {
    return { kind: "ward", suppressed: "incapacitated" };
  }
  if (/\bcan take one Reaction on every turn of combat\b/.test(text)) {
    return { kind: "reactive" };
  }
  if (/^The [^.]+ has the Invisible condition\.?$/.test(text)) {
    return { kind: "innateCondition", condition: "invisible" };
  }
  const flinch =
    /^If the [^.]+ takes (\w+) damage, it has Disadvantage on attack rolls and ability checks until the end of its next turn\.?$/.exec(
      text,
    )?.[1];
  const flinchType = DAMAGE_TYPES.find(
    (type) => type === flinch?.toLowerCase(),
  );
  if (flinchType) {
    return {
      kind: "onDamage",
      damage: [flinchType],
      modifiers: [
        { kind: "disadvantage", on: "attacks" },
        { kind: "disadvantage", on: "checks" },
      ],
    };
  }
  const corrosive =
    /^A creature that hits [^.]+ with a melee attack roll takes \d+ \((\d+d\d+)\) (\w+) damage\./.exec(
      text,
    );
  const corrosiveType = DAMAGE_TYPES.find(
    (type) => type === corrosive?.[2]?.toLowerCase(),
  );
  if (corrosive?.[1] && corrosiveType) {
    return {
      kind: "modifier",
      modifier: {
        kind: "retaliate",
        damage: [{ amount: { dice: corrosive[1] }, type: corrosiveType }],
      },
    };
  }
  if (/^The [^.]+ adheres to anything that touches it\./.test(text)) {
    return {
      kind: "modifier",
      modifier: { kind: "retaliate", damage: [], grapple: true },
    };
  }
  const stone =
    /drops to 0 Hit Points while it doesn[’']t have the Petrified condition, it turns to stone, regains (\d+) Hit Points/.exec(
      text,
    )?.[1];
  if (stone) return { kind: "stoneRestoration", hp: Number(stone) };
  if (
    label === "Fey Ancestry" &&
    /Advantage on saving throws (?:it makes )?to avoid or end the Charmed condition/i.test(
      text,
    )
  ) {
    return { kind: "saveAdvantage", abilities: [], conditions: ["charmed"] };
  }
  if (label === "Lucky" && /\brolls a 1 on the d20\b/.test(text)) {
    return { kind: "rerollOnes" };
  }
  if (
    label === "Displacement" &&
    /^Attack rolls against [^.]+ have Disadvantage/.test(text)
  ) {
    return {
      kind: "modifier",
      modifier: { kind: "disadvantage", on: "attacksAgainst" },
    };
  }
  if (label === "Pack Tactics") return { kind: "packTactics" };
  if (
    label === "Web Walker" &&
    /\bignores movement restrictions caused by webs\b/.test(text)
  ) {
    return { kind: "webWalker" };
  }
  const through = moveThroughOf(text);
  if (through) return through;
  if (
    label === "Jumper" &&
    /\bjump distance is determined using its Dexterity rather than its Strength\b/.test(
      text,
    )
  ) {
    return { kind: "jump", runUp: 10, ability: "dex" };
  }
  const leap =
    /\bLong Jump is up to (\d+) feet\b[^.]*\bwith or without a running start\b/.exec(
      text,
    ) ??
    /\bWith a (\d+)-foot running start, [^.]+? can Long Jump up to (\d+) feet\b/.exec(
      text,
    );
  if (leap) {
    return leap[2]
      ? { kind: "jump", feet: Number(leap[2]), runUp: Number(leap[1]) }
      : { kind: "jump", feet: Number(leap[1]), runUp: 0 };
  }
  if (label === "Undead Fortitude") return { kind: "undeadFortitude" };
  const regains = /\b(?:re)?gains (\d+) Hit Points\b/.exec(text)?.[1];
  if (!/^Regeneration\b/.test(label) || !regains) return null;
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
  return {
    kind: "regeneration",
    hp: Number(regains),
    stoppedBy: DAMAGE_TYPES.filter((damage) => words.has(damage)),
  };
}

// A list printed under an entry, as Eye Rays' rays, joins that entry's text as "• Name. text" items.
function listsFolded(block: string): string {
  return block.replace(
    /<\/p>\s*<(ol|ul)\b[^>]*>([\s\S]*?)<\/\1>/g,
    (_, _tag: string, items: string) =>
      `${items.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/g, " • $1")}</p>`,
  );
}

type Paragraph = readonly [string, string, string];

// Entries printed after one that ends in "the following effects:" are its options, not entries of their own: a
// satyr's songs, a syringe's serums, a variant's "(Hunter Only)" effects, a sphinx's First to Third Roar. They join
// it as "• Name. text" items until the section ends, or until the options' kind of label does.
const NOT_AN_OPTION =
  /^(?:Multiattack|(?:Innate )?Spellcasting|Magic Resistance|Legendary Resistance)\b/;
function foldedOptions(found: readonly RegExpMatchArray[]): Paragraph[] {
  const out: [string, string, string][] = [];
  let parent: [string, string, string] | null = null;
  let kind: RegExp | null = null;
  for (const match of found) {
    const item: [string, string, string] = [
      match[0],
      match[1] ?? "",
      match[2] ?? "",
    ];
    const header = /monster-header|Stat-Block-Heading/.test(item[1]);
    const entry = header ? null : entryOf(item[2]);
    // "1: Insect Hive. …" printed as a paragraph of its own.
    if (parent && !header && !entry && /^\d+: [A-Z]/.test(plainText(item[2]))) {
      parent[2] = `${parent[2]} ${item[2]}`;
      continue;
    }
    if (parent && entry && !NOT_AN_OPTION.test(entry.label)) {
      kind ??= /\((?:\w+ )?Only\)$/.test(entry.label)
        ? /\((?:\w+ )?Only\)$/
        : /^(?:First|Second|Third|Fourth|Fifth)\b/.test(entry.label)
          ? /^(?:First|Second|Third|Fourth|Fifth)\b/
          : /./;
      // An attack, a save, a spell or a limited use of its own is the next action, not an option.
      const own =
        kind.source === "." &&
        (/Attack(?: Roll)?:|Saving Throw:|\bcasts\b/.test(entry.text) ||
          /\((?:Recharge|\d+\/Day)/.test(entry.label));
      if (!own && kind.test(entry.label)) {
        parent[2] = `${parent[2]} • ${item[2]}`;
        continue;
      }
    }
    parent = null;
    kind = null;
    out.push(item);
    if (
      entry &&
      !NOT_AN_OPTION.test(entry.label) &&
      /:\s*$/.test(entry.text) &&
      /\bone of the following effects\b|\bas detailed below\b|\bsubjected to [^.:]+ effect:\s*$/i.test(
        entry.text,
      )
    ) {
      parent = item;
    }
  }
  return out;
}

// "• Captivated (Forager Only). … • Fearful (Hunter Only). …": the played variant's option stands in for the list.
function playedVariant(label: string, text: string, notes: string[]): string {
  const options =
    /^(.*?)(?:\s*[^.:]*\b[Oo]ne of the following effects(?: occurs)?:)\s*(•.*)$/s.exec(
      text,
    );
  if (!options || !/\((?:\w+ )?Only\)\./.test(options[2] ?? "")) return text;
  const chosen = new RegExp(
    `•\\s*[^.•]*\\(${VARIANT} Only\\)\\.\\s*([^•]*)`,
  ).exec(options[2] ?? "")?.[1];
  notes.push(
    `partial: ${label.replace(/\s*\(.*$/, "")}: left out the other variants' effects`,
  );
  return chosen ? `${options[1] ?? ""} ${chosen.trim()}` : (options[1] ?? "");
}

// Second pass, for a block the first pass found no action in. It's separate so that blocks which already parse don't change.
function parseBlock(
  block: string,
  pluginId: string,
  secondPass = false,
  spells?: SpellLookup,
): ParsedImport | null {
  const name = plainText(
    /<(?:h[1-6]|p class="[^"]*Stat-Block-Title[^"]*")[^>]*>([\s\S]*?)<\/(?:h[1-6]|p)>/.exec(
      block,
    )?.[1] ?? "",
  );
  const found = [
    ...listsFolded(block).matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g),
  ];
  const paragraphs = foldedOptions(found);
  const lines = paragraphs.map((item) => plainText(item[2]));
  // The stat block as printed, for its text and for what reads it as printed: shapes and legendary actions.
  const printed = found.map((item) => plainText(item[2] ?? ""));
  const field = (pattern: RegExp): string | undefined =>
    lines.map((line) => pattern.exec(line)?.[1]).find(Boolean);

  const ac = field(/^(?:AC|Armor Class)\s+(\d+)/);
  const hp = field(/^(?:HP|Hit Points)\s+(\d+)/);
  const rows = abilityRows(block);
  const scores = Object.fromEntries(
    (Object.keys(ABILITIES) as AbilityKey[]).map((key) => [
      key,
      rows.get(key)?.[0],
    ]),
  );
  if (
    !name ||
    !ac ||
    !hp ||
    Object.values(scores).some((s) => s === undefined)
  ) {
    return null;
  }
  const savesLine = field(/^Saving Throws\s+(.*)/) ?? "";
  const saves = (Object.keys(ABILITIES) as AbilityKey[]).filter((key) => {
    const [, modifier, save] = rows.get(key) ?? [];
    return (
      (save !== undefined && save !== modifier) ||
      new RegExp(`\\b${key}\\b`, "i").test(savesLine)
    );
  });

  const slug = slugOf(name);
  const kind = lines.map((line) => CREATURE_KIND.exec(line)).find(Boolean);
  const size = kind?.[1]?.toLowerCase();
  const actions: unknown[] = [];
  const notes: string[] = [];
  const passives = defencesOf(lines);
  const advantageDice = new Set<string>();
  let multiattack = 1;
  let section = "";
  // "using the same spellcasting ability as Spellcasting" points at the block's own Spellcasting entry.
  const proficiency = Number(field(/\b(?:PB|Proficiency Bonus) \+(\d+)/) ?? 2);
  const blockCaster = casterIn(
    lines.find((line) => /spellcasting ability/i.test(line)) ?? "",
    scores,
    proficiency,
  );
  const casterFor = (text: string): Caster => {
    const own = casterIn(text, scores, proficiency);
    return own.mod === null ? { ...blockCaster, ...nonNull(own) } : own;
  };
  // Where each entry's actions start, with the shapes its label limits them to.
  const marks: { at: number; forms: readonly string[] | undefined }[] = [];
  const shapePassives: { forms: readonly string[]; passive: Passive }[] = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    const attributes = paragraph[1];
    const inner = paragraph[2];
    marks.push({
      at: actions.length,
      forms: formsOnly(entryOf(inner)?.label ?? ""),
    });
    if (/monster-header|Stat-Block-Heading/.test(attributes)) {
      section = plainText(inner)
        .toLowerCase()
        .replace(/^bonus action$/, "bonus actions");
      continue;
    }
    const entry = entryOf(inner);
    if (!entry) continue;
    const { label } = entry;
    const folded = playedVariant(label, entry.text, notes);
    // The general readers take the entry without the options folded under it, which are reported as their own
    // entries were unless a one-off reader takes them.
    const [text = "", ...optionTexts] = folded.split(" • ");
    const leftOptions = () => {
      for (const option of optionTexts) {
        const name = /^([^.]{1,60})\./.exec(option)?.[1];
        if (name) notes.push(`not automated: ${name}`);
      }
    };
    // Paragraphs of its own text printed after it, as "While grafted, …", which only the one-off readers take.
    const next = paragraphs
      .slice(index + 1)
      .findIndex(
        (item) =>
          entryOf(item[2]) !== null ||
          /monster-header|Stat-Block-Heading/.test(item[1]),
      );
    const whole = [
      folded,
      ...lines.slice(index + 1, next < 0 ? undefined : index + 1 + next),
    ].join(" ");
    // legendaryOf reads these, and reports what it can't automate.
    if (
      section === "legendary actions" ||
      section === "lair actions" ||
      /^Legendary Resistance\b/i.test(label)
    ) {
      continue;
    }
    // Its spell lists follow it in paragraphs of their own, until the next entry.
    if (
      spells &&
      /^(?:Innate )?Spellcasting\b/.test(label) &&
      ["", "traits", "actions", "bonus actions"].includes(section)
    ) {
      const following = paragraphs.slice(index + 1);
      const end = following.findIndex(
        (item) =>
          entryOf(item[2]) !== null ||
          /monster-header|Stat-Block-Heading/.test(item[1]),
      );
      const entryText = [
        text,
        ...lines.slice(
          index + 1,
          index + 1 + (end < 0 ? following.length : end),
        ),
      ].join("\n");
      const listed = spellcastingActions(
        entryText,
        section === "traits" || section === "" ? [] : [costOf(section)],
        casterFor(text),
        spells,
        notes,
      );
      if (listed.length === 0) {
        notes.push(
          nothingToCast(spellcastingItems(entryText), spells)
            ? `no combat use: ${label}`
            : `not automated: ${label}`,
        );
      }
      actions.push(...listed);
      continue;
    }
    // Older books print traits before any heading.
    if (section === "traits" || section === "") {
      const special = oneOffTrait(label, whole);
      if (special) {
        passives.push(...special.passives);
        notes.push(...special.notes);
        continue;
      }
      leftOptions();
      const leftOut: string[] = [];
      const placed = areaTrait(label, text, leftOut);
      const passive = placed ? null : traitPassive(label, text);
      const left = passive
        ? traitLeftOut(label)
        : leftOut.length > 0
          ? [...new Set(leftOut)].join(", ")
          : null;
      const forms = formsOnly(label);
      if (passive && forms) shapePassives.push({ forms, passive });
      else if (passive) passives.push(passive, ...movingExtras(label, text));
      if (placed) passives.push(...placed);
      // "While Bloodied, … has Advantage on attack rolls and saving throws."
      if (
        passive?.kind === "attackAdvantage" &&
        passive.when === "bloodied" &&
        /\bAdvantage on attack rolls and saving throws\b/.test(text)
      ) {
        passives.push({
          kind: "saveAdvantage",
          abilities: ["str", "dex", "con", "int", "wis", "cha"],
          conditions: [],
          bloodied: true,
        });
      }
      if (left) notes.push(`partial: ${label}: left out ${left}`);
      if (!passive && !placed && !BY_SPEEDS.test(label)) {
        notes.push(
          `${noCombatTrait(label, text) ? "no combat use" : "not automated"}: ${label}`,
        );
      }
      continue;
    }
    if (/^multiattack/i.test(label)) {
      // "as many Bite attacks as it has heads" takes the heads a trait names.
      const heads = new RegExp(`\\b(${NUMBER}) heads\\b`, "i").exec(
        lines.join(" "),
      )?.[1];
      const count = multiattackCount(text) ?? (heads ? countOf(heads) : null);
      if (count === null) notes.push(`not automated: ${label} count`);
      multiattack = count ?? 1;
      continue;
    }
    // "casts Counterspell or Shield in response to the spell's trigger": the spells' own triggers say when.
    const reactionDays = /\((\d+)\/Day\b/.exec(label)?.[1];
    const reactions =
      section === "reactions" && spells
        ? castActions(
            text,
            {
              cost: ["reaction"],
              ...(reactionDays
                ? {
                    perDay: Number(reactionDays),
                    resource: `day:${slugOf(label.replace(/\s*\(.*$/, ""))}`,
                  }
                : {}),
            },
            casterFor(text),
            spells,
            notes,
          )
        : [];
    if (reactions.length > 0) {
      actions.push(...reactions);
      continue;
    }
    // "Trigger: … Response: …" the engine answers (import/monster-reactions.ts), or else a Parry-shaped guard.
    const reaction =
      section === "reactions" ? reactionOf(text, parseSave) : null;
    const guard = section === "reactions" && !reaction ? guardOf(text) : null;
    if (reaction) {
      const name = label.replace(/\s*\(.*$/, "");
      for (const reason of new Set(reaction.left)) {
        notes.push(`partial: ${name}: left out ${reason}`);
      }
      actions.push({
        name,
        ...(reactionDays ? { perDay: Number(reactionDays) } : {}),
        ...(rechargeOf(label) ? { recharge: rechargeOf(label) } : {}),
        activation: {
          cost: [
            "reaction",
            ...(reactionDays || rechargeOf(label)
              ? [
                  {
                    resource: `${reactionDays ? "day" : "recharge"}:${slugOf(name)}`,
                  },
                ]
              : []),
          ],
          trigger: reaction.trigger,
          targeting: reaction.targeting,
          resolution: reaction.resolution,
        },
      });
      continue;
    }
    if (guard) {
      const name = label.replace(/\s*\(.*$/, "");
      if (guard.left) notes.push(`partial: ${name}: left out ${guard.left}`);
      actions.push({
        name,
        ...(reactionDays ? { perDay: Number(reactionDays) } : {}),
        activation: {
          cost: [
            "reaction",
            ...(reactionDays ? [{ resource: `day:${slugOf(name)}` }] : []),
          ],
          trigger: {
            hitByAttack: true,
            ...(guard.melee ? { melee: true } : {}),
          },
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            damage: [],
            effects: [guard.effect],
          },
        },
      });
      continue;
    }
    const reacts =
      section === "reactions" ? oneOffReaction(label, whole) : null;
    if (reacts) {
      actions.push(...reacts.actions);
      notes.push(...reacts.notes);
      continue;
    }
    if (section !== "actions" && section !== "bonus actions") {
      notes.push(`not automated: ${label}`);
      continue;
    }
    // Nimble Escape or Cunning Action: "The goblin takes the Disengage or Hide action."
    const tactics =
      /^[^.]*?\btakes the ((?:Dash|Disengage|Hide)(?:,? (?:or )?(?:Dash|Disengage|Hide))*) action\.?$/.exec(
        text.trim(),
      )?.[1];
    if (section === "bonus actions" && tactics && !label.includes("(")) {
      passives.push({
        kind: "bonusTactics",
        tactics: [...tactics.matchAll(/Dash|Disengage|Hide/g)].map(
          (match) => match[0].toLowerCase() as "dash" | "disengage" | "hide",
        ),
      });
      continue;
    }
    // Charge: "The troll moves up to half its Speed straight toward an enemy it can see." A Dash toward the foes,
    // which is where a monster's moves go.
    const charge =
      /^[^.]*?\bmoves up to (half )?its Speed(?: or (?:its )?\w+ Speed)? straight toward an enemy it can (?:see|sense)( without provoking Opportunity Attacks)?\.?$/.exec(
        text.trim(),
      );
    if (section === "bonus actions" && charge && !label.includes("(")) {
      passives.push({
        kind: "bonusTactics",
        tactics: ["dash"],
        ...(charge[1] ? { half: true as const } : {}),
        ...(charge[2] ? { safe: true as const } : {}),
      });
      continue;
    }
    const special = oneOffAction(
      label,
      whole,
      section,
      actions,
      {
        parseSave,
        parseAttack,
      } satisfies Readers,
      Number(field(/^Speed\s+(\d+)/) ?? 0),
      lines.join("\n"),
    );
    if (special) {
      actions.push(...special.actions);
      passives.push(...special.passives);
      notes.push(...special.notes);
      continue;
    }
    leftOptions();
    const rechargeOn = /\(Recharge (\d)/.exec(label)?.[1];
    const perDay = /\((\d+)\/Day\b/.exec(label)?.[1];
    const resource = `${perDay ? "day" : "recharge"}:${slugOf(label.replace(/\s*\(.*$/, ""))}`;
    let recharge = rechargeOn; // options share one recharge, and each action holding it would roll for it
    for (const option of optionsIn(label, withOwnSize(text, size))) {
      let left: string[] = [];
      let optionText = secondPass
        ? withFirstChosenType(option.text, left)
        : option.text;
      let parsed =
        parseAttack(optionText, left) ??
        parseSave(optionText, left) ??
        parseSwallow(optionText, left);
      // "Acid or Necrotic damage (its choice)" is read as the first type when nothing else could be.
      if (!parsed && !secondPass) {
        const retry: string[] = [];
        const chosen = withFirstChosenType(option.text, retry);
        const again =
          chosen === option.text
            ? null
            : (parseAttack(chosen, retry) ?? parseSave(chosen, retry));
        if (again) {
          parsed = again;
          left = retry;
          optionText = chosen;
        }
      }
      if (!parsed) {
        const cast = spells
          ? castActions(
              optionText,
              {
                cost: [costOf(section)],
                ...(recharge ? { recharge: Number(recharge) } : {}),
                ...(perDay ? { perDay: Number(perDay) } : {}),
                ...(rechargeOn || perDay ? { resource } : {}),
              },
              casterFor(optionText),
              spells,
              notes,
            )
          : [];
        const move = cast.length === 0 ? teleportOf(optionText) : null;
        if (move) {
          const actionName = option.name.replace(/\s*\(.*$/, "");
          if (move.rest) {
            notes.push(`partial: ${actionName}: left out what follows it`);
          }
          if (move.others) {
            notes.push(
              `partial: ${actionName}: left out teleporting a willing creature`,
            );
          }
          actions.push({
            name: actionName,
            ...(recharge ? { recharge: Number(recharge) } : {}),
            ...(perDay ? { perDay: Number(perDay) } : {}),
            activation: {
              cost: [
                costOf(section),
                ...(rechargeOn || perDay ? [{ resource }] : []),
              ],
              targeting: { self: true },
              resolution: {
                kind: "automatic",
                damage: [],
                effects: [
                  {
                    kind: "teleport",
                    feet: move.feet,
                    movement: move.movement,
                  },
                ],
              },
            },
          });
          recharge = undefined;
          continue;
        }
        if (cast.length === 0) {
          notes.push(
            spells && nothingToCast(castItems(optionText), spells)
              ? `no combat use: ${option.name}`
              : `not automated: ${option.name}`,
          );
        } else recharge = undefined;
        actions.push(...cast);
        continue;
      }
      const actionName = option.name.replace(/\s*\(.*$/, "");
      for (const reason of new Set(left)) {
        notes.push(`partial: ${actionName}: left out ${reason}`);
      }
      for (const dice of parsed.advantageDice ?? []) advantageDice.add(dice);
      const cost = [
        costOf(section),
        ...(rechargeOn || perDay ? [{ resource }] : []),
      ];
      actions.push({
        name: actionName,
        ...(recharge ? { recharge: Number(recharge) } : {}),
        ...(perDay ? { perDay: Number(perDay) } : {}),
        activation: {
          cost,
          targeting: parsed.targeting,
          resolution: parsed.resolution,
        },
      });
      // A "Melee or Ranged" attack is two actions, so it's a melee attack up close and a ranged one further off.
      if (parsed.thrownRange !== undefined) {
        actions.push({
          name: `${actionName} (ranged)`,
          ...(perDay ? { perDay: Number(perDay) } : {}),
          activation: {
            cost,
            targeting: {
              ...(parsed.targeting as object),
              range: parsed.thrownRange,
            },
            resolution: parsed.resolution,
          },
        });
      }
      recharge = undefined;
    }
  }
  for (const [index, { at, forms }] of marks.entries()) {
    if (!forms) continue;
    for (const action of actions.slice(at, marks[index + 1]?.at)) {
      Object.assign(action as object, { shapes: forms });
    }
  }
  const shaped = shapesIn(printed, size);
  const shapes = shaped?.shapes.map((shape) => ({
    ...shape,
    passives: shapePassives.flatMap(({ forms, passive }) =>
      forms.includes(shape.name) ? [passive] : [],
    ),
  }));
  if (shaped && shapes) {
    actions.push(...shapeShiftActions(shapes, shaped.cost));
    const left = notes.findIndex((note) => note.endsWith(": Shape-Shift"));
    if (left >= 0) notes.splice(left, 1);
  } else {
    passives.push(...shapePassives.map(({ passive }) => passive));
  }
  // The block can still be read, and the creature fights like any other: it just never has an option but to pass.
  if (actions.length === 0 && (!secondPass || dependsOnCaster(lines))) {
    return null;
  }
  if (actions.length === 0) notes.push("no action could be automated");
  const legendary = legendaryOf(
    printed,
    actions.map((action) => (action as { readonly name: string }).name),
    spells
      ? (text) =>
          castActions(text, { cost: [] }, casterFor(text), spells, notes)
      : undefined,
  );
  notes.push(...legendary.notes);

  // shortcut: an Advantage rider printed on one attack is added to all of the monster's attacks.
  for (const dice of advantageDice) {
    passives.push({
      kind: "extraDamage",
      dice,
      when: "advantage",
      oncePerTurn: false,
    });
  }
  const speed = Number(field(/^Speed\s+(\d+)/) ?? 0);
  const otherSpeeds = [
    ...(lines.find((line) => line.startsWith("Speed")) ?? "").matchAll(
      /\b(Fly|Swim|Climb|Burrow)\s+(\d+)/gi,
    ),
  ].map((match): [string, number] => [
    (match[1] ?? "").toLowerCase(),
    Number(match[2]),
  ]);

  return {
    slug,
    notes,
    entry: {
      id: `${pluginId}:monster/${slug}`,
      name,
      ...(kind
        ? {
            size,
            creatureType: (kind[2] ?? "").toLowerCase(),
          }
        : {}),
      ac: Number(ac),
      hp: Number(hp),
      speed,
      ...(otherSpeeds.length > 0
        ? { speeds: { walk: speed, ...Object.fromEntries(otherSpeeds) } }
        : {}),
      abilities: scores,
      proficiency,
      saves,
      // Older books print no initiative, which is the Dexterity modifier there.
      ...(passives.length > 0 ? { passives } : {}),
      initiative: Number(
        (
          field(/Initiative\s+([+−-]?\d+)/) ??
          String(Math.floor(((scores.dex ?? 10) - 10) / 2))
        ).replace("−", "-"),
      ),
      multiattack,
      actions,
      ...(shapes ? { shapes } : {}),
      ...legendary.fields,
      text: printed.join("\n"),
    },
  };
}

// "The phaerimm teleports up to 30 feet to an unoccupied space it can see.", "Hazlik teleports … he can see, and …",
// "The bulette jumps up to 30 feet by
// spending 10 feet of movement.", or "casts Misty Step" while no book gives that spell a play. `rest` is any
// sentence after it, such as a limit or a creature taken along, which is left out.
export function teleportOf(
  text: string,
): { feet: number; movement: number; rest: string; others?: true } | null {
  // "teleports itself or a willing creature it can see within 10 feet of itself up to 120 feet": only itself.
  const teleport =
    /^(?:The )?[^.]*? (?:magically )?teleports(?:, along with any equipment it is wearing or carrying,)?( itself or a willing (?:creature|demon|devil|ally) [^.]*?|, along with a willing creature [^,]+,)? up to (\d+) feet to an unoccupied space (?:that )?(?:it|he|she|they|the [^.]+?) can see(?:[.,]| and)\s*(.*)$/s.exec(
      text.trim(),
    );
  if (teleport) {
    return {
      feet: Number(teleport[2]),
      movement: 0,
      rest: teleport[3] ?? "",
      ...(teleport[1] ? { others: true as const } : {}),
    };
  }
  // "teleports to an unoccupied space she can see within 30 feet of herself and makes one … attack"
  const near =
    /^(?:The )?[^.]*? (?:magically )?teleports to an unoccupied space (?:it|he|she|they) can see within (\d+) feet(?: of (?:itself|himself|herself|themselves))?(?:[.,]| and)\s*(.*)$/s.exec(
      text.trim(),
    );
  if (near) return { feet: Number(near[1]), movement: 0, rest: near[2] ?? "" };
  const leap =
    /^The [^.]*? jumps up to (\d+) feet by spending (\d+) feet of movement\.\s*(.*)$/s.exec(
      text.trim(),
    );
  if (leap) {
    return {
      feet: Number(leap[1]),
      movement: Number(leap[2]),
      rest: leap[3] ?? "",
    };
  }
  return /\bcasts (?:the )?Misty Step\b/.test(text)
    ? { feet: 30, movement: 0, rest: "" }
    : null;
}

// Stat blocks are regular enough for code alone, so no model is needed and nothing is invented.
// Spells come from the loaded content, so a monster's Spellcasting is only automated when they're given.
export function parseMonstersFromHtml(
  html: string,
  pluginId: string,
  knownIds?: readonly string[],
  contentOf?: (id: string) => unknown,
): readonly ParsedImport[] {
  const spells = spellLookup(knownIds, contentOf);
  return statBlocksIn(html).flatMap((block) => {
    const parsed =
      parseBlock(block, pluginId, false, spells) ??
      parseBlock(block, pluginId, true, spells);
    return parsed ? [parsed] : [];
  });
}
