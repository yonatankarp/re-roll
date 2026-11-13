import {
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { type Dice, createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { Input } from "../engine/kernel/events.ts";
import { replayInputs } from "../engine/run/save.ts";
import { AWAIT_FRAME } from "../engine/kernel/system.ts";
import { type RunContext, startRun, step } from "../engine/run/turn.ts";
import {
  type Context,
  choosePolicy,
  nextDndDecision,
  resolveAction,
  startCombat,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import { legendaryOf } from "../plugins/systems/dnd5.5e/core/import/monsters.ts";
import {
  legendOf,
  resistancesLeft,
} from "../plugins/systems/dnd5.5e/core/legendary.ts";
import {
  ActivationSchema,
  MonsterSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import type { KnownAction } from "../plugins/systems/dnd5.5e/core/stats.ts";

const HIGH: Dice = { below: () => 0, roll: (sides) => sides };
const LOW: Dice = { below: () => 0, roll: () => 1 };

const BITE = {
  name: "Bite",
  activation: {
    cost: ["action"],
    targeting: { creatures: 1, range: 5, side: "enemy" },
    resolution: {
      kind: "attack",
      attack: { type: "weapon", flatBonus: 6 },
      damage: [
        { amount: { dice: "1d8", bonus: { base: 3 } }, type: "piercing" },
      ],
    },
  },
};
const ROAR = {
  cost: [],
  targeting: {
    area: { shape: "emanation", radius: 30 },
    range: "self",
    side: "enemy",
  },
  resolution: {
    kind: "save",
    ability: "wis",
    dc: { base: 14 },
    damage: [],
    onFail: [
      {
        kind: "applyCondition",
        condition: "frightened",
        duration: { until: "yourNextTurnStart" },
      },
    ],
  },
};

// A made-up boss with every part of a legend, written as numbers and names only.
function boss(
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "goblin-ambush:monster/chief",
    name: "Wyrmling Tyrant",
    ac: 12,
    hp: 120,
    speed: 30,
    abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 10 },
    proficiency: 3,
    initiative: 0,
    actions: [BITE],
    legendary: {
      uses: 2,
      usesInLair: 3,
      actions: [
        { name: "Snap", makes: ["Bite"] },
        { name: "Roar", oncePerRound: true, activation: ROAR },
      ],
    },
    legendaryResistance: { perDay: 2, inLair: 3 },
    lairActions: [
      {
        name: "Falling Rocks",
        activation: {
          ...ROAR,
          targeting: {
            ...ROAR.targeting,
            area: { shape: "emanation", radius: 300 },
          },
        },
      },
    ],
    ...fields,
  };
}

const base = async (): Promise<RunContext> =>
  (await loadAdventure("goblin-ambush")).run;

function withContent(
  run: RunContext,
  extra: Record<string, unknown>,
): RunContext {
  return {
    ...run,
    content: (id) =>
      (extra[id] as ReturnType<RunContext["content"]>) ?? run.content(id),
  };
}

function hero(id = PLAYER_ACTOR, x = 0): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "party",
      source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
      hp: 40,
      inventory: [],
    }),
    position: { x, y: 0 },
  };
}

function chief(x = 1): Actor {
  return {
    ...freshActor({
      id: "chief",
      name: "Chief",
      side: "enemy",
      source: { kind: "monster", statBlockId: "goblin-ambush:monster/chief" },
      hp: 120,
      inventory: [],
    }),
    position: { x, y: 0 },
  };
}

function fight(
  actors: readonly Actor[],
  extra: Partial<NonNullable<DndState["combat"]>> = {},
): DndState {
  return {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
      grid: { width: 10, height: 10 },
      ...extra,
    },
  };
}

const contextOf = (run: RunContext, state: DndState, dice: Dice): Context => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});

// The kernel's loop in small: monsters answer with the system's own tactics.
function settle(
  run: RunContext,
  start: DndState,
  frames: readonly Frame[],
  dice: Dice,
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
        payload: {
          ...decision.resume.payload,
          answer: choosePolicy(decision, contextOf(run, state, dice)),
        },
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

const endTurn: Frame = { kind: `${NS}:endTurn`, payload: {} };
const named = (events: readonly SystemEvent[], kind: string): SystemEvent[] =>
  events.filter((event) => event.kind === `${NS}:${kind}`);

describe("reading legends from a stat block", () => {
  it("reads uses, resistance, attacks it makes and actions of its own", () => {
    const { fields, notes } = legendaryOf(
      [
        "Traits",
        "Legendary Resistance (3/Day, or 4/Day in Lair). It can succeed instead.",
        "Actions",
        "Bite. Melee Attack Roll: +7, reach 10 ft. Hit: 12 (2d8 + 3) Piercing damage.",
        "Legendary Actions",
        "Legendary Action Uses: 3 (4 in Lair). It spends a use after another creature's turn.",
        "Snap. The tyrant moves up to half its Speed, and it makes two Bite attacks.",
        "Roar. Wisdom Saving Throw: DC 15, each creature in a 20-foot Emanation originating from the tyrant. Failure: The target has the Frightened condition until the start of its next turn. Success: Nothing. The tyrant can't take this action again until the start of its next turn.",
        "Blink. The tyrant teleports up to 30 feet.",
        "Step. The tyrant teleports up to 60 feet to an unoccupied space it can see, and each creature within 10 feet of the space it left takes 5 (2d4) Necrotic damage.",
      ],
      ["Bite"],
    );
    expect(fields.legendaryResistance).toEqual({ perDay: 3, inLair: 4 });
    const legend = MonsterSchema.shape.legendary.parse(fields.legendary);
    expect(legend?.uses).toBe(3);
    expect(legend?.usesInLair).toBe(4);
    expect(legend?.actions.map((item) => item.name)).toEqual([
      "Snap",
      "Roar",
      "Step",
    ]);
    expect(legend?.actions[2]?.activation).toMatchObject({
      targeting: { self: true },
      resolution: { effects: [{ kind: "teleport", feet: 60 }] },
    });
    expect(legend?.actions[0]).toMatchObject({
      makes: ["Bite", "Bite"],
      moves: true,
      oncePerRound: false,
    });
    expect(legend?.actions[1]).toMatchObject({ oncePerRound: true });
    expect(legend?.actions[1]?.activation?.resolution.kind).toBe("save");
    expect(notes).toEqual([
      "not automated: legendary action Blink",
      "partial: Step: left out what follows it",
    ]);
  });

  it("reads an older import's printed text when the stat block has no legend fields", async () => {
    const run = await base();
    const plain = boss({
      legendary: undefined,
      legendaryResistance: undefined,
      lairActions: undefined,
      text: [
        "Traits",
        "Legendary Resistance (1/Day). It can succeed instead.",
        "Legendary Actions",
        "Legendary Action Uses: 2.",
        "Snap. It makes one Bite attack.",
      ].join("\n"),
    });
    const legend = legendOf(
      chief(),
      withContent(run, { [String(plain.id)]: plain }),
    );
    expect(legend.legendary?.uses).toBe(2);
    expect(legend.legendary?.actions[0]?.makes).toEqual(["Bite"]);
    expect(legend.legendaryResistance).toEqual({ perDay: 1 });
  });
});

describe("legendary actions", () => {
  it("come right after another creature's turn, and the uses return at the start of the monster's own", async () => {
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss(),
    });
    const state = fight([hero(), hero("ally", 2), chief()]);
    // The player's turn ends: the chief spends a use, then another after the ally's, then has none left.
    const first = settle(run, state, [endTurn], HIGH);
    expect(named(first.events, "legendaryActionTaken")).toHaveLength(1);
    expect(first.decisions[0]?.id).toMatch(/^dnd5\.5e:legendary:chief:1:0$/);
    const second = settle(run, first.state, [endTurn], HIGH);
    expect(named(second.events, "legendaryActionTaken")).toHaveLength(1);
    expect(
      second.events.some(
        (event) =>
          event.kind === `${NS}:legendaryActionTaken` &&
          second.events.indexOf(event) <
            second.events.findIndex(
              (item) => item.kind === `${NS}:turnAdvanced`,
            ),
      ),
    ).toBe(true);
    // The chief's own turn: no legendary action after it, and its uses are back.
    expect(second.state.combat?.index).toBe(2);
    expect(second.state.actors.chief?.usedThisTurn).toEqual([]);
    const third = settle(run, second.state, [endTurn], HIGH);
    expect(named(third.events, "legendaryActionTaken")).toEqual([]);
  });

  it("spends no more uses than it has, and keeps a once-a-round action to once", async () => {
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss({
        legendary: {
          uses: 3,
          actions: [{ name: "Roar", oncePerRound: true, activation: ROAR }],
        },
      }),
    });
    const state = fight([hero(), hero("ally", 2), chief()]);
    const first = settle(run, state, [endTurn], LOW);
    expect(named(first.events, "legendaryActionTaken")).toHaveLength(1);
    const second = settle(run, first.state, [endTurn], LOW);
    expect(named(second.events, "legendaryActionTaken")).toEqual([]);
  });

  it("aims an action meant only for a creature with a condition at such creatures alone, lair actions too", async () => {
    const stomp = {
      cost: [],
      targeting: {
        creatures: 1,
        range: 5,
        side: "enemy",
        targetConditions: ["prone"],
      },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: { base: 15 },
        damage: [{ amount: { dice: "2d10" }, type: "bludgeoning" }],
      },
    };
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss({
        legendary: { uses: 2, actions: [{ name: "Stomp", activation: stomp }] },
        lairActions: [{ name: "Sinkhole", activation: stomp }],
      }),
    });
    const options = (state: DndState, kind: string) => {
      const frames =
        run.system.frames[`${NS}:${kind}`]?.run(
          { actor: "chief", when: "" },
          contextOf(run, state, LOW),
        ).frames ?? [];
      const payload = frames[0]?.payload as { decision?: Decision } | undefined;
      const decision = payload?.decision;
      return (decision?.options ?? []).map((option) => option.id);
    };
    const standing = fight([hero(), chief()]);
    expect(options(standing, "legendaryTurn")).toEqual([]);
    expect(options(standing, "lairTurn")).toEqual([]);
    const prone = applyDndEvent(standing, {
      kind: `${NS}:effectAdded`,
      payload: {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: "test",
          casterId: "chief",
          modifier: { kind: "condition", condition: "prone" },
          ends: "spellDuration",
        },
      },
    });
    expect(options(prone, "legendaryTurn")).toContain(`0|${PLAYER_ACTOR}`);
    expect(options(prone, "lairTurn")).toContain(`0|${PLAYER_ACTOR}`);
  });

  it("uses more in its lair", async () => {
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss(),
    });
    const order = [hero(), hero("ally", 2), hero("third", 3), chief()];
    let state = fight(order, { lair: { at: 4 } });
    let taken = 0;
    for (let turn = 0; turn < 3; turn += 1) {
      const result = settle(run, state, [endTurn], HIGH);
      taken += named(result.events, "legendaryActionTaken").length;
      state = result.state;
    }
    expect(taken).toBe(3);
  });
});

describe("Legendary Resistance", () => {
  const scare: KnownAction = {
    id: "scare",
    name: "Scare",
    activation: ActivationSchema.parse({
      ...ROAR,
      resolution: {
        ...ROAR.resolution,
        dc: { base: 30 },
        onFail: [
          {
            kind: "applyCondition",
            condition: "stunned",
            duration: { minutes: 1 },
          },
        ],
      },
    }),
    spellLevel: 1,
  };

  it("turns a failed save against a disabling effect into a success, while it lasts", async () => {
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss(),
    });
    let state = fight([hero(), chief()]);
    const kinds: string[][] = [];
    for (let cast = 0; cast < 3; cast += 1) {
      const target = state.actors.chief;
      const caster = state.actors[PLAYER_ACTOR];
      if (!target || !caster) throw new Error("missing");
      const { events = [] } = resolveAction(
        scare,
        caster,
        [target],
        contextOf(run, state, LOW),
      );
      kinds.push(events.map((event) => event.kind.replace(`${NS}:`, "")));
      for (const event of events) state = applyDndEvent(state, event);
    }
    // Each save is recorded for the roll history before Legendary Resistance can turn it.
    expect(kinds).toEqual([
      ["saveRolled", "legendaryResistanceUsed"],
      ["saveRolled", "legendaryResistanceUsed"],
      ["saveRolled", "effectAdded"],
    ]);
    const chiefNow = state.actors.chief;
    if (!chiefNow) throw new Error("missing");
    expect(resistancesLeft(chiefNow, run, state)).toBe(0);
  });

  it("isn't spent on a save that only deals damage", async () => {
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss(),
    });
    const state = fight([hero(), chief()]);
    const blast: KnownAction = {
      ...scare,
      activation: {
        ...scare.activation,
        resolution: {
          kind: "save",
          ability: "dex",
          dc: { base: 30, add: [] },
          damage: [{ amount: { dice: "2d6" }, type: "fire" }],
          onSuccessDamage: "half",
          onFail: [],
          onSuccess: [],
        },
      },
    };
    const target = state.actors.chief;
    const caster = state.actors[PLAYER_ACTOR];
    if (!target || !caster) throw new Error("missing");
    const { events = [] } = resolveAction(
      blast,
      caster,
      [target],
      contextOf(run, state, LOW),
    );
    expect(named(events, "legendaryResistanceUsed")).toEqual([]);
  });
});

describe("lair actions", () => {
  const encounter = {
    id: "lair",
    monsters: [{ monster: "goblin-ambush:monster/chief", count: 1 }],
    lair: true,
  };
  const party = (): DndState => ({
    actors: { [PLAYER_ACTOR]: hero() },
    combat: null,
  });

  it("act before anyone when nobody rolls 20 or more", async () => {
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss(),
    });
    const started = startCombat(encounter, contextOf(run, party(), LOW), {
      canFlee: false,
      defeatContinues: false,
    });
    let state = party();
    for (const event of started.events ?? [])
      state = applyDndEvent(state, event);
    expect(state.combat?.lair).toEqual({ at: 0 });
    const result = settle(run, state, started.frames ?? [], LOW);
    expect(named(result.events, "lairActionTaken")).toHaveLength(1);
  });

  it("come after those on 20 or more, and only once a round", async () => {
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss(),
    });
    const started = startCombat(encounter, contextOf(run, party(), HIGH), {
      canFlee: false,
      defeatContinues: false,
    });
    expect(started.frames ?? []).toEqual([]);
    let state = party();
    for (const event of started.events ?? [])
      state = applyDndEvent(state, event);
    expect(state.combat?.lair).toEqual({ at: 2 });
    let lair = 0;
    for (let turn = 0; turn < 4; turn += 1) {
      const result = settle(run, state, [endTurn], HIGH);
      lair += named(result.events, "lairActionTaken").length;
      state = result.state;
    }
    expect(lair).toBe(2); // two rounds
  });

  it("don't happen outside the lair", async () => {
    const run = withContent(await base(), {
      "goblin-ambush:monster/chief": boss(),
    });
    const started = startCombat(
      { ...encounter, lair: false },
      contextOf(run, party(), LOW),
      { canFlee: false, defeatContinues: false },
    );
    expect(started.frames ?? []).toEqual([]);
  });
});

describe("surprise", () => {
  const encounter = {
    id: "ambush",
    monsters: [{ monster: "srd52:monster/goblin-warrior", count: 2 }],
  };
  function counting(): { dice: Dice; d20s: () => number } {
    let count = 0;
    const dice = createDice(rngFromSeed("surprise"));
    return {
      dice: {
        below: (limit) => dice.below(limit),
        roll: (sides) => {
          if (sides === 20) count += 1;
          return dice.roll(sides);
        },
      },
      d20s: () => count,
    };
  }
  const party: DndState = { actors: { [PLAYER_ACTOR]: hero() }, combat: null };

  it("makes the surprised side roll initiative with disadvantage", async () => {
    const run = await base();
    const plain = counting();
    startCombat(encounter, contextOf(run, party, plain.dice), {
      canFlee: false,
      defeatContinues: false,
    });
    expect(plain.d20s()).toBe(3);
    const enemies = counting();
    const started = startCombat(
      { ...encounter, surprise: "enemies" as const },
      contextOf(run, party, enemies.dice),
      { canFlee: false, defeatContinues: false },
    );
    expect(enemies.d20s()).toBe(5);
    expect(
      started.events?.find((event) => event.kind === `${NS}:combatStarted`),
    ).toMatchObject({ payload: { surprised: "enemies" } });
  });

  it("can be set by the story for the next fight, and is spent by it", async () => {
    const run = await base();
    const effect = run.system.storyEffects[`${NS}:surprise`];
    if (!effect) throw new Error("no surprise effect");
    const set = effect.apply({ side: "party" }, contextOf(run, party, LOW));
    let state = party;
    for (const event of set.events ?? []) state = applyDndEvent(state, event);
    expect(state.surprise).toBe("party");
    const plain = counting();
    const started = startCombat(encounter, contextOf(run, state, plain.dice), {
      canFlee: false,
      defeatContinues: false,
    });
    expect(plain.d20s()).toBe(4);
    for (const event of started.events ?? [])
      state = applyDndEvent(state, event);
    expect(state.surprise).toBeUndefined();
  });
});

describe("fleeing", () => {
  const take = (actor: string, answer: string): Frame => ({
    kind: `${NS}:takeAction`,
    payload: { actor, answer },
  });

  it("gives every foe in reach an Opportunity Attack, then ends the fight", async () => {
    const run = await base();
    const goblin = {
      ...chief(1),
      source: {
        kind: "monster" as const,
        statBlockId: "srd52:monster/goblin-warrior",
      },
    };
    const far = { ...goblin, id: "far", position: { x: 8, y: 8 } };
    const state = fight([hero(), goblin, far], { canFlee: true });
    const option = nextDndDecision(state, run)?.options.find(
      (item) => item.id === "flee",
    );
    expect(option?.label).toBe("Flee the fight (1 opportunity attack)");
    const result = settle(run, state, [take(PLAYER_ACTOR, "flee")], LOW);
    expect(named(result.events, "rollReported")).toHaveLength(1);
    expect(result.events).toContainEqual({
      kind: "encounterEnded",
      encounter: "arena",
      outcome: "flee",
    });
  });

  it("is free after Disengaging", async () => {
    const run = await base();
    const goblin = {
      ...chief(1),
      source: {
        kind: "monster" as const,
        statBlockId: "srd52:monster/goblin-warrior",
      },
    };
    const player = { ...hero(), usedThisTurn: ["disengage"] };
    const result = settle(
      run,
      fight([player, goblin], { canFlee: true }),
      [take(PLAYER_ACTOR, "flee")],
      LOW,
    );
    expect(named(result.events, "rollReported")).toEqual([]);
    expect(result.events).toContainEqual({
      kind: "encounterEnded",
      encounter: "arena",
      outcome: "flee",
    });
  });

  it("fails if the attacks drop the player, and the turn ends", async () => {
    const run = await base();
    const goblin = {
      ...chief(1),
      source: {
        kind: "monster" as const,
        statBlockId: "srd52:monster/goblin-warrior",
      },
    };
    const player = { ...hero(), hp: 1 };
    const ally = hero("ally", 5);
    const result = settle(
      run,
      fight([player, ally, goblin], { canFlee: true }),
      [take(PLAYER_ACTOR, "flee")],
      HIGH,
    );
    expect(result.state.combat).not.toBeNull();
    expect(result.state.actors[PLAYER_ACTOR]?.hp).toBe(0);
    expect(result.state.combat?.index).not.toBe(0);
  });
});

describe("a headless fight against a legendary monster", () => {
  it("plays the goblin chief as a legend in its lair, the same way on replay", async () => {
    const plain = await base();
    const run: RunContext = {
      ...withContent(plain, {
        "goblin-ambush:monster/chief": boss({ hp: 60 }),
      }),
      adventure: {
        ...plain.adventure,
        encounters: plain.adventure.encounters.map((item) =>
          item.id === "rearguard" ? { ...item, lair: true } : item,
        ),
      },
    };
    const seen = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      const seed = `legend-${String(index)}`;
      const started = startRun(run, seed, { difficulty: "story" });
      let { state, pending } = started;
      const inputs: Input[] = [
        { kind: "start", settings: { difficulty: "story" } },
      ];
      for (let count = 0; pending && count < 400; count += 1) {
        const answer =
          pending.id.startsWith(`${NS}:`) &&
          pending.id !== `${NS}:chooseCharacter`
            ? run.system.decidePolicy(pending, {
                state: state.system,
                dice: LOW,
                content: run.content,
                contentIds: run.contentIds,
              })
            : (pending.options[0]?.id ?? "");
        const input: Input = {
          kind: "answer",
          decisionId: pending.id,
          optionId: answer,
        };
        const outcome = step(run, state, input);
        if (!outcome.ok) throw new Error(outcome.error);
        ({ state, pending } = outcome);
        inputs.push(input);
        for (const event of outcome.events) seen.add(event.kind);
      }
      expect(replayInputs(run, seed, inputs).state).toStrictEqual(state);
    }
    expect(seen).toContain(`${NS}:legendaryActionTaken`);
    expect(seen).toContain(`${NS}:lairActionTaken`);
  }, 120_000);
});
