import { type Actor, dndEvent, hasCondition, NS } from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { lookup, spellSaveDc, type Stats } from "../../stats.ts";
import { MonsterSchema } from "../../schemas.ts";
import { type Context } from "../queries.ts";
import { leafEvents, rollSave } from "../effects.ts";

// Mirror Image: a d6 for each duplicate left, and on a 3 or higher the hit lands on one of them, which is gone.
// An attacker that is Blinded, or sees by Blindsight or Truesight, isn't fooled.
export function imageHit(
  attacker: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] | null {
  const images = target.activeEffects.find(
    ({ modifier }) => modifier.kind === "images",
  );
  if (images?.modifier.kind !== "images") return null;
  const senses =
    attacker.source.kind === "monster"
      ? (lookup(context, MonsterSchema, attacker.source.statBlockId).text ?? "")
      : "";
  const fooled =
    !hasCondition(attacker, "blinded") &&
    !/\b(?:blindsight|truesight) \d+ ft/i.test(senses) &&
    !attacker.activeEffects.some(
      ({ modifier }) => modifier.kind === "darkvision" && modifier.truesight,
    );
  const { count } = images.modifier;
  const rolls = Array.from({ length: count }, () => context.dice.roll(6));
  if (!fooled || rolls.every((roll) => roll < 3)) return null;
  return [
    dndEvent(`${NS}:effectEnded`, {
      actor: target.id,
      sourceId: images.sourceId,
    }),
    ...(count > 1
      ? [
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              ...images,
              modifier: { kind: "images", count: count - 1 },
            },
          }),
        ]
      : []),
  ];
}

// Unbreakable Majesty: the save of the first creature to hit the bearer on a turn, or with `before` of each
// creature as it first attacks it on a turn; null when none is called for.
export function majestic(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  before: boolean,
  context: Context,
): { readonly saved: boolean; readonly events: SystemEvent[] } | null {
  const majesty = target.activeEffects.find(
    ({ modifier }) =>
      modifier.kind === "majesty" && (modifier.before === true) === before,
  );
  if (majesty?.modifier.kind !== "majesty" || attacker.side === target.side) {
    return null;
  }
  const { combat } = context.state;
  const turn = `@${String(combat?.round ?? 0)}:${String(combat?.index ?? 0)}`;
  const key = before ? `majesty:${target.id}${turn}` : `majesty${turn}`;
  const holder = before ? attacker : target;
  if (holder.usedThisTurn.includes(key)) return null;
  const save = rollSave(
    attacker,
    majesty.modifier.ability,
    spellSaveDc(stats),
    context,
    true,
  );
  return {
    saved: save.saved,
    events: [
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: holder.id, key }),
      ...save.events,
      ...(before && save.saved
        ? leafEvents(
            [
              {
                kind: "modifier",
                modifier: {
                  kind: "disadvantage",
                  on: "saves",
                  casterSpells: true,
                },
                duration: { until: "yourNextTurnEnd" },
              },
            ],
            majesty.sourceId,
            target,
            attacker,
            context,
          )
        : []),
    ],
  };
}
