import {
  type Dice,
  PLAYER_ACTOR,
  type RestOption,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import {
  type Actor,
  type DndState,
  NS,
  REST_HOURS,
  applyDndEvent,
  dndEvent,
  isDead,
  frame,
} from "./state.ts";
import { HIT_DICE } from "./combat/ids.ts";
import { hitDieHealing, hitDieRoll } from "./trait-rules.ts";
import { gearOptions } from "./gear.ts";
import { familiarFoundEvents } from "./combat/familiar.ts";
import { ClassSchema, type ResourceDef } from "./schemas.ts";
import {
  type Stats,
  deriveStats,
  evaluateFormula,
  lookup,
  modifierFor,
  rollAmount,
  rollDiceNotation,
} from "./stats.ts";

type Context = SystemContext<DndState>;

const SPEND = "spend";
const GEAR = "gear";
const FINISH = "finish";

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

// Marks a creature that ate a Chef's Replenishing Meal this Short Rest. Any rest clears it.
const MEAL = "rest:meal";

// What a party member's Replenishing Meal adds to the first Hit Point Die it spends in a Short Rest, and the mark.
function mealBonus(actor: Actor, context: Context): number {
  if (actor.resourcesSpent[MEAL]) return 0;
  return party(context.state).reduce((most, member) => {
    const stats = deriveStats(member, context);
    return stats.passives.reduce(
      (best, passive) =>
        passive.kind === "restMeal"
          ? Math.max(best, rollAmount(passive.amount, stats, context.dice))
          : best,
      most,
    );
  }, 0);
}

// Each die heals its roll plus the Constitution modifier, and always at least 1.
function spendEvents(
  actor: Actor,
  die: string,
  stats: Stats,
  context: Context,
  withMeal = true,
): readonly SystemEvent[] {
  const meal = withMeal ? mealBonus(actor, context) : 0;
  const rolled =
    hitDieRoll(die, stats, context.dice) + modifierFor(stats, "con");
  return [
    dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource: HIT_DICE }),
    ...(meal > 0
      ? [dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource: MEAL })]
      : []),
    dndEvent(`${NS}:healed`, {
      actor: actor.id,
      amount: Math.min(
        hitDieHealing(Math.max(1, rolled), stats) + meal,
        stats.maxHp - actor.hp,
      ),
      max: stats.maxHp,
    }),
  ];
}

// Companions spend hit dice until healed. The player chooses die by die, below.
export function shortRestEvents(
  context: Context,
  skip?: string,
): SystemEvent[] {
  return Object.values(context.state.actors).flatMap((actor) =>
    actor.id === skip ? [] : diceSpent(actor, context, true),
  );
}

// Marks a creature given a Short Rest's benefits by a spell, which can't give them again until its Long Rest.
export const SHORT_REST_GIVEN = "shortRest:given";

// A Short Rest's benefits for one creature, as Prayer of Healing gives: Hit Dice spent until healed, then what the
// rest restores. The player spends theirs die by die afterwards (`givenDice`), so theirs aren't spent here.
export function shortRestFor(actor: Actor, context: Context): SystemEvent[] {
  if (actor.side !== "party" || isDead(actor)) return [];
  if (actor.resourcesSpent[SHORT_REST_GIVEN]) return [];
  const spent = actor.id === PLAYER_ACTOR ? [] : diceSpent(actor, context);
  const after = spent.reduce(applyDndEvent, context.state).actors[actor.id];
  const stats = deriveStats(actor, context);
  return [
    ...spent,
    dndEvent(`${NS}:rested`, {
      actor: actor.id,
      rest: "short",
      maxHp: stats.maxHp,
      resourcesSpent: recovered(
        (after ?? actor).resourcesSpent,
        stats,
        "short",
      ),
    }),
    dndEvent(`${NS}:resourceSpent`, {
      actor: actor.id,
      resource: SHORT_REST_GIVEN,
    }),
  ];
}

// With `meal`, in a real Short Rest, where a Chef's Replenishing Meal adds to the first die.
function diceSpent(
  actor: Actor,
  context: Context,
  meal = false,
): SystemEvent[] {
  {
    if (actor.side !== "party" || isDead(actor)) return [];
    if (actor.source.kind !== "character" || !actor.source.build) return [];
    const stats = deriveStats(actor, context);
    const events: SystemEvent[] = [];
    let { hp } = actor;
    let extra = meal ? mealBonus(actor, context) : 0;
    for (const { classId } of actor.source.build.levels.slice(
      actor.resourcesSpent[HIT_DICE] ?? 0,
    )) {
      if (hp >= stats.maxHp) break;
      const die = lookup(context, ClassSchema, classId).hitDie;
      const rolled = hitDieRoll(die, stats, context.dice);
      const amount = Math.min(
        hitDieHealing(Math.max(1, rolled + modifierFor(stats, "con")), stats) +
          extra,
        stats.maxHp - hp,
      );
      hp += amount;
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: HIT_DICE,
        }),
        ...(extra > 0
          ? [
              dndEvent(`${NS}:resourceSpent`, {
                actor: actor.id,
                resource: MEAL,
              }),
            ]
          : []),
        dndEvent(`${NS}:healed`, { actor: actor.id, amount, max: stats.maxHp }),
      );
      extra = 0;
    }
    return events;
  }
}

// Dice are spent in level order, so a multiclass character's dice stay in step with shortRestEvents.
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

const GIVEN = "given";

// The player spends Hit Dice a spell's Short Rest gave them, die by die, as in a Short Rest of their own.
function runGivenDice(context: Context): SystemResult {
  const player = context.state.actors[PLAYER_ACTOR];
  if (!player) return {};
  const stats = deriveStats(player, context);
  if (!canSpend(player, stats)) return {};
  const left = stats.level - (player.resourcesSpent[HIT_DICE] ?? 0);
  return {
    frames: [
      awaitDecision({
        id: `${NS}:givenDice:${String(left)}`,
        actor: player.id,
        prompt: `You have ${String(player.hp)} of ${String(stats.maxHp)} HP and ${String(left)} Hit Dice left.`,
        options: [
          { id: SPEND, label: `Spend a Hit Die (${nextDie(player, context)})` },
          { id: GIVEN, label: "Keep the rest" },
        ],
        resume: frame("givenDiceAnswer"),
      }),
    ],
  };
}

function runGivenDiceAnswer(
  { answer }: z.infer<typeof AnswerSchema>,
  context: Context,
): SystemResult {
  const player = context.state.actors[PLAYER_ACTOR];
  if (answer !== SPEND || !player) return {};
  return {
    events: spendEvents(
      player,
      nextDie(player, context),
      deriveStats(player, context),
      context,
      false,
    ),
    frames: [frame("givenDice")],
  };
}

function runCompanionsSpend(context: Context): SystemResult {
  return {
    events: shortRestEvents(context, PLAYER_ACTOR),
    frames: [frame("finishRest", { rest: "short" })],
  };
}

// The most uses of a resource, a slot level ("slot:<level>") or all spell slots ("slots").
function maxUses(resource: string, stats: Stats): number {
  if (resource === "slots") return stats.slots.reduce((sum, n) => sum + n, 0);
  if (resource.startsWith("slot:")) {
    return stats.slots[Number(resource.slice(5)) - 1] ?? 0;
  }
  return stats.resources[resource] ?? 0;
}

function slotKeys(stats: Stats): string[] {
  return stats.slots.map((_, index) => `slot:${String(index + 1)}`).reverse();
}

// Whether there's anything spent for a `regain` effect to give back.
export function canRegain(
  actor: Actor,
  resource: string,
  stats: Stats,
): boolean {
  const keys = resource === "slots" ? slotKeys(stats) : [resource];
  return keys.some((key) => (actor.resourcesSpent[key] ?? 0) > 0);
}

// A `regain` effect: spent uses back, at most `count`, half the most rounded up, or all; for "slots", slots of
// any level, the highest first.
export function regainEvents(
  actor: Actor,
  resource: string,
  count: number | "half" | "all",
  stats: Stats,
): SystemEvent[] {
  let left =
    count === "all"
      ? Infinity
      : count === "half"
        ? Math.ceil(maxUses(resource, stats) / 2)
        : count;
  return (resource === "slots" ? slotKeys(stats) : [resource]).flatMap(
    (key) => {
      const amount = Math.min(left, actor.resourcesSpent[key] ?? 0);
      left -= amount;
      return amount > 0
        ? [
            dndEvent(`${NS}:resourceRestored`, {
              actor: actor.id,
              resource: key,
              amount,
            }),
          ]
        : [];
    },
  );
}

type Recharge = ResourceDef["recharge"][number];

// How many spent uses a recharge gives back: its amount, no more than are spent, nor than leave `upTo` unspent.
export function rechargeAmount(
  entry: Recharge,
  spent: number,
  max: number,
  stats: Stats,
): number {
  const { amount, upTo } = entry;
  const back =
    amount === "all"
      ? spent
      : typeof amount === "number"
        ? amount
        : evaluateFormula(amount, stats);
  const room = upTo === undefined ? spent : upTo - (max - spent);
  return Math.max(0, Math.min(back, spent, room));
}

// A recharge's amount with a roll added to it.
function addedAmount(
  amount: Recharge["amount"],
  rolled: number,
): Recharge["amount"] {
  if (rolled === 0 || amount === "all") return amount;
  return typeof amount === "number"
    ? amount + rolled
    : { ...amount, base: amount.base + rolled };
}

// Whether a recharge with `uses` has that resource's use to spend.
export function canUse(
  entry: Recharge,
  spent: (id: string) => number,
  stats: Stats,
): boolean {
  return (
    entry.uses === undefined ||
    spent(entry.uses) < (stats.resources[entry.uses] ?? 0)
  );
}

// With `dice`, a recharge's `roll` is rolled and added, as a wand's 1d6 + 1 charges at dawn. The rested event
// carries what came back, so a save replays the roll.
export function recovered(
  spent: Actor["resourcesSpent"],
  stats: Stats,
  rest: "short" | "long",
  dice?: Dice,
): Actor["resourcesSpent"] {
  const left = new Map(Object.entries(spent));
  const used = (id: string): number => left.get(id) ?? 0;
  for (const key of left.keys()) {
    const slot = key.startsWith("slot:");
    const daily = key === HIT_DICE || key === SHORT_REST_GIVEN;
    if (
      key === MEAL ||
      (rest === "long" ? slot || daily : slot && stats.pactMagic)
    ) {
      left.set(key, 0);
    }
  }
  for (const { id, recharge } of stats.resourceDefs) {
    for (const entry of recharge) {
      const { on } = entry;
      // shortcut: there's no clock, so dawn comes with a Long Rest.
      // A once-a-turn use left spent when a fight ended comes back with any rest, and a Short Rest's with a Long one.
      const applies =
        entry.uses === undefined
          ? on === "turnStart" || on === "shortRest" || rest === "long"
          : on === (rest === "long" ? "longRest" : "shortRest");
      if (!applies || !canUse(entry, used, stats) || used(id) === 0) continue;
      // Cauldron of Rebirth's 7 days: only once that many have passed since the use was spent.
      if (entry.every) {
        const waited = `${id}:waited`;
        if (used(waited) + 1 < entry.every) {
          left.set(waited, used(waited) + 1);
          continue;
        }
        left.set(waited, 0);
      }
      const rolled =
        entry.roll && dice ? rollDiceNotation(entry.roll, dice) : 0;
      const back = rechargeAmount(
        { ...entry, amount: addedAmount(entry.amount, rolled) },
        used(id),
        stats.resources[id] ?? 0,
        stats,
      );
      left.set(id, used(id) - back);
      if (entry.uses !== undefined && back > 0) {
        left.set(entry.uses, used(entry.uses) + 1);
      }
    }
  }
  if (rest === "short") recoverSlots(left, stats);
  return Object.fromEntries([...left].filter(([, value]) => value > 0));
}

// Arcane Recovery and the like: spent slots back, highest first, while their levels fit the budget.
// shortcut: the slots are picked for the player, the highest that fit, which is what's nearly always best.
function recoverSlots(left: Map<string, number>, stats: Stats): void {
  for (const passive of stats.passives) {
    if (passive.kind !== "slotRecovery") continue;
    const { resource } = passive;
    if ((left.get(resource) ?? 0) >= (stats.resources[resource] ?? 0)) continue;
    let budget = evaluateFormula(passive.levels, stats);
    let recovered = false;
    for (let level = Math.min(5, stats.slots.length); level >= 1; level -= 1) {
      const key = `slot:${String(level)}`;
      while ((left.get(key) ?? 0) > 0 && level <= budget) {
        left.set(key, (left.get(key) ?? 0) - 1);
        budget -= level;
        recovered = true;
      }
    }
    if (recovered) left.set(resource, (left.get(resource) ?? 0) + 1);
  }
}

// The Scarlet Spellbook's Arcane Stamina: healing as slots are recovered in a Short Rest.
function recoveryHeal(
  actor: Actor,
  after: Actor["resourcesSpent"],
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const used = stats.passives.some(
    (passive) =>
      passive.kind === "slotRecovery" &&
      (after[passive.resource] ?? 0) >
        (actor.resourcesSpent[passive.resource] ?? 0),
  );
  if (!used) return [];
  const amount = stats.passives.reduce(
    (sum, passive) =>
      passive.kind === "recoveryHeal"
        ? sum + rollAmount(passive.amount, stats, context.dice)
        : sum,
    0,
  );
  const healed = Math.min(amount, stats.maxHp - actor.hp);
  return healed > 0
    ? [
        dndEvent(`${NS}:healed`, {
          actor: actor.id,
          amount: healed,
          max: stats.maxHp,
        }),
      ]
    : [];
}

// A Long Rest is as long as its slowest member's: 8 hours, or less for a party all with Trance or the like.
function longRestHours(members: readonly Actor[], context: Context): number {
  return Math.max(
    ...members.map((actor) =>
      deriveStats(actor, context).passives.reduce<number>(
        (hours, passive) =>
          passive.kind === "restHours" ? Math.min(hours, passive.hours) : hours,
        REST_HOURS.long,
      ),
    ),
  );
}

const FinishSchema = z.object({ rest: z.enum(["short", "long"]) });

function runFinishRest(
  { rest }: z.infer<typeof FinishSchema>,
  context: Context,
): SystemResult {
  const members = party(context.state);
  const hours =
    rest === "long" ? longRestHours(members, context) : REST_HOURS.short;
  return {
    events: [
      ...members.flatMap((actor) => {
        // A Long Rest gives back the Hit Point maximum Harm took, so it heals to the whole of it.
        const stats = deriveStats(
          rest === "long" ? { ...actor, maxHpLoss: 0 } : actor,
          context,
        );
        const resourcesSpent = recovered(
          actor.resourcesSpent,
          stats,
          rest,
          context.dice,
        );
        return [
          dndEvent(`${NS}:rested`, {
            actor: actor.id,
            rest,
            maxHp: stats.maxHp,
            resourcesSpent,
          }),
          ...(rest === "short"
            ? recoveryHeal(actor, resourcesSpent, stats, context)
            : []),
        ];
      }),
      ...restInspiration(members, rest, context),
      ...(rest === "long" ? restItems(members, context) : []),
      ...familiarFoundEvents(members, context, rest),
      dndEvent(`${NS}:restFinished`, {
        rest,
        ...(hours < REST_HOURS[rest] ? { hours } : {}),
      }),
    ],
  };
}

// Decanting: a Long Rest leaves the bearer one of the item, put in its pack.
// shortcut: the last one doesn't evaporate; one already carried, made or bought, is simply kept.
function restItems(members: readonly Actor[], context: Context): SystemEvent[] {
  return members.flatMap((actor) =>
    deriveStats(actor, context).passives.flatMap((passive) =>
      passive.kind === "restItem" &&
      context.content(passive.item) &&
      !actor.inventory.includes(passive.item)
        ? [
            dndEvent(`${NS}:treasureFound`, {
              actor: actor.id,
              gold: 0,
              items: [passive.item],
              stowed: [passive.item],
            }),
          ]
        : [],
    ),
  );
}

// shortcut: Musician inspires every ally, not a number equal to the Proficiency Bonus.
function restInspiration(
  members: readonly Actor[],
  rest: "short" | "long",
  context: Context,
): SystemEvent[] {
  const inspired = new Set<string>();
  for (const actor of members) {
    for (const passive of deriveStats(actor, context).passives) {
      if (passive.kind !== "restInspiration" || !passive.rests.includes(rest))
        continue;
      for (const other of passive.allies
        ? members.filter((item) => item.id !== actor.id)
        : [actor]) {
        inspired.add(other.id);
      }
    }
  }
  return [
    ...[...inspired].map((actor) =>
      dndEvent(`${NS}:inspirationGranted`, { actor }),
    ),
    ...restTempHp(members, rest, context),
    ...(rest === "short"
      ? members.flatMap((actor) =>
          actor.exhaustion > 0 &&
          deriveStats(actor, context).passives.some(
            (passive) => passive.kind === "restExhaustion",
          )
            ? [
                dndEvent(`${NS}:exhaustionChanged`, {
                  actor: actor.id,
                  levels: -1,
                }),
              ]
            : [],
        )
      : []),
  ];
}

// Temporary Hit Points as a rest ends, as with Inspiring Leader. They don't stack, so the most is kept.
function restTempHp(
  members: readonly Actor[],
  rest: "short" | "long",
  context: Context,
): SystemEvent[] {
  const best = new Map<string, number>();
  for (const actor of members) {
    const stats = deriveStats(actor, context);
    for (const passive of stats.passives) {
      if (passive.kind !== "restTempHp" || !passive.rests.includes(rest)) {
        continue;
      }
      for (const other of passive.allies ? members : [actor]) {
        const amount = evaluateFormula(
          other === actor
            ? passive.amount
            : (passive.alliesAmount ?? passive.amount),
          stats,
        );
        best.set(other.id, Math.max(best.get(other.id) ?? 0, amount));
      }
    }
  }
  return [...best].flatMap(([actor, amount]) =>
    amount > 0 ? [dndEvent(`${NS}:tempHpGained`, { actor, amount })] : [],
  );
}

// A Ring of Regeneration's Hit Points over a Short Rest's hour, before Hit Dice are spent: its dice for every so many
// minutes of it, for a creature with at least 1 Hit Point.
function regenerated(
  members: readonly Actor[],
  context: Context,
): SystemEvent[] {
  return members.flatMap((actor) => {
    if (actor.hp < 1) return [];
    const stats = deriveStats(actor, context);
    const amount = stats.passives.reduce(
      (total, passive) =>
        passive.kind === "slowRegeneration"
          ? total +
            rollDiceNotation(
              passive.dice,
              context.dice,
              Math.floor((REST_HOURS.short * 60) / passive.minutes),
            )
          : total,
      0,
    );
    const healed = Math.min(amount, stats.maxHp - actor.hp);
    return healed > 0
      ? [
          dndEvent(`${NS}:healed`, {
            actor: actor.id,
            amount: healed,
            max: stats.maxHp,
          }),
        ]
      : [];
  });
}

const DAY_HOURS = 24;

// Out of combat a Short Rest is always possible, and so is a Long Rest: a party within a day of its last one
// waits out the hours left first, as the rule allows one Long Rest in 24 hours. Nothing else passes time, so
// the wait costs only what the hours themselves do.
export function availableRests(state: DndState): readonly RestOption[] {
  if (state.combat) return [];
  const wait = Math.max(0, DAY_HOURS - (state.sinceLongRest ?? DAY_HOURS));
  return [
    {
      id: "short",
      label: `Short rest (${String(REST_HOURS.short)} hour)`,
      detail: "Spend Hit Dice to heal",
      effect: `${NS}:shortRest`,
    },
    {
      id: "long",
      label:
        wait > 0
          ? `Long rest (wait ${String(wait)} hour${wait === 1 ? "" : "s"}, then ${String(REST_HOURS.long)})`
          : `Long rest (${String(REST_HOURS.long)} hours)`,
      detail: "Restore HP, Hit Dice and spell slots",
      effect: `${NS}:longRest`,
    },
  ];
}

export const restEffects = {
  [`${NS}:shortRest`]: storyEffect({
    schema: z.strictObject({}),
    apply: (_args, context: Context) => ({
      events: regenerated(party(context.state), context),
      frames: [frame("shortRestStep")],
    }),
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
  [`${NS}:givenDice`]: frameHandler({
    schema: z.object({}),
    run: (_payload, context: Context) => runGivenDice(context),
  }),
  [`${NS}:givenDiceAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runGivenDiceAnswer,
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
