import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import {
  type RunContext,
  createRunContext,
  startRun,
  step,
} from "../engine/run/turn.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { sceneGearActions } from "../plugins/systems/dnd5.5e/core/gear.ts";
import {
  damageResponses,
  deriveStats,
  saveBonus,
  spellSaveDc,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { BOOK_ROOTS } from "./depth.ts";
import { castFrom } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";

// A sample of the book's magic items (issues #137 and #138), played by a pregen. Skipped where the books aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/dmg") &&
  existsSync("books/rules/arcana-unleashed-deadfall") &&
  existsSync("books/rules/eberron-forge-of-the-artificer");

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "magic-item-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "dmg",
    "arcana-unleashed-deadfall",
    "eberron-forge-of-the-artificer",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
});

// The pregen wearing `items` in place of its armor and shield, attuned to every one.
function wearing(items: readonly string[], pregen = "fighter"): Actor {
  const chosen = step(run, startRun(run, "books").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: `srd52:pregen/${pregen}`,
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const actor = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  return {
    ...actor,
    inventory: [
      ...actor.inventory.filter(
        (id) => id !== "srd52:item/chain-mail" && id !== "srd52:item/shield",
      ),
      ...items,
    ],
    attuned: [...items],
  };
}

describe.skipIf(!BOOKS)("the book's magic items", () => {
  it("gives a Cloak of Protection's AC and saves", () => {
    const plain = deriveStats(wearing([]), run);
    const cloaked = deriveStats(wearing(["dmg:item/cloak-of-protection"]), run);
    expect(cloaked.ac - plain.ac).toBe(1);
    expect(saveBonus(cloaked, "dex") - saveBonus(plain, "dex")).toBe(1);
  });

  it("wears +N armor and Shields, and Elven Chain without training", () => {
    const armor = "dmg:item/armor-1-2-or-3--1--chain-mail";
    const shield = "dmg:item/shield-1-2-or-3--3--shield";
    expect(run.content(armor)).toMatchObject({ name: "+1 Chain Mail" });
    expect(deriveStats(wearing([armor, shield]), run).ac).toBe(16 + 1 + 2 + 3);
    const wizard = deriveStats(
      wearing(["dmg:item/elven-chain--1--chain-mail"], "wizard"),
      run,
    );
    expect(wizard.untrainedArmor).toBe(false);
    expect(wizard.ac).toBe(17);
  });

  it("sets Strength with a Belt of Giant Strength", () => {
    const storm = "dmg:item/belt-of-giant-strength--6";
    expect(run.content(storm)).toMatchObject({
      name: "Belt of Giant Strength (storm)",
    });
    expect(deriveStats(wearing([storm]), run).abilities.str).toBe(29);
  });

  it("raises a Robe of Thayan Arcana's wearer's spell save DC", () => {
    const robe = "arcana-unleashed-deadfall:item/robe-of-thayan-arcana";
    const plain = deriveStats(wearing([], "wizard"), run);
    const robed = deriveStats(wearing([robe], "wizard"), run);
    expect(spellSaveDc(robed) - spellSaveDc(plain)).toBe(1);
  });

  it("makes a Returning Weapon from a thrown one", () => {
    expect(
      run.content(
        "eberron-forge-of-the-artificer:item/returning-weapon--1--javelin",
      ),
    ).toMatchObject({
      name: "Returning Weapon (Javelin)",
      type: "weapon",
      returning: true,
    });
  });
});

describe.skipIf(!BOOKS)("the book's magic items' passives", () => {
  const resists = (actor: Actor) =>
    [...damageResponses(actor, run).resistances].sort();
  const kinds = (actor: Actor) =>
    deriveStats(actor, run).passives.map((passive) => passive.kind);

  it("plays the shipped adventures' Staff of the Spirit Aegis and rings", () => {
    expect(
      resists(
        wearing(["arcana-unleashed-deadfall:item/staff-of-the-spirit-aegis"]),
      ),
    ).toEqual(["necrotic"]);
    expect(kinds(wearing(["dmg:item/ring-of-spell-turning"]))).toEqual(
      expect.arrayContaining(["magicResistance", "spellTurning"]),
    );
    expect(kinds(wearing(["dmg:item/ring-of-regeneration"]))).toContain(
      "slowRegeneration",
    );
  });

  it("resists the type of a Ring or Armor of Resistance's version", () => {
    expect(resists(wearing(["dmg:item/ring-of-resistance--3"]))).toEqual([
      "fire",
    ]);
    const armor = "dmg:item/armor-of-resistance--5--chain-mail";
    expect(run.content(armor)).toMatchObject({
      name: "Armor of Resistance (Lightning, Chain Mail)",
      type: "armor",
    });
    expect(resists(wearing([armor]))).toEqual(["lightning"]);
    expect(deriveStats(wearing([armor]), run).ac).toBe(16);
  });

  it("wears Dragon Scale Mail for its AC and its dragon's Resistance", () => {
    const mail = "dmg:item/dragon-scale-mail--9--scale-mail";
    expect(deriveStats(wearing([mail]), run).ac).toBe(14 + 1 + 1);
    expect(resists(wearing([mail]))).toEqual(["cold"]);
  });

  it("gives a Robe of the Archmagi's AC, spell DC and Magic Resistance", () => {
    const robe = "dmg:item/robe-of-the-archmagi";
    const plain = deriveStats(wearing([], "wizard"), run);
    const robed = deriveStats(wearing([robe], "wizard"), run);
    expect(robed.ac).toBe(15 + 2); // Dexterity 15 for +2
    expect(spellSaveDc(robed) - spellSaveDc(plain)).toBe(2);
    expect(kinds(wearing([robe], "wizard"))).toContain("magicResistance");
  });

  it("gives Frost Brand's Resistance and Cold, and Adamantine Armor's normal hits", () => {
    const brand = "dmg:item/frost-brand--1--longsword";
    expect(resists(wearing([brand]))).toEqual(["fire"]);
    const action = deriveStats(wearing([brand]), run).actions.find(
      (each) => each.id === `weapon:${brand}`,
    );
    const resolution = action?.activation.resolution;
    if (resolution?.kind !== "attack") throw new Error("Not an attack");
    expect(resolution.damage.map((each) => each.type)).toEqual([
      "slashing",
      "cold",
    ]);
    expect(
      kinds(wearing(["dmg:item/adamantine-armor--1--chain-mail"])),
    ).toContain("noCriticals");
  });

  // Issue #140: charges that cast spells.
  const casts = (actor: Actor) =>
    deriveStats(actor, run)
      .actions.filter((action) => castFrom(action.id))
      .map((action) => action.name);

  it("casts the shipped adventures' Thayan Sword smites and Staff of Power spells from their charges", () => {
    const sword = "arcana-unleashed-deadfall:item/thayan-sword";
    expect(casts(wearing([sword]))).toEqual([
      "Searing Smite (Thayan Sword)",
      "Thunderous Smite (Thayan Sword)",
      "Wrathful Smite (Thayan Sword)",
    ]);
    const stats = deriveStats(wearing([sword]), run);
    expect(stats.resources).toMatchObject({
      "thayan-sword": 4,
      "thayan-sword-resurgent": 1,
    });
    expect(kinds(wearing([sword]))).toContain("dropToOne");
    const staff = wearing(["dmg:item/staff-of-power"], "wizard");
    const named = casts(staff);
    expect(named).toContain("Fireball (Staff of Power)");
    expect(named).toContain("Cone of Cold (Staff of Power)");
    const fireball = deriveStats(staff, run).actions.find(
      (action) => action.name === "Fireball (Staff of Power)",
    );
    expect(fireball?.spellLevel).toBe(5);
    expect(fireball?.activation.cost).toContainEqual({
      resource: "staff-of-power",
      count: 5,
    });
  });

  it("heals from a Staff of Healing with the bearer's Wisdom, a level for each charge", () => {
    const named = casts(wearing(["dmg:item/staff-of-healing"], "cleric"));
    expect(named.filter((name) => name.startsWith("Cure Wounds"))).toEqual([
      "Cure Wounds, level 1 (Staff of Healing)",
      "Cure Wounds, level 2 (Staff of Healing)",
      "Cure Wounds, level 3 (Staff of Healing)",
      "Cure Wounds, level 4 (Staff of Healing)",
    ]);
  });

  // Issues #189 and #193: item activations and the passives #138 left.
  it("uses a Pearl of Power or a Spell-Refueling Ring for a slot, and an Arrow-Catching Shield's Reaction", () => {
    const uses = (actor: Actor) =>
      deriveStats(actor, run)
        .actions.filter((action) => action.id.startsWith("use:"))
        .map((action) => [action.name, action.activation.cost[0]]);
    expect(uses(wearing(["dmg:item/pearl-of-power"], "wizard"))).toEqual([
      ["Pearl of Power", "action"],
    ]);
    expect(
      uses(
        wearing(
          ["eberron-forge-of-the-artificer:item/spell-refueling-ring"],
          "wizard",
        ),
      ),
    ).toEqual([["Spell-Refueling Ring", "bonusAction"]]);
    expect(
      uses(wearing(["dmg:item/arrow-catching-shield--1--shield"])),
    ).toEqual([["Arrow-Catching Shield", "reaction"]]);
  });

  it("plays #193's passives: displacement, warmth, a saddle, free action, spell turning, a scarab and a dragon's breath", () => {
    expect(kinds(wearing(["dmg:item/cloak-of-displacement"]))).toContain(
      "ward",
    );
    expect(kinds(wearing(["dmg:item/saddle-of-the-cavalier"]))).toContain(
      "protectedMount",
    );
    expect(kinds(wearing(["dmg:item/ring-of-free-action"]))).toContain(
      "steadySpeed",
    );
    expect(
      deriveStats(wearing(["dmg:item/ring-of-spell-turning"]), run).passives,
    ).toContainEqual({ kind: "spellTurning", upTo: 7, deflect: true });
    const scarab = deriveStats(wearing(["dmg:item/scarab-of-protection"]), run);
    expect(scarab.resources["scarab-of-protection"]).toBe(12);
    expect(kinds(wearing(["dmg:item/scarab-of-protection"]))).toContain(
      "saveRescue",
    );
    expect(
      deriveStats(wearing(["dmg:item/dragon-scale-mail--9--scale-mail"]), run)
        .passives,
    ).toContainEqual(
      expect.objectContaining({
        kind: "saveAdvantage",
        from: { creatureTypes: ["dragon"], breath: true },
      }),
    );
  });

  it("names only spells some book has, for every item that casts", async () => {
    const missing: string[] = [];
    for (const book of await readdir("books/rules")) {
      const folder = `books/rules/${book}/equipment`;
      if (!existsSync(folder)) continue;
      for (const file of await readdir(folder)) {
        const text = await readFile(`${folder}/${file}`, "utf8");
        for (const [, slug = ""] of text.matchAll(/\{ spell: ([a-z0-9-]+)/g)) {
          const known =
            run.contentIds().some((id) => id.endsWith(`:spell/${slug}`)) ||
            existsSync(`books/rules/arcana-unleashed/spells/${slug}.yaml`);
          if (!known) missing.push(`${file}: ${slug}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

// A sample of #142's single-use items and #180's riders, as the books encode them.
describe.skipIf(!BOOKS)("the book's single-use items and riders", () => {
  const action = (actor: Actor, id: string) => {
    const found = deriveStats(actor, run).actions.find(
      (item) => item.id === id,
    );
    if (!found) throw new Error(`No ${id}`);
    return found;
  };
  const added = (actor: Actor, id: string) =>
    (
      resolveAction(action(actor, id), actor, [actor], {
        state: { actors: { [actor.id]: actor }, combat: null },
        dice: { roll: () => 3, below: () => 0 },
        content: run.content,
        contentIds: run.contentIds,
      }).events ?? []
    ).flatMap((event) =>
      event.kind === `${NS}:effectAdded` && "payload" in event
        ? [
            (event.payload as { effect: { modifier: { kind: string } } }).effect
              .modifier,
          ]
        : [],
    );

  it("drinks a Potion of Speed's Haste without lethargy, and a storm Potion of Giant Strength's Strength 29", () => {
    const speed = "dmg:item/potion-of-speed";
    expect(added(wearing([speed]), `item:${speed}`)).toContainEqual({
      kind: "hasted",
      noLethargy: true,
    });
    const storm = "dmg:item/potion-of-giant-strength--6";
    expect(run.content(storm)).toMatchObject({
      name: "Potion of Giant Strength (storm)",
    });
    expect(added(wearing([storm]), `item:${storm}`)).toContainEqual({
      kind: "setScore",
      ability: "str",
      score: 29,
    });
  });

  it("reads a Spell Scroll of Fireball with the scroll's DC, and gives Wraps of Unarmed Power to Unarmed Strikes", () => {
    const scroll = "dmg:item/spell-scroll--fireball";
    const read = action(wearing([scroll], "wizard"), `item:${scroll}`);
    expect(read.activation.resolution).toMatchObject({ dc: { base: 15 } });
    expect(read.castCheck).toMatchObject({ dc: 13 });
    const strike = action(
      wearing(["dmg:item/wraps-of-unarmed-power--2"]),
      "unarmed-strike",
    ).activation.resolution;
    expect(strike).toMatchObject({ attack: { itemBonus: 2 } });
  });

  it("fires +3 Ammunition, and offers Oil of Sharpness for a Longsword", () => {
    const shot = action(
      wearing(["srd52:item/shortbow", "dmg:item/ammunition-1-2-or-3--3"]),
      "weapon:srd52:item/shortbow",
    );
    expect(shot.ammunition).toBe("dmg:item/ammunition-1-2-or-3--3");
    expect(shot.activation.resolution).toMatchObject({
      attack: { itemBonus: 3 },
    });
    const oiled = wearing([
      "srd52:item/longsword",
      "dmg:item/oil-of-sharpness",
    ]);
    const options = sceneGearActions(
      { actors: { [PLAYER_ACTOR]: oiled }, combat: null },
      run,
    ).map((option) => option.args);
    expect(options).toContainEqual(
      expect.objectContaining({
        items: ["dmg:item/weapon-1-2-or-3--3--longsword"],
      }),
    );
  });
});
