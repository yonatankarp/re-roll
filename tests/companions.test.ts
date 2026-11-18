import { describe, expect, it } from "vitest";
import { PLAYER_ACTOR } from "../engine/kernel/events.ts";
import { tacticOptions } from "../plugins/systems/dnd5.5e/core/actions.ts";
import {
  companionActors,
  companionFoundEvents,
} from "../plugins/systems/dnd5.5e/core/combat/companions.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { canAfford } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { runAdvanceTurn } from "../plugins/systems/dnd5.5e/core/combat/turn.ts";
import {
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { hero, trait } from "./feat-fixtures.ts";
import { at, onMap, runWith } from "./senses-fixtures.ts";

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
});
