import type { ContentAccess, SystemEvent } from "#sdk";
import { type KnownAction, lookup } from "../stats.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  hasCondition,
  NS,
} from "../state.ts";
import {
  type Condition,
  MonsterSchema,
  type Spell,
  SpellSchema,
} from "../schemas.ts";
import { slugOf } from "../import/spells.ts";
import { spellOfSource } from "./ids.ts";
import { distanceFeet, type Square } from "../grid.ts";

// Ending conditions and spells on a creature, as Lesser Restoration and Dispel Magic do.

// The order a cure picks in when the target has several: what hampers it most first.
const WORST_FIRST: readonly Condition[] = [
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
  "incapacitated",
  "restrained",
  "blinded",
  "charmed",
  "frightened",
  "poisoned",
  "grappled",
  "prone",
  "deafened",
  "invisible",
];

// The condition a cure of these would end on the target, or null when it has none of them.
export function cureFor(
  target: Actor,
  conditions: readonly Condition[],
): Condition | null {
  return (
    WORST_FIRST.find(
      (condition) =>
        conditions.includes(condition) && hasCondition(target, condition),
    ) ?? null
  );
}

// A spell's level from the id its effects carry: a character's "spell:<id>", or a monster's own spell action,
// found by its name. null for anything that isn't a spell.
export function spellLevelOf(
  sourceId: string,
  caster: Actor | undefined,
  access: ContentAccess,
): number | null {
  return spellOf(sourceId, caster, access)?.level ?? null;
}

// The spell an action casts: a character's own, or the one a monster's action is named for.
export function spellOf(
  sourceId: string,
  caster: Actor | undefined,
  access: ContentAccess,
): Spell | null {
  const own = spellOfSource(sourceId);
  if (own) return SpellSchema.safeParse(access.content(own)).data ?? null;
  const index = /^monster:(\d+)$/.exec(sourceId)?.[1];
  if (index === undefined || caster?.source.kind !== "monster") return null;
  const monster = lookup(access, MonsterSchema, caster.source.statBlockId);
  const name = monster.actions[Number(index)]?.name;
  if (!name) return null;
  const suffix = `:spell/${slugOf(name)}`;
  const id = access.contentIds().find((item) => item.endsWith(suffix));
  return id ? (SpellSchema.safeParse(access.content(id)).data ?? null) : null;
}

// A character's spell, or a monster's action that casts one.
export function isSpell(
  action: KnownAction,
  caster: Actor,
  access: ContentAccess,
): boolean {
  return (
    action.spellLevel !== null ||
    spellLevelOf(action.id, caster, access) !== null
  );
}

export interface Dispelled {
  readonly sourceId: string;
  readonly casterId: string;
  readonly concentration: boolean;
  readonly level: number;
}

// Each spell on the target that a dispel of this level ends, once per caster.
export function dispellable(
  target: Actor,
  maxLevel: number,
  state: DndState,
  access: ContentAccess,
  hostile = false, // only the target's foes' spells
): readonly Dispelled[] {
  const found = new Map<string, Dispelled>();
  for (const effect of target.activeEffects) {
    if (effect.modifier.kind === "tactic") continue;
    if (hostile && state.actors[effect.casterId]?.side === target.side) {
      continue;
    }
    const key = `${effect.casterId} ${effect.sourceId}`;
    if (found.has(key)) continue;
    // shortcut: a monster's spell cast at a higher level counts at its own, since its effects don't say.
    const level =
      effect.level ??
      spellLevelOf(effect.sourceId, state.actors[effect.casterId], access);
    if (level === null || level > maxLevel) continue;
    found.set(key, {
      sourceId: effect.sourceId,
      casterId: effect.casterId,
      concentration: effect.ends === "concentration",
      level,
    });
  }
  return [...found.values()];
}

// Darkness dispels the light of a spell of level 2 or lower whose area overlaps it.
const casterOf = (
  context: { readonly state: DndState },
  id: string,
): Actor | undefined => context.state.actors[id];

export function snuffedLights(
  at: Square,
  radius: number,
  context: ContentAccess & { readonly state: DndState },
): SystemEvent[] {
  return Object.values(context.state.actors).flatMap((actor) =>
    actor.activeEffects.flatMap(({ modifier, sourceId, casterId, level }) =>
      ((modifier.kind === "zone" &&
        (modifier.zone === "light" || modifier.zone === "dim") &&
        distanceFeet(modifier.at, at) <=
          modifier.radius + (modifier.dim ?? 0) + radius) ||
        // the light a spell makes a creature shed, as Faerie Fire's
        (modifier.kind === "sheds" &&
          distanceFeet(actor.position, at) <=
            modifier.feet + (modifier.dim ?? 0) + radius)) &&
      (level ??
        spellLevelOf(sourceId, casterOf(context, casterId), context) ??
        9) <= 2
        ? [
            dndEvent(`${NS}:effectEnded`, {
              actor: actor.id,
              sourceId,
              casterId,
            }),
          ]
        : [],
    ),
  );
}

// The spell ends, so one held by Concentration ends for everyone it touched.
export function dispelEvents(
  target: Actor,
  maxLevel: number,
  state: DndState,
  access: ContentAccess,
  hostile = false,
  // with this, a spell above `maxLevel` ends only on a check passed against 10 plus its level
  check?: (dc: number) => { readonly success: boolean; events: SystemEvent[] },
): SystemEvent[] {
  const events: SystemEvent[] = [];
  const ended = new Set<string>();
  for (const { sourceId, casterId, concentration, level } of dispellable(
    target,
    check ? 9 : maxLevel,
    state,
    access,
    hostile,
  )) {
    if (level > maxLevel && check) {
      const rolled = check(10 + level);
      events.push(...rolled.events);
      if (!rolled.success) continue;
    }
    const caster = state.actors[casterId];
    if (concentration && caster?.concentratingOn === sourceId) {
      if (ended.has(casterId)) continue;
      ended.add(casterId);
      events.push(dndEvent(`${NS}:concentrationEnded`, { actor: casterId }));
      continue;
    }
    events.push(
      dndEvent(`${NS}:effectEnded`, { actor: target.id, sourceId, casterId }),
    );
  }
  return events;
}
