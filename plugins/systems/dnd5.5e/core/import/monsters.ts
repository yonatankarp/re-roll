import type { ParsedImport } from "#sdk";
import type {
  Condition,
  Damage,
  LeafEffect,
  Modifier,
  Passive,
  Resolution,
} from "../schemas.ts";
import { ConditionSchema, DAMAGE_TYPES } from "../schemas.ts";
import { dependsOnCaster, statBlocksIn } from "./book.ts";
import {
  type Caster,
  castActions,
  casterIn,
  type SpellLookup,
  spellcastingActions,
  spellLookup,
} from "./monster-spells.ts";
import { plainText, slugOf } from "./spells.ts";

const ABILITIES = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
} as const;
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
const withoutSizeLimits = (text: string): string =>
  text
    .replace(
      /\b(?:if )?(?:the )?(?:target|it) is (?:a )?(?:Medium|Large|Huge|Gargantuan) or smaller(?: creature)?,?/gi,
      "",
    )
    .replace(
      /\b(?:Medium|Large|Huge|Gargantuan) or smaller (creatures?)\b/gi,
      "$1",
    );

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

function conditionsIn(text: string, left: string[]): LeafEffect[] {
  const repeatSave =
    /\brepeats? the sav(?:e|ing throw)\b(?:,|[^.]*?\b(?:at the end of|whenever it takes damage)\b)/i.test(
      text,
    );
  const endsOnDamage =
    /\bends? (?:early )?(?:if|when) the target takes (?:any )?damage\b|\buntil (?:it|the target) takes (?:any )?damage\b/i.test(
      text,
    );
  return sentencesOf(text).flatMap((sentence) => {
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
    return [
      ...sentence.matchAll(/\b(?:has|have) the (\w+) condition/g),
    ].flatMap((match) => {
      const parsed = ConditionSchema.safeParse(match[1]?.toLowerCase());
      if (!parsed.success) return [];
      const [after = ""] = sentence
        .slice(match.index + match[0].length)
        .split(/,|\band\b/);
      const limit = limitOn(sentence.slice(0, match.index)) ?? limitOn(after);
      if (limit) {
        left.push(limit);
        return [];
      }
      return [
        {
          kind: "applyCondition" as const,
          condition: parsed.data,
          duration: edge ? { until } : { minutes },
          repeatSave,
          endsOnDamage,
        },
      ];
    });
  });
}

interface ParsedAction {
  readonly targeting: unknown;
  readonly resolution: Resolution;
  readonly advantageDice?: readonly string[];
  readonly thrownRange?: number; // a "Melee or Ranged" attack's range, for a second, ranged action
}

function parseAttack(text: string, left: string[]): ParsedAction | null {
  const match =
    /^(?:Melee or Ranged|Melee|Ranged)(?: Weapon| Spell)? Attack(?: Roll)?:\s*([+−-]?\d+)/.exec(
      text,
    );
  if (!match) return null;
  const hitAt = text.indexOf("Hit:");
  if (hitAt < 0) return null;
  const afterHit = text.slice(hitAt + 4).trim();
  // A save nested in the hit has its own chance to fail, which a resolution can't hold.
  if (/saving throw/i.test(afterHit)) left.push("a nested save");
  // Older books say "is grappled", which has no duration or end this parser can read reliably.
  if (OLDER_CONDITION.test(afterHit)) left.push("a condition in older wording");
  const [hit = ""] = afterHit.split(
    new RegExp(`(?=${SAVE_LABEL}|(?:Hit or )?Miss:)`),
  );
  const sentences = sentencesOf(hit);
  const advantageDice: string[] = [];
  const damage = damageIn(sentences[0] ?? "", left, advantageDice);
  noteLaterDamage(sentences, left);
  const onHit = conditionsIn(hit, left);
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
        flatBonus: Number((match[1] ?? "0").replace("−", "-")),
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

function parseSave(text: string, left: string[]): ParsedAction | null {
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
  // A worse condition on a later failure can't be tracked, so only the first stage applies.
  const firstStage = text.replace(
    /\s*(?:Second Failure|Failure by \d+ or More):.*?(?=\s*Success:|$)/s,
    "",
  );
  if (firstStage !== text) left.push("a later failure stage");
  const eitherResult = /\s*Failure or Success:.*$/s;
  if (eitherResult.test(firstStage)) left.push("an effect on either result");
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
  const onFail = conditionsIn(failure, left);
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
      onSuccess: [],
    },
  };
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
export function legendaryOf(
  lines: readonly string[],
  actionNames: readonly string[],
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
    const read = parseSave(text, left) ?? parseAttack(text, left);
    // Legendary and lair targets are picked without the condition check, so a gated action stays text there.
    const parsed =
      read && "targetConditions" in (read.targeting as object) ? null : read;
    const activation = parsed ? { cost: [], ...parsed } : undefined;
    if (section === "lair actions") {
      if (activation) lair.push({ name, activation });
      else notes.push(`not automated: lair action ${name}`);
      continue;
    }
    const made = activation ? [] : actionsMade(text, actionNames, left);
    if (!activation && made.length === 0) {
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
      ...(activation ? { activation } : { makes: made }),
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

// The traits the engine already knows how to play, or null for one it doesn't.
function traitPassive(label: string, text: string): Passive | null {
  if (label === "Magic Resistance") return { kind: "magicResistance" };
  if (label === "Pack Tactics") return { kind: "packTactics" };
  if (label === "Undead Fortitude") return { kind: "undeadFortitude" };
  const regains = /\bregains (\d+) Hit Points\b/.exec(text)?.[1];
  if (!/^Regeneration\b/.test(label) || !regains) return null;
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
  return {
    kind: "regeneration",
    hp: Number(regains),
    stoppedBy: DAMAGE_TYPES.filter((damage) => words.has(damage)),
  };
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
  const paragraphs = [...block.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)];
  const lines = paragraphs.map((item) => plainText(item[2] ?? ""));
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
  for (const [index, paragraph] of paragraphs.entries()) {
    const attributes = paragraph[1] ?? "";
    const inner = paragraph[2] ?? "";
    if (/monster-header|Stat-Block-Heading/.test(attributes)) {
      section = plainText(inner)
        .toLowerCase()
        .replace(/^bonus action$/, "bonus actions");
      continue;
    }
    const entry = entryOf(inner);
    if (!entry) continue;
    const { label, text } = entry;
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
      ["traits", "actions", "bonus actions"].includes(section)
    ) {
      const following = paragraphs.slice(index + 1);
      const end = following.findIndex(
        (item) =>
          entryOf(item[2] ?? "") !== null ||
          /monster-header|Stat-Block-Heading/.test(item[1] ?? ""),
      );
      const listed = spellcastingActions(
        [
          text,
          ...lines.slice(
            index + 1,
            index + 1 + (end < 0 ? following.length : end),
          ),
        ].join("\n"),
        section === "traits" ? [] : [costOf(section)],
        casterFor(text),
        spells,
        notes,
      );
      if (listed.length === 0) notes.push(`not automated: ${label}`);
      actions.push(...listed);
      continue;
    }
    if (section === "traits") {
      const passive = traitPassive(label, text);
      if (passive) passives.push(passive);
      else notes.push(`not automated: ${label}`);
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
    if (section !== "actions" && section !== "bonus actions") {
      notes.push(`not automated: ${label}`);
      continue;
    }
    const rechargeOn = /\(Recharge (\d)/.exec(label)?.[1];
    const perDay = /\((\d+)\/Day\b/.exec(label)?.[1];
    const resource = `${perDay ? "day" : "recharge"}:${slugOf(label.replace(/\s*\(.*$/, ""))}`;
    let recharge = rechargeOn; // options share one recharge, and each action holding it would roll for it
    for (const option of optionsIn(label, text)) {
      let left: string[] = [];
      let optionText = secondPass
        ? withFirstChosenType(option.text, left)
        : option.text;
      let parsed = parseAttack(optionText, left) ?? parseSave(optionText, left);
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
        if (cast.length === 0) notes.push(`not automated: ${option.name}`);
        else recharge = undefined;
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
  // The block can still be read, and the creature fights like any other: it just never has an option but to pass.
  if (actions.length === 0 && (!secondPass || dependsOnCaster(lines))) {
    return null;
  }
  if (actions.length === 0) notes.push("no action could be automated");
  const legendary = legendaryOf(
    lines,
    actions.map((action) => (action as { readonly name: string }).name),
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
  const kind = lines.map((line) => CREATURE_KIND.exec(line)).find(Boolean);
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
            size: (kind[1] ?? "").toLowerCase(),
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
      ...legendary.fields,
      text: lines.join("\n"),
    },
  };
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
