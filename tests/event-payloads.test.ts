import { readFile } from "node:fs/promises";
import { fc } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { systems } from "../app/systems.ts";
import { GameStateSchema } from "../engine/kernel/events.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { loadSave } from "../engine/run/save.ts";
import { applyEvent, createRunContext } from "../engine/run/turn.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { EVENT_SCHEMAS, NS } from "../plugins/systems/dnd5.5e/core/state.ts";

// #207: any payload an event's schema accepts folds without throwing into a state the system's schema
// still accepts, so a save holding it loads. Starts from a fight in progress, where most events apply.
const storage = await createNodeStorage(process.cwd());
const loaded = await loadRun(
  storage,
  await scanPlugins(storage, ["plugins"]),
  systems,
  ["goblin-ambush"],
);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const run = createRunContext(loaded.registry, "goblin-ambush");
const save = loadSave(
  await readFile("tests/fixtures/saves/mid-combat.json", "utf8"),
  loaded.registry,
  run,
);
if (!save.ok) throw new Error(save.error);
const base = save.state;

// Strings come from ids the state holds, so payloads name real actors and items, not only strangers.
const { actors } = base.system as {
  actors: Record<string, { inventory: string[]; source: { kind: string } }>;
};
const actorIds = Object.keys(actors);
const itemIds = Object.values(actors).flatMap(({ inventory }) => inventory);
const characters = actorIds.filter(
  (id) => actors[id]?.source.kind === "character",
);
const words = [...actorIds, ...itemIds, "x", ""];
// A field naming a creature names one in the fight: events are only ever made for actors that exist.
const ACTOR_FIELD = /actor|target|caster|attacker|owner|creature|^by$|^id$/i;

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  element?: z.ZodType;
  valueType?: z.ZodType;
  keyType?: z.ZodType;
  options?: z.ZodType[];
  entries?: Record<string, string | number>;
  values?: unknown[];
  getter?: () => z.ZodType;
  checks?: { _zod: { def: Check } }[];
}
interface Check {
  check: string;
  value?: number;
  inclusive?: boolean;
  minimum?: number;
  maximum?: number;
  format?: string;
  pattern?: RegExp;
}

// A generator for a zod schema's values, for the kinds event payloads use. What it gets wrong the
// schema filters out below, so a gap here skips cases rather than failing them.
const made = new Map<string, WeakMap<z.ZodType, fc.Arbitrary<unknown>>>();
function arbitrary(schema: z.ZodType, field = ""): fc.Arbitrary<unknown> {
  // Schemas share parts, so each is built once per field kind rather than once per path.
  const key = ACTOR_FIELD.test(field) ? "actor" : "";
  const cache = made.get(key) ?? new WeakMap();
  made.set(key, cache);
  const known = cache.get(schema);
  if (known) return known;
  const built = fc.constant(null).chain(() => build(schema, key));
  cache.set(schema, built);
  return built;
}

function build(schema: z.ZodType, field: string): fc.Arbitrary<unknown> {
  const def = (schema as unknown as { _zod: { def: Def } })._zod.def;
  const inner = (part: z.ZodType | undefined) =>
    part ? arbitrary(part, field) : fc.constant(undefined);
  const checks = (def.checks ?? []).map((check) => check._zod.def);
  const bound = (name: string) => checks.find(({ check }) => check === name);
  switch (def.type) {
    case "string": {
      const pattern = checks.find(({ format }) => format === "regex")?.pattern;
      if (pattern) return fc.stringMatching(pattern);
      return fc.constantFrom(...(field ? actorIds : words));
    }
    case "number": {
      const low = bound("greater_than");
      const high = bound("less_than");
      const min = low ? (low.value ?? 0) + (low.inclusive ? 0 : 1) : -2;
      return fc.integer({ min, max: high ? (high.value ?? 0) : min + 30 });
    }
    case "boolean":
      return fc.boolean();
    case "unknown":
      return fc.constant(null);
    case "literal":
      return fc.constantFrom(...(def.values ?? []));
    case "enum":
      return fc.constantFrom(...Object.values(def.entries ?? {}));
    case "optional":
    case "default":
      return fc.option(inner(def.innerType), { nil: undefined, freq: 1 });
    case "nullable":
      return fc.option(inner(def.innerType), { nil: null });
    case "array":
      return fc.array(inner(def.element), {
        minLength: bound("min_length")?.minimum ?? 0,
        maxLength: Math.min(bound("max_length")?.maximum ?? 3, 3),
      });
    case "record":
      return fc.dictionary(
        inner(def.keyType).map(String),
        inner(def.valueType),
        { maxKeys: 2 },
      );
    case "union":
      return fc.oneof(...(def.options ?? []).map((option) => inner(option)));
    case "lazy":
      return inner(def.getter?.());
    case "object":
      return fc.record(
        Object.fromEntries(
          Object.entries(def.shape ?? {}).map(([key, value]) => [
            key,
            arbitrary(value, key),
          ]),
        ),
      );
    default:
      throw new Error(`No generator for a zod ${def.type}`);
  }
}

// Undefined keys stand for absent ones, which strict objects otherwise refuse.
const pruned = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown;

describe("every D&D event payload its schema accepts", () => {
  it.each(Object.entries(EVENT_SCHEMAS))(
    "%s folds into a valid state",
    (kind, schema) => {
      fc.assert(
        fc.property(arbitrary(schema), (raw) => {
          const payload = pruned(raw);
          fc.pre(schema.safeParse(payload).success);
          // Only a character gains a level; the reducer refuses a monster's by name.
          if (kind === `${NS}:characterAdvanced`) {
            fc.pre(characters.includes((payload as { actor: string }).actor));
          }
          const state = applyEvent(run, base, {
            kind: kind as `${string}:${string}`,
            payload: payload as Record<string, never>,
          });
          expect(GameStateSchema.safeParse(state).success).toBe(true);
          const checked = run.system.stateSchema.safeParse(state.system);
          expect(checked.success || checked.error.message).toBe(true);
        }),
        { numRuns: 25 },
      );
    },
  );
});
