import { describe, expect, it } from "vitest";
import {
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
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { hero, settle, trait } from "./feat-fixtures.ts";
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
