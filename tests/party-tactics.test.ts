import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import {
  choosePolicy,
  nextDndDecision,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import { parseOption } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { gearOptions } from "../plugins/systems/dnd5.5e/core/gear.ts";
import { gearPolicy } from "../plugins/systems/dnd5.5e/core/policy.ts";
import {
  ClassSchema,
  PregenSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";

// How the party plays a fight (policy.ts with worth.ts): each case is one where the old rules chose worse.

const spell = (slug: string): string => `srd52:spell/${slug}`;

const club = (dice: string) => ({
  name: "Club",
  activation: {
    cost: ["action"],
    targeting: { creatures: 1, range: 5, side: "enemy" },
    resolution: {
      kind: "attack",
      attack: { type: "weapon", flatBonus: 4 },
      damage: [{ amount: { dice }, type: "bludgeoning" }],
    },
  },
});

const statBlock = (id: string, dice: string) => ({
  id,
  name: id,
  ac: 10,
  hp: 500,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  actions: [club(dice)],
});

// A wizard that can be given any spell, with slots of every level, and two monsters: one that barely hurts
// and one that hits hard.
async function arena(extra: Record<string, unknown> = {}): Promise<RunContext> {
  const base = (await loadAdventure("goblin-ambush")).run;
  const wizard = ClassSchema.parse(base.content("srd52:class/wizard"));
  const [first] = wizard.levels;
  if (!first) throw new Error("The wizard has no levels");
  const content: Record<string, unknown> = {
    "srd52:class/wizard": {
      ...wizard,
      levels: Array.from({ length: 20 }, (_, index) => ({
        ...(index === 0 ? first : { grants: [], choices: [], scaling: {} }),
        level: index + 1,
        slots: [4, 3, 3, 3, 3, 2, 2, 1, 1],
      })),
    },
    "test:monster/weak": statBlock("test:monster/weak", "1d4"),
    "test:monster/brute": statBlock("test:monster/brute", "4d12"),
    ...extra,
  };
  return {
    ...base,
    content: (id) =>
      (content[id] as ReturnType<RunContext["content"]>) ?? base.content(id),
    contentIds: () => [
      ...new Set([...base.contentIds(), ...Object.keys(content)]),
    ],
  };
}

function hero(
  run: RunContext,
  options: {
    readonly id?: string;
    readonly spells?: readonly string[];
    readonly features?: readonly string[];
    readonly level?: number;
    readonly inventory?: readonly string[];
    readonly hp?: number;
  } = {},
): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  const answers = [
    { kind: "spells" as const, values: (options.spells ?? []).map(spell) },
    { kind: "features" as const, values: [...(options.features ?? [])] },
  ];
  const actor = freshActor({
    id: options.id ?? PLAYER_ACTOR,
    name: options.id ?? "Hero",
    side: "party",
    source: {
      kind: "character",
      build: {
        ...pregen.build,
        levels: Array.from({ length: options.level ?? 5 }, () => ({
          ...first,
          answers,
        })),
      },
    },
    hp: 1,
    inventory: [...(options.inventory ?? [])],
  });
  return { ...actor, hp: options.hp ?? deriveStats(actor, run).maxHp };
}

function monster(id: string, kind: "weak" | "brute", hp: number): Actor {
  return freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId: `test:monster/${kind}` },
    hp,
    inventory: [],
  });
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
    },
  };
}

function choose(run: RunContext, state: DndState): string {
  const decision = nextDndDecision(state, run);
  if (!decision) throw new Error("No decision");
  return choosePolicy(decision, {
    state,
    dice: createDice(rngFromSeed("party-tactics")),
    content: run.content,
    contentIds: run.contentIds,
  });
}

describe("how the party fights", () => {
  it("brings a downed ally back with a Bonus Action, keeping the Action to attack", async () => {
    const run = await arena();
    const healer = hero(run, {
      spells: ["cure-wounds", "healing-word", "fire-bolt"],
    });
    const downed = hero(run, { id: "ally", hp: 0 });
    const picked = choose(
      run,
      fight(healer, downed, monster("a", "brute", 40)),
    );
    expect(picked).toContain("healing-word");
    expect(parseOption(picked)[1]).toBe("ally");
    // With the Bonus Action spent, the Action goes on the foe, not on more healing.
    const after = choose(
      run,
      fight(
        { ...healer, budget: { ...healer.budget, bonusAction: false } },
        { ...downed, hp: 4 },
        monster("a", "brute", 40),
      ),
    );
    expect(after).toContain("fire-bolt");
  });

  it("leaves a wounded ally alone while no foe could drop it this round", async () => {
    const run = await arena();
    const healer = hero(run, { spells: ["cure-wounds", "fire-bolt"] });
    const ally = hero(run, { id: "ally" });
    const hurt = { ...ally, hp: Math.floor(deriveStats(ally, run).maxHp / 3) };
    const picked = choose(run, fight(healer, hurt, monster("a", "weak", 30)));
    expect(picked).not.toContain("cure-wounds");
    expect(picked).toContain("fire-bolt");
  });

  it("heals at the damage the difficulty lets foes deal: on Story a hurt ally can wait", async () => {
    const run = await arena();
    const healer = hero(run, { spells: ["cure-wounds", "fire-bolt"] });
    const ally = hero(run, { id: "ally" });
    const hurt = { ...ally, hp: 8 };
    const normal = fight(healer, hurt, monster("a", "brute", 40));
    expect(choose(run, normal)).toContain("cure-wounds");
    expect(choose(run, { ...normal, difficulty: "story" })).toContain(
      "fire-bolt",
    );
  });

  it("hits the dangerous foe before the harmless one with a little less HP", async () => {
    const run = await arena();
    const caster = hero(run, { spells: ["fire-bolt"] });
    const picked = choose(
      run,
      fight(caster, monster("weak", "weak", 9), monster("brute", "brute", 11)),
    );
    expect(parseOption(picked)[1]).toBe("brute");
  });

  it("uses its best attack, not the first one listed", async () => {
    const run = await arena();
    const caster = hero(run, {
      spells: ["fire-bolt"],
      inventory: ["srd52:item/dagger"],
    });
    const picked = choose(run, fight(caster, monster("a", "brute", 60)));
    expect(picked).toContain("fire-bolt");
  });

  it("casts with a higher slot when the fight is going badly", async () => {
    const run = await arena();
    const caster = hero(run, { spells: ["magic-missile"], hp: 8 });
    const picked = choose(
      run,
      fight(caster, monster("a", "brute", 30), monster("b", "brute", 30)),
    );
    expect(picked).toContain("magic-missile");
    expect(Number(parseOption(picked)[2])).toBeGreaterThan(1);
  });

  it("doesn't put its own mark on a foe that already carries it", async () => {
    const mark = "test:feature/mark";
    const run = await arena({
      [mark]: {
        id: mark,
        name: "Mark",
        text: "Mark",
        automation: "full",
        resources: [{ id: "mark", max: { base: 3 }, recharge: [] }],
        activations: [
          {
            cost: ["bonusAction", { resource: "mark" }],
            targeting: { creatures: 1, range: 90, side: "enemy" },
            resolution: {
              kind: "automatic",
              effects: [
                {
                  kind: "modifier",
                  duration: { minutes: 60 },
                  modifier: {
                    kind: "hitDamage",
                    dealtBy: "caster",
                    damage: { amount: { dice: "1d6" }, type: "force" },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const caster = hero(run, { spells: ["fire-bolt"], features: [mark] });
    const markAction = deriveStats(caster, run).actions.find(
      (action) => action.name === "Mark",
    );
    if (!markAction) throw new Error("The mark isn't an action");
    const marked = {
      ...monster("a", "brute", 60),
      activeEffects: [
        {
          sourceId: markAction.id,
          casterId: PLAYER_ACTOR,
          ends: "spellDuration" as const,
          modifier: {
            kind: "hitDamage" as const,
            dealtBy: "caster" as const,
            weaponOnly: false,
            damage: { amount: { dice: "1d6" }, type: "force" as const },
          },
        },
      ],
    };
    const acted = { ...caster, budget: { ...caster.budget, action: false } };
    expect(choose(run, fight(acted, marked))).not.toContain(markAction.id);
    expect(choose(run, fight(acted, monster("a", "brute", 60)))).toContain(
      markAction.id,
    );
  });
});

describe("how the party protects itself and spends free boosts", () => {
  const decide = (run: RunContext, state: DndState): string => {
    const decision = run.system.nextDecision(state, run);
    if (!decision) throw new Error("No decision");
    return run.system.decidePolicy(decision, {
      state,
      dice: createDice(rngFromSeed("party-tactics")),
      content: run.content,
      contentIds: run.contentIds,
    });
  };

  it("Dodges when it's the one the foes will go for and one more round could drop it", async () => {
    const run = await arena();
    const caster = hero(run, { spells: ["fire-bolt"] });
    const foes = ["a", "b", "c"].map((id) => monster(id, "brute", 300));
    expect(decide(run, fight({ ...caster, hp: 3 }, ...foes))).toBe(
      "tactic:dodge",
    );
    expect(decide(run, fight(caster, ...foes))).toContain("fire-bolt");
    // Foes that can't act this round are no reason to Dodge: it would wait on them forever.
    const asleep = foes.map((foe) => ({
      ...foe,
      activeEffects: [
        {
          sourceId: "spell:sleep",
          casterId: PLAYER_ACTOR,
          ends: "spellDuration" as const,
          modifier: {
            kind: "condition" as const,
            condition: "unconscious" as const,
          },
        },
      ],
    }));
    expect(decide(run, fight({ ...caster, hp: 3 }, ...asleep))).toContain(
      "fire-bolt",
    );
  });

  it("spends a luck point before its attack, never after", async () => {
    const luck = "test:feature/luck";
    const run = await arena({
      [luck]: {
        id: luck,
        name: "Luck",
        text: "Luck",
        automation: "full",
        resources: [{ id: "luck", max: { base: 3 }, recharge: [] }],
        activations: [
          {
            cost: [{ resource: "luck" }],
            targeting: { self: true },
            resolution: {
              kind: "automatic",
              effects: [
                {
                  kind: "modifier",
                  duration: { until: "yourNextTurnStart" },
                  modifier: { kind: "advantage", on: "attacks", once: true },
                },
              ],
            },
          },
        ],
      },
    });
    const caster = hero(run, { spells: ["fire-bolt"], features: [luck] });
    const luckId = deriveStats(caster, run).actions.find(
      (action) => action.name === "Luck",
    )?.id;
    if (!luckId) throw new Error("Luck isn't an action");
    const foe = monster("a", "brute", 60);
    expect(choose(run, fight(caster, foe))).toContain(luckId);
    const attacked = {
      ...caster,
      budget: { ...caster.budget, action: false },
    };
    expect(choose(run, fight(attacked, foe))).not.toContain(luckId);
  });
});

describe("how the bot changes gear between fights", () => {
  const fighter = (run: RunContext, stowed: readonly string[]): Actor => {
    const pregen = PregenSchema.parse(run.content("srd52:pregen/fighter"));
    const actor = freshActor({
      id: PLAYER_ACTOR,
      name: pregen.name,
      side: "party",
      source: { kind: "character", build: pregen.build },
      hp: 1,
      inventory: [
        ...pregen.equipment,
        "srd52:item/leather-armor",
        "srd52:item/scale-mail",
      ],
    });
    return { ...actor, stowed: [...stowed] };
  };
  const answer = (run: RunContext, actor: Actor, kind: string): string =>
    gearPolicy(
      {
        id: `dnd5.5e:${kind}:${String(actor.inventory.length)}:0`,
        actor: actor.id,
        prompt: "Change your gear.",
        options:
          kind === "shortRest"
            ? [
                { id: "finish", label: "Finish resting" },
                { id: "gear", label: "Change gear" },
              ]
            : [...gearOptions(actor, run), { id: "done", label: "Done" }],
        resume: { kind: "dnd5.5e:gearAnswer", payload: { step: 0 } },
      },
      {
        state: fight(actor),
        dice: createDice(rngFromSeed("gear")),
        content: run.content,
        contentIds: run.contentIds,
      },
    );

  it("keeps its best armor on instead of stowing it or swapping it for worse", async () => {
    const run = await arena();
    const armored = fighter(run, [
      "srd52:item/leather-armor",
      "srd52:item/scale-mail",
    ]);
    expect(answer(run, armored, "gear")).toBe("done");
    // Nothing better to put on, so a rest doesn't open the gear at all.
    expect(answer(run, armored, "shortRest")).toBe("finish");
  });

  it("puts on better armor it carries", async () => {
    const run = await arena();
    const light = fighter(run, [
      "srd52:item/chain-mail",
      "srd52:item/scale-mail",
    ]);
    expect(answer(run, light, "shortRest")).toBe("gear");
    expect(answer(run, light, "gear")).toBe("equip:srd52:item/chain-mail");
  });
});
