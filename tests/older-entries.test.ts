import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import {
  backgroundIncreaseStep,
  choiceOptions,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  ABILITIES,
  ClassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { type Actor, NS } from "../plugins/systems/dnd5.5e/core/state.ts";
import { formsFor } from "../plugins/systems/dnd5.5e/core/forms.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { hero, scripted, settle, testRun } from "./feat-fixtures.ts";

// #182's older books' entries that play: their backgrounds, and Savage Attacks' Critical Hit. Ids and mechanics only.
describe("older books' entries (#182)", () => {
  it("raises any two abilities, or any three by 1, for a background listing all six", async () => {
    const run = await testRun();
    const fighter = lookup(run, ClassSchema, "srd52:class/fighter");
    const ids = backgroundIncreaseStep(ABILITIES, fighter).options.map(
      (item) => item.id,
    );
    // 30 ordered pairs and 20 triples: never +1 to all six.
    expect(ids).toHaveLength(50);
    expect(
      backgroundIncreaseStep(["str", "dex", "con"], fighter).options,
    ).toHaveLength(7);
  });

  it("asks an older background for an Origin feat, which reaches the character", async () => {
    const run = await testRun();
    const fighter = lookup(run, ClassSchema, "srd52:class/fighter");
    const draft = { picks: {}, backgroundId: "test:background/older" };
    const { options, prefer } = choiceOptions(
      { kind: "feat", id: "background-feat", category: "origin" },
      draft as never,
      null,
      fighter,
      run,
    );
    expect(options.map((item) => item.id)).toContain("test:feat/steady");
    // No feat of its own to put first.
    expect(prefer ?? []).toEqual([]);
    const stats = deriveStats(
      hero([], {
        background: "test:background/older",
        answers: [{ kind: "feats", values: ["test:feat/steady"] }],
      }),
      run,
    );
    expect(stats.features).toContain("test:feature/savage");
  });

  it("offers an onCritical after-hit option only on a Critical Hit", async () => {
    const run = await testRun();
    const foe: Actor = {
      ...hero([], { id: "foe" }),
      side: "enemy",
      position: { x: 1, y: 0 },
    };
    const attacker = { ...hero(["crit-die"]), position: { x: 0, y: 0 } };
    const offered = (critical: boolean) =>
      settle(
        run,
        [attacker, foe],
        [
          {
            kind: `${NS}:afterHit`,
            payload: {
              attacker: PLAYER_ACTOR,
              actionId: "weapon:srd52:item/longsword",
              target: "foe",
              critical,
            },
          },
        ],
        scripted([]).dice,
      ).decisions.some((item) => item.id.startsWith(`${NS}:afterHit:`));
    expect(offered(true)).toBe(true);
    expect(offered(false)).toBe(false);
  });

  it("turns its pilot only into the stat blocks it names, with no Challenge Rating, as the Apparatus of Kwalish", async () => {
    const run = await testRun();
    const barrel = {
      id: "test:monster/barrel",
      name: "Barrel",
      ac: 20,
      hp: 200,
      speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      proficiency: 0,
      initiative: 0,
      actions: [],
    };
    const access = {
      ...run,
      content: (id: string) => (id === barrel.id ? barrel : run.content(id)),
    };
    const forms = formsFor({ forms: { ids: [barrel.id] } }, hero([]), access);
    expect(forms.map((item) => [item.id, item.hp])).toEqual([[barrel.id, 200]]);
  });
});
