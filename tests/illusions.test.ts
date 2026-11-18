import { describe, expect, it } from "vitest";
import { PLAYER_ACTOR } from "../engine/kernel/events.ts";
import {
  runTactic,
  tacticOptions,
} from "../plugins/systems/dnd5.5e/core/actions.ts";
import { distracted } from "../plugins/systems/dnd5.5e/core/combat/attack.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { runFinishMove } from "../plugins/systems/dnd5.5e/core/combat/movement.ts";
import { sceneCheck } from "../plugins/systems/dnd5.5e/core/explore.ts";
import { seeing } from "../plugins/systems/dnd5.5e/core/sight.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { hero, scripted, trait } from "./feat-fixtures.ts";
import { at, block, monster, onMap, runWith } from "./senses-fixtures.ts";

// Made-up illusions and disguises for #147: ids and mechanics only.

const FIXTURES = [
  block("foe"),
  block("seer", { text: "Senses Truesight 60 ft." }),
  trait("actor", [{ kind: "impersonation" }]),
  trait("trickster", [{ kind: "distract" }]),
];
const dice = { below: () => 0, roll: () => 10 };

const image = (
  owner: string,
  x: number,
  y: number,
  extra: object = {},
): ActiveEffect => ({
  sourceId: "spell:test:spell/image",
  casterId: owner,
  modifier: {
    kind: "zone",
    zone: "image",
    at: { x, y },
    radius: 0,
    dc: 12,
    ...extra,
  },
  ends: "spellDuration",
});

const withEffect = (actor: Actor, effect: ActiveEffect): Actor => ({
  ...actor,
  activeEffects: [...actor.activeEffects, effect],
});

describe("illusions", () => {
  it("hide what's in them from those who believe them, but not from their maker or Truesight", async () => {
    const run = await runWith(FIXTURES);
    const maker = withEffect(at(hero([]), 0, 0), image(PLAYER_ACTOR, 3, 0));
    const hidden = at(monster("ally", "foe", "party"), 3, 0);
    const foe = at(monster("foe", "foe"), 6, 0);
    const seer = at(monster("seer", "seer"), 6, 1);
    const state = onMap([".......", "......."], [maker, hidden, foe, seer]);
    expect(seeing(foe, { x: 3, y: 0 }, state, run)).toBe("none");
    expect(seeing(maker, { x: 3, y: 0 }, state, run)).toBe("clear");
    expect(seeing(seer, { x: 3, y: 0 }, state, run)).toBe("clear");
    expect(seeing(foe, { x: 4, y: 0 }, state, run)).toBe("clear");
  });

  it("are seen through by walking into them or by a Study with Investigation", async () => {
    const run = await runWith(FIXTURES);
    const maker = withEffect(
      at(monster("maker", "foe"), 0, 0),
      image("maker", 3, 0),
    );
    const player = at(hero([]), 5, 0);
    const state = onMap([".......", "......."], [maker, player]);
    const walked = runFinishMove(
      { actor: PLAYER_ACTOR, x: 3, y: 0, feet: 10 },
      { ...run, state, dice },
    );
    const after = (walked.events ?? []).reduce(applyDndEvent, state);
    expect(
      seeing(after.actors[PLAYER_ACTOR] ?? player, { x: 3, y: 0 }, after, run),
    ).toBe("clear");
    const study = tacticOptions(player, state, run).find((option) =>
      option.label.startsWith("Study what's at"),
    );
    if (!study) throw new Error("no study option");
    const studied = runTactic(
      { actor: PLAYER_ACTOR, answer: study.id },
      { ...run, state, dice: scripted([15]).dice },
    );
    const seen = (studied.events ?? []).reduce(applyDndEvent, state);
    expect(
      seeing(seen.actors[PLAYER_ACTOR] ?? player, { x: 3, y: 0 }, seen, run),
    ).toBe("clear");
    expect(
      tacticOptions(seen.actors[PLAYER_ACTOR] ?? player, seen, run).some(
        (option) => option.label.startsWith("Study what's at"),
      ),
    ).toBe(false);
  });

  it("ends a phantasm its target studies through", async () => {
    const run = await runWith(FIXTURES);
    const haunted = withEffect(at(hero([]), 0, 0), {
      sourceId: "spell:test:spell/phantasm",
      casterId: "maker",
      modifier: { kind: "mark" },
      ends: "spellDuration",
      studyDc: 12,
    });
    const state = onMap([".."], [haunted]);
    const study = tacticOptions(haunted, state, run).find(
      (option) => option.label === "Study what you see (Investigation)",
    );
    if (!study) throw new Error("no phantasm option");
    const done = (
      runTactic(
        { actor: PLAYER_ACTOR, answer: study.id },
        { ...run, state, dice: scripted([15]).dice },
      ).events ?? []
    ).reduce(applyDndEvent, state);
    expect(done.actors[PLAYER_ACTOR]?.activeEffects).toEqual([]);
  });

  it("gives a creature with Distract Advantage beside its image, and lets Unerring Eye sense it", async () => {
    const run = await runWith(FIXTURES);
    const cleric = withEffect(
      at(hero(["trickster"]), 0, 0),
      image(PLAYER_ACTOR, 2, 0, { decoy: true }),
    );
    const foe = at(monster("foe", "foe"), 1, 0);
    const far = at(monster("far", "foe"), 5, 0);
    const state: DndState = onMap(["......"], [cleric, foe, far]);
    const context = { ...run, state, dice };
    expect(distracted(cleric, foe, context)).toBe(true);
    expect(distracted(cleric, far, context)).toBe(false);
    const sensed = leafEvents(
      [{ kind: "senseDeceptions", feet: 30 }],
      "test",
      foe,
      foe,
      context,
    );
    expect(sensed[0]).toMatchObject({
      kind: `${NS}:deceptionSensed`,
      payload: { count: 1 },
    });
  });
});

describe("disguises", () => {
  it("give a scene's Deception checks Advantage, and Performance too with Impersonation", async () => {
    const run = await runWith(FIXTURES);
    const disguise: ActiveEffect = {
      sourceId: "test",
      casterId: PLAYER_ACTOR,
      modifier: { kind: "disguise", dc: 13 },
      ends: "spellDuration",
    };
    const d20s = (actor: Actor, skill: "deception" | "performance") => {
      const { dice: rolled, counts } = scripted([]);
      sceneCheck(
        actor,
        { skill, dc: 10, about: [] },
        { ...run, state: onMap([".."], [actor]), dice: rolled },
      );
      return counts[20] ?? 0;
    };
    expect(d20s(hero([]), "deception")).toBe(1);
    expect(d20s(withEffect(hero([]), disguise), "deception")).toBe(2);
    expect(d20s(withEffect(hero([]), disguise), "performance")).toBe(1);
    expect(d20s(withEffect(hero(["actor"]), disguise), "performance")).toBe(2);
  });
});
