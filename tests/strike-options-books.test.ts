import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import {
  type RunContext,
  createRunContext,
  startRun,
  step,
} from "../engine/run/turn.ts";
import {
  type Draft,
  classStep,
  levelEntry,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import type { CharacterBuild } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { sceneSwapActions } from "../plugins/systems/dnd5.5e/core/swap.ts";
import { offerInspiration } from "../plugins/systems/dnd5.5e/core/class-rules.ts";
import {
  hitFits,
  speedsLeft,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { freshActor } from "../plugins/systems/dnd5.5e/core/state.ts";
import { contextOf, scripted, settle } from "./feat-fixtures.ts";
import { BOOK_ROOTS } from "./depth.ts";

// Strike options and attack riders left from #157 and #158 (issue #202), on book characters. Skipped where the books
// aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/phb") &&
  existsSync("books/rules/eberron-forge-of-the-artificer") &&
  existsSync("books/rules/xanathars-guide");

let run: RunContext;
let player: Actor;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "strike-options-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "eberron-forge-of-the-artificer",
    "xanathars-guide",
    "heroes-of-faerun",
    "sword-coast-guide",
    "arcana-unleashed",
    "ravenloft-horrors-within",
    "astarions-book",
    "monster-manual",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
  const chosen = step(run, startRun(run, "books").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: "srd52:pregen/fighter",
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const actor = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  player = actor;
});

function baseBuild(): CharacterBuild {
  if (player.source.kind !== "character" || !player.source.build) {
    throw new Error("No build");
  }
  return player.source.build;
}

// The pregen's origin with these class levels, each answering only what's given.
function build(
  classId: string,
  levels: number,
  answers: Record<number, CharacterBuild["levels"][number]["answers"]> = {},
): CharacterBuild {
  return {
    ...baseBuild(),
    levels: Array.from({ length: levels }, (_, index) => ({
      classId,
      hitPointGain: 5,
      answers: answers[index + 1] ?? [],
    })),
  };
}

function actorWith(made: CharacterBuild): Actor {
  return { ...player, source: { kind: "character", build: made } };
}

// Every step of one level-up, answered with `answer` where it names the slot, else the first option.
function levelUp(
  classId: string,
  base: CharacterBuild,
  answer: Record<string, string>,
): { readonly slots: readonly string[]; readonly draft: Draft } {
  let draft: Draft = { classId, scores: [], picks: {} };
  const slots: string[] = [];
  for (
    let next = classStep(draft, base, run);
    next;
    next = classStep(draft, base, run)
  ) {
    slots.push(next.slot ?? next.key);
    const picked =
      answer[next.slot ?? ""] ?? next.options[0]?.id ?? "unanswerable";
    draft = next.apply(draft, picked);
  }
  return { slots, draft };
}

const CLERIC = "phb:class/cleric";
const BLESSED = "phb:feature/cleric-blessed-strikes";

describe.skipIf(!BOOKS)("features with options chosen when gained", () => {
  it("asks Blessed Strikes' option at Cleric 7 and keeps the pick on the level", () => {
    const base = build(CLERIC, 6);
    const { slots, draft } = levelUp(CLERIC, base, {
      [`variant:${BLESSED}`]: "divine-strike",
    });
    expect(slots).toContain(`variant:${BLESSED}`);
    const entry = levelEntry(draft, base, run);
    expect(entry.answers).toContainEqual({
      kind: "variant",
      feature: BLESSED,
      values: ["divine-strike"],
    });
    const stats = deriveStats(
      actorWith({ ...base, levels: [...base.levels, entry] }),
      run,
    );
    expect(stats.passives).toContainEqual(
      expect.objectContaining({
        kind: "extraDamage",
        dice: "1d8",
        types: ["necrotic", "radiant"],
      }),
    );
  });

  it("makes Improved Blessed Strikes follow the earlier pick instead of asking", () => {
    const pick = (value: string) =>
      build(CLERIC, 14, {
        7: [{ kind: "variant", feature: BLESSED, values: [value] }],
      });
    const strikes = (made: CharacterBuild) =>
      deriveStats(actorWith(made), run).passives.filter(
        (passive) => passive.kind === "extraDamage" && passive.dice === "1d8",
      );
    expect(strikes(pick("divine-strike"))).toHaveLength(2);
    expect(strikes(pick("potent-spellcasting"))).toHaveLength(0);
    const riders = deriveStats(
      actorWith(pick("potent-spellcasting")),
      run,
    ).passives.filter((passive) => passive.kind === "cantripRider");
    expect(riders).toHaveLength(2);
    expect(riders[1]).toMatchObject({ selfEffects: [{ kind: "tempHp" }] });
    // Level 14 asks nothing for Improved Blessed Strikes.
    const { slots } = levelUp(CLERIC, build(CLERIC, 13), {});
    expect(slots.some((slot) => slot.startsWith("variant:"))).toBe(false);
  });

  it("swaps Perfected Armor's bigger launcher in for Armor Model's", () => {
    const artificer = "eberron-forge-of-the-artificer:class/artificer";
    const armorer = "eberron-forge-of-the-artificer:subclass/artificer-armorer";
    const model =
      "eberron-forge-of-the-artificer:feature/artificer-armorer-armor-model";
    const launchers = (levels: number) =>
      deriveStats(
        actorWith(
          build(artificer, levels, {
            3: [
              { kind: "subclass", values: [armorer] },
              { kind: "variant", feature: model, values: ["infiltrator"] },
            ],
          }),
        ),
        run,
      ).actions.filter((action) =>
        action.name.endsWith("(Lightning Launcher)"),
      );
    expect(launchers(14).map(({ name }) => name)).toEqual([
      "Armor Model (Infiltrator) (Lightning Launcher)",
    ]);
    expect(launchers(15).map(({ name }) => name)).toEqual([
      "Perfected Armor (Infiltrator) (Lightning Launcher)",
    ]);
  });

  it("offers to change Hunter's Prey between fights after a rest", () => {
    const ranger = "phb:class/ranger";
    const prey = "phb:feature/ranger-hunter-hunter-s-prey";
    const made = build(ranger, 3, {
      3: [
        { kind: "subclass", values: ["phb:subclass/ranger-hunter"] },
        { kind: "variant", feature: prey, values: ["colossus-slayer"] },
      ],
    });
    const state = StateSchema.parse({
      ...StateSchema.parse(startRun(run, "books").state.system),
      actors: { [PLAYER_ACTOR]: actorWith(made) },
      sinceLongRest: 0,
    });
    expect(sceneSwapActions(state, run).map(({ label }) => label)).toEqual([
      "Change a pick of Hunter’s Prey",
    ]);
  });
});

// The pregen fighter with these features too.
function withFeatures(features: readonly string[], id = PLAYER_ACTOR): Actor {
  const made = baseBuild();
  const [first, ...rest] = made.levels;
  if (!first) throw new Error("No level");
  return {
    ...player,
    id,
    position: { x: 0, y: 0 },
    source: {
      kind: "character",
      build: {
        ...made,
        levels: [
          {
            ...first,
            answers: [
              ...first.answers,
              { kind: "features", values: [...features] },
            ],
          },
          ...rest,
        ],
      },
    },
  };
}

function monster(id: string, statBlockId: string, x: number): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId },
      hp: 40,
      inventory: [],
    }),
    position: { x, y: 0 },
  };
}

const kinds = (events: readonly { kind: string }[]) =>
  events.map(({ kind }) => kind);

describe.skipIf(!BOOKS)("strike options and riders in a fight", () => {
  it("asks which mastery a hit uses with Tactical Master, and Sap takes the weapon's own place", () => {
    const fighter = withFeatures(["phb:feature/fighter-tactical-master"]);
    const weapon = deriveStats(fighter, run).actions.find((action) =>
      action.id.startsWith("weapon:"),
    );
    if (!weapon) throw new Error("No weapon");
    const goblin = monster("goblin", "srd52:monster/goblin-warrior", 1);
    const { dice } = scripted([]);
    const { decisions, state } = settle(
      run,
      [fighter, goblin],
      [
        {
          kind: `${NS}:masteryHit`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: weapon.id,
            target: "goblin",
            critical: false,
            hadAdvantage: false,
            total: 20,
            natural: 15,
            dealt: 5,
          },
        },
      ],
      dice,
      (decision) =>
        decision.id.startsWith(`${NS}:mastery:`)
          ? "sap"
          : (decision.options[0]?.id ?? ""),
    );
    const asked = decisions.find(({ id }) => id.startsWith(`${NS}:mastery:`));
    // The pregen's longsword masters with Sap already, so Push and Slow are what it can swap to.
    expect(asked?.options.map(({ id }) => id).sort()).toEqual(
      expect.arrayContaining(["push", "slow"]),
    );
    expect(
      state.actors.goblin?.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "disadvantage" && modifier.on === "attacks",
      ),
    ).toBe(true);
  });

  it("keeps a Dazed creature from moving once it acts, and from acting once it moves", () => {
    const dazed = {
      ...monster("goblin", "srd52:monster/goblin-warrior", 1),
      activeEffects: [
        {
          sourceId: "daze",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "actionLimit" as const, oneThing: true as const },
          ends: "spellDuration" as const,
        },
      ],
    };
    const stats = deriveStats(dazed, run);
    expect(Math.max(...speedsLeft(dazed, stats).values())).toBeGreaterThan(0);
    const acted = { ...dazed, budget: { ...dazed.budget, action: false } };
    expect(Math.max(...speedsLeft(acted, stats).values())).toBe(0);
  });

  it("offers Master Duelist's reroll on a miss, once a rest", () => {
    const duelist = withFeatures([
      "xanathars-guide:feature/rogue-swashbuckler-master-duelist",
    ]);
    const goblin = monster("goblin", "srd52:monster/goblin-warrior", 1);
    const context = contextOf(run, [duelist, goblin], scripted([]).dice);
    const payload = {
      attacker: PLAYER_ACTOR,
      actionId: "weapon:srd52:item/longsword",
      target: "goblin",
    };
    const report: SystemEvent = { kind: `${NS}:rollReported`, payload: {} };
    const offered = offerInspiration(duelist, payload, report, undefined, {
      ...context,
      content: run.content,
      contentIds: run.contentIds,
    });
    expect(JSON.stringify(offered?.frames)).toContain(`${NS}:missReroll:`);
    const spent = {
      ...duelist,
      resourcesSpent: { "master-duelist": 1 },
    };
    expect(
      offerInspiration(
        spent,
        payload,
        report,
        undefined,
        contextOf(run, [spent, goblin], scripted([]).dice),
      ),
    ).toBeNull();
  });

  it("spares a Fiend Hurl Through Hell's Psychic damage, but not anyone else", () => {
    const warlock = withFeatures([
      "phb:feature/warlock-fiend-patron-hurl-through-hell",
    ]);
    const hurl = deriveStats(warlock, run).actions.find((action) =>
      action.id.startsWith(
        "feature:phb:feature/warlock-fiend-patron-hurl-through-hell:",
      ),
    );
    if (!hurl) throw new Error("No Hurl Through Hell");
    const dealt = (statBlockId: string) => {
      const foe = monster("foe", statBlockId, 1);
      // Every save fails.
      const { dice } = scripted([1, 1, 1, 1]);
      const result = resolveAction(
        hurl,
        warlock,
        [foe],
        contextOf(run, [warlock, foe], dice),
      );
      return kinds(result.events ?? []).includes(`${NS}:damaged`);
    };
    expect(dealt("monster-manual:monster/imp")).toBe(false);
    expect(dealt("srd52:monster/goblin-warrior")).toBe(true);
  });

  it("moves Vow of Enmity off the last creature when it's used again", () => {
    const paladin = withFeatures([
      "phb:feature/paladin-oath-of-vengeance-vow-of-enmity",
    ]);
    const vow = deriveStats(paladin, run).actions.find((action) =>
      action.id.startsWith(
        "feature:phb:feature/paladin-oath-of-vengeance-vow-of-enmity:",
      ),
    );
    if (!vow) throw new Error("No Vow of Enmity");
    const first = {
      ...monster("first", "srd52:monster/goblin-warrior", 1),
      activeEffects: [
        {
          sourceId: vow.id,
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "advantage" as const,
            on: "attacksAgainst" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const second = monster("second", "srd52:monster/goblin-warrior", 2);
    const result = resolveAction(
      vow,
      paladin,
      [second],
      contextOf(run, [paladin, first, second], scripted([]).dice),
    );
    const ended = (result.events ?? []).filter(
      (event) =>
        event.kind === `${NS}:effectEnded` &&
        JSON.stringify(event).includes(`"actor":"first"`) &&
        JSON.stringify(event).includes(vow.id),
    );
    expect(ended).toHaveLength(1);
  });

  it("takes Envenom Weapons' Poison in place of Cunning Strike's", () => {
    const poisons = (features: readonly string[]) =>
      deriveStats(withFeatures(features), run)
        .actions.filter((action) => action.activation.label === "Poison")
        .map(({ id }) => id.split(":feature/")[1]?.split(":")[0]);
    expect(poisons(["phb:feature/rogue-cunning-strike"])).toEqual([
      "rogue-cunning-strike",
    ]);
    expect(
      poisons([
        "phb:feature/rogue-cunning-strike",
        "phb:feature/rogue-assassin-envenom-weapons",
      ]),
    ).toEqual(["rogue-assassin-envenom-weapons"]);
  });

  it("bonds Pact of the Blade with one melee weapon only", () => {
    const warlock = {
      ...withFeatures(["phb:feature/warlock-pact-of-the-blade"]),
      inventory: ["srd52:item/longsword", "srd52:item/shortsword"],
    };
    const actions = deriveStats(warlock, run).actions;
    const fits = (item: string) => {
      const action = actions.find(({ id }) => id === `weapon:${item}`);
      return action ? hitFits("pactWeapon", action, warlock, run) : false;
    };
    expect(fits("srd52:item/longsword")).toBe(true);
    expect(fits("srd52:item/shortsword")).toBe(false);
  });

  it("gives Invincible Conqueror's extra attack only while it lasts", () => {
    const id =
      "xanathars-guide:feature/paladin-oath-of-conquest-invincible-conqueror";
    const paladin = withFeatures([id]);
    const base = deriveStats(paladin, run).multiattack;
    const avatar = {
      ...paladin,
      activeEffects: [
        {
          sourceId: `feature:${id}:0`,
          casterId: PLAYER_ACTOR,
          modifier: { kind: "resistance" as const, damage: "fire" as const },
          ends: "spellDuration" as const,
        },
      ],
    };
    expect(deriveStats(avatar, run).multiattack).toBe(base + 1);
  });

  it("plays two Arcane Shot options, and their bigger forms from Fighter level 18", () => {
    const shot = "xanathars-guide:feature/fighter-arcane-archer-arcane-shot";
    const archer = (levels: number) =>
      build("phb:class/fighter", levels, {
        3: [
          {
            kind: "subclass",
            values: ["xanathars-guide:subclass/fighter-arcane-archer"],
          },
          {
            kind: "variant",
            feature: shot,
            values: ["bursting-arrow", "shadow-arrow"],
          },
        ],
      });
    const named = (levels: number) =>
      deriveStats(actorWith(archer(levels)), run)
        .actions.filter(({ name }) => name.includes("Arrow"))
        .map(({ name }) => name);
    expect(named(3)).toEqual([
      "Arcane Shot (Bursting Arrow, Shadow Arrow) (Bursting Arrow)",
      "Arcane Shot (Bursting Arrow, Shadow Arrow) (Shadow Arrow)",
    ]);
    expect(named(18)).toEqual([
      "Arcane Shot Options (Bursting Arrow, Shadow Arrow) (Bursting Arrow)",
      "Arcane Shot Options (Bursting Arrow, Shadow Arrow) (Shadow Arrow)",
    ]);
  });
});
