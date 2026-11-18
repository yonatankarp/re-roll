import {
  AWAIT_FRAME,
  type Decision,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { castRiders } from "../plugins/systems/dnd5.5e/core/combat/school.ts";
import { wishFrame } from "../plugins/systems/dnd5.5e/core/combat/wish.ts";
import {
  type Actor,
  applyDndEvent,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { gainRolls } from "../plugins/systems/dnd5.5e/core/gear.ts";
import {
  LeafEffectSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  deriveStats,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// Tables and features of the test's own for #177's random tables: ids and mechanics only.
const TABLE = "test:feature/table";
const heal = (amount: number) => ({
  kind: "automatic",
  damage: [],
  effects: [{ kind: "heal", amount: { bonus: { base: amount } } }],
});
const CONTENT = [
  trait("table", [], {
    table: {
      die: 4,
      rows: [
        {
          min: 1,
          max: 2,
          harmful: true,
          targets: ["self"],
          resolution: heal(1),
        },
        { min: 3, max: 4, targets: ["self"], resolution: heal(5) },
      ],
    },
  }),
  trait("surge", [
    {
      kind: "castRider",
      classes: ["wizard"],
      chance: { die: 20, at: 20 },
      rollTable: TABLE,
    },
  ]),
  trait("twice", [{ kind: "tableTwice", from: TABLE }]),
  trait(
    "tamed",
    [
      {
        kind: "castRider",
        classes: ["wizard"],
        resource: "tamed",
        pick: true,
        rollTable: TABLE,
      },
    ],
    {
      resources: [
        {
          id: "tamed",
          max: { base: 1 },
          recharge: [{ on: "longRest", amount: "all" }],
        },
      ],
    },
  ),
  trait(
    "tides",
    [
      {
        kind: "castRider",
        classes: ["wizard"],
        refills: "tides",
        rollTable: TABLE,
      },
    ],
    {
      resources: [
        {
          id: "tides",
          max: { base: 1 },
          recharge: [{ on: "longRest", amount: "all" }],
        },
      ],
    },
  ),
  {
    id: "test:table/props",
    name: "Props",
    die: "d4",
    columns: ["Property"],
    rows: [
      { min: 1, max: 2, cells: ["x"] },
      {
        min: 3,
        max: 4,
        cells: ["y"],
        passives: [
          {
            kind: "modifier",
            modifier: { kind: "conditionImmunity", condition: "poisoned" },
          },
        ],
      },
    ],
    source: "Test",
  },
  {
    id: "test:item/relic",
    name: "Relic",
    type: "magicItem",
    category: "wondrousItem",
    rarity: "artifact",
    attunement: false,
    text: "Test.",
    automation: "full",
    properties: [{ table: "test:table/props", count: { base: 2 } }],
  },
];

async function tableRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(CONTENT.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

const caster = (
  traits: readonly string[],
  extra: Partial<Actor> = {},
): Actor => ({
  ...hero(traits),
  hp: 1,
  position: { x: 0, y: 0 },
  ...extra,
});
const FIREBALL: KnownAction = {
  id: "spell:srd52:spell/fireball",
  name: "Fireball",
  activation: {
    cost: ["action", "slot"],
    targeting: { self: true },
    resolution: { kind: "automatic", damage: [], effects: [] },
  },
  spellLevel: 3,
};
const kinds = (events: readonly SystemEvent[] = []) =>
  events.map((event) => event.kind);
const healed = (events: readonly SystemEvent[] = []) =>
  events.flatMap((event) =>
    event.kind === `${NS}:healed` && "payload" in event
      ? [(event.payload as { amount: number }).amount]
      : [],
  );
const decisionOf = (frames: readonly { kind: string; payload: unknown }[]) =>
  frames.find((item) => item.kind === AWAIT_FRAME)?.payload as
    { decision: Decision } | undefined;

describe("random tables and open-ended effects (#177)", () => {
  it("surges on a d20 of 20 after a slot spell of its class, once a turn, and rolls the table", async () => {
    const run = await tableRun();
    const actor = caster(["surge"]);
    const surged = castRiders(
      actor,
      FIREBALL,
      3,
      contextOf(run, [actor], scripted([20, 4]).dice),
    );
    expect(healed(surged.events)).toEqual([5]);
    const quiet = castRiders(
      actor,
      FIREBALL,
      3,
      contextOf(run, [actor], scripted([19]).dice),
    );
    expect(healed(quiet.events)).toEqual([]);
    const twice = castRiders(
      { ...actor, usedThisTurn: ["wild-magic-surge"] },
      FIREBALL,
      3,
      contextOf(run, [actor], scripted([20, 4]).dice),
    );
    expect(kinds(twice.events)).not.toContain(`${NS}:dieRolled`);
  });

  it("picks between two rolls with Controlled Chaos, listing the row that isn't harmful first", async () => {
    const run = await tableRun();
    const actor = caster(["surge", "twice"]);
    const { frames } = castRiders(
      actor,
      FIREBALL,
      3,
      contextOf(run, [actor], scripted([20, 1, 3]).dice),
    );
    expect(decisionOf(frames)?.decision.options.map(({ id }) => id)).toEqual([
      "3",
      "1",
    ]);
    const { events } = settle(run, [actor], frames, scripted([]).dice);
    expect(healed(events)).toEqual([5]);
  });

  it("lets Tamed Surge pick any row but the last, spending its use only on a pick", async () => {
    const run = await tableRun();
    const actor = caster(["tamed"]);
    const offered = castRiders(
      actor,
      FIREBALL,
      3,
      contextOf(run, [actor], scripted([]).dice),
    );
    expect(kinds(offered.events)).not.toContain(`${NS}:resourceSpent`);
    expect(
      decisionOf(offered.frames)?.decision.options.map(({ id }) => id),
    ).toEqual(["1", "none"]);
    const picked = settle(run, [actor], offered.frames, scripted([]).dice);
    expect(kinds(picked.events)).toContain(`${NS}:resourceSpent`);
    expect(healed(picked.events)).toEqual([1]);
  });

  it("gives Tides of Chaos back with a slot spell of its class, which surges", async () => {
    const run = await tableRun();
    const actor = caster(["tides"], { resourcesSpent: { tides: 1 } });
    const { events } = castRiders(
      actor,
      FIREBALL,
      3,
      contextOf(run, [actor], scripted([4]).dice),
    );
    expect(kinds(events)).toContain(`${NS}:resourceRestored`);
    expect(healed(events)).toEqual([5]);
    const unspent = castRiders(
      caster(["tides"]),
      FIREBALL,
      3,
      contextOf(run, [actor], scripted([4]).dice),
    );
    expect(healed(unspent.events)).toEqual([]);
  });

  it("offers Divine Intervention only Cleric spells of level 5 or lower that aren't Reactions", async () => {
    const run = await tableRun();
    const actor = caster([]);
    const frame = wishFrame(
      { kind: "copySpell", maxLevel: 5, classes: ["cleric"], noReaction: true },
      "test",
      actor,
      contextOf(run, [actor], scripted([]).dice),
    );
    const ids = (frame?.payload as { decision: Decision }).decision.options.map(
      ({ id }) => id,
    );
    expect(ids).toContain("srd52:spell/cure-wounds");
    expect(ids).not.toContain("srd52:spell/fireball");
    expect(ids).not.toContain("srd52:spell/shield");
  });

  it("rolls an artifact's properties as it's found, their passives working while it's worn", async () => {
    const run = await tableRun();
    const finder = caster([]);
    const events = gainRolls(
      finder,
      ["test:item/relic"],
      contextOf(run, [finder], scripted([1, 3]).dice),
    );
    const found = events.reduce(
      applyDndEvent,
      contextOf(
        run,
        [{ ...finder, inventory: ["test:item/relic"] }],
        scripted([]).dice,
      ).state,
    );
    const holder = found.actors[PLAYER_ACTOR] ?? finder;
    expect(holder.itemProperties?.["test:item/relic"]).toHaveLength(1);
    expect(deriveStats(holder, run).passives).toContainEqual({
      kind: "modifier",
      modifier: { kind: "conditionImmunity", condition: "poisoned" },
    });
    expect(
      gainRolls(
        holder,
        ["test:item/relic"],
        contextOf(run, [holder], scripted([]).dice),
      ),
    ).toEqual([]);
  });

  it("gives Wish its Instant Health and a stress whose effects parse", async () => {
    const run = await tableRun();
    const wish = SpellSchema.parse(run.content("srd52:spell/wish"));
    const resolution = wish.activation?.resolution;
    const copy =
      resolution?.kind === "automatic"
        ? resolution.effects.find((effect) => effect.kind === "copySpell")
        : undefined;
    expect(copy?.kind === "copySpell" && copy.extras?.[0]?.name).toBe(
      "Instant Health",
    );
    if (copy?.kind !== "copySpell") throw new Error("No copy");
    for (const effects of [
      ...(copy.extras ?? []).map((extra) => extra.effects),
      copy.stress ?? [],
    ]) {
      expect(() => LeafEffectSchema.array().parse(effects)).not.toThrow();
    }
  });

  it("keeps a channeled spirit until it's unleashed at a creature, then ends it", async () => {
    const run = await tableRun();
    const bard = caster([]);
    const context = contextOf(run, [bard], scripted([4]).dice);
    const channeled = leafEvents(
      [{ kind: "channel", from: TABLE, dieSize: "bardicDie" }],
      "test",
      bard,
      bard,
      context,
    );
    const kept = channeled.reduce(applyDndEvent, context.state);
    const holder = kept.actors[PLAYER_ACTOR] ?? bard;
    expect(holder.activeEffects).toContainEqual(
      expect.objectContaining({
        modifier: { kind: "channeled", from: TABLE, face: 4 },
      }),
    );
    const unleash: KnownAction = {
      id: "feature:test:feature/table:0",
      name: "Unleash",
      activation: {
        cost: ["action"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [{ kind: "rollTable", from: TABLE, channeled: true }],
        },
      },
      spellLevel: null,
    };
    const unleashed = resolveAction(unleash, holder, [holder], {
      ...context,
      state: kept,
    });
    expect(healed(unleashed.events)).toEqual([5]);
    expect(kinds(unleashed.events)).toContain(`${NS}:effectEnded`);
  });
});
