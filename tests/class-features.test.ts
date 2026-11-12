import { existsSync } from "node:fs";
import {
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { BOOK_ROOTS } from "./depth.ts";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import { AWAIT_FRAME } from "../engine/kernel/system.ts";
import type { RunContext } from "../engine/run/turn.ts";
import {
  type Context,
  nextDndDecision,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { bookRun, classify, levelTo } from "./class-features.ts";

// Spot checks of each class's signature features in a fight, on characters built through the real level-up
// decisions. A feature that doesn't work yet is an `it.fails`, so it turns red once someone makes it work.

// Every d20 lands on `d20`, every other die on its highest face.
const dice = (d20 = 15): Dice & { d20s: () => number } => {
  let count = 0;
  return {
    below: () => 0,
    roll: (sides) => {
      if (sides !== 20) return sides;
      count += 1;
      return d20;
    },
    d20s: () => count,
  };
};

function withDummies(run: RunContext): RunContext {
  const dummy = (id: string, creatureType: string) => ({
    id,
    name: "Dummy",
    ac: 10,
    hp: 500,
    speed: 30,
    creatureType,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 1, cha: 10 },
    proficiency: 2,
    initiative: 0,
    actions: [
      {
        name: "Club",
        activation: {
          cost: ["action"],
          targeting: { creatures: 1, range: 5, side: "enemy" },
          resolution: {
            kind: "attack",
            attack: { type: "weapon", flatBonus: 4 },
            damage: [{ amount: { dice: "1d6" }, type: "slashing" }],
          },
        },
      },
    ],
  });
  const extra: Record<string, unknown> = {
    "test:monster/dummy": dummy("test:monster/dummy", "humanoid"),
    "test:monster/zombie": dummy("test:monster/zombie", "undead"),
  };
  return {
    ...run,
    content: (id) =>
      (extra[id] as ReturnType<RunContext["content"]>) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...Object.keys(extra)],
  };
}

function monster(id: string, statBlockId = "test:monster/dummy"): Actor {
  return freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId },
    hp: 500,
    inventory: [],
  });
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
    },
  };
}

interface Settled {
  readonly state: DndState;
  readonly events: readonly SystemEvent[];
  readonly decisions: readonly Decision[];
}

// A small copy of the kernel's loop, so a fight can be followed with chosen dice.
function settle(
  run: RunContext,
  start: DndState,
  frames: readonly Frame[],
  rolls: Dice,
  answer: (decision: Decision) => string = (decision) =>
    decision.options[0]?.id ?? "",
): Settled {
  let state = start;
  const events: SystemEvent[] = [];
  const decisions: Decision[] = [];
  const stack = [...frames].reverse();
  for (let top = stack.pop(); top; top = stack.pop()) {
    if (top.kind === AWAIT_FRAME) {
      const { decision } = top.payload as { decision: Decision };
      decisions.push(decision);
      stack.push({
        kind: decision.resume.kind,
        payload: { ...decision.resume.payload, answer: answer(decision) },
      });
      continue;
    }
    const definition = run.system.frames[top.kind];
    if (!definition) throw new Error(`Unknown frame ${top.kind}`);
    const context: Context = {
      state,
      dice: rolls,
      content: run.content,
      contentIds: run.contentIds,
    };
    const result = definition.run(top.payload, context);
    for (const event of result.events ?? []) {
      events.push(event);
      state = applyDndEvent(state, event);
    }
    stack.push(...[...(result.frames ?? [])].reverse());
  }
  return { state, events, decisions };
}

const act = (actor: string, answer: string): Frame => ({
  kind: `${NS}:takeAction`,
  payload: { actor, answer },
});
const attack = (attacker: string, actionId: string, target: string): Frame => ({
  kind: `${NS}:attackRoll`,
  payload: { attacker, actionId, target },
});
const endTurn: Frame = { kind: `${NS}:endTurn`, payload: {} };

function payloads(
  events: readonly SystemEvent[],
  kind: string,
): Readonly<Record<string, unknown>>[] {
  return events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event ? [event.payload] : [],
  );
}

const damageTo = (events: readonly SystemEvent[], actor: string): number =>
  payloads(events, "damaged")
    .filter((item) => item.actor === actor)
    .reduce((sum, item) => sum + Number(item.amount), 0);

function actorIn(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(`No actor ${id}`);
  return actor;
}

function turnOptions(run: RunContext, state: DndState): readonly string[] {
  return run.system.nextDecision(state, run)?.options.map((item) => item.id) ?? [];
}

const PHB = BOOK_ROOTS && existsSync("books/rules/phb");

describe.skipIf(!PHB)("signature class features in a fight", () => {
  let run: RunContext;
  // A character of the class at the level, at full health, as the player.
  const hero = (
    classSlug: string,
    level: number,
    subclass: string | null = null,
  ): Actor => {
    const built = levelTo(run, `phb:class/${classSlug}`, subclass, level);
    const ready = { ...built, id: PLAYER_ACTOR, hp: 1 };
    return { ...ready, hp: deriveStats(ready, run).maxHp };
  };
  const weaponOf = (actor: Actor): string => {
    const weapon = deriveStats(actor, run).actions.find((action) =>
      action.id.startsWith("weapon:"),
    );
    if (!weapon) throw new Error(`${actor.name} has no weapon`);
    return weapon.id;
  };
  const feature = (slug: string, index = 0) =>
    `feature:phb:feature/${slug}:${String(index)}`;

  beforeAll(async () => {
    const loaded = await bookRun();
    if (loaded.book !== "phb") throw new Error("The phb didn't load");
    run = withDummies(loaded.run);
  }, 60_000);

  it("Second Wind heals 1d10 + Fighter level and spends a use", () => {
    const fighter = { ...hero("fighter", 1), hp: 1 };
    const done = settle(
      run,
      fight(fighter, monster("a")),
      [act(PLAYER_ACTOR, `${feature("fighter-second-wind")}|${PLAYER_ACTOR}`)],
      dice(),
    );
    // 1d10 at its highest plus level 1, short of the maximum 1 HP has room for.
    const room = deriveStats(fighter, run).maxHp - 1;
    expect(payloads(done.events, "healed")[0]?.amount).toBe(Math.min(11, room));
    expect(
      actorIn(done.state, PLAYER_ACTOR).resourcesSpent["second-wind"],
    ).toBe(1);
  });

  it("Action Surge gives the action back", () => {
    const fighter = hero("fighter", 2);
    const spent = { ...fighter, budget: { ...fighter.budget, action: false } };
    const done = settle(
      run,
      fight(spent, monster("a")),
      [act(PLAYER_ACTOR, `${feature("fighter-action-surge")}|${PLAYER_ACTOR}`)],
      dice(),
    );
    expect(actorIn(done.state, PLAYER_ACTOR).budget.action).toBe(true);
  });

  it("Rage halves weapon damage taken and adds Rage Damage to Strength hits", () => {
    const barbarian = hero("barbarian", 1);
    const weapon = weaponOf(barbarian);
    const start = fight(barbarian, monster("a"));
    const plain = damageTo(
      settle(run, start, [attack(PLAYER_ACTOR, weapon, "a")], dice()).events,
      "a",
    );
    const raged = settle(
      run,
      start,
      [act(PLAYER_ACTOR, `${feature("barbarian-rage")}|${PLAYER_ACTOR}`)],
      dice(),
    ).state;
    const hit = settle(run, raged, [attack(PLAYER_ACTOR, weapon, "a")], dice());
    expect(damageTo(hit.events, "a")).toBe(plain + 2);
    const struck = settle(
      run,
      raged,
      [attack("a", "monster:0", PLAYER_ACTOR)],
      dice(),
    );
    expect(damageTo(struck.events, PLAYER_ACTOR)).toBe(3); // 1d6 slashing, halved
  });

  it("Reckless Attack gives Advantage both ways, once a turn", () => {
    const barbarian = hero("barbarian", 2);
    const reckless = `${feature("barbarian-reckless-attack")}|${PLAYER_ACTOR}`;
    const start = fight(barbarian, monster("a"));
    expect(turnOptions(run, start)).toContain(reckless);
    const used = settle(
      run,
      start,
      [act(PLAYER_ACTOR, reckless)],
      dice(),
    ).state;
    expect(turnOptions(run, used)).not.toContain(reckless);

    const mine = dice();
    settle(run, used, [attack(PLAYER_ACTOR, weaponOf(barbarian), "a")], mine);
    // Two for the attack with Advantage, and one for the target's save against the battleaxe's Topple mastery.
    expect(mine.d20s()).toBe(3);
    const theirs = dice();
    settle(run, used, [attack("a", "monster:0", PLAYER_ACTOR)], theirs);
    expect(theirs.d20s()).toBe(2);

    // A fight that ends on the barbarian's turn leaves the use spent until a rest.
    const rested = settle(
      run,
      { ...used, combat: null },
      [{ kind: `${NS}:finishRest`, payload: { rest: "short" } }],
      dice(),
    ).state;
    expect(
      actorIn(rested, PLAYER_ACTOR).resourcesSpent["reckless-attack"],
    ).toBeUndefined();

    const next = settle(run, used, [endTurn], dice()).state;
    expect(
      actorIn(next, PLAYER_ACTOR).resourcesSpent["reckless-attack"],
    ).toBeUndefined();
  });

  it("Sneak Attack adds 1d6 to a hit with Advantage", () => {
    const rogue = hero("rogue", 1);
    const weapon = weaponOf(rogue);
    const hit = (hadAdvantage: boolean): number =>
      damageTo(
        settle(
          run,
          fight(rogue, monster("a")),
          [
            {
              kind: `${NS}:applyHit`,
              payload: {
                attacker: PLAYER_ACTOR,
                actionId: weapon,
                target: "a",
                critical: false,
                hadAdvantage,
                total: 30,
                natural: 15,
              },
            },
          ],
          dice(),
        ).events,
        "a",
      );
    expect(hit(true)).toBe(hit(false) + 6);
  });

  // The bonus-action Dash, Disengage and Hide need those standard actions first.
  it.fails("Cunning Action offers a bonus-action Dash", () => {
    const rogue = hero("rogue", 2);
    const spent = { ...rogue, budget: { ...rogue.budget, action: false } };
    const options = nextDndDecision(fight(spent, monster("a")), run)?.options;
    expect(options?.some((item) => /dash/i.test(item.label))).toBe(true);
  });

  it("Bardic Inspiration adds its die to an ally's next attack roll only", () => {
    const bard = hero("bard", 1);
    const ally = { ...hero("fighter", 1), id: "ally", name: "Ally" };
    const start = fight(bard, ally, monster("a"));
    const inspired = settle(
      run,
      start,
      [act(PLAYER_ACTOR, `${feature("bard-bardic-inspiration")}|ally`)],
      dice(),
    );
    expect(
      actorIn(inspired.state, PLAYER_ACTOR).resourcesSpent[
        "bardic-inspiration"
      ],
    ).toBe(1);
    const totals = (state: DndState) =>
      payloads(
        settle(run, state, [attack("ally", weaponOf(ally), "a")], dice(10))
          .events,
        "rollReported",
      )[0]?.total;
    const first = settle(
      run,
      inspired.state,
      [attack("ally", weaponOf(ally), "a")],
      dice(10),
    );
    expect(payloads(first.events, "rollReported")[0]?.total).toBe(
      Number(totals(start)) + 6,
    );
    expect(totals(first.state)).toBe(totals(start));
  });

  it("Channel Divinity turns undead and spends a use", () => {
    const cleric = hero("cleric", 2);
    const turn = deriveStats(cleric, run).actions.find(
      (action) =>
        action.id.startsWith("feature:phb:feature/cleric-channel-divinity:") &&
        "area" in action.activation.targeting,
    );
    if (!turn) throw new Error("No Turn Undead");
    const done = settle(
      run,
      fight(cleric, monster("z", "test:monster/zombie"), monster("h")),
      [act(PLAYER_ACTOR, `${turn.id}|all`)],
      dice(2),
    );
    const zombie = actorIn(done.state, "z");
    expect(
      zombie.activeEffects.map((effect) => effect.modifier.kind),
    ).toContain("condition");
    expect(actorIn(done.state, "h").activeEffects).toHaveLength(0);
    expect(
      actorIn(done.state, PLAYER_ACTOR).resourcesSpent[
        "cleric-channel-divinity"
      ],
    ).toBe(1);
  });

  it("Divine Smite is prepared and spends a slot after a melee hit", () => {
    const paladin = hero("paladin", 2);
    const smite = "spell:phb:spell/divine-smite";
    expect(deriveStats(paladin, run).actions.map((item) => item.id)).toContain(
      smite,
    );
    const done = settle(
      run,
      fight(paladin, monster("a")),
      [attack(PLAYER_ACTOR, weaponOf(paladin), "a")],
      dice(),
      (decision) =>
        decision.options.find((item) => item.id.startsWith(smite))?.id ??
        decision.options[0]?.id ??
        "",
    );
    expect(
      done.decisions.some((item) => item.id.startsWith(`${NS}:afterHit:`)),
    ).toBe(true);
    expect(
      payloads(done.events, "damaged").some((item) => item.type === "radiant"),
    ).toBe(true);
    expect(actorIn(done.state, PLAYER_ACTOR).resourcesSpent["slot:1"]).toBe(1);
  });

  it("Wild Shape spends a use for Temporary Hit Points equal to Druid level", () => {
    const druid = hero("druid", 2);
    const done = settle(
      run,
      fight(druid, monster("a")),
      [act(PLAYER_ACTOR, `${feature("druid-wild-shape")}|${PLAYER_ACTOR}`)],
      dice(),
    );
    expect(actorIn(done.state, PLAYER_ACTOR).tempHp).toBe(2);
    expect(actorIn(done.state, PLAYER_ACTOR).resourcesSpent["wild-shape"]).toBe(
      1,
    );
  });

  it.fails("Wild Shape takes on a beast's form", () => {
    const druid = hero("druid", 2);
    const done = settle(
      run,
      fight(druid, monster("a")),
      [act(PLAYER_ACTOR, `${feature("druid-wild-shape")}|${PLAYER_ACTOR}`)],
      dice(),
    );
    expect(
      deriveStats(actorIn(done.state, PLAYER_ACTOR), run).creatureType,
    ).toBe("beast");
  });

  it("Metamagic is offered in a fight, with 2 Sorcery Points at level 2", () => {
    const sorcerer = hero("sorcerer", 2);
    expect(deriveStats(sorcerer, run).resources["sorcery-points"]).toBe(2);
    expect(
      turnOptions(run, fight(sorcerer, monster("a"))).some((id) =>
        id.startsWith("tactic:metamagic|"),
      ),
    ).toBe(true);
  });

  it.fails("Eldritch Invocations are picked at level-up", () => {
    const build = hero("warlock", 1).source;
    const picked =
      build.kind === "character"
        ? (build.build?.levels[0]?.answers ?? []).some(
            (answer) =>
              answer.kind === "features" &&
              answer.values.some((id) => id.includes("invocation")),
          )
        : false;
    expect(picked).toBe(true);
  });

  it("Unarmored Movement adds the class table's speed", () => {
    const speed = (level: number) =>
      deriveStats(hero("monk", level), run).speed;
    expect(speed(2)).toBe(speed(1) + 10);
  });

  it("Flurry of Blows makes two unarmed strikes for a Focus Point", () => {
    const monk = hero("monk", 2);
    const done = settle(
      run,
      fight(monk, monster("a")),
      [act(PLAYER_ACTOR, `${feature("monk-monk-s-focus")}|a`)],
      dice(),
    );
    expect(payloads(done.events, "rollReported")).toHaveLength(2);
    expect(
      actorIn(done.state, PLAYER_ACTOR).resourcesSpent["focus-points"],
    ).toBe(1);
  });

  it("prepares a subclass's spells from its table by level", () => {
    const known = (level: number) =>
      deriveStats(
        hero("cleric", level, "phb:subclass/cleric-life-domain"),
        run,
      ).actions.map((action) => action.id);
    expect(known(3)).toContain("spell:phb:spell/bless");
    expect(known(3)).not.toContain("spell:phb:spell/mass-healing-word");
    expect(known(5)).toContain("spell:phb:spell/mass-healing-word");
  });

  it("reports a feature's status from what the engine does with it", () => {
    const stats = deriveStats(hero("rogue", 2), run);
    expect(classify("phb:feature/rogue-sneak-attack", stats, run).status).toBe(
      "partial",
    );
    expect(
      classify(
        "phb:feature/rogue-uncanny-dodge",
        deriveStats(hero("rogue", 5), run),
        run,
      ).status,
    ).toBe("working");
    expect(
      classify("phb:feature/rogue-cunning-action", stats, run),
    ).toMatchObject({
      status: "text-only",
      why: "needs bonus-action Dash, Disengage and Hide",
    });
  });

  it("Hunter's Mark is prepared and adds 1d6 to the Ranger's hits on the mark", () => {
    const ranger = hero("ranger", 1);
    const mark = "spell:phb:spell/hunter-s-mark";
    const start = fight(ranger, monster("a"));
    expect(
      turnOptions(run, start).some((id) => id.startsWith(`${mark}|a`)),
    ).toBe(true);
    const weapon = weaponOf(ranger);
    const plain = damageTo(
      settle(run, start, [attack(PLAYER_ACTOR, weapon, "a")], dice()).events,
      "a",
    );
    const marked = settle(
      run,
      start,
      [act(PLAYER_ACTOR, `${mark}|a`)],
      dice(),
    ).state;
    const hit = settle(
      run,
      marked,
      [attack(PLAYER_ACTOR, weapon, "a")],
      dice(),
    );
    expect(damageTo(hit.events, "a")).toBe(plain + 6);
  });
});

describe("class feature rules on SRD characters", () => {
  let run: RunContext;
  beforeAll(async () => {
    run = withDummies((await loadAdventure("goblin-ambush")).run);
  });
  const pregen = (slug: string, fields: Partial<Actor> = {}): Actor => {
    const { build } = PregenSchema.parse(run.content(`srd52:pregen/${slug}`));
    return {
      ...freshActor({
        id: PLAYER_ACTOR,
        name: slug,
        side: "party",
        source: { kind: "character", build },
        hp: 50,
        inventory: ["srd52:item/longsword"],
      }),
      ...fields,
    };
  };
  const longsword = "weapon:srd52:item/longsword";

  it("spends Heroic Inspiration to reroll a missed attack", () => {
    const player = pregen("fighter", { heroicInspiration: true });
    const rolls = dice(1);
    const done = settle(
      run,
      fight(player, monster("a")),
      [attack(PLAYER_ACTOR, longsword, "a")],
      rolls,
    );
    expect(done.decisions.map((item) => item.id)).toEqual([
      `${NS}:inspiration:${PLAYER_ACTOR}`,
    ]);
    expect(rolls.d20s()).toBe(2);
    expect(actorIn(done.state, PLAYER_ACTOR).heroicInspiration).toBe(false);
    const kept = settle(
      run,
      fight(player, monster("a")),
      [attack(PLAYER_ACTOR, longsword, "a")],
      dice(1),
      () => "decline",
    );
    expect(actorIn(kept.state, PLAYER_ACTOR).heroicInspiration).toBe(true);
  });

  it("scores a Critical Hit on a 19 with Improved Critical", () => {
    const plain = pregen("fighter");
    const levels =
      plain.source.kind === "character"
        ? (plain.source.build?.levels ?? [])
        : [];
    const champion = pregen("fighter", {
      source: {
        kind: "character",
        build: {
          ...(plain.source.kind === "character" && plain.source.build
            ? plain.source.build
            : (() => {
                throw new Error("No build");
              })()),
          levels: levels.map((entry, index) =>
            index === 0
              ? {
                  ...entry,
                  answers: [
                    ...entry.answers,
                    {
                      kind: "features",
                      values: ["srd52:feature/improved-critical"],
                    },
                  ],
                }
              : entry,
          ),
        },
      },
    });
    const crit = (actor: Actor) =>
      payloads(
        settle(
          run,
          fight(actor, monster("a")),
          [attack(PLAYER_ACTOR, longsword, "a")],
          dice(19),
        ).events,
        "damaged",
      )[0]?.critical;
    expect(crit(plain)).toBe(false);
    expect(crit(champion)).toBe(true);
  });
});
