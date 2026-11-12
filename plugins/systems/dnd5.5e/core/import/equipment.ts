import type { ParsedImport } from "#sdk";
import {
  abilitiesIn,
  blockText,
  bodyOf,
  camelCase,
  captionOf,
  headingsIn,
  headingsUnder,
  rowsOf,
  tablesIn,
  type Heading,
} from "./book.ts";
import { parseMagicItemsFromHtml } from "./magic-items.ts";
import { plainText, slugOf } from "./spells.ts";

function parseWeapon(
  cells: readonly string[],
  category: string,
  columns: readonly string[],
  pluginId: string,
): ParsedImport {
  const [name = "", damage = "", properties = "", mastery = ""] =
    cells.map(plainText);
  const [dice = "", type = ""] = damage.split(/\s+/);
  const slug = slugOf(name);
  const listed = properties === "—" ? [] : properties.split(/,\s*/);
  return {
    slug,
    notes: listed
      .filter((item) => item.includes("("))
      .map((item) => `not held: ${item}`),
    entry: {
      id: `${pluginId}:item/${slug}`,
      name,
      type: "weapon",
      category,
      damage: /^\d+$/.test(dice)
        ? { flat: Number(dice), type: type.toLowerCase() }
        : { dice, type: type.toLowerCase() },
      properties: listed.map((item) => camelCase(item.split("(")[0] ?? "")),
      mastery: mastery.toLowerCase(),
      ...costAndWeight(cells, columns),
    },
  };
}

function parseArmor(
  cells: readonly string[],
  armorType: string,
  columns: readonly string[],
  pluginId: string,
): ParsedImport {
  const [name = "", ac = "", strength = "", stealth = ""] =
    cells.map(plainText);
  const slug = slugOf(name);
  const common = {
    id: `${pluginId}:item/${slug}`,
    name,
    ...costAndWeight(cells, columns),
  };
  const bonus = /^\+(\d+)/.exec(ac)?.[1];
  if (bonus) {
    return {
      slug,
      notes: [],
      entry: { ...common, type: "shield", bonus: Number(bonus) },
    };
  }
  const maxDex = /\(max (\d+)\)/.exec(ac)?.[1];
  return {
    slug,
    notes: [strength, stealth]
      .filter((item) => item !== "—")
      .map((item) => `not held: ${item}`),
    entry: {
      ...common,
      type: "armor",
      armorType,
      base: Number(/^\d+/.exec(ac)?.[0]),
      addDex: ac.includes("Dex modifier"),
      ...(maxDex ? { maxDex: Number(maxDex) } : {}),
    },
  };
}

// Single-cell rows in these tables head a group, such as Simple Melee Weapons or Light Armor.
function groupedRows<T>(
  table: string | undefined,
  read: (
    cells: readonly string[],
    group: string,
    columns: readonly string[],
  ) => T,
): readonly T[] {
  let group = "";
  const [header = [], ...rows] = rowsOf(table ?? "");
  const columns = header.map(plainText);
  return rows.flatMap((cells) => {
    if (cells.length === 1) {
      group = (/^\w+/.exec(plainText(cells[0] ?? ""))?.[0] ?? "").toLowerCase();
      return [];
    }
    return [read(cells, group, columns)];
  });
}

const COPPER_PER_COIN: Readonly<Record<string, number>> = {
  CP: 1,
  SP: 10,
  EP: 50,
  GP: 100,
  PP: 1000,
};

// Empty for "Varies" and "—", which name no single price.
function priced(cost: string): { readonly costCp?: number } {
  const match = /^([\d,]+) (CP|SP|EP|GP|PP)$/.exec(cost);
  const coin = COPPER_PER_COIN[match?.[2] ?? ""];
  return match?.[1] && coin
    ? { costCp: Number(match[1].replaceAll(",", "")) * coin }
    : {};
}

// Pounds, as "3 lb." or "1/2 lb."; empty for "—".
function weighed(weight: string): { readonly weightLb?: number } {
  const match = /^([\d,]+)(?:\/(\d+))? lb\.$/.exec(weight);
  return match?.[1]
    ? {
        weightLb: Number(match[1].replaceAll(",", "")) / Number(match[2] ?? 1),
      }
    : {};
}

// The Cost and Weight columns, found by name since the tables order them differently.
function costAndWeight(
  cells: readonly string[],
  columns: readonly string[],
): { readonly costCp?: number; readonly weightLb?: number } {
  const at = (name: string): string =>
    plainText(cells[columns.findIndex((item) => item.startsWith(name))] ?? "");
  return { ...priced(at("Cost")), ...weighed(at("Weight")) };
}

const GEAR_TABLES: Readonly<Record<string, string>> = {
  "Adventuring Gear": "adventuring",
  Ammunition: "ammunition",
  "Arcane Focuses": "focus",
  "Druidic Focuses": "focus",
  "Holy Symbols": "focus",
  "Mounts and Other Animals": "mount",
  "Tack, Harness, and Drawn Vehicles": "tack",
  "Airborne and Waterborne Vehicles": "vehicle",
  Explosives: "explosive",
  "Trade Bars": "treasure",
};

function descriptionsOfGear(
  html: string,
  headings: readonly Heading[],
): ReadonlyMap<string, string> {
  const parent = headings.find(
    (item) => item.tag === 2 && item.title === "Adventuring Gear",
  );
  if (!parent) return new Map();
  return new Map(
    headingsUnder(headings, parent)
      .filter((item) => item.tag === 4)
      .map((item) => [
        item.title.replace(/ \(.*$/, ""),
        blockText(bodyOf(html, headings, item)),
      ]),
  );
}

function gearEntry(
  name: string,
  slug: string,
  category: string,
  cost: string,
  lines: readonly string[],
  pluginId: string,
  weight = "",
): ParsedImport {
  const text = lines.filter(Boolean).join("\n");
  return {
    slug,
    notes: [],
    entry: {
      id: `${pluginId}:item/${slug}`,
      name,
      type: "gear",
      category,
      ...priced(cost),
      ...weighed(weight),
      ...(text ? { text } : {}),
    },
  };
}

function parseGearTable(
  table: string,
  category: string,
  descriptions: ReadonlyMap<string, string>,
  pluginId: string,
): readonly ParsedImport[] {
  const [header = [], ...rows] = rowsOf(table);
  const columns = header.map(plainText);
  const costAt = columns.findIndex((item) => /^(?:Cost|Value)\b/.test(item));
  let group = "";
  return rows.flatMap((cells) => {
    const printed = cells.map(plainText);
    if (cells.length === 1) {
      group = printed[0] ?? "";
      return [];
    }
    // A group like Saddle has no end marker, but the rows inside it link to pages named after it.
    const inGroup =
      group !== "" &&
      cells[0]?.toLowerCase().includes(`-${group.toLowerCase()}`);
    const name = inGroup ? `${group}, ${printed[0] ?? ""}` : (printed[0] ?? "");
    const short = name.replace(/ \(.*$/, "");
    const facts = columns.flatMap((column, index) => {
      const value = printed[index] ?? "";
      return index === 0 || index === costAt || value === "" || value === "—"
        ? []
        : [`${column}: ${value}`];
    });
    return [
      gearEntry(
        name,
        // Focus rows carry a usage note in brackets, while Spell Scroll needs its brackets to stay two entries.
        slugOf(category === "focus" ? short : name),
        category === "adventuring" && name.endsWith(" Pack")
          ? "pack"
          : category,
        printed[costAt] ?? "",
        [...facts, descriptions.get(short) ?? ""],
        pluginId,
        printed[columns.indexOf("Weight")] ?? "",
      ),
    ];
  });
}

// Gemstone and art tables are priced by their caption, and a gem's bracket describes it.
function parseTreasureTable(
  table: string,
  cost: string,
  pluginId: string,
): readonly ParsedImport[] {
  return rowsOf(table)
    .slice(1)
    .map((cells) => {
      const printed = plainText(cells[1] ?? "");
      const [, name = printed, described = ""] =
        /^(.*?) \((.*)\)$/.exec(printed) ?? [];
      return gearEntry(
        name,
        slugOf(name),
        "treasure",
        cost,
        [described],
        pluginId,
      );
    });
}

function parseTools(
  html: string,
  headings: readonly Heading[],
  pluginId: string,
): readonly ParsedImport[] {
  const parent = headings.find(
    (item) => item.tag === 2 && item.title === "Tools",
  );
  if (!parent) return [];
  return headingsUnder(headings, parent)
    .filter((item) => item.tag === 4)
    .map((heading) => {
      const [, name = heading.title, cost = ""] =
        /^(.*?) \((.*)\)$/.exec(heading.title) ?? [];
      const text = blockText(bodyOf(html, headings, heading));
      const slug = slugOf(name);
      return {
        slug,
        notes: [],
        entry: {
          id: `${pluginId}:item/${slug}`,
          name,
          type: "tool",
          ability: abilitiesIn(/Ability: (\w+)/.exec(text)?.[1] ?? "")[0],
          text,
          ...priced(cost),
          ...weighed(/Weight: (\S+ lb\.)/.exec(text)?.[1] ?? ""),
        },
      };
    });
}

export function parseEquipmentFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  const tables = tablesIn(html);
  const headings = headingsIn(html);
  const descriptions = descriptionsOfGear(html, headings);
  return [
    ...groupedRows(
      tables.find(
        (table) => captionOf(table) === "Weapons" && table.includes("Mastery"),
      ),
      (cells, group, columns) => parseWeapon(cells, group, columns, pluginId),
    ),
    ...groupedRows(
      tables.find(
        (table) =>
          captionOf(table) === "Armor" && table.includes("Armor Class"),
      ),
      (cells, group, columns) => parseArmor(cells, group, columns, pluginId),
    ),
    ...parseTools(html, headings, pluginId),
    ...tables.flatMap((table) => {
      const caption = captionOf(table);
      const category = GEAR_TABLES[caption];
      if (category) {
        return parseGearTable(table, category, descriptions, pluginId);
      }
      const value = /^([\d,]+ GP) (?:Gemstones|Art Objects)$/.exec(
        caption,
      )?.[1];
      return value ? parseTreasureTable(table, value, pluginId) : [];
    }),
    ...parseMagicItemsFromHtml(html, pluginId),
  ];
}
