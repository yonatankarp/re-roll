import { z } from "zod";
import { type Issue, zodIssues } from "../kernel/issues.ts";
import { ContentIdSchema, type GameSystem } from "../kernel/system.ts";

const SlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase words with dashes");

const AssetPathSchema = z
  .string()
  .regex(/^assets\/[^\\:]+$/, "must be a relative path inside assets/")
  .refine(
    (path) => !path.split("/").some((part) => part === ".." || part === "."),
    {
      message: "must not contain . or .. segments",
    },
  );

const hasBound = (bounds: { atLeast?: unknown; atMost?: unknown }): boolean =>
  bounds.atLeast !== undefined || bounds.atMost !== undefined;
const NEEDS_BOUND = { message: "needs atLeast or atMost" };

const ConditionLeafSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("flag"),
    flag: SlugSchema,
    is: z.boolean().default(true),
  }),
  z
    .strictObject({
      kind: z.literal("clock"),
      clock: SlugSchema,
      atLeast: z.number().int().optional(),
      atMost: z.number().int().optional(),
    })
    .refine(hasBound, NEEDS_BOUND),
  z
    .strictObject({
      kind: z.literal("resource"),
      resource: SlugSchema,
      atLeast: z.number().int().optional(),
      atMost: z.number().int().optional(),
    })
    .refine(hasBound, NEEDS_BOUND),
  z.strictObject({
    kind: z.literal("visited"),
    scene: SlugSchema,
    atLeast: z.number().int().min(1).default(1),
  }),
  z.strictObject({
    kind: z.literal("attitude"),
    npc: SlugSchema,
    atLeast: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal("system"),
    predicate: z.string(),
    args: z.unknown(),
  }),
]);

export const ConditionSchema = z.union([
  ConditionLeafSchema,
  z.strictObject({ all: z.array(ConditionLeafSchema).min(1) }),
  z.strictObject({ any: z.array(ConditionLeafSchema).min(1) }),
]);

export const StoryEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("setFlag"),
    flag: SlugSchema,
    value: z.boolean().default(true),
  }),
  z.strictObject({ kind: z.literal("goto"), scene: SlugSchema }),
  z.strictObject({
    kind: z.literal("advanceClock"),
    clock: SlugSchema,
    by: z.number().int().default(1),
  }),
  z.strictObject({
    kind: z.literal("adjustAttitude"),
    npc: SlugSchema,
    by: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal("adjustResource"),
    resource: SlugSchema,
    by: z.number().int(),
  }),
  z.strictObject({ kind: z.literal("startEncounter"), encounter: SlugSchema }),
  z.strictObject({ kind: z.literal("reveal"), secret: SlugSchema }),
  z.strictObject({
    kind: z.literal("system"),
    effect: z.string(),
    args: z.unknown(),
  }),
]);

const DirectChoiceSchema = z.strictObject({
  label: z.string().min(1),
  when: ConditionSchema.optional(),
  effects: z.array(StoryEffectSchema).min(1),
});

const CheckChoiceSchema = z.strictObject({
  label: z.string().min(1),
  when: ConditionSchema.optional(),
  check: z.unknown(),
  results: z.record(z.string(), z.array(StoryEffectSchema).min(1)),
});

const SceneSchema = z.strictObject({
  id: SlugSchema,
  text: z.string().min(1),
  // The first whose condition holds replaces the text.
  textVariants: z
    .array(z.strictObject({ when: ConditionSchema, text: z.string().min(1) }))
    .default([]),
  art: AssetPathSchema.optional(),
  rest: z.boolean().default(true), // false where the party can't stop, such as mid-chase
  choices: z
    .array(z.union([DirectChoiceSchema, CheckChoiceSchema]))
    .default([]),
});

// These keys are the story's. Whatever else an encounter holds goes to the system's schema.
const EncounterOutcomesSchema = z.looseObject({
  onVictory: z.array(StoryEffectSchema).min(1).optional(),
  onDefeat: z.array(StoryEffectSchema).min(1).optional(),
  onFlee: z.array(StoryEffectSchema).min(1).optional(),
});

const NpcSchema = z.strictObject({
  id: SlugSchema,
  name: z.string().min(1),
  pronouns: z.string().min(1),
  motive: z.string().min(1),
  attitude: z.number().int().default(0),
  knows: z.array(SlugSchema).default([]),
  statsId: ContentIdSchema.optional(),
});

const ClockSchema = z.strictObject({
  id: SlugSchema,
  label: z.string().min(1),
  max: z.number().int().min(1),
  at: z
    .array(
      z.strictObject({
        value: z.number().int().min(1),
        effects: z.array(StoryEffectSchema).min(1),
      }),
    )
    .default([]),
});

const FactionSchema = z.strictObject({
  id: SlugSchema,
  name: z.string().min(1),
  goal: z.string().min(1),
  clocks: z.array(ClockSchema).default([]),
});

const SecretSchema = z.strictObject({
  id: SlugSchema,
  truth: z.string().min(1),
  spoilerTerms: z.array(z.string().min(1)).default([]),
  clues: z
    .array(z.strictObject({ scene: SlugSchema, text: z.string().min(1) }))
    .min(2),
});

const VariantSchema = z.strictObject({
  id: SlugSchema,
  options: z
    .array(
      z.strictObject({
        id: SlugSchema,
        weight: z.number().int().positive().default(1),
        effects: z.array(StoryEffectSchema).min(1),
      }),
    )
    .min(2),
});

const BeatSchema = z.strictObject({
  id: SlugSchema,
  scene: SlugSchema,
  when: ConditionSchema.optional(),
  weight: z.number().int().positive().default(1),
});

const AdventureInfoSchema = z.strictObject({
  title: z.string().min(1),
  levels: z.string().min(1).optional(), // shown in the menu, such as "1-3"
  startScene: SlugSchema,
  resources: z.record(SlugSchema, z.number().int().min(0)).optional(),
});

export type StoryEffect = z.infer<typeof StoryEffectSchema>;
export type Condition = z.infer<typeof ConditionSchema>;

export interface EncounterOutcomes {
  readonly onVictory?: readonly StoryEffect[] | undefined;
  readonly onDefeat?: readonly StoryEffect[] | undefined;
  readonly onFlee?: readonly StoryEffect[] | undefined;
}

export interface Adventure {
  readonly title: string;
  readonly startScene: string;
  readonly resources?: Readonly<Record<string, number>> | undefined;
  readonly scenes: readonly z.infer<typeof SceneSchema>[];
  readonly npcs: readonly z.infer<typeof NpcSchema>[];
  readonly factions: readonly z.infer<typeof FactionSchema>[];
  readonly secrets: readonly z.infer<typeof SecretSchema>[];
  readonly variants: readonly z.infer<typeof VariantSchema>[];
  readonly beats: readonly z.infer<typeof BeatSchema>[];
  readonly encounters: readonly { readonly id: string }[];
  readonly encounterOutcomes: Readonly<Record<string, EncounterOutcomes>>; // only those that declare one
}

export const STORY_FILES = [
  "adventure",
  "scenes",
  "npcs",
  "factions",
  "secrets",
  "encounters",
  "variants",
  "beats",
] as const;

export type StoryFile = (typeof STORY_FILES)[number];

export interface AdventureInput {
  readonly pluginId: string;
  readonly system: GameSystem;
  readonly documents: ReadonlyMap<StoryFile, unknown>;
  readonly fileName: (file: StoryFile) => string;
  readonly assetPaths: ReadonlySet<string>;
}

export interface AdventureResult {
  readonly adventure: Adventure | null;
  readonly issues: readonly Issue[];
  readonly contentReferences: readonly string[];
}

export function validateAdventure(input: AdventureInput): AdventureResult {
  const { pluginId, system, documents, fileName, assetPaths } = input;
  const issues: Issue[] = [];
  const report = (file: StoryFile, message: string): void => {
    issues.push({ plugin: pluginId, file: fileName(file), message });
  };

  function parseList<T>(file: StoryFile, schema: z.ZodType<T>): T[] {
    const raw = documents.get(file) ?? [];
    if (!Array.isArray(raw)) {
      report(file, "must be a list");
      return [];
    }
    const parsed: T[] = [];
    (raw as unknown[]).forEach((item, index) => {
      const result = schema.safeParse(item);
      if (result.success) parsed.push(result.data);
      else
        issues.push(
          ...zodIssues(pluginId, fileName(file), result.error, String(index)),
        );
    });
    return parsed;
  }

  function uniqueIds(
    file: StoryFile,
    items: readonly { readonly id: string }[],
  ): Set<string> {
    const ids = new Set<string>();
    for (const { id } of items) {
      if (ids.has(id)) report(file, `duplicate id "${id}"`);
      ids.add(id);
    }
    return ids;
  }

  const info = AdventureInfoSchema.safeParse(documents.get("adventure"));
  if (!info.success)
    issues.push(...zodIssues(pluginId, fileName("adventure"), info.error));
  if (!documents.has("scenes")) report("scenes", "file is required");

  const scenes = parseList("scenes", SceneSchema);
  const npcs = parseList("npcs", NpcSchema);
  const factions = parseList("factions", FactionSchema);
  const secrets = parseList("secrets", SecretSchema);
  const variants = parseList("variants", VariantSchema);
  const beats = parseList("beats", BeatSchema);
  const clocks = factions.flatMap((faction) => faction.clocks);

  const contentReferences: string[] = [];
  const encounters: { readonly id: string }[] = [];
  const encounterOutcomes: Record<string, EncounterOutcomes> = {};
  const rawEncounters = documents.get("encounters") ?? [];
  if (Array.isArray(rawEncounters)) {
    (rawEncounters as unknown[]).forEach((item, index) => {
      const outcomes = EncounterOutcomesSchema.safeParse(item);
      if (!outcomes.success) {
        issues.push(
          ...zodIssues(
            pluginId,
            fileName("encounters"),
            outcomes.error,
            String(index),
          ),
        );
        return;
      }
      const { onVictory, onDefeat, onFlee, ...rules } = outcomes.data;
      const result = system.encounters.parse(rules);
      if (result.ok) {
        encounters.push(result.entry);
        contentReferences.push(...result.references);
        if (onVictory || onDefeat || onFlee) {
          encounterOutcomes[result.entry.id] = { onVictory, onDefeat, onFlee };
        }
      } else {
        issues.push(
          ...zodIssues(
            pluginId,
            fileName("encounters"),
            result.error,
            String(index),
          ),
        );
      }
    });
  } else {
    report("encounters", "must be a list");
  }

  const sceneIds = uniqueIds("scenes", scenes);
  const npcIds = uniqueIds("npcs", npcs);
  const clockIds = uniqueIds("factions", clocks);
  uniqueIds("factions", factions);
  const secretIds = uniqueIds("secrets", secrets);
  const encounterIds = uniqueIds("encounters", encounters);
  const resourceIds = new Set(
    Object.keys((info.success ? info.data.resources : undefined) ?? {}),
  );
  uniqueIds("variants", variants);
  uniqueIds("beats", beats);

  const need = (
    file: StoryFile,
    known: ReadonlySet<string>,
    id: string,
    label: string,
  ): void => {
    if (!known.has(id)) report(file, `unknown ${label} "${id}"`);
  };

  function checkEffects(
    file: StoryFile,
    effects: readonly StoryEffect[],
  ): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "setFlag":
          break;
        case "goto":
          need(file, sceneIds, effect.scene, "scene");
          break;
        case "advanceClock":
          need(file, clockIds, effect.clock, "clock");
          break;
        case "adjustAttitude":
          need(file, npcIds, effect.npc, "NPC");
          break;
        case "adjustResource":
          need(file, resourceIds, effect.resource, "resource");
          break;
        case "startEncounter":
          need(file, encounterIds, effect.encounter, "encounter");
          break;
        case "reveal":
          need(file, secretIds, effect.secret, "secret");
          break;
        case "system": {
          const schema = system.storyEffects[effect.effect]?.schema;
          if (!schema) {
            report(
              file,
              `system ${system.id} has no story effect "${effect.effect}"`,
            );
          } else {
            const args = schema.safeParse(effect.args);
            if (!args.success) {
              issues.push(
                ...zodIssues(
                  pluginId,
                  fileName(file),
                  args.error,
                  effect.effect,
                ),
              );
            }
          }
          break;
        }
        default:
          effect satisfies never;
      }
    }
  }

  function checkCondition(
    file: StoryFile,
    condition: Condition | undefined,
  ): void {
    if (!condition) return;
    const leaves =
      "all" in condition
        ? condition.all
        : "any" in condition
          ? condition.any
          : [condition];
    for (const leaf of leaves) {
      switch (leaf.kind) {
        case "flag":
          break;
        case "clock":
          need(file, clockIds, leaf.clock, "clock");
          break;
        case "resource":
          need(file, resourceIds, leaf.resource, "resource");
          break;
        case "visited":
          need(file, sceneIds, leaf.scene, "scene");
          break;
        case "attitude":
          need(file, npcIds, leaf.npc, "NPC");
          break;
        case "system": {
          const schema = system.storyPredicates[leaf.predicate]?.schema;
          if (!schema) {
            report(
              file,
              `system ${system.id} has no predicate "${leaf.predicate}"`,
            );
          } else {
            const args = schema.safeParse(leaf.args);
            if (!args.success) {
              issues.push(
                ...zodIssues(
                  pluginId,
                  fileName(file),
                  args.error,
                  leaf.predicate,
                ),
              );
            }
          }
          break;
        }
        default:
          leaf satisfies never;
      }
    }
  }

  function checkResults(
    sceneId: string,
    results: Readonly<Record<string, unknown>>,
  ): void {
    const { keys, groups = {} } = system.outcomes;
    const covered = new Map<string, number>();
    for (const name of Object.keys(results)) {
      const members = keys.includes(name) ? [name] : groups[name];
      if (!members) {
        report("scenes", `scene "${sceneId}": undeclared outcome "${name}"`);
        continue;
      }
      for (const key of members) covered.set(key, (covered.get(key) ?? 0) + 1);
    }
    for (const key of keys) {
      const count = covered.get(key) ?? 0;
      if (count === 0)
        report("scenes", `scene "${sceneId}": outcome "${key}" is not covered`);
      if (count > 1)
        report(
          "scenes",
          `scene "${sceneId}": outcome "${key}" is covered twice`,
        );
    }
  }

  const clockEffects = clocks.flatMap((clock) =>
    clock.at.flatMap((entry) => entry.effects),
  );
  const variantEffects = variants.flatMap((variant) =>
    variant.options.flatMap((option) => option.effects),
  );
  const outcomeEffects = Object.values(encounterOutcomes).flatMap(
    ({ onVictory = [], onDefeat = [], onFlee = [] }) => [
      ...onVictory,
      ...onDefeat,
      ...onFlee,
    ],
  );
  checkEffects("factions", clockEffects);
  checkEffects("variants", variantEffects);
  checkEffects("encounters", outcomeEffects);

  for (const clock of clocks) {
    for (const { value } of clock.at) {
      if (value > clock.max)
        report(
          "factions",
          `clock "${clock.id}": ${String(value)} is above its max`,
        );
    }
  }
  for (const npc of npcs) {
    for (const secret of npc.knows) need("npcs", secretIds, secret, "secret");
    if (npc.statsId) contentReferences.push(npc.statsId);
  }
  for (const secret of secrets) {
    for (const clue of secret.clues)
      need("secrets", sceneIds, clue.scene, "scene");
  }
  for (const beat of beats) {
    need("beats", sceneIds, beat.scene, "scene");
    checkCondition("beats", beat.when);
  }

  const edges = new Map<string, string[]>();
  const gotos = (effects: readonly StoryEffect[]): string[] =>
    effects.flatMap((effect) => (effect.kind === "goto" ? [effect.scene] : []));

  for (const scene of scenes) {
    if (scene.art && !assetPaths.has(scene.art)) {
      report("scenes", `scene "${scene.id}": missing asset "${scene.art}"`);
    }
    for (const { when } of scene.textVariants) checkCondition("scenes", when);
    const targets: string[] = [];
    for (const choice of scene.choices) {
      checkCondition("scenes", choice.when);
      if ("effects" in choice) {
        checkEffects("scenes", choice.effects);
        targets.push(...gotos(choice.effects));
      } else {
        const check = system.checkSchema.safeParse(choice.check);
        if (!check.success) {
          issues.push(
            ...zodIssues(
              pluginId,
              fileName("scenes"),
              check.error,
              `${scene.id}.check`,
            ),
          );
        }
        checkResults(scene.id, choice.results);
        for (const effects of Object.values(choice.results)) {
          checkEffects("scenes", effects);
          targets.push(...gotos(effects));
        }
      }
    }
    edges.set(scene.id, targets);
  }

  if (info.success) {
    need("adventure", sceneIds, info.data.startScene, "scene");

    const entryPoints = [
      info.data.startScene,
      ...beats.map((beat) => beat.scene),
      ...gotos(clockEffects),
      ...gotos(variantEffects),
      ...gotos(outcomeEffects),
    ];
    const reachable = new Set<string>();
    const queue = [...entryPoints];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(...(edges.get(next) ?? []));
    }
    for (const scene of scenes) {
      if (!reachable.has(scene.id))
        report("scenes", `scene "${scene.id}" is unreachable`);
    }
    if (
      !scenes.some(
        (scene) => scene.choices.length === 0 && reachable.has(scene.id),
      )
    ) {
      report(
        "scenes",
        "no reachable ending: at least one scene must have no choices",
      );
    }
  }

  const adventure: Adventure | null = info.success
    ? {
        ...info.data,
        scenes,
        npcs,
        factions,
        secrets,
        variants,
        beats,
        encounters,
        encounterOutcomes,
      }
    : null;
  return { adventure, issues, contentReferences };
}
