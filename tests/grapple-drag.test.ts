import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  inReach,
  moveSquares,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { releasedGrapples } from "../plugins/systems/dnd5.5e/core/combat/grapple.ts";
import { squareKey } from "../plugins/systems/dnd5.5e/core/grid.ts";
import { coverFor } from "../plugins/systems/dnd5.5e/core/sight.ts";
import {
  type Actor,
  type DndState,
  NS,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { scripted, settle, testRun } from "./feat-fixtures.ts";

// Dragging a grappled creature, Abduct, and creatures sharing a square (issue #122), on made-up stat blocks encoded
// as the bugbears, grell, boneless, death's head tree and gallows speaker are.

const club = {
  name: "Club",
  activation: {
    cost: ["action"],
    targeting: { creatures: 1, range: 5, side: "enemy" },
    resolution: {
      kind: "attack",
      attack: { type: "weapon", flatBonus: 4 },
      damage: [{ amount: { dice: "1d6" }, type: "bludgeoning" }],
    },
  },
};

const block = (id: string, fields: Readonly<Record<string, unknown>> = {}) => ({
  id: `test:monster/${id}`,
  name: id,
  ac: 10,
  hp: 50,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  actions: [club],
  ...fields,
});

const FIXTURES = [
  block("brute"),
  block("bugbear", { passives: [{ kind: "abduct" }] }),
  block("gnat", { size: "tiny" }),
  block("ghoul", { creatureType: "undead" }),
  block("ogre", { size: "large" }),
  block("tree", {
    size: "huge",
    passives: [{ kind: "shareSpace", who: "allies", cover: true }],
    actions: [
      club,
      {
        name: "Head Fruits",
        activation: {
          cost: ["bonusAction"],
          targeting: {
            creatures: 10,
            range: 0,
            side: "ally",
            creatureTypes: ["undead"],
          },
          resolution: {
            kind: "automatic",
            damage: [],
            effects: [
              {
                kind: "tempHp",
                amount: { bonus: { base: 5, add: [] } },
                reaction: true,
              },
            ],
          },
        },
      },
    ],
  }),
  block("speaker", {
    size: "huge",
    passives: [{ kind: "shareSpace", who: "self", cover: false }],
  }),
];

async function run(): Promise<RunContext> {
  const base = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...base,
    content: (id) => byId.get(id) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...byId.keys()].sort(),
  };
}

function monster(
  id: string,
  kind: string,
  x: number,
  y: number,
  side: "enemy" | "party" = "enemy",
): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side,
      source: { kind: "monster", statBlockId: `test:monster/${kind}` },
      hp: 50,
      inventory: [],
    }),
    position: { x, y },
  };
}

// Held in a grapple by `by`'s Club, which reaches 5 feet.
const grappled = (actor: Actor, by: string): Actor => ({
  ...actor,
  activeEffects: [
    {
      sourceId: "monster:0",
      casterId: by,
      modifier: { kind: "condition", condition: "grappled" },
      ends: "spellDuration",
    },
  ],
});

function arena(actors: readonly Actor[], width = 12, height = 3): DndState {
  return {
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: {
      encounter: "arena",
      order: actors.map((item) => item.id),
      index: 0,
      round: 1,
      grid: { width, height },
      walls: [],
    },
  };
}

function get(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(id);
  return actor;
}

function walks(content: RunContext, state: DndState, id: string) {
  const actor = state.actors[id];
  if (!actor) throw new Error(id);
  return new Map(
    moveSquares(actor, state, deriveStats(actor, content), content).map(
      (item) => [squareKey(item.square), item],
    ),
  );
}

describe("dragging a grappled creature", () => {
  it("costs double out of the hold's reach, and farther only by letting go", async () => {
    const content = await run();
    const state = arena([
      monster("brute", "brute", 1, 1),
      grappled(monster("hero", "brute", 0, 1, "party"), "brute"),
    ]);
    const squares = walks(content, state, "brute");
    // Still beside the held creature: no drag, normal cost.
    expect(squares.get("1,0")).toMatchObject({ feet: 5 });
    expect(squares.get("1,0")?.drag).toBeUndefined();
    // Two squares on: the hero follows onto the square the walk left, for double the feet.
    expect(squares.get("3,1")).toMatchObject({
      feet: 20,
      drag: [{ actor: "hero", to: { x: 2 } }],
    });
    // Half its Speed is as far as it drags; beyond, it walks alone.
    expect(squares.get("4,1")?.feet).toBe(30);
    expect(squares.get("5,1")).toMatchObject({ feet: 20 });
    expect(squares.get("5,1")?.drag).toBeUndefined();
  });

  it("costs nothing extra with Abduct, or for a Tiny creature", async () => {
    const content = await run();
    const abduct = arena([
      monster("bugbear", "bugbear", 1, 1),
      grappled(monster("hero", "brute", 0, 1, "party"), "bugbear"),
    ]);
    expect(walks(content, abduct, "bugbear").get("7,1")).toMatchObject({
      feet: 30,
      drag: [{ actor: "hero", to: { x: 6 } }],
    });
    const tiny = arena([
      monster("brute", "brute", 1, 1),
      grappled(monster("gnat", "gnat", 0, 1, "party"), "brute"),
    ]);
    expect(walks(content, tiny, "brute").get("7,1")?.feet).toBe(30);
  });

  it("moves the held creature with it, spending its own movement but none of theirs, and keeps the grapple", async () => {
    const content = await run();
    const start = arena([
      monster("brute", "brute", 1, 1),
      grappled(monster(PLAYER_ACTOR, "brute", 0, 1, "party"), "brute"),
    ]);
    const { state, events } = settle(
      content,
      start,
      [{ kind: `${NS}:move`, payload: { actor: "brute", answer: "3,1" } }],
      scripted([]).dice,
    );
    expect(state.actors.brute).toMatchObject({
      position: { x: 3, y: 1 },
      moved: 20,
    });
    expect(state.actors[PLAYER_ACTOR]).toMatchObject({
      position: { x: 2 },
      moved: 0,
    });
    expect(events.filter((event) => event.kind === `${NS}:moved`)).toHaveLength(
      2,
    );
    expect(releasedGrapples(state, content)).toEqual([]);
    // It comes along, so it never sees its grappler leave its reach.
    expect(get(state, PLAYER_ACTOR).budget.reaction).toBe(true);
  });
});

describe("sharing a square", () => {
  it("lets the tree's allies end their moves in its space, with Half Cover there, but not its foes", async () => {
    const content = await run();
    const state = arena([
      monster("tree", "tree", 4, 1),
      monster("ghoul", "ghoul", 1, 1),
      monster("hero", "brute", 7, 1, "party"),
    ]);
    expect(walks(content, state, "ghoul").has("4,1")).toBe(true);
    expect(walks(content, state, "hero").has("4,1")).toBe(false);
    const under = {
      ...state,
      actors: {
        ...state.actors,
        ghoul: { ...monster("ghoul", "ghoul", 4, 1) },
      },
    };
    const ghoul = get(under, "ghoul");
    expect(coverFor(under, { x: 7, y: 1 }, ghoul, ["hero"], content)).toBe(2);
    // Out from under the branches, nothing covers it.
    expect(
      coverFor(state, { x: 0, y: 1 }, get(state, "ghoul"), [], content),
    ).toBe(0);
    // Another ally can join, but a foe can't stop there.
    expect(walks(content, under, "hero").has("4,1")).toBe(false);
  });

  it("gives Head Fruits' Temporary Hit Points to undead allies in the tree's space for their Reaction", async () => {
    const content = await run();
    const state = arena([
      monster("tree", "tree", 4, 1),
      monster("ghoul", "ghoul", 4, 1),
    ]);
    const tree = get(state, "tree");
    const fruits = deriveStats(tree, content).actions.find(
      (item) => item.name === "Head Fruits",
    );
    if (!fruits) throw new Error("Head Fruits");
    // Only the undead ally inside the tree's space can be chosen, not one beside it, nor the tree itself.
    const beside = arena([
      ...Object.values(state.actors),
      monster("ghast", "ghoul", 5, 1),
    ]);
    expect(
      inReach(fruits, tree, beside, content).map((item) => item.id),
    ).toEqual(["ghoul"]);
    expect(
      inReach(
        fruits,
        tree,
        arena([tree, monster("ghast", "ghoul", 5, 1)]),
        content,
      ),
    ).toEqual([]);
    const context = { state, dice: scripted([]).dice, ...content };
    const fed = resolveAction(fruits, tree, [get(state, "ghoul")], context);
    expect(fed.events?.map((event) => event.kind)).toEqual(
      expect.arrayContaining([`${NS}:budgetSpent`, `${NS}:tempHpGained`]),
    );
    const spent = {
      ...state,
      actors: {
        ...state.actors,
        ghoul: {
          ...get(state, "ghoul"),
          budget: { ...get(state, "ghoul").budget, reaction: false },
        },
      },
    };
    const none = resolveAction(fruits, tree, [get(spent, "ghoul")], {
      ...context,
      state: spent,
    });
    expect(
      none.events?.some((event) => event.kind === `${NS}:tempHpGained`),
    ).toBe(false);
  });

  it("lets Whirling Form enter any creature's space and stop there, even one too near its size to pass", async () => {
    const content = await run();
    const state = arena([
      monster("speaker", "speaker", 1, 1),
      monster("ogre", "ogre", 3, 1, "party"),
    ]);
    const squares = walks(content, state, "speaker");
    expect(squares.has("3,1")).toBe(true);
    expect(squares.has("5,1")).toBe(true);
    // Without the trait, a Huge brute can neither pass nor stop on a Large foe.
    const plain = arena([
      { ...monster("speaker", "tree", 1, 1), side: "enemy" },
      monster("ogre", "ogre", 3, 1, "party"),
    ]);
    expect(walks(content, plain, "speaker").has("3,1")).toBe(false);
  });
});
