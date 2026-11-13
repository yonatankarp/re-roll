import { readFile, readdir } from "node:fs/promises";
import { PLAYER_ACTOR, type Decision } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { systems } from "../app/systems.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { GameState } from "../engine/kernel/events.ts";
import { type RunContext, startRun, step } from "../engine/run/turn.ts";
import type { StoryEffect } from "../engine/story/adventure.ts";
import { checkPlugins } from "../engine/tools/check-pack.ts";
import {
  nextDndDecision,
  runCheckCombatEnd,
  startCombat,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import { shownChoices } from "../engine/shell/choices.ts";
import {
  gearOptions,
  sceneGearActions,
} from "../plugins/systems/dnd5.5e/core/gear.ts";
import {
  type Actor,
  type DndState,
  NS,
  StateSchema,
  applyDndEvent,
  dndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";
import { memoryStorage } from "./memory-storage.ts";

const POTION = "srd52:item/potion-of-healing";
const RING = "srd52:item/ring-of-protection";
const SCALE = "srd52:item/scale-mail";
const SCROLL = "srd52:item/spell-scroll-magic-missile";

const dnd = (state: GameState): DndState => StateSchema.parse(state.system);

function playerOf(state: DndState): Actor {
  const actor = state.actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  return actor;
}

function treasure(gold: number, items: readonly string[]): StoryEffect {
  return {
    kind: "system",
    effect: "dnd5.5e:treasure",
    args: { gold, items },
  };
}

// One scene whose only choice runs `effects`, then an ending.
async function storyRun(effects: readonly StoryEffect[]): Promise<RunContext> {
  const { run } = await loadAdventure("goblin-ambush");
  return {
    ...run,
    adventure: {
      ...run.adventure,
      startScene: "s0",
      scenes: [
        {
          id: "s0",
          text: "Onward.",
          textVariants: [],
          rest: true,
          choices: [
            {
              label: "Go on",
              effects: [...effects, { kind: "goto", scene: "end" }],
            },
          ],
        },
        {
          id: "end",
          text: "The end.",
          textVariants: [],
          rest: true,
          choices: [],
        },
      ],
    },
  };
}

// Plays as the pregen, answering each decision with `pick`, or "done" and then the first option.
function play(
  run: RunContext,
  pregen: string,
  pick: (decision: Decision, state: DndState) => string | undefined = () =>
    undefined,
): { state: GameState; asked: Decision[] } {
  const started = startRun(run, "gear");
  let { state, pending } = started;
  const asked: Decision[] = [];
  for (let count = 0; pending && count < 50; count += 1) {
    const decision: Decision = pending;
    asked.push(decision);
    const optionId =
      decision.id === `${NS}:chooseCharacter`
        ? pregen
        : (pick(decision, dnd(state)) ??
          decision.options.find((option) => option.id === "done")?.id ??
          decision.options[0]?.id ??
          "");
    const outcome = step(run, state, {
      kind: "answer",
      decisionId: decision.id,
      optionId,
    });
    if (!outcome.ok) throw new Error(`${decision.id}: ${outcome.error}`);
    ({ state, pending } = outcome);
  }
  return { state, asked };
}

describe("treasure and gold", () => {
  it("adds up gold and carries found gear in the pack", async () => {
    const run = await storyRun([
      treasure(12, [SCALE]),
      treasure(30, [POTION, POTION]),
    ]);
    const { state, asked } = play(run, "srd52:pregen/fighter");
    const system = dnd(state);
    expect(system.gold).toBe(42);
    const player = playerOf(system);
    expect(player.inventory).toEqual(
      expect.arrayContaining([SCALE, POTION, POTION]),
    );
    expect(player.stowed).toEqual([SCALE]);
    // The fighter's own Chain Mail is still what counts.
    expect(deriveStats(player, run).ac).toBe(18);
    const found = asked.filter((item) => item.id.startsWith(`${NS}:found:`));
    expect(found.map((item) => item.prompt)).toEqual([
      "Found: 12 gp, Scale Mail.",
      "Found: 30 gp, Potion of Healing, Potion of Healing.",
    ]);
    expect(found[0]?.options.map((option) => option.label)).toEqual([
      "Equip Scale Mail",
      "Carry on",
    ]);
  });

  it("grants an encounter's loot on a win", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const started = startRun(run, "loot");
    const chosen = step(run, started.state, {
      kind: "answer",
      decisionId: `${NS}:chooseCharacter`,
      optionId: "srd52:pregen/fighter",
    });
    if (!chosen.ok) throw new Error(chosen.error);
    let state = dnd(chosen.state);
    const context = {
      state,
      dice: createDice(rngFromSeed("loot")),
      content: run.content,
      contentIds: run.contentIds,
    };
    const begun = startCombat(
      {
        id: "e",
        monsters: [{ monster: "srd52:monster/goblin-warrior", count: 1 }],
        loot: { gold: 5, items: [RING] },
      },
      context,
      { canFlee: false, defeatContinues: false },
    );
    for (const event of begun.events ?? []) state = applyDndEvent(state, event);
    state = applyDndEvent(
      state,
      dndEvent(`${NS}:damaged`, {
        actor: "e:goblin-warrior-1",
        amount: 99,
        type: "slashing",
        critical: false,
        massive: false,
      }),
    );
    const ended = runCheckCombatEnd({ ...context, state });
    for (const event of ended.events ?? []) state = applyDndEvent(state, event);
    expect(state.combat).toBeNull();
    expect(state.gold).toBe(5);
    expect(playerOf(state).inventory).toContain(RING);
    expect(ended.frames?.[0]?.kind).toBe(`${NS}:gearStep`);
  });
});

describe("equipping and attuning", () => {
  it("swaps armor and changes AC", async () => {
    const run = await storyRun([treasure(0, [SCALE])]);
    const before = playerOf(dnd(play(run, "srd52:pregen/fighter").state));
    expect(deriveStats(before, run).ac).toBe(18); // Chain Mail and a Shield

    const { state } = play(run, "srd52:pregen/fighter", (decision) =>
      decision.options.some((option) => option.id === `equip:${SCALE}`)
        ? `equip:${SCALE}`
        : undefined,
    );
    const after = playerOf(dnd(state));
    expect(after.stowed).toEqual(["srd52:item/chain-mail"]);
    expect(deriveStats(after, run).ac).toBe(17); // Scale Mail, Dex +1, and the Shield
  });

  it("doesn't offer armor the character isn't trained with", async () => {
    const run = await storyRun([treasure(0, [SCALE])]);
    const { asked } = play(run, "srd52:pregen/rogue"); // light armor only
    const offered = asked.flatMap((decision) =>
      decision.options.map((option) => option.id),
    );
    expect(offered).not.toContain(`equip:${SCALE}`);
  });

  it("drinks and changes gear between a scene's choices, and attunes only where the party can rest", async () => {
    const base = await storyRun([]);
    const runAt = (rest: boolean): RunContext => ({
      ...base,
      adventure: {
        ...base.adventure,
        scenes: [
          {
            id: "s0",
            text: "Onward.",
            textVariants: [],
            rest: true,
            choices: [
              {
                label: "Go on",
                effects: [
                  treasure(0, [POTION, RING]),
                  { kind: "goto", scene: "camp" },
                ],
              },
            ],
          },
          {
            id: "camp",
            text: "A clearing.",
            textVariants: [],
            rest,
            choices: [
              { label: "Go on", effects: [{ kind: "goto", scene: "end" }] },
            ],
          },
          ...base.adventure.scenes.filter((scene) => scene.id === "end"),
        ],
      },
    });
    const ids = (decision: Decision | undefined) =>
      decision?.options.map((option) => option.id) ?? [];

    const { state, asked } = play(
      runAt(false),
      "srd52:pregen/fighter",
      (decision) =>
        ids(decision).includes(`drink:${POTION}`)
          ? `drink:${POTION}`
          : undefined,
    );
    const camp = asked.filter((decision) => decision.id === "scene:camp");
    expect(ids(camp[0])).toEqual(
      expect.arrayContaining([
        "0",
        `drink:${POTION}`,
        "stow:srd52:item/shield",
      ]),
    );
    expect(ids(camp[0])).not.toContain(`attune:${RING}`);
    // Drunk and used up, and the scene's choices come back without it.
    expect(ids(camp[1])).not.toContain(`drink:${POTION}`);
    expect(playerOf(dnd(state)).inventory).not.toContain(POTION);

    const resting = play(runAt(true), "srd52:pregen/fighter", (decision) =>
      ids(decision).includes(`attune:${RING}`) ? `attune:${RING}` : undefined,
    );
    expect(playerOf(dnd(resting.state)).attuned).toEqual([RING]);
  });

  it("drops AC and attacks for stowed gear", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const fighter = playerOf(
      dnd(play(await storyRun([]), "srd52:pregen/fighter").state),
    );
    const stowed = {
      ...fighter,
      stowed: ["srd52:item/shield", "srd52:item/longsword"],
    };
    expect(deriveStats(stowed, run).ac).toBe(deriveStats(fighter, run).ac - 2);
    expect(deriveStats(fighter, run).actions.map((item) => item.id)).toContain(
      "weapon:srd52:item/longsword",
    );
    expect(
      deriveStats(stowed, run).actions.map((item) => item.id),
    ).not.toContain("weapon:srd52:item/longsword");
    expect(gearOptions(stowed, run).map((option) => option.id)).toContain(
      "equip:srd52:item/shield",
    );
  });

  it("adds a ring's AC only while attuned, to at most three items", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const fighter = playerOf(
      dnd(play(await storyRun([]), "srd52:pregen/fighter").state),
    );
    const ringed = { ...fighter, inventory: [...fighter.inventory, RING] };
    const ac = deriveStats(fighter, run).ac;
    expect(deriveStats(ringed, run).ac).toBe(ac);
    expect(deriveStats({ ...ringed, attuned: [RING] }, run).ac).toBe(ac + 1);
    expect(gearOptions(ringed, run).map((option) => option.id)).toContain(
      `attune:${RING}`,
    );
    const full = { ...ringed, attuned: ["a:item/x", "a:item/y", "a:item/z"] };
    expect(gearOptions(full, run).map((option) => option.id)).not.toContain(
      `attune:${RING}`,
    );
  });

  it("attunes during a short rest", async () => {
    const run = await storyRun([
      treasure(0, [RING]),
      { kind: "system", effect: "dnd5.5e:shortRest", args: {} },
    ]);
    const { state, asked } = play(
      run,
      "srd52:pregen/fighter",
      (decision, now) => {
        const ids = decision.options.map((option) => option.id);
        if (ids.includes(`attune:${RING}`)) return `attune:${RING}`;
        const attuned = playerOf(now).attuned ?? [];
        if (!ids.includes("finish")) return undefined;
        return ids.includes("gear") && attuned.length === 0 ? "gear" : "finish";
      },
    );
    const player = playerOf(dnd(state));
    expect(player.attuned).toEqual([RING]);
    expect(deriveStats(player, run).ac).toBe(19);
    expect(asked.some((item) => item.id.startsWith(`${NS}:gear:`))).toBe(true);
  });
});

describe("items in a fight", () => {
  it("drinks a potion as a Bonus Action, and it's used up", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const fighter = playerOf(
      dnd(play(await storyRun([]), "srd52:pregen/fighter").state),
    );
    const carrying = { ...fighter, inventory: [...fighter.inventory, POTION] };
    const potion = deriveStats(carrying, run).actions.find(
      (item) => item.id === `item:${POTION}`,
    );
    expect(potion?.name).toBe("Drink Potion of Healing");
    expect(potion?.activation.cost).toEqual(["bonusAction"]);
    const state: DndState = {
      actors: { [PLAYER_ACTOR]: carrying },
      combat: null,
    };
    const after = applyDndEvent(
      state,
      dndEvent(`${NS}:itemUsed`, { actor: PLAYER_ACTOR, item: POTION }),
    );
    expect(playerOf(after).inventory).toEqual(fighter.inventory);
  });

  it("keeps the potion offered but hidden at full health, and never picks it there", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const fighter = playerOf(
      dnd(play(await storyRun([]), "srd52:pregen/fighter").state),
    );
    const max = deriveStats(fighter, run).maxHp;
    const goblin = {
      ...fighter,
      id: "g",
      name: "Goblin",
      side: "enemy" as const,
      source: {
        kind: "monster" as const,
        statBlockId: "srd52:monster/goblin-warrior",
      },
      hp: 7,
      position: { x: 20, y: 20 },
    };
    const at = (hp: number): DndState => ({
      actors: {
        [PLAYER_ACTOR]: {
          ...fighter,
          hp,
          position: { x: 0, y: 0 },
          inventory: [...fighter.inventory, POTION],
        },
        g: goblin,
      },
      combat: {
        encounter: "e",
        order: [PLAYER_ACTOR, "g"],
        index: 0,
        round: 1,
      },
    });
    const drinkIn = (state: DndState) => {
      const decision = nextDndDecision(state, run);
      if (!decision) throw new Error("No turn");
      const policy = run.system.decidePolicy(decision, {
        state,
        dice: createDice(rngFromSeed("drink")),
        content: run.content,
        contentIds: run.contentIds,
      });
      const option = decision.options.find((item) =>
        item.id.startsWith(`item:${POTION}`),
      );
      return { option, policy };
    };

    const full = drinkIn(at(max));
    expect(full.option?.hidden).toBe(true);
    expect(full.policy.startsWith("item:")).toBe(false);

    const hurt = drinkIn(at(1));
    expect(hurt.option).toBeDefined();
    expect(hurt.option?.hidden).toBeUndefined();
    expect(hurt.policy.startsWith(`item:${POTION}`)).toBe(true);
  });

  it("lets a spellcaster read a scroll without a slot", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const wizard = playerOf(
      dnd(play(await storyRun([]), "srd52:pregen/wizard").state),
    );
    const fighter = playerOf(
      dnd(play(await storyRun([]), "srd52:pregen/fighter").state),
    );
    const read = (actor: Actor) =>
      deriveStats(
        { ...actor, inventory: [...actor.inventory, SCROLL] },
        run,
      ).actions.find((item) => item.id === `item:${SCROLL}`);
    expect(read(wizard)?.activation.cost).toEqual(["action"]);
    expect(read(fighter)).toBeUndefined();
  });

  it("says a read scroll crumbles, and a drunk potion doesn't", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const state = dnd(play(await storyRun([]), "srd52:pregen/wizard").state);
    const used = (item: string) =>
      dndUi.describe(
        dndEvent(`${NS}:itemUsed`, { actor: PLAYER_ACTOR, item }),
        state,
        run,
      );
    expect(used(SCROLL)).toMatch(/, and it crumbles to dust\.$/);
    expect(used(POTION)).not.toContain("crumbles");
  });

  it("marks gear the character can't use, and shows when gear can change", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const state = dnd(play(await storyRun([]), "srd52:pregen/wizard").state);
    const wizard = playerOf(state);
    const carrying: DndState = {
      ...state,
      actors: {
        ...state.actors,
        [PLAYER_ACTOR]: {
          ...wizard,
          inventory: [...wizard.inventory, SCALE, SCROLL, POTION],
          stowed: [...(wizard.stowed ?? []), SCALE],
        },
      },
    };
    const [sheet] = dndUi.sheets(carrying, run);
    const gear = sheet?.sections.find(
      (section) => section.title === "Equipment",
    );
    const row = (name: string) =>
      gear?.rows.find((item) => item.label.startsWith(name));
    // Not offered to put on, as it would only hinder.
    expect(row("Scale Mail")?.label).toBe("Scale Mail (can't use)");
    expect(row("Scale Mail")).not.toHaveProperty("option");
    expect(row("Potion of Healing")).toMatchObject({
      option: { id: `drink:${POTION}`, label: "Drink" },
      looks: [POTION], // its picture, found by its id
    });
    expect(row("Spell Scroll")?.label).not.toContain("can't use");
    // Near the top, right after the combat numbers.
    expect(sheet?.sections.map((section) => section.title).slice(0, 2)).toEqual(
      ["Combat", "Equipment"],
    );
  });
});

describe("drinking at full health", () => {
  it("shows Drink disabled with a hint, still answerable, and offers it once hurt", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const state = dnd(play(await storyRun([]), "srd52:pregen/fighter").state);
    const fighter = playerOf(state);
    const at = (hp: number): DndState => ({
      ...state,
      actors: {
        ...state.actors,
        [PLAYER_ACTOR]: {
          ...fighter,
          hp,
          inventory: [...fighter.inventory, POTION],
        },
      },
    });
    const max = deriveStats(fighter, run).maxHp;
    const drinkOf = (dndState: DndState) => {
      const action = sceneGearActions(dndState, run).find(
        (item) => item.id === `drink:${POTION}`,
      );
      const sheets = dndUi.sheets(dndState, run);
      const row = sheets[0]?.sections
        .flatMap((section) => section.rows)
        .find((item) => item.label.startsWith("Potion of Healing"));
      const decision: Decision = {
        id: "scene:s0",
        actor: PLAYER_ACTOR,
        prompt: "Onward.",
        options: [
          { id: "0", label: "Go on" },
          ...(action
            ? [
                {
                  id: action.id,
                  label: action.label,
                  ...(action.hidden ? { hidden: action.hidden } : {}),
                },
              ]
            : []),
        ],
        resume: { kind: "story:resolveChoice", payload: { scene: "s0" } },
      };
      const shown = shownChoices({
        decision,
        optionGroups: [],
        rests: [],
        sheets,
        shop: null,
        creation: null,
        endsEarly: new Set(),
      }).map((choice) => choice.id);
      return { action, row, shown };
    };

    const full = drinkOf(at(max));
    expect(full.action?.hidden).toBe(true);
    expect(full.row).toMatchObject({
      option: { id: `drink:${POTION}`, hint: "Already at full health" },
    });
    expect(full.shown).not.toContain(`drink:${POTION}`);

    const hurt = drinkOf(at(max - 3));
    expect(hurt.action).toBeDefined();
    expect(hurt.action?.hidden).toBeUndefined();
    expect(hurt.row).toMatchObject({
      option: { hint: "Drink between choices, or on your turn in a fight" },
    });
    expect(hurt.shown).toContain(`drink:${POTION}`);
  });
});

describe("checking loot", () => {
  async function issuesFor(
    documents: Readonly<Record<string, string>>,
  ): Promise<string[]> {
    const files: Record<string, string> = {};
    const root = "plugins/rules/srd52";
    for (const name of await readdir(root, { recursive: true })) {
      if (name.endsWith(".yaml")) {
        // readdir gives "\\" separators on Windows, and storage paths always use "/".
        const file = `${root}/${name.replaceAll("\\", "/")}`;
        files[file] = await readFile(file, "utf8");
      }
    }
    const adventure = "plugins/adventures/loot-test";
    files[`${adventure}/plugin.yaml`] = [
      "id: loot-test",
      "kind: adventure",
      "version: 1.0.0",
      "sdk: ^1",
      "system: dnd5.5e@^1",
      "requires:",
      "  - { plugin: srd52, version: ^1 }",
      "distribution: shipped",
    ].join("\n");
    files[`${adventure}/adventure.yaml`] = "title: Test\nstartScene: start\n";
    for (const [name, text] of Object.entries(documents)) {
      files[`${adventure}/${name}`] = text;
    }
    const report = await checkPlugins(
      memoryStorage(files),
      ["plugins"],
      systems,
    );
    return report.issues.map((issue) => issue.message);
  }

  const scenes = (args: string): string =>
    `- id: start\n  text: Hi.\n  choices:\n    - label: Look\n      effects:\n        - { kind: system, effect: "dnd5.5e:treasure", args: ${args} }\n        - { kind: goto, scene: end }\n- { id: end, text: The end. }\n`;

  it("accepts known items", async () => {
    const issues = await issuesFor({
      "scenes.yaml": scenes(`{ gold: 5, items: ["${POTION}"] }`),
    });
    expect(issues).toEqual([]);
  });

  it("reports an unknown item from the treasure effect", async () => {
    const issues = await issuesFor({
      "scenes.yaml": scenes('{ items: ["srd52:item/nope"] }'),
    });
    expect(issues.join("\n")).toContain('unknown reference "srd52:item/nope"');
  });

  it("reports an unknown or non-item id in an encounter's loot", async () => {
    const encounter = (items: string): string =>
      `- id: fight\n  monsters: [{ monster: "srd52:monster/goblin-warrior" }]\n  loot: { gold: 3, items: [${items}] }\n`;
    const scenesText = "- { id: start, text: The end. }\n";
    expect(
      (
        await issuesFor({
          "scenes.yaml": scenesText,
          "encounters.yaml": encounter('"srd52:item/nope"'),
        })
      ).join("\n"),
    ).toContain('unknown reference "srd52:item/nope"');
    expect(
      (
        await issuesFor({
          "scenes.yaml": scenesText,
          "encounters.yaml": encounter('"srd52:spell/magic-missile"'),
        })
      ).join("\n"),
    ).toContain("must be an item id");
  });
});
