import type { ContentAccess } from "#sdk";
import { describe, expect, it } from "vitest";
import {
  type DndState,
  dndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { dndCue } from "../plugins/systems/dnd5.5e/ui/cues.ts";

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

  it("shows legendary actions, Legendary Resistance left and lair actions", () => {
    const tyrant = {
      ...freshActor({
        id: "goblin",
        name: "Tyrant",
        side: "enemy",
        source: { kind: "monster", statBlockId: "test:monster/tyrant" },
        hp: 50,
        inventory: [],
      }),
      resourcesSpent: { legendaryResistance: 1 },
    };
    const state: DndState = { ...stateWith(50), actors: { goblin: tyrant } };
    const withLegend = {
      content: (id: string) =>
        id === "test:monster/tyrant"
          ? {
              id,
              name: "Tyrant",
              ac: 12,
              hp: 50,
              speed: 30,
              abilities: {
                str: 10,
                dex: 10,
                con: 10,
                int: 10,
                wis: 10,
                cha: 10,
              },
              proficiency: 2,
              initiative: 0,
              legendaryResistance: { perDay: 3 },
            }
          : undefined,
      contentIds: () => [],
    } as ContentAccess;
    const cue = (event: Parameters<typeof dndCue>[0]) =>
      dndCue(event, state, state, withLegend);
    expect(
      cue(
        dndEvent("dnd5.5e:legendaryActionTaken", {
          actor: "goblin",
          name: "Snap",
          cost: 1,
        }),
      ),
    ).toEqual({ kind: "legendary", actor: "goblin", label: "Snap" });
    expect(
      cue(dndEvent("dnd5.5e:legendaryResistanceUsed", { actor: "goblin" })),
    ).toEqual({ kind: "resist", actor: "goblin", left: 2 });
    expect(
      cue(
        dndEvent("dnd5.5e:lairActionTaken", {
          actor: "goblin",
          name: "Falling Rocks",
        }),
      ),
    ).toEqual({ kind: "lair", actor: "goblin", label: "Falling Rocks" });
  });
});
