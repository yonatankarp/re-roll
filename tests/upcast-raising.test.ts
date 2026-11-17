import { describe, expect, it } from "vitest";
import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import type { RunContext } from "../engine/run/turn.ts";
import { sceneCastActions } from "../plugins/systems/dnd5.5e/core/camp.ts";
import {
  dealEvents,
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  canAfford,
  deadWithin,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { castRiders } from "../plugins/systems/dnd5.5e/core/combat/school.ts";
import { nextDndDecision } from "../plugins/systems/dnd5.5e/core/combat/decisions.ts";
import { reincarnatedEvent } from "../plugins/systems/dnd5.5e/core/reincarnate.ts";
import {
  recovered,
  shortRestFor,
} from "../plugins/systems/dnd5.5e/core/rest.ts";
import {
  type Activation,
  type LeafEffect,
  PregenSchema,
  SpellSchema,
  type Targeting,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  effectiveBuild,
  freshActor,
  isDead,
  isDown,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  type KnownAction,
  deriveStats,
  lookup,
  scaleActivation,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { contextOf, hero, scripted, testRun, trait } from "./feat-fixtures.ts";

// Made-up traits for the pieces of #155, #186 and #201: ids and numbers only.
const RAGE = "test:feature/rage";
const use = (id: string) => ({
  resources: [
    { id, max: { base: 1 }, recharge: [{ on: "longRest", amount: "all" }] },
  ],
});
const FIXTURES = [
  {
    id: "test:species/keen",
    name: "Keen",
    text: "A test species.",
    creatureType: "Humanoid",
    size: "medium",
    speed: 30,
    traits: [],
    choices: [
      {
        kind: "skills",
        id: "senses",
        count: 1,
        from: ["insight", "perception"],
      },
    ],
  },
  trait("rage", []),
  trait("reckless", [], {
    activations: [
      {
        cost: [],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              modifier: { kind: "advantage", on: "attacks" },
              duration: { until: "yourNextTurnStart" },
            },
          ],
        },
      },
    ],
  }),
  trait("abandon", [
    {
      kind: "activationRider",
      feature: "test:feature/reckless",
      while: [RAGE],
      effects: [{ kind: "tempHp", amount: { bonus: { base: 2 } } }],
    },
  ]),
  trait("beyond", [{ kind: "fightOn", while: [RAGE] }]),
  trait("before", [{ kind: "fightOn", resource: "before" }], use("before")),
  trait("keeper", [
    {
      kind: "onKill",
      within: 60,
      ally: true,
      fallenHitDice: true,
      oncePerTurn: true,
      effects: [{ kind: "heal", amount: { bonus: { base: 1 } } }],
    },
  ]),
  trait(
    "summons",
    [
      {
        kind: "whenDowned",
        resource: "summons",
        incapacitated: true,
        effects: [
          {
            kind: "animate",
            monster: "srd52:monster/goblin-warrior",
            count: 2,
            range: 20,
          },
        ],
      },
    ],
    use("summons"),
  ),
  trait("undying", [{ kind: "deterAttackers", creatureTypes: ["humanoid"] }]),
  trait(
    "defy",
    [
      {
        kind: "castRider",
        uses: ["srd52:spell/heal"],
        resource: "defy",
        effects: [{ kind: "tempHp", amount: { bonus: { base: 3 } } }],
        onTargets: [
          {
            kind: "modifier",
            modifier: { kind: "actionLimit", noDisengage: true },
            duration: { minutes: 1 },
          },
        ],
      },
    ],
    use("defy"),
  ),
  trait("recovery", [], {
    activations: [
      {
        cost: ["bonusAction"],
        bloodied: true,
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "heal",
              amount: { bonus: { add: [{ kind: "maxHp", half: true }] } },
            },
          ],
        },
      },
    ],
  }),
  trait("jolt", [], {
    classTiers: {
      class: "srd52:class/fighter",
      at: [3, 5],
      step: { addDice: "1d4" },
    },
    activations: [
      {
        cost: ["action"],
        targeting: { creatures: 1, range: 15, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "heal", amount: { bonus: { base: 1 } } }],
          burst: {
            radius: 10,
            ability: "dex",
            dc: { base: 12 },
            damage: [{ amount: { dice: "2d4" }, type: "lightning" }],
            half: true,
          },
        },
      },
    ],
  }),
  trait("pool", [], {
    resources: [{ id: "pool", max: { base: 15 }, recharge: [] }],
  }),
  trait("cauldron", [], {
    resources: [
      {
        id: "cauldron",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all", every: 3 }],
      },
    ],
  }),
];

async function run(): Promise<RunContext> {
  const base = await testRun();
  const byId = new Map<string, unknown>(
    FIXTURES.map((item) => [item.id, item]),
  );
  return {
    ...base,
    content: (id) =>
      (byId.get(id) as ReturnType<RunContext["content"]>) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...byId.keys()].sort(),
  };
}

const at = (actor: Actor, x: number, y: number, more: Partial<Actor> = {}) => ({
  ...actor,
  position: { x, y },
  ...more,
});
const foe = (id: string, hp = 7): Actor =>
  freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
    hp,
    inventory: [],
  });
const raging = (actor: Actor): Actor => ({
  ...actor,
  activeEffects: [
    {
      sourceId: `feature:${RAGE}:0`,
      casterId: actor.id,
      modifier: { kind: "resistance", damage: "fire" },
      ends: "spellDuration",
    },
  ],
});
const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const effectsOf = (activation: Activation): readonly LeafEffect[] => {
  const { resolution } = activation;
  if (resolution.kind === "automatic") return resolution.effects;
  return resolution.kind === "save" ? resolution.onFail : resolution.onHit;
};
const spell = (content: RunContext, id: string) =>
  lookup(content, SpellSchema, `srd52:spell/${id}`);
function upcast(content: RunContext, id: string, slot: number): Activation {
  const found = spell(content, id);
  if (!found.activation || !found.upcast) throw new Error(id);
  return scaleActivation(
    found.activation,
    found.upcast.perSlotLevel,
    slot - found.level,
  );
}

describe("upcasting beyond dice, targets and radius (#155)", () => {
  it("raises flat healing, Temporary Hit Points and a bonus by the slot, as Heal, False Life and Aid", async () => {
    const content = await run();
    expect(effectsOf(upcast(content, "heal", 8))[0]).toMatchObject({
      kind: "heal",
      amount: { bonus: { base: 90 } },
    });
    expect(effectsOf(upcast(content, "false-life", 3))[0]).toMatchObject({
      kind: "tempHp",
      amount: { dice: "2d4", bonus: { base: 14 } },
    });
    const aid = effectsOf(upcast(content, "aid", 4));
    expect(aid[0]).toMatchObject({
      modifier: { kind: "bonus", to: "maxHp", amount: { bonus: { base: 15 } } },
    });
    expect(aid[1]).toMatchObject({ amount: { bonus: { base: 15 } } });
  });

  it("adds once at each listed slot, as Magic Weapon's +2 at level 3 and +3 at level 6", async () => {
    const content = await run();
    const bonus = (slot: number) =>
      effectsOf(upcast(content, "magic-weapon", slot)).map((effect) =>
        effect.kind === "modifier" &&
        (effect.modifier.kind === "bonus" ||
          effect.modifier.kind === "damageBonus")
          ? effect.modifier.amount.bonus?.base
          : null,
      );
    expect(bonus(2)).toEqual([1, 1]);
    expect(bonus(5)).toEqual([2, 2]);
    expect(bonus(6)).toEqual([3, 3]);
  });

  it("grows only the damage dealt as it's cast with `initial`, as Vitriolic Sphere's", async () => {
    const content = await run();
    const { resolution } = upcast(content, "vitriolic-sphere", 6);
    if (resolution.kind !== "save") throw new Error("save");
    expect(resolution.damage[0]?.amount.dice).toBe("14d4");
    expect(resolution.onFail[0]).toMatchObject({
      modifier: { damage: [{ amount: { dice: "5d4" } }] },
    });
  });

  it("ends higher spells on a check with the slot's level, as Dispel Magic", async () => {
    const content = await run();
    const caster = hero([], { id: "caster" });
    const target = {
      ...hero([], { id: "friend" }),
      activeEffects: [5, 7].map((level) => ({
        sourceId: `spell:x${String(level)}`,
        casterId: "foe",
        modifier: { kind: "advantage" as const, on: "attacks" as const },
        ends: "spellDuration" as const,
        level,
      })),
    };
    const dispel = effectsOf(upcast(content, "dispel-magic", 5));
    expect(dispel[0]).toMatchObject({ kind: "dispel", maxLevel: 5 });
    // A fighter has no spellcasting ability, so a level 5 slot ends the level 5 spell only.
    const context = contextOf(content, [caster, target], scripted([20]).dice);
    const ended = payloads(
      leafEvents(dispel, "spell:dispel", caster, target, context),
      "effectEnded",
    );
    expect(ended.map(({ sourceId }) => sourceId)).toEqual(["spell:x5"]);
  });

  it("rolls more Hit Point Dice by the slot, stopping once the target is whole", async () => {
    const content = await run();
    const whole = deriveStats(hero([], { level: 5 }), content).maxHp;
    const healer = { ...hero([], { level: 5 }), hp: whole - 15 };
    const context = contextOf(content, [healer], scripted([10, 10, 10]).dice);
    const events = leafEvents(
      [{ kind: "hitDieHeal", dice: 3, bonus: { base: 0, add: [] } }],
      "x",
      healer,
      healer,
      context,
    );
    // d10s: two 10s fill the 15 the fighter is missing, so the third isn't spent.
    expect(payloads(events, "resourceSpent")).toHaveLength(2);
    expect(payloads(events, "healed")[0]?.amount).toBe(15);
  });

  it("ends Armor of Agathys' retaliation with its Temporary Hit Points", () => {
    const warded: Actor = {
      ...hero([]),
      tempHp: 5,
      activeEffects: [
        {
          sourceId: "spell:agathys",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "retaliate", damage: [] },
          ends: "spellDuration",
          endsWithTempHp: true,
        },
      ],
    };
    const state: DndState = {
      actors: { [PLAYER_ACTOR]: warded },
      combat: null,
    };
    const damaged = (amount: number) =>
      applyDndEvent(
        state,
        dndEvent(`${NS}:damaged`, {
          actor: PLAYER_ACTOR,
          amount,
          type: "slashing",
          critical: false,
          massive: false,
        }),
      ).actors[PLAYER_ACTOR]?.activeEffects.length;
    expect(damaged(4)).toBe(1);
    expect(damaged(5)).toBe(0);
  });
});

describe("hit points and death (#201)", () => {
  it("stays conscious at 0 Hit Points while raging, dying of three failures only once the rage ends", async () => {
    const content = await run();
    const barbarian = raging(at(hero(["beyond"]), 0, 0, { hp: 3 }));
    const context = contextOf(content, [barbarian], scripted([]).dice);
    const { events } = dealEvents(
      barbarian,
      [{ amount: 5, type: "slashing" }],
      false,
      context,
    );
    const down = fold(context.state, events).actors[PLAYER_ACTOR];
    if (!down) throw new Error("gone");
    expect(down.hp).toBe(0);
    expect(isDown(down)).toBe(false);
    const failing = { ...down, deathSaves: { successes: 0, failures: 3 } };
    expect(isDead(failing)).toBe(false);
    const calm = applyDndEvent(
      { ...context.state, actors: { [PLAYER_ACTOR]: failing } },
      dndEvent(`${NS}:effectEnded`, {
        actor: PLAYER_ACTOR,
        sourceId: `feature:${RAGE}:0`,
      }),
    ).actors[PLAYER_ACTOR];
    expect(calm && isDead(calm)).toBe(true);
  });

  it("spends a Reaction and a use to fight on until its next turn ends, as Strength before Death", async () => {
    const content = await run();
    const samurai = at(hero(["before"]), 0, 0, { hp: 3 });
    const context = contextOf(content, [samurai], scripted([]).dice);
    const { events } = dealEvents(
      samurai,
      [{ amount: 5, type: "slashing" }],
      false,
      context,
    );
    expect(payloads(events, "effectAdded")[0]).toMatchObject({
      effect: { modifier: { kind: "fightingOn" }, ends: "casterNextTurnEnd" },
    });
    const after = fold(context.state, events).actors[PLAYER_ACTOR];
    expect(after?.budget.reaction).toBe(false);
    expect(after?.resourcesSpent.before).toBe(1);
  });

  it("heals the most hurt nearby by a fallen foe's Hit Dice, once a turn, as Keeper of Souls", async () => {
    const content = await run();
    const cleric = at(hero(["keeper"]), 0, 0);
    const max = deriveStats(cleric, content).maxHp;
    const ally = at(hero([], { id: "ally" }), 1, 0, { hp: 1 });
    const goblin = at(foe("goblin"), 2, 0);
    const context = contextOf(
      content,
      [cleric, ally, goblin],
      scripted([]).dice,
    );
    const { events } = dealEvents(
      goblin,
      [{ amount: 20, type: "slashing" }],
      false,
      context,
    );
    const healed = payloads(events, "healed");
    expect(healed).toHaveLength(1);
    expect(healed[0]).toMatchObject({ actor: "ally" });
    expect(Number(healed[0]?.amount)).toBeGreaterThan(0);
    expect(Number(healed[0]?.amount)).toBeLessThan(max);
    const used = fold(context.state, events);
    const second = at(foe("second"), 2, 1);
    const again = dealEvents(
      second,
      [{ amount: 20, type: "slashing" }],
      false,
      { ...context, state: fold(used, []) },
    );
    expect(
      payloads(
        dealEvents(second, [{ amount: 20, type: "slashing" }], false, {
          ...context,
          state: {
            ...used,
            actors: { ...used.actors, second },
          },
        }).events,
        "healed",
      ),
    ).toEqual([]);
    expect(again.events.length).toBeGreaterThan(0);
  });

  it("calls beasts on dropping to 0, which die at 0 and leave with the fight, as Faithful Summons", async () => {
    const content = await run();
    const druid = at(hero(["summons"]), 0, 0, { hp: 3 });
    const fight = contextOf(content, [druid], scripted([]).dice);
    const combat = fight.state.combat;
    if (!combat) throw new Error("no fight");
    const context = {
      ...fight,
      state: {
        ...fight.state,
        combat: { ...combat, grid: { width: 10, height: 10 } },
      },
    };
    const { events } = dealEvents(
      druid,
      [{ amount: 5, type: "slashing" }],
      false,
      context,
    );
    const called = payloads(events, "summoned").map(
      (item) => item.actor as Actor,
    );
    expect(called).toHaveLength(2);
    const beast = called[0];
    if (beast?.source.kind !== "monster") throw new Error("no beast");
    expect(beast.source.calledBy).toBe(PLAYER_ACTOR);
    expect(beast.side).toBe("party");
    expect(isDead({ ...beast, hp: 0 })).toBe(true);
  });

  it("rides an activation only while raging with `while`, as Reckless Abandon's Temporary Hit Points", async () => {
    const content = await run();
    const effects = (actor: Actor) => {
      const action = deriveStats(actor, content).actions.find((item) =>
        item.id.startsWith("feature:test:feature/reckless"),
      );
      return action ? effectsOf(action.activation).map(({ kind }) => kind) : [];
    };
    const barbarian = hero(["reckless", "abandon"]);
    expect(effects(barbarian)).toEqual(["modifier"]);
    expect(effects(raging(barbarian))).toEqual(["modifier", "tempHp"]);
  });

  it("puts a limit on a cast's targets and spends a use, as Hunter's Rime's no Disengage and Defy Death", async () => {
    const content = await run();
    const ranger = hero(["defy"]);
    const target = at(foe("goblin"), 1, 0);
    const context = contextOf(content, [ranger, target], scripted([]).dice);
    const heal = deriveStats(ranger, content).actions.find(
      (item) => item.id === "spell:srd52:spell/heal",
    ) ?? {
      id: "spell:srd52:spell/heal",
      name: "Heal",
      activation: present(spell(content, "heal").activation),
      spellLevel: 6,
    };
    const ridden = castRiders(ranger, heal, 6, context, [target]).events;
    expect(payloads(ridden, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "defy" },
    ]);
    const marked = fold(context.state, ridden).actors.goblin;
    expect(marked?.activeEffects[0]?.modifier).toMatchObject({
      kind: "actionLimit",
      noDisengage: true,
    });
    const spent = { ...ranger, resourcesSpent: { defy: 1 } };
    expect(castRiders(spent, heal, 6, context, [target]).events).toEqual([]);
  });

  it("raises a creature turned to dust only with `dust`, as True Resurrection", () => {
    const dust = { ...hero([]), hp: 0, dust: true as const };
    const raising: Targeting = {
      creatures: 1,
      range: "touch",
      side: "ally",
      dead: true,
    };
    expect(deadWithin(dust, raising)).toBe(false);
    expect(deadWithin(dust, { ...raising, dust: true })).toBe(true);
  });

  it("makes an undead attacker save or lose its attack, then frees it, as Among the Dead", async () => {
    const content = await run();
    const warlock = at(hero(["undying"]), 0, 0);
    const goblin = at(
      { ...hero([], { id: "goblin" }), side: "enemy" as const },
      1,
      0,
    );
    const context = contextOf(content, [goblin, warlock], scripted([1]).dice);
    const attack = content.system.frames[`${NS}:attackRoll`];
    const action = deriveStats(goblin, content).actions.find(
      (item) => item.activation.resolution.kind === "attack",
    );
    if (!attack || !action) throw new Error("no attack");
    const lost = attack.run(
      { attacker: "goblin", actionId: action.id, target: PLAYER_ACTOR },
      context,
    );
    expect(payloads(lost.events ?? [], "saveRolled")).toHaveLength(1);
    expect(payloads(lost.events ?? [], "damaged")).toEqual([]);
    const saved = attack.run(
      { attacker: "goblin", actionId: action.id, target: PLAYER_ACTOR },
      { ...context, dice: scripted([20]).dice },
    );
    expect(payloads(saved.events ?? [], "resourceSpent")).toContainEqual({
      actor: PLAYER_ACTOR,
      resource: "deterred:goblin",
    });
  });
});

describe("healing and raising (#186)", () => {
  it("counts a fight's rounds and a scene's hour against Revivify's minute", async () => {
    const content = await run();
    const fallen = {
      ...hero([], { id: "fallen" }),
      hp: 0,
      deathSaves: { successes: 0, failures: 3 },
    };
    const revivify: Targeting = {
      creatures: 1,
      range: "touch",
      side: "ally",
      dead: true,
      diedWithin: 0,
      diedWithinRounds: 10,
    };
    const context = contextOf(content, [hero([]), fallen], scripted([]).dice);
    let state = context.state;
    // The dead take no turns, so each turn passed is another round.
    for (let round = 0; round < 11; round += 1) {
      state = applyDndEvent(state, dndEvent(`${NS}:turnAdvanced`, {}));
    }
    expect(state.actors.fallen?.deadRounds).toBe(11);
    expect(deadWithin(present(state.actors.fallen), revivify)).toBe(false);
    const fresh = { ...context.state, combat: null };
    const passed = fold(
      fresh,
      content.system.sceneEntered?.(fresh, content) ?? [],
    );
    expect(passed.actors.fallen?.deadHours).toBe(1);
    expect(deadWithin(present(passed.actors.fallen), revivify)).toBe(false);
  });

  it("only offers a Bloodied-gated activation while Bloodied, as Unearthly Recovery", async () => {
    const content = await run();
    const sorcerer = hero(["recovery"]);
    const stats = deriveStats(sorcerer, content);
    const action = stats.actions.find((item) =>
      item.id.startsWith("feature:test:feature/recovery"),
    );
    if (!action) throw new Error("no action");
    expect(canAfford(action, { ...sorcerer, hp: stats.maxHp }, stats)).toBe(
      false,
    );
    expect(canAfford(action, { ...sorcerer, hp: 1 }, stats)).toBe(true);
  });

  it("deals its caster damage that heals the target twice over, as Life Transference", async () => {
    const content = await run();
    const caster = hero([], { id: "caster" });
    const friend = { ...hero([], { id: "friend" }), hp: 1 };
    const context = contextOf(content, [caster, friend], scripted([3, 3]).dice);
    const events = leafEvents(
      [
        {
          kind: "transference",
          amount: { dice: "2d8" },
          type: "necrotic",
          times: 2,
        },
      ],
      "x",
      caster,
      friend,
      context,
    );
    expect(payloads(events, "damaged")[0]).toMatchObject({
      actor: "caster",
      amount: 6,
    });
    expect(payloads(events, "healed")[0]).toMatchObject({
      actor: "friend",
      amount: Math.min(12, deriveStats(friend, content).maxHp - 1),
    });
  });

  it("gives a reincarnated body its species, without the old one's picks, as Reincarnate", async () => {
    const content = await run();
    const fallen = { ...hero([]), hp: 0 };
    const event = reincarnatedEvent(fallen, "srd52:species/elf", {}, content);
    const state = applyDndEvent(
      { actors: { [PLAYER_ACTOR]: fallen }, combat: null },
      event,
    );
    const build = effectiveBuild(present(state.actors[PLAYER_ACTOR]));
    expect(build?.speciesId).toBe("srd52:species/elf");
    expect(
      deriveStats(present(state.actors[PLAYER_ACTOR]), content).creatureType,
    ).toBe("humanoid");
  });

  it("grows a clone a day each Long Rest and wakes the dead in it once ready, as Clone", async () => {
    const content = await run();
    let state: DndState = {
      actors: { [PLAYER_ACTOR]: hero([]) },
      combat: null,
    };
    state = applyDndEvent(
      state,
      dndEvent(`${NS}:cloneStarted`, { actor: PLAYER_ACTOR, days: 2 }),
    );
    for (let day = 0; day < 2; day += 1) {
      state = applyDndEvent(
        state,
        dndEvent(`${NS}:restFinished`, { rest: "long" }),
      );
    }
    expect(state.actors[PLAYER_ACTOR]?.clone).toBe(0);
    const dead = {
      ...state,
      actors: {
        [PLAYER_ACTOR]: {
          ...present(state.actors[PLAYER_ACTOR]),
          hp: 0,
          deathSaves: { successes: 0, failures: 3 },
        },
      },
    };
    const woke = fold(dead, content.system.sceneEntered?.(dead, content) ?? []);
    const back = present(woke.actors[PLAYER_ACTOR]);
    expect(isDead(back)).toBe(false);
    expect(back.hp).toBe(deriveStats(back, content).maxHp);
    expect(back.clone).toBeUndefined();
  });

  it("recharges only once enough Long Rests have passed with `every`", async () => {
    const content = await run();
    const holder = hero(["cauldron"]);
    const stats = deriveStats(holder, content);
    let spent: Actor["resourcesSpent"] = { cauldron: 1 };
    spent = recovered(spent, stats, "long");
    spent = recovered(spent, stats, "long");
    expect(spent.cauldron).toBe(1);
    spent = recovered(spent, stats, "long");
    expect(spent.cauldron).toBeUndefined();
  });

  it("offers a higher slot between fights, and Greater Restoration a lowered Hit Point maximum", async () => {
    const content = await run();
    const target = { ...hero([], { id: "friend" }), maxHpLoss: 4 };
    const cleric = hero([]);
    const context = contextOf(content, [cleric, target], scripted([]).dice);
    const restored = leafEvents(
      [
        {
          kind: "cure",
          conditions: ["charmed"],
          curse: true,
          maxHp: true,
          exhaustion: true,
        },
      ],
      "x",
      cleric,
      target,
      context,
    );
    expect(payloads(restored, "maxHpReduced")).toEqual([
      { actor: "friend", amount: -4 },
    ]);
    expect(fold(context.state, restored).actors.friend?.maxHpLoss).toBe(0);
    // A fighter casts nothing, so between fights there's nothing to upcast.
    expect(
      sceneCastActions({ ...context.state, combat: null }, content).some(
        (action) => action.label.includes("slot)"),
      ),
    ).toBe(false);
    expect(nextDndDecision(context.state, content)).not.toBeNull();
  });
});

// A cleric from the SRD pregen who knows these spells.
function cleric(
  content: RunContext,
  spells: readonly string[],
  level = 3,
): Actor {
  const pregen = PregenSchema.parse(content.content("srd52:pregen/cleric"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("no levels");
  return freshActor({
    id: PLAYER_ACTOR,
    name: "Cleric",
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
    inventory: [],
  });
}

describe("a reincarnated body (#186)", () => {
  it("drops the printed species' picks even after a second event, and the player picks the new ones", async () => {
    const content = await run();
    const keen = hero([]);
    if (keen.source.kind !== "character" || !keen.source.build) {
      throw new Error("no build");
    }
    const [first, ...rest] = keen.source.build.levels;
    if (!first) throw new Error("no level");
    const fallen: Actor = {
      ...keen,
      hp: 0,
      deathSaves: { successes: 0, failures: 3 },
      source: {
        kind: "character",
        build: {
          ...keen.source.build,
          speciesId: "test:species/keen",
          levels: [
            {
              ...first,
              answers: [
                ...first.answers,
                { kind: "skills", values: ["perception"] },
              ],
            },
            ...rest,
          ],
        },
      },
    };
    const context = {
      ...contextOf(content, [fallen], scripted([2]).dice),
      state: { actors: { [PLAYER_ACTOR]: fallen }, combat: null },
    };
    const raised = leafEvents(
      [
        {
          kind: "reincarnate",
          species: ["test:species/plain", "test:species/plain"],
        },
      ],
      "x",
      fallen,
      fallen,
      context,
    );
    expect(deriveStats(fallen, content).skills).toContain("perception");
    let state = fold(context.state, raised);
    const skills = () =>
      deriveStats(present(state.actors[PLAYER_ACTOR]), content).skills;
    expect(skills()).not.toContain("perception");
    // The player's own picks come as a second event, which still drops the printed species' pick.
    const asked = content.system.frames[`${NS}:reincarnate`]?.run(
      { picks: {} },
      { ...context, state },
    );
    state = fold(state, asked?.events ?? []);
    expect(effectiveBuild(present(state.actors[PLAYER_ACTOR]))?.speciesId).toBe(
      "test:species/plain",
    );
    expect(skills()).not.toContain("perception");
    expect(isDead(present(state.actors[PLAYER_ACTOR]))).toBe(false);
  });
});

describe("casting between fights (#186)", () => {
  it("offers a higher slot, which heals more, and a ritual with no slot", async () => {
    const content = await run();
    const priest = cleric(content, [
      "srd52:spell/cure-wounds",
      "srd52:spell/gentle-repose",
    ]);
    const hurt = { ...hero([], { id: "hurt" }), hp: 1 };
    const fallen = {
      ...hero([], { id: "fallen" }),
      hp: 0,
      deathSaves: { successes: 0, failures: 3 },
    };
    const state: DndState = {
      actors: { [PLAYER_ACTOR]: priest, hurt, fallen },
      combat: null,
      gold: 10,
    };
    const offered = sceneCastActions(state, content);
    const labels = offered.map((action) => action.label);
    expect(labels).toContain("Cure Wounds (level 2 slot)");
    expect(labels).toContain("Gentle Repose (ritual)");
    const cast = content.system.storyEffects[`${NS}:castBetween`];
    const upcast = offered.find(
      (action) => action.label === "Cure Wounds (level 2 slot)",
    );
    const healed = cast?.apply(upcast?.args, {
      state,
      dice: scripted([1, 1, 1, 1]).dice,
      ...content,
    });
    expect(payloads(healed?.events ?? [], "resourceSpent")).toContainEqual({
      actor: PLAYER_ACTOR,
      resource: "slot:2",
    });
    const ritual = offered.find(
      (action) => action.label === "Gentle Repose (ritual)",
    );
    const reposed = cast?.apply(ritual?.args, {
      state,
      dice: scripted([]).dice,
      ...content,
    });
    expect(payloads(reposed?.events ?? [], "reposed")).toEqual([
      { actor: "fallen" },
    ]);
    expect(
      payloads(reposed?.events ?? [], "resourceSpent").filter(({ resource }) =>
        String(resource).startsWith("slot:"),
      ),
    ).toEqual([]);
  });
});

describe("the pieces those entries share", () => {
  it("removes several conditions from one use, 5 of the pool each, as Restoring Touch", async () => {
    const content = await run();
    const paladin = hero(["pool"]);
    const condition = (name: "stunned" | "blinded" | "deafened") => ({
      sourceId: `x:${name}`,
      casterId: "foe",
      modifier: { kind: "condition" as const, condition: name },
      ends: "spellDuration" as const,
    });
    const friend = {
      ...hero([], { id: "friend" }),
      activeEffects: [
        condition("stunned"),
        condition("blinded"),
        condition("deafened"),
      ],
    };
    const context = contextOf(content, [paladin, friend], scripted([]).dice);
    const pooled = (left: number) =>
      leafEvents(
        [
          {
            kind: "cure",
            conditions: ["blinded", "deafened", "stunned"],
            pool: { resource: "pool", per: 5 },
          },
        ],
        "x",
        { ...paladin, resourcesSpent: { pool: 15 - left } },
        friend,
        context,
      );
    // 10 left ends two of the three, the worst first, and spends the 10.
    const ten = pooled(10);
    expect(
      payloads(ten, "conditionRemoved").map(({ condition }) => condition),
    ).toEqual(["stunned", "blinded"]);
    expect(payloads(ten, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "pool", amount: 10 },
    ]);
    expect(payloads(pooled(4), "conditionRemoved")).toEqual([]);
  });

  it("heals by Hit Point Dice as many as a slot spell's level, as Simbul's Synostodweomer", async () => {
    const content = await run();
    const caster = { ...hero([], { level: 5 }), hp: 1 };
    const mended = {
      ...caster,
      activeEffects: [
        {
          sourceId: "spell:synostodweomer",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "castHitDice" as const,
            bonus: { base: 2, add: [] },
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const context = contextOf(content, [mended], scripted([4, 4, 4]).dice);
    const heal: KnownAction = {
      id: "spell:srd52:spell/heal",
      name: "Heal",
      activation: present(spell(content, "heal").activation),
      spellLevel: 6,
    };
    const events = castRiders(mended, heal, 3, context).events;
    expect(payloads(events, "resourceSpent")).toHaveLength(3);
    expect(payloads(events, "healed")[0]?.amount).toBe(14);
    expect(castRiders(mended, heal, undefined, context).events).toEqual([]);
  });

  it("heals the most hurt of the caster's side in an area too, as Wither and Bloom", async () => {
    const content = await run();
    const caster = at(hero([]), 0, 0);
    const friend = at(hero([], { id: "friend" }), 1, 0, { hp: 2 });
    const goblin = at(foe("goblin"), 2, 0);
    const context = contextOf(
      content,
      [caster, friend, goblin],
      scripted([]).dice,
    );
    const action: KnownAction = {
      id: "spell:bloom",
      name: "Bloom",
      spellLevel: 2,
      activation: {
        cost: ["action"],
        targeting: {
          area: { shape: "sphere", radius: 10 },
          range: 60,
          side: "enemy",
        },
        resolution: {
          kind: "save",
          ability: "con",
          dc: { base: 30, add: [] },
          damage: [{ amount: { dice: "1d6" }, type: "necrotic" }],
          onSuccessDamage: "half",
          onFail: [],
          onSuccess: [],
          chosen: [{ kind: "heal", amount: { bonus: { base: 3, add: [] } } }],
        },
      },
    };
    const result = resolveAction(
      action,
      caster,
      [goblin],
      context,
      undefined,
      false,
      { x: 1, y: 0 },
    );
    expect(payloads(result.events ?? [], "healed")).toEqual([
      expect.objectContaining({ actor: "friend", amount: 3 }),
    ]);
  });

  it("grows a feature's dice at levels in a class, and a burst with them, as Jolt to Life's lightning", async () => {
    const content = await run();
    const burstDice = (level: number) => {
      const action = deriveStats(
        hero(["jolt"], { level }),
        content,
      ).actions.find((item) => item.id.startsWith("feature:test:feature/jolt"));
      const resolution = action?.activation.resolution;
      return resolution?.kind === "automatic"
        ? resolution.burst?.damage[0]?.amount.dice
        : undefined;
    };
    expect(burstDice(2)).toBe("2d4");
    expect(burstDice(3)).toBe("3d4");
    expect(burstDice(5)).toBe("4d4");
  });

  it("leaves the player's Hit Dice for them to spend from a spell's Short Rest, as Prayer of Healing", async () => {
    const content = await run();
    const player = { ...hero([], { level: 3 }), hp: 1 };
    const context = {
      ...contextOf(content, [player], scripted([]).dice),
      state: { actors: { [PLAYER_ACTOR]: player }, combat: null },
    };
    const events = shortRestFor(player, context);
    expect(
      payloads(events, "resourceSpent").map(({ resource }) => resource),
    ).toEqual(["shortRest:given"]);
    const asked = content.system.frames[`${NS}:givenDice`]?.run({}, context);
    expect(asked?.frames?.length).toBe(1);
  });
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}
