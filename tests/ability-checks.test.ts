import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { tacticOptions } from "../plugins/systems/dnd5.5e/core/actions.ts";
import {
  focusFrame,
  withFocus,
} from "../plugins/systems/dnd5.5e/core/combat/check-choice.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { rollSave } from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  SpellSchema,
  type Skill,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  checkBonus,
  deriveStats,
  lookup,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  type Answers,
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// Made-up features and items for the check pieces: ids and mechanics only.
const advantageOn = (skills: readonly Skill[]) => ({
  kind: "modifier",
  modifier: { kind: "advantage", on: "checks", skills },
});
const FIXTURES = [
  trait("athlete", [advantageOn(["athletics"])]),
  trait("reliable", [
    {
      kind: "modifier",
      modifier: { kind: "checkFloor", value: 10, proficient: true },
    },
  ]),
  trait("jack", [{ kind: "halfProficiency" }]),
  trait("mighty", [{ kind: "scoreFloor", ability: "str" }]),
  trait(
    "tactician",
    [{ kind: "checkRescue", bonusDice: "1d10", resource: "wind", keep: true }],
    { resources: [{ id: "wind", max: { base: 1 }, recharge: [] }] },
  ),
  trait(
    "assessor",
    [
      {
        kind: "checkRescue",
        bonusDice: "1d8",
        dieSize: "testDie",
        resource: "dice",
        skills: ["stealth"],
      },
    ],
    { resources: [{ id: "dice", max: { base: 2 }, recharge: [] }] },
  ),
  trait("glamour", [
    {
      kind: "modifier",
      modifier: {
        kind: "bonus",
        to: "checks",
        ability: "cha",
        amount: {
          bonus: {
            base: 0,
            add: [{ kind: "abilityMod", ability: "wis" }],
            min: 1,
          },
        },
      },
    },
  ]),
  trait("intuition", [
    {
      kind: "modifier",
      modifier: {
        kind: "bonus",
        to: "checks",
        skill: "stealth",
        amount: { dice: "1d4", dieSize: "intuitionDie" },
      },
    },
  ]),
  trait("greater", [{ kind: "scalingFloor", key: "intuitionDie", value: 6 }]),
  trait("studious", [{ kind: "bonusTactics", tactics: ["study"] }]),
  {
    id: "test:item/lenses",
    name: "Lenses",
    type: "magicItem",
    category: "wondrousItem",
    rarity: "uncommon",
    attunement: false,
    text: "Test.",
    automation: "full",
    passives: [advantageOn(["perception"])],
  },
];

async function checkRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

// A scene's check, out of a fight, by the player's character.
function sceneCheck(
  run: RunContext,
  actor: Actor,
  check: { skill: Skill; dc: number } | { ability: "str"; dc: number },
  dice: Dice,
) {
  const context = { ...contextOf(run, [actor], dice) };
  const state: DndState = { ...context.state, combat: null };
  const result = run.system.resolveCheck(check, { ...context, state });
  const events = result.events ?? [];
  const report = events.find((event) => event.kind === `${NS}:rollReported`) as
    { payload: { natural: number; total: number } } | undefined;
  return {
    outcome: result.outcome,
    total: report?.payload.total,
    spent: spentOf(events),
  };
}

const spentOf = (events: readonly SystemEvent[]) =>
  events.flatMap((event) =>
    event.kind === `${NS}:resourceSpent` && "payload" in event
      ? [(event.payload as { resource: string }).resource]
      : [],
  );

// The test hero has Strength 17, Dexterity 14, Wisdom 12 and Charisma 10, Proficiency Bonus 2, and is proficient
// in Athletics and Survival.
describe("ability checks", () => {
  it("gives Advantage on checks with one skill only, as Remarkable Athlete's Athletics", async () => {
    const run = await checkRun();
    const athlete = hero(["athlete"]);
    const athletics = { skill: "athletics", dc: 15 } as const;
    expect(
      sceneCheck(run, athlete, athletics, scripted([5, 15]).dice).total,
    ).toBe(20);
    expect(
      sceneCheck(run, hero([]), athletics, scripted([5, 15]).dice).total,
    ).toBe(10);
    const stealth = { skill: "stealth", dc: 15 } as const;
    expect(
      sceneCheck(run, athlete, stealth, scripted([5, 15]).dice).total,
    ).toBe(7);
  });

  it("counts a low d20 as a floor on proficient checks only, as Reliable Talent", async () => {
    const run = await checkRun();
    const reliable = hero(["reliable"]);
    const roll = (skill: Skill) =>
      sceneCheck(run, reliable, { skill, dc: 10 }, scripted([3]).dice).total;
    expect(roll("athletics")).toBe(15);
    expect(roll("stealth")).toBe(5);
  });

  it("adds half the Proficiency Bonus to skills it lacks, on the sheet too, as Jack of All Trades", async () => {
    const run = await checkRun();
    const jack = hero(["jack"]);
    const stats = deriveStats(jack, run);
    expect(checkBonus(stats, jack, { ability: "dex", skill: "stealth" })).toBe(
      3,
    );
    expect(
      checkBonus(stats, jack, { ability: "str", skill: "athletics" }),
    ).toBe(5);
    expect(checkBonus(stats, jack, { ability: "dex" })).toBe(2);
  });

  it("totals at least the Strength score on Strength checks and saves, as Indomitable Might", async () => {
    const run = await checkRun();
    const mighty = hero(["mighty"]);
    const check = { ability: "str", dc: 16 } as const;
    expect(sceneCheck(run, mighty, check, scripted([1]).dice)).toMatchObject({
      outcome: "success",
      total: 17,
    });
    const save = rollSave(
      mighty,
      "str",
      16,
      contextOf(run, [mighty], scripted([1]).dice),
    );
    expect(save.saved).toBe(true);
  });

  it("keeps a rescue's use when the check still fails, as Tactical Mind's Second Wind", async () => {
    const run = await checkRun();
    const athletics = { skill: "athletics", dc: 15 } as const;
    const failed = sceneCheck(
      run,
      hero(["tactician"]),
      athletics,
      scripted([3, 2]).dice,
    );
    expect(failed).toMatchObject({ outcome: "failure", total: 10, spent: [] });
    const saved = sceneCheck(
      run,
      hero(["tactician"]),
      athletics,
      scripted([3, 8]).dice,
    );
    expect(saved).toMatchObject({
      outcome: "success",
      total: 16,
      spent: ["wind"],
    });
  });

  it("limits a rescue to some skills and sizes its die from a scaling key, as Tactical Assessment", async () => {
    const run = await checkRun();
    const assessor = hero(["assessor"]);
    const { dice, counts } = scripted([3, 8]);
    const stealth = sceneCheck(
      run,
      assessor,
      { skill: "stealth", dc: 12 },
      dice,
    );
    expect(stealth).toMatchObject({ outcome: "success", spent: ["dice"] });
    expect(counts[8]).toBe(1);
    const athletics = sceneCheck(
      run,
      assessor,
      { skill: "athletics", dc: 15 },
      scripted([3, 8]).dice,
    );
    expect(athletics).toMatchObject({ outcome: "failure", spent: [] });
  });

  it("adds a bonus to checks with one ability, as Otherworldly Glamour's Wisdom on Charisma checks", async () => {
    const run = await checkRun();
    const persuade = { skill: "persuasion", dc: 20 } as const;
    expect(
      sceneCheck(run, hero(["glamour"]), persuade, scripted([10]).dice).total,
    ).toBe(11);
    const climb = { skill: "athletics", dc: 20 } as const;
    expect(
      sceneCheck(run, hero(["glamour"]), climb, scripted([10]).dice).total,
    ).toBe(15);
  });

  it("rolls a bigger die once a scaling key is raised, as a Greater Mark's 1d6", async () => {
    const run = await checkRun();
    const stealth = { skill: "stealth", dc: 30 } as const;
    const mark = scripted([10]);
    sceneCheck(run, hero(["intuition"]), stealth, mark.dice);
    expect(mark.counts).toMatchObject({ 4: 1 });
    const greater = scripted([10]);
    sceneCheck(run, hero(["intuition", "greater"]), stealth, greater.dice);
    expect(greater.counts[6]).toBe(1);
    expect(greater.counts[4]).toBeUndefined();
  });

  it("gives a worn magic item's passives, as Eyes of the Eagle's Advantage on Perception", async () => {
    const run = await checkRun();
    const wearing = { ...hero([]), inventory: ["test:item/lenses"] };
    const perception = { skill: "perception", dc: 15 } as const;
    expect(
      sceneCheck(run, wearing, perception, scripted([5, 15]).dice).total,
    ).toBe(16);
  });

  it("gives Expertise in a skill already proficient, else proficiency, as Keen Mind", async () => {
    const run = await checkRun();
    const picked = (skill: Skill) => {
      const answers: Answers = [
        { kind: "skills", values: [skill], orExpertise: true },
      ];
      return deriveStats(hero([], { answers }), run);
    };
    expect(picked("athletics").expertise).toContain("athletics");
    expect(picked("arcana")).toMatchObject({ expertise: [] });
    expect(picked("arcana").skills).toContain("arcana");
  });

  it("offers Study as a Bonus Action, as Keen Mind's Quick Study", async () => {
    const run = await checkRun();
    const foe = { ...hero([], { id: "foe" }), side: "enemy" as const };
    const options = (traits: readonly string[]) =>
      tacticOptions(
        hero(traits),
        contextOf(run, [hero(traits), foe], scripted([]).dice).state,
        run,
      ).map(({ id }) => id);
    expect(options(["studious"]).some((id) => id.includes("bonus-study"))).toBe(
      true,
    );
    expect(options([]).some((id) => id.includes("bonus-study"))).toBe(false);
  });

  it("limits a cast's modifier to the skill or ability the caster picks, as Guidance and Enhance Ability", async () => {
    const run = await checkRun();
    const guidance = lookup(run, SpellSchema, "srd52:spell/guidance");
    const resolution = guidance.activation?.resolution;
    const effects = resolution?.kind === "automatic" ? resolution.effects : [];
    const caster = hero([]);
    expect(
      leafEvents(
        effects,
        "guidance",
        caster,
        caster,
        contextOf(run, [caster], scripted([]).dice),
      ),
    ).toEqual([]);
    const frame = focusFrame(effects, "guidance", caster, caster);
    expect(frame).not.toBeNull();
    const { state } = settle(
      run,
      [caster],
      frame ? [frame] : [],
      scripted([]).dice,
      () => "stealth",
    );
    const blessed = state.actors[PLAYER_ACTOR];
    if (!blessed) throw new Error("No hero");
    const stealth = { skill: "stealth", dc: 30 } as const;
    expect(
      sceneCheck(run, blessed, stealth, scripted([10, 3]).dice).total,
    ).toBe(15);
    expect(withFocus({ kind: "advantage", on: "checks" }, "dex")).toEqual({
      kind: "advantage",
      on: "checks",
      ability: "dex",
    });
  });

  it("uses an SRD Fighter's Second Wind to rescue a failed check, as Tactical Mind", async () => {
    const run = await checkRun();
    const fighter = hero([], { level: 2 });
    const athletics = { skill: "athletics", dc: 15 } as const;
    expect(
      sceneCheck(run, fighter, athletics, scripted([3, 10]).dice),
    ).toMatchObject({
      outcome: "success",
      spent: ["second-wind"],
    });
  });
});
