import {
  PLAYER_ACTOR,
  type SystemContext,
  type SystemEvent,
  storyEffect,
  storyPredicate,
} from "#sdk";
import { z } from "zod";
import { damageToParty, rollSave } from "./combat/effects.ts";
import { finalDamage, halved } from "./rules.ts";
import { AbilitySchema, DamageTypeSchema, DiceSchema } from "./schemas.ts";
import { type Actor, type DndState, NS, dndEvent, isDead } from "./state.ts";
import { damageResponses, rollDiceNotation } from "./stats.ts";

// What a scene does to the party outside a fight: a trap or hazard's damage, and paying for something.

type Context = SystemContext<DndState>;

const SceneDamageSchema = z.strictObject({
  dice: DiceSchema,
  bonus: z.number().int().default(0),
  // How many times the dice hit, as a trap's "1d3 darts, 4d6 each": a number or a roll.
  times: z.union([z.number().int().min(1), DiceSchema]).default(1),
  type: DamageTypeSchema,
  // The player's character, or every living member, as a trap that catches the whole party.
  who: z.enum(["player", "party"]).default("player"),
  save: z
    .strictObject({
      ability: AbilitySchema,
      dc: z.number().int().min(1),
      onSuccess: z.enum(["half", "none"]).default("half"),
    })
    .optional(),
});

function targets(state: DndState, who: "player" | "party"): Actor[] {
  if (who === "player") {
    const player = state.actors[PLAYER_ACTOR];
    return player && !isDead(player) ? [player] : [];
  }
  return Object.values(state.actors).filter(
    (actor) =>
      actor.side === "party" &&
      actor.source.kind === "character" &&
      !isDead(actor),
  );
}

// One roll for everyone it catches, as a trap's damage is rolled once. Each target's save, defenses
// and the difficulty setting then make their own share, and the event carries that final number.
// shortcut: a scene's damage leaves at least 1 HP, as a member downed in a fight gets up after it;
// dying and death outside a fight aren't played. Let it go to 0 once death saves run between fights.
export function sceneDamage(
  args: z.infer<typeof SceneDamageSchema>,
  context: Context,
): SystemEvent[] {
  const events: SystemEvent[] = [];
  const times =
    typeof args.times === "number"
      ? args.times
      : rollDiceNotation(args.times, context.dice);
  let rolled = 0;
  for (let hit = 0; hit < times; hit += 1)
    rolled += Math.max(
      0,
      rollDiceNotation(args.dice, context.dice) + args.bonus,
    );
  for (const target of targets(context.state, args.who)) {
    const save = args.save
      ? rollSave(target, args.save.ability, args.save.dc, context)
      : null;
    if (save) events.push(...save.events);
    const taken = !save?.saved
      ? rolled
      : args.save?.onSuccess === "half"
        ? halved(rolled)
        : 0;
    const defended = finalDamage(
      taken,
      args.type,
      damageResponses(target, context),
    );
    const scaled =
      defended > 0
        ? Math.max(1, Math.round(defended * damageToParty(context.state)))
        : 0;
    const amount = Math.min(scaled, target.tempHp + target.hp - 1);
    if (amount > 0)
      events.push(
        dndEvent(`${NS}:damaged`, {
          actor: target.id,
          amount,
          type: args.type,
          critical: false,
          massive: false,
        }),
      );
  }
  return events;
}

export const sceneEffects = {
  [`${NS}:sceneDamage`]: storyEffect({
    schema: SceneDamageSchema,
    apply: (args, context: Context) => ({ events: sceneDamage(args, context) }),
  }),
  // Takes what the party has, up to the price. Gate the choice with hasGold so a party that can't pay
  // is offered something else.
  [`${NS}:spendGold`]: storyEffect({
    schema: z.strictObject({ gold: z.number().int().min(1) }),
    apply: ({ gold }, context: Context) => {
      const spent = Math.min(gold, context.state.gold ?? 0);
      return spent > 0
        ? { events: [dndEvent(`${NS}:goldSpent`, { gold: spent })] }
        : {};
    },
  }),
};

export const scenePredicates = {
  [`${NS}:hasGold`]: storyPredicate({
    schema: z.strictObject({ atLeast: z.number().int().min(1) }),
    evaluate: ({ atLeast }, state: DndState) => (state.gold ?? 0) >= atLeast,
  }),
};
