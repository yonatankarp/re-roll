import { type Actor, hasCondition, isDown, NS } from "./state.ts";
import { deriveStats, type KnownAction, rollAmount } from "./stats.ts";
import {
  distanceFeet,
  rangeFeet,
  parseSquare,
  reachableSquares,
  type Square,
  squareKey,
} from "./grid.ts";
import { coverBonus, coverFor, difficultSquares } from "./sight.ts";
import { type Decision } from "#sdk";
import { ADD, AIM_AREA, BACK, CONFIRM, nextPick, PICK } from "./targeting.ts";
import { chooseBossAction, FLEE } from "./legendary.ts";
import { DECLINE, MOVE, parseOption, STAY } from "./combat/ids.ts";
import { changed, gearOptions } from "./gear.ts";
import {
  actorOf,
  aimsFor,
  allies,
  attackRoutine,
  canAfford,
  type Context,
  enemies,
  findAction,
  inReach,
  moveSquares,
  slotLevelFor,
  spellSource,
  targetCount,
} from "./combat/queries.ts";
import { AimSchema, PickSchema } from "./combat/actions.ts";
import { multiattackExtras } from "./combat/effects.ts";
import { AVERAGE, makeJudge } from "./worth.ts";
import { TACTIC } from "./tactics.ts";

// The Dodge action (actions.ts), which the party weighs like any other choice.
const DODGE = `${TACTIC}dodge`;

// How companions and monsters choose in a fight, and how the bot plays the player.

function hpFraction(actor: Actor, context: Context): number {
  return actor.hp / deriveStats(actor, context).maxHp;
}

// Simple, predictable tactics, so non-player characters never need a model: heal, attack the weakest, react when it helps.
// Where a creature should step to: within reach of the nearest foe it can hurt, by the shortest walk.
// Null when no square gets it any closer than it is.
export function stepToward(actor: Actor, context: Context): Square | null {
  const { state } = context;
  const stats = deriveStats(actor, context);
  if (!actor.position) return null;
  // A Concentration spell it's still holding someone with doesn't count, as it won't be cast again.
  const holding = holdingConcentration(actor, context);
  const offensive = stats.actions.filter(
    (action) =>
      !action.activation.trigger &&
      "side" in action.activation.targeting &&
      action.activation.targeting.side === "enemy" &&
      canAfford(action, actor, stats) &&
      !(holding && concentrates(action)),
  );
  if (offensive.length === 0) return null;
  const reach = Math.max(
    ...offensive.map((action) => {
      const { targeting } = action.activation;
      return "area" in targeting && targeting.range === "self"
        ? targeting.area.radius
        : "range" in targeting
          ? rangeFeet(targeting.range)
          : 0;
    }),
  );
  const foes = enemies(state, actor).filter(
    (item) => !isDown(item) && item.position,
  );
  // How far it is to walk from a square to a foe, round walls and through difficult terrain, ignoring
  // creatures. On a map with no walls that's the straight distance.
  const { grid, walls = [] } = state.combat ?? {};
  const walkFrom = new Map<string, ReadonlyMap<string, number>>();
  const walk = (from: Square | null, foe: Actor): number => {
    if (!grid || walls.length === 0 || !from || !foe.position) {
      return distanceFeet(from, foe.position);
    }
    let field = walkFrom.get(foe.id);
    if (!field) {
      field = new Map(
        reachableSquares(
          foe.position,
          Infinity,
          grid,
          new Set(walls),
          new Set(),
          difficultSquares(state),
        ).map((item) => [squareKey(item.square), item.feet]),
      );
      walkFrom.set(foe.id, field);
    }
    return field.get(squareKey(from)) ?? Infinity;
  };
  // In reach with a clear line is 0. Out of range, it's the walk still to go. A foe in range but behind
  // total cover counts the whole walk, so the creature goes round the wall until it has a line.
  const gap = (from: Square | null): number =>
    Math.min(
      ...foes.map((foe) => {
        const distance = distanceFeet(from, foe.position);
        if (distance > reach) return Math.max(0, walk(from, foe) - reach);
        return coverFor(state, from, foe, [actor.id]) === "total"
          ? walk(from, foe)
          : 0;
      }),
    );
  if (foes.length === 0) return null;
  const now = gap(actor.position);
  const gaps = new Map(
    moveSquares(actor, state, stats).map((item) => [item, gap(item.square)]),
  );
  const squares = [...gaps.keys()];
  const closest = Math.min(...gaps.values());
  if (squares.length === 0 || closest >= now) return null;
  // Of the squares that get it closest, the one off difficult terrain and nearest. One that fights from range
  // also wants the most cover from its foes; a melee creature is going up to them anyway.
  const difficult = difficultSquares(state);
  const ranged = reach > 10;
  const ranked = squares
    .filter((item) => gaps.get(item) === closest)
    .map((item) => ({
      ...item,
      cover: ranged
        ? foes.reduce(
            (sum, foe) =>
              sum +
              coverBonus(
                coverFor(
                  state,
                  foe.position,
                  { ...actor, position: item.square },
                  [foe.id],
                ),
              ),
            0,
          )
        : 0,
      rough: Number(difficult.has(squareKey(item.square))),
    }))
    .sort((a, b) => b.cover - a.cover || a.rough - b.rough || a.feet - b.feet);
  return ranked[0]?.square ?? null;
}

function heals(action: KnownAction): boolean {
  return (
    action.activation.resolution.kind === "automatic" &&
    action.activation.resolution.effects.some((item) => item.kind === "heal")
  );
}

function slotsLeft(
  actor: Actor,
  stats: ReturnType<typeof deriveStats>,
): number {
  return stats.slots.reduce(
    (total, count, index) =>
      total +
      Math.max(
        0,
        count - (actor.resourcesSpent[`slot:${String(index + 1)}`] ?? 0),
      ),
    0,
  );
}

function leavesOf(action: KnownAction) {
  const { resolution } = action.activation;
  return resolution.kind === "automatic"
    ? resolution.effects
    : resolution.kind === "save"
      ? resolution.onFail
      : resolution.onHit;
}

// Whether a step to `square` would bring a foe into reach of something harmful the actor can still afford.
export function reachesFrom(
  actor: Actor,
  square: Square,
  context: Context,
): boolean {
  const stats = deriveStats(actor, context);
  const moved = { ...actor, position: square };
  return stats.actions.some(
    (action) =>
      !action.activation.trigger &&
      "side" in action.activation.targeting &&
      action.activation.targeting.side === "enemy" &&
      canAfford(action, actor, stats) &&
      inReach(action, moved, context.state, context).length > 0,
  );
}

// The teleport or jump an action makes, if it does.
export function moveOf(action: KnownAction) {
  const { resolution } = action.activation;
  return resolution.kind === "automatic"
    ? resolution.effects.find((item) => item.kind === "teleport")
    : undefined;
}

// A save that comes with a hit, or a condition left by an action that deals no damage.
function weighed(action: KnownAction): boolean {
  const { resolution } = action.activation;
  if (resolution.kind === "attack" && resolution.onHitSave) return true;
  return (
    !("damage" in resolution && resolution.damage.length > 0) &&
    leavesOf(action).some((item) => item.kind === "applyCondition")
  );
}

function concentrates(action: KnownAction): boolean {
  return leavesOf(action).some(
    (item) =>
      "duration" in item &&
      typeof item.duration === "object" &&
      "concentration" in item.duration,
  );
}

// Whether something the actor concentrates on is still on anyone, so a new Concentration spell would end it.
function holdingConcentration(actor: Actor, context: Context): boolean {
  const spell = actor.concentratingOn;
  return (
    spell !== null &&
    Object.values(context.state.actors).some(
      (item) =>
        !isDown(item) &&
        item.activeEffects.some(
          (effect) => effect.sourceId === spell && effect.casterId === actor.id,
        ),
    )
  );
}

interface Parsed {
  readonly option: Decision["options"][number];
  readonly action: KnownAction;
  readonly targetId: string;
  readonly slot: string | undefined;
}

// A party member's turn, played as a sensible player would: every choice is weighed by worth.ts, and the
// Action and Bonus Action are planned together, as only one of them may spend a spell slot in a turn.
// Null when nothing is worth doing.
function partyChoice(
  parsed: readonly Parsed[],
  offered: Decision["options"],
  actor: Actor,
  context: Context,
): string | null {
  const judge = makeJudge(context, actor);
  const stats = deriveStats(actor, context);
  const fresh = actor.budget.action && actor.budget.bonusAction;
  // A healer keeps its last slot to bring someone back.
  const lastSlot =
    slotsLeft(actor, stats) <= 1 &&
    stats.actions.some(
      (action) => (action.spellLevel ?? 0) > 0 && heals(action),
    );
  const holding = holdingConcentration(actor, context);
  // A caster about to drop gets more from damage now than from a spell it won't keep.
  const shaky = actor.hp < 0.4 * stats.maxHp;
  const scored = parsed.flatMap((item) => {
    const { action, targetId, slot } = item;
    if (action.activation.trigger) return [];
    const slotted = action.activation.cost.includes("slot");
    if (slotted && (!fresh || (lastSlot && !heals(action)))) return [];
    const lasting = concentrates(action);
    if (lasting && holding) return [];
    // Choosing targets one by one must find someone, or the choice would only come back here.
    if (
      targetId === PICK &&
      pickNext(actor, action.id, slot, [], context) === null
    ) {
      return [];
    }
    const worth =
      judge.worth(actor, action.id, targetId, slot) *
      (lasting && shaky ? 0.5 : 1);
    const { cost } = action.activation;
    const uses = cost.includes("action")
      ? "action"
      : cost.includes("bonusAction")
        ? "bonusAction"
        : "free";
    return worth > 0 ? [{ id: item.option.id, worth, slotted, uses }] : [];
  });
  const dodge = offered.some((option) => option.id === DODGE)
    ? judge.dodgeWorth(actor)
    : 0;
  if (dodge > 0) {
    scored.push({ id: DODGE, worth: dodge, slotted: false, uses: "action" });
  }
  type Scored = (typeof scored)[number];
  const best = (list: readonly Scored[]): Scored | undefined =>
    [...list].sort((a, b) => b.worth - a.worth)[0];
  const actions = scored.filter((item) => item.uses === "action");
  const bonuses = scored.filter((item) => item.uses === "bonusAction");
  const free = best(scored.filter((item) => item.uses === "free"));
  if (free) return free.id;
  if (!fresh) return best(scored)?.id ?? null;
  // Either the Action spends the slot or the Bonus Action does, never both.
  const plans = [
    [best(actions), best(bonuses.filter((item) => !item.slotted))],
    [best(actions.filter((item) => !item.slotted)), best(bonuses)],
  ] as const;
  const total = ([main, bonus]: (typeof plans)[number]): number =>
    (main?.worth ?? 0) + (bonus?.worth ?? 0);
  const [main, bonus] =
    total(plans[0]) >= total(plans[1]) ? plans[0] : plans[1];
  // The slot first, so the other half can't take it; otherwise the Bonus Action, such as a mark, before the Attack.
  if (main?.slotted) return main.id;
  return (bonus ?? main)?.id ?? null;
}

// Who a sensible caster adds next, or null when it should cast.
function pickNext(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  picked: readonly string[],
  context: Context,
): string | null {
  const slotLevel = slotLevelFor(actor, actionId, slot, context);
  const action = findAction(actor, actionId, context, slotLevel);
  const { projectiles, resolution } = action.activation;
  const stats = deriveStats(actor, context);
  // Average dice, for how many darts a creature takes to drop.
  const average = { below: () => 0, roll: (sides: number) => (sides + 1) / 2 };
  const perHit =
    "damage" in resolution
      ? resolution.damage.reduce(
          (total, { amount }) => total + rollAmount(amount, stats, average),
          0,
        )
      : 0;
  return nextPick(
    inReach(action, actor, context.state, context),
    picked,
    targetCount(findAction(actor, actionId, context), slotLevel),
    projectiles !== undefined,
    { sourceId: spellSource(action), perHit },
  );
}

// Picks targets one at a time as a sensible caster would, then casts.
function pickPolicy(
  decision: Decision,
  actor: Actor,
  context: Context,
): string {
  const { actionId, slot, picked } = PickSchema.omit({ answer: true }).parse(
    decision.resume.payload,
  );
  const next = pickNext(actor, actionId, slot, picked, context);
  if (next !== null) return `${ADD}${next}`;
  return decision.options.some((option) => option.id === CONFIRM)
    ? CONFIRM
    : BACK;
}

export function choosePolicy(decision: Decision, context: Context): string {
  const { state } = context;
  const [first] = decision.options;
  if (!first) throw new Error(`${decision.id} has no options`);
  if (decision.id.startsWith(`${NS}:reaction:`)) return first.id;
  if (decision.id.startsWith(`${NS}:inspiration:`)) return first.id;
  if (decision.id.startsWith(`${NS}:deathSave:`)) return first.id;
  if (/^dnd5\.5e:(legendary|lair):/.test(decision.id)) {
    return chooseBossAction(decision, context);
  }

  const actor = actorOf(state, decision.actor);
  if (decision.id.startsWith(`${NS}:moveTo:`)) {
    const square = stepToward(actor, context);
    return square ? squareKey(square) : STAY;
  }
  // A teleport or jump lands where a foe is in reach, nearest one first, as its options are listed.
  if (decision.id.startsWith(`${NS}:teleportTo:`)) {
    const landing = decision.options.find((option) => {
      const square = parseSquare(option.id);
      return square !== null && reachesFrom(actor, square, context);
    });
    return landing?.id ?? STAY;
  }
  if (decision.id.startsWith(`${NS}:targets:`)) {
    return pickPolicy(decision, actor, context);
  }
  if (decision.id.startsWith(`${NS}:aim:`)) {
    const { actionId } = AimSchema.omit({ answer: true }).parse(
      decision.resume.payload,
    );
    const [best] = aimsFor(
      findAction(actor, actionId, context),
      actor,
      context,
    );
    return best && best.score > 0 ? squareKey(best.square) : BACK;
  }
  const stats = deriveStats(actor, context);
  // Only the player is offered flight. Run when the enemies left clearly outlast the party.
  if (decision.options.some((option) => option.id === FLEE)) {
    const standing = (list: readonly Actor[]): number =>
      list
        .filter((item) => !isDown(item))
        .reduce((sum, item) => sum + item.hp, 0);
    if (standing(enemies(state, actor)) > 3 * standing(allies(state, actor))) {
      return FLEE;
    }
  }
  // An area is only aimed where it catches more foes than it costs friends.
  const bestAim = new Map<string, number>();
  const worthOf = (action: KnownAction): number => {
    const known = bestAim.get(action.id);
    if (known !== undefined) return known;
    const score = aimsFor(action, actor, context)[0]?.score ?? 0;
    bestAim.set(action.id, score);
    return score;
  };
  // A hidden option, such as a potion at full health, only answers older saves.
  const parsed = decision.options.flatMap((option) => {
    if (option.hidden) return [];
    const [actionId = "", targetId = "", slot] = parseOption(option.id);
    const action = stats.actions.find((item) => item.id === actionId);
    const target = state.actors[targetId];
    const worth = action && targetId === AIM_AREA ? worthOf(action) : null;
    return action && (worth === null || worth > 0)
      ? [{ option, action, target, targetId, slot, worth }]
      : [];
  });

  // Slots go on fights that need them: the enemies left must outlast the caster's own HP, and a healer keeps its last slot.
  const foesHp = enemies(state, actor)
    .filter((item) => !isDown(item))
    .reduce((total, item) => total + item.hp, 0);
  const healer = stats.actions.some(
    (action) => (action.spellLevel ?? 0) > 0 && heals(action),
  );
  const spendsSlot =
    foesHp > stats.maxHp && slotsLeft(actor, stats) > (healer ? 1 : 0);

  if (decision.id.startsWith(`${NS}:afterHit:`)) {
    return spendsSlot ? first.id : DECLINE;
  }

  // The party plays by worth. Monsters keep the simple rules below, so the books' fights stay as hard as written.
  if (actor.side === "party" && decision.id.startsWith(`${NS}:turn:`)) {
    const chosen = partyChoice(parsed, decision.options, actor, context);
    if (chosen) return chosen;
    if (
      actor.budget.action &&
      decision.options.some((option) => option.id === MOVE) &&
      stepToward(actor, context)
    ) {
      return MOVE;
    }
    return decision.options.at(-1)?.id ?? first.id;
  }

  const wounded = parsed
    .filter(
      ({ action, target }) =>
        heals(action) && target && hpFraction(target, context) < 0.5,
    )
    .sort((a, b) => (a.target?.hp ?? 0) - (b.target?.hp ?? 0))[0];
  if (wounded) return wounded.option.id;

  const foes = enemies(state, actor).filter((item) => !isDown(item));
  const areas = parsed.filter(
    ({ action, target }) =>
      !target &&
      !heals(action) &&
      action.spellLevel === null &&
      "area" in action.activation.targeting &&
      action.activation.targeting.side === "enemy",
  );
  // A monster's area attack, such as a breath weapon, is its strongest choice while it's ready. One with no recharge
  // has to catch more than one foe to beat attacking, and one that only applies a condition waits until at least
  // half the foes are free of it, as repeating it on the rest would waste the turn.
  const blast = areas.find(({ action, worth }) => {
    const { cost, resolution } = action.activation;
    if ("damage" in resolution && resolution.damage.length > 0) {
      return (
        (worth ?? foes.length) > 1 ||
        cost.some((item) => typeof item === "object")
      );
    }
    const applied = (
      resolution.kind === "save" ? resolution.onFail : []
    ).flatMap((item) =>
      item.kind === "applyCondition" ? [item.condition] : [],
    );
    const free = foes.filter((item) => !hasCondition(item, ...applied));
    return free.length > 0 && free.length * 2 >= foes.length;
  });
  if (blast) return blast.option.id;

  // One slot a turn, on a spell that's still doing nothing: never a second Concentration or the same buff twice.
  const freshTurn = actor.budget.action && actor.budget.bonusAction;
  const slotSpell = parsed
    .filter(({ action, target, slot }) => {
      const { activation, spellLevel } = action;
      if (slot !== undefined || (spellLevel ?? 0) === 0) return false;
      if (heals(action) || !activation.cost.includes("slot")) return false;
      const { resolution } = activation;
      const leaves =
        resolution.kind === "automatic"
          ? resolution.effects
          : resolution.kind === "save"
            ? resolution.onFail
            : resolution.onHit;
      const concentrates = leaves.some(
        (item) =>
          "duration" in item &&
          typeof item.duration === "object" &&
          "concentration" in item.duration,
      );
      if (concentrates && actor.concentratingOn !== null) return false;
      const lasting = leaves.some(
        (item) => item.kind === "modifier" || item.kind === "applyCondition",
      );
      const harms = "damage" in resolution && resolution.damage.length > 0;
      if (!harms && !lasting) return false;
      const side =
        "side" in activation.targeting && activation.targeting.side === "enemy"
          ? enemies(state, actor)
          : allies(state, actor);
      const aimedAt = target ? [target] : side;
      return !(
        !harms &&
        aimedAt.some((item) =>
          item.activeEffects.some((effect) => effect.sourceId === action.id),
        )
      );
    })
    .sort(
      (a, b) =>
        Number("area" in b.action.activation.targeting) -
          Number("area" in a.action.activation.targeting) ||
        (b.action.spellLevel ?? 0) - (a.action.spellLevel ?? 0),
    )[0];
  if (spendsSlot && freshTurn && slotSpell) return slotSpell.option.id;

  // A Multiattack that also uses Constrict is worth more than either alone.
  const routineSize = (action: KnownAction): number =>
    attackRoutine(action, actor, stats).length +
    multiattackExtras(action, actor, context).length;
  // A spell it keeps up with Concentration isn't cast again while the last one still holds someone, which would
  // only end it (a succubus re-casting Dominate Person every turn).
  const holding = holdingConcentration(actor, context);
  const attacks = parsed.filter(
    ({ action, target }) =>
      target?.side !== actor.side &&
      target !== undefined &&
      !heals(action) &&
      (action.spellLevel ?? 0) === 0 &&
      !(holding && concentrates(action)),
  );
  // A save a hit brings (a ghoul's paralysing Claw) or a hold that deals nothing (Swallow) is weighed against
  // plain damage by worth.ts. Fights with neither keep choosing by the size of the routine.
  const judge = attacks.some(({ action }) => weighed(action))
    ? makeJudge(context, actor)
    : null;
  const routineWorth = (action: KnownAction, targetId: string): number =>
    judge
      ? [
          ...attackRoutine(action, actor, stats),
          ...multiattackExtras(action, actor, context),
        ].reduce(
          (total, id) => total + judge.worth(actor, id, targetId, undefined),
          0,
        )
      : 0;
  const attack = attacks
    .map((item) => ({
      ...item,
      // Three-quarters cover is worth going around while someone else is in the open.
      hidden: Number(
        item.target !== undefined &&
          coverFor(state, actor.position, item.target, [actor.id]) === 5,
      ),
      worth: routineWorth(item.action, item.targetId),
    }))
    .sort(
      (a, b) =>
        a.hidden - b.hidden ||
        (a.target?.hp ?? 0) - (b.target?.hp ?? 0) ||
        b.worth - a.worth ||
        routineSize(b.action) - routineSize(a.action),
    )[0];
  if (attack) return attack.option.id;
  // Nothing in reach yet: walk closer while there's still an action to use when it gets there.
  if (
    actor.budget.action &&
    decision.options.some((option) => option.id === MOVE) &&
    stepToward(actor, context)
  ) {
    return MOVE;
  }
  const lastResort = areas.find(
    ({ action: { activation } }) =>
      "damage" in activation.resolution &&
      activation.resolution.damage.length > 0,
  );
  if (lastResort) return lastResort.option.id;

  // With the Attack action spent: Action Surge when the fight is still on, and a monster's free trick like Nimble Escape.
  const extra = parsed.find(({ action, target }) => {
    const { cost, resolution } = action.activation;
    if (target?.id !== actor.id || heals(action) || moveOf(action)) {
      return false;
    }
    return resolution.kind === "automatic" &&
      resolution.effects.some((item) => item.kind === "extraAction")
      ? foesHp > stats.maxHp && !actor.budget.action
      : actor.source.kind === "monster" && cost.includes("bonusAction");
  });
  if (extra) return extra.option.id;
  return decision.options.at(-1)?.id ?? first.id;
}

// Between fights, as a careful player: spend Hit Dice while hurt, put on what makes the character better (more
// AC, a harder-hitting weapon, a magic item to attune), and never take off what it wears. Only the bot asks.
const GEAR_STEP = /^dnd5\.5e:(shortRest|gear|found):/;

export function isGearDecision(decision: Decision): boolean {
  return GEAR_STEP.test(decision.id);
}

export function gearPolicy(decision: Decision, context: Context): string {
  const actor = actorOf(context.state, decision.actor);
  const ids = new Set(decision.options.map((option) => option.id));
  const better = decision.options.find(({ id }) =>
    improves(actor, id, context),
  );
  if (decision.id.startsWith(`${NS}:shortRest:`)) {
    if (ids.has("spend") && actor.hp < deriveStats(actor, context).maxHp) {
      return "spend";
    }
    const worthChanging = gearOptions(actor, context).some(({ id }) =>
      improves(actor, id, context),
    );
    return worthChanging && ids.has("gear") ? "gear" : "finish";
  }
  return better?.id ?? "done";
}

// The best a character's weapons deal on a hit, on average.
function bestWeaponHit(actor: Actor, context: Context): number {
  const stats = deriveStats(actor, context);
  return Math.max(
    0,
    ...stats.actions.flatMap(({ id, activation: { resolution } }) =>
      id.startsWith("weapon:") && resolution.kind === "attack"
        ? [
            resolution.damage.reduce(
              (total, { amount }) => total + rollAmount(amount, stats, AVERAGE),
              0,
            ),
          ]
        : [],
    ),
  );
}

function improves(actor: Actor, answer: string, context: Context): boolean {
  if (answer.startsWith("attune:")) return true;
  if (!answer.startsWith("equip:")) return false;
  const after = { ...actor, ...changed(actor, answer, context) };
  const ac = (item: Actor): number => deriveStats(item, context).ac;
  return (
    ac(after) > ac(actor) ||
    (ac(after) === ac(actor) &&
      bestWeaponHit(after, context) > bestWeaponHit(actor, context))
  );
}
