import type { ContentAccess } from "#sdk";
import { describe, expect, it } from "vitest";
import {
  type DndState,
  dndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { leadGroups } from "../engine/shell/session.ts";
import { dndCue } from "../plugins/systems/dnd5.5e/ui/cues.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";

const access = {} as ContentAccess; // cues read nothing from content

function stateWith(hp: number, index = 0): DndState {
  const goblin = freshActor({
    id: "goblin",
    name: "Goblin",
    side: "enemy",
    source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
    hp,
    inventory: [],
  });
  return {
    actors: { goblin },
    combat: { encounter: "road", order: ["hero", "goblin"], index, round: 1 },
  };
}

describe("combat board cues", () => {
  it("turns a hit into an attack cue and its damage into a damage cue with the HP left", () => {
    const attack = dndCue(
      dndEvent("dnd5.5e:rollReported", {
        actor: "hero",
        against: "goblin",
        natural: 17,
        total: 21,
        target: 15,
        success: true,
        label: "Longsword",
      }),
      stateWith(10),
      stateWith(10),
      access,
    );
    expect(attack).toEqual({
      kind: "attack",
      actor: "hero",
      target: "goblin",
      label: "Longsword",
      natural: 17,
      total: 21,
      ac: 15,
      hit: true,
      style: "melee", // the attacker isn't in this state, so it falls back to a swing with no dice
      damage: "",
    });

    const damage = dndCue(
      dndEvent("dnd5.5e:damaged", {
        actor: "goblin",
        amount: 7,
        type: "slashing",
        critical: false,
        massive: false,
      }),
      stateWith(10),
      stateWith(3),
      access,
    );
    expect(damage).toEqual({
      kind: "damage",
      actor: "goblin",
      amount: 7,
      type: "slashing",
      critical: false,
      hp: 3,
    });
  });

  it("names whose turn it is after the turn moves on, and ignores bookkeeping", () => {
    expect(
      dndCue(
        dndEvent("dnd5.5e:turnAdvanced", {}),
        stateWith(10, 0),
        stateWith(10, 1),
        access,
      ),
    ).toEqual({ kind: "turn", actor: "goblin" });
    expect(
      dndCue(
        dndEvent("dnd5.5e:budgetSpent", { actor: "hero", kind: "action" }),
        stateWith(10),
        stateWith(10),
        access,
      ),
    ).toBeNull();
  });
});

describe("the roll history", () => {
  const roll = (kind: Parameters<typeof dndEvent>[0], payload: never) =>
    dndUi.roll(dndEvent(kind, payload), stateWith(10));

  it("shows an attack's die and bonus against the AC, by name", () => {
    expect(
      roll("dnd5.5e:rollReported", {
        actor: "goblin",
        against: "hero",
        natural: 14,
        total: 19,
        target: 15,
        success: true,
        label: "Scimitar",
      } as never),
    ).toEqual({
      actor: "Goblin",
      label: "Scimitar → hero", // the hero isn't in this state, so it keeps its id
      math: "14 + 5 = 19 vs AC 15",
      success: true,
    });
  });

  it("says when a natural 1 misses whatever the total", () => {
    expect(
      roll("dnd5.5e:rollReported", {
        actor: "goblin",
        against: "hero",
        natural: 1,
        total: 16,
        target: 15,
        success: false,
        label: "Scimitar",
      } as never)?.math,
    ).toBe("1 + 15 = 16 vs AC 15, natural 1");
  });

  it("names checks, saves and death saves, and lists damage with no target", () => {
    const lines = [
      roll("dnd5.5e:rollReported", {
        actor: "goblin",
        against: "check",
        natural: 9,
        total: 8,
        target: 13,
        success: false,
        label: "sleightOfHand",
      } as never),
      roll("dnd5.5e:rollReported", {
        actor: "goblin",
        against: "check",
        natural: 12,
        total: 12,
        target: 10,
        success: true,
        label: "wis",
      } as never),
      roll("dnd5.5e:saveRolled", {
        actor: "goblin",
        ability: "dex",
        natural: 8,
        total: 10,
        dc: 13,
        success: false,
      } as never),
      roll("dnd5.5e:deathSaveRolled", {
        actor: "goblin",
        natural: 12,
      } as never),
      roll("dnd5.5e:damaged", {
        actor: "goblin",
        amount: 7,
        type: "fire",
        critical: true,
        massive: false,
      } as never),
    ];
    expect(lines.map((line) => line && `${line.label}: ${line.math}`)).toEqual([
      "Sleight of Hand check: 9 − 1 = 8 vs DC 13",
      "Wisdom check: 12 vs DC 10",
      "Dexterity save: 8 + 2 = 10 vs DC 13",
      "Death save: 12 vs 10",
      "Damage taken: 7 fire, critical hit",
    ]);
    expect(lines.map((line) => line?.success)).toEqual([
      false,
      true,
      false,
      true,
      null,
    ]);
  });

  it("leaves out events that roll nothing", () => {
    expect(
      dndUi.roll({ kind: "actorDowned", actor: "goblin" }, stateWith(0)),
    ).toBeNull();
    expect(roll("dnd5.5e:turnAdvanced", {} as never)).toBeNull();
  });
});

describe("leads", () => {
  it("groups clues by the secret they point to, the newest group and clue first", () => {
    expect(
      leadGroups([
        { secret: "a", text: "first", step: 1 },
        { secret: "b", text: "second", step: 2 },
        { secret: "a", text: "third", step: 3 },
      ]),
    ).toEqual([
      {
        clues: [
          { text: "third", step: 3 },
          { text: "first", step: 1 },
        ],
      },
      { clues: [{ text: "second", step: 2 }] },
    ]);
  });
});
