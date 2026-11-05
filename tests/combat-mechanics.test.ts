import {
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { type Dice, createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import { replayInputs } from "../engine/kernel/save.ts";
import type { Input } from "../engine/kernel/events.ts";
import { AWAIT_FRAME } from "../engine/kernel/system.ts";
import { type RunContext, startRun, step } from "../engine/kernel/turn.ts";
import {
  type Context,
  choosePolicy,
  effectEnds,
  nextDndDecision,
  runAttackRoll,
  runTakeAction,
  runLingeringTick,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
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
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  damageResponses,
  deriveStats,
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
  answer: (decision: Decision) => string = (decision) =>
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
