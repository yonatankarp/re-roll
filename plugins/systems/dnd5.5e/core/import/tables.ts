import type { ParsedImport } from "#sdk";
import {
  blockText,
  bodyOf,
  captionOf,
  headingsIn,
  headingsUnder,
  rowsOf,
  tablesIn,
  type Heading,
} from "./book.ts";
import { plainText, slugOf } from "./spells.ts";

const DASHES = /[–—−-]/g;

function bookTitle(html: string): string {
  return (
    plainText(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "") || "book"
  );
}

function cellsOf(table: string): string[][] {
  return rowsOf(table).map((row) => row.map(plainText));
}

// Names that stay unique within one book, so same-named tables don't overwrite each other.
function uniqueSlugs(): (name: string) => string {
  const seen = new Map<string, number>();
  return (name) => {
    const base = slugOf(name) || "table";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${String(count)}`;
  };
}

export interface RollRow {
  readonly min: number;
  readonly max: number;
  readonly cells: readonly string[];
}

export type TableParse =
  | {
      readonly die: string;
      readonly columns: readonly string[];
      readonly rows: readonly RollRow[];
    }
  | { readonly problem: string };

// Only a table whose first column is a die roll, with every result covered exactly once.
export function parseRollTable(table: string): TableParse | null {
  const rows = cellsOf(table);
  const [header = [], ...all] = rows;
  // Footnotes under the table are short rows with no roll.
  const body = [...all];
  while (
    body.length > 0 &&
    (body.at(-1)?.length ?? 0) < header.length &&
    !/^\d/.test(body.at(-1)?.[0] ?? "")
  ) {
    body.pop();
  }
  const die = /^(\d*)d(\d+|%)$/i.exec((header[0] ?? "").replace(/\s/g, ""));
  if (!die) return null;
  const count = Number(die[1]) || 1;
  const sides = die[2] === "%" ? 100 : Number(die[2]);
  const parsed: RollRow[] = [];
  for (const row of body) {
    if (row.length !== header.length) return { problem: "ragged row" };
    const range = /^(\d+)(?:-(\d+))?$/.exec(
      (row[0] ?? "").replace(DASHES, "-").replace(/\s/g, ""),
    );
    if (!range) return { problem: "row without a roll" };
    const edge = (text: string): number =>
      sides === 100 && Number(text) === 0 ? 100 : Number(text);
    parsed.push({
      min: edge(range[1] ?? ""),
      max: edge(range[2] ?? range[1] ?? ""),
      cells: row.slice(1),
    });
  }
  if (parsed.length === 0) return { problem: "no rows" };
  let next = count;
  for (const row of parsed) {
    if (row.min !== next || row.max < row.min)
      return { problem: "gap or overlap" };
    next = row.max + 1;
  }
  if (next !== count * sides + 1)
    return { problem: "doesn't reach the die's top" };
  return {
    die: `${count === 1 ? "" : String(count)}d${String(sides)}`,
    columns: header.slice(1),
    rows: parsed,
  };
}

export function parseTablesFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  const title = bookTitle(html);
  const headings = headingsIn(html);
  const slug = uniqueSlugs();
  const result: ParsedImport[] = [];
  for (const match of html.matchAll(/<table\b[\s\S]*?<\/table>/g)) {
    const parsed = parseRollTable(match[0]);
    if (!parsed || "problem" in parsed) continue;
    const before = headings.filter((item) => item.start < match.index).at(-1);
    const caption = captionOf(match[0]);
    const name = caption === "" ? (before?.title ?? "Table") : caption;
    const id = slug(name);
    result.push({
      slug: id,
      notes: [],
      entry: {
        id: `${pluginId}:table/${id}`,
        name,
        die: parsed.die,
        columns: parsed.columns.map((column, index) =>
          column === "" ? `Column ${String(index + 1)}` : column,
        ),
        rows: parsed.rows,
        source: before ? `${title}: ${before.title}` : title,
      },
    });
  }
  return result;
}

// Tables keyed by Challenge Rating or by theme, which no die can pick from.
export function parseLookupsFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  const title = bookTitle(html);
  const headings = headingsIn(html);
  const slug = uniqueSlugs();
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].flatMap((match) => {
    const [header = [], ...rows] = cellsOf(match[0]);
    const [keyedBy = "", ...columns] = header;
    if (!/^(?:CR|Theme)$/.test(keyedBy) || columns.length === 0) return [];
    const body = rows.filter((row) => row.length === header.length && row[0]);
    if (body.length === 0) return [];
    const before = headings.filter((item) => item.start < match.index).at(-1);
    const name = captionOf(match[0]) || (before?.title ?? "Table");
    const id = slug(name);
    return [
      {
        slug: id,
        notes: [],
        entry: {
          id: `${pluginId}:lookup/${id}`,
          name,
          keyedBy,
          columns,
          rows: body.map(([key = "", ...cells]) => ({ key, cells })),
          source: before ? `${title}: ${before.title}` : title,
        },
      },
    ];
  });
}

// A Bastion chapter describes its facilities and events under headings of their own, and a table holds each facility's facts.
export function parseBastionsFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  const headings = headingsIn(html);
  const facts = new Map(
    tablesIn(html)
      .filter((table) => /^Special Facilities$/.test(captionOf(table)))
      .flatMap((table) => {
        const [header = [], ...rows] = cellsOf(table);
        const at = (row: readonly string[], name: string): string =>
          row[header.indexOf(name)] ?? "";
        return rows.map((row): [string, Record<string, unknown>] => [
          slugOf(at(row, "Special Facility")),
          {
            ...(/^\d+$/.test(at(row, "Level"))
              ? { level: Number(at(row, "Level")) }
              : {}),
            ...(/^(?:None|—|)$/.test(at(row, "Prerequisite"))
              ? {}
              : { prerequisite: at(row, "Prerequisite") }),
            ...(at(row, "Order") ? { order: at(row, "Order") } : {}),
          },
        ]);
      }),
  );
  const chapters = headings
    .filter((item) => item.tag === 1 && item.title.includes("Bastion"))
    .flatMap((item) => headingsUnder(headings, item));
  const entry = (
    heading: Heading,
    type: "facility" | "event",
  ): ParsedImport => {
    const id = slugOf(heading.title);
    return {
      slug: id,
      notes: [],
      entry: {
        id: `${pluginId}:bastion/${id}`,
        name: heading.title,
        type,
        ...(type === "facility" ? facts.get(id) : {}),
        text: blockText(bodyOf(html, headings, heading)),
      },
    };
  };
  return [
    ...chapters
      .filter((item) => item.tag === 3 && facts.has(slugOf(item.title)))
      .map((item) => entry(item, "facility")),
    ...headings
      .filter((item) => item.title === "Event Descriptions")
      .flatMap((item) => headingsUnder(headings, item))
      .filter((item) => item.tag === 4)
      .map((item) => entry(item, "event")),
  ];
}

function bands(text: string): { min: number; max: number }[] {
  const ranges = [...text.matchAll(/(\d+)\s*[–-]\s*(\d+)/g)].map((m) => ({
    min: Number(m[1]),
    max: Number(m[2]),
  }));
  if (ranges.length > 0) return ranges;
  const single = /\d+/.exec(text)?.[0];
  return single ? [{ min: Number(single), max: Number(single) }] : [];
}

const dcsIn = (lines: readonly string[]): number[] =>
  lines.flatMap((line) =>
    [...line.matchAll(/\bDC (\d+)/g)].map((match) => Number(match[1])),
  );

function parseDangers(
  html: string,
  pluginId: string,
  noun: "Trap" | "Hazard",
): readonly ParsedImport[] {
  const headings = headingsIn(html);
  const slug = uniqueSlugs();
  const first = new RegExp(`^(Nuisance|Deadly) ${noun} \\((.*?)\\)`, "i");
  const result: ParsedImport[] = [];
  for (const heading of headings) {
    const body = bodyOf(html, headings, heading);
    const withoutTables = body.replace(/<table\b[\s\S]*?<\/table>/g, "");
    const [label = "", ...lines] = blockText(withoutTables).split("\n");
    const head = first.exec(label);
    const levels = bands(head?.[2] ?? "");
    if (!head || levels.length === 0 || lines.length === 0) continue;
    const labelled = (name: string): string | undefined =>
      lines
        .find((line) => line.startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim();
    const scaling = tablesIn(body).flatMap((table) => {
      const [header = [], ...rows] = cellsOf(table);
      if (header[0] !== "Levels") return [];
      const column = (pattern: RegExp): number =>
        header.findIndex((cell) => pattern.test(cell));
      const dcAt = column(/\bDC\b/);
      const damageAt = column(/damage/i);
      return rows.flatMap((row) => {
        const band = bands(row[0] ?? "")[0];
        if (!band) return [];
        const dc = dcAt < 0 ? undefined : /\d+/.exec(row[dcAt] ?? "")?.[0];
        const damage = damageAt < 0 ? undefined : row[damageAt];
        return [
          {
            levels: band,
            ...(dc === undefined ? {} : { dc: Number(dc) }),
            ...(damage ? { damage } : {}),
            values: Object.fromEntries(
              header
                .slice(1)
                .map((name, index) => [name, row[index + 1] ?? ""]),
            ),
          },
        ];
      });
    });
    const id = slug(heading.title);
    const trigger = labelled("Trigger");
    const duration = labelled("Duration");
    result.push({
      slug: id,
      notes: [],
      entry: {
        id: `${pluginId}:${noun.toLowerCase()}/${id}`,
        name: heading.title,
        severity: (head[1] ?? "").toLowerCase(),
        levels,
        ...(trigger ? { trigger } : {}),
        ...(duration ? { duration } : {}),
        scaling,
        dcs: dcsIn(lines),
        text: lines.join("\n"),
      },
    });
  }
  return result;
}

export const parseTrapsFromHtml = (
  html: string,
  pluginId: string,
): readonly ParsedImport[] => parseDangers(html, pluginId, "Trap");

export const parseHazardsFromHtml = (
  html: string,
  pluginId: string,
): readonly ParsedImport[] => parseDangers(html, pluginId, "Hazard");

export function parsePoisonsFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  const headings: readonly Heading[] = headingsIn(html);
  const slug = uniqueSlugs();
  const result: ParsedImport[] = [];
  for (const heading of headings) {
    const named = /^(.+?)\s*\(([\d,]+)\s*GP\)$/.exec(heading.title);
    if (!named) continue;
    const [label = "", ...lines] = blockText(
      bodyOf(html, headings, heading),
    ).split("\n");
    const delivery = /^(Contact|Ingested|Inhaled|Injury) Poison$/i.exec(label);
    if (!delivery || lines.length === 0) continue;
    const id = slug(named[1] ?? "");
    result.push({
      slug: id,
      notes: [],
      entry: {
        id: `${pluginId}:poison/${id}`,
        name: named[1],
        costGp: Number((named[2] ?? "").replace(/,/g, "")),
        delivery: (delivery[1] ?? "").toLowerCase(),
        ...dcFields(lines),
        text: lines.join("\n"),
      },
    });
  }
  return result;
}

function dcFields(lines: readonly string[]): { dc?: number } {
  const [dc] = dcsIn(lines);
  return dc === undefined ? {} : { dc };
}

// Encounter XP Budget per Character: low, moderate and high XP for each character level.
export function parseBudgetsFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  const title = bookTitle(html);
  const slug = uniqueSlugs();
  const result: ParsedImport[] = [];
  for (const table of tablesIn(html)) {
    const name = captionOf(table);
    if (!/XP Budget per Character/i.test(name)) continue;
    const rows = cellsOf(table);
    const at = rows.findIndex(
      (row) =>
        row.length === 4 &&
        /Level/i.test(row[0] ?? "") &&
        /low/i.test(row[1] ?? ""),
    );
    if (at < 0) continue;
    const data = rows.slice(at + 1).flatMap((row) => {
      const [level, low, moderate, high] = row.map((cell) =>
        Number(cell.replace(/,/g, "")),
      );
      return row.length === 4 &&
        [level, low, moderate, high].every(Number.isInteger)
        ? [{ level, low, moderate, high }]
        : [];
    });
    const id = slug(name);
    result.push({
      slug: id,
      notes: [],
      entry: {
        id: `${pluginId}:budget/${id}`,
        name,
        source: title,
        rows: data,
      },
    });
  }
  return result;
}
