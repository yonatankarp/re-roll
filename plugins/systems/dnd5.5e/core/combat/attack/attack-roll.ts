import { prisonEvents } from "../fear.ts";
import { z } from "zod";
import { deflection, placedFlag } from "../../zones.ts";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
  frame,
} from "../../state.ts";
import { DECLINE, FANCY_FOOTWORK, parseOption, weaponItemId } from "../ids.ts";
import { forgoAdvantageFrame, gainAdvantageFrame } from "../strikes.ts";
import { replaceHitFrame } from "../ranged-smite.ts";
import { duelBroken, duelHampers } from "../duel.ts";
import { distanceFeet } from "../../grid.ts";
import { grapplesOn } from "../grapple.ts";
import {
  blindedTo,
  coverAgainst,
  lightAt,
  seeing,
  unseenInvisible,
} from "../../sight.ts";
import { swallowerOf } from "../swallow.ts";
import { beyondUnderwaterRange, underwaterHampered } from "../water.ts";
import { awaitDecision, type SystemResult } from "#sdk";
import { effectsOf, turnedOn, withoutMoves } from "../reactions.ts";
import {
  attackBonus,
  deriveStats,
  passiveModifiers,
  spellSaveDc,
  type Stats,
} from "../../stats.ts";
import { rollD20 } from "../../rules.ts";
import {
  dodging,
  grappledAwayFrom,
  castRevealEvents,
  tacticsOf,
} from "../../tactics.ts";
import {
  criticalFrom,
  offerInspiration,
  onceEnded,
} from "../../class-rules.ts";
import {
  d20Floor,
  markedBy,
  steadyShot,
  traitAttackAdvantage,
  WARD_DOWN,
  warded,
} from "../../trait-rules.ts";
import {
  actorOf,
  allies,
  type Context,
  enemies,
  exemptFrom,
  findAction,
  onceKey,
  isStuck,
  hasFlag,
  hasPassive,
  underEffect,
  isMelee,
  meleeReach,
  rollBonus,
  within5,
  luckyEdge,
} from "../queries.ts";
import {
  actingEnds,
  naturalOneEvents,
  payCosts,
  protectedMount,
  reactionMove,
  resolveAction,
  rollSave,
} from "../effects.ts";
import {
  mountedStrike,
  distracted,
  unadvantaged,
  PEERLESS_AIM,
  swornElsewhere,
} from "./advantage.ts";
import { quiverDrawn } from "./ammunition.ts";
import { meleeAc, attackKind, inOwnTurn } from "./attack-kind.ts";
import { onceHitEnded } from "./damage.ts";
import { imageHit, majestic } from "./defenses.ts";
import { guardFor, guardCosts, redirect, intercepted } from "./guards.ts";
import { missOutcome } from "./miss.ts";
import { AttackSchema } from "./payloads.ts";
import { aimAt } from "./projectile.ts";
import { reactionFor, ownTrigger, rollWindow } from "./roll-reactions.ts";

// A resource spent on the bearer: this attacker is freed of its Among the Dead until a Long Rest.
const DETERRED = "deterred:";

export function runAttackRoll(
  payload: z.infer<typeof AttackSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  // A hit can end the fight with more attacks still queued, and the monsters are gone by then.
  if (!state.combat) return {};
  const attacker = actorOf(state, payload.attacker);
  if (isDead(attacker) || isDown(attacker)) return {};

  // A later attack in a multiattack moves on if its first target has already fallen, and one with a weapon that
  // got stuck, as to Sticky Shield, isn't made.
  const target = aimAt(payload.target, attacker, state);
  if (!target || isStuck(attacker, payload.actionId)) return {};

  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const { resolution } = action.activation;
  if (resolution.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  // Sanctuary: an attacker that fails its Wisdom save loses the attack. One warded itself loses the ward by attacking.
  const attackerType = deriveStats(attacker, context).creatureType ?? "";
  const freedKey = `${DETERRED}${attacker.id}`;
  const ward = target.activeEffects.find(
    ({ modifier }) =>
      modifier.kind === "sanctuary" &&
      (!modifier.creatureTypes ||
        modifier.creatureTypes.includes(attackerType)) &&
      !(modifier.lasting && target.resourcesSpent[freedKey]),
  );
  const unwarded = attacker.activeEffects
    .filter(
      ({ modifier }) => modifier.kind === "sanctuary" && !modifier.lasting,
    )
    .map(({ sourceId }) =>
      dndEvent(`${NS}:effectEnded`, { actor: attacker.id, sourceId }),
    );
  if (ward?.modifier.kind === "sanctuary" && attacker.side !== target.side) {
    const save = rollSave(
      attacker,
      ward.modifier.ability ?? "wis",
      ward.modifier.dc ?? 10,
      context,
      true,
    );
    if (!save.saved) return { events: [...unwarded, ...save.events] };
    if (ward.modifier.lasting) {
      unwarded.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: target.id,
          resource: freedKey,
        }),
      );
    }
  }
  const stats = deriveStats(attacker, context);
  const targetStats = deriveStats(target, context);
  // XGE's Unbreakable Majesty: the attacker saves before its first attack on the bearer this turn, or loses it.
  const daunted = payload.rolled
    ? null
    : majestic(attacker, target, targetStats, true, context);
  if (daunted && !daunted.saved) {
    return { events: [...unwarded, ...daunted.events] };
  }
  if (daunted) unwarded.push(...daunted.events);
  // Among the Dead: an undead attacker saves or loses the attack, and once it saves, or the bearer attacks it, it's
  // free of this until a Long Rest.
  const deterred = (bearer: Actor, other: Actor, bearerStats: Stats) =>
    bearerStats.passives.some(
      (passive) =>
        passive.kind === "deterAttackers" &&
        (passive.creatureTypes as readonly string[]).includes(
          deriveStats(other, context).creatureType ?? "",
        ),
    ) && !bearer.resourcesSpent[`${DETERRED}${other.id}`];
  const freed = (bearer: Actor, other: Actor) =>
    dndEvent(`${NS}:resourceSpent`, {
      actor: bearer.id,
      resource: `${DETERRED}${other.id}`,
    });
  const freedOwn = deterred(attacker, target, stats)
    ? [freed(attacker, target)]
    : [];
  if (
    attacker.side !== target.side &&
    deterred(target, attacker, targetStats)
  ) {
    const save = rollSave(
      attacker,
      "wis",
      spellSaveDc(targetStats),
      context,
      true,
    );
    if (!save.saved) return { events: [...unwarded, ...save.events] };
    unwarded.push(...save.events, freed(target, attacker));
  }
  unwarded.push(...freedOwn);
  const packed =
    hasPassive(stats, "packTactics") &&
    allies(state, attacker).some(
      (item) =>
        item.id !== attacker.id &&
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING) &&
        within5(item, target),
    );
  const close = within5(attacker, target);
  const steady = steadyShot(stats, action.id, resolution.attack.type);
  // A ranged attack is harder with an enemy standing next to the attacker.
  const crowded =
    meleeReach(action) === null &&
    !steady.inMelee &&
    enemies(state, attacker).some(
      (item) =>
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING) &&
        within5(item, attacker),
    );
  const proneFar = hasCondition(target, "prone") && !close;
  // Darkness hides a creature from anyone without Darkvision in range: attacking an unseen target has
  // Disadvantage, and a target that can't see its attacker gives Advantage.
  // From inside its swallower, the light at the creature's old square has nothing to do with it.
  const inside = swallowerOf(attacker) === target.id;
  const unseenTarget =
    !inside && seeing(attacker, target.position, state, context) === "none";
  const unseenAttacker =
    !inside && seeing(target, attacker.position, state, context) === "none";
  // A monster's flat bonus names no ability: a weapon attack is Strength-based in melee and Dexterity-based at range.
  const ability =
    resolution.attack.ability ?? (meleeReach(action) === null ? "dex" : "str");
  // An Oathbow at its sworn enemy: Advantage, and no cover or long range in the way.
  const sworn =
    resolution.sworn !== undefined &&
    markedBy(target, attacker, [resolution.sworn.item]);
  // Brutal Strike's options take the roll's Advantage away.
  const forgoes = (payload.strikes ?? []).length > 0 && !payload.advantaged;
  const advantage =
    !unadvantaged(target, targetStats, attacker) &&
    (payload.advantaged === true ||
      (!forgoes &&
        (packed ||
          unseenAttacker ||
          hasFlag(attacker, "advantage", "attacks", stats, ability) ||
          hasFlag(
            target,
            "advantage",
            "attacksAgainst",
            targetStats,
            undefined,
            undefined,
            attacker.id,
          ) ||
          placedFlag(
            attacker,
            "advantage",
            "attacks",
            state,
            context,
            ability,
          ) ||
          placedFlag(target, "advantage", "attacksAgainst", state, context) ||
          distracted(attacker, target, context) ||
          unseenInvisible(attacker, target, context) ||
          blindedTo(target, attacker, context) ||
          hasCondition(
            target,
            "paralyzed",
            "petrified",
            "restrained",
            "stunned",
            "unconscious",
          ) ||
          (hasCondition(target, "prone") && close) ||
          (hasPassive(stats, "grappledAdvantage") &&
            grapplesOn(target).some(
              ({ casterId }) => casterId === attacker.id,
            )) ||
          // Street Justice's Headlock: allies too, against a creature the bearer grapples.
          grapplesOn(target).some(({ casterId }) => {
            const grappler = state.actors[casterId];
            return (
              grappler !== undefined &&
              casterId !== attacker.id &&
              grappler.side === attacker.side &&
              deriveStats(grappler, context).passives.some(
                (passive) =>
                  passive.kind === "grappledAdvantage" && passive.allies,
              )
            );
          }) ||
          traitAttackAdvantage(stats, attacker, target, targetStats, state) ||
          (resolution.attack.shadowAdvantage === true &&
            lightAt(target.position, state, context) !== "bright") ||
          sworn ||
          // Innate Sorcery: Advantage on spell attacks only.
          (action.spellLevel !== null &&
            [
              ...attacker.activeEffects.map((effect) => effect.modifier),
              ...passiveModifiers(stats.passives),
            ].some(
              (modifier) =>
                modifier.kind === "advantage" &&
                modifier.on === "attacks" &&
                modifier.spellAttacks === true,
            )) ||
          mountedStrike(attacker, target, stats, context))));
  const held = payload.rolled;
  // Redirect Attack: the target trades places with an ally next to it, who takes the attack instead.
  const redirected = held ? null : redirect(attacker, target, context);
  if (redirected) {
    return {
      events: redirected.events,
      frames: [frame("attackRoll", { ...payload, target: redirected.ally })],
    };
  }
  // An Arrow-Catching Shield: an ally beside the target takes a ranged attack on itself.
  const ranged = attackKind(payload, context).ranged;
  // A Shield of Missile Attraction's curse draws a ranged weapon attack aimed near its bearer.
  const magnet =
    held ||
    !ranged ||
    resolution.attack.type !== "weapon" ||
    hasPassive(targetStats, "missileMagnet")
      ? undefined
      : Object.values(state.actors).find(
          (other) =>
            other.id !== target.id &&
            other.id !== attacker.id &&
            other.position !== null &&
            !isDown(other) &&
            // shortcut: a bearer farther than 30 feet off draws nothing, which spares the look at every creature
            distanceFeet(other.position, target.position) <= 30 &&
            deriveStats(other, context).passives.some(
              (passive) =>
                passive.kind === "missileMagnet" &&
                distanceFeet(other.position, target.position) <= passive.within,
            ),
        );
  if (magnet) {
    return {
      events: [],
      frames: [frame("attackRoll", { ...payload, target: magnet.id })],
    };
  }
  const drawn = held
    ? null
    : guardFor(target, attacker, "allyAttacked", context, {
        ranged,
        draw: true,
      });
  if (drawn) {
    return {
      events: guardCosts(drawn.guard, drawn.action, context),
      frames: [frame("attackRoll", { ...payload, target: drawn.guard.id })],
    };
  }
  // Protection: an ally's Shield gives this roll, and the others against the target, Disadvantage.
  const shielded = held
    ? null
    : guardFor(target, attacker, "allyAttacked", context, { ranged });
  const { normalRange } = resolution.attack;
  const longRange =
    !sworn &&
    normalRange !== undefined &&
    distanceFeet(attacker.position, target.position) > normalRange;
  // A Berserker Axe's curse: any other weapon attacks with Disadvantage.
  const wielded = weaponItemId(action.id);
  const otherWeapon =
    wielded !== "" &&
    stats.passives.some(
      (passive) =>
        passive.kind === "soleWeapon" &&
        wielded !== passive.item &&
        !wielded.startsWith(`${passive.item}--`),
    );
  const hampered =
    shielded !== null ||
    otherWeapon ||
    stats.passives.some(
      (passive) =>
        passive.kind === "foeDisadvantage" &&
        targetStats.creatureType !== undefined &&
        passive.creatureTypes.includes(targetStats.creatureType),
    ) ||
    crowded ||
    longRange ||
    // Ranged weapon attacks through a wind or a wall of water, as Wall of Water's.
    (ranged &&
      resolution.attack.type === "weapon" &&
      deflection(state, attacker.position, target.position) !== null) ||
    underwaterHampered(attacker, action, resolution, context) ||
    // Speedy or Boots of Speed: an Opportunity Attack, one made on the target's own turn, has Disadvantage.
    (inOwnTurn(target, context) &&
      [
        ...target.activeEffects.map((effect) => effect.modifier),
        ...passiveModifiers(targetStats.passives),
      ].some(
        (modifier) =>
          modifier.kind === "disadvantage" &&
          modifier.on === "attacksAgainst" &&
          modifier.opportunity === true,
      )) ||
    swornElsewhere(attacker, action, resolution, context) ||
    unseenTarget ||
    proneFar ||
    dodging(target) ||
    duelHampers(attacker, target) ||
    grappledAwayFrom(attacker, target) ||
    hasFlag(
      attacker,
      "disadvantage",
      "attacks",
      stats,
      ability,
      undefined,
      target.id,
    ) ||
    hasFlag(
      target,
      "disadvantage",
      "attacksAgainst",
      targetStats,
      undefined,
      stats.creatureType,
    ) ||
    placedFlag(attacker, "disadvantage", "attacks", state, context, ability) ||
    placedFlag(target, "disadvantage", "attacksAgainst", state, context) ||
    hasCondition(attacker, "frightened", "poisoned", "prone", "restrained") ||
    blindedTo(attacker, target, context) ||
    unseenInvisible(target, attacker, context) ||
    warded(target, targetStats) ||
    // Escape the Horde: an Opportunity Attack is one made on the bearer's own turn.
    (inOwnTurn(target, context) &&
      [
        ...target.activeEffects.map(({ modifier }) => modifier),
        ...passiveModifiers(targetStats.passives),
      ].some(
        (modifier) =>
          modifier.kind === "disadvantage" &&
          modifier.on === "attacksAgainst" &&
          modifier.opportunity,
      )) ||
    protectedMount(target, context) ||
    (action.spellLevel !== null &&
      passiveModifiers(targetStats.passives).some(
        (modifier) =>
          modifier.kind === "disadvantage" &&
          modifier.on === "attacksAgainst" &&
          modifier.spells,
      )) ||
    // A strong wind hampers ranged weapon attacks, and a dampened magic zone spell attacks (environment.ts); Frostbite
    // the next weapon attack.
    [
      ...attacker.activeEffects.map(({ modifier }) => modifier),
      ...passiveModifiers(stats.passives),
    ].some(
      (modifier) =>
        modifier.kind === "disadvantage" &&
        modifier.on === "attacks" &&
        modifier.weapon === true &&
        resolution.attack.type === "weapon",
    ) ||
    passiveModifiers(stats.passives).some(
      (modifier) =>
        modifier.kind === "disadvantage" &&
        modifier.on === "attacks" &&
        ((modifier.ranged === true &&
          action.spellLevel === null &&
          !isMelee(action)) ||
          (modifier.spellAttacks === true && action.spellLevel !== null)),
    );
  // Lucky: the target spends a Luck Point on its own once it's badly hurt or the attacker has Advantage.
  // One that costs only the Reaction, as Shadowy Dodge, is taken whenever it can be; XGE's only against a roll
  // without Advantage.
  const luck =
    held || hampered || isDown(target)
      ? null
      : ownTrigger(
          target,
          "attacked",
          context,
          advantage,
          advantage || target.hp * 2 <= targetStats.maxHp,
        );
  const disadvantage = hampered || luck !== null;
  const guarded = [
    ...(shielded
      ? [
          ...guardCosts(shielded.guard, shielded.action, context),
          ...(resolveAction(shielded.action, shielded.guard, [target], context)
            .events ?? []),
        ]
      : []),
    ...(luck
      ? [
          ...payCosts(luck, target, context),
          // Limited Foresight's Advantage is against the attacker alone, so it's aimed at it.
          ...(resolveAction(
            withoutMoves(luck),
            target,
            ["self" in luck.activation.targeting ? target : attacker],
            context,
          ).events ?? []),
          // Shadowy Dodge's move away from the attacker.
          ...effectsOf(luck).flatMap((effect) =>
            effect.kind === "reactionMove"
              ? reactionMove(
                  { ...target, budget: { ...target.budget, reaction: true } },
                  context,
                  effect,
                  attacker,
                ).filter((event) => event.kind !== `${NS}:budgetSpent`)
              : [],
          ),
        ]
      : []),
  ];
  // An attack roll with Advantage can give it up for Brutal Strike's options, picked before it's rolled.
  const brutal =
    held || payload.strikes !== undefined || !advantage || disadvantage
      ? null
      : forgoAdvantageFrame({ ...payload, target: target.id }, context);
  if (brutal) return { frames: [brutal] };
  // One without it can take a strike option that gives it, picked before it's rolled, as a Martialist's Trip.
  const trip =
    held || payload.strikes !== undefined || advantage || disadvantage
      ? null
      : gainAdvantageFrame({ ...payload, target: target.id }, context);
  if (trip) return { frames: [trip] };
  // Drunkard's Luck cancels Disadvantage on a fresh roll, for its resource.
  const lucky = held
    ? null
    : luckyEdge(attacker, stats, advantage, disadvantage);
  const edge = held ?? { advantage, disadvantage: disadvantage && !lucky };
  const rolledFirst = held
    ? { natural: held.natural }
    : payload.fixed !== undefined
      ? { natural: payload.fixed }
      : rollD20(dice, {
          advantage,
          disadvantage: edge.disadvantage,
          rerollOnes: hasPassive(stats, "rerollOnes"),
          thirdDie: ability !== "str" && hasPassive(stats, "elvenAccuracy"),
        });
  // Trance of Order: a d20 of 9 or lower counts as 10; a fixed d20 stands.
  const first =
    held || payload.fixed !== undefined
      ? rolledFirst
      : { natural: Math.max(rolledFirst.natural, d20Floor(attacker, stats)) };
  const hadAdvantage = edge.advantage && !edge.disadvantage;
  const hadDisadvantage = edge.disadvantage && !edge.advantage;
  const base =
    held?.base ??
    attackBonus(resolution, stats) +
      rollBonus(
        attacker,
        "attacks",
        context,
        undefined,
        undefined,
        resolution.attack.type === "weapon",
      ) +
      rollBonus(target, "attacksAgainst", context) + // Blade Ward's -1d4
      // A Mace of Smiting's more against a Construct.
      (resolution.vs &&
      exemptFrom(resolution.vs.creatureTypes, target, targetStats)
        ? resolution.vs.bonus
        : 0);
  // A Wand of the War Mage ignores Half Cover with spell attacks.
  const behind = coverAgainst(state, attacker, target, context);
  const cover =
    behind === 2 &&
    stats.passives.some(
      (passive) =>
        passive.kind === "ignoreHalfCover" &&
        passive.attack === resolution.attack.type,
    )
      ? 0
      : behind;
  const ac =
    targetStats.ac +
    meleeAc(target, meleeReach(action) !== null, targetStats) +
    ((steady.bypassCover || resolution.attack.bypassCover || sworn) &&
    meleeReach(action) === null
      ? 0
      : cover);
  const critFrom = Math.min(
    criticalFrom(stats),
    ...stats.passives.flatMap((passive) =>
      passive.kind === "criticalRange" &&
      (passive.against !== undefined || passive.while !== undefined) &&
      (!passive.against || markedBy(target, attacker, passive.against)) &&
      (!passive.while ||
        (isMelee(action) && underEffect(attacker, passive.while)))
        ? [passive.from]
        : [],
    ),
  );
  // Underwater, a ranged weapon misses past its normal range.
  const drowned = beyondUnderwaterRange(
    attacker,
    target,
    action,
    resolution,
    state,
  );
  const judge = (natural: number, bonus: number) => {
    const sum = natural + base + bonus;
    return {
      total: sum,
      success:
        payload.hits === true ||
        (!drowned && (natural >= critFrom || (natural !== 1 && sum >= ac))),
      critical: payload.hits !== true && !drowned && natural >= critFrom,
    };
  };
  // Reactions to the roll before it lands, as Bountiful Luck or Second Chance (combat/reactions.ts).
  const window = rollWindow(
    { ...payload, target: target.id },
    {
      roller: attacker,
      kind: "attack",
      natural: first.natural,
      goal: ac,
      against: target,
      magical: action.spellLevel !== null,
      ...judge(first.natural, held?.bonus ?? 0),
    },
    { ...edge, base, bonus: held?.bonus ?? 0 },
    judge,
    context,
  );
  if ("frames" in window) {
    return {
      events: [...(lucky ?? []), ...guarded, ...window.events],
      frames: window.frames,
    };
  }
  const roll = { natural: window.natural };
  const total = judge(roll.natural, window.bonus).total;
  const struck = judge(roll.natural, window.bonus).success;
  // Boon of Combat Prowess's Peerless Aim: a miss hits instead, once until the bearer's next turn starts.
  const aimed =
    !struck &&
    hasPassive(stats, "peerlessAim") &&
    !attacker.usedThisTurn.includes(PEERLESS_AIM);
  const hits = struck || aimed;
  // A hit from within 5 feet on a Paralyzed or Unconscious target is a Critical Hit, unless the target's Adamantine
  // Armor makes it a normal one.
  const critical =
    !hasPassive(targetStats, "noCriticals") &&
    (roll.natural >= critFrom ||
      (hits &&
        isMelee(action) &&
        hasCondition(target, "paralyzed", "unconscious")));

  const report = dndEvent(`${NS}:rollReported`, {
    actor: attacker.id,
    against: target.id,
    natural: roll.natural,
    total,
    target: ac,
    success: hits,
    label: action.name,
  });
  // An effect like Guiding Bolt's lasts only until the next attack roll it applies to.
  const spent = [
    ...turnedOn(attacker, [target], stats),
    ...(lucky ?? []),
    ...duelBroken(attacker, [target], state),
    ...guarded,
    ...window.events,
    ...naturalOneEvents(attacker, roll.natural, context),
    ...(aimed
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: PEERLESS_AIM,
          }),
        ]
      : []),
    ...onceEnded(
      attacker,
      "attacks",
      undefined,
      resolution.attack.type === "weapon",
    ),
    ...actingEnds(attacker, action),
    ...(isMelee(action) ? prisonEvents(attacker, context) : []),
    ...onceEnded(target, "attacksAgainst", attacker.id),
    // Fancy Footwork: the creature it attacks in melee can't make Opportunity Attacks against it this turn.
    ...(isMelee(action) && hasPassive(stats, "fancyFootwork")
      ? [
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: FANCY_FOOTWORK,
              casterId: attacker.id,
              modifier: { kind: "mark" },
              ends: "casterTurnEnd",
            },
          }),
        ]
      : []),
    ...quiverDrawn(attacker, action, context),
    // Skulker's Sniper: a miss from hiding doesn't give the attacker away.
    ...(!hits && hasPassive(stats, "quietMiss")
      ? []
      : castRevealEvents(attacker, action.spellLevel !== null, stats.passives)),
    ...unwarded,
    // Attacking lowers the attacker's own Diabolic Ward until its next turn.
    ...(stats.passives.some(
      (passive) =>
        passive.kind === "ward" && passive.suppressed === "attacking",
    )
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: WARD_DOWN,
          }),
        ]
      : []),
  ];
  const hiddenWith = tacticsOf(attacker, "hidden")[0]?.value;
  const hit = {
    attacker: attacker.id,
    actionId: action.id,
    target: target.id,
    critical,
    hadAdvantage,
    ...(hadDisadvantage ? { hadDisadvantage: true } : {}),
    total,
    natural: roll.natural,
    ...(payload.slotLevel === undefined
      ? {}
      : { slotLevel: payload.slotLevel }),
    ...(payload.noModifier ? { noModifier: true } : {}),
    ...(payload.poleStrike ? { poleStrike: true } : {}),
    ...(payload.strikes ? { strikes: payload.strikes } : {}),
    ...(payload.leapt ? { leapt: payload.leapt } : {}),
    ...(payload.spell ? { spell: payload.spell } : {}),
    ...(payload.overcomes ? { overcomes: true } : {}),
    // The Stealth total it attacked from hiding with, for Supreme Sneak's Stealth Attack.
    ...(hiddenWith === undefined ? {} : { hidden: hiddenWith }),
  };

  if (!hits) {
    // A reroll starts the roll afresh, so what was held for a reaction goes.
    const reroll = offerInspiration(
      attacker,
      {
        attacker: payload.attacker,
        actionId: payload.actionId,
        target: target.id,
        ...(payload.slotLevel === undefined
          ? {}
          : { slotLevel: payload.slotLevel }),
        ...(payload.noModifier ? { noModifier: true } : {}),
        ...(payload.poleStrike ? { poleStrike: true } : {}),
      },
      report,
      hit,
      context,
    );
    if (reroll) {
      return {
        ...reroll,
        events: [...guarded, ...window.events, ...(reroll.events ?? [])],
      };
    }
    // Lightning Arrow takes the miss's place, so what a miss sets off waits on the answer.
    const instead = replaceHitFrame(hit, false, context);
    return {
      events: [report, ...spent, ...onceHitEnded(attacker)],
      frames: instead ? [instead] : missOutcome(hit, context),
    };
  }

  // Unbreakable Majesty: the first creature to hit the bearer on a turn saves or misses instead.
  const awed = majestic(attacker, target, targetStats, false, context);
  if (awed && !awed.saved) {
    return {
      events: [
        dndEvent(`${NS}:rollReported`, {
          actor: attacker.id,
          against: target.id,
          natural: roll.natural,
          total,
          target: ac,
          success: false,
          label: action.name,
        }),
        ...spent,
        ...awed.events,
      ],
      frames: missOutcome(hit, context),
    };
  }
  if (awed) spent.push(...awed.events);
  const duplicate = imageHit(attacker, target, context);
  if (duplicate) return { events: [report, ...spent, ...duplicate] };
  const reaction = reactionFor(
    target,
    total,
    ac,
    context,
    critical,
    meleeReach(action) !== null,
    action.spellLevel !== null,
    attacker,
    resolution.damage.map(({ type }) => type),
  );
  if (reaction) {
    return {
      events: [report, ...spent],
      frames: [
        awaitDecision({
          id: `${NS}:reaction:${target.id}`,
          actor: target.id,
          prompt: `${attacker.name} hits ${target.name} with ${action.name}. React?`,
          options: [
            { id: reaction.id, label: reaction.name },
            { id: DECLINE, label: "Take the hit" },
          ],
          resume: frame("afterReaction", hit),
        }),
      ],
    };
  }
  const guard = intercepted(hit, context);
  return { events: [report, ...spent, ...guard.events], frames: guard.frames };
}

export const AdvantageForgoneSchema = AttackSchema.extend({
  answer: z.string(),
});

// A strike option picked in place of an attack roll's Advantage, which the roll then goes without.
export function runAdvantageForgone(
  { answer, ...attack }: z.infer<typeof AdvantageForgoneSchema>,
  context: Context,
): SystemResult {
  const chosen = attack.strikes ?? [];
  if (answer === DECLINE) {
    return runAttackRoll({ ...attack, strikes: chosen }, context);
  }
  const [actionId = ""] = parseOption(answer);
  const next = { ...attack, strikes: [...chosen, actionId] };
  const more = forgoAdvantageFrame(next, context);
  if (more) return { frames: [more] };
  const rolled = runAttackRoll(next, context);
  return {
    ...rolled,
    // The roll it's picked for spends it, whether or not it hits.
    events: [
      ...next.strikes.map((id) =>
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: attack.attacker,
          key: onceKey(
            findAction(actorOf(context.state, attack.attacker), id, context),
          ),
        }),
      ),
      ...(rolled.events ?? []),
    ],
  };
}

// A strike option picked to give the roll Advantage, as a Martialist's Trip, or none.
export function runAdvantageGained(
  { answer, ...attack }: z.infer<typeof AdvantageForgoneSchema>,
  context: Context,
): SystemResult {
  if (answer === DECLINE) {
    return runAttackRoll({ ...attack, strikes: [] }, context);
  }
  const [actionId = ""] = parseOption(answer);
  const attacker = actorOf(context.state, attack.attacker);
  const chosen = findAction(attacker, actionId, context);
  // A Clockwork Amulet's 10 is paid for as it's picked, and is no strike of its own.
  const fixed = chosen.activation.trigger?.fixedRoll;
  if (fixed !== undefined) {
    const rolled = runAttackRoll({ ...attack, strikes: [], fixed }, context);
    return {
      ...rolled,
      events: [
        ...payCosts(chosen, attacker, context),
        ...(rolled.events ?? []),
      ],
    };
  }
  return runAttackRoll(
    { ...attack, strikes: [actionId], advantaged: true },
    context,
  );
}
