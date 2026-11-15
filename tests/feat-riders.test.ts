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
import { hasFlag } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { type Actor, NS } from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
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

  it("puts a damage rider on the first creature a spell damages, as Putrefy does on a spell", async () => {
    const run = await testRun();
    const caster = hero(["hamstring"]);
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
    // Hamstring's once-a-turn rider, on the first foe only.
    expect(
      events.filter(
        (event) =>
          event.kind === `${NS}:oncePerTurnUsed` ||
          event.kind === `${NS}:effectAdded`,
      ),
    ).toHaveLength(2);
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
});
