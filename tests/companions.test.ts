import { describe, expect, it } from "vitest";
import { PLAYER_ACTOR } from "../engine/kernel/events.ts";
import { tacticOptions } from "../plugins/systems/dnd5.5e/core/actions.ts";
import {
  awaitsCommand,
  companionActors,
  companionFoundEvents,
} from "../plugins/systems/dnd5.5e/core/combat/companions.ts";
import {
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { mountOptions } from "../plugins/systems/dnd5.5e/core/combat/mounts.ts";
import {
  canAfford,
  touchCourier,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { runAdvanceTurn } from "../plugins/systems/dnd5.5e/core/combat/turn.ts";
import {
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { hero, trait } from "./feat-fixtures.ts";
import { at, block, monster, onMap, runWith } from "./senses-fixtures.ts";

// A made-up lasting companion for #145: ids and mechanics only.

const FIGHTER = "srd52:class/fighter";
const FIXTURES = [
  {
    id: "test:companion/hound",
    name: "Hound",
    ac: "12 + your Strength modifier",
    hp: "5 + five times your level",
    speed: "40 ft.",
    abilities: { str: 14, dex: 12, con: 14, int: 4, wis: 10, cha: 6 },
    text: "Test.",
    play: {
      level: 1,
      ac: 12,
      hp: 10,
      speed: 40,
      owner: {
        hp: {
          base: 5,
          add: [{ kind: "classLevel", class: FIGHTER, times: 5 }],
        },
        ac: { base: 12, add: [{ kind: "abilityMod", ability: "str" }] },
      },
      passives: [],
      actions: [
        {
          name: "Bite",
          activation: {
            cost: ["action"],
            targeting: { creatures: 1, range: 5, side: "enemy" },
            resolution: {
              kind: "attack",
              attack: { type: "spell" },
              damage: [
                {
                  amount: {
                    dice: "1d8",
                    bonus: {
                      base: 2,
                      add: [{ kind: "scaling", key: "ownerMod" }],
                    },
                  },
                  type: "piercing",
                },
              ],
            },
          },
        },
      ],
    },
  },
  trait(
    "handler",
    [{ kind: "lastingCompanion", companion: "test:companion/hound" }],
    {
      activations: [
        {
          label: "Command",
          cost: ["bonusAction"],
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            effects: [{ kind: "commandCompanion" }],
          },
        },
      ],
    },
  ),
  trait("trainer", [], {
    companion: { multiattack: 2, damageTypes: ["force"] },
  }),
  {
    id: "test:spell/servant",
    name: "Servant",
    level: 2,
    school: "conjuration",
    classes: [],
    castingTime: "1 hour",
    range: "10 feet",
    components: "V, S",
    duration: "instantaneous",
    text: "Test.",
    automation: "full",
    companion: { companion: "test:companion/servant" },
  },
  {
    id: "test:companion/servant",
    name: "Servant",
    ac: "13",
    hp: "15",
    speed: "20 ft.",
    abilities: { str: 4, dex: 15, con: 12, int: 10, wis: 10, cha: 7 },
    text: "Test.",
    play: {
      level: 2,
      ac: 13,
      hp: 15,
      hpPerLevel: 5,
      speed: 20,
      passives: [],
      actions: [],
    },
  },
  trait("servant-caster", [], { spells: { "1": ["test:spell/servant"] } }),
  trait("horseshoes", [
    {
      kind: "companionGear",
      passives: [
        {
          kind: "modifier",
          modifier: {
            kind: "bonus",
            to: "speed",
            amount: { bonus: { base: 30 } },
          },
        },
      ],
    },
  ]),
  trait("saddle", [{ kind: "quickMount" }]),
  trait("golem-maker", [], {
    activations: [
      {
        label: "Animate",
        cost: ["action"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "animate",
              monster: "test:monster/horse",
              range: 5,
              lasting: true,
            },
          ],
        },
      },
    ],
  }),
  block("horse", { size: "large", speed: 60 }),
];
const dice = { below: () => 0, roll: () => 10 };

describe("lasting companions", () => {
  it("are found with their numbers from the owner, and kept, hurt or not, from one fight to the next", async () => {
    const run = await runWith(FIXTURES);
    const owner = hero(["handler", "trainer"], { level: 3 });
    const found = companionFoundEvents([owner], run, "fight");
    expect(found).toHaveLength(1);
    let state: DndState = found.reduce(applyDndEvent, {
      actors: { [owner.id]: owner },
      combat: null,
    });
    const keeper = state.actors[owner.id] ?? owner;
    expect(keeper.companions?.[0]).toMatchObject({ maxHp: 20, hp: 20, ac: 15 });
    expect(companionFoundEvents([keeper], run, "fight")).toEqual([]);
    const [hound] = companionActors([keeper], run);
    if (!hound) throw new Error("no hound");
    const stats = deriveStats(hound, run);
    expect(stats.maxHp).toBe(20);
    expect(stats.ac).toBe(15);
    expect(stats.multiattack).toBe(2);
    expect(JSON.stringify(stats.actions)).toContain('"force"');
    // Hurt in a fight, it carries the wound out of it, and a Long Rest heals it.
    state = onMap(["...."], [at(keeper, 0, 0), at({ ...hound, hp: 7 }, 1, 0)]);
    const after = applyDndEvent(state, dndEvent(`${NS}:combatEnded`, {}));
    const back = after.actors[owner.id] ?? owner;
    expect(back.companions?.[0]?.hp).toBe(7);
    expect(after.actors[hound.id]).toBeUndefined();
    expect(companionFoundEvents([back], run, "short")).toEqual([]);
    expect(companionFoundEvents([back], run, "long")).toHaveLength(1);
  });

  it("only Dodges until its owner commands it", async () => {
    const run = await runWith(FIXTURES);
    const owner = hero(["handler"], { level: 3 });
    const empty: DndState = { actors: { [owner.id]: owner }, combat: null };
    const keeper =
      companionFoundEvents([owner], run, "fight").reduce(applyDndEvent, empty)
        .actors[owner.id] ?? owner;
    const [hound] = companionActors([keeper], run);
    if (!hound) throw new Error("no hound");
    const start = onMap(["...."], [at(keeper, 0, 0), at(hound, 1, 0)]);
    const turn = (state: DndState) =>
      (runAdvanceTurn({ ...run, state, dice }).events ?? []).reduce(
        applyDndEvent,
        state,
      );
    const idle = turn(start).actors[hound.id] ?? hound;
    const bite = deriveStats(idle, run).actions.find(
      ({ name }) => name === "Bite",
    );
    if (!bite) throw new Error("no bite");
    expect(canAfford(bite, idle, deriveStats(idle, run))).toBe(false);
    expect(
      tacticOptions(idle, turn(start), run).map(({ label }) => label),
    ).toEqual(["Dodge (attacks against you have Disadvantage)"]);
    const dodged = {
      ...idle,
      budget: { ...idle.budget, action: false },
    };
    expect(tacticOptions(dodged, turn(start), run)).toEqual([]);
    const commanded = leafEvents(
      [{ kind: "commandCompanion" }],
      "test",
      keeper,
      keeper,
      { ...run, state: start, dice },
    ).reduce(applyDndEvent, start);
    const ready = turn(commanded).actors[hound.id] ?? hound;
    expect(canAfford(bite, ready, deriveStats(ready, run))).toBe(true);
    expect(keeper.id).toBe(PLAYER_ACTOR);
  });

  it("come from a known spell at the spell's level, free of commands, wearing their owner's gear", async () => {
    const run = await runWith(FIXTURES);
    const owner = hero(["servant-caster", "horseshoes"], { level: 3 });
    const keeper =
      companionFoundEvents([owner], run, "fight").reduce<DndState>(
        applyDndEvent,
        {
          actors: { [owner.id]: owner },
          combat: null,
        },
      ).actors[owner.id] ?? owner;
    expect(keeper.companions?.[0]).toMatchObject({
      companion: "test:companion/servant",
      level: 2,
      free: true,
      maxHp: 15,
    });
    const [servant] = companionActors([keeper], run);
    if (!servant) throw new Error("no servant");
    expect(deriveStats(servant, run).speed).toBe(50);
    expect(awaitsCommand(servant, keeper)).toBe(false);
  });

  it("keeps a creature animated to last, as a golem, for later fights", async () => {
    const run = await runWith(FIXTURES);
    const maker = at(hero(["golem-maker"]), 0, 0);
    const state = onMap(["...."], [maker]);
    const animate = deriveStats(maker, run).actions.find(({ id }) =>
      id.includes("golem-maker"),
    );
    if (!animate) throw new Error("no animate");
    const made = (
      resolveAction(animate, maker, [maker], { ...run, state, dice }).events ??
      []
    ).reduce(applyDndEvent, state);
    const keeper = made.actors[PLAYER_ACTOR] ?? maker;
    expect(keeper.companions?.[0]).toMatchObject({ monster: true, free: true });
    const [golem] = companionActors([keeper], run);
    expect(golem?.source).toMatchObject({
      kind: "monster",
      calledBy: PLAYER_ACTOR,
    });
  });

  it("lets a rider with Born to the Saddle mount for 5 feet of movement", async () => {
    const run = await runWith(FIXTURES);
    const rider = at(hero(["saddle"]), 0, 0);
    const horse = monster("steed", "horse", "party");
    const mount = at(
      {
        ...horse,
        source: {
          kind: "monster",
          statBlockId: "test:monster/horse",
          calledBy: PLAYER_ACTOR,
          lasting: { feature: "test:monster/horse" },
        },
      },
      1,
      0,
    );
    const state = onMap(["...."], [rider, mount]);
    const labels = mountOptions(rider, state, run).map(({ label }) => label);
    expect(labels.some((label) => label.includes("5 ft"))).toBe(true);
  });

  it("lets a familiar deliver its owner's touch spell to a creature beside it, with its Reaction", () => {
    const owner = at(hero([]), 0, 0);
    const owl = at(
      {
        ...monster("owl", "horse", "party"),
        source: {
          kind: "monster" as const,
          statBlockId: "test:monster/horse",
          familiarOf: {
            owner: PLAYER_ACTOR,
            maxHp: 1,
            features: [],
            scaling: {},
          },
        },
      },
      10,
      0,
    );
    const foe = at(monster("foe", "horse"), 11, 0);
    const far = at(monster("far", "horse"), 14, 0);
    const state = onMap(["..............."], [owner, owl, foe, far]);
    const touch: KnownAction = {
      id: "test:spell/touch",
      name: "Touch",
      spellLevel: 1,
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: "touch", side: "enemy" },
        resolution: { kind: "automatic", damage: [], effects: [] },
      },
    } as unknown as KnownAction;
    expect(touchCourier(touch, owner, foe, state)?.id).toBe("owl");
    expect(touchCourier(touch, owner, far, state)).toBeNull();
    const spent = { ...owl, budget: { ...owl.budget, reaction: false } };
    expect(
      touchCourier(touch, owner, foe, {
        ...state,
        actors: { ...state.actors, owl: spent },
      }),
    ).toBeNull();
  });
});
