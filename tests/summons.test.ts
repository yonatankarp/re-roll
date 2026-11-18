import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import { startRun, step, type RunContext } from "../engine/run/turn.ts";
import {
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { retinueActors } from "../plugins/systems/dnd5.5e/core/combat/familiar.ts";
import {
  boosted,
  summonedActors,
} from "../plugins/systems/dnd5.5e/core/combat/summon.ts";
import {
  ActivationSchema,
  LeafEffectSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  applyDndEvent,
  type DndState,
  dndEvent,
  freshActor,
  NS,
  RETINUE,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";

// Summoned and conjured creatures (#144): a companion's forms, monsters that last as long as what called them or come
// hostile, the slain rising, what boosts a caster's summons, and creatures kept between fights. Made-up stat blocks.

const LOW: Dice = { below: () => 0, roll: () => 1 };
const GOBLIN = "srd52:monster/goblin-warrior";
const SPIRIT = "test:companion/shifting-spirit";

const FIXTURES = [
  {
    id: "test:feature/durable",
    name: "Durable",
    text: "Test.",
    automation: "full",
    passives: [
      {
        kind: "summonBoost",
        slot: true,
        tempHp: { base: 7, add: [] },
        resistant: true,
        hp: { base: 4, add: [] },
      },
    ],
  },
  {
    id: SPIRIT,
    name: "Shifting Spirit",
    ac: "11 + the spell's level",
    hp: "20 or 30",
    speed: "30 ft.",
    abilities: { str: 14, dex: 14, con: 14, int: 4, wis: 10, cha: 4 },
    text: "Test.",
    play: {
      level: 3,
      ac: 14,
      hp: 30,
      speed: 30,
      actions: [
        {
          name: "Claw",
          shapes: ["Land"],
          activation: {
            cost: ["action"],
            targeting: { creatures: 1, range: 5, side: "enemy" },
            resolution: {
              kind: "attack",
              attack: { type: "spell" },
              damage: [{ amount: { dice: "1d8" }, type: "slashing" }],
            },
          },
        },
        {
          name: "Bolt",
          shapes: ["Sky"],
          activation: {
            cost: ["action"],
            targeting: { creatures: 1, range: 120, side: "enemy" },
            resolution: {
              kind: "attack",
              attack: { type: "spell" },
              damage: [{ amount: { dice: "1d6" }, type: "force" }],
            },
          },
        },
      ],
      forms: [
        { name: "Land" },
        { name: "Sky", hp: 20, speeds: { walk: 30, fly: 60 } },
      ],
    },
  },
];

let run: RunContext;
let hero: Actor;
beforeAll(async () => {
  const loaded = (await loadAdventure("goblin-ambush")).run;
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  run = {
    ...loaded,
    content: (id) => byId.get(id) ?? loaded.content(id),
    contentIds: () => [...loaded.contentIds(), ...byId.keys()].sort(),
  };
  const chosen = step(run, startRun(run, "summons").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: "srd52:pregen/wizard",
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const player = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (!player) throw new Error("no player");
  hero = { ...player, position: { x: 0, y: 0 } };
});

const goblin = (id: string, x: number, side: Actor["side"]): Actor => ({
  ...freshActor({
    id,
    name: id,
    side,
    source: { kind: "monster", statBlockId: GOBLIN },
    hp: 10,
    inventory: [],
  }),
  position: { x, y: 0 },
});

function fight(actors: readonly Actor[]): DndState {
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

const apply = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);
const contextOf = (state: DndState) => ({ ...run, state, dice: LOW });

const spell = (
  id: string,
  effects: readonly unknown[],
  cost: readonly unknown[] = ["action", "slot"],
): KnownAction => ({
  id: `spell:${id}`,
  name: id,
  spellLevel: 3,
  activation: ActivationSchema.parse({
    cost,
    targeting: { self: true },
    resolution: { kind: "automatic", effects },
  }),
});

describe("summons", () => {
  it("calls a companion in the form picked, with that form's numbers and actions", () => {
    const state = fight([hero, goblin("foe", 5, "enemy")]);
    const call = (form?: string) => {
      const effect = LeafEffectSchema.parse({
        kind: "summon",
        companion: SPIRIT,
        duration: { minutes: 60 },
        range: 30,
        ...(form ? { form } : {}),
      });
      if (effect.kind !== "summon") throw new Error("not a summon");
      const [called] = summonedActors(
        effect,
        spell("test:spell/call", [effect]),
        hero,
        deriveStats(hero, run),
        contextOf(state),
        3,
      );
      if (!called) throw new Error("none called");
      return deriveStats(called, run);
    };
    const land = call();
    expect(land.maxHp).toBe(30);
    expect(land.actions.map((action) => action.name)).toContain("Claw");
    expect(land.actions.map((action) => action.name)).not.toContain("Bolt");
    const sky = call("Sky");
    expect(sky.maxHp).toBe(20);
    expect(sky.actions.map((action) => action.name)).toContain("Bolt");
  });

  it("sends monsters that last as long as their spell's Concentration, or come hostile", () => {
    const state = fight([hero, goblin("foe", 8, "enemy")]);
    const lasting = spell("test:spell/bowl", [
      {
        kind: "animate",
        monster: GOBLIN,
        count: 2,
        range: 30,
        duration: { concentration: true, minutes: 60 },
      },
    ]);
    const called = apply(
      apply(state, [
        dndEvent(`${NS}:concentrationStarted`, {
          actor: PLAYER_ACTOR,
          spell: lasting.id,
        }),
      ]),
      resolveAction(lasting, hero, [], contextOf(state)).events ?? [],
    );
    const animated = Object.values(called.actors).filter((actor) =>
      actor.id.includes(":animated-"),
    );
    expect(animated).toHaveLength(2);
    expect(animated.every((actor) => actor.side === "party")).toBe(true);
    const dropped = apply(called, [
      dndEvent(`${NS}:concentrationEnded`, { actor: PLAYER_ACTOR }),
    ]);
    expect(
      Object.values(dropped.actors)
        .filter((actor) => actor.id.includes(":animated-"))
        .every((actor) => actor.hp === 0),
    ).toBe(true);
    const hostile = spell("test:spell/curse", [
      { kind: "animate", monster: GOBLIN, count: 1, range: 30, hostile: true },
    ]);
    const angry = apply(
      state,
      resolveAction(hostile, hero, [], contextOf(state)).events ?? [],
    );
    expect(
      Object.values(angry.actors).find((actor) =>
        actor.id.includes(":animated-"),
      )?.side,
    ).toBe("enemy");
  });

  it("raises the one its action slew, on the caster's side", () => {
    const corpse = (id: string, x: number): Actor => ({
      ...hero,
      id,
      side: "enemy",
      hp: 0,
      position: { x, y: 0 },
    });
    const dead = corpse("foe", 1);
    const state = fight([hero, dead, corpse("other", 2)]);
    const effect = LeafEffectSchema.parse({
      kind: "raiseCorpse",
      monster: GOBLIN,
      range: 60,
      creatureTypes: ["humanoid"],
      slain: true,
    });
    const raised = apply(
      state,
      leafEvents(
        [effect],
        "spell:test:spell/doom",
        hero,
        dead,
        contextOf(state),
      ),
    );
    expect(raised.actors["foe:risen"]?.side).toBe("party");
    expect(raised.actors["other:risen"]).toBeUndefined();
  });

  it("boosts what a caster summons, by its passives", () => {
    if (hero.source.kind !== "character" || !hero.source.build) {
      throw new Error("no build");
    }
    const { build } = hero.source;
    const [first, ...rest] = build.levels;
    if (!first) throw new Error("no level");
    const caster: Actor = {
      ...hero,
      source: {
        kind: "character",
        build: {
          ...build,
          levels: [
            {
              ...first,
              answers: [
                ...first.answers,
                { kind: "features", values: ["test:feature/durable"] },
              ],
            },
            ...rest,
          ],
        },
      },
    };
    const called = goblin("called", 1, "party");
    const made = boosted(called, caster, "spell:test:spell/x", true, run);
    expect(made.tempHp).toBe(7);
    expect(made.hp).toBe(called.hp + 4);
    expect(
      made.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "resistance" && modifier.damage === "fire",
      ),
    ).toBe(true);
    expect(boosted(called, caster, "spell:test:spell/x", false, run)).toEqual(
      called,
    );
  });

  it("keeps creatures between fights, brings them to each fight and keeps their Hit Points", () => {
    const state: DndState = { actors: { [PLAYER_ACTOR]: hero }, combat: null };
    const effect = LeafEffectSchema.parse({
      kind: "retain",
      monster: GOBLIN,
      count: { base: -5, add: [{ kind: "slotLevel" }, { kind: "slotLevel" }] },
    });
    const kept = apply(
      state,
      leafEvents(
        [effect],
        "spell:test:spell/raise",
        hero,
        hero,
        contextOf(state),
        undefined,
        4,
      ),
    );
    const retinue = kept.actors[PLAYER_ACTOR]?.retinue ?? [];
    expect(retinue).toHaveLength(3);
    const player = kept.actors[PLAYER_ACTOR];
    if (!player) throw new Error("no player");
    const joined = retinueActors([player], contextOf(kept));
    expect(joined).toHaveLength(3);
    expect(joined[0]?.id).toBe(
      `${PLAYER_ACTOR}${RETINUE}${retinue[0]?.key ?? ""}`,
    );
    const [first, second] = joined;
    if (!first || !second) throw new Error("none joined");
    const fought = fight([player, { ...first, hp: 3 }, { ...second, hp: 0 }]);
    const after = apply(fought, [dndEvent(`${NS}:combatEnded`, {})]);
    const left = after.actors[PLAYER_ACTOR]?.retinue ?? [];
    expect(left).toHaveLength(2);
    expect(left.find((entry) => entry.key === retinue[0]?.key)?.hp).toBe(3);
    const rested = apply(after, [
      dndEvent(`${NS}:restFinished`, { rest: "long" }),
    ]);
    expect(rested.actors[PLAYER_ACTOR]?.retinue ?? []).toHaveLength(0);
  });
});
