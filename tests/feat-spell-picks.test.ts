import { type Decision, PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import {
  choiceOptions,
  latePick,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import { spellOfSource } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import {
  ClassSchema,
  FeatSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { type Actor, NS } from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  evaluateFormula,
  lookup,
  type Stats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { swappable } from "../plugins/systems/dnd5.5e/core/swap.ts";
import { traitAttackAdvantage } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import { hero, scripted, settle, testRun } from "./feat-fixtures.ts";

const BURNING_HANDS = "srd52:spell/burning-hands";
const BLESS = "srd52:spell/bless";
type Run = Awaited<ReturnType<typeof testRun>>;

// Runs a swap or late pick, answering each decision in turn, and gives the actor after it with the options asked.
function swap(
  run: Run,
  actor: Actor,
  key: string,
  answers: readonly string[],
): { actor: Actor; asked: Decision[] } {
  const queue = [...answers];
  const { state, decisions } = settle(
    run,
    [actor],
    [{ kind: `${NS}:swapStep`, payload: { actor: actor.id, key } }],
    scripted([]).dice,
    () => queue.shift() ?? "keep",
  );
  const after = state.actors[actor.id];
  if (!after) throw new Error("No actor");
  return { actor: after, asked: decisions };
}

const spellIds = (stats: Stats) =>
  stats.actions
    .map((action) => action.id)
    .filter((id) => id.startsWith("spell:"));
const freeOf = (stats: Stats, id: string) =>
  stats.actions.find((action) => action.id === id);

describe("spells from feats and species", () => {
  it("swaps a trait's cantrip for one from its lists after a Long Rest, once until the next", async () => {
    const run = await testRun();
    const elf = hero(["high"]);
    const key = "trait:test:feature/high";
    expect(swappable(elf, run).find((item) => item.key === key)?.open).toBe(
      true,
    );
    const { actor, asked } = swap(run, elf, key, ["srd52:spell/fire-bolt"]);
    expect(asked[0]?.options.map((option) => option.id)).toContain(
      "srd52:spell/fire-bolt",
    );
    expect(asked[0]?.options.map((option) => option.id)).not.toContain(
      "srd52:spell/prestidigitation",
    );
    expect(spellIds(deriveStats(actor, run))).toContain(
      "spell:srd52:spell/fire-bolt",
    );
    expect(swappable(actor, run).find((item) => item.key === key)?.open).toBe(
      false,
    );
    // Swapped again, the new cantrip is the one dropped.
    const rested = { ...actor, swapped: [] };
    const again = swap(run, rested, key, ["srd52:spell/ray-of-frost"]).actor;
    const spells = spellIds(deriveStats(again, run));
    expect(spells).toContain("spell:srd52:spell/ray-of-frost");
    expect(spells).not.toContain("spell:srd52:spell/fire-bolt");
  });

  it("changes one of a feat's spells each time the character gains a level, not at a Long Rest", async () => {
    const run = await testRun();
    const answers = [
      { kind: "feats" as const, values: ["test:feat/changing"] },
      {
        kind: "spells" as const,
        values: ["srd52:spell/fire-bolt", "srd52:spell/ray-of-frost"],
        feat: "test:feat/changing",
      },
      {
        kind: "spells" as const,
        values: [BLESS],
        feat: "test:feat/changing",
      },
    ];
    const at = (level: number): Actor => {
      const actor = hero([], { level: 1, answers });
      const build =
        actor.source.kind === "character" ? actor.source.build : null;
      const first = build?.levels[0];
      if (!build || !first) throw new Error("No build");
      const later = { classId: first.classId, hitPointGain: 6, answers: [] };
      return {
        ...actor,
        source: {
          kind: "character",
          build: {
            ...build,
            levels: [first, ...Array.from({ length: level - 1 }, () => later)],
          },
        },
      };
    };
    const cantrips = (actor: Actor) =>
      swappable(actor, run).filter((item) => item.key === "0:2");
    // Only the cantrips choice changes, and not at the level the feat was taken.
    expect(cantrips(at(1))[0]?.open).toBe(false);
    expect(swappable(at(2), run).some((item) => item.key === "0:3")).toBe(
      false,
    );
    const { actor } = swap(run, at(2), "0:2", [
      "srd52:spell/fire-bolt",
      "srd52:spell/acid-splash",
    ]);
    expect(spellIds(deriveStats(actor, run))).toContain(
      "spell:srd52:spell/acid-splash",
    );
    expect(cantrips(actor)[0]?.open).toBe(false);
    // A Long Rest doesn't bring it back; the next level does.
    const rested = settle(
      run,
      [actor],
      [{ kind: `${NS}:finishRest`, payload: { rest: "long" } }],
      scripted([]).dice,
    ).state.actors[PLAYER_ACTOR];
    if (!rested) throw new Error("No actor");
    expect(cantrips(rested)[0]?.open).toBe(false);
    const levelled = at(3);
    expect(
      cantrips({ ...levelled, swaps: actor.swaps, swapped: actor.swapped })[0]
        ?.open,
    ).toBe(true);
  });

  it("offers a feat's own table beside its list", async () => {
    const run = await testRun();
    const [, table] = lookup(run, FeatSchema, "test:feat/changing").choices;
    if (!table) throw new Error("No choice");
    const ids = choiceOptions(
      table,
      { picks: {}, backgroundId: "test:background/plain" } as never,
      null,
      lookup(run, ClassSchema, "srd52:class/fighter"),
      run,
    ).options.map((option) => option.id);
    expect(ids).toContain(BLESS);
    expect(ids).toContain("srd52:spell/magic-missile");
    expect(ids).not.toContain("srd52:spell/shield");
  });

  it("picks as many ritual spells as the Proficiency Bonus between scenes, never as the feat is taken", async () => {
    const run = await testRun();
    const ritualist = (level: number, swaps = {}) => ({
      ...hero([], {
        level,
        answers: [
          { kind: "feats", values: ["test:feat/rituals"] },
          { kind: "abilities", increases: { int: 1 } },
        ],
      }),
      swaps,
    });
    // Never asked as the feat is taken, so a save from before it replays.
    const [rituals] = lookup(run, FeatSchema, "test:feat/rituals").choices;
    expect(rituals && latePick(rituals)).toBe(true);
    const key = "pick:test:feat/rituals#rituals";
    const first = swap(run, ritualist(4), key, ["srd52:spell/floating-disk"]);
    expect(first.asked[0]?.options.map((option) => option.id)).not.toContain(
      BLESS,
    );
    const twice = swap(run, first.actor, key, ["srd52:spell/alarm"]).actor;
    expect(twice.swaps?.[key]).toEqual([
      "srd52:spell/floating-disk",
      "srd52:spell/alarm",
    ]);
    // Proficiency Bonus 2: no third until it rises.
    expect(swappable(twice, run).find((item) => item.key === key)?.open).toBe(
      false,
    );
    expect(
      swappable(ritualist(5, twice.swaps), run).find((item) => item.key === key)
        ?.open,
    ).toBe(true);
  });

  it("gives another cantrip only to a character who already knows the feat's", async () => {
    const run = await testRun();
    const bringer = (traits: readonly string[]) =>
      hero(traits, {
        level: 4,
        answers: [
          { kind: "feats", values: ["test:feat/bringer"] },
          { kind: "abilities", increases: { wis: 1 } },
        ],
      });
    const key = "pick:test:feat/bringer#other";
    const open = (actor: Actor) =>
      swappable(actor, run).find((item) => item.key === key)?.open;
    expect(open(bringer([]))).toBe(false);
    const knows = bringer(["lit"]);
    expect(open(knows)).toBe(true);
    const { actor } = swap(run, knows, key, ["srd52:spell/sacred-flame"]);
    const stats = deriveStats(actor, run);
    expect(spellIds(stats)).toContain("spell:srd52:spell/sacred-flame");
    // The feat raised Wisdom to 13: its cantrip's DC is 8 + 2 + 1.
    const flame = stats.actions.find(
      (action) => action.id === "spell:srd52:spell/sacred-flame",
    )?.activation.resolution;
    expect(
      flame?.kind === "save" ? evaluateFormula(flame.dc, stats) : null,
    ).toBe(11);
    expect(open(actor)).toBe(false);
  });

  it("casts a free spell as with a higher slot from the level its table names", async () => {
    const run = await testRun();
    const wisher = (level: number) =>
      deriveStats(
        hero(["wishing"], {
          level,
          answers: [
            {
              kind: "spells",
              values: [BURNING_HANDS],
              freeCast: { resource: "wish", slotLevel: { 1: 1, 3: 2 } },
            },
          ],
        }),
        run,
      );
    const dice = (stats: Stats) => {
      const resolution = freeOf(stats, `spell:${BURNING_HANDS}:free`)
        ?.activation.resolution;
      return resolution?.kind === "save"
        ? resolution.damage[0]?.amount.dice
        : null;
    };
    expect(freeOf(wisher(1), `spell:${BURNING_HANDS}:free`)?.spellLevel).toBe(
      1,
    );
    expect(dice(wisher(1))).toBe("3d6");
    expect(freeOf(wisher(3), `spell:${BURNING_HANDS}:free`)?.spellLevel).toBe(
      2,
    );
    expect(dice(wisher(3))).toBe("4d6");
    expect(
      freeOf(wisher(3), `spell:${BURNING_HANDS}:free`)?.activation.cost,
    ).toContainEqual({ resource: "wish" });
  });

  it("casts a spell from two traits twice, and through another feat's resource as its own action", async () => {
    const run = await testRun();
    const twice = deriveStats(hero(["gift", "gift-again"]), run);
    expect(twice.resources[`free:${BURNING_HANDS}`]).toBe(2);
    const marked = (feats: readonly string[]) =>
      deriveStats(
        hero(["dragonmarked"], {
          level: 3,
          answers: [{ kind: "feats", values: [...feats] }],
        }),
        run,
      );
    const potent = marked(["test:feat/potent"]);
    const extra = freeOf(potent, `spell:${BURNING_HANDS}:free:potent`);
    expect(extra?.spellLevel).toBe(2);
    expect(extra?.activation.cost).toContainEqual({ resource: "potent" });
    expect(potent.resources.potent).toBe(1);
    expect(freeOf(potent, `spell:${BURNING_HANDS}:free`)).toBeDefined();
    expect(spellOfSource(`spell:${BURNING_HANDS}:free:potent`)).toBe(
      BURNING_HANDS,
    );
    expect(
      freeOf(marked([]), `spell:${BURNING_HANDS}:free:potent`),
    ).toBeUndefined();
  });

  it("casts each of a trait's spells its own way", async () => {
    const run = await testRun();
    const stats = deriveStats(hero(["drowish"]), run);
    expect(
      freeOf(stats, `spell:${BLESS}:free`)?.activation.cost,
    ).not.toContainEqual({ resource: `free:${BLESS}` });
    expect(
      freeOf(stats, `spell:${BURNING_HANDS}:free`)?.activation.cost,
    ).toContainEqual({ resource: `free:${BURNING_HANDS}` });
  });

  it("casts a feat's spells only by its free cast, sharing one use, without knowing them", async () => {
    const run = await testRun();
    const stats = deriveStats(hero(["wishes"]), run);
    for (const spell of [BURNING_HANDS, "srd52:spell/magic-missile"]) {
      expect(
        freeOf(stats, `spell:${spell}:free`)?.activation.cost,
      ).toContainEqual({
        resource: "wishes",
      });
      expect(freeOf(stats, `spell:${spell}`)).toBeUndefined();
    }
  });

  it("picks a background feat's spells between scenes when saves were made before it asked", async () => {
    const run = await testRun();
    const actor = hero([], {
      answers: [{ kind: "feats", values: ["test:feat/later"] }],
    });
    const key = "pick:test:feat/later#cantrips";
    const once = swap(run, actor, key, ["srd52:spell/fire-bolt"]).actor;
    expect(swappable(once, run).find((item) => item.key === key)?.open).toBe(
      true,
    );
    const twice = swap(run, once, key, ["srd52:spell/ray-of-frost"]).actor;
    expect(swappable(twice, run).find((item) => item.key === key)?.open).toBe(
      false,
    );
    expect(spellIds(deriveStats(twice, run))).toEqual(
      expect.arrayContaining([
        "spell:srd52:spell/fire-bolt",
        "spell:srd52:spell/ray-of-frost",
      ]),
    );
  });

  it("has Advantage on attack rolls against a Charmed creature with Treacherous Allure", async () => {
    const run = await testRun();
    const target = hero([], { id: "foe" });
    const charmed: Actor = {
      ...target,
      activeEffects: [
        {
          sourceId: "test",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "condition", condition: "charmed" },
          ends: "spellDuration",
        },
      ],
    };
    const edge = (traits: readonly string[], foe: Actor) => {
      const attacker = hero(traits);
      return traitAttackAdvantage(
        deriveStats(attacker, run),
        attacker,
        foe,
        deriveStats(foe, run),
      );
    };
    expect(edge(["allure"], charmed)).toBe(true);
    expect(edge(["allure"], target)).toBe(false);
    expect(edge([], charmed)).toBe(false);
  });
});
