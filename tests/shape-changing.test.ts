import { describe, expect, it } from "vitest";
import { PLAYER_ACTOR } from "../engine/kernel/events.ts";
import {
  dealEvents,
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  canAfford,
  sizeOf,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { formsFor } from "../plugins/systems/dnd5.5e/core/forms.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  bareSpell,
  deriveStats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { d20Floor } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import { contextOf, hero, scripted, settle, trait } from "./feat-fixtures.ts";
import { at, block, monster, onMap, runWith } from "./senses-fixtures.ts";

// Made-up forms and traits for shape-changing (#146): ids and mechanics only.

const beast = (id: string, cr: string, fields = {}) =>
  block(id, {
    creatureType: "beast",
    text: `CR ${cr} (XP 50; PB +2)`,
    abilities: { str: 18, dex: 12, con: 14, int: 2, wis: 10, cha: 4 },
    ac: 11,
    hp: 20,
    ...fields,
  });

const SELF = { self: true };
const FIGHTER = "srd52:class/fighter";
const shift = (extra: object) => ({
  label: "Shift",
  cost: ["bonusAction"],
  targeting: SELF,
  resolution: {
    kind: "automatic",
    effects: [
      {
        kind: "polymorph",
        duration: { minutes: 60 },
        forms: {
          types: ["beast"],
          byLevel: {
            class: FIGHTER,
            tiers: [
              { level: 1, maxCr: 0.25 },
              { level: 3, maxCr: 1, fly: true },
            ],
          },
        },
        keep: ["mind", "features"],
        tempHpAmount: { bonus: { base: 7, add: [] } },
        lasting: true,
        untilIncapacitated: true,
        ...extra,
      },
    ],
  },
});

const FIXTURES = [
  beast("wolfish", "1/4"),
  beast("hawkish", "1/4", { speeds: { walk: 10, fly: 60 } }),
  beast("bearish", "1", { size: "large" }),
  block("foe"),
  trait("shifter", [], {
    activations: [
      shift({}),
      {
        label: "Leave",
        cost: ["bonusAction"],
        while: ["test:feature/shifter"],
        targeting: SELF,
        resolution: {
          kind: "automatic",
          effects: [{ kind: "endOwn", features: ["test:feature/shifter"] }],
        },
      },
    ],
  }),
  trait("floored", [], {
    activations: [shift({ acFloor: { base: 16, add: [] } })],
  }),
  trait("tough", [
    {
      kind: "modifier",
      modifier: { kind: "resistance", damage: "fire" },
    },
  ]),
  trait("starry", [
    {
      kind: "modifier",
      modifier: { kind: "resistance", damage: "cold" },
      whileAspect: "Dragon",
    },
  ]),
  trait(
    "zealot",
    [
      {
        kind: "dropToOne",
        resource: "rage",
        allies: true,
        reaction: true,
        within: 30,
        hp: { base: 7 },
      },
    ],
    { resources: [{ id: "rage", max: { base: 2 }, recharge: [] }] },
  ),
  trait("dragon", [
    {
      kind: "modifier",
      modifier: {
        kind: "checkFloor",
        value: 10,
        ability: "int",
        concentration: true,
      },
    },
  ]),
  trait("profane", [{ kind: "noComponents", school: ["necromancy"] }]),
  trait("necrosis", [
    {
      kind: "extraDamage",
      oneDieOf: "slashing",
      when: "always",
      type: "necrotic",
    },
    {
      kind: "extraDamage",
      dice: "1d4",
      when: "always",
      type: "psychic",
      targetCondition: "frightened",
    },
  ]),
  trait("misty", [], {
    activations: [
      {
        cost: [],
        targeting: SELF,
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              modifier: { kind: "actionLimit", noAttacks: true },
              duration: { minutes: 1 },
            },
          ],
        },
      },
    ],
  }),
];

const dice = { below: () => 0, roll: () => 1 };

const none = (): never => {
  throw new Error("no actor");
};

// Takes the trait's first activation and picks `form` when asked which.
async function shifted(traits: readonly string[], form: string, level = 1) {
  const run = await runWith(FIXTURES);
  const self = at(hero(traits, { level }), 0, 0);
  const state = onMap(["...."], [self, at(monster("f", "foe"), 3, 0)]);
  const action = deriveStats(self, run).actions.find((item) =>
    item.id.startsWith(`feature:test:feature/${traits[0] ?? ""}:0`),
  );
  if (!action) throw new Error("no shift action");
  const context = { ...run, state, dice };
  const cast = resolveAction(action, self, [self], context);
  const started = (cast.events ?? []).reduce(applyDndEvent, state);
  const chosen = settle(run, started, cast.frames ?? [], dice, () => form);
  const formed = chosen.state.actors[self.id];
  if (!formed) throw new Error("no actor");
  return {
    run,
    self,
    formed,
    state: chosen.state,
    decisions: chosen.decisions,
  };
}

describe("Wild Shape's forms", () => {
  it("offers Beasts up to the tier the class level reaches, flyers only from the tier that allows them", async () => {
    const run = await runWith(FIXTURES);
    const ids = (level: number) =>
      formsFor(
        {
          forms: {
            types: ["beast"],
            byLevel: {
              class: FIGHTER,
              tiers: [
                { level: 1, maxCr: 0.25 },
                { level: 3, maxCr: 1, fly: true },
              ],
            },
          },
        },
        hero([], { level }),
        run,
      ).map(({ id }) => id);
    expect(ids(1)).toContain("test:monster/wolfish");
    expect(ids(1)).not.toContain("test:monster/hawkish");
    expect(ids(1)).not.toContain("test:monster/bearish");
    expect(ids(3)).toContain("test:monster/hawkish");
    expect(ids(3)).toContain("test:monster/bearish");
  });

  it("keeps the bearer's mind, features and Hit Points, takes the Beast's body, and leaves it as a Bonus Action", async () => {
    const { run, self, formed, state } = await shifted(
      ["shifter", "tough"],
      "test:monster/wolfish",
    );
    expect(formed.tempHp).toBe(7);
    const own = deriveStats(self, run);
    const stats = deriveStats(formed, run);
    expect(stats.abilities.str).toBe(18);
    expect(stats.abilities.wis).toBe(own.abilities.wis);
    expect(stats.ac).toBe(11);
    expect(stats.maxHp).toBe(own.maxHp);
    expect(stats.passives).toContainEqual(
      expect.objectContaining({
        modifier: { kind: "resistance", damage: "fire" },
      }),
    );
    expect(stats.actions.some(({ spellLevel }) => spellLevel !== null)).toBe(
      false,
    );
    // Running out of Temporary Hit Points leaves it in the form.
    const hurt =
      applyDndEvent(
        state,
        dndEvent(`${NS}:damaged`, {
          actor: self.id,
          amount: 9,
          type: "slashing",
          critical: false,
          massive: false,
        }),
      ).actors[self.id] ?? none();
    expect(hurt.tempHp).toBe(0);
    expect(deriveStats(hurt, run).abilities.str).toBe(18);
    const leave = stats.actions.find((item) => item.name.endsWith("(Leave)"));
    if (!leave) throw new Error("no leave action");
    expect(canAfford(leave, formed, stats)).toBe(true);
    const back =
      (
        resolveAction(leave, formed, [formed], { ...run, state, dice })
          .events ?? []
      ).reduce(applyDndEvent, state).actors[self.id] ?? none();
    expect(deriveStats(back, run).abilities.str).toBe(own.abilities.str);
  });

  it("raises the form's AC to a floor, and takes the form's size", async () => {
    const { run, formed } = await shifted(
      ["floored"],
      "test:monster/bearish",
      3,
    );
    expect(deriveStats(formed, run).ac).toBe(16);
    expect(sizeOf(formed, run)).toBe(3);
  });
});

describe("transformations", () => {
  it("grows and shrinks a creature, holds a passive to its aspect, and keeps an attackless form from attacking", async () => {
    const run = await runWith(FIXTURES);
    const plain = hero(["starry", "misty"]);
    const grown: Actor = {
      ...plain,
      activeEffects: [
        {
          sourceId: "test",
          casterId: plain.id,
          modifier: { kind: "size", grow: 1 },
          ends: "spellDuration",
        },
      ],
    };
    expect(sizeOf(plain, run)).toBe(2);
    expect(sizeOf(grown, run)).toBe(3);
    const cold = (actor: Actor) =>
      deriveStats(actor, run).passives.some(
        (passive) =>
          passive.kind === "modifier" &&
          passive.modifier.kind === "resistance" &&
          passive.modifier.damage === "cold",
      );
    expect(cold(plain)).toBe(false);
    const dragon: Actor = {
      ...plain,
      activeEffects: [
        {
          sourceId: "test",
          casterId: plain.id,
          modifier: { kind: "aspect", name: "Dragon" },
          ends: "spellDuration",
        },
      ],
    };
    expect(cold(dragon)).toBe(true);
    const state: DndState = onMap([".."], [at(plain, 0, 0)]);
    const misty = deriveStats(plain, run).actions.find((item) =>
      item.id.startsWith("feature:test:feature/misty:"),
    );
    if (!misty) throw new Error("no misty action");
    const gassy =
      (
        resolveAction(misty, plain, [plain], { ...run, state, dice }).events ??
        []
      ).reduce(applyDndEvent, state).actors[plain.id] ?? none();
    const attack = deriveStats(gassy, run).actions.find(
      (item) => item.activation.resolution.kind === "attack",
    );
    if (!attack) throw new Error("no attack");
    expect(canAfford(attack, gassy, deriveStats(gassy, run))).toBe(false);
    expect(canAfford(attack, plain, deriveStats(plain, run))).toBe(true);
    expect(
      leafEvents(
        [{ kind: "endOwn", features: ["test:feature/misty"] }],
        "test",
        gassy,
        gassy,
        { ...run, state, dice },
      ).map((event) => event.kind),
    ).toEqual([`${NS}:effectEnded`]);
  });
});

describe("choices, lost bearers and hit riders", () => {
  const options = {
    kind: "choose" as const,
    duration: { minutes: 1 },
    options: [
      { name: "Enlarge", modifiers: [{ kind: "size" as const, grow: 1 }] },
      {
        name: "Reduce",
        foe: true as const,
        modifiers: [{ kind: "size" as const, grow: -1 }],
      },
    ],
  };

  it("takes the first option for a friend and the one meant for foes for a foe, when nobody is asked", async () => {
    const run = await runWith(FIXTURES);
    const caster = at(monster("caster", "foe", "party"), 0, 0);
    const friend = at(monster("friend", "foe", "party"), 1, 0);
    const foe = at(monster("baddie", "foe"), 2, 0);
    const state = onMap(["..."], [caster, friend, foe]);
    const grew = (target: Actor) =>
      leafEvents([options], "test", caster, target, {
        ...run,
        state,
        dice,
      }).reduce(applyDndEvent, state).actors[target.id];
    expect(sizeOf(grew(friend) ?? none(), run)).toBe(3);
    expect(sizeOf(grew(foe) ?? none(), run)).toBe(1);
  });

  it("turns its bearer into a monster of the other side, sooner the more it's tempted", async () => {
    const run = await runWith(FIXTURES);
    const bearer = at(hero([]), 0, 0);
    const doom = {
      kind: "becomeMonster" as const,
      monster: "test:monster/foe",
      chance: 50,
      counter: "doom",
    };
    let state: DndState = onMap([".."], [bearer]);
    const once = (roll: number) => {
      const context = { ...run, state, dice: scripted([roll]).dice };
      const self = state.actors[PLAYER_ACTOR] ?? none();
      state = leafEvents([doom], "test", self, self, context).reduce(
        applyDndEvent,
        state,
      );
    };
    once(60);
    expect(state.actors[`${PLAYER_ACTOR}:lost`]).toBeUndefined();
    once(60);
    const lost = state.actors[`${PLAYER_ACTOR}:lost`] ?? none();
    expect(lost.side).toBe("enemy");
    expect(lost.position).toEqual({ x: 0, y: 0 });
  });

  it("lets a bearer spend its Reaction to hold an ally in reach at its Hit Points, and floors its Concentration saves", async () => {
    const run = await runWith(FIXTURES);
    const zealot = at(hero(["zealot", "dragon"]), 0, 0);
    const near = at({ ...hero([], { id: "near" }), hp: 3 }, 1, 0);
    const far = at({ ...hero([], { id: "far" }), hp: 3 }, 8, 0);
    const state = onMap([".........."], [zealot, near, far]);
    const context = { ...run, state, dice };
    const hp = (target: Actor) =>
      dealEvents(
        target,
        [{ amount: 5, type: "slashing" }],
        false,
        context,
      ).events.reduce(applyDndEvent, state).actors[target.id]?.hp;
    expect(hp(near)).toBe(7);
    expect(hp(far)).toBe(0);
    const stats = deriveStats(zealot, run);
    expect(d20Floor(zealot, stats, true)).toBe(10);
    expect(d20Floor(zealot, stats)).toBe(1);
    expect(bareSpell(hero(["profane"]), "necromancy", run)).toBe(true);
    expect(bareSpell(hero(["profane"]), "evocation", run)).toBe(false);
  });

  it("adds a die of the hit's own damage, and damage against a Frightened target only", async () => {
    const run = await runWith(FIXTURES);
    const attacker = at(hero(["necrosis"]), 0, 0);
    const hit = (frightened: boolean) => {
      const foe = at(
        {
          ...hero([], { id: "foe" }),
          side: "enemy" as const,
          hp: 40,
          activeEffects: frightened
            ? [
                {
                  sourceId: "test",
                  casterId: "x",
                  modifier: {
                    kind: "condition" as const,
                    condition: "frightened" as const,
                  },
                  ends: "spellDuration" as const,
                },
              ]
            : [],
        },
        1,
        0,
      );
      const result = run.system.frames[`${NS}:applyHit`]?.run(
        {
          attacker: PLAYER_ACTOR,
          actionId: "weapon:srd52:item/longsword",
          target: "foe",
          critical: false,
          hadAdvantage: false,
          total: 20,
          natural: 15,
        },
        contextOf(run, [attacker, foe], scripted([]).dice),
      );
      return (result?.events ?? []).flatMap((event) =>
        event.kind === `${NS}:damaged` && "payload" in event
          ? [(event.payload as { type: string }).type]
          : [],
      );
    };
    expect(hit(false)).toContain("necrotic");
    expect(hit(false)).not.toContain("psychic");
    expect(hit(true)).toContain("psychic");
  });
});
