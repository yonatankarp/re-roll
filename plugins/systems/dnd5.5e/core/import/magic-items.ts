import type { ParsedImport } from "#sdk";
import {
  blockText,
  bodyOf,
  camelCase,
  headingsIn,
  rowsOf,
  tablesIn,
} from "./book.ts";
import { plainText, slugOf } from "./spells.ts";

// The line under an item's name. Subtypes can hold commas, so it anchors on the subtype's closing bracket.
const TYPE_LINE =
  /^(Wondrous Item|Potion|Ring|Rod|Scroll|Staff|Wand|Armor|Weapon)(?: \([^)]*\))?, ((?:Very Rare|Uncommon|Common|Rare|Legendary|Artifact|Rarity Varies)\b.*)$/i;
// Some books print a rarity in lowercase.
const RARITY = /(Very Rare|Uncommon|Common|Rare|Legendary|Artifact)/i;

interface Bonus {
  readonly to: string;
  readonly amount: number;
}

interface Variant {
  readonly rarity: string;
  readonly name?: string;
  readonly bonuses?: readonly Bonus[];
  readonly healing?: unknown;
}

function typeLineAfter(html: string, end: number): RegExpExecArray | null {
  const block = /^\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html.slice(end));
  return block ? TYPE_LINE.exec(plainText(block[1] ?? "")) : null;
}

// Numbers are read only from these unconditional wordings, and only if the wording appears once.
const FIXED_BONUSES: readonly (readonly [RegExp, readonly string[]])[] = [
  [
    /\+(\d) bonus to attack rolls and damage rolls made with (?:this (?:magic )?weapon|it)\b/,
    ["attack", "damage"],
  ],
  [/\+(\d) bonus to Armor Class and saving throws\b/, ["ac", "savingThrows"]],
  [/\+(\d) bonus to Armor Class\b(?! and saving throws)/, ["ac"]],
  [/\+(\d) bonus to saving throws\b/, ["savingThrows"]],
  [/\+(\d) bonus to spell attack rolls\b/, ["spellAttack"]],
];
// "and gain" marks a worked example of moving a bonus, and "allies" an effect that needs an action first.
const CONDITIONAL = /\b(?:if|when|against|unless|until|allies|and gain)\b/i;

function fixedBonuses(text: string): readonly Bonus[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return FIXED_BONUSES.flatMap(([pattern, targets]) => {
    const [hit, ...others] = sentences.filter((item) => pattern.test(item));
    if (hit === undefined || others.length > 0 || CONDITIONAL.test(hit)) {
      return [];
    }
    const amount = Number(pattern.exec(hit)?.[1]);
    return targets.map((to) => ({ to, amount }));
  });
}

// What a "Rare (+2)" bonus applies to, which only the item's text says.
function targetsOfRarityBonus(text: string): readonly string[] {
  if (text.includes("bonus to attack rolls and damage rolls")) {
    return ["attack", "damage"];
  }
  if (/bonus to (?:your )?Armor Class/.test(text)) return ["ac"];
  if (text.includes("bonus to spell attack rolls")) return ["spellAttack"];
  return [];
}

function rarityVariants(rest: string, text: string): readonly Variant[] {
  const targets = targetsOfRarityBonus(text);
  return [
    ...rest.matchAll(
      new RegExp(`${RARITY.source}(?:\\s*\\(\\+(\\d)\\))?`, "gi"),
    ),
  ].map(([, rarity = "", amount]) => ({
    rarity: camelCase(rarity),
    ...(amount && targets.length > 0
      ? { bonuses: targets.map((to) => ({ to, amount: Number(amount) })) }
      : {}),
  }));
}

// A potion's dice come from its table, never from the prose around it.
function healingVariants(body: string): readonly Variant[] {
  const table = tablesIn(body).find(
    (item) => plainText(rowsOf(item)[0]?.[1] ?? "") === "HP Regained",
  );
  return rowsOf(table ?? "")
    .slice(1)
    .flatMap((cells) => {
      const [name = "", regained = "", rarity = ""] = cells.map(plainText);
      const dice = /^(\d+d\d+)(?: ?\+ ?(\d+))?$/.exec(regained);
      if (!dice?.[1] || !RARITY.test(rarity)) return [];
      return [
        {
          name,
          rarity: camelCase(rarity),
          healing: {
            dice: dice[1],
            ...(dice[2] ? { bonus: { base: Number(dice[2]) } } : {}),
          },
        },
      ];
    });
}

export function parseMagicItemsFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  const headings = headingsIn(html);
  const items = headings.flatMap((heading) => {
    const line = typeLineAfter(html, heading.end);
    return line ? [{ heading, line }] : [];
  });
  const starts = new Set(items.map((item) => item.heading.start));
  return items.map(({ heading, line }) => {
    // A nested item, such as a Crystal Ball's versions, is its own entry and not part of its parent's text.
    const body = bodyOf(
      html,
      headings,
      heading,
      (next) => next.tag <= heading.tag || starts.has(next.start),
    );
    const text = blockText(body);
    const slug = slugOf(heading.title);
    const attunement = /\(Requires Attunement(?: by ([^)]*))?\)/i.exec(
      line[2] ?? "",
    );
    const rest = (line[2] ?? "").replace(/\((?!\+\d\))[^)]*\)/g, "");
    const healing = healingVariants(body);
    const listed = /Rarity Varies/i.test(rest)
      ? []
      : rarityVariants(rest, text);
    const variants = healing.length > 0 ? healing : listed;
    const single = variants.length === 1 ? variants[0]?.rarity : undefined;
    // An entry covering several versions can't say which version a number in its text belongs to.
    const bonuses = single ? fixedBonuses(text) : [];
    return {
      slug,
      notes: [],
      entry: {
        id: `${pluginId}:item/${slug}`,
        name: heading.title,
        type: "magicItem",
        category: camelCase(line[1] ?? ""),
        rarity: single ?? "varies",
        attunement: attunement !== null,
        ...(attunement?.[1] ? { attunementBy: attunement[1] } : {}),
        text,
        // Nothing here is applied in play yet, so these stay readable-only however many numbers were read.
        automation: "text",
        ...(bonuses.length > 0 ? { bonuses } : {}),
        ...(!single && variants.length > 0 ? { variants } : {}),
      },
    };
  });
}
