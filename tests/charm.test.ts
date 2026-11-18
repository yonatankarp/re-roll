import { type Decision, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { controlledChoice } from "../plugins/systems/dnd5.5e/core/actions.ts";
import { limitsOf } from "../plugins/systems/dnd5.5e/core/combat/durations.ts";
import {
  dealEvents,
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { runFleeTurn } from "../plugins/systems/dnd5.5e/core/combat/fear.ts";
import { optionFrame } from "../plugins/systems/dnd5.5e/core/combat/options.ts";
import {
  runCheckCombatEnd,
  runLingeringTick,
} from "../plugins/systems/dnd5.5e/core/combat/turn.ts";
import { choosePolicy } from "../plugins/systems/dnd5.5e/core/policy.ts";
import {
  ActivationSchema,
  type LeafEffect,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  applyDndEvent,
  type DndState,
  freshActor,
  hasCondition,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import type { KnownAction } from "../plugins/systems/dnd5.5e/core/stats.ts";

// Charm, commands and control (#148): a creature under another's control, one compelled about on its turn, one out of
// the fight, a save a Charmed creature fails, and damage only near the caster. Made-up spells: ids and numbers only.

const HIGH: Dice = { below: () => 0, roll: (sides) => sides };
const LOW: Dice = { below: () => 0, roll: () => 1 };
const SOURCE = "spell:test:spell/control";

let run: RunContext;
beforeAll(async () => {
  run = (await loadAdventure("goblin-ambush")).run;
});

const goblin = (
  id: string,
  x: number,
  side: Actor["side"] = "enemy",
): Actor => ({
  ...freshActor({
    id,
    name: id,
    side,
    source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
    hp: 10,
    inventory: [],
  }),
  position: { x, y: 0 },
});

function fight(actors: readonly Actor[], turn = 0): DndState {
  return {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: turn,
      round: 1,
      grid: { width: 20, height: 3 },
    },
  };
}

const contextOf = (state: DndState, dice: Dice = LOW) => ({
  ...run,
  state,
  dice,
});

const apply = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);

function given(
  state: DndState,
  effects: readonly LeafEffect[],
  caster: string,
  target: string,
  save?: { ability: "wis" | "int"; dc: number },
): DndState {
  const of = (id: string): Actor => {
    const actor = state.actors[id];
    if (!actor) throw new Error(`no ${id}`);
    return actor;
  };
  return apply(
    state,
    leafEvents(effects, SOURCE, of(caster), of(target), contextOf(state), save),
  );
}

const actorIn = (state: DndState, id: string): Actor => {
  const actor = state.actors[id];
  if (!actor) throw new Error(`no ${id}`);
  return actor;
};

const controlled: LeafEffect = {
  kind: "modifier",
  modifier: { kind: "controlled" },
  duration: { minutes: 1 },
};

describe("control", () => {
  it("puts a controlled creature on its caster's side, and back once the control ends", () => {
    const start = fight([
      goblin(PLAYER_ACTOR, 0, "party"),
      goblin("a", 2),
      goblin("b", 4),
    ]);
    const held = given(start, [controlled], PLAYER_ACTOR, "a");
    expect(actorIn(held, "a")).toMatchObject({
      side: "party",
      ownSide: "enemy",
    });
    const freed = apply(held, [
      {
        kind: `${NS}:effectEnded`,
        payload: { actor: "a", sourceId: SOURCE, casterId: PLAYER_ACTOR },
      },
    ]);
    expect(actorIn(freed, "a").side).toBe("enemy");
    expect(actorIn(freed, "a").ownSide).toBeUndefined();
  });

  it("wins a fight whose last foe is controlled, and keeps a hero a foe controls in it", () => {
    const start = fight([
      goblin(PLAYER_ACTOR, 0, "party"),
      goblin("a", 2),
      { ...goblin("b", 4), hp: 0 },
    ]);
    const won = runCheckCombatEnd(
      contextOf(given(start, [controlled], PLAYER_ACTOR, "a")),
    );
    expect(won.events?.some((event) => event.kind === "partyDefeated")).toBe(
      false,
    );
    expect(won.events?.length ?? 0).toBeGreaterThan(0);
    const taken = given(start, [controlled], "a", PLAYER_ACTOR);
    expect(actorIn(taken, PLAYER_ACTOR).side).toBe("enemy");
    expect(runCheckCombatEnd(contextOf(taken)).events ?? []).toEqual([]);
  });

  it("hands a controlled hero's choices to the tactics", () => {
    const start = fight([goblin(PLAYER_ACTOR, 0, "party"), goblin("a", 2)]);
    const decision: Decision = {
      id: `${NS}:turn:${PLAYER_ACTOR}:1:ab0`,
      actor: PLAYER_ACTOR,
      prompt: "Turn",
      options: [{ id: "pass", label: "End your turn" }],
      resume: { kind: `${NS}:takeAction`, payload: {} },
    };
    expect(controlledChoice(decision, start)?.policy).toBeUndefined();
    const taken = given(start, [controlled], "a", PLAYER_ACTOR);
    expect(controlledChoice(decision, taken)?.policy).toBe(true);
  });
});

describe("compelled", () => {
  it("walks a creature toward its caster, ending its turn within 5 feet", () => {
    const start = fight([goblin(PLAYER_ACTOR, 0, "party"), goblin("a", 6)], 1);
    const state = given(
      start,
      [
        {
          kind: "modifier",
          modifier: { kind: "compelled", toward: true, endsTurn: true },
          duration: { until: "itsNextTurnEnd" },
        },
      ],
      PLAYER_ACTOR,
      "a",
    );
    const after = apply(state, runFleeTurn(contextOf(state)).events ?? []);
    const moved = actorIn(after, "a");
    expect(moved.position).toEqual({ x: 1, y: 0 });
    expect(moved.budget.action).toBe(false);
    expect(moved.budget.bonusAction).toBe(false);
    expect(limitsOf(moved).speed).toBe("none");
  });

  it("walks one away without a Dash, and leaves the rest of its turn", () => {
    const start = fight([goblin(PLAYER_ACTOR, 0, "party"), goblin("a", 2)], 1);
    const state = given(
      start,
      [
        {
          kind: "modifier",
          modifier: { kind: "compelled" },
          duration: { minutes: 1 },
        },
      ],
      PLAYER_ACTOR,
      "a",
    );
    const after = apply(state, runFleeTurn(contextOf(state)).events ?? []);
    const moved = actorIn(after, "a");
    expect(moved.position?.x).toBe(8);
    expect(moved.budget.action).toBe(true);
  });
});

describe("pacified", () => {
  it("takes away its turn and Reaction, and counts as beaten", () => {
    const start = fight([goblin(PLAYER_ACTOR, 0, "party"), goblin("a", 2)]);
    const state = given(
      start,
      [
        {
          kind: "modifier",
          modifier: { kind: "pacified" },
          duration: { minutes: 60 },
          endsOnDamage: true,
        },
      ],
      PLAYER_ACTOR,
      "a",
    );
    const calm = actorIn(state, "a");
    expect(limitsOf(calm)).toMatchObject({
      noActions: true,
      noReactions: true,
      speed: "none",
    });
    expect(calm.budget.reaction).toBe(false);
    expect(runCheckCombatEnd(contextOf(state)).events?.length).toBeGreaterThan(
      0,
    );
    expect(runCheckCombatEnd(contextOf(start)).events ?? []).toEqual([]);
  });
});

describe("saves and riders", () => {
  const command: KnownAction = {
    id: "spell:test:spell/command",
    name: "Command",
    spellLevel: 1,
    activation: ActivationSchema.parse({
      cost: ["action"],
      targeting: { creatures: 1, range: 60, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "wis",
        dc: { base: 10 },
        edges: [{ charmedByCaster: true, roll: "fail" }],
        onFail: [
          {
            kind: "applyCondition",
            condition: "prone",
            duration: "instantaneous",
          },
        ],
      },
    }),
  };

  it("fails a save a creature its caster has Charmed makes", () => {
    const start = fight([goblin(PLAYER_ACTOR, 0, "party"), goblin("a", 2)]);
    const cast = (state: DndState) =>
      apply(
        state,
        resolveAction(
          command,
          actorIn(state, PLAYER_ACTOR),
          [actorIn(state, "a")],
          contextOf(state, HIGH),
        ).events ?? [],
      );
    expect(hasCondition(actorIn(cast(start), "a"), "prone")).toBe(false);
    const charmed = given(
      start,
      [
        {
          kind: "applyCondition",
          condition: "charmed",
          duration: { minutes: 1 },
          repeatSave: false,
          endsOnDamage: false,
        },
      ],
      PLAYER_ACTOR,
      "a",
    );
    expect(hasCondition(actorIn(cast(charmed), "a"), "prone")).toBe(true);
  });

  it("deals turn-end damage only near its caster", () => {
    const tick = (x: number) => {
      const state = fight([goblin(PLAYER_ACTOR, 0, "party"), goblin("a", x)]);
      const held = given(
        state,
        [
          {
            kind: "modifier",
            modifier: {
              kind: "lingeringDamage",
              when: "turnEnd",
              near: 5,
              damage: [{ amount: { dice: "4d8" }, type: "psychic" }],
              once: false,
            },
            duration: { minutes: 1 },
          },
        ],
        PLAYER_ACTOR,
        "a",
      );
      return (
        runLingeringTick(
          { actor: "a", sourceId: SOURCE, when: "turnEnd" },
          contextOf(held),
        ).events ?? []
      ).length;
    };
    expect(tick(1)).toBeGreaterThan(0);
    expect(tick(6)).toBe(0);
  });

  it("repeats a modifier's save when its bearer is hurt", () => {
    const start = fight([goblin(PLAYER_ACTOR, 0, "party"), goblin("a", 2)]);
    const state = given(
      start,
      [
        {
          kind: "modifier",
          modifier: { kind: "furious" },
          duration: { minutes: 1 },
          saveOnDamage: true,
        },
      ],
      PLAYER_ACTOR,
      "a",
      { ability: "int", dc: 5 },
    );
    expect(actorIn(state, "a").activeEffects[0]?.saveOnDamage).toEqual({
      ability: "int",
      dc: 5,
    });
    const hurt = apply(
      state,
      dealEvents(
        actorIn(state, "a"),
        [{ amount: 1, type: "fire" }],
        false,
        contextOf(state, HIGH),
      ).events,
    );
    expect(
      actorIn(hurt, "a").activeEffects.some(
        ({ modifier }) => modifier.kind === "furious",
      ),
    ).toBe(false);
  });

  it("offers Drop as an option, and the tactics pick a friend the last", () => {
    const start = fight([
      goblin(PLAYER_ACTOR, 0, "party"),
      goblin("a", 2),
      goblin("b", 1, "party"),
    ]);
    const effects: LeafEffect[] = [
      {
        kind: "modifier",
        modifier: { kind: "pacified" },
        duration: { minutes: 1 },
        option: "Indifferent",
      },
      { kind: "drop", option: "Drop" },
    ];
    expect(
      leafEvents(
        effects,
        SOURCE,
        actorIn(start, PLAYER_ACTOR),
        actorIn(start, "a"),
        contextOf(start),
      ),
    ).toEqual([]);
    const ask = (target: string) => {
      const frame = optionFrame(
        effects,
        SOURCE,
        actorIn(start, PLAYER_ACTOR),
        actorIn(start, target),
      );
      const decision = frame?.payload.decision as Decision;
      expect(decision.options.map((item) => item.id)).toEqual([
        "Indifferent",
        "Drop",
      ]);
      return choosePolicy(decision, contextOf(start));
    };
    expect(ask("a")).toBe("Indifferent");
    expect(ask("b")).toBe("Drop");
  });
});
