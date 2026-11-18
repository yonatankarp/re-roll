import {
  damageResponses,
  deriveStats,
  evaluateFormula,
  immuneToCondition,
  type KnownAction,
  modifierFor,
  rollAmount,
  rollDiceNotation,
  weaponAttackOf,
  type Stats,
} from "../../stats.ts";
import { metamagicSaves } from "../../metamagic.ts";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  type DndState,
  hasCondition,
  INCAPACITATING,
  familiarOwner,
  isDead,
  isDown,
  NS,
  frame,
} from "../../state.ts";
import {
  type Dice,
  type Frame,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { finalDamage, halved } from "../../rules.ts";
import {
  type Damage,
  type DamageType,
  type LeafEffect,
  SpellSchema,
} from "../../schemas.ts";
import {
  HIGHEST,
  masteredDice,
  maximized,
  flooredTypes,
  masteredTypes,
  rerolledTypes,
  piercing,
  interposedShield,
  evades,
  rescuedSave,
  saveSourceOf,
} from "../../trait-rules.ts";
import { ALL, THROW_PREFIX, weaponItemId } from "../ids.ts";
import { distanceFeet, inArea, type Square } from "../../grid.ts";
import { zoneModifiers, zonesOn } from "../../zones.ts";
import { coverAgainst } from "../../sight.ts";
import { teleportFrame } from "../movement.ts";
import {
  afterDamage,
  spellAimedAt,
  turnedOn,
  reactFrames,
  beforeFailedSave,
  slotRefund,
  tableOf,
  tableRoll,
} from "../reactions.ts";
import { channelPickFrame, fueledDamage, schoolOf } from "../school.ts";
import { summonEvents } from "../summon.ts";
import { conditionsApplied, legendaryResistance } from "../../legendary.ts";
import { insideDamageEvents } from "../swallow.ts";
import { isSpell, spellOf } from "../dispel.ts";
import { formFrame } from "../form-choice.ts";
import { damageTypeFrame, zoneTypeFrame } from "../damage-choice.ts";
import { focusFrame } from "../check-choice.ts";
import { optionFrame } from "../options.ts";
import { weaponAttackResult } from "../weapon-spell.ts";
import { duelBroken, duelDamaged } from "../duel.ts";
import { wishFrame } from "../wish.ts";
import {
  allies,
  attackRoutine,
  type Context,
  charmersOf,
  exemptFrom,
  hasPassive,
  isMelee,
  SIZES,
  sizeOf,
  spellSource,
} from "../queries.ts";
import { resolveTargets } from "./targets.ts";
import { payCosts } from "./costs.ts";
import { dealEvents, siphoned } from "./damage.ts";
import { leafEvents } from "./leaf.ts";
import { damageRiders } from "./riders.ts";
import { concentrationFrame } from "./concentration.ts";
import { typeAgainst } from "./damage-types.ts";
import {
  movedZone,
  zoneEvents,
  appearFrames,
  fissureEvents,
} from "./spell-zones.ts";
import { sharedHealing } from "./healing.ts";
import { warded, wardBroken } from "./death-ward.ts";
import { ownForm, effectEnds } from "./lasting.ts";
import { rolledActions } from "./rolled-actions.ts";
import {
  reactionMove,
  reactionAttack,
  forcedAttack,
} from "./forced-reactions.ts";
import {
  pairedBandSpares,
  deflectedSpell,
  backfireEvents,
} from "./magic-items.ts";
import { rollSave } from "./saves.ts";
import { multiattackFrames } from "./multiattack.ts";

// Resolving an action against its targets.

// Boon of Erupting Spellpower: a slot spell's surge, spending its use.
// shortcut: it's used on the first slot spell that deals damage, and comes back with a rest, not on rolling Initiative.
function overloaded(
  actor: Actor,
  action: KnownAction,
  stats: Stats,
): SystemEvent | null {
  if (action.spellLevel === null) return null;
  for (const passive of stats.passives) {
    if (
      passive.kind === "spellOverload" &&
      (actor.resourcesSpent[passive.resource] ?? 0) <
        (stats.resources[passive.resource] ?? 0)
    ) {
      return dndEvent(`${NS}:resourceSpent`, {
        actor: actor.id,
        resource: passive.resource,
      });
    }
  }
  return null;
}

// The owner's familiar within range takes the commanded action with its Reaction, as with Energy Pulse.
export function commandedFamiliar(
  effect: Extract<LeafEffect, { kind: "commandFamiliar" }>,
  owner: Actor,
  state: DndState,
): Actor | null {
  return (
    Object.values(state.actors).find(
      (item) =>
        familiarOwner(item) === owner.id &&
        !isDown(item) &&
        item.budget.reaction &&
        !hasCondition(item, ...INCAPACITATING) &&
        distanceFeet(owner.position, item.position) <= effect.range,
    ) ?? null
  );
}

function commandedResult(
  effect: Extract<LeafEffect, { kind: "commandFamiliar" }>,
  owner: Actor,
  context: Context,
): SystemResult {
  const familiar = commandedFamiliar(effect, owner, context.state);
  // "Attack": its first attack its owner can command, as Pact of the Chain's.
  const action =
    familiar &&
    deriveStats(familiar, context).actions.find((item) =>
      effect.action === "Attack"
        ? item.activation.resolution.kind === "attack" &&
          item.activation.trigger?.commanded === true
        : item.name === effect.action,
    );
  if (!familiar || !action) return {};
  const result = resolveAction(
    action,
    familiar,
    resolveTargets(ALL, action, familiar, context),
    context,
  );
  return {
    events: [...payCosts(action, familiar, context), ...(result.events ?? [])],
    frames: result.frames ?? [],
  };
}

// Storm's Strength: saves against the caster's spells dealing these types have Disadvantage.
function stormStrength(action: KnownAction, stats: Stats): boolean {
  if (action.spellLevel === null) return false;
  const types = action.activation.resolution.damage.map(({ type }) => type);
  return stats.passives.some(
    (passive) =>
      passive.kind === "stormStrength" &&
      passive.damage.some((type) => types.includes(type)),
  );
}

export function resolveAction(
  action: KnownAction,
  actor: Actor,
  aimedAt: readonly Actor[],
  context: Context,
  slotLevel?: number,
  critical = false,
  aim?: Square, // where an area was aimed, for a zone it leaves
): SystemResult {
  const { resolution } = action.activation;
  const stats = deriveStats(actor, context);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  // A helmed horror's Spell Immunity: the spells it names pass it by.
  const spell = isSpell(action, actor, context) ? action.name : null;
  // Shield against Magic Missile, or Spell Thief: a reaction may turn the spell aside before it lands.
  const aside = spell
    ? spellAimedAt(action, actor, aimedAt, context)
    : { targets: aimedAt, events: [] };
  events.push(...aside.events);
  if (spell) events.push(...turnedOn(actor, aside.targets, stats));
  const targets = spell
    ? sculpted(
        aside.targets.filter(
          (target) => !immuneToSpell(target, spell, context, action),
        ),
        action,
        actor,
        stats,
        context,
        slotLevel ?? action.spellLevel ?? 0,
      )
    : aimedAt;
  const mastered = masteredTypes(stats, action.spellLevel !== null);
  const floors = flooredTypes(stats, action.spellLevel !== null);
  const rerolled = rerolledTypes(stats, action.spellLevel !== null);
  // Another spell aimed at a creature ends what lasts only until one is, as Modify Memory's charm.
  const spellEnds = targets.flatMap((target) =>
    [
      ...new Set(
        target.activeEffects
          .filter(
            (effect) =>
              effect.endsOnSpell && effect.sourceId !== spellSource(action),
          )
          .map((effect) => effect.sourceId),
      ),
    ].map((sourceId) =>
      dndEvent(`${NS}:effectEnded`, { actor: target.id, sourceId }),
    ),
  );
  if (spellEnds.length > 0 && isSpell(action, actor, context)) {
    events.push(...spellEnds);
  }
  // Ending what the action it needs left on the target, as Quivering Palm's end.
  const { targeting } = action.activation;
  const afflicting =
    action.activation.endsAffliction && "afflicted" in targeting
      ? stats.actions.find(({ name }) => name === targeting.afflicted)?.id
      : undefined;
  if (afflicting) {
    events.push(
      ...targets.map((target) =>
        dndEvent(`${NS}:effectEnded`, {
          actor: target.id,
          sourceId: afflicting,
          casterId: actor.id,
        }),
      ),
    );
  }
  // One creature at a time: used again, it leaves the last one.
  if (action.activation.oneTarget) {
    for (const other of Object.values(context.state.actors)) {
      if (
        !targets.some(({ id }) => id === other.id) &&
        other.activeEffects.some(
          (item) => item.sourceId === action.id && item.casterId === actor.id,
        )
      ) {
        events.push(
          dndEvent(`${NS}:effectEnded`, {
            actor: other.id,
            sourceId: action.id,
            casterId: actor.id,
          }),
        );
      }
    }
  }
  if (spell) events.push(...duelBroken(actor, targets, context.state));

  const usesConcentration = (effects: readonly LeafEffect[]): boolean =>
    effects.some(
      (effect) =>
        (effect.kind === "modifier" ||
          effect.kind === "applyCondition" ||
          effect.kind === "zone" ||
          effect.kind === "polymorph" ||
          effect.kind === "choose" ||
          effect.kind === "summon") &&
        typeof effect.duration === "object" &&
        "concentration" in effect.duration,
    );

  const beginConcentration = (effects: readonly LeafEffect[]): void => {
    if (!usesConcentration(effects) && !action.concentrates) return;
    // What a held spell lets its caster do keeps that spell's Concentration, as Witch Bolt's later lightning.
    if (action.id.startsWith("lasting:") || action.id.startsWith("spheres:")) {
      return;
    }
    // An area acting later, at no cost, keeps the Concentration its spell began, as Conjure Elemental's spirit
    // restraining. A recast still begins it anew.
    if (
      action.activation.cost.length === 0 &&
      actor.concentratingOn === spellSource(action)
    ) {
      return;
    }
    if (actor.concentratingOn !== null) {
      events.push(dndEvent(`${NS}:concentrationEnded`, { actor: actor.id }));
    }
    events.push(
      dndEvent(`${NS}:concentrationStarted`, {
        actor: actor.id,
        spell: spellSource(action),
      }),
    );
  };

  let ridden = false;
  const overload = { prone: false };
  let lastDealt = 0;
  const pulled = new Set<string>(); // Pull of Death's once a turn, within this cast
  const applyRolled = (
    target: Actor,
    damage: readonly {
      readonly total: number;
      readonly type: Damage["type"];
    }[],
    scale: (amount: number) => number,
  ): void => {
    const result = dealEvents(
      target,
      damage.map(({ total, type }) => ({
        amount: finalDamage(
          scale(total),
          type,
          piercing(
            damageResponses(target, context),
            mastered,
            stats,
            action.id,
          ),
        ),
        type,
      })),
      false,
      context,
      actor,
      action.spellLevel !== null,
    );
    lastDealt = result.dealt;
    events.push(
      ...result.events,
      ...siphoned(action, actor, result.dealt, stats),
      ...insideDamageEvents(actor, target, result.dealt),
      ...duelDamaged(actor, target, result.dealt, context.state),
    );
    // Boon of Erupting Spellpower: each creature the surging spell damages is knocked Prone.
    if (overload.prone && result.dealt > 0) {
      events.push(
        ...leafEvents(
          [
            {
              kind: "applyCondition",
              condition: "prone",
              duration: { minutes: 1 },
              repeatSave: false,
              endsOnDamage: false,
            },
          ],
          "spell-overload",
          actor,
          target,
          context,
        ),
      );
    }
    // Pull of Death: a spell's damage by a save or with no roll, once a turn, to a creature already missing Hit
    // Points (combat/attack.ts adds it to an attack's).
    if (
      action.spellLevel !== null &&
      result.dealt > 0 &&
      resolution.kind !== "attack"
    ) {
      const hurt = target.hp < deriveStats(target, context).maxHp;
      stats.passives.forEach((passive, index) => {
        const key = `extra:${String(index)}`;
        if (
          !hurt ||
          passive.kind !== "extraDamage" ||
          passive.when !== "targetHurt" ||
          !passive.type ||
          (passive.oncePerTurn &&
            (actor.usedThisTurn.includes(key) || pulled.has(key)))
        ) {
          return;
        }
        if (passive.oncePerTurn) {
          pulled.add(key);
          events.push(
            dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key }),
          );
        }
        const now = events.reduce(applyDndEvent, context.state);
        events.push(
          ...dealEvents(
            now.actors[target.id] ?? target,
            [
              {
                amount: passive.dice
                  ? rollDiceNotation(passive.dice, context.dice)
                  : 0,
                type: passive.type,
              },
            ],
            false,
            { ...context, state: now },
          ).events,
        );
      });
    }
    // A spell's riders, as Putrefy's, go on the first creature it damages.
    // shortcut: only the first, since a use spent on one isn't seen by the next in the same cast.
    if (!ridden && action.spellLevel !== null && result.dealt > 0) {
      ridden = true;
      events.push(
        ...damageRiders(
          actor,
          target,
          new Set(damage.map(({ type }) => type)),
          false,
          stats,
          context,
          true,
        ),
      );
    }
    frames.push(
      ...afterDamage(
        target,
        result.dealt,
        {
          source: actor.id,
          types: damage.map(({ type }) => type),
          spell: action.spellLevel !== null,
        },
        concentrationFrame(
          target,
          result.dealt,
          hasPassive(stats, "concentrationBreaker"),
        ),
        { ...context, state: events.reduce(applyDndEvent, context.state) },
      ),
    );
  };

  const rollSharedDamage = (list: readonly Damage[]) => {
    const fuel =
      list.length > 0
        ? fueledDamage(actor, action, context)
        : { bonus: 0, events: [] };
    const maxed = maximized(
      actor,
      stats,
      list.map(({ type }) => type),
    );
    const surge =
      list.length > 0 && slotLevel !== undefined
        ? overloaded(actor, action, stats)
        : null;
    overload.prone = surge !== null;
    events.push(
      ...fuel.events,
      ...(maxed?.events ?? []),
      ...(surge ? [surge] : []),
    );
    const maxIndex = list.findIndex(({ type }) => type === maxed?.type);
    const floored = (dice: Dice): Dice =>
      surge
        ? {
            below: (count) => dice.below(count),
            roll: (sides) => Math.max(3, dice.roll(sides)),
          }
        : dice;
    const roll = (amount: Damage["amount"], type: DamageType, index: number) =>
      rollAmount(
        amount,
        stats,
        index === maxIndex
          ? HIGHEST
          : floored(masteredDice(context.dice, type, floors, rerolled)),
        critical ? 2 : 1,
      ) + (index === 0 ? fuel.bonus : 0);
    const shared = list.map(({ amount, type }, index) => ({
      total: roll(amount, type, index),
      type,
    }));
    // A larger die against a hurt target, or more dice against its kind, rolled once for all they reach.
    const later = new Map<string, number>();
    const once = (key: string, rolled: () => number): number => {
      const known = later.get(key) ?? rolled();
      later.set(key, known);
      return known;
    };
    return (target: Actor) => {
      const met = deriveStats(target, context);
      const hurt = target.hp < met.maxHp;
      return list.flatMap((item, index) => {
        if (item.except && exemptFrom(item.except, target, met)) return [];
        if (item.only && !exemptFrom(item.only, target, met)) return [];
        const { total = 0 } = shared[index] ?? {};
        const type = item.types
          ? typeAgainst(item.types, damageResponses(target, context))
          : item.type;
        const count = (item.amount.dice ?? "").split("d")[0] ?? "0";
        const dealt =
          item.hurtDie && hurt
            ? once(`hurt:${String(index)}`, () =>
                roll(
                  { ...item.amount, dice: `${count}d${String(item.hurtDie)}` },
                  type,
                  index,
                ),
              )
            : total;
        const { vs } = item;
        return [
          { total: dealt, type },
          ...(vs && exemptFrom(vs.creatureTypes, target, met)
            ? [
                {
                  total: once(`vs:${String(index)}`, () =>
                    rollDiceNotation(vs.dice, context.dice, critical ? 2 : 1),
                  ),
                  type,
                },
              ]
            : []),
        ];
      });
    };
  };

  switch (resolution.kind) {
    case "automatic": {
      beginConcentration(resolution.effects);
      // The Hide action as part of another, as Shrouding Spells', comes once the rest is done (actions.ts).
      if (resolution.effects.some((effect) => effect.kind === "hide")) {
        frames.push(frame("hideNow", { actor: actor.id }));
      }
      for (const effect of resolution.effects) {
        if (effect.kind === "moveZone" && aim) {
          const moved = movedZone(effect.source, actor, aim, context);
          events.push(...moved.events);
          frames.push(...moved.frames);
        }
      }
      for (const effect of resolution.effects) {
        if (effect.kind === "summon") {
          events.push(
            ...summonEvents(effect, action, actor, stats, context, slotLevel),
          );
        }
        if (effect.kind === "commandFamiliar") {
          const commanded = commandedResult(effect, actor, context);
          events.push(...(commanded.events ?? []));
          frames.push(...(commanded.frames ?? []));
        }
      }
      events.push(
        ...zoneEvents(
          resolution.effects,
          action,
          actor,
          context,
          aim,
          slotLevel,
        ),
      );
      frames.push(...appearFrames(action, actor, events, context));
      const element = zoneTypeFrame(
        resolution.effects,
        spellSource(action),
        actor,
      );
      if (element) frames.push(element);
      const damage = rollSharedDamage(resolution.damage);
      const shared = sharedHealing(resolution.effects, targets, actor, context);
      const slay = resolution.effects.find((effect) => effect.kind === "slay");
      for (const target of targets) {
        // Power Word Kill: a target with few enough Hit Points dies, and only the others take the damage.
        if (
          slay?.kind === "slay" &&
          target.hp > 0 &&
          target.hp <= slay.hpAtMost
        ) {
          if (warded(target)) {
            events.push(...wardBroken(target));
            continue;
          }
          events.push(
            dndEvent(`${NS}:damaged`, {
              actor: target.id,
              amount: target.hp + target.tempHp,
              type: "psychic",
              critical: false,
              massive: true,
            }),
            { kind: "actorDefeated", actor: target.id },
          );
          continue;
        }
        applyRolled(target, damage(target), (amount) => amount);
        events.push(
          ...leafEvents(
            // A spell's weapon attack lands its other effects only on a hit, as Booming Blade's (combat/attack.ts).
            weaponAttackOf(resolution) ? [] : shared(target),
            spellSource(action),
            actor,
            target,
            context,
            undefined,
            slotLevel,
          ),
        );
        const typed = damageTypeFrame(
          resolution.effects,
          spellSource(action),
          actor,
          target,
          slotLevel,
        );
        if (typed) frames.push(typed);
        const focus = focusFrame(
          resolution.effects,
          spellSource(action),
          actor,
          target,
          slotLevel,
        );
        if (focus) frames.push(focus);
        const picked = optionFrame(
          resolution.effects,
          spellSource(action),
          actor,
          target,
          undefined,
          slotLevel,
        );
        if (picked) frames.push(picked);
        // Where it lands is chosen, as a move is, and so is a form for a friend.
        for (const effect of resolution.effects) {
          if (
            effect.kind === "teleport" &&
            (target.id === actor.id || effect.others)
          ) {
            const { rolled } = effect;
            frames.push(
              teleportFrame(
                target,
                rolled
                  ? rolled.times *
                      context.dice.roll(
                        deriveStats(actor, context).scaling[rolled.dieSize] ??
                          6,
                      )
                  : effect.feet,
                effect.halfSpeed
                  ? Math.floor(deriveStats(target, context).speed / 2)
                  : effect.movement,
                context,
                effect.provokes,
                effect.beside === undefined
                  ? undefined
                  : { actor: actor.id, feet: effect.beside },
                action.id,
                effect.fly,
                effect.retrace,
              ),
            );
          }
          const choice =
            effect.kind === "polymorph" &&
            target.side === actor.side &&
            ownForm(target, actor)
              ? formFrame(
                  effect,
                  spellSource(action),
                  actor,
                  target,
                  effectEnds(effect.duration),
                  context,
                )
              : null;
          if (choice) frames.push(choice);
          if (effect.kind === "copySpell" && target.id === actor.id) {
            const wish = wishFrame(effect, spellSource(action), actor, context);
            if (wish) frames.push(wish);
          }
          if (effect.kind === "weaponAttack") {
            const made = weaponAttackResult(
              effect,
              spellSource(action),
              actor,
              target,
              context,
            );
            events.push(...made.events);
            frames.push(...made.frames);
          }
          if (effect.kind === "rollTable") {
            const table = tableOf(effect.from, context);
            // A channeled spirit is unleashed: its kept face, and the effect that kept it ends.
            const kept = effect.channeled
              ? actor.activeEffects.find(
                  ({ modifier }) =>
                    modifier.kind === "channeled" &&
                    modifier.from === effect.from,
                )
              : undefined;
            const face =
              kept?.modifier.kind === "channeled"
                ? kept.modifier.face
                : undefined;
            if (table && (!effect.channeled || face !== undefined)) {
              if (kept) {
                events.push(
                  dndEvent(`${NS}:effectEnded`, {
                    actor: actor.id,
                    sourceId: kept.sourceId,
                  }),
                );
              }
              const rolled = tableRoll(
                table,
                action,
                actor,
                undefined,
                target,
                slotLevel ?? action.spellLevel ?? 0,
                context,
                face,
              );
              events.push(...rolled.events);
              frames.push(...rolled.frames);
            }
          }
          // Teleport's getaway: the fight ends as a flight, where the story lets the party flee.
          if (effect.kind === "escape" && context.state.combat?.canFlee) {
            frames.push(frame("escape", { actor: actor.id }));
          }
          if (effect.kind === "channel" && effect.pick) {
            const table = tableOf(effect.from, context);
            const sides =
              deriveStats(actor, context).scaling[effect.dieSize] ?? 6;
            if (table) {
              frames.push(
                channelPickFrame(actor, effect.from, table, sides, target),
              );
            }
          }
          if (effect.kind === "randomAction") {
            const rolled = rolledActions(
              effect,
              action,
              actor,
              target,
              context,
              slotLevel,
            );
            events.push(...rolled.events);
            frames.push(...rolled.frames);
          }
          if (effect.kind === "reactionMove") {
            events.push(...reactionMove(target, context, effect, actor));
          }
          if (effect.kind === "reactionAttack") {
            const struck = reactionAttack(target, context);
            events.push(...struck.events);
            frames.push(...struck.frames);
          }
        }
        // A save round the target, as Jolt to Life's lightning (combat/spell-riders.ts).
        if (resolution.burst) {
          frames.push(
            frame("burst", {
              attacker: actor.id,
              actionId: action.id,
              target: target.id,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          );
        }
      }
      break;
    }
    case "save": {
      // Mythal Ward's 20 turns the whole spell aside, so what it has done so far is dropped (beforeFailedSave).
      const unspent = { events: events.length, frames: frames.length };
      beginConcentration(resolution.onFail);
      // A zone the spell leaves is left before the saves, so a cloud's first save comes from the cast.
      events.push(
        ...zoneEvents(
          [...resolution.onFail, ...resolution.onSuccess],
          action,
          actor,
          context,
          aim,
          slotLevel,
        ),
      );
      const element = zoneTypeFrame(
        [...resolution.onFail, ...resolution.onSuccess],
        spellSource(action),
        actor,
      );
      if (element) frames.push(element);
      const dc = evaluateFormula(resolution.dc, stats);
      // Damage against several targets at once is rolled once for all of them.
      const damage = rollSharedDamage(resolution.damage);
      const source = saveSourceOf(actor, action.id, action.name, context);
      const careful = metamagicSaves(
        action,
        actor,
        targets,
        modifierFor(stats, "cha"),
      );
      const { heightened } = careful;
      // Heightened Spell: the target's later saves against a spell held by Concentration are at Disadvantage too.
      if (heightened !== undefined && action.concentrates) {
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: heightened,
            effect: {
              sourceId: action.id,
              casterId: actor.id,
              modifier: {
                kind: "disadvantage",
                on: "saves",
                casterSpells: true,
              },
              ends: "concentration",
            },
          }),
        );
      }
      // Magical Ambush: an Invisible caster's spell is saved against with Disadvantage.
      const ambushing =
        action.spellLevel !== null &&
        hasCondition(actor, "invisible") &&
        hasPassive(stats, "magicalAmbush");
      const banded = pairedBandSpares(action, actor, stats, targets, context);
      events.push(...banded.events);
      const spared = new Set([...careful.spared, ...banded.spared]);
      for (const struck of targets) {
        if (resolution.heard && hasCondition(struck, "deafened")) continue;
        // Wail of the Banshee: a target with few enough Hit Points dies, and only the others save.
        if (
          resolution.slayAtMost !== undefined &&
          struck.hp > 0 &&
          struck.hp <= resolution.slayAtMost &&
          !warded(struck)
        ) {
          events.push(
            dndEvent(`${NS}:damaged`, {
              actor: struck.id,
              amount: struck.hp + struck.tempHp,
              type: resolution.damage[0]?.type ?? "psychic",
              critical: false,
              massive: true,
            }),
            { kind: "actorDefeated", actor: struck.id },
          );
          continue;
        }
        // Banishing Smite: the damage lands first, and only a target it leaves low enough saves.
        const landed = resolution.hpAtMost !== undefined;
        if (landed) applyRolled(struck, damage(struck), (amount) => amount);
        const target = landed
          ? (events.reduce(applyDndEvent, context.state).actors[struck.id] ??
            struck)
          : struck;
        if (
          resolution.hpAtMost !== undefined &&
          (target.hp <= 0 || target.hp > resolution.hpAtMost)
        ) {
          continue;
        }
        const met = deriveStats(target, context);
        const edges = (resolution.edges ?? []).flatMap((edge) =>
          (!edge.creatureTypes ||
            exemptFrom(edge.creatureTypes, target, met)) &&
          (!edge.minSize ||
            sizeOf(target, context) >= SIZES.indexOf(edge.minSize)) &&
          (!edge.maxScore ||
            met.abilities[edge.maxScore.ability] <= edge.maxScore.score) &&
          (!edge.immuneTo || immuneToCondition(met, edge.immuneTo)) &&
          (!edge.charmedByCaster || charmersOf(target).has(actor.id))
            ? [edge.roll]
            : [],
        );
        // Cause Fear: a creature of a type it can't touch is left out altogether.
        if (edges.includes("immune")) continue;
        // shortcut: cover counts from the caster, even for a sphere whose centre is elsewhere.
        const { saved: rolledSave, events: saveEvents } = spared.has(target.id)
          ? { saved: true, events: [] }
          : edges.includes("succeed") ||
              edges.includes("fail") ||
              (resolution.willing && target.side === actor.side)
            ? { saved: edges.includes("succeed"), events: [] }
            : rollSave(
                target,
                resolution.ability,
                dc,
                context,
                action.spellLevel !== null,
                coverAgainst(context.state, actor, target, context),
                conditionsApplied(resolution.onFail),
                heightened === target.id ||
                  edges.includes("disadvantage") ||
                  ambushing ||
                  stormStrength(action, stats),
                resolution.advantage === true || edges.includes("advantage"),
                source,
                action.saveDice
                  ? rollDiceNotation(action.saveDice, context.dice)
                  : 0,
              );
        events.push(...saveEvents);
        const resisted = rolledSave
          ? null
          : legendaryResistance(
              target,
              conditionsApplied(resolution.onFail),
              context,
              events,
            );
        if (resisted) events.push(resisted);
        const rescued =
          rolledSave || resisted
            ? []
            : rescuedSave(
                target,
                resolution.ability,
                conditionsApplied(resolution.onFail),
                deriveStats(target, context),
                saveEvents,
                events,
                context.dice,
                action.spellLevel !== null,
                { source, access: context },
              );
        events.push(...rescued);
        const saved = rolledSave || resisted !== null || rescued.length > 0;
        // Mythal Ward: a reaction before the failed save lands, which may make the spell do nothing to the target.
        if (!saved && action.spellLevel !== null) {
          const warded = beforeFailedSave(
            target,
            actor,
            slotLevel ?? action.spellLevel,
            context,
          );
          if (warded.negate) {
            events.length = unspent.events;
            frames.length = unspent.frames;
            events.push(
              ...warded.events,
              ...slotRefund(actor, action, slotLevel ?? action.spellLevel),
            );
            break;
          }
          events.push(...warded.events);
          frames.push(...warded.frames);
        }
        // Ring of Spell Turning: a spell up to some level does nothing to a target that saves against it.
        const school =
          action.spellLevel === null
            ? undefined
            : spellOf(action.id, actor, context)?.school;
        // A spell's own, as Holy Star of Mystra's mote, turns spells the same way.
        const held = target.activeEffects.flatMap(({ modifier }) =>
          modifier.kind === "spellTurning"
            ? [{ ...modifier, schools: undefined, resource: undefined }]
            : [],
        );
        const turning = saved
          ? [...deriveStats(target, context).passives, ...held].find(
              (passive) =>
                passive.kind === "spellTurning" &&
                action.spellLevel !== null &&
                (slotLevel ?? action.spellLevel) <= passive.upTo &&
                (!passive.schools ||
                  (school !== undefined && passive.schools.includes(school))),
            )
          : undefined;
        const turned = turning?.kind === "spellTurning" && !turning.deflectOnly;
        // And with its Reaction, a spell aimed at it alone is turned back at its caster, who saves against it.
        if (turning?.kind === "spellTurning" && targets.length === 1) {
          const deflected = deflectedSpell(
            action,
            actor,
            target,
            context,
            turning,
          );
          events.push(...deflected.events);
          frames.push(...deflected.frames);
        }
        const evaded =
          resolution.onSuccessDamage === "half" &&
          (evades(
            target,
            resolution.ability,
            context,
            action.spellLevel !== null,
          ) ||
            (action.spellLevel !== null &&
              zonesOn(target, context.state, context).some(
                (zone) => zone.area?.magicWard,
              )));
        const interposed =
          saved &&
          !evaded &&
          resolution.damage.length > 0 &&
          resolution.ability === "dex" &&
          resolution.onSuccessDamage === "half" &&
          !spared.has(target.id)
            ? interposedShield(target, deriveStats(target, context), context)
            : null;
        if (interposed) events.push(interposed);
        lastDealt = 0;
        const scaled = (amount: number): number => {
          if (turned) return 0;
          if (evaded) return saved ? 0 : halved(amount);
          if (!saved || resolution.onSuccessDamage === "full") return amount;
          return resolution.onSuccessDamage === "half" &&
            !spared.has(target.id) &&
            !interposed
            ? halved(amount)
            : 0;
        };
        // Lightning Lure's damage waits on where its pull leaves the target.
        const within = resolution.damageWithin;
        if (!landed && within === undefined) {
          applyRolled(target, damage(target), scaled);
        }
        // A Helm of Brilliance: Fire from a failed save against a spell may set its gems off.
        if (!saved && !turned && lastDealt > 0 && action.spellLevel !== null) {
          events.push(
            ...backfireEvents(
              target,
              resolution.damage.map(({ type }) => type),
              {
                ...context,
                state: events.reduce(applyDndEvent, context.state),
              },
            ),
          );
        }
        events.push(
          ...leafEvents(
            turned ? [] : saved ? resolution.onSuccess : resolution.onFail,
            spellSource(action),
            actor,
            target,
            context,
            { ability: resolution.ability, dc },
            slotLevel,
          ),
        );
        if (!landed && within !== undefined) {
          const now = events.reduce(applyDndEvent, context.state).actors[
            target.id
          ];
          if (now && distanceFeet(actor.position, now.position) <= within) {
            applyRolled(target, damage(target), scaled);
          }
        }
        // A willing ally of Polymorph's that fails it by choice: the caster picks its form.
        for (const effect of turned || saved ? [] : resolution.onFail) {
          const choice =
            effect.kind === "polymorph" &&
            target.side === actor.side &&
            ownForm(target, actor)
              ? formFrame(
                  effect,
                  spellSource(action),
                  actor,
                  target,
                  effectEnds(effect.duration),
                  context,
                )
              : null;
          if (choice) frames.push(choice);
        }
        // Detonate: an explosion round the target once its own save is done (combat/spell-riders.ts).
        if (resolution.burst) {
          frames.push(
            frame("burst", {
              attacker: actor.id,
              actionId: action.id,
              target: target.id,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          );
        }
        const focused = turned
          ? null
          : focusFrame(
              saved ? resolution.onSuccess : resolution.onFail,
              spellSource(action),
              actor,
              target,
              slotLevel,
            );
        if (focused) frames.push(focused);
        const picked = turned
          ? null
          : optionFrame(
              saved ? resolution.onSuccess : resolution.onFail,
              spellSource(action),
              actor,
              target,
              { ability: resolution.ability, dc },
              slotLevel,
            );
        if (picked) frames.push(picked);
        // Harm: the damage taken comes off the Hit Point maximum too.
        // Aura of Life keeps the maximum whole.
        if (
          !saved &&
          !turned &&
          lastDealt > 0 &&
          resolution.onFail.some((effect) => effect.kind === "drainMaxHp") &&
          !zoneModifiers(target, context.state, context).some(
            (modifier) => modifier.kind === "keepMaxHp",
          )
        ) {
          const now = events.reduce(applyDndEvent, context.state).actors[
            target.id
          ];
          const max = Math.max(
            1,
            deriveStats(target, context).maxHp - lastDealt,
          );
          if (now) {
            events.push(
              dndEvent(`${NS}:maxHpReduced`, {
                actor: target.id,
                amount: lastDealt,
                ...(now.hp > max ? { hp: max } : {}),
              }),
            );
          }
        }
        // Disintegrate: a character it drops is dust, past death saves.
        if (
          !saved &&
          !turned &&
          target.side === "party" &&
          resolution.onFail.some((effect) => effect.kind === "disintegrate")
        ) {
          const now = events.reduce(applyDndEvent, context.state).actors[
            target.id
          ];
          if (now && now.hp <= 0 && !isDead(now)) {
            events.push(
              dndEvent(`${NS}:damaged`, {
                actor: target.id,
                amount: 0,
                type: "force",
                critical: false,
                massive: true,
              }),
              dndEvent(`${NS}:disintegrated`, { actor: target.id }),
              { kind: "actorDefeated", actor: target.id },
            );
          }
        }
        if (!saved) {
          const forced = forcedAttack(
            resolution.onFail,
            actor,
            target,
            context,
          );
          events.push(...forced.events);
          frames.push(...forced.frames);
          for (const effect of turned ? [] : resolution.onFail) {
            if (effect.kind === "reactionMove") {
              const now = events.reduce(applyDndEvent, context.state).actors[
                target.id
              ];
              if (now)
                events.push(...reactionMove(now, context, effect, actor));
            }
          }
        }
        // A reaction to how the save went, as Mind Corrosion or Spell Reflection.
        frames.push(
          ...reactFrames(
            {
              kind: "saved",
              actor: target.id,
              source: actor.id,
              success: saved,
              spell: action.spellLevel !== null,
              conditions: conditionsApplied(resolution.onFail),
            },
            context,
          ),
        );
      }
      // One creature of the caster's choice in the area, the most hurt of its side there, also gets these, as
      // Wither and Bloom's Hit Point Dice.
      const { targeting } = action.activation;
      if (resolution.chosen && "area" in targeting) {
        const caught = [actor, ...allies(context.state, actor)].filter(
          (item) =>
            !isDead(item) &&
            inArea(
              targeting.area.shape,
              targeting.area.radius,
              actor.position,
              aim ?? actor.position,
              item.position,
            ),
        );
        const now = events.reduce(applyDndEvent, context.state);
        const missing = (item: Actor) =>
          deriveStats(item, context).maxHp -
          (now.actors[item.id]?.hp ?? item.hp);
        const chosen = [...caught].sort((a, b) => missing(b) - missing(a))[0];
        if (chosen && missing(chosen) > 0) {
          events.push(
            ...leafEvents(
              resolution.chosen,
              spellSource(action),
              actor,
              now.actors[chosen.id] ?? chosen,
              { ...context, state: now },
              undefined,
              slotLevel,
            ),
          );
        }
      }
      if (resolution.fissure) {
        events.push(
          ...fissureEvents(
            resolution.fissure,
            resolution.ability,
            dc,
            action,
            actor,
            targets,
            frames,
            { ...context, state: events.reduce(applyDndEvent, context.state) },
          ),
        );
      }
      break;
    }
    case "attack": {
      // A spell attack that leaves something held by Concentration begins it, as Spiritual Weapon's force.
      beginConcentration([...resolution.onHit, ...resolution.onMiss]);
      const thrown: Frame[] = [];
      for (const target of targets) {
        for (const actionId of attackRoutine(action, actor, stats)) {
          frames.push(
            frame("attackRoll", {
              attacker: actor.id,
              actionId,
              target: target.id,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          );
          // Let go once the rolls are done, since each looks the weapon up again.
          if (actionId.startsWith(THROW_PREFIX)) {
            thrown.push(
              frame("throwWeapon", {
                actor: actor.id,
                item: weaponItemId(actionId),
                target: target.id,
              }),
            );
          }
        }
        // Hit or miss, the shard bursts round the target, as Ice Knife's.
        if (resolution.burst) {
          frames.push(
            frame("burst", {
              attacker: actor.id,
              actionId: action.id,
              target: target.id,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          );
        }
      }
      frames.push(...thrown);
      frames.push(...multiattackFrames(action, actor, targets[0], context));
      break;
    }
    default:
      resolution satisfies never;
  }
  return { events, frames };
}

// Spell Immunity names spells by id; a spell is known here by its name, as a monster's cast of it carries.
// Reflective Carapace adds every spell that makes a ranged attack roll.
// shortcut: the carapace's 6 that turns the spell back on its caster is left out; the spell only misses it.
function immuneToSpell(
  target: Actor,
  spell: string,
  context: Context,
  action: KnownAction,
): boolean {
  const { resolution } = action.activation;
  const rangedAttack =
    resolution.kind === "attack" &&
    resolution.attack.type === "spell" &&
    !isMelee(action);
  return deriveStats(target, context).passives.some(
    (passive) =>
      passive.kind === "spellImmunity" &&
      ((passive.rangedAttacks === true && rangedAttack) ||
        passive.spells.some(
          (id) =>
            SpellSchema.safeParse(context.content(id)).data?.name === spell,
        )),
  );
}

// Evocation Sculptor: an area spell passes over the caster and up to that many of its side, who save and take nothing.
// Sculpt Spells: only an Evocation, sparing 1 plus the spell's level of the caster's side.
// shortcut: the spared are the caster's side, the ones it would pick, and they're spared the whole spell.
function sculpted(
  targets: readonly Actor[],
  action: KnownAction,
  actor: Actor,
  stats: ReturnType<typeof deriveStats>,
  context: Context,
  slotLevel: number,
): readonly Actor[] {
  const school = schoolOf(action.id, context);
  const sculptor = stats.passives.find(
    (passive) =>
      passive.kind === "sculptor" &&
      (!passive.schools || passive.schools.some((item) => item === school)),
  );
  if (
    sculptor?.kind !== "sculptor" ||
    !("area" in action.activation.targeting)
  ) {
    return targets;
  }
  const most = sculptor.creatures + (sculptor.perLevel ? slotLevel : 0);
  let spared = 0;
  return targets.filter((target) => {
    if (target.side !== actor.side) return true;
    if (target.id === actor.id && !sculptor.perLevel) return false;
    spared += 1;
    return spared > most;
  });
}
