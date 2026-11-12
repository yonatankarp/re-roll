import { PLAYER_ACTOR, type Decision } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { type RunContext, startRun, step } from "../engine/kernel/turn.ts";
import { CREATE_CHARACTER } from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  type Activation,
  ItemSchema,
  PregenSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  freshActor,
  isStable,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  type Stats,
  attackBonus,
  checkBonus,
  deriveStats,
  saveBonus,
} from "../plugins/systems/dnd5.5e/core/stats.ts";

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

function bonusOf(stats: Stats, id: string): number {
  const action = stats.actions.find((item) => item.id === id);
  const resolution: Activation["resolution"] | undefined =
    action?.activation.resolution;
  if (resolution?.kind !== "attack") throw new Error(`No attack ${id}`);
  return attackBonus(resolution, stats);
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

  it("starts death saves afresh when a Stable creature with failures is hit", async () => {
    const run = await goblin();
    const stable = pregen(run, "srd52:pregen/fighter", {
      hp: 0,
      deathSaves: { successes: 3, failures: 2 },
    });
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

describe("armor and weapon training", () => {
  it("stops a wizard in chain mail casting, and gives Disadvantage on attacks", async () => {
    const run = await goblin();
    const wizard = pregen(run, "srd52:pregen/wizard");
    const robed = deriveStats(wizard, run);
    expect(robed.untrainedArmor).toBe(false);
    expect(robed.actions.some((item) => item.id.startsWith("spell:"))).toBe(
      true,
    );
    const armored = deriveStats(
      {
        ...wizard,
        inventory: [
          ...wizard.inventory,
          "srd52:item/chain-mail",
          "srd52:item/shield",
        ],
      },
      run,
    );
    expect(armored.untrainedArmor).toBe(true);
    expect(armored.actions.some((item) => item.id.startsWith("spell:"))).toBe(
      false,
    );
    expect(armored.passives).toContainEqual({
      kind: "modifier",
      modifier: { kind: "disadvantage", on: "attacks" },
    });
    expect(armored.ac).toBe(16); // chain mail, and no shield without training
  });

  it("adds Proficiency only to weapons the class trains with", async () => {
    const run = await goblin();
    const wizard = pregen(run, "srd52:pregen/wizard", {
      inventory: ["srd52:item/dagger", "srd52:item/longsword"],
    });
    const stats = deriveStats(wizard, run);
    // Dex 14 for the dagger and Str 8 for the longsword.
    expect(bonusOf(stats, "weapon:srd52:item/dagger")).toBe(2 + 2);
    expect(bonusOf(stats, "weapon:srd52:item/longsword")).toBe(-1);
  });

  it("counts only one shield", async () => {
    const base = await goblin();
    const run = withContent(base, [
      ItemSchema.parse({
        id: "test:item/kite-shield",
        name: "Kite Shield",
        type: "shield",
        bonus: 2,
      }),
    ]);
    const fighter = pregen(run, "srd52:pregen/fighter");
    expect(deriveStats(fighter, run).ac).toBe(18);
    const twice = {
      ...fighter,
      inventory: [...fighter.inventory, "test:item/kite-shield"],
    };
    expect(deriveStats(twice, run).ac).toBe(18);
  });

  it("slows a wearer too weak for heavy armor by 10 feet", async () => {
    const run = await goblin();
    const fighter = pregen(run, "srd52:pregen/fighter");
    const strong = deriveStats(fighter, run);
    if (fighter.source.kind !== "character" || !fighter.source.build) {
      throw new Error("No build");
    }
    const { build } = fighter.source;
    const weak = deriveStats(
      {
        ...fighter,
        source: {
          kind: "character",
          build: {
            ...build,
            baseAbilities: { ...build.baseAbilities, str: 8 },
            backgroundIncrease: { con: 2, dex: 1 },
          },
        },
      },
      run,
    );
    expect(weak.speed).toBe(strong.speed - 10);
  });
});

describe("magic item bonuses", () => {
  const weapon = ItemSchema.parse({
    id: "test:item/weapon-plus",
    name: "Weapon, +1, +2 or +3",
    type: "magicItem",
    category: "weapon",
    rarity: "varies",
    attunement: false,
    text: "A magic weapon.",
    automation: "partial",
    variants: [
      {
        rarity: "uncommon",
        bonuses: [
          { to: "attack", amount: 1 },
          { to: "damage", amount: 1 },
        ],
      },
      {
        rarity: "rare",
        bonuses: [
          { to: "attack", amount: 2 },
          { to: "damage", amount: 2 },
        ],
      },
    ],
  });
  const potions = ItemSchema.parse({
    id: "test:item/potions-of-healing",
    name: "Potions of Healing",
    type: "magicItem",
    category: "potion",
    rarity: "varies",
    attunement: false,
    text: "Red potions.",
    automation: "partial",
    variants: [
      { rarity: "common", healing: { dice: "2d4", bonus: { base: 2 } } },
      { rarity: "uncommon", healing: { dice: "4d4", bonus: { base: 4 } } },
    ],
  });

  it("adds a magic weapon's attack and damage bonus to the weapon swung", async () => {
    const run = withContent(await goblin(), [weapon]);
    const fighter = pregen(run, "srd52:pregen/fighter");
    const plain = deriveStats(fighter, run);
    const magic = deriveStats(
      { ...fighter, inventory: [...fighter.inventory, weapon.id] },
      run,
    );
    const id = "weapon:srd52:item/longsword";
    expect(bonusOf(magic, id)).toBe(bonusOf(plain, id) + 1);
    const swing = magic.actions.find((item) => item.id === id)?.activation;
    expect(
      swing?.resolution.kind === "attack" &&
        swing.resolution.damage[0]?.amount.bonus?.base,
    ).toBe(1);
  });

  it("adds a ring's saving throw bonus only while attuned", async () => {
    const run = await goblin();
    const ring = "srd52:item/ring-of-protection";
    const fighter = pregen(run, "srd52:pregen/fighter", {
      inventory: [ring],
    });
    const loose = deriveStats(fighter, run);
    const worn = deriveStats({ ...fighter, attuned: [ring] }, run);
    expect(saveBonus(worn, "wis")).toBe(saveBonus(loose, "wis") + 1);
    expect(worn.ac).toBe(loose.ac + 1);
  });

  it("heals with a potion whose numbers sit on its versions", async () => {
    const run = withContent(await goblin(), [potions]);
    const fighter = pregen(run, "srd52:pregen/fighter", {
      inventory: [potions.id],
    });
    const drink = deriveStats(fighter, run).actions.find(
      (item) => item.id === `item:${potions.id}`,
    );
    expect(drink?.activation.resolution).toMatchObject({
      kind: "automatic",
      effects: [{ kind: "heal", amount: { dice: "2d4", bonus: { base: 2 } } }],
    });
  });
});

describe("spells at character creation", () => {
  it("lists a spell with no rules last, marked story only", async () => {
    const inert = SpellSchema.parse({
      id: "test:spell/aaa-whisper",
      name: "Aaa Whisper",
      level: 0,
      school: "illusion",
      classes: ["srd52:class/wizard"],
      castingTime: "Action",
      range: "Self",
      components: "V",
      duration: "instantaneous",
      text: "A whisper.",
      automation: "text",
    });
    const run = withContent(await goblin(), [inert]);
    const plan: Readonly<Record<string, string>> = {
      [`${NS}:chooseCharacter`]: CREATE_CHARACTER,
    };
    let { state, pending } = startRun(run, "spells");
    let cantrips: Decision | undefined;
    for (let count = 0; pending && !cantrips && count < 40; count += 1) {
      const decision: Decision = pending;
      if (decision.id.includes(":cantrips-")) {
        cantrips = decision;
        break;
      }
      const optionId = decision.id.endsWith(":class")
        ? "srd52:class/wizard"
        : (plan[decision.id] ?? decision.options[0]?.id ?? "");
      const outcome = step(run, state, {
        kind: "answer",
        decisionId: decision.id,
        optionId,
      });
      if (!outcome.ok) throw new Error(`${decision.id}: ${outcome.error}`);
      ({ state, pending } = outcome);
    }
    const options = cantrips?.options ?? [];
    expect(options.at(-1)).toMatchObject({
      id: inert.id,
      label: "Aaa Whisper (story only)",
    });
    expect(options[0]?.label).not.toContain("story only");
  });
});

describe("exhaustion", () => {
  it("takes 2 per level from attacks, saves and checks, and 5 feet from speed", async () => {
    const run = await goblin();
    const fighter = pregen(run, "srd52:pregen/fighter");
    const tired = { ...fighter, exhaustion: 2 };
    const fresh = deriveStats(fighter, run);
    const worn = deriveStats(tired, run);
    const sword = "weapon:srd52:item/longsword";
    expect(bonusOf(worn, sword)).toBe(bonusOf(fresh, sword) - 4);
    expect(saveBonus(worn, "con")).toBe(saveBonus(fresh, "con") - 4);
    expect(checkBonus(worn, tired, { ability: "str" })).toBe(
      checkBonus(fresh, fighter, { ability: "str" }) - 4,
    );
    expect(worn.speed).toBe(fresh.speed - 10);
  });
});
