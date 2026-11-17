import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import {
  type RunContext,
  createRunContext,
  startRun,
  step,
} from "../engine/run/turn.ts";
import { sceneCastActions } from "../plugins/systems/dnd5.5e/core/camp.ts";
import { carriedWeight } from "../plugins/systems/dnd5.5e/core/carry.ts";
import { environmentEvents } from "../plugins/systems/dnd5.5e/core/environment.ts";
import {
  type Actor,
  type DndState,
  NS,
  StateSchema,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #153's and #185's book entries, on the fighter pregen. Skipped where the books aren't present.
const PLUGINS = [
  "phb",
  "dmg",
  "xanathars-guide",
  "eberron-forge-of-the-artificer",
  "ravenloft-horrors-within",
];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((plugin) => existsSync(`books/rules/${plugin}`));

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "explore-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    ...PLUGINS,
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
});

// The fighter pregen, whole, with these features and items too.
function fighter(
  features: readonly string[] = [],
  items: readonly string[] = [],
): Actor {
  const chosen = step(run, startRun(run, "books").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: "srd52:pregen/fighter",
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const actor = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (actor?.source.kind !== "character" || !actor.source.build) {
    throw new Error("No player");
  }
  const { build } = actor.source;
  const [first, ...rest] = build.levels;
  if (!first) throw new Error("No level");
  return {
    ...actor,
    source: {
      kind: "character",
      build: {
        ...build,
        levels: [
          {
            ...first,
            answers: [
              ...first.answers,
              { kind: "features", values: [...features] },
            ],
          },
          ...rest,
        ],
      },
    },
    inventory: [...actor.inventory, ...items],
  };
}

const between = (actor: Actor): DndState => ({
  actors: { [PLAYER_ACTOR]: actor },
  combat: null,
});

const context = (state: DndState, rolls: readonly number[] = []) => {
  const queue = [...rolls];
  return {
    state,
    dice: { roll: () => queue.shift() ?? 10, below: () => 0 },
    content: run.content,
    contentIds: run.contentIds,
  };
};

const kinds = (events: readonly SystemEvent[] = []) =>
  events.map((event) => event.kind);

describe.skipIf(!BOOKS)("the book's exploring entries (#153, #185)", () => {
  it("rings a Chime of Opening where a check here is about a lock, and the lock opens", () => {
    const state = between(fighter([], ["dmg:item/chime-of-opening"]));
    const lock = { skill: "sleightOfHand", dc: 30, about: ["lock"] };
    expect(sceneCastActions(state, run, { checks: [] })).toEqual([]);
    const [offer] = sceneCastActions(state, run, { checks: [lock] });
    const cast = run.system.storyEffects[`${NS}:castBetween`]?.apply(
      offer?.args,
      context(state),
    );
    const rung = (cast?.events ?? []).reduce(applyDndEvent, state);
    const opened = run.system.resolveCheck(lock, context(rung));
    expect(opened.outcome).toBe("success");
    expect(kinds(opened.events)).toContain(`${NS}:obstacleCleared`);
  });

  it("climbs with a Rope of Climbing without a roll", () => {
    const climb = { skill: "athletics", dc: 30, about: ["climb"] };
    const roped = run.system.resolveCheck(
      climb,
      context(between(fighter([], ["dmg:item/rope-of-climbing"]))),
    );
    expect(roped.outcome).toBe("success");
  });

  it("picks a Locked Door only with Thieves' Tools", () => {
    const door = { feature: "dmg:dungeon-feature/locked-door", dc: 10 };
    const bare = run.system.resolveCheck(door, context(between(fighter())));
    expect(kinds(bare.events)).toContain(`${NS}:toolMissing`);
    const tooled = run.system.resolveCheck(
      door,
      context(between(fighter([], ["phb:item/thieves-tools"]))),
    );
    expect(tooled.outcome).toBe("success");
  });

  it("adds a Mark of Warding's die to a check with Thieves' Tools", () => {
    const total = (actor: Actor) => {
      const result = run.system.resolveCheck(
        { tool: "phb:item/thieves-tools", dc: 30 },
        context(between(actor), [10, 4]),
      );
      const report = (result.events ?? []).find(
        (event) => event.kind === `${NS}:rollReported`,
      ) as { payload: { total: number } } | undefined;
      return report?.payload.total ?? 0;
    };
    const mark = "eberron-forge-of-the-artificer:feature/feat-mark-of-warding";
    expect(
      total(fighter([mark], ["phb:item/thieves-tools"])) -
        total(fighter([], ["phb:item/thieves-tools"])),
    ).toBe(4);
  });

  it("carries the pack in a Bag of Holding", () => {
    const own = fighter();
    const bagged = {
      ...own,
      inventory: [...own.inventory, "dmg:item/bag-of-holding"],
    };
    // Everything the fighter has packed away is held weightless.
    expect(carriedWeight(own, run)).toBeGreaterThan(0);
    expect(carriedWeight({ ...bagged, stowed: own.inventory }, run)).toBe(0);
    expect(carriedWeight(bagged, run)).toBe(carriedWeight(own, run));
  });

  it("spares a party with an Alchemy Jug Extreme Heat's saves", () => {
    const heat = {
      effects: ["dmg:environmental-effect/extreme-heat"],
      hours: 2,
      minutes: 0,
    };
    expect(
      kinds(environmentEvents(heat, context(between(fighter()), [1, 1]))),
    ).toContain(`${NS}:saveRolled`);
    expect(
      kinds(
        environmentEvents(
          heat,
          context(between(fighter([], ["dmg:item/alchemy-jug"])), [1, 1]),
        ),
      ),
    ).not.toContain(`${NS}:saveRolled`);
  });

  it("gives Peerless Skill to attack rolls, Ambush to Initiative, and Drunkard's Luck against Disadvantage", () => {
    const kindsOf = (feature: string) =>
      deriveStats(fighter([feature]), run).passives.map(({ kind }) => kind);
    expect(
      kindsOf("phb:feature/bard-college-of-lore-peerless-skill"),
    ).toContain("missBoost");
    expect(
      kindsOf("phb:feature/fighter-battle-master-maneuver-ambush"),
    ).toContain("initiativeDie");
    expect(
      kindsOf(
        "xanathars-guide:feature/monk-way-of-the-drunken-master-drunkard-s-luck",
      ),
    ).toContain("cancelDisadvantage");
  });

  it("sets off Echoing Soul's save when a check rolls a 1", () => {
    const echoing = fighter([
      "ravenloft-horrors-within:feature/feat-echoing-soul",
    ]);
    const result = run.system.resolveCheck(
      { skill: "athletics", dc: 30 },
      context(between(echoing), [1, 1]),
    );
    expect(kinds(result.events)).toContain(`${NS}:saveRolled`);
  });
});
