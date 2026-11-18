import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { startRun, step, type RunContext } from "../engine/run/turn.ts";
import {
  aidFor,
  obstaclesOf,
  withEdge,
} from "../plugins/systems/dnd5.5e/core/explore.ts";
import type {
  Check,
  Modifier,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { rollBonus } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";

// Languages and social checks (#150): what a check's skill deals with, checks with whom, and a skill pick's bonus.

let run: RunContext;
let hero: Actor;
beforeAll(async () => {
  run = (await loadAdventure("goblin-ambush")).run;
  const chosen = step(run, startRun(run, "social").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: "srd52:pregen/fighter",
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const player = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (!player) throw new Error("no player");
  hero = player;
});

const withEffect = (actor: Actor, modifier: Modifier): Actor => ({
  ...actor,
  activeEffects: [
    ...actor.activeEffects,
    {
      sourceId: "spell:test",
      casterId: actor.id,
      modifier,
      ends: "spellDuration",
    },
  ],
});

describe("social checks", () => {
  it("reads what a check deals with from its skill", () => {
    expect(obstaclesOf({ skill: "persuasion", dc: 12 }, run)).toEqual([
      "influence",
    ]);
    expect(obstaclesOf({ skill: "insight", dc: 12 }, run)).toEqual(["truth"]);
    expect(
      obstaclesOf({ skill: "animalHandling", dc: 12, about: ["climb"] }, run),
    ).toEqual(["climb", "beast"]);
    const friends = withEffect(hero, {
      kind: "sceneAid",
      about: ["influence"],
      aid: "advantage",
      once: true,
    });
    expect(aidFor(friends, ["influence"], run)?.aid).toBe("advantage");
  });

  it("gives Advantage with the creature a check names, and Disadvantage against a Hostile one", () => {
    const dwarf: Check = {
      skill: "persuasion",
      dc: 12,
      with: { kin: "dwarf", creatureType: "humanoid", cr: 0.125 },
    };
    const belted = withEffect(hero, {
      kind: "advantage",
      on: "checks",
      skills: ["persuasion"],
      with: { kin: ["dwarf"] },
    });
    expect(withEdge(belted, dwarf, ["influence"], run).advantage).toBe(true);
    expect(
      withEdge(belted, { ...dwarf, with: { kin: "elf" } }, ["influence"], run)
        .advantage,
    ).toBe(false);
    expect(
      withEdge(belted, { skill: "persuasion", dc: 12 }, ["influence"], run)
        .advantage,
    ).toBe(false);
    const hostile: Check = {
      skill: "persuasion",
      dc: 12,
      with: { hostile: true },
    };
    expect(withEdge(hero, hostile, ["influence"], run).disadvantage).toBe(true);
    expect(withEdge(hero, hostile, ["truth"], run).disadvantage).toBe(false);
  });

  it("adds a skill pick's bonus to checks with the skill picked", () => {
    if (hero.source.kind !== "character" || !hero.source.build) {
      throw new Error("no build");
    }
    const { build } = hero.source;
    const [first, ...rest] = build.levels;
    if (!first) throw new Error("no level");
    const picked: Actor = {
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
                {
                  kind: "skills",
                  values: ["persuasion"],
                  bonus: { base: 3, add: [] },
                },
              ],
            },
            ...rest,
          ],
        },
      },
    };
    const bonus = (actor: Actor) =>
      rollBonus(
        actor,
        "checks",
        {
          ...run,
          state: { actors: { [actor.id]: actor }, combat: null },
          dice: { below: () => 0, roll: () => 1 },
        },
        "persuasion",
        "cha",
      );
    expect(bonus(picked) - bonus(hero)).toBe(3);
  });
});
