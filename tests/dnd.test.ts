import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { listAdventures, loadAdventure } from "../app/cli/load-adventure.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { GameState } from "../engine/kernel/events.ts";
import type { Registry } from "../engine/kernel/loader.ts";
import { createSave, loadSave, replayInputs } from "../engine/kernel/save.ts";
import {
  type StoryFile,
  validateAdventure,
} from "../engine/story/adventure.ts";
import { type RunContext, startRun, step } from "../engine/kernel/turn.ts";
import { checkPlugins } from "../engine/tools/check-pack.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { playRun, testAdventure } from "../engine/tools/bot.ts";
import { systems } from "../app/systems.ts";
import {
  HitSchema,
  choosePolicy,
  damageEvents,
  nextDndDecision,
  runAfterReaction,
  runApplyHit,
  runAttackRoll,
  runCheckCombatEnd,
  runEndTurn,
  runRecheckHit,
  runTakeAction,
  shortRestEvents,
  startCombat,
  effectEnds,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  BattlemapSchema,
  ResolutionSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { doesSomething } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { runEscape } from "../plugins/systems/dnd5.5e/core/legendary.ts";
import {
  concentrationDc,
  finalDamage,
  halved,
  rollD20,
} from "../plugins/systems/dnd5.5e/core/rules.ts";
import {
  SpellSchema,
  type Spell,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  StateSchema,
  applyDndEvent,
  dndEvent,
  freshActor,
  isDead,
  isStable,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  abilityModifier,
  deriveStats,
  lookup,
  proficiencyBonus,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function systemState(state: GameState): DndState {
  return StateSchema.parse(state.system);
}

async function goblin(): Promise<RunContext> {
  return (await loadAdventure("goblin-ambush")).run;
}

function pregenActor(
  run: RunContext,
  slug: string,
  overrides: Partial<Actor> = {},
): Actor {
  const pregen = lookup(run, PregenSchema, `srd52:pregen/${slug}`);
  const actor = freshActor({
    id: slug,
    name: pregen.name,
    side: "party",
    source: { kind: "character", build: pregen.build },
    hp: 1,
    inventory: pregen.equipment,
  });
  return { ...actor, ...overrides };
}

describe("SRD damage rules", () => {
  it("matches the SRD's worked example: 28 fire with a −5 aura ends at 22", () => {
    expect(
      finalDamage(28, "fire", {
        adjustments: [-5],
        resistances: ["fire"],
        vulnerabilities: ["fire"],
      }),
    ).toBe(22);
  });

  it("counts Resistance once however many sources grant it", () => {
    expect(
      finalDamage(10, "necrotic", { resistances: ["necrotic", "necrotic"] }),
    ).toBe(5);
  });

  it("counts Vulnerability once however many sources grant it", () => {
    expect(finalDamage(10, "fire", { vulnerabilities: ["fire", "fire"] })).toBe(
      20,
    );
  });

  it("rounds a halved odd number down", () => {
    expect(finalDamage(7, "fire", { resistances: ["fire"] })).toBe(3);
    expect(halved(7)).toBe(3);
  });

  it("makes Immunity take damage to 0", () => {
    expect(
      finalDamage(50, "poison", {
        immunities: ["poison"],
        vulnerabilities: ["poison"],
      }),
    ).toBe(0);
  });

  it("never lets adjustments push damage below 0", () => {
    expect(finalDamage(3, "fire", { adjustments: [-5] })).toBe(0);
  });

  it("only applies a response to its own damage type", () => {
    expect(finalDamage(10, "cold", { resistances: ["fire"] })).toBe(10);
  });
});

describe("SRD roll rules", () => {
  const dice = () => createDice(rngFromSeed("d20"));

  it("takes the higher of two rolls with Advantage", () => {
    const roll = rollD20(dice(), { advantage: true, disadvantage: false });
    expect(roll.rolls).toHaveLength(2);
    expect(roll.natural).toBe(Math.max(...roll.rolls));
  });

  it("takes the lower of two rolls with Disadvantage", () => {
    const roll = rollD20(dice(), { advantage: false, disadvantage: true });
    expect(roll.natural).toBe(Math.min(...roll.rolls));
  });

  it("cancels Advantage and Disadvantage into one plain roll", () => {
    expect(
      rollD20(dice(), { advantage: true, disadvantage: true }).rolls,
    ).toHaveLength(1);
  });

  it.each([
    [0, 10],
    [19, 10],
    [20, 10],
    [21, 10],
    [22, 11],
    [59, 29],
    [60, 30],
    [100, 30],
  ])("sets the Concentration DC for %i damage to %i", (damage, dc) => {
    expect(concentrationDc(damage)).toBe(dc);
  });

  it.each([
    [1, -5],
    [8, -1],
    [10, 0],
    [11, 0],
    [12, 1],
    [20, 5],
  ])("gives a score of %i a modifier of %i", (score, modifier) => {
    expect(abilityModifier(score)).toBe(modifier);
  });

  it.each([
    [1, 2],
    [4, 2],
    [5, 3],
    [17, 6],
    [20, 6],
  ])("gives level %i a Proficiency Bonus of %i", (level, bonus) => {
    expect(proficiencyBonus(level)).toBe(bonus);
  });
});

describe("derived stats", () => {
  it("calculates a Fighter from choices and gear", async () => {
    const run = await goblin();
    const stats = deriveStats(pregenActor(run, "fighter"), run);
    expect(stats.abilities.str).toBe(17); // base 15, Soldier +2
    expect(stats.abilities.con).toBe(15); // base 14, Soldier +1
    expect(stats.maxHp).toBe(12); // d10 maximum of 10, Con +2
    expect(stats.ac).toBe(18); // Chain Mail 16, Shield +2
    expect(stats.resources["second-wind"]).toBe(2);
    expect(stats.skills).toContain("athletics"); // from Soldier
    expect(stats.skills).toContain("perception"); // from a class choice
    expect(stats.savingThrows).toEqual(["str", "con"]);
  });

  it("lets Dexterity raise light armor but not heavy armor", async () => {
    const run = await goblin();
    const rogue = deriveStats(pregenActor(run, "rogue"), run);
    expect(rogue.ac).toBe(11 + abilityModifier(17));
  });

  it("caps Dexterity on medium armor", async () => {
    const run = await goblin();
    const cleric = pregenActor(run, "cleric");
    const build =
      cleric.source.kind === "character" ? cleric.source.build : null;
    if (!build) throw new Error("No build");
    const quick = {
      ...cleric,
      source: {
        kind: "character" as const,
        build: {
          ...build,
          baseAbilities: { ...build.baseAbilities, dex: 18 },
        },
      },
    };
    expect(deriveStats(quick, run).ac).toBe(14 + 2 + 2);
  });

  it("uses only the best AC formula, then adds bonuses", async () => {
    const run = await goblin();
    const wizard = pregenActor(run, "wizard", {
      activeEffects: [
        {
          sourceId: "shield",
          casterId: "wizard",
          ends: "casterNextTurn",
          modifier: {
            kind: "bonus",
            to: "ac",
            amount: { bonus: { base: 5, add: [] } },
          },
        },
      ],
    });
    expect(deriveStats(wizard, run).ac).toBe(10 + 2 + 5);
  });

  it("counts two effects from one source once", async () => {
    const run = await goblin();
    const effect = {
      sourceId: "same",
      casterId: "wizard",
      ends: "casterNextTurn" as const,
      modifier: {
        kind: "bonus" as const,
        to: "ac" as const,
        amount: { bonus: { base: 5, add: [] } },
      },
    };
    const wizard = pregenActor(run, "wizard", {
      activeEffects: [effect, effect],
    });
    expect(deriveStats(wizard, run).ac).toBe(17);
  });

  it("calculates spell slots and a spell save DC", async () => {
    const run = await goblin();
    const cleric = deriveStats(pregenActor(run, "cleric"), run);
    expect(cleric.slots).toEqual([2]);
    expect(cleric.spellAbility).toBe("wis");
    expect(cleric.abilities.wis).toBe(17);
  });

  it("caps background increases at 20", async () => {
    const run = await goblin();
    const fighter = pregenActor(run, "fighter");
    const build =
      fighter.source.kind === "character" ? fighter.source.build : null;
    if (!build) throw new Error("No build");
    const strong = {
      ...fighter,
      source: {
        kind: "character" as const,
        build: { ...build, baseAbilities: { ...build.baseAbilities, str: 20 } },
      },
    };
    expect(deriveStats(strong, run).abilities.str).toBe(20);
  });
});

describe("encoded spells", () => {
  const spell = (run: RunContext, slug: string): Spell =>
    lookup(run, SpellSchema, `srd52:spell/${slug}`);

  it("expresses Fireball with one damage roll, halved on a save", async () => {
    const { activation } = spell(await goblin(), "fireball");
    expect(activation?.resolution).toMatchObject({
      kind: "save",
      ability: "dex",
      onSuccessDamage: "half",
      damage: [{ amount: { dice: "8d6" }, type: "fire" }],
    });
  });

  it("expresses Cure Wounds with dice and a spell modifier", async () => {
    const { activation } = spell(await goblin(), "cure-wounds");
    expect(activation?.resolution).toMatchObject({
      kind: "automatic",
      effects: [
        {
          kind: "heal",
          amount: { dice: "2d8", bonus: { add: [{ kind: "spellMod" }] } },
        },
      ],
    });
  });

  it("expresses Bless as two concentration bonuses", async () => {
    const parsed = spell(await goblin(), "bless");
    expect(parsed.activation?.targeting).toMatchObject({ creatures: 3 });
    expect(parsed.activation?.resolution).toMatchObject({
      effects: [
        { modifier: { to: "attacks", amount: { dice: "1d4" } } },
        { modifier: { to: "saves", amount: { dice: "1d4" } } },
      ],
    });
  });

  it("expresses Shield as a reaction, and marks it partly automated", async () => {
    const parsed = spell(await goblin(), "shield");
    expect(parsed.automation).toBe("partial");
    expect(parsed.activation?.cost).toEqual(["reaction", "slot"]);
    expect(parsed.activation?.trigger?.hitByAttack).toBe(true);
  });

  it("builds a Longsword attack from weapon data", async () => {
    const run = await goblin();
    const action = deriveStats(pregenActor(run, "fighter"), run).actions.find(
      (item) => item.id === "weapon:srd52:item/longsword",
    );
    expect(action?.activation.resolution).toMatchObject({
      kind: "attack",
      attack: { type: "weapon", ability: "str" },
      damage: [
        {
          amount: {
            dice: "1d8",
            bonus: { add: [{ kind: "abilityMod", ability: "str" }] },
          },
          type: "slashing",
        },
      ],
    });
  });

  it("uses Dexterity for a Finesse weapon when it's better", async () => {
    const run = await goblin();
    const action = deriveStats(pregenActor(run, "rogue"), run).actions.find(
      (item) => item.id === "weapon:srd52:item/shortsword",
    );
    expect(action?.activation.resolution).toMatchObject({
      attack: { ability: "dex" },
    });
  });
});

describe("damage and death in state", () => {
  const baseState = (actor: Actor): DndState => ({
    actors: { [actor.id]: actor },
    combat: null,
  });
  const damaged = (actor: string, amount: number, critical = false) =>
    dndEvent(`${NS}:damaged`, {
      actor,
      amount,
      type: "fire",
      critical,
      massive: false,
    });

  it("takes damage from Temporary Hit Points first", async () => {
    const run = await goblin();
    const state = baseState(pregenActor(run, "fighter", { hp: 10, tempHp: 4 }));
    const after = applyDndEvent(state, damaged("fighter", 6));
    expect(after.actors.fighter?.tempHp).toBe(0);
    expect(after.actors.fighter?.hp).toBe(8);
  });

  it("stops at 0 Hit Points", async () => {
    const run = await goblin();
    const state = baseState(pregenActor(run, "fighter", { hp: 3 }));
    expect(
      applyDndEvent(state, damaged("fighter", 50)).actors.fighter?.hp,
    ).toBe(0);
  });

  it("adds a death save failure when hit at 0, and two for a critical", async () => {
    const run = await goblin();
    const state = baseState(pregenActor(run, "fighter", { hp: 0 }));
    let after = applyDndEvent(state, damaged("fighter", 1));
    expect(after.actors.fighter?.deathSaves.failures).toBe(1);
    after = applyDndEvent(after, damaged("fighter", 1, true));
    expect(after.actors.fighter?.deathSaves.failures).toBe(3);
  });

  it("counts death saves, with 1 and 20 as special cases", async () => {
    const run = await goblin();
    const state = baseState(pregenActor(run, "fighter", { hp: 0 }));
    const roll = (current: DndState, natural: number) =>
      applyDndEvent(
        current,
        dndEvent(`${NS}:deathSaveRolled`, { actor: "fighter", natural }),
      );
    expect(roll(state, 10).actors.fighter?.deathSaves.successes).toBe(1);
    expect(roll(state, 9).actors.fighter?.deathSaves.failures).toBe(1);
    expect(roll(state, 1).actors.fighter?.deathSaves.failures).toBe(2);
    expect(roll(state, 20).actors.fighter?.hp).toBe(1);
  });

  it("clears death saves when healed, up to the maximum", async () => {
    const run = await goblin();
    const state = baseState(
      pregenActor(run, "fighter", {
        hp: 0,
        deathSaves: { successes: 1, failures: 2 },
      }),
    );
    const after = applyDndEvent(
      state,
      dndEvent(`${NS}:healed`, { actor: "fighter", amount: 99, max: 12 }),
    );
    expect(after.actors.fighter?.hp).toBe(12);
    expect(after.actors.fighter?.deathSaves).toEqual({
      successes: 0,
      failures: 0,
    });
  });

  it("keeps the higher Temporary Hit Points rather than adding them", async () => {
    const run = await goblin();
    const state = baseState(pregenActor(run, "fighter", { tempHp: 5 }));
    const after = applyDndEvent(
      state,
      dndEvent(`${NS}:tempHpGained`, { actor: "fighter", amount: 3 }),
    );
    expect(after.actors.fighter?.tempHp).toBe(5);
  });

  it("ends a caster's concentration effects on everyone", async () => {
    const run = await goblin();
    const fighter = pregenActor(run, "fighter", {
      activeEffects: [
        {
          sourceId: "bless",
          casterId: "cleric",
          ends: "concentration",
          modifier: { kind: "advantage", on: "attacks" },
        },
      ],
    });
    const cleric = pregenActor(run, "cleric", { concentratingOn: "bless" });
    const state: DndState = {
      actors: { fighter, cleric },
      combat: null,
    };
    const after = applyDndEvent(
      state,
      dndEvent(`${NS}:concentrationEnded`, { actor: "cleric" }),
    );
    expect(after.actors.fighter?.activeEffects).toEqual([]);
    expect(after.actors.cleric?.concentratingOn).toBeNull();
  });
});

describe("life and death in combat", () => {
  const ROUND = {
    encounter: "fight",
    order: ["a", "b", "c"],
    index: 0,
    round: 1,
  };

  function makeContext(run: RunContext, state: DndState, seed = "ctx") {
    return {
      state,
      dice: createDice(rngFromSeed(seed)),
      content: run.content,
      contentIds: run.contentIds,
    };
  }

  function fightState(
    run: RunContext,
    overrides: Partial<Actor> = {},
  ): DndState {
    const player = pregenActor(run, "fighter", {
      id: PLAYER_ACTOR,
      hp: 12,
      ...overrides,
    });
    const goblin = freshActor({
      id: "goblin",
      name: "Goblin",
      side: "enemy",
      source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
      hp: 10,
      inventory: [],
    });
    const ally = pregenActor(run, "rogue", { id: "ally", hp: 10 });
    return {
      actors: { [PLAYER_ACTOR]: player, goblin, ally },
      combat: {
        encounter: "fight",
        order: [PLAYER_ACTOR, "goblin", "ally"],
        index: 0,
        round: 1,
      },
    };
  }

  it("ends the run when the player's character dies, even if allies are standing", async () => {
    const run = await goblin();
    const state = fightState(run, {
      hp: 0,
      deathSaves: { successes: 0, failures: 3 },
    });
    const result = runCheckCombatEnd(makeContext(run, state));
    expect(result.events).toEqual([{ kind: "partyDefeated" }]);
  });

  it("lets the party survive a lost fight only when the encounter plans for it", async () => {
    const run = await goblin();
    const base = fightState(run, { hp: 0 });
    const ally = base.actors.ally;
    if (!ally || !base.combat) throw new Error("No fight");
    const lost: DndState = {
      ...base,
      actors: { ...base.actors, ally: { ...ally, hp: 0 } },
    };
    expect(runCheckCombatEnd(makeContext(run, lost)).events).toEqual([
      { kind: "partyDefeated" },
    ]);
    const planned: DndState = {
      ...lost,
      combat: { ...base.combat, defeatContinues: true },
    };
    expect(runCheckCombatEnd(makeContext(run, planned)).events).toEqual([
      { kind: "encounterEnded", encounter: "fight", outcome: "defeat" },
      dndEvent(`${NS}:combatEnded`, {}),
    ]);
  });

  it("ends the run when the player dies, whatever the encounter planned", async () => {
    const run = await goblin();
    const base = fightState(run, {
      hp: 0,
      deathSaves: { successes: 0, failures: 3 },
    });
    if (!base.combat) throw new Error("No fight");
    const state: DndState = {
      ...base,
      combat: { ...base.combat, defeatContinues: true, canFlee: true },
    };
    expect(runCheckCombatEnd(makeContext(run, state)).events).toEqual([
      { kind: "partyDefeated" },
    ]);
  });

  it("offers fleeing only to the player, and only when the encounter allows it", async () => {
    const run = await goblin();
    const base = fightState(run);
    if (!base.combat) throw new Error("No fight");
    const optionsFor = (state: DndState): readonly string[] =>
      nextDndDecision(state, run)?.options.map((option) => option.id) ?? [];
    expect(optionsFor(base)).not.toContain("flee");

    const allowed: DndState = {
      ...base,
      combat: { ...base.combat, canFlee: true },
    };
    expect(optionsFor(allowed)).toContain("flee");
    expect(optionsFor(allowed).at(-1)).toBe("pass");
    expect(
      optionsFor({
        ...allowed,
        combat: { ...base.combat, canFlee: true, index: 2 },
      }),
    ).not.toContain("flee");

    // Nobody stands within reach here, so the run is free and ends the fight.
    const { frames = [] } = runTakeAction(
      { actor: PLAYER_ACTOR, answer: "flee" },
      makeContext(run, allowed),
    );
    expect(frames.map((item) => item.kind)).toEqual([
      `${NS}:checkCombatEnd`,
      `${NS}:escape`,
    ]);
    expect(
      runEscape({ actor: PLAYER_ACTOR }, makeContext(run, allowed)).events,
    ).toEqual([
      { kind: "encounterEnded", encounter: "fight", outcome: "flee" },
      dndEvent(`${NS}:combatEnded`, {}),
    ]);
  });

  it("drops an attack still queued when the fight has already ended", async () => {
    const run = await goblin();
    const over: DndState = { ...fightState(run), combat: null };
    expect(
      runAttackRoll(
        { attacker: "gone", actionId: "monster:0", target: PLAYER_ACTOR },
        makeContext(run, over),
      ),
    ).toEqual({});
  });

  it("scales monster counts to the living party when an encounter asks", async () => {
    const run = await goblin();
    const state = fightState(run); // two living party members
    const monster = "srd52:monster/goblin-warrior";
    const count = (written: number, forPartySize?: number): number => {
      const { events = [] } = startCombat(
        {
          id: "e",
          monsters: [{ monster, count: written }],
          ...(forPartySize ? { forPartySize } : {}),
        },
        makeContext(run, state),
        { canFlee: false, defeatContinues: false },
      );
      const started = events.find(
        (event) => event.kind === `${NS}:combatStarted`,
      );
      if (!started || !("payload" in started)) throw new Error("No combat");
      return (started.payload.monsters as readonly unknown[]).length;
    };
    expect(count(4)).toBe(4);
    expect(count(4, 4)).toBe(2);
    expect(count(1, 8)).toBe(1); // always at least one
    expect(count(3, 2)).toBe(3);
    expect(count(2, 1)).toBe(4);
  });

  it("starts a fight on its battle map, with walls that block the way", async () => {
    const run = await goblin();
    const state = fightState(run);
    const battlemap = BattlemapSchema.parse({
      image: "assets/map.png",
      imageWidth: 500,
      imageHeight: 400,
      crop: { x: 0, y: 0, width: 500, height: 400 },
      columns: 5,
      rows: 4,
      walls: ["..#..", "..#..", "..#..", "....."],
      party: [[0, 0]],
      monsters: [[4, 0]],
    });
    const { events = [] } = startCombat(
      {
        id: "e",
        monsters: [{ monster: "srd52:monster/goblin-warrior", count: 2 }],
        battlemap,
      },
      makeContext(run, state),
      { canFlee: false, defeatContinues: false },
    );
    const started = events.find(
      (event) => event.kind === `${NS}:combatStarted`,
    );
    if (!started || !("payload" in started)) throw new Error("No combat");
    const payload = started.payload as {
      positions: Record<string, { x: number; y: number }>;
      walls: readonly string[];
      grid: { width: number; height: number };
    };
    expect(payload.grid).toEqual({ width: 5, height: 4 });
    expect(payload.positions[PLAYER_ACTOR]).toEqual({ x: 0, y: 0 });
    expect(payload.walls).toContain("2,1");
    // Everyone gets a square of their own, and nobody stands in a wall.
    const squares = Object.values(payload.positions).map(
      ({ x, y }) => `${String(x)},${String(y)}`,
    );
    expect(new Set(squares).size).toBe(squares.length);
    for (const square of squares) expect(payload.walls).not.toContain(square);
  });

  it("rejects a battle map that starts someone in a wall or can't be crossed", () => {
    const map = {
      image: "assets/map.png",
      imageWidth: 300,
      imageHeight: 300,
      crop: { x: 0, y: 0, width: 300, height: 300 },
      columns: 3,
      rows: 3,
      walls: ["...", "###", "..."],
      party: [[0, 0]],
      monsters: [[0, 2]],
    };
    expect(BattlemapSchema.safeParse(map).success).toBe(false); // the wall cuts them apart
    expect(
      BattlemapSchema.safeParse({ ...map, walls: ["...", "##.", "..."] })
        .success,
    ).toBe(true);
    expect(
      BattlemapSchema.safeParse({
        ...map,
        walls: ["#..", "...", "..."],
      }).success,
    ).toBe(false); // the party starts in a wall
  });

  it("heals with hit dice on a short rest, which run out", async () => {
    const run = await goblin();
    const rest = (state: DndState, seed: string): readonly SystemEvent[] =>
      shortRestEvents(makeContext(run, state, seed));
    const base = fightState(run, { hp: 1 });
    const hurt: DndState = {
      actors: Object.fromEntries(
        Object.entries(base.actors).filter(([, item]) => item.side === "party"),
      ),
      combat: null,
    };
    const player = hurt.actors[PLAYER_ACTOR];
    const ally = hurt.actors.ally;
    if (!player || !ally) throw new Error("No party");
    const max = deriveStats(ally, run).maxHp;
    const state: DndState = {
      ...hurt,
      actors: { ...hurt.actors, ally: { ...ally, hp: max } },
    };

    const events = rest(state, "a");
    expect(events.map((event) => event.kind)).toEqual([
      `${NS}:resourceSpent`,
      `${NS}:healed`,
    ]);
    const after = events.reduce(applyDndEvent, state);
    expect(after.actors[PLAYER_ACTOR]?.hp).toBeGreaterThan(1);
    expect(after.actors[PLAYER_ACTOR]?.resourcesSpent.hitDice).toBe(1);
    expect(after.actors.ally?.hp).toBe(max);

    // A level 1 character has one die, so a second rest gives nothing.
    const hurtAgain: DndState = {
      ...after,
      actors: {
        ...after.actors,
        [PLAYER_ACTOR]: { ...player, hp: 1, resourcesSpent: { hitDice: 1 } },
      },
    };
    expect(rest(hurtAgain, "b")).toEqual([]);

    // The dead don't rest.
    const dead: DndState = {
      ...state,
      actors: {
        ...state.actors,
        [PLAYER_ACTOR]: {
          ...player,
          hp: 0,
          deathSaves: { successes: 0, failures: 3 },
        },
      },
    };
    expect(rest(dead, "c")).toEqual([]);
  });

  it("carries on when a companion dies but the player lives", async () => {
    const run = await goblin();
    const base = fightState(run);
    const ally = base.actors.ally;
    if (!ally) throw new Error("No ally");
    const state: DndState = {
      ...base,
      actors: {
        ...base.actors,
        ally: { ...ally, hp: 0, deathSaves: { successes: 0, failures: 3 } },
      },
    };
    expect(runCheckCombatEnd(makeContext(run, state)).events ?? []).toEqual([]);
  });

  it("stops asking for death saves after three successes", async () => {
    const run = await goblin();
    const base = fightState(run);
    const ally = base.actors.ally;
    if (!ally) throw new Error("No ally");
    const stable = {
      ...ally,
      hp: 0,
      deathSaves: { successes: 3, failures: 0 },
    };
    expect(isStable(stable)).toBe(true);
    const state: DndState = {
      ...base,
      actors: { ...base.actors, ally: stable },
      combat: { ...ROUND, order: ["goblin", "ally", PLAYER_ACTOR], index: 0 },
    };
    const after = applyDndEvent(state, dndEvent(`${NS}:turnAdvanced`, {}));
    // The stable ally is skipped, so the next turn belongs to the player.
    expect(after.combat?.index).toBe(2);
    expect(nextDndDecision(after, run)?.actor).toBe(PLAYER_ACTOR);
  });

  it("kills outright when leftover damage reaches the HP maximum", async () => {
    const run = await goblin();
    // The SRD's own example: maximum 12, current 6, takes 18, so 12 remains.
    const state = fightState(run, { hp: 6 });
    const context = makeContext(run, state);
    const player = state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("No player");
    const hit = runApplyMassive(player, 18, context);
    expect(hit.events.map((event) => event.kind)).toContain("actorDefeated");
    let after = state;
    for (const event of hit.events) after = applyDndEvent(after, event);
    const dead = after.actors[PLAYER_ACTOR];
    if (!dead) throw new Error("No player");
    expect(dead.hp).toBe(0);
    expect(isDead(dead)).toBe(true);
  });

  it("only knocks a character down when leftover damage is below the maximum", async () => {
    const run = await goblin();
    const state = fightState(run, { hp: 6 });
    const player = state.actors[PLAYER_ACTOR];
    if (!player) throw new Error("No player");
    const hit = runApplyMassive(player, 17, makeContext(run, state));
    expect(hit.events.map((event) => event.kind)).toContain("actorDowned");
    expect(hit.events.map((event) => event.kind)).not.toContain(
      "actorDefeated",
    );
  });

  it("has spellcasting companions use their cantrips", async () => {
    const run = await goblin();
    const base = fightState(run);
    const wizard = pregenActor(run, "wizard", { id: "ally", hp: 8 });
    const state: DndState = {
      ...base,
      actors: { ...base.actors, ally: wizard },
      combat: { ...ROUND, order: ["ally", "goblin", PLAYER_ACTOR], index: 0 },
    };
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("No decision");
    const choices = decision.options.map((option) => option.id);
    expect(choices).toContain("spell:srd52:spell/fire-bolt|goblin");
    const picked = choosePolicy(decision, makeContext(run, state));
    expect(picked).toContain("goblin");
    expect(picked).not.toBe("pass");
  });

  it("has a healer help an ally below half HP", async () => {
    const run = await goblin();
    const base = fightState(run, { hp: 3 });
    const cleric = pregenActor(run, "cleric", { id: "ally", hp: 10 });
    const state: DndState = {
      ...base,
      actors: { ...base.actors, ally: cleric },
      combat: { ...ROUND, order: ["ally", "goblin", PLAYER_ACTOR], index: 0 },
    };
    const decision = nextDndDecision(state, run);
    if (!decision) throw new Error("No decision");
    const picked = choosePolicy(decision, makeContext(run, state));
    expect(picked).toContain(PLAYER_ACTOR);
    expect(picked).toMatch(/cure-wounds|healing-word/);
  });

  it("lets Fireball roll once for all, halved and rounded down for those who save", async () => {
    const run = await goblin();
    const monster = (id: string): Actor =>
      freshActor({
        id,
        name: id,
        side: "enemy",
        source: { kind: "monster", statBlockId: "srd52:monster/goblin-boss" },
        hp: 500,
        inventory: [],
      });
    const wizard = pregenActor(run, "wizard", { id: PLAYER_ACTOR, hp: 8 });
    const build =
      wizard.source.kind === "character" ? wizard.source.build : null;
    const [level] = build?.levels ?? [];
    if (!build || !level) throw new Error("No build");
    const caster: Actor = {
      ...wizard,
      source: {
        kind: "character",
        build: {
          ...build,
          levels: [
            {
              ...level,
              answers: [{ kind: "spells", values: ["srd52:spell/fireball"] }],
            },
          ],
        },
      },
    };
    const enemies = ["a", "b", "c", "d", "e", "f"].map(monster);
    const state: DndState = {
      actors: {
        [PLAYER_ACTOR]: caster,
        ...Object.fromEntries(enemies.map((enemy) => [enemy.id, enemy])),
      },
      combat: {
        encounter: "fight",
        order: [PLAYER_ACTOR, ...enemies.map((enemy) => enemy.id)],
        index: 0,
        round: 1,
      },
    };

    let sawBoth = false;
    for (let index = 0; index < 40 && !sawBoth; index += 1) {
      const result = runTakeAction(
        {
          actor: PLAYER_ACTOR,
          answer: "spell:srd52:spell/fireball|all",
        },
        makeContext(run, state, `fireball-${String(index)}`),
      );
      const amounts = (result.events ?? []).flatMap((event) =>
        event.kind === `${NS}:damaged` && "payload" in event
          ? [Number(event.payload.amount)]
          : [],
      );
      expect(amounts).toHaveLength(6);
      const full = Math.max(...amounts);
      for (const amount of amounts) {
        expect([full, Math.floor(full / 2)]).toContain(amount);
      }
      sawBoth = new Set(amounts).size === 2;
    }
    expect(sawBoth).toBe(true);
  });

  it("lets Shield turn a hit into a miss, and expires on the caster's next turn", async () => {
    const run = await goblin();
    const wizard = pregenActor(run, "wizard", { id: "wizard", hp: 8 });
    const monster = freshActor({
      id: "goblin",
      name: "Goblin",
      side: "enemy",
      source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
      hp: 10,
      inventory: [],
    });
    const state: DndState = {
      actors: { wizard, goblin: monster },
      combat: { ...ROUND, order: ["goblin", "wizard"], index: 0 },
    };

    for (let index = 0; index < 200; index += 1) {
      const rolled = runAttackRoll(
        { attacker: "goblin", actionId: "monster:0", target: "wizard" },
        makeContext(run, state, `shield-${String(index)}`),
      );
      const [pending] = rolled.frames ?? [];
      if (pending?.kind !== "kernel:await") continue;

      const { decision } = pending.payload as {
        decision: { resume: { payload: Record<string, unknown> } };
      };
      const hit = HitSchema.parse(decision.resume.payload);
      const context = makeContext(run, state);
      const reacted = runAfterReaction(
        { ...hit, answer: "spell:srd52:spell/shield" },
        context,
      );
      let after = state;
      for (const event of reacted.events ?? []) {
        after = applyDndEvent(after, event);
      }
      const shielded = after.actors.wizard;
      if (!shielded) throw new Error("No wizard");
      expect(deriveStats(shielded, run).ac).toBe(
        deriveStats(wizard, run).ac + 5,
      );
      expect(shielded.budget.reaction).toBe(false);
      expect(shielded.resourcesSpent["slot:1"]).toBe(1);

      // The attack was within 5 of AC, so the +5 turns it into a miss.
      const recheck = runRecheckHit(hit, makeContext(run, after));
      expect(recheck.frames ?? []).toEqual([]);

      const nextTurn = applyDndEvent(after, dndEvent(`${NS}:turnAdvanced`, {}));
      const expired = nextTurn.actors.wizard;
      if (!expired) throw new Error("No wizard");
      expect(deriveStats(expired, run).ac).toBe(deriveStats(wizard, run).ac);
      return;
    }
    throw new Error("No seed triggered a reaction");
  });
});

function runApplyMassive(
  target: Actor,
  amount: number,
  context: Parameters<typeof runApplyHit>[1],
): { events: readonly SystemEvent[] } {
  return { events: damageEvents(target, amount, "fire", false, context) };
}

describe("playing a D&D adventure", () => {
  it("passes check-pack for every real plugin", async () => {
    const storage = await createNodeStorage(process.cwd());
    const report = await checkPlugins(storage, ["plugins"], systems);
    expect(report.issues).toEqual([]);
    expect(report.checked).toEqual(["goblin-ambush", "haunted-house", "srd52"]);
  });

  it("carries the required SRD attribution", async () => {
    const { registry } = await loadAdventure("goblin-ambush");
    const srd = registry.plugins.find((plugin) => plugin.id === "srd52");
    expect(srd?.attribution).toContain("System Reference Document 5.2");
    expect(srd?.attribution).toContain("Creative Commons Attribution 4.0");
  });

  it("asks the player to choose a character before the first scene", async () => {
    const run = await goblin();
    const started = startRun(run, "choose");
    expect(started.pending?.id).toBe("dnd5.5e:chooseCharacter");
    expect(started.state.story.scene).toBeNull();
    expect(started.pending?.options).toHaveLength(5);
    expect(started.pending?.options.at(-1)?.id).toBe("create");

    const chosen = step(run, started.state, {
      kind: "answer",
      decisionId: "dnd5.5e:chooseCharacter",
      optionId: "srd52:pregen/fighter",
    });
    if (!chosen.ok) throw new Error(chosen.error);
    expect(chosen.state.story.scene).toBe("road");
    const player = systemState(chosen.state).actors[PLAYER_ACTOR];
    expect(player?.hp).toBe(12);
    expect(player?.name).toBe("Human Fighter");
  });

  it("gives companions real characters from the start", async () => {
    const run = await goblin();
    const { state } = startRun(run, "party");
    const dnd = systemState(state);
    for (const id of ["companion-1", "companion-2"]) {
      const actor = dnd.actors[id];
      if (!actor) throw new Error(`Missing ${id}`);
      expect(actor.hp).toBe(deriveStats(actor, run).maxHp);
      expect(actor.name).toBe(state.companions[id]?.name);
    }
  });

  it.each(["goblin-ambush", "haunted-house"])(
    "finishes %s across many seeds, replaying exactly",
    async (adventure) => {
      const { run } = await loadAdventure(adventure);
      const report = testAdventure(run, { runs: 120, maxDecisions: 500 });
      expect(report.failures).toEqual([]);
      expect(report.unvisitedScenes).toEqual([]);
    },
    30_000, // many full playthroughs, which also run alongside other test files
  );

  it("keeps state as plain JSON that passes its schema at every step", async () => {
    const run = await goblin();
    for (let index = 0; index < 25; index += 1) {
      playRun(run, `json-${String(index)}`, {
        maxDecisions: 500,
        onState: (state) => {
          // Freezing makes any handler that mutates state throw on the next step.
          deepFreeze(state);
          expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
          StateSchema.parse(state.system);
        },
      });
    }
  });

  it("really fights: monsters take damage, and fights end in a win or a defeat", async () => {
    const run = await goblin();
    let wins = 0;
    let defeats = 0;
    for (let index = 0; index < 120; index += 1) {
      const played = playRun(run, `fight-${String(index)}`, {
        maxDecisions: 500,
      });
      const events = played.log.flatMap((entry) => entry.events);
      if (!events.some((event) => event.kind === "encounterStarted")) continue;
      expect(events.some((event) => event.kind.endsWith(":damaged"))).toBe(
        true,
      );
      if (played.outcome === "defeat") {
        defeats += 1;
        expect(events.some((event) => event.kind === "partyDefeated")).toBe(
          true,
        );
        expect(played.state.story.scene).not.toBe("safe-road");
      } else if (events.some((event) => event.kind === "encounterEnded")) {
        wins += 1;
      }
    }
    expect(wins).toBeGreaterThan(0);
    expect(defeats).toBeGreaterThan(0);
  }, 30_000); // many full playthroughs, which also run alongside other test files

  it("clears monsters and the combat when a fight is won", async () => {
    const run = await goblin();
    for (let index = 0; index < 120; index += 1) {
      const played = playRun(run, `clear-${String(index)}`, {
        maxDecisions: 500,
      });
      const events = played.log.flatMap((entry) => entry.events);
      if (
        played.outcome === "ending" &&
        events.some((event) => event.kind === "encounterEnded")
      ) {
        const dnd = systemState(played.state);
        expect(dnd.combat).toBeNull();
        expect(
          Object.values(dnd.actors).every((actor) => actor.side === "party"),
        ).toBe(true);
        return;
      }
    }
    throw new Error("No seed won a fight");
  });

  it("saves and resumes in the middle of a fight", async () => {
    const { registry, run } = await loadAdventure("goblin-ambush");
    for (let index = 0; index < 60; index += 1) {
      const seed = `mid-${String(index)}`;
      const played = playRun(run, seed, { maxDecisions: 500 });
      const fighting = played.log.findIndex((entry) =>
        entry.events.some((event) => event.kind === "encounterStarted"),
      );
      if (fighting === -1 || fighting + 2 >= played.log.length) continue;

      const cut = played.log.slice(0, fighting + 1);
      const save = createSave(registry, "goblin-ambush", seed, cut);
      const loaded = loadSave(JSON.stringify(save), registry, run);
      if (!loaded.ok) throw new Error(loaded.error);
      const replayed = replayInputs(
        run,
        seed,
        cut.map((entry) => entry.input),
      );
      expect(loaded.state).toStrictEqual(replayed.state);

      const next = played.log[fighting + 1]?.input;
      if (next?.kind !== "answer") throw new Error("Expected an answer");
      const fromSave = step(run, loaded.state, next);
      if (!fromSave.ok) throw new Error(fromSave.error);
      expect(fromSave.events).toStrictEqual(played.log[fighting + 1]?.events);
      return;
    }
    throw new Error("No seed had a fight to save in");
  });

  it("lists adventures through the command-line helper", async () => {
    // arrayContaining, since a machine may also hold private adventures.
    expect(await listAdventures()).toEqual(
      expect.arrayContaining(["goblin-ambush", "haunted-house"]),
    );
  });
});

describe("spell effects without a map", () => {
  const save = (onFail: readonly unknown[]) =>
    ResolutionSchema.parse({
      kind: "save",
      ability: "wis",
      dc: { add: [] },
      onFail,
    });
  const charmed = {
    kind: "applyCondition",
    condition: "charmed",
    duration: "instantaneous",
  };

  it("leaves out a spell that would only waste its slot", () => {
    expect(
      doesSomething(
        save([{ kind: "forcedMove", feet: 10, direction: "away" }]),
      ),
    ).toBe(false);
    expect(doesSomething(save([{ ...charmed, condition: "deafened" }]))).toBe(
      false,
    );
    expect(doesSomething(save([charmed]))).toBe(true);
  });

  it("keeps a spell with at least one working effect", () => {
    expect(
      doesSomething(
        save([
          { kind: "forcedMove", feet: 5, direction: "away" },
          { kind: "tempHp", amount: { dice: "1d4" } },
        ]),
      ),
    ).toBe(true);
  });

  it("keeps a timed effect past the caster's next turn", () => {
    expect(effectEnds({ minutes: 60 })).toBe("spellDuration");
    expect(effectEnds({ text: "Until dispelled" })).toBe("spellDuration");
    expect(effectEnds({ concentration: true, minutes: 1 })).toBe(
      "concentration",
    );
    expect(effectEnds({ until: "yourNextTurnStart" })).toBe("casterNextTurn");
  });
});

describe("conditions in combat", () => {
  const goblinIn = (state: DndState): Actor => {
    const actor = state.actors.goblin;
    if (!actor) throw new Error("No goblin");
    return actor;
  };

  const condition = (
    name: "paralyzed" | "blinded" | "poisoned",
    extra: Partial<Actor["activeEffects"][number]> = {},
  ): Actor["activeEffects"][number] => ({
    sourceId: "spell:test",
    casterId: "goblin",
    modifier: { kind: "condition", condition: name },
    ends: "spellDuration",
    ...extra,
  });

  async function fight(player: Partial<Actor> = {}) {
    const run = await goblin();
    const state: DndState = {
      actors: {
        [PLAYER_ACTOR]: pregenActor(run, "fighter", {
          id: PLAYER_ACTOR,
          hp: 12,
          ...player,
        }),
        goblin: freshActor({
          id: "goblin",
          name: "Goblin",
          side: "enemy",
          source: {
            kind: "monster",
            statBlockId: "srd52:monster/goblin-warrior",
          },
          hp: 10,
          inventory: [],
        }),
      },
      combat: {
        encounter: "fight",
        order: [PLAYER_ACTOR, "goblin"],
        index: 0,
        round: 1,
      },
    };
    const context = (seed: string) => ({
      state,
      dice: createDice(rngFromSeed(seed)),
      content: run.content,
      contentIds: run.contentIds,
    });
    return { run, state, context };
  }

  it("leaves an Incapacitated actor nothing to do but end the turn", async () => {
    const { run, state } = await fight({
      activeEffects: [condition("paralyzed")],
    });
    expect(nextDndDecision(state, run)?.options.map((o) => o.id)).toEqual([
      "pass",
    ]);
  });

  it("makes melee hits on a Paralyzed target critical", async () => {
    const { run, state, context } = await fight({
      activeEffects: [condition("paralyzed")],
    });
    const attack = deriveStats(goblinIn(state), run).actions.find(
      (action) => action.activation.resolution.kind === "attack",
    );
    expect(attack).toBeDefined();
    let hits = 0;
    for (let seed = 0; seed < 30; seed += 1) {
      const frames =
        runAttackRoll(
          {
            attacker: "goblin",
            actionId: attack?.id ?? "",
            target: PLAYER_ACTOR,
          },
          context(String(seed)),
        ).frames ?? [];
      for (const item of frames) {
        if (item.kind.endsWith(":applyHit")) {
          hits += 1;
          expect(item.payload).toMatchObject({ critical: true });
        }
      }
    }
    expect(hits).toBeGreaterThan(0);
  });

  it("gives attackers Disadvantage while Blinded, seen as lower hit rates", async () => {
    const hitsWith = async (effects: Actor["activeEffects"]) => {
      const { run, state, context } = await fight();
      const goblinActor = goblinIn(state);
      const blinded: DndState = {
        ...state,
        actors: {
          ...state.actors,
          goblin: { ...goblinActor, activeEffects: effects },
        },
      };
      const attack = deriveStats(goblinActor, run).actions.find(
        (action) => action.activation.resolution.kind === "attack",
      );
      let hits = 0;
      for (let seed = 0; seed < 300; seed += 1) {
        const report = runAttackRoll(
          {
            attacker: "goblin",
            actionId: attack?.id ?? "",
            target: PLAYER_ACTOR,
          },
          { ...context(String(seed)), state: blinded },
        );
        if ((report.frames ?? []).length > 0) hits += 1;
      }
      return hits;
    };
    expect(await hitsWith([condition("blinded")])).toBeLessThan(
      await hitsWith([]),
    );
  });

  it("repeats a save at the end of the target's turn and ends the effect on a success", async () => {
    const easy = await fight({
      activeEffects: [
        condition("paralyzed", { repeatSave: { ability: "wis", dc: -50 } }),
      ],
    });
    const passed = runEndTurn(easy.context("a")).events ?? [];
    expect(passed.map((event) => event.kind)).toEqual([
      "dnd5.5e:effectEnded",
      "dnd5.5e:turnAdvanced",
    ]);

    const hard = await fight({
      activeEffects: [
        condition("blinded", { repeatSave: { ability: "wis", dc: 99 } }),
      ],
    });
    const failed = runEndTurn(hard.context("a")).events ?? [];
    expect(failed.map((event) => event.kind)).toEqual(["dnd5.5e:turnAdvanced"]);
  });

  it("removes an effect that ends on damage when the target is hurt", async () => {
    const { state } = await fight({
      activeEffects: [
        condition("blinded", { endsOnDamage: true }),
        condition("poisoned"),
      ],
    });
    const after = applyDndEvent(
      state,
      dndEvent("dnd5.5e:damaged", {
        actor: PLAYER_ACTOR,
        amount: 1,
        type: "fire",
        critical: false,
        massive: false,
      }),
    );
    expect(after.actors[PLAYER_ACTOR]?.activeEffects).toHaveLength(1);
  });

  it("uses an armor formula when it beats the current AC", async () => {
    const { run, state } = await fight();
    const wizardLike = goblinIn(state);
    const base = deriveStats(wizardLike, run).ac;
    const raised = deriveStats(
      {
        ...wizardLike,
        activeEffects: [
          {
            sourceId: "spell:barkskin",
            casterId: "goblin",
            modifier: { kind: "acFormula", formula: { base: 30, add: [] } },
            ends: "spellDuration",
          },
        ],
      },
      run,
    ).ac;
    expect(base).toBeLessThan(30);
    expect(raised).toBe(30);
  });
});

describe("encounter outcomes in real fights", () => {
  async function outcomesRun(): Promise<{
    run: RunContext;
    registry: Registry;
  }> {
    const { registry, run } = await loadAdventure("goblin-ambush");
    const { adventure, issues } = validateAdventure({
      pluginId: "outcomes",
      system: run.system,
      fileName: (file) => file,
      assetPaths: new Set(),
      documents: new Map<StoryFile, unknown>([
        ["adventure", { title: "Outcomes", startScene: "start" }],
        [
          "encounters",
          [
            {
              id: "brawl",
              monsters: [{ monster: "srd52:monster/goblin-warrior", count: 4 }],
              forPartySize: 4,
              onDefeat: [{ kind: "goto", scene: "captured" }],
              onFlee: [{ kind: "goto", scene: "fled" }],
            },
          ],
        ],
        [
          "scenes",
          [
            {
              id: "start",
              text: "Start.",
              choices: [
                {
                  label: "Fight",
                  effects: [
                    { kind: "startEncounter", encounter: "brawl" },
                    { kind: "setFlag", flag: "won" },
                    { kind: "goto", scene: "camp" },
                  ],
                },
              ],
            },
            {
              id: "camp",
              text: "Camp.",
              choices: [
                {
                  label: "Rest",
                  effects: [
                    { kind: "system", effect: `${NS}:shortRest`, args: {} },
                    { kind: "goto", scene: "road" },
                  ],
                },
              ],
            },
            { id: "road", text: "Road." },
            { id: "captured", text: "Captured." },
            { id: "fled", text: "Fled." },
          ],
        ],
      ]),
    });
    if (!adventure || issues.length > 0)
      throw new Error(JSON.stringify(issues));
    return { registry, run: { ...run, adventure } };
  }

  it("branches on how the fight ended and never after the player dies", async () => {
    const { run } = await outcomesRun();
    const seen: Record<string, number> = {};
    for (let index = 0; index < 80; index += 1) {
      const played = playRun(run, `outcome-${String(index)}`, {
        maxDecisions: 800,
      });
      const { story } = played.state;
      const dnd = systemState(played.state);
      const key = played.outcome === "defeat" ? "dead" : (story.scene ?? "");
      seen[key] = (seen[key] ?? 0) + 1;

      if (played.outcome === "defeat") {
        const player = dnd.actors[PLAYER_ACTOR];
        if (!player) throw new Error("No player");
        expect(isDead(player)).toBe(true);
      } else {
        expect(played.outcome).toBe("ending");
        expect(dnd.combat).toBeNull();
        expect(
          Object.values(dnd.actors).every((actor) => actor.side === "party"),
        ).toBe(true);
        expect(story.flags.won).toBe(story.scene === "road" ? true : undefined);
      }
    }
    expect(seen.fled).toBeGreaterThan(0);
    expect(seen.captured).toBeGreaterThan(0);
    expect(seen.road).toBeGreaterThan(0);
  }, 30_000);

  it("replays exactly, from inputs and from a save", async () => {
    const { registry, run } = await outcomesRun();
    const report = testAdventure(run, { runs: 40, maxDecisions: 800 });
    expect(report.failures).toEqual([]);

    const played = playRun(run, "outcome-save", { maxDecisions: 800 });
    const save = createSave(
      registry,
      "goblin-ambush",
      "outcome-save",
      played.log,
    );
    const loaded = loadSave(JSON.stringify(save), registry, run);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.state).toStrictEqual(played.state);
  }, 30_000);
});
