import {
  type Frame,
  PLAYER_ACTOR,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import { type Actor, type DndState, NS, dndEvent, isDead } from "./state.ts";
import { HIT_DICE, shortRestEvents } from "./combat.ts";
import { gearOptions } from "./gear.ts";
import { ClassSchema } from "./schemas.ts";
import {
  type Stats,
  deriveStats,
  lookup,
  modifierFor,
  rollDiceNotation,
} from "./stats.ts";

type Context = SystemContext<DndState>;

const SPEND = "spend";
const GEAR = "gear";
const FINISH = "finish";

function frame(
  kind: string,
  payload: Readonly<Record<string, unknown>> = {},
): Frame {
  return { kind: `${NS}:${kind}`, payload };
}

function party(state: DndState): readonly Actor[] {
  return Object.values(state.actors).filter(
    (actor) => actor.side === "party" && !isDead(actor),
  );
}

function canSpend(actor: Actor, stats: Stats): boolean {
  return (
    (actor.resourcesSpent[HIT_DICE] ?? 0) < stats.level &&
    actor.hp < stats.maxHp
  );
}

// Each die heals its roll plus the Constitution modifier, and always at least 1.
function spendEvents(
  actor: Actor,
  die: string,
  stats: Stats,
  context: Context,
): readonly SystemEvent[] {
  const rolled =
    rollDiceNotation(`1${die}`, context.dice) + modifierFor(stats, "con");
  return [
    dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource: HIT_DICE }),
    dndEvent(`${NS}:healed`, {
      actor: actor.id,
      amount: Math.min(Math.max(1, rolled), stats.maxHp - actor.hp),
      max: stats.maxHp,
    }),
  ];
}

// Dice are spent in level order, so a multiclass character's dice stay in step with the combat.ts short rest.
function nextDie(player: Actor, context: Context): string {
  const { source } = player;
  const spent = player.resourcesSpent[HIT_DICE] ?? 0;
  const entry =
    source.kind === "character" ? source.build?.levels[spent] : null;
  if (!entry) throw new Error(`${player.id} has no Hit Die left`);
  return lookup(context, ClassSchema, entry.classId).hitDie;
}

function runShortRestStep(context: Context): SystemResult {
  const player = context.state.actors[PLAYER_ACTOR];
  if (!player) throw new Error("The player has no character");
  const stats = deriveStats(player, context);
  const spend = canSpend(player, stats);
  // A Short Rest is also the time to attune to a magic item or put on found gear. Worn gear alone, which
  // could only be stowed, isn't worth asking about.
  const gear = gearOptions(player, context).some(
    (option) => !option.id.startsWith("stow:"),
  );
  if (!spend && !gear) return { frames: [frame("companionsSpend")] };
  const left = stats.level - (player.resourcesSpent[HIT_DICE] ?? 0);
  return {
    frames: [
      awaitDecision({
        id: `${NS}:shortRest:${String(left)}`,
        actor: player.id,
        prompt: `You rest with ${String(player.hp)} of ${String(stats.maxHp)} HP and ${String(left)} Hit Dice left.`,
        options: [
          ...(spend
            ? [
                {
                  id: SPEND,
                  label: `Spend a Hit Die (${nextDie(player, context)})`,
                },
              ]
            : []),
          { id: FINISH, label: "Finish resting" },
          // Last, so a player who always takes the first choice still finishes the rest.
          ...(gear ? [{ id: GEAR, label: "Change gear" }] : []),
        ],
        resume: frame("shortRestAnswer"),
      }),
    ],
  };
}

const AnswerSchema = z.object({ answer: z.string() });

function runShortRestAnswer(
  { answer }: z.infer<typeof AnswerSchema>,
  context: Context,
): SystemResult {
  if (answer === GEAR) {
    return {
      frames: [frame("gearStep", { step: 0 }), frame("shortRestStep")],
    };
  }
  if (answer !== SPEND) return { frames: [frame("companionsSpend")] };
  const player = context.state.actors[PLAYER_ACTOR];
  if (!player) throw new Error("The player has no character");
  return {
    events: spendEvents(
      player,
      nextDie(player, context),
      deriveStats(player, context),
      context,
    ),
    frames: [frame("shortRestStep")],
  };
}

function runCompanionsSpend(context: Context): SystemResult {
  return {
    events: shortRestEvents(context, PLAYER_ACTOR),
    frames: [frame("finishRest", { rest: "short" })],
  };
}

function recovered(
  spent: Actor["resourcesSpent"],
  stats: Stats,
  rest: "short" | "long",
): Actor["resourcesSpent"] {
  const left = new Map(Object.entries(spent));
  for (const key of left.keys()) {
    const slot = key.startsWith("slot:");
    if (rest === "long" ? slot || key === HIT_DICE : slot && stats.pactMagic) {
      left.set(key, 0);
    }
  }
  for (const { id, recharge } of stats.resourceDefs) {
    for (const { on, amount } of recharge) {
      // shortcut: there's no clock, so dawn comes with a Long Rest.
      const applies =
        rest === "short"
          ? on === "shortRest"
          : on === "longRest" || on === "dawn";
      if (applies) {
        left.set(id, amount === "all" ? 0 : (left.get(id) ?? 0) - amount);
      }
    }
  }
  return Object.fromEntries([...left].filter(([, value]) => value > 0));
}

const FinishSchema = z.object({ rest: z.enum(["short", "long"]) });

function runFinishRest(
  { rest }: z.infer<typeof FinishSchema>,
  context: Context,
): SystemResult {
  return {
    events: party(context.state).map((actor) => {
      const stats = deriveStats(actor, context);
      return dndEvent(`${NS}:rested`, {
        actor: actor.id,
        rest,
        maxHp: stats.maxHp,
        resourcesSpent: recovered(actor.resourcesSpent, stats, rest),
      });
    }),
  };
}

export const restEffects = {
  [`${NS}:shortRest`]: storyEffect({
    schema: z.strictObject({}),
    apply: (_args, _context: Context) => ({ frames: [frame("shortRestStep")] }),
  }),
  [`${NS}:longRest`]: storyEffect({
    schema: z.strictObject({}),
    apply: (_args, _context: Context) => ({
      frames: [frame("finishRest", { rest: "long" })],
    }),
  }),
};

export const restFrames = {
  [`${NS}:shortRestStep`]: frameHandler({
    schema: z.object({}),
    run: (_payload, context: Context) => runShortRestStep(context),
  }),
  [`${NS}:shortRestAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runShortRestAnswer,
  }),
  [`${NS}:companionsSpend`]: frameHandler({
    schema: z.object({}),
    run: (_payload, context: Context) => runCompanionsSpend(context),
  }),
  [`${NS}:finishRest`]: frameHandler({
    schema: FinishSchema,
    run: runFinishRest,
  }),
};
