import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createRunContext, type RunContext } from "../engine/run/turn.ts";
import { groundFor } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { startCombat } from "../plugins/systems/dnd5.5e/core/combat/start.ts";
import { squareKey } from "../plugins/systems/dnd5.5e/core/grid.ts";
import {
  type Actor,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  damageResponses,
  deriveStats,
  modifierFor,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

const AU = "arcana-unleashed";
const BOOKS = BOOK_ROOTS && existsSync(`books/rules/${AU}`);

async function auRun(): Promise<RunContext> {
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "familiar-feats-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    AU,
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return createRunContext(loaded.registry, "goblin-ambush");
}

// A level 4 fighter with Familiar Friend, and at level 4 every familiar feat, its energies chosen.
function befriended(run: RunContext): Actor {
  const fighter = levelTo(run, "phb:class/fighter", null, 4);
  if (fighter.source.kind !== "character" || !fighter.source.build) {
    throw new Error("No build");
  }
  const { build } = fighter.source;
  const feat = (slug: string) => `${AU}:feat/${slug}`;
  const levels = build.levels.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          answers: [
            ...entry.answers,
            { kind: "feats" as const, values: [feat("familiar-friend")] },
            {
              kind: "spellAbility" as const,
              ability: "wis" as const,
              feat: feat("familiar-friend"),
            },
          ],
        }
      : index === 3
        ? {
            ...entry,
            answers: [
              {
                kind: "feats" as const,
                values: [
                  feat("elemental-familiar"),
                  feat("otherworldly-familiar"),
                  feat("soothing-familiar"),
                  feat("warlike-familiar"),
                ],
              },
              {
                kind: "features" as const,
                values: [
                  `${AU}:feature/feat-elemental-familiar-fire`,
                  `${AU}:feature/feat-otherworldly-familiar-psychic`,
                ],
              },
            ],
          }
        : entry,
  );
  return {
    ...fighter,
    source: { ...fighter.source, build: { ...build, levels } },
  };
}

describe.skipIf(!BOOKS)("Arcana Unleashed familiar feats", () => {
  it("give a fighter an Owl familiar with each feat's benefits", async () => {
    const run = await auRun();
    const hero = befriended(run);
    const stats = deriveStats(hero, run);
    // Faithful Companion: Find Familiar, cast with Wisdom. The Player's Handbook's plays as the SRD's, with its owl.
    expect(stats.familiar).toEqual({
      form: "srd52:monster/owl",
      ability: "wis",
    });
    // Helpful Friend's uses, and the command for Energy Pulse.
    expect(stats.passives).toContainEqual({
      kind: "familiarHelp",
      resource: "helpful-friend",
    });
    expect(stats.resources["helpful-friend"]).toBe(stats.proficiency);
    expect(
      stats.actions.some(
        (action) =>
          action.activation.resolution.kind === "automatic" &&
          action.activation.resolution.effects.some(
            (effect) => effect.kind === "commandFamiliar",
          ),
      ),
    ).toBe(true);
    // Warlike Familiar's Battle Familiar is a summon it can cast.
    expect(
      stats.actions.some(
        (action) => action.id === `spell:${AU}:spell/battle-familiar:free`,
      ),
    ).toBe(true);

    const state = {
      actors: { [PLAYER_ACTOR]: { ...hero, hp: stats.maxHp } },
      combat: null,
    };
    const { events = [] } = startCombat(
      {
        id: "ambush",
        monsters: [{ monster: "srd52:monster/goblin-warrior", count: 1 }],
      },
      {
        state,
        dice: { below: () => 0, roll: () => 10 },
        content: run.content,
        contentIds: run.contentIds,
      },
      { canFlee: false, defeatContinues: false },
    );
    const started = events.reduce(applyDndEvent, state);
    const familiar = started.actors[`${PLAYER_ACTOR}:familiar`];
    if (!familiar) throw new Error("No familiar joined");
    const own = deriveStats(familiar, run);
    // Fortified Familiar: the Owl's 1 Hit Point and twice the fighter's level.
    expect(familiar.hp).toBe(9);
    expect(own.maxHp).toBe(9);
    // Elemental and Energy Resistance.
    expect(damageResponses(familiar, { ...run, state: started })).toMatchObject(
      { resistances: expect.arrayContaining(["fire", "psychic"]) as unknown },
    );
    // Healing Beacon, Intercept Attack and Energy Pulse, which uses the fighter's DC for Find Familiar.
    expect(own.passives).toContainEqual({
      kind: "healDieFloor",
      at: 3,
      within: 5,
    });
    const names = own.actions.map((action) => action.name);
    expect(names).toEqual(
      expect.arrayContaining(["Intercept Attack", "Energy Pulse"]),
    );
    expect(own.scaling.spellDc).toBe(
      8 + stats.proficiency + modifierFor(stats, "wis"),
    );
    expect(own.scaling.ownerProficiency).toBe(stats.proficiency);
    // Phase Walk: through walls, at double cost, though it can't stop in one.
    if (!started.combat || !familiar.position) throw new Error("No fight");
    const wall = squareKey({
      x: familiar.position.x + 1,
      y: familiar.position.y,
    });
    const walled = {
      ...started,
      combat: { ...started.combat, walls: [wall] },
    };
    const ground = groundFor(familiar, walled, run, own);
    expect([
      ground.blocked.has(wall),
      ground.occupied.has(wall),
      ground.costly.has(wall),
    ]).toEqual([false, true, true]);
    expect(own.passives).toContainEqual(
      expect.objectContaining({
        kind: "moveThrough",
        creatures: "any",
        walls: true,
        costly: true,
      }),
    );
  });
});
