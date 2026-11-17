import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { completeDraft } from "../plugins/systems/dnd5.5e/core/character-sheet.ts";
import { levelEntry } from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  turnInspiration,
  turnRecharge,
} from "../plugins/systems/dnd5.5e/core/class-rules.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  canAfford,
  findAction,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { schoolCastEvents } from "../plugins/systems/dnd5.5e/core/combat/school.ts";
import { initiativeRecharge } from "../plugins/systems/dnd5.5e/core/combat/start.ts";
import { joins } from "../plugins/systems/dnd5.5e/core/metamagic.ts";
import {
  recovered,
  regainEvents,
} from "../plugins/systems/dnd5.5e/core/rest.ts";
import {
  FeatureSchema,
  PregenSchema,
  ResourceDefSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { NS, type Actor } from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  type Stats,
  deriveStats,
  lookup,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// Made-up resource traits: ids and mechanics only.
const self = { self: true };
const auto = (effects: readonly object[]) => ({ kind: "automatic", effects });
const once = (id: string) =>
  ResourceDefSchema.parse({
    id,
    max: { base: 1 },
    recharge: [{ on: "longRest", amount: "all" }],
  });
const FIXTURES = [
  trait("rally", [], {
    resources: [
      once("rally-once"),
      {
        id: "pool",
        max: { base: 6 },
        recharge: [
          {
            on: "initiative",
            amount: "all",
            uses: "rally-once",
            heal: { bonus: { base: 4 } },
          },
        ],
      },
      {
        id: "dice",
        max: { base: 4 },
        recharge: [{ on: "initiative", amount: "all", upTo: 2 }],
      },
      {
        id: "relent",
        max: { base: 3 },
        recharge: [{ on: "turnStart", amount: 1, upTo: 1 }],
      },
    ],
  }),
  trait("convert", [], {
    resources: [{ id: "pool", max: { base: 6 }, recharge: [] }],
    activations: [
      {
        cost: ["bonusAction"],
        targeting: self,
        resolution: auto([{ kind: "regain", resource: "pool", count: 2 }]),
      },
    ],
  }),
  trait("heroic", [{ kind: "turnInspiration" }]),
  trait("diviner", [
    { kind: "schoolCast", school: "divination", rider: "refund" },
  ]),
  trait("cook", [{ kind: "restMeal", amount: { bonus: { base: 5 } } }]),
  trait("trance", [{ kind: "restHours", hours: 4 }]),
  trait("blessing", [], {
    spells: { "1": ["srd52:spell/shield-of-faith"] },
    freeCast: { resource: "divinity", minutes: 1 },
  }),
  trait("mastery", [], {
    spells: { "1": ["srd52:spell/bless"] },
    freeCast: "atWill",
  }),
  {
    id: "test:feat/mastered",
    name: "Mastered",
    category: "origin",
    text: "Test.",
    choices: [
      {
        kind: "spells",
        id: "spell",
        count: 1,
        minLevel: 1,
        maxLevel: 1,
        list: "srd52:class/wizard",
        freeCast: "atWill",
      },
    ],
  },
  {
    id: "test:background/mastered",
    name: "Mastered",
    abilities: ["str", "dex", "con"],
    feat: "test:feat/mastered",
    skills: ["athletics", "survival"],
    tool: "Test Tools",
  },
  trait("signature", [], {
    spells: { "1": ["srd52:spell/bless"] },
    freeCast: "shortRest",
  }),
];

async function poolsRun() {
  const run = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id: string) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );

const spending = (actor: Actor, resourcesSpent: Record<string, number>) => ({
  ...actor,
  resourcesSpent,
});

const at = (run: Awaited<ReturnType<typeof poolsRun>>, actor: Actor) =>
  contextOf(run, [actor], scripted([]).dice);

// The hero's numbers with spell slots and passives of the test's own.
const withSlots = (
  stats: Stats,
  slots: number[],
  extra: Partial<Stats> = {},
): Stats => ({ ...stats, slots, ...extra });

describe("resource pools, conversions and rest recovery (#170)", () => {
  it("gives uses back on Initiative: a once-a-rest one only with half the pool spent, healing too, and `upTo`", async () => {
    const run = await poolsRun();
    const max = deriveStats(hero([]), run).maxHp;
    const fresh = { ...hero(["rally"]), hp: 1 };
    const light = spending(fresh, { pool: 2 });
    expect(
      initiativeRecharge(light, contextOf(run, [light], scripted([]).dice)),
    ).toEqual([]);

    const low = spending(fresh, { pool: 4, dice: 4 });
    const events = initiativeRecharge(
      low,
      contextOf(run, [low], scripted([]).dice),
    );
    expect(payloads(events, "resourceRestored")).toEqual([
      { actor: PLAYER_ACTOR, resource: "pool", amount: 4 },
      // Superior Inspiration's "until you have two": two back of four spent.
      { actor: PLAYER_ACTOR, resource: "dice", amount: 2 },
    ]);
    expect(payloads(events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "rally-once" },
    ]);
    expect(payloads(events, "healed")).toEqual([
      { actor: PLAYER_ACTOR, amount: 4, max },
    ]);

    // Its once-a-rest use spent, nothing more comes back that way.
    const used = spending(fresh, { pool: 6, "rally-once": 1 });
    expect(
      initiativeRecharge(used, contextOf(run, [used], scripted([]).dice)),
    ).toEqual([]);
  });

  it("brings one use back a turn only once the pool is empty with `upTo: 1`, as Relentless", async () => {
    const run = await poolsRun();
    const empty = spending(hero(["rally"]), { relent: 3 });
    expect(
      payloads(turnRecharge(empty, at(run, empty)), "resourceRestored"),
    ).toEqual([{ actor: PLAYER_ACTOR, resource: "relent", amount: 1 }]);
    const some = spending(hero(["rally"]), { relent: 2 });
    expect(turnRecharge(some, at(run, some))).toEqual([]);
  });

  it("gives Heroic Inspiration as a turn starts to a bearer without it, as Heroic Warrior", async () => {
    const run = await poolsRun();
    expect(
      payloads(
        turnInspiration(hero(["heroic"]), at(run, hero(["heroic"]))),
        "inspirationGranted",
      ),
    ).toEqual([{ actor: PLAYER_ACTOR }]);
    expect(
      turnInspiration(
        { ...hero(["heroic"]), heroicInspiration: true },
        at(run, hero([])),
      ),
    ).toEqual([]);
    expect(turnInspiration(hero([]), at(run, hero([])))).toEqual([]);
  });

  it("regains spent uses, never more than are spent, and isn't offered with none spent", async () => {
    const run = await poolsRun();
    const spent = spending(hero(["convert"]), { pool: 1 });
    const context = contextOf(run, [spent], scripted([]).dice);
    const action = findAction(spent, "feature:test:feature/convert:0", context);
    const effects =
      action.activation.resolution.kind === "automatic"
        ? action.activation.resolution.effects
        : [];
    expect(
      payloads(
        leafEvents(effects, action.id, spent, spent, context),
        "resourceRestored",
      ),
    ).toEqual([{ actor: PLAYER_ACTOR, resource: "pool", amount: 1 }]);
    const stats = deriveStats(spent, run);
    expect(canAfford(action, spent, stats)).toBe(true);
    expect(canAfford(action, hero(["convert"]), stats)).toBe(false);
  });

  it("regains spell slots highest first, half of them rounded up, as Magical Cunning", async () => {
    const run = await poolsRun();
    const stats = withSlots(deriveStats(hero([]), run), [4, 2]);
    const actor = spending(hero([]), { "slot:1": 3, "slot:2": 2 });
    expect(
      payloads(regainEvents(actor, "slots", "half", stats), "resourceRestored"),
    ).toEqual([
      { actor: PLAYER_ACTOR, resource: "slot:2", amount: 2 },
      { actor: PLAYER_ACTOR, resource: "slot:1", amount: 1 },
    ]);
    expect(
      payloads(regainEvents(actor, "slots", "all", stats), "resourceRestored"),
    ).toHaveLength(2);
  });

  it("recovers slots in a Short Rest, highest first within the budget, once a Long Rest, as Arcane Recovery", async () => {
    const run = await poolsRun();
    const base = deriveStats(hero([]), run);
    const stats = withSlots(base, [4, 3, 3], {
      passives: [
        ...base.passives,
        { kind: "slotRecovery", levels: { base: 3, add: [] }, resource: "rec" },
      ],
      resourceDefs: [...base.resourceDefs, once("rec")],
      resources: { ...base.resources, rec: 1 },
    });
    const spent = { "slot:1": 2, "slot:2": 1, "slot:3": 1 };
    const after = recovered(spent, stats, "short");
    expect(after).toEqual({ "slot:1": 2, "slot:2": 1, rec: 1 });
    expect(recovered(after, stats, "short")).toEqual(after);
    expect(recovered(after, stats, "long")).toEqual({});
  });

  it("gives back a formula's worth in a Short Rest once a Long Rest with `uses`, as Sorcerous Restoration", async () => {
    const run = await poolsRun();
    const base = deriveStats(hero([]), run);
    const stats = withSlots(base, [], {
      resourceDefs: [
        once("restore"),
        {
          id: "points",
          max: { base: 5, add: [] },
          recharge: [
            { on: "shortRest", amount: { base: 2, add: [] }, uses: "restore" },
          ],
        },
      ],
      resources: { ...base.resources, restore: 1, points: 5 },
    });
    const after = recovered({ points: 5 }, stats, "short");
    expect(after).toEqual({ points: 3, restore: 1 });
    expect(recovered(after, stats, "short")).toEqual(after);
  });

  it("gives back a spent slot below the one a divination spell was cast with, as Expert Divination", async () => {
    const run = await poolsRun();
    const actor = spending(hero(["diviner"]), { "slot:1": 1, "slot:2": 1 });
    const context = contextOf(run, [actor], scripted([]).dice);
    const action = {
      id: "spell:srd52:spell/detect-magic",
      name: "Detect Magic",
      activation: { cost: [], targeting: self, resolution: auto([]) },
      spellLevel: 1,
    } as unknown as Parameters<typeof schoolCastEvents>[1];
    expect(
      payloads(schoolCastEvents(actor, action, 3, context), "resourceRestored"),
    ).toEqual([{ actor: PLAYER_ACTOR, resource: "slot:2", amount: 1 }]);
    expect(schoolCastEvents(actor, action, 1, context)).toEqual([]);
  });

  it("casts a spell without a slot by a resource and without Concentration, at will, or once a Short Rest", async () => {
    const run = await poolsRun();
    const free = (name: string, spell: string) =>
      deriveStats(hero([name]), run).actions.find(
        (item) => item.id === `spell:${spell}:free`,
      );
    const blessing = free("blessing", "srd52:spell/shield-of-faith");
    expect(blessing?.activation.cost).toContainEqual({ resource: "divinity" });
    expect(JSON.stringify(blessing?.activation)).not.toContain("concentration");
    expect(free("mastery", "srd52:spell/bless")?.activation.cost).toEqual([
      "action",
    ]);
    const plain = deriveStats(hero([]), run).resourceDefs;
    expect(deriveStats(hero(["mastery"]), run).resourceDefs).toEqual(plain);
    expect(deriveStats(hero(["signature"]), run).resourceDefs).toEqual([
      ...plain,
      {
        id: "free:srd52:spell/bless",
        max: { base: 1, add: [] },
        recharge: [{ on: "shortRest", amount: "all" }],
      },
    ]);
  });

  it("keeps a spells choice's way of casting free in its answer, as Spell Mastery's at will", async () => {
    const run = await poolsRun();
    const draft = completeDraft(
      {
        classId: "srd52:class/fighter",
        speciesId: "test:species/plain",
        backgroundId: "test:background/mastered",
        scores: [],
        picks: {},
      },
      "standard",
      run,
    );
    const { answers } = levelEntry(draft, null, run);
    expect(answers).toContainEqual(
      expect.objectContaining({ kind: "spells", freeCast: "atWill" }),
    );
  });

  it("adds a Replenishing Meal to each member's first Hit Point Die in a Short Rest", async () => {
    const run = await poolsRun();
    const max = deriveStats(hero([]), run).maxHp;
    const cook = { ...hero(["cook"]), hp: 1 };
    const friend = { ...hero([], { id: "friend" }), hp: 1 };
    const state = {
      ...contextOf(run, [cook, friend], scripted([]).dice).state,
      combat: null,
    };
    const { events } = settle(
      run,
      state,
      [{ kind: `${NS}:shortRestStep`, payload: {} }],
      scripted([1, 1, 1, 1]).dice,
      (decision) =>
        decision.options.find((option) => option.id === "spend")?.id ??
        "finish",
    );
    // A 1 on the d10 plus the Constitution modifier of 2, and 5 more, for each member's one die.
    expect(max).toBeGreaterThan(8);
    expect(payloads(events, "healed")).toEqual([
      { actor: PLAYER_ACTOR, amount: 8, max },
      { actor: "friend", amount: 8, max },
    ]);
    expect(payloads(events, "resourceSpent")).toContainEqual({
      actor: "friend",
      resource: "rest:meal",
    });
  });

  it("shortens a Long Rest only when every member has Trance or the like", async () => {
    const run = await poolsRun();
    const finish = (actors: readonly Actor[]) =>
      payloads(
        settle(
          run,
          { ...contextOf(run, actors, scripted([]).dice).state, combat: null },
          [{ kind: `${NS}:finishRest`, payload: { rest: "long" } }],
          scripted([]).dice,
        ).events,
        "restFinished",
      );
    const elf = hero(["trance"]);
    expect(finish([elf, hero(["trance"], { id: "friend" })])).toEqual([
      { rest: "long", hours: 4 },
    ]);
    expect(finish([elf, hero([], { id: "friend" })])).toEqual([
      { rest: "long" },
    ]);
  });

  it("lets any two Metamagic options join with Sorcery Incarnate", () => {
    expect(joins("quickened", ["twinned"])).toBe(false);
    expect(joins("quickened", ["twinned"], true)).toBe(true);
    expect(joins("careful", ["twinned", "quickened"], true)).toBe(false);
  });

  it("plays the SRD's Channel Divinity and Arcane Recovery", async () => {
    const run = await testRun();
    const cleric = lookup(run, FeatureSchema, "srd52:feature/channel-divinity");
    expect(cleric.activations.map((item) => item.label)).toEqual([
      "Divine Spark",
      "Divine Spark, Radiant",
      "Divine Spark, Necrotic",
      "Turn Undead",
    ]);
    const wizard = lookup(run, PregenSchema, "srd52:pregen/wizard").build;
    const stats = deriveStats(
      { ...hero([]), source: { kind: "character", build: wizard } },
      run,
    );
    expect(stats.passives).toContainEqual(
      expect.objectContaining({
        kind: "slotRecovery",
        resource: "arcane-recovery",
      }),
    );
  });
});
