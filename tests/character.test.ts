import { PLAYER_ACTOR, type Decision, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { GameEvent, GameState } from "../engine/kernel/events.ts";
import {
  createSave,
  loadSave,
  type LogEntry,
  replayInputs,
} from "../engine/kernel/save.ts";
import {
  type RunContext,
  pendingDecision,
  startRun,
  step,
} from "../engine/kernel/turn.ts";
import type { StoryEffect } from "../engine/story/adventure.ts";
import { testAdventure } from "../engine/tools/bot.ts";
import {
  levelChoices,
  levelForXp,
  startingGear,
  weaponProficient,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  CREATE_CHARACTER,
  canAfford,
  runTakeAction,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  type CharacterBuild,
  ClassSchema,
  FeatureSchema,
  ItemSchema,
  PregenSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { availableRests } from "../plugins/systems/dnd5.5e/core/rest.ts";
import {
  type Actor,
  type DndState,
  StateSchema,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  buildAbilities,
  deriveStats,
  lookup,
  spellSaveDc,
} from "../plugins/systems/dnd5.5e/core/stats.ts";

const system = (state: GameState): DndState => StateSchema.parse(state.system);

function actorIn(state: GameState, id: string = PLAYER_ACTOR): Actor {
  const actor = system(state).actors[id];
  if (!actor) throw new Error(`No actor ${id}`);
  return actor;
}

function buildOf(actor: Actor): CharacterBuild {
  if (actor.source.kind !== "character" || !actor.source.build) {
    throw new Error(`${actor.id} has no build`);
  }
  return actor.source.build;
}

// One scene per entry, each moved past by a single choice, ending in a scene with no choices.
function storyRun(
  run: RunContext,
  effects: readonly (readonly StoryEffect[])[],
): RunContext {
  const scenes = effects.map((list, index) => ({
    id: `s${String(index)}`,
    text: "Onward.",
    textVariants: [],
    rest: true,
    choices: [
      {
        label: "Go on",
        effects: [
          ...list,
          { kind: "goto" as const, scene: `s${String(index + 1)}` },
        ],
      },
    ],
  }));
  return {
    ...run,
    adventure: {
      ...run.adventure,
      startScene: "s0",
      scenes: [
        ...scenes,
        {
          id: `s${String(effects.length)}`,
          text: "The end.",
          textVariants: [],
          rest: true,
          choices: [],
        },
      ],
    },
  };
}

const levelUp: StoryEffect = {
  kind: "system",
  effect: "dnd5.5e:levelUp",
  args: {},
};

function withContent(
  run: RunContext,
  entries: readonly { readonly id: string }[],
): RunContext {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () =>
      [...run.contentIds(), ...entries.map((entry) => entry.id)].sort(),
  };
}

type Plan = readonly (readonly [RegExp, string])[];

interface Driven {
  readonly state: GameState;
  readonly log: readonly LogEntry[];
  readonly events: readonly GameEvent[];
  readonly asked: readonly Decision[];
}

// Answers decisions by the first plan line matching their id, and the first option otherwise.
function drive(
  run: RunContext,
  seed: string,
  plan: Plan,
  until: (decision: Decision) => boolean = () => false,
): Driven {
  const started = startRun(run, seed);
  const log: LogEntry[] = [
    { input: { kind: "start" }, events: started.events },
  ];
  const asked: Decision[] = [];
  let { state, pending } = started;
  while (pending && !until(pending)) {
    const decision: Decision = pending;
    asked.push(decision);
    const planned = plan.find(([pattern]) => pattern.test(decision.id))?.[1];
    const optionId = planned ?? decision.options[0]?.id ?? "";
    const input = {
      kind: "answer" as const,
      decisionId: decision.id,
      optionId,
    };
    const outcome = step(run, state, input);
    if (!outcome.ok) throw new Error(`${decision.id}: ${outcome.error}`);
    log.push({ input, events: outcome.events });
    ({ state, pending } = outcome);
  }
  return { state, log, events: log.flatMap((entry) => entry.events), asked };
}

const FIGHTER: Plan = [
  [/chooseCharacter/, CREATE_CHARACTER],
  [/:class$/, "srd52:class/fighter"],
  [/:species$/, "srd52:species/human"],
  [/:background$/, "srd52:background/soldier"],
  [/:score-15$/, "str"],
  [/:score-14$/, "con"],
  [/:score-13$/, "dex"],
  [/:score-12$/, "wis"],
  [/:score-10$/, "cha"],
  [/:player:increase$/, "str:2,con:1"],
  [/:fighting-style-0$/, "srd52:feat/archery"],
  [/:subclass-0$/, "srd52:subclass/champion"],
  [/:feat-0$/, "srd52:feat/ability-score-improvement"],
  [/:feat:increase$/, "str:1,con:1"],
];

const WIZARD: Plan = [
  [/chooseCharacter/, CREATE_CHARACTER],
  [/:class$/, "srd52:class/wizard"],
  [/:species$/, "srd52:species/elf"],
  [/:background$/, "srd52:background/sage"],
  [/:score-15$/, "int"],
  [/:score-14$/, "con"],
  [/:score-13$/, "dex"],
  [/:score-12$/, "wis"],
  [/:score-10$/, "cha"],
  [/:player:increase$/, "int:2,con:1"],
  [/:subclass-0$/, "srd52:subclass/evoker"],
  [/:feat-0$/, "srd52:feat/ability-score-improvement"],
  [/:feat:increase$/, "int:2"],
];

async function goblin(): Promise<RunContext> {
  return (await loadAdventure("goblin-ambush")).run;
}

function expectReplays(
  run: RunContext,
  registry: Awaited<ReturnType<typeof loadAdventure>>["registry"],
  seed: string,
  driven: Driven,
): void {
  const save = createSave(registry, "goblin-ambush", seed, driven.log);
  const loaded = loadSave(JSON.stringify(save), registry, run);
  if (!loaded.ok) throw new Error(loaded.error);
  expect(loaded.state).toEqual(driven.state);
}

describe("character creation", () => {
  it("still lets the player take a pregen", async () => {
    const run = await goblin();
    const driven = drive(storyRun(run, []), "pregen", [
      [/chooseCharacter/, "srd52:pregen/rogue"],
    ]);
    expect(actorIn(driven.state).name).toBe("Human Rogue");
    expect(driven.asked).toHaveLength(1);
  });

  it("builds a wizard from the decisions, by the rules", async () => {
    const run = storyRun(await goblin(), []);
    const { state, asked } = drive(run, "wizard", WIZARD);

    const player = actorIn(state);
    const build = buildOf(player);
    const stats = deriveStats(player, run);
    expect(player.name).toBe("Elf Wizard");
    expect(build.baseAbilities).toEqual({
      int: 15,
      con: 14,
      dex: 13,
      wis: 12,
      cha: 10,
      str: 8,
    });
    expect(stats.abilities).toMatchObject({ int: 17, con: 15, str: 8 });
    expect(stats.maxHp).toBe(8); // d6's maximum, plus 2 for Constitution
    expect(player.hp).toBe(8);
    expect(stats.ac).toBe(11); // no armor training: 10 + 1 for Dexterity
    expect(spellSaveDc(stats)).toBe(13); // 8 + 2 + 3
    expect(stats.slots).toEqual([2]);
    expect(stats.skills).toEqual(expect.arrayContaining(["arcana", "history"]));
    expect(stats.skills).toHaveLength(4);

    // Asked one at a time, with what's already taken no longer on offer.
    const skills = asked.filter((item) => item.id.includes(":skills-"));
    expect(skills.map((item) => item.options.length)).toEqual([5, 4]);
    expect(skills[0]?.options.some((option) => option.id === "arcana")).toBe(
      false,
    );
    const scoreOptions = asked
      .filter((item) => item.id.includes(":score-"))
      .map((item) => item.options.length);
    expect(scoreOptions).toEqual([6, 5, 4, 3, 2]);
    expect(
      asked.find((item) => item.id.endsWith(":increase"))?.options,
    ).toHaveLength(7);

    const spells = build.levels[0]?.answers.flatMap((answer) =>
      answer.kind === "spells" ? answer.values : [],
    );
    expect(spells).toHaveLength(7); // 3 cantrips and 4 prepared spells
    expect(asked.filter((item) => item.id.includes(":cantrips-"))).toHaveLength(
      3,
    );
    expect(asked.filter((item) => item.id.includes(":spells-"))).toHaveLength(
      4,
    );
    expect(player.inventory).toContain("srd52:item/dagger");
  });

  it("asks a fighter for a Fighting Style and masteries instead of spells", async () => {
    const run = storyRun(await goblin(), []);
    const { state, asked } = drive(run, "style", FIGHTER);
    expect(asked.some((item) => item.id.includes(":cantrips-"))).toBe(false);
    expect(
      asked.filter((item) => item.id.includes(":weapon-mastery-")),
    ).toHaveLength(3);
    const player = actorIn(state);
    expect(player.inventory).toEqual(
      expect.arrayContaining(["srd52:item/chain-mail", "srd52:item/shield"]),
    );
    expect(deriveStats(player, run).ac).toBe(18); // chain mail 16 + shield 2
  });

  it("replays and resumes from the middle of creation", async () => {
    const { registry, run: base } = await loadAdventure("goblin-ambush");
    const run = storyRun(base, []);
    const whole = drive(run, "mid", WIZARD);
    expectReplays(run, registry, "mid", whole);

    const cut = drive(run, "mid", WIZARD, (decision) =>
      decision.id.endsWith(":increase"),
    );
    expect(actorIn(cut.state).source).toEqual({
      kind: "character",
      build: null,
    });
    const save = createSave(registry, "goblin-ambush", "mid", cut.log);
    const loaded = loadSave(JSON.stringify(save), registry, run);
    if (!loaded.ok) throw new Error(loaded.error);
    const resumed = step(run, loaded.state, {
      kind: "answer",
      decisionId: "dnd5.5e:build:player:increase",
      optionId: "int:2,con:1",
    });
    expect(resumed.ok).toBe(true);
  });

  it("uses stated choices over inferred ones, and honors option choices", async () => {
    const run = withContent(await goblin(), [
      FeatureSchema.parse({
        id: "test:feature/trick-a",
        name: "Trick A",
        text: "A.",
        automation: "text",
      }),
      FeatureSchema.parse({
        id: "test:feature/trick-b",
        name: "Trick B",
        text: "B.",
        automation: "text",
      }),
      ClassSchema.parse({
        id: "test:class/juggler",
        name: "Juggler",
        hitDie: "d8",
        primaryAbilities: ["dex"],
        savingThrows: ["dex"],
        weapons: ["simple"],
        armor: [],
        levels: [
          {
            level: 1,
            choices: [
              { kind: "skills", id: "skills", count: 1, from: ["stealth"] },
              {
                kind: "option",
                id: "trick",
                count: 1,
                from: ["test:feature/trick-a", "test:feature/trick-b"],
              },
            ],
          },
        ],
      }),
    ]);
    const { state, asked } = drive(storyRun(run, []), "juggler", [
      [/chooseCharacter/, CREATE_CHARACTER],
      [/:class$/, "test:class/juggler"],
      [/:background$/, "srd52:background/criminal"],
      [/:trick-0$/, "test:feature/trick-b"],
    ]);
    expect(asked.find((item) => item.id.endsWith(":trick-0"))?.options).toEqual(
      [
        { id: "test:feature/trick-a", label: "Trick A" },
        { id: "test:feature/trick-b", label: "Trick B" },
      ],
    );
    const stats = deriveStats(actorIn(state), storyRun(run, []));
    expect(stats.features).toContain("test:feature/trick-b");
    expect(stats.features).not.toContain("test:feature/trick-a");
    // Criminal already gives Stealth, so the one skill on offer has nothing left to ask.
    expect(asked.some((item) => item.id.includes(":skills-"))).toBe(false);
  });
});

describe("what a level asks for", () => {
  const imported = ClassSchema.parse({
    id: "test:class/imported",
    name: "Imported",
    hitDie: "d8",
    primaryAbilities: ["wis"],
    savingThrows: ["wis"],
    weapons: ["simple"],
    armor: [],
    levels: [
      { level: 1, slots: [2], scaling: { cantrips: 2, preparedSpells: 4 } },
      {
        level: 2,
        grants: ["test:feature/imported-fighting-style"],
        slots: [3],
        scaling: { cantrips: 2, preparedSpells: 5 },
      },
      {
        level: 3,
        grants: ["test:feature/imported-imported-subclass"],
        slots: [4, 2],
        scaling: { cantrips: 2, preparedSpells: 6 },
      },
      {
        level: 4,
        grants: ["test:feature/imported-ability-score-improvement"],
        slots: [4, 3],
        scaling: { cantrips: 3, preparedSpells: 7 },
      },
    ],
  });

  it("reads classes without stated choices from their grants and tables", async () => {
    const run = await goblin();
    const kinds = (level: number) =>
      levelChoices(imported, level, undefined, run).map((item) => item.id);
    expect(kinds(1)).toEqual(["skills", "cantrips", "spells"]);
    expect(kinds(2)).toEqual(["fighting-style", "spells"]);
    expect(kinds(3)).toEqual(["subclass", "spells"]);
    expect(kinds(4)).toEqual(["feat", "cantrips", "spells"]);
    expect(
      levelChoices(imported, 3, undefined, run).find(
        (item) => item.kind === "spells",
      ),
    ).toMatchObject({ count: 1, maxLevel: 2, list: "test:class/imported" });
  });
});

describe("levelling up", () => {
  it("takes a fighter from 1 to 5, matching numbers worked out by hand", async () => {
    const { registry, run: base } = await loadAdventure("goblin-ambush");
    const run = storyRun(base, [[levelUp], [levelUp], [levelUp], [levelUp]]);
    const expected = [
      // Level 1: d10's maximum 10, plus Constitution 15's +2.
      { level: 1, maxHp: 12, proficiency: 2, secondWind: 2, attacks: 1 },
      // Each later level: the fixed 6, plus Constitution.
      { level: 2, maxHp: 20, proficiency: 2, secondWind: 2, attacks: 1 },
      { level: 3, maxHp: 28, proficiency: 2, secondWind: 2, attacks: 1 },
      // Constitution rises to 16 at level 4, adding 1 at every level: 28 + 6 + 3 + 3.
      { level: 4, maxHp: 40, proficiency: 2, secondWind: 3, attacks: 1 },
      { level: 5, maxHp: 49, proficiency: 3, secondWind: 3, attacks: 2 },
    ];
    let state: GameState | null = null;
    for (const [index, want] of expected.entries()) {
      const driven = drive(
        run,
        "fighter",
        FIGHTER,
        (decision) => decision.id === `scene:s${String(index)}`,
      );
      state = driven.state;
      const player = actorIn(state);
      const stats = deriveStats(player, run);
      expect({
        level: stats.level,
        maxHp: stats.maxHp,
        proficiency: stats.proficiency,
        secondWind: stats.resources["second-wind"],
        attacks: stats.multiattack,
      }).toEqual(want);
      expect(player.hp).toBe(want.maxHp);
    }

    const whole = drive(run, "fighter", FIGHTER);
    const player = actorIn(whole.state);
    const stats = deriveStats(player, run);
    expect(stats.abilities).toMatchObject({ str: 18, con: 16 });
    expect(stats.features).toEqual(
      expect.arrayContaining([
        "srd52:feature/action-surge",
        "srd52:feature/improved-critical",
        "srd52:feature/extra-attack",
      ]),
    );
    expect(whole.asked.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "dnd5.5e:build:player:3:subclass-0",
        "dnd5.5e:build:player:4:feat-0",
        "dnd5.5e:build:player:4:feat:increase",
        "dnd5.5e:build:player:1:weapon-mastery-0",
      ]),
    );
    expect(
      whole.events.filter(
        (event) => event.kind === "levelGained" && event.actor === PLAYER_ACTOR,
      ),
    ).toHaveLength(4);
    expect(buildOf(player).levels.map((entry) => entry.hitPointGain)).toEqual([
      10, 6, 6, 6, 6,
    ]);
    expectReplays(run, registry, "fighter", whole);
  });

  it("takes a wizard from 1 to 5, with slots and prepared spells", async () => {
    const run = storyRun(await goblin(), [
      [levelUp],
      [levelUp],
      [levelUp],
      [levelUp],
    ]);
    const { state, asked } = drive(run, "wizard-5", WIZARD);
    const player = actorIn(state);
    const stats = deriveStats(player, run);
    expect(stats.slots).toEqual([4, 3, 2]);
    // 8 at level 1, then the fixed 4 plus Constitution 15's +2 at each level.
    expect(stats.maxHp).toBe(32);
    expect(stats.abilities.int).toBe(19);
    expect(spellSaveDc(stats)).toBe(15); // 8 + 3 + 4

    const known = buildOf(player).levels.flatMap((entry) =>
      entry.answers.flatMap((answer) =>
        answer.kind === "spells" ? answer.values : [],
      ),
    );
    expect(new Set(known).size).toBe(13); // 4 cantrips and 9 prepared spells

    // A spell offered at level 5 can be up to level 3, the highest slot then.
    const lastStep = asked.findLast((item) => item.id.includes(":spells-"));
    expect(
      lastStep?.options.some((item) => item.label.endsWith("(level 3)")),
    ).toBe(true);
    expect(
      lastStep?.options.some((item) => item.label.endsWith("(level 4)")),
    ).toBe(false);
    expect(stats.features).toContain("srd52:feature/evocation-savant");
  });

  it("grows Sneak Attack from the class table", async () => {
    const run = storyRun(await goblin(), [
      [levelUp],
      [levelUp],
      [levelUp],
      [levelUp],
    ]);
    const { state } = drive(run, "rogue-5", [
      [/chooseCharacter/, "srd52:pregen/rogue"],
      [/:subclass-0$/, "srd52:subclass/thief"],
    ]);
    const stats = deriveStats(actorIn(state), run);
    expect(stats.level).toBe(5);
    expect(
      stats.passives.flatMap((item) =>
        item.kind === "extraDamage" ? [item.dice] : [],
      ),
    ).toEqual(["3d6"]);
  });

  it("levels by XP at the right thresholds", async () => {
    expect([0, 299, 300, 899, 900, 2700, 6500].map(levelForXp)).toEqual([
      1, 1, 2, 2, 3, 4, 5,
    ]);
    const xp = (amount: number): StoryEffect => ({
      kind: "system",
      effect: "dnd5.5e:awardXp",
      args: { amount },
    });
    const run = storyRun(await goblin(), [
      [xp(299)],
      [xp(1)],
      [xp(600)],
      [levelUp],
    ]);
    const fighter: Plan = [[/chooseCharacter/, "srd52:pregen/fighter"]];
    const at = (scene: number) =>
      actorIn(
        drive(
          run,
          "xp",
          fighter,
          (decision) => decision.id === `scene:s${String(scene)}`,
        ).state,
      );
    expect(buildOf(at(1)).levels).toHaveLength(1);
    expect(at(1).xp).toBe(299);
    expect(buildOf(at(2)).levels).toHaveLength(2);
    expect(buildOf(at(3)).levels).toHaveLength(3);
    // A milestone is the XP that reaches the next level.
    const last = actorIn(drive(run, "xp", fighter).state);
    expect(last.xp).toBe(2700);
    expect(buildOf(last).levels).toHaveLength(4);
  });

  it("jumps several levels from one award, asking for each", async () => {
    const run = storyRun(await goblin(), [
      [{ kind: "system", effect: "dnd5.5e:awardXp", args: { amount: 900 } }],
    ]);
    const { state } = drive(run, "jump", [
      [/chooseCharacter/, "srd52:pregen/fighter"],
    ]);
    expect(buildOf(actorIn(state)).levels).toHaveLength(3);
  });

  it("stops at the last level the content has", async () => {
    const run = storyRun(await goblin(), [
      [levelUp],
      [levelUp],
      [levelUp],
      [levelUp],
      [levelUp],
    ]);
    const { state } = drive(run, "cap", [
      [/chooseCharacter/, "srd52:pregen/fighter"],
    ]);
    expect(buildOf(actorIn(state)).levels).toHaveLength(5);
  });

  it("gives Extra Attack to weapons and not to spell attacks", async () => {
    const run = storyRun(await goblin(), [
      [levelUp],
      [levelUp],
      [levelUp],
      [levelUp],
    ]);
    const { state } = drive(run, "extra", [
      [/chooseCharacter/, "srd52:pregen/fighter"],
    ]);
    const fighter = actorIn(state);
    const build = buildOf(fighter);
    const caster: Actor = {
      ...fighter,
      source: {
        kind: "character",
        build: {
          ...build,
          levels: [
            ...build.levels.slice(0, -1),
            {
              classId: "srd52:class/fighter",
              hitPointGain: 6,
              answers: [{ kind: "spells", values: ["srd52:spell/fire-bolt"] }],
            },
          ],
        },
      },
    };
    const target = freshActor({
      id: "goblin",
      name: "Goblin",
      side: "enemy",
      source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
      hp: 10,
      inventory: [],
    });
    const context = {
      state: {
        actors: { [PLAYER_ACTOR]: caster, goblin: target },
        combat: null,
      } satisfies DndState,
      dice: createDice(rngFromSeed("extra")),
      content: run.content,
      contentIds: run.contentIds,
    };
    const attacks = (answer: string) =>
      (
        runTakeAction({ actor: PLAYER_ACTOR, answer }, context).frames ?? []
      ).filter((item) => item.kind === "dnd5.5e:attackRoll");
    expect(attacks("weapon:srd52:item/longsword|goblin")).toHaveLength(2);
    expect(attacks("spell:srd52:spell/fire-bolt|goblin")).toHaveLength(1);
  });
});

describe("rests", () => {
  const short: StoryEffect = {
    kind: "system",
    effect: "dnd5.5e:shortRest",
    args: {},
  };
  const long: StoryEffect = {
    kind: "system",
    effect: "dnd5.5e:longRest",
    args: {},
  };

  function hurt(
    state: GameState,
    id: string,
    change: Partial<Actor>,
  ): GameState {
    const dnd = system(state);
    return {
      ...state,
      system: {
        ...dnd,
        actors: { ...dnd.actors, [id]: { ...actorIn(state, id), ...change } },
      },
    };
  }

  async function atFirstScene(effects: readonly StoryEffect[]) {
    const run = storyRun(await goblin(), [effects]);
    const started = startRun(run, "rest");
    const chosen = step(run, started.state, {
      kind: "answer",
      decisionId: "dnd5.5e:chooseCharacter",
      optionId: "srd52:pregen/fighter",
    });
    if (!chosen.ok) throw new Error(chosen.error);
    return { run, state: chosen.state };
  }

  function answer(
    run: RunContext,
    state: GameState,
    decisionId: string,
    optionId: string,
  ) {
    const outcome = step(run, state, { kind: "answer", decisionId, optionId });
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome;
  }

  it("lets the player spend Hit Dice one at a time on a short rest", async () => {
    const { run, state } = await atFirstScene([short]);
    const wounded = hurt(state, PLAYER_ACTOR, {
      hp: 2,
      resourcesSpent: { "second-wind": 2 },
    });
    const asked = answer(run, wounded, "scene:s0", "0");
    expect(asked.pending?.id).toBe("dnd5.5e:shortRest:1");
    expect(asked.pending?.options.map((item) => item.id)).toEqual([
      "spend",
      "finish",
    ]);
    // Level 1 means one die, so spending it finishes the rest.
    const rested = answer(run, asked.state, "dnd5.5e:shortRest:1", "spend");
    const player = actorIn(rested.state);
    // 1d10 + 2 for Constitution.
    expect(player.hp).toBeGreaterThanOrEqual(5);
    expect(player.hp).toBeLessThanOrEqual(12);
    expect(player.resourcesSpent).toEqual({ hitDice: 1, "second-wind": 1 });
    expect(rested.state.story.scene).toBe("s1");
  });

  it("can finish a short rest without spending, and skips asking at full HP", async () => {
    const { run, state } = await atFirstScene([short]);
    const wounded = hurt(state, PLAYER_ACTOR, { hp: 2 });
    const asked = answer(run, wounded, "scene:s0", "0");
    const rested = answer(run, asked.state, "dnd5.5e:shortRest:1", "finish");
    expect(actorIn(rested.state).hp).toBe(2);
    expect(actorIn(rested.state).resourcesSpent).toEqual({});

    const full = answer(run, state, "scene:s0", "0");
    expect(full.pending).toBeNull();
    expect(full.state.story.scene).toBe("s1");
  });

  it("has companions heal themselves on a short rest", async () => {
    const { run, state } = await atFirstScene([short]);
    const wounded = hurt(state, "companion-1", { hp: 1 });
    const rested = answer(run, wounded, "scene:s0", "0");
    const companion = actorIn(rested.state, "companion-1");
    expect(companion.hp).toBeGreaterThan(1);
    expect(companion.resourcesSpent.hitDice).toBe(1);
  });

  it("restores everything on a long rest", async () => {
    const { run, state } = await atFirstScene([long]);
    const wounded = hurt(state, PLAYER_ACTOR, {
      hp: 2,
      tempHp: 4,
      exhaustion: 2,
      resourcesSpent: { "second-wind": 2, hitDice: 1, "slot:1": 2 },
    });
    const rested = answer(run, wounded, "scene:s0", "0");
    const player = actorIn(rested.state);
    expect(player.hp).toBe(12);
    expect(player.tempHp).toBe(0);
    expect(player.exhaustion).toBe(1);
    expect(player.resourcesSpent).toEqual({});
  });

  it("recharges Pact Magic on a short rest, and other slots only on a long one", async () => {
    const pactMagic = FeatureSchema.parse({
      id: "test:feature/warlock-pact-magic",
      name: "Pact Magic",
      text: "Your slots come back on a Short Rest.",
      automation: "text",
    });
    const warlock = ClassSchema.parse({
      id: "test:class/warlock",
      name: "Warlock",
      hitDie: "d8",
      primaryAbilities: ["cha"],
      savingThrows: ["wis", "cha"],
      weapons: ["simple"],
      armor: ["light"],
      spellcasting: { ability: "cha" },
      levels: [
        { level: 1, grants: ["test:feature/warlock-pact-magic"], slots: [1] },
        { level: 2, slots: [2] },
        { level: 3, slots: [0, 2] },
      ],
    });
    const entry = (
      answers: CharacterBuild["levels"][number]["answers"] = [],
    ): CharacterBuild["levels"][number] => ({
      classId: "test:class/warlock",
      hitPointGain: 5,
      answers,
    });
    const { run: base, state } = await atFirstScene([short]);
    const run = withContent(base, [pactMagic, warlock]);
    const fighter = actorIn(state);
    const pregen = lookup(run, PregenSchema, "srd52:pregen/cleric");
    const bound: Actor = {
      ...fighter,
      source: {
        kind: "character",
        build: {
          ...pregen.build,
          levels: [
            entry([{ kind: "spells", values: ["srd52:spell/bless"] }]),
            entry(),
            entry(),
          ],
        },
      },
      inventory: [], // the fighter's chain mail would stop a warlock casting
      resourcesSpent: { "slot:2": 2 },
    };
    const stats = deriveStats(bound, run);
    expect(stats.slots).toEqual([0, 2]);
    expect(stats.pactMagic).toBe(true);

    // A level 1 spell can only go in the level 2 pact slots here.
    const bless = stats.actions.find((item) => item.id.includes("bless"));
    if (!bless) throw new Error("No Bless");
    expect(canAfford(bless, bound, stats)).toBe(false);
    const ready = { ...bound, resourcesSpent: { "slot:2": 1 } };
    expect(canAfford(bless, ready, stats)).toBe(true);
    const cast = runTakeAction(
      { actor: PLAYER_ACTOR, answer: `${bless.id}|all` },
      {
        state: { actors: { [PLAYER_ACTOR]: ready }, combat: null },
        dice: createDice(rngFromSeed("pact")),
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    expect(cast.events).toContainEqual({
      kind: "dnd5.5e:resourceSpent",
      payload: { actor: PLAYER_ACTOR, resource: "slot:2" },
    } satisfies SystemEvent);

    const rested = answer(
      run,
      hurt(state, PLAYER_ACTOR, { ...bound, hp: 999 }),
      "scene:s0",
      "0",
    );
    expect(actorIn(rested.state).resourcesSpent).toEqual({});

    // A wizard keeps theirs spent until a long rest.
    const wizard = answer(
      run,
      hurt(state, PLAYER_ACTOR, {
        source: {
          kind: "character",
          build: lookup(run, PregenSchema, "srd52:pregen/wizard").build,
        },
        hp: 999,
        resourcesSpent: { "slot:1": 2 },
      }),
      "scene:s0",
      "0",
    );
    expect(actorIn(wizard.state).resourcesSpent).toEqual({ "slot:1": 2 });
  });

  it("replays a rest with dice exactly", async () => {
    const { registry, run: base } = await loadAdventure("goblin-ambush");
    const run = storyRun(base, [[levelUp], [short]]);
    const driven = drive(run, "rest-replay", FIGHTER);
    expectReplays(run, registry, "rest-replay", driven);
  });
});

describe("resting between scenes", () => {
  const options = (decision: Decision | null) =>
    decision?.options.map((item) => item.id) ?? [];

  // At the first of two plain scenes, playing the fighter pregen.
  async function atCamp(seed = "camp") {
    const { registry, run } = await loadAdventure("goblin-ambush");
    const camp = storyRun(run, [[], []]);
    const driven = drive(
      camp,
      seed,
      [[/chooseCharacter/, "srd52:pregen/fighter"]],
      (decision) => decision.id === "scene:s0",
    );
    return { registry, run: camp, driven };
  }

  function play(
    run: RunContext,
    driven: Driven,
    decisionId: string,
    optionId: string,
  ): Driven {
    const input = { kind: "answer" as const, decisionId, optionId };
    const outcome = step(run, driven.state, input);
    if (!outcome.ok) throw new Error(outcome.error);
    const log = [...driven.log, { input, events: outcome.events }];
    return {
      state: outcome.state,
      log,
      events: log.flatMap((entry) => entry.events),
      asked: outcome.pending
        ? [...driven.asked, outcome.pending]
        : driven.asked,
    };
  }

  it("offers a short and a long rest beside the scene's choices", async () => {
    const { run, driven } = await atCamp();
    expect(options(pendingDecision(run, driven.state))).toEqual([
      "0",
      "rest:short",
      "rest:long",
    ]);
  });

  it("rests in place, once per visit to a scene", async () => {
    const { run, driven } = await atCamp();
    const rested = play(run, driven, "scene:s0", "rest:long");
    expect(rested.state.story.scene).toBe("s0");
    expect(system(rested.state).sinceLongRest).toBe(8);
    expect(options(pendingDecision(run, rested.state))).toEqual(["0"]);
    expect(
      step(run, rested.state, {
        kind: "answer",
        decisionId: "scene:s0",
        optionId: "rest:short",
      }).ok,
    ).toBe(false);
  });

  it("allows one long rest in 24 hours, counting the hours rests pass", async () => {
    const { run, driven } = await atCamp();
    const rested = play(run, driven, "scene:s0", "rest:long");
    const next = play(run, rested, "scene:s0", "0");
    expect(next.state.story.scene).toBe("s1");
    expect(options(pendingDecision(run, next.state))).toEqual([
      "0",
      "rest:short",
    ]);

    const later = play(run, next, "scene:s1", "rest:short");
    expect(system(later.state).sinceLongRest).toBe(9);
    const dnd = system(later.state);
    expect(availableRests({ ...dnd, sinceLongRest: 23 })).toHaveLength(1);
    expect(
      availableRests({ ...dnd, sinceLongRest: 24 }).map((rest) => rest.id),
    ).toEqual(["short", "long"]);
  });

  it("offers no rest in a fight", async () => {
    const run = storyRun(await goblin(), [
      [{ kind: "startEncounter", encounter: "roadside" }],
    ]);
    const driven = drive(
      run,
      "fight",
      [[/chooseCharacter/, "srd52:pregen/fighter"]],
      (decision) => decision.id.startsWith("dnd5.5e:turn:"),
    );
    const turn = pendingDecision(run, driven.state);
    expect(turn?.id).toMatch(/^dnd5\.5e:turn:/);
    expect(options(turn).some((id) => id.startsWith("rest:"))).toBe(false);
    expect(availableRests(system(driven.state))).toEqual([]);
  });

  it("lets an adventure forbid resting in a scene", async () => {
    const { run, driven } = await atCamp();
    const noRest: RunContext = {
      ...run,
      adventure: {
        ...run.adventure,
        scenes: run.adventure.scenes.map((scene) =>
          scene.id === "s0" ? { ...scene, rest: false } : scene,
        ),
      },
    };
    const decision = pendingDecision(noRest, driven.state);
    expect(options(decision)).toEqual(["0"]);
    expect(
      step(noRest, driven.state, {
        kind: "answer",
        decisionId: "scene:s0",
        optionId: "rest:long",
      }).ok,
    ).toBe(false);
  });

  it("replays rests from a save and from the inputs", async () => {
    const { registry, run, driven } = await atCamp("camp-replay");
    let played = play(run, driven, "scene:s0", "rest:short");
    played = play(run, played, "scene:s0", "0");
    played = play(run, played, "scene:s1", "rest:short");
    played = play(run, played, "scene:s1", "0");
    expect(played.state.story.ended).toBe("ending");
    expectReplays(run, registry, "camp-replay", played);
    const replayed = replayInputs(
      run,
      "camp-replay",
      played.log.map((entry) => entry.input),
    );
    expect(replayed.state).toEqual(played.state);
  });
});

describe("the dynamic party", () => {
  it("builds companions with the same rules, and every run differs", async () => {
    const run = await goblin();
    const pregens = run
      .contentIds()
      .filter((id) => id.includes(":pregen/"))
      .map((id) => lookup(run, PregenSchema, id).build);
    const seen = new Set<string>();
    for (let index = 0; index < 30; index += 1) {
      const { state } = startRun(run, `party-${String(index)}`);
      const classes = ["companion-1", "companion-2"].map((id) => {
        const actor = actorIn(state, id);
        const build = buildOf(actor);
        expect(pregens).not.toContainEqual(build);
        seen.add(JSON.stringify(build));

        expect(actor.name).toBe(state.companions[id]?.name);
        expect(actor.hp).toBe(deriveStats(actor, run).maxHp);
        // The standard array, before the background's increase.
        expect(
          Object.values(build.baseAbilities).sort((a, b) => b - a),
        ).toEqual([15, 14, 13, 12, 10, 8]);
        const classDef = lookup(
          run,
          ClassSchema,
          build.levels[0]?.classId ?? "",
        );
        // Their best score goes where their class needs it.
        const best = classDef.primaryAbilities[0];
        if (best) expect(build.baseAbilities[best]).toBe(15);
        expect(
          actor.inventory.some(
            (id2) => lookup(run, ItemSchema, id2).type === "weapon",
          ),
        ).toBe(true);
        return classDef.id;
      });
      expect(new Set(classes).size).toBe(2);
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it("keeps companions at the player's level, with valid builds", async () => {
    const { registry, run: base } = await loadAdventure("goblin-ambush");
    const run = storyRun(base, [[levelUp], [levelUp], [levelUp], [levelUp]]);
    const driven = drive(run, "party-up", FIGHTER);
    const player = deriveStats(actorIn(driven.state), run);
    expect(player.level).toBe(5);
    for (const id of ["companion-1", "companion-2"]) {
      const actor = actorIn(driven.state, id);
      const stats = deriveStats(actor, run);
      expect(stats.level).toBe(5);
      expect(actor.hp).toBe(stats.maxHp);
      expect(stats.proficiency).toBe(3);
      // Levels 3 and 4 each asked them something.
      const kinds = buildOf(actor).levels.flatMap((entry) =>
        entry.answers.map((answer) => answer.kind),
      );
      expect(kinds).toEqual(expect.arrayContaining(["subclass", "feats"]));
      expect(buildAbilities(buildOf(actor))).toEqual(stats.abilities);
    }
    expectReplays(run, registry, "party-up", driven);
  });

  it("plays whole adventures with created characters and bot choices", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const report = testAdventure(run, { runs: 40, maxDecisions: 800 });
    expect(report.failures).toEqual([]);
    expect(report.unvisitedScenes).toEqual([]);
  }, 30_000);
});

describe("weapon proficiency limited by property", () => {
  it("keeps a Rogue to Finesse or Light Martial weapons", async () => {
    const run = await goblin();
    const rogue = lookup(run, ClassSchema, "srd52:class/rogue");
    const weapon = (id: string) => {
      const item = lookup(run, ItemSchema, id);
      if (item.type !== "weapon") throw new Error(`${id} isn't a weapon`);
      return item;
    };
    expect(weaponProficient(rogue, weapon("srd52:item/longsword"))).toBe(false);
    expect(weaponProficient(rogue, weapon("srd52:item/shortsword"))).toBe(true);
    expect(weaponProficient(rogue, weapon("srd52:item/dagger"))).toBe(true);
    const fighter = lookup(run, ClassSchema, "srd52:class/fighter");
    expect(weaponProficient(fighter, weapon("srd52:item/longsword"))).toBe(
      true,
    );

    const gear = startingGear(
      rogue,
      { str: 8, dex: 17, con: 14, int: 12, wis: 10, cha: 13 },
      run,
    );
    expect(gear).toEqual(
      expect.arrayContaining([
        "srd52:item/shortsword",
        "srd52:item/leather-armor",
      ]),
    );
    expect(gear).not.toContain("srd52:item/longsword");
  });
});
