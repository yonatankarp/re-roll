import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { runAfterAction } from "../plugins/systems/dnd5.5e/core/combat.ts";
import { payCosts } from "../plugins/systems/dnd5.5e/core/combat/effects/costs.ts";
import { dealEvents } from "../plugins/systems/dnd5.5e/core/combat/effects/damage.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects/leaf.ts";
import {
  type Context,
  canAfford,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  SLOT_SPENT,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { buildAbilities } from "../plugins/systems/dnd5.5e/core/stats/abilities.ts";
import { bestAc } from "../plugins/systems/dnd5.5e/core/stats/armor-class.ts";
import { lintEntry } from "../plugins/systems/dnd5.5e/core/lint.ts";
import { scripted } from "./feat-fixtures.ts";

// The smaller rules gaps of #216, each against the 2024 rules.

async function goblin(): Promise<RunContext> {
  return (await loadAdventure("goblin-ambush")).run;
}

function pregen(run: RunContext, id: string, fields: Partial<Actor> = {}) {
  const { build, equipment } = PregenSchema.parse(run.content(id));
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "Hero",
      side: "party",
      source: { kind: "character", build },
      hp: 10,
      inventory: [...equipment],
    }),
    ...fields,
  };
}

function inCombat(run: RunContext, actors: readonly Actor[]): Context {
  const state: DndState = {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
      grid: { width: 20, height: 20 },
    },
  };
  return {
    state,
    dice: scripted([]).dice,
    content: run.content,
    contentIds: run.contentIds,
  };
}

describe("one spell slot a turn", () => {
  it("marks a slot spent on an Action and then bars a second", async () => {
    const run = await goblin();
    const wizard = pregen(run, "srd52:pregen/wizard");
    const stats = deriveStats(wizard, run);
    const spell = stats.actions.find(
      (action) =>
        action.activation.cost.includes("slot") &&
        action.activation.cost.includes("action"),
    );
    if (!spell) throw new Error("The wizard has no slot spell");
    expect(canAfford(spell, wizard, stats)).toBe(true);
    const paid = payCosts(spell, wizard, inCombat(run, [wizard]));
    expect(paid).toContainEqual({
      kind: `${NS}:oncePerTurnUsed`,
      payload: { actor: wizard.id, key: SLOT_SPENT },
    });
    const spent = {
      ...wizard,
      budget: { ...wizard.budget, action: true },
      usedThisTurn: [SLOT_SPENT],
    };
    expect(canAfford(spell, spent, deriveStats(spent, run))).toBe(false);
  });
});

describe("moving after acting", () => {
  it("keeps the turn while Speed is left, and ends it once it's gone", async () => {
    const run = await goblin();
    const spent = { action: false, bonusAction: false, reaction: false };
    const wizard = pregen(run, "srd52:pregen/wizard", {
      position: { x: 5, y: 5 },
      budget: spent,
    });
    const speed = deriveStats(wizard, run).speed;
    expect(
      runAfterAction({ actor: wizard.id }, inCombat(run, [wizard])),
    ).toEqual({});
    const still = { ...wizard, moved: speed };
    expect(
      runAfterAction({ actor: still.id }, inCombat(run, [still])),
    ).not.toEqual({});
  });
});

describe("damage order", () => {
  it("takes a flat cut before Resistance", async () => {
    const run = await goblin();
    const fighter = pregen(run, "srd52:pregen/fighter", {
      hp: 30,
      activeEffects: [
        {
          sourceId: "test:cut",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "damageReduction",
            damage: "fire",
            amount: { bonus: { base: 3, add: [] } },
          },
          ends: "spellDuration",
        },
      ],
    });
    const context = inCombat(run, [fighter]);
    // 10 fire, cut by 3 and then halved: 3, where halving first would leave 2.
    const { dealt } = dealEvents(
      fighter,
      [{ amount: 10, type: "fire", response: { resistances: ["fire"] } }],
      false,
      context,
    );
    expect(dealt).toBe(3);
  });
});

describe("Epic Boons", () => {
  it("raise a score past 20, up to 30", async () => {
    const run = await goblin();
    const { build } = PregenSchema.parse(run.content("srd52:pregen/fighter"));
    const at20 = {
      ...build,
      baseAbilities: { ...build.baseAbilities, str: 20 },
      backgroundIncrease: {},
    };
    const raised = (max?: 30) =>
      buildAbilities({
        ...at20,
        levels: [
          ...at20.levels,
          {
            classId: at20.levels[0]?.classId ?? "",
            hitPointGain: 1,
            answers: [
              {
                kind: "abilities",
                increases: { str: 1 },
                ...(max ? { max } : {}),
              },
            ],
          },
        ],
      }).str;
    expect(raised()).toBe(20);
    expect(raised(30)).toBe(21);
  });
});

describe("Armor Class", () => {
  it("counts 10 + Dex only without armor", () => {
    const actor = freshActor({
      id: "a",
      name: "A",
      side: "party",
      source: { kind: "monster", statBlockId: "x" },
      hp: 1,
      inventory: [],
    });
    const abilities = { str: 10, dex: 20, con: 10, int: 10, wis: 10, cha: 10 };
    const worn = (armorTypes: string[]) =>
      bestAc(actor, abilities, {
        armorBases: armorTypes.length > 0 ? [14] : [],
        flatBonus: 0,
        passives: [],
        armorTypes,
      });
    expect(worn(["heavy"])).toBe(14); // Ring Mail
    expect(worn([])).toBe(15);
  });
});

describe("effect kinds", () => {
  it("gives Heroic Inspiration with an inspiration effect", async () => {
    const run = await goblin();
    const fighter = pregen(run, "srd52:pregen/fighter");
    expect(
      leafEvents(
        [{ kind: "inspiration" }],
        "test",
        fighter,
        fighter,
        inCombat(run, [fighter]),
      ),
    ).toContainEqual({
      kind: `${NS}:inspirationGranted`,
      payload: { actor: fighter.id },
    });
  });
});

describe("weapons and armor", () => {
  const longswordDie = (actor: Actor, run: RunContext) => {
    const sword = deriveStats(actor, run).actions.find(
      (action) => action.id === "weapon:srd52:item/longsword",
    );
    const { resolution } = sword?.activation ?? {};
    return resolution?.kind === "attack"
      ? resolution.damage[0]?.amount.dice
      : undefined;
  };

  it("rolls a Versatile weapon's larger die without a Shield", async () => {
    const run = await goblin();
    const fighter = pregen(run, "srd52:pregen/fighter");
    expect(longswordDie(fighter, run)).toBe("1d8");
    const twoHands = {
      ...fighter,
      inventory: fighter.inventory.filter((id) => !id.endsWith("/shield")),
    };
    expect(longswordDie(twoHands, run)).toBe("1d10");
  });

  it("gives Disadvantage on Stealth in Chain Mail", async () => {
    const run = await goblin();
    const hampered = (actor: Actor) =>
      deriveStats(actor, run).passives.some(
        (passive) =>
          passive.kind === "modifier" &&
          passive.modifier.kind === "disadvantage" &&
          passive.modifier.skills?.includes("stealth") === true,
      );
    const fighter = pregen(run, "srd52:pregen/fighter");
    expect(hampered(fighter)).toBe(true);
    expect(
      hampered({
        ...fighter,
        inventory: fighter.inventory.filter((id) => !id.endsWith("chain-mail")),
      }),
    ).toBe(false);
  });
});

describe("check-pack's effect positions", () => {
  it("reports a kind where nothing reads it, and not where something does", () => {
    const read = {
      activations: [
        {
          resolution: { kind: "automatic", effects: [{ kind: "teleport" }] },
        },
      ],
    };
    expect(lintEntry(read)).toEqual([]);
    const dropped = {
      passives: [
        { kind: "damageRider", effects: [{ kind: "reactionAttack" }] },
      ],
    };
    expect(lintEntry(dropped)).toEqual([
      "effect reactionAttack at passives.0.effects.0 is never read there",
    ]);
  });
});
