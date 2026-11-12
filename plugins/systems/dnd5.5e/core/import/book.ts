import { ABILITIES, ABILITY_NAMES, type Ability } from "../schemas.ts";
import { plainText } from "./spells.ts";

export interface Heading {
  readonly tag: number;
  readonly attributes: string;
  readonly id: string;
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

// A heading in a table caption only labels that table, so it never ends a section.
export function headingsIn(html: string): readonly Heading[] {
  return [...html.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g)].flatMap(
    (match) =>
      /<caption\b[^>]*>\s*$/.test(html.slice(0, match.index).slice(-60))
        ? []
        : [
            {
              tag: Number(match[1]),
              attributes: match[2] ?? "",
              id: /\bid="([^"]*)"/.exec(match[2] ?? "")?.[1] ?? "",
              title: plainText(match[3] ?? ""),
              start: match.index,
              end: match.index + match[0].length,
            },
          ],
  );
}

// The headings under the given one, up to the next heading of its level or above.
export function headingsUnder(
  headings: readonly Heading[],
  parent: Heading,
): readonly Heading[] {
  const after = headings.filter((item) => item.start > parent.start);
  const stop = after.findIndex((item) => item.tag <= parent.tag);
  return stop < 0 ? after : after.slice(0, stop);
}

// The page after a heading, up to the next heading that ends it.
export function bodyOf(
  html: string,
  headings: readonly Heading[],
  heading: Heading,
  endsIt: (next: Heading) => boolean = (next) => next.tag <= heading.tag,
): string {
  const next = headings.find(
    (item) => item.start > heading.start && endsIt(item),
  );
  return html.slice(heading.end, next?.start ?? html.length);
}

// A book can add its own styling to the class, as in "stat-block darklord-stat-block". Older books mark a block with a
// themed background class instead, or only a plain frame with a stat block title inside. The example that explains
// how to read a stat block isn't a creature.
const STAT_BLOCK =
  /<div class="(?:stat-block(?: (?!example-stat-block)[^"]*)?|[^"]*\bstat-block-background--[^"]*|Basic-Text-Frame)"[^>]*>/g;

// The block's own closing tag is found by depth, because it contains other divs.
export function statBlocksIn(html: string): readonly string[] {
  return [...html.matchAll(STAT_BLOCK)]
    .map((start) => {
      const from = start.index + start[0].length;
      let depth = 1;
      for (const tag of html.slice(from).matchAll(/<(\/?)div\b/g)) {
        depth += tag[1] ? -1 : 1;
        if (depth === 0)
          return { start, block: html.slice(from, from + tag.index) };
      }
      return { start, block: html.slice(from) };
    })
    .filter(
      ({ start, block }) =>
        !start[0].includes('"Basic-Text-Frame"') ||
        block.includes("Stat-Block-Title"),
    )
    .map(({ block }) => block);
}

const FROM_CASTER = /\b(?:your|spell|level|summoner)\b/i;

// The monster parser takes printed numbers, so a creature whose numbers come from whoever brought it is a companion.
export function dependsOnCaster(lines: readonly string[]): boolean {
  const line = (label: RegExp): string =>
    lines.find((item) => label.test(item)) ?? "";
  return (
    FROM_CASTER.test(line(/^(?:AC|Armor Class)\s/)) ||
    FROM_CASTER.test(line(/^(?:HP|Hit Points)\s/)) ||
    lines.some(
      (item) =>
        /Attack(?: Roll)?:(?!\s*[+−–-]?\d)/.test(item) &&
        FROM_CASTER.test(item),
    )
  );
}

export function tablesIn(html: string): readonly string[] {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((m) => m[0]);
}

export function captionOf(table: string): string {
  return plainText(
    /<caption\b[^>]*>([\s\S]*?)<\/caption>/.exec(table)?.[1] ?? "",
  );
}

// Each row as the HTML of its cells, because some books mix td and th in one column.
export function rowsOf(table: string): readonly (readonly string[])[] {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(
      (cell) => cell[1] ?? "",
    ),
  );
}

// The printed text of part of a page, one line per block, without art credits.
export function blockText(html: string): string {
  const withoutArt = html.replace(/<figure\b[\s\S]*?<\/figure>/g, "");
  return [...withoutArt.matchAll(/<(h[1-6]|p|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((block) =>
      block[1] === "tr"
        ? (rowsOf(block[0])[0] ?? []).map(plainText).join(" | ")
        : plainText(block[2] ?? ""),
    )
    .filter(Boolean)
    .join("\n");
}

const ABILITY_BY_NAME: Readonly<Record<string, Ability>> = Object.fromEntries(
  ABILITIES.map((ability) => [ABILITY_NAMES[ability], ability]),
);

export function abilitiesIn(text: string): readonly Ability[] {
  return [
    ...text.matchAll(
      /Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma/g,
    ),
  ].flatMap((match) => {
    const ability = ABILITY_BY_NAME[match[0]];
    return ability ? [ability] : [];
  });
}

// The id of something another plugin holds, such as the class a book's subclass belongs to.
export function knownId(
  knownIds: readonly string[],
  prefix: string,
  slug: string,
): string | undefined {
  return knownIds.find((id) => id.endsWith(`:${prefix}/${slug}`));
}

export function camelCase(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word, index) =>
      index === 0
        ? word.toLowerCase()
        : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`,
    )
    .join("");
}
