import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  classOptions,
  runClassOption,
} from "../plugins/systems/dnd5.5e/core/class-options.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  type Actor,
  type DndState,
  freshActor,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { contextOf, hero, scripted, settle, testRun } from "./feat-fixtures.ts";

// Made-up character options for #192's grants: ids and mechanics only.
const option = (id: string, extra: object) => ({
  id: `test:supernatural-gift/${id}`,
  name: id,
  source: "Test",
  text: "Test.",
  ...extra,
});
const FIXTURES = [
  {
    id: "test:circle-casting-option/expand",
    name: "Expand",
    source: "Test",
    text: "Test.",
    automation: "full",
    passives: [
      {
        kind: "castOption",
        label: "Circle spell: Expand",
        circle: { slot: "any" },
        area: 10,
      },
    ],
  },
  option("health", {
    automation: "full",
    passives: [
      { kind: "scoreIncrease", abilities: ["con"], amount: 2, max: 22 },
    ],
  }),
  option("skillful", {
    automation: "full",
    choices: [
      {
        kind: "skills",
        id: "skills",
        count: 2,
        from: ["arcana", "history", "nature"],
      },
    ],
  }),
  option("resilience", {
    automation: "full",
    variants: [
      {
        id: "wis",
        name: "Wisdom",
        passives: [{ kind: "saveProficiency", abilities: ["wis"] }],
      },
      {
        id: "cha",
        name: "Charisma",
        passives: [{ kind: "saveProficiency", abilities: ["cha"] }],
      },
    ],
  }),
  option("restoration", {
    automation: "full",
    resources: [{ id: "charges", max: { base: 3 }, recharge: [] }],
    castsOnly: ["srd52:spell/lesser-restoration"],
    freeCast: { resource: "charges", count: 2 },
  }),
];

async function grantsRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

const id = (name: string) => `test:supernatural-gift/${name}`;

let run: RunContext;
beforeAll(async () => {
  run = await grantsRun();
});

function grant(
  state: DndState,
  args: object,
  answer?: (options: readonly string[]) => string,
) {
  const effect = run.system.storyEffects[`${NS}:grantOption`];
  if (!effect) throw new Error("No grantOption effect");
  const { dice } = scripted([]);
  const context = {
    state,
    dice,
    content: run.content,
    contentIds: run.contentIds,
  };
  const started = effect.apply(effect.schema.parse(args), context);
  return settle(
    run,
    state,
    started.frames ?? [],
    dice,
    answer
      ? (decision) => answer(decision.options.map((item) => item.id))
      : undefined,
  );
}

const party = (): DndState => {
  const player = hero([]);
  const ally = hero([], { id: "companion-1" });
  return {
    actors: { [player.id]: player, [ally.id]: ally },
    combat: null,
  };
};

describe("character options a story grants (#192)", () => {
  it("records a gift and plays what it does", () => {
    const { state, events } = grant(party(), { option: id("health") });
    expect(events.map((event) => event.kind)).toEqual([`${NS}:optionGranted`]);
    const player = state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("No player");
    expect(player.granted).toEqual([id("health")]);
    expect(deriveStats(player, run).abilities.con).toBe(16); // 13 + 1 from the background + 2
    // Not a feature: the sheet lists it apart.
    expect(deriveStats(player, run).features).not.toContain(id("health"));
  });

  it("asks an option's own picks as it's granted, and keeps them in the event", () => {
    const { state, decisions, events } = grant(party(), {
      option: id("skillful"),
    });
    expect(decisions).toHaveLength(2);
    expect(events[0]).toMatchObject({
      payload: {
        answers: [
          {
            kind: "skills",
            values: ["arcana", "history"],
            feat: id("skillful"),
          },
        ],
      },
    });
    const player = state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("No player");
    expect(deriveStats(player, run).skills).toEqual(
      expect.arrayContaining(["arcana", "history"]),
    );
  });

  it("lets the player pick which option, picks one of its variants, and grants the party too", () => {
    const { state, decisions } = grant(
      party(),
      { from: [id("health"), id("resilience")], party: true },
      (options) => (options.includes("cha") ? "cha" : (options.at(-1) ?? "")),
    );
    expect(decisions[0]?.options.map((item) => item.id)).toEqual([
      id("health"),
      id("resilience"),
    ]);
    const player = state.actors[PLAYER_ACTOR];
    const ally = state.actors["companion-1"];
    if (!player || !ally) throw new Error("No party");
    expect(deriveStats(player, run).savingThrows).toContain("cha");
    // The companion gains it too, picking without being asked.
    expect(ally.granted).toEqual([id("resilience")]);
    expect(decisions).toHaveLength(2);
  });

  it("casts a charm's spell with its charges, several at once", () => {
    const { state } = grant(party(), { option: id("restoration") });
    const player = state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("No player");
    const free = deriveStats(player, run).actions.find((action) =>
      action.id.startsWith("spell:srd52:spell/lesser-restoration:free"),
    );
    expect(free?.activation.cost).toContainEqual({
      resource: "charges",
      count: 2,
    });
  });
});

// A level 1 Wizard who knows Burning Hands, standing on this square.
function wizard(id: string, x: number): Actor {
  const actor = hero([], {
    id,
    answers: [{ kind: "spells", values: ["srd52:spell/burning-hands"] }],
  });
  const build = actor.source.kind === "character" ? actor.source.build : null;
  if (!build) throw new Error("No build");
  return {
    ...actor,
    position: { x, y: 0 },
    source: {
      kind: "character",
      build: {
        ...build,
        levels: build.levels.map((entry) => ({
          ...entry,
          classId: "srd52:class/wizard",
        })),
      },
    },
  };
}

const goblin = (): Actor => ({
  ...freshActor({
    id: "goblin",
    name: "Goblin",
    side: "enemy",
    source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
    hp: 7,
    inventory: [],
  }),
  position: { x: 1, y: 1 },
});

describe("Circle casting (#192)", () => {
  const expand = "castOption:test:circle-casting-option/expand:0";

  it("is offered while another caster within 30 feet can join, and grows the spell's area with each", () => {
    const { dice } = scripted([]);
    const near = contextOf(
      run,
      [wizard(PLAYER_ACTOR, 0), wizard("companion-1", 2), goblin()],
      dice,
    );
    const player = near.state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("No player");
    const offered = classOptions(player, near.state, near).map(
      (item) => item.id,
    );
    expect(offered.some((item) => item.endsWith(expand))).toBe(true);
    const far = contextOf(
      run,
      [wizard(PLAYER_ACTOR, 0), wizard("companion-1", 9), goblin()],
      dice,
    );
    const alone = far.state.actors[PLAYER_ACTOR];
    if (!alone) throw new Error("No player");
    expect(
      classOptions(alone, far.state, far).some((item) =>
        item.id.endsWith(expand),
      ),
    ).toBe(false);

    // Picked for Burning Hands, the other caster joins with its Reaction and a slot.
    const id = offered.find((item) => item.endsWith(expand)) ?? "";
    const { state, decisions } = settle(
      run,
      near.state,
      runClassOption({ actor: PLAYER_ACTOR, answer: id }, near).frames ?? [],
      dice,
      (decision) =>
        decision.options.find((option) => option.id.includes("burning-hands"))
          ?.id ?? "",
    );
    expect(decisions).toHaveLength(1);
    const ally = state.actors["companion-1"];
    const caster = state.actors[PLAYER_ACTOR];
    if (!ally || !caster) throw new Error("No party");
    expect(ally.budget.reaction).toBe(false);
    expect(ally.resourcesSpent["slot:1"]).toBe(1);
    const hands = deriveStats(caster, run).actions.find(
      (action) => action.id === "spell:srd52:spell/burning-hands",
    );
    const { targeting } = hands?.activation ?? {};
    expect(targeting && "area" in targeting ? targeting.area.radius : 0).toBe(
      25,
    );
  });
});
