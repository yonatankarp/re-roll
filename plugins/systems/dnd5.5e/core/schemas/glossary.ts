import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";

// The rules glossary (#132): terms, conditions, actions and the rest, each text a book prints. Keyed by
// content folder, with the id kinds coverage files name.
export const GLOSSARY_KINDS = {
  "rule-terms": "rule-term",
  conditions: "condition",
  actions: "action",
  senses: "sense",
  skills: "skill",
  "creature-types": "creature-type",
  "areas-of-effect": "area-of-effect",
  "weapon-properties": "weapon-property",
  "weapon-masteries": "weapon-mastery",
  attitudes: "attitude",
} as const;

export const GlossaryEntrySchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  source: z.string().min(1), // the book's title
  // shortcut: optional, since the imported library has no printed page numbers. Require it once it does (#181).
  page: z.number().int().positive().optional(),
  text: z.string(),
}).strict();

// Monster families and lairs (#133), text kinds like the glossary's, keyed by content folder.
export const MONSTER_TEXT_KINDS = {
  "monster-families": "monster-family",
  lairs: "lair",
} as const;

// Kinds for what a book describes beside its rules (#134–#136), each entry the glossary's shape: content folder ->
// id kind. Environmental effects, diseases and dungeon features play (#191, their schemas below); curses stay text.
export const ENVIRONMENT_KINDS = {
  "environmental-effects": "environmental-effect",
  diseases: "disease",
  curses: "curse",
  "dungeon-features": "dungeon-feature",
} as const;
export const DOWNTIME_KINDS = {
  "downtime-activities": "downtime-activity",
  lifestyles: "lifestyle",
  services: "service",
  "renown-tracks": "renown-track",
  "group-patrons": "group-patron",
  "marks-of-prestige": "mark-of-prestige",
  "bastion-orders": "bastion-order",
  "vehicle-upgrades": "vehicle-upgrade",
} as const;
// A variant rule is a switch a run could turn on; here it is only its text.
export const OPTION_KINDS = {
  "supernatural-gifts": "supernatural-gift",
  "epic-destinies": "epic-destiny",
  "survivor-talents": "survivor-talent",
  "circle-casting-options": "circle-casting-option",
  "beast-shape-lists": "beast-shape-list",
  "variant-rules": "variant-rule",
} as const;
// The option kinds a story grants to a character (#192), which carry mechanics.
export const GRANTED_KINDS = {
  "supernatural-gifts": OPTION_KINDS["supernatural-gifts"],
  "epic-destinies": OPTION_KINDS["epic-destinies"],
  "survivor-talents": OPTION_KINDS["survivor-talents"],
  "circle-casting-options": OPTION_KINDS["circle-casting-options"],
  "beast-shape-lists": OPTION_KINDS["beast-shape-lists"],
} as const;

// A family heading (Bandits, Black Dragons): the stat blocks and families it holds or, for a group, lists.
export const MonsterFamilySchema = GlossaryEntrySchema.extend({
  members: z.array(ContentIdSchema).default([]),
}).strict();

// A monster's lair: its regional effects as printed, and whose lair it is. A 2024 stat block prints its
// in-Lair numbers itself, so play reads nothing here.
export const LairSchema = GlossaryEntrySchema.extend({
  owners: z.array(ContentIdSchema).default([]),
}).strict();

// An engine value as the name in its entity's id: "twoHanded" is weapon-property/two-handed.
export const glossaryName = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
