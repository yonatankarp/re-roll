// World kinds (#127): setting lore, the same under any rule system, so the engine owns them and any
// system's plugins can fill them. Each entry is text a book prints, like an `automation: text` rule.
import { z } from "zod";
import {
  ContentEntrySchema,
  ContentIdSchema,
  type ContentKind,
  contentKind,
} from "./system.ts";

export const WorldEntrySchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  source: z.string().min(1), // the book's title
  // shortcut: optional, since the imported library has no printed page numbers. Require it once it does.
  page: z.number().int().positive().optional(),
  text: z.string(),
  // Where the book puts it: an area's place, a place inside another, an NPC's home.
  place: ContentIdSchema.optional(),
  pantheon: ContentIdSchema.optional(), // a deity's
  faction: ContentIdSchema.optional(), // an NPC's
}).strict();
export type WorldEntry = z.infer<typeof WorldEntrySchema>;

// A keyed adventure area always belongs to its place.
const AreaSchema = WorldEntrySchema.extend({ place: ContentIdSchema });

const links = (entry: WorldEntry): string[] =>
  [entry.place, entry.pantheon, entry.faction].filter(
    (id): id is string => id !== undefined,
  );

// Keyed by content folder, like a system's kinds. Each idPrefix is the kind coverage files name.
const PREFIXES: Readonly<Record<string, string>> = {
  places: "place",
  deities: "deity",
  pantheons: "pantheon",
  factions: "faction",
  npcs: "npc",
  peoples: "people",
  adventures: "adventure",
  eras: "era",
  events: "event",
  "calendar-days": "calendar-day",
  phenomena: "phenomenon",
  settings: "setting",
  materials: "material",
};

export const WORLD_KINDS: Readonly<Record<string, ContentKind>> = {
  ...Object.fromEntries(
    Object.entries(PREFIXES).map(([folder, idPrefix]) => [
      folder,
      contentKind({ idPrefix, schema: WorldEntrySchema, references: links }),
    ]),
  ),
  areas: contentKind({
    idPrefix: "area",
    schema: AreaSchema,
    references: links,
  }),
};

// A system's kinds can't take a world kind's folder or id prefix, so a world id means one thing.
export function worldClashes(
  kinds: Readonly<Record<string, ContentKind>>,
): string[] {
  const prefixes = new Set(Object.values(WORLD_KINDS).map((k) => k.idPrefix));
  return Object.entries(kinds).flatMap(([folder, kind]) => [
    ...(Object.hasOwn(WORLD_KINDS, folder)
      ? [`content folder "${folder}"`]
      : []),
    ...(prefixes.has(kind.idPrefix) ? [`id prefix "${kind.idPrefix}"`] : []),
  ]);
}
