import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { RunContext } from "../engine/kernel/turn.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  freshActor,
  isStable,
} from "../plugins/systems/dnd5.5e/core/state.ts";

async function goblin(): Promise<RunContext> {
  return (await loadAdventure("goblin-ambush")).run;
}

function withContent(
  run: RunContext,
  entries: readonly { readonly id: string }[],
): RunContext {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () =>
      [...run.contentIds(), ...entries.map((entry) => entry.id)].sort(),
  };
}

function pregen(
  run: RunContext,
  id: string,
  fields: Partial<Actor> = {},
): Actor {
  const { build, equipment } = PregenSchema.parse(run.content(id));
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "Hero",
      side: "party",
      source: { kind: "character", build },
      hp: 10,
      inventory: [...equipment],
    }),
    ...fields,
  };
}

function alone(actor: Actor): DndState {
  return { actors: { [actor.id]: actor }, combat: null };
}

describe("death saves", () => {
  it("stops being Stable when damaged at 0 HP", async () => {
    const run = await goblin();
    const stable = pregen(run, "srd52:pregen/fighter", {
      hp: 0,
      deathSaves: { successes: 3, failures: 0 },
    });
    expect(isStable(stable)).toBe(true);
    const hit = applyDndEvent(
      alone(stable),
      dndEvent(`${NS}:damaged`, {
        actor: PLAYER_ACTOR,
        amount: 5,
        type: "slashing",
        critical: false,
        massive: false,
      }),
    ).actors[PLAYER_ACTOR];
    expect(hit?.deathSaves).toEqual({ successes: 0, failures: 1 });
    expect(hit && isStable(hit)).toBe(false);
  });

  it("keeps a dying creature's successes when it is hit", async () => {
    const run = await goblin();
    const dying = pregen(run, "srd52:pregen/fighter", {
      hp: 0,
      deathSaves: { successes: 2, failures: 0 },
    });
    const hit = applyDndEvent(
      alone(dying),
      dndEvent(`${NS}:damaged`, {
        actor: PLAYER_ACTOR,
        amount: 5,
        type: "slashing",
        critical: false,
        massive: false,
      }),
    ).actors[PLAYER_ACTOR];
    expect(hit?.deathSaves).toEqual({ successes: 2, failures: 1 });
  });
});


