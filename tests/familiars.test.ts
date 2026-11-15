import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import {
  type Context,
  choosePolicy,
  nextDndDecision,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  tacticOptions,
  withTactics,
} from "../plugins/systems/dnd5.5e/core/actions.ts";
import { startCombat } from "../plugins/systems/dnd5.5e/core/combat/start.ts";
import {
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { restFrames } from "../plugins/systems/dnd5.5e/core/rest.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  familiarOwner,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  attackBonus,
  damageResponses,
  deriveStats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";

const LOW: Dice = { below: () => 0, roll: () => 1 };
const FORM = "srd52:monster/test-owl";
const SPELL = "srd52:spell/test-find-familiar";
const BOONS = "srd52:feature/test-familiar-boons";
const FAMILIAR = `${PLAYER_ACTOR}:familiar`;

async function arena(): Promise<RunContext> {
  const base = (await loadAdventure("goblin-ambush")).run;
  const content: Record<string, unknown> = {
    [FORM]: {
      id: FORM,
      name: "Test Owl",
      size: "tiny",
      creatureType: "beast",
      ac: 11,
      hp: 5,
      speed: 30,
      abilities: { str: 3, dex: 13, con: 8, int: 2, wis: 12, cha: 7 },
      proficiency: 2,
      initiative: 1,
      actions: [
        {
          name: "Talons",
          activation: {
            cost: ["action"],
            targeting: { creatures: 1, range: 5, side: "enemy" },
            resolution: {
              kind: "attack",
              attack: { type: "weapon", ability: "dex" },
              damage: [{ amount: { dice: "1d1" }, type: "slashing" }],
            },
          },
        },
      ],
    },
    [SPELL]: {
      id: SPELL,
      name: "Test Find Familiar",
      level: 1,
      school: "conjuration",
      classes: [],
      castingTime: "1 hour or Ritual",
      range: "10 feet",
      components: "V, S",
      duration: "instantaneous",
      text: "A test.",
      automation: "partial",
      outOfCombat: "castingTime",
      familiar: { form: FORM },
    },
    [BOONS]: {
      id: BOONS,
      name: "Test Familiar Boons",
      text: "A test.",
      automation: "full",
      resources: [
        {
          id: "helpful-friend",
          max: { add: [{ kind: "proficiency" }] },
          recharge: [{ on: "longRest", amount: "all" }],
        },
      ],
      passives: [{ kind: "familiarHelp", resource: "helpful-friend" }],
      activations: [
        {
          cost: ["bonusAction"],
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            effects: [
              { kind: "commandFamiliar", action: "Energy Pulse", range: 120 },
            ],
          },
        },
      ],
      familiar: {
        hp: { base: 0, add: [{ kind: "level" }, { kind: "level" }] },
        passives: [
          {
            kind: "modifier",
            modifier: { kind: "resistance", damage: "fire" },
          },
          { kind: "healDieFloor", at: 3, within: 5 },
        ],
        actions: [
          {
            name: "Intercept Attack",
            activation: {
              cost: ["reaction"],
              trigger: { allyHit: true },
              targeting: { creatures: 1, range: 5, side: "ally" },
              resolution: {
                kind: "automatic",
                effects: [
                  {
                    kind: "acAgainstHit",
                    bonus: {
                      base: 0,
                      add: [{ kind: "scaling", key: "ownerProficiency" }],
                    },
                  },
                ],
              },
            },
          },
          {
            name: "Energy Pulse",
            activation: {
              cost: ["reaction"],
              trigger: { commanded: true },
              targeting: {
                area: { shape: "emanation", radius: 5 },
                range: "self",
                side: "enemy",
              },
              resolution: {
                kind: "save",
                ability: "dex",
                dc: { base: 0, add: [{ kind: "scaling", key: "spellDc" }] },
                damage: [{ amount: { dice: "2d4" }, type: "fire" }],
                onFail: [
                  {
                    kind: "applyCondition",
                    condition: "prone",
                    duration: "instantaneous",
                    maxSize: "medium",
                  },
                ],
                onSuccess: [],
              },
            },
          },
        ],
      },
    },
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

function owner(run: RunContext, boons = false): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  const answers = [
    ...first.answers.filter((answer) => answer.kind !== "spells"),
    { kind: "spells" as const, values: [SPELL] },
    ...(boons ? [{ kind: "features" as const, values: [BOONS] }] : []),
  ];
  return freshActor({
    id: PLAYER_ACTOR,
    name: "Hero",
    side: "party",
    source: {
      kind: "character",
      build: {
        ...pregen.build,
        levels: Array.from({ length: 4 }, () => ({ ...first, answers })),
      },
    },
    hp: 20,
    inventory: [],
  });
}

function goblin(id: string, x: number): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
      hp: 10,
      inventory: [],
    }),
    position: { x, y: 0 },
  };
}

const contextOf = (run: RunContext, state: DndState, dice = LOW): Context => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});

const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);

function begin(run: RunContext, state: DndState): DndState {
  const { events = [] } = startCombat(
    {
      id: "ambush",
      monsters: [{ monster: "srd52:monster/goblin-warrior", count: 1 }],
    },
    contextOf(run, { ...state, combat: null }),
    { canFlee: false, defeatContinues: false },
  );
  return fold(state, events);
}

function rest(run: RunContext, state: DndState, kind: "short" | "long") {
  const { events = [] } = restFrames[`${NS}:finishRest`].run(
    { rest: kind },
    contextOf(run, state),
  );
  return fold(state, events);
}

const hurt = (state: DndState, id: string, amount: number): DndState =>
  applyDndEvent(
    state,
    dndEvent(`${NS}:damaged`, {
      actor: id,
      amount,
      type: "slashing",
      critical: false,
      massive: false,
    }),
  );

function at(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(`No ${id}`);
  return actor;
}

const solo = (actor: Actor): DndState => ({
  actors: { [actor.id]: actor },
  combat: null,
});

describe("familiars", () => {
  it("join each fight beside their owner with Initiative of their own, and can't attack", async () => {
    const run = await arena();
    const state = begin(run, solo(owner(run)));
    const familiar = state.actors[FAMILIAR];
    if (!familiar) throw new Error("No familiar joined");
    expect(familiarOwner(familiar)).toBe(PLAYER_ACTOR);
    expect(state.actors[PLAYER_ACTOR]?.familiar).toEqual({
      form: FORM,
      hp: 5,
      maxHp: 5,
    });
    expect(state.combat?.order).toHaveLength(3);
    expect(familiar.position).not.toBeNull();
    const stats = deriveStats(familiar, run);
    expect(stats.creatureType).toBe("fey");
    expect(stats.actions.map((action) => action.name)).not.toContain("Talons");
  });

  it("keep their Hit Points between fights until a rest finds them again", async () => {
    const run = await arena();
    const fought = begin(run, solo(owner(run)));
    const ended = applyDndEvent(
      hurt(fought, FAMILIAR, 3),
      dndEvent(`${NS}:combatEnded`, {}),
    );
    expect(ended.actors[FAMILIAR]).toBeUndefined();
    expect(ended.actors[PLAYER_ACTOR]?.familiar?.hp).toBe(2);
    expect(begin(run, ended).actors[FAMILIAR]?.hp).toBe(2);
    // A Short Rest leaves a hurt one as it is, and a Long Rest heals it.
    expect(rest(run, ended, "short").actors[PLAYER_ACTOR]?.familiar?.hp).toBe(
      2,
    );
    expect(rest(run, ended, "long").actors[PLAYER_ACTOR]?.familiar?.hp).toBe(5);
    // One that dropped stays gone for the next fight, and any rest calls it back.
    const dropped = applyDndEvent(
      hurt(fought, FAMILIAR, 10),
      dndEvent(`${NS}:combatEnded`, {}),
    );
    expect(dropped.actors[PLAYER_ACTOR]?.familiar?.hp).toBe(0);
    expect(begin(run, dropped).actors[FAMILIAR]).toBeUndefined();
    expect(rest(run, dropped, "short").actors[PLAYER_ACTOR]?.familiar?.hp).toBe(
      5,
    );
  });

  it("Help against the foe beside an ally, walking up to it first", async () => {
    const run = await arena();
    const started = begin(run, solo(owner(run)));
    const state: DndState = {
      ...started,
      actors: {
        ...started.actors,
        [PLAYER_ACTOR]: {
          ...at(started, PLAYER_ACTOR),
          position: { x: 1, y: 0 },
        },
        [FAMILIAR]: {
          ...at(started, FAMILIAR),
          position: { x: 2, y: 1 },
        },
        "ambush:goblin-warrior-1": goblin("ambush:goblin-warrior-1", 2),
      },
      combat: started.combat && {
        ...started.combat,
        order: [FAMILIAR, PLAYER_ACTOR, "ambush:goblin-warrior-1"],
        index: 0,
      },
    };
    const familiar = at(state, FAMILIAR);
    const help = encodeHelp("ambush:goblin-warrior-1");
    expect(
      tacticOptions(familiar, state, run).map((option) => option.id),
    ).toContain(help);
    const turn = withTactics(nextDndDecision(state, run), state, run);
    if (!turn) throw new Error("No turn");
    expect(choosePolicy(turn, contextOf(run, state))).toBe(help);
    // From across the field it walks up to the foe first.
    const far: DndState = {
      ...state,
      actors: {
        ...state.actors,
        [FAMILIAR]: { ...familiar, position: { x: 8, y: 6 } },
      },
    };
    const away = withTactics(nextDndDecision(far, run), far, run);
    if (!away) throw new Error("No turn");
    expect(choosePolicy(away, contextOf(run, far))).toBe("move");
  });

  it("get what their owner's features give: Hit Points, resistance, Energy Pulse and Healing Beacon", async () => {
    const run = await arena();
    const started = begin(run, solo(owner(run, true)));
    const familiar = at(started, FAMILIAR);
    // Twice the owner's level on top of its form's 5.
    expect(familiar.hp).toBe(13);
    expect(deriveStats(familiar, run).maxHp).toBe(13);
    expect(
      damageResponses(familiar, contextOf(run, started)).resistances,
    ).toContain("fire");
    const state: DndState = {
      ...started,
      actors: {
        ...started.actors,
        [PLAYER_ACTOR]: {
          ...at(started, PLAYER_ACTOR),
          position: { x: 0, y: 0 },
        },
        [FAMILIAR]: { ...familiar, position: { x: 4, y: 0 } },
        "ambush:goblin-warrior-1": goblin("ambush:goblin-warrior-1", 5),
      },
    };
    const hero = at(state, PLAYER_ACTOR);
    const command = deriveStats(hero, run).actions.find((action) =>
      action.activation.resolution.kind === "automatic"
        ? action.activation.resolution.effects.some(
            (effect) => effect.kind === "commandFamiliar",
          )
        : false,
    );
    if (!command) throw new Error("No command");
    const { events = [] } = resolveAction(
      command,
      hero,
      [hero],
      contextOf(run, state),
    );
    const after = fold(state, events);
    expect(after.actors[FAMILIAR]?.budget.reaction).toBe(false);
    const goblinAfter = at(after, "ambush:goblin-warrior-1");
    expect(goblinAfter.hp).toBeLessThan(10);
    expect(
      goblinAfter.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "condition" && modifier.condition === "prone",
      ),
    ).toBe(true);
    // A heal rolled beside the familiar treats a 1 on its die as a 3.
    const healed = (at: { x: number; y: number }) => {
      const beside = {
        ...state,
        actors: {
          ...state.actors,
          [PLAYER_ACTOR]: { ...hero, hp: 1, position: at },
        },
      };
      const events = leafEvents(
        [{ kind: "heal", amount: { dice: "1d8" } }],
        "test:heal",
        beside.actors[PLAYER_ACTOR],
        beside.actors[PLAYER_ACTOR],
        contextOf(run, beside),
      );
      return events.flatMap((event) =>
        event.kind === `${NS}:healed` && "payload" in event
          ? [(event.payload as { amount: number }).amount]
          : [],
      )[0];
    };
    expect(healed({ x: 3, y: 0 })).toBe(3);
    expect(healed({ x: 0, y: 0 })).toBe(1);
  });

  it("intercept a hit on a creature beside them with their owner's Proficiency Bonus", async () => {
    const run = await arena();
    const started = begin(run, solo(owner(run, true)));
    const hero = at(started, PLAYER_ACTOR);
    const state: DndState = {
      ...started,
      actors: {
        ...started.actors,
        [PLAYER_ACTOR]: { ...hero, position: { x: 0, y: 0 } },
        [FAMILIAR]: {
          ...at(started, FAMILIAR),
          position: { x: 0, y: 1 },
        },
        "ambush:goblin-warrior-1": goblin("ambush:goblin-warrior-1", 1),
      },
    };
    const ac = deriveStats(hero, run).ac;
    const goblinStats = deriveStats(at(state, "ambush:goblin-warrior-1"), run);
    const [scimitar] = goblinStats.actions;
    if (scimitar?.activation.resolution.kind !== "attack") {
      throw new Error("No attack");
    }
    // A d20 that just meets the hero's AC.
    const natural =
      ac - attackBonus(scimitar.activation.resolution, goblinStats);
    const dice: Dice = { below: () => 0, roll: () => natural };
    const result = run.system.frames[`${NS}:attackRoll`]?.run(
      {
        attacker: "ambush:goblin-warrior-1",
        actionId: scimitar.id,
        target: PLAYER_ACTOR,
      },
      contextOf(run, state, dice),
    );
    const after = fold(state, result?.events ?? []);
    expect(after.actors[FAMILIAR]?.budget.reaction).toBe(false);
    expect(result?.frames?.some((item) => item.kind === `${NS}:applyHit`)).toBe(
      false,
    );
  });

  it("give their owner Advantage on a proficient skill check, a use at a time", async () => {
    const run = await arena();
    const hero = {
      ...owner(run, true),
      familiar: { form: FORM, hp: 5, maxHp: 5 },
    };
    const [skill] = deriveStats(hero, run).skills;
    let d20s = 0;
    const dice: Dice = {
      below: () => 0,
      roll: (sides) => {
        if (sides === 20) d20s += 1;
        return 10;
      },
    };
    const result = run.system.resolveCheck(
      { skill, dc: 10 },
      contextOf(run, solo(hero), dice),
    );
    expect(d20s).toBe(2);
    expect(result.events?.map((event) => event.kind)).toContain(
      `${NS}:resourceSpent`,
    );
    // Without the familiar, a plain roll.
    d20s = 0;
    run.system.resolveCheck(
      { skill, dc: 10 },
      contextOf(
        run,
        solo({ ...hero, familiar: { ...hero.familiar, hp: 0 } }),
        dice,
      ),
    );
    expect(d20s).toBe(1);
  });
});

function encodeHelp(foe: string): string {
  return `tactic:help|${foe}`;
}
