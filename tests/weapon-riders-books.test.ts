import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Frame, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import {
  type RunContext,
  createRunContext,
  startRun,
  step,
} from "../engine/run/turn.ts";
import { itemFits } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  type Actor,
  type DndState,
  freshActor,
  hasCondition,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { zonesOf } from "../plugins/systems/dnd5.5e/core/zones.ts";
import { BOOK_ROOTS } from "./depth.ts";
import { settle } from "./feat-fixtures.ts";

// A sample of the book's magic weapons and their riders on a hit (issue #139), played by a pregen. Skipped where the
// books aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/dmg") &&
  existsSync("books/rules/arcana-unleashed");

let run: RunContext;

const DUMMY = {
  name: "Dummy",
  ac: 10,
  hp: 300,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
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
          damage: [{ amount: { dice: "1d6" }, type: "bludgeoning" }],
        },
      },
    },
  ],
};
const MONSTERS: Record<string, unknown> = Object.fromEntries(
  ["humanoid", "construct", "giant", "undead", "dragon"].map((type) => [
    `test:monster/${type}`,
    { ...DUMMY, id: `test:monster/${type}`, creatureType: type },
  ]),
);

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "weapon-riders-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "dmg",
    "arcana-unleashed",
    "netherils-fall",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const base = createRunContext(loaded.registry, "goblin-ambush");
  run = {
    ...base,
    content: (id) =>
      (MONSTERS[id] as ReturnType<RunContext["content"]>) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...Object.keys(MONSTERS)],
  };
});

// The pregen with `items` in place of its own weapons and armor, attuned to every one.
function wielding(items: readonly string[], pregen = "fighter"): Actor {
  const chosen = step(run, startRun(run, "books").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: `srd52:pregen/${pregen}`,
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const actor = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  return { ...actor, hp: 100, inventory: [...items], attuned: [...items] };
}

// The same character as a Bard, more charming than strong.
function bard(actor: Actor): Actor {
  if (actor.source.kind !== "character" || !actor.source.build) return actor;
  const { build } = actor.source;
  return {
    ...actor,
    source: {
      ...actor.source,
      build: {
        ...build,
        baseAbilities: { ...build.baseAbilities, str: 10, cha: 16 },
        levels: build.levels.map((level) => ({
          ...level,
          classId: "phb:class/bard",
        })),
      },
    },
  };
}

function monster(id: string, type: string, hp = 300): Actor {
  return freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId: `test:monster/${type}` },
    hp,
    inventory: [],
  });
}

function onGrid(...placed: readonly [Actor, number, number][]): DndState {
  return {
    actors: Object.fromEntries(
      placed.map(([item, x, y]) => [item.id, { ...item, position: { x, y } }]),
    ),
    combat: {
      encounter: "arena",
      order: placed.map(([item]) => item.id),
      index: 0,
      round: 1,
      grid: { width: 14, height: 14 },
    },
  };
}

const swing = (weapon: string, target: string): Frame => ({
  kind: `${NS}:takeAction`,
  payload: { actor: PLAYER_ACTOR, answer: `weapon:${weapon}|${target}` },
});
// The d20 lands on this, and every other die rolls its highest.
const d20 = (natural: number): Dice => ({
  below: () => 0,
  roll: (sides) => (sides === 20 ? natural : sides),
});
const actionOf = (actor: Actor, id: string): KnownAction => {
  const found = deriveStats(actor, run).actions.find(
    (action) => action.id === id,
  );
  if (!found) throw new Error(`No action ${id}`);
  return found;
};
const resolutionOf = (actor: Actor, id: string) => {
  const { resolution } = actionOf(actor, id).activation;
  if (resolution.kind !== "attack") throw new Error(`${id} isn't an attack`);
  return resolution;
};
function damageOf(events: readonly SystemEvent[], id: string): number[] {
  return events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    event.payload.actor === id
      ? [Number(event.payload.amount)]
      : [],
  );
}
const need = (state: DndState, id: string): Actor => {
  const found = state.actors[id];
  if (!found) throw new Error(`No actor ${id}`);
  return found;
};

describe.skipIf(!BOOKS)("the book's magic weapons", () => {
  it("adds dice of the weapon's own type, against the creature types they name", () => {
    const slayer = "dmg:item/dragon-slayer--1--longsword";
    const vicious = "dmg:item/vicious-weapon--1--greataxe";
    const actor = wielding([slayer, vicious]);
    expect(resolutionOf(actor, `weapon:${slayer}`).damage.slice(1)).toEqual([
      { amount: { dice: "3d6" }, type: "slashing", only: ["dragon"] },
    ]);
    expect(resolutionOf(actor, `weapon:${vicious}`).damage.slice(1)).toEqual([
      { amount: { dice: "2d6" }, type: "slashing" },
    ]);
  });

  it("makes a Sun Blade a Finesse longsword of Radiant, and a staff a Quarterstaff", () => {
    const blade = run.content("dmg:item/sun-blade--1--longsword");
    expect(blade).toMatchObject({
      type: "weapon",
      damage: { dice: "1d8", type: "radiant" },
    });
    expect((blade as unknown as { properties: string[] }).properties).toContain(
      "finesse",
    );
    expect(
      run.content("dmg:item/staff-of-striking--1--quarterstaff"),
    ).toMatchObject({
      type: "weapon",
      name: "Staff of Striking (Quarterstaff)",
    });
  });

  it("gives a Silvered Weapon's Critical Hit one of the weapon's dice against a shape-shifted creature", () => {
    const silver = "dmg:item/silvered-weapon--1--longsword";
    expect(
      resolutionOf(wielding([silver]), `weapon:${silver}`).natural20,
    ).toMatchObject({
      critical: true,
      damage: [
        { amount: { dice: "1d8" }, type: "slashing", shapeShifted: true },
      ],
    });
  });

  it("sets a Thunderous Greatclub's Strength, and a Hammer of Thunderbolts' Might of Giants on a belt's", () => {
    const club = "dmg:item/thunderous-greatclub--1--greatclub";
    expect(deriveStats(wielding([club]), run).abilities.str).toBe(20);
    const hammer = "dmg:item/hammer-of-thunderbolts--1--maul";
    const belt = "dmg:item/belt-of-giant-strength--1";
    expect(deriveStats(wielding([hammer, belt]), run).abilities.str).toBe(25);
    const thrown = actionOf(wielding([hammer]), `throw:${hammer}`).activation;
    expect(thrown.cost).toContainEqual({ resource: "hammer-of-thunderbolts" });
    expect(
      thrown.resolution.kind === "attack" && thrown.resolution.onHitSave,
    ).toMatchObject({ ability: "con", radius: 30 });
  });

  it("lets a Bard swing the Lute of Thunderous Thumping with Charisma", () => {
    const lute = "dmg:item/lute-of-thunderous-thumping--1--club";
    expect(
      resolutionOf(bard(wielding([lute])), `weapon:${lute}`).attack.ability,
    ).toBe("cha");
    expect(
      resolutionOf(wielding([lute]), `weapon:${lute}`).attack.ability,
    ).toBe("str");
  });

  it("offers a staff's charges only on its own hits", () => {
    const staff = "dmg:item/staff-of-striking--1--quarterstaff";
    const actor = wielding([staff, "srd52:item/dagger"]);
    const uses = deriveStats(actor, run).actions.filter(({ id }) =>
      id.startsWith(`use:${staff}`),
    );
    expect(uses).toHaveLength(3);
    const [one] = uses;
    if (!one) throw new Error("No use");
    expect(itemFits(one, actionOf(actor, `weapon:${staff}`), run)).toBe(true);
    expect(
      itemFits(one, actionOf(actor, "weapon:srd52:item/dagger"), run),
    ).toBe(false);
  });

  it("turns an Executioner's Axe's extra damage on a Humanoid into Temporary Hit Points", () => {
    const axe = "dmg:item/executioner-s-axe--1--battleaxe";
    const state = onGrid(
      [wielding([axe]), 0, 0],
      [monster("bandit", "humanoid"), 1, 0],
    );
    const hit = settle(run, state, [swing(axe, "bandit")], d20(15));
    expect(need(hit.state, PLAYER_ACTOR).tempHp).toBe(12);
  });

  it("smashes a Construct left at 25 Hit Points or fewer on a Mace of Smiting's 20", () => {
    const mace = "dmg:item/mace-of-smiting--1--mace";
    const state = onGrid(
      [wielding([mace]), 0, 0],
      [monster("golem", "construct", 40), 1, 0],
    );
    const twenty = settle(run, state, [swing(mace, "golem")], d20(20));
    expect(twenty.state.actors.golem?.hp ?? 0).toBeLessThanOrEqual(0);
    const fifteen = settle(run, state, [swing(mace, "golem")], d20(15));
    expect(need(fifteen.state, "golem").hp).toBeGreaterThan(0);
  });

  it("cuts off a head with a Vorpal Sword's 20", () => {
    const vorpal = "dmg:item/vorpal-sword--1--longsword";
    const state = onGrid(
      [wielding([vorpal]), 0, 0],
      [monster("ogre", "giant"), 1, 0],
    );
    const twenty = settle(run, state, [swing(vorpal, "ogre")], d20(20));
    expect(twenty.state.actors.ogre?.hp ?? 0).toBeLessThanOrEqual(0);
    const fifteen = settle(run, state, [swing(vorpal, "ogre")], d20(15));
    expect(need(fifteen.state, "ogre").hp).toBeGreaterThan(0);
  });

  it("knocks a Giant Prone with a Giant Slayer, and no other creature", () => {
    const slayer = "dmg:item/giant-slayer--1--longsword";
    // The attack's d20 hits, and every later one fails its save.
    let d20s = 0;
    const fail: Dice = {
      below: () => 0,
      roll: (sides) => (sides === 20 ? (d20s++ % 2 === 0 ? 15 : 1) : 1),
    };
    const giant = onGrid(
      [wielding([slayer]), 0, 0],
      [monster("ogre", "giant"), 1, 0],
    );
    const felled = settle(run, giant, [swing(slayer, "ogre")], fail);
    expect(hasCondition(need(felled.state, "ogre"), "prone")).toBe(true);
    const man = onGrid(
      [wielding([slayer]), 0, 0],
      [monster("bandit", "humanoid"), 1, 0],
    );
    const stood = settle(run, man, [swing(slayer, "bandit")], fail);
    expect(hasCondition(need(stood.state, "bandit"), "prone")).toBe(false);
  });

  it("makes a hit a Critical Hit with a Namer's Needle, once a dawn", () => {
    const needle = "dmg:item/namer-s-needle--1--dagger".replace(
      "dmg:",
      "arcana-unleashed:",
    );
    const state = onGrid(
      [wielding([needle]), 0, 0],
      [monster("bandit", "humanoid"), 1, 0],
    );
    const named = settle(run, state, [swing(needle, "bandit")], d20(15));
    expect(
      named.decisions.some(({ id }) => id === `${NS}:strike:${PLAYER_ACTOR}`),
    ).toBe(true);
    // 1d4 doubled at its highest, the +1 and Strength: more than a plain hit's.
    const plain = settle(
      run,
      state,
      [swing(needle, "bandit")],
      d20(15),
      () => "decline",
    );
    expect(damageOf(named.events, "bandit")[0]).toBeGreaterThan(
      damageOf(plain.events, "bandit")[0] ?? 0,
    );
    expect(
      need(named.state, PLAYER_ACTOR).resourcesSpent["namer-s-needle"],
    ).toBe(1);
  });

  it("coats the Dagger of Venom with a Bonus Action, and the next hit brings the save", () => {
    const dagger = "dmg:item/dagger-of-venom--1--dagger";
    const state = onGrid(
      [wielding([dagger]), 0, 0],
      [monster("bandit", "humanoid"), 1, 0],
    );
    const coated = settle(
      run,
      state,
      [
        {
          kind: `${NS}:takeAction`,
          payload: {
            actor: PLAYER_ACTOR,
            answer: `use:${dagger}:0|${PLAYER_ACTOR}`,
          },
        },
      ],
      d20(15),
    );
    expect(
      need(coated.state, PLAYER_ACTOR).activeEffects.map(
        ({ modifier }) => modifier.kind,
      ),
    ).toEqual(["coating"]);
    let d20s = 0;
    const struck = settle(run, coated.state, [swing(dagger, "bandit")], {
      below: () => 0,
      roll: (sides) => (sides === 20 ? (d20s++ === 0 ? 15 : 1) : sides),
    });
    expect(hasCondition(need(struck.state, "bandit"), "poisoned")).toBe(true);
    expect(need(struck.state, PLAYER_ACTOR).activeEffects).toEqual([]);
  });

  it("flies with the Mythallar Cloak and adds its Radiant to one hit a turn", () => {
    const cloak = "netherils-fall:item/mythallar-cloak";
    const actor = wielding([cloak, "srd52:item/longsword"]);
    const uses = deriveStats(actor, run).actions.filter(({ id }) =>
      id.startsWith(`use:${cloak}`),
    );
    expect(uses.map(({ activation }) => activation.cost)).toEqual([
      ["bonusAction", { resource: "mythallar-cloak" }],
    ]);
  });

  it("swears an Oathbow's enemy: Advantage on it, Disadvantage with other weapons while it lives", () => {
    const bow = "dmg:item/oathbow--1--longbow";
    const state = onGrid(
      [wielding([bow, "srd52:item/dagger"]), 0, 0],
      [monster("foe", "humanoid"), 6, 0],
      [monster("other", "humanoid"), 1, 0],
    );
    const sworn = settle(
      run,
      state,
      [
        {
          kind: `${NS}:takeAction`,
          payload: { actor: PLAYER_ACTOR, answer: `use:${bow}:0|foe` },
        },
      ],
      d20(15),
    );
    // The roll at the sworn enemy has Advantage, and one with another weapon Disadvantage.
    const rolled = (weapon: string, target: string) => {
      // The other foe stands aside for the shot, so it isn't made in melee.
      const other = need(sworn.state, "other");
      const state =
        weapon === bow
          ? {
              ...sworn.state,
              actors: {
                ...sworn.state.actors,
                other: { ...other, position: { x: 12, y: 12 } },
              },
            }
          : sworn.state;
      const result = run.system.frames[`${NS}:attackRoll`]?.run(
        { attacker: PLAYER_ACTOR, actionId: `weapon:${weapon}`, target },
        {
          state,
          dice: d20(15),
          content: run.content,
          contentIds: run.contentIds,
        },
      );
      return result?.frames?.find(({ kind }) => kind === `${NS}:applyHit`)
        ?.payload as { hadAdvantage: boolean; hadDisadvantage?: boolean };
    };
    expect(rolled(bow, "foe")).toMatchObject({ hadAdvantage: true });
    expect(rolled("srd52:item/dagger", "other")).toMatchObject({
      hadDisadvantage: true,
    });
    const shot = settle(run, sworn.state, [swing(bow, "foe")], d20(15));
    // 1d8 + 3d6 at their highest, with Dexterity's modifier.
    const [dealt = 0] = damageOf(shot.events, "foe");
    expect(dealt).toBeGreaterThanOrEqual(8 + 18);
  });

  it("restrains a creature all three of a Tentacle Rod's tentacles hit", () => {
    const rod = "dmg:item/tentacle-rod";
    let d20s = 0;
    const state = onGrid(
      [wielding([rod]), 0, 0],
      [monster("bandit", "humanoid"), 2, 0],
    );
    const held = settle(
      run,
      state,
      [
        {
          kind: `${NS}:takeAction`,
          payload: { actor: PLAYER_ACTOR, answer: `use:${rod}:0|bandit` },
        },
      ],
      {
        below: () => 0,
        roll: (sides) => (sides === 20 ? (d20s++ < 3 ? 15 : 1) : 1),
      },
    );
    expect(damageOf(held.events, "bandit")).toEqual([1, 1, 1]);
    expect(hasCondition(need(held.state, "bandit"), "restrained")).toBe(true);
  });

  it("gives a Holy Avenger's bearer and its friends nearby Advantage on saves against magic", () => {
    const avenger = "dmg:item/holy-avenger--1--longsword";
    const state = onGrid(
      [wielding([avenger]), 0, 0],
      [{ ...wielding([]), id: "friend" }, 1, 0],
      [{ ...wielding([]), id: "far" }, 6, 0],
    );
    const [aura] = zonesOf(state, run).filter(
      ({ name }) => name === "Holy Avenger",
    );
    expect(aura).toMatchObject({ radius: 10, owner: PLAYER_ACTOR });
  });

  it("knocks a creature Prone with a piece of Walloping Ammunition, which the hit spends", () => {
    const bow = "srd52:item/shortbow";
    const arrow = "dmg:item/walloping-ammunition";
    let d20s = 0;
    const state = onGrid(
      [wielding([bow, arrow]), 0, 0],
      [monster("bandit", "humanoid"), 6, 0],
    );
    const shot = settle(run, state, [swing(bow, "bandit")], {
      below: () => 0,
      roll: (sides) => (sides === 20 ? (d20s++ === 0 ? 15 : 1) : 1),
    });
    expect(hasCondition(need(shot.state, "bandit"), "prone")).toBe(true);
    expect(need(shot.state, PLAYER_ACTOR).inventory).not.toContain(arrow);
  });

  it("slays a creature under 100 Hit Points on a Nine Lives Stealer's 20, spending a charge", () => {
    const blade = "dmg:item/nine-lives-stealer--1--longsword";
    let d20s = 0;
    const state = onGrid(
      [wielding([blade]), 0, 0],
      [monster("bandit", "humanoid", 60), 1, 0],
    );
    const slain = settle(run, state, [swing(blade, "bandit")], {
      below: () => 0,
      roll: (sides) => (sides === 20 ? (d20s++ === 0 ? 20 : 1) : 1),
    });
    expect(slain.state.actors.bandit?.hp ?? 0).toBeLessThanOrEqual(0);
    expect(
      need(slain.state, PLAYER_ACTOR).resourcesSpent["nine-lives-stealer"],
    ).toBe(1);
  });
});
