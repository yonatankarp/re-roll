import {
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import { AWAIT_FRAME } from "../engine/kernel/system.ts";
import type { RunContext } from "../engine/run/turn.ts";
import {
  type Context,
  provokers,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  shapeOf,
  weakestBeast,
} from "../plugins/systems/dnd5.5e/core/forms.ts";
import {
  formsOnly,
  shapesIn,
  shapeShiftActions,
} from "../plugins/systems/dnd5.5e/core/import/shapes.ts";
import {
  dealEvents,
  leafEvents,
  resolveAction,
  rollSave,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { runAdvanceTurn } from "../plugins/systems/dnd5.5e/core/combat/turn.ts";
import {
  actorOf,
  inReach,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { darkvisionOf } from "../plugins/systems/dnd5.5e/core/sight.ts";
import { finalDamage } from "../plugins/systems/dnd5.5e/core/rules.ts";
import { sizeOf } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { choosePolicy } from "../plugins/systems/dnd5.5e/core/policy.ts";
import { nextDndDecision } from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  damageResponses,
  deriveStats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  freshActor,
  hasCondition,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import type { KnownAction } from "../plugins/systems/dnd5.5e/core/stats.ts";

// Monster traits and reactions read from stat blocks (issue #8), on made-up stat blocks.

const club = {
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
};

const statBlock = (
  id: string,
  fields: Readonly<Record<string, unknown>> = {},
): { readonly id: string } & Record<string, unknown> => ({
  id,
  name: id,
  ac: 10,
  hp: 500,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  actions: [club],
  ...fields,
});

const parry = (melee: boolean) => ({
  name: "Parry",
  activation: {
    cost: ["reaction"],
    trigger: { hitByAttack: true, ...(melee ? { melee: true } : {}) },
    targeting: { self: true },
    resolution: {
      kind: "automatic",
      damage: [],
      effects: [{ kind: "acAgainstHit", bonus: 5 }],
    },
  },
});

const BLOCKS = [
  statBlock("test:monster/cat", {
    size: "tiny",
    creatureType: "beast",
    hp: 2,
    text: "CR 0 (XP 10; PB +2)",
  }),
  statBlock("test:monster/dummy", { text: "CR 5 (XP 1,800; PB +3)" }),
  statBlock("test:monster/parrier", { actions: [club, parry(true)] }),
  statBlock("test:monster/evader", {
    passives: [{ kind: "evasion", anySave: false }],
  }),
  statBlock("test:monster/dodger", {
    passives: [{ kind: "evasion", anySave: true }],
  }),
  statBlock("test:monster/turner", {
    passives: [{ kind: "spellTurning", upTo: 7 }],
  }),
  statBlock("test:monster/frenzied", {
    passives: [{ kind: "attackAdvantage", when: "targetHurt" }],
  }),
  statBlock("test:monster/furious", {
    passives: [{ kind: "attackAdvantage", when: "bloodied" }],
  }),
  statBlock("test:monster/terror", {
    passives: [{ kind: "attackAdvantage", when: "targetFrightened" }],
  }),
  statBlock("test:monster/flyer", {
    passives: [{ kind: "noOpportunityAttacks" }],
  }),
  statBlock("test:monster/golem", {
    text: "CR 5 (XP 1,800; PB +3)",
    passives: [{ kind: "immutableForm" }],
  }),
  statBlock("test:monster/absorber", {
    passives: [
      { kind: "modifier", modifier: { kind: "immunity", damage: "fire" } },
      { kind: "absorb", damage: ["fire"] },
    ],
  }),
  statBlock("test:monster/flamer", {
    actions: [
      {
        ...club,
        activation: {
          ...club.activation,
          resolution: {
            ...club.activation.resolution,
            damage: [
              { amount: { dice: "1d6" }, type: "slashing" },
              { amount: { dice: "2d6" }, type: "fire" },
            ],
          },
        },
      },
    ],
  }),
  statBlock("test:monster/pudding", {
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "retaliate",
          damage: [{ amount: { dice: "1d8" }, type: "acid" }],
          grapple: true,
        },
      },
    ],
  }),
  statBlock("test:monster/devil", {
    passives: [{ kind: "ward", suppressed: "attacking" }],
  }),
  statBlock("test:monster/horror", {
    passives: [
      { kind: "spellImmunity", spells: ["test:spell/zap"] },
      { kind: "stoneRestoration", hp: 50 },
    ],
  }),
  statBlock("test:monster/berserk", {
    passives: [
      {
        kind: "saveAdvantage",
        abilities: ["str", "dex", "con", "int", "wis", "cha"],
        bloodied: true,
      },
      {
        kind: "onDamage",
        damage: ["fire"],
        modifiers: [{ kind: "disadvantage", on: "attacks" }],
      },
      { kind: "reactive" },
    ],
  }),
  statBlock("test:monster/troll", {
    hp: 100,
    passives: [
      {
        kind: "severedLimbs",
        monster: "test:monster/dummy",
        slashing: 15,
        resource: "day:loathsome-limbs",
        uses: 4,
      },
      { kind: "regeneration", hp: 15 },
    ],
  }),
  statBlock("test:monster/beholder", {
    actions: [
      {
        name: "Eye Rays",
        activation: {
          cost: ["action"],
          targeting: { creatures: 1, range: 120, side: "enemy" },
          resolution: {
            kind: "automatic",
            effects: [
              { kind: "randomAction", of: ["Ray A", "Ray B"], times: 2 },
            ],
          },
        },
      },
      ...["Ray A", "Ray B"].map((name) => ({
        name,
        rolled: true,
        activation: {
          cost: [],
          targeting: { creatures: 1, range: 120, side: "enemy" },
          resolution: {
            kind: "automatic",
            damage: [
              { amount: { bonus: { base: 3, add: [] } }, type: "force" },
            ],
          },
        },
      })),
    ],
  }),
  statBlock("test:monster/wraith", {
    actions: [
      {
        name: "Create Specter",
        activation: {
          cost: ["action"],
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            effects: [
              {
                kind: "raiseCorpse",
                monster: "test:monster/dummy",
                range: 10,
                creatureTypes: ["humanoid"],
              },
            ],
          },
        },
      },
    ],
  }),
  { ...statBlock("test:monster/corpse"), creatureType: "humanoid" },
  {
    id: "test:spell/zap",
    name: "Zap",
    level: 1,
    school: "evocation",
    classes: [],
    castingTime: "Action",
    range: "60 feet",
    components: "V",
    duration: "instantaneous",
    text: "Zap.",
    automation: "full",
  },
  // A werewolf in small: Bite in wolf shape only, Club in its true one only, and a Shape-Shift to each.
  statBlock("test:monster/were", {
    actions: [
      { ...club, shapes: ["humanoid"] },
      {
        ...club,
        name: "Bite",
        shapes: ["wolf"],
        activation: {
          ...club.activation,
          resolution: {
            ...club.activation.resolution,
            damage: [{ amount: { dice: "4d6" }, type: "piercing" }],
          },
        },
      },
      ...shapeShiftActions(
        [{ name: "humanoid" }, { name: "wolf" }] as never,
        "bonusAction",
      ),
    ],
    shapes: [
      { name: "humanoid", speed: 30 },
      {
        name: "wolf",
        size: "large",
        speed: 40,
        passives: [{ kind: "noOpportunityAttacks" }],
      },
    ],
  }),
];

async function base(): Promise<RunContext> {
  const run = (await loadAdventure("goblin-ambush")).run;
  const content = Object.fromEntries(BLOCKS.map((item) => [item.id, item]));
  return {
    ...run,
    content: (id) => content[id] ?? run.content(id),
    contentIds: () => [
      ...new Set([...run.contentIds(), ...Object.keys(content)]),
    ],
  };
}

// The SRD fighter: Strength 17 (+3) and Proficiency +2, so a longsword hits at +5.
function fighter(
  run: RunContext,
  options: {
    readonly at?: readonly [number, number];
    readonly hp?: number;
  } = {},
): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/fighter"));
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "Fighter",
      side: "party",
      source: { kind: "character", build: pregen.build },
      hp: options.hp ?? 100,
      inventory: ["srd52:item/longsword", "srd52:item/shortbow"],
    }),
    position: options.at ? { x: options.at[0], y: options.at[1] } : null,
  };
}

function monster(
  id: string,
  options: {
    readonly at?: readonly [number, number];
    readonly hp?: number;
  } = {},
): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId: `test:monster/${id}` },
      hp: options.hp ?? 500,
      inventory: [],
    }),
    position: options.at ? { x: options.at[0], y: options.at[1] } : null,
  };
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: {
      encounter: "arena",
      order: actors.map((item) => item.id),
      index: 0,
      round: 1,
      ...(actors.some((item) => item.position)
        ? { grid: { width: 20, height: 20 } }
        : {}),
    },
  };
}

const contextOf = (run: RunContext, state: DndState, dice: Dice): Context => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});

// Runs frames to the end, answering each decision with its first option unless told otherwise.
function settle(
  run: RunContext,
  start: DndState,
  frames: readonly Frame[],
  dice: Dice,
  answer: (decision: Decision) => string = (decision) =>
    decision.options[0]?.id ?? "",
): { state: DndState; events: SystemEvent[]; decisions: Decision[] } {
  let state = start;
  const events: SystemEvent[] = [];
  const decisions: Decision[] = [];
  const stack = [...frames].reverse();
  for (let top = stack.pop(); top; top = stack.pop()) {
    if (top.kind === AWAIT_FRAME) {
      const { decision } = top.payload as { decision: Decision };
      decisions.push(decision);
      stack.push({
        kind: decision.resume.kind,
        payload: { ...decision.resume.payload, answer: answer(decision) },
      });
      continue;
    }
    const definition = run.system.frames[top.kind];
    if (!definition) throw new Error(`Unknown frame ${top.kind}`);
    const result = definition.run(top.payload, contextOf(run, state, dice));
    for (const event of result.events ?? []) {
      events.push(event);
      state = applyDndEvent(state, event);
    }
    stack.push(...[...(result.frames ?? [])].reverse());
  }
  return { state, events, decisions };
}

const damageOf = (events: readonly SystemEvent[], actor: string): number[] =>
  events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    event.payload.actor === actor
      ? [Number(event.payload.amount)]
      : [],
  );

// Every d20 lands on `natural` and every other die on 1, counting the d20s rolled.
function d20s(natural: number): { dice: Dice; count: () => number } {
  let count = 0;
  return {
    dice: {
      below: () => 0,
      roll: (sides) => {
        if (sides !== 20) return 1;
        count += 1;
        return natural;
      },
    },
    count: () => count,
  };
}

const attack = (attacker: string, actionId: string, target: string): Frame => ({
  kind: `${NS}:attackRoll`,
  payload: { attacker, actionId, target },
});

describe("Parry", () => {
  it("turns a melee hit into a miss against that attack only, and never a ranged one", async () => {
    const run = await base();
    const state = fight(fighter(run), monster("parrier"));
    // 7 + 5 = 12 hits AC 10, and misses the 15 Parry makes.
    const swing = [
      attack(PLAYER_ACTOR, "weapon:srd52:item/longsword", "parrier"),
    ];
    const parried = settle(run, state, swing, d20s(7).dice);
    expect(parried.decisions[0]?.id).toBe(`${NS}:reaction:parrier`);
    expect(damageOf(parried.events, "parrier")).toEqual([]);
    expect(parried.state.actors.parrier?.budget.reaction).toBe(false);
    // The bonus doesn't stay: nothing is left on the parrier for the next attack.
    expect(parried.state.actors.parrier?.activeEffects).toEqual([]);
    const taken = settle(run, state, swing, d20s(7).dice, () => "decline");
    expect(damageOf(taken.events, "parrier")).toHaveLength(1);
    // A hit the bonus can't undo isn't offered.
    const sure = settle(run, state, swing, d20s(12).dice);
    expect(sure.decisions).toEqual([]);
    const shot = settle(
      run,
      state,
      [attack(PLAYER_ACTOR, "weapon:srd52:item/shortbow", "parrier")],
      d20s(9).dice,
    );
    expect(shot.decisions).toEqual([]);
    expect(damageOf(shot.events, "parrier")).toHaveLength(1);
  });
});

describe("Evasion", () => {
  const burst = (ability: "dex" | "con", dc: number): KnownAction => ({
    id: "test:burst",
    name: "Burst",
    spellLevel: null,
    activation: {
      cost: [],
      targeting: { creatures: 1, range: 60, side: "enemy" },
      resolution: {
        kind: "save",
        ability,
        dc: { base: dc, add: [] },
        damage: [{ amount: { bonus: { base: 10, add: [] } }, type: "fire" }],
        onSuccessDamage: "half",
        onFail: [],
        onSuccess: [],
      },
    },
  });
  const dealt = async (
    target: string,
    action: KnownAction,
    incapacitated = false,
  ): Promise<number[]> => {
    const run = await base();
    const victim = monster(target);
    const held = incapacitated
      ? {
          ...victim,
          activeEffects: [
            {
              sourceId: "test",
              casterId: PLAYER_ACTOR,
              modifier: {
                kind: "condition" as const,
                condition: "incapacitated" as const,
              },
              ends: "spellDuration" as const,
            },
          ],
        }
      : victim;
    const state = fight(fighter(run), held);
    const result = resolveAction(
      action,
      fighter(run),
      [held],
      contextOf(run, state, d20s(10).dice),
    );
    return damageOf(result.events ?? [], target);
  };

  it("takes half on a failed Dexterity save and none on a success", async () => {
    expect(await dealt("dummy", burst("dex", 30))).toEqual([10]);
    expect(await dealt("evader", burst("dex", 30))).toEqual([5]);
    expect(await dealt("evader", burst("dex", 1))).toEqual([]);
    // Only Dexterity, unless the trait says any save, and not while Incapacitated.
    expect(await dealt("evader", burst("con", 30))).toEqual([10]);
    expect(await dealt("dodger", burst("con", 30))).toEqual([5]);
    expect(await dealt("evader", burst("dex", 30), true)).toEqual([10]);
  });

  it("takes nothing from a spell up to its level it saves against, as with a Ring of Spell Turning", async () => {
    const spell = (dc: number, spellLevel: number) => ({
      ...burst("con", dc),
      spellLevel,
    });
    expect(await dealt("turner", spell(1, 7))).toEqual([]);
    expect(await dealt("turner", spell(1, 8))).toEqual([5]);
    expect(await dealt("turner", spell(30, 3))).toEqual([10]);
    expect(await dealt("turner", burst("con", 1))).toEqual([5]); // not a spell
  });
});

describe("Advantage from a monster's trait", () => {
  const rolls = async (
    attacker: Actor,
    target: (run: RunContext) => Actor,
  ): Promise<number> => {
    const run = await base();
    const { dice, count } = d20s(10);
    settle(
      run,
      fight(target(run), attacker),
      [attack(attacker.id, "monster:0", PLAYER_ACTOR)],
      dice,
    );
    return count();
  };

  it("rolls twice against a hurt target, while Bloodied, or against a Frightened one", async () => {
    const whole = (run: RunContext) => fighter(run);
    const hurt = (run: RunContext) => fighter(run, { hp: 1 });
    expect(await rolls(monster("frenzied"), whole)).toBe(1);
    expect(await rolls(monster("frenzied"), hurt)).toBe(2);
    expect(await rolls(monster("furious"), whole)).toBe(1);
    expect(await rolls(monster("furious", { hp: 200 }), whole)).toBe(2);
    expect(await rolls(monster("terror"), whole)).toBe(1);
    const scared = (run: RunContext): Actor => ({
      ...fighter(run),
      activeEffects: [
        {
          sourceId: "test",
          casterId: "terror",
          modifier: { kind: "condition", condition: "frightened" },
          ends: "spellDuration" as const,
        },
      ],
    });
    expect(await rolls(monster("terror"), scared)).toBe(2);
  });
});

describe("Flyby and Immutable Form", () => {
  it("leaves a foe's reach without an Opportunity Attack", async () => {
    const run = await base();
    for (const [id, expected] of [
      ["dummy", 1],
      ["flyer", 0],
    ] as const) {
      const state = fight(
        fighter(run, { at: [4, 5] }),
        monster(id, { at: [5, 5] }),
      );
      const mover = state.actors[id];
      if (!mover) throw new Error("No mover");
      expect(provokers(mover, { x: 8, y: 5 }, state, run)).toHaveLength(
        expected,
      );
    }
  });

  it("gives Polymorph no Beast to turn a golem into", async () => {
    const run = await base();
    expect(weakestBeast(monster("dummy"), run)).not.toBeNull();
    expect(weakestBeast(monster("golem"), run)).toBeNull();
  });
});

describe("Shape-Shift", () => {
  const shift = (shape: string) => [{ kind: "shapeShift" as const, shape }];

  it("takes a shape with its size, Speed, traits and actions, and goes back", async () => {
    const run = await base();
    const were = monster("were");
    const state = fight(fighter(run), were);
    const context = contextOf(run, state, d20s(10).dice);
    const names = (item: Actor) =>
      deriveStats(item, run).actions.map(({ name }) => name);
    expect(names(were)).toContain("Club");
    expect(names(were)).not.toContain("Bite");
    const wolf = leafEvents(shift("wolf"), "x", were, were, context).reduce(
      applyDndEvent,
      state,
    ).actors.were;
    if (!wolf) throw new Error("No wolf");
    expect(shapeOf(wolf)).toBe("wolf");
    expect(names(wolf)).toContain("Bite");
    expect(names(wolf)).not.toContain("Club");
    expect(deriveStats(wolf, run).speed).toBe(40);
    expect(sizeOf(wolf, run)).toBeGreaterThan(sizeOf(were, run));
    expect(deriveStats(wolf, run).passives).toContainEqual({
      kind: "noOpportunityAttacks",
    });
    const back = leafEvents(shift("humanoid"), "x", wolf, wolf, {
      ...context,
      state: { ...state, actors: { ...state.actors, were: wolf } },
    }).reduce(applyDndEvent, state).actors.were;
    expect(back && shapeOf(back)).toBeNull();
    // Already in that shape: nothing happens.
    expect(leafEvents(shift("humanoid"), "x", were, were, context)).toEqual([]);
  });

  it("shifts first when its other shape hits harder, and never for nothing", async () => {
    const run = await base();
    const choose = (were: Actor): string => {
      const state = fight(fighter(run, { at: [4, 5] }), {
        ...were,
        position: { x: 5, y: 5 },
      });
      const decision = nextDndDecision(
        { ...state, combat: state.combat && { ...state.combat, index: 1 } },
        run,
      );
      if (!decision) throw new Error("No decision");
      return choosePolicy(decision, contextOf(run, state, d20s(10).dice));
    };
    expect(choose(monster("were"))).toMatch(/^monster:3\b/);
    const wolf: Actor = {
      ...monster("were"),
      activeEffects: [
        {
          sourceId: "shape",
          casterId: "were",
          modifier: { kind: "shape", shape: "wolf" },
          ends: "spellDuration",
        },
      ],
    };
    expect(choose(wolf)).toMatch(/^monster:1\b/);
  });

  it("reads the shapes from the stat block's text", () => {
    expect(formsOnly("Bite (Wolf or Hybrid Form Only)")).toEqual([
      "wolf",
      "hybrid",
    ]);
    expect(formsOnly("Magic Allergy (Individual Form Only; 1/Day)")).toEqual([
      "individual",
    ]);
    const read = shapesIn(
      [
        "Speed 30 ft., 40 ft. (wolf form only)",
        "Actions",
        "Multiattack (Wolf or Hybrid Form Only). The werewolf makes two attacks.",
        "Bite (Wolf or Hybrid Form Only). Melee Attack Roll: +5, reach 5 ft.",
        "Bonus Actions",
        "Shape-Shift. The werewolf shape-shifts into a Large wolf-humanoid hybrid or a Medium wolf, or it returns to its true humanoid form.",
      ],
      "medium",
    );
    expect(read?.cost).toBe("bonusAction");
    expect(
      read?.shapes.map(({ name, size, speed, multiattack }) => [
        name,
        size,
        speed,
        multiattack,
      ]),
    ).toEqual([
      ["humanoid", "medium", 30, false],
      ["hybrid", "large", 30, true],
      ["wolf", "medium", 40, true],
    ]);
    const bat = shapesIn(
      [
        "Speed 40 ft., Fly 40 ft.",
        "Bonus Actions",
        "Shape-Shift. If the vampire isn’t in sunlight, it shape-shifts into a Tiny bat (Speed 5 ft., Fly Speed 30 ft.), or it returns to its vampire form.",
      ],
      "medium",
    );
    expect(bat?.shapes.map(({ name, speeds }) => [name, speeds])).toEqual([
      ["vampire", { walk: 40, fly: 40 }],
      ["bat", { walk: 5, fly: 30 }],
    ]);
  });
});

const hitWith = (
  run: RunContext,
  target: Actor,
  damage: readonly { amount: number; type: string }[],
) =>
  dealEvents(
    target,
    damage as never,
    false,
    contextOf(run, fight(fighter(run), target), d20s(10).dice),
  ).events.reduce(applyDndEvent, fight(fighter(run), target));

describe("one-off monster traits and actions", () => {
  it("heals from absorbed fire, even though it's immune to it", async () => {
    const run = await base();
    const after = hitWith(run, monster("absorber", { hp: 100 }), [
      { amount: -12, type: "fire" },
    ]);
    expect(after.actors.absorber?.hp).toBe(112);
    // A hit that is part slashing, part fire: the slashing hurts and the fire heals.
    const absorber = monster("absorber", { hp: 100 });
    const struck = settle(
      run,
      fight(fighter(run), monster("flamer"), absorber),
      [attack("flamer", "monster:0", "absorber")],
      d20s(15).dice,
    );
    expect(damageOf(struck.events, "absorber")).toEqual([1]);
    expect(struck.state.actors.absorber?.hp).toBe(101);
    // finalDamage turns the absorbed type into the negative amount dealEvents heals with.
    expect(
      finalDamage(12, "fire", damageResponses(monster("absorber"), run)),
    ).toBe(-12);
  });

  it("burns and holds a creature that hits it in melee", async () => {
    const run = await base();
    const state = fight(
      fighter(run, { at: [4, 5] }),
      monster("pudding", { at: [5, 5] }),
    );
    const swing = settle(
      run,
      state,
      [attack(PLAYER_ACTOR, "weapon:srd52:item/longsword", "pudding")],
      d20s(15).dice,
    );
    expect(damageOf(swing.events, PLAYER_ACTOR)).toEqual([1]);
    expect(hasCondition(actorOf(swing.state, PLAYER_ACTOR), "grappled")).toBe(
      true,
    );
  });

  it("is harder to hit until it attacks, and again from its next turn", async () => {
    const run = await base();
    const { dice, count } = d20s(15);
    const state = fight(fighter(run), monster("devil"));
    settle(
      run,
      state,
      [attack(PLAYER_ACTOR, "weapon:srd52:item/longsword", "devil")],
      dice,
    );
    expect(count()).toBe(2);
    const attacked = settle(
      run,
      state,
      [attack("devil", "monster:0", PLAYER_ACTOR)],
      d20s(15).dice,
    );
    const counted = d20s(15);
    settle(
      run,
      attacked.state,
      [attack(PLAYER_ACTOR, "weapon:srd52:item/longsword", "devil")],
      counted.dice,
    );
    expect(counted.count()).toBe(1);
  });

  it("lets the spells it names pass it by, and turns to stone instead of dropping", async () => {
    const run = await base();
    const zap = {
      id: "spell:test:spell/zap",
      name: "Zap",
      spellLevel: 1,
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 60, side: "enemy" },
        resolution: {
          kind: "automatic",
          damage: [{ amount: { bonus: { base: 40, add: [] } }, type: "force" }],
          effects: [],
        },
      },
    } as KnownAction;
    const horror = monster("horror", { hp: 30 });
    const state = fight(fighter(run), horror);
    const context = contextOf(run, state, d20s(10).dice);
    expect(
      resolveAction(zap, actorOf(state, PLAYER_ACTOR), [horror], context)
        .events ?? [],
    ).toEqual([]);
    const stone = hitWith(run, horror, [{ amount: 40, type: "force" }]).actors
      .horror;
    expect(stone?.hp).toBe(50);
    expect(stone && hasCondition(stone, "petrified")).toBe(true);
  });

  it("saves with Advantage while Bloodied, flinches from fire, and reacts on every turn", async () => {
    const run = await base();
    const rolls = (hp: number): number => {
      const { dice, count } = d20s(10);
      rollSave(
        monster("berserk", { hp }),
        "dex",
        15,
        contextOf(run, fight(monster("berserk", { hp })), dice),
      );
      return count();
    };
    expect(rolls(500)).toBe(1);
    expect(rolls(200)).toBe(2);
    const burnt = hitWith(run, monster("berserk"), [
      { amount: 5, type: "fire" },
    ]).actors.berserk;
    expect(
      burnt?.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "disadvantage" && modifier.on === "attacks",
      ),
    ).toBe(true);
    const spent: Actor = {
      ...monster("berserk"),
      budget: { action: true, bonusAction: true, reaction: false },
    };
    const next = runAdvanceTurn(
      contextOf(run, fight(fighter(run), spent), d20s(10).dice),
    );
    expect(
      (next.events ?? []).reduce(applyDndEvent, fight(fighter(run), spent))
        .actors.berserk?.budget.reaction,
    ).toBe(true);
  });

  it("loses a limb to a heavy slash while Bloodied, and grows it back as it heals", async () => {
    const run = await base();
    const troll = monster("troll", { hp: 60, at: [5, 5] });
    const state = fight(fighter(run, { at: [4, 5] }), troll);
    const cut = dealEvents(
      troll,
      [{ amount: 15, type: "slashing" }],
      false,
      contextOf(run, state, d20s(10).dice),
    ).events.reduce(applyDndEvent, state);
    expect(cut.actors.troll?.exhaustion).toBe(1);
    expect(cut.actors["troll:limb-1"]?.side).toBe("enemy");
    expect(cut.combat?.order).toEqual([PLAYER_ACTOR, "troll", "troll:limb-1"]);
    const healed = runAdvanceTurn(contextOf(run, cut, d20s(10).dice));
    expect(
      (healed.events ?? []).reduce(applyDndEvent, cut).actors.troll?.exhaustion,
    ).toBe(0);
  });

  it("rolls its eye rays, never the same one twice in a turn", async () => {
    const run = await base();
    const beholder = monster("beholder");
    const state = fight(fighter(run), beholder);
    let next = 0;
    const dice: Dice = { below: () => 0, roll: () => [1, 1, 2][next++] ?? 1 };
    const rays = settle(
      run,
      state,
      [attack("beholder", "monster:0", PLAYER_ACTOR)].map((item) => ({
        ...item,
        kind: `${NS}:useAction`,
        payload: {
          actor: "beholder",
          actionId: "monster:0",
          target: PLAYER_ACTOR,
        },
      })),
      dice,
    );
    expect(damageOf(rays.events, PLAYER_ACTOR)).toEqual([3, 3]);
    expect(rays.state.actors.beholder?.usedThisTurn).toEqual([
      "rolled:Ray A",
      "rolled:Ray B",
    ]);
    const decision = nextDndDecision(
      { ...state, combat: state.combat && { ...state.combat, index: 1 } },
      run,
    );
    expect(decision?.options.some(({ id }) => id.startsWith("monster:1"))).toBe(
      false,
    );
  });

  it("raises a fallen humanoid beside it on its side", async () => {
    const run = await base();
    const corpse = {
      ...monster("corpse", { at: [6, 5] }),
      hp: 0,
      side: "party" as const,
      deathSaves: { successes: 0, failures: 3 },
    };
    const wraith = monster("wraith", { at: [5, 5] });
    const state = fight(fighter(run, { at: [1, 1] }), wraith, corpse);
    const raised = settle(
      run,
      state,
      [
        {
          kind: `${NS}:useAction`,
          payload: { actor: "wraith", actionId: "monster:0", target: "wraith" },
        },
      ],
      d20s(10).dice,
    );
    const risen = raised.state.actors["corpse:risen"];
    expect(risen?.side).toBe("enemy");
    expect(risen?.position).toEqual({ x: 6, y: 5 });
    expect(raised.state.combat?.order.indexOf("corpse:risen")).toBe(
      (raised.state.combat?.order.indexOf("wraith") ?? 0) + 1,
    );
  });

  it("can't heal under Negative Energy, and a drained maximum is rolled once", async () => {
    const run = await base();
    const hurt: Actor = {
      ...fighter(run, { hp: 10 }),
      activeEffects: [
        {
          sourceId: "x",
          casterId: "x",
          modifier: { kind: "noHealing" },
          ends: "spellDuration",
        },
      ],
    };
    const context = contextOf(run, fight(hurt), d20s(10).dice);
    expect(
      leafEvents(
        [{ kind: "heal", amount: { dice: "2d8" } }],
        "y",
        hurt,
        hurt,
        context,
      ),
    ).toEqual([]);
    const [drain] = leafEvents(
      [
        {
          kind: "modifier",
          modifier: {
            kind: "bonus",
            to: "maxHp",
            amount: { dice: "4d6" },
            subtract: true,
          },
          duration: { minutes: 1 },
        },
      ],
      "z",
      hurt,
      hurt,
      context,
    );
    expect(drain && "payload" in drain && drain.payload.effect).toMatchObject({
      modifier: { amount: { bonus: { base: 4, add: [] } } },
    });
  });
});

describe("spells sorted out of #111", () => {
  const effect = (modifier: object): Actor["activeEffects"][number] => ({
    sourceId: "spell:test",
    casterId: PLAYER_ACTOR,
    modifier: modifier as never,
    ends: "spellDuration",
  });
  const swing = (run: RunContext, target: Actor, natural: number) =>
    settle(
      run,
      fight(fighter(run), target),
      [attack(PLAYER_ACTOR, "weapon:srd52:item/longsword", target.id)],
      d20s(natural).dice,
    );

  it("takes Blade Ward's die off an attack roll, and lets a duplicate take a hit", async () => {
    const run = await base();
    // 7 + 5 = 12 hits AC 10; less the 1 Blade Ward rolls it's 11, still a hit.
    const ward = {
      ...monster("dummy"),
      activeEffects: [
        effect({
          kind: "bonus",
          to: "attacksAgainst",
          amount: { dice: "1d4" },
          subtract: true,
        }),
      ],
    };
    const report = swing(run, ward, 7).events.find(
      (event) => event.kind === `${NS}:rollReported`,
    );
    expect(report && "payload" in report && report.payload.total).toBe(11);
    const images = {
      ...monster("dummy"),
      activeEffects: [effect({ kind: "images", count: 3 })],
    };
    // Every die but the d20 rolls 1, so no duplicate is hit; a 6 on every die would hit one.
    expect(damageOf(swing(run, images, 15).events, "dummy")).not.toEqual([]);
    const sixes: Dice = { below: () => 0, roll: (sides) => sides };
    const fooled = settle(
      run,
      fight(fighter(run), images),
      [attack(PLAYER_ACTOR, "weapon:srd52:item/longsword", "dummy")],
      sixes,
    );
    expect(damageOf(fooled.events, "dummy")).toEqual([]);
    const left = fooled.state.actors.dummy?.activeEffects[0]?.modifier;
    expect(left).toEqual({ kind: "images", count: 2 });
  });

  it("makes an attacker that fails its save lose the attack on a creature under Sanctuary", async () => {
    const run = await base();
    const warded = {
      ...monster("dummy"),
      activeEffects: [effect({ kind: "sanctuary", dc: 30 })],
    };
    expect(damageOf(swing(run, warded, 15).events, "dummy")).toEqual([]);
  });

  it("drops to 1 under Death Ward, stabilizes the dying, and slays the weak outright", async () => {
    const run = await base();
    const warded: Actor = {
      ...fighter(run, { hp: 10 }),
      activeEffects: [effect({ kind: "deathWard" })],
    };
    const after = hitWith(run, warded, [{ amount: 300, type: "fire" }]);
    expect(after.actors[PLAYER_ACTOR]?.hp).toBe(1);
    expect(after.actors[PLAYER_ACTOR]?.activeEffects).toEqual([]);
    const dying = fighter(run, { hp: 0 });
    const context = contextOf(run, fight(dying), d20s(10).dice);
    expect(
      leafEvents([{ kind: "stabilize" }], "x", dying, dying, context),
    ).toEqual([dndEvent(`${NS}:stabilized`, { actor: PLAYER_ACTOR })]);
    const kill = {
      id: "spell:test:spell/pwk",
      name: "Power Word Kill",
      spellLevel: 9,
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 60, side: "enemy" },
        resolution: {
          kind: "automatic",
          damage: [{ amount: { dice: "12d12" }, type: "psychic" }],
          effects: [{ kind: "slay", hpAtMost: 100 }],
        },
      },
    } as KnownAction;
    const weak = monster("dummy", { hp: 90 });
    const strong = monster("dummy", { hp: 200 });
    const slain = resolveAction(
      kill,
      fighter(run),
      [weak],
      contextOf(run, fight(fighter(run), weak), d20s(10).dice),
    );
    expect(
      (slain.events ?? []).reduce(applyDndEvent, fight(fighter(run), weak))
        .actors.dummy?.hp,
    ).toBe(0);
    const hurt = resolveAction(
      kill,
      fighter(run),
      [strong],
      contextOf(run, fight(fighter(run), strong), d20s(10).dice),
    );
    expect(damageOf(hurt.events ?? [], "dummy")).toEqual([12]);
  });

  it("sees farther with Darkvision, and offers Revivify only a dead ally", async () => {
    const run = await base();
    const seer = {
      ...fighter(run),
      activeEffects: [effect({ kind: "darkvision", feet: 150 })],
    };
    expect(darkvisionOf(seer, run)).toBe(150);
    const revivify = {
      id: "spell:test:spell/revivify",
      name: "Revivify",
      spellLevel: 3,
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 60, side: "ally", dead: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [{ kind: "heal", amount: { bonus: { base: 1, add: [] } } }],
        },
      },
    } as KnownAction;
    const fallen: Actor = {
      ...freshActor({
        id: "friend",
        name: "Friend",
        side: "party",
        source: fighter(run).source,
        hp: 0,
        inventory: [],
      }),
      deathSaves: { successes: 0, failures: 3 },
    };
    const state = fight(fighter(run), fallen, monster("dummy"));
    expect(
      inReach(revivify, actorOf(state, PLAYER_ACTOR), state, run).map(
        ({ id }) => id,
      ),
    ).toEqual(["friend"]);
    const revived = resolveAction(
      revivify,
      actorOf(state, PLAYER_ACTOR),
      [fallen],
      contextOf(run, state, d20s(10).dice),
    );
    const back = (revived.events ?? []).reduce(applyDndEvent, state).actors
      .friend;
    expect(back?.hp).toBe(1);
    expect(back?.deathSaves.failures).toBe(0);
  });
});
