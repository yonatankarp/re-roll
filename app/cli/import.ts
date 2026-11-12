import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { formatIssue } from "../../engine/kernel/issues.ts";
import { loadRun, scanPlugins } from "../../engine/kernel/loader.ts";
import { createLlamaClient } from "../../engine/platform/node/llama-client.ts";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { checkPlugins } from "../../engine/tools/check-pack.ts";
import { buildLibrary } from "../../engine/tools/library.ts";
import {
  approveImport,
  importParsed,
  importSource,
  splitSource,
} from "../../engine/tools/import.ts";
import { spellTextFromHtml } from "../../plugins/systems/dnd5.5e/core/import/spells.ts";
import { systems } from "../systems.ts";
import { PLUGIN_ROOTS } from "./load-adventure.ts";

// Text and images from your own books stay under books/, which git ignores.
//   npm run import -- split --kind spells --input books/sources/spells.txt
//   npm run import -- draft --plugin my-book --kind spells --input books/sources/spells.txt
//   npm run import -- approve --plugin my-book --kind spells --all

const USAGE = `Usage:
  npm run import -- parse   --plugin <id> --kind <folder> --input <book.html> [--requires <id>]
  npm run import -- split   --kind <folder> --input <file>
  npm run import -- extract --input <book.html> --output <file>
  npm run import -- draft   --plugin <id> --kind <folder> --input <file> [--system <id>] [--encodings <file>]
  npm run import -- library --plugin <id> --input <book.html>
  npm run import -- approve --plugin <id> --kind <folder> (--all | --slugs a,b,c)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plugin: { type: "string" },
    kind: { type: "string" },
    input: { type: "string" },
    system: { type: "string", default: "dnd5.5e" },
    requires: { type: "string", default: "srd52" },
    slugs: { type: "string" },
    all: { type: "boolean", default: false },
    server: { type: "string", default: "http://127.0.0.1:8181" },
    "allow-remote": { type: "boolean", default: false },
    encodings: { type: "string" },
    output: { type: "string" },
  },
});

const [command] = positionals;

// One Markdown file per section, written by code, for reading and DM prep.
if (command === "library") {
  const id = values.plugin;
  if (!id || !values.input || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    console.error(USAGE);
    process.exit(2);
  }
  const library = buildLibrary(await readFile(values.input, "utf8"));
  const root = `books/library/${id}`;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const [file, text] of library.files) {
    await writeFile(`${root}/${file}`, text);
  }
  await writeFile(
    `${root}/index.json`,
    `${JSON.stringify({ plugin: id, title: library.title, entries: library.entries }, null, 2)}\n`,
  );
  const kinds: Record<string, number> = {};
  for (const entry of library.entries) {
    kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  }
  const words = library.entries.reduce((sum, entry) => sum + entry.words, 0);
  console.log(
    `${id}: ${String(library.entries.length)} sections, ${String(words)} words ${JSON.stringify(kinds)}`,
  );
  process.exit(0);
}

const folder = values.kind;
const system = systems.find((item) => item.id === values.system);
if (!system || !folder || !command) {
  console.error(USAGE);
  process.exit(2);
}

const storage = await createNodeStorage(process.cwd());

async function readInput(): Promise<string> {
  if (!values.input) {
    console.error(USAGE);
    process.exit(2);
  }
  // The input is a path the user chose, which may be outside the project, so it skips project storage.
  try {
    return await readFile(values.input, "utf8");
  } catch {
    console.error(`Can't read ${values.input}`);
    process.exit(1);
  }
}

if (command === "parse") {
  if (!values.plugin) {
    console.error(USAGE);
    process.exit(2);
  }
  const catalog = await scanPlugins(storage, PLUGIN_ROOTS);
  const loaded = await loadRun(storage, catalog, systems, [values.requires]);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map(formatIssue).join("\n"));
  }
  const summary = await importParsed({
    storage,
    system,
    pluginId: values.plugin,
    folder,
    html: await readInput(),
    knownIds: loaded.registry.contentIds(),
  });
  console.log(`Written: ${String(summary.written)}`);
  console.log(`Invalid: ${summary.invalid.join(", ") || "none"}`);
  console.log(`Duplicates: ${String(summary.duplicates.length)}`);
  console.log(`Abilities not automated: ${String(summary.notAutomated)}`);
} else if (command === "extract") {
  if (!values.output) {
    console.error(USAGE);
    process.exit(2);
  }
  await storage.replaceAtomically(
    values.output,
    spellTextFromHtml(await readInput()),
  );
  console.log(`Wrote ${values.output}`);
} else if (command === "split") {
  const { sources, duplicates } = splitSource(
    system,
    folder,
    await readInput(),
  );
  const unparsed = sources.filter((source) => source.problem !== null);
  console.log(`Found ${String(sources.length)} entries.`);
  console.log(
    `Unreadable: ${String(unparsed.length)}. Duplicates: ${String(duplicates.length)}.`,
  );
  console.log(sources.map((source) => source.name).join(", "));
} else if (command === "draft") {
  if (!values.plugin) {
    console.error(USAGE);
    process.exit(2);
  }
  const catalog = await scanPlugins(storage, PLUGIN_ROOTS);
  const loaded = await loadRun(storage, catalog, systems, [values.requires]);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map(formatIssue).join("\n"));
  }
  const encodingsText = values.encodings
    ? await storage.read(values.encodings)
    : null;
  const summary = await importSource({
    storage,
    client: createLlamaClient(values.server, {
      allowRemote: values["allow-remote"],
    }),
    system,
    pluginId: values.plugin,
    folder,
    sourceText: await readInput(),
    knownIds: loaded.registry.contentIds(),
    contentOf: (id) => loaded.registry.content(id),
    ...(encodingsText === null
      ? {}
      : {
          encodings: JSON.parse(encodingsText) as Record<string, unknown>,
        }),
    onProgress: (done, total) => {
      process.stdout.write(`\rEntry ${String(done)} of ${String(total)}`);
    },
  });
  console.log(`\nWith mechanics: ${String(summary.encoded)}`);
  console.log(`Reused from reviewed entries: ${String(summary.reused)}`);
  console.log(`Text only: ${String(summary.textOnly)}`);
  console.log(`Already done: ${String(summary.skippedAlreadyDone)}`);
  console.log(`Unreadable: ${String(summary.unparsed.length)}`);
  console.log(`Invalid: ${String(summary.invalid.length)}`);
  console.log(`Duplicates: ${String(summary.duplicates.length)}`);
  console.log(
    `Report: books/import/${values.plugin}/${folder}/report.md (keep this private, as it quotes your book)`,
  );
} else if (command === "approve") {
  const slugs = values.all ? "all" : values.slugs?.split(",");
  if (!values.plugin || !slugs) {
    console.error(USAGE);
    process.exit(2);
  }
  const result = await approveImport({
    storage,
    system,
    pluginId: values.plugin,
    folder,
    slugs,
    requires: [{ plugin: values.requires, version: "^1" }],
  });
  console.log(`Approved: ${String(result.approved.length)}`);
  if (result.missing.length > 0) {
    console.log(`Not found: ${result.missing.join(", ")}`);
  }
  const report = await checkPlugins(storage, PLUGIN_ROOTS, systems);
  for (const issue of report.issues) console.error(formatIssue(issue));
  console.log(`check-pack: ${String(report.issues.length)} issues`);
  if (report.issues.length > 0) process.exitCode = 1;
} else {
  console.error(USAGE);
  process.exit(2);
}
