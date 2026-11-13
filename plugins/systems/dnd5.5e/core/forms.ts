import type { ContentAccess } from "#sdk";
import { type Monster, MonsterSchema } from "./schemas.ts";
import type { Actor, DndState } from "./state.ts";

// Another creature's shape, as Polymorph gives: the form's stat block replaces the creature's own while it keeps its
// Hit Points (stats.ts), and the form's Hit Points come as Temporary Hit Points that end it when they run out.

export function formOf(actor: Actor): string | null {
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "form") return modifier.monster;
  }
  return null;
}

// "CR 1/4 (XP 50; PB +2)" in the stat block's text.
export function challengeOf(monster: Monster): number | null {
  const [, whole, over] =
    /\bCR (\d+)(?:\/(\d+))?\b/.exec(monster.text ?? "") ?? [];
  if (whole === undefined) return null;
  return over === undefined ? Number(whole) : Number(whole) / Number(over);
}

// A character's level, or a monster's Challenge Rating.
export function levelOrChallenge(actor: Actor, access: ContentAccess): number {
  if (actor.source.kind === "character") {
    return actor.source.build?.levels.length ?? 1;
  }
  if (actor.source.kind === "summon") return 0; // its Challenge Rating is None
  const entry = access.content(actor.source.statBlockId);
  const monster = MonsterSchema.safeParse(entry).data;
  return monster ? (challengeOf(monster) ?? 0) : 0;
}

const beastsBySource = new WeakMap<
  object,
  readonly { id: string; cr: number; hp: number }[]
>();

// Every Beast in the loaded content with its Challenge Rating, weakest first, read once per content.
function beasts(
  access: ContentAccess,
): readonly { id: string; cr: number; hp: number }[] {
  const known = beastsBySource.get(access.content);
  if (known) return known;
  const list = access
    .contentIds()
    .filter((id) => id.includes(":monster/"))
    .flatMap((id) => {
      const monster = MonsterSchema.safeParse(access.content(id)).data;
      const cr = monster ? challengeOf(monster) : null;
      return monster?.creatureType === "beast" && cr !== null
        ? [{ id, cr, hp: monster.hp }]
        : [];
    })
    .sort((a, b) => a.cr - b.cr || a.hp - b.hp || (a.id < b.id ? -1 : 1));
  beastsBySource.set(access.content, list);
  return list;
}

// The form a hostile caster gives: the weakest Beast the target's level or Challenge Rating allows, or null.
// shortcut: weakest means lowest Challenge Rating, then fewest Hit Points, not a reading of its attacks.
export function weakestBeast(
  target: Actor,
  access: ContentAccess,
): { readonly id: string; readonly hp: number } | null {
  const limit = levelOrChallenge(target, access);
  return beasts(access).find((beast) => beast.cr <= limit) ?? null;
}

// Settles a form after an event: a form that ended takes its Temporary Hit Points with it, and running out of
// them ends the form.
export function settleForms(before: DndState, after: DndState): DndState {
  let actors = after.actors;
  for (const [id, actor] of Object.entries(after.actors)) {
    const old = before.actors[id];
    if (!old || old === actor) continue;
    const had = formOf(old) !== null;
    const has = formOf(actor) !== null;
    if (had && !has && actor.tempHp > 0) {
      actors = { ...actors, [id]: { ...actor, tempHp: 0 } };
    } else if (has && actor.tempHp <= 0 && old.tempHp > 0) {
      actors = {
        ...actors,
        [id]: {
          ...actor,
          activeEffects: actor.activeEffects.filter(
            ({ modifier }) => modifier.kind !== "form",
          ),
        },
      };
    }
  }
  return actors === after.actors ? after : { ...after, actors };
}
