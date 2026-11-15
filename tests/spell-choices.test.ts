import {
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { runConfusedTurn } from "../plugins/systems/dnd5.5e/core/combat/confusion.ts";
import { dealEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  findAction,
  moveSquares,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  ClassSchema,
  PregenSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  NS,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  modifierFor,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { scripted, settle } from "./feat-fixtures.ts";

// The spells of #114 and #115: weapon attacks made or changed by a spell, damage types picked as they're cast,
// rolled outcomes, a duel and Wish's copy of another spell.

const need = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) throw new Error("missing");
  return value;
};
const HIGH: Dice = { below: () => 0, roll: (sides) => sides };
const LOW: Dice = { below: () => 0, roll: () => 1 };
const srd = (slug: string): string => `srd52:spell/${slug}`;
const DC = { add: [{ kind: "spellSaveDc" }] };

// Spells only the Player's Handbook has, as ids and numbers, so the tests run without the private books.
const test = (slug: string, fields: Record<string, unknown>) => ({
  id: `test:spell/${slug}`,
  name: slug,
  school: "evocation",
  classes: [],
  castingTime: "Bonus Action",
  range: "Self",
  components: "V",
  duration: "instantaneous",
  text: "Test spell.",
  automation: "full",
  ...fields,
});
const SPELLS = [
  test("hail-of-thorns", {
    level: 1,
    activation: {
      cost: ["bonusAction", "slot"],
      trigger: { afterHit: "rangedWeapon" },
      targeting: {
        area: { shape: "sphere", radius: 5 },
        range: "self",
        side: "enemy",
      },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: DC,
        damage: [{ amount: { dice: "1d10" }, type: "piercing" }],
        onSuccessDamage: "half",
      },
    },
    upcast: { perSlotLevel: { addDice: "1d10" } },
  }),
  test("lightning-arrow", {
    level: 3,
    activation: {
      cost: ["bonusAction", "slot"],
      trigger: {
        afterHit: "rangedWeapon",
        replacesHit: [{ amount: { dice: "4d8" }, type: "lightning" }],
      },
      targeting: {
        area: { shape: "sphere", radius: 10 },
        range: "self",
        side: "enemy",
      },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: DC,
        damage: [{ amount: { dice: "2d8" }, type: "lightning" }],
        onSuccessDamage: "half",
      },
    },
    upcast: { perSlotLevel: { addDice: "1d8" } },
  }),
  test("swift-quiver", {
    level: 5,
    duration: { concentration: true, minutes: 1 },
    activation: {
      cost: ["bonusAction", "slot"],
      targeting: { creatures: 1, range: 5, side: "enemy" },
      resolution: {
        kind: "automatic",
        effects: [{ kind: "weaponAttack", times: 2, change: { ranged: true } }],
      },
    },
    lasting: {
      cost: ["bonusAction"],
      targeting: { creatures: 1, range: 5, side: "enemy" },
      resolution: {
        kind: "automatic",
        effects: [{ kind: "weaponAttack", times: 2, change: { ranged: true } }],
      },
    },
  }),
  test("elemental-weapon", {
    level: 3,
    activation: {
      cost: ["action", "slot"],
      targeting: { creatures: 1, range: "touch", side: "ally" },
      resolution: {
        kind: "automatic",
        effects: [
          {
            kind: "modifier",
            modifier: {
              kind: "bonus",
              to: "attacks",
              amount: { bonus: { base: 1 } },
            },
            duration: { concentration: true, minutes: 60 },
          },
          {
            kind: "modifier",
            modifier: {
              kind: "hitDamage",
              dealtBy: "bearer",
              weaponOnly: true,
              damage: { amount: { dice: "1d4" }, type: "acid" },
            },
            duration: { concentration: true, minutes: 60 },
            choose: ["acid", "cold", "fire", "lightning", "thunder"],
          },
        ],
      },
    },
  }),
  test("dragon-s-breath", {
    level: 2,
    activation: {
      cost: ["bonusAction", "slot"],
      targeting: { creatures: 1, range: "touch", side: "ally" },
      resolution: {
        kind: "automatic",
        effects: [
          {
            kind: "modifier",
            modifier: { kind: "grantedAction", damage: "acid" },
            duration: { concentration: true, minutes: 1 },
            choose: ["acid", "cold", "fire", "lightning", "poison"],
          },
        ],
      },
    },
    granted: {
      cost: ["action"],
      targeting: {
        area: { shape: "cone", radius: 15 },
        range: "self",
        side: "enemy",
      },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: DC,
        damage: [{ amount: { dice: "3d6" }, type: "acid" }],
        onSuccessDamage: "half",
      },
    },
    upcast: { perSlotLevel: { addDice: "1d6" } },
  }),
  test("compelled-duel", {
    level: 1,
    activation: {
      cost: ["bonusAction", "slot"],
      targeting: { creatures: 1, range: 30, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "wis",
        dc: DC,
        onFail: [
          {
            kind: "modifier",
            modifier: { kind: "duel" },
            duration: { concentration: true, minutes: 1 },
          },
        ],
      },
    },
  }),
];

async function arena(): Promise<RunContext> {
  const base = (await loadAdventure("goblin-ambush")).run;
  const slots = [4, 3, 3, 3, 3, 2, 2, 1, 1];
  const wizard = ClassSchema.parse(base.content("srd52:class/wizard"));
  const [first] = wizard.levels;
  if (!first) throw new Error("The wizard has no levels");
  const content: Record<string, unknown> = {
    "srd52:class/wizard": {
      ...wizard,
      levels: Array.from({ length: 20 }, (_, index) => ({
        ...(index === 0 ? first : { grants: [], choices: [], scaling: {} }),
        level: index + 1,
        slots,
      })),
    },
    "srd52:monster/dummy": {
      id: "srd52:monster/dummy",
      name: "Dummy",
      ac: 10,
      hp: 500,
      speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      proficiency: 2,
      initiative: 0,
      actions: [
        {
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
        },
      ],
    },
    ...Object.fromEntries(SPELLS.map((entry) => [entry.id, entry])),
  };
  return {
    ...base,
    content: (id) =>
      (content[id] as ReturnType<RunContext["content"]>) ?? base.content(id),
    contentIds: () => [
      ...new Set([...base.contentIds(), ...Object.keys(content)]),
    ],
  };
}

function caster(
  run: RunContext,
  spells: readonly string[],
  {
    id = PLAYER_ACTOR,
    level = 1,
    inventory = ["srd52:item/longsword"],
    at = { x: 0, y: 0 },
  }: {
    readonly id?: string;
    readonly level?: number;
    readonly inventory?: readonly string[];
    readonly at?: { x: number; y: number };
  } = {},
): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  return {
    ...freshActor({
      id,
      name: id,
      side: "party",
      source: {
        kind: "character",
        build: {
          ...pregen.build,
          levels: Array.from({ length: level }, () => ({
            ...first,
            answers: [{ kind: "spells" as const, values: [...spells] }],
          })),
        },
      },
      hp: 100,
      inventory: [...inventory],
    }),
    position: at,
  };
}

function foe(id: string, at: { x: number; y: number }): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId: "srd52:monster/dummy" },
      hp: 500,
      inventory: [],
    }),
    position: at,
  };
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
      grid: { width: 20, height: 20 },
    },
  };
}

const ctx = (run: RunContext, state: DndState, dice: Dice) => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});
const act = (actor: string, answer: string): Frame => ({
  kind: `${NS}:takeAction`,
  payload: { actor, answer },
});
const hitBy = (
  attacker: string,
  actionId: string,
  target: string,
  critical = false,
): Frame => ({
  kind: `${NS}:applyHit`,
  payload: {
    attacker,
    actionId,
    target,
    critical,
    hadAdvantage: false,
    total: 30,
    natural: 15,
  },
});

function damageOf(events: readonly SystemEvent[], actor: string): number[] {
  return events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    event.payload.actor === actor
      ? [Number(event.payload.amount)]
      : [],
  );
}
const typesOf = (events: readonly SystemEvent[], actor: string): string[] =>
  events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    event.payload.actor === actor
      ? [String(event.payload.type)]
      : [],
  );
const effectsOf = (state: DndState, id: string): readonly ActiveEffect[] =>
  state.actors[id]?.activeEffects ?? [];
const modifiersOf = (state: DndState, id: string) =>
  effectsOf(state, id).map(({ modifier }) => modifier);

const WEAPON = "weapon:srd52:item/longsword";
const BOW = "weapon:srd52:item/shortbow";

describe("a weapon attack made or changed by a spell", () => {
  it("makes True Strike's attack with the spellcasting ability, as Radiant damage, growing with level", async () => {
    const run = await arena();
    const hero = caster(run, [srd("true-strike")], { level: 5 });
    const state = fight(hero, foe("a", { x: 1, y: 0 }));
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${srd("true-strike")}|a`)],
      HIGH,
    );
    const mod = modifierFor(
      deriveStats(hero, run),
      deriveStats(hero, run).spellAbility ?? "int",
    );
    // The highest rolls are a Critical Hit: a longsword's d8 and the fifth level's extra d6 doubled, and the caster's
    // modifier.
    expect(damageOf(cast.events, "a")).toEqual([16 + mod + 12]);
    expect(typesOf(cast.events, "a")).toEqual(["radiant"]);
    // It was for that attack only.
    expect(
      modifiersOf(cast.state, PLAYER_ACTOR).some(
        ({ kind }) => kind === "weaponSpell",
      ),
    ).toBe(false);
    expect(cast.state.actors[PLAYER_ACTOR]?.budget.action).toBe(false);
  });

  it("can't cast True Strike without a weapon", async () => {
    const run = await arena();
    const hero = caster(run, [srd("true-strike")], { inventory: [] });
    expect(
      deriveStats(hero, run).actions.some(
        ({ id }) => id === `spell:${srd("true-strike")}`,
      ),
    ).toBe(false);
  });

  it("makes Shillelagh's staff a d8 of Force with the spellcasting ability, a d10 from level 5", async () => {
    const run = await arena();
    for (const [level, die] of [
      [1, "1d8"],
      [5, "1d10"],
    ] as const) {
      const hero = caster(run, [srd("shillelagh")], {
        level,
        inventory: ["srd52:item/quarterstaff", "srd52:item/longsword"],
      });
      const state = fight(hero, foe("a", { x: 1, y: 0 }));
      const cast = settle(
        run,
        state,
        [act(PLAYER_ACTOR, `spell:${srd("shillelagh")}|${PLAYER_ACTOR}`)],
        HIGH,
      );
      const after = cast.state.actors[PLAYER_ACTOR];
      if (!after) throw new Error("no hero");
      const stats = deriveStats(after, run);
      const staff = findAction(
        after,
        "weapon:srd52:item/quarterstaff",
        ctx(run, cast.state, HIGH),
      ).activation.resolution;
      const sword = findAction(after, WEAPON, ctx(run, cast.state, HIGH))
        .activation.resolution;
      if (staff.kind !== "attack" || sword.kind !== "attack") {
        throw new Error("not attacks");
      }
      expect(staff.attack.ability).toBe(stats.spellAbility);
      expect(staff.damage[0]?.amount.dice).toBe(die);
      expect(staff.damage[0]?.type).toBe("force");
      expect(sword.damage[0]?.type).toBe("slashing"); // only the staff changes
    }
  });

  it("makes Swift Quiver's two ranged attacks on the cast and on each Bonus Action after", async () => {
    const run = await arena();
    const hero = caster(run, ["test:spell/swift-quiver"], {
      level: 9,
      inventory: ["srd52:item/shortbow", "srd52:item/longsword"],
    });
    const state = fight(hero, foe("a", { x: 4, y: 0 }));
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "spell:test:spell/swift-quiver|a")],
      HIGH,
    );
    expect(damageOf(cast.events, "a")).toHaveLength(2);
    const after = cast.state.actors[PLAYER_ACTOR];
    expect(after?.concentratingOn).toBe("spell:test:spell/swift-quiver");
    const lasting = deriveStats(need(after), run).actions.find(
      ({ id }) => id === "lasting:test:spell/swift-quiver",
    );
    expect(lasting?.activation.cost).toEqual(["bonusAction"]);
  });
});

describe("a spell on a ranged weapon's hit", () => {
  it("rains Hail of Thorns on the creature hit and those beside it, never on a melee hit", async () => {
    const run = await arena();
    const hero = caster(run, ["test:spell/hail-of-thorns"], {
      inventory: ["srd52:item/shortbow", "srd52:item/longsword"],
    });
    const state = fight(
      hero,
      foe("a", { x: 6, y: 0 }),
      foe("b", { x: 7, y: 0 }),
      foe("c", { x: 12, y: 0 }),
    );
    const hail = settle(run, state, [hitBy(PLAYER_ACTOR, BOW, "a")], HIGH);
    expect(hail.decisions[0]?.id).toBe(`${NS}:afterHit:${PLAYER_ACTOR}`);
    // The bow's own hit, then a d10 halved by each save made with the highest roll.
    expect(damageOf(hail.events, "a")).toHaveLength(2);
    expect(damageOf(hail.events, "b")).toEqual([5]);
    expect(damageOf(hail.events, "c")).toEqual([]);
    const melee = settle(
      run,
      { ...state, actors: { ...state.actors, a: foe("a", { x: 1, y: 0 }) } },
      [hitBy(PLAYER_ACTOR, WEAPON, "a")],
      HIGH,
    );
    expect(melee.decisions).toEqual([]);
  });

  it("turns a hit into Lightning Arrow's bolt, and a miss into half of it, with a burst round the target", async () => {
    const run = await arena();
    const hero = caster(run, ["test:spell/lightning-arrow"], {
      level: 5,
      inventory: ["srd52:item/shortbow"],
    });
    const state = fight(
      hero,
      foe("a", { x: 6, y: 0 }),
      foe("b", { x: 8, y: 0 }),
    );
    const bolt = settle(run, state, [hitBy(PLAYER_ACTOR, BOW, "a")], HIGH);
    expect(bolt.decisions[0]?.id).toBe(
      `${NS}:afterHit:${PLAYER_ACTOR}:instead`,
    );
    expect(damageOf(bolt.events, "a")).toEqual([32]); // 4d8, and no arrow
    expect(typesOf(bolt.events, "a")).toEqual(["lightning"]);
    expect(damageOf(bolt.events, "b")).toEqual([8]); // 2d8 halved by a save
    expect(bolt.state.actors[PLAYER_ACTOR]?.resourcesSpent).toEqual({
      "slot:3": 1,
    });
    // An upcast adds a d8 to both.
    const upcast = settle(
      run,
      state,
      [hitBy(PLAYER_ACTOR, BOW, "a")],
      HIGH,
      (decision) =>
        decision.options.find(({ id }) => id.endsWith("|4"))?.id ?? "",
    );
    expect(damageOf(upcast.events, "a")).toEqual([40]);
    // A miss: the attack roll fails, and the bolt still lands for half.
    const missed = settle(
      run,
      state,
      [
        {
          kind: `${NS}:attackRoll`,
          payload: { attacker: PLAYER_ACTOR, actionId: BOW, target: "a" },
        },
      ],
      LOW,
    );
    expect(damageOf(missed.events, "a")).toEqual([2]); // 4d8 at 1 each, halved
    // Declined, the hit lands as it was.
    const kept = settle(
      run,
      state,
      [hitBy(PLAYER_ACTOR, BOW, "a")],
      HIGH,
      (decision) => decision.options.at(-1)?.id ?? "",
    );
    expect(typesOf(kept.events, "a")).toEqual(["piercing"]);
  });
});

describe("a damage type picked as the spell is cast", () => {
  it("keeps Protection from Energy's choice in its effect", async () => {
    const run = await arena();
    const hero = caster(run, [srd("protection-from-energy")], { level: 5 });
    const cast = settle(
      run,
      fight(hero, foe("a", { x: 5, y: 5 })),
      [
        act(
          PLAYER_ACTOR,
          `spell:${srd("protection-from-energy")}|${PLAYER_ACTOR}`,
        ),
      ],
      HIGH,
      (decision) => (decision.id.startsWith(`${NS}:damageType:`) ? "cold" : ""),
    );
    const asked = cast.decisions.find(({ id }) =>
      id.startsWith(`${NS}:damageType:`),
    );
    expect(asked?.options.map(({ id }) => id)).toEqual([
      "acid",
      "cold",
      "fire",
      "lightning",
      "thunder",
    ]);
    expect(modifiersOf(cast.state, PLAYER_ACTOR)).toContainEqual({
      kind: "resistance",
      damage: "cold",
    });
    expect(cast.state.actors[PLAYER_ACTOR]?.concentratingOn).toBe(
      `spell:${srd("protection-from-energy")}`,
    );
  });

  it("takes a d4 off Resistance's type once a turn", async () => {
    const run = await arena();
    const hero = caster(run, [srd("resistance")]);
    const cast = settle(
      run,
      fight(hero, foe("a", { x: 5, y: 5 })),
      [act(PLAYER_ACTOR, `spell:${srd("resistance")}|${PLAYER_ACTOR}`)],
      HIGH,
      (decision) => (decision.id.includes("damageType") ? "fire" : ""),
    );
    const bearer = need(cast.state.actors[PLAYER_ACTOR]);
    const first = dealEvents(
      bearer,
      [
        { amount: 10, type: "fire" },
        { amount: 10, type: "fire" },
        { amount: 10, type: "cold" },
      ],
      false,
      ctx(run, cast.state, HIGH),
    );
    expect(damageOf(first.events, PLAYER_ACTOR)).toEqual([6, 10, 10]);
  });

  it("sets both of Fire Shield's types with one choice", async () => {
    const run = await arena();
    const hero = caster(run, [srd("fire-shield")], { level: 7 });
    const cast = settle(
      run,
      fight(hero, foe("a", { x: 5, y: 5 })),
      [act(PLAYER_ACTOR, `spell:${srd("fire-shield")}|${PLAYER_ACTOR}`)],
      HIGH,
      (decision) => (decision.id.includes("damageType") ? "fire" : ""),
    );
    const asked = cast.decisions.find(({ id }) => id.includes("damageType"));
    expect(asked?.options.map(({ label }) => label)).toEqual([
      "Resistance to Cold, Fire damage to attackers",
      "Resistance to Fire, Cold damage to attackers",
    ]);
    expect(modifiersOf(cast.state, PLAYER_ACTOR)).toEqual([
      { kind: "resistance", damage: "fire" },
      {
        kind: "retaliate",
        damage: [{ amount: { dice: "2d8" }, type: "cold" }],
      },
    ]);
  });

  it("gives Elemental Weapon's bearer a bonus to hit and a die of the chosen type", async () => {
    const run = await arena();
    const hero = caster(run, ["test:spell/elemental-weapon"], { level: 5 });
    const friend = caster(run, [], { id: "b", at: { x: 1, y: 1 } });
    const cast = settle(
      run,
      fight(hero, friend, foe("a", { x: 5, y: 5 })),
      [act(PLAYER_ACTOR, "spell:test:spell/elemental-weapon|b")],
      HIGH,
      (decision) => (decision.id.includes("damageType") ? "thunder" : ""),
    );
    expect(modifiersOf(cast.state, "b")).toEqual([
      { kind: "bonus", to: "attacks", amount: { bonus: { base: 1, add: [] } } },
      {
        kind: "hitDamage",
        dealtBy: "bearer",
        weaponOnly: true,
        damage: { amount: { dice: "1d4" }, type: "thunder" },
      },
    ]);
  });

  it("gives Dragon's Breath's target a breath of the chosen type at the caster's DC and slot", async () => {
    const run = await arena();
    const hero = caster(run, ["test:spell/dragon-s-breath"], { level: 5 });
    const friend = caster(run, [], { id: "b", at: { x: 1, y: 1 } });
    const cast = settle(
      run,
      fight(hero, friend, foe("a", { x: 3, y: 3 })),
      [act(PLAYER_ACTOR, "spell:test:spell/dragon-s-breath|b|3")],
      HIGH,
      (decision) => (decision.id.includes("damageType") ? "cold" : ""),
    );
    const breather = need(cast.state.actors.b);
    const breath = deriveStats(breather, run).actions.find(({ id }) =>
      id.startsWith("granted:"),
    );
    const { resolution } = breath?.activation ?? {};
    if (resolution?.kind !== "save") throw new Error("no breath");
    expect(resolution.dc.base).toBe(
      8 +
        deriveStats(hero, run).proficiency +
        modifierFor(
          deriveStats(hero, run),
          deriveStats(hero, run).spellAbility ?? "int",
        ),
    );
    expect(resolution.damage).toEqual([
      { amount: { dice: "4d6" }, type: "cold" },
    ]);
    // Breathing hurts the foe in the cone.
    const breathed = settle(
      run,
      cast.state,
      [act("b", `${need(breath).id}|@3,3`)],
      HIGH,
    );
    expect(typesOf(breathed.events, "a")).toEqual(["cold"]);
  });
});

describe("rolled outcomes", () => {
  const confused = (state: DndState, roll: readonly number[]) => {
    const run = arena();
    return run.then((context) => {
      const { dice } = scripted(roll);
      return {
        run: context,
        result: runConfusedTurn(ctx(context, state, dice)),
      };
    });
  };
  const confusedState = async () => {
    const run = await arena();
    const victim: Actor = {
      ...foe("a", { x: 5, y: 5 }),
      activeEffects: [
        {
          sourceId: `spell:${srd("confusion")}`,
          casterId: PLAYER_ACTOR,
          modifier: { kind: "confused" },
          ends: "concentration",
          repeatSave: { ability: "wis", dc: 15 },
        },
      ],
    };
    const state = fight(victim, caster(run, [], { at: { x: 6, y: 5 } }));
    return state;
  };
  const kinds = (events: readonly SystemEvent[] = []) =>
    events.map((event) => event.kind);

  it("widens Confusion's Sphere by 5 feet for each slot level above 4", async () => {
    const run = await arena();
    const hero = caster(run, [srd("confusion")], { level: 9 });
    const state = fight(hero, foe("a", { x: 5, y: 5 }));
    const { targeting } = findAction(
      hero,
      `spell:${srd("confusion")}`,
      ctx(run, state, HIGH),
      6,
    ).activation;
    expect("area" in targeting ? targeting.area.radius : 0).toBe(20);
  });

  it("rolls Confusion's d10 as the turn starts and keeps it in an event", async () => {
    const state = await confusedState();
    const still = await confused(state, [4]);
    const events = still.result.events ?? [];
    expect(events[0]).toMatchObject({
      kind: `${NS}:dieRolled`,
      payload: { actor: "a", die: 10, rolled: 4 },
    });
    // 2-6: no move and no action, nor Bonus Action or Reaction.
    expect(kinds(events)).toContain(`${NS}:effectAdded`);
    const spent = events.flatMap((event) =>
      event.kind === `${NS}:budgetSpent` && "payload" in event
        ? [event.payload.kind]
        : [],
    );
    expect(spent.sort()).toEqual(["action", "bonusAction", "reaction"]);
    const free = await confused(state, [10]);
    expect(
      (free.result.events ?? []).flatMap((event) =>
        event.kind === `${NS}:budgetSpent` && "payload" in event
          ? [event.payload.kind]
          : [],
      ),
    ).toEqual(["reaction", "bonusAction"]);
  });

  it("sends a confused creature wandering on a 1, and at a random neighbour on a 7", async () => {
    const state = await confusedState();
    const wander = await confused(state, [1, 2]); // east
    const moved = (wander.result.events ?? []).find(
      (event) => event.kind === `${NS}:moved`,
    );
    expect(moved && "payload" in moved ? moved.payload.to : null).toEqual({
      x: 11,
      y: 5,
    });
    const lash = await confused(state, [7, 1]);
    expect(lash.result.frames?.[0]).toMatchObject({
      kind: `${NS}:attackRoll`,
      payload: { attacker: "a", target: PLAYER_ACTOR },
    });
  });

  const rays = (d8s: readonly number[]): Dice => {
    const queue = [...d8s];
    return {
      below: () => 0,
      roll: (sides) => (sides === 8 ? (queue.shift() ?? 1) : 1),
    };
  };

  it("strikes each creature in Prismatic Spray's cone with its own rolled ray", async () => {
    const run = await arena();
    const hero = caster(run, [srd("prismatic-spray")], { level: 13 });
    const state = fight(
      hero,
      foe("a", { x: 2, y: 0 }),
      foe("b", { x: 3, y: 0 }),
    );
    const sprayed = settle(
      run,
      state,
      [
        {
          kind: `${NS}:useAction`,
          payload: {
            actor: PLAYER_ACTOR,
            actionId: `spell:${srd("prismatic-spray")}`,
            target: "a",
          },
        },
      ],
      // a: red; b: an 8, then indigo and violet. Every other die rolls a 1, so each save fails.
      rays([1, 8, 6, 7]),
    );
    const rolls = sprayed.events.flatMap((event) =>
      event.kind === `${NS}:dieRolled` && "payload" in event
        ? [[event.payload.actor, event.payload.rolled]]
        : [],
    );
    expect(rolls).toEqual([
      ["a", 1],
      ["b", 8],
      ["b", 6],
      ["b", 7],
    ]);
    expect(typesOf(sprayed.events, "a")).toEqual(["fire"]);
    const b = effectsOf(sprayed.state, "b");
    const restrained = b.find(
      ({ modifier }) =>
        modifier.kind === "condition" && modifier.condition === "restrained",
    );
    expect(restrained?.secondFailure).toMatchObject({
      condition: "petrified",
      count: 3,
    });
    expect(restrained?.repeatSave?.ability).toBe("con");
    const blinded = b.find(
      ({ modifier }) =>
        modifier.kind === "condition" && modifier.condition === "blinded",
    );
    expect(blinded?.banish?.ability).toBe("wis");
  });

  it("petrifies on Prismatic Spray's third failed indigo save, and keeps count until then", async () => {
    const run = await arena();
    const hero = caster(run, []);
    let state = fight(
      {
        ...foe("a", { x: 2, y: 0 }),
        activeEffects: [
          {
            sourceId: `spell:${srd("prismatic-spray")}`,
            casterId: PLAYER_ACTOR,
            modifier: { kind: "condition", condition: "restrained" },
            ends: "spellDuration",
            repeatSave: { ability: "con", dc: 30 },
            secondFailure: {
              condition: "petrified",
              ends: "spellDuration",
              count: 3,
            },
          },
        ],
      },
      hero,
    );
    const finish: Frame = { kind: `${NS}:finishTurn`, payload: {} };
    for (const failed of [1, 2]) {
      state = settle(run, state, [finish], LOW).state;
      // finishTurn moves the turn on; bring it back to the restrained creature.
      state = { ...state, combat: { ...need(state.combat), index: 0 } };
      const effect = effectsOf(state, "a")[0];
      expect(effect?.tally).toEqual({ saved: 0, failed });
    }
    state = settle(run, state, [finish], LOW).state;
    expect(modifiersOf(state, "a")).toEqual([
      { kind: "condition", condition: "petrified" },
    ]);
  });

  it("banishes a creature Prismatic Spray's violet ray blinded once it fails the save on the caster's next turn", async () => {
    const run = await arena();
    const hero = caster(run, []);
    const state: DndState = {
      ...fight(
        {
          ...foe("a", { x: 2, y: 0 }),
          activeEffects: [
            {
              sourceId: `spell:${srd("prismatic-spray")}`,
              casterId: PLAYER_ACTOR,
              modifier: { kind: "condition", condition: "blinded" },
              ends: "spellDuration",
              banish: { ability: "wis", dc: 30 },
            },
          ],
        },
        hero,
      ),
    };
    const advanced = settle(
      run,
      state,
      [{ kind: `${NS}:advanceTurn`, payload: {} }],
      LOW,
    );
    expect(modifiersOf(advanced.state, "a")).toEqual([{ kind: "sealed" }]);
  });
});

describe("Compelled Duel", () => {
  const dueled = async () => {
    const run = await arena();
    const hero = caster(run, ["test:spell/compelled-duel"]);
    const state = fight(
      foe("a", { x: 1, y: 0 }),
      hero,
      caster(run, [], { id: "b", at: { x: 1, y: 1 } }),
      foe("c", { x: 2, y: 0 }),
    );
    const cast = settle(
      run,
      { ...state, combat: { ...need(state.combat), index: 1 } },
      [act(PLAYER_ACTOR, "spell:test:spell/compelled-duel|a")],
      LOW, // the target fails its save
    );
    return { run, state: cast.state };
  };

  it("gives the target Disadvantage on attacks against anyone but the caster", async () => {
    const { run, state } = await dueled();
    expect(modifiersOf(state, "a")).toContainEqual({ kind: "duel", feet: 30 });
    const club = deriveStats(need(state.actors.a), run).actions[0]?.id ?? "";
    // Two d20s, the lower kept: a 20 and a 1 miss anyone but the caster.
    const hampered = (target: string): boolean => {
      const queue = [20, 1];
      const rolled = settle(
        run,
        state,
        [
          {
            kind: `${NS}:attackRoll`,
            payload: { attacker: "a", actionId: club, target },
          },
        ],
        {
          below: () => 0,
          roll: (sides) => (sides === 20 ? (queue.shift() ?? 1) : 1),
        },
        (decision) => decision.options.at(-1)?.id ?? "",
      );
      return damageOf(rolled.events, target).length === 0;
    };
    expect(hampered("b")).toBe(true);
    expect(hampered(PLAYER_ACTOR)).toBe(false);
  });

  it("keeps the target within 30 feet of the caster", async () => {
    const { run, state } = await dueled();
    const target = need(state.actors.a);
    const squares = moveSquares(target, state, deriveStats(target, run), run);
    expect(squares.length).toBeGreaterThan(0);
    expect(
      squares.every(
        ({ square }) => Math.max(Math.abs(square.x), square.y) <= 6,
      ),
    ).toBe(true);
  });

  it("ends when the caster attacks someone else, or an ally hurts the target", async () => {
    const { run, state } = await dueled();
    const turned = settle(
      run,
      state,
      [
        {
          kind: `${NS}:attackRoll`,
          payload: { attacker: PLAYER_ACTOR, actionId: WEAPON, target: "c" },
        },
      ],
      HIGH,
    );
    expect(turned.state.actors[PLAYER_ACTOR]?.concentratingOn).toBeNull();
    expect(modifiersOf(turned.state, "a")).toEqual([]);
    const helped = settle(run, state, [hitBy("b", WEAPON, "a")], HIGH);
    expect(modifiersOf(helped.state, "a")).toEqual([]);
    const own = settle(run, state, [hitBy(PLAYER_ACTOR, WEAPON, "a")], HIGH);
    expect(modifiersOf(own.state, "a")).toContainEqual({
      kind: "duel",
      feet: 30,
    });
  });
});

describe("Wish", () => {
  it("lists the spells it can copy, and casts the chosen one free", async () => {
    const run = await arena();
    const hero = caster(run, [srd("wish")], { level: 17 });
    const state = fight(hero, foe("a", { x: 4, y: 0 }));
    const wished = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${srd("wish")}|${PLAYER_ACTOR}`)],
      HIGH,
      (decision: Decision) =>
        decision.id.startsWith(`${NS}:wish:`) ? srd("fireball") : "",
    );
    const offered = wished.decisions[0]?.options ?? [];
    const levels = offered.map(({ label }) =>
      Number(/level (\d)/.exec(label)?.[1]),
    );
    expect(Math.max(...levels)).toBeLessThanOrEqual(8);
    expect(levels).toEqual([...levels].sort((a, b) => b - a));
    expect(offered.some(({ id }) => id === srd("wish"))).toBe(false);
    const after = need(wished.state.actors[PLAYER_ACTOR]);
    const copy = deriveStats(after, run).actions.find(
      ({ id }) => id === `spell:${srd("fireball")}`,
    );
    expect(copy?.activation.cost).toEqual([]);
    const cast = settle(
      run,
      wished.state,
      [act(PLAYER_ACTOR, `spell:${srd("fireball")}|@4,0`)],
      HIGH,
    );
    expect(damageOf(cast.events, "a").length).toBe(1);
    // Once cast, it's gone, and it spent no slot of its own.
    expect(
      modifiersOf(cast.state, PLAYER_ACTOR).some(
        ({ kind }) => kind === "wished",
      ),
    ).toBe(false);
    expect(cast.state.actors[PLAYER_ACTOR]?.resourcesSpent).toEqual({
      "slot:9": 1,
    });
  });
});
