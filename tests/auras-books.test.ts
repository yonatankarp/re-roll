import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { type RunContext, createRunContext } from "../engine/run/turn.ts";
import { rollBonus } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import type { CharacterBuild } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { zonesOf } from "../plugins/systems/dnd5.5e/core/zones.ts";
import { scripted } from "./feat-fixtures.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #164's book entries, on characters given them outright. Skipped where the books aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/phb") &&
  existsSync("books/rules/heroes-of-faerun");

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "auras-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "heroes-of-faerun",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
});

// A level `level` character of `classId` with these book features outright.
function bearer(
  features: readonly string[],
  classId = "phb:class/paladin",
  level = 6,
  id = PLAYER_ACTOR,
): Actor {
  const build: CharacterBuild = {
    baseAbilities: { str: 15, dex: 10, con: 13, int: 12, wis: 14, cha: 16 },
    speciesId: "phb:species/human",
    backgroundId: "phb:background/soldier",
    backgroundIncrease: { str: 2, con: 1 },
    levels: Array.from({ length: level }, (_, index) => ({
      classId,
      hitPointGain: 8,
      answers:
        index === 0
          ? [{ kind: "features" as const, values: [...features] }]
          : [],
    })),
  };
  return freshActor({
    id,
    name: id,
    side: "party",
    source: { kind: "character", build },
    hp: 40,
    inventory: ["srd52:item/longsword"],
  });
}

const row = (actors: readonly Actor[], gap = 1): DndState => ({
  actors: Object.fromEntries(
    actors.map((actor, index) => [
      actor.id,
      { ...actor, position: { x: index * gap, y: 0 } },
    ]),
  ),
  combat: {
    encounter: "arena",
    order: actors.map((actor) => actor.id),
    index: 0,
    round: 1,
    grid: { width: 40, height: 3 },
  },
});
const at = (state: DndState) => ({
  state,
  dice: scripted([]).dice,
  content: run.content,
  contentIds: run.contentIds,
});

describe.skipIf(!BOOKS)("auras and support for allies from the books", () => {
  it("Aura of Protection adds the Paladin's Charisma modifier to an ally's saves within 10 feet, 30 from level 18", () => {
    const aura = "phb:feature/paladin-aura-of-protection";
    const ally = bearer([], "phb:class/fighter", 3, "ally");
    const near = row([bearer([aura]), ally], 2);
    expect(rollBonus(near.actors.ally!, "saves", at(near))).toBe(3);
    const far = row([bearer([aura]), ally], 5);
    expect(rollBonus(far.actors.ally!, "saves", at(far))).toBe(0);
    const wide = row([bearer([aura], "phb:class/paladin", 18), ally], 5);
    expect(rollBonus(wide.actors.ally!, "saves", at(wide))).toBe(3);
  });

  it("Holy Nimbus fills the aura with sunlight only once it's used", () => {
    const nimbus = "phb:feature/paladin-oath-of-devotion-holy-nimbus";
    const paladin = bearer([nimbus]);
    const sunlit = (actor: Actor) =>
      zonesOf(row([actor]), run).some((zone) => zone.zone === "sunlight");
    expect(sunlit(paladin)).toBe(false);
    const lit = {
      ...paladin,
      activeEffects: [
        {
          sourceId: `feature:${nimbus}:0`,
          casterId: PLAYER_ACTOR,
          modifier: { kind: "aspect" as const, name: "holy-nimbus" },
          ends: "spellDuration" as const,
        },
      ],
    };
    expect(sunlit(lit)).toBe(true);
  });

  it("Group Recovery and Rallying Surge ride on Second Wind and Action Surge", () => {
    const fighter = bearer(
      [
        "phb:feature/fighter-second-wind",
        "phb:feature/fighter-action-surge",
        "heroes-of-faerun:feature/fighter-banneret-group-recovery",
        "heroes-of-faerun:feature/fighter-banneret-rallying-surge",
      ],
      "phb:class/fighter",
      7,
    );
    const actions = deriveStats(fighter, run).actions;
    const allies = (feature: string) =>
      actions.find((action) => action.id.startsWith(`feature:${feature}:`))
        ?.activation.alsoAllies;
    expect(allies("phb:feature/fighter-second-wind")?.[0]?.within).toBe(30);
    expect(allies("phb:feature/fighter-action-surge")?.[0]?.within).toBe(30);
  });

  it("Bardic Inspiration gives a die that Combat Inspiration lets go to damage", () => {
    const bard = bearer(
      [
        "phb:feature/bard-bardic-inspiration",
        "phb:feature/bard-college-of-valor-combat-inspiration",
      ],
      "phb:class/bard",
      3,
    );
    const stats = deriveStats(bard, run);
    expect(
      stats.passives.some(({ kind }) => kind === "combatInspiration"),
    ).toBe(true);
    const give = stats.actions.find((action) =>
      action.id.startsWith("feature:phb:feature/bard-bardic-inspiration:"),
    );
    expect(give?.activation.resolution).toMatchObject({
      effects: [{ modifier: { kind: "inspired" } }],
    });
  });
});
