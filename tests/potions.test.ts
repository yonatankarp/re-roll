import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import type { RunContext } from "../engine/run/turn.ts";
import { describe, expect, it } from "vitest";
import {
  payCosts,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { itemUseId } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { sceneGearActions } from "../plugins/systems/dnd5.5e/core/gear.ts";
import {
  type Actor,
  type ActiveEffect,
  applyDndEvent,
  frame,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  grantedKey,
  type KnownAction,
  UNARMED_STRIKE,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { deriveItem } from "../plugins/systems/dnd5.5e/core/variants.ts";
import { contextOf, hero, scripted, settle, testRun } from "./feat-fixtures.ts";

// Magic items of the test's own for #142's single-use items and #180's riders: ids and mechanics only.
const item = (name: string, extra: object) => ({
  id: `test:item/${name}`,
  name,
  type: "magicItem",
  category: "potion",
  rarity: "rare",
  attunement: false,
  text: "Test.",
  automation: "full",
  ...extra,
});
const self = (effects: object[]) => ({
  cost: ["bonusAction"],
  targeting: { self: true },
  resolution: { kind: "automatic", effects },
});
const minute = { minutes: 1 };
const ITEMS = [
  item("speed", {
    activation: self([
      {
        kind: "modifier",
        modifier: { kind: "hasted", noLethargy: true },
        duration: minute,
      },
    ]),
  }),
  item("fire-breath", {
    activation: self([
      {
        kind: "modifier",
        modifier: { kind: "grantedAction", damage: "fire", uses: 3 },
        duration: { minutes: 60 },
      },
    ]),
    granted: {
      cost: ["bonusAction"],
      targeting: { creatures: 1, range: 30, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: { base: 13 },
        damage: [{ amount: { dice: "4d6" }, type: "fire" }],
        onSuccessDamage: "half",
      },
    },
  }),
  item("giant", {
    variants: [
      {
        rarity: "uncommon",
        name: "Giant (hill)",
        activation: self([
          {
            kind: "modifier",
            modifier: { kind: "setScore", ability: "str", score: 21 },
            duration: { minutes: 60 },
          },
        ]),
      },
    ],
  }),
  item("oil", {
    verb: "Apply",
    activation: self([{ kind: "note", text: "Test." }]),
  }),
  item("wraps", {
    category: "wondrousItem",
    bonuses: [
      { to: "attack", amount: 2, weapons: ["unarmed-strike"] },
      { to: "damage", amount: 2, weapons: ["unarmed-strike"] },
    ],
  }),
  item("arrow", {
    category: "weapon",
    ammunition: true,
    variants: [
      {
        rarity: "rare",
        bonuses: [
          { to: "attack", amount: 2 },
          { to: "damage", amount: 2 },
        ],
      },
    ],
  }),
  item("scroll", { category: "scroll", boundSpell: { as: "scroll" } }),
  item("staff", {
    category: "staff",
    boundSpell: { as: "charges", maxLevel: 8 },
    resources: [{ id: "staff", max: { base: 6 }, recharge: [] }],
  }),
  item("mail", {
    category: "armor",
    boundSpell: { as: "charges", schools: ["abjuration", "illusion"] },
    resources: [{ id: "mail", max: { base: 6 }, recharge: [] }],
  }),
  item("tattoo", {
    category: "wondrousItem",
    boundSpell: { as: "tattoo", minLevel: 1, maxLevel: 3 },
  }),
  item("hat", {
    category: "wondrousItem",
    resources: [
      {
        id: "hat",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    unknownSpell: {
      class: "wizard",
      cantrips: true,
      action: true,
      dc: 10,
      resource: "hat",
    },
  }),
  item("many", {
    category: "wondrousItem",
    resources: [
      {
        id: "many",
        max: { base: 1 },
        recharge: [{ on: "shortRest", amount: "all" }],
      },
    ],
    unknownSpell: {
      class: "wizard",
      dc: 10,
      perLevel: true,
      resource: "many",
      keepOnFailure: true,
    },
  }),
  item("jar", {
    category: "wondrousItem",
    resources: [{ id: "jar", max: { base: 1 }, rolled: "1d4", recharge: [] }],
    activations: [
      {
        name: "Dose",
        activation: {
          cost: ["action", { resource: "jar" }],
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            effects: [
              { kind: "heal", amount: { dice: "2d8", bonus: { base: 2 } } },
            ],
          },
        },
      },
    ],
  }),
  item("ring", {
    category: "ring",
    storesSpells: { levels: 5, maxLevel: 5 },
  }),
];

async function itemRun() {
  const run = await testRun();
  const byId = new Map(ITEMS.map((entry) => [entry.id, entry]));
  const access: RunContext = {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id) ?? deriveItem(id, access),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
  return access;
}
type Run = Awaited<ReturnType<typeof itemRun>>;

const carrying = (items: readonly string[], extra: Partial<Actor> = {}) => ({
  ...hero([]),
  hp: 30,
  inventory: ["srd52:item/longsword", ...items],
  ...extra,
});
// A wizard of `level` carrying these items, who knows these spells.
const wizard = (
  items: readonly string[],
  level = 1,
  spells: readonly string[] = [],
): Actor => {
  const base = carrying(items, {
    ...hero([], {
      level,
      answers:
        spells.length > 0 ? [{ kind: "spells", values: [...spells] }] : [],
    }),
  });
  if (base.source.kind !== "character" || !base.source.build) return base;
  const { build } = base.source;
  return {
    ...base,
    hp: 30,
    inventory: ["srd52:item/longsword", ...items],
    source: {
      kind: "character",
      build: {
        ...build,
        levels: build.levels.map((entry) => ({
          ...entry,
          classId: "srd52:class/wizard",
        })),
      },
    },
  };
};
const saveDc = (action: KnownAction | undefined): number | undefined => {
  const resolution = action?.activation.resolution;
  return resolution?.kind === "save" ? resolution.dc.base : undefined;
};
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const actionOf = (run: Run, actor: Actor, id: string): KnownAction => {
  const found = deriveStats(actor, run).actions.find(
    (action) => action.id === id,
  );
  if (!found) throw new Error(`No ${id}`);
  return found;
};
// The actor once these events have happened to it.
const after = (actor: Actor, events: readonly SystemEvent[]): Actor => {
  let state = contextOf({} as never, [actor], scripted([]).dice).state;
  for (const event of events) state = applyDndEvent(state, event);
  return state.actors[actor.id] ?? actor;
};

describe("single-use magic items (#142)", () => {
  it("drinks a potion's own activation, named by its verb, and uses it up", async () => {
    const run = await itemRun();
    const actor = carrying(["test:item/speed", "test:item/oil"]);
    const drink = actionOf(run, actor, "item:test:item/speed");
    expect(drink.name).toBe("Drink speed");
    expect(actionOf(run, actor, "item:test:item/oil").name).toBe("Apply oil");
    const { events = [] } = resolveAction(
      drink,
      actor,
      [actor],
      contextOf(run, [actor], scripted([]).dice),
    );
    // Haste without its lethargy, as a Potion of Speed.
    const added = payloads(events, "effectAdded").map(
      (item) => (item.effect as ActiveEffect).modifier.kind,
    );
    expect(added).toEqual(["hasted"]);
  });

  it("gives an item's own action for a grant, as a Potion of Fire Breath's three exhales", async () => {
    const run = await itemRun();
    const actor = carrying(["test:item/fire-breath"]);
    const { events = [] } = resolveAction(
      actionOf(run, actor, "item:test:item/fire-breath"),
      actor,
      [actor],
      contextOf(run, [actor], scripted([]).dice),
    );
    const source = "item:test:item/fire-breath";
    expect(payloads(events, "resourceRestored")).toContainEqual({
      actor: PLAYER_ACTOR,
      resource: grantedKey(source),
    });
    const breathing = after(actor, events);
    const stats = deriveStats(breathing, run);
    const breath = actionOf(run, breathing, `granted:${source}`);
    expect(breath.name).toBe("fire-breath");
    expect(breath.activation.cost).toContainEqual({
      resource: grantedKey(source),
    });
    expect(stats.resources[grantedKey(source)]).toBe(3);
  });

  it("sets an ability score while a drink lasts, as a Potion of Giant Strength", async () => {
    const run = await itemRun();
    const actor = carrying(["test:item/giant--1"]);
    const drink = actionOf(run, actor, "item:test:item/giant--1");
    expect(drink.name).toBe("Drink Giant (hill)");
    const { events = [] } = resolveAction(
      drink,
      actor,
      [actor],
      contextOf(run, [actor], scripted([]).dice),
    );
    expect(deriveStats(actor, run).abilities.str).toBe(17);
    expect(deriveStats(after(actor, events), run).abilities.str).toBe(21);
  });
});

describe("magic item riders (#180)", () => {
  it("gives every character an Unarmed Strike, and Wraps of Unarmed Power add to it", async () => {
    const run = await itemRun();
    const strike = actionOf(run, carrying([]), UNARMED_STRIKE);
    const { resolution } = strike.activation;
    if (resolution.kind !== "attack") throw new Error("Not an attack");
    expect(resolution.attack).toEqual(
      expect.objectContaining({ ability: "str", unarmed: true }),
    );
    expect(resolution.damage[0]?.amount.bonus?.base).toBe(1);
    const wrapped = actionOf(run, carrying(["test:item/wraps"]), UNARMED_STRIKE)
      .activation.resolution;
    if (wrapped.kind !== "attack") throw new Error("Not an attack");
    expect(wrapped.attack.itemBonus).toBe(2);
    expect(wrapped.damage[0]?.amount.bonus?.base).toBe(3);
    // The wraps' bonus goes to no weapon.
    const sword = actionOf(
      run,
      carrying(["test:item/wraps"]),
      "weapon:srd52:item/longsword",
    ).activation.resolution;
    if (sword.kind !== "attack") throw new Error("Not an attack");
    expect(sword.attack.itemBonus).toBeUndefined();
  });

  it("fires magic ammunition with its bonus, and a hit spends one piece", async () => {
    const run = await itemRun();
    const archer = {
      ...carrying([
        "srd52:item/shortbow",
        "test:item/arrow--1",
        "test:item/arrow--1",
      ]),
      position: { x: 0, y: 0 },
    };
    const shot = actionOf(run, archer, "weapon:srd52:item/shortbow");
    expect(shot.ammunition).toBe("test:item/arrow--1");
    const { resolution } = shot.activation;
    if (resolution.kind !== "attack") throw new Error("Not an attack");
    expect(resolution.attack.itemBonus).toBe(2);
    // The ammunition's bonus goes to no other weapon.
    const sword = actionOf(run, archer, "weapon:srd52:item/longsword")
      .activation.resolution;
    if (sword.kind !== "attack") throw new Error("Not an attack");
    expect(sword.attack.itemBonus).toBeUndefined();
    const foe = {
      ...hero([], { id: "foe" }),
      side: "enemy" as const,
      hp: 40,
      position: { x: 3, y: 0 },
    };
    const { events, state } = settle(
      run,
      [archer, foe],
      [
        frame("attackRoll", {
          attacker: PLAYER_ACTOR,
          actionId: shot.id,
          target: "foe",
        }),
      ],
      scripted([18]).dice,
      () => "",
    );
    expect(payloads(events, "itemUsed")).toEqual([
      { actor: PLAYER_ACTOR, item: "test:item/arrow--1" },
    ]);
    expect(
      state.actors[PLAYER_ACTOR]?.inventory.filter(
        (id) => id === "test:item/arrow--1",
      ),
    ).toHaveLength(1);
  });
});

describe("spells bound into items (#142, #199)", () => {
  it("reads a Spell Scroll named by its spell, with the scroll's numbers, on the reader's own list", async () => {
    const run = await itemRun();
    const missile = "test:item/scroll--magic-missile";
    const fire = "test:item/scroll--fireball";
    const reader = wizard([missile, fire]);
    const read = actionOf(run, reader, `item:${missile}`);
    expect(read.name).toBe("Read scroll (Magic Missile)");
    expect(read.castCheck).toBeUndefined();
    // Above the reader's slots, a check of DC 10 + the spell's level comes first, and the scroll's DC is 15.
    const high = actionOf(run, reader, `item:${fire}`);
    expect(high.castCheck).toEqual({ ability: "int", dc: 13 });
    expect(saveDc(high)).toBe(15);
    // A fighter has no spell list to read it from.
    expect(
      deriveStats(carrying([missile]), run).actions.some(
        (action) => action.id === `item:${missile}`,
      ),
    ).toBe(false);
    // A spell nobody has heard of names no item.
    expect(run.content("test:item/scroll--no-such-spell")).toBeUndefined();
  });

  it("wastes a scroll whose check fails, and casts it on a success", async () => {
    const run = await itemRun();
    const fire = "test:item/scroll--fireball";
    const reader = { ...wizard([fire]), position: { x: 0, y: 0 } };
    const foe = {
      ...hero([], { id: "foe" }),
      side: "enemy" as const,
      hp: 40,
      position: { x: 4, y: 0 },
    };
    const cast = (natural: number) =>
      settle(
        run,
        [reader, foe],
        [
          frame("castCheck", {
            actor: PLAYER_ACTOR,
            actionId: `item:${fire}`,
            target: "foe",
          }),
        ],
        scripted([natural, 1, 1, 1, 1, 1, 1, 1, 1, 1]).dice,
        () => "",
      );
    const failed = cast(2);
    expect(payloads(failed.events, "itemUsed")).toEqual([
      { actor: PLAYER_ACTOR, item: fire },
    ]);
    expect(payloads(failed.events, "damaged")).toEqual([]);
    const passed = cast(19);
    expect(
      payloads(passed.events, "damaged").map((item) => item.actor),
    ).toContain("foe");
  });

  it("casts an Enspelled item's spell with its charges and the DC its level gives", async () => {
    const run = await itemRun();
    const staff = "test:item/staff--fireball";
    const cast = actionOf(
      run,
      carrying([staff]),
      `spell:srd52:spell/fireball:item:${staff}:1`,
    );
    expect(cast.name).toBe("Fireball (staff (Fireball))");
    expect(saveDc(cast)).toBe(15);
    expect(cast.activation.cost).toContainEqual({ resource: "staff" });
    // Armor made from a plain one holds only the schools it allows.
    const mail = "test:item/mail--1--chain-mail--shield";
    expect(run.content(mail)).toEqual(
      expect.objectContaining({
        type: "armor",
        name: "mail (Chain Mail) (Shield)",
      }),
    );
    expect(
      run.content("test:item/mail--1--chain-mail--fireball"),
    ).toBeUndefined();
  });

  it("keeps a Thayan Spell Tattoo's spell prepared, and casts it once for free with DC 13 for a non-caster", async () => {
    const run = await itemRun();
    const tattoo = "test:item/tattoo--hold-person";
    const free = actionOf(run, carrying([tattoo]), `item:${tattoo}`);
    expect(free.activation.cost).not.toContain("slot");
    expect(saveDc(free)).toBe(13);
    const known = deriveStats(wizard([tattoo], 3), run).actions.map(
      (action) => action.id,
    );
    expect(known).toContain("spell:srd52:spell/hold-person");
    expect(run.content("test:item/tattoo--fireball")).toEqual(
      expect.objectContaining({ name: "tattoo (Fireball)" }),
    );
    expect(run.content("test:item/tattoo--wish")).toBeUndefined();
  });
});

describe("spells an item casts unknown (#199)", () => {
  it("tries a cantrip off a class's list behind an Arcana check, as a Hat of Wizardry", async () => {
    const run = await itemRun();
    const hat = "test:item/hat";
    const actions = deriveStats(wizard([hat]), run).actions;
    const bolt = actions.find(
      (action) => action.id === `spell:srd52:spell/fire-bolt:item:${hat}:0`,
    );
    expect(bolt?.castCheck).toEqual({
      ability: "int",
      skill: "arcana",
      dc: 10,
    });
    expect(bolt?.activation.cost).toContainEqual({ resource: "hat" });
    // Only cantrips, and none for a fighter, who has no spellcasting.
    expect(
      actions.some((action) =>
        action.id.startsWith("spell:srd52:spell/magic-missile:item"),
      ),
    ).toBe(false);
    expect(
      deriveStats(carrying([hat]), run).actions.some((action) =>
        action.id.endsWith(`:item:${hat}:0`),
      ),
    ).toBe(false);
  });

  it("tries a leveled spell its slots reach for DC 10 + its level, keeping the use on a failure, as a Hat of Many Spells", async () => {
    const run = await itemRun();
    const many = "test:item/many";
    const ids = deriveStats(wizard([many], 3), run).actions;
    const missile = ids.find(
      (action) =>
        action.id === `spell:srd52:spell/magic-missile:item:${many}:0`,
    );
    expect(missile?.castCheck).toEqual({
      ability: "int",
      skill: "arcana",
      dc: 11,
      keep: "many",
    });
    expect(missile?.activation.cost).toContain("slot");
    expect(
      ids.some(
        (action) => action.id === `spell:srd52:spell/fireball:item:${many}:0`,
      ),
    ).toBe(false);
    const foe = {
      ...hero([], { id: "foe" }),
      side: "enemy" as const,
      hp: 40,
      position: { x: 4, y: 0 },
    };
    const caster = { ...wizard([many], 3), position: { x: 0, y: 0 } };
    const { events } = settle(
      run,
      [caster, foe],
      [
        frame("castCheck", {
          actor: PLAYER_ACTOR,
          actionId: `spell:srd52:spell/magic-missile:item:${many}:0`,
          target: ["foe", "foe", "foe"],
        }),
      ],
      scripted([2]).dice,
      () => "",
    );
    const spent = payloads(events, "resourceSpent").map(
      (item) => item.resource,
    );
    expect(spent).toContain("slot:1");
    expect(spent).not.toContain("many");
  });
});

describe("rolled pools and stored spells (#142, #199)", () => {
  it("rolls a pool's size once, as it's first spent, as Keoghtom's Ointment's doses", async () => {
    const run = await itemRun();
    const actor = carrying(["test:item/jar"], { hp: 5 });
    expect(deriveStats(actor, run).resources.jar).toBe(2);
    const dose = actionOf(run, actor, itemUseId("test:item/jar", 0));
    const events = payCosts(
      dose,
      actor,
      contextOf(run, [actor], scripted([3]).dice),
    );
    expect(payloads(events, "poolRolled")).toEqual([
      { actor: PLAYER_ACTOR, resource: "jar", amount: 3 },
    ]);
    const rolled = after(actor, events);
    expect(deriveStats(rolled, run).resources.jar).toBe(4);
    // Rolled once only.
    expect(
      payloads(
        payCosts(dose, rolled, contextOf(run, [rolled], scripted([1]).dice)),
        "poolRolled",
      ),
    ).toEqual([]);
  });

  it("stores a caster's spell in a ring between fights, cast later with the caster's numbers", async () => {
    const run = await itemRun();
    const ring = "test:item/ring";
    const caster = wizard([ring], 3, ["srd52:spell/magic-missile"]);
    const state = contextOf(run, [caster], scripted([]).dice).state;
    const options = sceneGearActions({ ...state, combat: null }, run).filter(
      (option) => option.effect === `${NS}:storeSpell`,
    );
    const store = options.find((option) =>
      option.id.includes("srd52:spell/magic-missile"),
    );
    expect(store?.args).toEqual(
      expect.objectContaining({ slot: 1, item: ring, holder: PLAYER_ACTOR }),
    );
    if (!store) throw new Error("No store");
    const effect = run.system.storyEffects[`${NS}:storeSpell`];
    const { events = [] } =
      effect?.apply(store.args, {
        state: { ...state, combat: null },
        dice: scripted([]).dice,
        content: run.content,
        contentIds: run.contentIds,
      }) ?? {};
    expect(payloads(events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "slot:1" },
    ]);
    const holding = after(caster, events);
    const cast = actionOf(
      run,
      holding,
      `spell:srd52:spell/magic-missile:item:${ring}:0`,
    );
    expect(cast.activation.cost).not.toContain("slot");
    expect(cast.stored).toBe(ring);
    const spent = payCosts(
      cast,
      holding,
      contextOf(run, [holding], scripted([]).dice),
    );
    expect(payloads(spent, "storedSpellUsed")).toEqual([
      { actor: PLAYER_ACTOR, item: ring, spell: "srd52:spell/magic-missile" },
    ]);
    expect(
      deriveStats(after(holding, spent), run).actions.some(
        (action) => action.id === cast.id,
      ),
    ).toBe(false);
  });
});
