import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { levelChoices } from "../plugins/systems/dnd5.5e/core/character.ts";
import { ClassSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { BOOK_ROOTS } from "./depth.ts";

// SRD copies of entries the Player's Handbook plays (issue #169). The SRD entry holds the encoding, and the book's
// copy plays as it, so both take later mechanics work at once.
const TWINS: readonly (readonly [srd: string, phb: string])[] = [
  ["srd52:feature/uncanny-dodge", "phb:feature/rogue-uncanny-dodge"],
  [
    "srd52:feature/second-story-work",
    "phb:feature/rogue-thief-second-story-work",
  ],
  ["srd52:feature/alert", "phb:feature/feat-alert"],
  ["srd52:feature/savage-attacker", "phb:feature/feat-savage-attacker"],
  ["srd52:feature/cunning-action", "phb:feature/rogue-cunning-action"],
  ["srd52:feature/steady-aim", "phb:feature/rogue-steady-aim"],
  ["srd52:feature/fast-hands", "phb:feature/rogue-thief-fast-hands"],
  ...[
    "bane",
    "chain-lightning",
    "darkvision",
    "expeditious-retreat",
    "feather-fall",
    "fire-storm",
    "hellish-rebuke",
    "lesser-restoration",
    "longstrider",
    "meteor-swarm",
    "mirror-image",
    "misty-step",
    "power-word-heal",
    "power-word-kill",
    "see-invisibility",
    "spare-the-dying",
    "aid",
    "conjure-minor-elementals",
    "dispel-magic",
    "false-life",
    "greater-restoration",
    "heal",
    "magic-weapon",
    "vitriolic-sphere",
    // terrain, walls and areas (#159)
    "antilife-shell",
    "antimagic-field",
    "blade-barrier",
    "conjure-elemental",
    "earthquake",
    "entangle",
    "forcecage",
    "grease",
    "gust-of-wind",
    "ice-storm",
    "incendiary-cloud",
    "insect-plague",
    "plant-growth",
    "prismatic-wall",
    "reverse-gravity",
    "sleet-storm",
    "spike-growth",
    "spirit-guardians",
    "wall-of-fire",
    "wall-of-force",
    "wall-of-ice",
    "wall-of-stone",
    "wall-of-thorns",
    "web",
    "wind-wall",
    // spells moved or reused on later turns (#154), and cast over several turns (#205)
    "call-lightning",
    "conjure-animals",
    "conjure-celestial",
    "conjure-fey",
    "conjure-woodland-beings",
    "delayed-blast-fireball",
    "flame-blade",
    "flaming-sphere",
    "heat-metal",
    "hex",
    "hunter-s-mark",
    "moonbeam",
    "spiritual-weapon",
    "storm-of-vengeance",
    "sunbeam",
    "telekinesis",
    "vampiric-touch",
    "tsunami",
  ].map((name) => [`srd52:spell/${name}`, `phb:spell/${name}`] as const),
  ["srd52:spell/black-tentacles", "phb:spell/evard-s-black-tentacles"],
  ["srd52:spell/arcane-hand", "phb:spell/bigby-s-hand"],
  ["srd52:spell/arcane-sword", "phb:spell/mordenkainen-s-sword"],
  ["srd52:spell/freezing-sphere", "phb:spell/otiluke-s-freezing-sphere"],
];

// These play from the grant itself (`levelChoices`), so there is no encoding to share.
const BY_GRANT: readonly (readonly [
  cls: string,
  level: number,
  choice: string,
])[] = [
  ["fighter", 1, "fighting-style"],
  ["fighter", 3, "subclass"],
  ["fighter", 4, "feat"],
  ["rogue", 3, "subclass"],
  ["cleric", 3, "subclass"],
  ["wizard", 3, "subclass"],
];

const ENCODING = [
  "automation",
  "activation",
  "upcast",
  "outOfCombat",
  "passives",
  "activations",
  "resources",
] as const;
const encodingOf = (entry: unknown): Record<string, unknown> =>
  Object.fromEntries(
    ENCODING.map((key) => [key, (entry as Record<string, unknown>)[key]]),
  );

describe("SRD copies", () => {
  it("play their encoding in the shipped adventures", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    for (const [srd] of TWINS) {
      expect(run.content(srd), srd).toMatchObject({ automation: "full" });
    }
    for (const [cls, level, choice] of BY_GRANT) {
      const classDef = ClassSchema.parse(run.content(`srd52:class/${cls}`));
      const ids = levelChoices(classDef, level, undefined, run).map(
        (item) => item.id,
      );
      expect(ids, `${cls} ${String(level)}`).toContain(choice);
    }
  });

  it.skipIf(!(BOOK_ROOTS && existsSync("books/rules/phb")))(
    "share one encoding with the book's copies, which keep their own lists",
    async () => {
      const storage = await createPlayStorage(
        process.cwd(),
        await mkdtemp(join(tmpdir(), "srd-twins-")),
      );
      const loaded = await loadRun(
        storage,
        await scanPlugins(storage, ["plugins", "books"]),
        systems,
        ["goblin-ambush", "phb"],
      );
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
      const { registry } = loaded;
      for (const [srd, phb] of TWINS) {
        const book = registry.content(phb);
        expect(book, phb).toMatchObject({ id: phb, playsAs: srd });
        expect(encodingOf(book), phb).toEqual(
          encodingOf(registry.content(srd)),
        );
      }
      expect(registry.content("phb:spell/bane")).toMatchObject({
        classes: expect.arrayContaining(["phb:class/bard"]) as unknown,
      });
    },
  );
});
