import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { startRun, step } from "../engine/run/turn.ts";
import { twoWeaponStyle } from "../plugins/systems/dnd5.5e/core/actions/bonus-attacks.ts";
import { CREATE_CHARACTER } from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  fitsType,
  hasPassive,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  type CharacterBuild,
  FeatSchema,
  FeatureSchema,
  ItemSchema,
  MonsterSchema,
  PregenSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";

// What a player has with no books installed (#215): the SRD rules and the shipped adventures. Every number here
// was checked against the SRD 5.2 document.

const { run } = await loadAdventure("goblin-ambush");
const ids = (kind: string) =>
  run.contentIds().filter((id) => id.includes(`:${kind}/`));

type Answers = CharacterBuild["levels"][number]["answers"];

function pregenActor(slug: string, more: Answers = []): Actor {
  const pregen = lookup(run, PregenSchema, `srd52:pregen/${slug}`);
  const [first, ...rest] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  return freshActor({
    id: PLAYER_ACTOR,
    name: pregen.name,
    side: "party",
    source: {
      kind: "character",
      build: {
        ...pregen.build,
        levels: [{ ...first, answers: [...first.answers, ...more] }, ...rest],
      },
    },
    hp: 1,
    inventory: pregen.equipment,
  });
}

const monster = (id: string): Actor =>
  freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId: id },
    hp: 1,
    inventory: [],
  });

const feat = (id: string): Answers => [{ kind: "feats", values: [id] }];

describe("shipped feats", () => {
  // Feats whose effect is code that reads the feat's id, so they grant no feature.
  const CODE_KEYED = [
    "srd52:feat/ability-score-improvement", // character.ts asks its increase
    "srd52:feat/two-weapon-fighting", // actions/bonus-attacks.ts
  ];

  it("each does something: a feature with mechanics, a choice, or code that reads its id", () => {
    const feats = ids("feat").map((id) => lookup(run, FeatSchema, id));
    // Every SRD 5.2 feat ships (#222), so this covers all of them.
    expect(feats.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "Alert",
        "Magic Initiate",
        "Savage Attacker",
        "Skilled",
        "Ability Score Improvement",
        "Grappler",
        "Archery",
        "Defense",
        "Great Weapon Fighting",
        "Two-Weapon Fighting",
        "Boon of Combat Prowess",
        "Boon of Dimensional Travel",
        "Boon of Fate",
        "Boon of Irresistible Offense",
        "Boon of Spell Recall",
        "Boon of the Night Spirit",
        "Boon of Truesight",
      ]),
    );
    // A feat printed once and offered as a version per spell list, as Magic Initiate, is never taken itself.
    const versioned = (entry: (typeof feats)[number]) =>
      feats.some(
        (other) =>
          other.id.startsWith(`${entry.id}-`) &&
          other.name.startsWith(`${entry.name} (`),
      );
    const idle = feats
      .filter((entry) => {
        const works = entry.grants.some((grant) => {
          const feature = lookup(run, FeatureSchema, grant);
          return (
            feature.passives.length > 0 ||
            feature.activations.length > 0 ||
            feature.resources.length > 0
          );
        });
        return (
          !works &&
          entry.choices.length === 0 &&
          !versioned(entry) &&
          !CODE_KEYED.includes(entry.id)
        );
      })
      .map(({ id }) => id);
    expect(idle).toEqual([]);
    expect(
      twoWeaponStyle(
        pregenActor("rogue", feat("srd52:feat/two-weapon-fighting")),
      ),
    ).toBe(true);
    expect(twoWeaponStyle(pregenActor("rogue"))).toBe(false);
  });

  it("adds 2 to ranged weapon attacks with Archery, and nothing to melee ones", () => {
    const bonus = (actor: Actor, action: string) => {
      const resolution = deriveStats(actor, run).actions.find(
        ({ id }) => id === action,
      )?.activation.resolution;
      if (resolution?.kind !== "attack") throw new Error(`No attack ${action}`);
      return resolution.attack.flatBonus ?? 0;
    };
    const archer = pregenActor("rogue", feat("srd52:feat/archery"));
    expect(bonus(archer, "weapon:srd52:item/shortbow")).toBe(2);
    expect(bonus(archer, "weapon:srd52:item/shortsword")).toBe(0);
    expect(bonus(pregenActor("rogue"), "weapon:srd52:item/shortbow")).toBe(0);
  });

  it("adds 1 to Armor Class with Defense, only in armor", () => {
    const ac = (actor: Actor) => deriveStats(actor, run).ac;
    const rogue = pregenActor("rogue");
    const styled = pregenActor("rogue", feat("srd52:feat/defense"));
    expect(ac(styled)).toBe(ac(rogue) + 1);
    const bare = (actor: Actor) => ({ ...actor, inventory: [] });
    expect(ac(bare(styled))).toBe(ac(bare(rogue)));
  });

  it("gives Great Weapon Fighting and Grappler their passives, and Grappler its ability increase", () => {
    const has = (id: string, kind: Parameters<typeof hasPassive>[1]) =>
      hasPassive(deriveStats(pregenActor("fighter", feat(id)), run), kind);
    expect(has("srd52:feat/great-weapon-fighting", "greatWeaponFighting")).toBe(
      true,
    );
    expect(has("srd52:feat/grappler", "grappledAdvantage")).toBe(true);
    expect(lookup(run, FeatSchema, "srd52:feat/grappler")).toMatchObject({
      abilityIncrease: ["str", "dex"],
      prerequisite: { abilities: ["str", "dex"], min: 13 },
    });
  });
});

describe("shipped monsters", () => {
  it("each has a size and a creature type", () => {
    const bare = ids("monster").filter((id) => {
      const { size, creatureType } = lookup(run, MonsterSchema, id);
      return size === undefined || creatureType === undefined;
    });
    expect(bare).toEqual([]);
  });

  it("makes goblins Small Fey and the commoner a Humanoid, as the SRD prints them", () => {
    const type = (id: string) => deriveStats(monster(id), run).creatureType;
    for (const id of [
      "srd52:monster/goblin-warrior",
      "srd52:monster/goblin-boss",
      "goblin-ambush:monster/chief",
    ]) {
      expect([id, type(id), lookup(run, MonsterSchema, id).size]).toEqual([
        id,
        "fey",
        "small",
      ]);
    }
    expect(type("srd52:monster/commoner")).toBe("humanoid");
  });

  it("lets Charm Person and Hold Person take a Humanoid and no other creature", () => {
    const wizard = pregenActor("wizard");
    for (const spell of ["charm-person", "hold-person", "dominate-person"]) {
      const { targeting } = lookup(run, SpellSchema, `srd52:spell/${spell}`)
        .activation ?? { targeting: undefined };
      if (!targeting) throw new Error(`${spell} has no activation`);
      const fits = (id: string) =>
        fitsType(monster(id), targeting, run, wizard);
      expect([spell, fits("srd52:monster/commoner")]).toEqual([spell, true]);
      expect([spell, fits("srd52:monster/goblin-warrior")]).toEqual([
        spell,
        false,
      ]);
      expect([spell, fits("srd52:monster/zombie")]).toEqual([spell, false]);
    }
  });

  it("gives the Goblin Boss its traits, and both goblins Nimble Escape", () => {
    const boss = deriveStats(monster("srd52:monster/goblin-boss"), run);
    expect(boss.passives).toEqual(
      expect.arrayContaining([
        { kind: "bonusTactics", tactics: ["disengage", "hide"] },
        expect.objectContaining({
          kind: "extraDamage",
          dice: "1d4",
          when: "advantage",
        }),
      ]),
    );
    expect(
      lookup(run, MonsterSchema, "srd52:monster/goblin-boss").actions.map(
        ({ name }) => name,
      ),
    ).toEqual(["Scimitar", "Shortbow", "Redirect Attack"]);
    expect(
      hasPassive(
        deriveStats(monster("srd52:monster/goblin-warrior"), run),
        "bonusTactics",
      ),
    ).toBe(true);
  });

  it("makes the SRD's undead immune to Exhaustion", () => {
    for (const id of ["skeleton", "zombie", "ghoul"]) {
      const stats = deriveStats(monster(`srd52:monster/${id}`), run);
      expect([id, hasPassive(stats, "noExhaustion")]).toEqual([id, true]);
    }
  });
});

describe("shipped equipment and spells", () => {
  it("gives every ranged or thrown weapon its range, the Shortbow 80/320", () => {
    const rangeless = ids("item").filter((id) => {
      const item = lookup(run, ItemSchema, id);
      return (
        item.type === "weapon" &&
        item.properties.some((p) => p === "ammunition" || p === "thrown") &&
        item.range === undefined
      );
    });
    expect(rangeless).toEqual([]);
    expect(lookup(run, ItemSchema, "srd52:item/shortbow")).toMatchObject({
      range: { normal: 80, long: 320 },
    });
  });

  it("marks a spell fully automated only when casting it does something", () => {
    const idle = ids("spell").filter((id) => {
      const spell = lookup(run, SpellSchema, id);
      return (
        spell.automation === "full" &&
        spell.activation === undefined &&
        spell.outOfCombat === undefined
      );
    });
    expect(idle).toEqual([]);
    for (const id of ["telepathic-bond", "secret-chest"]) {
      expect(lookup(run, SpellSchema, `srd52:spell/${id}`).automation).toBe(
        "text",
      );
    }
  });
});

describe("the pregens", () => {
  // Plays character creation with the pregen's own picks, in the order creation asks for them.
  function handBuilt(slug: string) {
    const pregen = lookup(run, PregenSchema, `srd52:pregen/${slug}`);
    const { build } = pregen;
    const [level] = build.levels;
    if (!level) throw new Error("The pregen has no levels");
    const scores = Object.entries(build.baseAbilities);
    const increase = Object.entries(build.backgroundIncrease)
      .map(([ability, by]) => `${ability}:${String(by)}`)
      .join(",");
    // Each answer's values, taken one at a time by the decisions of its kind.
    const queue = level.answers.flatMap((answer) =>
      "values" in answer ? answer.values : [],
    );
    let { state, pending } = startRun(run, `pregen-${slug}`);
    for (let asked = 0; asked < 100 && pending; asked += 1) {
      const { id, options } = pending;
      const scored = /:score-(\d+)$/.exec(id)?.[1];
      const optionId = id.endsWith(":chooseCharacter")
        ? CREATE_CHARACTER
        : id.endsWith(":species")
          ? build.speciesId
          : id.endsWith(":class")
            ? level.classId
            : id.endsWith(":background")
              ? build.backgroundId
              : scored !== undefined
                ? scores.find(([, score]) => score === Number(scored))?.[0]
                : id.endsWith(":increase")
                  ? increase
                  : id.endsWith(":name")
                    ? options[0]?.id
                    : queue.shift();
      if (optionId === undefined)
        throw new Error(`${slug}: no answer for ${id}`);
      const outcome = step(run, state, {
        kind: "answer",
        decisionId: id,
        optionId,
      });
      if (!outcome.ok) throw new Error(`${slug}: ${id}: ${outcome.error}`);
      const chosen = outcome.events.find(({ kind }) =>
        kind.endsWith(":characterChosen"),
      );
      if (chosen && "payload" in chosen) {
        return { pregen, made: chosen.payload as unknown, left: queue };
      }
      ({ state, pending } = outcome);
    }
    throw new Error(`${slug}: creation never finished`);
  }

  it.each(["fighter", "rogue", "cleric", "wizard"])(
    "the %s is the character creation makes of the same picks, gear included",
    (slug) => {
      const { pregen, made, left } = handBuilt(slug);
      expect(left).toEqual([]); // creation asked for every pick the pregen states
      expect(made).toMatchObject({
        build: pregen.build,
        inventory: pregen.equipment,
        hp: deriveStats(pregenActor(slug), run).maxHp,
      });
    },
  );

  it("builds each class's level 1 in full", () => {
    const first = (slug: string) =>
      lookup(run, PregenSchema, `srd52:pregen/${slug}`).build.levels[0]
        ?.answers ?? [];
    const feats = (slug: string) =>
      first(slug).flatMap((answer) =>
        answer.kind === "feats" ? answer.values : [],
      );
    // Fighting Style and the Human's Versatile; the others, Versatile alone.
    expect(feats("fighter")).toEqual([
      "srd52:feat/defense",
      "srd52:feat/alert",
    ]);
    for (const slug of ["rogue", "cleric", "wizard"]) {
      expect(feats(slug)).toHaveLength(1);
    }
    expect(deriveStats(pregenActor("fighter"), run).ac).toBe(19); // Chain Mail, Shield, Defense
    expect(deriveStats(pregenActor("rogue"), run).expertise).toEqual([
      "stealth",
      "perception",
    ]);
    for (const slug of ["cleric", "wizard"]) {
      const spells = first(slug).flatMap((answer) =>
        answer.kind === "spells" ? [answer.values.length] : [],
      );
      expect([slug, spells.slice(0, 2)]).toEqual([slug, [3, 4]]); // cantrips, then prepared spells
    }
  });
});
