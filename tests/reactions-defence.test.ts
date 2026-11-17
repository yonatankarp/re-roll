import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  dealEvents,
  rollSave,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { reactFrames } from "../plugins/systems/dnd5.5e/core/combat/reactions.ts";
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
const HIT = {
  actionId: SWORD,
  critical: false,
  hadAdvantage: false,
  total: 30,
  natural: 15,
};

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
          ends: "never" as const,
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
          ends: "never",
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
