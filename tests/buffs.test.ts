import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  dealEvents,
  leafEvents,
  rollSave,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { evades } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import { damageResponses } from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  type Actor,
  type DndState,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { hero, scripted, testRun, trait } from "./feat-fixtures.ts";

// Buff and debuff spells with special rules (#160): made-up features and effects with ids and mechanics only.
const MINE = [
  trait("prescience", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: {
          rolled: {
            rolls: ["attack", "save", "check"],
            by: "any",
            when: "hitOrFailedOwn",
          },
        },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "replaceRoll", extreme: true }],
        },
      },
    ],
  }),
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

type Effect = Actor["activeEffects"][number];
const effect = (modifier: Effect["modifier"], casterId = PLAYER_ACTOR) =>
  ({
    sourceId: "spell:test",
    casterId,
    modifier,
    ends: "spellDuration",
  }) as Effect;
const friendOf = (
  effects: readonly Effect[] = [],
  extra: Partial<Actor> = {},
) => ({
  ...hero([], { id: "friend" }),
  name: "Friend",
  hp: 30,
  activeEffects: [...effects],
  ...extra,
});

function row(actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(
      actors.map((actor, index) => [
        actor.id,
        { ...actor, position: { x: index, y: 0 } },
      ]),
    ),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
      grid: { width: 10, height: 3 },
    },
  };
}
const ctx = (state: DndState, run: RunContext, dice = scripted([]).dice) => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});
function who(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(`no ${id}`);
  return actor;
}
const kinds = (events: readonly SystemEvent[], kind: string) =>
  events.filter((event) => event.kind === `${NS}:${kind}`);

describe("buffs with special rules", () => {
  it("heals at the dice's highest numbers, as Beacon of Hope", async () => {
    const run = await mineRun();
    const state = row([
      hero([]),
      friendOf([effect({ kind: "healedMax" })], { hp: 1 }),
    ]);
    const events = leafEvents(
      [{ kind: "heal", amount: { dice: "1d4" } }],
      "spell:cure",
      who(state, PLAYER_ACTOR),
      who(state, "friend"),
      ctx(state, run, scripted([1, 1]).dice),
    );
    expect(kinds(events, "healed")).toMatchObject([{ payload: { amount: 4 } }]);
  });

  it("deals the bearer's damage to its caster too, as Warding Bond", async () => {
    const run = await mineRun();
    const state = row([hero([], {}), friendOf([effect({ kind: "bonded" })])]);
    const dealt = dealEvents(
      who(state, "friend"),
      [{ amount: 6, type: "fire" }],
      false,
      ctx(state, run),
    );
    expect(kinds(dealt.events, "damaged")).toMatchObject([
      { payload: { actor: "friend", amount: 6 } },
      { payload: { actor: PLAYER_ACTOR, amount: 6 } },
    ]);
  });

  it("strips Resistance to its type and adds its dice once a turn, as Elemental Bane", async () => {
    const run = await mineRun();
    const baned = friendOf([
      effect({ kind: "resistance", damage: "fire" }),
      effect({ kind: "bane", damage: "fire", amount: { dice: "2d6" } }),
    ]);
    const state = row([hero([]), baned]);
    expect(
      damageResponses(who(state, "friend"), ctx(state, run)).resistances,
    ).not.toContain("fire");
    const dealt = dealEvents(
      who(state, "friend"),
      [{ amount: 3, type: "fire" }],
      false,
      ctx(state, run, scripted([4, 5]).dice),
    );
    expect(dealt.dealt).toBe(12);
  });

  it("dodges a magic save's damage of any ability, only against magic, as Elminster's Elusion", async () => {
    const run = await mineRun();
    const state = row([
      friendOf([effect({ kind: "evasion", anySave: true, magical: true })]),
    ]);
    const friend = who(state, "friend");
    expect(evades(friend, "con", ctx(state, run), true)).toBe(true);
    expect(evades(friend, "con", ctx(state, run), false)).toBe(false);
  });

  it("holds off a condition only from creatures of its types, as Protection from Evil and Good", async () => {
    const run = await mineRun();
    const ward = friendOf([
      effect({
        kind: "conditionImmunity",
        condition: "charmed",
        creatureTypes: ["fiend"],
      }),
    ]);
    const state = row([hero([]), ward]);
    // The caster here is a humanoid hero, so the charm lands.
    const events = leafEvents(
      [
        {
          kind: "applyCondition",
          condition: "charmed",
          duration: { minutes: 1 },
          repeatSave: false,
          endsOnDamage: false,
        },
      ],
      "spell:charm",
      who(state, PLAYER_ACTOR),
      who(state, "friend"),
      ctx(state, run),
    );
    expect(kinds(events, "effectAdded")).toHaveLength(1);
  });

  it("negates an outright death and ends, as Death Ward", async () => {
    const run = await mineRun();
    const state = row([hero([]), friendOf([effect({ kind: "deathWard" })])]);
    const events = leafEvents(
      [{ kind: "slay", hpAtMost: 100 }],
      "spell:kill",
      who(state, PLAYER_ACTOR),
      who(state, "friend"),
      ctx(state, run),
    );
    expect(kinds(events, "damaged")).toHaveLength(0);
    expect(kinds(events, "effectEnded")).toHaveLength(1);
  });

  it("turns the bearer's own failed save into a 20, as Moment of Prescience", async () => {
    const run = await mineRun();
    const seer = hero(["prescience"]);
    const state = row([seer]);
    const save = rollSave(seer, "wis", 25, ctx(state, run, scripted([3]).dice));
    expect(save.saved).toBe(false); // a 20 plus Wisdom still misses 25
    const easy = rollSave(seer, "wis", 18, ctx(state, run, scripted([3]).dice));
    expect(easy.saved).toBe(true);
  });
});
