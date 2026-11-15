import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import {
  actingEnds,
  dealEvents,
  leafEvents,
  resolveAction,
  rollSave,
  tempHpBonus,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  hitDieRoll,
  maximized,
  rescuedCheck,
  rescuedSave,
} from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import {
  canAfford,
  hasFlag,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  type Actor,
  applyDndEvent,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { sceneSwapActions } from "../plugins/systems/dnd5.5e/core/swap.ts";
import { masteryOf } from "../plugins/systems/dnd5.5e/core/tactics.ts";
import {
  deriveStats,
  evaluateFormula,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { contextOf, hero, scripted, testRun } from "./feat-fixtures.ts";

const kinds = (events: readonly SystemEvent[]) =>
  events.map((event) => event.kind);

const invisible = (
  endsOn: "attack" | "action",
): Actor["activeEffects"][number] => ({
  sourceId: "fade",
  casterId: PLAYER_ACTOR,
  modifier: { kind: "condition", condition: "invisible" },
  ends: "casterNextTurnEnd",
  endsOn,
});

const action = (
  resolution: KnownAction["activation"]["resolution"],
): KnownAction => ({
  id: "test",
  name: "Test",
  activation: { cost: ["action"], targeting: { self: true }, resolution },
  spellLevel: null,
});

describe("feat and trait riders", () => {
  it("ends an invisibility as the bearer attacks, harms or acts, as Fade Away's and Merge with Shadows' do", () => {
    const quiet = action({ kind: "automatic", damage: [], effects: [] });
    const harmful = action({
      kind: "automatic",
      damage: [{ amount: { dice: "1d6" }, type: "fire" }],
      effects: [],
    });
    const faded = { ...hero([]), activeEffects: [invisible("attack")] };
    expect(kinds(actingEnds(faded, quiet))).toEqual([]);
    expect(kinds(actingEnds(faded, harmful))).toEqual([`${NS}:effectEnded`]);
    const merged = { ...hero([]), activeEffects: [invisible("action")] };
    expect(kinds(actingEnds(merged, quiet))).toEqual([`${NS}:effectEnded`]);
    expect(kinds(actingEnds(merged, null))).toEqual([`${NS}:effectEnded`]);
  });

  it("gives a caster's own Advantage only to that caster's attacks, as Reassert Honor does", async () => {
    const run = await testRun();
    const marked: Actor = {
      ...hero([], { id: "foe" }),
      activeEffects: [
        {
          sourceId: "reassert-honor",
          casterId: "bearer",
          modifier: {
            kind: "advantage",
            on: "attacksAgainst",
            once: true,
            casterOnly: true,
          },
          ends: "casterNextTurnEnd",
        },
      ],
    };
    const stats = deriveStats(marked, run);
    const against = (attacker: string) =>
      hasFlag(
        marked,
        "advantage",
        "attacksAgainst",
        stats,
        undefined,
        undefined,
        attacker,
      );
    expect(against("bearer")).toBe(true);
    expect(against("someone")).toBe(false);
  });

  it("puts a spell's damage rider on the first creature it damages, as Putrefy does, and no attack-only rider", async () => {
    const run = await testRun();
    const added = (traits: readonly string[]) => {
      const caster = hero(traits);
      const foes = ["a", "b"].map((id) => ({
        ...hero([], { id }),
        side: "enemy" as const,
        hp: 30,
      }));
      const spell: KnownAction = {
        ...action({
          kind: "automatic",
          damage: [{ amount: { dice: "1d6" }, type: "slashing" }],
          effects: [],
        }),
        spellLevel: 1,
      };
      const { events = [] } = resolveAction(
        spell,
        caster,
        foes,
        contextOf(run, [caster, ...foes], scripted([]).dice),
      );
      return events.filter((event) => event.kind === `${NS}:effectAdded`)
        .length;
    };
    expect(added(["necrosis"])).toBe(1);
    expect(added(["hamstring"])).toBe(0); // its rider is for attacks only
  });

  it("keeps an invisibility's Advantage on the attack that ends it", async () => {
    const run = await testRun();
    const attacker = {
      ...hero([]),
      position: { x: 0, y: 0 },
      activeEffects: [invisible("attack")],
    };
    const foe = {
      ...hero([], { id: "foe" }),
      side: "enemy" as const,
      hp: 30,
      position: { x: 1, y: 0 },
    };
    const { dice, counts } = scripted([]);
    const rolled = run.system.frames[`${NS}:attackRoll`]?.run(
      {
        attacker: PLAYER_ACTOR,
        actionId: "weapon:srd52:item/longsword",
        target: "foe",
      },
      contextOf(run, [attacker, foe], dice),
    );
    expect(counts[20]).toBe(2);
    expect(kinds(rolled?.events ?? [])).toContain(`${NS}:effectEnded`);
  });

  it("gives Advantage on Strength saves beside an ally, for the bearer and the ally, as Stronger Together does", async () => {
    const run = await testRun();
    const d20s = (traits: readonly string[], allyAt: number) => {
      const bearer = { ...hero(traits), position: { x: 0, y: 0 } };
      const ally = {
        ...hero([], { id: "ally" }),
        position: { x: allyAt, y: 0 },
      };
      const { dice, counts } = scripted([]);
      rollSave(ally, "str", 10, contextOf(run, [bearer, ally], dice));
      return counts[20];
    };
    expect(d20s(["together"], 1)).toBe(2);
    expect(d20s(["together"], 3)).toBe(1);
    expect(d20s([], 1)).toBe(1);
  });

  it("adds Temporary Hit Points, and rolls Hit Point Dice high, as Boon of Bountiful Health and Bloodlust do", async () => {
    const run = await testRun();
    const stats = (traits: readonly string[]) => deriveStats(hero(traits), run);
    expect(tempHpBonus(stats(["bountiful"]))).toBe(5);
    expect(hitDieRoll("d10", stats(["bountiful"]), scripted([2]).dice)).toBe(
      10,
    );
    expect(hitDieRoll("d10", stats(["recovery"]), scripted([2]).dice)).toBe(3);
    expect(hitDieRoll("d10", stats([]), scripted([2]).dice)).toBe(2);
  });

  it("rolls a radiant damage roll at its highest once, as Powerful Radiance does", async () => {
    const run = await testRun();
    const actor = hero(["radiance"]);
    const stats = deriveStats(actor, run);
    expect(maximized(actor, stats, ["radiant"])?.type).toBe("radiant");
    expect(maximized(actor, stats, ["fire"])).toBeNull();
    const spent = { ...actor, resourcesSpent: { radiance: 1 } };
    expect(maximized(spent, deriveStats(spent, run), ["radiant"])).toBeNull();
  });

  it("adds a d6 to a failed save against a spell, or a failed check, when it could be enough", async () => {
    const run = await testRun();
    const saveEvents = [
      {
        kind: `${NS}:saveRolled`,
        payload: { actor: PLAYER_ACTOR, total: 9, dc: 12 },
      },
    ] as unknown as SystemEvent[];
    const rescue = (magical: boolean, roll: number, traits = ["resistant"]) => {
      const actor = hero(traits);
      return rescuedSave(
        actor,
        "wis",
        [],
        deriveStats(actor, run),
        saveEvents,
        [],
        scripted([roll]).dice,
        magical,
      ).length;
    };
    expect(rescue(true, 4)).toBe(1);
    expect(rescue(true, 2)).toBe(0); // 9 + 2 still fails
    expect(rescue(false, 6)).toBe(0); // not a spell
    const actor = hero(["past-life"]);
    const stats = deriveStats(actor, run);
    expect(rescuedCheck(actor, stats, 9, 12, scripted([5]).dice).bonus).toBe(5);
    expect(rescuedCheck(actor, stats, 4, 12, scripted([5]).dice).bonus).toBe(0);
  });

  it("can't be Charmed while bolstered, and Dashes as part of an action, as Lordly Resolve and Adrenaline Rush give", async () => {
    const run = await testRun();
    const bolstered: Actor = {
      ...hero([]),
      activeEffects: [
        {
          sourceId: "lordly",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "conditionImmunity", condition: "charmed" },
          ends: "spellDuration",
        },
      ],
    };
    const context = contextOf(run, [bolstered], scripted([]).dice);
    const charm = leafEvents(
      [
        {
          kind: "applyCondition",
          condition: "charmed",
          duration: { minutes: 1 },
          repeatSave: false,
          endsOnDamage: false,
        },
      ],
      "charm",
      bolstered,
      bolstered,
      context,
    );
    expect(charm).toEqual([]);
    const dash = leafEvents(
      [{ kind: "dash" }],
      "rush",
      bolstered,
      bolstered,
      context,
    );
    expect(dash[0]).toMatchObject({
      payload: { effect: { modifier: { kind: "tactic", tactic: "dash" } } },
    });
  });

  it("lets damage repeat the save that ends a fear, as Dragon Fear's", async () => {
    const run = await testRun();
    const afraid: Actor = {
      ...hero([], { id: "foe" }),
      side: "enemy",
      hp: 30,
      activeEffects: [
        {
          sourceId: "roar",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "condition", condition: "frightened" },
          ends: "spellDuration",
          saveOnDamage: { ability: "wis", dc: 5 },
        },
      ],
    };
    const { events } = dealEvents(
      afraid,
      [{ amount: 3, type: "fire" }],
      false,
      contextOf(run, [afraid], scripted([15]).dice),
    );
    expect(kinds(events)).toContain(`${NS}:effectEnded`);
  });

  it("changes a feat's pick after a Long Rest, beside the scene's choices, as Weapon Master's weapons", async () => {
    const run = await testRun();
    const master = hero([], {
      answers: [
        { kind: "feats", values: ["test:feat/master"] },
        {
          kind: "weaponMastery",
          values: ["srd52:item/longsword"],
          feat: "test:feat/master",
        },
      ],
    });
    const { state } = contextOf(run, [master], scripted([]).dice);
    const resting = { ...state, combat: null };
    // Not before a Long Rest, then once after one.
    expect(sceneSwapActions(resting, run)).toEqual([]);
    const rested = { ...resting, sinceLongRest: 8 };
    const [action] = sceneSwapActions(rested, run);
    expect(action?.args).toEqual({ key: "0:2" });
    const context = { ...run, state: rested, dice: scripted([]).dice };
    const step = run.system.frames[`${NS}:swapStep`]?.run(
      { actor: PLAYER_ACTOR, key: "0:2" },
      context,
    );
    const decision = step?.frames?.[0]?.payload as {
      decision: { options: { id: string }[] };
    };
    const ids = decision.decision.options.map(({ id }) => id);
    expect(ids).toContain("srd52:item/dagger");
    expect(ids).not.toContain("srd52:item/longsword");
    const swapped = run.system.frames[`${NS}:swapAnswer`]?.run(
      {
        actor: PLAYER_ACTOR,
        key: "0:2",
        drop: "srd52:item/longsword",
        answer: "srd52:item/dagger",
      },
      context,
    );
    const after = (swapped?.events ?? []).reduce(applyDndEvent, rested);
    const actor = after.actors[PLAYER_ACTOR];
    if (!actor) throw new Error("no actor");
    expect(masteryOf(actor, "weapon:srd52:item/dagger", run)).toBe("nick");
    expect(masteryOf(actor, "weapon:srd52:item/longsword", run)).toBeNull();
    expect(sceneSwapActions(after, run)).toEqual([]);
  });

  it("pushes and grapples on a hit once a turn on its own turn, as Tavern Brawler and Punch and Grab do", async () => {
    const run = await testRun();
    const hit = (used: readonly string[], ownTurn = true) => {
      const brawler = {
        ...hero(["brawler"]),
        position: { x: 0, y: 0 },
        usedThisTurn: [...used],
      };
      const foe = {
        ...hero([], { id: "foe" }),
        side: "enemy" as const,
        hp: 30,
        position: { x: 1, y: 0 },
      };
      const plain = contextOf(
        run,
        ownTurn ? [brawler, foe] : [foe, brawler],
        scripted([]).dice,
      );
      const { combat } = plain.state;
      if (!combat) throw new Error("no fight");
      const context = {
        ...plain,
        state: {
          ...plain.state,
          combat: { ...combat, grid: { width: 10, height: 10 } },
        },
      };
      return kinds(
        run.system.frames[`${NS}:applyHit`]?.run(
          {
            attacker: PLAYER_ACTOR,
            actionId: "feature:test:feature/brawler:0",
            target: "foe",
            critical: false,
            hadAdvantage: false,
            total: 20,
            natural: 15,
          },
          context,
        ).events ?? [],
      );
    };
    expect(hit([])).toEqual(
      expect.arrayContaining([`${NS}:moved`, `${NS}:effectAdded`]),
    );
    const again = hit([
      "onhit:feature:test:feature/brawler:0",
      "onhit-effects:feature:test:feature/brawler:0",
    ]);
    expect(again).not.toContain(`${NS}:moved`);
    expect(again).not.toContain(`${NS}:effectAdded`);
    expect(hit([], false)).not.toContain(`${NS}:effectAdded`);
  });

  it("adds the Proficiency Bonus while Bloodied once a turn, and Advantage after a foe drops, as Boon of Bloodshed", async () => {
    const run = await testRun();
    const damage = (hp: number) => {
      const bearer = { ...hero(["bloodshed"]), hp, position: { x: 0, y: 0 } };
      const foe = {
        ...hero([], { id: "foe" }),
        side: "enemy" as const,
        hp: 30,
        position: { x: 1, y: 0 },
      };
      const events =
        run.system.frames[`${NS}:applyHit`]?.run(
          {
            attacker: PLAYER_ACTOR,
            actionId: "weapon:srd52:item/longsword",
            target: "foe",
            critical: false,
            hadAdvantage: false,
            total: 20,
            natural: 15,
          },
          contextOf(run, [bearer, foe], scripted([4]).dice),
        ).events ?? [];
      const hit = events.find((event) => event.kind === `${NS}:damaged`);
      return hit && "payload" in hit ? hit.payload.amount : 0;
    };
    // Longsword 1d8 (4) + Str 3, and 2 more while Bloodied.
    expect(damage(10)).toBe(7);
    expect(damage(4)).toBe(9);

    const bearer = { ...hero(["bloodshed"]), position: { x: 0, y: 0 } };
    const foe = { ...hero([], { id: "foe" }), side: "enemy" as const, hp: 3 };
    const dropped = dealEvents(
      foe,
      [{ amount: 5, type: "fire" }],
      false,
      contextOf(run, [bearer, foe], scripted([]).dice),
    );
    expect(
      dropped.events.some(
        (event) =>
          event.kind === `${NS}:effectAdded` &&
          "payload" in event &&
          event.payload.actor === PLAYER_ACTOR,
      ),
    ).toBe(true);
  });

  it("uses a stat's best modifier, waits for an action, and spends a save's one-off Disadvantage", async () => {
    const run = await testRun();
    const stats = deriveStats(hero([]), run);
    // Str 17 (+3) beats Dex 14 (+2).
    expect(
      evaluateFormula(
        {
          base: 8,
          add: [{ kind: "bestAbilityMod", abilities: ["str", "dex"] }],
        },
        stats,
      ),
    ).toBe(11);
    const blink: KnownAction = {
      id: "blink",
      name: "Blink",
      activation: {
        cost: [],
        afterAction: true,
        targeting: { self: true },
        resolution: { kind: "automatic", damage: [], effects: [] },
      },
      spellLevel: null,
    };
    const actor = hero([]);
    expect(canAfford(blink, actor, stats)).toBe(false);
    expect(
      canAfford(
        blink,
        { ...actor, budget: { ...actor.budget, action: false } },
        stats,
      ),
    ).toBe(true);
    const withered: Actor = {
      ...actor,
      activeEffects: [
        {
          sourceId: "help:saves",
          casterId: "ally",
          modifier: { kind: "disadvantage", on: "saves", once: true },
          ends: "casterNextTurn",
        },
      ],
    };
    const { dice, counts } = scripted([]);
    const save = rollSave(
      withered,
      "wis",
      10,
      contextOf(run, [withered], dice),
    );
    expect(counts[20]).toBe(2);
    expect(kinds(save.events)).toContain(`${NS}:effectEnded`);
  });

  it("surges a slot spell's damage, counting 1s and 2s as 3s and knocking the damaged Prone, as Erupting Spellpower", async () => {
    const run = await testRun();
    const caster = hero(["overload"]);
    const foe = { ...hero([], { id: "foe" }), side: "enemy" as const, hp: 30 };
    const spell: KnownAction = {
      ...action({
        kind: "automatic",
        damage: [{ amount: { dice: "2d6" }, type: "fire" }],
        effects: [],
      }),
      spellLevel: 1,
    };
    const { events = [] } = resolveAction(
      spell,
      caster,
      [foe],
      contextOf(run, [caster, foe], scripted([1, 2]).dice),
      1,
    );
    const hit = events.find((event) => event.kind === `${NS}:damaged`);
    expect(hit && "payload" in hit ? hit.payload.amount : 0).toBe(6);
    expect(JSON.stringify(events)).toContain('"condition":"prone"');
  });

  it("adds 1d8 to a melee hit after moving 10 feet, once a turn, as Charge Attack, and drains with a bite", async () => {
    const run = await testRun();
    const hit = (
      traits: readonly string[],
      moved: number,
      actionId: string,
    ) => {
      const bearer = {
        ...hero(traits),
        hp: 5,
        moved,
        position: { x: 0, y: 0 },
      };
      const foe = {
        ...hero([], { id: "foe" }),
        side: "enemy" as const,
        hp: 30,
        position: { x: 1, y: 0 },
      };
      return (
        run.system.frames[`${NS}:applyHit`]?.run(
          {
            attacker: PLAYER_ACTOR,
            actionId,
            target: "foe",
            critical: false,
            hadAdvantage: false,
            total: 20,
            natural: 15,
          },
          contextOf(run, [bearer, foe], scripted([4, 5]).dice),
        ).events ?? []
      ).map((event) => ("payload" in event ? event.payload : {}));
    };
    const sword = "weapon:srd52:item/longsword";
    const amount = (events: readonly Record<string, unknown>[]) =>
      events.find((payload) => payload.actor === "foe" && "amount" in payload)
        ?.amount;
    expect(amount(hit(["charge-attack"], 10, sword))).toBe(12); // 4 + 3 + 1d8 of 5
    expect(amount(hit(["charge-attack"], 5, sword))).toBe(7);
    // The bite's 1d4 of 4 heals the biter by what it dealt.
    const bite = hit(["biter"], 0, "feature:test:feature/biter:0");
    expect(bite).toContainEqual(
      expect.objectContaining({ actor: PLAYER_ACTOR, amount: 4 }),
    );
    expect(
      deriveStats(hero(["biter"]), run).actions.map(({ name }) => name),
    ).toContain("biter (bite)");
  });

  it("keeps an ally from being pushed with a Reaction, as Stand as One, and retypes a spell, as Cold Fire Magic", async () => {
    const run = await testRun();
    const pusher = {
      ...hero([], { id: "foe" }),
      side: "enemy" as const,
      position: { x: 0, y: 0 },
    };
    const ally = { ...hero([], { id: "ally" }), position: { x: 1, y: 0 } };
    const tyro = { ...hero(["stand-as-one"]), position: { x: 1, y: 1 } };
    const plain = contextOf(run, [pusher, ally, tyro], scripted([]).dice);
    const { combat } = plain.state;
    if (!combat) throw new Error("no fight");
    const context = {
      ...plain,
      state: {
        ...plain.state,
        combat: { ...combat, grid: { width: 10, height: 10 } },
      },
    };
    const pushed = leafEvents(
      [{ kind: "forcedMove", feet: 10, direction: "away" }],
      "push",
      pusher,
      ally,
      context,
    );
    expect(
      pushed.map((event) => ("payload" in event ? event.payload : null)),
    ).toEqual([
      expect.objectContaining({ actor: PLAYER_ACTOR, kind: "reaction" }),
    ]);
    const spell = deriveStats(hero(["cold-fire"]), run).actions.find(
      ({ id }) => id === "spell:srd52:spell/burning-hands",
    );
    expect(spell?.activation.resolution.damage[0]?.type).toBe("cold");
  });
});
