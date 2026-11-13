import { type ContentAccess, type SystemEvent } from "#sdk";
import { type Actor, dndEvent, type DndState, isDown, NS } from "../state.ts";
import { lookup } from "../stats.ts";
import { MonsterSchema } from "../schemas.ts";
import { distanceFeet, nearestOpen, type Square, squareKey } from "../grid.ts";
import { type Context } from "./queries.ts";
import { rollSave } from "./effects.ts";

// Swallowed: a monster took the creature out of its grapple and into itself (Swallow, a gug's Chew). The effects
// that came with it carry `swallowed` and the swallower as their caster. A swallowed creature can only reach the
// swallower, and gets out when the swallower drops, or regurgitates it after enough damage from inside in one turn.

// The creature that has swallowed this one, if any.
export function swallowerOf(actor: Actor): string | undefined {
  return actor.activeEffects.find((effect) => effect.swallowed)?.casterId;
}

// "If the worm takes 30 damage or more on a single turn from a creature inside it, … DC 21 Constitution saving
// throw … within 5 feet of the worm": read from the stat block, as an escape DC is.
function regurgitation(
  swallower: Actor,
  access: ContentAccess,
): {
  readonly damage: number;
  readonly dc: number;
  readonly feet: number;
} | null {
  if (swallower.source.kind !== "monster") return null;
  const { text = "" } = lookup(
    access,
    MonsterSchema,
    swallower.source.statBlockId,
  );
  const match =
    /\btakes (\d+) damage or more on a single turn from (?:a creature inside it|the swallowed creature|[^.,]*?\binside\b[^.,]*?)[^.]*?\bDC (\d+) Constitution saving throw[^.]*?\bwithin (\d+) feet\b/i.exec(
      text,
    );
  return match
    ? { damage: Number(match[1]), dc: Number(match[2]), feet: Number(match[3]) }
    : null;
}

// "can escape from the corpse by using 20 feet of movement": what getting out of a dead swallower costs.
function corpseExit(swallower: Actor, access: ContentAccess): number {
  if (swallower.source.kind !== "monster") return 0;
  const { text = "" } = lookup(
    access,
    MonsterSchema,
    swallower.source.statBlockId,
  );
  const feet =
    /\bescape from the corpse (?:by )?using (\d+) feet of movement/i.exec(
      text.replace(/\s+/g, " "),
    )?.[1];
  return Number(feet ?? 0);
}

// Out of the swallower, with the Prone condition, and within `feet` of it. Out of a corpse, it pays `exit` feet
// of movement: now, on its own turn, or else on its next one.
// shortcut: it stands outside at once, before it has paid them.
function releaseEvents(
  held: Actor,
  swallower: Actor,
  feet: number,
  state: DndState,
  exit = 0,
): SystemEvent[] {
  const sources = new Set(
    held.activeEffects.flatMap((effect) =>
      effect.swallowed && effect.casterId === swallower.id
        ? [effect.sourceId]
        : [],
    ),
  );
  const grid = state.combat?.grid;
  const from = swallower.position;
  const to =
    grid && from && held.position && distanceFeet(from, held.position) > feet
      ? nearestOpen(
          from,
          grid,
          new Set([
            ...(state.combat?.walls ?? []),
            ...Object.values(state.actors).flatMap((item) =>
              item.id !== held.id && item.position && !isDown(item)
                ? [squareKey(item.position)]
                : [],
            ),
            squareKey(from),
          ]),
        )
      : null;
  return [
    ...[...sources].map((sourceId) =>
      dndEvent(`${NS}:effectEnded`, {
        actor: held.id,
        sourceId,
        casterId: swallower.id,
      }),
    ),
    dndEvent(`${NS}:effectAdded`, {
      actor: held.id,
      effect: {
        sourceId: "swallowed",
        casterId: swallower.id,
        modifier: { kind: "condition", condition: "prone" },
        ends: "spellDuration",
      },
    }),
    ...exitEvents(held, to, exit, state),
  ];
}

function exitEvents(
  held: Actor,
  to: Square | null,
  exit: number,
  state: DndState,
): SystemEvent[] {
  const { order = [], index = 0 } = state.combat ?? {};
  const own = order[index] === held.id;
  const at = to ?? held.position;
  if (own || exit === 0) {
    return at && (to || exit > 0)
      ? [
          dndEvent(`${NS}:moved`, {
            actor: held.id,
            to: at,
            feet: own ? exit : 0,
          }),
        ]
      : [];
  }
  return [
    ...(to ? [dndEvent(`${NS}:moved`, { actor: held.id, to, feet: 0 })] : []),
    dndEvent(`${NS}:effectAdded`, {
      actor: held.id,
      effect: {
        sourceId: "swallowed:exit",
        casterId: held.id,
        modifier: { kind: "tactic", tactic: "exiting", value: exit },
        ends: "casterNextTurnEnd",
      },
    }),
  ];
}

function swallowedIn(state: DndState): readonly [Actor, string][] {
  return (state.combat?.order ?? []).flatMap((id) => {
    const held = state.actors[id];
    const by = held && swallowerOf(held);
    return held && by !== undefined ? [[held, by] as [Actor, string]] : [];
  });
}

// A swallower that's gone or down lets out everything inside it.
export function releasedSwallows(
  state: DndState,
  access: ContentAccess,
): SystemEvent[] {
  return swallowedIn(state).flatMap(([held, by]) => {
    const swallower = state.actors[by];
    if (!swallower) {
      return releaseEvents(held, { ...held, id: by, position: null }, 0, state);
    }
    return isDown(swallower)
      ? releaseEvents(
          held,
          swallower,
          regurgitation(swallower, access)?.feet ?? 5,
          state,
          corpseExit(swallower, access),
        )
      : [];
  });
}

// Damage a swallowed creature deals to its swallower, which counts toward regurgitating it.
export function insideDamageEvents(
  attacker: Actor,
  target: Actor,
  dealt: number,
): SystemEvent[] {
  return dealt > 0 && swallowerOf(attacker) === target.id
    ? [
        dndEvent(`${NS}:damagedFromInside`, {
          actor: target.id,
          amount: dealt,
        }),
      ]
    : [];
}

// At the end of a turn, a swallower that took enough damage from inside makes its save or lets everyone out.
export function regurgitationEvents(context: Context): SystemEvent[] {
  const { state } = context;
  return (state.combat?.order ?? []).flatMap((id) => {
    const swallower = state.actors[id];
    if (!swallower?.insideDamage || isDown(swallower)) return [];
    const rule = regurgitation(swallower, context);
    if (!rule || swallower.insideDamage < rule.damage) return [];
    const save = rollSave(swallower, "con", rule.dc, context);
    return [
      ...save.events,
      ...(save.saved
        ? []
        : swallowedIn(state).flatMap(([held, by]) =>
            by === id ? releaseEvents(held, swallower, rule.feet, state) : [],
          )),
    ];
  });
}
