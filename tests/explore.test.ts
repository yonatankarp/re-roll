import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { sceneCastActions } from "../plugins/systems/dnd5.5e/core/camp.ts";
import { carriedWeight } from "../plugins/systems/dnd5.5e/core/carry.ts";
import { environmentEvents } from "../plugins/systems/dnd5.5e/core/environment.ts";
import { toolProficiencies } from "../plugins/systems/dnd5.5e/core/explore.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { startingTools } from "../plugins/systems/dnd5.5e/core/tools.ts";
import { ClassSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { hasFlag } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { startCombat } from "../plugins/systems/dnd5.5e/core/combat.ts";
import { hero, scripted, settle, testRun, trait } from "./feat-fixtures.ts";

// Made-up tools, items and features for exploring outside a fight (#153, #185): ids and mechanics only.
const PICKS = "test:item/picks";
const automatic = (effects: readonly object[]) => ({
  kind: "automatic",
  damage: [],
  effects,
});
const FIXTURES = [
  {
    id: PICKS,
    name: "Lockpicks",
    type: "tool",
    ability: "dex",
    handles: ["lock", "trap"],
    text: "Test.",
  },
  {
    id: "test:item/kit",
    name: "Kit",
    type: "tool",
    ability: "wis",
    text: "Test.",
  },
  trait("picker", [{ kind: "toolProficiency", tools: [PICKS] }]),
  trait("deft", [], {}),
  trait("reliable", [
    {
      kind: "modifier",
      modifier: { kind: "checkFloor", value: 10, proficient: true },
    },
  ]),
  trait("marked", [
    {
      kind: "modifier",
      modifier: {
        kind: "bonus",
        to: "checks",
        tool: "test:item/kit",
        amount: { bonus: { base: 3 } },
      },
    },
  ]),
  trait("opener", [], {
    activations: [
      {
        cost: ["action"],
        targeting: { self: true },
        resolution: automatic([
          {
            kind: "modifier",
            modifier: {
              kind: "sceneAid",
              about: ["lock", "stuck"],
              aid: "success",
              once: true,
            },
            duration: "instantaneous",
          },
        ]),
      },
    ],
  }),
  trait("guide", [], {
    activations: [
      {
        cost: ["action"],
        targeting: { creatures: 1, range: "touch", side: "ally" },
        resolution: automatic([
          {
            kind: "modifier",
            modifier: {
              kind: "bonus",
              to: "checks",
              amount: { bonus: { base: 4 } },
            },
            duration: { concentration: true, minutes: 1 },
            pick: ["stealth", "perception"],
          },
        ]),
      },
    ],
  }),
  trait("blessing", [], {
    activations: [
      {
        cost: ["action"],
        targeting: { self: true },
        resolution: automatic([
          {
            kind: "modifier",
            modifier: { kind: "advantage", on: "checks", skills: ["stealth"] },
            duration: { until: "longRest" },
          },
        ]),
      },
    ],
  }),
  {
    id: "test:item/rope",
    name: "Rope",
    type: "magicItem",
    category: "wondrousItem",
    rarity: "uncommon",
    attunement: false,
    text: "Test.",
    automation: "full",
    passives: [
      {
        kind: "modifier",
        modifier: { kind: "sceneAid", about: ["climb"], aid: "advantage" },
      },
    ],
  },
  {
    id: "test:item/bag",
    name: "Bag",
    type: "magicItem",
    category: "wondrousItem",
    rarity: "uncommon",
    attunement: false,
    weightLb: 5,
    text: "Test.",
    automation: "full",
    passives: [{ kind: "modifier", modifier: { kind: "holds", pounds: 10 } }],
  },
  {
    id: "test:item/brick",
    name: "Brick",
    type: "gear",
    weightLb: 6,
    text: "Test.",
  },
  {
    id: "test:dungeon-feature/lock",
    name: "Lock",
    text: "Test.",
    source: "Test",
    automation: "full",
    check: {
      skill: "sleightOfHand",
      ability: "dex",
      tool: PICKS,
      about: ["lock"],
    },
  },
  {
    id: "test:item/key",
    name: "Key",
    type: "magicItem",
    category: "wondrousItem",
    rarity: "common",
    attunement: false,
    text: "Test.",
    automation: "full",
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "sceneAid",
          about: ["lock"],
          aid: "success",
          chance: 5,
          spends: true,
        },
      },
    ],
  },
  {
    id: "test:item/saw",
    name: "Saw",
    type: "tool",
    ability: "dex",
    artisan: true,
    text: "Test.",
  },
  trait("manifold", [{ kind: "anyTool" }]),
  trait("lucky", [{ kind: "cancelDisadvantage", resource: "focus", cost: 2 }], {
    resources: [{ id: "focus", max: { base: 2 }, recharge: [] }],
  }),
  trait("echoing", [
    {
      kind: "naturalOne",
      name: "Echoes",
      save: { ability: "con", dc: { base: 30 } },
      effects: [
        {
          kind: "applyCondition",
          condition: "incapacitated",
          duration: { until: "yourNextTurnEnd" },
        },
      ],
    },
  ]),
  trait(
    "ambusher",
    [{ kind: "initiativeDie", bonusDice: "1d8", resource: "dice" }],
    { resources: [{ id: "dice", max: { base: 1 }, recharge: [] }] },
  ),
  trait("steady", [
    {
      kind: "modifier",
      modifier: {
        kind: "advantage",
        on: "checks",
        skills: ["perception"],
        halfMove: true,
      },
    },
  ]),
  trait("courtier", [
    { kind: "saveProficiency", abilities: ["con"], orElse: ["int", "cha"] },
  ]),
  {
    id: "test:environmental-effect/heat",
    name: "Heat",
    text: "Test.",
    source: "Test",
    automation: "full",
    weather: "heat",
    exposure: { every: "hour", ability: "con", dc: 30, water: true },
  },
];

async function exploreRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

// Whole, so healing isn't offered with what's tested.
const whole = (actor: Actor): Actor => ({ ...actor, hp: 12 });

const between = (actors: readonly Actor[]): DndState => ({
  actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
  combat: null,
});

const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);

// A scene's check by the player's character, and what it rolled.
function check(
  run: RunContext,
  state: DndState,
  value: object,
  dice: Dice = scripted([]).dice,
) {
  const result = run.system.resolveCheck(value, {
    state,
    dice,
    content: run.content,
    contentIds: run.contentIds,
  });
  const events = result.events ?? [];
  const report = events.find((event) => event.kind === `${NS}:rollReported`) as
    { payload: { total: number } } | undefined;
  return { outcome: result.outcome, total: report?.payload.total, events };
}

const kinds = (events: readonly SystemEvent[]) =>
  events.map((event) => event.kind);

// The test hero is a level 1 Fighter: Dexterity 14 (+2), Wisdom 12 (+1), Proficiency Bonus 2, proficient in Athletics
// and Survival, not Sleight of Hand.
describe("checks about an obstacle (#153)", () => {
  it("clears a lock with an aid cast for it, without a roll, and spends the aid", async () => {
    const run = await exploreRun();
    const player = {
      ...hero([]),
      activeEffects: [
        {
          sourceId: "x:opener",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "sceneAid" as const,
            about: ["lock" as const],
            aid: "success" as const,
            once: true as const,
          },
          ends: "spellDuration" as const,
          lingers: 0,
        },
      ],
    };
    const state = between([player]);
    const lock = { skill: "sleightOfHand", dc: 30, about: ["lock"] };
    const opened = check(run, state, lock);
    expect(opened.outcome).toBe("success");
    expect(kinds(opened.events)).toEqual([
      `${NS}:obstacleCleared`,
      `${NS}:effectEnded`,
    ]);
    // A check about something else rolls as usual.
    const climb = check(run, state, {
      skill: "athletics",
      dc: 30,
      about: ["climb"],
    });
    expect(climb.outcome).toBe("failure");
    expect(kinds(climb.events)).toContain(`${NS}:rollReported`);
  });

  it("rolls a climb with Advantage while carrying an item that helps with it", async () => {
    const run = await exploreRun();
    const player = { ...hero([]), inventory: ["test:item/rope"] };
    // Athletics: +3 Strength, +2 proficiency; Advantage keeps the 15 over the 5.
    const climb = { skill: "athletics", dc: 25, about: ["climb"] };
    expect(
      check(run, between([player]), climb, scripted([5, 15]).dice).total,
    ).toBe(20);
    const plain = { skill: "athletics", dc: 25 };
    expect(
      check(run, between([player]), plain, scripted([5, 15]).dice).total,
    ).toBe(10);
  });
});

describe("tool checks (#185)", () => {
  it("adds a carried tool's proficiency to a check about what it deals with", async () => {
    const run = await exploreRun();
    const lock = { skill: "sleightOfHand", dc: 30, about: ["lock"] };
    const roll = (actor: Actor) =>
      check(run, between([actor]), lock, scripted([10, 10]).dice).total;
    // 10 + Dexterity 2, then the tool's proficiency 2, only while it's carried.
    expect(roll(hero(["picker"]))).toBe(12);
    expect(roll({ ...hero(["picker"]), inventory: [PICKS] })).toBe(14);
    expect(roll({ ...hero([]), inventory: [PICKS] })).toBe(12);
  });

  it("gives Advantage with both the tool and the skill, and counts the tool for Reliable Talent", async () => {
    const run = await exploreRun();
    const stealthy = { skill: "athletics", dc: 30, about: ["lock"] };
    const tooled = {
      ...hero(["picker", "reliable"]),
      inventory: [PICKS],
    };
    // Athletics is proficient and the tool is too: Advantage takes the 12; no second Proficiency Bonus.
    expect(
      check(run, between([tooled]), stealthy, scripted([3, 12]).dice).total,
    ).toBe(17);
    // A tool check with no skill: a 2 counts as 10 with Reliable Talent, as the tool is proficient.
    const picked = { tool: PICKS, dc: 30 };
    expect(
      check(run, between([tooled]), picked, scripted([2]).dice).total,
    ).toBe(14);
  });

  it("fails a dungeon feature's check that needs a tool the character doesn't carry", async () => {
    const run = await exploreRun();
    const feature = { feature: "test:dungeon-feature/lock", dc: 5 };
    const without = check(run, between([hero(["picker"])]), feature);
    expect(without.outcome).toBe("failure");
    expect(kinds(without.events)).toEqual([
      `${NS}:toolMissing`,
      "gmOpportunity",
    ]);
    const carried = check(
      run,
      between([{ ...hero(["picker"]), inventory: [PICKS] }]),
      feature,
      scripted([10]).dice,
    );
    expect(carried.outcome).toBe("success");
  });

  it("adds a bonus only to checks with its tool, using the tool's ability", async () => {
    const run = await exploreRun();
    const marked = { ...hero(["marked"]), inventory: ["test:item/kit"] };
    // Wisdom +1 and the bonus's 3.
    expect(
      check(
        run,
        between([marked]),
        { tool: "test:item/kit", dc: 30 },
        scripted([10]).dice,
      ).total,
    ).toBe(14);
    expect(
      check(
        run,
        between([marked]),
        { ability: "wis", dc: 30 },
        scripted([10]).dice,
      ).total,
    ).toBe(11);
  });

  it("gives proficiency with a background's tool by name and a class's tools, and starts with them", async () => {
    const run = await exploreRun();
    const tools = toolProficiencies(hero([]), {
      ...run,
      content: (id) =>
        id === "test:background/plain"
          ? { ...run.content(id), id, tool: "Lockpicks" }
          : run.content(id),
    });
    // Tools match by name, so a book's Lockpicks and another's are one tool.
    expect([...tools]).toEqual(["lockpicks"]);
    const rogue = lookup(run, ClassSchema, "srd52:class/rogue");
    expect(startingTools(rogue, "Lockpicks", run)).toEqual([
      "srd52:item/thieves-tools",
      PICKS,
    ]);
  });
});

describe("between fights (#153, #185)", () => {
  it("offers an aid only where a check here is about what it deals with, and the cast lasts the scene", async () => {
    const run = await exploreRun();
    const state = between([whole(hero(["opener"]))]);
    const lock = { skill: "sleightOfHand", dc: 15, about: ["lock"] };
    expect(sceneCastActions(state, run, { checks: [lock] })).toHaveLength(1);
    expect(
      sceneCastActions(state, run, {
        checks: [{ skill: "athletics", dc: 15, about: ["climb"] }],
      }),
    ).toEqual([]);
    const [offer] = sceneCastActions(state, run, { checks: [lock] });
    const cast = run.system.storyEffects[`${NS}:castBetween`]?.apply(
      offer?.args,
      {
        state,
        dice: scripted([]).dice,
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    const cast1 = fold(state, cast?.events ?? []);
    expect(cast1.actors[PLAYER_ACTOR]?.activeEffects).toMatchObject([
      { modifier: { kind: "sceneAid" }, lingers: 0 },
    ]);
    // Already on, it isn't offered again; the next scene ends it.
    expect(sceneCastActions(cast1, run, { checks: [lock] })).toEqual([]);
    const later = fold(cast1, [dndEvent(`${NS}:timePassed`, { hours: 1 })]);
    expect(later.actors[PLAYER_ACTOR]?.activeEffects).toEqual([]);
  });

  it("offers a check bonus where a check uses a skill it can pick, and the player picks the skill", async () => {
    const run = await exploreRun();
    const state = between([whole(hero(["guide"]))]);
    expect(
      sceneCastActions(state, run, {
        checks: [{ skill: "athletics", dc: 10 }],
      }),
    ).toEqual([]);
    const [offer] = sceneCastActions(state, run, {
      checks: [{ skill: "perception", dc: 10 }],
    });
    const cast = run.system.storyEffects[`${NS}:castBetween`]?.apply(
      offer?.args,
      {
        state,
        dice: scripted([]).dice,
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    const started = fold(state, cast?.events ?? []);
    expect(started.actors[PLAYER_ACTOR]?.concentratingOn).not.toBeNull();
    const picked = settle(
      run,
      started,
      cast?.frames ?? [],
      scripted([]).dice,
      () => "perception",
    );
    expect(picked.decisions[0]?.actor).toBe(PLAYER_ACTOR);
    expect(picked.state.actors[PLAYER_ACTOR]?.activeEffects).toMatchObject([
      { modifier: { kind: "bonus", skill: "perception" }, lingers: 0 },
    ]);
    // The next scene ends it, and the Concentration with it.
    const later = fold(picked.state, [
      dndEvent(`${NS}:timePassed`, { hours: 1 }),
    ]);
    expect(later.actors[PLAYER_ACTOR]?.activeEffects).toEqual([]);
    expect(later.actors[PLAYER_ACTOR]?.concentratingOn).toBeNull();
  });

  it("keeps an effect that lasts until a Long Rest through fights and scenes, and ends it with one", async () => {
    const run = await exploreRun();
    const state = between([whole(hero(["blessing"]))]);
    const [offer] = sceneCastActions(state, run, {
      checks: [{ skill: "stealth", dc: 10 }],
    });
    const cast = run.system.storyEffects[`${NS}:castBetween`]?.apply(
      offer?.args,
      {
        state,
        dice: scripted([]).dice,
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    let after = fold(state, cast?.events ?? []);
    after = fold(after, [
      dndEvent(`${NS}:timePassed`, { hours: 3 }),
      dndEvent(`${NS}:restFinished`, { rest: "short" }),
    ]);
    expect(after.actors[PLAYER_ACTOR]?.activeEffects).toHaveLength(1);
    after = fold(after, [dndEvent(`${NS}:restFinished`, { rest: "long" })]);
    expect(after.actors[PLAYER_ACTOR]?.activeEffects).toEqual([]);
  });
});

describe("what's carried and drunk (#153)", () => {
  it("carries the pack's load in a holding item, up to what it holds", async () => {
    const run = await exploreRun();
    const brick = "test:item/brick";
    const packed = {
      ...hero([]),
      inventory: ["test:item/bag", brick, brick],
      stowed: [brick, brick],
    };
    // 5 for the bag and 12 of bricks, 10 of them held.
    expect(carriedWeight(packed, run)).toBe(7);
    expect(carriedWeight({ ...packed, stowed: [] }, run)).toBe(17);
  });

  it("spares a party with drinkable water an exposure's saves that water answers", async () => {
    const run = await exploreRun();
    const heat = {
      effects: ["test:environmental-effect/heat"],
      hours: 1,
      minutes: 0,
    };
    const context = (actors: readonly Actor[]) => ({
      state: between(actors),
      dice: scripted([1]).dice,
      content: run.content,
      contentIds: run.contentIds,
    });
    const dry = environmentEvents(heat, context([hero([])]));
    expect(kinds(dry)).toContain(`${NS}:exhaustionChanged`);
    const watered = {
      ...hero([]),
      activeEffects: [
        {
          sourceId: "x:water",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "water" as const },
          ends: "spellDuration" as const,
          lingers: 24,
        },
      ],
    };
    expect(kinds(environmentEvents(heat, context([watered])))).not.toContain(
      `${NS}:exhaustionChanged`,
    );
  });
});

describe("the rest of the pieces (#153, #185)", () => {
  it("tries an item that works by chance, which is gone once it has", async () => {
    const run = await exploreRun();
    const player = { ...hero([]), inventory: ["test:item/key"] };
    const lock = { skill: "sleightOfHand", dc: 30, about: ["lock"] };
    const opened = check(run, between([player]), lock, scripted([4]).dice);
    expect(opened.outcome).toBe("success");
    expect(kinds(opened.events)).toEqual([
      `${NS}:obstacleCleared`,
      `${NS}:itemUsed`,
    ]);
    const tried = check(run, between([player]), lock, scripted([50, 10]).dice);
    expect(tried.outcome).toBe("failure");
  });

  it("counts a Manifold Tool as any Artisan's Tools, proficient", async () => {
    const run = await exploreRun();
    const saw = { tool: "test:item/saw", dc: 30 };
    // 10, Dexterity 2, and the tool's proficiency 2.
    expect(
      check(run, between([hero(["manifold"])]), saw, scripted([10]).dice).total,
    ).toBe(14);
    const needed = { tool: "test:item/saw", dc: 5, needs: true };
    expect(check(run, between([hero([])]), needed).outcome).toBe("failure");
  });

  it("cancels Disadvantage on a check by spending its resource, while there's enough", async () => {
    const run = await exploreRun();
    const poisoned = (actor: Actor): Actor => ({
      ...actor,
      activeEffects: [
        {
          sourceId: "x:poison",
          casterId: "foe",
          modifier: { kind: "condition", condition: "poisoned" },
          ends: "spellDuration",
        },
      ],
    });
    const athletics = { skill: "athletics", dc: 30 };
    // One die, the 5, with the Disadvantage cancelled; 5 + 3 + 2.
    const lucky = check(
      run,
      between([poisoned(hero(["lucky"]))]),
      athletics,
      scripted([5, 15]).dice,
    );
    expect(lucky.total).toBe(10);
    expect(kinds(lucky.events)[0]).toBe(`${NS}:resourceSpent`);
    const spent = {
      ...poisoned(hero(["lucky"])),
      resourcesSpent: { focus: 1 },
    };
    expect(
      check(run, between([spent]), athletics, scripted([15, 5]).dice).total,
    ).toBe(10);
  });

  it("makes its save right after a d20 test rolls a 1, and the failure lands on the bearer", async () => {
    const run = await exploreRun();
    const rolled = check(
      run,
      between([hero(["echoing"])]),
      { skill: "athletics", dc: 30 },
      scripted([1, 1]).dice,
    );
    expect(kinds(rolled.events)).toEqual(
      expect.arrayContaining([`${NS}:saveRolled`, `${NS}:effectAdded`]),
    );
    const fine = check(
      run,
      between([hero(["echoing"])]),
      { skill: "athletics", dc: 30 },
      scripted([2]).dice,
    );
    expect(kinds(fine.events)).not.toContain(`${NS}:saveRolled`);
  });

  it("adds a resource's die to Initiative and spends it", async () => {
    const run = await exploreRun();
    const state = between([hero(["ambusher"])]);
    const result = startCombat(
      {
        id: "ambush",
        monsters: [{ monster: "srd52:monster/goblin-warrior", count: 1 }],
      },
      {
        state,
        dice: scripted([10, 10, 8]).dice,
        content: run.content,
        contentIds: run.contentIds,
      },
      { canFlee: false, defeatContinues: false },
    );
    expect(kinds(result.events ?? [])).toContain(`${NS}:resourceSpent`);
  });

  it("gives Advantage only while the bearer has moved no more than half its Speed", async () => {
    const run = await exploreRun();
    const steady = hero(["steady"]);
    const stats = deriveStats(steady, run);
    expect(
      hasFlag(
        steady,
        "advantage",
        "checks",
        stats,
        "wis",
        undefined,
        undefined,
        "perception",
      ),
    ).toBe(true);
    const moved = { ...steady, moved: stats.speed };
    expect(
      hasFlag(
        moved,
        "advantage",
        "checks",
        stats,
        "wis",
        undefined,
        undefined,
        "perception",
      ),
    ).toBe(false);
  });

  it("gives another save's proficiency when the one it gives is already there", async () => {
    const run = await exploreRun();
    // The Fighter already has Constitution; Charisma 10 beats Intelligence 8.
    expect(deriveStats(hero(["courtier"]), run).savingThrows).toContain("cha");
  });

  it("keeps a calmed environment's exposure off the party", async () => {
    const run = await exploreRun();
    const calm = {
      ...hero([]),
      activeEffects: [
        {
          sourceId: "x:calm",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "weather" as const,
            ends: ["heat" as const],
          },
          ends: "spellDuration" as const,
          lingers: 8,
        },
      ],
    };
    const events = environmentEvents(
      { effects: ["test:environmental-effect/heat"], hours: 1, minutes: 0 },
      {
        state: between([calm]),
        dice: scripted([1]).dice,
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    expect(kinds(events)).not.toContain(`${NS}:saveRolled`);
  });
});
