import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import {
  BONUS_DASH,
  BONUS_DODGE,
  OFFHAND,
  POLE_STRIKE,
  tacticOptions,
} from "../plugins/systems/dnd5.5e/core/actions.ts";
import { choiceOptions } from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  leafEvents,
  payCosts,
  resolveAction,
  rollSave,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { encodeOption } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { rollD20 } from "../plugins/systems/dnd5.5e/core/rules.ts";
import {
  ActivationSchema,
  ClassSchema,
  LeafEffectSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  checkBonus,
  damageResponses,
  deriveStats,
  lookup,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  TACTIC,
  lightAttackEvents,
} from "../plugins/systems/dnd5.5e/core/tactics.ts";
import {
  masteredDice,
  rerolledTypes,
} from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import {
  type Answers,
  contextOf,
  hero,
  scripted,
  testRun,
} from "./feat-fixtures.ts";

const LONGSWORD = "weapon:srd52:item/longsword";
const DAGGER = "weapon:srd52:item/dagger";
const SPEAR = "weapon:test:item/spear";

const foeOf = (traits: readonly string[] = [], extra: Partial<Actor> = {}) => ({
  ...hero(traits, { id: "foe" }),
  side: "enemy" as const,
  hp: 30,
  position: { x: 1, y: 0 },
  ...extra,
});

const at = (actor: Actor, extra: Partial<Actor> = {}): Actor => ({
  ...actor,
  position: { x: 0, y: 0 },
  ...extra,
});

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );

const effectsAdded = (events: readonly SystemEvent[]) =>
  payloads(events, "effectAdded").map(
    (payload) =>
      payload.effect as { sourceId: string; modifier: Record<string, unknown> },
  );

const HIT = {
  critical: false,
  hadAdvantage: false,
  total: 20,
  natural: 15,
};

describe("feats and traits of round 5", () => {
  it("doubles the Proficiency Bonus of a skill picked for Expertise, and offers only proficient skills for it", async () => {
    const run = await testRun();
    const bonus = (answers: Answers, traits: readonly string[] = []) => {
      const actor = hero(traits, { answers });
      return checkBonus(deriveStats(actor, run), actor, {
        ability: "int",
        skill: "arcana",
      });
    };
    // Int 8 is -1; a Proficiency Bonus of 2.
    expect(bonus([])).toBe(-1);
    expect(bonus([{ kind: "skills", values: ["arcana"] }])).toBe(1);
    expect(
      bonus([
        { kind: "skills", values: ["arcana"] },
        { kind: "skills", values: ["arcana"], expertise: true },
      ]),
    ).toBe(3);
    // Boon of Skill's All-Around Adept: proficient in every skill.
    expect(bonus([], ["adept-all"])).toBe(1);

    const offered = (expertise: "proficient" | "any") =>
      choiceOptions(
        {
          kind: "skills",
          id: "expertise",
          count: 1,
          from: ["athletics", "arcana"],
          expertise,
        },
        { picks: {}, backgroundId: "test:background/plain" } as never,
        null,
        lookup(run, ClassSchema, "srd52:class/fighter"),
        run,
      ).options.map((item) => item.id);
    // The background gives Athletics.
    expect(offered("proficient")).toEqual(["athletics"]);
    expect(offered("any")).toEqual(["athletics", "arcana"]);
  });

  it("adds 10 feet to the Dash action with Charger, and stands from Prone for 5 feet with Hop Up", async () => {
    const run = await testRun();
    const take = (traits: readonly string[], answer: string) =>
      run.system.frames[`${NS}:takeAction`]?.run(
        { actor: PLAYER_ACTOR, answer },
        contextOf(run, [at(hero(traits)), foeOf()], scripted([]).dice),
      ).events ?? [];
    const dashed = (traits: readonly string[]) =>
      effectsAdded(take(traits, `${TACTIC}dash`)).map(
        ({ modifier }) => modifier.value,
      );
    expect(dashed(["charger"])).toEqual([40]);
    expect(dashed([])).toEqual([undefined]);
    const stood = (traits: readonly string[]) =>
      payloads(take(traits, `${TACTIC}stand`), "moved").map(
        (payload) => payload.feet,
      );
    expect(stood(["hop"])).toEqual([5]);
    expect(stood([])).toEqual([15]);
  });

  it("spends a Hit Point Die to heal when taking the Dodge action, as Dwarven Fortitude does", async () => {
    const run = await testRun();
    const dodge = (traits: readonly string[]) =>
      run.system.frames[`${NS}:takeAction`]?.run(
        { actor: PLAYER_ACTOR, answer: `${TACTIC}dodge` },
        contextOf(
          run,
          [at(hero(traits), { hp: 2 }), foeOf()],
          scripted([4]).dice,
        ),
      ).events ?? [];
    // A d10 of 4, plus a Constitution modifier of 2.
    expect(payloads(dodge(["fortitude"]), "healed")).toEqual([
      expect.objectContaining({ actor: PLAYER_ACTOR, amount: 6 }),
    ]);
    expect(payloads(dodge([]), "healed")).toEqual([]);
  });

  it("attacks off-hand with a non-Light weapon after a Light one, as Dual Wielder allows", async () => {
    const run = await testRun();
    const offhand = (traits: readonly string[]) => {
      const actor = at(hero(traits), {
        inventory: ["srd52:item/dagger", "srd52:item/longsword"],
        usedThisTurn: [`light:${DAGGER}`],
      });
      const state = contextOf(run, [actor, foeOf()], scripted([]).dice).state;
      return tacticOptions(actor, state, run).map((option) => option.id);
    };
    expect(offhand(["dual"])).toContain(
      encodeOption(OFFHAND, "foe", LONGSWORD),
    );
    expect(offhand([])).not.toContain(encodeOption(OFFHAND, "foe", LONGSWORD));
  });

  it("strikes with a spear's other end for a d4 of Bludgeoning after attacking with it, as Polearm Master's Pole Strike does", async () => {
    const run = await testRun();
    const wielder = (traits: readonly string[], used: readonly string[]) =>
      at(hero(traits), {
        inventory: ["test:item/spear"],
        usedThisTurn: [...used],
      });
    // Attacking with the spear marks it for the turn.
    expect(
      payloads(
        lightAttackEvents(wielder([], []), SPEAR, run),
        "oncePerTurnUsed",
      ),
    ).toEqual([{ actor: PLAYER_ACTOR, key: "pole" }]);
    const options = (traits: readonly string[], used: readonly string[]) => {
      const actor = wielder(traits, used);
      const { state } = contextOf(run, [actor, foeOf()], scripted([]).dice);
      return tacticOptions(actor, state, run).map((option) => option.id);
    };
    const strike = encodeOption(POLE_STRIKE, "foe", SPEAR);
    expect(options(["pole"], ["pole"])).toContain(strike);
    expect(options(["pole"], [])).not.toContain(strike);
    expect(options([], ["pole"])).not.toContain(strike);
    expect(options(["pole"], ["pole", "pole-struck"])).not.toContain(strike);

    const taken = run.system.frames[`${NS}:takeAction`]?.run(
      { actor: PLAYER_ACTOR, answer: strike },
      contextOf(run, [wielder(["pole"], ["pole"]), foeOf()], scripted([]).dice),
    );
    expect(JSON.stringify(taken?.frames)).toContain('"poleStrike":true');
    const { dice, counts } = scripted([3]);
    const hit = run.system.frames[`${NS}:applyHit`]?.run(
      {
        ...HIT,
        attacker: PLAYER_ACTOR,
        actionId: SPEAR,
        target: "foe",
        poleStrike: true,
      },
      contextOf(run, [wielder(["pole"], ["pole"]), foeOf()], dice),
    );
    expect(counts[4]).toBe(1);
    expect(payloads(hit?.events ?? [], "damaged")).toEqual([
      expect.objectContaining({ actor: "foe", type: "bludgeoning" }),
    ]);
  });

  it("knocks a creature it hits Prone unless it passes a Strength save, once a turn, as Shield Master's Shield Bash does", async () => {
    const run = await testRun();
    const bash = (
      used: readonly string[] = [],
      inventory = ["srd52:item/longsword", "srd52:item/shield"],
    ) => {
      const bearer = at(hero(["shield-master"]), {
        inventory,
        usedThisTurn: [...used],
      });
      const result = run.system.frames[`${NS}:applyHit`]?.run(
        { ...HIT, attacker: PLAYER_ACTOR, actionId: LONGSWORD, target: "foe" },
        contextOf(run, [bearer, foeOf()], { below: () => 0, roll: () => 2 }),
      );
      return effectsAdded(result?.events ?? []).map(
        ({ modifier }) => modifier.condition,
      );
    };
    expect(bash()).toEqual(["prone"]);
    expect(bash(["shield-bash"])).toEqual([]);
    expect(bash([], ["srd52:item/longsword"])).toEqual([]);
  });

  it("takes no damage from a Dexterity save it passes for half, with its Reaction and a Shield, as Shield Master's Interpose Shield does", async () => {
    const run = await testRun();
    const blast = {
      id: "test:blast",
      name: "Blast",
      spellLevel: 1,
      activation: ActivationSchema.parse({
        cost: ["action"],
        targeting: { creatures: 1, range: 60, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "dex",
          dc: { base: 5 },
          damage: [{ amount: { dice: "2d6" }, type: "fire" }],
          onSuccessDamage: "half",
        },
      }),
    };
    const caught = (inventory: readonly string[]) => {
      const target = at(hero(["shield-master"], { id: "target" }), {
        inventory: [...inventory],
        hp: 30,
      });
      const caster = foeOf();
      const context = contextOf(run, [target, caster], {
        below: () => 0,
        roll: () => 6,
      });
      const events =
        resolveAction(blast, caster, [target], context).events ?? [];
      return {
        damage: payloads(events, "damaged").map((payload) => payload.amount),
        reactions: payloads(events, "budgetSpent").map(
          (payload) => payload.label,
        ),
      };
    };
    expect(caught(["srd52:item/shield"])).toEqual({
      damage: [],
      reactions: ["Interpose Shield"],
    });
    expect(caught([])).toEqual({ damage: [6], reactions: [] });
  });

  it("turns a miss into a hit once a round with Peerless Aim, and rolls a failed save again with Fortune's Favor", async () => {
    const run = await testRun();
    const swing = (used: readonly string[] = []) => {
      const attacker = at(hero(["prowess"]), { usedThisTurn: [...used] });
      const result = run.system.frames[`${NS}:attackRoll`]?.run(
        { attacker: PLAYER_ACTOR, actionId: LONGSWORD, target: "foe" },
        contextOf(run, [attacker, foeOf()], scripted([2]).dice),
      );
      return payloads(result?.events ?? [], "rollReported").map(
        (payload) => payload.success,
      );
    };
    expect(swing()).toEqual([true]);
    expect(swing(["peerless-aim"])).toEqual([false]);

    const save = (traits: readonly string[]) => {
      const { dice, counts } = scripted([2, 18]);
      const target = hero(traits);
      const { saved } = rollSave(
        target,
        "dex",
        15,
        contextOf(run, [target], dice),
      );
      return { saved, d20s: counts[20] };
    };
    expect(save(["fortune"])).toEqual({ saved: true, d20s: 2 });
    expect(save([])).toEqual({ saved: false, d20s: 1 });
  });

  it("resists all but some damage in the dark or while Bloodied, as Shadowy Form and Desperate Resilience do", async () => {
    const run = await testRun();
    const resists = (
      traits: readonly string[],
      light: "bright" | "dark",
      hp = 10,
    ) => {
      const actor = at(hero(traits), { hp });
      const { state } = contextOf(run, [actor], scripted([]).dice);
      const lit: DndState = state.combat
        ? {
            ...state,
            combat: {
              ...state.combat,
              terrain: {
                difficult: [],
                half: [],
                threeQuarters: [],
                dim: [],
                dark: [],
                light,
              },
            },
          }
        : state;
      return damageResponses(actor, { ...run, state: lit }).resistances;
    };
    expect(resists(["night"], "dark")).toContain("fire");
    expect(resists(["night"], "dark")).not.toContain("psychic");
    expect(resists(["night"], "bright")).not.toContain("fire");
    expect(resists(["desperate"], "bright", 3)).toContain("fire");
    expect(resists(["desperate"], "bright", 3)).not.toContain("force");
    expect(resists(["desperate"], "bright")).not.toContain("fire");
  });

  it("rolls a third d20 with Advantage for Elven Accuracy, and rerolls 1s on a fire spell's dice for Flames of Phlegethos", async () => {
    const run = await testRun();
    const { dice, counts } = scripted([3, 4, 19]);
    expect(
      rollD20(dice, { advantage: true, disadvantage: false, thirdDie: true })
        .natural,
    ).toBe(19);
    expect(counts[20]).toBe(3);

    const stats = deriveStats(hero(["phlegethos"]), run);
    expect(rerolledTypes(stats, true)).toEqual(["fire"]);
    expect(rerolledTypes(stats, false)).toEqual([]);
    const fire = masteredDice(scripted([1, 5]).dice, "fire", [], ["fire"]);
    expect(fire.roll(6)).toBe(5);
    const cold = masteredDice(scripted([1, 5]).dice, "cold", [], ["fire"]);
    expect(cold.roll(6)).toBe(1);
  });

  it("keeps a level 1-4 slot when a d4 matches its level, as Boon of Spell Recall does", async () => {
    const run = await testRun();
    const spell = {
      id: "test:bolt",
      name: "Bolt",
      spellLevel: 2,
      activation: ActivationSchema.parse({
        cost: ["action", "slot"],
        targeting: { self: true },
        resolution: { kind: "automatic" },
      }),
    };
    const slots = (traits: readonly string[], d4: number, level = 2) => {
      const caster = hero(traits);
      const context = contextOf(run, [caster], scripted([d4]).dice);
      return payloads(payCosts(spell, caster, context, level), "resourceSpent");
    };
    expect(slots(["recall"], 2)).toEqual([]);
    expect(slots(["recall"], 3)).toEqual([
      { actor: PLAYER_ACTOR, resource: "slot:2" },
    ]);
    expect(slots(["recall"], 5, 5)).toEqual([
      { actor: PLAYER_ACTOR, resource: "slot:5" },
    ]);
    expect(slots([], 2)).toEqual([{ actor: PLAYER_ACTOR, resource: "slot:2" }]);
  });

  it("keeps Concentration through damage with Boon of the Iron Mind", async () => {
    const run = await testRun();
    const save = (traits: readonly string[]) => {
      const caster = { ...hero(traits), concentratingOn: "srd52:spell/bless" };
      return (
        run.system.frames[`${NS}:concentrationSave`]?.run(
          { actor: PLAYER_ACTOR, dc: 30 },
          contextOf(run, [caster], scripted([]).dice),
        ).events ?? []
      ).map((event) => event.kind);
    };
    expect(save(["iron-mind"])).toEqual([]);
    expect(save([])).toContain(`${NS}:concentrationEnded`);
    // Stunned no longer ends it; Unconscious still does.
    const condition = (traits: readonly string[], name: string) => {
      const caster = { ...hero(traits), concentratingOn: "srd52:spell/bless" };
      const context = contextOf(run, [caster, foeOf()], scripted([]).dice);
      return leafEvents(
        [
          LeafEffectSchema.parse({
            kind: "applyCondition",
            condition: name,
            duration: { until: "yourNextTurnEnd" },
          }),
        ],
        "test",
        foeOf(),
        caster,
        context,
      ).some((event) => event.kind === `${NS}:concentrationEnded`);
    };
    expect(condition(["iron-mind"], "stunned")).toBe(false);
    expect(condition(["iron-mind"], "unconscious")).toBe(true);
    expect(condition([], "stunned")).toBe(true);
  });

  it("dashes or disengages as a Bonus Action while uses last, as Timely Retreat does, and dodges as one with Dancing Silhouette", async () => {
    const run = await testRun();
    const options = (traits: readonly string[], spent = 0) => {
      const actor = at(hero(traits), { resourcesSpent: { retreat: spent } });
      const { state } = contextOf(
        run,
        [actor, foeOf([], { position: { x: 5, y: 0 } })],
        scripted([]).dice,
      );
      return tacticOptions(actor, state, run).map((option) => option.id);
    };
    expect(options(["retreat"])).toContain(BONUS_DASH);
    expect(options(["retreat"], 1)).not.toContain(BONUS_DASH);
    expect(options(["shadow-dodge"])).toContain(BONUS_DODGE);
    const dashed = run.system.frames[`${NS}:takeAction`]?.run(
      { actor: PLAYER_ACTOR, answer: BONUS_DASH },
      contextOf(run, [at(hero(["retreat"])), foeOf()], scripted([]).dice),
    );
    expect(payloads(dashed?.events ?? [], "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "retreat" },
    ]);
  });

  it("resists weapon damage with its Reaction after taking it, as Delicious Pain does, and poisons once per rest, as Putrefy does", async () => {
    const run = await testRun();
    const hitBearer = (traits: readonly string[]) => {
      const bearer = at(hero(traits), { hp: 30 });
      const result = run.system.frames[`${NS}:applyHit`]?.run(
        { ...HIT, attacker: "foe", actionId: LONGSWORD, target: PLAYER_ACTOR },
        contextOf(run, [bearer, foeOf()], scripted([]).dice),
      );
      return effectsAdded(result?.events ?? []).map(
        ({ modifier }) => modifier.damage,
      );
    };
    expect(hitBearer(["toughened"])).toEqual([
      "bludgeoning",
      "piercing",
      "slashing",
    ]);
    expect(hitBearer([])).toEqual([]);

    const rot = (spent: number) => {
      const bearer = at(hero(["putrefy"]), { resourcesSpent: { rot: spent } });
      const result = run.system.frames[`${NS}:applyHit`]?.run(
        { ...HIT, attacker: PLAYER_ACTOR, actionId: LONGSWORD, target: "foe" },
        contextOf(run, [bearer, foeOf()], scripted([]).dice),
      );
      return effectsAdded(result?.events ?? []).map(
        ({ modifier }) => modifier.condition,
      );
    };
    expect(rot(0)).toEqual(["poisoned"]);
    expect(rot(1)).toEqual([]);
  });
});
