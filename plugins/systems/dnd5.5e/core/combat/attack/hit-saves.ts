import { type Actor, dndEvent, isDead, NS } from "../../state.ts";
import { distanceFeet } from "../../grid.ts";
import { type SystemEvent } from "#sdk";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  evaluateFormula,
  rollAmount,
  saveBonus,
} from "../../stats.ts";
import { finalDamage, halved } from "../../rules.ts";
import { conditionsApplied } from "../../legendary.ts";
import { type Resolution } from "../../schemas.ts";
import { rescuedSave, saveSourceOf, evades } from "../../trait-rules.ts";
import { type Context, exemptFrom } from "../queries.ts";
import { dealEvents, leafEvents, payCosts, rollSave } from "../effects.ts";
import { inOwnTurn } from "./attack-kind.ts";
import { hasUse } from "./hit-features.ts";

// The save a hit brings, as a ghoul's claw. Its effects have a source of their own, so a successful repeat save
// against them leaves a grapple from the same hit.
export function nestedSave(
  resolution: Extract<Resolution, { kind: "attack" }>,
  action: KnownAction,
  attacker: Actor,
  hit: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly dealt: number } {
  const printed = resolution.onHitSave;
  const target = context.state.actors[hit.id];
  if (!printed || !target || isDead(target)) return { events: [], dealt: 0 };
  const met = deriveStats(target, context);
  if (
    exemptFrom(printed.exempt, target, met) ||
    (printed.only && !exemptFrom(printed.only, target, met)) ||
    (printed.hpAtMost !== undefined &&
      (target.hp <= 0 || target.hp > printed.hpAtMost)) ||
    (printed.resource !== undefined &&
      !hasUse(attacker, deriveStats(attacker, context), printed.resource))
  ) {
    return { events: [], dealt: 0 };
  }
  const onceKey = `onhit:${printed.onceKey ?? action.id}`;
  const once = printed.oncePerTurn
    ? attacker.usedThisTurn.includes(onceKey) || !inOwnTurn(attacker, context)
      ? null
      : dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key: onceKey })
    : undefined;
  if (once === null) return { events: [], dealt: 0 };
  const save = {
    ...printed,
    ability:
      printed.orDex &&
      saveBonus(deriveStats(target, context), "dex") >
        saveBonus(deriveStats(target, context), printed.ability)
        ? ("dex" as const)
        : printed.ability,
  };
  const stats = deriveStats(attacker, context);
  const dc = evaluateFormula(save.dc, stats);
  const rolled = rollSave(
    target,
    save.ability,
    dc,
    context,
    false,
    0,
    conditionsApplied(save.onFail),
  );
  const rescued = rolled.saved
    ? []
    : rescuedSave(
        target,
        save.ability,
        conditionsApplied(save.onFail),
        deriveStats(target, context),
        rolled.events,
        [],
        context.dice,
        action.spellLevel !== null,
        {
          source: saveSourceOf(attacker, action.id, action.name, context),
          access: context,
        },
      );
  const succeeded = rolled.saved || rescued.length > 0;
  const responses = damageResponses(target, context);
  const damage = dealEvents(
    target,
    save.damage.flatMap(({ amount, type }) => {
      const total = rollAmount(amount, stats, context.dice);
      const scaled =
        save.onSuccessDamage === "half" && evades(target, save.ability, context)
          ? succeeded
            ? 0
            : halved(total)
          : !succeeded || save.onSuccessDamage === "full"
            ? total
            : save.onSuccessDamage === "half"
              ? halved(total)
              : 0;
      return scaled > 0
        ? [{ amount: finalDamage(scaled, type, responses), type }]
        : [];
    }),
    false,
    context,
  );
  const source = `${action.id}:save`;
  return {
    events: [
      ...(once ? [once] : []),
      ...rolled.events,
      ...rescued,
      ...damage.events,
      // A Nine Lives Stealer's charge goes with each life it takes, as a cost spends it.
      ...(printed.resource && !succeeded
        ? payCosts(
            {
              ...action,
              activation: {
                ...action.activation,
                cost: [{ resource: printed.resource }],
              },
            },
            attacker,
            context,
          )
        : []),
      ...leafEvents(
        succeeded ? save.onSuccess : save.onFail,
        source,
        attacker,
        target,
        context,
        { ability: save.ability, dc },
      ),
    ],
    dealt: damage.dealt,
  };
}

// The save a hit brings, on the target and, with `radius`, every other creature that near it but the attacker, as a
// Hammer of Thunderbolts' thunderclap; with `allHit`, only once each of the action's projectiles has hit the target
// this turn, as a Tentacle Rod's.
export function nestedSaves(
  resolution: Extract<Resolution, { kind: "attack" }>,
  action: KnownAction,
  attacker: Actor,
  hit: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly dealt: number } {
  const printed = resolution.onHitSave;
  if (!printed) return { events: [], dealt: 0 };
  const counted: SystemEvent[] = [];
  if (printed.allHit) {
    const key = `${ALL_HIT}${action.id}:${hit.id}:`;
    const landed = attacker.usedThisTurn.filter((used) =>
      used.startsWith(key),
    ).length;
    counted.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: attacker.id,
        key: `${key}${String(landed + 1)}`,
      }),
    );
    if (landed + 1 < (action.activation.projectiles ?? 1)) {
      return { events: counted, dealt: 0 };
    }
  }
  const around =
    printed.radius === undefined
      ? []
      : Object.values(context.state.actors).filter(
          (item) =>
            item.id !== hit.id &&
            item.id !== attacker.id &&
            !isDead(item) &&
            distanceFeet(hit.position, item.position) <= (printed.radius ?? 0),
        );
  const first = nestedSave(resolution, action, attacker, hit, context);
  const rest = around.map((item) =>
    nestedSave(resolution, action, attacker, item, context),
  );
  return {
    events: [
      ...counted,
      ...first.events,
      ...rest.flatMap(({ events }) => events),
    ],
    dealt: first.dealt,
  };
}

// A hit of an action's that a Tentacle Rod's save counts: "allHit:<action>:<target>:<n>".
const ALL_HIT = "allHit:";
