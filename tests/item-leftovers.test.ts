import { AWAIT_FRAME, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import {
  dealEvents,
  damageEvents,
  heldInPlace,
  leafEvents,
  payCosts,
  protectedMount,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  itemUseId,
  itemUseOf,
} from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import {
  duelHampers,
  leashed,
} from "../plugins/systems/dnd5.5e/core/combat/duel.ts";
import { regainCap } from "../plugins/systems/dnd5.5e/core/rest.ts";
import { sceneDamage } from "../plugins/systems/dnd5.5e/core/scene.ts";
import {
  ActivationSchema,
  LeafEffectSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type ActiveEffect,
  dndEvent,
  frame,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  evaluateFormula,
  type KnownAction,
  scaleActivation,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { walkSpeed } from "../plugins/systems/dnd5.5e/core/tactics.ts";
import {
  rescuedSave,
  saveSourceOf,
  traitSaveAdvantage,
  WARD_DOWN,
  warded,
} from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import { contextOf, hero, scripted, settle, testRun } from "./feat-fixtures.ts";

// Magic items and features of the test's own for #189's item activations and #193's passives: ids and mechanics
// only.
const item = (name: string, extra: object) => ({
  id: `test:item/${name}`,
  name,
  type: "magicItem",
  category: "wondrousItem",
  rarity: "rare",
  attunement: false,
  text: "Test.",
  automation: "full",
  ...extra,
});
const pool = (id: string, max: number, recharge: object[] = []) => ({
  id,
  max: { base: max },
  recharge,
});
const ITEMS = [
  item("pearl", {
    resources: [pool("pearl", 1, [{ on: "dawn", amount: "all" }])],
    lastCharge: "destroyed",
    activations: [
      {
        name: "Pearl",
        activation: {
          cost: ["action", { resource: "pearl" }],
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            effects: [{ kind: "regain", resource: "slots", maxLevel: 2 }],
          },
        },
      },
    ],
  }),
  item("cloak", { passives: [{ kind: "ward", suppressed: "damaged" }] }),
  item("warmth", {
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "damageReduction",
          damage: "cold",
          amount: { dice: "2d8" },
        },
      },
    ],
  }),
  item("saddle", { passives: [{ kind: "protectedMount" }] }),
  item("focus", {
    passives: [
      {
        kind: "saveRescue",
        concentration: true,
        hitDice: 2,
        resource: "hitDice",
      },
    ],
  }),
  item("scarab", {
    resources: [pool("scarab", 2)],
    passives: [
      {
        kind: "saveRescue",
        from: { schools: ["necromancy"], creatureTypes: ["undead"] },
        reaction: true,
        resource: "scarab",
        item: "test:item/scarab",
      },
    ],
  }),
  item("dragon-mail", {
    passives: [
      {
        kind: "saveAdvantage",
        from: { creatureTypes: ["dragon"], breath: true },
      },
    ],
  }),
  item("weaver", {
    passives: [
      {
        kind: "saveAdvantage",
        abilities: ["int", "wis", "cha"],
        while: "unconscious",
      },
    ],
  }),
  item("band", {
    resources: [pool("band", 1, [{ on: "dawn", amount: "all" }])],
    passives: [
      { kind: "pairedBand", item: "test:item/band", resource: "band" },
    ],
  }),
  item("thimble", {
    resources: [pool("thimble", 30)],
    passives: [
      { kind: "trapShield", resource: "thimble", item: "test:item/thimble" },
    ],
  }),
  item("free", { passives: [{ kind: "steadySpeed" }] }),
  item("turning", {
    passives: [{ kind: "spellTurning", upTo: 7, deflect: true }],
  }),
  item("catching", {
    activations: [
      {
        name: "Catch",
        activation: {
          cost: ["reaction"],
          trigger: { allyAttacked: true, ranged: true },
          targeting: { self: true },
          resolution: { kind: "automatic", effects: [{ kind: "drawAttack" }] },
        },
      },
    ],
  }),
  {
    id: "test:feature/rebuke",
    name: "Rebuke",
    text: "Test.",
    automation: "full",
    passives: [],
    resources: [pool("rebuke", 1, [{ on: "longRest", amount: "all" }])],
    activations: [
      {
        cost: ["reaction", { resource: "rebuke" }],
        trigger: { foeHitsOther: true, within: 30 },
        targeting: { creatures: 1, range: 30, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "wis",
          dc: { base: 30 },
          damage: [
            {
              amount: { bonus: { add: [{ kind: "dealt" }] } },
              type: "radiant",
            },
          ],
          onSuccessDamage: "half",
          onFail: [],
          onSuccess: [],
        },
      },
    ],
  },
];

async function itemRun() {
  const run = await testRun();
  const byId = new Map(ITEMS.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id: string) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}
type Run = Awaited<ReturnType<typeof itemRun>>;

// A fighter wearing these test items, or a wizard of `level` with spell slots.
function wearing(
  items: readonly string[],
  {
    id = PLAYER_ACTOR,
    traits = [] as string[],
    level = 1,
    wizard = false,
  } = {},
): Actor {
  const base = hero(traits, { id, level });
  const build =
    base.source.kind === "character" && base.source.build && wizard
      ? {
          ...base.source.build,
          levels: base.source.build.levels.map((entry) => ({
            ...entry,
            classId: "srd52:class/wizard",
          })),
        }
      : base.source.kind === "character"
        ? base.source.build
        : undefined;
  return {
    ...base,
    hp: 30,
    ...(build ? { source: { kind: "character" as const, build } } : {}),
    inventory: [...base.inventory, ...items.map((name) => `test:item/${name}`)],
  };
}
const foeOf = (extra: Partial<Actor> = {}): Actor => ({
  ...wearing([], { id: "foe" }),
  side: "enemy",
  ...extra,
});
const at = (actor: Actor, x: number, y = 0): Actor => ({
  ...actor,
  position: { x, y },
});
const condition = (name: string): ActiveEffect => ({
  sourceId: "test",
  casterId: "test",
  ends: "spellDuration",
  modifier: {
    kind: "condition",
    condition: name as "unconscious",
  },
});
const kinds = (events: readonly SystemEvent[]) =>
  events.map((event) => event.kind.replace(`${NS}:`, ""));
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const ctx = (run: Run, actors: readonly Actor[], rolls: number[] = []) =>
  contextOf(run, actors, scripted(rolls).dice);

describe("magic item activations and capped slot regain (#189)", () => {
  it("offers a worn item's activation and gives back the highest spent slot it allows", async () => {
    const run = await itemRun();
    const actor = {
      ...wearing(["pearl"], { level: 5, wizard: true }),
      resourcesSpent: { "slot:3": 1, "slot:2": 1, "slot:1": 1 },
    };
    const use = deriveStats(actor, run).actions.find(
      (action) => action.id === itemUseId("test:item/pearl", 0),
    );
    expect(use?.name).toBe("Pearl");
    expect(itemUseOf(use?.id ?? "")).toBe("test:item/pearl");
    if (!use) throw new Error("No use");
    const { events = [] } = resolveAction(
      use,
      actor,
      [actor],
      ctx(run, [actor]),
    );
    expect(payloads(events, "resourceRestored")).toEqual([
      { actor: PLAYER_ACTOR, resource: "slot:2", amount: 1 },
    ]);
    // Packed away, it isn't used.
    const packed = { ...actor, stowed: ["test:item/pearl"] };
    expect(
      deriveStats(packed, run).actions.some((action) => action.id === use.id),
    ).toBe(false);
    // Its one charge spent at dawn's last, a d20 of 1 spends it.
    expect(kinds(payCosts(use, actor, ctx(run, [actor], [1])))).toEqual([
      "budgetSpent",
      "resourceSpent",
      "itemUsed",
      "resourceRestored",
    ]);
  });

  it("gives back slots up to half the level a spell is cast with, as Mordenkainen's Lucubration", async () => {
    const run = await itemRun();
    const actor = {
      ...wearing([], { level: 5, wizard: true }),
      resourcesSpent: { "slot:3": 1, "slot:2": 1, "slot:1": 1 },
    };
    const effect = {
      kind: "regain" as const,
      resource: "slots",
      count: 2,
      maxLevel: "halfSlot" as const,
    };
    expect(regainCap(effect, 5)).toBe(2);
    expect(regainCap(effect, 7)).toBe(3);
    const regained = (slotLevel: number) =>
      payloads(
        leafEvents(
          [effect],
          "spell:test",
          actor,
          actor,
          ctx(run, [actor]),
          undefined,
          slotLevel,
        ),
        "resourceRestored",
      ).map((item) => item.resource);
    expect(regained(5)).toEqual(["slot:2", "slot:1"]);
    expect(regained(7)).toEqual(["slot:3", "slot:2"]);
    // A higher slot changes nothing else.
    const activation = ActivationSchema.parse({
      cost: [],
      targeting: { self: true },
      resolution: { kind: "automatic", effects: [effect] },
    });
    expect(scaleActivation(activation, { slotOnly: true }, 3)).toBe(activation);
  });
});

describe("magic item passives (#193)", () => {
  it("gives attacks against a Cloak of Displacement's wearer Disadvantage until it's hurt or held still", async () => {
    const run = await itemRun();
    const actor = wearing(["cloak"]);
    const stats = deriveStats(actor, run);
    expect(warded(actor, stats)).toBe(true);
    const hurt = damageEvents(actor, 5, "slashing", false, ctx(run, [actor]));
    expect(payloads(hurt, "oncePerTurnUsed")).toContainEqual({
      actor: PLAYER_ACTOR,
      key: WARD_DOWN,
    });
    expect(warded({ ...actor, usedThisTurn: [WARD_DOWN] }, stats)).toBe(false);
    const held = { ...actor, activeEffects: [condition("grappled")] };
    expect(warded(held, deriveStats(held, run))).toBe(false);
  });

  it("takes a Ring of Warmth's dice off Cold damage every time", async () => {
    const run = await itemRun();
    const actor = wearing(["warmth"]);
    const { events } = dealEvents(
      actor,
      [{ amount: 20, type: "cold" }],
      false,
      ctx(run, [actor], [3, 4]),
    );
    expect(payloads(events, "damaged")[0]?.amount).toBe(13);
    const fire = dealEvents(
      actor,
      [{ amount: 20, type: "fire" }],
      false,
      ctx(run, [actor], [3, 4]),
    );
    expect(payloads(fire.events, "damaged")[0]?.amount).toBe(20);
  });

  it("protects a Saddle of the Cavalier's mount and keeps its rider in it", async () => {
    const run = await itemRun();
    const mount = { ...foeOf(), id: "mount", side: "party" as const };
    const riding = (items: string[]) => ({
      ...wearing(items),
      activeEffects: [
        {
          sourceId: "mounted",
          casterId: "mount",
          ends: "spellDuration" as const,
          modifier: { kind: "riding" as const },
        },
      ],
    });
    const rider = riding(["saddle"]);
    expect(protectedMount(mount, ctx(run, [rider, mount]))).toBe(true);
    expect(heldInPlace(rider, ctx(run, [rider, mount]))).not.toEqual([]);
    const plain = riding([]);
    expect(protectedMount(mount, ctx(run, [plain, mount]))).toBe(false);
    expect(heldInPlace(plain, ctx(run, [plain, mount]))).toEqual([]);
  });

  it("adds Hit Point Dice to a failed save to keep Concentration, as a Ring of Dedicated Focus", async () => {
    const run = await itemRun();
    const actor = {
      ...wearing(["focus"], { level: 3 }),
      concentratingOn: "spell:test",
    };
    // A 2 fails DC 15; d10s of 5 and 6 make up the rest.
    const { events } = settle(
      run,
      [actor],
      [frame("concentrationSave", { actor: PLAYER_ACTOR, dc: 15 })],
      scripted([2, 5, 6]).dice,
    );
    expect(payloads(events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "hitDice", amount: 2 },
    ]);
    expect(kinds(events)).not.toContain("concentrationEnded");
    // Dice that can't make it up aren't spent.
    const short = settle(
      run,
      [actor],
      [frame("concentrationSave", { actor: PLAYER_ACTOR, dc: 40 })],
      scripted([2]).dice,
    );
    expect(kinds(short.events)).toContain("concentrationEnded");
    expect(payloads(short.events, "resourceSpent")).toEqual([]);
  });

  it("turns a failed save against Necromancy or an Undead into a success, and crumbles on its last charge, as a Scarab of Protection", async () => {
    const run = await itemRun();
    const actor = wearing(["scarab"]);
    const stats = deriveStats(actor, run);
    const failed = [
      dndEvent(`${NS}:saveRolled`, {
        actor: PLAYER_ACTOR,
        ability: "wis",
        natural: 3,
        total: 5,
        dc: 15,
        success: false,
      }),
    ];
    const rescue = (target: Actor, source: object) =>
      rescuedSave(
        target,
        "wis",
        [],
        deriveStats(target, run),
        failed,
        [],
        undefined,
        false,
        {
          source: {
            creatureType: undefined,
            school: null,
            breath: false,
            ...source,
          },
        },
      );
    expect(kinds(rescue(actor, { creatureType: "undead" }))).toEqual([
      "budgetSpent",
      "resourceSpent",
    ]);
    expect(kinds(rescue(actor, { school: "necromancy" }))).toEqual([
      "budgetSpent",
      "resourceSpent",
    ]);
    expect(
      rescue(actor, { creatureType: "humanoid", school: "evocation" }),
    ).toEqual([]);
    expect(stats.resources.scarab).toBe(2);
    const last = { ...actor, resourcesSpent: { scarab: 1 } };
    expect(kinds(rescue(last, { creatureType: "undead" }))).toEqual([
      "budgetSpent",
      "resourceSpent",
      "itemUsed",
      "resourceRestored",
    ]);
  });

  it("gives Advantage on a save against a dragon's breath, and on mental saves while Unconscious", async () => {
    const run = await itemRun();
    const mail = wearing(["dragon-mail"]);
    const stats = deriveStats(mail, run);
    const breath = { creatureType: "dragon", school: null, breath: true };
    expect(traitSaveAdvantage(stats, "dex", [], false, mail, breath)).toBe(
      true,
    );
    expect(
      traitSaveAdvantage(stats, "dex", [], false, mail, {
        ...breath,
        breath: false,
      }),
    ).toBe(false);
    expect(traitSaveAdvantage(stats, "dex", [], false, mail)).toBe(false);
    const foe = foeOf();
    expect(saveSourceOf(foe, "monster:0", "Fire Breath", run).breath).toBe(
      true,
    );
    const sleeper = {
      ...wearing(["weaver"]),
      activeEffects: [condition("unconscious")],
    };
    const awake = wearing(["weaver"]);
    expect(
      traitSaveAdvantage(deriveStats(sleeper, run), "wis", [], false, sleeper),
    ).toBe(true);
    expect(
      traitSaveAdvantage(deriveStats(awake, run), "wis", [], false, awake),
    ).toBe(false);
    expect(
      traitSaveAdvantage(deriveStats(sleeper, run), "dex", [], false, sleeper),
    ).toBe(false);
  });

  it("spares the wearer of the paired band from its partner's area, once, as Boon Companions' Bands", async () => {
    const run = await itemRun();
    const caster = at(wearing(["band"]), 0);
    const friend = at(wearing(["band"], { id: "friend" }), 3);
    const foe = at(foeOf(), 4);
    const blast: KnownAction = {
      id: "test-blast",
      name: "Blast",
      spellLevel: 3,
      activation: {
        cost: [],
        targeting: {
          area: { shape: "sphere", radius: 20 },
          range: 60,
          side: "enemy",
        },
        resolution: {
          kind: "save",
          ability: "dex",
          dc: { base: 30, add: [] },
          damage: [{ amount: { dice: "8d6" }, type: "fire" }],
          onSuccessDamage: "half",
          onFail: [],
          onSuccess: [],
        },
      },
    };
    const { events = [] } = resolveAction(
      blast,
      caster,
      [friend, foe],
      ctx(run, [caster, friend, foe]),
    );
    expect(payloads(events, "damaged").map((item) => item.actor)).toEqual([
      "foe",
    ]);
    expect(payloads(events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "band" },
    ]);
  });

  it("takes a trap's damage on a Thief's Thimble until it breaks", async () => {
    const run = await itemRun();
    const actor = wearing(["thimble"]);
    const args = {
      dice: "1d6",
      bonus: 0,
      times: 1,
      type: "piercing",
      who: "player",
      trap: true,
    } as const;
    const small = sceneDamage({ ...args, dice: "1d6" }, ctx(run, [actor], [4]));
    expect(payloads(small, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "thimble", amount: 4 },
    ]);
    expect(payloads(small, "damaged")).toEqual([]);
    const big = sceneDamage(
      { ...args, dice: "6d6" },
      ctx(run, [actor], [6, 6, 6, 6, 6, 6]),
    );
    expect(kinds(big)).toEqual(["itemUsed", "resourceRestored", "damaged"]);
    expect(payloads(big, "damaged")[0]?.amount).toBe(6);
    // Not a trap's: no thimble.
    const burned = sceneDamage(
      { ...args, trap: undefined },
      ctx(run, [actor], [4]),
    );
    expect(kinds(burned)).toEqual(["damaged"]);
  });

  it("keeps effects from lowering a Ring of Free Action's wearer's Speed", async () => {
    const run = await itemRun();
    const slowed: ActiveEffect = {
      sourceId: "spell:test",
      casterId: "foe",
      ends: "spellDuration",
      modifier: { kind: "actionLimit", speed: "half" },
    };
    const ringed = { ...wearing(["free"]), activeEffects: [slowed] };
    const plain = { ...wearing([]), activeEffects: [slowed] };
    expect(walkSpeed(ringed, deriveStats(ringed, run))).toBe(30);
    expect(walkSpeed(plain, deriveStats(plain, run))).toBe(15);
    const chilled: ActiveEffect = {
      sourceId: "spell:test",
      casterId: "foe",
      ends: "spellDuration",
      modifier: {
        kind: "bonus",
        to: "speed",
        subtract: true,
        amount: { bonus: { base: 10, add: [] } },
      },
    };
    const cold = { ...wearing(["free"]), activeEffects: [chilled] };
    expect(deriveStats(cold, run).speed).toBe(30);
  });

  it("turns a spell aimed at a Ring of Spell Turning's wearer alone back at its caster", async () => {
    const run = await itemRun();
    const bearer = at(wearing(["turning"]), 0);
    const foe = at(foeOf(), 1);
    const hold = (
      targeting: KnownAction["activation"]["targeting"],
    ): KnownAction => ({
      id: "test-hold",
      name: "Hold",
      spellLevel: 2,
      activation: {
        cost: [],
        targeting,
        resolution: {
          kind: "save",
          ability: "wis",
          dc: { base: 5, add: [] },
          damage: [],
          onSuccessDamage: "none",
          onFail: [
            LeafEffectSchema.parse({
              kind: "applyCondition",
              condition: "paralyzed",
              duration: { minutes: 1 },
            }),
          ],
          onSuccess: [],
        },
      },
    });
    const single = resolveAction(
      hold({ creatures: 1, range: 60, side: "enemy" }),
      foe,
      [bearer],
      ctx(run, [bearer, foe], [15]),
    );
    expect(payloads(single.events ?? [], "budgetSpent")).toContainEqual(
      expect.objectContaining({ actor: PLAYER_ACTOR, label: "Spell Turning" }),
    );
    expect(single.frames).toContainEqual(
      frame("useAction", {
        actor: "foe",
        actionId: "test-hold",
        target: "foe",
        anyone: true,
        free: true,
      }),
    );
    const area = resolveAction(
      hold({ area: { shape: "sphere", radius: 10 }, range: 60, side: "enemy" }),
      foe,
      [bearer],
      ctx(run, [bearer, foe], [15]),
    );
    expect(payloads(area.events ?? [], "budgetSpent")).toEqual([]);
  });

  it("draws a ranged attack on a creature beside it to an Arrow-Catching Shield's wearer", async () => {
    const run = await itemRun();
    const bearer = at(wearing(["catching"]), 0);
    const friend = at({ ...wearing([], { id: "friend" }), hp: 30 }, 1);
    const foe = at(
      foeOf({ inventory: ["srd52:item/shortbow", "srd52:item/longsword"] }),
      4,
    );
    const attack = (actionId: string, who: Actor) =>
      settle(
        run,
        [who, bearer, friend],
        [frame("attackRoll", { attacker: "foe", actionId, target: "friend" })],
        scripted([15, 4]).dice,
        () => "",
      );
    const shot = attack("weapon:srd52:item/shortbow", foe);
    expect(payloads(shot.events, "budgetSpent")).toContainEqual(
      expect.objectContaining({ actor: PLAYER_ACTOR, kind: "reaction" }),
    );
    expect(
      payloads(shot.events, "damaged").map((item) => item.actor),
    ).not.toContain("friend");
    const swung = attack("weapon:srd52:item/longsword", {
      ...foe,
      position: { x: 2, y: 0 },
    });
    expect(payloads(swung.events, "budgetSpent")).toEqual([]);
  });

  it("echoes the damage a foe deals someone else, as Rebuke the Violent", async () => {
    const run = await itemRun();
    const bearer = at(wearing([], { traits: ["rebuke"] }), 0);
    const friend = at({ ...wearing([], { id: "friend" }), hp: 30 }, 1);
    const foe = at(foeOf({ hp: 40 }), 2);
    const { events } = settle(
      run,
      [bearer, friend, foe],
      [
        frame("applyHit", {
          attacker: "foe",
          actionId: "weapon:srd52:item/longsword",
          target: "friend",
          critical: false,
          hadAdvantage: false,
          total: 30,
          natural: 15,
        }),
      ],
      scripted([]).dice,
      () => "",
    );
    const hits = payloads(events, "damaged");
    const dealt = hits.find((item) => item.actor === "friend")?.amount;
    expect(dealt).toBeGreaterThan(0);
    expect(hits.find((item) => item.actor === "foe")).toEqual(
      expect.objectContaining({ amount: dealt, type: "radiant" }),
    );
    // Anywhere else the term is nothing.
    expect(
      evaluateFormula(
        { base: 2, add: [{ kind: "dealt" }] },
        deriveStats(bearer, run),
      ),
    ).toBe(2);
  });

  it("holds a challenged creature near its caster only while the caster can act, without Compelled Duel's Disadvantage", async () => {
    const run = await itemRun();
    const challenged = (extra: Partial<Actor> = {}): Actor => ({
      ...at(foeOf(), 1),
      activeEffects: [
        {
          sourceId: "challenge",
          casterId: PLAYER_ACTOR,
          ends: "spellDuration",
          modifier: { kind: "duel", feet: 30, leashOnly: true },
        },
      ],
      ...extra,
    });
    const paladin = at(wearing([]), 0);
    const far = { x: 9, y: 0 };
    const state = (caster: Actor, foe: Actor) =>
      contextOf(run, [caster, foe], scripted([]).dice).state;
    expect(leashed(challenged(), state(paladin, challenged()))(far)).toBe(true);
    const out = { ...paladin, activeEffects: [condition("incapacitated")] };
    expect(leashed(challenged(), state(out, challenged()))(far)).toBe(false);
    expect(duelHampers(challenged(), wearing([], { id: "friend" }))).toBe(
      false,
    );
  });

  it("moves a willing ally instead of the bearer, as Telekinetic Movement", async () => {
    const run = await itemRun();
    const bearer = at(wearing([]), 0);
    const friend = at({ ...wearing([], { id: "friend" }), hp: 30 }, 1);
    const move: KnownAction = {
      id: "test-move",
      name: "Move",
      spellLevel: null,
      activation: {
        cost: [],
        targeting: { creatures: 1, range: 30, side: "ally" },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [{ kind: "teleport", feet: 30, movement: 0, others: true }],
        },
      },
    };
    const state = {
      ...ctx(run, [bearer, friend]),
      state: {
        ...ctx(run, [bearer, friend]).state,
        combat: {
          ...ctx(run, [bearer, friend]).state.combat,
          grid: { width: 10, height: 4 },
        },
      },
    };
    const { frames = [] } = resolveAction(
      move,
      bearer,
      [friend],
      state as never,
    );
    const asked = frames.find((item) => item.kind === AWAIT_FRAME)?.payload as
      { readonly decision: { readonly actor: string } } | undefined;
    expect(asked?.decision.actor).toBe("friend");
  });
});
