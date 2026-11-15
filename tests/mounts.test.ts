import { existsSync } from "node:fs";
import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import type { Context } from "../plugins/systems/dnd5.5e/core/combat.ts";
import { tacticOptions } from "../plugins/systems/dnd5.5e/core/actions.ts";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { moveSquares } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  DISMOUNT,
  MOUNT,
  STEED,
} from "../plugins/systems/dnd5.5e/core/combat/mounts.ts";
import { encodeOption } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { squareKey } from "../plugins/systems/dnd5.5e/core/grid.ts";
import {
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
  mountOf,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { bookRun } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

const LOW: Dice = { below: () => 0, roll: () => 1 };
const STEED_ID = "srd52:companion/test-steed";
const SPELL = "srd52:spell/test-find-steed";
const RIDDEN = `${PLAYER_ACTOR}:test-steed-1`;

async function arena(): Promise<RunContext> {
  const base = (await loadAdventure("goblin-ambush")).run;
  const content: Record<string, unknown> = {
    [STEED_ID]: {
      id: STEED_ID,
      name: "Test Steed",
      size: "large",
      ac: "10 + 1 per spell level",
      hp: "5 + 10 per spell level",
      speed: "60 ft.",
      abilities: { str: 18, dex: 12, con: 14, int: 6, wis: 12, cha: 8 },
      text: "A test.",
      play: {
        level: 2,
        ac: 12,
        acPerLevel: 1,
        hp: 25,
        hpPerLevel: 10,
        speed: 60,
        creatureType: "celestial",
        passives: [{ kind: "rideable" }],
        actions: [],
      },
    },
    [SPELL]: {
      id: SPELL,
      name: "Test Find Steed",
      level: 2,
      school: "conjuration",
      classes: [],
      castingTime: "Action",
      range: "30 feet",
      components: "V, S",
      duration: "instantaneous",
      text: "A test.",
      automation: "full",
      activation: {
        cost: ["action", "slot"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "summon",
              companion: STEED_ID,
              duration: "instantaneous",
              range: 30,
            },
          ],
        },
      },
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

function hero(run: RunContext): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/fighter"));
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "Hero",
      side: "party",
      source: { kind: "character", build: pregen.build },
      hp: 30,
      inventory: [],
    }),
    position: { x: 0, y: 0 },
  };
}

function goblin(x: number, y = 0): Actor {
  return {
    ...freshActor({
      id: "g",
      name: "Goblin",
      side: "enemy",
      source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
      hp: 10,
      inventory: [],
    }),
    position: { x, y },
  };
}

const contextOf = (run: RunContext, state: DndState): Context => ({
  state,
  dice: LOW,
  content: run.content,
  contentIds: run.contentIds,
});

const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);

function at(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(`No ${id}`);
  return actor;
}

// A fighter who has just summoned a steed beside it, with a goblin far off.
function summoned(run: RunContext): DndState {
  const rider = hero(run);
  const state: DndState = {
    actors: { [PLAYER_ACTOR]: rider, g: goblin(11, 11) },
    combat: {
      encounter: "arena",
      order: [PLAYER_ACTOR, "g"],
      index: 0,
      round: 1,
      grid: { width: 24, height: 24 },
    },
  };
  const { activation } = SpellSchema.parse(run.content(SPELL));
  if (!activation) throw new Error("No activation");
  const { events = [] } = resolveAction(
    {
      id: `spell:${SPELL}`,
      name: "Test Find Steed",
      activation,
      spellLevel: 2,
    },
    rider,
    [rider],
    contextOf(run, state),
  );
  const after = fold(state, events);
  // Right beside its rider.
  return fold(after, [
    dndEvent(`${NS}:moved`, { actor: RIDDEN, to: { x: 1, y: 0 }, feet: 0 }),
  ]);
}

function choose(run: RunContext, state: DndState, answer: string): DndState {
  const result = run.system.frames[`${NS}:takeAction`]?.run(
    { actor: PLAYER_ACTOR, answer },
    contextOf(run, state),
  );
  return fold(state, result?.events ?? []);
}

describe("mounted combat", () => {
  it("mounts a steed beside its rider for half the rider's Speed", async () => {
    const run = await arena();
    const state = summoned(run);
    expect(state.combat?.order).toEqual([PLAYER_ACTOR, RIDDEN, "g"]);
    const mount = encodeOption(MOUNT, RIDDEN);
    expect(
      tacticOptions(at(state, PLAYER_ACTOR), state, run).map(({ id }) => id),
    ).toContain(mount);
    const mounted = choose(run, state, mount);
    const rider = at(mounted, PLAYER_ACTOR);
    expect(mountOf(rider)).toBe(RIDDEN);
    expect(rider.position).toEqual({ x: 1, y: 0 });
    expect(rider.moved).toBe(15);
    // Someone already on it can't be joined, and a rider can't mount twice.
    expect(
      tacticOptions(rider, mounted, run).some(({ id }) => id === mount),
    ).toBe(false);
  });

  it("moves with the mount's Speed, carrying its rider, on the rider's turn", async () => {
    const run = await arena();
    const mounted = choose(run, summoned(run), encodeOption(MOUNT, RIDDEN));
    const rider = at(mounted, PLAYER_ACTOR);
    const far = moveSquares(rider, mounted, deriveStats(rider, run), run);
    expect(Math.max(...far.map(({ feet }) => feet))).toBe(60);
    const to = { x: 1, y: 12 };
    const moved = run.system.frames[`${NS}:move`]?.run(
      { actor: PLAYER_ACTOR, answer: squareKey(to) },
      contextOf(run, mounted),
    );
    const finish = moved?.frames?.find(
      (item) => item.kind === `${NS}:finishMove`,
    );
    if (!finish) throw new Error("No move");
    const done = fold(
      mounted,
      run.system.frames[`${NS}:finishMove`]?.run(
        finish.payload,
        contextOf(run, mounted),
      ).events ?? [],
    );
    expect(at(done, RIDDEN).position).toEqual(to);
    expect(at(done, RIDDEN).moved).toBe(60);
    expect(at(done, PLAYER_ACTOR).position).toEqual(to);
    expect(at(done, PLAYER_ACTOR).moved).toBe(15);
    // The mount Dashes on its rider's turn, with its own action.
    const dashed = choose(run, done, encodeOption(STEED, "dash"));
    expect(at(dashed, RIDDEN).budget.action).toBe(false);
    expect(
      moveSquares(
        at(dashed, PLAYER_ACTOR),
        dashed,
        deriveStats(rider, run),
        run,
      ).length,
    ).toBeGreaterThan(0);
    // Its turn is skipped while it's ridden, and it's ready again when its rider's comes round.
    const next = applyDndEvent(dashed, dndEvent(`${NS}:turnAdvanced`, {}));
    expect(next.combat?.order[next.combat.index]).toBe("g");
    const back = applyDndEvent(next, dndEvent(`${NS}:turnAdvanced`, {}));
    expect(back.combat?.order[back.combat.index]).toBe(PLAYER_ACTOR);
    expect(at(back, RIDDEN).moved).toBe(0);
    expect(at(back, RIDDEN).budget.action).toBe(true);
  });

  it("dismounts into an open square beside it, and lets a mount whose rider can't act take its own turn", async () => {
    const run = await arena();
    const mounted = choose(run, summoned(run), encodeOption(MOUNT, RIDDEN));
    // Getting off takes the other half of its Speed, so it needs that much left.
    const tired: DndState = {
      ...mounted,
      actors: {
        ...mounted.actors,
        [PLAYER_ACTOR]: { ...at(mounted, PLAYER_ACTOR), moved: 20 },
      },
    };
    expect(
      tacticOptions(at(tired, PLAYER_ACTOR), tired, run).some(
        ({ id }) => id === DISMOUNT,
      ),
    ).toBe(false);
    const off = choose(run, mounted, DISMOUNT);
    const rider = at(off, PLAYER_ACTOR);
    expect(mountOf(rider)).toBeNull();
    expect(rider.position).not.toEqual(at(off, RIDDEN).position);
    expect(rider.moved).toBe(30);
    // A stunned rider's steed goes on its own turn.
    const stunned = fold(mounted, [
      dndEvent(`${NS}:effectAdded`, {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: "test:stun",
          casterId: "g",
          modifier: { kind: "condition", condition: "stunned" },
          ends: "spellDuration",
        },
      }),
      dndEvent(`${NS}:turnAdvanced`, {}),
    ]);
    expect(stunned.combat?.order[stunned.combat.index]).toBe(RIDDEN);
  });
});

describe.skipIf(!BOOK_ROOTS || !existsSync("books/rules/phb"))(
  "Find Steed",
  () => {
    it("summons an Otherworldly Steed to ride, with the slot's numbers", async () => {
      const { run } = await bookRun();
      const { activation } = SpellSchema.parse(
        run.content("phb:spell/find-steed"),
      );
      if (!activation) throw new Error("No activation");
      const steed = (level: number): Actor => {
        const rider = hero(run);
        const state: DndState = {
          actors: { [PLAYER_ACTOR]: rider, g: goblin(11, 11) },
          combat: {
            encounter: "arena",
            order: [PLAYER_ACTOR, "g"],
            index: 0,
            round: 1,
            grid: { width: 24, height: 24 },
          },
        };
        const { events = [] } = resolveAction(
          {
            id: "spell:phb:spell/find-steed",
            name: "Find Steed",
            activation,
            spellLevel: 2,
          },
          rider,
          [rider],
          contextOf(run, state),
          level,
        );
        return at(fold(state, events), `${PLAYER_ACTOR}:otherworldly-steed-1`);
      };
      const second = steed(2);
      const stats = deriveStats(second, run);
      expect([stats.ac, second.hp, stats.speed]).toEqual([12, 25, 60]);
      expect(stats.passives).toContainEqual({ kind: "rideable" });
      expect(stats.actions.map(({ name }) => name)).toEqual([
        "Otherworldly Slam",
        "Healing Touch",
      ]);
      const fourth = steed(4);
      expect([deriveStats(fourth, run).ac, fourth.hp]).toEqual([14, 45]);
    });
  },
);
