import { z } from "zod";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  mountOf,
  NS,
  frame,
} from "../../state.ts";
import { DECLINE, encodeOption, parseOption, weaponItemId } from "../ids.ts";
import { criticalFrame, forgoFrame, SNEAK_DICE } from "../strikes.ts";
import { replaceHitFrame } from "../ranged-smite.ts";
import { againstTarget } from "../spell-riders.ts";
import { duelDamaged } from "../duel.ts";
import { insideDamageEvents } from "../swallow.ts";
import { type SystemEvent, type SystemResult } from "#sdk";
import { afterDamage, reactFrames } from "../reactions.ts";
import {
  damageResponses,
  deriveStats,
  modifierFor,
  evaluateFormula,
  rollAmount,
  rollDiceNotation,
} from "../../stats.ts";
import { finalDamage, halved } from "../../rules.ts";
import { HEW_READY, masteryOf } from "../../tactics.ts";
import { type Damage, type DamageType, WeaponSchema } from "../../schemas.ts";
import {
  armoredReduction,
  HIGHEST,
  masteredDice,
  markedBy,
  maximized,
  flooredTypes,
  masteredTypes,
  rerolledTypes,
  piercing,
  weaponDamageDice,
} from "../../trait-rules.ts";
import {
  actorOf,
  extraFits,
  CHECK_END,
  type Context,
  findAction,
  hasPassive,
  isMelee,
  meleeReach,
} from "../queries.ts";
import {
  concentrationFrame,
  damageRiders,
  dealEvents,
  leafEvents,
  siphoned,
  payCosts,
  typeAgainst,
} from "../effects.ts";
import { attackKind, inOwnTurn } from "./attack-kind.ts";
import {
  fewerDice,
  poleEnd,
  leastResisted,
  retypedHit,
  onceHitEnded,
  lessenHits,
  needsFaces,
  recorded,
  rolledType,
  damageBonus,
} from "./damage.ts";
import {
  deathStruck,
  CHARGE_ATTACK,
  drained,
  feast,
  BLOODIED_DAMAGE,
  shieldBash,
  oncePerTurnHit,
  inspiringStrike,
  reassertHonor,
  halted,
} from "./hit-features.ts";
import { passedOn } from "./hit-reactions.ts";
import { nestedSave, nestedSaves } from "./hit-saves.ts";
import { HitSchema } from "./payloads.ts";
import { retaliated } from "./retaliation.ts";
import { sideRidersSpent, spellHitEvents, hitRiders } from "./riders.ts";
import { smitesFor, companionSmites } from "./smite.ts";
import { sharedOnce, stayHidden } from "./strike-options.ts";

const SNEAK_TWICE = "sneak-twice"; // Sudden Strike's second Sneak Attack, spent
const SNEAK_AT = "sneak-at:"; // the creature dealt the first, for a bearer of Sudden Strike
const SAVAGE_ATTACKER = "savage-attacker";

// Veer: a rider with Mounted Combatant takes a hit meant for its mount.
// shortcut: taken without asking, whenever the rider has more Hit Points left than the mount.
function veered(target: Actor, context: Context): Actor | null {
  const rider = Object.values(context.state.actors).find(
    (item) => mountOf(item) === target.id,
  );
  return rider &&
    !isDown(rider) &&
    !hasCondition(rider, ...INCAPACITATING) &&
    rider.hp > target.hp &&
    hasPassive(deriveStats(rider, context), "mountedCombatant")
    ? rider
    : null;
}

export function runApplyHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const rider = veered(actorOf(context.state, payload.target), context);
  if (rider) {
    return runApplyHit({ ...payload, target: rider.id }, context);
  }
  const instead = payload.kept ? null : replaceHitFrame(payload, true, context);
  if (instead) return { frames: [instead] };
  // Cunning Strike's options are picked before the Sneak Attack dice they give up are rolled.
  const strike =
    payload.strikes === undefined ? forgoFrame(payload, context) : null;
  if (strike) return { frames: [strike] };
  const named = criticalFrame(payload, context);
  if (named) return { frames: [named] };
  return landHit(payload, context);
}

// A strike option picked to make the hit a Critical Hit, paid for as it's picked, as a Namer's Needle's Named Target.
export function runCriticalChosen(
  { answer, ...hit }: z.infer<typeof StrikeChosenSchema>,
  context: Context,
): SystemResult {
  if (answer === DECLINE) return landHit(hit, context);
  const [actionId = ""] = parseOption(answer);
  const attacker = actorOf(context.state, hit.attacker);
  const paid = payCosts(
    findAction(attacker, actionId, context),
    attacker,
    context,
  );
  const landed = landHit(
    { ...hit, critical: true },
    { ...context, state: paid.reduce(applyDndEvent, context.state) },
  );
  return { ...landed, events: [...paid, ...(landed.events ?? [])] };
}

export const StrikeChosenSchema = HitSchema.extend({ answer: z.string() });

// A strike option picked for a hit: another is asked for while the hit can take more.
export function runStrikeChosen(
  { answer, ...hit }: z.infer<typeof StrikeChosenSchema>,
  context: Context,
): SystemResult {
  const chosen = hit.strikes ?? [];
  if (answer === DECLINE) return landHit({ ...hit, strikes: chosen }, context);
  const [actionId = ""] = parseOption(answer);
  const attacker = actorOf(context.state, hit.attacker);
  const action = findAction(attacker, actionId, context);
  const next = {
    ...hit,
    strikes: [...chosen, actionId],
    forgone: (hit.forgone ?? 0) + (action.activation.trigger?.forgo ?? 0),
  };
  const more = forgoFrame(next, context);
  return more ? { frames: [more] } : landHit(next, context);
}

function landHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const printed = action.activation.resolution;
  if (printed.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  // Planar Warrior: all the hit's own damage takes the type the bearer's mark on the target names.
  const retype = target.activeEffects.find(
    ({ modifier, casterId }) =>
      modifier.kind === "hitDamage" &&
      modifier.retype !== undefined &&
      casterId === attacker.id,
  )?.modifier;
  const poled = payload.poleStrike ? poleEnd(printed) : printed;
  // A Sword of Sharpness's 20: what a natural 20, or with `critical` any Critical Hit, adds.
  const twenty = poled.natural20;
  const lucky =
    twenty &&
    (payload.natural === 20 || (twenty.critical && payload.critical)) &&
    (!twenty.attunedTo ||
      (attacker.attuned ?? []).some((id) =>
        twenty.attunedTo?.some((to) => id === to || id.startsWith(`${to}--`)),
      ))
      ? twenty
      : undefined;
  const swornDamage =
    poled.sworn && markedBy(target, attacker, [poled.sworn.item])
      ? poled.sworn.damage
      : [];
  const shaped = {
    ...poled,
    damage: [...poled.damage, ...(lucky?.damage ?? []), ...swornDamage],
  };
  const marked =
    retype?.kind === "hitDamage" && retype.retype
      ? {
          ...shaped,
          damage: shaped.damage.map((item) => ({
            ...item,
            type: retype.retype ?? item.type,
          })),
        }
      : shaped;
  // A Javelin of Lightning deals whichever of its types the target resists least.
  const altTypes = WeaponSchema.safeParse(
    context.content(weaponItemId(action.id)),
  ).data?.altTypes;
  const chosen =
    altTypes && marked.damage[0]
      ? {
          ...marked,
          damage: [
            {
              ...marked.damage[0],
              type: leastResisted(
                [marked.damage[0].type, ...altTypes],
                damageResponses(target, context),
              ),
            },
            ...marked.damage.slice(1),
          ],
        }
      : marked;
  const brooch = retypedHit(attacker, target, chosen, context);
  const resolution = againstTarget(brooch.resolution, target, context);
  const stats = deriveStats(attacker, context);
  const multiplier = payload.critical ? 2 : 1;
  const mastered = masteredTypes(stats, action.spellLevel !== null);
  const floors = flooredTypes(stats, action.spellLevel !== null);
  const rerolled = rerolledTypes(stats, action.spellLevel !== null);
  const piercedResponses = piercing(
    damageResponses(target, context),
    mastered,
    stats,
    action.id,
  );
  // A Shield of Missile Attraction resists a ranged weapon attack's damage.
  const missile =
    resolution.attack.type === "weapon" &&
    meleeReach(action) === null &&
    hasPassive(deriveStats(target, context), "missileResistance");
  const shielded = missile
    ? {
        ...piercedResponses,
        resistances: [
          ...piercedResponses.resistances,
          ...resolution.damage.map((item) => item.type),
        ],
      }
    : piercedResponses;
  const responses = payload.overcomes
    ? { ...shielded, resistances: [], immunities: [] }
    : shielded;

  // Magic ammunition is no longer magical once it hits.
  const events: SystemEvent[] = [
    ...brooch.events,
    ...(action.ammunition
      ? [
          dndEvent(`${NS}:itemUsed`, {
            actor: attacker.id,
            item: action.ammunition,
          }),
        ]
      : []),
  ];
  let totalDealt = 0;
  const absorbed: { amount: number; type: DamageType }[] = [];
  // The first damage's dice, for Chaos Bolt's type and a leap's matching numbers.
  const faces: number[] = [];
  const printedFirst = resolution.damage[0]?.type;
  let gained = 0; // Temporary Hit Points the hit gives the attacker, as an Executioner's Axe's

  // Add dice-based extra damage such as Sneak Attack to the first damage roll.
  let extra = 0;
  const typedExtra: Damage[] = [];
  const edge = {
    advantage: payload.hadAdvantage,
    disadvantage: payload.hadDisadvantage === true,
    natural: payload.natural,
  };
  const sneak = { landed: false };
  // Sudden Strike: once its Bonus Action attack is taken, Sneak Attack a second time, at a creature not dealt it yet.
  const twice = stats.passives.flatMap((passive) =>
    passive.kind === "secondSneak" ? [passive.feature] : [],
  );
  const again =
    twice.length > 0 &&
    !attacker.usedThisTurn.includes(SNEAK_TWICE) &&
    !attacker.usedThisTurn.includes(`${SNEAK_AT}${target.id}`) &&
    twice.some((feature) =>
      attacker.usedThisTurn.includes(`once:feature:${feature}`),
    );
  stats.passives.forEach((passive, index) => {
    if (passive.kind !== "extraDamage") return;
    const key = `extra:${String(index)}`;
    const sneaks = passive.diceCount === SNEAK_DICE;
    const spent = passive.oncePerTurn && attacker.usedThisTurn.includes(key);
    if (spent && !(sneaks && again)) return;
    if (!extraFits(passive, attacker, target, action, edge, context)) return;
    if (sneaks) {
      sneak.landed = true;
      if (twice.length > 0) {
        events.push(
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: spent ? SNEAK_TWICE : `${SNEAK_AT}${target.id}`,
          }),
        );
      }
    }
    // Dreaded Necrosis: one more die of the hit's own damage of that type, and nothing without it.
    const ownDie = passive.oneDieOf
      ? /d(\d+)/.exec(
          resolution.damage.find(({ type }) => type === passive.oneDieOf)
            ?.amount.dice ?? "",
        )?.[1]
      : undefined;
    if (passive.oneDieOf && !ownDie) return;
    // Cunning Strike's options give up some of Sneak Attack's dice before they're rolled.
    const dice_ = ownDie
      ? `1d${ownDie}`
      : passive.diceCount === SNEAK_DICE
        ? fewerDice(passive.dice, payload.forgone ?? 0)
        : passive.dice;
    // Murderous Intent: a Sneak Attack die below its floor counts as the floor.
    const floor =
      passive.diceCount === SNEAK_DICE
        ? Math.max(
            0,
            ...stats.passives.map((other) =>
              other.kind === "sneakFloor" ? other.value : 0,
            ),
          )
        : 0;
    const rolling =
      floor > 0
        ? {
            ...dice,
            roll: (sides: number) => Math.max(floor, dice.roll(sides)),
          }
        : dice;
    const rolled =
      (dice_ ? rollDiceNotation(dice_, rolling, multiplier) : 0) +
      (passive.bonus ? evaluateFormula(passive.bonus, stats) : 0);
    const type = passive.types
      ? typeAgainst(passive.types, responses)
      : passive.type;
    if (type) {
      typedExtra.push({ amount: { bonus: { base: rolled, add: [] } }, type });
    } else extra += rolled;
    if (passive.oncePerTurn) {
      events.push(
        dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key }),
      );
    }
  });

  // Savage Attacker: once a turn, a weapon's damage dice are rolled twice and the higher roll kept.
  const savage =
    resolution.attack.type === "weapon" &&
    hasPassive(stats, "savageAttacker") &&
    !attacker.usedThisTurn.includes(SAVAGE_ATTACKER);
  // Zhentarim Ruffian's Exploit Opening does the same for every Opportunity Attack.
  const exploit =
    hasPassive(stats, "opportunityDamage") && inOwnTurn(target, context);
  if (savage) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: attacker.id,
        key: SAVAGE_ATTACKER,
      }),
    );
  }
  // Piercer: once a turn, a low die of the first damage of its type is rolled again, and a Critical Hit with it
  // rolls one more die.
  const piercer = stats.passives.find(
    (passive) =>
      passive.kind === "damageReroll" &&
      resolution.damage.some(({ type }) => type === passive.damage),
  );
  const pierced = piercer?.kind === "damageReroll" ? piercer.damage : null;
  const pierceIndex = resolution.damage.findIndex(
    ({ type }) => type === pierced,
  );
  const pierceKey = `reroll:${String(pierced)}`;
  const rerolls =
    pierced !== null && !attacker.usedThisTurn.includes(pierceKey);
  // Boon of Bloodshed's Power from Pain: once a turn, the Proficiency Bonus more while Bloodied.
  const pain =
    hasPassive(stats, "bloodiedDamage") &&
    attacker.hp * 2 <= stats.maxHp &&
    !attacker.usedThisTurn.includes(BLOODIED_DAMAGE);
  if (pain) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: attacker.id,
        key: BLOODIED_DAMAGE,
      }),
    );
  }
  // The turn's use is spent only when a die is rolled again.
  const pierce = { used: false };
  // Charger's Charge Attack: once on its turn, a melee hit after moving at least 10 feet adds 1d8.
  // shortcut: any 10 feet moved this turn counts, not only a straight line toward the target, and it never pushes.
  const charging =
    hasPassive(stats, "chargeAttack") &&
    isMelee(action) &&
    attacker.moved >= 10 &&
    inOwnTurn(attacker, context) &&
    !attacker.usedThisTurn.includes(CHARGE_ATTACK);
  if (charging) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: attacker.id,
        key: CHARGE_ATTACK,
      }),
    );
  }
  const charge = charging ? rollDiceNotation("1d8", dice, multiplier) : 0;
  const maxed = maximized(
    attacker,
    stats,
    resolution.damage.map(({ type }) => type),
  );
  events.push(...(maxed?.events ?? []));
  const maxIndex = resolution.damage.findIndex(
    ({ type }) => type === maxed?.type,
  );
  const weaponDice = weaponDamageDice(dice, action.id, stats, context);
  resolution.damage.forEach(({ amount, type: printedType, tempHp }, index) => {
    const recording = index === 0 && needsFaces(resolution);
    const pierces = index === pierceIndex;
    const die = /d(\d+)/.exec(amount.dice ?? "")?.[1];
    const roll = () => {
      if (recording) faces.length = 0;
      const inner =
        index === maxIndex
          ? HIGHEST
          : masteredDice(
              weaponDice,
              printedType,
              floors,
              rerolled,
              state.combat?.environment?.forceFloor,
            );
      if (!(pierces && rerolls)) {
        return rollAmount(
          amount,
          stats,
          recording ? recorded(inner, faces) : inner,
          multiplier,
        );
      }
      let count = 0;
      const total = rollAmount(
        { ...amount, reroll: 1 },
        stats,
        {
          below: (count) => inner.below(count),
          roll: (sides) => {
            count += 1;
            return inner.roll(sides);
          },
        },
        multiplier,
      );
      const printed = Number(/^(\d+)d/.exec(amount.dice ?? "")?.[1] ?? 0);
      if (count > printed * multiplier) pierce.used = true;
      return total;
    };
    const rolled =
      ((savage || exploit) && index === 0 ? Math.max(roll(), roll()) : roll()) +
      (pierces && payload.critical && die
        ? rollDiceNotation(`1d${die}`, dice)
        : 0) +
      (index === 0 && printedType === printedFirst
        ? extra +
          damageBonus(attacker, resolution, stats, context) +
          (pain ? stats.proficiency : 0) +
          charge
        : 0) -
      (index === 0 && payload.noModifier && resolution.attack.ability
        ? Math.max(0, modifierFor(stats, resolution.attack.ability))
        : 0);
    const type =
      rolledType(resolution.damage[0]?.rolledTypes, faces, responses) ??
      printedType;
    const final = finalDamage(Math.max(0, rolled), type, responses);
    // Damage it absorbs heals it on its own, rather than taking from the rest of the hit.
    if (final < 0) absorbed.push({ amount: final, type });
    else totalDealt += final;
    if (tempHp && final > 0) gained += final;
  });
  const firstType =
    rolledType(resolution.damage[0]?.rolledTypes, faces, responses) ??
    printedFirst;
  if (gained > 0) {
    events.push(
      dndEvent(`${NS}:tempHpGained`, { actor: attacker.id, amount: gained }),
    );
  }
  if (pierce.used) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key: pierceKey }),
    );
  }

  events.push(...sideRidersSpent(attacker, target, state));
  const riders = hitRiders(
    attacker,
    target,
    action,
    resolution,
    responses,
    context,
  );
  events.push(...riders.events);
  const hits = [
    ...(firstType ? [{ amount: totalDealt, type: firstType }] : []),
    ...absorbed,
    ...[...typedExtra, ...riders.damage].map(({ amount, type }) => ({
      amount: finalDamage(
        rollAmount(amount, stats, dice, multiplier),
        type,
        responses,
      ),
      type,
    })),
  ];
  // Death Strike: a first-round Sneak Attack doubles the hit's damage unless the target saves.
  const struck = sneak.landed
    ? deathStruck(attacker, target, stats, context)
    : null;
  if (struck) events.push(...struck.events);
  // Enfeebling Arrow: the bearer's weapon attacks deal half damage; Ancestral Protectors' only off its caster.
  const weakened =
    resolution.attack.type === "weapon" &&
    attacker.activeEffects.some(
      ({ modifier, casterId }) =>
        modifier.kind === "weakened" &&
        !(modifier.exceptCaster && casterId === target.id),
    );
  // Path to the Grave's curse: the next hit from its caster's side deals double.
  const exposed = target.activeEffects.some(
    ({ modifier, casterId }) =>
      modifier.kind === "exposed" &&
      state.actors[casterId]?.side === attacker.side,
  );
  const doubled =
    struck?.doubled || exposed
      ? hits.map((item) => ({
          ...item,
          amount: item.amount > 0 ? item.amount * 2 : item.amount,
        }))
      : weakened
        ? hits.map((item) => ({
            ...item,
            amount: item.amount > 0 ? halved(item.amount) : item.amount,
          }))
        : hits;
  const targetStats = deriveStats(target, context);
  const armored = doubled.map((item) => ({
    ...item,
    amount:
      item.amount < 0
        ? item.amount // absorbed
        : Math.max(
            0,
            item.amount -
              armoredReduction(
                target,
                targetStats,
                item.type,
                context,
                item.amount,
              ),
          ),
  }));
  const lessened = lessenHits(armored, payload);
  const dealt = dealEvents(
    target,
    lessened,
    payload.critical,
    context,
    attacker,
    action.spellLevel !== null,
  );
  const passed = passedOn(armored, lessened, payload, attacker, target, {
    ...context,
    state: dealt.events.reduce(applyDndEvent, state),
  });
  events.push(
    ...dealt.events,
    ...passed.events,
    ...damageRiders(
      attacker,
      target,
      new Set(resolution.damage.map(({ type }) => type)),
      payload.critical,
      stats,
      context,
      false,
      action,
    ),
    ...insideDamageEvents(attacker, target, dealt.dealt),
    ...leafEvents(resolution.onHit, action.id, attacker, target, context),
    ...spellHitEvents(payload.spell, attacker, target, stats, context),
    ...oncePerTurnHit(resolution, action, attacker, target, context),
    ...drained(resolution, attacker, target, dealt.dealt, stats, context),
    ...siphoned(action, attacker, dealt.dealt, stats),
    ...feast(attacker, target, stats, context),
    ...retaliated(attacker, target, action, context, dealt.dealt),
    ...halted(attacker, target, stats, context),
    ...shieldBash(attacker, target, action, stats, context),
    ...inspiringStrike(attacker, payload.critical, stats, context),
    ...(dealt.dealt > 0 ? reassertHonor(attacker, target, context) : []),
    ...duelDamaged(attacker, target, dealt.dealt, state),
    ...onceHitEnded(attacker),
  );
  // The save sees the target as the hit left it.
  const afterHit = events.reduce(applyDndEvent, state);
  const nested = nestedSaves(resolution, action, attacker, target, {
    ...context,
    state: afterHit,
  });
  events.push(...nested.events);
  // A natural 20's own effects and save, on the target as the hit left it, as a Mace of Smiting's or a Nine Lives
  // Stealer's.
  if (lucky) {
    const now = {
      ...context,
      state: nested.events.reduce(applyDndEvent, afterHit),
    };
    const struckNow = now.state.actors[target.id];
    if (struckNow && !isDead(struckNow)) {
      events.push(
        ...leafEvents(lucky.onHit, action.id, attacker, struckNow, now),
      );
    }
    if (lucky.onHitSave) {
      events.push(
        ...nestedSaves(
          { ...resolution, onHitSave: lucky.onHitSave },
          action,
          attacker,
          target,
          { ...context, state: events.reduce(applyDndEvent, state) },
        ).events,
      );
    }
  }
  // A Poisoner's dose on the weapon: the save it brings, once, on a hit that deals damage.
  const coating =
    dealt.dealt > 0 && action.id.startsWith("weapon:")
      ? attacker.activeEffects.find(
          ({ modifier }) => modifier.kind === "coating",
        )
      : undefined;
  const coated =
    coating?.modifier.kind === "coating"
      ? nestedSave(
          {
            ...resolution,
            onHitSave: {
              ability: coating.modifier.ability,
              dc: coating.modifier.dc,
              damage: coating.modifier.damage,
              onSuccessDamage: "none",
              onFail: coating.modifier.condition
                ? [
                    {
                      kind: "applyCondition",
                      condition: coating.modifier.condition,
                      duration: coating.modifier.minutes
                        ? { minutes: coating.modifier.minutes }
                        : { until: "yourNextTurnEnd" },
                      repeatSave: false,
                      endsOnDamage: false,
                    },
                  ]
                : [],
              onSuccess: [],
            },
          },
          { ...action, id: coating.sourceId },
          attacker,
          target,
          { ...context, state: nested.events.reduce(applyDndEvent, afterHit) },
        )
      : null;
  if (coating && coated) {
    events.push(
      ...coated.events,
      dndEvent(`${NS}:effectEnded`, {
        actor: attacker.id,
        sourceId: coating.sourceId,
      }),
    );
  }
  // What answers the hit: the damage, the hit itself, and a foe striking someone else, as with Sentinel's Guardian.
  const landed = {
    ...context,
    state: [...nested.events, ...(coated?.events ?? [])].reduce(
      applyDndEvent,
      afterHit,
    ),
  };
  const how = attackKind(payload, context);
  const cause = {
    source: attacker.id,
    types: armored.flatMap((item) => (item.amount > 0 ? [item.type] : [])),
    ...how,
  };
  // Hew: a Critical Hit or a drop with a melee weapon readies a Bonus Action attack with it.
  const hew =
    hasPassive(stats, "hew") &&
    action.id.startsWith("weapon:") &&
    isMelee(action) &&
    (payload.critical || dealt.dealt + nested.dealt >= target.hp)
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: `${HEW_READY}${action.id}`,
          }),
        ]
      : [];
  return {
    // Stealth Attack: hidden again until the turn ends, unless it ends out of cover (combat/turn.ts).
    events: [...events, ...hew, ...stayHidden(payload, attacker, context)],
    frames: [
      ...concentrationFrame(
        target,
        dealt.dealt + nested.dealt,
        hasPassive(stats, "concentrationBreaker") ||
          resolution.breaksConcentration === true,
      ),
      // The attacker's own choices for its hit come before the target's answers: the strike options picked, then
      // what it can add now.
      ...(payload.strikes ?? []).map((id, index, all) =>
        frame("smite", {
          attacker: attacker.id,
          actionId: action.id,
          target: target.id,
          critical: payload.critical,
          answer: encodeOption(id, target.id),
          ...(sharedOnce(attacker, id, all.slice(0, index), context)
            ? { noDamage: true }
            : {}),
        }),
      ),
      ...(smitesFor(
        action,
        attacker,
        target,
        stats,
        context,
        undefined,
        payload.critical,
      ).length > 0 || companionSmites(attacker, target, context)
        ? [
            frame("afterHit", {
              attacker: attacker.id,
              actionId: action.id,
              target: target.id,
              critical: payload.critical,
              total: payload.total,
            }),
          ]
        : []),
      ...(masteryOf(attacker, action.id, context)
        ? [frame("masteryHit", { ...payload, dealt: dealt.dealt })]
        : []),
      ...(resolution.leap && new Set(faces).size < faces.length
        ? [frame("leap", payload)]
        : []),
      ...passed.frames,
      ...afterDamage(target, dealt.dealt + nested.dealt, cause, [], landed),
      // Elemental Rebuke's save comes once the halved damage is in, and the hit is then offered to the rest.
      ...(payload.echo
        ? [
            frame("reactAnswer", {
              kind: "struck",
              actor: target.id,
              ...cause,
              dealt: dealt.dealt + nested.dealt,
              reactor: target.id,
              actionId: payload.echo,
              answer: payload.echo,
              paid: true,
            }),
          ]
        : reactFrames({ kind: "struck", actor: target.id, ...cause }, landed)),
      ...reactFrames(
        {
          kind: "hitOther",
          actor: target.id,
          ...cause,
          dealt: dealt.dealt + nested.dealt,
        },
        landed,
      ),
      CHECK_END,
    ],
  };
}
