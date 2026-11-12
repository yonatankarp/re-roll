import {
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { type Dice, createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import { replayInputs } from "../engine/run/save.ts";
import type { Input } from "../engine/kernel/events.ts";
import { AWAIT_FRAME } from "../engine/kernel/system.ts";
import { type RunContext, startRun, step } from "../engine/run/turn.ts";
import {
  type Context,
  MOVE,
  choosePolicy,
  damageEvents,
  effectEnds,
  nextDndDecision,
  runAttackRoll,
  runTakeAction,
  runLingeringTick,
  startCombat,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  PASS,
  encodeOption,
  parseOption,
} from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import {
  codeKeys,
  coverBetween,
  distanceFeet,
  placeSides,
  reachableSquares,
} from "../plugins/systems/dnd5.5e/core/grid.ts";
import {
  coverFor,
  darkvisionOf,
  seeing,
  terrainOf,
} from "../plugins/systems/dnd5.5e/core/sight.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";
import {
  BattlemapSchema,
  ClassSchema,
  MonsterSchema,
  PregenSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  StateSchema,
  applyDndEvent,
  dndEvent,
  freshActor,
  hasCondition,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  damageResponses,
  deriveStats,
  saveBonus,
  scaleActivation,
} from "../plugins/systems/dnd5.5e/core/stats.ts";

// Dice that always land the same way, so a result can be stated exactly.
const HIGH: Dice = { below: () => 0, roll: (sides) => sides };
const LOW: Dice = { below: () => 0, roll: () => 1 };

function countingD20s(dice: Dice): { dice: Dice; d20s: () => number } {
  let count = 0;
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

const spell = (slug: string): string => `srd52:spell/${slug}`;

function arenaRun(
  base: RunContext,
  extra: Record<string, unknown>,
): RunContext {
  const slots = [4, 3, 3, 3, 3, 2, 2, 1, 1];
  const wizard = ClassSchema.parse(base.content("srd52:class/wizard"));
  const [first] = wizard.levels;
  if (!first) throw new Error("The wizard has no levels");
  const content: Record<string, unknown> = {
    "srd52:class/wizard": {
      ...wizard,
      levels: Array.from({ length: 20 }, (_, index) => ({
        ...(index === 0 ? first : { grants: [], choices: [], scaling: {} }),
        level: index + 1,
        slots,
        scaling: { sneakAttackD6: 3, martialArtsDie: 8, rageDamage: 2 },
      })),
    },
    "srd52:monster/dummy": dummy("srd52:monster/dummy", {}),
    ...extra,
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

function dummy(
  id: string,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
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

function hero(
  run: RunContext,
  options: {
    readonly id?: string;
    readonly spells?: readonly string[];
    readonly features?: readonly string[];
    readonly level?: number;
    readonly inventory?: readonly string[];
    readonly hp?: number;
  } = {},
): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  const answers = [
    { kind: "spells" as const, values: (options.spells ?? []).map(spell) },
    { kind: "features" as const, values: [...(options.features ?? [])] },
  ];
  return freshActor({
    id: options.id ?? PLAYER_ACTOR,
    name: "Hero",
    side: "party",
    source: {
      kind: "character",
      build: {
        ...pregen.build,
        levels: Array.from({ length: options.level ?? 1 }, () => ({
          ...first,
          answers,
        })),
      },
    },
    hp: options.hp ?? 100,
    inventory: [...(options.inventory ?? ["srd52:item/longsword"])],
  });
}

function monster(
  id: string,
  statBlockId = "srd52:monster/dummy",
  hp = 500,
): Actor {
  return freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId },
    hp,
    inventory: [],
  });
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
    },
  };
}

function contextOf(run: RunContext, state: DndState, dice: Dice): Context {
  return { state, dice, content: run.content, contentIds: run.contentIds };
}

interface Settled {
  readonly state: DndState;
  readonly events: readonly SystemEvent[];
  readonly decisions: readonly Decision[];
}

// A small copy of the kernel's loop, so a whole cast can be followed with chosen dice.
function settle(
  run: RunContext,
  start: DndState,
  frames: readonly Frame[],
  dice: Dice,
  answer: (decision: Decision, state: DndState) => string = (decision) =>
    decision.options[0]?.id ?? "",
): Settled {
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
          answer: answer(decision, state),
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

const act = (actor: string, answer: string): Frame => ({
  kind: `${NS}:takeAction`,
  payload: { actor, answer },
});
const endTurn: Frame = { kind: `${NS}:endTurn`, payload: {} };

function damageOf(events: readonly SystemEvent[], actor?: string): number[] {
  return events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    (actor === undefined || event.payload.actor === actor)
      ? [Number(event.payload.amount)]
      : [],
  );
}

function kinds(events: readonly SystemEvent[]): readonly string[] {
  return events.map((event) => event.kind);
}

function actor(state: DndState, id: string): Actor {
  const found = state.actors[id];
  if (!found) throw new Error(`No actor ${id}`);
  return found;
}

const base = async (): Promise<RunContext> =>
  (await loadAdventure("goblin-ambush")).run;

describe("lingering damage", () => {
  it("ignores a queued tick when the fight has already removed its target", () => {
    const result = runLingeringTick(
      { actor: "gone", sourceId: "spell:test", when: "turnStart" },
      {
        state: { actors: {}, combat: null },
        dice: createDice(rngFromSeed("tick")),
        content: () => undefined,
        contentIds: () => [],
      },
    );
    expect(result).toEqual({});
  });

  it("hits everyone in Moonbeam when it appears and at the end of each of their turns", async () => {
    const run = arenaRun(await base(), {});
    const start = fight(
      hero(run, { spells: ["moonbeam"] }),
      monster("a"),
      monster("b"),
    );
    // Every die rolls 1, so saves fail and the 2d10 is exactly 2.
    const cast = settle(
      run,
      start,
      [act(PLAYER_ACTOR, `spell:${spell("moonbeam")}|all`)],
      LOW,
    );
    expect(damageOf(cast.events, "a")).toEqual([2]);
    expect(damageOf(cast.events, "b")).toEqual([2]);
    expect(actor(cast.state, PLAYER_ACTOR).concentratingOn).toBe(
      `spell:${spell("moonbeam")}`,
    );

    const onA: DndState = {
      ...cast.state,
      combat: start.combat && { ...start.combat, index: 1 },
    };
    const tick = settle(run, onA, [endTurn], LOW);
    expect(damageOf(tick.events, "a")).toEqual([2]);
    expect(damageOf(tick.events, "b")).toEqual([]);
    expect(tick.state.combat?.index).toBe(2);

    // A save halves it: the same 2d10 at the highest roll is 20, so 10.
    const saved = settle(run, onA, [endTurn], HIGH);
    expect(damageOf(saved.events, "a")).toEqual([10]);
  });

  it("ends with the caster's Concentration, on everyone", async () => {
    const run = arenaRun(await base(), {});
    const cast = settle(
      run,
      fight(
        hero(run, { spells: ["spirit-guardians"] }),
        monster("a"),
        monster("b"),
      ),
      [act(PLAYER_ACTOR, `spell:${spell("spirit-guardians")}|all`)],
      LOW,
    );
    expect(damageOf(cast.events)).toEqual([]);
    expect(actor(cast.state, "b").activeEffects).toHaveLength(1);
    const ended = applyDndEvent(
      cast.state,
      dndEvent(`${NS}:concentrationEnded`, { actor: PLAYER_ACTOR }),
    );
    expect(actor(ended, "a").activeEffects).toEqual([]);
    expect(actor(ended, "b").activeEffects).toEqual([]);
  });

  it("doesn't let the same spell from two casters hit twice in a turn", async () => {
    const run = arenaRun(await base(), {});
    const effect = {
      sourceId: `spell:${spell("moonbeam")}`,
      casterId: PLAYER_ACTOR,
      ends: "concentration" as const,
      modifier: {
        kind: "lingeringDamage" as const,
        when: "turnEnd" as const,
        damage: [{ amount: { dice: "2d10" }, type: "radiant" as const }],
        once: false,
      },
    };
    const target = {
      ...monster("a"),
      activeEffects: [effect, { ...effect, casterId: "ally" }],
    };
    const state = fight(target, hero(run), hero(run, { id: "ally" }));
    const tick = settle(run, state, [endTurn], LOW);
    expect(damageOf(tick.events, "a")).toEqual([2]);
  });

  it("runs Searing Smite at the start of the target's turn, and a save ends it", async () => {
    const run = arenaRun(await base(), {});
    const cast = settle(
      run,
      fight(hero(run, { spells: ["searing-smite"] }), monster("a")),
      [
        {
          kind: `${NS}:smite`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: "weapon:srd52:item/longsword",
            target: "a",
            critical: false,
            answer: `spell:${spell("searing-smite")}|a`,
          },
        },
      ],
      LOW,
    );
    expect(damageOf(cast.events, "a")).toEqual([1]);

    const failed = settle(run, cast.state, [endTurn], LOW);
    expect(failed.state.combat?.index).toBe(1);
    expect(damageOf(failed.events, "a")).toEqual([1]);
    expect(actor(failed.state, "a").activeEffects).toHaveLength(1);

    const passed = settle(run, cast.state, [endTurn], HIGH);
    expect(damageOf(passed.events, "a")).toEqual([6]);
    expect(actor(passed.state, "a").activeEffects).toEqual([]);
  });

  it("skips the turn of a monster it kills at the start of that turn", async () => {
    const run = arenaRun(await base(), {});
    const burning = {
      ...monster("a", "srd52:monster/dummy", 1),
      activeEffects: [
        {
          sourceId: "spell:x",
          casterId: PLAYER_ACTOR,
          ends: "spellDuration" as const,
          modifier: {
            kind: "lingeringDamage" as const,
            when: "turnStart" as const,
            damage: [{ amount: { dice: "1d6" }, type: "fire" as const }],
            once: false,
          },
        },
      ],
    };
    const state = fight(hero(run), burning, monster("b"));
    const after = settle(run, state, [endTurn], LOW);
    expect(kinds(after.events)).toContain("actorDefeated");
    expect(after.state.combat?.index).toBe(2);
    expect(nextDndDecision(after.state, run)?.actor).toBe("b");
  });

  it("ends the fight when it kills the last enemy", async () => {
    const run = arenaRun(await base(), {});
    const burning = {
      ...monster("a", "srd52:monster/dummy", 1),
      activeEffects: [
        {
          sourceId: "spell:x",
          casterId: PLAYER_ACTOR,
          ends: "spellDuration" as const,
          modifier: {
            kind: "lingeringDamage" as const,
            when: "turnEnd" as const,
            damage: [{ amount: { dice: "1d6" }, type: "fire" as const }],
            once: false,
          },
        },
      ],
    };
    const after = settle(run, fight(burning, hero(run)), [endTurn], LOW);
    expect(after.state.combat).toBeNull();
  });

  it("fires Acid Arrow's later damage once", async () => {
    const run = arenaRun(await base(), {});
    const hit = settle(
      run,
      fight(hero(run, { spells: ["acid-arrow"] }), monster("a")),
      [
        {
          kind: `${NS}:applyHit`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: `spell:${spell("acid-arrow")}`,
            target: "a",
            critical: false,
            hadAdvantage: false,
            total: 30,
            natural: 15,
          },
        },
      ],
      LOW,
    );
    expect(damageOf(hit.events, "a")).toEqual([4]);
    const onA: DndState = {
      ...hit.state,
      combat: hit.state.combat && { ...hit.state.combat, index: 1 },
    };
    const tick = settle(run, onA, [endTurn], LOW);
    expect(damageOf(tick.events, "a")).toEqual([2]);
    expect(actor(tick.state, "a").activeEffects).toEqual([]);
  });
});

describe("several projectiles", () => {
  const missile = `spell:${spell("magic-missile")}`;

  it("offers each target and the lowest-HP choice", async () => {
    const run = arenaRun(await base(), {});
    const decision = nextDndDecision(
      fight(
        hero(run, { spells: ["magic-missile"] }),
        monster("a"),
        monster("b"),
      ),
      run,
    );
    const ids = decision?.options.map((option) => option.id) ?? [];
    expect(ids).toContain(`${missile}|a`);
    expect(ids).toContain(`${missile}|b`);
    expect(ids).toContain(`${missile}|all`);
  });

  it("lands every dart separately at 1d4 + 1", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(hero(run, { spells: ["magic-missile"] }), monster("a"));
    const cast = settle(run, state, [act(PLAYER_ACTOR, `${missile}|a`)], LOW);
    expect(damageOf(cast.events, "a")).toEqual([2, 2, 2]);
  });

  it("sends darts at the lowest HP, moving on when it falls", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(
      hero(run, { spells: ["magic-missile"] }),
      monster("big"),
      monster("small", "srd52:monster/dummy", 3),
    );
    const cast = settle(run, state, [act(PLAYER_ACTOR, `${missile}|all`)], LOW);
    expect(damageOf(cast.events, "small")).toEqual([2, 2]);
    expect(damageOf(cast.events, "big")).toEqual([2]);
    expect(
      kinds(cast.events).filter((kind) => kind === "actorDefeated"),
    ).toHaveLength(1);
  });

  it("adds a dart per slot level above 1, and spends that slot", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(hero(run, { spells: ["magic-missile"] }), monster("a"));
    const cast = settle(run, state, [act(PLAYER_ACTOR, `${missile}|a|3`)], LOW);
    expect(damageOf(cast.events, "a")).toHaveLength(5);
    expect(actor(cast.state, PLAYER_ACTOR).resourcesSpent).toEqual({
      "slot:3": 1,
    });
  });

  it("makes a separate attack for each Scorching Ray", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(hero(run, { spells: ["scorching-ray"] }), monster("a"));
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${spell("scorching-ray")}|a`)],
      HIGH,
    );
    expect(
      kinds(cast.events).filter((kind) => kind === `${NS}:rollReported`),
    ).toHaveLength(3);
    expect(damageOf(cast.events, "a")).toEqual([24, 24, 24]); // critical hits, 4d6 each
  });

  it("gives Eldritch Blast more beams with character level", async () => {
    const run = arenaRun(await base(), {});
    const beams = (level: number): number => {
      const state = fight(
        hero(run, { spells: ["eldritch-blast"], level }),
        monster("a"),
      );
      const cast = settle(
        run,
        state,
        [act(PLAYER_ACTOR, `spell:${spell("eldritch-blast")}|a`)],
        HIGH,
      );
      return damageOf(cast.events, "a").length;
    };
    expect([1, 4, 5, 10, 11, 16, 17].map(beams)).toEqual([1, 1, 2, 2, 3, 3, 4]);
  });
});

describe("choosing targets and aiming areas", () => {
  const at = (who: Actor, x: number, y: number): Actor => ({
    ...who,
    position: { x, y },
  });
  const onGrid = (...actors: readonly Actor[]): DndState => {
    const state = fight(...actors);
    if (!state.combat) throw new Error("No fight");
    return {
      ...state,
      combat: { ...state.combat, grid: { width: 12, height: 12 } },
    };
  };
  // Answers each follow-up in turn from a list, as a player clicking would.
  const answers =
    (...list: string[]) =>
    (decision: Decision): string => {
      const next = list.shift();
      if (next === undefined)
        throw new Error(`Nothing left for ${decision.id}`);
      if (!decision.options.some((option) => option.id === next)) {
        throw new Error(`${next} isn't offered at ${decision.id}`);
      }
      return next;
    };
  const blessedIn = (events: readonly SystemEvent[]): string[] => [
    ...new Set(
      events.flatMap((event) =>
        event.kind === `${NS}:effectAdded` && "payload" in event
          ? [String(event.payload.actor)]
          : [],
      ),
    ),
  ];
  const bless = `spell:${spell("bless")}`;
  const missile = `spell:${spell("magic-missile")}`;
  const hold = `spell:${spell("hold-person")}`;
  const fireball = `spell:${spell("fireball")}`;

  it("builds turn option ids that parseOption takes apart and encodeOption puts back", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(
      hero(run, { spells: ["bless", "magic-missile"] }),
      hero(run, { id: "b" }),
      monster("x"),
    );
    const ids =
      nextDndDecision(state, run)?.options.map((item) => item.id) ?? [];
    expect(ids).toContain(encodeOption(missile, "x"));
    expect(ids).toContain(encodeOption(missile, "x", 2));
    expect(ids).toContain(encodeOption(bless, "pick"));
    expect(ids).toContain(PASS);
    const known = new Set(
      deriveStats(actor(state, PLAYER_ACTOR), run).actions.map(
        (item) => item.id,
      ),
    );
    for (const id of ids) {
      const parts = parseOption(id);
      expect(encodeOption(...parts)).toBe(id);
      if (parts.length > 1) expect(known).toContain(parts[0]);
    }
  });

  it("lets Bless pick 2 of 3 allies, take one back, and cast", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(
      hero(run, { spells: ["bless"] }),
      hero(run, { id: "b" }),
      hero(run, { id: "c" }),
      monster("x"),
    );
    const ids = nextDndDecision(state, run)?.options.map((item) => item.id);
    expect(ids).toContain(`${bless}|pick`);
    expect(ids).not.toContain(`${bless}|all`);
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `${bless}|pick`)],
      LOW,
      answers("+b", "+c", "-c", `+${PLAYER_ACTOR}`, "cast"),
    );
    expect(blessedIn(cast.events).sort()).toEqual([PLAYER_ACTOR, "b"].sort());
    const last = cast.decisions.at(-1);
    expect(last?.options.find((item) => item.id === "cast")?.label).toBe(
      "Cast Bless (2 of 3)",
    );
    expect(actor(cast.state, PLAYER_ACTOR).resourcesSpent).toEqual({
      "slot:1": 1,
    });
  });

  it("spends nothing when the caster goes back", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(hero(run, { spells: ["bless"] }), monster("x"));
    const backed = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `${bless}|pick`)],
      LOW,
      answers(`+${PLAYER_ACTOR}`, "back"),
    );
    expect(backed.events).toEqual([]);
  });

  it("splits Magic Missile's darts, with repeats, and casts only once all are aimed", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(
      hero(run, { spells: ["magic-missile"] }),
      monster("a"),
      monster("b"),
    );
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `${missile}|pick`)],
      LOW,
      answers("+a", "+a", "+b", "cast"),
    );
    expect(
      cast.decisions
        .slice(0, 3)
        .some((item) => item.options.some((o) => o.id === "cast")),
    ).toBe(false);
    expect(damageOf(cast.events, "a")).toEqual([2, 2]);
    expect(damageOf(cast.events, "b")).toEqual([2]);
  });

  it("aims Eldritch Blast's beams at different foes once it has two", async () => {
    const run = arenaRun(await base(), {});
    const blast = `spell:${spell("eldritch-blast")}`;
    const state = fight(
      hero(run, { spells: ["eldritch-blast"], level: 5 }),
      monster("a"),
      monster("b"),
    );
    const ids = nextDndDecision(state, run)?.options.map((item) => item.id);
    expect(ids).toContain(`${blast}|pick`);
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `${blast}|pick`)],
      HIGH,
      answers("+a", "+b", "cast"),
    );
    expect(damageOf(cast.events, "a")).toHaveLength(1);
    expect(damageOf(cast.events, "b")).toHaveLength(1);
  });

  it("lets Hold Person cast at level 3 pick two creatures", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(
      hero(run, { spells: ["hold-person"], level: 3 }),
      monster("a"),
      monster("b"),
      monster("c"),
    );
    const ids = nextDndDecision(state, run)?.options.map((item) => item.id);
    expect(ids).toContain(`${hold}|a`);
    expect(ids).toContain(`${hold}|pick|3`);
    expect(ids).not.toContain(`${hold}|a|3`);
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `${hold}|pick|3`)],
      LOW,
      answers("+a", "+c", "cast"),
    );
    expect(hasCondition(actor(cast.state, "a"), "paralyzed")).toBe(true);
    expect(hasCondition(actor(cast.state, "b"), "paralyzed")).toBe(false);
    expect(hasCondition(actor(cast.state, "c"), "paralyzed")).toBe(true);
  });

  it("aims Fireball at an empty square, and burns an ally and the caster caught in it", async () => {
    const run = arenaRun(await base(), {});
    const state = onGrid(
      at(hero(run, { spells: ["fireball"] }), 0, 0),
      at(hero(run, { id: "ally" }), 4, 4),
      at(monster("a"), 8, 8),
      at(monster("b"), 11, 11),
    );
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `${fireball}|aim`)],
      LOW,
      answers("8,4"),
    );
    const [aim] = cast.decisions;
    expect(aim?.options.find((o) => o.id === "8,4")?.label).toBe(
      "I5: catches a, and also Hero",
    );
    expect(aim?.options.find((o) => o.id === "2,2")?.label).toBe(
      "C3: catches only your side: Hero and you",
    );
    // Best for the caster first: both foes and nobody of theirs.
    expect(aim?.options[0]?.label).toMatch(/: catches a and b$/);
    expect(damageOf(cast.events, "a")).toHaveLength(1);
    expect(damageOf(cast.events, "ally")).toHaveLength(1);
    expect(damageOf(cast.events, "b")).toEqual([]);
    expect(damageOf(cast.events, PLAYER_ACTOR)).toEqual([]);
  });

  it("aims Burning Hands in one of 8 directions", async () => {
    const run = arenaRun(await base(), {});
    const state = onGrid(
      at(hero(run, { spells: ["burning-hands"] }), 5, 5),
      at(monster("a"), 6, 5),
      at(monster("b"), 7, 5),
      at(monster("c"), 5, 7),
    );
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${spell("burning-hands")}|aim`)],
      LOW,
      answers("6,5"),
    );
    const labels = cast.decisions[0]?.options.map((o) => o.label) ?? [];
    expect(labels).toHaveLength(9);
    expect(labels).toContain("East: catches a and b");
    expect(labels).toContain("South: catches c");
    expect(damageOf(cast.events, "a")).toHaveLength(1);
    expect(damageOf(cast.events, "b")).toHaveLength(1);
    expect(damageOf(cast.events, "c")).toEqual([]);
  });

  it("has the AI aim clear of its allies, and skip an area that would mostly hurt its own side", async () => {
    const run = arenaRun(await base(), {});
    const policy = (state: DndState) => (decision: Decision) =>
      choosePolicy(decision, contextOf(run, state, LOW));
    const crowd = onGrid(
      at(hero(run, { spells: ["fireball"] }), 0, 0),
      at(hero(run, { id: "ally" }), 5, 5),
      at(monster("a"), 9, 9),
      at(monster("b"), 10, 10),
      at(monster("c"), 6, 6),
    );
    const aimed = settle(
      run,
      crowd,
      [act(PLAYER_ACTOR, `${fireball}|aim`)],
      LOW,
      policy(crowd),
    );
    expect(damageOf(aimed.events, "ally")).toEqual([]);
    expect(damageOf(aimed.events, "a")).toHaveLength(1);
    expect(damageOf(aimed.events, "b")).toHaveLength(1);

    // Every square that would catch this foe also catches an ally beside it.
    const close = onGrid(
      at(hero(run, { spells: ["fireball"] }), 0, 0),
      at(hero(run, { id: "left" }), 5, 6),
      at(monster("a"), 6, 6),
      at(hero(run, { id: "right" }), 7, 6),
    );
    const turn = nextDndDecision(close, run);
    if (!turn) throw new Error("No turn");
    expect(turn.options.map((o) => o.id)).toContain(`${fireball}|aim`);
    expect(choosePolicy(turn, contextOf(run, close, LOW))).not.toContain(
      fireball,
    );
  });

  it("has the AI bless its allies and pile darts on whoever they can drop", async () => {
    const run = arenaRun(await base(), {});
    const party = fight(
      hero(run, { spells: ["bless"] }),
      hero(run, { id: "b" }),
      monster("x"),
    );
    const blessed = settle(
      run,
      party,
      [act(PLAYER_ACTOR, `${bless}|pick`)],
      LOW,
      (decision) => choosePolicy(decision, contextOf(run, party, LOW)),
    );
    expect(blessedIn(blessed.events).sort()).toEqual(
      [PLAYER_ACTOR, "b"].sort(),
    );

    const foes = fight(
      hero(run, { spells: ["magic-missile"] }),
      monster("big"),
      monster("small", "srd52:monster/dummy", 3),
    );
    const darts = settle(
      run,
      foes,
      [act(PLAYER_ACTOR, `${missile}|pick`)],
      LOW,
      (decision) => choosePolicy(decision, contextOf(run, foes, LOW)),
    );
    expect(damageOf(darts.events, "small")).toEqual([2]);
    expect(damageOf(darts.events, "big")).toEqual([2, 2]);
  });

  it("replays a save with chosen targets and an aimed Fireball exactly", async () => {
    const plain = await base();
    const pregen = PregenSchema.parse(plain.content("srd52:pregen/wizard"));
    const [first] = pregen.build.levels;
    if (!first) throw new Error("The pregen has no levels");
    const run = arenaRun(plain, {
      "srd52:pregen/wizard": {
        ...pregen,
        build: {
          ...pregen.build,
          levels: [
            {
              ...first,
              answers: [
                ...first.answers,
                { kind: "spells", values: [spell("bless"), spell("fireball")] },
              ],
            },
          ],
        },
      },
    });
    const seed = "targets";
    let { state, pending } = startRun(run, seed);
    const inputs: Input[] = [{ kind: "start" }];
    const done = { bless: false, fireball: false, aimedAt: "" };
    for (let count = 0; pending && count < 400; count += 1) {
      const { id, options, actor: who } = pending;
      const has = (option: string) => options.some((o) => o.id === option);
      let chosen = options[0]?.id ?? "";
      if (has("srd52:pregen/wizard")) chosen = "srd52:pregen/wizard";
      else if (who === PLAYER_ACTOR && !done.bless && has(`${bless}|pick`)) {
        chosen = `${bless}|pick`;
      } else if (id.startsWith(`${NS}:targets:`)) {
        chosen = options.find((o) => o.id.startsWith("+"))?.id ?? "cast";
        if (chosen === "cast") done.bless = true;
      } else if (
        who === PLAYER_ACTOR &&
        !done.fireball &&
        has(`${fireball}|aim`)
      ) {
        chosen = `${fireball}|aim`;
      } else if (id.startsWith(`${NS}:aim:`)) {
        // Any square at all, not only one with a creature in it.
        chosen =
          options.find((o) => o.label.endsWith("catches nobody"))?.id ?? "";
        done.fireball = true;
        done.aimedAt = chosen;
      }
      const input: Input = { kind: "answer", decisionId: id, optionId: chosen };
      const outcome = step(run, state, input);
      if (!outcome.ok) throw new Error(outcome.error);
      ({ state, pending } = outcome);
      inputs.push(input);
      if (done.bless && done.fireball) break;
    }
    expect(done).toMatchObject({ bless: true, fireball: true });
    expect(done.aimedAt).toMatch(/^\d+,\d+$/);
    expect(replayInputs(run, seed, inputs).state).toStrictEqual(state);
  });
});

describe("extra damage riders", () => {
  const sword = "weapon:srd52:item/longsword";
  const hit = (
    attacker: string,
    actionId: string,
    target: string,
    critical = false,
  ) => ({
    attacker,
    actionId,
    target,
    critical,
    hadAdvantage: false,
    total: 30,
    natural: 15,
  });

  it("adds Hex's die only when its caster hits the cursed target, and doubles it on a critical", async () => {
    const run = arenaRun(await base(), {});
    const cast = settle(
      run,
      fight(
        hero(run, { spells: ["hex"] }),
        hero(run, { id: "ally" }),
        monster("a"),
        monster("b"),
      ),
      [act(PLAYER_ACTOR, `spell:${spell("hex")}|a`)],
      HIGH,
    );
    const damage = (
      attacker: string,
      target: string,
      critical = false,
    ): number[] =>
      damageOf(
        settle(
          run,
          cast.state,
          [
            {
              kind: `${NS}:applyHit`,
              payload: hit(attacker, sword, target, critical),
            },
          ],
          HIGH,
        ).events,
      );
    expect(damage(PLAYER_ACTOR, "a")).toEqual([7, 6]);
    expect(damage(PLAYER_ACTOR, "a", true)).toEqual([15, 12]);
    expect(damage(PLAYER_ACTOR, "b")).toEqual([7]);
    expect(damage("ally", "a")).toEqual([7]);
  });

  it("limits Divine Favor to weapons, and counts it once", async () => {
    const run = arenaRun(await base(), {});
    const favor = `spell:${spell("divine-favor")}`;
    const cast = settle(
      run,
      fight(hero(run, { spells: ["divine-favor", "fire-bolt"] }), monster("a")),
      [act(PLAYER_ACTOR, `${favor}|${PLAYER_ACTOR}`)],
      HIGH,
    );
    const twice = settle(
      run,
      cast.state,
      [act(PLAYER_ACTOR, `${favor}|${PLAYER_ACTOR}`)],
      HIGH,
    );
    const damage = (actionId: string): number[] =>
      damageOf(
        settle(
          run,
          twice.state,
          [
            {
              kind: `${NS}:applyHit`,
              payload: hit(PLAYER_ACTOR, actionId, "a"),
            },
          ],
          HIGH,
        ).events,
      );
    expect(damage(sword)).toEqual([7, 4]);
    expect(damage(`spell:${spell("fire-bolt")}`)).toEqual([10]);
  });

  it("offers a smite after a melee weapon hit, doubled on a critical", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(hero(run, { spells: ["divine-smite"] }), monster("a"));
    const smited = settle(
      run,
      state,
      [
        {
          kind: `${NS}:applyHit`,
          payload: hit(PLAYER_ACTOR, sword, "a", true),
        },
      ],
      HIGH,
    );
    expect(smited.decisions[0]?.id).toContain(":afterHit:");
    expect(damageOf(smited.events, "a")).toEqual([15, 32]); // 4d8 at the highest roll
    const after = actor(smited.state, PLAYER_ACTOR);
    expect(after.budget.bonusAction).toBe(false);
    expect(after.resourcesSpent).toEqual({ "slot:1": 1 });
  });

  it("lets a smite be upcast or declined", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(hero(run, { spells: ["divine-smite"] }), monster("a"));
    const frames: Frame[] = [
      { kind: `${NS}:applyHit`, payload: hit(PLAYER_ACTOR, sword, "a") },
    ];
    const upcast = settle(run, state, frames, HIGH, (decision) => {
      const option = decision.options.find((item) => item.id.endsWith("|3"));
      return option?.id ?? "";
    });
    expect(damageOf(upcast.events, "a")).toEqual([7, 32]);
    expect(actor(upcast.state, PLAYER_ACTOR).resourcesSpent).toEqual({
      "slot:3": 1,
    });
    const declined = settle(run, state, frames, HIGH, () => "decline");
    expect(damageOf(declined.events, "a")).toEqual([7]);
    expect(actor(declined.state, PLAYER_ACTOR).resourcesSpent).toEqual({});
  });

  it("doesn't offer a melee smite on a ranged hit, nor without a Bonus Action, nor to a target already down", async () => {
    const run = arenaRun(await base(), {});
    const ranged = hero(run, {
      spells: ["divine-smite"],
      inventory: ["srd52:item/shortbow"],
    });
    const shot = settle(
      run,
      fight(ranged, monster("a")),
      [
        {
          kind: `${NS}:applyHit`,
          payload: hit(PLAYER_ACTOR, "weapon:srd52:item/shortbow", "a"),
        },
      ],
      HIGH,
    );
    expect(shot.decisions).toEqual([]);

    const spent = hero(run, { spells: ["divine-smite"] });
    const tired = settle(
      run,
      fight(
        { ...spent, budget: { ...spent.budget, bonusAction: false } },
        monster("a"),
      ),
      [{ kind: `${NS}:applyHit`, payload: hit(PLAYER_ACTOR, sword, "a") }],
      HIGH,
    );
    expect(tired.decisions).toEqual([]);

    const killed = settle(
      run,
      fight(spent, monster("a", "srd52:monster/dummy", 1), monster("b")),
      [{ kind: `${NS}:applyHit`, payload: hit(PLAYER_ACTOR, sword, "a") }],
      HIGH,
    );
    expect(killed.decisions).toEqual([]);
  });

  it("never treats a smite as a reaction to being hit", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(monster("a"), hero(run, { spells: ["divine-smite"] }));
    const rolled = runAttackRoll(
      { attacker: "a", actionId: "monster:0", target: PLAYER_ACTOR },
      contextOf(run, state, { below: () => 0, roll: () => 15 }),
    );
    expect(rolled.frames?.[0]?.kind).toBe(`${NS}:applyHit`);
  });
});

describe("scaling by level and slot", () => {
  it("grows a cantrip's dice at character levels 5, 11 and 17", async () => {
    const run = arenaRun(await base(), {});
    const dice = [1, 4, 5, 10, 11, 16, 17, 20].map((level) => {
      const action = deriveStats(
        hero(run, { spells: ["fire-bolt"], level }),
        run,
      ).actions.find((item) => item.id === `spell:${spell("fire-bolt")}`);
      const resolution = action?.activation.resolution;
      return resolution?.kind === "attack"
        ? resolution.damage[0]?.amount.dice
        : undefined;
    });
    expect(dice).toEqual([
      "1d10",
      "1d10",
      "2d10",
      "2d10",
      "3d10",
      "3d10",
      "4d10",
      "4d10",
    ]);
  });

  it("casts Fireball higher for more dice, and spends the slot chosen", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(hero(run, { spells: ["fireball"] }), monster("a"));
    const decision = nextDndDecision(state, run);
    expect(decision?.options.map((option) => option.id)).toContain(
      `spell:${spell("fireball")}|all|5`,
    );
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${spell("fireball")}|all|5`)],
      LOW,
    );
    expect(damageOf(cast.events, "a")).toEqual([10]);
    expect(actor(cast.state, PLAYER_ACTOR).resourcesSpent).toEqual({
      "slot:5": 1,
    });
  });

  it("offers no higher slot when the spell wouldn't gain from one", async () => {
    const run = arenaRun(await base(), {});
    const decision = nextDndDecision(
      fight(hero(run, { spells: ["shield-of-faith"] }), monster("a")),
      run,
    );
    const ids = decision?.options.map((option) => option.id) ?? [];
    expect(ids.filter((id) => id.includes("shield-of-faith"))).toHaveLength(1);
  });

  it("uses a higher slot when the lower ones are gone", async () => {
    const run = arenaRun(await base(), {});
    const out = {
      ...hero(run, { spells: ["magic-missile"] }),
      resourcesSpent: { "slot:1": 4 },
    };
    const cast = settle(
      run,
      fight(out, monster("a")),
      [act(PLAYER_ACTOR, `spell:${spell("magic-missile")}|a`)],
      LOW,
    );
    expect(damageOf(cast.events, "a")).toHaveLength(4);
    expect(actor(cast.state, PLAYER_ACTOR).resourcesSpent).toEqual({
      "slot:1": 4,
      "slot:2": 1,
    });
  });

  it("adds the extra targets of a higher slot after the one chosen", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(
      hero(run, { spells: ["hold-person"] }),
      monster("a"),
      monster("b"),
      monster("c", "srd52:monster/dummy", 400),
    );
    const cast = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${spell("hold-person")}|a|3`)],
      LOW,
    );
    expect(actor(cast.state, "a").activeEffects).toHaveLength(1);
    expect(actor(cast.state, "c").activeEffects).toHaveLength(1);
    expect(actor(cast.state, "b").activeEffects).toHaveLength(0);
  });

  it("adds dice only to amounts that use the same die", () => {
    const activation = scaleActivation(
      {
        cost: ["action"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [
            { amount: { dice: "2d10" }, type: "bludgeoning" },
            { amount: { dice: "4d6" }, type: "cold" },
          ],
          effects: [],
        },
      },
      { addDice: "1d10" },
      2,
    );
    expect(
      activation.resolution.kind === "automatic" &&
        activation.resolution.damage.map((item) => item.amount.dice),
    ).toEqual(["4d10", "4d6"]);
  });
});

describe("monster traits", () => {
  const trait = (kind: string, fields = {}) => ({
    "srd52:monster/wolf": dummy("srd52:monster/wolf", {
      passives: [{ kind }],
      ...fields,
    }),
  });
  const WOLF = "srd52:monster/wolf";

  it("has a creature with no automated actions pass its turn", async () => {
    const run = arenaRun(await base(), {
      [WOLF]: dummy(WOLF, { actions: [] }),
    });
    const state = fight(monster("w", WOLF), hero(run));
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("The creature has no turn");
    expect(decision.options.map((option) => option.id)).toEqual(["pass"]);
    expect(
      choosePolicy(
        decision,
        contextOf(run, state, createDice(rngFromSeed("pass"))),
      ),
    ).toBe("pass");
  });

  it("gives Pack Tactics Advantage only with an ally able to act", async () => {
    const run = arenaRun(await base(), trait("packTactics"));
    const rolls = (state: DndState): number => {
      const { dice, d20s } = countingD20s(LOW);
      runAttackRoll(
        { attacker: "w", actionId: "monster:0", target: PLAYER_ACTOR },
        contextOf(run, state, dice),
      );
      return d20s();
    };
    const wolf = monster("w", WOLF);
    expect(rolls(fight(wolf, hero(run)))).toBe(1);
    expect(rolls(fight(wolf, monster("friend"), hero(run)))).toBe(2);
    expect(rolls(fight(wolf, monster("fallen", WOLF, 0), hero(run)))).toBe(1);
  });

  it("lets a goblin hide as a Bonus Action, on a passed DC 15 roll", async () => {
    const run = await base();
    const goblin = monster("g", "srd52:monster/goblin-warrior");
    const decision = nextDndDecision(fight(goblin, hero(run)), run);
    const hide = decision?.options.find((option) => option.id.endsWith("|g"));
    if (!hide) throw new Error("The goblin has no Nimble Escape");
    const hidden = settle(
      run,
      fight(goblin, hero(run)),
      [act("g", hide.id)],
      HIGH,
    );
    expect(actor(hidden.state, "g").activeEffects[0]?.modifier).toEqual({
      kind: "condition",
      condition: "invisible",
    });
    const seen = settle(
      run,
      fight(goblin, hero(run)),
      [act("g", hide.id)],
      LOW,
    );
    expect(actor(seen.state, "g").activeEffects).toEqual([]);
  });

  it("lets Undead Fortitude keep a monster at 1 HP on a passed save", async () => {
    const run = arenaRun(await base(), trait("undeadFortitude"));
    const weak = monster("z", WOLF, 5);
    const finish = (dice: Dice, critical = false) =>
      settle(
        run,
        fight(hero(run), weak, monster("other")),
        [
          {
            kind: `${NS}:applyHit`,
            payload: {
              attacker: PLAYER_ACTOR,
              actionId: "weapon:srd52:item/longsword",
              target: "z",
              critical,
              hadAdvantage: false,
              total: 30,
              natural: 15,
            },
          },
        ],
        dice,
      );
    // The d8 and the save die both roll high here, and a natural 20 on the Constitution save beats DC 12.
    const survived = finish(HIGH);
    expect(actor(survived.state, "z").hp).toBe(1);
    expect(kinds(survived.events)).not.toContain("actorDefeated");
    // On a Critical Hit there's no save.
    const crit = finish(HIGH, true);
    expect(actor(crit.state, "z").hp).toBe(0);
    expect(kinds(crit.events)).toContain("actorDefeated");
  });

  it("gives Undead Fortitude no save against Radiant damage, or on a failed roll", async () => {
    const run = arenaRun(await base(), trait("undeadFortitude"));
    const weak = monster("z", WOLF, 2);
    const cast = settle(
      run,
      fight(hero(run, { spells: ["guiding-bolt"] }), weak, monster("other")),
      [
        {
          kind: `${NS}:applyHit`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: `spell:${spell("guiding-bolt")}`,
            target: "z",
            critical: false,
            hadAdvantage: false,
            total: 30,
            natural: 15,
          },
        },
      ],
      HIGH,
    );
    expect(actor(cast.state, "z").hp).toBe(0);
    const failed = settle(
      run,
      fight(hero(run, { spells: ["magic-missile"] }), weak, monster("other")),
      [act(PLAYER_ACTOR, `spell:${spell("magic-missile")}|z`)],
      LOW,
    );
    expect(actor(failed.state, "z").hp).toBe(0);
  });

  it("gives Magic Resistance Advantage on saves against spells only", async () => {
    const breath = {
      name: "Breath",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 15, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "dex",
          dc: { base: 10 },
          damage: [{ amount: { dice: "1d6" }, type: "fire" }],
        },
      },
    };
    const run = arenaRun(await base(), {
      ...trait("magicResistance"),
      "srd52:monster/dragon": dummy("srd52:monster/dragon", {
        actions: [breath],
      }),
    });
    const d20sFor = (attacker: Actor, answer: string): number => {
      const { dice, d20s } = countingD20s(LOW);
      runTakeAction(
        { actor: attacker.id, answer },
        contextOf(run, fight(attacker, monster("w", WOLF)), dice),
      );
      return d20s();
    };
    expect(
      d20sFor(
        hero(run, { spells: ["sacred-flame"] }),
        `spell:${spell("sacred-flame")}|w`,
      ),
    ).toBe(2);
    const dragon = {
      ...monster("d", "srd52:monster/dragon"),
      side: "party" as const,
    };
    expect(d20sFor(dragon, "monster:0|w")).toBe(1);
  });

  it("keeps a condition off a creature immune to it", async () => {
    const shove = {
      name: "Shove",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "weapon", flatBonus: 4 },
          damage: [{ amount: { dice: "1d4" }, type: "bludgeoning" }],
          onHit: [
            {
              kind: "applyCondition",
              condition: "prone",
              duration: { minutes: 1 },
            },
          ],
        },
      },
    };
    const run = arenaRun(await base(), {
      ...trait("conditionImmunity", {
        passives: [{ kind: "conditionImmunity", condition: "prone" }],
      }),
      "srd52:monster/bully": dummy("srd52:monster/bully", {
        actions: [shove],
      }),
    });
    const bully = {
      ...monster("b", "srd52:monster/bully"),
      side: "party" as const,
    };
    const hit = (target: Actor) =>
      settle(
        run,
        fight(bully, target, hero(run)),
        [
          {
            kind: `${NS}:applyHit`,
            payload: {
              attacker: "b",
              actionId: "monster:0",
              target: target.id,
              critical: false,
              hadAdvantage: false,
              total: 30,
              natural: 15,
            },
          },
        ],
        LOW,
      );
    expect(
      hasCondition(actor(hit(monster("w", WOLF)).state, "w"), "prone"),
    ).toBe(false);
    expect(hasCondition(actor(hit(monster("o")).state, "o"), "prone")).toBe(
      true,
    );
  });

  it("has Regeneration heal at the start of the creature's turn, up to its maximum", async () => {
    const run = arenaRun(
      await base(),
      trait("regeneration", {
        passives: [{ kind: "regeneration", hp: 15, stoppedBy: ["fire"] }],
      }),
    );
    const turn = (hp: number) =>
      actor(
        settle(run, fight(hero(run), monster("t", WOLF, hp)), [endTurn], LOW)
          .state,
        "t",
      ).hp;
    expect(turn(400)).toBe(415);
    expect(turn(495)).toBe(500);
  });
});

describe("monster Multiattack routines and area choices", () => {
  const attackAction = (name: string) => ({
    name,
    activation: {
      cost: ["action"],
      targeting: { creatures: 1, range: 5, side: "enemy" },
      resolution: {
        kind: "attack",
        attack: { type: "weapon", flatBonus: 4 },
        damage: [{ amount: { dice: "1d6" }, type: "slashing" }],
      },
    },
  });
  const beast = (
    names: readonly string[],
    multiattack: number,
    sentence?: string,
  ) => ({
    "srd52:monster/beast": dummy("srd52:monster/beast", {
      actions: names.map(attackAction),
      multiattack,
      ...(sentence
        ? { text: `Actions Multiattack. ${sentence} Bite. Melee.` }
        : {}),
    }),
  });
  const routineOf = async (
    names: readonly string[],
    multiattack: number,
    sentence: string | undefined,
    chosen: number,
  ): Promise<readonly string[]> => {
    const run = arenaRun(await base(), beast(names, multiattack, sentence));
    const state = fight(monster("m", "srd52:monster/beast"), hero(run));
    const frames = runTakeAction(
      { actor: "m", answer: `monster:${String(chosen)}|${PLAYER_ACTOR}` },
      contextOf(run, state, LOW),
    ).frames;
    return (frames ?? []).flatMap((item) =>
      item.kind === `${NS}:attackRoll`
        ? [names[Number(String(item.payload.actionId).split(":")[1])] ?? ""]
        : [],
    );
  };

  it("makes the printed mix, whichever attack was chosen", async () => {
    const sentence = "The beast makes one Bite attack and two Thrash attacks.";
    const names = ["Bite", "Thrash"];
    expect(await routineOf(names, 3, sentence, 0)).toEqual([
      "Bite",
      "Thrash",
      "Thrash",
    ]);
    expect(await routineOf(names, 3, sentence, 1)).toEqual([
      "Bite",
      "Thrash",
      "Thrash",
    ]);
  });

  it("spreads a tarrasque's other attacks across the ones it names", async () => {
    const sentence =
      "The tarrasque makes one Bite attack and three other attacks, using Claw or Tail in any combination.";
    expect(await routineOf(["Bite", "Claw", "Tail"], 4, sentence, 0)).toEqual([
      "Bite",
      "Claw",
      "Tail",
      "Claw",
    ]);
  });

  it("repeats the chosen attack when the block allows any combination", async () => {
    const sentence =
      "The centaur makes two attacks, using Pike or Longbow in any combination.";
    const names = ["Pike", "Longbow"];
    expect(await routineOf(names, 2, sentence, 1)).toEqual([
      "Longbow",
      "Longbow",
    ]);
    const either = "The warrior makes two Pike or Longbow attacks.";
    expect(await routineOf(names, 2, either, 1)).toEqual([
      "Longbow",
      "Longbow",
    ]);
  });

  it("has the ranged copy of a Melee or Ranged attack follow the melee routine", async () => {
    const sentence = "The beast makes two Spear attacks.";
    const names = ["Spear", "Spear (ranged)"];
    expect(await routineOf(names, 2, sentence, 0)).toEqual(["Spear", "Spear"]);
    expect(await routineOf(names, 2, sentence, 1)).toEqual([
      "Spear (ranged)",
      "Spear (ranged)",
    ]);
  });

  it("keeps a printed choice of two routines apart", async () => {
    const sentence =
      "The devil makes one Claws attack and one Tail attack, or it makes two Hurl Flame attacks.";
    const names = ["Claws", "Tail", "Hurl Flame"];
    expect(await routineOf(names, 2, sentence, 1)).toEqual(["Claws", "Tail"]);
    expect(await routineOf(names, 2, sentence, 2)).toEqual([
      "Hurl Flame",
      "Hurl Flame",
    ]);
    expect(
      await routineOf(
        ["Maul", "Burst"],
        3,
        "The dao makes three Maul attacks or two Burst attacks.",
        1,
      ),
    ).toEqual(["Burst", "Burst"]);
  });

  it("makes an attack outside the routine only once, and the policy prefers the routine", async () => {
    const sentence = "The ghoul makes two Bite attacks.";
    const names = ["Claw", "Bite"];
    expect(await routineOf(names, 2, sentence, 0)).toEqual(["Claw"]);
    expect(await routineOf(names, 2, sentence, 1)).toEqual(["Bite", "Bite"]);
    const run = arenaRun(await base(), beast(names, 2, sentence));
    const state = fight(monster("m", "srd52:monster/beast"), hero(run));
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("No decision");
    expect(choosePolicy(decision, contextOf(run, state, LOW))).toBe(
      `monster:1|${PLAYER_ACTOR}`,
    );
  });

  it("keeps repeating the chosen attack when no routine is printed", async () => {
    expect(await routineOf(["Bite", "Claw"], 2, undefined, 1)).toEqual([
      "Claw",
      "Claw",
    ]);
  });

  const area = (
    fields: Readonly<Record<string, unknown>>,
    cost: unknown[],
  ) => ({
    name: "Breath",
    activation: {
      cost,
      targeting: {
        area: { shape: "cone", radius: 30 },
        range: "self",
        side: "enemy",
      },
      resolution: { kind: "save", ability: "wis", dc: { base: 10 }, ...fields },
    },
  });
  const sleep = {
    onFail: [
      {
        kind: "applyCondition",
        condition: "incapacitated",
        duration: { minutes: 1 },
      },
    ],
  };
  const heat = { damage: [{ amount: { dice: "1d6" }, type: "fire" }] };

  const picks = async (
    breath: unknown,
    party: readonly ((run: RunContext) => Actor)[],
  ): Promise<string> => {
    const run = arenaRun(await base(), {
      "srd52:monster/drake": dummy("srd52:monster/drake", {
        actions: [attackAction("Rend"), breath],
      }),
    });
    const state = fight(
      monster("d", "srd52:monster/drake"),
      ...party.map((make) => make(run)),
    );
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("No decision");
    return choosePolicy(decision, contextOf(run, state, LOW));
  };
  const free =
    (id: string, hp = 100) =>
    (run: RunContext): Actor =>
      hero(run, { id, hp });
  const asleep =
    (id: string) =>
    (run: RunContext): Actor => ({
      ...hero(run, { id }),
      activeEffects: [
        {
          sourceId: "monster:1",
          casterId: "d",
          ends: "spellDuration",
          modifier: { kind: "condition", condition: "incapacitated" },
        },
      ],
    });
  const BREATH = "monster:1|all";

  it("uses a condition-only area action until most foes already have the condition", async () => {
    const breath = area(sleep, ["action"]);
    expect(await picks(breath, [free(PLAYER_ACTOR), free("b")])).toBe(BREATH);
    expect(await picks(breath, [asleep(PLAYER_ACTOR), free("b")])).toBe(BREATH);
    expect(
      await picks(breath, [asleep(PLAYER_ACTOR), asleep("b"), free("c")]),
    ).not.toBe(BREATH);
    expect(await picks(breath, [asleep(PLAYER_ACTOR), asleep("b")])).not.toBe(
      BREATH,
    );
  });

  it("uses a damaging area action with no recharge only on more than one foe", async () => {
    const breath = area(heat, ["action"]);
    expect(await picks(breath, [free(PLAYER_ACTOR), free("b")])).toBe(BREATH);
    expect(await picks(breath, [free(PLAYER_ACTOR)])).not.toBe(BREATH);
  });

  it("always takes a recharged area attack while it's ready", async () => {
    const breath = area(heat, ["action", { resource: "breath" }]);
    expect(await picks(breath, [free(PLAYER_ACTOR)])).toBe(BREATH);
  });
});

describe("advantage and disadvantage against a target", () => {
  const attackFrom = (run: RunContext, state: DndState) => {
    const { dice, d20s } = countingD20s(LOW);
    const result = runAttackRoll(
      {
        attacker: PLAYER_ACTOR,
        actionId: "weapon:srd52:item/longsword",
        target: "a",
      },
      contextOf(run, state, dice),
    );
    return { result, d20s: d20s() };
  };

  it("makes Faerie Fire give Advantage to everyone attacking an outlined target", async () => {
    const run = arenaRun(await base(), {});
    const cast = settle(
      run,
      fight(hero(run, { spells: ["faerie-fire"] }), monster("a"), monster("b")),
      [act(PLAYER_ACTOR, `spell:${spell("faerie-fire")}|all`)],
      LOW,
    );
    expect(attackFrom(run, cast.state).d20s).toBe(2);
    const passed = settle(
      run,
      fight(hero(run, { spells: ["faerie-fire"] }), monster("a")),
      [act(PLAYER_ACTOR, `spell:${spell("faerie-fire")}|all`)],
      HIGH,
    );
    expect(attackFrom(run, passed.state).d20s).toBe(1);
  });

  it("makes Blur give Disadvantage, and it cancels with Advantage", async () => {
    const run = arenaRun(await base(), {});
    const blurred = {
      sourceId: `spell:${spell("blur")}`,
      casterId: "a",
      ends: "concentration" as const,
      modifier: {
        kind: "disadvantage" as const,
        on: "attacksAgainst" as const,
      },
    };
    const target = { ...monster("a"), activeEffects: [blurred] };
    expect(attackFrom(run, fight(hero(run), target)).d20s).toBe(2);
    const both = {
      ...target,
      activeEffects: [
        blurred,
        {
          ...blurred,
          sourceId: "other",
          modifier: {
            kind: "advantage" as const,
            on: "attacksAgainst" as const,
          },
        },
      ],
    };
    expect(attackFrom(run, fight(hero(run), both)).d20s).toBe(1);
  });

  it("spends Guiding Bolt's Advantage on the next attack roll, hit or miss", async () => {
    const run = arenaRun(await base(), {});
    const bolted = settle(
      run,
      fight(hero(run, { spells: ["guiding-bolt"] }), monster("a")),
      [
        {
          kind: `${NS}:applyHit`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: `spell:${spell("guiding-bolt")}`,
            target: "a",
            critical: false,
            hadAdvantage: false,
            total: 30,
            natural: 15,
          },
        },
      ],
      LOW,
    );
    const first = attackFrom(run, bolted.state);
    expect(first.d20s).toBe(2);
    const events = first.result.events ?? [];
    expect(kinds(events)).toContain(`${NS}:effectEnded`);
    let after = bolted.state;
    for (const event of events) after = applyDndEvent(after, event);
    expect(attackFrom(run, after).d20s).toBe(1);
  });

  it("keeps a next-turn-end effect through the caster's next turn, then ends it", async () => {
    const run = arenaRun(await base(), {});
    expect(effectEnds({ until: "yourNextTurnEnd" })).toBe("casterNextTurnEnd");
    const marked = {
      ...monster("a"),
      activeEffects: [
        {
          sourceId: "s",
          casterId: PLAYER_ACTOR,
          ends: "casterNextTurnEnd" as const,
          modifier: {
            kind: "advantage" as const,
            on: "attacksAgainst" as const,
          },
        },
      ],
    };
    let state = fight(hero(run), marked);
    const advance = (): void => {
      state = applyDndEvent(state, dndEvent(`${NS}:turnAdvanced`, {}));
    };
    advance(); // the caster's casting turn ends
    expect(actor(state, "a").activeEffects).toHaveLength(1);
    advance(); // the caster's next turn starts
    expect(actor(state, "a").activeEffects).toHaveLength(1);
    advance(); // and ends
    expect(actor(state, "a").activeEffects).toEqual([]);
  });

  it("makes Vicious Mockery's Disadvantage last one attack", async () => {
    const run = arenaRun(await base(), {});
    const mocked = settle(
      run,
      fight(hero(run, { spells: ["vicious-mockery"] }), monster("a")),
      [act(PLAYER_ACTOR, `spell:${spell("vicious-mockery")}|a`)],
      LOW,
    );
    const roll = runAttackRoll(
      { attacker: "a", actionId: "monster:0", target: PLAYER_ACTOR },
      contextOf(run, mocked.state, LOW),
    );
    expect(kinds(roll.events ?? [])).toContain(`${NS}:effectEnded`);
  });
});

describe("how companions spend spell slots", () => {
  const choose = (run: RunContext, state: DndState): string => {
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("No decision");
    return choosePolicy(decision, contextOf(run, state, LOW));
  };

  it("spends a slot when the enemies left have more HP than the caster", async () => {
    const run = arenaRun(await base(), {});
    const picked = choose(
      run,
      fight(
        hero(run, { spells: ["magic-missile", "fire-bolt"], hp: 8 }),
        monster("a", "srd52:monster/dummy", 50),
      ),
    );
    expect(picked).toContain("magic-missile");
    expect(picked.split("|")).toHaveLength(2);
  });

  it("saves slots for a fight nearly won", async () => {
    const run = arenaRun(await base(), {});
    const picked = choose(
      run,
      fight(
        hero(run, { spells: ["magic-missile", "fire-bolt"], hp: 8 }),
        monster("a", "srd52:monster/dummy", 3),
      ),
    );
    expect(picked).not.toContain("magic-missile");
  });

  it("keeps a healer's last slot for healing", async () => {
    const run = arenaRun(await base(), {});
    const caster = hero(run, {
      spells: ["cure-wounds", "guiding-bolt", "sacred-flame"],
    });
    const lastOne = {
      ...caster,
      hp: deriveStats(caster, run).maxHp,
      resourcesSpent: {
        "slot:1": 4,
        "slot:2": 3,
        "slot:3": 3,
        "slot:4": 3,
        "slot:5": 3,
        "slot:6": 2,
        "slot:7": 2,
        "slot:8": 1,
      },
    };
    expect(choose(run, fight(lastOne, monster("a")))).not.toContain(
      "guiding-bolt",
    );
    const twoLeft = {
      ...lastOne,
      resourcesSpent: { ...lastOne.resourcesSpent, "slot:8": 0 },
    };
    expect(choose(run, fight(twoLeft, monster("a")))).toContain("guiding-bolt");
  });

  it("won't drop one Concentration spell for another, or repeat a buff", async () => {
    const run = arenaRun(await base(), {});
    const concentrating = {
      ...hero(run, { spells: ["bless", "fire-bolt"], hp: 8 }),
      concentratingOn: "spell:other",
    };
    expect(choose(run, fight(concentrating, monster("a")))).not.toContain(
      "bless",
    );
    const armored = {
      ...hero(run, { spells: ["mage-armor", "fire-bolt"], hp: 8 }),
      activeEffects: [
        {
          sourceId: `spell:${spell("mage-armor")}`,
          casterId: PLAYER_ACTOR,
          ends: "spellDuration" as const,
          modifier: {
            kind: "resistance" as const,
            damage: "fire" as const,
          },
        },
      ],
    };
    expect(choose(run, fight(armored, monster("a")))).not.toContain(
      "mage-armor",
    );
  });

  it("spends only one slot a turn", async () => {
    const run = arenaRun(await base(), {});
    const caster = hero(run, { spells: ["hex", "magic-missile"], hp: 8 });
    const acted = {
      ...caster,
      budget: { ...caster.budget, action: false },
    };
    expect(choose(run, fight(acted, monster("a")))).toBe("pass");
  });

  it("smites only when the fight is worth a slot", async () => {
    const run = arenaRun(await base(), {});
    const caster = hero(run, { spells: ["divine-smite"], hp: 8 });
    const decide = (hp: number): string => {
      const state = fight(caster, monster("a", "srd52:monster/dummy", hp));
      const settled = settle(
        run,
        state,
        [
          {
            kind: `${NS}:afterHit`,
            payload: {
              attacker: PLAYER_ACTOR,
              actionId: "weapon:srd52:item/longsword",
              target: "a",
              critical: false,
            },
          },
        ],
        LOW,
        (decision) => choosePolicy(decision, contextOf(run, state, LOW)),
      );
      return settled.events.length > 0 ? "smite" : "decline";
    };
    expect(decide(100)).toBe("smite");
    expect(decide(3)).toBe("decline");
  });
});

describe("class feature building blocks", () => {
  const feature = (id: string, fields: Readonly<Record<string, unknown>>) => ({
    [id]: { id, name: id, text: id, automation: "full", ...fields },
  });
  const modifier = (value: Readonly<Record<string, unknown>>) => ({
    passives: [{ kind: "modifier", modifier: value }],
  });

  it("applies a passive AC formula and flat bonus", async () => {
    const run = arenaRun(await base(), {
      ...feature(
        "srd52:feature/unarmored",
        modifier({
          kind: "acFormula",
          formula: {
            base: 10,
            add: [
              { kind: "abilityMod", ability: "dex" },
              { kind: "abilityMod", ability: "int" },
            ],
          },
        }),
      ),
      ...feature(
        "srd52:feature/defense",
        modifier({ kind: "bonus", to: "ac", amount: { bonus: { base: 1 } } }),
      ),
    });
    const plain = deriveStats(hero(run), run).ac;
    const unarmored = hero(run, { features: ["srd52:feature/unarmored"] });
    expect(deriveStats(unarmored, run).ac).toBe(plain + 3);
    const defended = hero(run, { features: ["srd52:feature/defense"] });
    expect(deriveStats(defended, run).ac).toBe(plain + 1);
  });

  it("applies passive resistance, vulnerability and immunity", async () => {
    const run = arenaRun(await base(), {
      ...feature("srd52:feature/tough", {
        passives: [
          {
            kind: "modifier",
            modifier: { kind: "resistance", damage: "fire" },
          },
          {
            kind: "modifier",
            modifier: { kind: "vulnerability", damage: "cold" },
          },
          {
            kind: "modifier",
            modifier: { kind: "immunity", damage: "poison" },
          },
        ],
      }),
    });
    expect(
      damageResponses(hero(run, { features: ["srd52:feature/tough"] }), run),
    ).toMatchObject({
      resistances: ["fire"],
      vulnerabilities: ["cold"],
      immunities: ["poison"],
    });
  });

  it("adds a passive bonus to attack rolls and saves", async () => {
    const run = arenaRun(await base(), {
      ...feature(
        "srd52:feature/archery",
        modifier({
          kind: "bonus",
          to: "attacks",
          amount: { bonus: { base: 2 } },
        }),
      ),
    });
    const totalWith = (features: readonly string[]): unknown => {
      const rolled = runAttackRoll(
        {
          attacker: PLAYER_ACTOR,
          actionId: "weapon:srd52:item/longsword",
          target: "a",
        },
        contextOf(run, fight(hero(run, { features }), monster("a")), {
          below: () => 0,
          roll: () => 10,
        }),
      );
      const report = (rolled.events ?? [])[0];
      return report && "payload" in report ? report.payload.total : undefined;
    };
    expect(totalWith(["srd52:feature/archery"])).toBe(
      Number(totalWith([])) + 2,
    );
  });

  it("gives Advantage from a passive flag", async () => {
    const run = arenaRun(await base(), {
      ...feature(
        "srd52:feature/keen",
        modifier({ kind: "advantage", on: "attacks" }),
      ),
    });
    const { dice, d20s } = countingD20s(LOW);
    runAttackRoll(
      {
        attacker: PLAYER_ACTOR,
        actionId: "weapon:srd52:item/longsword",
        target: "a",
      },
      contextOf(
        run,
        fight(hero(run, { features: ["srd52:feature/keen"] }), monster("a")),
        dice,
      ),
    );
    expect(d20s()).toBe(2);
  });

  it("lets scaling keys set a die count and a die size", async () => {
    const run = arenaRun(await base(), {
      ...feature("srd52:feature/sneak", {
        passives: [
          {
            kind: "extraDamage",
            dice: "1d6",
            diceCount: "sneakAttackD6",
            when: "advantage",
          },
        ],
      }),
      ...feature("srd52:feature/fist", {
        activations: [
          {
            cost: ["bonusAction"],
            targeting: { creatures: 1, range: 5, side: "enemy" },
            resolution: {
              kind: "attack",
              attack: { type: "weapon", ability: "dex" },
              damage: [
                {
                  amount: { dice: "1d4", dieSize: "martialArtsDie" },
                  type: "bludgeoning",
                },
              ],
            },
          },
        ],
      }),
    });
    const sneaky = hero(run, { features: ["srd52:feature/sneak"] });
    const sneak = settle(
      run,
      fight(sneaky, monster("a")),
      [
        {
          kind: `${NS}:applyHit`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: "weapon:srd52:item/longsword",
            target: "a",
            critical: false,
            hadAdvantage: true,
            total: 30,
            natural: 15,
          },
        },
      ],
      HIGH,
    );
    expect(damageOf(sneak.events, "a")).toEqual([7 + 18]); // 1d8 - 1 Str, plus 3d6
    const puncher = hero(run, { features: ["srd52:feature/fist"] });
    const punch = settle(
      run,
      fight(puncher, monster("a")),
      [
        {
          kind: `${NS}:applyHit`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: "feature:srd52:feature/fist:0",
            target: "a",
            critical: false,
            hadAdvantage: false,
            total: 30,
            natural: 15,
          },
        },
      ],
      HIGH,
    );
    // The d4 is replaced by the d8 held in martialArtsDie, plus Dex +2 is not in this amount.
    expect(damageOf(punch.events, "a")).toEqual([8]);
  });

  it("adds a damage bonus to matching weapon attacks only", async () => {
    const run = arenaRun(await base(), {
      ...feature("srd52:feature/rage", {
        activations: [
          {
            cost: ["bonusAction"],
            targeting: { self: true },
            resolution: {
              kind: "automatic",
              effects: [
                {
                  kind: "modifier",
                  duration: { minutes: 10 },
                  modifier: {
                    kind: "damageBonus",
                    ability: "str",
                    amount: {
                      bonus: { add: [{ kind: "scaling", key: "rageDamage" }] },
                    },
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const raging = hero(run, {
      features: ["srd52:feature/rage"],
      spells: ["fire-bolt"],
    });
    const raged = settle(
      run,
      fight(raging, monster("a")),
      [act(PLAYER_ACTOR, `feature:srd52:feature/rage:0|${PLAYER_ACTOR}`)],
      HIGH,
    );
    const hit = (actionId: string): number[] =>
      damageOf(
        settle(
          run,
          raged.state,
          [
            {
              kind: `${NS}:applyHit`,
              payload: {
                attacker: PLAYER_ACTOR,
                actionId,
                target: "a",
                critical: false,
                hadAdvantage: false,
                total: 30,
                natural: 15,
              },
            },
          ],
          HIGH,
        ).events,
      );
    expect(hit("weapon:srd52:item/longsword")).toEqual([9]); // 1d8 - 1 Str + 2
    expect(hit(`spell:${spell("fire-bolt")}`)).toEqual([10]);
  });

  it("gives Action Surge's action back", async () => {
    const run = arenaRun(await base(), {
      ...feature("srd52:feature/surge", {
        resources: [{ id: "surge", max: { base: 1 }, recharge: [] }],
        activations: [
          {
            cost: [{ resource: "surge" }],
            targeting: { self: true },
            resolution: {
              kind: "automatic",
              effects: [{ kind: "extraAction" }],
            },
          },
        ],
      }),
    });
    const fighter = hero(run, { features: ["srd52:feature/surge"] });
    const spent = { ...fighter, budget: { ...fighter.budget, action: false } };
    const state = fight(spent, monster("a"));
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("No decision");
    const picked = choosePolicy(decision, contextOf(run, state, LOW));
    expect(picked).toBe(`feature:srd52:feature/surge:0|${PLAYER_ACTOR}`);
    const surged = settle(run, state, [act(PLAYER_ACTOR, picked)], LOW);
    const after = actor(surged.state, PLAYER_ACTOR);
    expect(after.budget.action).toBe(true);
    expect(after.resourcesSpent.surge).toBe(1);
  });

  it("halves a hit with an Uncanny Dodge reaction, even a critical one", async () => {
    const dodge = feature("srd52:feature/dodge", {
      activations: [
        {
          cost: ["reaction"],
          trigger: { hitByAttack: true },
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            effects: [{ kind: "reduceDamage", halve: true }],
          },
        },
      ],
    });
    const run = arenaRun(await base(), dodge);
    const state = fight(
      monster("a"),
      hero(run, { features: ["srd52:feature/dodge"] }),
    );
    const frames: Frame[] = [
      {
        kind: `${NS}:attackRoll`,
        payload: { attacker: "a", actionId: "monster:0", target: PLAYER_ACTOR },
      },
    ];
    const dodged = settle(run, state, frames, HIGH);
    expect(dodged.decisions[0]?.id).toContain(":reaction:");
    expect(damageOf(dodged.events, PLAYER_ACTOR)).toEqual([6]); // a critical's 2d6 is 12
    expect(actor(dodged.state, PLAYER_ACTOR).budget.reaction).toBe(false);
    const taken = settle(run, state, frames, HIGH, () => "decline");
    expect(damageOf(taken.events, PLAYER_ACTOR)).toEqual([12]);
  });

  it("takes a rolled amount off a hit with a Deflect Attacks reaction", async () => {
    const run = arenaRun(await base(), {
      ...feature("srd52:feature/deflect", {
        activations: [
          {
            cost: ["reaction"],
            trigger: { hitByAttack: true },
            targeting: { self: true },
            resolution: {
              kind: "automatic",
              effects: [
                { kind: "reduceDamage", amount: { bonus: { base: 5 } } },
              ],
            },
          },
        ],
      }),
    });
    const state = fight(
      monster("a"),
      hero(run, { features: ["srd52:feature/deflect"] }),
    );
    const deflected = settle(
      run,
      state,
      [
        {
          kind: `${NS}:attackRoll`,
          payload: {
            attacker: "a",
            actionId: "monster:0",
            target: PLAYER_ACTOR,
          },
        },
      ],
      HIGH,
    );
    expect(damageOf(deflected.events, PLAYER_ACTOR)).toEqual([7]);
  });

  it("sets Extra Attack from a passive, for weapons and not for spells", async () => {
    const run = arenaRun(await base(), {
      ...feature("srd52:feature/twice", {
        passives: [{ kind: "multiattack", attacks: 2 }],
      }),
    });
    const fighter = hero(run, {
      features: ["srd52:feature/twice"],
      spells: ["fire-bolt"],
    });
    expect(deriveStats(fighter, run).multiattack).toBe(2);
    const attacks = (answer: string): number =>
      (
        runTakeAction(
          { actor: PLAYER_ACTOR, answer },
          contextOf(run, fight(fighter, monster("a")), LOW),
        ).frames ?? []
      ).filter((frame) => frame.kind === `${NS}:attackRoll`).length;
    expect(attacks("weapon:srd52:item/longsword|a")).toBe(2);
    expect(attacks(`spell:${spell("fire-bolt")}|a`)).toBe(1);
  });

  it("limits a Turn Undead-style effect to the creature types it names", async () => {
    const run = arenaRun(await base(), {
      "srd52:monster/zombie": dummy("srd52:monster/zombie", {
        creatureType: "Undead",
      }),
      ...feature("srd52:feature/turn", {
        activations: [
          {
            cost: ["action"],
            targeting: {
              area: { shape: "emanation", radius: 30 },
              range: "self",
              side: "enemy",
              creatureTypes: ["undead"],
            },
            resolution: {
              kind: "automatic",
              effects: [
                {
                  kind: "applyCondition",
                  condition: "frightened",
                  duration: { minutes: 1 },
                },
              ],
            },
          },
        ],
      }),
    });
    expect(
      MonsterSchema.parse(run.content("srd52:monster/dummy")).creatureType,
    ).toBeUndefined();
    const cleric = hero(run, { features: ["srd52:feature/turn"] });
    const turn = "feature:srd52:feature/turn:0|all";
    const living = fight(cleric, monster("a"));
    expect(
      nextDndDecision(living, run)?.options.map((option) => option.id),
    ).not.toContain(turn);
    const state = fight(
      cleric,
      monster("a"),
      monster("z", "srd52:monster/zombie"),
    );
    expect(
      nextDndDecision(state, run)?.options.map((option) => option.id),
    ).toContain(turn);
    const turned = settle(run, state, [act(PLAYER_ACTOR, turn)], LOW);
    expect(actor(turned.state, "z").activeEffects).toHaveLength(1);
    expect(actor(turned.state, "a").activeEffects).toEqual([]);
  });

  it("aims a Trample-style action only at a creature with the condition it names", async () => {
    const run = arenaRun(
      await base(),
      feature("srd52:feature/trample", {
        activations: [
          {
            cost: ["action"],
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
          },
        ],
      }),
    );
    const trampler = hero(run, { features: ["srd52:feature/trample"] });
    const prone = {
      ...monster("p"),
      activeEffects: [
        {
          sourceId: "monster:0",
          casterId: "x",
          ends: "spellDuration" as const,
          modifier: { kind: "condition" as const, condition: "prone" as const },
        },
      ],
    };
    const options = nextDndDecision(
      fight(trampler, monster("a"), prone),
      run,
    )?.options.map((option) => option.id);
    expect(options).toContain("feature:srd52:feature/trample:0|p");
    expect(options).not.toContain("feature:srd52:feature/trample:0|a");
  });
});

describe("replay", () => {
  it("replays whole fights exactly, with the new spells cast along the way", async () => {
    const spells = [
      "moonbeam",
      "spirit-guardians",
      "magic-missile",
      "scorching-ray",
      "eldritch-blast",
      "hex",
      "divine-favor",
      "divine-smite",
      "searing-smite",
      "faerie-fire",
      "guiding-bolt",
      "fireball",
    ];
    const plain = await base();
    const pregen = PregenSchema.parse(plain.content("srd52:pregen/wizard"));
    const [first] = pregen.build.levels;
    if (!first) throw new Error("The pregen has no levels");
    const run = arenaRun(plain, {
      "srd52:pregen/wizard": {
        ...pregen,
        build: {
          ...pregen.build,
          levels: [
            {
              ...first,
              answers: [
                ...first.answers,
                { kind: "spells", values: spells.map(spell) },
              ],
            },
          ],
        },
      },
    });

    // Plays the wizard, trying each new spell once when it's on offer, and otherwise picks at random.
    const seen = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const seed = `mechanics-${String(index)}`;
      const dice = createDice(rngFromSeed(`${seed}:choices`));
      const untried = new Set(spells);
      const started = startRun(run, seed);
      let { state, pending } = started;
      const inputs: Input[] = [{ kind: "start" }];
      for (let count = 0; pending && count < 300; count += 1) {
        const { options }: Decision = pending;
        const fresh = options.find((option) =>
          [...untried].some((slug) => option.id.includes(spell(slug))),
        );
        const chosen =
          options.find((option) => option.id === "srd52:pregen/wizard") ??
          fresh ??
          options[dice.below(options.length)];
        if (!chosen) throw new Error(`${pending.id} has no options`);
        for (const slug of untried) {
          if (chosen.id.includes(spell(slug))) untried.delete(slug);
        }
        const input: Input = {
          kind: "answer",
          decisionId: pending.id,
          optionId: chosen.id,
        };
        const outcome = step(run, state, input);
        if (!outcome.ok) throw new Error(outcome.error);
        ({ state, pending } = outcome);
        inputs.push(input);
        for (const event of outcome.events) {
          if (event.kind === `${NS}:effectAdded` && "payload" in event) {
            const added = event.payload as {
              effect: { modifier: { kind: string } };
            };
            seen.add(added.effect.modifier.kind);
          }
          if (event.kind === `${NS}:damaged`) seen.add("damaged");
        }
      }
      expect(replayInputs(run, seed, inputs).state).toStrictEqual(state);
      expect(StateSchema.parse(state.system)).toBeDefined();
    }
    expect(seen).toContain("lingeringDamage");
    expect(seen).toContain("hitDamage");
    expect(seen).toContain("damaged");
  }, 240_000);

  it("gives the same events from the same seed for a seeded cast", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(
      hero(run, { spells: ["moonbeam"] }),
      monster("a"),
      monster("b"),
    );
    const once = (): Settled =>
      settle(
        run,
        state,
        [act(PLAYER_ACTOR, `spell:${spell("moonbeam")}|all`), endTurn, endTurn],
        createDice(rngFromSeed("same")),
      );
    expect(once().events).toStrictEqual(once().events);
    expect(once().state).toStrictEqual(once().state);
  });
});

describe("the 5-foot grid", () => {
  const at = (who: Actor, x: number, y: number): Actor => ({
    ...who,
    position: { x, y },
  });
  const onGrid = (...actors: readonly Actor[]): DndState => {
    const state = fight(...actors);
    if (!state.combat) throw new Error("No fight");
    return {
      ...state,
      combat: { ...state.combat, grid: { width: 12, height: 12 } },
    };
  };
  const sword = "weapon:srd52:item/longsword";

  it("starts the sides 30 feet apart", () => {
    const { positions } = placeSides(["hero", "ally"], ["goblin"]);
    expect(distanceFeet(positions.hero ?? null, positions.goblin ?? null)).toBe(
      30,
    );
  });

  it("offers a melee attack only within reach, and a move to close in", async () => {
    const run = arenaRun(await base(), {});
    const far = onGrid(at(hero(run), 0, 0), at(monster("a"), 5, 0));
    const options = nextDndDecision(far, run)?.options.map((item) => item.id);
    expect(options).not.toContain(`${sword}|a`);
    expect(options).toContain(MOVE);

    const moved = settle(
      run,
      far,
      [act(PLAYER_ACTOR, MOVE)],
      HIGH,
      () => "4,0",
    );
    expect(actor(moved.state, PLAYER_ACTOR).position).toEqual({ x: 4, y: 0 });
    expect(actor(moved.state, PLAYER_ACTOR).moved).toBe(20);
    expect(
      nextDndDecision(moved.state, run)?.options.map((item) => item.id),
    ).toContain(`${sword}|a`);
  });

  it("can't move further than its speed", async () => {
    const run = arenaRun(await base(), {});
    const state = onGrid(at(hero(run), 0, 0), at(monster("a"), 11, 11));
    const [decision] = settle(
      run,
      state,
      [act(PLAYER_ACTOR, MOVE)],
      HIGH,
      () => "stay",
    ).decisions;
    const squares = (decision?.options ?? []).flatMap((item) => {
      const [x, y] = item.id.split(",").map(Number);
      return x === undefined || y === undefined ? [] : [{ x, y }];
    });
    expect(squares.length).toBeGreaterThan(0);
    for (const square of squares) {
      expect(distanceFeet({ x: 0, y: 0 }, square)).toBeLessThanOrEqual(30);
    }
  });

  it("gives an enemy an Opportunity Attack when the hero leaves its reach", async () => {
    const run = arenaRun(await base(), {});
    const state = onGrid(at(hero(run), 0, 0), at(monster("a"), 1, 0));
    const left = settle(
      run,
      state,
      [act(PLAYER_ACTOR, MOVE)],
      HIGH,
      () => "0,4",
    );
    expect(actor(left.state, "a").budget.reaction).toBe(false);
    expect(damageOf(left.events, PLAYER_ACTOR).length).toBe(1);
    expect(actor(left.state, PLAYER_ACTOR).position).toEqual({ x: 0, y: 4 });

    const stayed = settle(
      run,
      state,
      [act(PLAYER_ACTOR, MOVE)],
      HIGH,
      () => "0,1",
    );
    expect(damageOf(stayed.events, PLAYER_ACTOR)).toEqual([]);
  });

  it("catches only the creatures near where a Fireball is aimed", async () => {
    const run = arenaRun(await base(), {});
    const state = onGrid(
      at(hero(run, { spells: ["fireball"] }), 0, 0),
      at(monster("a"), 6, 6),
      at(monster("b"), 7, 7),
      at(monster("c"), 11, 0),
    );
    const cast = `spell:${spell("fireball")}|aim`;
    expect(
      nextDndDecision(state, run)?.options.map((item) => item.id),
    ).toContain(cast);
    const burned = settle(run, state, [act(PLAYER_ACTOR, cast)], LOW, (d) =>
      d.id.startsWith(`${NS}:aim:`) ? "6,6" : (d.options[0]?.id ?? ""),
    );
    expect(
      burned.decisions[0]?.options.find((o) => o.id === "6,6")?.label,
    ).toBe("G7: catches a and b");
    expect(damageOf(burned.events, "a").length).toBe(1);
    expect(damageOf(burned.events, "b").length).toBe(1);
    expect(damageOf(burned.events, "c")).toEqual([]);
  });

  it("tells the board each area's shape, so it can outline where it lands", async () => {
    const run = arenaRun(await base(), {});
    const state = onGrid(
      at(hero(run, { spells: ["fireball"] }), 0, 0),
      at(monster("a"), 6, 6),
    );
    const board = dndUi.combat(state, run)?.board as {
      shapes: Record<string, unknown>;
    };
    expect(board.shapes[`spell:${spell("fireball")}`]).toEqual({
      area: { shape: "sphere", radius: 20 },
      range: 150,
      side: "enemy",
    });
  });

  it("warns the board which moves give an Opportunity Attack, with the route", async () => {
    const run = arenaRun(await base(), {});
    const state = onGrid(at(hero(run), 0, 0), at(monster("a"), 1, 0));
    const board = dndUi.combat(state, run)?.board;
    const away = board?.moves.find((move) => move.x === 0 && move.y === 4);
    const near = board?.moves.find((move) => move.x === 0 && move.y === 1);
    expect(away?.provokes).toBe(1);
    expect(away?.path).toHaveLength(4);
    expect(away?.path.at(-1)).toEqual([0, 4]);
    expect(near?.provokes).toBe(0);
  });

  it("walks a monster into reach before it attacks", async () => {
    const run = arenaRun(await base(), {});
    const state = onGrid(at(monster("a"), 0, 0), at(hero(run), 0, 5));
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("No decision");
    const context = contextOf(run, state, HIGH);
    expect(choosePolicy(decision, context)).toBe(MOVE);
    const walked = settle(run, state, [act("a", MOVE)], HIGH, (asked) =>
      choosePolicy(asked, contextOf(run, state, HIGH)),
    );
    expect(
      distanceFeet(actor(walked.state, "a").position, { x: 0, y: 5 }),
    ).toBe(5);
  });
});

describe("battle map ground, cover and light", () => {
  const at = (who: Actor, x: number, y: number): Actor => ({
    ...who,
    position: { x, y },
  });
  const sword = "weapon:srd52:item/longsword";
  const keysOf = (rows: readonly string[]) => ({
    walls: new Set(codeKeys(rows, "#")),
    cover: {
      half: new Set(codeKeys(rows, "h")),
      threeQuarters: new Set(codeKeys(rows, "t")),
    },
  });
  // A fight on a map drawn as rows of codes, with the light everywhere else.
  const onMap = (
    rows: readonly string[],
    actors: readonly Actor[],
    light: "bright" | "dim" | "dark" = "bright",
  ): DndState => {
    const state = fight(...actors);
    // A map needs two rows at least, so a one-row picture gets an open one below.
    const drawn =
      rows.length > 1 ? rows : [...rows, ".".repeat(rows[0]?.length ?? 0)];
    const y = drawn.findIndex((row) => /[^#]/.test(row));
    const open = [drawn[y]?.search(/[^#]/) ?? 0, y];
    const map = BattlemapSchema.parse({
      image: "assets/map.png",
      imageWidth: 100,
      imageHeight: 100,
      crop: { x: 0, y: 0, width: 100, height: 100 },
      columns: drawn[0]?.length ?? 0,
      rows: drawn.length,
      walls: drawn,
      light,
      // The starts only need to be open: the actors are placed by hand.
      party: [open],
      monsters: [open],
    });
    if (!state.combat) throw new Error("No fight");
    const terrain = terrainOf(map);
    return {
      ...state,
      combat: {
        ...state.combat,
        grid: { width: map.columns, height: map.rows },
        walls: codeKeys(drawn, "#"),
        ...(terrain ? { terrain } : {}),
      },
    };
  };
  const archer = (
    run: RunContext,
    id: string,
    fields: Record<string, unknown> = {},
  ): RunContext =>
    arenaRun(run, {
      [`srd52:monster/${id}`]: dummy(`srd52:monster/${id}`, {
        actions: [
          {
            name: "Shortbow",
            activation: {
              cost: ["action"],
              targeting: { creatures: 1, range: 30, side: "enemy" },
              resolution: {
                kind: "attack",
                attack: { type: "weapon", flatBonus: 4 },
                damage: [{ amount: { dice: "1d6" }, type: "piercing" }],
              },
            },
          },
        ],
        ...fields,
      }),
    });
  const reported = (events: readonly SystemEvent[]) =>
    events.flatMap((event) =>
      event.kind === `${NS}:rollReported` && "payload" in event
        ? [event.payload as { target: number; success: boolean }]
        : [],
    );

  it("keeps old maps valid and checks the new codes and light", () => {
    const map = {
      image: "assets/map.png",
      imageWidth: 300,
      imageHeight: 300,
      crop: { x: 0, y: 0, width: 300, height: 300 },
      columns: 3,
      rows: 3,
      walls: ["...", "##.", "..."],
      party: [[0, 0]],
      monsters: [[0, 2]],
    };
    const old = BattlemapSchema.parse(map);
    expect(terrainOf(old)).toBeNull(); // nothing marked, so the fight is as it was
    const marked = BattlemapSchema.parse({
      ...map,
      walls: ["~ht", "##d", "x.."],
      light: "dim",
    });
    expect(terrainOf(marked)).toEqual({
      difficult: ["0,0"],
      half: ["1,0"],
      threeQuarters: ["2,0"],
      dim: ["2,1"],
      dark: ["0,2"],
      light: "dim",
    });
    expect(
      BattlemapSchema.safeParse({ ...map, walls: ["..?", "##.", "..."] })
        .success,
    ).toBe(false);
    expect(BattlemapSchema.safeParse({ ...map, light: "gloomy" }).success).toBe(
      false,
    );
  });

  it("costs double to walk through difficult terrain", () => {
    const grid = { width: 8, height: 1 };
    const rough = new Set(["1,0", "2,0"]);
    const walk = reachableSquares(
      { x: 0, y: 0 },
      30,
      grid,
      new Set(),
      new Set(),
      rough,
    );
    const feet = (x: number) => walk.find((item) => item.square.x === x)?.feet;
    expect(feet(1)).toBe(10);
    expect(feet(2)).toBe(20);
    expect(feet(4)).toBe(30);
    expect(feet(5)).toBeUndefined();
    // Around is cheaper than through when there's room.
    const wide = reachableSquares(
      { x: 0, y: 1 },
      30,
      { width: 5, height: 3 },
      new Set(),
      new Set(),
      new Set(["1,1", "2,1"]),
    );
    const across = wide.find(
      (item) => item.square.x === 3 && item.square.y === 1,
    );
    expect(across?.feet).toBe(15);
    expect(across?.path.some((square) => square.y === 1 && square.x < 3)).toBe(
      false,
    );
  });

  it("works out cover from walls, cover squares and creatures in the way", () => {
    const cover = (
      rows: readonly string[],
      creatures: readonly string[] = [],
    ) => {
      const { walls, cover: squares } = keysOf(rows);
      return coverBetween(
        { x: 0, y: 1 },
        { x: 4, y: 1 },
        walls,
        squares,
        new Set(creatures),
      );
    };
    expect(cover([".....", ".....", "....."])).toBe(0);
    expect(cover([".....", "..#..", "....."])).toBe(2); // a pillar, as on the DMG's grid
    expect(cover(["..#..", "..#..", "..#.."])).toBe("total");
    expect(cover([".....", "..h..", "....."])).toBe(2);
    expect(cover([".....", "..t..", "....."])).toBe(5);
    expect(cover([".....", ".....", "....."], ["2,1"])).toBe(2);
    // Standing in a cover square gives nothing: only cover between the two counts.
    expect(cover([".....", "....h", "....."])).toBe(0);
    expect(
      coverBetween(
        { x: 0, y: 0 },
        null,
        new Set(),
        keysOf([]).cover,
        new Set(),
      ),
    ).toBe(0);
  });

  it("adds cover to AC against an attack, and to Dexterity saves", async () => {
    const run = arenaRun(await base(), {});
    const open = onMap(
      ["....."],
      [at(hero(run), 0, 0), at(monster("a"), 1, 0)],
    );
    const hit = settle(run, open, [act(PLAYER_ACTOR, `${sword}|a`)], HIGH);
    expect(reported(hit.events)[0]?.target).toBe(10);

    const shot = archer(run, "archer");
    const behind = onMap(
      ["..t.."],
      [at(monster("b", "srd52:monster/archer"), 0, 0), at(hero(shot), 4, 0)],
    );
    const covered = settle(shot, behind, [act("b", "monster:0|player")], HIGH);
    const ac = deriveStats(actor(behind, PLAYER_ACTOR), shot).ac;
    expect(reported(covered.events)[0]?.target).toBe(ac + 5);

    const spit = arenaRun(await base(), {
      "srd52:monster/spitter": dummy("srd52:monster/spitter", {
        actions: [
          {
            name: "Spit",
            activation: {
              cost: ["action"],
              targeting: { creatures: 1, range: 30, side: "enemy" },
              resolution: {
                kind: "save",
                ability: "dex",
                dc: { base: 15 },
                damage: [{ amount: { dice: "1d6" }, type: "acid" }],
              },
            },
          },
        ],
      }),
    });
    const player = hero(spit);
    // A roll that fails by one in the open, and passes with half cover.
    const natural = 14 - saveBonus(deriveStats(player, spit), "dex");
    const dice: Dice = {
      below: () => 0,
      roll: (sides) => (sides === 20 ? natural : 1),
    };
    const spat = (rows: readonly string[]) =>
      damageOf(
        settle(
          spit,
          onMap(rows, [
            at(monster("s", "srd52:monster/spitter"), 0, 0),
            at(player, 4, 0),
          ]),
          [act("s", "monster:0|player")],
          dice,
        ).events,
        PLAYER_ACTOR,
      );
    expect(spat(["....."])).toEqual([1]);
    expect(spat(["..h.."])).toEqual([]);
  });

  it("can't target a creature behind total cover", async () => {
    const run = archer(await base(), "archer");
    const state = onMap(
      ["..#..", "..#..", "..#.."],
      [at(monster("b", "srd52:monster/archer"), 0, 1), at(hero(run), 4, 1)],
    );
    const options = nextDndDecision(state, run)?.options.map((item) => item.id);
    expect(options).not.toContain("monster:0|player");
    const peek = onMap(
      ["..#..", "..#..", "....."],
      [at(monster("b", "srd52:monster/archer"), 0, 1), at(hero(run), 4, 1)],
    );
    expect(
      nextDndDecision(peek, run)?.options.map((item) => item.id),
    ).toContain("monster:0|player");
  });

  it("hides creatures in darkness from those without Darkvision", async () => {
    const run = archer(await base(), "seer", {
      text: "Senses Darkvision 60 ft.; Passive Perception 10",
    });
    const player = hero(run);
    expect(darkvisionOf(player, run)).toBe(0); // a Human
    const seer = monster("v", "srd52:monster/seer");
    expect(darkvisionOf(seer, run)).toBe(60);
    expect(darkvisionOf(monster("a"), run)).toBe(0);
    const dwarf: Actor =
      player.source.kind === "character" && player.source.build
        ? {
            ...player,
            source: {
              ...player.source,
              build: {
                ...player.source.build,
                speciesId: "srd52:species/dwarf",
              },
            },
          }
        : player;
    expect(darkvisionOf(dwarf, run)).toBe(60);

    const dark = onMap(["....."], [at(player, 0, 0), at(seer, 1, 0)], "dark");
    expect(seeing(player, { x: 1, y: 0 }, dark, run)).toBe("none");
    expect(seeing(seer, { x: 0, y: 0 }, dark, run)).toBe("dim");
    // The hero can't see the seer: Disadvantage, so two d20s and no Advantage.
    const swing = countingD20s(HIGH);
    const swung = settle(
      run,
      dark,
      [act(PLAYER_ACTOR, `${sword}|v`)],
      swing.dice,
    );
    expect(swing.d20s()).toBe(2);
    expect(reported(swung.events)).toHaveLength(1);
    // The seer sees the hero, who can't see it back: Advantage, from far enough not to be crowded.
    const apart = onMap(["....."], [at(player, 0, 0), at(seer, 4, 0)], "dark");
    const shoot = countingD20s(HIGH);
    const shot = settle(run, apart, [act("v", "monster:0|player")], shoot.dice);
    expect(shoot.d20s()).toBe(2);
    expect(shot.events.some((event) => event.kind === `${NS}:damaged`)).toBe(
      true,
    );
    // In bright light, one d20 each.
    const lit = countingD20s(HIGH);
    settle(
      run,
      onMap(["....."], [at(player, 0, 0), at(seer, 1, 0)]),
      [act(PLAYER_ACTOR, `${sword}|v`)],
      lit.dice,
    );
    expect(lit.d20s()).toBe(1);
  });

  it("gives Disadvantage on sight-based Perception into dim light", async () => {
    const run = await base();
    const player = hero(run);
    const state = onMap(["..d.x"], [at(player, 0, 0)]);
    expect(seeing(player, { x: 1, y: 0 }, state, run)).toBe("clear");
    expect(seeing(player, { x: 2, y: 0 }, state, run)).toBe("dim");
    expect(seeing(player, { x: 4, y: 0 }, state, run)).toBe("none");
  });

  it("tells the board the terrain, move costs through it and each foe's cover", async () => {
    const run = arenaRun(await base(), {});
    const state = onMap(
      ["~~....", "......", "..h..."],
      [at(hero(run), 0, 2), at(monster("a"), 4, 2)],
    );
    const board = dndUi.combat(state, run)?.board;
    expect(board?.terrain?.difficult).toEqual(["0,0", "1,0"]);
    expect(board?.cover).toEqual({ a: 2 });
    expect(
      board?.moves.find((move) => move.x === 0 && move.y === 0)?.feet,
    ).toBe(15); // 5 to the diagonal, then 10 into the rough square
    expect(
      board?.moves.find((move) => move.x === 0 && move.y === 1)?.feet,
    ).toBe(5);
  });

  it("steps into cover and around difficult terrain", async () => {
    const run = archer(await base(), "archer");
    const player = hero(run);
    const spot = { x: 0, y: 2 };
    // A monster closing to shoot picks a square that's behind the half wall.
    const shooting = onMap(
      [
        "............",
        "............",
        "....h.......",
        "............",
        "............",
      ],
      [
        at(monster("b", "srd52:monster/archer"), 11, 2),
        at(player, spot.x, spot.y),
      ],
    );
    const step = settle(run, shooting, [act("b", MOVE)], HIGH, (asked) =>
      choosePolicy(asked, contextOf(run, shooting, HIGH)),
    );
    const archerNow = actor(step.state, "b");
    expect(distanceFeet(archerNow.position, spot)).toBeLessThanOrEqual(30);
    expect(coverFor(step.state, spot, archerNow, [PLAYER_ACTOR])).toBe(2);

    // A melee monster ends beside the hero on firm ground.
    const rough = onMap(
      [".....", ".~...", "....."],
      [at(monster("a"), 4, 1), at(player, 0, 1)],
    );
    const walked = settle(
      arenaRun(run, {}),
      rough,
      [act("a", MOVE)],
      HIGH,
      (asked) => choosePolicy(asked, contextOf(run, rough, HIGH)),
    );
    const there = actor(walked.state, "a").position;
    expect(distanceFeet(there, { x: 0, y: 1 })).toBe(5);
    expect(there).not.toEqual({ x: 1, y: 1 });
  });

  it("walks round a long wall to get a line on a foe it can't see through it", async () => {
    const run = archer(await base(), "archer");
    // In bow range, but the wall runs further than one move: straight-line distance would only lead away.
    const corridor = onMap(
      [
        "######",
        ".#....",
        ".#....",
        ".#....",
        ".#....",
        ".#....",
        ".#....",
        ".#....",
        ".#....",
        ".#....",
        "......",
      ],
      [at(monster("b", "srd52:monster/archer"), 0, 1), at(hero(run), 3, 1)],
    );
    const decision = nextDndDecision(corridor, run);
    if (!decision) throw new Error("No decision");
    expect(decision.options.map((item) => item.id)).not.toContain(
      "monster:0|player",
    );
    const context = contextOf(run, corridor, HIGH);
    expect(choosePolicy(decision, context)).toBe(MOVE);
    const walked = settle(run, corridor, [act("b", MOVE)], HIGH, (asked, now) =>
      choosePolicy(asked, contextOf(run, now, HIGH)),
    );
    expect(actor(walked.state, "b").position).toEqual({ x: 0, y: 7 });
  });

  it("goes for a foe in the open before one behind three-quarters cover", async () => {
    const run = archer(await base(), "archer");
    const state = onMap(
      [".....", "..t..", "....."],
      [
        at(monster("b", "srd52:monster/archer"), 0, 1),
        at(hero(run, { hp: 5 }), 4, 1),
        at(hero(run, { id: "ally", hp: 50 }), 2, 2), // off the line through the cover
      ],
    );
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("No decision");
    expect(choosePolicy(decision, contextOf(run, state, HIGH))).toBe(
      "monster:0|ally",
    );
  });

  it("plays a whole fight on a map with cover to the end", async () => {
    const run = archer(await base(), "archer", { hp: 12 });
    const party = [hero(run), hero(run, { id: "ally" })];
    const rows = ["........", "..h..t..", "...##...", "..~~~...", "........"];
    const battlemap = BattlemapSchema.parse({
      image: "assets/map.png",
      imageWidth: 800,
      imageHeight: 500,
      crop: { x: 0, y: 0, width: 800, height: 500 },
      columns: 8,
      rows: 5,
      walls: rows,
      party: [
        [0, 4],
        [1, 4],
      ],
      monsters: [
        [6, 0],
        [7, 0],
      ],
    });
    const started = startCombat(
      {
        id: "e",
        monsters: [{ monster: "srd52:monster/archer", count: 2 }],
        battlemap,
      },
      contextOf(run, fight(...party), HIGH),
      { canFlee: false, defeatContinues: false },
    );
    let state = (started.events ?? []).reduce<DndState>(
      (current, event) => applyDndEvent(current, event),
      {
        actors: Object.fromEntries(party.map((item) => [item.id, item])),
        combat: null,
      },
    );
    expect(state.combat?.terrain?.half).toEqual(["2,1"]);
    const dice = createDice(rngFromSeed("cover"));
    const events: SystemEvent[] = [];
    for (let turn = 0; turn < 200 && state.combat; turn += 1) {
      const decision = nextDndDecision(state, run);
      if (!decision) break;
      const answer = (asked: Decision, now: DndState): string =>
        choosePolicy(asked, contextOf(run, now, dice));
      const result = settle(
        run,
        state,
        [
          {
            kind: decision.resume.kind,
            payload: {
              ...decision.resume.payload,
              answer: answer(decision, state),
            },
          },
        ],
        dice,
        answer,
      );
      events.push(...result.events);
      state = result.state;
    }
    // Someone shot past the half wall or the pillar, against AC raised by cover.
    const heroAc = deriveStats(actor(state, PLAYER_ACTOR), run).ac;
    expect(reported(events).map((roll) => roll.target)).toContain(heroAc + 2);
    expect(state.combat).toBeNull();
    expect(reported(events).length).toBeGreaterThan(0);
  });
});

describe("difficulty helpers", () => {
  it("builds a pregen on the fullest class of its name when two books have one", async () => {
    const run = await base();
    const wizard = ClassSchema.parse(run.content("srd52:class/wizard"));
    const [first] = wizard.levels;
    if (!first) throw new Error("The wizard has no levels");
    // A second book's Wizard whose id sorts first, as the Handbook's does before the SRD's.
    const unsorted = arenaRun(run, {
      "a-book:class/wizard": {
        ...wizard,
        id: "a-book:class/wizard",
        levels: Array.from({ length: 20 }, (_, index) => ({
          ...first,
          level: index + 1,
        })),
      },
    });
    // The real loader sorts content ids, so the test does too.
    const fuller = {
      ...unsorted,
      contentIds: () => [...unsorted.contentIds()].sort(),
    };
    const chosen = fuller.system.frames[`${NS}:characterChosen`]?.run(
      { answer: "srd52:pregen/wizard" },
      contextOf(fuller, { actors: {}, combat: null }, HIGH),
    );
    const event = chosen?.events?.find(
      (item) => item.kind === `${NS}:characterChosen`,
    );
    const build = (event && "payload" in event ? event.payload : {}) as {
      build?: { levels: readonly { classId: string }[] };
    };
    expect(build.build?.levels.map((level) => level.classId)).toEqual([
      "a-book:class/wizard",
    ]);
  });

  it("flees a fight the party clearly can't win, when fleeing is offered", async () => {
    const run = arenaRun(await base(), {});
    const state = fight(
      hero(run, { hp: 5 }),
      monster("a", "srd52:monster/dummy", 500),
    );
    const fleeing: DndState = state.combat
      ? { ...state, combat: { ...state.combat, canFlee: true } }
      : state;
    const decision = nextDndDecision(fleeing, run);
    if (!decision) throw new Error("No decision");
    expect(choosePolicy(decision, contextOf(run, fleeing, HIGH))).toBe("flee");
  });
});

describe("the difficulty setting", () => {
  it("cuts the damage the party takes to a third on Story and adds half on Hard", async () => {
    const run = arenaRun(await base(), {});
    const party = hero(run);
    const foe = monster("a");
    const taken = (difficulty: "story" | "normal" | "hard", target: Actor) =>
      damageEvents(
        target,
        10,
        "slashing",
        false,
        contextOf(run, { ...fight(party, foe), difficulty }, HIGH),
      ).map((event) => ("payload" in event ? event.payload.amount : 0));
    expect(taken("story", party)).toEqual([3]);
    expect(taken("normal", party)).toEqual([10]);
    expect(taken("hard", party)).toEqual([15]);
    expect(taken("story", foe)).toEqual([10]); // monsters take what the dice say
  });

  it("keeps the difficulty through the start and end of a fight", async () => {
    const run = arenaRun(await base(), {});
    const state: DndState = {
      ...fight(hero(run), monster("a")),
      difficulty: "story",
    };
    const ended = applyDndEvent(state, dndEvent(`${NS}:combatEnded`, {}));
    expect(ended.difficulty).toBe("story");
  });
});
