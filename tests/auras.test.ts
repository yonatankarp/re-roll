import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  alliesRiderEvents,
  dealEvents,
  rollSave,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { rollBonus } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { zoneFrames } from "../plugins/systems/dnd5.5e/core/combat/areas.ts";
import { coverFor } from "../plugins/systems/dnd5.5e/core/sight.ts";
import { evades } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import { zoneCureEvents } from "../plugins/systems/dnd5.5e/core/zones.ts";
import {
  type Actor,
  type DndState,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { hero, scripted, testRun, trait } from "./feat-fixtures.ts";

// Auras and support for allies (#164): made-up features with ids and mechanics only.
const aura = (id: string, area: object, extra: object = {}) =>
  trait(id, [{ kind: "aura", name: id, radius: 10, area, ...extra }]);

const MINE = [
  aura("protection", {
    side: "ally",
    self: true,
    awake: true,
    grants: [
      {
        kind: "bonus",
        to: "saves",
        amount: { bonus: { add: [{ kind: "abilityMod", ability: "cha" }] } },
      },
    ],
  }),
  aura("courage", {
    side: "ally",
    self: true,
    grants: [{ kind: "conditionImmunity", condition: "frightened" }],
  }),
  aura("cover", { side: "ally", self: true, grants: [{ kind: "halfCover" }] }),
  aura("evasion", { side: "ally", grants: [{ kind: "evasion" }] }),
  aura("life", {
    side: "ally",
    when: "turnStart",
    downed: true,
    resolution: {
      kind: "automatic",
      damage: [],
      effects: [{ kind: "heal", amount: { bonus: { base: 1 } } }],
    },
  }),
  trait("leading", [{ kind: "evasion", leading: true }]),
];

async function mineRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(MINE.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

// A hero with these traits and this Charisma score.
function withCha(actor: Actor, cha: number): Actor {
  if (actor.source.kind !== "character" || !actor.source.build) return actor;
  const { build } = actor.source;
  return {
    ...actor,
    source: {
      ...actor.source,
      build: { ...build, baseAbilities: { ...build.baseAbilities, cha } },
    },
  };
}
const friendOf = (
  traits: readonly string[] = [],
  extra: Partial<Actor> = {},
) => ({ ...hero(traits, { id: "friend" }), name: "Friend", hp: 30, ...extra });
const foeOf = () => ({
  ...hero([], { id: "foe" }),
  name: "Foe",
  side: "enemy" as const,
  hp: 30,
});

function board(
  actors: readonly Actor[],
  at: Record<string, [number, number]>,
): DndState {
  const placed = actors.map((actor) => {
    const square = at[actor.id] ?? [0, 0];
    return { ...actor, position: { x: square[0], y: square[1] } };
  });
  return {
    actors: Object.fromEntries(placed.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: placed.map((actor) => actor.id),
      index: 0,
      round: 1,
      grid: { width: 20, height: 4 },
    },
  };
}
const ctx = (state: DndState, run: RunContext, dice = scripted([]).dice) => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});
const kinds = (events: readonly SystemEvent[], kind: string) =>
  events.filter((event) => event.kind === `${NS}:${kind}`);

describe("character auras", () => {
  it("gives allies in range a save bonus from the bearer's numbers, counting one aura of a kind once", async () => {
    const run = await mineRun();
    const paladin = withCha(hero(["protection"]), 16); // +3
    const near = friendOf();
    const far = { ...friendOf(), id: "far" };
    const state = board([paladin, near, far], {
      [PLAYER_ACTOR]: [0, 0],
      friend: [2, 0],
      far: [6, 0],
    });
    expect(rollBonus(state.actors.friend!, "saves", ctx(state, run))).toBe(3);
    expect(rollBonus(state.actors.far!, "saves", ctx(state, run))).toBe(0);
    expect(
      rollBonus(state.actors[PLAYER_ACTOR]!, "saves", ctx(state, run)),
    ).toBe(3);
    // A second Paladin's aura of the same name doesn't add another +3.
    const second = { ...withCha(hero(["protection"], { id: "second" }), 16) };
    const both = board([paladin, near, second], {
      [PLAYER_ACTOR]: [0, 0],
      friend: [1, 0],
      second: [2, 0],
    });
    expect(rollBonus(both.actors.friend!, "saves", ctx(both, run))).toBe(3);
  });

  it("is off while its bearer is Incapacitated, when it must be awake", async () => {
    const run = await mineRun();
    const paladin = {
      ...withCha(hero(["protection"]), 16),
      activeEffects: [
        {
          sourceId: "test",
          casterId: "foe",
          modifier: {
            kind: "condition" as const,
            condition: "stunned" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const state = board([paladin, friendOf()], {
      [PLAYER_ACTOR]: [0, 0],
      friend: [1, 0],
    });
    expect(rollBonus(state.actors.friend!, "saves", ctx(state, run))).toBe(0);
  });

  it("ends a condition it gives Immunity to on an ally standing in it", async () => {
    const run = await mineRun();
    const frightened = friendOf([], {
      activeEffects: [
        {
          sourceId: "test",
          casterId: "foe",
          modifier: { kind: "condition", condition: "frightened" },
          ends: "spellDuration",
        },
      ],
    });
    const state = board([hero(["courage"]), frightened, foeOf()], {
      [PLAYER_ACTOR]: [0, 0],
      friend: [1, 0],
      foe: [5, 0],
    });
    expect(kinds(zoneCureEvents(state, run), "conditionRemoved")).toEqual([
      expect.objectContaining({
        payload: { actor: "friend", condition: "frightened" },
      }),
    ]);
  });

  it("gives Half Cover to allies in it, and Evasion", async () => {
    const run = await mineRun();
    const state = board([hero(["cover", "evasion"]), friendOf(), foeOf()], {
      [PLAYER_ACTOR]: [0, 0],
      friend: [1, 0],
      foe: [8, 0],
    });
    const friend = state.actors.friend!;
    expect(coverFor(state, { x: 8, y: 0 }, friend, ["foe"], run)).toBe(2);
    expect(coverFor(state, { x: 8, y: 0 }, friend, ["foe"])).toBe(0);
    expect(evades(friend, "dex", ctx(state, run))).toBe(true);
    expect(evades(friend, "con", ctx(state, run))).toBe(false);
  });

  it("shares Evasion with allies within 5 feet of a Leading Evasion bearer", async () => {
    const run = await mineRun();
    const at = (x: number) =>
      board([hero(["leading"]), friendOf()], {
        [PLAYER_ACTOR]: [0, 0],
        friend: [x, 0],
      });
    expect(evades(at(1).actors.friend!, "dex", ctx(at(1), run))).toBe(true);
    expect(evades(at(3).actors.friend!, "dex", ctx(at(3), run))).toBe(false);
  });

  it("acts as an ally's turn starts only when it is at 0 Hit Points, as Aura of Life does", async () => {
    const run = await mineRun();
    const at = (hp: number) =>
      board([hero(["life"]), friendOf([], { hp })], {
        [PLAYER_ACTOR]: [0, 0],
        friend: [1, 0],
      });
    expect(
      zoneFrames(at(0).actors.friend!, "start", ctx(at(0), run)),
    ).toHaveLength(1);
    expect(
      zoneFrames(at(5).actors.friend!, "start", ctx(at(5), run)),
    ).toHaveLength(0);
  });
});

describe("support for allies", () => {
  const inspired = (giver: string) =>
    friendOf([], {
      activeEffects: [
        {
          sourceId: "feature:test:bardic:0",
          casterId: giver,
          modifier: { kind: "inspired", amount: { dice: "1d6" } },
          ends: "spellDuration",
        },
      ],
    });

  it("spends a held Bardic Inspiration die on a failed save it turns into a success, and only then", async () => {
    const run = await mineRun();
    const state = board([hero([]), inspired(PLAYER_ACTOR)], {
      [PLAYER_ACTOR]: [0, 0],
      friend: [1, 0],
    });
    const friend = state.actors.friend!;
    // A 9 against 13 fails by 4 (the friend has no Wisdom bonus); the d6 shows 5.
    const turned = rollSave(
      friend,
      "wis",
      13,
      ctx(state, run, scripted([9, 5]).dice),
    );
    expect(turned.saved).toBe(true);
    expect(kinds(turned.events, "effectEnded")).toHaveLength(1);
    // Too far short for a d6: kept.
    const kept = rollSave(
      friend,
      "wis",
      18,
      ctx(state, run, scripted([9, 5]).dice),
    );
    expect(kept.saved).toBe(false);
    expect(kinds(kept.events, "effectEnded")).toHaveLength(0);
  });

  it("gives an activation's effects to the most hurt allies near the bearer, spending a use", async () => {
    const run = await mineRun();
    const hurt = friendOf([], { hp: 3 });
    const fine = { ...friendOf([], { hp: 30 }), id: "fine" };
    const state = board([hero([]), hurt, fine], {
      [PLAYER_ACTOR]: [0, 0],
      friend: [2, 0],
      fine: [3, 0],
    });
    const events = alliesRiderEvents(
      [
        {
          within: 30,
          count: { base: 1, add: [] },
          effects: [{ kind: "heal", amount: { bonus: { base: 4, add: [] } } }],
          resource: "second-wind",
        },
      ],
      "test",
      state.actors[PLAYER_ACTOR]!,
      ctx(state, run),
    );
    expect(kinds(events, "healed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ actor: "friend" }),
      }),
    ]);
    expect(kinds(events, "resourceSpent")).toHaveLength(1);
  });

  it("takes a ward's dice off damage, keeping those it didn't need", async () => {
    const run = await mineRun();
    const warded = friendOf([], {
      activeEffects: [
        {
          sourceId: "test",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "wardDice", count: 5, die: 8 },
          ends: "spellDuration",
        },
      ],
    });
    const state = board([hero([]), warded], {
      [PLAYER_ACTOR]: [0, 0],
      friend: [1, 0],
    });
    // 7 damage needs two d8s on average; they roll 3 and 3, so 1 gets through and three dice are left.
    const dealt = dealEvents(
      state.actors.friend!,
      [{ amount: 7, type: "fire" }],
      false,
      ctx(state, run, scripted([3, 3]).dice),
    );
    expect(dealt.dealt).toBe(1);
    expect(kinds(dealt.events, "effectAdded")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          effect: expect.objectContaining({
            modifier: { kind: "wardDice", count: 3, die: 8 },
          }),
        }),
      }),
    ]);
  });
});
