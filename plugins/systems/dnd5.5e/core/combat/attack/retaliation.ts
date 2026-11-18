import { zoneGrants } from "../../zones.ts";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
} from "../../state.ts";
import { distanceFeet } from "../../grid.ts";
import { type SystemEvent } from "#sdk";
import { spared } from "../reactions.ts";
import {
  damageResponses,
  deriveStats,
  immuneToCondition,
  type KnownAction,
  passiveModifiers,
  evaluateFormula,
  rollAmount,
} from "../../stats.ts";
import { markedBy } from "../../trait-rules.ts";
import { type Context, isMelee, within5 } from "../queries.ts";
import { dealEvents, leafEvents, rollSave } from "../effects.ts";

// A melee hit from within 5 feet on a creature that strikes back, as Fire Shield's or Flames of Phlegethos' flames, a black
// pudding's acid or a mimic's glue, rolled with the bearer's numbers.
export function retaliated(
  attacker: Actor,
  target: Actor,
  action: KnownAction,
  context: Context,
  dealt = 0,
): SystemEvent[] {
  const close = isMelee(action) && within5(attacker, target);
  const stats = deriveStats(target, context);
  const onceKey = `retaliate:${attacker.id}`;
  const near = distanceFeet(attacker.position, target.position);
  // An aura's strikes back are worked out from its owner's numbers, as Holy Aura's save DC.
  const giver = new Map<Actor["activeEffects"][number]["modifier"], Actor>(
    zoneGrants(target, context.state, context).map(({ modifier, zone }) => [
      modifier,
      context.state.actors[zone.owner] ?? target,
    ]),
  );
  const attackerType = (
    deriveStats(attacker, context).creatureType ?? ""
  ).toLowerCase();
  const backs = [
    ...target.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
    ...giver.keys(),
  ].flatMap((modifier) =>
    modifier.kind === "retaliate" &&
    (!modifier.creatureTypes ||
      modifier.creatureTypes.includes(attackerType)) &&
    (modifier.within !== undefined
      ? near <= modifier.within
      : close || modifier.anyAttack === true) &&
    (!modifier.marked || markedBy(attacker, target, modifier.marked)) &&
    (!modifier.oncePerTurn || !attacker.usedThisTurn.includes(onceKey)) &&
    (!modifier.able || !hasCondition(target, ...INCAPACITATING)) &&
    !(modifier.halfDealt && spared(target, attacker))
      ? [modifier]
      : [],
  );
  if (backs.length === 0 || isDown(attacker)) return [];
  const responses = damageResponses(attacker, context);
  const hits = backs.flatMap(({ damage, halfDealt }) => [
    ...damage.map(({ amount, type }) => ({
      amount: rollAmount(amount, stats, context.dice),
      response: responses,
      type,
    })),
    ...(halfDealt && dealt > 1
      ? [
          {
            amount: Math.floor(dealt / 2),
            response: responses,
            type: halfDealt,
          },
        ]
      : []),
  ]);
  // Holy Aura: a save against the giver's DC, or the attacker gets the effects.
  const struck = backs.flatMap((back) => {
    if (!back.condition) return [];
    const by = giver.get(back) ?? target;
    const rolled = back.save
      ? rollSave(
          attacker,
          back.save.ability,
          evaluateFormula(back.save.dc, deriveStats(by, context)),
          context,
          true,
        )
      : { saved: false, events: [] };
    return [
      ...rolled.events,
      ...(rolled.saved
        ? []
        : leafEvents(
            [
              {
                kind: "applyCondition",
                condition: back.condition,
                duration: { until: "itsNextTurnEnd" },
                repeatSave: false,
                endsOnDamage: false,
              },
            ],
            `retaliate:${by.id}`,
            by,
            attacker,
            context,
          )),
    ];
  });
  const events = [
    ...struck,
    ...(backs.some(({ oncePerTurn }) => oncePerTurn)
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: onceKey,
          }),
        ]
      : []),
    ...dealEvents(attacker, hits, false, context).events,
  ];
  if (
    backs.some(({ grapple }) => grapple) &&
    !hasCondition(attacker, "grappled") &&
    !immuneToCondition(deriveStats(attacker, context), "grappled")
  ) {
    events.push(
      dndEvent(`${NS}:effectAdded`, {
        actor: attacker.id,
        effect: {
          sourceId: `${target.id}:adhesive`,
          casterId: target.id,
          modifier: { kind: "condition", condition: "grappled" },
          ends: "spellDuration",
        },
      }),
    );
  }
  return events;
}
