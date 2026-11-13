import { PLAYER_ACTOR, type Decision } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { GameState } from "../engine/kernel/events.ts";
import { createSave, loadSave, type LogEntry } from "../engine/run/save.ts";
import { type RunContext, startRun, step } from "../engine/run/turn.ts";
import {
  ACCEPT,
  BUILD_YOURSELF,
  NEXT,
  POINT_BUY_BUDGET,
  READY_PREFIX,
  type Sheet,
  SheetStepSchema,
  completeDraft,
  encodeScores,
  pointsSpent,
  recommendedScores,
} from "../plugins/systems/dnd5.5e/core/character-sheet.ts";
import {
  type Draft,
  classStep,
  namedContent,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  BackgroundSchema,
  ClassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  StateSchema,
  type Actor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { sheetCreation as creation } from "../plugins/systems/dnd5.5e/ui/creation-sheet.ts";

interface Played {
  readonly run: RunContext;
  readonly state: GameState;
  readonly pending: Decision | null;
  readonly log: readonly LogEntry[];
}

async function goblin() {
  return loadAdventure("goblin-ambush");
}

// Answers in order, each to whatever decision is waiting.
function play(run: RunContext, answers: readonly string[]): Played {
  const started = startRun(run, "sheet");
  const log: LogEntry[] = [
    { input: { kind: "start" }, events: started.events },
  ];
  let { state, pending } = started;
  for (const optionId of answers) {
    if (!pending) throw new Error(`Nothing waits for ${optionId}`);
    const input = {
      kind: "answer" as const,
      decisionId: pending.id,
      optionId,
    };
    const outcome = step(run, state, input);
    if (!outcome.ok) throw new Error(`${optionId}: ${outcome.error}`);
    log.push({ input, events: outcome.events });
    ({ state, pending } = outcome);
  }
  return { run, state, pending, log };
}

function sheetOf(played: Played): Sheet {
  return SheetStepSchema.parse(played.pending?.resume.payload).sheet;
}

function player(state: GameState): Actor {
  const actor = StateSchema.parse(state.system).actors[PLAYER_ACTOR];
  if (actor?.source.kind !== "character" || !actor.source.build) {
    throw new Error("The player has no character yet");
  }
  return actor;
}

// The draft as the step engine itself would take it: every pick among what its step offers.
function expectSound(draft: Draft, run: RunContext): void {
  let walked: Draft = { ...draft, picks: {} };
  for (
    let next = classStep(walked, null, run);
    next;
    next = classStep(walked, null, run)
  ) {
    const slot = next.slot ?? "";
    const pick = draft.picks[slot]?.[walked.picks[slot]?.length ?? 0];
    expect(next.options.map((option) => option.id)).toContain(pick);
    walked = next.apply(walked, pick ?? "");
  }
  expect(walked.picks).toEqual(draft.picks);
}

describe("the character sheet", () => {
  it("offers a ready hero of every class after the adventure's own heroes", async () => {
    const { run } = await goblin();
    const first = startRun(run, "doors").pending;
    const ids = first?.options.map((option) => option.id) ?? [];
    expect(ids[0]).toMatch(/:pregen\//);
    const classes = namedContent(run, "class", ClassSchema);
    expect(ids.filter((id) => id.startsWith(READY_PREFIX))).toHaveLength(
      classes.length,
    );
    expect(ids).toContain(BUILD_YOURSELF);
  });

  it("builds a sound, recommended character of every class in one click", async () => {
    const { run, registry } = await goblin();
    for (const classDef of namedContent(run, "class", ClassSchema)) {
      const ready = play(run, [`${READY_PREFIX}${classDef.id}`]);
      const sheet = sheetOf(ready);
      expect(sheet.at).toBe("review");
      expectSound(sheet.draft, run);
      // Its scores put the standard array's best where the class needs it.
      const best = classDef.primaryAbilities.map(
        (ability) => sheet.draft.base?.[ability] ?? 0,
      );
      expect(Math.max(...best)).toBe(15);

      const done = play(run, [`${READY_PREFIX}${classDef.id}`, ACCEPT]);
      const hero = player(done.state);
      expect(hero.inventory.length).toBeGreaterThan(0);
      if (hero.source.kind !== "character" || !hero.source.build) continue;
      expect(hero.source.build.baseAbilities).toEqual(sheet.draft.base);
      expect(hero.source.build.levels[0]?.classId).toBe(classDef.id);

      const save = createSave(registry, "goblin-ambush", "sheet", done.log);
      const loaded = loadSave(JSON.stringify(save), registry, run);
      if (!loaded.ok) throw new Error(loaded.error);
      expect(loaded.state).toEqual(done.state);
    }
  });

  it("raises the class's own abilities with the recommended background", async () => {
    const { run } = await goblin();
    const wizard = play(run, [`${READY_PREFIX}srd52:class/wizard`]);
    const { draft } = sheetOf(wizard);
    const background = lookup(run, BackgroundSchema, draft.backgroundId ?? "");
    expect(background.abilities).toContain("int");
    expect(draft.increase).toMatch(/^int:2/);
  });

  it("walks every part with Next alone and ends on the review", async () => {
    const { run } = await goblin();
    const steps = [BUILD_YOURSELF, NEXT, NEXT, NEXT, NEXT, NEXT, NEXT];
    const walked = play(run, steps);
    expect(sheetOf(walked).at).toBe("review");
    expect(walked.pending?.options.map((option) => option.id)).toEqual([
      ACCEPT,
    ]);
    const done = play(run, [...steps, ACCEPT]);
    expect(player(done.state).name).toBe("Bruni Ironhold");
  });

  it("keeps the class's picks when the species changes, and returns to review on Change", async () => {
    const { run } = await goblin();
    const before = sheetOf(play(run, [`${READY_PREFIX}srd52:class/rogue`]));
    const after = play(run, [
      `${READY_PREFIX}srd52:class/rogue`,
      "at:species",
      "species:srd52:species/dwarf",
      "at:review",
    ]);
    const sheet = sheetOf(after);
    expect(sheet.at).toBe("review");
    expect(sheet.draft.speciesId).toBe("srd52:species/dwarf");
    const classSkills = Object.entries(before.draft.picks).filter(
      ([slot]) => !slot.startsWith("species-"),
    );
    for (const [slot, picks] of classSkills) {
      expect(sheet.draft.picks[slot]).toEqual(picks);
    }
  });

  it("takes picked skills and fills the rest", async () => {
    const { run } = await goblin();
    const ready = sheetOf(play(run, [`${READY_PREFIX}srd52:class/fighter`]));
    const slot = Object.keys(ready.draft.picks).find((key) =>
      key.endsWith("skills"),
    );
    if (!slot) throw new Error("A fighter picks skills");
    // A skill the recommendation passed over.
    const steps = classStep({ ...ready.draft, picks: {} }, null, run);
    const other = steps?.options.find(
      (option) => !ready.draft.picks[slot]?.includes(option.id),
    )?.id;
    const picked = sheetOf(
      play(run, [
        `${READY_PREFIX}srd52:class/fighter`,
        `pick:${slot}=${other ?? ""}`,
      ]),
    );
    expect(picked.draft.picks[slot]?.[0]).toBe(other);
    expect(picked.draft.picks[slot]).toHaveLength(
      ready.draft.picks[slot]?.length ?? 0,
    );
    expectSound(picked.draft, run);
  });

  it("allows point-buy within the budget only", async () => {
    const { run } = await goblin();
    const start = [`${READY_PREFIX}srd52:class/fighter`, "method:pointBuy"];
    const switched = sheetOf(play(run, start));
    expect(switched.method).toBe("pointBuy");
    expect(
      pointsSpent(
        switched.draft.base ??
          recommendedScores(lookup(run, ClassSchema, "srd52:class/fighter")),
      ),
    ).toBe(POINT_BUY_BUDGET);

    const even = { str: 13, dex: 13, con: 13, int: 12, wis: 12, cha: 12 };
    const fits = sheetOf(play(run, [...start, `scores:${encodeScores(even)}`]));
    expect(fits.draft.base).toEqual(even);

    const greedy = { str: 15, dex: 15, con: 15, int: 15, wis: 8, cha: 8 };
    const over = sheetOf(
      play(run, [...start, `scores:${encodeScores(greedy)}`]),
    );
    expect(over.draft.base).toEqual(switched.draft.base);

    // The standard array allows only its own six values.
    const standard = sheetOf(
      play(run, [
        `${READY_PREFIX}srd52:class/fighter`,
        `scores:${encodeScores(even)}`,
      ]),
    );
    expect(standard.draft.base).not.toEqual(even);
  });

  it("ignores a change the rules don't allow", async () => {
    const { run } = await goblin();
    const ready = sheetOf(play(run, [`${READY_PREFIX}srd52:class/cleric`]));
    for (const bad of [
      "species:srd52:class/wizard",
      "class:nowhere",
      "at:nowhere",
      "scores:str=99",
      "pick:nowhere",
      "nonsense",
    ]) {
      const after = sheetOf(
        play(run, [`${READY_PREFIX}srd52:class/cleric`, bad]),
      );
      expect(after).toEqual(ready);
    }
  });

  it("names the hero as typed", async () => {
    const { run } = await goblin();
    const done = play(run, [
      `${READY_PREFIX}srd52:class/rogue`,
      "name:Ilyra Moonwhisper",
      ACCEPT,
    ]);
    expect(player(done.state).name).toBe("Ilyra Moonwhisper");
  });

  it("is idempotent: a complete draft stays as it is", async () => {
    const { run } = await goblin();
    for (const classDef of namedContent(run, "class", ClassSchema)) {
      const { draft, method } = sheetOf(
        play(run, [`${READY_PREFIX}${classDef.id}`]),
      );
      expect(completeDraft(draft, method, run)).toEqual(draft);
    }
  });

  it("draws the sheet with a live card", async () => {
    const { run } = await goblin();
    const ready = play(run, [`${READY_PREFIX}srd52:class/wizard`]);
    if (!ready.pending) throw new Error("The sheet waits");
    const view = creation(ready.pending, ready.state.system, run);
    const card = view && "card" in view ? view.card : undefined;
    expect(card?.title).toBe("Edric Quill");
    expect(card?.numbers.map((stat) => stat.label)).toContain("HP");
    expect(card?.subtitle).toMatch(/^Level 1 Human Wizard · /);
  });
});
