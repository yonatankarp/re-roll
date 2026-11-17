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
import { tradesOf } from "../plugins/systems/dnd5.5e/core/combat/trade.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of the books' extra action, Bonus Action and movement entries (issue #171), on a pregen. Skipped where
// the books aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/phb") &&
  existsSync("books/rules/eberron-forge-of-the-artificer") &&
  existsSync("books/rules/lorwyn-first-light");

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "combat-extras-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "eberron-forge-of-the-artificer",
    "lorwyn-first-light",
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

const stats = (features: readonly string[]) =>
  deriveStats(fighter(features), run);
const named = (features: readonly string[], name: string) =>
  stats(features).actions.find((action) => action.name === name);

describe.skipIf(!BOOKS)("the books' extra action and movement entries", () => {
  it("dashes, disengages or hides as a Bonus Action with Cunning Action", () => {
    expect(stats(["phb:feature/rogue-cunning-action"]).passives).toContainEqual(
      {
        kind: "bonusTactics",
        tactics: ["dash", "disengage", "hide"],
      },
    );
  });

  it("moves half the Speed without provoking with Second Wind, through Tactical Shift", () => {
    const wind = "phb:feature/fighter-second-wind";
    const effects = (features: readonly string[]) => {
      const resolution = stats(features).actions.find((action) =>
        action.id.startsWith(`feature:${wind}:`),
      )?.activation.resolution;
      return resolution?.kind === "automatic"
        ? resolution.effects.map(({ kind }) => kind)
        : [];
    };
    expect(effects([wind, "phb:feature/fighter-tactical-shift"])).toEqual([
      "heal",
      "dash",
    ]);
    expect(effects([wind])).toEqual(["heal"]);
  });

  it("gives the Monk's Focus versions of Patient Defense and Step of the Wind", () => {
    const focus = "phb:feature/monk-monk-s-focus";
    expect(
      named([focus], "Monk’s Focus (Step of the Wind)")?.activation.resolution,
    ).toMatchObject({
      effects: [{ kind: "disengage" }, { kind: "dash" }],
    });
    expect(
      named([focus], "Monk’s Focus (Patient Defense)")?.activation.resolution,
    ).toMatchObject({
      effects: [{ kind: "disengage" }, { kind: "dodge" }],
    });
  });

  it("attacks twice with an artificer's Extra Attack, and trades an attack for Breath Weapon", () => {
    expect(
      stats([
        "eberron-forge-of-the-artificer:feature/artificer-armorer-extra-attack",
      ]).multiattack,
    ).toBe(2);
    expect(tradesOf(stats(["phb:feature/dragonborn-breath-weapon"]))).toEqual([
      { kind: "attackReplacement", attacks: 1, resource: "breath-weapon" },
    ]);
  });

  it("makes a weapon attack as a Bonus Action with War Priest, and moves on Initiative as a changeling", () => {
    expect(
      named(["phb:feature/cleric-war-domain-war-priest"], "War Priest")
        ?.activation,
    ).toMatchObject({
      cost: ["bonusAction", { resource: "war-priest" }],
      resolution: { effects: [{ kind: "weaponAttack" }] },
    });
    expect(
      named(
        ["lorwyn-first-light:feature/lorwyn-changeling-unpredictable-movement"],
        "Unpredictable Movement",
      )?.activation.trigger,
    ).toEqual({ initiative: true });
  });
});
