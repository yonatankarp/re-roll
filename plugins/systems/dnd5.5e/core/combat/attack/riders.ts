import { zoneGrants } from "../../zones.ts";
import { type Actor, dndEvent, type DndState, NS } from "../../state.ts";
import { spellOfSource } from "../ids.ts";
import { distanceFeet } from "../../grid.ts";
import { type SystemEvent } from "#sdk";
import { heldDie } from "../reactions.ts";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  cantripTier,
  scaleActivation,
  type Stats,
  scaledDice,
} from "../../stats.ts";
import { type Damage, type Resolution, SpellSchema } from "../../schemas.ts";
import { type Context, isMelee } from "../queries.ts";
import { leafEvents, typeAgainst } from "../effects.ts";
import { firesAmmunition } from "./ammunition.ts";

// A curse any of its caster's side spends by hitting, as Path to the Grave's, ends once a hit uses it.
export function sideRidersSpent(
  attacker: Actor,
  target: Actor,
  state: DndState,
) {
  return target.activeEffects.flatMap(({ modifier, sourceId, casterId }) =>
    (modifier.kind === "exposed" &&
      state.actors[casterId]?.side === attacker.side) ||
    (modifier.kind === "hitDamage" &&
      ((modifier.dealtBy === "side" &&
        state.actors[casterId]?.side === attacker.side) ||
        // Feinting Attack's die, on the creature feinted, goes with the caster's hit.
        (modifier.dealtBy === "caster" &&
          modifier.once === true &&
          casterId === attacker.id)))
      ? [
          dndEvent(`${NS}:effectEnded`, {
            actor: target.id,
            sourceId,
            casterId,
          }),
        ]
      : [],
  );
}

// Booming Blade: the spell whose weapon attack hit lands its other effects on the creature hit, grown with the
// caster's level as a cantrip's damage is.
export function spellHitEvents(
  sourceId: string | undefined,
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const spellId = sourceId ? spellOfSource(sourceId) : null;
  const spell = spellId
    ? SpellSchema.safeParse(context.content(spellId)).data
    : undefined;
  if (!sourceId || !spell?.activation) return [];
  const activation =
    spell.level === 0 && spell.cantrip
      ? scaleActivation(
          spell.activation,
          spell.cantrip.perTier,
          cantripTier(stats.level),
        )
      : spell.activation;
  const { resolution } = activation;
  if (resolution.kind !== "automatic") return [];
  return leafEvents(
    resolution.effects.filter((effect) => effect.kind !== "weaponAttack"),
    sourceId,
    attacker,
    target,
    context,
  );
}

// Extra damage riders: Divine Favor sits on the attacker, while Hex and Hunter's Mark sit on the target.
export function hitRiders(
  attacker: Actor,
  target: Actor,
  action: KnownAction,
  resolution: Extract<Resolution, { kind: "attack" }>,
  responses: ReturnType<typeof damageResponses>,
  context: Context,
): { readonly damage: readonly Damage[]; readonly events: SystemEvent[] } {
  const { state } = context;
  const seen = new Set<string>();
  const events: SystemEvent[] = [];
  const sided = (casterId: string) =>
    state.actors[casterId]?.side === attacker.side;
  const carried: {
    readonly effect: Pick<
      Actor["activeEffects"][number],
      "modifier" | "sourceId" | "casterId"
    >;
    readonly by: string;
  }[] = [
    ...attacker.activeEffects.map((effect) => ({ effect, by: "bearer" })),
    ...target.activeEffects.map((effect) => ({ effect, by: "caster" })),
    // What an aura the attacker stands in gives its hits, as Crusader's Mantle's Radiant.
    ...zoneGrants(attacker, state, context).map(({ modifier, zone }) => ({
      effect: { modifier, sourceId: zone.sourceId, casterId: zone.owner },
      by: "bearer",
    })),
  ];
  const damage = carried.flatMap(({ effect, by }) => {
    const { modifier, sourceId, casterId } = effect;
    if (
      modifier.kind !== "hitDamage" ||
      (modifier.dealtBy === "side"
        ? by !== "caster" || !sided(casterId)
        : modifier.dealtBy !== by ||
          (by === "caster" && casterId !== attacker.id)) ||
      (modifier.weaponOnly && resolution.attack.type !== "weapon") ||
      (modifier.melee && !isMelee(action)) ||
      (modifier.ammunition && !firesAmmunition(action, context)) ||
      (modifier.unarmed && !resolution.attack.unarmed) ||
      (modifier.within !== undefined &&
        distanceFeet(attacker.position, target.position) > modifier.within) ||
      (modifier.oncePerTurn &&
        attacker.usedThisTurn.includes(`${HIT_DAMAGE_ONCE}${sourceId}`)) ||
      seen.has(sourceId)
    ) {
      return [];
    }
    seen.add(sourceId);
    if (modifier.oncePerTurn) {
      events.push(
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: attacker.id,
          key: `${HIT_DAMAGE_ONCE}${sourceId}`,
        }),
      );
    }
    const type = modifier.types
      ? typeAgainst(modifier.types, responses)
      : modifier.damage.type;
    // A die another creature gave is its size, as Commander's Strike's Superiority Die.
    const giver = state.actors[casterId];
    const { amount } = modifier.damage;
    return [
      {
        ...modifier.damage,
        type,
        ...(giver &&
        giver.id !== attacker.id &&
        (amount.dieSize || amount.diceCount)
          ? {
              amount: {
                ...amount,
                dice:
                  scaledDice(amount, deriveStats(giver, context).scaling) ??
                  amount.dice,
                dieSize: undefined,
                diceCount: undefined,
              },
            }
          : {}),
      },
    ];
  });
  // Combat Inspiration's Offense: the attacker's Bardic Inspiration die, at its giver's size, added to the hit.
  const held = heldDie(attacker, context);
  const first = resolution.damage[0];
  if (
    held &&
    first &&
    held.stats.passives.some(({ kind }) => kind === "combatInspiration")
  ) {
    events.push(held.spent);
    damage.push({
      amount: {
        dice: scaledDice(held.amount, held.stats.scaling) ?? held.amount.dice,
      },
      type: first.type,
    });
  }
  return { damage, events };
}

// A once-a-turn hitDamage's use, by its source: "hitDamage:<source>".
const HIT_DAMAGE_ONCE = "hitDamage:";
