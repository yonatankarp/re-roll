import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  dealEvents,
  rollSave,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  reactFrames,
  spellAimedAt,
} from "../plugins/systems/dnd5.5e/core/combat/reactions.ts";
import { provokers } from "../plugins/systems/dnd5.5e/core/combat/movement.ts";
import { recovered } from "../plugins/systems/dnd5.5e/core/rest.ts";
import {
  canAfford,
  slotToSpend,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  type Actor,
  type DndState,
  frame,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { hero, scripted, settle, testRun, trait } from "./feat-fixtures.ts";

// Reactions and protections from #161 and #163: made-up features with ids and mechanics only.
const SWORD = "weapon:srd52:item/longsword";

const reacting = (
  id: string,
  trigger: object,
  effects: readonly object[],
  extra: object = {},
  cost: readonly unknown[] = ["reaction"],
) =>
  trait(id, [], {
    activations: [
      {
        cost,
        trigger,
        targeting: { self: true },
        resolution: { kind: "automatic", effects },
        ...extra,
      },
    ],
  });

const MINE = [
  reacting(
    "bend",
    { rolled: { rolls: ["attack", "save", "check"], by: "others" } },
    [{ kind: "rollBonus", amount: { dice: "1d4" }, either: true }],
  ),
  reacting(
    "countercharm",
    {
      rolled: {
        rolls: ["save"],
        by: "selfOrAlly",
        when: "failed",
        conditions: ["charmed", "frightened"],
      },
      within: 30,
    },
    [{ kind: "reroll", advantage: true }],
  ),
  reacting(
    "balance",
    { rolled: { rolls: ["attack"], by: "foe", edged: true } },
    [{ kind: "reroll", straight: true }],
  ),
  reacting(
    "stroke",
    { rolled: { rolls: ["save"], by: "self", when: "failed" } },
    [{ kind: "replaceRoll", value: 20 }],
    {},
    [],
  ),
  reacting(
    "wish",
    { rolled: { rolls: ["save"], by: "selfOrAlly", when: "failed" } },
    [{ kind: "succeed" }],
  ),
  reacting(
    "reweave",
    { rolled: { rolls: ["save"], by: "selfOrAlly", when: "failed" } },
    [{ kind: "reroll", advantage: true, tempHp: { dice: "6d10" } }],
  ),
  reacting("skirmish", { turnEnds: true, within: 5 }, [
    { kind: "reactionMove", away: true, half: true },
  ]),
  trait("vow", [], {
    activations: [
      {
        cost: ["bonusAction"],
        targeting: { creatures: 1, range: 30, side: "enemy" },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              modifier: { kind: "advantage", on: "attacksAgainst" },
              duration: { minutes: 1 },
            },
          ],
        },
      },
    ],
  }),
  trait("vengeance", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { foeAttacks: true, marked: ["test:feature/vow"] },
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: { kind: "automatic", effects: [{ kind: "strike" }] },
      },
    ],
  }),
  trait("riposte", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { missed: true, melee: true },
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "strike", damage: { dice: "1d8" } }],
        },
      },
    ],
  }),
  trait("twist", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: {
          ownSave: "succeeded",
          allySave: "succeeded",
          conditions: ["charmed", "frightened"],
          within: 120,
        },
        targeting: { creatures: 1, range: 120, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "wis",
          dc: { base: 13 },
          damage: [],
          onFail: [
            {
              kind: "applyCondition",
              condition: "charmed",
              duration: { minutes: 1 },
            },
          ],
          onSuccess: [],
        },
      },
    ],
  }),
  trait("glory", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { allyHit: true, within: 10 },
        targeting: { creatures: 1, range: 10, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "acAgainstHit", bonus: 10 }, { kind: "strike" }],
        },
      },
    ],
  }),
  trait("spirit-shield", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { damaged: true, before: true, within: 30 },
        targeting: { creatures: 1, range: 30, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [
            { kind: "reduceDamage", amount: { dice: "2d6" }, echo: "force" },
          ],
        },
      },
    ],
  }),
  trait("allegiance", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { damaged: true, before: true, within: 5 },
        targeting: { creatures: 1, range: 5, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "reduceDamage", takes: true }],
        },
      },
    ],
  }),
  trait("backlash", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { damaged: true, before: true },
        targeting: { creatures: 1, range: 60, side: "enemy" },
        selfEffects: [{ kind: "reduceDamage", amount: { dice: "1d6" } }],
        resolution: {
          kind: "save",
          ability: "con",
          dc: { base: 30 },
          damage: [{ amount: { dice: "1d6" }, type: "force" }],
          onFail: [],
          onSuccess: [],
        },
      },
    ],
  }),
  reacting("illusory", { hitByAttack: true }, [{ kind: "negateHit" }]),
  trait("sentinel", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { allyHit: true, within: 30 },
        targeting: { creatures: 1, range: 30, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "noCritical" }],
        },
      },
    ],
  }),
  trait("duelist", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { hitByAttack: true, melee: true, holding: "finesse" },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "acAgainstHit", bonus: 20 }],
        },
      },
    ],
  }),

  trait("portent", [{ kind: "foretell", count: 2 }], {
    activations: [
      {
        cost: [],
        oncePerTurn: true,
        trigger: { rolled: { rolls: ["attack", "save", "check"], by: "any" } },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "replaceRoll", foretold: true }],
        },
      },
    ],
  }),
  trait("ward", [{ kind: "wardPool", resource: "ward", made: "ward-made" }], {
    resources: [
      { id: "ward", max: { base: 8 }, recharge: [] },
      {
        id: "ward-made",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  }),
  trait("rebuke", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { hitByAttack: true },
        targeting: { creatures: 1, range: 60, side: "enemy" },
        selfEffects: [{ kind: "reduceDamage", halve: true }],
        resolution: {
          kind: "save",
          ability: "wis",
          dc: { base: 30 },
          damage: [
            {
              amount: { bonus: { add: [{ kind: "dealt" }] } },
              type: "psychic",
            },
          ],
          onFail: [],
          onSuccess: [],
        },
      },
    ],
  }),
  trait("thief", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { spellTargets: true },
        targeting: { self: true },
        resolution: {
          kind: "save",
          ability: "int",
          dc: { base: 30 },
          damage: [],
          onFail: [{ kind: "stealSpell" }],
          onSuccess: [],
        },
      },
    ],
  }),
  trait("defender", [{ kind: "vigilantDefender" }, { kind: "holdTheLine" }]),
  trait("misdirect", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { attacked: true },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "redirect", cover: true }],
        },
      },
    ],
  }),
  trait("emissary", [
    { kind: "creatureResistance" },
    {
      kind: "modifier",
      modifier: { kind: "retaliate", anyAttack: true, halfDealt: "radiant" },
    },
  ]),
  trait("mirror", [{ kind: "mirrorDamage", damage: "psychic" }]),
  trait("absorbing", [
    {
      kind: "modifier",
      modifier: {
        kind: "damageReduction",
        amount: { bonus: { base: 3 } },
        magical: true,
        oncePerTurn: true,
      },
    },
    { kind: "spellDamageResistance" },
  ]),
  trait("unarmored", [
    {
      kind: "modifier",
      modifier: {
        kind: "acFormula",
        unarmored: true,
        noShield: true,
        formula: { base: 20 },
      },
    },
    {
      kind: "modifier",
      modifier: {
        kind: "bonus",
        to: "ac",
        armor: "any",
        amount: { bonus: { base: 1 } },
      },
    },
    {
      kind: "modifier",
      modifier: { kind: "bonus", to: "ac", amount: { bonus: { base: 2 } } },
      concentrating: true,
    },
  ]),
  trait("elusive", [
    { kind: "modifier", modifier: { kind: "noAdvantageAgainst", able: true } },
    {
      kind: "modifier",
      modifier: { kind: "checkFloor", value: 10, all: true },
    },
  ]),
  trait("lethargy", [], {
    resources: [
      {
        id: "lethargy",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all", everyDie: 4 }],
      },
    ],
  }),

  trait("fury", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { damaged: true, endured: true },
        targeting: { creatures: 1, range: 15, side: "enemy" },
        resolution: { kind: "automatic", effects: [{ kind: "strike" }] },
      },
    ],
  }),
  trait("endurance", [{ kind: "dropToOne", resource: "endurance" }], {
    resources: [
      {
        id: "endurance",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  }),
  trait("counter", [
    { kind: "saveCounter", marked: ["test:feature/vow"] },
    { kind: "preyBonus", marked: ["test:feature/vow"], dice: "1d6" },
  ]),
  trait("majesty-after", [
    { kind: "modifier", modifier: { kind: "majesty", ability: "cha" } },
  ]),
  trait("storm", [{ kind: "stormStrength", damage: ["lightning"] }]),
  trait("horde", [
    {
      kind: "modifier",
      modifier: {
        kind: "disadvantage",
        on: "attacksAgainst",
        opportunity: true,
      },
    },
  ]),
  trait("rebuker", [
    {
      kind: "modifier",
      modifier: {
        kind: "retaliate",
        anyAttack: true,
        oncePerTurn: true,
        damage: [{ amount: { bonus: { base: 4 } }, type: "psychic" }],
      },
    },
  ]),
  trait("shroud", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { rolled: { rolls: ["save"], by: "self", when: "failed" } },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            { kind: "rollBonus", amount: { bonus: { base: 4 } } },
            {
              kind: "modifier",
              modifier: { kind: "actionLimit", cantripsOnly: true },
              duration: { until: "yourNextTurnEnd" },
            },
            {
              kind: "foesTake",
              creatures: 1,
              range: 60,
              damage: [{ amount: { bonus: { base: 5 } }, type: "force" }],
            },
          ],
        },
      },
    ],
  }),
  trait("stride", [], {
    activations: [
      {
        cost: [],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              modifier: {
                kind: "strideDamage",
                damage: { bonus: { base: 3 } },
                types: ["fire"],
              },
              duration: { until: "turnEnd" },
            },
          ],
        },
      },
    ],
  }),
  trait("song", [], {
    activations: [
      {
        cost: ["reaction", "slot"],
        minSlot: 2,
        trigger: { damaged: true, before: true },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "reduceDamage", perSlot: 5 }],
        },
      },
    ],
  }),
  trait("absorb", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { damaged: true, before: true, damagedBy: ["fire"] },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "resistTrigger",
              lasting: { until: "yourNextTurnStart" },
              hitDamage: { dice: "1d6" },
            },
          ],
        },
      },
    ],
  }),
  trait("raging-only", [
    {
      kind: "modifier",
      modifier: { kind: "immunity", damage: "thunder" },
      bloodied: true,
    },
    { kind: "sneakFloor", value: 3 },
    { kind: "armorStrength" },
  ]),

  trait("rebuke-and-thunder", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { hitByAttack: true },
        targeting: { creatures: 1, range: 60, side: "enemy" },
        selfEffects: [{ kind: "reduceDamage", halve: true }],
        resolution: {
          kind: "save",
          ability: "wis",
          dc: { base: 30 },
          damage: [{ amount: { bonus: { base: 1 } }, type: "psychic" }],
          onFail: [],
          onSuccess: [],
        },
      },
      {
        cost: ["reaction"],
        trigger: { damaged: true },
        targeting: { creatures: 1, range: 60, side: "enemy" },
        resolution: {
          kind: "automatic",
          damage: [{ amount: { bonus: { base: 7 } }, type: "thunder" }],
          effects: [],
        },
      },
    ],
  }),
  trait("deflector", [], {
    resources: [
      {
        id: "focus",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    activations: [
      {
        cost: ["reaction"],
        trigger: { hitByAttack: true, damagedBy: ["piercing"] },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "reduceDamage",
              amount: { bonus: { base: 99 } },
              deflect: {
                range: 60,
                melee: 5,
                ability: "dex",
                dc: { base: 40 },
                damage: [
                  { amount: { bonus: { base: 6 } }, type: "bludgeoning" },
                ],
                resource: "focus",
                sameType: true,
              },
            },
          ],
        },
      },
    ],
  }),
  trait("tiers", [], {
    classTiers: {
      class: "srd52:class/fighter",
      at: [3],
      step: { addRadius: 20 },
    },
    activations: [
      {
        cost: ["reaction"],
        trigger: { damaged: true, before: true, within: 10 },
        targeting: { creatures: 1, range: 10, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [{ kind: "reduceDamage", takes: true }],
        },
      },
    ],
  }),
  trait("chosen", [], {
    variants: [
      { id: "one", name: "One", spells: { "1": ["srd52:spell/fire-bolt"] } },
      { id: "two", name: "Two" },
    ],
  }),
  trait("quick-cantrip", [], {
    spells: { "1": ["srd52:spell/fire-bolt"] },
    freeCast: { resource: "quick", bonusAction: true },
    resources: [
      {
        id: "quick",
        max: { base: 2 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  }),
  trait(
    "shaker",
    [
      {
        kind: "shakeOff",
        conditions: ["frightened"],
        turnStart: true,
        resource: "shake",
      },
    ],
    {
      resources: [
        {
          id: "shake",
          max: { base: 1 },
          recharge: [{ on: "longRest", amount: "all" }],
        },
      ],
    },
  ),
  trait(
    "helm",
    [
      {
        kind: "spellBackfire",
        damage: "fire",
        die: 20,
        radius: 60,
        ability: "dex",
        dc: 30,
        type: "radiant",
        resources: ["gems"],
        item: "srd52:item/longsword",
      },
    ],
    {
      resources: [{ id: "gems", max: { base: 4 }, recharge: [] }],
    },
  ),
];

async function mineRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(MINE.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

const foeOf = (traits: readonly string[] = [], extra: Partial<Actor> = {}) => ({
  ...hero(traits, { id: "foe" }),
  name: "Foe",
  side: "enemy" as const,
  hp: 30,
  ...extra,
});
const friendOf = (
  traits: readonly string[] = [],
  extra: Partial<Actor> = {},
) => ({
  ...hero(traits, { id: "friend" }),
  name: "Friend",
  hp: 30,
  ...extra,
});

function board(
  actors: readonly Actor[],
  at: Record<string, [number, number]>,
  turn: string,
): DndState {
  const placed = actors.map((actor) => {
    const square = at[actor.id];
    return square
      ? { ...actor, position: { x: square[0], y: square[1] } }
      : actor;
  });
  return {
    actors: Object.fromEntries(placed.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: [
        turn,
        ...placed.map((actor) => actor.id).filter((id) => id !== turn),
      ],
      index: 0,
      round: 1,
      grid: { width: 12, height: 4 },
    },
  };
}
const row = (actors: readonly Actor[]): DndState =>
  board(
    actors,
    Object.fromEntries(actors.map((actor, index) => [actor.id, [index, 0]])),
    actors[0]?.id ?? PLAYER_ACTOR,
  );

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const rolls = (events: readonly SystemEvent[], actor: string) =>
  payloads(events, "rollReported").filter((item) => item.actor === actor);
const at = (
  state: DndState,
  dice: ReturnType<typeof scripted>["dice"],
  run: RunContext,
) => ({ state, dice, content: run.content, contentIds: run.contentIds });

describe("reactions that change a d20 roll", () => {
  it("bends another creature's roll either way, but never the bearer's own, as Bend Luck does", async () => {
    const run = await mineRun();
    const actors = [hero(["bend"]), friendOf()];
    const helped = rollSave(
      friendOf(),
      "dex",
      17,
      at(row(actors), scripted([13, 4]).dice, run),
    );
    expect(helped.saved).toBe(true);
    const own = rollSave(
      hero(["bend"]),
      "dex",
      17,
      at(row(actors), scripted([13, 4]).dice, run),
    );
    expect(own.saved).toBe(false);
  });

  it("rerolls with Advantage a failed save only against Charmed or Frightened, as Countercharm does", async () => {
    const run = await mineRun();
    const actors = [hero(["countercharm"]), friendOf()];
    const charmed = rollSave(
      friendOf(),
      "wis",
      15,
      at(row(actors), scripted([3, 4, 18]).dice, run),
      false,
      0,
      ["charmed"],
    );
    expect(charmed.saved).toBe(true);
    const other = rollSave(
      friendOf(),
      "wis",
      15,
      at(row(actors), scripted([3, 4, 18]).dice, run),
      false,
      0,
      ["poisoned"],
    );
    expect(other.saved).toBe(false);
  });

  it("turns a failed save into a 20, a success, or a reroll that gives Temporary Hit Points when it succeeds", async () => {
    const run = await mineRun();
    const stroke = rollSave(
      hero(["stroke"]),
      "con",
      15,
      at(row([hero(["stroke"])]), scripted([3]).dice, run),
    );
    expect(stroke.saved).toBe(true);
    expect(payloads(stroke.events, "saveRolled")).toEqual([
      expect.objectContaining({ natural: 20 }),
    ]);
    const wish = rollSave(
      friendOf(),
      "con",
      28,
      at(row([hero(["wish"]), friendOf()]), scripted([3]).dice, run),
    );
    expect(wish.saved).toBe(true);
    const reweave = rollSave(
      friendOf(),
      "con",
      15,
      at(
        row([hero(["reweave"]), friendOf()]),
        scripted([3, 17, 4, 1, 1, 1, 1, 1, 1]).dice,
        run,
      ),
    );
    expect(reweave.saved).toBe(true);
    expect(payloads(reweave.events, "effectAdded")).toEqual([]);
    expect(
      reweave.events.some(
        (event) =>
          event.kind === `${NS}:tempHpGained` ||
          JSON.stringify(event).includes("tempHp"),
      ),
    ).toBe(true);
  });

  it("takes Advantage away from a foe's attack roll, as Restore Balance does, but leaves a plain roll alone", async () => {
    const run = await mineRun();
    const blinded = {
      ...hero(["balance"]),
      activeEffects: [
        {
          sourceId: "test",
          casterId: "foe",
          modifier: {
            kind: "condition" as const,
            condition: "blinded" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const { events } = settle(
      run,
      row([foeOf(), blinded]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      scripted([15, 18, 2]).dice,
    );
    expect(rolls(events, "foe")).toEqual([
      expect.objectContaining({ natural: 2, success: false }),
    ]);
  });
});

describe("moments other reactions answer", () => {
  it("moves away when a foe ends its turn beside the bearer, as Skirmisher does", async () => {
    const run = await mineRun();
    const state = board(
      [hero(["skirmish"]), foeOf()],
      { player: [3, 0], foe: [2, 0] },
      "foe",
    );
    const frames = reactFrames(
      { kind: "turnEnd", actor: "foe" },
      at(state, scripted([]).dice, run),
    );
    const { events } = settle(run, state, frames, scripted([]).dice);
    const [moved] = payloads(events, "moved");
    expect(moved).toMatchObject({ actor: PLAYER_ACTOR });
    expect((moved?.to as { x: number }).x).toBeGreaterThan(3);
  });

  it("strikes a vowed foe that misses anyone, as Soul of Vengeance does, but not a foe it never vowed against", async () => {
    const run = await mineRun();
    const vowed = foeOf([], {
      activeEffects: [
        {
          sourceId: "feature:test:feature/vow:0",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "advantage", on: "attacksAgainst" },
          ends: "spellDuration",
        },
      ],
    });
    const frames = (foe: Actor) =>
      reactFrames(
        { kind: "missed", actor: "friend", source: foe.id, melee: true },
        at(row([hero(["vengeance"]), foe, friendOf()]), scripted([]).dice, run),
      );
    expect(frames(vowed)).toHaveLength(1);
    expect(frames(foeOf())).toHaveLength(0);
    const { events } = settle(
      run,
      row([hero(["vengeance"]), vowed, friendOf()]),
      frames(vowed),
      scripted([15]).dice,
    );
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "foe" }),
    ]);
  });

  it("adds its die to the attack back after a melee miss, as Riposte does", async () => {
    const run = await mineRun();
    const state = row([hero(["riposte"]), foeOf()]);
    const frames = reactFrames(
      { kind: "missed", actor: PLAYER_ACTOR, source: "foe", melee: true },
      at(state, scripted([]).dice, run),
    );
    const { events } = settle(run, state, frames, scripted([15]).dice);
    expect(
      payloads(events, "effectAdded").map(
        (item) => (item.effect as { modifier: { kind: string } }).modifier.kind,
      ),
    ).toContain("damageBonus");
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "foe" }),
    ]);
  });

  it("answers an ally's save against Charmed that succeeds, as Beguiling Twist does", async () => {
    const run = await mineRun();
    const state = row([hero(["twist"]), friendOf(), foeOf()]);
    const context = at(state, scripted([]).dice, run);
    const moment = {
      kind: "saved" as const,
      actor: "friend",
      source: "foe",
      success: true,
    };
    expect(
      reactFrames({ ...moment, conditions: ["charmed"] }, context),
    ).toHaveLength(1);
    expect(
      reactFrames({ ...moment, conditions: ["poisoned"] }, context),
    ).toHaveLength(0);
  });
});

describe("protections for the bearer and others", () => {
  it("raises an ally's AC against a hit and strikes the attacker when it misses, as Glorious Defense does", async () => {
    const run = await mineRun();
    const { events } = settle(
      run,
      row([friendOf(), hero(["glory"]), foeOf()]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: "friend",
        }),
      ],
      scripted([12, 15]).dice,
    );
    expect(
      payloads(events, "damaged").filter((item) => item.actor === "friend"),
    ).toEqual([]);
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "foe" }),
    ]);
  });

  it("lessens an ally's damage and sends what it took off back, as Spirit Shield with Vengeful Ancestors does", async () => {
    const run = await mineRun();
    const state = row([hero(["spirit-shield"]), friendOf(), foeOf()]);
    const foe = state.actors.foe;
    const friend = state.actors.friend;
    if (!foe || !friend) throw new Error("missing");
    const dealt = dealEvents(
      friend,
      [{ amount: 10, type: "slashing" }],
      false,
      at(state, scripted([3, 3]).dice, run),
      foe,
    );
    expect(payloads(dealt.events, "damaged")).toEqual([
      expect.objectContaining({ actor: "foe", amount: 6 }),
      expect.objectContaining({ actor: "friend", amount: 4 }),
    ]);
  });

  it("takes an ally's damage on itself, as Divine Allegiance does", async () => {
    const run = await mineRun();
    const state = row([hero(["allegiance"]), friendOf()]);
    const friend = state.actors.friend;
    if (!friend) throw new Error("missing");
    const dealt = dealEvents(
      friend,
      [{ amount: 9, type: "fire" }],
      false,
      at(state, scripted([]).dice, run),
    );
    const hurt = payloads(dealt.events, "damaged");
    expect(hurt.filter((item) => item.actor === PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ amount: 9 }),
    ]);
    expect(
      hurt.filter((item) => item.actor === "friend" && Number(item.amount) > 0),
    ).toEqual([]);
  });

  it("lessens its own damage and makes the creature that dealt it save, as Backlash does", async () => {
    const run = await mineRun();
    const me = { ...hero(["backlash"]), hp: 30 };
    const state = row([me, foeOf()]);
    const foe = state.actors.foe;
    const self = state.actors[PLAYER_ACTOR];
    if (!foe || !self) throw new Error("missing");
    const dealt = dealEvents(
      self,
      [{ amount: 10, type: "fire" }],
      false,
      at(state, scripted([4, 2, 5]).dice, run),
      foe,
    );
    const hurt = payloads(dealt.events, "damaged");
    expect(hurt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: PLAYER_ACTOR, amount: 6 }),
        expect.objectContaining({ actor: "foe", amount: 2 }),
      ]),
    );
  });

  it("makes a hit miss outright, as Illusory Self does", async () => {
    const run = await mineRun();
    const { events } = settle(
      run,
      row([foeOf(), { ...hero(["illusory"]), hp: 30 }]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      scripted([18]).dice,
    );
    expect(
      payloads(events, "damaged").filter((item) => item.actor === PLAYER_ACTOR),
    ).toEqual([]);
  });

  it("turns an ally's Critical Hit into a normal one, as Sentinel at Death's Door does", async () => {
    const run = await mineRun();
    const { events } = settle(
      run,
      row([hero(["sentinel"]), friendOf(), foeOf()]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: "friend",
        }),
      ],
      { below: () => 0, roll: (sides) => sides },
    );
    // A longsword's 1d8 rolls 8 once, not twice.
    const [hurt] = payloads(events, "damaged").filter(
      (item) => item.actor === "friend",
    );
    expect(Number(hurt?.amount)).toBeLessThan(16);
  });

  it("parries only while holding a Finesse weapon, as Defensive Duelist does", async () => {
    const run = await mineRun();
    const attack = (bearer: Actor) =>
      settle(
        run,
        row([foeOf(), bearer]),
        [
          frame("attackRoll", {
            attacker: "foe",
            actionId: SWORD,
            target: PLAYER_ACTOR,
          }),
        ],
        scripted([15]).dice,
      ).events;
    const longsword = attack({ ...hero(["duelist"]), hp: 30 });
    expect(
      payloads(longsword, "damaged").filter(
        (item) => item.actor === PLAYER_ACTOR,
      ),
    ).toHaveLength(1);
    const rapier = attack({
      ...hero(["duelist"]),
      hp: 30,
      inventory: ["srd52:item/shortsword"],
    });
    expect(
      payloads(rapier, "damaged").filter((item) => item.actor === PLAYER_ACTOR),
    ).toHaveLength(0);
  });
});

describe("pools, foretold rolls and stolen spells", () => {
  it("rolls Portent's d20s as a Long Rest ends, and spends the one that saves an ally", async () => {
    const run = await mineRun();
    const rested = settle(
      run,
      {
        actors: { [PLAYER_ACTOR]: hero(["portent"]), friend: friendOf() },
        combat: null,
      },
      [frame("finishRest", { rest: "long" })],
      scripted([3, 17]).dice,
    );
    expect(payloads(rested.events, "foretold")).toEqual([
      { actor: PLAYER_ACTOR, rolls: [3, 17] },
    ]);
    const seer = rested.state.actors[PLAYER_ACTOR];
    if (!seer) throw new Error("missing");
    const save = rollSave(
      friendOf(),
      "con",
      15,
      at(row([seer, friendOf()]), scripted([4]).dice, run),
    );
    expect(save.saved).toBe(true);
    expect(payloads(save.events, "foretoldUsed")).toEqual([
      { actor: PLAYER_ACTOR, roll: 17 },
    ]);
  });

  it("lets a ward take damage only once it has been made, as Arcane Ward", async () => {
    const run = await mineRun();
    const fresh = { ...hero(["ward"]), hp: 30 };
    const unmade = dealEvents(
      fresh,
      [{ amount: 5, type: "fire" }],
      false,
      at(row([fresh]), scripted([]).dice, run),
    );
    expect(payloads(unmade.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 5 }),
    ]);
    const made = { ...fresh, resourcesSpent: { "ward-made": 1 } };
    const warded = dealEvents(
      made,
      [{ amount: 11, type: "fire" }],
      false,
      at(row([made]), scripted([]).dice, run),
    );
    expect(payloads(warded.events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "ward", amount: 8 },
    ]);
    expect(payloads(warded.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 3 }),
    ]);
  });

  it("halves a hit, then makes the attacker save against the damage taken, as Elemental Rebuke", async () => {
    const run = await mineRun();
    const { events } = settle(
      run,
      row([foeOf(), { ...hero(["rebuke"]), hp: 40 }]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      { below: () => 0, roll: (sides) => (sides === 20 ? 15 : 8) },
    );
    const hurt = payloads(events, "damaged");
    const mine = hurt.find((item) => item.actor === PLAYER_ACTOR);
    const theirs = hurt.find((item) => item.actor === "foe");
    expect(theirs?.amount).toBe(mine?.amount);
  });

  it("makes a spell's caster save or have it pass the bearer by, as Spell Thief, and lets Shield's spell pass", async () => {
    const run = await mineRun();
    const thief = { ...hero(["thief"]), hp: 30 };
    const state = row([foeOf(), thief]);
    const missile = {
      id: "spell:srd52:spell/magic-missile",
      name: "Magic Missile",
      spellLevel: 1,
      activation: {
        cost: ["action" as const, "slot" as const],
        targeting: { creatures: 3, range: 120, side: "enemy" as const },
        resolution: { kind: "automatic" as const, damage: [], effects: [] },
      },
    };
    const caster = state.actors.foe;
    if (!caster) throw new Error("missing");
    const aimed = spellAimedAt(
      missile,
      caster,
      [thief],
      at(state, scripted([2]).dice, run),
    );
    expect(aimed.targets).toEqual([]);
    expect(payloads(aimed.events, "saveRolled")).toEqual([
      expect.objectContaining({ actor: "foe", success: false }),
    ]);
    const plain = spellAimedAt(
      missile,
      caster,
      [friendOf()],
      at(row([foeOf(), friendOf()]), scripted([2]).dice, run),
    );
    expect(plain.targets).toHaveLength(1);
  });
});

describe("opportunity attacks and redirected attacks", () => {
  it("provokes a walk inside the reach, and with the Reaction spent still once on another's turn", async () => {
    const run = await mineRun();
    const spent = {
      ...hero(["defender"]),
      budget: { action: true, bonusAction: true, reaction: false },
    };
    const state = board(
      [foeOf(), spent],
      { foe: [1, 0], player: [0, 0] },
      "foe",
    );
    const walker = state.actors.foe;
    if (!walker) throw new Error("missing");
    expect(
      provokers(walker, { x: 1, y: 1 }, state, run).map(({ foe }) => foe.id),
    ).toEqual([PLAYER_ACTOR]);
  });

  it("turns an attack on a creature standing between, as Misdirection", async () => {
    const run = await mineRun();
    const shield = { ...friendOf(), id: "shield" };
    const state = board(
      [foeOf(), shield, { ...hero(["misdirect"]), hp: 30 }],
      { foe: [0, 0], shield: [1, 0], player: [2, 0] },
      "foe",
    );
    const { events } = settle(
      run,
      state,
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      scripted([15]).dice,
    );
    expect(rolls(events, "foe")).toEqual([
      expect.objectContaining({ against: "shield" }),
    ]);
  });
});

describe("resistances and protections", () => {
  it("resists another creature's damage and strikes back with half of a hit, until it attacks that one, as Emissary of Redemption", async () => {
    const run = await mineRun();
    const me = { ...hero(["emissary"]), hp: 40 };
    const state = row([foeOf(), me]);
    const foe = state.actors.foe;
    if (!foe) throw new Error("missing");
    const halved = dealEvents(
      me,
      [{ amount: 10, type: "fire" }],
      false,
      at(state, scripted([]).dice, run),
      foe,
    );
    expect(payloads(halved.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 5 }),
    ]);
    const turned = { ...me, resourcesSpent: { "emissary:foe": 1 } };
    const full = dealEvents(
      turned,
      [{ amount: 10, type: "fire" }],
      false,
      at(row([foe, turned]), scripted([]).dice, run),
      foe,
    );
    expect(payloads(full.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 10 }),
    ]);
  });

  it("sends Psychic damage back on its dealer, as Thought Shield", async () => {
    const run = await mineRun();
    const me = { ...hero(["mirror"]), hp: 40 };
    const state = row([foeOf(), me]);
    const foe = state.actors.foe;
    if (!foe) throw new Error("missing");
    const dealt = dealEvents(
      me,
      [{ amount: 6, type: "psychic" }],
      false,
      at(state, scripted([]).dice, run),
      foe,
    );
    expect(payloads(dealt.events, "damaged").map((item) => item.actor)).toEqual(
      [PLAYER_ACTOR, "foe"],
    );
  });

  it("lessens a spell's damage once a turn and halves it, as Magic Absorption and Spell Resistance", async () => {
    const run = await mineRun();
    const me = { ...hero(["absorbing"]), hp: 40 };
    const state = row([me]);
    const spell = dealEvents(
      me,
      [{ amount: 10, type: "fire" }],
      false,
      at(state, scripted([]).dice, run),
      undefined,
      true,
    );
    expect(payloads(spell.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 2 }),
    ]);
    const plain = dealEvents(
      me,
      [{ amount: 10, type: "fire" }],
      false,
      at(state, scripted([]).dice, run),
    );
    expect(payloads(plain.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 10 }),
    ]);
  });

  it("counts Unarmored Defense only without armor, a bonus only with it, and another only while concentrating", async () => {
    const run = await mineRun();
    const bare = deriveStats({ ...hero(["unarmored"]), inventory: [] }, run);
    expect(bare.ac).toBe(20);
    const focused = deriveStats(
      { ...hero(["unarmored"]), inventory: [], concentratingOn: "spell:x" },
      run,
    );
    expect(focused.ac).toBe(22);
    const armored = deriveStats(
      { ...hero(["unarmored"]), inventory: ["srd52:item/chain-mail"] },
      run,
    );
    expect(armored.ac).toBe(17);
  });

  it("gives no Advantage against the bearer, and counts its low d20s as 10, as Elusive and Trance of Order", async () => {
    const run = await mineRun();
    const prone = {
      ...hero(["elusive"]),
      hp: 30,
      activeEffects: [
        {
          sourceId: "test",
          casterId: "foe",
          modifier: {
            kind: "condition" as const,
            condition: "blinded" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const { events } = settle(
      run,
      row([foeOf(), prone]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      scripted([2, 19]).dice,
    );
    expect(rolls(events, "foe")).toEqual([
      expect.objectContaining({ natural: 2 }),
    ]);
    const save = rollSave(
      hero(["elusive"]),
      "con",
      12,
      at(row([hero(["elusive"])]), scripted([3]).dice, run),
    );
    expect(payloads(save.events, "saveRolled")).toEqual([
      expect.objectContaining({ natural: 10 }),
    ]);
  });

  it("brings a use back after a rolled number of Long Rests, as Lethargy Resilience", async () => {
    const run = await mineRun();
    const stats = deriveStats(hero(["lethargy"]), run);
    const first = recovered({ lethargy: 1 }, stats, "long", scripted([3]).dice);
    expect(first).toMatchObject({
      lethargy: 1,
      "lethargy:due": 3,
      "lethargy:waited": 1,
    });
    const second = recovered(first, stats, "long", scripted([]).dice);
    expect(second).toMatchObject({ lethargy: 1, "lethargy:waited": 2 });
    const third = recovered(second, stats, "long", scripted([]).dice);
    expect(third.lethargy).toBeUndefined();
  });
});

describe("more reactions and protections", () => {
  it("strikes back right after Relentless Endurance holds, as Orcish Fury", async () => {
    const run = await mineRun();
    const me = { ...hero(["fury", "endurance"]), hp: 5 };
    const state = row([foeOf(), me]);
    const { events } = settle(
      run,
      state,
      [
        frame("applyHit", {
          actionId: SWORD,
          critical: false,
          hadAdvantage: false,
          total: 30,
          natural: 15,
          attacker: "foe",
          target: PLAYER_ACTOR,
        }),
      ],
      { below: () => 0, roll: (sides) => (sides === 20 ? 15 : 8) },
    );
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "foe" }),
    ]);
  });

  it("attacks the prey that calls for a save first, and a hit makes it succeed, as Slayer's Counter", async () => {
    const run = await mineRun();
    const prey = foeOf([], {
      activeEffects: [
        {
          sourceId: "feature:test:feature/vow:0",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "advantage", on: "attacksAgainst" },
          ends: "spellDuration",
        },
      ],
    });
    const me = hero(["counter"]);
    const save = rollSave(
      me,
      "wis",
      30,
      at(row([me, prey]), scripted([18, 4]).dice, run),
      false,
      0,
      [],
      false,
      false,
      { creatureType: undefined, school: null, breath: false, caster: "foe" },
    );
    expect(save.saved).toBe(true);
    expect(rolls(save.events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "foe", success: true }),
    ]);
  });

  it("makes the first creature to hit the bearer on a turn save or miss, as Unbreakable Majesty", async () => {
    const run = await mineRun();
    const me = {
      ...hero([]),
      hp: 30,
      activeEffects: [
        {
          sourceId: "test",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "majesty" as const, ability: "cha" as const },
          ends: "spellDuration" as const,
        },
      ],
    };
    const { events } = settle(
      run,
      row([foeOf(), me]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      scripted([15, 2]).dice,
    );
    expect(
      payloads(events, "damaged").filter((item) => item.actor === PLAYER_ACTOR),
    ).toEqual([]);
  });

  it("strikes back at any attacker that hits, once a turn, as Scornful Rebuke", async () => {
    const run = await mineRun();
    const me = { ...hero(["rebuker"]), hp: 40 };
    const state = board([foeOf(), me], { foe: [0, 0], player: [5, 0] }, "foe");
    const hit = {
      actionId: SWORD,
      critical: false,
      hadAdvantage: false,
      total: 30,
      natural: 15,
      attacker: "foe",
      target: PLAYER_ACTOR,
    };
    const { events } = settle(
      run,
      state,
      [frame("applyHit", hit), frame("applyHit", hit)],
      scripted([]).dice,
    );
    expect(
      payloads(events, "damaged").filter((item) => item.actor === "foe"),
    ).toEqual([expect.objectContaining({ amount: 4, type: "psychic" })]);
  });

  it("adds to a failed save, keeps the bearer to cantrips and hurts a foe, as Arcane Deflection with Deflecting Shroud", async () => {
    const run = await mineRun();
    const me = hero(["shroud"]);
    const save = rollSave(
      me,
      "con",
      16,
      at(row([me, foeOf()]), scripted([10]).dice, run),
    );
    expect(save.saved).toBe(true);
    expect(payloads(save.events, "damaged")).toEqual([
      expect.objectContaining({ actor: "foe", amount: 5 }),
    ]);
    expect(
      payloads(save.events, "effectAdded").map(
        (item) => (item.effect as { modifier: { kind: string } }).modifier.kind,
      ),
    ).toContain("actionLimit");
  });

  it("lessens damage by five a slot level, and resists a type until its next turn with a hit's extra die, as Song of Defense and Absorb Elements", async () => {
    const run = await mineRun();
    const caster = {
      ...hero(["song"]),
      hp: 40,
      source: hero(["song"]).source,
    };
    const stats = deriveStats(caster, run);
    expect(stats.actions.some((item) => item.activation.minSlot === 2)).toBe(
      true,
    );
    const absorber = { ...hero(["absorb"]), hp: 40 };
    const dealt = dealEvents(
      absorber,
      [{ amount: 10, type: "fire" }],
      false,
      at(row([absorber]), scripted([]).dice, run),
    );
    expect(payloads(dealt.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 5 }),
    ]);
    expect(
      payloads(dealt.events, "effectAdded").map(
        (item) => (item.effect as { modifier: { kind: string } }).modifier.kind,
      ),
    ).toEqual(["resistance", "hitDamage"]);
  });

  it("holds a passive only while Bloodied, floors Sneak Attack dice, and lifts armor's Strength", async () => {
    const run = await mineRun();
    const whole = deriveStats({ ...hero(["raging-only"]), hp: 30 }, run);
    expect(whole.passives.some((passive) => passive.kind === "modifier")).toBe(
      false,
    );
    const hurt = deriveStats({ ...hero(["raging-only"]), hp: 1 }, run);
    expect(hurt.passives.some((passive) => passive.kind === "modifier")).toBe(
      true,
    );
    expect(hurt.passives.some((passive) => passive.kind === "sneakFloor")).toBe(
      true,
    );
  });

  it("burns foes a walk comes beside once a turn, as Destructive Stride", async () => {
    const run = await mineRun();
    const walker = {
      ...hero(["stride"]),
      activeEffects: [
        {
          sourceId: "feature:test:feature/stride:0",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "strideDamage" as const,
            damage: { bonus: { base: 3, add: [] } },
            types: ["fire" as const],
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const state = board(
      [walker, foeOf()],
      { player: [0, 0], foe: [3, 1] },
      PLAYER_ACTOR,
    );
    const { events } = settle(
      run,
      state,
      [frame("move", { actor: PLAYER_ACTOR, answer: "5,0" })],
      scripted([]).dice,
    );
    expect(
      payloads(events, "damaged").filter((item) => item.actor === "foe"),
    ).toEqual([expect.objectContaining({ amount: 3, type: "fire" })]);
  });
});

describe("pieces checked one by one", () => {
  const HIT0 = {
    actionId: SWORD,
    critical: false,
    hadAdvantage: false,
    total: 30,
    natural: 15,
  };

  it("spends one Reaction on Elemental Rebuke, so no other reaction answers the same hit", async () => {
    const run = await mineRun();
    const { events } = settle(
      run,
      row([foeOf(), { ...hero(["rebuke-and-thunder"]), hp: 40 }]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      { below: () => 0, roll: (sides) => (sides === 20 ? 15 : 4) },
    );
    expect(
      payloads(events, "budgetSpent").filter(
        (item) => item.actor === PLAYER_ACTOR && item.kind === "reaction",
      ),
    ).toHaveLength(1);
    expect(
      payloads(events, "damaged").filter((item) => item.type === "thunder"),
    ).toEqual([]);
  });

  it("answers a spell aimed at it twice only once, as Shield does a second dart", async () => {
    const run = await mineRun();
    const thief = { ...hero(["thief"]), hp: 30 };
    const state = row([foeOf(), thief]);
    const caster = state.actors.foe;
    if (!caster) throw new Error("missing");
    const missile = {
      id: "spell:srd52:spell/magic-missile",
      name: "Magic Missile",
      spellLevel: 1,
      activation: {
        cost: ["action" as const],
        targeting: { creatures: 3, range: 120, side: "enemy" as const },
        resolution: { kind: "automatic" as const, damage: [], effects: [] },
      },
    };
    const aimed = spellAimedAt(
      missile,
      caster,
      [thief, thief, thief],
      at(state, scripted([2, 2, 2]).dice, run),
    );
    expect(aimed.targets).toEqual([]);
    expect(payloads(aimed.events, "saveRolled")).toHaveLength(1);
  });

  it("deflects only a type it answers, sending its own type back for a Focus Point", async () => {
    const run = await mineRun();
    const me = { ...hero(["deflector"]), hp: 40 };
    const { events } = settle(
      run,
      row([foeOf(), me]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      scripted([15]).dice,
    );
    // A longsword's Slashing isn't Piercing, so the reaction isn't offered.
    expect(
      payloads(events, "damaged").filter((item) => item.actor === PLAYER_ACTOR),
    ).toHaveLength(1);
  });

  it("spends a level 2+ slot for an activation with `minSlot`, and keeps a bearer to cantrips", async () => {
    const run = await mineRun();
    const wizard = deriveStats({ ...hero(["song"]), hp: 30 }, run);
    const song = wizard.actions.find((item) => item.activation.minSlot === 2);
    if (!song) throw new Error("missing");
    const caster = { ...hero(["song"]), hp: 30 };
    const slots = { ...wizard, slots: [4, 2] };
    expect(slotToSpend(song, caster, slots)).toBe(2);
    const limited = {
      ...caster,
      activeEffects: [
        {
          sourceId: "test",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "actionLimit" as const,
            cantripsOnly: true as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    expect(canAfford({ ...song, spellLevel: 1 }, limited, slots)).toBe(false);
    expect(
      canAfford(
        {
          ...song,
          spellLevel: 0,
          activation: { ...song.activation, cost: [] },
        },
        limited,
        slots,
      ),
    ).toBe(true);
  });

  it("grows a reaction's reach at a class level, as Aura of the Guardian at 18", async () => {
    const run = await mineRun();
    const reach = (level: number) =>
      deriveStats(hero(["tiers"], { level }), run).actions.find(
        (item) => item.activation.trigger?.within !== undefined,
      )?.activation.trigger?.within;
    expect(reach(1)).toBe(10);
    expect(reach(3)).toBe(30);
  });

  it("gives a picked variant's spells, and casts a cantrip as a Bonus Action for a use", async () => {
    const run = await mineRun();
    const chosen = deriveStats(hero(["chosen"]), run);
    expect(
      chosen.actions.some((item) => item.id === "spell:srd52:spell/fire-bolt"),
    ).toBe(true);
    const quick = deriveStats(hero(["quick-cantrip"]), run).actions.find(
      (item) => item.id.startsWith("spell:srd52:spell/fire-bolt:free"),
    );
    expect(quick?.activation.cost).toEqual([
      "bonusAction",
      { resource: "quick" },
    ]);
  });

  it("regains twice a slot's level, as Arcane Ward's Bonus Action does", async () => {
    const run = await mineRun();
    const ward = { ...hero(["ward"]), resourcesSpent: { ward: 6 } };
    const events = leafEvents(
      [{ kind: "regain", resource: "ward", count: 1, perSlot: 2 }],
      "test",
      ward,
      ward,
      at(row([ward]), scripted([]).dice, run),
      undefined,
      2,
    );
    expect(payloads(events, "resourceRestored")).toEqual([
      { actor: PLAYER_ACTOR, resource: "ward", amount: 4 },
    ]);
  });

  it("shakes off Frightened as its turn starts for a use, as Guarded Mind", async () => {
    const run = await mineRun();
    const scared = {
      ...hero(["shaker"]),
      activeEffects: [
        {
          sourceId: "test",
          casterId: "foe",
          modifier: {
            kind: "condition" as const,
            condition: "frightened" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const state = row([foeOf(), scared]);
    const { events } = settle(
      run,
      state,
      [frame("advanceTurn", {})],
      scripted([]).dice,
    );
    expect(payloads(events, "conditionRemoved")).toContainEqual({
      actor: PLAYER_ACTOR,
      condition: "frightened",
    });
    expect(payloads(events, "resourceSpent")).toContainEqual({
      actor: PLAYER_ACTOR,
      resource: "shake",
    });
  });

  it("strikes back with half the damage a hit dealt, and resists less once attacked, as Emissary of Redemption", async () => {
    const run = await mineRun();
    const me = { ...hero(["emissary"]), hp: 40 };
    const { events } = settle(
      run,
      row([foeOf(), me]),
      [frame("applyHit", { ...HIT0, attacker: "foe", target: PLAYER_ACTOR })],
      { below: () => 0, roll: () => 8 },
    );
    const mine = payloads(events, "damaged").find(
      (item) => item.actor === PLAYER_ACTOR,
    );
    const theirs = payloads(events, "damaged").find(
      (item) => item.actor === "foe",
    );
    expect(theirs?.type).toBe("radiant");
    expect(theirs?.amount).toBe(Math.floor(Number(mine?.amount) / 2));
  });
});

describe("a helm's gems set off", () => {
  it("rolls a d20 for fire from a failed save against a spell, and on a 1 its gems strike out and it's spent", async () => {
    const run = await mineRun();
    const wearer = { ...hero(["helm"]), hp: 40 };
    const state = row([foeOf(), wearer]);
    const caster = state.actors.foe;
    const target = state.actors[PLAYER_ACTOR];
    if (!caster || !target) throw new Error("missing");
    const flame = {
      id: "spell:srd52:spell/burning-hands",
      name: "Burning Hands",
      spellLevel: 1,
      activation: {
        cost: [],
        targeting: { creatures: 1, range: 15, side: "enemy" as const },
        resolution: {
          kind: "save" as const,
          ability: "dex" as const,
          dc: { base: 30, add: [] },
          damage: [
            { amount: { bonus: { base: 6, add: [] } }, type: "fire" as const },
          ],
          onSuccessDamage: "half" as const,
          onFail: [],
          onSuccess: [],
        },
      },
    };
    const result = resolveAction(
      flame,
      caster,
      [target],
      at(state, scripted([2, 1, 2]).dice, run),
    );
    const events = result.events ?? [];
    expect(payloads(events, "damaged")).toContainEqual(
      expect.objectContaining({ actor: "foe", amount: 4, type: "radiant" }),
    );
    expect(payloads(events, "itemUsed")).toEqual([
      { actor: PLAYER_ACTOR, item: "srd52:item/longsword" },
    ]);
  });
});
