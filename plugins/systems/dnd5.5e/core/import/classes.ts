import type { ParsedImport } from "#sdk";
import { type ChoiceDef, SKILL_ABILITIES, type Skill } from "../schemas.ts";
import {
  type Heading,
  abilitiesIn,
  blockText,
  bodyOf,
  camelCase,
  captionOf,
  headingsIn,
  headingsUnder,
  knownId,
  rowsOf,
  tablesIn,
} from "./book.ts";
import { parseSpeciesTraits } from "./origins.ts";
import {
  isStatBlockTitle,
  plainText,
  slugOf,
  spellTextFromHtml,
  splitSpells,
} from "./spells.ts";

interface BookFeature {
  readonly slug: string;
  readonly headingId: string;
  readonly name: string;
  readonly text: string;
  readonly level: number | null; // from the heading, which every subclass feature prints
  readonly subclass: string;
}

interface ClassChapter {
  readonly name: string;
  readonly traits: ReadonlyMap<string, string>;
  readonly levelTable: string;
  readonly spellTables: readonly string[];
  readonly features: readonly BookFeature[];
  readonly subclassFeatures: readonly BookFeature[];
}

const LEVEL_PREFIX = /^Level (\d+): /;

function chapterFeatures(
  html: string,
  name: string,
  headings: readonly Heading[],
  chapter: readonly Heading[],
): Pick<ClassChapter, "features" | "subclassFeatures"> {
  const features: BookFeature[] = [];
  const subclassFeatures: BookFeature[] = [];
  const used = new Set<string>();
  let section: "base" | "subclass" | "other" = "other";
  let subclass = "";

  // Only these headings split the chapter. Plain h5s, and h4s among the subclasses, stay in the text around them.
  const isBoundary = (item: Heading): boolean =>
    item.tag <= 3 ||
    item.attributes.includes("h3-override") ||
    item.attributes.includes("h4-override") ||
    (item.tag === 4 && section !== "subclass");

  for (const heading of chapter) {
    if (heading.tag <= 3) {
      if (/Class Features$|^Eldritch Invocation Options$/.test(heading.title)) {
        section = "base";
      } else {
        section = heading.title.endsWith("Subclasses") ? "subclass" : "other";
      }
      continue;
    }
    if (section === "subclass" && heading.attributes.includes("h3-override")) {
      subclass = heading.title;
      continue;
    }
    const isFeature =
      section === "base"
        ? heading.tag === 4
        : section === "subclass" && heading.attributes.includes("h4-override");
    if (!isFeature) continue;

    const level = LEVEL_PREFIX.exec(heading.title)?.[1];
    const featureName = heading.title.replace(LEVEL_PREFIX, "");
    const base = [
      name,
      ...(section === "subclass" ? [subclass] : []),
      featureName,
    ]
      .map(slugOf)
      .join("-");
    // Improved Brutal Strike has one heading per level it improves at.
    const slug = used.has(base) && level ? `${base}-${level}` : base;
    used.add(slug);
    (section === "subclass" ? subclassFeatures : features).push({
      slug,
      headingId: heading.id,
      name: featureName,
      text: blockText(bodyOf(html, headings, heading, isBoundary)),
      level: level === undefined ? null : Number(level),
      subclass,
    });
  }
  return { features, subclassFeatures };
}

// A class that is a chapter of its own sits one heading level higher, and its subclasses have plain headings,
// so the page is read as if it used the same headings as the Player's Handbook.
function asHandbookHeadings(
  headings: readonly Heading[],
  chapter: readonly Heading[],
): readonly Heading[] {
  let inSubclasses = false;
  const moved = new Map(
    chapter.map((item) => {
      if (item.tag === 2) inSubclasses = item.title.endsWith("Subclasses");
      const override = !inSubclasses
        ? ""
        : item.tag === 3
          ? " h3-override"
          : item.tag === 4 && LEVEL_PREFIX.test(item.title)
            ? " h4-override"
            : "";
      return [
        item.start,
        {
          ...item,
          // The spell list ends the features rather than being one of them.
          tag: item.title.endsWith("Spell List") ? 3 : item.tag + 1,
          attributes: `${item.attributes}${override}`,
        },
      ];
    }),
  );
  return headings.map((item) => moved.get(item.start) ?? item);
}

function classChapters(html: string): readonly ClassChapter[] {
  const headings = headingsIn(html);
  return headings
    .filter((heading) => heading.tag <= 2)
    .flatMap((heading) => {
      const name = heading.title.replace(/^The /, "");
      const tables = tablesIn(bodyOf(html, headings, heading));
      const core = tables.find(
        (table) => captionOf(table) === `Core ${name} Traits`,
      );
      const levelTable = tables.find(
        (table) => captionOf(table) === `${name} Features`,
      );
      if (!core || !levelTable) return [];
      const under = headingsUnder(headings, heading);
      const own = under.some(
        (item) => item.tag === 2 && item.title.endsWith("Class Features"),
      );
      const page = own ? asHandbookHeadings(headings, under) : headings;
      return [
        {
          name,
          traits: new Map(
            rowsOf(core).map((row) => [
              plainText(row[0] ?? ""),
              plainText(row[1] ?? ""),
            ]),
          ),
          levelTable,
          // Only a class with a chapter of its own: the spells of the books before it can't name it, but a
          // Player's Handbook class is named by its spells.
          spellTables: own
            ? tables.filter((table) =>
                new RegExp(`Level \\d ${name} Spells\\)?$`).test(
                  captionOf(table),
                ),
              )
            : [],
          ...chapterFeatures(html, name, page, headingsUnder(page, heading)),
        },
      ];
    });
}

function featureId(pluginId: string, slug: string): string {
  return `${pluginId}:feature/${slug}`;
}

const DICE = /^(\d+)?d(\d+)$/i;

// The schema only holds numbers, so a die column keeps whichever part changes with level.
function scalingColumn(
  title: string,
  cells: readonly string[],
): { readonly key: string; readonly values: readonly (number | null)[] } {
  const key = camelCase(title);
  const dice = cells.flatMap((cell) => {
    const match = DICE.exec(cell);
    return match ? [match] : [];
  });
  const [first] = dice;
  if (!first) {
    return {
      key,
      values: cells.map((cell) => {
        const number = /^[+]?(\d+)/.exec(cell)?.[1];
        return number === undefined ? null : Number(number);
      }),
    };
  }
  const sameCount = dice.every((match) => match[1] === first[1]);
  return {
    key: sameCount
      ? `${key.replace(/Die$/, "")}Die`
      : `${key}D${first[2] ?? ""}`,
    values: cells.map((cell) => {
      const match = DICE.exec(cell);
      if (!match) return null;
      return Number(sameCount ? match[2] : (match[1] ?? 1));
    }),
  };
}

function slotsAt(values: readonly number[]): readonly number[] {
  const last = values.findLastIndex((value) => value > 0);
  return values.slice(0, last + 1);
}

function skillChoice(text: string): ChoiceDef | null {
  const count = /Choose (?:any )?(\d+)/i.exec(text)?.[1];
  if (count === undefined) return null;
  const named = (text.split(":")[1] ?? "")
    .split(/,|\bor\b/)
    .map(camelCase)
    .filter((name): name is Skill => name in SKILL_ABILITIES);
  return {
    kind: "skills",
    id: "skills",
    count: Number(count),
    from: named.length > 0 ? named : (Object.keys(SKILL_ABILITIES) as Skill[]),
  };
}

const NOT_SCALING =
  /^(?:Level|Proficiency Bonus|Class Features|\d|Spell Slots|Slot Level)/;

function parseLevels(
  chapter: ClassChapter,
  pluginId: string,
): { readonly levels: readonly unknown[]; readonly notes: readonly string[] } {
  const rows = rowsOf(chapter.levelTable);
  const header = rows.find((row) => plainText(row[0] ?? "") === "Level");
  const body = rows.filter((row) => /^\d+$/.test(plainText(row[0] ?? "")));
  const titles = (header ?? []).map(plainText);
  const textAt = (row: readonly string[], index: number): string =>
    plainText(row[index] ?? "");
  const notes: string[] = [];

  const columns = titles.flatMap((title, index) =>
    NOT_SCALING.test(title)
      ? []
      : [
          scalingColumn(
            title,
            body.map((row) => textAt(row, index)),
          ),
        ],
  );
  const slotColumns = titles.flatMap((title, index) =>
    /^\d$/.test(title) ? [index] : [],
  );
  const featuresAt = titles.indexOf("Class Features");
  const pactSlots = titles.indexOf("Spell Slots");
  const pactLevel = titles.indexOf("Slot Level");
  const known = new Map(
    chapter.features.map((feature) => [feature.headingId, feature.slug]),
  );
  const missing = new Set<string>();
  const skills = skillChoice(
    [...chapter.traits].find(([key]) => key.startsWith("Skill"))?.[1] ?? "",
  );

  const levels = body.map((row, rowIndex) => {
    const grants = new Set<string>();
    for (const link of (row[featuresAt] ?? "").matchAll(
      /<a\b[^>]*href="[^"#]*#([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    )) {
      const slug = known.get(link[1] ?? "");
      if (slug) grants.add(featureId(pluginId, slug));
      else missing.add(plainText(link[2] ?? ""));
    }
    const slots =
      pactSlots >= 0
        ? [
            ...Array<number>(
              Math.max(0, Number(textAt(row, pactLevel)) - 1),
            ).fill(0),
            Number(textAt(row, pactSlots)),
          ]
        : slotColumns.map((index) => Number(textAt(row, index)) || 0);
    return {
      level: Number(textAt(row, 0)),
      grants: [...grants],
      ...(rowIndex === 0 && skills ? { choices: [skills] } : {}),
      slots: slotsAt(slots),
      scaling: Object.fromEntries(
        columns.flatMap(({ key, values }) => {
          const value = values[rowIndex];
          return value === null || value === undefined ? [] : [[key, value]];
        }),
      ),
    };
  });
  if (missing.size > 0) {
    notes.push(`table links with no feature: ${[...missing].join(", ")}`);
  }
  if (pactSlots >= 0) {
    notes.push(
      "pact slots are stored as ordinary slots, and only a granted Pact Magic feature brings them back on a short rest",
    );
  }
  return { levels, notes };
}

// A class added by a later book can't be named by the spells of earlier ones, so it lists them itself.
function spellListOf(
  chapter: ClassChapter,
  html: string,
  pluginId: string,
  knownIds: readonly string[],
): { readonly ids: readonly string[]; readonly unknown: readonly string[] } {
  const own = new Set(
    splitSpells(spellTextFromHtml(html)).map((item) => item.slug),
  );
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const table of chapter.spellTables) {
    // A row with a single cell is a footnote.
    for (const [cell = ""] of rowsOf(table)
      .slice(1)
      .filter((row) => row.length > 1)) {
      const name = plainText(cell);
      const slug = slugOf(name);
      const id = own.has(slug)
        ? `${pluginId}:spell/${slug}`
        : knownId(knownIds, "spell", slug);
      if (id === undefined) unknown.push(name);
      else ids.push(id);
    }
  }
  return { ids, unknown };
}

// Classes and features are parsed separately, and meet through the heading each level table links to.
export function parseClassesFromHtml(
  html: string,
  pluginId: string,
  knownIds?: readonly string[],
): readonly ParsedImport[] {
  return classChapters(html).map((chapter) => {
    const { name, traits } = chapter;
    const trait = (label: RegExp): string =>
      [...traits].find(([key]) => label.test(key))?.[1] ?? "";
    const weapons = trait(/^Weapon/);
    const armor = trait(/^Armor/);
    const ability = chapter.features
      .map(
        (feature) =>
          /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) is (?:your|the) spellcasting ability/.exec(
            feature.text,
          )?.[1],
      )
      .find(Boolean);
    const [spellcasting] = abilitiesIn(ability ?? "");
    const { levels, notes } = parseLevels(chapter, pluginId);
    const slug = slugOf(name);
    const spellList =
      knownIds && chapter.spellTables.length > 0
        ? spellListOf(chapter, html, pluginId, knownIds)
        : { ids: [], unknown: [] };
    const limited = /Martial weapons that have the (.+?) propert/i.exec(
      weapons,
    );
    return {
      slug,
      notes: [
        ...notes,
        ...(spellList.unknown.length > 0
          ? [`spell list names not found: ${spellList.unknown.join(", ")}`]
          : []),
      ],
      entry: {
        id: `${pluginId}:class/${slug}`,
        name,
        hitDie: `d${/D(\d+)/i.exec(trait(/^Hit Point/))?.[1] ?? ""}`,
        primaryAbilities: abilitiesIn(trait(/^Primary/)),
        savingThrows: abilitiesIn(trait(/^Saving/)),
        weapons: [
          ...(/simple/i.test(weapons) ? ["simple"] : []),
          ...(/martial/i.test(weapons) ? ["martial"] : []),
        ],
        ...(limited
          ? {
              martialWeaponProperties: (limited[1] ?? "")
                .split(/,|\bor\b|\band\b/)
                .map(camelCase)
                .filter(Boolean),
            }
          : {}),
        armor: ["light", "medium", "heavy", "shield"].filter((item) =>
          armor.toLowerCase().includes(item),
        ),
        ...(spellcasting ? { spellcasting: { ability: spellcasting } } : {}),
        ...(spellList.ids.length > 0 ? { spellList: spellList.ids } : {}),
        levels,
      },
    };
  });
}

function featureEntry(pluginId: string, feature: BookFeature): ParsedImport {
  return {
    slug: feature.slug,
    notes: [],
    entry: {
      id: featureId(pluginId, feature.slug),
      name: feature.name,
      text: feature.text,
      automation: "text",
    },
  };
}

function groupBy<K, T>(
  items: readonly T[],
  key: (item: T) => K,
): ReadonlyMap<K, readonly T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  }
  return groups;
}

interface BookSubclass {
  readonly className: string;
  readonly name: string;
  readonly features: readonly BookFeature[];
  readonly castingTable: readonly CastingLevel[];
  readonly older?: boolean;
}

interface CastingLevel {
  readonly level: number;
  readonly slots: readonly number[];
  readonly scaling: Readonly<Record<string, number>>;
}

// A subclass that casts on its own prints a level table with a column per spell level.
function castingTableIn(html: string): readonly CastingLevel[] {
  for (const table of tablesIn(html)) {
    const rows = rowsOf(table).map((row) => row.map(plainText));
    const header = rows.find(
      (row) =>
        (row[0] ?? "").endsWith("Level") &&
        row.some((cell) => /^\d$/.test(cell)),
    );
    if (!header) continue;
    return rows.flatMap((row) => {
      if (!/^\d+$/.test(row[0] ?? "")) return [];
      const at = (column: string): number =>
        Number(row[header.indexOf(column)]) || 0;
      const named = header.slice(1).filter((title) => !/^\d$/.test(title));
      return [
        {
          level: Number(row[0]),
          slots: slotsAt(header.filter((title) => /^\d$/.test(title)).map(at)),
          scaling: Object.fromEntries(
            named.map((title) => [camelCase(title), at(title)]),
          ),
        },
      ];
    });
  }
  return [];
}

const SUBCLASS_TITLE = /^(.+) \(([A-Z][a-z]+)\)$/;

const CLASS_TITLE =
  /^(Barbarian|Bard|Cleric|Druid|Fighter|Monk|Paladin|Ranger|Rogue|Sorcerer|Warlock|Wizard)s?$/;
const LEVEL_IN_TEXT = /\b(\d+)(?:st|nd|rd|th) level\b/;
// An invocation or a spell can sit under the same headings, and a table's title is only its label.
const NOT_A_FEATURE =
  /^(?:Prerequisite\b|\w+ cantrip\b|\d(?:st|nd|rd|th)-level )/;

// 2014 books give a subclass's features plain headings and say the level in their text. They're always kept
// apart from books with whole classes, whose chapters have other headings that could look like this.
function olderSubclasses(
  html: string,
  headings: readonly Heading[],
): readonly BookSubclass[] {
  if (
    classChapters(html).length > 0 ||
    headings.some((item) => item.title === "Class Features")
  ) {
    return [];
  }
  const isTableTitle = (item: Heading): boolean =>
    item.attributes.includes("Table-Title");
  let className = "";
  return headings.flatMap((heading) => {
    if (heading.tag === 1) className = "";
    const named =
      heading.tag === 2 ? CLASS_TITLE.exec(heading.title)?.[1] : undefined;
    if (named) className = named;
    if (named || !className || heading.tag > 3) return [];
    const parts = headingsUnder(headings, heading)
      .filter((item) => item.tag === 4 && !isTableTitle(item))
      .map((item) => {
        const text = blockText(
          bodyOf(
            html,
            headings,
            item,
            (next) => next.tag <= item.tag && !isTableTitle(next),
          ),
        );
        const level = LEVEL_IN_TEXT.exec(text)?.[1];
        return {
          item,
          text,
          level: level === undefined ? null : Number(level),
        };
      })
      .filter(({ text }) => !NOT_A_FEATURE.test(text));
    const levels = parts.flatMap(({ level }) =>
      level === null ? [] : [level],
    );
    // A real subclass adds to several levels, where notes on a class's history only mention one or two.
    if (new Set(levels).size < 3) return [];
    const used = new Set<string>();
    return [
      {
        className,
        name: heading.title,
        older: true,
        castingTable: [],
        features: parts.map(({ item, text, level }) => {
          const base = [className, heading.title, item.title]
            .map(slugOf)
            .join("-");
          const slug = used.has(base) ? `${base}-${String(level)}` : base;
          used.add(slug);
          return {
            slug,
            headingId: item.id,
            name: item.title,
            text,
            // A feature with no level of its own, such as an expanded spell list, comes with the subclass.
            level: level ?? Math.min(...levels),
            subclass: heading.title,
          };
        }),
      },
    ];
  });
}

// Books after the Player's Handbook print a subclass alone, as "Name (Class)" above "Level N: Feature" headings.
function bookSubclasses(html: string): readonly BookSubclass[] {
  // A stat block's title can outrank the features around it, and it belongs to the feature that grants it.
  const headings = headingsIn(html).filter(
    (item) => !isStatBlockTitle(html, item.start),
  );
  const modern = headings.flatMap((heading) => {
    const [, name, className] = SUBCLASS_TITLE.exec(heading.title) ?? [];
    // Tag 3 and below, as a chapter heading can read "Classes (Continued)".
    if (!name || !className || heading.tag < 3) return [];
    const levelled = headingsUnder(headings, heading).filter((item) =>
      LEVEL_PREFIX.test(item.title),
    );
    if (levelled.length === 0) return [];
    const starts = new Set(levelled.map((item) => item.start));
    const used = new Set<string>();
    const features = levelled.map((item) => {
      const level = LEVEL_PREFIX.exec(item.title)?.[1];
      const featureName = item.title.replace(LEVEL_PREFIX, "");
      const base = [className, name, featureName].map(slugOf).join("-");
      const slug = used.has(base) ? `${base}-${level ?? ""}` : base;
      used.add(slug);
      return {
        slug,
        headingId: item.id,
        name: featureName,
        text: blockText(
          bodyOf(
            html,
            headings,
            item,
            (next) => starts.has(next.start) || next.tag <= heading.tag,
          ),
        ),
        level: level === undefined ? null : Number(level),
        subclass: name,
      };
    });
    return [
      {
        className,
        name,
        features,
        castingTable: castingTableIn(bodyOf(html, headings, heading)),
      },
    ];
  });
  return [...modern, ...olderSubclasses(html, headings)];
}

function bookSubclassEntries(
  html: string,
  pluginId: string,
  knownIds: readonly string[] | undefined,
): readonly ParsedImport[] {
  const own = new Set(classChapters(html).map((item) => item.name));
  return bookSubclasses(html).flatMap((subclass) => {
    const classSlug = slugOf(subclass.className);
    const classId =
      own.has(subclass.className) || !knownIds
        ? `${pluginId}:class/${classSlug}`
        : knownId(knownIds, "class", classSlug);
    // Its features are still imported, so they're ready if that class ever arrives.
    if (classId === undefined) return [];
    const slug = `${classSlug}-${slugOf(subclass.name)}`;
    const byLevel = groupBy(subclass.features, (item) => item.level ?? 0);
    const levels = [
      ...new Set([
        ...byLevel.keys(),
        ...subclass.castingTable.map((item) => item.level),
      ]),
    ].sort((a, b) => a - b);
    return [
      {
        slug,
        notes: [],
        entry: {
          id: `${pluginId}:subclass/${slug}`,
          name: subclass.name,
          class: classId,
          ...(subclass.older ? { edition: "2014" } : {}),
          levels: levels.map((level) => {
            const casting = subclass.castingTable.find(
              (item) => item.level === level,
            );
            return {
              level,
              grants: (byLevel.get(level) ?? []).map((item) =>
                featureId(pluginId, item.slug),
              ),
              ...(casting
                ? { slots: casting.slots, scaling: casting.scaling }
                : {}),
            };
          }),
        },
      },
    ];
  });
}

export function parseSubclassesFromHtml(
  html: string,
  pluginId: string,
  knownIds?: readonly string[],
): readonly ParsedImport[] {
  return [
    ...parseChapterSubclasses(html, pluginId),
    ...bookSubclassEntries(html, pluginId, knownIds),
  ];
}

function parseChapterSubclasses(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  return classChapters(html).flatMap((chapter) =>
    [...groupBy(chapter.subclassFeatures, (item) => item.subclass)].map(
      ([name, features]) => {
        const slug = `${slugOf(chapter.name)}-${slugOf(name)}`;
        const byLevel = groupBy(
          features.filter((item) => item.level !== null),
          (item) => item.level ?? 0,
        );
        const unlevelled = features.filter((item) => item.level === null);
        return {
          slug,
          notes: unlevelled.map(
            (item) => `no level in the heading of ${item.name}`,
          ),
          entry: {
            id: `${pluginId}:subclass/${slug}`,
            name,
            class: `${pluginId}:class/${slugOf(chapter.name)}`,
            levels: [...byLevel].map(([level, items]) => ({
              level,
              grants: items.map((item) => featureId(pluginId, item.slug)),
            })),
          },
        };
      },
    ),
  );
}

// Printed text only: no mechanics are worked out here.
export function parseFeaturesFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  return [
    ...classChapters(html).flatMap((chapter) =>
      [...chapter.features, ...chapter.subclassFeatures].map((feature) =>
        featureEntry(pluginId, feature),
      ),
    ),
    ...bookSubclasses(html).flatMap((subclass) =>
      subclass.features.map((feature) => featureEntry(pluginId, feature)),
    ),
    ...parseSpeciesTraits(html, pluginId),
  ];
}
