import type { ContentAccess } from "#sdk";
import { type LeafEffect, type Monster, MonsterSchema } from "./schemas.ts";
import type { Actor, DndState } from "./state.ts";

// Another creature's shape, as Polymorph gives: the form's stat block replaces the creature's own while it keeps its
// Hit Points (stats.ts), and the form's Hit Points come as Temporary Hit Points that end it when they run out.

export function formOf(actor: Actor): string | null {
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "form") return modifier.monster;
  }
  return null;
}

// What a creature in another's form keeps of its own, as Shapechange's spellcasting.
export function formKept(actor: Actor): readonly ("mind" | "spells")[] {
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "form") return modifier.keep ?? [];
  }
  return [];
}

// "CR 1/4 (XP 50; PB +2)" in the stat block's text.
export function challengeOf(monster: Monster): number | null {
  const [, whole, over] =
    /\bCR (\d+)(?:\/(\d+))?\b/.exec(monster.text ?? "") ?? [];
  if (whole === undefined) return null;
  return over === undefined ? Number(whole) : Number(whole) / Number(over);
}

// Immutable Form: a stat block that says its shape can't change.
function immutable(actor: Actor, access: ContentAccess): boolean {
  if (actor.source.kind !== "monster") return false;
  const monster = MonsterSchema.safeParse(
    access.content(actor.source.statBlockId),
  ).data;
  return (
    monster?.passives.some(({ kind }) => kind === "immutableForm") ?? false
  );
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

interface FormBlock {
  readonly id: string;
  readonly name: string;
  readonly cr: number;
  readonly hp: number;
  readonly type: string;
  readonly size: number;
}

const blocksBySource = new WeakMap<object, readonly FormBlock[]>();

// Every stat block in the loaded content with a Challenge Rating, weakest first, read once per content.
function formBlocks(access: ContentAccess): readonly FormBlock[] {
  const known = blocksBySource.get(access.content);
  if (known) return known;
  const list = access
    .contentIds()
    .filter((id) => id.includes(":monster/"))
    .flatMap((id) => {
      const monster = MonsterSchema.safeParse(access.content(id)).data;
      const cr = monster ? challengeOf(monster) : null;
      return monster && cr !== null
        ? [
            {
              id,
              name: monster.name,
              cr,
              hp: monster.hp,
              type: monster.creatureType?.toLowerCase() ?? "",
              size: SIZE_ORDER.indexOf(monster.size ?? "medium"),
            },
          ]
        : [];
    })
    .sort((a, b) => a.cr - b.cr || a.hp - b.hp || (a.id < b.id ? -1 : 1));
  blocksBySource.set(access.content, list);
  return list;
}

const SIZE_ORDER = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

export type Polymorph = Extract<LeafEffect, { kind: "polymorph" }>;

// The stat blocks a polymorph can turn the target into, weakest first: Beasts unless it says otherwise, up to the
// target's level or Challenge Rating unless it sets its own limit.
export function formsFor(
  effect: Pick<Polymorph, "forms">,
  target: Actor,
  access: ContentAccess,
): readonly FormBlock[] {
  if (immutable(target, access)) return [];
  const { forms } = effect;
  const types = forms ? forms.types : ["beast"];
  const limit = forms?.maxCr ?? levelOrChallenge(target, access);
  const size = forms?.maxSize ? SIZE_ORDER.indexOf(forms.maxSize) : 5;
  return formBlocks(access).filter(
    (block) =>
      block.cr <= limit &&
      block.size <= size &&
      (!types || types.includes(block.type)) &&
      !forms?.except?.includes(block.type),
  );
}

// The form a hostile caster gives: the weakest Beast the target's level or Challenge Rating allows, or null.
// shortcut: weakest means lowest Challenge Rating, then fewest Hit Points, not a reading of its attacks.
export function weakestBeast(
  target: Actor,
  access: ContentAccess,
): { readonly id: string; readonly hp: number } | null {
  return formsFor({}, target, access)[0] ?? null;
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

// A stat block's own shapes, as a werewolf's wolf and hybrid: every Shape-Shift effect shares one source, so the
// next one replaces it, and the true shape (the first) is having none.
export const SHAPE = "shape";

type Shape = NonNullable<Monster["shapes"]>[number];

export function shapeOf(actor: Actor): string | null {
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "shape") return modifier.shape;
  }
  return null;
}

// The shape a monster is in, or null for a stat block with only one.
export function currentShape(monster: Monster, actor: Actor): Shape | null {
  const { shapes } = monster;
  if (!shapes) return null;
  const name = shapeOf(actor);
  return shapes.find((shape) => shape.name === name) ?? shapes[0] ?? null;
}

// An action printed "(Wolf or Hybrid Form Only)" is out of reach in any other shape.
export function usableIn(
  action: Monster["actions"][number],
  shape: Shape | null,
): boolean {
  return !action.shapes || !shape || action.shapes.includes(shape.name);
}
