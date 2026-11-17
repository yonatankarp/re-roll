// Monster families and lairs (#133): the stat blocks each family heading holds and whose each lair is,
// read from where a book nests them, as ids only. The world importer writes them on the entities, and
// the links index lets the library reader go between a monster, its family and its lair.

export interface Placed {
  readonly file: string; // the library section file it starts in
  readonly level: number;
  readonly text: string;
  readonly body: string; // what the book prints under it, up to the next heading
  readonly entity?: string | undefined; // the entity the heading names
}

export interface Look {
  readonly inLair: (monster: string) => boolean; // its stat block prints in-Lair numbers
  readonly named: (name: string) => string | undefined; // a stat block by its name
  readonly people: readonly { id: string; name: string }[]; // the book's monsters and npcs, for "Name's Lair"
}

export interface LinkRef {
  readonly file: string;
  readonly heading: string;
  readonly rel: "family" | "member" | "lair" | "owner"; // what the linked section is to this one
}

const kindOf = (id = ""): string => /^[^:]+:([^/]+)\//.exec(id)?.[1] ?? "";
const key = (text: string): string =>
  text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// A family's members and a lair's owners, by the entity's id, for the book's own families and lairs.
export function familyLinks(
  book: string,
  headings: readonly Placed[],
  look: Look,
): Map<string, string[]> {
  const level = (at: number) => headings[at]?.level ?? 0;
  const entity = (at: number) => headings[at]?.entity;
  const below = (at: number): number[] => {
    const out: number[] = [];
    for (let i = at + 1; i < headings.length && level(i) > level(at); i += 1)
      out.push(i);
    return out;
  };
  const parentOf = (at: number): number => {
    for (let i = at - 1; i >= 0; i -= 1) if (level(i) < level(at)) return i;
    return -1;
  };
  // The nearest heading above that is a family, so a family inside a family holds its own stat blocks.
  const familyOf = (at: number): number => {
    for (let i = parentOf(at); i >= 0; i = parentOf(i))
      if (kindOf(entity(i)) === "monster-family") return i;
    return -1;
  };
  const ids = (at: readonly number[], kinds: readonly string[]) => [
    ...new Set(
      at.map(entity).filter((id): id is string => kinds.includes(kindOf(id))),
    ),
  ];

  const out = new Map<string, string[]>();
  headings.forEach((heading, at) => {
    const id = heading.entity;
    if (!id?.startsWith(`${book}:`)) return;
    if (kindOf(id) === "monster-family") {
      const held = ids(
        below(at).filter((i) => familyOf(i) === at),
        ["monster", "monster-family"],
      );
      // A group with no stat blocks of its own lists them by name: "Balor", "Dretches (all)".
      const listed = heading.body
        .split("\n")
        .map((line) => line.trim())
        .flatMap((line) => {
          const all = /^(.+?)\s*\(all\)$/i.exec(line)?.[1];
          if (all === undefined) return look.named(line) ?? [];
          const family = headings.find(
            (other) =>
              kindOf(other.entity) === "monster-family" &&
              key(other.text) === key(all),
          );
          return family?.entity ?? [];
        });
      out.set(id, held.length > 0 ? held : [...new Set(listed)]);
    } else if (kindOf(id) === "lair") {
      // "Name's Lair" is whoever it's named for, a stat block before an npc, as a book may nest it under
      // someone else. Else under a family or a monster: theirs. Else the stat blocks below it.
      const owner = /^(.+?)['’]s\s+Lairs?$/i.exec(heading.text)?.[1];
      const named = owner
        ? look.people.filter((person) =>
            ` ${key(person.name)} `.includes(` ${key(owner)} `),
          )
        : [];
      const monsters = named.filter((p) => kindOf(p.id) === "monster");
      const parent = parentOf(at);
      const scope = ["monster-family", "monster"].includes(
        kindOf(entity(parent)),
      )
        ? [parent, ...below(parent)]
        : below(at);
      const pool =
        named.length > 0
          ? (monsters.length > 0 ? monsters : named).map((p) => p.id)
          : ids(scope, ["monster"]);
      const lairs = pool.filter(look.inLair);
      out.set(id, lairs.length > 0 ? lairs : pool);
    }
  });
  return out;
}

// For each section file, the sections its family, members, lair or owners are in, both ways.
export function linksIndex(
  headings: readonly Placed[],
  links: ReadonlyMap<string, readonly string[]>,
): Record<string, LinkRef[]> {
  const index: Record<string, LinkRef[]> = {};
  const add = (file: string, ref: LinkRef) => {
    const refs = (index[file] ??= []);
    if (!refs.some((r) => r.file === ref.file && r.rel === ref.rel))
      refs.push(ref);
  };
  // The first heading naming it after `from`, as a book may name a stat block in an example before it.
  const find = (id: string, from = 0) => {
    const at = headings.findIndex((h, i) => i >= from && h.entity === id);
    return at >= 0 ? at : headings.findIndex((h) => h.entity === id);
  };
  for (const [id, others] of links) {
    const at = find(id);
    const home = headings[at];
    if (!home) continue;
    const lair = kindOf(id) === "lair";
    for (const other of others) {
      const there = headings[find(other, at)];
      if (!there || there.file === home.file) continue;
      add(home.file, {
        file: there.file,
        heading: there.text,
        rel: lair ? "owner" : "member",
      });
      add(there.file, {
        file: home.file,
        heading: home.text,
        rel: lair ? "lair" : "family",
      });
    }
  }
  return index;
}
