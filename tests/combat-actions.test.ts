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
import { tacticalPolicy } from "../plugins/systems/dnd5.5e/core/actions.ts";
import {
  type Context,
  provokers,
  rollSave,
  speedLeft,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
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
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  coverAgainst,
  coverFor,
} from "../plugins/systems/dnd5.5e/core/sight.ts";
import { distanceFeet } from "../plugins/systems/dnd5.5e/core/grid.ts";
import { dndCue } from "../plugins/systems/dnd5.5e/ui/cues.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";

// Dice that land the same way every time, or d20s in a set order (then 20s), so results can be stated exactly.
const HIGH: Dice = { below: () => 0, roll: (sides) => sides };
const LOW: Dice = { below: () => 0, roll: () => 1 };
function d20s(...rolls: readonly number[]): Dice {
  const left = [...rolls];
  return {
    below: () => 0,
    roll: (sides) => (sides === 20 ? (left.shift() ?? 20) : sides),
  };
}

const weapon = (
  slug: string,
  mastery: string,
  properties: readonly string[] = [],
  dice = "1d8",
) => ({
  id: `test:item/${slug}`,
  name: `Test ${slug}`,
  type: "weapon",
  category: "martial",
  damage: { dice, type: "slashing" },
  properties,
  mastery,
});

const WEAPONS = [
  weapon("sapper", "sap"),
  weapon("slower", "slow"),
  weapon("vexer", "vex"),
  weapon("toppler", "topple"),
  weapon("pusher", "push"),
  weapon("cleaver", "cleave", [], "1d12"),
  weapon("grazer", "graze"),
];

function dummy(id: string, fields: Readonly<Record<string, unknown>> = {}) {
  return {
    id,
    name: "Dummy",
    ac: 10,
    hp: 500,
    speed: 30,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    proficiency: 2,
    initiative: 0,
    actions: [
      {
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
      },
    ],
    ...fields,
  };
}

// Bites, then squeezes: a grapple with an escape DC, and Restrained and damage each turn until it ends.
const COILER = dummy("test:monster/coiler", {
  text: [
    "Actions",
    "Multiattack. The coiler makes one Bite attack and uses Squeeze.",
    "Bite. Melee Attack Roll: +4, reach 5 ft. Hit: 3 (1d6) Piercing damage.",
    "Squeeze. Strength Saving Throw: DC 14, one creature within 10 feet. Failure: The target has the Grappled condition (escape DC 15).",
  ].join("\n"),
  actions: [
    {
      name: "Squeeze",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 10, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "str",
          dc: { base: 14 },
          onFail: [
            {
              kind: "applyCondition",
              condition: "grappled",
              duration: { minutes: 1 },
            },
            {
              kind: "applyCondition",
              condition: "restrained",
              duration: { minutes: 1 },
            },
            {
              kind: "modifier",
              modifier: {
                kind: "lingeringDamage",
                when: "turnStart",
                damage: [{ amount: { dice: "1d6" }, type: "bludgeoning" }],
              },
              duration: { minutes: 1 },
            },
          ],
        },
      },
    },
    {
      name: "Bite",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "weapon", flatBonus: 4 },
          damage: [{ amount: { dice: "1d6" }, type: "piercing" }],
        },
      },
    },
  ],
});

// Swallows a creature it's grappling, and lets it out after 10 damage from inside in one turn.
const GULPER = dummy("test:monster/gulper", {
  text: [
    "Actions",
    "Gulp. Strength Saving Throw: DC 14, one creature Grappled by the gulper. Failure: The target is swallowed, and the Grappled condition ends.",
    "If the gulper takes 10 damage or more on a single turn from a creature inside it, the gulper must succeed on a DC 12 Constitution saving throw at the end of that turn or regurgitate all swallowed creatures, each of which falls in a space within 5 feet of the gulper and has the Prone condition.",
    "If the gulper dies, a swallowed creature is no longer Restrained and can escape from the corpse using 10 feet of movement, exiting Prone.",
  ].join("\n"),
  actions: [
    {
      name: "Gulp",
      activation: {
        cost: ["action"],
        targeting: {
          creatures: 1,
          range: 5,
          side: "enemy",
          targetConditions: ["grappled"],
        },
        resolution: {
          kind: "save",
          ability: "str",
          dc: { base: 14 },
          onFail: [
            { kind: "removeCondition", condition: "grappled" },
            {
              kind: "applyCondition",
              condition: "blinded",
              duration: { minutes: 1 },
            },
            {
              kind: "applyCondition",
              condition: "restrained",
              duration: { minutes: 1 },
            },
          ],
        },
      },
    },
    ...(dummy("x").actions as unknown[]),
  ],
});

// A claw whose hit brings a save against paralysis, on its own source.
const CLAWER = dummy("test:monster/clawer", {
  actions: [
    {
      name: "Claw",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "weapon", flatBonus: 4 },
          damage: [{ amount: { dice: "1d4" }, type: "slashing" }],
          onHit: [
            {
              kind: "applyCondition",
              condition: "grappled",
              duration: { minutes: 1 },
            },
          ],
          onHitSave: {
            ability: "con",
            dc: { base: 10 },
            onFail: [
              {
                kind: "applyCondition",
                condition: "paralyzed",
                duration: { minutes: 1 },
                repeatSave: true,
              },
            ],
            exempt: ["undead"],
          },
        },
      },
    },
  ],
});

// A plain Club and a weaker Claw whose hit brings a hard save against paralysis, which elves skip, or humans.
const pinner = (exempt: readonly string[]) =>
  dummy(`test:monster/pinner-${exempt.join("-")}`, {
    actions: [
      ...(dummy("x").actions as unknown[]),
      {
        name: "Claw",
        activation: {
          cost: ["action"],
          targeting: { creatures: 1, range: 5, side: "enemy" },
          resolution: {
            kind: "attack",
            attack: { type: "weapon", flatBonus: 4 },
            damage: [{ amount: { dice: "1d4" }, type: "slashing" }],
            onHitSave: {
              ability: "con",
              dc: { base: 16 },
              onFail: [
                {
                  kind: "applyCondition",
                  condition: "paralyzed",
                  duration: { minutes: 1 },
                  repeatSave: true,
                },
              ],
              exempt,
            },
          },
        },
      },
    ],
  });
// Cunning Action: Dash, Disengage or Hide as a Bonus Action.
const SNEAK = dummy("test:monster/sneak", {
  passives: [{ kind: "bonusTactics", tactics: ["dash", "disengage", "hide"] }],
});

// Teleports 40 feet, or jumps 30 for 10 feet of movement.
const mover = (name: string, movement: number) => ({
  name,
  activation: {
    cost: ["bonusAction"],
    targeting: { self: true },
    resolution: {
      kind: "automatic",
      effects: [{ kind: "teleport", feet: movement ? 30 : 40, movement }],
    },
  },
});
const BLINKER = dummy("test:monster/blinker", {
  actions: [...(dummy("x").actions as unknown[]), mover("Teleport", 0)],
});
const LEAPER = dummy("test:monster/leaper", {
  actions: [...(dummy("x").actions as unknown[]), mover("Leap", 10)],
});

// The gulper with its Club listed first, as the giant toad lists its Bite before Swallow.
const TOAD = dummy("test:monster/toad", {
  actions: [...(GULPER.actions as unknown[])].reverse(),
});
// The same, swallowing only a Small or smaller creature, as the giant frog does.
const FROG = dummy("test:monster/frog", {
  actions: (TOAD.actions as { activation: { targeting: object } }[]).map(
    (action, index) =>
      index === 1
        ? {
            ...action,
            activation: {
              ...action.activation,
              targeting: { ...action.activation.targeting, maxSize: "small" },
            },
          }
        : action,
  ),
});
const PINNER = pinner(["elf"]);
const HUMAN_PINNER = pinner(["human"]);

// Weakens one creature: Disadvantage on Strength saves and a damage penalty, saved against each turn.
const WEAKENER = dummy("test:monster/weakener", {
  actions: [
    {
      name: "Sap",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "str",
          dc: { base: 12 },
          onFail: [
            {
              kind: "modifier",
              modifier: { kind: "disadvantage", on: "saves", ability: "str" },
              duration: { minutes: 1 },
              repeatSave: true,
            },
            {
              kind: "modifier",
              modifier: {
                kind: "damageBonus",
                amount: { dice: "1d4" },
                subtract: true,
              },
              duration: { minutes: 1 },
              repeatSave: true,
            },
          ],
        },
      },
    },
  ],
});

// Bites, then sprays a cone that the Multiattack has to aim.
const SPITTER = dummy("test:monster/spitter", {
  text: "Actions\nMultiattack. The spitter makes one Club attack and uses Spray.",
  actions: [
    ...(dummy("x").actions as unknown[]),
    {
      name: "Spray",
      activation: {
        cost: ["action"],
        targeting: {
          area: { shape: "cone", radius: 15 },
          range: "self",
          side: "enemy",
        },
        resolution: {
          kind: "save",
          ability: "dex",
          dc: { base: 12 },
          damage: [{ amount: { dice: "1d6" }, type: "acid" }],
        },
      },
    },
  ],
});

function arena(base: RunContext): RunContext {
  const content: Record<string, unknown> = {
    "test:monster/dummy": dummy("test:monster/dummy"),
    "test:monster/coiler": COILER,
    "test:monster/spitter": SPITTER,
    "test:monster/gulper": GULPER,
    "test:monster/clawer": CLAWER,
    "test:monster/weakener": WEAKENER,
    [PINNER.id]: PINNER,
    [TOAD.id]: TOAD,
    [FROG.id]: FROG,
    [SNEAK.id]: SNEAK,
    [BLINKER.id]: BLINKER,
    [LEAPER.id]: LEAPER,
    [HUMAN_PINNER.id]: HUMAN_PINNER,
    "test:monster/giant": dummy("test:monster/giant", { size: "huge" }),
    ...Object.fromEntries(WEAPONS.map((item) => [item.id, item])),
  };
  return {
    ...base,
    content: (id) =>
      (content[id] as ReturnType<RunContext["content"]>) ?? base.content(id),
    contentIds: () => [
      ...new Set([...base.contentIds(), ...Object.keys(content)]),
    ],
  };
}

const base = async (): Promise<RunContext> =>
  arena((await loadAdventure("goblin-ambush")).run);

// The SRD fighter: Strength 17 (+3), Proficiency +2, so an Unarmed Strike or mastery DC is 13.
function fighter(
  run: RunContext,
  options: {
    readonly id?: string;
    readonly inventory?: readonly string[];
    readonly mastery?: readonly string[];
    readonly at?: readonly [number, number];
  } = {},
): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/fighter"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  return {
    ...freshActor({
      id: options.id ?? PLAYER_ACTOR,
      name: options.id ?? "Fighter",
      side: "party",
      source: {
        kind: "character",
        build: {
          ...pregen.build,
          levels: [
            {
              ...first,
              answers: [
                { kind: "weaponMastery", values: [...(options.mastery ?? [])] },
              ],
            },
          ],
        },
      },
      hp: 100,
      inventory: [...(options.inventory ?? ["srd52:item/longsword"])],
    }),
    position: options.at ? { x: options.at[0], y: options.at[1] } : null,
  };
}

function monster(
  id: string,
  at?: readonly [number, number],
  statBlockId = "test:monster/dummy",
): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId },
      hp: 500,
      inventory: [],
    }),
    position: at ? { x: at[0], y: at[1] } : null,
  };
}

function fight(
  actors: readonly Actor[],
  grid = actors.some((item) => item.position),
): DndState {
  return {
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: {
      encounter: "arena",
      order: actors.map((item) => item.id),
      index: 0,
      round: 1,
      ...(grid ? { grid: { width: 20, height: 20 } } : {}),
    },
  };
}

function contextOf(run: RunContext, state: DndState, dice: Dice): Context {
  return { state, dice, content: run.content, contentIds: run.contentIds };
}

// A small copy of the kernel's loop, so an action can be followed through its frames with chosen dice.
function settle(
  run: RunContext,
  start: DndState,
  frames: readonly Frame[],
  dice: Dice,
): { state: DndState; events: SystemEvent[] } {
  let state = start;
  const events: SystemEvent[] = [];
  const stack = [...frames].reverse();
  for (let top = stack.pop(); top; top = stack.pop()) {
    if (top.kind === AWAIT_FRAME) {
      const { decision } = top.payload as { decision: Decision };
      stack.push({
        kind: decision.resume.kind,
        payload: {
          ...decision.resume.payload,
          answer: decision.options[0]?.id ?? "",
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
  return { state, events };
}

const act = (actor: string, answer: string): Frame => ({
  kind: `${NS}:takeAction`,
  payload: { actor, answer },
});
const moveTo = (actor: string, x: number, y: number): Frame => ({
  kind: `${NS}:move`,
  payload: { actor, answer: `${String(x)},${String(y)}` },
});
const attackRoll = (attacker: string, actionId: string, target: string) => ({
  kind: `${NS}:attackRoll`,
  payload: { attacker, actionId, target },
});

function who(state: DndState, id: string): Actor {
  const found = state.actors[id];
  if (!found) throw new Error(`No actor ${id}`);
  return found;
}

function optionIds(run: RunContext, state: DndState): string[] {
  const decision = run.system.nextDecision(state, {
    content: run.content,
    contentIds: run.contentIds,
  });
  return (decision?.options ?? []).map((option) => option.id);
}

function rolls(events: readonly SystemEvent[]) {
  return events.flatMap((event) =>
    event.kind === `${NS}:rollReported` && "payload" in event
      ? [event.payload as { actor: string; against: string; natural: number }]
      : [],
  );
}

function damageTo(events: readonly SystemEvent[], actor: string): number[] {
  return events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    event.payload.actor === actor
      ? [Number(event.payload.amount)]
      : [],
  );
}

function payloadOf(events: readonly SystemEvent[], kind: string): unknown {
  const found = events.find((event) => event.kind === `${NS}:${kind}`);
  return found && "payload" in found ? found.payload : null;
}

function sources(actor: Actor): string[] {
  return actor.activeEffects.map((item) => item.sourceId);
}

// Starts the next creature's turn, as the kernel does between turns.
function nextTurn(state: DndState): DndState {
  return applyDndEvent(state, dndEvent(`${NS}:turnAdvanced`, {}));
}

const LONGSWORD = "weapon:srd52:item/longsword";

describe("actions anyone can take", () => {
  it("offers them in their own tab, after Move and before ending the turn", async () => {
    const run = await base();
    const state = fight([fighter(run, { at: [0, 0] }), monster("foe", [1, 0])]);
    const ids = optionIds(run, state);
    expect(ids).toEqual(
      expect.arrayContaining([
        "tactic:dash",
        "tactic:disengage",
        "tactic:dodge",
        "tactic:study|foe",
        "tactic:grapple|foe",
        "tactic:shove|foe|prone",
        "tactic:shove|foe|push",
        `tactic:ready|${LONGSWORD}`,
      ]),
    );
    // A foe beside you means you can't hide, and with no ally there's no one to help.
    expect(ids).not.toContain("tactic:hide");
    expect(ids.some((id) => id.startsWith("tactic:help"))).toBe(false);
    expect(ids.at(-1)).toBe("pass");
    expect(ids.indexOf("tactic:dash")).toBeGreaterThan(ids.indexOf("move"));

    const decision = run.system.nextDecision(state, run);
    if (!decision) throw new Error("No decision");
    const groups = dndUi.optionGroups(decision, state, run);
    const tab = groups.find((group) => group.title === "Actions");
    expect(tab?.options.map((option) => option.id)).toContain("tactic:dodge");
    expect(tab?.options.find((o) => o.id === "tactic:dodge")?.detail).toMatch(
      /Disadvantage/,
    );
    expect(
      groups.find((group) => group.title === "Attacks")?.options,
    ).not.toContainEqual(expect.objectContaining({ id: "tactic:dodge" }));
  });

  it("Dash adds the Speed again for the turn, which goes on for the move", async () => {
    const run = await base();
    const state = fight([fighter(run, { at: [0, 0] }), monster("foe", [9, 9])]);
    const stats = deriveStats(who(state, PLAYER_ACTOR), run);
    expect(speedLeft(who(state, PLAYER_ACTOR), stats)).toBe(30);
    const dashed = settle(run, state, [act(PLAYER_ACTOR, "tactic:dash")], LOW);
    expect(speedLeft(who(dashed.state, PLAYER_ACTOR), stats)).toBe(60);
    expect(dashed.state.combat?.index).toBe(0);
    expect(optionIds(run, dashed.state)).toContain("move");
    // It lasts only until the creature's next turn.
    const later = nextTurn(nextTurn(dashed.state));
    expect(speedLeft(who(later, PLAYER_ACTOR), stats)).toBe(30);
  });

  it("Disengage stops Opportunity Attacks for the turn", async () => {
    const run = await base();
    const state = fight([fighter(run, { at: [5, 5] }), monster("foe", [6, 5])]);
    const away = { x: 2, y: 5 };
    expect(provokers(who(state, PLAYER_ACTOR), away, state, run)).toHaveLength(
      1,
    );
    const done = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:disengage")],
      LOW,
    );
    expect(
      provokers(who(done.state, PLAYER_ACTOR), away, done.state, run),
    ).toHaveLength(0);
    const walked = settle(run, done.state, [moveTo(PLAYER_ACTOR, 2, 5)], HIGH);
    expect(rolls(walked.events)).toEqual([]);
  });

  it("Dodge gives attacks against you Disadvantage and you Advantage on Dexterity saves", async () => {
    const run = await base();
    const state = fight([fighter(run), monster("foe")]);
    const dodged = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:dodge")],
      LOW,
    ).state;
    const swing = settle(
      run,
      dodged,
      [attackRoll("foe", "monster:0", PLAYER_ACTOR)],
      d20s(20, 2),
    );
    expect(rolls(swing.events)[0]?.natural).toBe(2);
    const plain = settle(
      run,
      state,
      [attackRoll("foe", "monster:0", PLAYER_ACTOR)],
      d20s(20, 2),
    );
    expect(rolls(plain.events)[0]?.natural).toBe(20);

    const hero = who(dodged, PLAYER_ACTOR);
    expect(
      rollSave(hero, "dex", 15, contextOf(run, dodged, d20s(1, 20))).saved,
    ).toBe(true);
    expect(
      rollSave(hero, "str", 15, contextOf(run, dodged, d20s(1, 20))).saved,
    ).toBe(false);
    expect(sources(who(nextTurn(nextTurn(dodged)), PLAYER_ACTOR))).toEqual([]);
  });

  it("Help gives an ally's next attack on a foe beside you Advantage, once", async () => {
    const run = await base();
    const state = fight([
      fighter(run),
      fighter(run, { id: "ally" }),
      monster("foe"),
    ]);
    expect(optionIds(run, state)).toContain("tactic:help|foe");
    const helped = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:help|foe")],
      LOW,
    ).state;
    const first = settle(
      run,
      helped,
      [attackRoll("ally", LONGSWORD, "foe")],
      d20s(1, 15),
    );
    expect(rolls(first.events)[0]?.natural).toBe(15);
    const second = settle(
      run,
      first.state,
      [attackRoll("ally", LONGSWORD, "foe")],
      d20s(1, 15),
    );
    expect(rolls(second.events)[0]?.natural).toBe(1);
  });

  it("Help on an ally gives its next check Advantage, once", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [0, 0] }),
      fighter(run, { id: "ally", at: [1, 0] }),
      monster("foe", [9, 9]),
    ]);
    const helped = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:help|ally")],
      LOW,
    ).state;
    const onAlly: DndState = {
      ...helped,
      combat: helped.combat && { ...helped.combat, index: 1 },
    };
    const hid = settle(run, onAlly, [act("ally", "tactic:hide")], d20s(1, 16));
    expect(rolls(hid.events)[0]?.natural).toBe(16);
    expect(sources(who(hid.state, "ally"))).not.toContain("tactic:help");
  });

  it("Help stabilizes a dying ally within 5 feet on a DC 10 Medicine check", async () => {
    const run = await base();
    const dying = {
      ...fighter(run, { id: "ally", at: [1, 0] }),
      hp: 0,
      deathSaves: { successes: 1, failures: 2 },
    };
    const state = fight([
      fighter(run, { at: [0, 0] }),
      dying,
      monster("foe", [9, 9]),
    ]);
    expect(optionIds(run, state)).toContain("tactic:help|ally");
    const decision = run.system.nextDecision(state, run);
    if (!decision) throw new Error("No decision");
    const shown = dndUi
      .optionGroups(decision, state, run)
      .flatMap((group) => group.options)
      .find((option) => option.id === "tactic:help|ally");
    expect(shown?.label).toMatch(/Stabilize/);
    expect(shown?.detail).toMatch(/Stable/);
    const steadied = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:help|ally")],
      HIGH,
    );
    expect(who(steadied.state, "ally").deathSaves).toEqual({
      successes: 3,
      failures: 0,
    });
    const fumbled = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:help|ally")],
      LOW,
    );
    expect(who(fumbled.state, "ally").deathSaves.failures).toBe(2);
    // Too far away, there's no one to stabilize.
    const far = fight([
      fighter(run, { at: [0, 0] }),
      { ...dying, position: { x: 5, y: 0 } },
      monster("foe", [9, 9]),
    ]);
    expect(optionIds(run, far)).not.toContain("tactic:help|ally");
  });

  it("a companion stabilizes the dying player beside it instead of attacking", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { id: "ally", at: [0, 0] }),
      {
        ...fighter(run, { at: [1, 0] }),
        hp: 0,
        deathSaves: { successes: 0, failures: 1 },
      },
      monster("foe", [0, 1]),
    ]);
    const decision = run.system.nextDecision(state, run);
    if (!decision) throw new Error("No decision");
    expect(decision.options.map((option) => option.id)).toContain(
      `${LONGSWORD}|foe`,
    );
    expect(tacticalPolicy(decision, contextOf(run, state, LOW))).toBe(
      `tactic:help|${PLAYER_ACTOR}`,
    );
  });

  it("Hide makes you Invisible until you attack, and a Search can find you", async () => {
    const run = await base();
    const state = fight([fighter(run, { at: [0, 0] }), monster("foe", [6, 0])]);
    expect(optionIds(run, state)).toContain("tactic:hide");
    const failed = settle(run, state, [act(PLAYER_ACTOR, "tactic:hide")], LOW);
    expect(hasCondition(who(failed.state, PLAYER_ACTOR), "invisible")).toBe(
      false,
    );
    const hidden = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:hide")],
      d20s(14), // Dexterity +1 makes a Stealth total of 15
    ).state;
    expect(hasCondition(who(hidden, PLAYER_ACTOR), "invisible")).toBe(true);

    // A Search finds it with a Perception total of 15 or more.
    const onFoe: DndState = {
      ...hidden,
      combat: hidden.combat && { ...hidden.combat, index: 1 },
    };
    expect(optionIds(run, onFoe)).toContain("tactic:search");
    const missed = settle(run, onFoe, [act("foe", "tactic:search")], d20s(14));
    expect(hasCondition(who(missed.state, PLAYER_ACTOR), "invisible")).toBe(
      true,
    );
    const found = settle(run, onFoe, [act("foe", "tactic:search")], d20s(15));
    expect(hasCondition(who(found.state, PLAYER_ACTOR), "invisible")).toBe(
      false,
    );

    // Attacking from hiding has Advantage and gives you away.
    const near: DndState = {
      ...hidden,
      actors: {
        ...hidden.actors,
        foe: { ...who(hidden, "foe"), position: { x: 1, y: 0 } },
      },
    };
    const struck = settle(
      run,
      near,
      [act(PLAYER_ACTOR, `${LONGSWORD}|foe`)],
      d20s(3, 12),
    );
    expect(rolls(struck.events)[0]?.natural).toBe(12);
    expect(hasCondition(who(struck.state, PLAYER_ACTOR), "invisible")).toBe(
      false,
    );
  });

  it("Ready attacks a foe stepping into reach, with the Reaction", async () => {
    const run = await base();
    const state = fight([fighter(run, { at: [5, 5] }), monster("foe", [9, 5])]);
    const readied = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `tactic:ready|${LONGSWORD}`)],
      LOW,
    ).state;
    // Moving about out of reach doesn't set it off.
    const far = settle(run, readied, [moveTo("foe", 8, 5)], HIGH);
    expect(rolls(far.events)).toEqual([]);
    const close = settle(run, far.state, [moveTo("foe", 6, 5)], HIGH);
    expect(rolls(close.events)).toEqual([
      expect.objectContaining({ actor: PLAYER_ACTOR, against: "foe" }),
    ]);
    expect(who(close.state, PLAYER_ACTOR).budget.reaction).toBe(false);
    expect(sources(who(close.state, PLAYER_ACTOR))).not.toContain(
      "tactic:ready",
    );
  });

  it("Study and Search are checks, and Study tells what it learns", async () => {
    const run = await base();
    const state = fight([fighter(run), monster("foe")]);
    const learned = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:study|foe")],
      HIGH,
    );
    expect(payloadOf(learned.events, "rollReported")).toMatchObject({
      against: "check",
      target: 15,
      success: true,
      label: "history (foe: AC 10)",
    });
    expect(who(learned.state, PLAYER_ACTOR).budget.action).toBe(false);
  });

  it("Grapple: a failed save holds the target at Speed 0 until it escapes", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [5, 5] }),
      fighter(run, { id: "ally", at: [9, 9] }),
      monster("foe", [6, 5]),
    ]);
    const resisted = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:grapple|foe")],
      HIGH,
    );
    expect(hasCondition(who(resisted.state, "foe"), "grappled")).toBe(false);
    const held = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:grapple|foe")],
      LOW,
    ).state;
    const foe = who(held, "foe");
    expect(hasCondition(foe, "grappled")).toBe(true);
    expect(speedLeft(foe, deriveStats(foe, run))).toBe(0);
    // Attacks at anyone but the grappler have Disadvantage.
    const atAlly = settle(
      run,
      held,
      [attackRoll("foe", "monster:0", "ally")],
      d20s(18, 4),
    );
    expect(rolls(atAlly.events)[0]?.natural).toBe(4);
    // It escapes with its action: Athletics +0 against DC 13, and the end of its turn alone doesn't free it.
    const onFoe: DndState = {
      ...held,
      combat: held.combat && { ...held.combat, index: 2 },
    };
    const end = { kind: `${NS}:endTurn`, payload: {} };
    const waited = settle(run, onFoe, [end], HIGH);
    expect(hasCondition(who(waited.state, "foe"), "grappled")).toBe(true);
    const escape = "tactic:escape|player|tactic:grapple";
    expect(optionIds(run, onFoe)).toContain(escape);
    const stuck = settle(run, onFoe, [act("foe", escape)], d20s(12));
    expect(hasCondition(who(stuck.state, "foe"), "grappled")).toBe(true);
    expect(who(stuck.state, "foe").budget.action).toBe(false);
    const free = settle(run, onFoe, [act("foe", escape)], d20s(13));
    expect(hasCondition(who(free.state, "foe"), "grappled")).toBe(false);
    // Walking away lets go.
    const left = settle(run, held, [moveTo(PLAYER_ACTOR, 3, 5)], LOW);
    expect(hasCondition(who(left.state, "foe"), "grappled")).toBe(false);
  });

  it("can't Grapple or Shove a creature two sizes larger", async () => {
    const run = await base();
    const state = fight([
      fighter(run),
      monster("giant", undefined, "test:monster/giant"),
    ]);
    const ids = optionIds(run, state);
    expect(ids.some((id) => id.startsWith("tactic:grapple"))).toBe(false);
    expect(ids.some((id) => id.startsWith("tactic:shove"))).toBe(false);
  });

  it("Shove knocks a foe Prone or pushes it 5 feet, and standing costs half its Speed", async () => {
    const run = await base();
    const state = fight([fighter(run, { at: [5, 5] }), monster("foe", [6, 5])]);
    const prone = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:shove|foe|prone")],
      LOW,
    ).state;
    expect(hasCondition(who(prone, "foe"), "prone")).toBe(true);
    const pushed = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "tactic:shove|foe|push")],
      LOW,
    ).state;
    expect(who(pushed, "foe").position).toEqual({ x: 7, y: 5 });
    expect(who(pushed, "foe").moved).toBe(0);

    const onFoe: DndState = {
      ...prone,
      combat: prone.combat && { ...prone.combat, index: 1 },
    };
    expect(optionIds(run, onFoe)).toContain("tactic:stand");
    const decision = run.system.nextDecision(onFoe, run);
    if (!decision) throw new Error("No decision");
    expect(tacticalPolicy(decision, contextOf(run, onFoe, LOW))).toBe(
      "tactic:stand",
    );
    const stood = settle(run, onFoe, [act("foe", "tactic:stand")], LOW).state;
    expect(hasCondition(who(stood, "foe"), "prone")).toBe(false);
    expect(who(stood, "foe").moved).toBe(15);
  });
});

describe("two weapons", () => {
  const dagger = "weapon:srd52:item/dagger";
  const shortsword = "weapon:srd52:item/shortsword";

  it("lets a second Light weapon attack as a Bonus Action, without the ability modifier", async () => {
    const run = await base();
    const state = fight([
      fighter(run, {
        inventory: ["srd52:item/shortsword", "srd52:item/dagger"],
      }),
      monster("foe"),
    ]);
    expect(
      optionIds(run, state).some((id) => id.startsWith("tactic:offhand")),
    ).toBe(false);
    const first = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `${shortsword}|foe`)],
      HIGH,
    );
    // A critical 2d6 plus Strength +3.
    expect(damageTo(first.events, "foe")).toEqual([15]);
    const offhand = `tactic:offhand|foe|${dagger}`;
    expect(optionIds(run, first.state)).toContain(offhand);
    const second = settle(run, first.state, [act(PLAYER_ACTOR, offhand)], HIGH);
    expect(damageTo(second.events, "foe")).toEqual([8]); // 2d4, no +3
    expect(who(second.state, PLAYER_ACTOR).budget.bonusAction).toBe(false);
    expect(
      optionIds(run, second.state).some((id) =>
        id.startsWith("tactic:offhand"),
      ),
    ).toBe(false);
  });

  it("makes the off-hand attack part of the Attack action with Nick", async () => {
    const run = await base();
    const state = fight([
      fighter(run, {
        inventory: ["srd52:item/shortsword", "srd52:item/dagger"],
        mastery: ["srd52:item/dagger"],
      }),
      monster("foe"),
    ]);
    const first = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `${shortsword}|foe`)],
      HIGH,
    );
    const offhand = `tactic:offhand|foe|${dagger}`;
    const decision = run.system.nextDecision(first.state, run);
    expect(decision?.options.find((o) => o.id === offhand)?.label).toMatch(
      /Nick/,
    );
    const second = settle(run, first.state, [act(PLAYER_ACTOR, offhand)], HIGH);
    expect(who(second.state, PLAYER_ACTOR).budget.bonusAction).toBe(true);
  });

  it("needs two weapons, or two of the same Light weapon", async () => {
    const run = await base();
    const one = fight([
      fighter(run, { inventory: ["srd52:item/dagger"] }),
      monster("foe"),
    ]);
    const after = settle(run, one, [act(PLAYER_ACTOR, `${dagger}|foe`)], HIGH);
    expect(
      optionIds(run, after.state).some((id) => id.startsWith("tactic:offhand")),
    ).toBe(false);
    const pair = fight([
      fighter(run, { inventory: ["srd52:item/dagger", "srd52:item/dagger"] }),
      monster("foe"),
    ]);
    const twice = settle(run, pair, [act(PLAYER_ACTOR, `${dagger}|foe`)], HIGH);
    expect(optionIds(run, twice.state)).toContain(
      `tactic:offhand|foe|${dagger}`,
    );
  });
});

describe("weapon mastery", () => {
  const armed = (
    run: RunContext,
    slug: string,
    mastered = true,
    at?: readonly [number, number],
  ) =>
    fighter(run, {
      inventory: [`test:item/${slug}`],
      mastery: mastered ? [`test:item/${slug}`] : [],
      ...(at ? { at } : {}),
    });
  const swing = (slug: string, target = "foe") =>
    act(PLAYER_ACTOR, `weapon:test:item/${slug}|${target}`);

  it("does nothing for a weapon the character hasn't mastered", async () => {
    const run = await base();
    const state = fight([armed(run, "sapper", false), monster("foe")]);
    const hit = settle(run, state, [swing("sapper")], HIGH);
    expect(sources(who(hit.state, "foe"))).toEqual([]);
  });

  it("Sap: the target's next attack has Disadvantage", async () => {
    const run = await base();
    const state = fight([armed(run, "sapper"), monster("foe")]);
    const hit = settle(run, state, [swing("sapper")], HIGH).state;
    expect(sources(who(hit, "foe"))).toEqual(["mastery:sap"]);
    const back = settle(
      run,
      hit,
      [attackRoll("foe", "monster:0", PLAYER_ACTOR)],
      d20s(19, 3),
    );
    expect(rolls(back.events)[0]?.natural).toBe(3);
    expect(sources(who(back.state, "foe"))).toEqual([]);
  });

  it("Slow: a damaging hit takes 10 feet off the target's Speed", async () => {
    const run = await base();
    const state = fight([
      armed(run, "slower", true, [0, 0]),
      monster("foe", [1, 0]),
    ]);
    const foe = who(settle(run, state, [swing("slower")], HIGH).state, "foe");
    expect(speedLeft(foe, deriveStats(foe, run))).toBe(20);
  });

  it("Vex: a damaging hit gives your next attack Advantage", async () => {
    const run = await base();
    const state = fight([armed(run, "vexer"), monster("foe")]);
    const hit = settle(run, state, [swing("vexer")], HIGH).state;
    expect(sources(who(hit, PLAYER_ACTOR))).toEqual(["mastery:vex"]);
    const next = settle(
      run,
      hit,
      [attackRoll(PLAYER_ACTOR, "weapon:test:item/vexer", "foe")],
      d20s(2, 17),
    );
    expect(rolls(next.events)[0]?.natural).toBe(17);
  });

  it("Topple: a failed Constitution save knocks the target Prone", async () => {
    const run = await base();
    const state = fight([armed(run, "toppler"), monster("foe")]);
    const saved = settle(run, state, [swing("toppler")], d20s(20, 13)).state;
    expect(hasCondition(who(saved, "foe"), "prone")).toBe(false);
    const fell = settle(run, state, [swing("toppler")], d20s(20, 12));
    expect(hasCondition(who(fell.state, "foe"), "prone")).toBe(true);
    expect(payloadOf(fell.events, "saveReported")).toMatchObject({
      ability: "con",
      dc: 13,
      success: false,
    });
  });

  it("Push: a hit pushes the target 10 feet straight away", async () => {
    const run = await base();
    const state = fight([
      armed(run, "pusher", true, [5, 5]),
      monster("foe", [6, 6]),
    ]);
    const hit = settle(run, state, [swing("pusher")], HIGH).state;
    expect(who(hit, "foe").position).toEqual({ x: 8, y: 8 });
  });

  it("Cleave: a hit also swings at a second foe beside the first, once a turn, without the modifier", async () => {
    const run = await base();
    const state = fight([
      armed(run, "cleaver", true, [5, 5]),
      monster("foe", [6, 5]),
      monster("other", [6, 6]),
      monster("far", [9, 9]),
    ]);
    const hit = settle(run, state, [swing("cleaver")], HIGH);
    // A critical 2d12 plus 3, then 2d12 alone.
    expect(damageTo(hit.events, "foe")).toEqual([27]);
    expect(damageTo(hit.events, "other")).toEqual([24]);
    expect(damageTo(hit.events, "far")).toEqual([]);
    const again = settle(run, hit.state, [swing("cleaver")], HIGH);
    expect(damageTo(again.events, "other")).toEqual([]);
  });

  it("Graze: a miss still deals the ability modifier", async () => {
    const run = await base();
    const state = fight([armed(run, "grazer"), monster("foe")]);
    const missed = settle(run, state, [swing("grazer")], LOW);
    expect(rolls(missed.events)[0]?.natural).toBe(1);
    expect(damageTo(missed.events, "foe")).toEqual([3]);
  });

  it("shows on the board as cues and in the log", async () => {
    const run = await base();
    const state = fight([armed(run, "vexer"), monster("foe")]);
    const hit = settle(run, state, [act(PLAYER_ACTOR, "tactic:dodge")], LOW);
    const cues = hit.events.map((event) =>
      dndCue(event, state, hit.state, run),
    );
    expect(cues).toContainEqual({
      kind: "status",
      actor: PLAYER_ACTOR,
      text: "dodging",
    });
  });
});

describe("tactics", () => {
  it("Dashes toward foes it can't reach, then keeps walking", async () => {
    const run = await base();
    const start = fight([
      monster("foe", [0, 0]),
      fighter(run, { at: [15, 15] }),
    ]);
    const walked = settle(run, start, [moveTo("foe", 6, 6)], LOW).state;
    const decision = run.system.nextDecision(walked, run);
    if (!decision) throw new Error("No decision");
    expect(tacticalPolicy(decision, contextOf(run, walked, LOW))).toBe(
      "tactic:dash",
    );
    const dashed = settle(run, walked, [act("foe", "tactic:dash")], LOW).state;
    const next = run.system.nextDecision(dashed, run);
    if (!next) throw new Error("No decision");
    expect(tacticalPolicy(next, contextOf(run, dashed, LOW))).toBe("move");
  });

  it("takes the off-hand attack after the Attack action", async () => {
    const run = await base();
    const state = fight([
      fighter(run, {
        inventory: ["srd52:item/shortsword", "srd52:item/dagger"],
      }),
      monster("foe"),
    ]);
    const first = settle(
      run,
      state,
      [act(PLAYER_ACTOR, "weapon:srd52:item/shortsword|foe")],
      LOW,
    ).state;
    const decision = run.system.nextDecision(first, run);
    if (!decision) throw new Error("No decision");
    expect(tacticalPolicy(decision, contextOf(run, first, LOW))).toBe(
      "tactic:offhand|foe|weapon:srd52:item/dagger",
    );
  });
});

describe("monster grapples and multiattacks", () => {
  it("takes the action a Multiattack also uses after its attacks", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [5, 5] }),
      monster("coiler", [6, 5], "test:monster/coiler"),
    ]);
    const { state: after, events } = settle(
      run,
      state,
      [act("coiler", "monster:1|player")],
      LOW,
    );
    expect(rolls(events)[0]?.against).toBe(PLAYER_ACTOR);
    expect(payloadOf(events, "saveRolled")).toMatchObject({ dc: 14 });
    const hero = who(after, PLAYER_ACTOR);
    expect(hasCondition(hero, "grappled", "restrained")).toBe(true);
    // Squeezing on its own doesn't bite as well.
    const alone = settle(run, state, [act("coiler", "monster:0|player")], LOW);
    expect(rolls(alone.events)).toEqual([]);
  });

  it("escapes a monster's grapple with an action against its printed DC, ending what came with it", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [5, 5] }),
      monster("coiler", [6, 5], "test:monster/coiler"),
    ]);
    const squeezed = settle(
      run,
      state,
      [act("coiler", "monster:0|player")],
      LOW,
    ).state;
    // Back to the hero's turn.
    const held: DndState = {
      ...squeezed,
      combat: squeezed.combat && { ...squeezed.combat, index: 0 },
    };
    expect(sources(who(held, PLAYER_ACTOR))).toEqual([
      "monster:0",
      "monster:0",
      "monster:0",
    ]);
    const escape = "tactic:escape|coiler|monster:0";
    const decision = run.system.nextDecision(held, {
      content: run.content,
      contentIds: run.contentIds,
    });
    expect(
      decision?.options.find((option) => option.id === escape)?.label,
    ).toBe("Escape coiler's grapple (Athletics or Acrobatics, DC 15)");
    const stuck = settle(run, held, [act(PLAYER_ACTOR, escape)], LOW);
    expect(hasCondition(who(stuck.state, PLAYER_ACTOR), "grappled")).toBe(true);
    const free = settle(run, held, [act(PLAYER_ACTOR, escape)], HIGH);
    expect(sources(who(free.state, PLAYER_ACTOR))).toEqual([]);
    expect(rolls(free.events)[0]).toMatchObject({ target: 15 });
    // Restrained and squeezed each turn, the AI spends its action getting out.
    if (!decision) throw new Error("No turn decision");
    expect(tacticalPolicy(decision, contextOf(run, held, LOW))).toBe(escape);
  });

  it("ends a grapple when the grappler is Incapacitated or ends up out of its reach", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [5, 5] }),
      monster("coiler", [6, 5], "test:monster/coiler"),
    ]);
    const held = settle(
      run,
      state,
      [act("coiler", "monster:0|player")],
      LOW,
    ).state;
    const check = { kind: `${NS}:checkCombatEnd`, payload: {} };
    const after = (event: SystemEvent) =>
      who(
        settle(run, applyDndEvent(held, event), [check], LOW).state,
        PLAYER_ACTOR,
      );
    const stunned = dndEvent(`${NS}:effectAdded`, {
      actor: "coiler",
      effect: {
        sourceId: "test",
        casterId: "player",
        modifier: { kind: "condition", condition: "stunned" },
        ends: "spellDuration",
      },
    });
    expect(sources(after(stunned))).toEqual([]);
    const moved = (x: number) =>
      dndEvent(`${NS}:moved`, { actor: "coiler", to: { x, y: 5 }, feet: 0 });
    // Squeeze reaches 10 feet.
    expect(hasCondition(after(moved(7)), "grappled", "restrained")).toBe(true);
    expect(sources(after(moved(8)))).toEqual([]);
  });

  it("keeps two coilers' grapples apart, so one letting go leaves the other's", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [5, 5] }),
      monster("coiler", [6, 5], "test:monster/coiler"),
      monster("coiler2", [4, 5], "test:monster/coiler"),
    ]);
    const first = settle(
      run,
      state,
      [act("coiler", "monster:0|player")],
      LOW,
    ).state;
    const both = settle(
      run,
      { ...first, combat: first.combat && { ...first.combat, index: 2 } },
      [act("coiler2", "monster:0|player")],
      LOW,
    ).state;
    const held: DndState = {
      ...both,
      combat: both.combat && { ...both.combat, index: 0 },
    };
    const decision = run.system.nextDecision(held, {
      content: run.content,
      contentIds: run.contentIds,
    });
    const escapes = (decision?.options ?? [])
      .map((option) => option.id)
      .filter((id) => id.startsWith("tactic:escape"));
    expect(escapes).toEqual([
      "tactic:escape|coiler|monster:0",
      "tactic:escape|coiler2|monster:0",
    ]);
    // Escaping one keeps the other's grapple, Restrained and squeeze.
    const free = settle(
      run,
      held,
      [act(PLAYER_ACTOR, "tactic:escape|coiler|monster:0")],
      HIGH,
    ).state;
    const hero = who(free, PLAYER_ACTOR);
    expect(hasCondition(hero, "grappled", "restrained")).toBe(true);
    expect(new Set(hero.activeEffects.map((e) => e.casterId))).toEqual(
      new Set(["coiler2"]),
    );
    // The other one dropping releases its grapple too.
    const check = { kind: `${NS}:checkCombatEnd`, payload: {} };
    const gone = settle(
      run,
      applyDndEvent(
        free,
        dndEvent(`${NS}:damaged`, {
          actor: "coiler2",
          amount: 999,
          type: "fire",
          critical: false,
          massive: false,
        }),
      ),
      [check],
      LOW,
    ).state;
    expect(sources(who(gone, PLAYER_ACTOR))).toEqual([]);
  });

  it("lets a swallowed creature hit only its swallower, and out on enough damage or the swallower dropping", async () => {
    const run = await base();
    const start = fight([
      fighter(run, { at: [5, 5] }),
      monster("gulper", [6, 5], "test:monster/gulper"),
      monster("near", [4, 5]),
    ]);
    const grappled = applyDndEvent(
      start,
      dndEvent(`${NS}:effectAdded`, {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: "monster:1",
          casterId: "gulper",
          modifier: { kind: "condition", condition: "grappled" },
          ends: "spellDuration",
        },
      }),
    );
    const gulped = settle(
      run,
      {
        ...grappled,
        combat: grappled.combat && { ...grappled.combat, index: 1 },
      },
      [act("gulper", "monster:0|player")],
      LOW,
    ).state;
    const inside = who(gulped, PLAYER_ACTOR);
    expect(hasCondition(inside, "grappled")).toBe(false);
    expect(inside.activeEffects.every((e) => e.swallowed)).toBe(true);
    // It carries the hero off, and the foe beside the hero is outside.
    const moved = applyDndEvent(
      { ...gulped, combat: gulped.combat && { ...gulped.combat, index: 0 } },
      dndEvent(`${NS}:moved`, {
        actor: "gulper",
        to: { x: 12, y: 5 },
        feet: 0,
      }),
    );
    // Three-quarters cover between the hero's old square and the gulper counts for nothing from inside.
    const walled: DndState = {
      ...moved,
      combat: moved.combat && {
        ...moved.combat,
        terrain: {
          difficult: [],
          half: [],
          threeQuarters: ["8,5"],
          dim: [],
          dark: [],
          light: "bright",
        },
      },
    };
    const swallowed = who(walled, PLAYER_ACTOR);
    const gulper = who(walled, "gulper");
    expect(coverFor(walled, swallowed.position, gulper, [PLAYER_ACTOR])).toBe(
      5,
    );
    expect(coverAgainst(walled, swallowed, gulper)).toBe(0);
    const options = optionIds(run, moved);
    expect(options).toContain(`${LONGSWORD}|gulper`);
    expect(options).not.toContain(`${LONGSWORD}|near`);
    // A critical hit from inside does 10 or more, and the gulper fails its save at the end of the turn.
    const hit = settle(
      run,
      moved,
      [act(PLAYER_ACTOR, `${LONGSWORD}|gulper`)],
      HIGH,
    );
    expect(who(hit.state, "gulper").insideDamage).toBeGreaterThanOrEqual(10);
    const out = settle(
      run,
      hit.state,
      [{ kind: `${NS}:endTurn`, payload: {} }],
      LOW,
    ).state;
    const hero = who(out, PLAYER_ACTOR);
    expect(hasCondition(hero, "blinded", "restrained")).toBe(false);
    expect(hasCondition(hero, "prone")).toBe(true);
    expect(
      Math.max(
        Math.abs((hero.position?.x ?? 0) - 12),
        Math.abs((hero.position?.y ?? 0) - 5),
      ),
    ).toBe(1);
    expect(who(out, "gulper").insideDamage).toBe(0);
    // A swallower that drops lets the creature out too.
    const dead = applyDndEvent(
      gulped,
      dndEvent(`${NS}:damaged`, {
        actor: "gulper",
        amount: 999,
        type: "fire",
        critical: false,
        massive: false,
      }),
    );
    const freed = settle(
      run,
      dead,
      [{ kind: `${NS}:checkCombatEnd`, payload: {} }],
      LOW,
    ).state;
    expect(
      hasCondition(who(freed, PLAYER_ACTOR), "blinded", "restrained"),
    ).toBe(false);
    expect(hasCondition(who(freed, PLAYER_ACTOR), "prone")).toBe(true);
    // Climbing out of the corpse takes 10 feet of the hero's next turn, and of that turn only.
    const stats = deriveStats(who(freed, PLAYER_ACTOR), run);
    const heroTurn = (from: DndState): DndState => {
      let state = from;
      do {
        state = settle(
          run,
          state,
          [{ kind: `${NS}:endTurn`, payload: {} }],
          LOW,
        ).state;
      } while (state.combat?.order[state.combat.index] !== PLAYER_ACTOR);
      return state;
    };
    const next = heroTurn(freed);
    expect(speedLeft(who(next, PLAYER_ACTOR), stats)).toBe(stats.speed - 10);
    expect(speedLeft(who(heroTurn(next), PLAYER_ACTOR), stats)).toBe(
      stats.speed,
    );
    // Killing it from inside on its own turn spends the 10 feet then.
    const own = settle(
      run,
      { ...dead, combat: dead.combat && { ...dead.combat, index: 0 } },
      [{ kind: `${NS}:checkCombatEnd`, payload: {} }],
      LOW,
    ).state;
    expect(who(own, PLAYER_ACTOR).moved).toBe(10);
  });

  it("rolls the save a hit brings, keeping its effects apart from the hit's grapple", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [5, 5] }),
      monster("clawer", [6, 5], "test:monster/clawer"),
    ]);
    const { state: after } = settle(
      run,
      { ...state, combat: state.combat && { ...state.combat, index: 1 } },
      [act("clawer", "monster:0|player")],
      d20s(19, 1),
    );
    const hero = who(after, PLAYER_ACTOR);
    expect(hasCondition(hero, "grappled", "paralyzed")).toBe(true);
    expect(sources(hero).sort()).toEqual(["monster:0", "monster:0:save"]);
    // Saving at the end of its turn ends the paralysis and leaves the grapple.
    const saved = settle(
      run,
      { ...after, combat: after.combat && { ...after.combat, index: 0 } },
      [{ kind: `${NS}:endTurn`, payload: {} }],
      HIGH,
    ).state;
    expect(sources(who(saved, PLAYER_ACTOR))).toEqual(["monster:0"]);
  });

  it("has a monster weigh a hit's save and a swallow against plain damage", async () => {
    const run = await base();
    const turnOf = (state: DndState, index: number): string => {
      const turn = {
        ...state,
        combat: state.combat && { ...state.combat, index },
      };
      const decision = run.system.nextDecision(turn, run);
      if (!decision) throw new Error("No decision");
      return tacticalPolicy(decision, contextOf(run, turn, LOW));
    };
    // The Claw's paralysis is worth more than the Club's extra damage, unless the target never makes the save.
    const clawed = fight([
      fighter(run, { at: [5, 5] }),
      monster("pinner", [6, 5], PINNER.id),
    ]);
    expect(turnOf(clawed, 1)).toBe("monster:1|player");
    const human = fight([
      fighter(run, { at: [5, 5] }),
      monster("pinner", [6, 5], HUMAN_PINNER.id),
    ]);
    expect(turnOf(human, 1)).toBe("monster:0|player");
    // A toad swallows the creature it's grappling instead of clubbing it.
    const start = fight([
      fighter(run, { at: [5, 5] }),
      monster("toad", [6, 5], TOAD.id),
    ]);
    expect(turnOf(start, 1)).toBe("monster:0|player");
    const held = applyDndEvent(
      start,
      dndEvent(`${NS}:effectAdded`, {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: "monster:0",
          casterId: "toad",
          modifier: { kind: "condition", condition: "grappled" },
          ends: "spellDuration",
        },
      }),
    );
    expect(turnOf(held, 1)).toBe("monster:1|player");
    // A frog can't swallow the Medium hero it holds.
    const frog = {
      ...held,
      actors: {
        ...held.actors,
        toad: {
          ...who(held, "toad"),
          source: { kind: "monster" as const, statBlockId: FROG.id },
        },
      },
    };
    expect(
      optionIds(run, {
        ...frog,
        combat: frog.combat && { ...frog.combat, index: 1 },
      }),
    ).not.toContain("monster:1|player");
  });

  it("dashes with Cunning Action when walking won't reach, and hides with it only behind cover", async () => {
    const run = await base();
    const choose = (state: DndState): string => {
      const decision = run.system.nextDecision(state, run);
      if (!decision) throw new Error("No decision");
      return tacticalPolicy(decision, contextOf(run, state, LOW));
    };
    const sneakTurn = (at: readonly [number, number]): DndState => {
      const state = fight([
        fighter(run, { at: [5, 5] }),
        monster("sneak", at, SNEAK.id),
      ]);
      return {
        ...state,
        combat: state.combat && { ...state.combat, index: 1 },
      };
    };
    const far = sneakTurn([15, 5]);
    expect(choose(far)).toBe("tactic:bonus-dash");
    const dashed = settle(
      run,
      far,
      [act("sneak", "tactic:bonus-dash")],
      LOW,
    ).state;
    const sneak = who(dashed, "sneak");
    expect(sneak.budget).toMatchObject({ action: true, bonusAction: false });
    expect(speedLeft(sneak, deriveStats(sneak, run))).toBe(60);
    expect(choose(dashed)).toBe("move");
    // Close enough to walk up and club: no Dash.
    expect(choose(sneakTurn([9, 5]))).toBe("move");
    // With its Action spent, it hides only where the hero sees it through Three-Quarters Cover.
    const spent = (state: DndState): DndState =>
      applyDndEvent(
        state,
        dndEvent(`${NS}:budgetSpent`, { actor: "sneak", kind: "action" }),
      );
    const open = spent(sneakTurn([12, 5]));
    expect(optionIds(run, open)).toContain("tactic:bonus-hide");
    expect(choose(open)).not.toBe("tactic:bonus-hide");
    const covered: DndState = {
      ...open,
      combat: open.combat && {
        ...open.combat,
        terrain: {
          difficult: [],
          half: [],
          threeQuarters: ["8,5"],
          dim: [],
          dark: [],
          light: "bright",
        },
      },
    };
    expect(choose(covered)).toBe("tactic:bonus-hide");
    const hidden = settle(
      run,
      covered,
      [act("sneak", "tactic:bonus-hide")],
      HIGH,
    ).state;
    expect(hasCondition(who(hidden, "sneak"), "invisible")).toBe(true);
    expect(who(hidden, "sneak").budget.bonusAction).toBe(false);
  });

  it("teleports or leaps into reach when walking won't get there", async () => {
    const run = await base();
    const turnAt = (statBlockId: string, x: number): DndState => {
      const state = fight([
        fighter(run, { at: [5, 5] }),
        monster("mover", [x, 5], statBlockId),
      ]);
      return {
        ...state,
        combat: state.combat && { ...state.combat, index: 1 },
      };
    };
    const choose = (state: DndState) => {
      const decision = run.system.nextDecision(state, run);
      if (!decision) throw new Error("No decision");
      return {
        decision,
        answer: tacticalPolicy(decision, contextOf(run, state, LOW)),
      };
    };
    // A walk of 30 feet doesn't reach from 45 feet away; a 40-foot teleport does, and costs no movement.
    const far = turnAt(BLINKER.id, 14);
    expect(choose(far).answer).toBe("monster:1|mover");
    const asked = settle(run, far, [act("mover", "monster:1|mover")], LOW);
    const blinked = who(asked.state, "mover");
    expect(distanceFeet(blinked.position, { x: 5, y: 5 })).toBe(5);
    expect(blinked.moved).toBe(0);
    expect(blinked.budget.bonusAction).toBe(false);
    expect(choose(asked.state).answer).toBe("monster:0|player");
    // Close enough to walk: no teleport.
    expect(choose(turnAt(BLINKER.id, 10)).answer).toBe("move");
    // A Leap pays 10 feet of movement for its 30.
    const leapt = settle(
      run,
      turnAt(LEAPER.id, 12),
      [act("mover", "monster:1|mover")],
      LOW,
    ).state;
    expect(who(leapt, "mover").moved).toBe(10);
    expect(distanceFeet(who(leapt, "mover").position, { x: 5, y: 5 })).toBe(5);
    // Leaping out of a foe's reach provokes; teleporting doesn't.
    const away = (movement: number) =>
      settle(
        run,
        turnAt(LEAPER.id, 6),
        [
          {
            kind: `${NS}:teleport`,
            payload: { actor: "mover", feet: 30, movement, answer: "12,5" },
          },
        ],
        LOW,
      );
    expect(rolls(away(10).events)[0]).toMatchObject({ actor: PLAYER_ACTOR });
    expect(rolls(away(0).events)).toEqual([]);
    expect(who(away(0).state, "mover").position).toEqual({ x: 12, y: 5 });
  });

  it("gives Disadvantage only on rolls with the ability an effect names", async () => {
    const run = await base();
    const weakened = applyDndEvent(
      fight([fighter(run, { at: [5, 5] })]),
      dndEvent(`${NS}:effectAdded`, {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: "test",
          casterId: "foe",
          modifier: { kind: "disadvantage", on: "saves", ability: "str" },
          ends: "spellDuration",
        },
      }),
    );
    const hero = who(weakened, PLAYER_ACTOR);
    const context = contextOf(run, weakened, d20s(15, 2, 15, 2));
    expect(rollSave(hero, "str", 10, context).saved).toBe(false);
    expect(rollSave(hero, "dex", 10, context).saved).toBe(true);
  });

  it("turns a condition into its second failure when the repeat save fails", async () => {
    const run = await base();
    const start = applyDndEvent(
      fight([fighter(run, { at: [5, 5] }), monster("gazer", [9, 5])]),
      dndEvent(`${NS}:effectAdded`, {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: "monster:0",
          casterId: "gazer",
          modifier: { kind: "condition", condition: "restrained" },
          ends: "spellDuration",
          repeatSave: { ability: "con", dc: 12 },
          secondFailure: { condition: "petrified", ends: "spellDuration" },
        },
      }),
    );
    const end = [{ kind: `${NS}:endTurn`, payload: {} }];
    const failed = who(settle(run, start, end, LOW).state, PLAYER_ACTOR);
    expect(hasCondition(failed, "restrained")).toBe(false);
    expect(hasCondition(failed, "petrified")).toBe(true);
    expect(failed.activeEffects[0]?.repeatSave).toBeUndefined();
    expect(
      sources(who(settle(run, start, end, HIGH).state, PLAYER_ACTOR)),
    ).toEqual([]);
  });

  it("takes a damage penalty off weapon hits until a repeated save ends it", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [5, 5] }),
      monster("weakener", [6, 5], "test:monster/weakener"),
    ]);
    const sapped = settle(
      run,
      { ...state, combat: state.combat && { ...state.combat, index: 1 } },
      [act("weakener", "monster:0|player")],
      LOW,
    ).state;
    const hero = who(sapped, PLAYER_ACTOR);
    expect(hero.activeEffects.map((e) => e.repeatSave)).toEqual([
      { ability: "str", dc: 12 },
      { ability: "str", dc: 12 },
    ]);
    const onHero = (from: DndState) => ({
      ...from,
      combat: from.combat && { ...from.combat, index: 0 },
    });
    const hit = (from: DndState) =>
      damageTo(
        settle(
          run,
          onHero(from),
          [act(PLAYER_ACTOR, `${LONGSWORD}|weakener`)],
          HIGH,
        ).events,
        "weakener",
      )[0] ?? 0;
    expect(hit(state) - hit(sapped)).toBe(4);
    // One successful save at the end of the turn ends both.
    const saved = settle(
      run,
      onHero(sapped),
      [{ kind: `${NS}:endTurn`, payload: {} }],
      HIGH,
    ).state;
    expect(sources(who(saved, PLAYER_ACTOR))).toEqual([]);
  });

  it("aims an area a Multiattack uses where it catches the most foes", async () => {
    const run = await base();
    const state = fight([
      fighter(run, { at: [7, 5] }),
      fighter(run, { id: "ally", at: [8, 6] }),
      fighter(run, { id: "behind", at: [11, 5] }),
      monster("spitter", [9, 5], "test:monster/spitter"),
    ]);
    const { events } = settle(
      run,
      state,
      [act("spitter", "monster:0|ally")],
      LOW,
    );
    const saved = events.flatMap((event) =>
      event.kind === `${NS}:saveRolled` && "payload" in event
        ? [event.payload.actor]
        : [],
    );
    expect(saved.sort()).toEqual(["ally", PLAYER_ACTOR]);
  });

  it("picks the attack that brings the other action over that action alone", async () => {
    const run = await base();
    const state = fight([
      monster("coiler", [6, 5], "test:monster/coiler"),
      fighter(run, { at: [5, 5] }),
    ]);
    const decision = run.system.nextDecision(state, {
      content: run.content,
      contentIds: run.contentIds,
    });
    if (!decision) throw new Error("No turn decision");
    expect(decision.options.map((option) => option.id)).toContain(
      "monster:0|player",
    );
    expect(tacticalPolicy(decision, contextOf(run, state, LOW))).toBe(
      "monster:1|player",
    );
  });

  it("gives an Opportunity Attack for walking past a foe, not only for where a move starts and ends", async () => {
    const run = await base();
    // Both ends are 10 feet from the foe, and every way round it passes through its reach.
    const state = fight([fighter(run, { at: [3, 5] }), monster("foe", [5, 5])]);
    const hero = who(state, PLAYER_ACTOR);
    expect(provokers(hero, { x: 7, y: 5 }, state, run)).toHaveLength(1);
    const walked = settle(run, state, [moveTo(PLAYER_ACTOR, 7, 5)], LOW);
    expect(rolls(walked.events)[0]).toMatchObject({ actor: "foe" });
    // Stepping round it while staying in reach provokes nothing.
    const beside = fight([
      fighter(run, { at: [4, 5] }),
      monster("foe", [5, 5]),
    ]);
    expect(
      provokers(who(beside, PLAYER_ACTOR), { x: 4, y: 6 }, beside, run),
    ).toHaveLength(0);
  });
});
