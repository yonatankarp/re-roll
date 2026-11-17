import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import type { Dice, SystemEvent } from "#sdk";
import {
  damageEvents,
  dealEvents,
  resolveAction,
  sharedHealing,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { runTakeAction } from "../plugins/systems/dnd5.5e/core/combat/actions.ts";
import {
  runAdvanceTurn,
  runFinishTurn,
} from "../plugins/systems/dnd5.5e/core/combat/turn.ts";
import { castRiders } from "../plugins/systems/dnd5.5e/core/combat/school.ts";
import { DEATH_SAVE } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { hitDieHealing } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  type KnownAction,
  deriveStats,
  lookup,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { SpellSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// Made-up traits for the hit point mechanics of #174: ids and numbers only.
const use = (id: string, max = 1, rests = ["longRest"]) => ({
  resources: [
    {
      id,
      max: { base: max },
      recharge: rests.map((on) => ({ on, amount: "all" })),
    },
  ],
});
const RAGE = "test:feature/rage";
const FIXTURES = [
  trait(
    "relentless",
    [
      {
        kind: "dropToOne",
        resource: "relentless",
        while: [RAGE],
        save: { ability: "con", dc: 10, step: 5 },
        hp: { base: 7 },
      },
    ],
    use("relentless", 10),
  ),
  trait(
    "protector",
    [{ kind: "dropToOne", resource: "protector", allies: true }],
    use("protector"),
  ),
  trait(
    "husk",
    [
      {
        kind: "dropToOne",
        resource: "husk",
        hp: { base: 4 },
        burst: {
          radius: 30,
          save: "con",
          damage: { bonus: { base: 6 } },
          type: "necrotic",
        },
        exhaustion: 1,
      },
    ],
    use("husk"),
  ),
  trait(
    "grave",
    [
      {
        kind: "dropToOne",
        resource: "grave",
        except: ["radiant"],
        notCritical: true,
      },
    ],
    use("grave"),
  ),
  trait(
    "last-stand",
    [
      {
        kind: "dropToOne",
        resource: "last-stand",
        hp: { base: 1, add: [{ kind: "maxHp", half: true }] },
      },
    ],
    use("last-stand"),
  ),
  trait("survivor", [{ kind: "deathSaveRoll", twentyFrom: 18 }]),
  trait("periapt", [
    { kind: "deathSaveRoll", floor: 10 },
    { kind: "hitDieRolls", double: true },
  ]),
  trait(
    "defy",
    [
      {
        kind: "deathSaveHeal",
        resource: "defy",
        amount: { bonus: { base: 5 } },
      },
    ],
    use("defy"),
  ),
  trait(
    "vengeance",
    [
      {
        kind: "deathSaveRescue",
        resource: "vengeance",
        within: 60,
        radius: 30,
        damage: { bonus: { base: 3 } },
        type: "radiant",
      },
    ],
    use("vengeance"),
  ),
  trait("rally", [
    { kind: "regeneration", hp: { bonus: { base: 5 } }, bloodied: true },
  ]),
  trait("mending", [{ kind: "regeneration", hp: 2, turnEnd: true }]),
  trait("resilience", [
    {
      kind: "restTempHp",
      rests: ["short"],
      allies: true,
      amount: { base: 8 },
      alliesAmount: { base: 3 },
    },
  ]),
  trait("tireless", [{ kind: "restExhaustion" }]),
  trait("vitality", [
    {
      kind: "castRider",
      uses: ["test:spell/mark"],
      effects: [{ kind: "tempHp", amount: { bonus: { base: 4 } } }],
    },
    {
      kind: "turnTempHp",
      while: [RAGE],
      within: 10,
      amount: { bonus: { base: 6 } },
    },
  ]),
  trait("blessing", [
    {
      kind: "onKill",
      within: 10,
      mine: true,
      effects: [{ kind: "tempHp", amount: { bonus: { base: 9 } } }],
    },
  ]),
  trait("fortified", [{ kind: "healBonus", amount: { base: 4 } }]),
  trait("hardy", [
    {
      kind: "modifier",
      modifier: {
        kind: "bonus",
        to: "maxHp",
        amount: { bonus: { base: 100 } },
      },
    },
  ]),
];

async function run(): Promise<RunContext> {
  const base = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...base,
    content: (id) => byId.get(id) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...byId.keys()].sort(),
  };
}

const at = (actor: Actor, x: number, y: number, more: Partial<Actor> = {}) => ({
  ...actor,
  position: { x, y },
  ...more,
});

function foe(id: string, hp = 30): Actor {
  return freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
    hp,
    inventory: [],
  });
}

const raging = (actor: Actor): Actor => ({
  ...actor,
  activeEffects: [
    {
      sourceId: `feature:${RAGE}:0`,
      casterId: actor.id,
      modifier: { kind: "resistance", damage: "slashing" },
      ends: "spellDuration",
    },
  ],
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}

const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);
const kinds = (events: readonly SystemEvent[]) =>
  events.map((event) => event.kind);

// Hits `target` for `amount` slashing damage in a fight of `actors`, and the state after.
function hit(
  content: RunContext,
  actors: readonly Actor[],
  target: string,
  amount: number,
  dice: Dice,
  type: "slashing" | "radiant" = "slashing",
  critical = false,
) {
  const context = { ...contextOf(content, actors, dice), ...content };
  const victim = context.state.actors[target];
  if (!victim) throw new Error(target);
  const events = damageEvents(victim, amount, type, critical, context);
  return { events, state: fold(context.state, events) };
}

describe("hit points, temporary hit points and death (#174)", () => {
  it("changes the Hit Points instead of dropping to 0 only while raging, after a save whose DC rises with each use", async () => {
    const content = await run();
    const barbarian = at(hero(["relentless"]), 0, 0, { hp: 5 });
    const calm = hit(
      content,
      [barbarian],
      barbarian.id,
      9,
      scripted([20]).dice,
    );
    expect(calm.state.actors[barbarian.id]?.hp).toBe(0);
    const raged = hit(
      content,
      [raging(barbarian)],
      barbarian.id,
      9,
      scripted([20]).dice,
    );
    expect(raged.state.actors[barbarian.id]?.hp).toBe(7);
    expect(raged.state.actors[barbarian.id]?.resourcesSpent.relentless).toBe(1);
    // Two uses in, the DC is 20, which a 10 doesn't reach.
    const worn = raging({ ...barbarian, resourcesSpent: { relentless: 2 } });
    const failed = hit(content, [worn], barbarian.id, 9, scripted([10]).dice);
    expect(kinds(failed.events)).toContain(`${NS}:saveRolled`);
    expect(failed.state.actors[barbarian.id]?.hp).toBe(0);
  });

  it("drops an ally to 1 instead, spending the bearer's use", async () => {
    const content = await run();
    const warlock = at(hero(["protector"], { id: "warlock" }), 1, 0);
    const ally = at(hero([], { id: "ally" }), 0, 0, { hp: 3 });
    const { state } = hit(
      content,
      [warlock, ally],
      "ally",
      8,
      scripted([]).dice,
    );
    expect(state.actors.ally?.hp).toBe(1);
    expect(state.actors.warlock?.resourcesSpent.protector).toBe(1);
  });

  it("bursts on nearby foes and tires the bearer as it gets back up", async () => {
    const content = await run();
    const warlock = at(hero(["husk"]), 0, 0, { hp: 2 });
    const near = at(foe("near"), 2, 0);
    const far = at(foe("far"), 9, 0);
    const { state } = hit(
      content,
      [warlock, near, far],
      warlock.id,
      6,
      scripted([1]).dice,
    );
    expect(state.actors[warlock.id]?.hp).toBe(4);
    expect(state.actors[warlock.id]?.exhaustion).toBe(1);
    expect(state.actors.near?.hp).toBe(24);
    expect(state.actors.far?.hp).toBe(30);
  });

  it("holds against neither Radiant damage nor a Critical Hit, as Strength of the Grave", async () => {
    const content = await run();
    const sorcerer = at(hero(["grave"]), 0, 0, { hp: 2 });
    const dice = () => scripted([]).dice;
    expect(
      hit(content, [sorcerer], sorcerer.id, 5, dice()).state.actors[sorcerer.id]
        ?.hp,
    ).toBe(1);
    expect(
      hit(content, [sorcerer], sorcerer.id, 5, dice(), "radiant").state.actors[
        sorcerer.id
      ]?.hp,
    ).toBe(0);
    expect(
      hit(content, [sorcerer], sorcerer.id, 5, dice(), "slashing", true).state
        .actors[sorcerer.id]?.hp,
    ).toBe(0);
  });

  it("lands at 1 plus half the Hit Point maximum, as Last Stand", async () => {
    const content = await run();
    const standing = at(hero(["last-stand"]), 0, 0, { hp: 2 });
    const max = deriveStats(standing, content).maxHp;
    const { state } = hit(
      content,
      [standing],
      standing.id,
      9,
      scripted([]).dice,
    );
    expect(state.actors[standing.id]?.hp).toBe(1 + Math.floor(max / 2));
  });

  function deathSave(content: RunContext, actor: Actor, roll: number) {
    const context = {
      ...contextOf(content, [actor], scripted([roll]).dice),
      ...content,
    };
    const result = runTakeAction(
      { actor: actor.id, answer: DEATH_SAVE },
      context,
    );
    return fold(context.state, result.events ?? []).actors[actor.id];
  }

  it("counts an 18 as a 20 with Survivor, and a failure as a 10 with a Periapt of Wound Closure", async () => {
    const content = await run();
    const down = (traits: string[]) => at(hero(traits), 0, 0, { hp: 0 });
    expect(deathSave(content, down(["survivor"]), 18)?.hp).toBe(1);
    expect(deathSave(content, down([]), 18)?.hp).toBe(0);
    expect(deathSave(content, down(["periapt"]), 3)?.deathSaves).toEqual({
      successes: 1,
      failures: 0,
    });
  });

  it("heals on a successful Death Saving Throw, once, as Defy Death", async () => {
    const content = await run();
    const dying = at(hero(["defy"]), 0, 0, { hp: 0 });
    expect(deathSave(content, dying, 12)?.hp).toBe(5);
    expect(
      deathSave(content, { ...dying, resourcesSpent: { defy: 1 } }, 12)?.hp,
    ).toBe(0);
  });

  it("springs an ally back up as its turn starts, burning and blinding foes round it, as Searing Vengeance", async () => {
    const content = await run();
    const warlock = at(hero(["vengeance"], { id: "warlock" }), 3, 0);
    const dying = at(hero([], { id: "dying" }), 0, 0, { hp: 0 });
    const near = at(foe("near"), 1, 0);
    const context = {
      ...contextOf(content, [warlock, dying, near], scripted([]).dice),
      ...content,
    };
    const events = runAdvanceTurn(context).events ?? [];
    const after = fold(context.state, events);
    const max = deriveStats(dying, content).maxHp;
    expect(after.actors.dying?.hp).toBe(Math.floor(max / 2));
    expect(after.actors.near?.hp).toBe(27);
    expect(
      after.actors.near?.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "condition" && modifier.condition === "blinded",
      ),
    ).toBe(true);
    expect(after.actors.warlock?.resourcesSpent.vengeance).toBe(1);
  });

  it("heals at the start of a turn only while Bloodied, and at its end with turnEnd", async () => {
    const content = await run();
    const max = deriveStats(hero(["rally"]), content).maxHp;
    const start = (actor: Actor) => {
      const context = {
        ...contextOf(content, [foe("f"), actor], scripted([]).dice),
        ...content,
      };
      return fold(context.state, runAdvanceTurn(context).events ?? []).actors[
        actor.id
      ]?.hp;
    };
    expect(start(at(hero(["rally"]), 0, 0, { hp: 1 }))).toBe(6);
    expect(start(at(hero(["rally"]), 0, 0, { hp: max }))).toBe(max);
    const mending = at(hero(["mending"]), 0, 0, { hp: 1 });
    expect(start(mending)).toBe(1);
    // Its own turn ending heals it.
    const ending = {
      ...contextOf(content, [mending, foe("f")], scripted([]).dice),
      ...content,
    };
    expect(
      fold(ending.state, runFinishTurn(ending).events ?? []).actors[mending.id]
        ?.hp,
    ).toBe(3);
  });

  it("gives allies their own share of a rest's Temporary Hit Points, and a Short Rest takes off Exhaustion", async () => {
    const content = await run();
    const warlock = hero(["resilience", "tireless"], { id: "warlock" });
    const ally = hero([], { id: "ally" });
    const { state } = settle(
      content,
      [{ ...warlock, exhaustion: 2 }, ally],
      [{ kind: `${NS}:finishRest`, payload: { rest: "short" } }],
      scripted([]).dice,
    );
    expect(state.actors.warlock?.tempHp).toBe(8);
    expect(state.actors.ally?.tempHp).toBe(3);
    expect(state.actors.warlock?.exhaustion).toBe(1);
  });

  it("gives Temporary Hit Points for casting a spell, and to an ally nearby as a raging turn starts", async () => {
    const content = await run();
    const barbarian = at(hero(["vitality"]), 0, 0);
    const action = {
      id: "spell:test:spell/mark",
      spellLevel: 1,
      activation: {
        resolution: { kind: "automatic", damage: [], effects: [] },
      },
    } as unknown as KnownAction;
    const context = {
      ...contextOf(content, [barbarian], scripted([]).dice),
      ...content,
    };
    expect(kinds(castRiders(barbarian, action, 1, context).events)).toContain(
      `${NS}:tempHpGained`,
    );
    const ally = at(hero([], { id: "ally" }), 1, 0);
    const turn = {
      ...contextOf(
        content,
        [foe("f"), raging(barbarian), ally],
        scripted([]).dice,
      ),
      ...content,
    };
    expect(
      fold(turn.state, runAdvanceTurn(turn).events ?? []).actors.ally?.tempHp,
    ).toBe(6);
  });

  it("gives Temporary Hit Points as a foe drops nearby, as Dark One's Blessing", async () => {
    const content = await run();
    const warlock = at(hero(["blessing"]), 0, 0);
    const near = at(foe("near", 3), 1, 0);
    const context = {
      ...contextOf(content, [near, warlock], scripted([]).dice),
      ...content,
    };
    const dealt = dealEvents(
      near,
      [{ amount: 5, type: "fire" }],
      false,
      context,
    );
    expect(fold(context.state, dealt.events).actors[warlock.id]?.tempHp).toBe(
      9,
    );
  });

  function cast(
    content: RunContext,
    spell: string,
    target: Actor,
    rolls: readonly number[],
  ) {
    const caster = at(hero([], { id: "caster" }), 0, 0);
    const { activation, level } = lookup(content, SpellSchema, spell);
    if (!activation) throw new Error(spell);
    const action: KnownAction = {
      id: `spell:${spell}`,
      name: spell,
      activation,
      spellLevel: level,
    };
    const context = {
      ...contextOf(content, [caster, target], scripted(rolls).dice),
      ...content,
    };
    const result = resolveAction(action, caster, [target], context);
    return fold(context.state, result.events ?? []);
  }

  it("lowers the Hit Point maximum by Harm's damage until a Long Rest", async () => {
    const content = await run();
    const target = at(hero(["hardy"], { id: "target" }), 1, 0);
    const full = deriveStats(target, content).maxHp;
    // A failed save, then fourteen 1s for 14 Necrotic damage.
    const struck = cast(content, "srd52:spell/harm", { ...target, hp: full }, [
      1,
      ...Array<number>(14).fill(1),
    ]);
    const after = struck.actors.target;
    if (!after) throw new Error("target");
    const lost = after.maxHpLoss ?? 0;
    expect(lost).toBe(14);
    expect(deriveStats(after, content).maxHp).toBe(full - lost);
    expect(after.hp).toBeLessThanOrEqual(full - lost);
    const rested = applyDndEvent(
      struck,
      dndEvent(`${NS}:rested`, {
        actor: "target",
        rest: "long",
        maxHp: full,
        resourcesSpent: {},
      }),
    );
    expect(rested.actors.target?.maxHpLoss).toBeUndefined();
  });

  it("turns a character Disintegrate drops to dust, past death saves", async () => {
    const content = await run();
    const struck = cast(
      content,
      "srd52:spell/disintegrate",
      at(hero(["hardy"], { id: "target" }), 1, 0, { hp: 30 }),
      [1, ...Array<number>(10).fill(1)],
    );
    expect(struck.actors.target?.deathSaves.failures).toBe(3);
  });

  it("slays the weak outright and spares the deaf, as Wail of the Banshee", async () => {
    const content = await run();
    const caster = at(hero([], { id: "caster" }), 0, 0);
    const action = {
      id: "spell:test:wail",
      name: "Wail",
      spellLevel: 9,
      activation: {
        cost: [],
        targeting: { creatures: 3, range: 60, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "con",
          dc: { base: 30, add: [] },
          slayAtMost: 50,
          heard: true,
          damage: [
            { amount: { bonus: { base: 10, add: [] } }, type: "psychic" },
          ],
          onSuccessDamage: "half",
          onFail: [],
          onSuccess: [],
        },
      },
    } as unknown as KnownAction;
    const weak = at(foe("weak", 40), 1, 0);
    const strong = at(foe("strong", 80), 2, 0);
    const deaf = at(foe("deaf", 40), 3, 0, {
      activeEffects: [
        {
          sourceId: "x",
          casterId: "x",
          modifier: { kind: "condition", condition: "deafened" },
          ends: "spellDuration",
        },
      ],
    });
    const context = {
      ...contextOf(content, [caster, weak, strong, deaf], scripted([1]).dice),
      ...content,
    };
    const after = fold(
      context.state,
      resolveAction(action, caster, [weak, strong, deaf], context).events ?? [],
    );
    expect(after.actors.weak?.hp).toBe(0);
    expect(after.actors.strong?.hp).toBe(70);
    expect(after.actors.deaf?.hp).toBe(40);
  });

  it("shares Temporary Hit Points to divide evenly, as Power Word Fortify", async () => {
    const content = await run();
    const caster = hero([], { id: "caster" });
    const targets = [
      hero([], { id: "a" }),
      hero([], { id: "b" }),
      hero([], { id: "c" }),
    ];
    const context = {
      ...contextOf(content, [caster, ...targets], scripted([]).dice),
      ...content,
    };
    const share = sharedHealing(
      [
        {
          kind: "tempHp",
          divided: true,
          amount: { bonus: { base: 120, add: [] } },
        },
      ],
      targets,
      caster,
      context,
    );
    expect(share(present(targets[0]))).toEqual([
      { kind: "tempHp", amount: { bonus: { base: 40, add: [] } } },
    ]);
  });

  it("doubles what a Hit Point Die heals, and adds healing once a turn, as Boon of Fortitude", async () => {
    const content = await run();
    expect(hitDieHealing(6, deriveStats(hero(["periapt"]), content))).toBe(12);
    expect(hitDieHealing(6, deriveStats(hero([]), content))).toBe(6);
    const boon = at(hero(["fortified"]), 0, 0, { hp: 1 });
    const action = {
      id: "spell:test:cure",
      name: "Cure",
      spellLevel: 1,
      activation: {
        cost: [],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [{ kind: "heal", amount: { bonus: { base: 2, add: [] } } }],
        },
      },
    } as unknown as KnownAction;
    const context = {
      ...contextOf(content, [boon], scripted([]).dice),
      ...content,
    };
    const once = fold(
      context.state,
      resolveAction(action, boon, [boon], context).events ?? [],
    );
    expect(once.actors[boon.id]?.hp).toBe(7);
    const again = fold(
      once,
      resolveAction(
        action,
        present(once.actors[boon.id]),
        [present(once.actors[boon.id])],
        { ...context, state: once },
      ).events ?? [],
    );
    expect(again.actors[boon.id]?.hp).toBe(9);
  });
});
