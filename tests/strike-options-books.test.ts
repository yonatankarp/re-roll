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
import {
  type Draft,
  classStep,
  levelEntry,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import type { CharacterBuild } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { sceneSwapActions } from "../plugins/systems/dnd5.5e/core/swap.ts";
import { BOOK_ROOTS } from "./depth.ts";

// Strike options and attack riders left from #157 and #158 (issue #202), on book characters. Skipped where the books
// aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/phb") &&
  existsSync("books/rules/eberron-forge-of-the-artificer") &&
  existsSync("books/rules/xanathars-guide");

let run: RunContext;
let player: Actor;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "strike-options-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "eberron-forge-of-the-artificer",
    "xanathars-guide",
    "heroes-of-faerun",
    "sword-coast-guide",
    "arcana-unleashed",
    "ravenloft-horrors-within",
    "astarions-book",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
  const chosen = step(run, startRun(run, "books").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: "srd52:pregen/fighter",
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const actor = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  player = actor;
});

function baseBuild(): CharacterBuild {
  if (player.source.kind !== "character" || !player.source.build) {
    throw new Error("No build");
  }
  return player.source.build;
}

// The pregen's origin with these class levels, each answering only what's given.
function build(
  classId: string,
  levels: number,
  answers: Record<number, CharacterBuild["levels"][number]["answers"]> = {},
): CharacterBuild {
  return {
    ...baseBuild(),
    levels: Array.from({ length: levels }, (_, index) => ({
      classId,
      hitPointGain: 5,
      answers: answers[index + 1] ?? [],
    })),
  };
}

function actorWith(made: CharacterBuild): Actor {
  return { ...player, source: { kind: "character", build: made } };
}

// Every step of one level-up, answered with `answer` where it names the slot, else the first option.
function levelUp(
  classId: string,
  base: CharacterBuild,
  answer: Record<string, string>,
): { readonly slots: readonly string[]; readonly draft: Draft } {
  let draft: Draft = { classId, scores: [], picks: {} };
  const slots: string[] = [];
  for (
    let next = classStep(draft, base, run);
    next;
    next = classStep(draft, base, run)
  ) {
    slots.push(next.slot ?? next.key);
    const picked =
      answer[next.slot ?? ""] ?? next.options[0]?.id ?? "unanswerable";
    draft = next.apply(draft, picked);
  }
  return { slots, draft };
}

const CLERIC = "phb:class/cleric";
const BLESSED = "phb:feature/cleric-blessed-strikes";

describe.skipIf(!BOOKS)("features with options chosen when gained", () => {
  it("asks Blessed Strikes' option at Cleric 7 and keeps the pick on the level", () => {
    const base = build(CLERIC, 6);
    const { slots, draft } = levelUp(CLERIC, base, {
      [`variant:${BLESSED}`]: "divine-strike",
    });
    expect(slots).toContain(`variant:${BLESSED}`);
    const entry = levelEntry(draft, base, run);
    expect(entry.answers).toContainEqual({
      kind: "variant",
      feature: BLESSED,
      values: ["divine-strike"],
    });
    const stats = deriveStats(
      actorWith({ ...base, levels: [...base.levels, entry] }),
      run,
    );
    expect(stats.passives).toContainEqual(
      expect.objectContaining({
        kind: "extraDamage",
        dice: "1d8",
        types: ["necrotic", "radiant"],
      }),
    );
  });

  it("makes Improved Blessed Strikes follow the earlier pick instead of asking", () => {
    const pick = (value: string) =>
      build(CLERIC, 14, {
        7: [{ kind: "variant", feature: BLESSED, values: [value] }],
      });
    const strikes = (made: CharacterBuild) =>
      deriveStats(actorWith(made), run).passives.filter(
        (passive) => passive.kind === "extraDamage" && passive.dice === "1d8",
      );
    expect(strikes(pick("divine-strike"))).toHaveLength(2);
    expect(strikes(pick("potent-spellcasting"))).toHaveLength(0);
    const riders = deriveStats(
      actorWith(pick("potent-spellcasting")),
      run,
    ).passives.filter((passive) => passive.kind === "cantripRider");
    expect(riders).toHaveLength(2);
    expect(riders[1]).toMatchObject({ selfEffects: [{ kind: "tempHp" }] });
    // Level 14 asks nothing for Improved Blessed Strikes.
    const { slots } = levelUp(CLERIC, build(CLERIC, 13), {});
    expect(slots.some((slot) => slot.startsWith("variant:"))).toBe(false);
  });

  it("swaps Perfected Armor's bigger launcher in for Armor Model's", () => {
    const artificer = "eberron-forge-of-the-artificer:class/artificer";
    const armorer = "eberron-forge-of-the-artificer:subclass/artificer-armorer";
    const model =
      "eberron-forge-of-the-artificer:feature/artificer-armorer-armor-model";
    const launchers = (levels: number) =>
      deriveStats(
        actorWith(
          build(artificer, levels, {
            3: [
              { kind: "subclass", values: [armorer] },
              { kind: "variant", feature: model, values: ["infiltrator"] },
            ],
          }),
        ),
        run,
      ).actions.filter((action) =>
        action.name.endsWith("(Lightning Launcher)"),
      );
    expect(launchers(14).map(({ name }) => name)).toEqual([
      "Armor Model (Infiltrator) (Lightning Launcher)",
    ]);
    expect(launchers(15).map(({ name }) => name)).toEqual([
      "Perfected Armor (Infiltrator) (Lightning Launcher)",
    ]);
  });

  it("offers to change Hunter's Prey between fights after a rest", () => {
    const ranger = "phb:class/ranger";
    const prey = "phb:feature/ranger-hunter-hunter-s-prey";
    const made = build(ranger, 3, {
      3: [
        { kind: "subclass", values: ["phb:subclass/ranger-hunter"] },
        { kind: "variant", feature: prey, values: ["colossus-slayer"] },
      ],
    });
    const state = StateSchema.parse({
      ...StateSchema.parse(startRun(run, "books").state.system),
      actors: { [PLAYER_ACTOR]: actorWith(made) },
      sinceLongRest: 0,
    });
    expect(sceneSwapActions(state, run).map(({ label }) => label)).toEqual([
      "Change a pick of Hunter’s Prey",
    ]);
  });
});
