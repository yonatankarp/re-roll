import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { type RunContext, createRunContext } from "../engine/run/turn.ts";
import { rollSave } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import type { CharacterBuild } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  frame,
  freshActor,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { scripted, settle } from "./feat-fixtures.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #161's and #163's book entries, on characters given them outright. Skipped where the books aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/phb") &&
  existsSync("books/rules/xanathars-guide");

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "reactions-defence-books-")),
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
  classId = "phb:class/fighter",
  level = 5,
  id = PLAYER_ACTOR,
): Actor {
  const build: CharacterBuild = {
    baseAbilities: { str: 15, dex: 14, con: 13, int: 12, wis: 14, cha: 10 },
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
  return {
    ...freshActor({
      id,
      name: id,
      side: "party",
      source: { kind: "character", build },
      hp: 40,
      inventory: ["srd52:item/longsword"],
    }),
  };
}

const foe = (): Actor => ({
  ...bearer([], "phb:class/fighter", 3, "foe"),
  side: "enemy",
});

const row = (actors: readonly Actor[]): DndState => ({
  actors: Object.fromEntries(
    actors.map((actor, index) => [
      actor.id,
      { ...actor, position: { x: index, y: 0 } },
    ]),
  ),
  combat: {
    encounter: "arena",
    order: actors.map((actor) => actor.id),
    index: 0,
    round: 1,
    grid: { width: 10, height: 3 },
  },
});

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );

describe.skipIf(!BOOKS)("reactions and defences from the books", () => {
  it("rolls Portent's two d20s at a Long Rest and Greater Portent's three", () => {
    const rested = settle(
      run,
      {
        actors: {
          [PLAYER_ACTOR]: bearer(
            [
              "phb:feature/wizard-diviner-portent",
              "phb:feature/wizard-diviner-greater-portent",
            ],
            "phb:class/wizard",
          ),
        },
        combat: null,
      },
      [frame("finishRest", { rest: "long" })],
      scripted([4, 9, 16]).dice,
    );
    expect(payloads(rested.events, "foretold")).toEqual([
      { actor: PLAYER_ACTOR, rolls: [4, 9, 16] },
    ]);
  });

  it("strikes back at a creature beside it that damages it, as Retaliation", () => {
    const berserker = bearer(
      ["phb:feature/barbarian-path-of-the-berserker-retaliation"],
      "phb:class/barbarian",
    );
    const { events } = settle(
      run,
      row([foe(), berserker]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: "weapon:srd52:item/longsword",
          target: PLAYER_ACTOR,
        }),
      ],
      scripted([18, 5, 15]).dice,
    );
    expect(payloads(events, "budgetSpent")).toContainEqual(
      expect.objectContaining({ actor: PLAYER_ACTOR, label: "Retaliation" }),
    );
    expect(
      payloads(events, "rollReported").filter(
        (item) => item.actor === PLAYER_ACTOR,
      ),
    ).toEqual([expect.objectContaining({ against: "foe" })]);
  });

  it("counts Unarmored Defense only without armor", () => {
    const monk = (inventory: readonly string[]) =>
      deriveStats(
        {
          ...bearer(["phb:feature/monk-unarmored-defense"], "phb:class/monk"),
          inventory: [...inventory],
        },
        run,
      ).ac;
    expect(monk([])).toBe(14);
    expect(monk(["srd52:item/chain-mail"])).toBe(16);
  });

  it("gives Danger Sense's Advantage on Dexterity saves, but not while Incapacitated", () => {
    const barbarian = bearer(
      ["phb:feature/barbarian-danger-sense"],
      "phb:class/barbarian",
    );
    const context = {
      state: row([barbarian]),
      content: run.content,
      contentIds: run.contentIds,
    };
    const saved = rollSave(barbarian, "dex", 15, {
      ...context,
      dice: scripted([3, 18]).dice,
    });
    expect(saved.saved).toBe(true);
    const stunned = {
      ...barbarian,
      activeEffects: [
        {
          sourceId: "test",
          casterId: "foe",
          modifier: {
            kind: "condition" as const,
            condition: "incapacitated" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const failed = rollSave(stunned, "dex", 15, {
      ...context,
      dice: scripted([3, 18]).dice,
    });
    expect(failed.saved).toBe(false);
  });

  it("grows Spirit Shield's dice at Barbarian levels 10 and 14", () => {
    const dice = (level: number) =>
      deriveStats(
        bearer(
          [
            "xanathars-guide:feature/barbarian-path-of-the-ancestral-guardian-spirit-shield",
          ],
          "phb:class/barbarian",
          level,
        ),
        run,
      ).actions.find((item) => item.activation.label === "Spirit Shield")
        ?.activation.resolution;
    expect(JSON.stringify(dice(6))).toContain('"2d6"');
    expect(JSON.stringify(dice(10))).toContain('"3d6"');
    expect(JSON.stringify(dice(14))).toContain('"4d6"');
  });
});
