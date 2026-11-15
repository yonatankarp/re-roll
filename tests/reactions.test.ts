import { PLAYER_ACTOR, type Question, type SystemEvent } from "#sdk";
import { DECLINE } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { describe, expect, it } from "vitest";
import {
  dealEvents,
  rollSave,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  afterDamage,
  initiativeSwapFrames,
  inspirationEchoes,
  reactFrames,
} from "../plugins/systems/dnd5.5e/core/combat/reactions.ts";
import {
  type Actor,
  type DndState,
  frame,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { contextOf, hero, scripted, settle, testRun } from "./feat-fixtures.ts";

const SWORD = "weapon:srd52:item/longsword";
const HIT = {
  actionId: SWORD,
  critical: false,
  hadAdvantage: false,
  total: 30,
  natural: 15,
};

const foeOf = (
  traits: readonly string[] = [],
  extra: Partial<Actor> = {},
): Actor => ({
  ...hero(traits, { id: "foe" }),
  side: "enemy",
  hp: 30,
  ...extra,
});
const friendOf = (
  traits: readonly string[] = [],
  extra: Partial<Actor> = {},
): Actor => ({
  ...hero(traits, { id: "friend" }),
  hp: 30,
  ...extra,
});

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const labels = (events: readonly SystemEvent[]) =>
  payloads(events, "budgetSpent").flatMap((item) =>
    item.label ? [item.label] : [],
  );
const rolls = (events: readonly SystemEvent[], actor: string) =>
  payloads(events, "rollReported").filter((item) => item.actor === actor);

// A board for walks, landings and splits, with everyone standing where `at` says.
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
      grid: { width: 10, height: 4 },
    },
  };
}

// Everyone side by side in a row, the first one's turn.
const row = (actors: readonly Actor[]): DndState =>
  board(
    actors,
    Object.fromEntries(actors.map((actor, index) => [actor.id, [index, 0]])),
    actors[0]?.id ?? PLAYER_ACTOR,
  );
const at = (
  state: DndState,
  dice: ReturnType<typeof scripted>["dice"],
  run: Awaited<ReturnType<typeof testRun>>,
) => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});

describe("reactions to a d20 roll before it lands", () => {
  it("lets an ally reroll a natural 1, asking the player and not a companion, as Bountiful Luck does", async () => {
    const run = await testRun();
    // The friend attacks, rolls a 1, and the player rerolls it to a 15.
    const asked = settle(
      run,
      row([hero(["bountiful-luck"]), friendOf(), foeOf()]),
      [
        frame("attackRoll", {
          attacker: "friend",
          actionId: SWORD,
          target: "foe",
        }),
      ],
      scripted([1, 15]).dice,
    );
    expect(asked.decisions.map((item) => item.id)).toEqual([
      `${NS}:reaction:${PLAYER_ACTOR}`,
    ]);
    expect(rolls(asked.events, "friend").map((item) => item.natural)).toEqual([
      15,
    ]);
    expect(labels(asked.events)).toEqual(["bountiful-luck"]);
    // A companion with it rerolls the player's 1 on its own.
    const companion = settle(
      run,
      row([hero([]), friendOf(["bountiful-luck"]), foeOf()]),
      [
        frame("attackRoll", {
          attacker: PLAYER_ACTOR,
          actionId: SWORD,
          target: "foe",
        }),
      ],
      scripted([1, 15]).dice,
    );
    expect(companion.decisions).toEqual([]);
    expect(
      rolls(companion.events, PLAYER_ACTOR).map((item) => item.natural),
    ).toEqual([15]);
    // Declined, the 1 stands.
    const declined = settle(
      run,
      row([hero(["bountiful-luck"]), friendOf(), foeOf()]),
      [
        frame("attackRoll", {
          attacker: "friend",
          actionId: SWORD,
          target: "foe",
        }),
      ],
      scripted([1, 15]).dice,
      (decision) => decision.options.at(-1)?.id ?? "",
    );
    expect(
      rolls(declined.events, "friend").map((item) => item.natural),
    ).toEqual([1]);
  });

  it("makes an attacker that hits reroll, as Second Chance does", async () => {
    const run = await testRun();
    const { events } = settle(
      run,
      row([hero(["second-chance"]), foeOf()]),
      [
        frame("attackRoll", {
          attacker: "foe",
          actionId: SWORD,
          target: PLAYER_ACTOR,
        }),
      ],
      scripted([15, 2]).dice,
    );
    expect(rolls(events, "foe")).toEqual([
      expect.objectContaining({ natural: 2, success: false }),
    ]);
  });

  it("adds 2d4 to an ally's failing save, or leaves a passing one alone, as Boon of Fate does", async () => {
    const run = await testRun();
    const actors = [hero(["fate"]), friendOf()];
    const failing = rollSave(
      friendOf(),
      "dex",
      15,
      at(row(actors), scripted([12, 4, 4]).dice, run),
    );
    expect(failing.saved).toBe(true);
    expect(payloads(failing.events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "fate" },
    ]);
    const passing = rollSave(
      friendOf(),
      "dex",
      15,
      at(row(actors), scripted([18]).dice, run),
    );
    expect(passing.events.length).toBe(1);
    // Too far short for 2d4 to help, it isn't spent.
    const hopeless = rollSave(
      friendOf(),
      "dex",
      30,
      at(row(actors), scripted([2]).dice, run),
    );
    expect(payloads(hopeless.events, "resourceSpent")).toEqual([]);
  });

  it("rolls a failed save again for a Luck Point, as Lucky does", async () => {
    const run = await testRun();
    const save = rollSave(
      hero(["lucky-saves"]),
      "con",
      15,
      at(row([hero(["lucky-saves"])]), scripted([3, 18]).dice, run),
    );
    expect(save.saved).toBe(true);
    expect(payloads(save.events, "saveRolled")).toEqual([
      expect.objectContaining({ natural: 18 }),
    ]);
  });
});

describe("the player's say on reactions in the middle of a step", () => {
  // A context that can ask, answering every question as `answer` says and keeping what was asked.
  const asking = (
    context: ReturnType<typeof at>,
    answer: (question: Question) => string,
  ) => {
    const asked: Question[] = [];
    return {
      asked,
      context: {
        ...context,
        ask: (question: Question) => {
          asked.push(question);
          return answer(question);
        },
      },
    };
  };

  it("asks before spending a Luck Point on a failed save, and keeps the roll when the player declines", async () => {
    const run = await testRun();
    const bearer = hero(["lucky-saves"]);
    const take = asking(
      at(row([bearer]), scripted([3, 18]).dice, run),
      (question) => question.options[0]?.id ?? "",
    );
    expect(rollSave(bearer, "con", 15, take.context).saved).toBe(true);
    expect(take.asked.map((item) => item.id)).toEqual([
      `${NS}:reaction:${PLAYER_ACTOR}:save:${PLAYER_ACTOR}`,
    ]);
    expect(take.asked[0]?.prompt).toContain("You roll 3");
    const decline = asking(
      at(row([bearer]), scripted([3, 18]).dice, run),
      () => DECLINE,
    );
    const kept = rollSave(bearer, "con", 15, decline.context);
    expect(kept.saved).toBe(false);
    expect(payloads(kept.events, "resourceSpent")).toEqual([]);
  });

  it("asks the player about Vitality Ward before the damage lands, but not a companion", async () => {
    const run = await testRun();
    const player = asking(
      contextOf(run, [hero(["ward"])], scripted([3, 3]).dice),
      () => DECLINE,
    );
    const full = dealEvents(
      hero(["ward"]),
      [{ amount: 10, type: "necrotic" }],
      false,
      player.context,
    );
    expect(player.asked).toHaveLength(1);
    expect(payloads(full.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 10 }),
    ]);
    const friend = friendOf(["ward"]);
    const companion = asking(
      contextOf(run, [hero([]), friend], scripted([3, 3]).dice),
      () => DECLINE,
    );
    const warded = dealEvents(
      friend,
      [{ amount: 10, type: "necrotic" }],
      false,
      companion.context,
    );
    expect(companion.asked).toEqual([]);
    expect(payloads(warded.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 4 }),
    ]);
  });
});

describe("reactions to attacks", () => {
  it("strikes a foe that hits someone else beside the bearer, as Sentinel's Guardian does", async () => {
    const run = await testRun();
    const { events } = settle(
      run,
      row([hero(["guardian"]), foeOf(), friendOf()]),
      [frame("applyHit", { ...HIT, attacker: "foe", target: "friend" })],
      scripted([]).dice,
    );
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "foe" }),
    ]);
    // A hit on the bearer itself isn't one.
    const self = settle(
      run,
      row([hero(["guardian"]), foeOf()]),
      [frame("applyHit", { ...HIT, attacker: "foe", target: PLAYER_ACTOR })],
      scripted([]).dice,
    );
    expect(rolls(self.events, PLAYER_ACTOR)).toEqual([]);
  });

  it("strikes back at a melee attacker that hits the bearer, as Zhentarim Tactics' Retaliate does", async () => {
    const run = await testRun();
    const { events, decisions } = settle(
      run,
      row([{ ...hero(["retaliate"]), hp: 30 }, foeOf()]),
      [frame("applyHit", { ...HIT, attacker: "foe", target: PLAYER_ACTOR })],
      scripted([]).dice,
    );
    expect(decisions.map((item) => item.id)).toEqual([
      `${NS}:reaction:${PLAYER_ACTOR}`,
    ]);
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "foe" }),
    ]);
  });

  it("trades places with an ally who takes the attack instead, as Redirect Attack does", async () => {
    const run = await testRun();
    const minion = { ...foeOf([], { id: "minion" }), name: "Minion" };
    const state = board(
      [hero([]), foeOf(["swap"]), minion],
      { player: [0, 0], foe: [1, 0], minion: [2, 0] },
      PLAYER_ACTOR,
    );
    const { events } = settle(
      run,
      state,
      [
        frame("attackRoll", {
          attacker: PLAYER_ACTOR,
          actionId: SWORD,
          target: "foe",
        }),
      ],
      scripted([15]).dice,
    );
    expect(payloads(events, "moved")).toEqual([
      { actor: "foe", to: { x: 2, y: 0 }, feet: 0 },
      { actor: "minion", to: { x: 1, y: 0 }, feet: 0 },
    ]);
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "minion" }),
    ]);
  });

  it("turns a hit into a miss and strikes back, as Riposte does, or makes the attacker save, as Jinx does", async () => {
    const run = await testRun();
    const riposte = settle(
      run,
      row([hero([]), foeOf(["riposte"])]),
      [
        frame("attackRoll", {
          attacker: PLAYER_ACTOR,
          actionId: SWORD,
          target: "foe",
        }),
      ],
      scripted([15]).dice,
    );
    expect(
      payloads(riposte.events, "damaged").filter(
        (item) => item.actor === "foe",
      ),
    ).toEqual([]);
    expect(rolls(riposte.events, "foe")).toEqual([
      expect.objectContaining({ against: PLAYER_ACTOR }),
    ]);
    const jinx = settle(
      run,
      row([hero([]), foeOf(["jinx"])]),
      [
        frame("attackRoll", {
          attacker: PLAYER_ACTOR,
          actionId: SWORD,
          target: "foe",
        }),
      ],
      scripted([15, 5]).dice,
    );
    expect(payloads(jinx.events, "damaged")).toEqual([]);
  });
});

describe("reactions to damage", () => {
  it("lessens Necrotic damage by Proficiency Bonus d6s, as Vitality Ward does", async () => {
    const run = await testRun();
    const context = contextOf(run, [hero(["ward"])], scripted([3, 3]).dice);
    const necrotic = dealEvents(
      hero(["ward"]),
      [{ amount: 10, type: "necrotic" }],
      false,
      context,
    );
    expect(payloads(necrotic.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 4 }),
    ]);
    const fire = dealEvents(
      hero(["ward"]),
      [{ amount: 10, type: "fire" }],
      false,
      context,
    );
    expect(payloads(fire.events, "damaged")).toEqual([
      expect.objectContaining({ amount: 10 }),
    ]);
  });

  it("splits a creature hit by the right damage, each half with half its Hit Points", async () => {
    const run = await testRun();
    const state = board(
      [hero([]), foeOf(["split"])],
      { player: [0, 0], foe: [1, 0] },
      PLAYER_ACTOR,
    );
    const { events } = settle(
      run,
      state,
      [frame("applyHit", { ...HIT, attacker: PLAYER_ACTOR, target: "foe" })],
      { below: () => 0, roll: () => 4 },
    );
    const [hp] = payloads(events, "hpSet");
    const [copy] = payloads(events, "summoned");
    expect(hp?.actor).toBe("foe");
    expect(typeof hp?.hp).toBe("number");
    expect((copy?.actor as Actor).hp).toBe(hp?.hp);
  });

  it("walks up to a Bloodied creature that takes damage and attacks it, as Bloodthirsty Slash does", async () => {
    const run = await testRun();
    const state = board(
      [
        hero([], { id: PLAYER_ACTOR }),
        friendOf([], { hp: 5 }),
        foeOf(["slash"]),
      ],
      { player: [0, 0], friend: [0, 2], foe: [6, 2] },
      PLAYER_ACTOR,
    );
    const friend = state.actors.friend;
    if (!friend) throw new Error("no friend");
    const frames = afterDamage(friend, 3, { source: PLAYER_ACTOR }, [], {
      state,
      dice: scripted([]).dice,
      content: run.content,
      contentIds: run.contentIds,
    });
    const { events } = settle(run, state, frames, scripted([]).dice);
    // It stops beside the friend at (0, 2), on the side nearest it.
    const [step] = payloads(events, "moved");
    expect(step).toMatchObject({ actor: "foe", to: { x: 1 } });
    expect(rolls(events, "foe")).toEqual([
      expect.objectContaining({ against: "friend" }),
    ]);
  });
});

describe("reactions to a save", () => {
  it("hurts the creature whose effect the bearer failed to save against, as Mind Corrosion does", async () => {
    const run = await testRun();
    const state = row([hero([]), foeOf(["corrode"])]);
    const context = at(state, scripted([]).dice, run);
    const failed = settle(
      run,
      state,
      reactFrames(
        { kind: "saved", actor: "foe", source: PLAYER_ACTOR, success: false },
        context,
      ),
      scripted([4]).dice,
    );
    expect(
      payloads(failed.events, "damaged").filter(
        (item) => item.actor === PLAYER_ACTOR,
      ),
    ).toEqual([expect.objectContaining({ amount: 4, type: "psychic" })]);
    expect(
      reactFrames(
        { kind: "saved", actor: "foe", source: PLAYER_ACTOR, success: true },
        context,
      ),
    ).toEqual([]);
  });
});

describe("reactions to walks, turns and Initiative", () => {
  it("stops a walk where it enters the bearer's reach for an attack, then lets it go on, as Polearm Master does", async () => {
    const run = await testRun();
    const state = board(
      [hero(["polearm"]), foeOf()],
      { player: [2, 0], foe: [6, 0] },
      "foe",
    );
    const { events } = settle(
      run,
      state,
      [frame("move", { actor: "foe", answer: "1,2" })],
      scripted([]).dice,
    );
    const moves = payloads(events, "moved").map(
      (item) => item.to as { x: number; y: number },
    );
    expect(moves).toHaveLength(2);
    expect(
      Math.max(Math.abs((moves[0]?.x ?? 0) - 2), Math.abs(moves[0]?.y ?? 0)),
    ).toBe(1);
    expect(moves[1]).toEqual({ x: 1, y: 2 });
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ against: "foe" }),
    ]);
  });

  it("casts a damaging cantrip at a creature leaving the bearer's reach, as War Caster does", async () => {
    const run = await testRun();
    const state = board(
      [hero(["war-caster"]), foeOf()],
      { player: [2, 0], foe: [3, 0] },
      "foe",
    );
    const { events } = settle(
      run,
      state,
      [frame("move", { actor: "foe", answer: "8,0" })],
      scripted([]).dice,
    );
    expect(rolls(events, PLAYER_ACTOR)).toEqual([
      expect.objectContaining({ label: "Fire Bolt" }),
    ]);
  });

  it("answers a creature ending its move or starting its turn nearby, as Pursuit and Unnerving Gaze do", async () => {
    const run = await testRun();
    const state = board(
      [hero([]), foeOf(["pursue", "gaze"])],
      { player: [0, 0], foe: [8, 3] },
      PLAYER_ACTOR,
    );
    const context = {
      state,
      dice: scripted([]).dice,
      content: run.content,
      contentIds: run.contentIds,
    };
    const moved = settle(
      run,
      state,
      reactFrames({ kind: "endsMove", actor: PLAYER_ACTOR }, context),
      scripted([]).dice,
    );
    expect(payloads(moved.events, "moved")).toEqual([
      expect.objectContaining({ actor: "foe" }),
    ]);
    const near = board(
      [hero([]), foeOf(["gaze"])],
      { player: [0, 0], foe: [3, 0] },
      PLAYER_ACTOR,
    );
    const gazed = settle(
      run,
      near,
      reactFrames(
        { kind: "turnStart", actor: PLAYER_ACTOR },
        { ...context, state: near },
      ),
      scripted([5]).dice,
    );
    const added = payloads(gazed.events, "effectAdded");
    expect(added.map((item) => item.actor)).toEqual([PLAYER_ACTOR]);
    expect(added[0]?.effect).toMatchObject({
      modifier: { kind: "condition", condition: "frightened" },
    });
  });

  it("gives Heroic Inspiration to a bearer whose ally spends theirs, as Tireless Reveler does", async () => {
    const run = await testRun();
    const context = contextOf(
      run,
      [hero(["reveler"]), friendOf()],
      scripted([]).dice,
    );
    expect(
      payloads(inspirationEchoes(friendOf(), context), "inspirationGranted"),
    ).toEqual([{ actor: PLAYER_ACTOR }]);
    const inspired = { ...hero(["reveler"]), heroicInspiration: true };
    expect(
      inspirationEchoes(
        friendOf(),
        contextOf(run, [inspired, friendOf()], scripted([]).dice),
      ),
    ).toEqual([]);
  });

  it("swaps Initiative with an ally the player picks, as Alert does", async () => {
    const run = await testRun();
    const actors = [foeOf(), friendOf(), hero(["alert-swap"])];
    const context = contextOf(run, actors, scripted([]).dice);
    const frames = initiativeSwapFrames(
      [hero(["alert-swap"]), friendOf()],
      context,
    );
    const { state } = settle(
      run,
      context.state,
      frames,
      scripted([]).dice,
      () => "friend",
    );
    expect(state.combat?.order).toEqual(["foe", PLAYER_ACTOR, "friend"]);
    expect(initiativeSwapFrames([hero([]), friendOf()], context)).toEqual([]);
  });
});
