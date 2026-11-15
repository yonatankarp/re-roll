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
import type { Context } from "../plugins/systems/dnd5.5e/core/combat.ts";
import { sizeOf } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { heightOf } from "../plugins/systems/dnd5.5e/core/combat/falling.ts";
import { inReach } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  reactFrames,
  rollResponder,
} from "../plugins/systems/dnd5.5e/core/combat/reactions.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  applyDndEvent,
  type DndState,
  freshActor,
  hasCondition,
  invisibleTo,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";

// The parts of monster reactions #118 left unread, on made-up stat blocks: ids and mechanics only.

const SWORD = "weapon:srd52:item/longsword";
const BOW = "weapon:srd52:item/shortbow";

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
const FOE = { creatures: 1, range: 120, side: "enemy" };
const SELF = { self: true };
const auto = (effects: readonly object[]) => ({
  kind: "automatic",
  damage: [],
  effects,
});
const reaction = (
  trigger: object,
  targeting: object,
  resolution: object,
  name = "Answer",
) => ({
  name,
  activation: { cost: ["reaction"], trigger, targeting, resolution },
});
const statBlock = (id: string, actions: readonly object[], fields = {}) => ({
  id: `test:monster/${id}`,
  name: id,
  ac: 10,
  hp: 500,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  actions: [club, ...actions],
  ...fields,
});
const saving = (ability: string, dc: number, rest: object) => ({
  kind: "save",
  ability,
  dc: { base: dc, add: [] },
  damage: [],
  ...rest,
});

const BLOCKS = [
  statBlock("whirl", [
    reaction(
      { hitByAttack: true },
      SELF,
      auto([
        { kind: "acAgainstHit", bonus: 2 },
        {
          kind: "teleport",
          feet: 30,
          movement: 0,
          around: {
            within: 5,
            foes: true,
            conditions: ["blinded"],
            duration: { until: "yourNextTurnEnd" },
          },
        },
      ]),
    ),
  ]),
  statBlock("disruptor", [
    reaction(
      { damaged: true },
      SELF,
      auto([
        {
          kind: "teleport",
          feet: 30,
          movement: 0,
          around: {
            origin: true,
            within: 10,
            save: { ability: "con", dc: 30 },
            modifiers: [{ kind: "actionLimit", speed: "half" }],
            duration: { until: "yourNextTurnStart" },
          },
        },
      ]),
    ),
  ]),
  statBlock("deflector", [
    reaction(
      { hitByAttack: true, ranged: true },
      SELF,
      auto([
        {
          kind: "reduceDamage",
          amount: { bonus: { base: 50 } },
          deflect: {
            range: 60,
            ability: "dex",
            dc: 30,
            damage: [{ amount: { bonus: { base: 7 } }, type: "force" }],
          },
        },
      ]),
    ),
  ]),
  statBlock("plant", [
    reaction(
      { hitByAttack: true },
      SELF,
      auto([
        {
          kind: "reduceDamage",
          halve: true,
          toNear: { monster: "test:monster/pod", within: 5 },
        },
      ]),
    ),
  ]),
  statBlock("pod", []),
  statBlock("sticky", [
    reaction(
      { missed: true, melee: true },
      FOE,
      saving("str", 30, {
        onFail: [
          {
            kind: "applyCondition",
            condition: "grappled",
            duration: { until: "rest" },
          },
          { kind: "stickWeapon" },
        ],
      }),
    ),
  ]),
  statBlock("stance", [
    reaction(
      { hitByAttack: true, melee: true },
      SELF,
      auto([
        {
          kind: "modifier",
          modifier: {
            kind: "bonus",
            to: "ac",
            amount: { bonus: { base: 4 } },
            melee: true,
          },
          duration: { until: "yourNextTurnStart" },
        },
      ]),
    ),
  ]),
  statBlock("gazer", [
    reaction(
      { turnStart: true, within: 30 },
      FOE,
      saving("wis", 1, {
        onFail: [],
        onSuccess: [
          {
            kind: "modifier",
            modifier: { kind: "areaImmunity" },
            duration: { minutes: 1440 },
          },
        ],
      }),
    ),
  ]),
  statBlock("warper", [
    reaction({ studied: true, within: 120 }, FOE, auto([])),
  ]),
  statBlock("diviner", [
    reaction(
      {
        rolled: {
          rolls: ["attack", "save"],
          by: "any",
          when: "hitOrFailed",
          magical: true,
        },
        within: 5,
      },
      SELF,
      auto([{ kind: "replaceRoll" }]),
    ),
  ]),
  statBlock("seer", [
    reaction(
      { attacked: true },
      FOE,
      auto([
        {
          kind: "modifier",
          modifier: {
            kind: "advantage",
            on: "attacksAgainst",
            casterOnly: true,
          },
          duration: { until: "yourNextTurnEnd" },
        },
      ]),
    ),
  ]),
  statBlock("hunter", [
    {
      name: "Hop",
      activation: {
        cost: ["action"],
        targeting: SELF,
        resolution: auto([{ kind: "teleport", feet: 120, movement: 0 }]),
      },
    },
    reaction(
      { endsMove: true, within: 120 },
      FOE,
      auto([{ kind: "strike", action: "Hop", near: 10 }]),
    ),
  ]),
  statBlock("catcher", [
    reaction(
      { falls: true, within: 60 },
      SELF,
      auto([{ kind: "slowFall", creatures: 5 }]),
      "Feather Fall",
    ),
  ]),
  statBlock(
    "splitter",
    [reaction({ damaged: true }, SELF, auto([{ kind: "split", times: 2 }]))],
    { size: "large" },
  ),
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
function fighter(run: RunContext, at: readonly [number, number]): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/fighter"));
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "Fighter",
      side: "party",
      source: { kind: "character", build: pregen.build },
      hp: 100,
      inventory: ["srd52:item/longsword", "srd52:item/shortbow"],
    }),
    position: { x: at[0], y: at[1] },
  };
}

function monster(
  block: string,
  at: readonly [number, number],
  {
    id = block,
    side = "enemy",
    hp = 500,
  }: { id?: string; side?: Actor["side"]; hp?: number } = {},
): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side,
      source: { kind: "monster", statBlockId: `test:monster/${block}` },
      hp,
      inventory: [],
    }),
    position: { x: at[0], y: at[1] },
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
      grid: { width: 20, height: 20 },
    },
  };
}

const contextOf = (run: RunContext, state: DndState, dice: Dice): Context => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});

// Every d20 lands on `natural` and every other die on 1.
const d20s = (natural: number): Dice => ({
  below: () => 0,
  roll: (sides) => (sides === 20 ? natural : 1),
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

const attack = (attacker: string, actionId: string, target: string): Frame => ({
  kind: `${NS}:attackRoll`,
  payload: { attacker, actionId, target },
});
const damageOf = (events: readonly SystemEvent[], actor: string): number[] =>
  events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    event.payload.actor === actor
      ? [Number(event.payload.amount)]
      : [],
  );
const square = (state: DndState, id: string) => state.actors[id]?.position;

describe("what a teleport does round where it lands or leaves", () => {
  it("blinds the foes beside the landing square, as Whirlwind of Sand does", async () => {
    const run = await base();
    // An ally of the player's stands at (5, 5); the whirl lands next to it. 6 + 5 = 11 hits AC 10, not 12.
    const state = fight(
      fighter(run, [0, 0]),
      monster("pod", [5, 5], { id: "friend", side: "party" }),
      monster("whirl", [1, 0]),
    );
    const { state: after } = settle(
      run,
      state,
      [attack(PLAYER_ACTOR, SWORD, "whirl")],
      d20s(6),
      (decision) =>
        decision.id.includes("teleportTo")
          ? "5,6"
          : (decision.options[0]?.id ?? ""),
    );
    expect(square(after, "whirl")).toEqual({ x: 5, y: 6 });
    const friend = after.actors.friend;
    expect(friend && hasCondition(friend, "blinded")).toBe(true);
    const player = after.actors[PLAYER_ACTOR];
    expect(player && hasCondition(player, "blinded")).toBe(false);
  });

  it("halves the Speed of those near the square it left who fail the save, as Temporal Disruption does", async () => {
    const run = await base();
    const state = fight(fighter(run, [0, 0]), monster("disruptor", [1, 0]));
    const { state: after } = settle(
      run,
      state,
      [attack(PLAYER_ACTOR, SWORD, "disruptor")],
      d20s(15),
      (decision) =>
        decision.id.includes("teleportTo")
          ? "7,0"
          : (decision.options[0]?.id ?? ""),
    );
    expect(square(after, "disruptor")).toEqual({ x: 7, y: 0 });
    expect(
      after.actors[PLAYER_ACTOR]?.activeEffects.map((item) => item.modifier),
    ).toContainEqual({ kind: "actionLimit", speed: "half" });
  });
});

describe("damage a reaction takes off and passes on", () => {
  it("sends the force back at the attacker once the hit is brought to 0, as Deflect Missile does", async () => {
    const run = await base();
    const state = fight(fighter(run, [0, 0]), monster("deflector", [4, 0]));
    const { events } = settle(
      run,
      state,
      [attack(PLAYER_ACTOR, BOW, "deflector")],
      d20s(15),
    );
    expect(damageOf(events, "deflector")).toEqual([]);
    expect(damageOf(events, PLAYER_ACTOR)).toEqual([7]);
  });

  it("gives the halved-off damage to a podling beside it, and isn't taken without one, as Transfer Harm does", async () => {
    const run = await base();
    const near = fight(
      fighter(run, [0, 0]),
      monster("plant", [1, 0]),
      monster("pod", [2, 0]),
    );
    // A natural 20 on the longsword: 2d8 at 1 each, +3.
    const hit = settle(
      run,
      near,
      [attack(PLAYER_ACTOR, SWORD, "plant")],
      d20s(20),
    );
    expect(damageOf(hit.events, "plant")).toEqual([2]);
    expect(damageOf(hit.events, "pod")).toEqual([3]);
    const alone = fight(fighter(run, [0, 0]), monster("plant", [1, 0]));
    const lone = settle(
      run,
      alone,
      [attack(PLAYER_ACTOR, SWORD, "plant")],
      d20s(20),
    );
    expect(lone.decisions).toEqual([]);
    expect(damageOf(lone.events, "plant")).toEqual([5]);
  });
});

describe("the rest of what reactions do", () => {
  it("sticks the weapon that missed, so it can't be used while the grapple holds, as Sticky Shield does", async () => {
    const run = await base();
    const state = fight(fighter(run, [0, 0]), monster("sticky", [1, 0]));
    // Extra Attack's second swing is already queued when the first misses, and isn't made.
    const { state: after, events } = settle(
      run,
      state,
      [
        attack(PLAYER_ACTOR, SWORD, "sticky"),
        attack(PLAYER_ACTOR, SWORD, "sticky"),
      ],
      d20s(2),
    );
    expect(
      events.filter((event) => event.kind === `${NS}:rollReported`),
    ).toHaveLength(1);
    const player = after.actors[PLAYER_ACTOR];
    if (!player) throw new Error("no player");
    expect(hasCondition(player, "grappled")).toBe(true);
    const ids = deriveStats(player, run).actions.map((item) => item.id);
    expect(ids).not.toContain(SWORD);
    expect(ids).toContain(BOW);
  });

  it("adds to AC against melee attacks only, until the bearer's next turn, as Defensive Stance does", async () => {
    const run = await base();
    const state = fight(fighter(run, [0, 0]), monster("stance", [1, 0]));
    // 7 + 5 = 12 hits AC 10, and misses the 14 the stance gives.
    const swung = settle(
      run,
      state,
      [attack(PLAYER_ACTOR, SWORD, "stance")],
      d20s(7),
    );
    expect(damageOf(swung.events, "stance")).toEqual([]);
    const again = settle(
      run,
      swung.state,
      [attack(PLAYER_ACTOR, SWORD, "stance")],
      d20s(7),
    );
    expect(damageOf(again.events, "stance")).toEqual([]);
    const shot = settle(
      run,
      swung.state,
      [attack(PLAYER_ACTOR, BOW, "stance")],
      d20s(7),
    );
    expect(damageOf(shot.events, "stance")).toHaveLength(1);
  });

  it("isn't offered again to a creature that saved against it, as with Unnerving Gaze", async () => {
    const run = await base();
    const state = fight(fighter(run, [0, 0]), monster("gazer", [2, 0]));
    const moment = { kind: "turnStart" as const, actor: PLAYER_ACTOR };
    const frames = reactFrames(moment, contextOf(run, state, d20s(10)));
    expect(frames).toHaveLength(1);
    const { state: after } = settle(run, state, frames, d20s(10));
    expect(reactFrames(moment, contextOf(run, after, d20s(10)))).toEqual([]);
  });

  it("answers a creature taking the Study action, as Warp Mind does", async () => {
    const run = await base();
    const state = fight(fighter(run, [0, 0]), monster("warper", [6, 0]));
    const context = contextOf(run, state, d20s(10));
    expect(
      reactFrames({ kind: "studied", actor: PLAYER_ACTOR }, context),
    ).toHaveLength(1);
    expect(
      reactFrames({ kind: "endsMove", actor: PLAYER_ACTOR }, context),
    ).toEqual([]);
  });

  it("answers only an ally's hit or failed magical save, as Defensive Divination does", async () => {
    const run = await base();
    const player = fighter(run, [0, 0]);
    const diviner = monster("diviner", [1, 0]);
    const friend = monster("pod", [2, 0], { id: "friend" });
    const context = contextOf(run, fight(player, diviner, friend), d20s(10));
    const save = {
      roller: friend,
      kind: "save" as const,
      natural: 5,
      total: 5,
      goal: 15,
    };
    expect(
      rollResponder({ ...save, success: false, magical: true }, [], context)
        ?.reactor.id,
    ).toBe("diviner");
    expect(rollResponder({ ...save, success: false }, [], context)).toBeNull();
    expect(
      rollResponder({ ...save, success: true, magical: true }, [], context),
    ).toBeNull();
    const swing = {
      roller: player,
      kind: "attack" as const,
      natural: 15,
      total: 20,
      goal: 10,
      against: friend,
    };
    expect(
      rollResponder({ ...swing, success: true }, [], context)?.reactor.id,
    ).toBe("diviner");
    expect(rollResponder({ ...swing, success: false }, [], context)).toBeNull();
  });

  it("gives Advantage against the attacker alone, as Limited Foresight does", async () => {
    const run = await base();
    // Bloodied, so the seer takes it.
    const state = fight(
      fighter(run, [0, 0]),
      monster("seer", [1, 0], { hp: 100 }),
    );
    const seer = state.actors.seer;
    if (!seer) throw new Error("no seer");
    const hurt = {
      ...state,
      actors: { ...state.actors, seer: { ...seer, hp: 10 } },
    };
    const { state: after } = settle(
      run,
      hurt,
      [attack(PLAYER_ACTOR, SWORD, "seer")],
      d20s(15),
    );
    expect(after.actors[PLAYER_ACTOR]?.activeEffects).toContainEqual(
      expect.objectContaining({
        casterId: "seer",
        modifier: { kind: "advantage", on: "attacksAgainst", casterOnly: true },
      }),
    );
  });

  it("teleports to within 10 feet of the creature that ended its move, as Pursuit does", async () => {
    const run = await base();
    const state = fight(fighter(run, [0, 0]), monster("hunter", [15, 15]));
    const { state: after } = settle(
      run,
      state,
      reactFrames(
        { kind: "endsMove", actor: PLAYER_ACTOR },
        contextOf(run, state, d20s(10)),
      ),
      d20s(10),
    );
    const at = square(after, "hunter");
    expect(at && Math.max(at.x, at.y)).toBeLessThanOrEqual(2);
  });

  it("shrinks both halves a size when a creature splits", async () => {
    const run = await base();
    const state = fight(
      fighter(run, [0, 0]),
      monster("splitter", [1, 0], { hp: 40 }),
    );
    const { state: after } = settle(
      run,
      state,
      [attack(PLAYER_ACTOR, SWORD, "splitter")],
      d20s(15),
    );
    const halves = Object.values(after.actors).filter((item) =>
      item.id.startsWith("splitter"),
    );
    expect(halves).toHaveLength(2);
    expect(halves.map((item) => sizeOf(item, run))).toEqual([2, 2]);
  });

  it("can't benefit from Invisible while outlined, as under Fiendish Blood's curse", () => {
    const hidden = {
      ...freshActor({
        id: "x",
        name: "x",
        side: "party",
        source: { kind: "character", build: null },
        hp: 1,
        inventory: [],
      }),
      activeEffects: [
        {
          sourceId: "s",
          casterId: "c",
          modifier: {
            kind: "condition" as const,
            condition: "invisible" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    } as Actor;
    const viewer = { ...hidden, id: "y", activeEffects: [] };
    expect(invisibleTo(hidden, viewer)).toBe(true);
    const outlined = {
      ...hidden,
      activeEffects: [
        ...hidden.activeEffects,
        {
          sourceId: "t",
          casterId: "c",
          modifier: { kind: "outlined" as const },
          ends: "spellDuration" as const,
        },
      ],
    };
    expect(invisibleTo(outlined, viewer)).toBe(false);
  });
});

describe("falling", () => {
  // Reverse Gravity's lift on these creatures, as the spell's caster, the player, puts it there.
  function lifted(run: RunContext, state: DndState, ids: readonly string[]) {
    const caster = state.actors[PLAYER_ACTOR];
    if (!caster) throw new Error("no caster");
    return ids.reduce((after, id) => {
      const target = after.actors[id];
      if (!target) throw new Error(`no ${id}`);
      return leafEvents(
        [{ kind: "lift", feet: 60, duration: { minutes: 1 } }],
        "rg",
        caster,
        target,
        contextOf(run, after, d20s(10)),
      ).reduce(applyDndEvent, after);
    }, state);
  }
  const ended = (state: DndState, ids: readonly string[]) =>
    ids.reduce(
      (after, id) =>
        applyDndEvent(after, {
          kind: `${NS}:effectEnded`,
          payload: { actor: id, sourceId: "rg", casterId: PLAYER_ACTOR },
        }),
      state,
    );

  it("lifts a creature out of reach of those below until the spell ends, then drops it for 1d6 per 10 feet and Prone", async () => {
    const run = await base();
    const start = fight(fighter(run, [0, 0]), monster("pod", [1, 0]));
    const up = lifted(run, start, ["pod"]);
    const pod = up.actors.pod;
    const player = up.actors[PLAYER_ACTOR];
    if (!pod || !player) throw new Error("missing");
    expect(heightOf(pod)).toBe(60);
    const sword = deriveStats(player, run).actions.find(
      (item) => item.id === SWORD,
    );
    if (!sword) throw new Error("no sword");
    expect(inReach(sword, player, up, run)).toEqual([]);
    // Nothing falls while the spell holds it up.
    const holding = settle(
      run,
      up,
      [{ kind: `${NS}:checkCombatEnd`, payload: {} }],
      d20s(10),
    );
    expect(damageOf(holding.events, "pod")).toEqual([]);
    const { state, events } = settle(
      run,
      ended(up, ["pod"]),
      [{ kind: `${NS}:checkCombatEnd`, payload: {} }],
      d20s(10),
    );
    expect(damageOf(events, "pod")).toEqual([6]);
    const landed = state.actors.pod;
    expect(landed && hasCondition(landed, "prone")).toBe(true);
    expect(landed && heightOf(landed)).toBe(0);
  });

  it("lets its own side down gently with Feather Fall, and only its side", async () => {
    const run = await base();
    const start = fight(
      fighter(run, [0, 0]),
      monster("pod", [1, 0]),
      monster("catcher", [3, 0]),
    );
    const down = ended(lifted(run, start, ["pod", PLAYER_ACTOR]), [
      "pod",
      PLAYER_ACTOR,
    ]);
    const { state, events } = settle(
      run,
      down,
      [{ kind: `${NS}:checkCombatEnd`, payload: {} }],
      d20s(10),
    );
    expect(damageOf(events, "pod")).toEqual([]);
    expect(damageOf(events, PLAYER_ACTOR)).toEqual([6]);
    expect(state.actors.catcher?.budget.reaction).toBe(false);
  });
});
