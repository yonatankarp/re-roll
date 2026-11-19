import { beforeAll, describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { RunContext } from "../engine/run/turn.ts";
import {
  ClassSchema,
  SubclassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { auditClass, levelTo } from "./class-features.ts";

// Issue #222: with no books, the SRD 5.2 builds every one of its twelve classes, with its subclass, to level 20.
const CLASSES = [
  ["barbarian", "path-of-the-berserker"],
  ["bard", "college-of-lore"],
  ["cleric", "life-domain"],
  ["druid", "circle-of-the-land"],
  ["fighter", "champion"],
  ["monk", "warrior-of-the-open-hand"],
  ["paladin", "oath-of-devotion"],
  ["ranger", "hunter"],
  ["rogue", "thief"],
  ["sorcerer", "draconic-sorcery"],
  ["warlock", "fiend-patron"],
  ["wizard", "evoker"],
] as const;

let run: RunContext;
beforeAll(async () => {
  ({ run } = await loadAdventure("goblin-ambush"));
});

describe("SRD 5.2 classes without books", () => {
  it("ships all twelve classes and one subclass each", () => {
    const ids = run.contentIds();
    expect(ids.filter((id) => id.startsWith("srd52:class/")).sort()).toEqual(
      CLASSES.map(([cls]) => `srd52:class/${cls}`).sort(),
    );
    for (const [cls, sub] of CLASSES) {
      expect(lookup(run, SubclassSchema, `srd52:subclass/${sub}`).class).toBe(
        `srd52:class/${cls}`,
      );
    }
  });

  it.each(CLASSES)(
    "%s levels from 1 to 20 through the real level-up decisions",
    (cls, sub) => {
      const classDef = lookup(run, ClassSchema, `srd52:class/${cls}`);
      expect(classDef.levels.map((level) => level.level)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
      const actor = levelTo(run, classDef.id, `srd52:subclass/${sub}`, 20);
      if (actor.source.kind !== "character") throw new Error("No character");
      expect(actor.source.build?.levels).toHaveLength(20);
      const rows = auditClass(
        run,
        classDef,
        lookup(run, SubclassSchema, `srd52:subclass/${sub}`),
      );
      // Every resource has uses and every caster has slots at the level it's gained.
      expect(
        rows
          .filter((row) => /has no uses|no spell slots/.test(row.why))
          .map((row) => `${row.id}: ${row.why}`),
      ).toEqual([]);
    },
  );
});
