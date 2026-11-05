import type { ParsedImport } from "#sdk";
import {
  blockText,
  dependsOnCaster,
  headingsIn,
  rowsOf,
  statBlocksIn,
  tablesIn,
} from "./book.ts";
import { plainText, slugOf } from "./spells.ts";

const SIZE = /^(Tiny|Small|Medium|Large|Huge|Gargantuan)\b/;

function abilitiesOf(block: string): Record<string, number> {
  return Object.fromEntries(
    tablesIn(block)
      .flatMap((table) => rowsOf(table))
      .flatMap((row) => {
        const [name = "", score = ""] = row.map(plainText);
        return /^(?:str|dex|con|int|wis|cha)$/i.test(name) &&
          /^\d+$/.test(score)
          ? [[name.toLowerCase(), Number(score)]]
          : [];
      }),
  );
}

// Stat blocks whose AC or Hit Points depend on the one who brought the creature, such as a summoned spirit.
export function parseCompanionsFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  return statBlocksIn(html).flatMap((block) => {
    const [title] = headingsIn(block);
    const lines = [...block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(
      (match) => plainText(match[1] ?? ""),
    );
    const line = (label: RegExp): string =>
      lines.find((item) => label.test(item))?.replace(label, "") ?? "";
    const ac = line(/^(?:AC|Armor Class)\s+/);
    const hp = line(/^(?:HP|Hit Points)\s+/);
    if (!title || !hp || !dependsOnCaster(lines)) return [];
    const slug = slugOf(title.title);
    const size = SIZE.exec(lines[0] ?? "")?.[1];
    return [
      {
        slug,
        notes: [],
        entry: {
          id: `${pluginId}:companion/${slug}`,
          name: title.title,
          ...(size ? { size: size.toLowerCase() } : {}),
          ac,
          hp,
          speed: line(/^Speed\s+/),
          abilities: abilitiesOf(block),
          text: blockText(block),
        },
      },
    ];
  });
}
