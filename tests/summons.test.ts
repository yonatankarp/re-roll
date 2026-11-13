import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import {
  type Context,
  choosePolicy,
  nextDndDecision,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  ClassSchema,
  PregenSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  freshActor,
  isDead,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  attackBonus,
  deriveStats,
  doesSomething,
  evaluateFormula,
  spellSaveDc,
} from "../plugins/systems/dnd5.5e/core/stats.ts";

const LOW: Dice = { below: () => 0, roll: () => 1 };
const COMPANION = "srd52:companion/test-spirit";
const SPELL = "srd52:spell/test-summon";

const summoning = {
  cost: ["action", "slot"],
  targeting: { self: true },
  resolution: {
    kind: "automatic",
    effects: [
      {
        kind: "summon",
        companion: COMPANION,
        duration: { concentration: true, minutes: 60 },
        range: 30,
      },
    ],
  },
};

async function arena(): Promise<RunContext> {
  const base = (await loadAdventure("goblin-ambush")).run;
  const wizard = ClassSchema.parse(base.content("srd52:class/wizard"));
  const [first] = wizard.levels;
  if (!first) throw new Error("The wizard has no levels");
  const content: Record<string, unknown> = {
    "srd52:class/wizard": {
      ...wizard,
      levels: Array.from({ length: 20 }, (_, index) => ({
        ...(index === 0 ? first : { grants: [], choices: [], scaling: {} }),
        level: index + 1,
        slots: [4, 3, 3, 3, 3, 2, 2, 1, 1],
      })),
    },
    [COMPANION]: {
      id: COMPANION,
      name: "Test Spirit",
      size: "small",
      ac: "11 + the spell's level",
      hp: "30 + 5 for each spell level above 2",
      speed: "30 ft.",
      abilities: { str: 18, dex: 11, con: 16, int: 4, wis: 14, cha: 5 },
      text: "Senses Darkvision 60 ft.",
      play: {
        level: 2,
        ac: 13,
        acPerLevel: 1,
        hp: 30,
        hpPerLevel: 5,
        speed: 30,
        creatureType: "beast",
        halfLevelAttacks: true,
        actions: [
          {
            name: "Rend",
            activation: {
              cost: ["action"],
              targeting: { creatures: 1, range: 5, side: "enemy" },
              resolution: {
                kind: "attack",
                attack: { type: "spell" },
                damage: [
                  {
                    amount: {
                      dice: "1d8",
                      bonus: {
                        base: 4,
                        add: [{ kind: "scaling", key: "spellLevel" }],
                      },
                    },
                    type: "piercing",
                  },
                ],
              },
            },
          },
        ],
      },
    },
    [SPELL]: {
      id: SPELL,
      name: "Test Summon",
      level: 2,
      school: "conjuration",
      classes: [],
      castingTime: "Action",
      range: "90 feet",
      components: "V",
      duration: { concentration: true, minutes: 60 },
      text: "A test.",
      automation: "full",
      activation: summoning,
    },
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

function hero(run: RunContext, spells: readonly string[] = []): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  const answers = [{ kind: "spells" as const, values: [...spells] }];
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "Hero",
      side: "party",
      source: {
        kind: "character",
        build: {
          ...pregen.build,
          levels: Array.from({ length: 5 }, () => ({ ...first, answers })),
        },
      },
      hp: 30,
      inventory: [],
    }),
    position: { x: 0, y: 0 },
  };
}

function goblin(id: string, x: number): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
      hp: 10,
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
      grid: { width: 12, height: 12 },
    },
  };
}

const contextOf = (run: RunContext, state: DndState): Context => ({
  state,
  dice: LOW,
  content: run.content,
  contentIds: run.contentIds,
});

function cast(
  run: RunContext,
  state: DndState,
  caster: Actor,
  level: number,
): { readonly events: readonly SystemEvent[]; readonly state: DndState } {
  const { activation } = SpellSchema.parse(run.content(SPELL));
  if (!activation) throw new Error("No activation");
  const { events = [] } = resolveAction(
    { id: `spell:${SPELL}`, name: "Test Summon", activation, spellLevel: 2 },
    caster,
    [caster],
    contextOf(run, state),
    level,
  );
  return { events, state: events.reduce(applyDndEvent, state) };
}

function summonedIn(state: DndState): Actor {
  const found = Object.values(state.actors).find(
    (item) => item.source.kind === "summon",
  );
  if (!found) throw new Error("Nothing was summoned");
  return found;
}

describe("summoned creatures", () => {
  it("join right after the caster, next to a foe, with numbers for the slot and the caster's attack", async () => {
    const run = await arena();
    const caster = hero(run);
    const state = fight(caster, goblin("g", 5));
    const { state: after } = cast(run, state, caster, 4);
    const spirit = summonedIn(after);
    expect(after.combat?.order).toEqual([PLAYER_ACTOR, spirit.id, "g"]);
    expect(spirit.side).toBe("party");
    expect(spirit.position).toEqual({ x: 4, y: 0 });
    expect(spirit.hp).toBe(40);
    expect(after.actors[PLAYER_ACTOR]?.concentratingOn).toBe(`spell:${SPELL}`);
    const stats = deriveStats(spirit, run);
    const casterStats = deriveStats(caster, run);
    expect(stats.ac).toBe(15);
    expect(stats.multiattack).toBe(2);
    expect(stats.proficiency).toBe(casterStats.proficiency);
    const [rend] = stats.actions;
    if (rend?.activation.resolution.kind !== "attack") throw new Error("Rend");
    expect(attackBonus(rend.activation.resolution, stats)).toBe(
      spellSaveDc(casterStats) - 8,
    );
    const bonus = rend.activation.resolution.damage[0]?.amount.bonus;
    expect(bonus && evaluateFormula(bonus, stats)).toBe(8);
  });

  it("moves a lair's turn down when it joins before it", async () => {
    const run = await arena();
    const caster = hero(run);
    const start = fight(caster, goblin("g", 5));
    const state: DndState = start.combat
      ? { ...start, combat: { ...start.combat, lair: { at: 1 } } }
      : start;
    expect(cast(run, state, caster, 2).state.combat?.lair).toEqual({ at: 2 });
  });

  it("drops dead at 0 Hit Points, with no death saves, and its turn is passed by", async () => {
    const run = await arena();
    const caster = hero(run);
    const { state } = cast(run, fight(caster, goblin("g", 5)), caster, 2);
    const spirit = summonedIn(state);
    const hit = applyDndEvent(
      state,
      dndEvent(`${NS}:damaged`, {
        actor: spirit.id,
        amount: 100,
        type: "slashing",
        critical: false,
        massive: false,
      }),
    );
    expect(isDead(summonedIn(hit))).toBe(true);
    const next = applyDndEvent(hit, dndEvent(`${NS}:turnAdvanced`, {}));
    expect(next.combat?.order[next.combat.index]).toBe("g");
    expect(nextDndDecision(next, run)?.actor).toBe("g");
  });

  it("vanishes when the caster's Concentration ends, and leaves with the fight", async () => {
    const run = await arena();
    const caster = hero(run);
    const { state } = cast(run, fight(caster, goblin("g", 5)), caster, 2);
    const broken = applyDndEvent(
      state,
      dndEvent(`${NS}:concentrationEnded`, { actor: PLAYER_ACTOR }),
    );
    expect(summonedIn(broken).hp).toBe(0);
    const ended = applyDndEvent(state, dndEvent(`${NS}:combatEnded`, {}));
    expect(Object.keys(ended.actors)).toEqual([PLAYER_ACTOR]);
  });

  it("fights for a monster caster, with the DC its Spellcasting gives", async () => {
    const run = await arena();
    const caster = goblin("caster", 0);
    const state = fight(caster, { ...hero(run), position: { x: 6, y: 0 } });
    const { activation } = SpellSchema.parse(run.content(SPELL));
    if (!activation) throw new Error("No activation");
    const numbered = {
      ...activation,
      resolution: {
        kind: "automatic" as const,
        damage: [],
        effects: [
          {
            kind: "summon" as const,
            companion: COMPANION,
            duration: { concentration: true as const, minutes: 60 },
            range: 30,
            count: { base: 2, add: [] },
            dc: { base: 15, add: [] },
          },
        ],
      },
    };
    expect(doesSomething(numbered.resolution)).toBe(true);
    const { events = [] } = resolveAction(
      {
        id: "monster:9",
        name: "Test Summon",
        activation: numbered,
        spellLevel: 3,
      },
      caster,
      [caster],
      contextOf(run, state),
    );
    const after = events.reduce(applyDndEvent, state);
    const spirits = Object.values(after.actors).filter(
      (item) => item.source.kind === "summon",
    );
    expect(spirits.map((item) => item.side)).toEqual(["enemy", "enemy"]);
    expect(after.combat?.order.slice(0, 3)).toEqual([
      "caster",
      "caster:test-spirit-1",
      "caster:test-spirit-2",
    ]);
    const [first] = spirits;
    if (first?.source.kind !== "summon") throw new Error("No spirit");
    expect(first.source.spellAttack).toBe(7);
    expect(first.source.level).toBe(3);
  });

  it("are cast by a companion with a fight ahead", async () => {
    const run = await arena();
    const caster = { ...hero(run, [SPELL]), id: "ally" };
    const player = { ...hero(run), position: { x: 0, y: 1 } };
    const state = fight(
      caster,
      player,
      goblin("g1", 6),
      goblin("g2", 7),
      goblin("g3", 8),
    );
    const turn = nextDndDecision(state, run);
    if (!turn) throw new Error("No turn");
    expect(choosePolicy(turn, contextOf(run, state))).toContain(SPELL);
  });
});
