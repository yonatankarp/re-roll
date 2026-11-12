// Levels a character of every class and subclass from 1 to 20 through the real level-up decisions, and lists what
// each feature gained does in the engine. Writes docs/class-features.md: names, statuses and reasons, never book text.
// Run: npm run class-features
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR } from "#sdk";
import { systems } from "../app/systems.ts";
import type { GameState } from "../engine/kernel/events.ts";
import { loadRun, scanPlugins } from "../engine/kernel/loader.ts";
import {
  type RunContext,
  createRunContext,
  startRun,
  step,
} from "../engine/kernel/turn.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import type { StoryEffect } from "../engine/story/adventure.ts";
import { CREATE_CHARACTER } from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  featureRules,
  grantedSpells,
} from "../plugins/systems/dnd5.5e/core/feature-rules.ts";
import {
  type CharacterBuild,
  type ClassDef,
  ClassSchema,
  FeatureSchema,
  type LeafEffect,
  type Resolution,
  type Subclass,
  SubclassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  type Stats,
  deriveStats,
  lookup,
} from "../plugins/systems/dnd5.5e/core/stats.ts";

export type Status = "working" | "partial" | "text-only";

export interface Row {
  readonly className: string;
  readonly subclass: string | null;
  readonly level: number;
  readonly feature: string;
  readonly id: string;
  readonly status: Status;
  readonly why: string;
}

const LEVEL_UP: StoryEffect = {
  kind: "system",
  effect: "dnd5.5e:levelUp",
  args: {},
};

// One scene per level after the first, each moved past by a level-up, ending in a scene with no choices.
function levellingRun(run: RunContext, level: number): RunContext {
  const scenes = Array.from({ length: level - 1 }, (_, index) => ({
    id: `s${String(index)}`,
    text: "Onward.",
    textVariants: [],
    rest: true,
    choices: [
      {
        label: "Go on",
        effects: [
          LEVEL_UP,
          { kind: "goto" as const, scene: `s${String(index + 1)}` },
        ],
      },
    ],
  }));
  const end = {
    id: `s${String(level - 1)}`,
    text: "The end.",
    textVariants: [],
    rest: true,
    choices: [],
  };
  return {
    ...run,
    adventure: { ...run.adventure, startScene: "s0", scenes: [...scenes, end] },
  };
}

// Builds a character through the real creation and level-up decisions, answering the class and subclass and taking
// the first option everywhere else.
export function levelTo(
  base: RunContext,
  classId: string,
  subclassId: string | null,
  level: number,
): Actor {
  const run = levellingRun(base, level);
  let { state, pending } = startRun(
    run,
    `audit:${classId}:${subclassId ?? ""}`,
  );
  let guard = 0;
  while (pending) {
    guard += 1;
    if (guard > 2000) throw new Error(`${classId}: too many decisions`);
    const decision = pending;
    const id = decision.id;
    const optionId = id.includes("chooseCharacter")
      ? CREATE_CHARACTER
      : id.endsWith(":class")
        ? classId
        : id.endsWith(":subclass-0") && subclassId
          ? subclassId
          : (decision.options[0]?.id ?? "");
    const outcome = step(run, state, {
      kind: "answer",
      decisionId: id,
      optionId,
    });
    if (!outcome.ok) throw new Error(`${id}: ${outcome.error}`);
    ({ state, pending } = outcome);
  }
  return playerOf(state);
}

function playerOf(state: GameState): Actor {
  const actor = StateSchema.parse(state.system).actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  return actor;
}

function buildOf(actor: Actor): CharacterBuild {
  if (actor.source.kind !== "character" || !actor.source.build) {
    throw new Error("No build");
  }
  return actor.source.build;
}

function atLevel(actor: Actor, level: number): Actor {
  const build = buildOf(actor);
  return {
    ...actor,
    source: {
      kind: "character",
      build: { ...build, levels: build.levels.slice(0, level) },
    },
  };
}

// Features granted by the class and subclass up to a level, plus options picked at level-up.
function classFeatures(
  build: CharacterBuild,
  classDef: ClassDef,
  subclass: Subclass | null,
  level: number,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of build.levels.slice(0, level)) {
    for (const answer of entry.answers) {
      if (answer.kind === "features") answer.values.forEach((v) => ids.add(v));
    }
  }
  for (const source of [classDef, subclass]) {
    for (const item of source?.levels ?? []) {
      if (item.level <= level) item.grants.forEach((id) => ids.add(id));
    }
  }
  return ids;
}

// Effects the engine applies. A note or a forced move does nothing yet.
const INERT = new Set<LeafEffect["kind"]>(["note", "forcedMove"]);

function resolutionKinds(resolution: Resolution): string[] {
  const effects =
    resolution.kind === "automatic"
      ? resolution.effects
      : resolution.kind === "attack"
        ? [...resolution.onHit, ...resolution.onMiss]
        : [...resolution.onFail, ...resolution.onSuccess];
  return [
    ...(resolution.damage.length > 0 ? [`${resolution.kind} damage`] : []),
    ...(resolution.kind === "attack" && resolution.damage.length === 0
      ? ["attack"]
      : []),
    ...effects
      .filter((effect) => !INERT.has(effect.kind))
      .map((effect) =>
        effect.kind === "modifier"
          ? effect.modifier.kind
          : effect.kind === "applyCondition"
            ? `condition ${effect.condition}`
            : effect.kind,
      ),
  ];
}

const counted = (items: readonly string[]): string =>
  [...new Set(items)]
    .map((item) => {
      const times = items.filter((other) => other === item).length;
      return times > 1 ? `${item} x${String(times)}` : item;
    })
    .join(", ");

// Features the level-up flow or the stats read by their id, rather than by their data.
function handledByName(
  id: string,
  stats: Stats,
): { status: Status; why: string } | null {
  const working = (why: string) => ({ status: "working" as const, why });
  if (id.endsWith("-subclass")) return working("level choice: subclass");
  if (id.endsWith("ability-score-improvement")) {
    return working("level choice: feat");
  }
  if (id.endsWith("fighting-style"))
    return working("level choice: fighting style");
  if (id.endsWith("epic-boon")) return working("level choice: epic boon");
  if (id.endsWith("weapon-mastery")) {
    return working("level choice: weapon masteries");
  }
  if (/extra-attack|two-extra-attacks|three-extra-attacks/.test(id)) {
    return working(`attacks per action: ${String(stats.multiattack)}`);
  }
  if (id.endsWith("pact-magic") || id.endsWith("spellcasting")) {
    const slots = stats.slots.reduce((sum, count) => sum + count, 0);
    return slots > 0
      ? working(`spell slots: ${String(slots)}, spells picked at level-up`)
      : { status: "partial", why: "no spell slots in the class data" };
  }
  return null;
}

// Actions of other features that spend a resource, as a subclass's Channel Divinity option spends the class's uses.
function spentElsewhere(resource: string, featureId: string, stats: Stats) {
  return stats.actions.some(
    (action) =>
      !action.id.startsWith(`feature:${featureId}:`) &&
      action.activation.cost.some(
        (cost) => typeof cost === "object" && cost.resource === resource,
      ),
  );
}

const OUT_OF_COMBAT = "out of combat only: skills, tools or languages";
const SLOT_RECOVERY = "needs a way to regain spell slots";

// What the engine would need first, for the level 1 to 5 class features left as text.
const WAITING_ON: Readonly<Record<string, string>> = {
  "barbarian-danger-sense": "needs Advantage on one ability's saves",
  "barbarian-primal-knowledge": OUT_OF_COMBAT,
  "bard-expertise": OUT_OF_COMBAT,
  "bard-jack-of-all-trades": OUT_OF_COMBAT,
  "cleric-divine-order": "needs a choice between the orders at level-up",
  "cleric-sear-undead": "needs damage added to Turn Undead",
  "druid-druidic": OUT_OF_COMBAT,
  "druid-primal-order": "needs a choice between the orders at level-up",
  "druid-wild-companion": "needs summoned familiars",
  "druid-wild-resurgence": SLOT_RECOVERY,
  "fighter-tactical-mind": OUT_OF_COMBAT,
  "fighter-tactical-shift": "needs free movement after Second Wind",
  "monk-uncanny-metabolism": "needs Focus Points regained on Initiative",
  "monk-slow-fall": "no falling in fights",
  "paladin-faithful-steed": "needs summoned mounts",
  "ranger-deft-explorer": OUT_OF_COMBAT,
  "rogue-expertise": OUT_OF_COMBAT,
  "rogue-thieves-cant": OUT_OF_COMBAT,
  "rogue-cunning-action": "needs bonus-action Dash, Disengage and Hide",
  "rogue-cunning-strike": "needs Sneak Attack dice traded for effects",
  "sorcerer-font-of-magic": "needs Sorcery Points turned into spell slots",
  "sorcerer-metamagic": "needs Metamagic options picked and applied to spells",
  "sorcerer-sorcerous-restoration": SLOT_RECOVERY,
  "warlock-eldritch-invocations": "needs invocation choices at level-up",
  "warlock-magical-cunning": SLOT_RECOVERY,
  "wizard-ritual-adept": OUT_OF_COMBAT,
  "wizard-arcane-recovery": SLOT_RECOVERY,
  "wizard-scholar": OUT_OF_COMBAT,
  "wizard-memorize-spell": "needs prepared spells swapped on a Short Rest",
};

export function classify(
  id: string,
  stats: Stats,
  access: RunContext,
): { name: string; status: Status; why: string } {
  const feature = featureRules(lookup(access, FeatureSchema, id));
  const named = handledByName(id, stats);
  if (named) return { name: feature.name, ...named };

  const reasons: string[] = [];
  let broken = false;
  for (const resource of feature.resources) {
    const max = stats.resources[resource.id] ?? 0;
    if (max <= 0) broken = true;
    reasons.push(`resource ${resource.id} max ${String(max)}`);
    if (spentElsewhere(resource.id, feature.id, stats)) {
      reasons.push(`${resource.id} spent by other features`);
    }
  }
  const passives = feature.passives.map((passive) =>
    passive.kind === "modifier" ? passive.modifier.kind : passive.kind,
  );
  if (passives.length > 0) reasons.push(`passive: ${counted(passives)}`);
  for (const activation of feature.activations) {
    const kinds = resolutionKinds(activation.resolution);
    if (kinds.length === 0) continue;
    const cost = activation.cost
      .map((item) => (typeof item === "string" ? item : item.resource))
      .join("+");
    const when = activation.trigger ? " (triggered)" : "";
    reasons.push(`${cost || "free"}${when}: ${counted(kinds)}`);
  }
  const spells = grantedSpells(feature.id, stats.level).length;
  if (spells > 0) reasons.push(`always-prepared spells: ${String(spells)}`);
  if (reasons.length === feature.resources.length) {
    return {
      name: feature.name,
      status: "text-only",
      why:
        reasons.length > 0
          ? `${reasons.join("; ")}; nothing spends it`
          : (WAITING_ON[id.slice(id.indexOf("/") + 1)] ?? "no mechanics"),
    };
  }
  const status: Status =
    broken || feature.automation !== "full" ? "partial" : "working";
  return {
    name: feature.name,
    status,
    why: [...reasons, ...(broken ? ["a resource has no uses"] : [])].join("; "),
  };
}

export function auditClass(
  run: RunContext,
  classDef: ClassDef,
  subclass: Subclass | null,
): Row[] {
  const actor = levelTo(run, classDef.id, subclass?.id ?? null, 20);
  const build = buildOf(actor);
  const rows: Row[] = [];
  let before = new Set<string>();
  for (let level = 1; level <= build.levels.length; level += 1) {
    const now = classFeatures(build, classDef, subclass, level);
    const stats = deriveStats(atLevel(actor, level), run);
    for (const id of now) {
      if (before.has(id)) continue;
      const fromSubclass =
        subclass?.levels.some((item) => item.grants.includes(id)) ?? false;
      const { name, status, why } = classify(id, stats, run);
      rows.push({
        className: classDef.name,
        subclass: fromSubclass ? (subclass?.name ?? null) : null,
        level,
        feature: name,
        id,
        status,
        why,
      });
    }
    before = now;
  }
  return rows;
}

export async function bookRun(): Promise<{ run: RunContext; book: string }> {
  const saves = await mkdtemp(join(tmpdir(), "class-audit-"));
  const storage = await createPlayStorage(process.cwd(), saves);
  const catalog = await scanPlugins(storage, ["plugins", "private"]);
  for (const book of ["phb", "srd52"]) {
    if (!catalog.plugins.has(book)) continue;
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      book,
    ]);
    if (loaded.ok) {
      return { run: createRunContext(loaded.registry, "goblin-ambush"), book };
    }
  }
  throw new Error("Neither phb nor srd52 loads");
}

function table(rows: readonly Row[]): string {
  const lines = [
    "| Class | Level | Feature | Status | Why |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.subclass ? `${row.className} (${row.subclass})` : row.className} | ${String(row.level)} | ${row.feature} | ${row.status} | ${row.why} |`,
    ),
  ];
  return lines.join("\n");
}

function counts(rows: readonly Row[], className: string): string {
  const of = (status: Status) =>
    rows.filter((row) => row.className === className && row.status === status)
      .length;
  return `| ${className} | ${String(of("working"))} | ${String(of("partial"))} | ${String(of("text-only"))} |`;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const { run, book } = await bookRun();
  const classes = run
    .contentIds()
    .filter((id) => id.startsWith(`${book}:class/`))
    .map((id) => lookup(run, ClassSchema, id));
  const subclasses = run
    .contentIds()
    .filter((id) => id.startsWith(`${book}:subclass/`))
    .map((id) => lookup(run, SubclassSchema, id))
    .filter((item) => item.edition === undefined);
  const rows: Row[] = [];
  for (const classDef of classes) {
    const own = subclasses.filter((item) => item.class === classDef.id);
    const seen = new Set<string>();
    for (const subclass of own.length > 0 ? own : [null]) {
      for (const row of auditClass(run, classDef, subclass)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  }
  rows.sort(
    (a, b) =>
      a.className.localeCompare(b.className) ||
      (a.subclass ?? "").localeCompare(b.subclass ?? "") ||
      a.level - b.level,
  );
  const names = [...new Set(rows.map((row) => row.className))];
  const doc = [
    "# Class features in play",
    "",
    `Generated by \`npm run class-features\` from the \`${book}\` classes: each class and subclass is levelled from 1 to 20`,
    "through the real level-up decisions, and each feature gained is checked against what the engine does with it.",
    "",
    "- **working**: the feature's mechanics run in the engine, or the level-up flow handles it by id.",
    "- **partial**: some of it runs, such as a resource and its main effect, but riders are missing.",
    "- **text-only**: the engine does nothing with it yet.",
    "",
    "## Counts",
    "",
    "| Class | Working | Partial | Text-only |",
    "| --- | --- | --- | --- |",
    ...names.map((name) => counts(rows, name)),
    "",
    "## Features",
    "",
    table(rows),
    "",
  ].join("\n");
  await writeFile("docs/class-features.md", doc);
  console.log(
    [
      "| Class | Working | Partial | Text-only |",
      ...names.map((name) => counts(rows, name)),
    ].join("\n"),
  );
}
