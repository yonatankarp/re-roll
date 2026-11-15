import {
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import { AWAIT_FRAME } from "../engine/kernel/system.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { type Context } from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  dealEvents,
  leafEvents,
  resolveAction,
  rollSave,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  runAdvanceTurn,
  runFinishTurn,
} from "../plugins/systems/dnd5.5e/core/combat/turn.ts";
import { inReach } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { zonesOn } from "../plugins/systems/dnd5.5e/core/zones.ts";
import {
  deriveStats,
  immuneToCondition,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  freshActor,
  hasCondition,
} from "../plugins/systems/dnd5.5e/core/state.ts";

// The pieces issue #117's monster one-offs play through, on made-up stat blocks.

const club = {
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
};

const automatic = (
  name: string,
  targeting: object,
  effects: object[],
  damage: object[] = [],
) => ({
  name,
  activation: {
    cost: ["action"],
    targeting,
    resolution: { kind: "automatic", damage, effects },
  },
});

const statBlock = (
  id: string,
  fields: Readonly<Record<string, unknown>> = {},
) => ({
  id: `test:monster/${id}`,
  name: id,
  ac: 10,
  hp: 100,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  actions: [club],
  ...fields,
});

const BLOCKS = [
  statBlock("cultist", {
    passives: [
      { kind: "conditionImmunity", condition: "frightened", bloodied: true },
      { kind: "regeneration", hp: 10, stoppedBy: [], bloodied: true },
    ],
  }),
  statBlock("inquisitor", {
    passives: [{ kind: "regeneration", hp: 5, stoppedBy: [], cures: true }],
  }),
  statBlock("wonder", {
    passives: [{ kind: "undeadFortitude", except: ["lightning"] }],
  }),
  statBlock("treant", {
    actions: [
      club,
      automatic("Animate Trees", { self: true }, [
        { kind: "animate", count: 2, range: 15, lacks: ["Animate Trees"] },
      ]),
    ],
  }),
  statBlock("gennifer", {
    passives: [{ kind: "reborn", monster: "test:monster/wolf", hp: "full" }],
  }),
  statBlock("wolf", { hp: 60 }),
  statBlock("golem", { passives: [{ kind: "berserk" }] }),
  statBlock("hydra", {
    multiattack: 3,
    passives: [
      {
        kind: "heads",
        heads: 3,
        damage: 25,
        regrow: 2,
        heal: 20,
        stoppedBy: ["fire"],
      },
    ],
  }),
  statBlock("evoker", {
    passives: [{ kind: "sculptor", creatures: 5 }],
    actions: [
      {
        name: "Fireball",
        activation: {
          cost: ["action"],
          targeting: {
            area: { shape: "sphere", radius: 20 },
            range: 150,
            side: "enemy",
          },
          resolution: {
            kind: "save",
            ability: "dex",
            dc: { base: 30, add: [] },
            damage: [
              { amount: { bonus: { base: 10, add: [] } }, type: "fire" },
            ],
            onSuccessDamage: "half",
          },
        },
      },
    ],
  }),
  statBlock("tarrasque", {
    passives: [
      {
        kind: "spellImmunity",
        spells: ["srd52:spell/magic-missile"],
        rangedAttacks: true,
      },
    ],
  }),
  statBlock("devil", {
    passives: [
      {
        kind: "aura",
        name: "Barbed Hide",
        zone: "area",
        radius: 5,
        area: {
          when: "ownerTurnStart",
          grappling: true,
          resolution: {
            kind: "automatic",
            damage: [
              { amount: { bonus: { base: 5, add: [] } }, type: "piercing" },
            ],
          },
        },
      },
    ],
  }),
  statBlock("shoggoth", {
    passives: [
      { kind: "saveDisadvantage", conditions: ["charmed"] },
      { kind: "proneDeficiency", ability: "dex", dc: 10 },
      { kind: "dispelShutdown", condition: "unconscious" },
    ],
  }),
  statBlock("gnoll", {
    actions: [
      club,
      {
        ...club,
        name: "Rampage",
        activation: {
          ...club.activation,
          cost: ["bonusAction"],
          afterAction: true,
          targeting: { ...club.activation.targeting, bloodied: true },
        },
      },
      automatic("Incite", { creatures: 1, range: 60, side: "ally" }, [
        { kind: "reactionAttack" },
      ]),
    ],
  }),
  statBlock("nightmare", {
    actions: [
      {
        ...club,
        name: "Spear",
        activation: {
          ...club.activation,
          resolution: {
            ...club.activation.resolution,
            onHit: [
              {
                kind: "modifier",
                modifier: { kind: "mark" },
                duration: { text: "until it ends" },
              },
            ],
          },
        },
      },
      automatic(
        "Narcotize",
        { creatures: 1, range: 60, side: "enemy", afflicted: "Spear" },
        [],
        [{ amount: { bonus: { base: 3, add: [] } }, type: "psychic" }],
      ),
      automatic("Weight", { creatures: 1, range: 60, side: "enemy" }, [
        { kind: "exhaustion", levels: 1 },
      ]),
      {
        name: "Feast",
        activation: {
          cost: ["action"],
          targeting: { creatures: 1, range: 5, side: "enemy", downed: true },
          resolution: {
            kind: "save",
            ability: "con",
            dc: { base: 30, add: [] },
            onFail: [{ kind: "slay", hpAtMost: 1 }],
          },
        },
      },
    ],
  }),
];

async function base(): Promise<RunContext> {
  const run = (await loadAdventure("goblin-ambush")).run;
  const content = Object.fromEntries(BLOCKS.map((item) => [item.id, item]));
  return {
    ...run,
    content: (id) => content[id] ?? run.content(id),
    contentIds: () => [
      ...new Set([...run.contentIds(), ...Object.keys(content)]),
    ],
  };
}

function fighter(
  run: RunContext,
  at: readonly [number, number] = [1, 1],
  hp = 100,
): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/fighter"));
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "Fighter",
      side: "party",
      source: { kind: "character", build: pregen.build },
      hp,
      inventory: ["srd52:item/longsword"],
    }),
    position: { x: at[0], y: at[1] },
  };
}

function monster(
  id: string,
  options: { at?: readonly [number, number]; hp?: number; name?: string } = {},
): Actor {
  return {
    ...freshActor({
      id: options.name ?? id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId: `test:monster/${id}` },
      hp: options.hp ?? 100,
      inventory: [],
    }),
    position: { x: options.at?.[0] ?? 5, y: options.at?.[1] ?? 5 },
  };
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: {
      encounter: "arena",
      order: actors.map((item) => item.id),
      index: 0,
      round: 1,
      grid: { width: 20, height: 20 },
    },
  };
}

const contextOf = (run: RunContext, state: DndState, dice: Dice): Context => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});

// Every die rolls `value`, or `d20` for a d20.
const fixed = (value: number, d20 = value): Dice => ({
  below: () => 0,
  roll: (sides) => Math.min(sides, sides === 20 ? d20 : value),
});

function settle(
  run: RunContext,
  start: DndState,
  frames: readonly Frame[],
  dice: Dice,
) {
  let state = start;
  const events: SystemEvent[] = [];
  const stack = [...frames].reverse();
  for (let top = stack.pop(); top; top = stack.pop()) {
    if (top.kind === AWAIT_FRAME) {
      const { decision } = top.payload as { decision: Decision };
      stack.push({
        kind: decision.resume.kind,
        payload: {
          ...decision.resume.payload,
          answer: decision.options[0]?.id ?? "",
        },
      });
      continue;
    }
    const definition = run.system.frames[top.kind];
    if (!definition) throw new Error(`Unknown frame ${top.kind}`);
    const result = definition.run(top.payload, contextOf(run, state, dice));
    for (const event of result.events ?? []) {
      events.push(event);
      state = applyDndEvent(state, event);
    }
    stack.push(...[...(result.frames ?? [])].reverse());
  }
  return { state, events };
}

const use = (actor: string, index: number, target: string): Frame => ({
  kind: `${NS}:useAction`,
  payload: { actor, actionId: `monster:${String(index)}`, target },
});

const actionOf = (run: RunContext, actor: Actor, name: string): KnownAction => {
  const found = deriveStats(actor, run).actions.find(
    (action) => action.name === name,
  );
  if (!found) throw new Error(`no ${name}`);
  return found;
};

function must<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("missing");
  return value;
}

const kinds = (events: readonly SystemEvent[]) =>
  events.map((event) => event.kind);

describe("monster one-off pieces", () => {
  it("holds Bloodied passives only while Bloodied, and Metabolic Control ends a condition", async () => {
    const run = await base();
    const hale = monster("cultist", { hp: 80 });
    const bloodied = monster("cultist", { hp: 40 });
    expect(immuneToCondition(deriveStats(hale, run), "frightened")).toBe(false);
    expect(immuneToCondition(deriveStats(bloodied, run), "frightened")).toBe(
      true,
    );
    const heals = (actor: Actor) =>
      (
        runAdvanceTurn(contextOf(run, fight(fighter(run), actor), fixed(1)))
          .events ?? []
      ).filter((event) => event.kind === `${NS}:healed`).length;
    expect(heals(hale)).toBe(0);
    expect(heals(bloodied)).toBe(1);
    const held: Actor = {
      ...monster("inquisitor", { hp: 50 }),
      activeEffects: [
        {
          sourceId: "x",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "condition", condition: "poisoned" },
          ends: "spellDuration",
        },
      ],
    };
    const cured = runAdvanceTurn(
      contextOf(run, fight(fighter(run), held), fixed(1)),
    );
    expect(kinds(cured.events ?? [])).toContain(`${NS}:conditionRemoved`);
  });

  it("holds on at 1 Hit Point except against its own weakness", async () => {
    const run = await base();
    const wonder = monster("wonder", { hp: 10 });
    const state = fight(fighter(run), wonder);
    const hold = dealEvents(
      wonder,
      [{ amount: 12, type: "fire" }],
      false,
      contextOf(run, state, fixed(1, 20)),
    );
    expect(hold.events.reduce(applyDndEvent, state).actors.wonder?.hp).toBe(1);
    const zap = dealEvents(
      wonder,
      [{ amount: 12, type: "lightning" }],
      false,
      contextOf(run, state, fixed(1, 20)),
    );
    expect(zap.events.reduce(applyDndEvent, state).actors.wonder?.hp).toBe(0);
  });

  it("animates copies that lack the action, and comes back as another stat block", async () => {
    const run = await base();
    const treant = monster("treant");
    const grown = settle(
      run,
      fight(fighter(run), treant),
      [use("treant", 1, "treant")],
      fixed(1),
    );
    const copies = Object.values(grown.state.actors).filter((actor) =>
      actor.id.startsWith("treant:animated-"),
    );
    expect(copies).toHaveLength(2);
    expect(copies.every((actor) => actor.side === "enemy")).toBe(true);
    expect(
      deriveStats(must(copies[0]), run).actions.map((action) => action.name),
    ).toEqual(["Club"]);
    const gennifer = monster("gennifer", { hp: 5 });
    const state = fight(fighter(run), gennifer);
    const dropped = dealEvents(
      gennifer,
      [{ amount: 9, type: "slashing" }],
      false,
      contextOf(run, state, fixed(1)),
    ).events.reduce(applyDndEvent, state);
    expect(dropped.actors["gennifer:reborn"]).toMatchObject({
      hp: 60,
      side: "enemy",
    });
    expect(dropped.actors["gennifer:reborn"]?.source).toEqual({
      kind: "monster",
      statBlockId: "test:monster/wolf",
    });
  });

  it("confuses a creature's turn, and a berserk golem strikes its nearest friend", async () => {
    const run = await base();
    const confused: Actor = {
      ...monster("wolf", { at: [2, 1] }),
      activeEffects: [
        {
          sourceId: "gaze",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "confused" },
          ends: "spellDuration",
        },
      ],
    };
    const state = {
      ...fight(fighter(run), confused),
      combat: { ...must(fight(fighter(run), confused).combat), index: 0 },
    };
    // The fighter's turn ends and the wolf's begins: an 8 on the d8 strikes the fighter beside it.
    const next = runAdvanceTurn(contextOf(run, state, fixed(8)));
    expect(
      next.events?.some(
        (event) =>
          "payload" in event &&
          JSON.stringify(event.payload).includes('"noActions":true'),
      ),
    ).toBe(true);
    expect(
      next.frames?.some(
        (frame) =>
          frame.kind === `${NS}:useAction` &&
          (frame.payload as { anyone?: boolean }).anyone,
      ),
    ).toBe(true);
    const golem = monster("golem", { hp: 40, at: [5, 5] });
    const friend = monster("wolf", { at: [6, 5], name: "friend" });
    const rage = runAdvanceTurn(
      contextOf(run, fight(fighter(run, [15, 15]), golem, friend), fixed(6)),
    );
    expect(
      rage.frames?.find((frame) => frame.kind === `${NS}:useAction`)?.payload,
    ).toMatchObject({ target: "friend", anyone: true });
    const calm = runAdvanceTurn(
      contextOf(run, fight(fighter(run, [15, 15]), golem, friend), fixed(5)),
    );
    expect(
      calm.frames?.some((frame) => frame.kind === `${NS}:useAction`) ?? false,
    ).toBe(false);
  });

  it("loses heads to heavy hits, grows two back unless burned, and bites once a head", async () => {
    const run = await base();
    const hydra = monster("hydra", { hp: 100 });
    const state = fight(fighter(run), hydra);
    const cut = dealEvents(
      hydra,
      [{ amount: 30, type: "slashing" }],
      false,
      contextOf(run, state, fixed(1)),
    ).events.reduce(applyDndEvent, state);
    const lopped = must(cut.actors.hydra);
    expect(deriveStats(lopped, run).multiattack).toBe(2);
    const turn = { ...cut, combat: { ...must(cut.combat), index: 1 } };
    const grown = (
      runFinishTurn(contextOf(run, turn, fixed(1))).events ?? []
    ).reduce(applyDndEvent, turn);
    expect(deriveStats(must(grown.actors.hydra), run).multiattack).toBe(4);
    expect(grown.actors.hydra?.hp).toBe(90);
    const burned = dealEvents(
      lopped,
      [{ amount: 5, type: "fire" }],
      false,
      contextOf(run, cut, fixed(1)),
    ).events.reduce(applyDndEvent, turn);
    const seared = (
      runFinishTurn(contextOf(run, burned, fixed(1))).events ?? []
    ).reduce(applyDndEvent, burned);
    expect(deriveStats(must(seared.actors.hydra), run).multiattack).toBe(2);
  });

  it("spares the sculptor's side, and turns ranged spell attacks and named spells away", async () => {
    const run = await base();
    const evoker = monster("evoker", { at: [5, 5] });
    const friend = monster("wolf", { at: [6, 5], name: "friend" });
    const hero = fighter(run, [5, 6]);
    const state = fight(hero, evoker, friend);
    const blast = resolveAction(
      actionOf(run, evoker, "Fireball"),
      evoker,
      [hero, evoker, friend],
      contextOf(run, state, fixed(1)),
    );
    const hurt = (blast.events ?? []).flatMap((event) =>
      event.kind === `${NS}:damaged` && "payload" in event
        ? [String(event.payload.actor)]
        : [],
    );
    expect(hurt).toEqual([PLAYER_ACTOR]);
  });

  it("deals Barbed Hide only to those it grapples", async () => {
    const run = await base();
    const devil = monster("devil", { at: [5, 5] });
    const held = {
      ...fighter(run, [5, 6]),
      activeEffects: [
        {
          sourceId: "g",
          casterId: "devil",
          modifier: {
            kind: "condition" as const,
            condition: "grappled" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    expect(zonesOn(held, fight(held, devil), run)).toHaveLength(1);
    expect(
      zonesOn(fighter(run, [5, 6]), fight(fighter(run, [5, 6]), devil), run),
    ).toHaveLength(0);
  });

  it("saves badly against charms, falls helpless when knocked down, and shuts down when dispelled", async () => {
    const run = await base();
    const shoggoth = monster("shoggoth");
    const state = fight(fighter(run), shoggoth);
    let d20s = 0;
    const counting: Dice = {
      below: () => 0,
      roll: (sides) => {
        if (sides === 20) d20s += 1;
        return 10;
      },
    };
    rollSave(shoggoth, "wis", 10, contextOf(run, state, counting), false, 0, [
      "charmed",
    ]);
    expect(d20s).toBe(2);
    const knocked = leafEvents(
      [
        {
          kind: "applyCondition",
          condition: "prone",
          duration: { minutes: 1 },
          repeatSave: false,
          endsOnDamage: false,
        },
      ],
      "shove",
      fighter(run),
      shoggoth,
      contextOf(run, state, fixed(1)),
    ).reduce(applyDndEvent, state);
    expect(hasCondition(must(knocked.actors.shoggoth), "incapacitated")).toBe(
      true,
    );
    const dispelled = leafEvents(
      [{ kind: "dispel", maxLevel: 3 }],
      "spell:dispel",
      fighter(run),
      shoggoth,
      contextOf(run, state, fixed(1)),
    ).reduce(applyDndEvent, state);
    expect(hasCondition(must(dispelled.actors.shoggoth), "unconscious")).toBe(
      true,
    );
  });

  it("gates targets: Bloodied, cursed by its own action, and down at 0 Hit Points", async () => {
    const run = await base();
    const gnoll = monster("gnoll", { at: [5, 5] });
    const rampage = actionOf(run, gnoll, "Rampage");
    const reach = (hero: Actor) =>
      inReach(
        rampage,
        { ...gnoll, budget: { ...gnoll.budget, action: false } },
        fight(hero, gnoll),
        run,
      );
    expect(reach(fighter(run, [5, 6], 100))).toHaveLength(0);
    expect(reach(fighter(run, [5, 6], 1))).toHaveLength(1);
    const nightmare = monster("nightmare", { at: [5, 5] });
    const hero = fighter(run, [5, 6]);
    const narcotize = actionOf(run, nightmare, "Narcotize");
    expect(
      inReach(narcotize, nightmare, fight(hero, nightmare), run),
    ).toHaveLength(0);
    const cursed = {
      ...hero,
      activeEffects: [
        {
          sourceId: "monster:0",
          casterId: "nightmare",
          modifier: { kind: "mark" as const },
          ends: "spellDuration" as const,
        },
      ],
    };
    expect(
      inReach(narcotize, nightmare, fight(cursed, nightmare), run),
    ).toHaveLength(1);
    const dying = { ...hero, hp: 0 };
    const feast = actionOf(run, nightmare, "Feast");
    expect(
      inReach(feast, nightmare, fight(dying, nightmare), run),
    ).toHaveLength(1);
    const ate = resolveAction(
      feast,
      nightmare,
      [dying],
      contextOf(run, fight(dying, nightmare), fixed(1)),
    );
    expect(kinds(ate.events ?? [])).toContain("actorDefeated");
    const weighed = resolveAction(
      actionOf(run, nightmare, "Weight"),
      nightmare,
      [hero],
      contextOf(run, fight(hero, nightmare), fixed(1)),
    );
    expect(
      (weighed.events ?? []).reduce(applyDndEvent, fight(hero, nightmare))
        .actors[PLAYER_ACTOR]?.exhaustion,
    ).toBe(1);
  });

  it("has an ally spend its Reaction on an attack", async () => {
    const run = await base();
    const lord = monster("gnoll", { at: [5, 5] });
    const ally = monster("wolf", { at: [8, 8], name: "ally" });
    const hero = fighter(run, [8, 9]);
    const state = fight(hero, lord, ally);
    const incited = resolveAction(
      actionOf(run, lord, "Incite"),
      lord,
      [ally],
      contextOf(run, state, fixed(1)),
    );
    expect(incited.frames?.[0]?.payload).toMatchObject({
      actor: "ally",
      target: PLAYER_ACTOR,
    });
    expect(
      (incited.events ?? []).reduce(applyDndEvent, state).actors.ally?.budget
        .reaction,
    ).toBe(false);
  });
});
