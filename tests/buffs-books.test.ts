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
import {
  dealEvents,
  leafEvents,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  type CharacterBuild,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  applyDndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { scripted } from "./feat-fixtures.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #160's book entries, on characters given them outright. Skipped where the books aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/phb") &&
  existsSync("books/rules/xanathars-guide");

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "buffs-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "xanathars-guide",
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

const effectsOf = (id: string) => {
  const resolution = SpellSchema.parse(run.content(id)).activation?.resolution;
  return resolution?.kind === "automatic" ? resolution.effects : [];
};
const kindsOf = (id: string) =>
  effectsOf(id).map((item) =>
    item.kind === "modifier" ? item.modifier : null,
  );

describe.skipIf(!BOOKS)("buff and debuff spells from the books", () => {
  it("Heroism gives Temporary Hit Points as each turn starts, and Mage Armor holds only without armor", () => {
    expect(kindsOf("phb:spell/heroism").map((item) => item?.kind)).toContain(
      "turnTempHp",
    );
    expect(kindsOf("phb:spell/mage-armor")[0]).toMatchObject({
      unarmored: true,
    });
  });

  it("Warding Bond's damage reaches its caster", () => {
    const ally = bearer([], "phb:class/fighter", 3, "ally");
    const caster = { ...bearer([]), position: { x: 0, y: 0 } };
    const target = { ...ally, position: { x: 1, y: 0 } };
    const state: DndState = {
      actors: { [PLAYER_ACTOR]: caster, ally: target },
      combat: {
        encounter: "arena",
        order: [PLAYER_ACTOR, "ally"],
        index: 0,
        round: 1,
        grid: { width: 5, height: 3 },
      },
    };
    const context = {
      state,
      dice: scripted([]).dice,
      content: run.content,
      contentIds: run.contentIds,
    };
    const bonded = leafEvents(
      effectsOf("phb:spell/warding-bond"),
      "spell:phb:spell/warding-bond",
      caster,
      target,
      context,
    ).reduce(applyDndEvent, state);
    const dealt = dealEvents(
      bonded.actors.ally ?? target,
      [{ amount: 8, type: "fire" }],
      false,
      { ...context, state: bonded },
    );
    // The caster takes what the ally took (dealt damage has its Resistance applied already).
    expect(
      dealt.events.filter((event) => event.kind === "dnd5.5e:damaged"),
    ).toMatchObject([
      { payload: { actor: "ally", amount: 8 } },
      { payload: { actor: PLAYER_ACTOR, amount: 8 } },
    ]);
  });
});
