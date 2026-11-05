import type { ParsedImport } from "#sdk";
import type { Damage, LeafEffect, Resolution } from "../schemas.ts";
import { ConditionSchema, DAMAGE_TYPES } from "../schemas.ts";
import { dependsOnCaster, statBlocksIn } from "./book.ts";
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

const sentencesOf = (text: string): readonly string[] =>
  text.split(/(?<=\.)\s+/);

// Why part of an effect only applies sometimes, in our own words so that a note never quotes the book.
function limitOn(text: string): string | null {
  // Every target in a fight is a creature, so this one always holds.
  const clause = text.replace(/\bif the target is a creature,/gi, "");
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

function damageIn(sentence: string, left: string[]): Damage[] {
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
    if (limit) {
      left.push(limit);
      return [];
    }
    const [, dice, sign, bonus, flat, type = ""] = match;
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
  const repeatSave = /repeats the save/i.test(text);
  return sentencesOf(text).flatMap((sentence) => {
    const shortTerm = /until the (start|end) of [^.]*next turn/i.test(sentence);
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
          duration: shortTerm
            ? { until: "yourNextTurnStart" as const }
            : { minutes: 1 },
          repeatSave,
          endsOnDamage: false,
        },
      ];
    });
  });
}

interface ParsedAction {
  readonly targeting: unknown;
  readonly resolution: Resolution;
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
  const damage = damageIn(sentences[0] ?? "", left);
  noteLaterDamage(sentences, left);
  const onHit = conditionsIn(hit, left);
  if (
    damage.length === 0 &&
    (onHit.length === 0 || hit.search(DICE_DAMAGE) >= 0)
  ) {
    return null;
  }
  const distances = [
    /reach (\d+) ft/.exec(text)?.[1],
    /range (\d+)(?:\/\d+)? ft/.exec(text)?.[1],
  ].flatMap((item) => (item ? [Number(item)] : []));
  return {
    targeting: {
      creatures: 1,
      range: Math.max(5, ...distances),
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
      // shortcut: Cylinder has no shape of its own, and positions don't exist until step 6 anyway.
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

function parseSave(text: string, left: string[]): ParsedAction | null {
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
  const [who = ""] = sentencesOf(rule);
  if (
    limitOn(who) ||
    /\b(?:Grappled|Restrained|Prone|Incapacitated|Charmed|Stunned|Paralyzed|Unconscious)\b/.test(
      who,
    )
  ) {
    return null;
  }
  const sentences = sentencesOf(failure);
  const damage = damageIn(sentences[0] ?? "", left);
  noteLaterDamage(sentences, left);
  const onFail = conditionsIn(failure, left);
  if (damage.length === 0 && onFail.length === 0) return null;
  return {
    targeting: targetingFor(rule),
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
  if (counts.length === 0) return /\battacks?\b/i.test(routine) ? null : 1;
  return counts.reduce((sum, count) => sum + count, 0);
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

// Second pass, for a block the first pass found no action in. It's separate so that blocks which already parse don't change.
function parseBlock(
  block: string,
  pluginId: string,
  secondPass = false,
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
  let multiattack = 1;
  let section = "";
  for (const paragraph of paragraphs) {
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
    if (section === "traits") {
      notes.push(`not automated: ${label}`);
      continue;
    }
    if (/^multiattack/i.test(label)) {
      const count = multiattackCount(text);
      if (count === null) notes.push(`not automated: ${label} count`);
      multiattack = count ?? 1;
      continue;
    }
    if (section !== "actions" && section !== "bonus actions") {
      notes.push(`not automated: ${label}`);
      continue;
    }
    const rechargeOn = /\(Recharge (\d)/.exec(label)?.[1];
    const resource = `recharge:${slugOf(label.replace(/\s*\(.*$/, ""))}`;
    let recharge = rechargeOn; // options share one recharge, and each action holding it would roll for it
    for (const option of optionsIn(label, text)) {
      const left: string[] = [];
      const optionText = secondPass
        ? withFirstChosenType(option.text, left)
        : option.text;
      const parsed =
        parseAttack(optionText, left) ?? parseSave(optionText, left);
      if (!parsed) {
        notes.push(`not automated: ${option.name}`);
        continue;
      }
      const actionName = option.name.replace(/\s*\(.*$/, "");
      for (const reason of new Set(left)) {
        notes.push(`partial: ${actionName}: left out ${reason}`);
      }
      actions.push({
        name: actionName,
        ...(recharge ? { recharge: Number(recharge) } : {}),
        activation: {
          cost: [
            section === "bonus actions" ? "bonusAction" : "action",
            ...(rechargeOn ? [{ resource }] : []),
          ],
          targeting: parsed.targeting,
          resolution: parsed.resolution,
        },
      });
      recharge = undefined;
    }
  }
  // The block can still be read, and the creature fights like any other: it just never has an option but to pass.
  if (actions.length === 0 && (!secondPass || dependsOnCaster(lines))) {
    return null;
  }
  if (actions.length === 0) notes.push("no action could be automated");

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
      proficiency: Number(field(/\b(?:PB|Proficiency Bonus) \+(\d+)/) ?? 2),
      saves,
      // Older books print no initiative, which is the Dexterity modifier there.
      initiative: Number(
        (
          field(/Initiative\s+([+−-]?\d+)/) ??
          String(Math.floor(((scores.dex ?? 10) - 10) / 2))
        ).replace("−", "-"),
      ),
      multiattack,
      actions,
      text: lines.join("\n"),
    },
  };
}

// Stat blocks are regular enough for code alone, so no model is needed and nothing is invented.
export function parseMonstersFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  return statBlocksIn(html).flatMap((block) => {
    const parsed =
      parseBlock(block, pluginId) ?? parseBlock(block, pluginId, true);
    return parsed ? [parsed] : [];
  });
}
