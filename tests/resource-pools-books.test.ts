import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import {
  type RunContext,
  createRunContext,
  startRun,
  step,
} from "../engine/run/turn.ts";
import { turnInspiration } from "../plugins/systems/dnd5.5e/core/class-rules.ts";
import { initiativeRecharge } from "../plugins/systems/dnd5.5e/core/combat/start.ts";
import {
  FeatureSchema,
  ItemSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { BOOK_ROOTS } from "./depth.ts";

// The book's resource pool, conversion and rest recovery entries (issue #170), on a pregen. Skipped where the books
// aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/phb") &&
  existsSync("books/rules/arcana-unleashed-deadfall") &&
  existsSync("books/rules/eberron-forge-of-the-artificer");

const USED = [
  "arcana-unleashed-deadfall:item/scarlet-spellbook",
  "eberron-forge-of-the-artificer:feature/warforged-sentry-s-rest",
  "phb:feature/barbarian-persistent-rage",
  "phb:feature/bard-font-of-inspiration",
  "phb:feature/bard-superior-inspiration",
  "phb:feature/cleric-channel-divinity",
  "phb:feature/cleric-war-domain-war-god-s-blessing",
  "phb:feature/druid-circle-of-the-land-natural-recovery",
  "phb:feature/druid-wild-resurgence",
  "phb:feature/elf-trance",
  "phb:feature/feat-chef",
  "phb:feature/fighter-battle-master-relentless",
  "phb:feature/fighter-champion-heroic-warrior",
  "phb:feature/fighter-psi-warrior-psionic-power",
  "phb:feature/monk-perfect-focus",
  "phb:feature/monk-uncanny-metabolism",
  "phb:feature/paladin-channel-divinity",
  "phb:feature/rogue-soulknife-psionic-power",
  "phb:feature/sorcerer-font-of-magic",
  "phb:feature/sorcerer-sorcerous-restoration",
  "phb:feature/sorcerer-sorcery-incarnate",
  "phb:feature/warlock-eldritch-master",
  "phb:feature/warlock-magical-cunning",
  "phb:feature/wizard-arcane-recovery",
  "phb:feature/wizard-diviner-expert-divination",
  "phb:feature/wizard-signature-spells",
  "phb:feature/wizard-spell-mastery",
  "srd52:feature/arcane-recovery",
  "srd52:feature/channel-divinity",
];

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "resource-pools-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "arcana-unleashed-deadfall",
    "eberron-forge-of-the-artificer",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
});

// The fighter pregen with these features too.
function fighter(features: readonly string[]): Actor {
  const chosen = step(run, startRun(run, "books").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: "srd52:pregen/fighter",
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const actor = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (actor?.source.kind !== "character" || !actor.source.build) {
    throw new Error("No player");
  }
  const { build } = actor.source;
  const [first, ...rest] = build.levels;
  if (!first) throw new Error("No level");
  return {
    ...actor,
    source: {
      kind: "character",
      build: {
        ...build,
        levels: [
          {
            ...first,
            answers: [
              ...first.answers,
              { kind: "features", values: [...features] },
            ],
          },
          ...rest,
        ],
      },
    },
  };
}

const contextOf = (actor: Actor) => ({
  state: { actors: { [PLAYER_ACTOR]: actor }, combat: null },
  dice: { roll: () => 3, below: () => 0 },
  content: run.content,
  contentIds: run.contentIds,
});

describe.skipIf(!BOOKS)("the book's resource entries", () => {
  it("plays every entry the shipped adventures use", () => {
    for (const id of USED) {
      const entry = id.includes(":item/")
        ? lookup(run, ItemSchema, id)
        : lookup(run, FeatureSchema, id);
      expect([id, "automation" in entry && entry.automation]).not.toEqual([
        id,
        "text",
      ]);
    }
  });

  it("gives Rage back as Initiative is rolled, once a Long Rest, with Persistent Rage", () => {
    const barbarian = fighter([
      "phb:feature/barbarian-rage",
      "phb:feature/barbarian-persistent-rage",
    ]);
    const raged = { ...barbarian, resourcesSpent: { rage: 2 } };
    const events = initiativeRecharge(raged, contextOf(raged));
    expect(events).toContainEqual({
      kind: `${NS}:resourceSpent`,
      payload: { actor: PLAYER_ACTOR, resource: "persistent-rage" },
    });
    const used = {
      ...barbarian,
      resourcesSpent: { rage: 2, "persistent-rage": 1 },
    };
    expect(initiativeRecharge(used, contextOf(used))).toEqual([]);
  });

  it("gives Heroic Inspiration each turn with Heroic Warrior, and a shorter Long Rest with Trance", () => {
    const champion = fighter(["phb:feature/fighter-champion-heroic-warrior"]);
    expect(turnInspiration(champion, contextOf(champion))).toHaveLength(1);
    const elf = fighter(["phb:feature/elf-trance"]);
    expect(deriveStats(elf, run).passives).toContainEqual({
      kind: "restHours",
      hours: 4,
    });
  });

  it("casts War God's Blessing's spells by Channel Divinity", () => {
    const cleric = fighter([
      "phb:feature/cleric-war-domain-war-god-s-blessing",
    ]);
    const free = deriveStats(cleric, run).actions.find(
      (item) => item.id === "spell:phb:spell/shield-of-faith:free",
    );
    expect(free?.activation.cost).toContainEqual({
      resource: "cleric-channel-divinity",
    });
  });
});
