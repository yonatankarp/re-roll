import type { ContentAccess } from "#sdk";
import { type ClassDef, ItemSchema } from "./schemas.ts";

// Tools by name, as the books print a background's tool, and the tools a character starts with.

const quotes = /[’']/g;

function toolKey(name: string): string {
  return name
    .toLowerCase()
    .replace(quotes, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}

// Tools by name, for a background's tool, which the books print as a name. Keyed by the content lookup, which
// playing() keeps.
const toolNames = new WeakMap<ContentAccess["content"], Map<string, string>>();

export function toolByName(
  name: string,
  access: ContentAccess,
): string | undefined {
  let names = toolNames.get(access.content);
  if (!names) {
    names = new Map();
    for (const id of access.contentIds()) {
      const item = ItemSchema.safeParse(access.content(id));
      if (item.success && item.data.type === "tool") {
        const key = toolKey(item.data.name);
        if (!names.has(key)) names.set(key, id);
      }
    }
    toolNames.set(access.content, names);
  }
  return names.get(toolKey(name));
}

// The same tool from two books, as the SRD's Thieves' Tools and the Player's Handbook's, is one tool: tools match by
// name.
export function toolKeyOf(id: string, access: ContentAccess): string {
  const item = ItemSchema.safeParse(access.content(id)).data;
  return item?.type === "tool" ? toolKey(item.name) : id;
}

// The tools a new character carries: its class's and its background's, as a Rogue's Thieves' Tools.
export function startingTools(
  classDef: ClassDef,
  backgroundTool: string | undefined,
  access: ContentAccess,
): readonly string[] {
  return [
    ...new Set([
      ...(classDef.tools ?? []).filter(
        (id) => access.content(id) !== undefined,
      ),
      ...(backgroundTool
        ? [toolByName(backgroundTool, access) ?? []].flat()
        : []),
    ]),
  ];
}
