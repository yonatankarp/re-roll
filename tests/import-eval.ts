import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { systems } from "../app/systems.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import { loadRun, scanPlugins } from "../engine/kernel/loader.ts";
import { createLlamaClient } from "../engine/platform/node/llama-client.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { importSource, splitSource } from "../engine/tools/import.ts";
import { describeEncoding } from "../plugins/systems/dnd5.5e/core/import/spells.ts";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";
import {
  type Activation,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";

// Manual evaluation against a running llama-server, so it stays out of `npm test`.
// Uses only the openly licensed SRD. Run tests/tools/extract-srd-spells.sh first.

const SERVER = process.env.LLAMA_URL ?? "http://127.0.0.1:8181";
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE ?? 25);
const SOURCE = "out/import-eval/srd-spells.txt";
const OUTPUT_ROOT = "out/import-eval/verified-drafts";
const RUN_ALL = process.env.RUN_ALL === "1";
const PLUGIN = "srd-eval";

// Each of these was encoded by hand from the same text, so it can be compared field by field.
// Magic Missile and Shield were simplified by hand, so some differences there are expected.
const GOLD = [
  "bless",
  "cure-wounds",
  "fire-bolt",
  "fireball",
  "healing-word",
  "magic-missile",
  "sacred-flame",
  "shield",
];

const sourceText = await readFile(SOURCE, "utf8");
const storage = await createNodeStorage(process.cwd());
const catalog = await scanPlugins(storage, ["plugins"]);
const loaded = await loadRun(storage, catalog, systems, ["srd52"]);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const { registry } = loaded;

const { sources, duplicates } = splitSource(dnd55e, "spells", sourceText);
const dice = createDice(rngFromSeed("import-eval"));
const others = sources.filter((source) => !GOLD.includes(source.slug));
const sampled: string[] = [];
while (sampled.length < SAMPLE_SIZE && others.length > 0) {
  const [picked] = others.splice(dice.below(others.length), 1);
  if (picked) sampled.push(picked.slug);
}
const selected = new Set(
  RUN_ALL ? sources.map((source) => source.slug) : [...GOLD, ...sampled],
);

const started = performance.now();
const summary = await importSource({
  storage,
  client: createLlamaClient(SERVER, {
    allowRemote: process.argv.includes("--allow-remote"),
  }),
  system: dnd55e,
  pluginId: PLUGIN,
  folder: "spells",
  sourceText,
  knownIds: registry.contentIds(),
  outputRoot: OUTPUT_ROOT,
  only: (source) => selected.has(source.slug),
  onProgress: (done, total) => {
    console.log(`Entry ${String(done)} of ${String(total)}`);
  },
});
const seconds = (performance.now() - started) / 1000;

function shapeOf(activation: Activation | undefined): Record<string, unknown> {
  if (!activation) return { encoded: false };
  const { resolution, targeting, cost } = activation;
  const shape =
    "self" in targeting ? "self" : "area" in targeting ? "area" : "creatures";
  return {
    cost,
    targeting: shape,
    count: "creatures" in targeting ? targeting.creatures : null,
    side: "side" in targeting ? targeting.side : null,
    resolution: resolution.kind,
    damage:
      "damage" in resolution
        ? resolution.damage.map(
            (item) => `${item.amount.dice ?? ""} ${item.type}`,
          )
        : [],
    ability: resolution.kind === "save" ? resolution.ability : null,
    onSuccessDamage:
      resolution.kind === "save" ? resolution.onSuccessDamage : null,
    effects:
      resolution.kind === "automatic"
        ? resolution.effects.map((item) => item.kind)
        : [],
  };
}

const lines = [
  "# Import evaluation",
  "",
  "## Summary",
  "",
  "| Measure | Value |",
  "|---|---|",
  `| Spells found in the source | ${String(sources.length)} |`,
  `| Unreadable overall | ${String(sources.filter((item) => item.problem !== null).length)} |`,
  `| Duplicates | ${String(duplicates.length)} |`,
  `| Spells run | ${String(summary.total)} |`,
  `| With mechanics | ${String(summary.encoded)} |`,
  `| Text only | ${String(summary.textOnly)} |`,
  `| Unreadable in this run | ${String(summary.unparsed.length)} |`,
  `| Invalid | ${String(summary.invalid.length)} |`,
  `| Seconds per entry | ${(seconds / Math.max(1, summary.written)).toFixed(0)} |`,
  `| Projected hours for all spells | ${(((seconds / Math.max(1, summary.written)) * sources.length) / 3600).toFixed(1)} |`,
  "",
  "## Compared with the hand-encoded spells",
  "",
];

let exact = 0;
for (const slug of GOLD) {
  const expected = SpellSchema.parse(registry.content(`srd52:spell/${slug}`));
  const text = await readFile(
    `${OUTPUT_ROOT}/${PLUGIN}/spells/${slug}.yaml`,
    "utf8",
  ).catch(() => null);
  const draft =
    text === null
      ? null
      : (parse(text) as {
          entry: { activation?: Activation; automation: string };
          notes: string[];
        });
  const got = shapeOf(draft?.entry.activation);
  const want = shapeOf(expected.activation);
  const differing = Object.keys({ ...want, ...got }).filter(
    (key) => JSON.stringify(got[key]) !== JSON.stringify(want[key]),
  );
  if (differing.length === 0) exact += 1;
  lines.push(
    `### ${expected.name}: ${differing.length === 0 ? "matches" : `differs in ${differing.join(", ")}`}`,
    "",
    `- Automation: ${draft?.entry.automation ?? "none"}`,
    ...(differing.length > 0
      ? [
          `- Expected: \`${JSON.stringify(want)}\``,
          `- Got: \`${JSON.stringify(got)}\``,
        ]
      : []),
    ...(draft?.notes.length ? [`- Notes: ${draft.notes.join("; ")}`] : []),
    "",
  );
}
lines.splice(
  6,
  0,
  `| Hand-encoded spells matched exactly | ${String(exact)} of ${String(GOLD.length)} |`,
);

lines.push("## Sampled spells", "");
for (const slug of RUN_ALL ? [...selected] : sampled) {
  const text = await readFile(
    `${OUTPUT_ROOT}/${PLUGIN}/spells/${slug}.yaml`,
    "utf8",
  ).catch(() => null);
  if (text === null) {
    lines.push(`### ${slug}: not drafted`, "");
    continue;
  }
  const draft = parse(text) as {
    entry: {
      name: string;
      text: string;
      automation: string;
      activation?: Activation;
    };
    notes: string[];
  };
  lines.push(
    `### ${draft.entry.name}: ${draft.entry.automation}`,
    "",
    `> ${draft.entry.text.replaceAll("\n", " ")}`,
    "",
    ...(draft.entry.activation
      ? [
          `\`${JSON.stringify(shapeOf(draft.entry.activation))}\``,
          "",
          `Game: ${describeEncoding(draft.entry.activation)}`,
          "",
        ]
      : []),
    ...(draft.notes.length ? [`Notes: ${draft.notes.join("; ")}`, ""] : []),
  );
}

await mkdir("out/import-eval", { recursive: true });
await writeFile("out/import-eval/report.md", lines.join("\n"));
console.log(`Report: out/import-eval/report.md (${seconds.toFixed(0)}s)`);
