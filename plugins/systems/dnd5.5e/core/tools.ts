import type { ContentAccess } from "#sdk";
import { type ClassDef, ItemSchema, type Obstacle } from "./schemas.ts";

// Tools by name. The same tool from two books, as the SRD's Thieves' Tools and the Player's Handbook's, is one tool:
// it matches by name, and what one copy says it handles or is (an Artisan's Tools) holds for all of them. The books
// print a background's tool as a name too.

const quotes = /[’']/g;

function toolKey(name: string): string {
  return name
    .toLowerCase()
    .replace(quotes, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}

interface Tool {
  readonly id: string; // the first by precedence
  readonly handles: ReadonlySet<Obstacle>;
  readonly artisan: boolean;
}

// Keyed by the content lookup, which playing() keeps.
const tools = new WeakMap<ContentAccess["content"], Map<string, Tool>>();

function toolsOf(access: ContentAccess): Map<string, Tool> {
  const known = tools.get(access.content);
  if (known) return known;
  const index = new Map<string, Tool>();
  for (const id of access.contentIds()) {
    const item = ItemSchema.safeParse(access.content(id)).data;
    if (item?.type !== "tool") continue;
    const key = toolKey(item.name);
    const had = index.get(key);
    index.set(key, {
      id: had?.id ?? id,
      handles: new Set([...(had?.handles ?? []), ...(item.handles ?? [])]),
      artisan: (had?.artisan ?? false) || item.artisan === true,
    });
  }
  tools.set(access.content, index);
  return index;
}

export function toolByName(
  name: string,
  access: ContentAccess,
): string | undefined {
  return toolsOf(access).get(toolKey(name))?.id;
}

export function toolKeyOf(id: string, access: ContentAccess): string {
  const item = ItemSchema.safeParse(access.content(id)).data;
  return item?.type === "tool" ? toolKey(item.name) : id;
}

// Every tool once, by its first id, and whether it's one of the Artisan's Tools, for a choice of tools.
export function everyTool(
  access: ContentAccess,
): readonly { readonly id: string; readonly artisan: boolean }[] {
  return [...toolsOf(access).values()];
}

// What a tool deals with and whether it's one of the Artisan's Tools, from any of its copies.
export function toolOf(id: string, access: ContentAccess): Tool | undefined {
  const item = ItemSchema.safeParse(access.content(id)).data;
  return item?.type === "tool"
    ? toolsOf(access).get(toolKey(item.name))
    : undefined;
}

// The tools a new character carries: its class's and its background's, as a Rogue's Thieves' Tools, one of each.
export function startingTools(
  classDef: ClassDef,
  backgroundTool: string | undefined,
  access: ContentAccess,
): readonly string[] {
  const ids = [
    ...(classDef.tools ?? []).filter((id) => access.content(id) !== undefined),
    ...(backgroundTool
      ? [toolByName(backgroundTool, access) ?? []].flat()
      : []),
  ];
  return ids.filter(
    (id, at) =>
      ids.findIndex(
        (other) => toolKeyOf(other, access) === toolKeyOf(id, access),
      ) === at,
  );
}
