import {
  deriveStats,
  lookup,
  spellAttackBonus,
  spellSaveDc,
} from "../../stats.ts";
import { type Actor, dndEvent, freshActor, isDead, NS } from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { type LeafEffect, type Monster, MonsterSchema } from "../../schemas.ts";
import { distanceFeet, type Square } from "../../grid.ts";
import { teleportSquares } from "../movement.ts";
import { boosted } from "../summon.ts";
import { type Context } from "../queries.ts";

// Creatures brought to life, and corpses raised.

// Copies of a monster, or another stat block, come to life next to the bearer, as Animate Trees or Soul Tattoo.
// shortcut: they stay until they drop, not until the bearer dies or moves too far away; with `duration` they go when
// what called them (`sourceId`) ends, which outside Concentration is the fight's end.
export function animatedEvents(
  effect: Extract<LeafEffect, { kind: "animate" }>,
  actor: Actor,
  context: Context,
  sourceId?: string,
  slotted?: boolean,
): SystemEvent[] {
  const id =
    effect.monster ??
    (actor.source.kind === "monster" ? actor.source.statBlockId : undefined);
  if (!id) return [];
  const monster = lookup(context, MonsterSchema, id);
  const open = [
    ...teleportSquares(actor, effect.range, 0, context.state, context),
  ].sort(
    (a, b) => distanceFeet(actor.position, a) - distanceFeet(actor.position, b),
  );
  const made = Object.keys(context.state.actors).filter((key) =>
    key.startsWith(`${actor.id}:animated-`),
  ).length;
  // Manual of Golems: its maker keeps the golem, to bring it to later fights.
  const stats = deriveStats(actor, context);
  const kept =
    effect.lasting && actor.source.kind !== "monster"
      ? [
          dndEvent(`${NS}:companionFound`, {
            actor: actor.id,
            feature: id,
            companion: id,
            maxHp: monster.hp,
            proficiency: stats.proficiency,
            spellAttack: spellAttackBonus(stats),
            spellDc: spellSaveDc(stats),
            free: true,
            monster: true,
          }),
        ]
      : [];
  return [
    ...kept,
    ...animatedSummons(effect, actor, monster, id, open, made, context, {
      sourceId,
      slotted: slotted ?? false,
    }),
  ];
}

function animatedSummons(
  effect: Extract<LeafEffect, { kind: "animate" }>,
  actor: Actor,
  monster: Monster,
  id: string,
  open: readonly Square[],
  made: number,
  context: Context,
  { sourceId, slotted }: { sourceId: string | undefined; slotted: boolean }, // what called them, for how long and what boosts them
): SystemEvent[] {
  return open.slice(0, effect.count).map((square, index) =>
    dndEvent(`${NS}:summoned`, {
      actor: boosted(
        {
          ...freshActor({
            id: `${actor.id}:animated-${String(made + index + 1)}`,
            name: `${monster.name} ${String(made + index + 1)}`,
            side: effect.hostile
              ? actor.side === "party"
                ? "enemy"
                : "party"
              : actor.side,
            source: {
              kind: "monster",
              statBlockId: id,
              ...(effect.lacks.length > 0 ? { lacks: effect.lacks } : {}),
              // a character's beasts die at 0 Hit Points, as monsters do, and leave with the fight
              ...(actor.source.kind === "monster"
                ? {}
                : { calledBy: actor.id }),
              // Find Greater Steed's mount stays between fights.
              ...(effect.lasting && actor.source.kind !== "monster"
                ? { lasting: { feature: id } }
                : {}),
              ...(effect.duration && sourceId
                ? {
                    lasts: {
                      casterId: actor.id,
                      sourceId,
                      concentration:
                        typeof effect.duration === "object" &&
                        "concentration" in effect.duration,
                    },
                  }
                : {}),
            },
            hp: monster.hp,
            inventory: [],
          }),
          position: square,
        },
        actor,
        sourceId,
        slotted,
        context,
      ),
      after: actor.id,
    }),
  );
}

// A corpse rises in its own square, on the raiser's side, taking its turns right after the raiser's.
// shortcut: how long it has been dead, and how many the raiser already controls, aren't counted.
export function raisedEvents(
  effect: Extract<LeafEffect, { kind: "raiseCorpse" }>,
  actor: Actor,
  context: Context,
  slain?: Actor, // the target its action just killed, the only corpse a `slain` raising takes
  source?: string, // the spell that raised it, for what boosts the raiser's undead
): SystemEvent[] {
  const { state } = context;
  const corpses = Object.values(state.actors).filter(
    (item) =>
      (!effect.slain || item.id === slain?.id) &&
      isDead(item) &&
      item.position !== null &&
      state.actors[`${item.id}:risen`] === undefined &&
      distanceFeet(actor.position, item.position) <= effect.range &&
      effect.creatureTypes.includes(
        deriveStats(item, context).creatureType ?? "",
      ),
  );
  const monster = lookup(context, MonsterSchema, effect.monster);
  return (effect.all ? corpses : corpses.slice(0, 1)).map((corpse) =>
    dndEvent(`${NS}:summoned`, {
      actor: boosted(
        {
          ...freshActor({
            id: `${corpse.id}:risen`,
            name: `${monster.name} (${corpse.name})`,
            side: actor.side,
            source: {
              kind: "monster",
              statBlockId: effect.monster,
              // a character's dead die again at 0 Hit Points, and leave with the fight
              ...(actor.source.kind === "monster"
                ? {}
                : { calledBy: actor.id }),
            },
            hp: monster.hp,
            inventory: [],
          }),
          position: corpse.position,
        },
        actor,
        source,
        false,
        context,
      ),
      after: actor.id,
    }),
  );
}
