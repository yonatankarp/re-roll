// check-pack's look at entries that load but would play wrong (GameSystem.lint).
import { READ_ELSEWHERE } from "./combat/effects/leaf.ts";

const ELSEWHERE: ReadonlySet<string> = new Set(READ_ELSEWHERE);
const RESOLUTION_LISTS = new Set([
  "effects",
  "onHit",
  "onMiss",
  "onFail",
  "onSuccess",
]);

// Whether something acts on a READ_ELSEWHERE `kind` in the list `path` ends in, held by an object of `owner` kind.
function read(kind: string, path: readonly string[], owner: string): boolean {
  const list = path.at(-2) ?? "";
  const holder = path.at(-3) ?? "";
  return (
    // an activation's own (combat/reactions.ts effectsOf, resolveAction, zones from every list)
    (RESOLUTION_LISTS.has(list) && holder === "resolution") ||
    // a shape's, which replace its resolution's (combat/actions.ts withShape)
    (list === "effects" && path.at(-4) === "shapes") ||
    // a reaction's own, read with its effects (combat/reactions.ts)
    list === "selfEffects" ||
    // a rider's, added to the resolution (stats/spell-changes.ts) or cast with (combat/school.ts)
    (list === "effects" &&
      (owner === "activationRider" || owner === "castRider")) ||
    // allies' reactions (combat/effects/riders.ts alliesRiderEvents)
    (list === "effects" &&
      holder === "allies" &&
      (kind === "reactionAttack" || kind === "reactionMove")) ||
    // the bearer's own teleport (combat/actions.ts castAction)
    ((list === "alsoSelf" ||
      (list === "self" && owner === "activationRider")) &&
      kind === "teleport")
  );
}

// A kind only certain lists act on, placed in another, where it would do nothing.
export function lintEntry(entry: unknown): readonly string[] {
  const found: string[] = [];
  const walk = (
    value: unknown,
    path: readonly string[],
    owner: string,
  ): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, [...path, String(index)], owner);
      });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const { kind } = value as { kind?: unknown };
    if (
      typeof kind === "string" &&
      ELSEWHERE.has(kind) &&
      /^\d+$/.test(path.at(-1) ?? "") &&
      !read(kind, path, owner)
    ) {
      found.push(`effect ${kind} at ${path.join(".")} is never read there`);
    }
    const holds = typeof kind === "string" ? kind : owner;
    for (const [key, child] of Object.entries(value)) {
      walk(child, [...path, key], holds);
    }
  };
  walk(entry, [], "");
  return found;
}
