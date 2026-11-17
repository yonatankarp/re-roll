// Drafts world entities (#127–#129) for the library headings coverage says should be one, by code
// alone: the name is the heading, the text is what the book prints under it, and the links come
// from where the book nests it (an area in its place, a deity under its pantheon).
import { WORLD_KINDS, type WorldEntry } from "../kernel/world.ts";
import { STRUCTURAL, type Verdict, slug } from "./coverage.ts";

// The world kinds' folders by id kind. A system's text kinds, such as a rules glossary, come as `more`.
const WORLD_FOLDERS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WORLD_KINDS).map(([folder, kind]) => [kind.idPrefix, folder]),
);
// A text kind's heading can wrap its name in a label saying its kind or its price ("Blinded [Condition]",
// "Variant: Encumbrance", "Modest (1 GP per Day)"), which the id and name leave out.
const LABELS = [
  /\s*\[[^\]]*\]$/,
  /^(?:variant|option):\s*/i,
  /\s*\((?:free|[\d,]+\s*[cesgp]p\b[^)]*)\)$/i,
];
const unlabelled = (text: string): string =>
  LABELS.reduce((name, label) => name.replace(label, ""), text) || text;
const kindOf = (id: string): string => /:([^/]+)\//.exec(id)?.[1] ?? "";
const tailOf = (id: string): string => id.slice(id.indexOf("/") + 1);

export interface WorldDraft {
  readonly file: string; // "<folder>/<id's name>.yaml", inside the book's rules plugin
  readonly entry: WorldEntry;
}

export interface WorldDrafts {
  readonly drafts: readonly WorldDraft[];
  readonly homeless: readonly string[]; // keyed areas with no place above them, by heading id
}

export function draftWorld(
  book: string,
  source: string,
  verdicts: readonly Verdict[], // the book's, in reading order
  taken: ReadonlySet<string>, // files the plugin already has
  more: Readonly<Record<string, string>> = {}, // a system's text kinds: id kind -> folder
): WorldDrafts {
  const FOLDERS = new Map(Object.entries({ ...WORLD_FOLDERS, ...more }));
  const labelled = (kind: string) => Object.hasOwn(more, kind);
  const used = new Set(taken);
  const ids = verdicts.map((verdict) =>
    verdict.status === "linked" && FOLDERS.has(verdict.kind)
      ? verdict.entity
      : undefined,
  );
  const level = (at: number) => verdicts[at]?.heading.level ?? 0;
  // The nearest heading above this one, at a shallower level, that is an entity of the kind.
  const above = (at: number, kind: string): string | undefined => {
    for (let i = at - 1, depth = level(at); i >= 0 && depth > 1; i -= 1) {
      if (level(i) >= depth) continue;
      depth = level(i);
      const id = ids[i];
      if (id !== undefined && kindOf(id) === kind) return id;
    }
    return undefined;
  };
  // Its own words, and those of the parts below it (Features, History), but not of entities below it.
  const textOf = (at: number): string => {
    const parts = [verdicts[at]?.heading.body ?? ""];
    let skip = Infinity;
    for (let i = at + 1; i < verdicts.length && level(i) > level(at); i += 1) {
      const verdict = verdicts[i];
      if (!verdict || level(i) > skip) continue;
      skip = Infinity;
      if (verdict.status !== STRUCTURAL) {
        skip = level(i);
        continue;
      }
      const { heading } = verdict;
      parts.push(`${"#".repeat(heading.level)} ${heading.text}`, heading.body);
    }
    return parts.filter(Boolean).join("\n\n");
  };

  const drafts: WorldDraft[] = [];
  const homeless: string[] = [];
  verdicts.forEach((verdict, at) => {
    const folder = FOLDERS.get(verdict.kind);
    // Each book's lore is its own entity, even where another book's has the same name.
    const elsewhere =
      verdict.status === "linked" && !verdict.entity?.startsWith(`${book}:`);
    if (folder === undefined || (verdict.status !== "missing" && !elsewhere))
      return;
    const { heading, kind } = verdict;
    const place = above(at, "place");
    if (kind === "area" && place === undefined) {
      homeless.push(heading.id);
      return;
    }
    // An area's id starts with its place's, since many places have a "1. Entrance".
    const shown = labelled(kind) ? unlabelled(heading.text) : heading.text;
    const full =
      slug(shown.normalize("NFD").replace(/\p{M}/gu, "")) || "untitled";
    // A ruling's heading is a whole question, so its name stops at a word near 60 letters.
    const name =
      full.length > 60 ? full.slice(0, 61).replace(/-[^-]*$/, "") : full;
    const base = kind === "area" && place ? `${tailOf(place)}-${name}` : name;
    let tail = base;
    for (let n = 2; used.has(`${folder}/${tail}.yaml`); n += 1)
      tail = `${base}-${String(n)}`;
    const file = `${folder}/${tail}.yaml`;
    used.add(file);
    const id = `${book}:${kind}/${tail}`;
    ids[at] = id;

    const pantheon = kind === "deity" ? above(at, "pantheon") : undefined;
    const faction = kind === "npc" ? above(at, "faction") : undefined;
    const placed = ["place", "area", "npc"].includes(kind) ? place : undefined;
    drafts.push({
      file,
      entry: {
        id,
        name: shown,
        source,
        text: textOf(at),
        library: [heading.id],
        ...(placed ? { place: placed } : {}),
        ...(pantheon ? { pantheon } : {}),
        ...(faction ? { faction } : {}),
      },
    });
  });
  return { drafts, homeless };
}
