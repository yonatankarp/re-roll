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
import { hasFlag } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  type CharacterBuild,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { swappable } from "../plugins/systems/dnd5.5e/core/swap.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  checkBonus,
  deriveStats,
  lookup,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of the book's check, skill and tool entries (issue #165), on a pregen. Skipped where the books aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/phb") &&
  existsSync("books/rules/dmg") &&
  existsSync("books/rules/arcana-unleashed-deadfall") &&
  existsSync("books/rules/eberron-forge-of-the-artificer") &&
  existsSync("books/rules/ravenloft-horrors-within");

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "ability-check-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "dmg",
    "arcana-unleashed-deadfall",
    "eberron-forge-of-the-artificer",
    "ravenloft-horrors-within",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
});

// The fighter pregen with these features and these items worn, and these answers too.
function fighter(
  features: readonly string[],
  items: readonly string[] = [],
  answers: CharacterBuild["levels"][number]["answers"] = [],
): Actor {
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
              ...answers,
            ],
          },
          ...rest,
        ],
      },
    },
    inventory: [...actor.inventory, ...items],
  };
}

describe.skipIf(!BOOKS)("the book's check entries", () => {
  it("adds half proficiency with Jack of All Trades", () => {
    const jack = fighter(["phb:feature/bard-jack-of-all-trades"]);
    const plain = fighter([]);
    const arcana = { ability: "int", skill: "arcana" } as const;
    expect(
      checkBonus(deriveStats(jack, run), jack, arcana) -
        checkBonus(deriveStats(plain, run), plain, arcana),
    ).toBe(1);
  });

  it("gives Advantage on Perception with Eyes of the Eagle", () => {
    const eyes = fighter([], ["dmg:item/eyes-of-the-eagle"]);
    const flag = (actor: Actor) =>
      hasFlag(
        actor,
        "advantage",
        "checks",
        deriveStats(actor, run),
        "wis",
        undefined,
        undefined,
        "perception",
      );
    expect(flag(eyes)).toBe(true);
    expect(flag(fighter([]))).toBe(false);
  });

  it("adds +5 to Deception with Eyes of Deceit", () => {
    const context = (actor: Actor) => ({
      state: { actors: { [PLAYER_ACTOR]: actor }, combat: null },
      dice: { roll: () => 10, below: () => 0 },
      content: run.content,
      contentIds: run.contentIds,
    });
    const total = (actor: Actor) => {
      const result = run.system.resolveCheck(
        { skill: "deception", dc: 30 },
        context(actor),
      );
      const report = (result.events ?? []).find(
        (event) => event.kind === `${NS}:rollReported`,
      ) as { payload: { total: number } } | undefined;
      return report?.payload.total ?? 0;
    };
    expect(
      total(fighter([], ["arcana-unleashed-deadfall:item/eyes-of-deceit"])) -
        total(fighter([])),
    ).toBe(5);
  });

  it("rolls a Greater Mark's d6 for its Mark's d4", () => {
    const mark =
      "eberron-forge-of-the-artificer:feature/feat-mark-of-detection";
    const greater =
      "eberron-forge-of-the-artificer:feature/feat-greater-mark-of-detection";
    expect(
      deriveStats(fighter([mark]), run).scaling.intuitionDie,
    ).toBeUndefined();
    expect(
      deriveStats(fighter([mark, greater]), run).scaling.intuitionDie,
    ).toBe(6);
  });

  it("still plays an Echoing Soul taken before its Expertise pick existed", () => {
    const feat = "ravenloft-horrors-within:feat/echoing-soul";
    const older = fighter(
      [],
      [],
      [
        { kind: "feats", values: [feat] },
        { kind: "skills", values: ["arcana", "history"], feat },
      ],
    );
    const stats = deriveStats(older, run);
    expect(stats.skills).toEqual(expect.arrayContaining(["arcana", "history"]));
    expect(stats.expertise).toEqual([]);
    // The pregen's own class picks, as its Weapon Mastery, stay swappable; the feat offers no late pick.
    expect(
      swappable(older, run).filter(({ classId }) => classId === undefined),
    ).toEqual([]);
  });

  it("lets Guidance's caster pick the skill", () => {
    const guidance = lookup(run, SpellSchema, "phb:spell/guidance");
    const resolution = guidance.activation?.resolution;
    const [effect] = resolution?.kind === "automatic" ? resolution.effects : [];
    expect(effect?.kind === "modifier" ? effect.pick : undefined).toContain(
      "stealth",
    );
  });
});
