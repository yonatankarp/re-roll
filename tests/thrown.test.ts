import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { nextDndDecision } from "../plugins/systems/dnd5.5e/core/combat/decisions.ts";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { encodeOption } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import {
  type Actor,
  applyDndEvent,
  type DndState,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { contextOf, hero, scripted, testRun } from "./feat-fixtures.ts";

const DAGGER = "srd52:item/dagger";
const THROW = `throw:${DAGGER}`;

const thrower = (
  traits: readonly string[] = [],
  extra: Partial<Actor> = {},
) => ({
  ...hero(traits),
  position: { x: 0, y: 0 },
  inventory: [DAGGER],
  ...extra,
});
const foeAt = (x: number) => ({
  ...hero([], { id: "foe" }),
  side: "enemy" as const,
  hp: 30,
  position: { x, y: 0 },
});

const actorIn = (state: DndState, id: string): Actor => {
  const found = state.actors[id];
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const kinds = (events: readonly SystemEvent[]) =>
  events.map((event) => event.kind);
const fold = (state: DndState, events: readonly SystemEvent[]) =>
  events.reduce(applyDndEvent, state);

describe("thrown weapons", () => {
  it("throw a Thrown weapon out to its long range, with Disadvantage past the normal range unless Long Shots", async () => {
    const run = await testRun();
    const throwOf = (traits: readonly string[]) =>
      deriveStats(thrower(traits), run).actions.find(({ id }) => id === THROW);
    const plain = throwOf([]);
    expect(plain?.activation.targeting).toMatchObject({ range: 60 });
    const { resolution } = plain?.activation ?? {};
    expect(resolution?.kind === "attack" && resolution.attack).toMatchObject({
      ability: "str", // the hero's Strength is better than its Dexterity, as in melee
      normalRange: 20,
    });
    const longShots = throwOf(["bomber"])?.activation.resolution;
    expect(
      longShots?.kind === "attack" && longShots.attack.normalRange,
    ).toBeUndefined();
    // Thrown Weapon Fighting adds 2 to the throw's damage, and not to the melee attack.
    const fighter = deriveStats(thrower(["thrower"]), run).actions;
    const bonus = (id: string) => {
      const found = fighter.find((action) => action.id === id)?.activation
        .resolution;
      return found?.kind === "attack" ? found.damage[0]?.amount.bonus?.base : 0;
    };
    expect(bonus(THROW)).toBe(2);
    expect(bonus(`weapon:${DAGGER}`)).toBe(0);

    // At 40 feet the roll has Disadvantage: two d20s.
    const roll = (traits: readonly string[]) => {
      const { dice, counts } = scripted([15, 15, 3]);
      const actor = thrower(traits);
      run.system.frames[`${NS}:attackRoll`]?.run(
        { attacker: PLAYER_ACTOR, actionId: THROW, target: "foe" },
        contextOf(run, [actor, foeAt(8)], dice),
      );
      return counts[20];
    };
    expect(roll([])).toBe(2);
    expect(roll(["bomber"])).toBe(1);
  });

  it("lets go of the weapon where the target stands, and picks it up again within 5 feet", async () => {
    const run = await testRun();
    const actor = thrower();
    const { state, ...rest } = contextOf(
      run,
      [actor, foeAt(3)],
      scripted([]).dice,
    );
    const context = { state, ...rest };
    const action = deriveStats(actor, run).actions.find(
      ({ id }) => id === THROW,
    );
    if (!action) throw new Error("no throw");
    const cast = resolveAction(action, actor, [actorIn(state, "foe")], context);
    const throwFrame = cast.frames?.find(
      (item) => item.kind === `${NS}:throwWeapon`,
    );
    expect(throwFrame?.payload).toEqual({
      actor: PLAYER_ACTOR,
      item: DAGGER,
      target: "foe",
    });
    const thrown = run.system.frames[`${NS}:throwWeapon`]?.run(
      throwFrame?.payload ?? {},
      context,
    );
    expect(kinds(thrown?.events ?? [])).toEqual([`${NS}:weaponThrown`]);
    const after = fold(state, thrown?.events ?? []);
    expect(after.actors[PLAYER_ACTOR]?.inventory).toEqual([]);
    expect(after.combat?.dropped).toEqual([
      { item: DAGGER, at: { x: 3, y: 0 }, by: PLAYER_ACTOR },
    ]);
    // It's gone from hand, so there's no throw or stab with it left.
    const unarmed = deriveStats(actorIn(after, PLAYER_ACTOR), run);
    expect(unarmed.actions.some(({ id }) => id.endsWith(DAGGER))).toBe(false);

    // Out of reach, there's nothing to pick up; next to it, there is, once a turn.
    const options = (state: DndState) =>
      nextDndDecision(state, run)?.options.map(({ id }) => id) ?? [];
    const pickUp = encodeOption("pickUp", 0);
    expect(options(after)).not.toContain(pickUp);
    const near = {
      ...after,
      actors: {
        ...after.actors,
        [PLAYER_ACTOR]: {
          ...actorIn(after, PLAYER_ACTOR),
          position: { x: 2, y: 0 },
        },
      },
    };
    expect(options(near)).toContain(pickUp);
    const taken = run.system.frames[`${NS}:takeAction`]?.run(
      { actor: PLAYER_ACTOR, answer: pickUp },
      { ...context, state: near },
    );
    const picked = fold(near, taken?.events ?? []);
    expect(picked.actors[PLAYER_ACTOR]?.inventory).toEqual([DAGGER]);
    expect(picked.combat?.dropped).toEqual([]);
    expect(options(picked)).not.toContain(pickUp);

    // Left on the ground, it comes back when the fight ends.
    const ended = fold(after, [{ kind: `${NS}:combatEnded`, payload: {} }]);
    expect(ended.actors[PLAYER_ACTOR]?.inventory).toEqual([DAGGER]);
  });

  it("throws no more daggers than it holds, one per attack", async () => {
    const run = await testRun();
    const fighter = (daggers: number) =>
      thrower([], {
        ...hero([], { level: 5 }),
        position: { x: 0, y: 0 },
        inventory: Array<string>(daggers).fill(DAGGER),
      });
    const frames = (daggers: number) => {
      const actor = fighter(daggers);
      const context = contextOf(run, [actor, foeAt(3)], scripted([]).dice);
      const action = deriveStats(actor, run).actions.find(
        ({ id }) => id === THROW,
      );
      if (!action) throw new Error("no throw");
      return (
        resolveAction(action, actor, [actorIn(context.state, "foe")], context)
          .frames ?? []
      ).map((item) => item.kind);
    };
    expect(frames(1)).toEqual([`${NS}:attackRoll`, `${NS}:throwWeapon`]);
    expect(frames(3)).toEqual([
      `${NS}:attackRoll`,
      `${NS}:attackRoll`,
      `${NS}:throwWeapon`,
      `${NS}:throwWeapon`,
    ]);
  });

  it("throws a vial as an action that spends it, farther with Far Lobber", async () => {
    const run = await testRun();
    const vial = (traits: readonly string[]) =>
      deriveStats(
        thrower(traits, { inventory: ["test:item/acid"] }),
        run,
      ).actions.find(({ id }) => id === "item:test:item/acid");
    expect(vial([])?.name).toBe("Throw Acid");
    expect(vial([])?.activation.targeting).toMatchObject({ range: 20 });
    expect(vial(["bomber"])?.activation.targeting).toMatchObject({ range: 40 });
  });
});
