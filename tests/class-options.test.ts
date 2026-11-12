import {
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import { AWAIT_FRAME } from "../engine/kernel/system.ts";
import type { RunContext } from "../engine/run/turn.ts";
import type { Context } from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";

// Metamagic and Font of Magic in a fight, on a made-up sorcerer whose one level grants every option.

const text = "Made up for the tests.";
const METAMAGIC = [
  "careful",
  "distant",
  "empowered",
  "extended",
  "heightened",
  "quickened",
  "seeking",
  "subtle",
  "transmuted",
  "twinned",
];
const option = (name: string) =>
  `test:feature/sorcerer-metamagic-${name}-spell`;
const FONT = "test:feature/sorcerer-font-of-magic";
const ZAP = "spell:test:spell/zap";
const BURST = "spell:test:spell/burst";
const CHARM = "spell:test:spell/charm";
const MEND = "spell:test:spell/mend";

// A made-up warlock whose level 1 offers each invocation, and the invocations as data.
const invocation = (name: string) => `test:feature/warlock-${name}`;
const cha = { kind: "abilityMod", ability: "cha" };
const INVOCATIONS: Record<string, Record<string, unknown>> = {
  agonizing: {
    passives: [{ kind: "cantripRider", damage: { base: 0, add: [cha] } }],
    prerequisite: { level: 2, cantrip: "damage" },
  },
  repelling: {
    passives: [
      {
        kind: "cantripRider",
        attackOnly: true,
        onHit: [{ kind: "forcedMove", feet: 10, direction: "away" }],
      },
    ],
    prerequisite: { cantrip: "attack" },
  },
  spear: {
    passives: [
      {
        kind: "cantripRider",
        rangePerLevel: { class: "test:class/warlock", feet: 30 },
      },
    ],
  },
  armor: {
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "acFormula",
          formula: { base: 13, add: [{ kind: "abilityMod", ability: "dex" }] },
        },
      },
    ],
  },
  sight: { passives: [{ kind: "seesInDarkness", feet: 120 }] },
  mind: { passives: [{ kind: "concentrationAdvantage" }] },
  blade: { passives: [{ kind: "pactWeapon" }] },
  drinker: {
    passives: [
      {
        kind: "pactWeapon",
        damage: [{ amount: { dice: "1d6" }, type: "necrotic" }],
      },
    ],
    prerequisite: { features: [invocation("blade")] },
  },
  thirst: {
    passives: [{ kind: "multiattack", attacks: 2 }],
    prerequisite: { level: 5, features: [invocation("blade")] },
  },
  smite: {
    resources: [
      {
        id: "smite",
        max: { base: 1 },
        recharge: [{ on: "turnStart", amount: "all" }],
      },
    ],
    activations: [
      {
        cost: ["slot", { resource: "smite" }],
        trigger: { afterHit: "meleeWeapon" },
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "automatic",
          damage: [{ amount: { dice: "1d8" }, type: "force" }],
          effects: [
            {
              kind: "applyCondition",
              condition: "prone",
              duration: { until: "yourNextTurnStart" },
            },
          ],
        },
      },
    ],
    upcast: { perSlotLevel: { addDice: "1d8" } },
  },
  vigor: {
    activations: [
      {
        cost: ["action"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "tempHp", amount: { bonus: { base: 12 } } }],
        },
      },
    ],
  },
  tome: {
    choices: [
      { kind: "spells", id: "tome-cantrips", count: 1, maxLevel: 0 },
      {
        kind: "spells",
        id: "tome-rituals",
        count: 1,
        maxLevel: 1,
        ritual: true,
      },
    ],
  },
};
const WARLOCK = [
  ...Object.entries(INVOCATIONS).map(([name, fields]) => ({
    id: invocation(name),
    name,
    text,
    automation: "full",
    ...fields,
  })),
  {
    id: "test:class/warlock",
    name: "Warlock",
    hitDie: "d8",
    primaryAbilities: ["cha"],
    savingThrows: ["wis", "cha"],
    weapons: ["simple", "martial"],
    armor: ["light"],
    spellcasting: { ability: "cha" },
    levels: Array.from({ length: 5 }, (_, index) => ({
      level: index + 1,
      grants: [],
      choices: [
        {
          kind: "option",
          id: "invocations",
          count: 1,
          from: Object.keys(INVOCATIONS).map(invocation),
        },
      ],
      slots: index < 2 ? [1] : [0, 0, 2],
    })),
  },
  {
    id: "test:spell/blast",
    name: "Blast",
    level: 0,
    school: "evocation",
    classes: ["test:class/warlock"],
    castingTime: "Action",
    range: "120 feet",
    components: "V",
    duration: "instantaneous",
    text,
    automation: "full",
    activation: {
      cost: ["action"],
      targeting: { creatures: 1, range: 120, side: "enemy" },
      resolution: {
        kind: "attack",
        attack: { type: "spell" },
        damage: [{ amount: { dice: "1d10" }, type: "force" }],
      },
    },
  },
  {
    id: "test:spell/sing",
    name: "Sing",
    level: 1,
    ritual: true,
    school: "enchantment",
    classes: ["test:class/bard"],
    castingTime: "Action",
    range: "Self",
    components: "V",
    duration: "instantaneous",
    text,
    automation: "text",
  },
];

const content = [
  ...METAMAGIC.map((name) => ({
    id: option(name),
    name: `${name} spell`,
    text,
    automation: "full",
  })),
  {
    id: FONT,
    name: "Font",
    text,
    automation: "partial",
    resources: [
      {
        id: "sorcery-points",
        max: { add: [{ kind: "scaling", key: "sorceryPoints" }] },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  },
  {
    id: "test:class/sorcerer",
    name: "Sorcerer",
    hitDie: "d6",
    primaryAbilities: ["cha"],
    savingThrows: ["con", "cha"],
    weapons: [],
    armor: [],
    spellcasting: { ability: "cha" },
    levels: Array.from({ length: 5 }, (_, index) => ({
      level: index + 1,
      grants: index === 0 ? [FONT, ...METAMAGIC.map(option)] : [],
      slots: [4, 3, 2],
      scaling: { sorceryPoints: 5 },
    })),
  },
  {
    id: "test:spell/zap",
    name: "Zap",
    level: 1,
    school: "evocation",
    classes: ["test:class/sorcerer"],
    castingTime: "Action",
    range: "60 feet",
    components: "V",
    duration: "instantaneous",
    text,
    automation: "full",
    activation: {
      cost: ["action", "slot"],
      targeting: { creatures: 1, range: 60, side: "enemy" },
      resolution: {
        kind: "attack",
        attack: { type: "spell" },
        damage: [{ amount: { dice: "4d6" }, type: "fire" }],
      },
    },
  },
  {
    id: "test:spell/burst",
    name: "Burst",
    level: 1,
    school: "evocation",
    classes: ["test:class/sorcerer"],
    castingTime: "Action",
    range: "Self",
    components: "V",
    duration: "instantaneous",
    text,
    automation: "full",
    activation: {
      cost: ["action", "slot"],
      targeting: {
        area: { shape: "emanation", radius: 10 },
        range: "self",
        side: "enemy",
      },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: { add: [{ kind: "spellSaveDc" }] },
        damage: [{ amount: { dice: "2d6" }, type: "thunder" }],
        onSuccessDamage: "half",
      },
    },
  },
  {
    id: "test:spell/charm",
    name: "Charm",
    level: 1,
    school: "enchantment",
    classes: ["test:class/sorcerer"],
    castingTime: "Action",
    range: "30 feet",
    components: "V",
    duration: { concentration: true, minutes: 1 },
    text,
    automation: "full",
    activation: {
      cost: ["action", "slot"],
      targeting: { creatures: 1, range: 30, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "wis",
        dc: { add: [{ kind: "spellSaveDc" }] },
        onFail: [
          {
            kind: "applyCondition",
            condition: "charmed",
            duration: { concentration: true, minutes: 1 },
          },
        ],
      },
    },
    upcast: { perSlotLevel: { addTargets: 1 } },
  },
  {
    id: "test:spell/mend",
    name: "Mend",
    level: 1,
    school: "evocation",
    classes: ["test:class/sorcerer"],
    castingTime: "Action",
    range: "Touch",
    components: "V",
    duration: "instantaneous",
    text,
    automation: "full",
    activation: {
      cost: ["action", "slot"],
      targeting: { creatures: 1, range: "touch", side: "ally" },
      resolution: {
        kind: "automatic",
        effects: [{ kind: "heal", amount: { dice: "1d8" } }],
      },
    },
  },
  {
    id: "test:monster/dummy",
    name: "Dummy",
    ac: 10,
    hp: 100,
    speed: 30,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    proficiency: 2,
    initiative: 0,
    actions: [],
  },
  ...WARLOCK,
];

function withContent(run: RunContext): RunContext {
  const byId = new Map<string, unknown>(content.map((item) => [item.id, item]));
  return {
    ...run,
    content: (id) =>
      (byId.get(id) as ReturnType<RunContext["content"]>) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

// Every die lands on the next number given, then on its highest face.
function dice(...rolls: number[]): Dice & { readonly rolled: number[] } {
  const rolled: number[] = [];
  return {
    below: () => 0,
    roll: (sides) => {
      const value = rolls.shift() ?? sides;
      rolled.push(value);
      return value;
    },
    rolled,
  };
}

function sorcerer(level = 1, fields: Partial<Actor> = {}): Actor {
  const actor = freshActor({
    id: PLAYER_ACTOR,
    name: "Sorcerer",
    side: "party",
    source: {
      kind: "character",
      build: {
        baseAbilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 16 },
        speciesId: "srd52:species/human",
        backgroundId: "srd52:background/soldier",
        backgroundIncrease: { cha: 2, con: 1 },
        levels: Array.from({ length: level }, () => ({
          classId: "test:class/sorcerer",
          hitPointGain: 6,
          answers: [
            {
              kind: "spells",
              values: [
                "test:spell/zap",
                "test:spell/burst",
                "test:spell/charm",
                "test:spell/mend",
              ],
            },
          ],
        })),
      },
    },
    hp: 30,
    inventory: [],
  });
  return { ...actor, ...fields };
}

function creature(
  id: string,
  side: "party" | "enemy",
  x: number,
  hp = 100,
): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side,
      source: { kind: "monster", statBlockId: "test:monster/dummy" },
      hp,
      inventory: [],
    }),
    position: { x, y: 0 },
  };
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
      grid: { width: 20, height: 5 },
    },
  };
}

interface Settled {
  readonly state: DndState;
  readonly events: readonly SystemEvent[];
  readonly decisions: readonly Decision[];
}

let run: RunContext;

// A small copy of the kernel's loop: each decision met is answered by the next answer given, or its first option.
function settle(
  start: DndState,
  frames: readonly Frame[],
  rolls: Dice,
  answers: string[] = [],
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
          answer: answers.shift() ?? decision.options[0]?.id ?? "",
        },
      });
      continue;
    }
    const definition = run.system.frames[top.kind];
    if (!definition) throw new Error(`Unknown frame ${top.kind}`);
    const context: Context = {
      state,
      dice: rolls,
      content: run.content,
      contentIds: run.contentIds,
    };
    const result = definition.run(top.payload, context);
    for (const event of result.events ?? []) {
      events.push(event);
      state = applyDndEvent(state, event);
    }
    stack.push(...[...(result.frames ?? [])].reverse());
  }
  return { state, events, decisions };
}

const act = (answer: string, actor = PLAYER_ACTOR): Frame => ({
  kind: `${NS}:takeAction`,
  payload: { actor, answer },
});
const ready =
  (name: string, answer: string, rolls = dice()) =>
  (state: DndState) =>
    settle(state, [act(`tactic:metamagic|${option(name)}`)], rolls, [answer])
      .state;

function turn(state: DndState): Decision {
  const decision = run.system.nextDecision(state, run);
  if (!decision) throw new Error("No decision");
  return decision;
}

function payloads(events: readonly SystemEvent[], kind: string) {
  return events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
}

const pointsSpent = (state: DndState): number =>
  state.actors[PLAYER_ACTOR]?.resourcesSpent["sorcery-points"] ?? 0;

const playerIn = (state: DndState): Actor => {
  const actor = state.actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  return actor;
};

beforeAll(async () => {
  run = withContent((await loadAdventure("goblin-ambush")).run);
});

describe("Metamagic", () => {
  it("is offered in the turn for the options known, with their cost", () => {
    const labels = turn(
      fight(sorcerer(), creature("a", "enemy", 2)),
    ).options.map((item) => item.label);
    expect(labels).toContain("Metamagic: quickened spell (2 Sorcery Points)");
    expect(labels).toContain("Metamagic: twinned spell (1 Sorcery Point)");
  });

  it("Quickened Spell casts an action spell as a Bonus Action and spends 2 points", () => {
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 } }),
      creature("a", "enemy", 2),
    );
    const readied = ready("quickened", ZAP)(start);
    const listed = turn(readied).options.find((item) =>
      item.id.startsWith(`${ZAP}|a`),
    );
    expect(listed?.label).toContain("Zap (Quickened)");
    const done = settle(readied, [act(`${ZAP}|a`)], dice());
    const hero = playerIn(done.state);
    expect(hero.budget.action).toBe(true);
    expect(hero.budget.bonusAction).toBe(false);
    expect(pointsSpent(done.state)).toBe(2);
    // The option is used up with the cast.
    expect(
      hero.activeEffects.some((item) => item.sourceId === option("quickened")),
    ).toBe(false);
  });

  it("Distant Spell doubles a range, and makes Touch 30 feet", () => {
    const readied = ready(
      "distant",
      CHARM,
    )(
      fight(
        sorcerer(1, { position: { x: 0, y: 0 } }),
        creature("a", "enemy", 2),
      ),
    );
    const charm = deriveStats(playerIn(readied), run).actions.find(
      (item) => item.id === CHARM,
    );
    expect(charm?.activation.targeting).toMatchObject({ range: 60 });
    const touched = ready(
      "distant",
      MEND,
    )(
      fight(
        sorcerer(1, { position: { x: 0, y: 0 } }),
        creature("a", "enemy", 2),
      ),
    );
    const mend = deriveStats(playerIn(touched), run).actions.find(
      (item) => item.id === MEND,
    );
    expect(mend?.activation.targeting).toMatchObject({ range: 30 });
  });

  it("Twinned Spell gives a spell that gains targets one more", () => {
    const readied = ready(
      "twinned",
      CHARM,
    )(
      fight(
        sorcerer(1, { position: { x: 0, y: 0 } }),
        creature("a", "enemy", 2),
        creature("b", "enemy", 3),
      ),
    );
    const charm = deriveStats(playerIn(readied), run).actions.find(
      (item) => item.id === CHARM,
    );
    expect(charm?.activation.targeting).toMatchObject({ creatures: 2 });
    // Only a spell that gains targets from a higher slot can be twinned.
    const offered = settle(
      fight(sorcerer(1), creature("a", "enemy", 2)),
      [act(`tactic:metamagic|${option("twinned")}`)],
      dice(),
    ).decisions[0]?.options.map((item) => item.id);
    expect(offered).toEqual([CHARM, "back"]);
  });

  it("Careful Spell spares the caster's side from a save's damage", () => {
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 } }),
      creature("ally", "party", 1),
      creature("a", "enemy", 2),
    );
    const done = settle(
      ready("careful", BURST)(start),
      [act(`${BURST}|all`)],
      dice(),
    );
    const saves = payloads(done.events, "saveRolled").map((item) => item.actor);
    expect(saves).not.toContain("ally");
    expect(saves).toContain("a");
    expect(done.state.actors.ally?.hp).toBe(100);
    expect(pointsSpent(done.state)).toBe(1);
  });

  it("Heightened Spell rolls the target's save with Disadvantage", () => {
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 } }),
      creature("a", "enemy", 2),
    );
    // Two d20s, 18 then 3: with Disadvantage the 3 counts and the save fails.
    const done = settle(
      ready("heightened", CHARM)(start),
      [act(`${CHARM}|a`)],
      dice(18, 3),
    );
    expect(payloads(done.events, "saveRolled")[0]).toMatchObject({
      natural: 3,
      success: false,
    });
    expect(pointsSpent(done.state)).toBe(2);
  });

  it("Empowered Spell rerolls low damage dice once", () => {
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 } }),
      creature("a", "enemy", 2),
    );
    // The attack hits on 15; the 4d6 come up 1, 1, 6, 6 and the two 1s are rolled again as 6s.
    const done = settle(
      ready("empowered", ZAP)(start),
      [act(`${ZAP}|a`)],
      dice(15, 1, 1, 6, 6, 6, 6),
    );
    expect(payloads(done.events, "damaged")[0]?.amount).toBe(24);
  });

  it("Extended Spell gives Advantage on saves to keep its Concentration", () => {
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 } }),
      creature("a", "enemy", 2),
    );
    const cast = settle(
      ready("extended", CHARM)(start),
      [act(`${CHARM}|a`)],
      dice(2),
    ).state;
    expect(playerIn(cast).concentratingOn).toBe(CHARM);
    // A Concentration save rolls two d20s and keeps the higher.
    const save = settle(
      cast,
      [
        {
          kind: `${NS}:concentrationSave`,
          payload: { actor: PLAYER_ACTOR, dc: 10 },
        },
      ],
      dice(2, 19),
    );
    expect(payloads(save.events, "saveRolled")[0]).toMatchObject({
      natural: 19,
      success: true,
    });
  });

  it("Subtle Spell keeps a hidden caster hidden", () => {
    const hidden: Actor["activeEffects"][number] = {
      sourceId: "tactic:hide",
      casterId: PLAYER_ACTOR,
      modifier: { kind: "tactic", tactic: "hidden", value: 20 },
      ends: "casterNextTurn",
    };
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 }, activeEffects: [hidden] }),
      creature("a", "enemy", 2),
    );
    const done = settle(
      ready("subtle", CHARM)(start),
      [act(`${CHARM}|a`)],
      dice(2),
    );
    expect(
      playerIn(done.state).activeEffects.some(
        (item) => item.sourceId === "tactic:hide",
      ),
    ).toBe(true);
  });

  it("Seeking Spell rerolls a missed spell attack, and costs its point only then", () => {
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 } }),
      creature("a", "enemy", 2),
    );
    const missed = settle(
      ready("seeking", ZAP)(start),
      [act(`${ZAP}|a`)],
      dice(2, 15),
    );
    expect(
      payloads(missed.events, "rollReported").map((item) => item.natural),
    ).toEqual([2, 15]);
    expect(pointsSpent(missed.state)).toBe(1);
    const hit = settle(
      ready("seeking", ZAP)(start),
      [act(`${ZAP}|a`)],
      dice(15),
    );
    expect(pointsSpent(hit.state)).toBe(0);
  });

  it("Transmuted Spell changes the damage type chosen", () => {
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 } }),
      creature("a", "enemy", 2),
    );
    // The types run acid, cold, fire, lightning, poison, thunder: 1 is cold.
    const done = settle(
      ready("transmuted", `${ZAP}|1`)(start),
      [act(`${ZAP}|a`)],
      dice(15),
    );
    expect(payloads(done.events, "damaged")[0]?.type).toBe("cold");
  });

  it("only takes options that combine, and not more points than are left", () => {
    const start = fight(
      sorcerer(1, { position: { x: 0, y: 0 } }),
      creature("a", "enemy", 2),
    );
    const quickened = ready("quickened", ZAP)(start);
    // Empowered joins Quickened on Zap, but Distant doesn't.
    const spells = (name: string) =>
      settle(
        quickened,
        [act(`tactic:metamagic|${option(name)}`)],
        dice(),
      ).decisions[0]?.options.map((item) => item.id) ?? [];
    expect(spells("empowered")).toContain(ZAP);
    expect(spells("distant")).not.toContain(ZAP);
    // 5 points, 2 promised to Quickened and 3 spent: Heightened's 2 are too many.
    const spent = {
      ...quickened,
      actors: {
        ...quickened.actors,
        [PLAYER_ACTOR]: {
          ...playerIn(quickened),
          resourcesSpent: { "sorcery-points": 2 },
        },
      },
    };
    const labels = turn(spent).options.map((item) => item.label);
    expect(labels.some((label) => label.includes("heightened"))).toBe(false);
    expect(labels.some((label) => label.includes("careful"))).toBe(true);
  });
});

describe("Font of Magic", () => {
  it("turns a spell slot into Sorcery Points, no more than were spent", () => {
    const start = fight(
      sorcerer(3, { resourcesSpent: { "sorcery-points": 2 } }),
      creature("a", "enemy", 2),
    );
    const labels = turn(start).options.map((item) => item.id);
    expect(labels).toContain("tactic:font-points|3");
    const done = settle(start, [act("tactic:font-points|3")], dice());
    expect(playerIn(done.state).resourcesSpent).toEqual({ "slot:3": 1 });
  });

  it("makes a spell slot as a Bonus Action from Sorcery Points", () => {
    const start = fight(
      sorcerer(3, { resourcesSpent: { "slot:2": 1 } }),
      creature("a", "enemy", 2),
    );
    // A level 3 slot needs Sorcerer level 5.
    expect(turn(start).options.map((item) => item.id)).not.toContain(
      "tactic:font-slot|3",
    );
    const done = settle(start, [act("tactic:font-slot|2")], dice());
    const hero = playerIn(done.state);
    expect(hero.resourcesSpent).toEqual({ "sorcery-points": 3 });
    expect(hero.budget.bonusAction).toBe(false);
  });
});

describe("Metamagic for companions", () => {
  it("quickens a spell once the action is spent", () => {
    const start = fight(
      sorcerer(1, {
        position: { x: 0, y: 0 },
        budget: { action: false, bonusAction: true, reaction: true },
      }),
      creature("a", "enemy", 2),
    );
    const first = run.system.decidePolicy(turn(start), {
      state: start,
      dice: dice(),
      content: run.content,
      contentIds: run.contentIds,
    });
    expect(first).toBe(`tactic:metamagic|${option("quickened")}`);
  });
});

function warlock(
  level: number,
  picks: readonly string[],
  fields: Partial<Actor> = {},
): Actor {
  const actor = freshActor({
    id: PLAYER_ACTOR,
    name: "Warlock",
    side: "party",
    source: {
      kind: "character",
      build: {
        baseAbilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 16 },
        speciesId: "srd52:species/human",
        backgroundId: "srd52:background/soldier",
        backgroundIncrease: { cha: 2, con: 1 },
        levels: Array.from({ length: level }, (_, index) => ({
          classId: "test:class/warlock",
          hitPointGain: 8,
          answers:
            index === 0
              ? [
                  { kind: "spells" as const, values: ["test:spell/blast"] },
                  {
                    kind: "features" as const,
                    values: picks.map(invocation),
                  },
                ]
              : [],
        })),
      },
    },
    hp: 30,
    inventory: ["srd52:item/longsword"],
  });
  return { ...actor, position: { x: 0, y: 0 }, ...fields };
}

const BLAST = "spell:test:spell/blast";
const SWORD = "weapon:srd52:item/longsword";
const statsOf = (actor: Actor) => deriveStats(actor, run);
const actionOf = (actor: Actor, id: string) => {
  const action = statsOf(actor).actions.find((item) => item.id === id);
  if (!action) throw new Error(`No ${id}`);
  return action;
};

describe("Eldritch Invocations", () => {
  it("Agonizing Blast adds Charisma to the damaging cantrip", () => {
    const done = settle(
      fight(warlock(2, ["agonizing"]), creature("a", "enemy", 2)),
      [act(`${BLAST}|a`)],
      dice(15),
    );
    // 1d10 at its highest and Charisma 18's +4.
    expect(payloads(done.events, "damaged")[0]?.amount).toBe(14);
  });

  it("Repelling Blast pushes the creature hit 10 feet away", () => {
    const done = settle(
      fight(warlock(2, ["repelling"]), creature("a", "enemy", 2)),
      [act(`${BLAST}|a`)],
      dice(15),
    );
    expect(done.state.actors.a?.position).toEqual({ x: 4, y: 0 });
  });

  it("Eldritch Spear adds 30 feet of range per Warlock level", () => {
    expect(
      actionOf(warlock(3, ["spear"]), BLAST).activation.targeting,
    ).toMatchObject({ range: 210 });
  });

  it("Armor of Shadows sets AC to 13 + Dexterity", () => {
    expect(statsOf({ ...warlock(1, ["armor"]), inventory: [] }).ac).toBe(15);
  });

  it("Devil's Sight sees 120 feet through darkness", async () => {
    const { darkvisionOf } =
      await import("../plugins/systems/dnd5.5e/core/sight.ts");
    expect(darkvisionOf(warlock(2, ["sight"]), run)).toBe(120);
    expect(darkvisionOf(warlock(2, []), run)).toBe(0);
  });

  it("Eldritch Mind gives Advantage on Concentration saves", () => {
    const save = settle(
      fight(
        warlock(1, ["mind"], { concentratingOn: "spell:test:spell/charm" }),
        creature("a", "enemy", 2),
      ),
      [
        {
          kind: `${NS}:concentrationSave`,
          payload: { actor: PLAYER_ACTOR, dc: 10 },
        },
      ],
      dice(2, 19),
    );
    expect(payloads(save.events, "saveRolled")[0]).toMatchObject({
      natural: 19,
    });
  });

  it("Pact of the Blade attacks with Charisma, and Lifedrinker adds necrotic damage", () => {
    const sword = actionOf(warlock(2, ["blade", "drinker"]), SWORD).activation
      .resolution;
    expect(sword.kind === "attack" && sword.attack.ability).toBe("cha");
    expect(sword.damage.map((item) => item.type)).toEqual([
      "slashing",
      "necrotic",
    ]);
    expect(statsOf(warlock(5, ["blade", "thirst"])).multiattack).toBe(2);
  });

  it("Eldritch Smite spends a pact slot for force damage by its level, and knocks the target prone", () => {
    const done = settle(
      fight(warlock(5, ["blade", "smite"]), creature("a", "enemy", 1)),
      [act(`${SWORD}|a`)],
      dice(15),
      [`feature:${invocation("smite")}:0|a`],
    );
    // A level 3 slot: 1d8 and 3d8 more, all at their highest.
    expect(
      payloads(done.events, "damaged").find((item) => item.type === "force")
        ?.amount,
    ).toBe(32);
    const hero = playerIn(done.state);
    expect(hero.resourcesSpent).toMatchObject({ "slot:3": 1 });
    expect(
      payloads(done.events, "resourceSpent").map((item) => item.resource),
    ).toContain("smite");
    expect(
      done.state.actors.a?.activeEffects.some(
        (item) =>
          item.modifier.kind === "condition" &&
          item.modifier.condition === "prone",
      ),
    ).toBe(true);
  });

  it("Fiendish Vigor gives the most Temporary Hit Points, with no slot", () => {
    const done = settle(
      fight(warlock(2, ["vigor"]), creature("a", "enemy", 5)),
      [act(`feature:${invocation("vigor")}:0|${PLAYER_ACTOR}`)],
      dice(),
    );
    expect(playerIn(done.state).tempHp).toBe(12);
  });
});

describe("invocation prerequisites", () => {
  const offered = async (base: Actor | null): Promise<readonly string[]> => {
    const { choiceOptions } =
      await import("../plugins/systems/dnd5.5e/core/character.ts");
    const { ClassSchema } =
      await import("../plugins/systems/dnd5.5e/core/schemas.ts");
    const classDef = ClassSchema.parse(run.content("test:class/warlock"));
    const [choice] = classDef.levels[0]?.choices ?? [];
    if (!choice) throw new Error("No choice");
    const build = base?.source.kind === "character" ? base.source.build : null;
    return choiceOptions(
      choice,
      {
        classId: classDef.id,
        backgroundId: "srd52:background/soldier",
        scores: [],
        picks: {},
      },
      build,
      classDef,
      run,
    ).options.map((item) => item.id.replace(invocation(""), ""));
  };

  it("leaves out what needs a higher level, another invocation or a cantrip", async () => {
    expect(await offered(null)).toEqual([
      "spear",
      "armor",
      "sight",
      "mind",
      "blade",
      "smite",
      "vigor",
      "tome",
    ]);
  });

  it("offers them once they're met", async () => {
    const options = await offered(warlock(1, ["blade"]));
    expect(options).toContain("agonizing");
    expect(options).toContain("repelling");
    expect(options).toContain("drinker");
    expect(options).not.toContain("thirst");
    expect(options).not.toContain("blade");
  });
});

describe("an invocation's own choices", () => {
  it("Pact of the Tome asks for a cantrip and a ritual as it's taken", async () => {
    const { startRun, step } = await import("../engine/run/turn.ts");
    const { CREATE_CHARACTER } =
      await import("../plugins/systems/dnd5.5e/core/combat.ts");
    const { SpellSchema, StateSchema } = await Promise.all([
      import("../plugins/systems/dnd5.5e/core/schemas.ts"),
      import("../plugins/systems/dnd5.5e/core/state.ts"),
    ]).then(([schemas, state]) => ({ ...schemas, ...state }));
    const scene = {
      id: "s0",
      text: "The end.",
      textVariants: [],
      rest: true,
      choices: [],
    };
    const levelling = {
      ...run,
      adventure: { ...run.adventure, startScene: "s0", scenes: [scene] },
    };
    let { state, pending } = startRun(levelling, "tome");
    const asked: Decision[] = [];
    for (let guard = 0; pending && guard < 200; guard += 1) {
      const decision = pending;
      asked.push(decision);
      const ids = decision.options.map((item) => item.id);
      const answer = decision.id.includes("chooseCharacter")
        ? CREATE_CHARACTER
        : decision.id.endsWith(":class")
          ? "test:class/warlock"
          : ids.includes(invocation("tome"))
            ? invocation("tome")
            : (["test:spell/blast", "test:spell/sing"].find((id) =>
                ids.includes(id),
              ) ??
              ids[0] ??
              "");
      const outcome = step(levelling, state, {
        kind: "answer",
        decisionId: decision.id,
        optionId: answer,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      ({ state, pending } = outcome);
    }
    const rituals = asked.find((item) => item.id.includes("tome-rituals"));
    expect(rituals?.options.map((item) => item.id)).toContain(
      "test:spell/sing",
    );
    for (const { id } of rituals?.options ?? []) {
      expect(SpellSchema.parse(run.content(id)).ritual).toBe(true);
    }
    expect(asked.some((item) => item.id.includes("tome-cantrips"))).toBe(true);
    const player = StateSchema.parse(state.system).actors[PLAYER_ACTOR];
    const answers =
      player?.source.kind === "character"
        ? (player.source.build?.levels[0]?.answers ?? [])
        : [];
    expect(
      answers.some(
        (item) =>
          item.kind === "spells" && item.values.includes("test:spell/sing"),
      ),
    ).toBe(true);
  });
});
