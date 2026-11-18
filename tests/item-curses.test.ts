import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  leafEvents,
  payCosts,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { madnessStart } from "../plugins/systems/dnd5.5e/core/combat/madness.ts";
import {
  changed,
  gearOptions,
  sceneGearActions,
} from "../plugins/systems/dnd5.5e/core/gear.ts";
import {
  type Actor,
  applyDndEvent,
  frame,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { deriveItem } from "../plugins/systems/dnd5.5e/core/variants.ts";
import {
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// Magic items and features of the test's own for #143's curses and attunement: ids and mechanics only.
const item = (name: string, extra: object) => ({
  id: `test:item/${name}`,
  name,
  type: "magicItem",
  category: "wondrousItem",
  rarity: "rare",
  attunement: true,
  text: "Test.",
  automation: "full",
  ...extra,
});
const CONTENT = [
  trait("adept", [{ kind: "attunementSlots", count: 4 }]),
  trait("device", [
    { kind: "chargeSaver" },
    { kind: "anyScroll", ability: "int" },
  ]),
  item("axe", {
    category: "weapon",
    curse: {
      bound: true,
      passives: [
        { kind: "soleWeapon", item: "test:item/axe" },
        { kind: "fury", ability: "wis", dc: 15 },
      ],
    },
  }),
  item("brittle", {
    curse: {
      passives: [
        {
          kind: "modifier",
          modifier: { kind: "vulnerability", damage: "slashing" },
        },
      ],
    },
  }),
  item("holy", { attuneBy: { classes: ["cleric"] } }),
  item("plain", {}),
  item("wand", {
    attunement: false,
    resources: [
      {
        id: "wand",
        max: { base: 3 },
        recharge: [{ on: "dawn", amount: "all" }],
      },
    ],
  }),
  item("deadly", {
    attuneSave: {
      ability: "con",
      dc: 17,
      saved: [{ amount: { dice: "2d6" }, type: "necrotic" }],
    },
  }),
  item("tome", {
    study: {
      ability: "any",
      raise: 2,
      max: 24,
      lower: { amount: 2, min: 3 },
      keep: true,
      passives: [{ kind: "noExhaustion" }],
    },
  }),
  item("magnet", {
    attunement: false,
    passives: [{ kind: "missileResistance" }],
    curse: { passives: [{ kind: "missileMagnet", within: 10 }] },
  }),
  {
    id: "test:item/scroll-fireball",
    name: "Scroll",
    type: "magicItem",
    category: "scroll",
    rarity: "uncommon",
    attunement: false,
    text: "Test.",
    automation: "full",
    spell: "srd52:spell/fireball",
  },
];

async function curseRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(CONTENT.map((entry) => [entry.id, entry]));
  const access: RunContext = {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id) ?? deriveItem(id, access),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
  return access;
}

const carrying = (
  items: readonly string[],
  extra: Partial<Actor> = {},
  traits: readonly string[] = [],
): Actor => ({
  ...hero(traits),
  hp: 30,
  inventory: ["srd52:item/longsword", ...items],
  position: { x: 0, y: 0 },
  ...extra,
});
const kinds = (events: readonly SystemEvent[]) =>
  events.map((event) => event.kind);
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const ids = (options: readonly { id: string }[]) => options.map(({ id }) => id);

describe("curses, sentient items and attunement (#143)", () => {
  it("attunes to a fourth item with Magic Item Adept, and only a Cleric to a Cleric's talisman", async () => {
    const run = await curseRun();
    const three = ["test:item/plain", "test:item/brittle", "test:item/deadly"];
    const plain = carrying([...three, "test:item/tome"], { attuned: three });
    expect(ids(gearOptions(plain, run))).not.toContain("attune:test:item/tome");
    const adept = carrying([...three, "test:item/tome"], { attuned: three }, [
      "adept",
    ]);
    expect(ids(gearOptions(adept, run))).toContain("attune:test:item/tome");
    expect(ids(gearOptions(carrying(["test:item/holy"]), run))).not.toContain(
      "attune:test:item/holy",
    );
    expect(() =>
      changed(carrying(["test:item/holy"]), "attune:test:item/holy", run),
    ).toThrow();
  });

  it("holds its bearer to a cursed axe until Remove Curse ends the Attunement", async () => {
    const run = await curseRun();
    const axe = "test:item/axe--1--longsword";
    const cursed = carrying([axe], { attuned: [axe] });
    const options = ids(gearOptions(cursed, run));
    expect(options).not.toContain(`unattune:${axe}`);
    expect(options).not.toContain(`stow:${axe}`);
    expect(() => changed(cursed, `unattune:${axe}`, run)).toThrow();
    const lifted = leafEvents(
      [{ kind: "uncurse" }],
      "srd52:spell/remove-curse",
      cursed,
      cursed,
      contextOf(run, [cursed], scripted([]).dice),
    );
    expect(payloads(lifted, "gearChanged")).toEqual([
      { actor: PLAYER_ACTOR, stowed: [], attuned: [] },
    ]);
  });

  it("keeps a curse's Vulnerability on its attuned bearer with the item stowed", async () => {
    const run = await curseRun();
    const stowed = carrying(["test:item/brittle"], {
      attuned: ["test:item/brittle"],
      stowed: ["test:item/brittle"],
    });
    expect(deriveStats(stowed, run).passives).toContainEqual({
      kind: "modifier",
      modifier: { kind: "vulnerability", damage: "slashing" },
    });
  });

  it("sends a cursed axe's bearer into a fury when damaged, and its turn goes at the nearest ally", async () => {
    const run = await curseRun();
    const axe = "test:item/axe--1--longsword";
    const foe: Actor = {
      ...hero([], { id: "foe" }),
      side: "enemy",
      hp: 30,
      position: { x: 3, y: 0 },
    };
    const ally = carrying([], { id: "ally", position: { x: 1, y: 0 } });
    const bearer = carrying([axe], { attuned: [axe] });
    const context = contextOf(run, [foe, bearer, ally], scripted([]).dice);
    const { events } = settle(
      run,
      [foe, bearer, ally],
      [
        frame("applyHit", {
          attacker: "foe",
          actionId: "weapon:srd52:item/longsword",
          target: PLAYER_ACTOR,
          critical: false,
          hadAdvantage: false,
          total: 30,
          natural: 15,
        }),
      ],
      scripted([5, 2]).dice,
      () => "",
    );
    expect(
      payloads(events, "effectAdded").some(
        ({ actor, effect }) =>
          actor === PLAYER_ACTOR &&
          (effect as { modifier: { kind: string } }).modifier.kind ===
            "furious",
      ),
    ).toBe(true);
    const furious = events.reduce(
      applyDndEvent,
      contextOf(run, [foe, bearer, ally], scripted([]).dice).state,
    );
    const raging = furious.actors[PLAYER_ACTOR];
    if (!raging) throw new Error("No bearer");
    const turn = madnessStart(raging, {
      ...context,
      state: furious,
    });
    expect(turn.frames[0]?.payload).toMatchObject({ target: "ally" });
  });

  it("keeps a wand's charge on a 6 with Use Magic Device, and reads a Fireball scroll behind an Arcana check", async () => {
    const run = await curseRun();
    const thief = carrying(
      ["test:item/wand", "test:item/scroll-fireball"],
      {},
      ["device"],
    );
    const zap: KnownAction = {
      id: "use:test:item/wand:0",
      name: "Zap",
      activation: {
        cost: [{ resource: "wand" }],
        targeting: { self: true },
        resolution: { kind: "automatic", damage: [], effects: [] },
      },
      spellLevel: null,
    };
    const kept = payCosts(
      zap,
      thief,
      contextOf(run, [thief], scripted([6]).dice),
    );
    expect(kinds(kept)).not.toContain(`${NS}:resourceSpent`);
    const spent = payCosts(
      zap,
      thief,
      contextOf(run, [thief], scripted([5]).dice),
    );
    expect(kinds(spent)).toContain(`${NS}:resourceSpent`);
    const read = deriveStats(thief, run).actions.find(
      (action) => action.id === "item:test:item/scroll-fireball",
    );
    expect(read?.castCheck).toEqual({
      ability: "int",
      skill: "arcana",
      dc: 13,
    });
  });

  it("calls for a save as a deadly item is attuned: a failure is the end, a success takes its damage", async () => {
    const run = await curseRun();
    const bearer = carrying(["test:item/deadly"], {
      attuned: ["test:item/deadly"],
    });
    const attune = frame("attuneSave", {
      actor: PLAYER_ACTOR,
      item: "test:item/deadly",
    });
    const failed = settle(run, [bearer], [attune], scripted([2]).dice);
    expect(kinds(failed.events)).toEqual(
      expect.arrayContaining(["actorDefeated", "partyDefeated"]),
    );
    const saved = settle(run, [bearer], [attune], scripted([19, 3, 4]).dice);
    expect(kinds(saved.events)).not.toContain("actorDefeated");
    expect(payloads(saved.events, "damaged")[0]).toMatchObject({ amount: 7 });
  });

  it("studies a kept book once, raising a score of the reader's choice and lowering the lowest other", async () => {
    const run = await curseRun();
    const reader = carrying(["test:item/tome"], {
      attuned: ["test:item/tome"],
    });
    const state = {
      ...contextOf(run, [reader], scripted([]).dice).state,
      combat: null,
    };
    const offers = sceneGearActions(state, run).filter((offer) =>
      offer.id.startsWith("study:"),
    );
    expect(offers.map((offer) => offer.id)).toContain(
      "study:test:item/tome:wis",
    );
    const studied = run.system.storyEffects[`${NS}:study`]?.apply(
      { item: "test:item/tome", ability: "wis" },
      {
        state,
        dice: scripted([]).dice,
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    expect(payloads(studied?.events ?? [], "abilityRaised")).toEqual([
      {
        actor: PLAYER_ACTOR,
        ability: "wis",
        amount: 2,
        item: "test:item/tome",
      },
      {
        actor: PLAYER_ACTOR,
        ability: "int",
        amount: -2,
        item: "test:item/tome",
      },
    ]);
    expect(kinds(studied?.events ?? [])).not.toContain(`${NS}:itemUsed`);
    const after = (studied?.events ?? []).reduce(applyDndEvent, state);
    expect(
      sceneGearActions(after, run).some((offer) =>
        offer.id.startsWith("study:"),
      ),
    ).toBe(false);
    expect(
      deriveStats(after.actors[PLAYER_ACTOR] ?? reader, run).passives,
    ).toContainEqual({ kind: "noExhaustion" });
  });

  it("pulls an arrow aimed beside a Shield of Missile Attraction's bearer onto it", async () => {
    const run = await curseRun();
    const archer: Actor = {
      ...hero([], { id: "archer" }),
      side: "enemy",
      hp: 30,
      inventory: ["srd52:item/shortbow"],
      position: { x: 8, y: 0 },
    };
    const ally = carrying([], { id: "ally", position: { x: 1, y: 0 } });
    const bearer = carrying(["test:item/magnet"], {
      attuned: ["test:item/magnet"],
    });
    const { events } = settle(
      run,
      [archer, bearer, ally],
      [
        frame("attackRoll", {
          attacker: "archer",
          actionId: "weapon:srd52:item/shortbow",
          target: "ally",
        }),
      ],
      scripted([15, 4]).dice,
      () => "",
    );
    expect(payloads(events, "damaged")[0]?.actor).toBe(PLAYER_ACTOR);
  });
});
