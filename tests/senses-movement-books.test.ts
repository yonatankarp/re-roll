import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createRunContext, type RunContext } from "../engine/run/turn.ts";
import { speedsOf } from "../plugins/systems/dnd5.5e/core/movement-modes.ts";
import { SpellSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { sensesOf } from "../plugins/systems/dnd5.5e/core/sight.ts";
import type { Actor } from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

const PLUGINS = [
  "phb",
  "dmg",
  "xanathars-guide",
  "heroes-of-faerun",
  "arcana-unleashed",
  "sword-coast-guide",
];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

// A level 5 fighter with these features and items, as a sample of #172, #173 and #200's entries plays.
function fighter(
  run: RunContext,
  features: readonly string[],
  items: readonly string[] = [],
  picks: Readonly<Record<string, string>> = {}, // a variant picked, by feature
): Actor {
  const built = levelTo(run, "phb:class/fighter", null, 5);
  if (built.source.kind !== "character" || !built.source.build) {
    throw new Error("No build");
  }
  const { build } = built.source;
  const levels = build.levels.map((entry, index) => ({
    ...entry,
    answers: [
      ...entry.answers,
      ...(index === 0
        ? [
            { kind: "features" as const, values: [...features] },
            ...Object.entries(picks).map(([feature, value]) => ({
              kind: "variant" as const,
              feature,
              values: [value],
            })),
          ]
        : []),
    ],
  }));
  return {
    ...built,
    inventory: [...built.inventory, ...items],
    source: { kind: "character", build: { ...build, levels } },
  };
}

describe.skipIf(!BOOKS)("the books' senses, movement and extra actions", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "senses-movement-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  it("gives Blind Fighting Blindsight, Goggles of Night Darkvision, and Witch Sight Truesight", () => {
    expect(
      sensesOf(fighter(run, ["phb:feature/feat-blind-fighting"]), run)
        .blindsight,
    ).toBe(10);
    expect(
      sensesOf(fighter(run, [], ["dmg:item/goggles-of-night"]), run).darkvision,
    ).toBeGreaterThanOrEqual(60);
    expect(
      sensesOf(fighter(run, ["phb:feature/warlock-witch-sight"]), run)
        .truesight,
    ).toBe(30);
  });

  it("adds Fast Movement's Speed, a Swim Speed from Gift of the Depths, and Thief's Reflexes' second turn", () => {
    // In the fighter's Heavy armor it does nothing; with the armor stowed it adds 10 feet.
    const fast = fighter(run, ["phb:feature/barbarian-fast-movement"]);
    const plain = deriveStats(fighter(run, []), run).speed;
    expect(deriveStats(fast, run).speed).toBe(plain);
    const bare = (actor: Actor): Actor => ({
      ...actor,
      stowed: [...actor.inventory],
    });
    expect(deriveStats(bare(fast), run).speed).toBe(
      deriveStats(bare(fighter(run, [])), run).speed + 10,
    );
    const deep = fighter(run, ["phb:feature/warlock-gift-of-the-depths"]);
    expect(speedsOf(deep, deriveStats(deep, run)).has("swim")).toBe(true);
    expect(
      deriveStats(
        fighter(run, ["phb:feature/rogue-thief-thief-s-reflexes"]),
        run,
      ).passives,
    ).toContainEqual({ kind: "secondTurn", minus: 10 });
  });

  it("plays the PHB's Jump and Daylight as their SRD twins", () => {
    const jump = lookup(run, SpellSchema, "phb:spell/jump");
    expect(jump.automation).toBe("full");
    expect(JSON.stringify(jump.activation)).toContain("jumpBoost");
    const daylight = lookup(run, SpellSchema, "phb:spell/daylight");
    expect(JSON.stringify(daylight.activation)).toContain("disperse");
  });

  it("adds Indomitable Teleport's teleport to Indomitable, Song of Victory's damage, and Aura of Malevolence typed by Dread Allegiance", () => {
    const effectsOf = (actor: Actor, feature: string) =>
      JSON.stringify(
        deriveStats(actor, run).actions.find((item) =>
          item.id.startsWith(`feature:${feature}:`),
        )?.activation.resolution,
      );
    const archer = fighter(run, [
      "phb:feature/fighter-indomitable",
      "arcana-unleashed:feature/fighter-arcane-archer-indomitable-teleport",
    ]);
    expect(effectsOf(archer, "phb:feature/fighter-indomitable")).toContain(
      '{"kind":"teleport","feet":60',
    );
    const singer = fighter(run, [
      "sword-coast-guide:feature/wizard-bladesinging-song-of-victory",
    ]);
    expect(deriveStats(singer, run).passives).toContainEqual(
      expect.objectContaining({ kind: "weaponRider", with: "meleeWeapon" }),
    );
    const allegiance =
      "heroes-of-faerun:feature/rogue-scion-of-the-three-dread-allegiance";
    const bloodthirst =
      "heroes-of-faerun:feature/rogue-scion-of-the-three-bloodthirst";
    const scion = fighter(
      run,
      [
        bloodthirst,
        allegiance,
        "heroes-of-faerun:feature/rogue-scion-of-the-three-aura-of-malevolence",
      ],
      [],
      { [allegiance]: "myrkul" },
    );
    const aura = effectsOf(scion, bloodthirst);
    expect(aura).toContain('"kind":"foesTake"');
    expect(aura).toContain('"type":"necrotic"');
    expect(deriveStats(scion, run).passives).toContainEqual(
      expect.objectContaining({
        kind: "overcomeResistance",
        damage: ["necrotic"],
      }),
    );
  });
});
