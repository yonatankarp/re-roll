import { parse, stringify } from "yaml";
import { z } from "zod";
import { hashText } from "../kernel/dice.ts";
import type { Storage } from "../kernel/storage.ts";
import type { GameSystem, ImportKind, ImportSource } from "../kernel/system.ts";
import type { ModelClient } from "../prep/model.ts";
import { runJob } from "../prep/run-job.ts";

const OUTPUT_ROOT = "private/import";
const RULES_ROOT = "private/rules";

const DraftFileSchema = z.object({
  sourceHash: z.string(),
  status: z.enum(["encoded", "textOnly"]),
  notes: z.array(z.string()),
  entry: z.unknown(),
});

export interface ImportSummary {
  readonly total: number;
  readonly written: number;
  readonly encoded: number;
  readonly reused: number;
  readonly textOnly: number;
  readonly skippedAlreadyDone: number;
  readonly unparsed: readonly string[];
  readonly invalid: readonly string[];
  readonly duplicates: readonly string[];
}

export interface ImportRequest {
  readonly storage: Storage;
  readonly client: ModelClient;
  readonly system: GameSystem;
  readonly pluginId: string;
  readonly folder: string;
  readonly sourceText: string;
  readonly knownIds: readonly string[];
  readonly contentOf?: (id: string) => unknown;
  // Encodings already written by a capable model, by slug. When set, no model is called.
  readonly encodings?: Readonly<Record<string, unknown>>;
  readonly outputRoot?: string;
  readonly only?: (source: ImportSource) => boolean;
  // Reports progress as counts only, so book text doesn't end up in terminal output.
  readonly onProgress?: (done: number, total: number) => void;
}

function importKindOf(system: GameSystem, folder: string): ImportKind {
  const kind = system.importKinds?.[folder];
  if (!kind) {
    throw new Error(`System ${system.id} can't import "${folder}" yet`);
  }
  return kind;
}

const SAFE_NAME = /^[a-z0-9][a-z0-9.-]*$/;

function assertSafeName(label: string, value: string): void {
  if (!SAFE_NAME.test(value)) throw new Error(`Invalid ${label}: "${value}"`);
}

export function splitSource(
  system: GameSystem,
  folder: string,
  sourceText: string,
): {
  readonly sources: readonly ImportSource[];
  readonly duplicates: readonly string[];
} {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const sources: ImportSource[] = [];
  for (const source of importKindOf(system, folder).split(sourceText)) {
    if (seen.has(source.slug)) duplicates.push(source.name);
    else sources.push(source);
    seen.add(source.slug);
  }
  return { sources, duplicates };
}

// Each draft is saved as soon as it's written, so an interrupted overnight run resumes where it stopped.
export async function importSource(
  request: ImportRequest,
): Promise<ImportSummary> {
  const { storage, client, system, pluginId, folder, knownIds } = request;
  assertSafeName("plugin id", pluginId);
  assertSafeName("content folder", folder);
  const kind = importKindOf(system, folder);
  const contentKind = system.contentKinds[folder];
  if (!contentKind) throw new Error(`Unknown content folder "${folder}"`);

  const { sources, duplicates } = splitSource(
    system,
    folder,
    request.sourceText,
  );
  const selected = request.only ? sources.filter(request.only) : sources;
  const root = `${request.outputRoot ?? OUTPUT_ROOT}/${pluginId}/${folder}`;

  const unparsed: string[] = [];
  const invalid: string[] = [];
  let written = 0;
  let encoded = 0;
  let reused = 0;
  let textOnly = 0;
  let skippedAlreadyDone = 0;
  let done = 0;
  const reportLines: string[] = [];

  for (const source of selected) {
    done += 1;
    request.onProgress?.(done, selected.length);
    if (source.problem !== null) {
      unparsed.push(source.name);
      reportLines.push(`- **${source.name}:** not imported: ${source.problem}`);
      continue;
    }

    const path = `${root}/${source.slug}.yaml`;
    const sourceHash = hashText(source.text);
    const existing = await storage.read(path);
    if (existing !== null) {
      const previous = DraftFileSchema.safeParse(parse(existing));
      if (previous.success && previous.data.sourceHash === sourceHash) {
        skippedAlreadyDone += 1;
        continue;
      }
    }

    const referenceId = knownIds.find((id) =>
      id.endsWith(`:${kind.idPrefix}/${source.slug}`),
    );
    const candidate =
      referenceId === undefined ? null : request.contentOf?.(referenceId);
    const reference =
      candidate && kind.matchesReference(source, candidate) ? candidate : null;

    const { verification } = kind;
    const provided = request.encodings?.[source.slug];
    const check =
      provided === undefined ? null : kind.validate(provided, source);
    const result =
      reference !== null || request.encodings
        ? null
        : await runJob(
            {
              id: `${pluginId}:${folder}:${source.slug}`,
              kind: folder,
              system: kind.systemPrompt,
              prompt: kind.prompt(source),
              schema: kind.modelSchema,
              validate: (value) => kind.validate(value, source),
              spoilerTerms: [],
              reviews: [
                {
                  name: "mechanics",
                  system: verification.system,
                  schema: verification.schema,
                  applies: verification.applies,
                  prompt: (answer) => verification.prompt(answer, source),
                  ifUnreadable: "reject",
                  judge: (verdict) => verification.judge(verdict, source),
                },
              ],
              fallback: null,
              maxTokens: kind.maxTokens,
            },
            client,
            { seed: 42, temperature: 0.2 },
          );

    const built = kind.build({
      source,
      draft: check?.success
        ? check.data
        : result?.status === "written"
          ? result.output
          : null,
      reference,
      pluginId,
      knownIds,
    });
    const parsed = contentKind.parse(built.entry);
    if (!parsed.ok) {
      invalid.push(source.name);
      reportLines.push(
        `- **${source.name}:** invalid draft: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
      continue;
    }

    const isEncoded =
      (built.entry as { readonly automation?: string }).automation !== "text";
    const failedChecks =
      result?.status === "fallback"
        ? [
            `mechanics rejected after ${String(result.attempts.length)} attempts: ${(
              result.attempts.at(-1)?.problems ?? []
            ).join(" ")}`,
          ]
        : [];
    const failedProvided =
      check && !check.success
        ? [
            `mechanics rejected: ${check.error.issues
              .map((issue) => issue.message)
              .join(" ")}`,
          ]
        : [];
    const notes = [...built.notes, ...failedChecks, ...failedProvided];
    await storage.replaceAtomically(
      path,
      stringify({
        sourceHash,
        status: isEncoded ? "encoded" : "textOnly",
        notes,
        entry: built.entry,
      }),
    );
    written += 1;
    if (reference !== null) reused += 1;
    if (isEncoded) encoded += 1;
    else textOnly += 1;
    if (notes.length > 0) {
      reportLines.push(`- **${source.name}:** ${notes.join("; ")}`);
    }
  }

  const summary: ImportSummary = {
    total: selected.length,
    written,
    encoded,
    reused,
    textOnly,
    skippedAlreadyDone,
    unparsed,
    invalid,
    duplicates,
  };

  await storage.replaceAtomically(
    `${root}/report.md`,
    [
      `# Import report: ${pluginId} ${folder}`,
      "",
      "Entries with mechanics passed automatic checks, which can still miss errors. Nothing here loads in the game until it's approved.",
      "",
      `Entries: ${String(summary.total)}. Written this run: ${String(written)} (${String(encoded)} with mechanics, including ${String(reused)} reused from reviewed entries; ${String(textOnly)} text only). Already done: ${String(skippedAlreadyDone)}.`,
      "",
      ...(duplicates.length > 0
        ? [`Duplicate names skipped: ${duplicates.join(", ")}`, ""]
        : []),
      "## Entries to look at",
      "",
      ...(reportLines.length > 0 ? reportLines : ["None."]),
      "",
    ].join("\n"),
  );
  return summary;
}

export interface ParsedSummary {
  readonly written: number;
  readonly invalid: readonly string[];
  readonly duplicates: readonly string[];
  readonly notAutomated: number;
}

// Writes entries that code parsed entirely from a book page, in the same draft form as the rest.
export async function importParsed(request: {
  readonly storage: Storage;
  readonly system: GameSystem;
  readonly pluginId: string;
  readonly folder: string;
  readonly html: string;
  readonly knownIds?: readonly string[];
}): Promise<ParsedSummary> {
  const { storage, system, pluginId, folder, html, knownIds } = request;
  assertSafeName("plugin id", pluginId);
  assertSafeName("content folder", folder);
  const parser = system.htmlParsers?.[folder];
  const contentKind = system.contentKinds[folder];
  if (!parser || !contentKind) {
    throw new Error(`System ${system.id} can't parse "${folder}" yet`);
  }
  const sourceHash = hashText(html);
  const seen = new Set<string>();
  const invalid: string[] = [];
  const duplicates: string[] = [];
  let written = 0;
  let notAutomated = 0;
  for (const { slug, entry, notes } of parser(html, pluginId, knownIds)) {
    if (seen.has(slug)) {
      duplicates.push(slug);
      continue;
    }
    seen.add(slug);
    if (!contentKind.parse(entry).ok || !SAFE_NAME.test(slug)) {
      invalid.push(slug);
      continue;
    }
    await storage.replaceAtomically(
      `${OUTPUT_ROOT}/${pluginId}/${folder}/${slug}.yaml`,
      stringify({
        sourceHash,
        status:
          (entry as { readonly automation?: string }).automation === "text"
            ? "textOnly"
            : "encoded",
        notes,
        entry,
      }),
    );
    written += 1;
    notAutomated += notes.length;
  }
  return { written, invalid, duplicates, notAutomated };
}

export interface ApproveRequest {
  readonly storage: Storage;
  readonly system: GameSystem;
  readonly pluginId: string;
  readonly folder: string;
  readonly slugs: readonly string[] | "all";
  readonly requires: readonly {
    readonly plugin: string;
    readonly version: string;
  }[];
  readonly outputRoot?: string;
}

export interface ApproveResult {
  readonly approved: readonly string[];
  readonly missing: readonly string[];
}

// Drafts never load in the game. Approving copies them to where the plugin loader can see them.
export async function approveImport(
  request: ApproveRequest,
): Promise<ApproveResult> {
  const { storage, system, pluginId, folder } = request;
  assertSafeName("plugin id", pluginId);
  assertSafeName("content folder", folder);
  const draftRoot = `${request.outputRoot ?? OUTPUT_ROOT}/${pluginId}/${folder}`;
  const pluginRoot = `${RULES_ROOT}/${pluginId}`;

  const available = (await storage.list(draftRoot))
    .filter((item) => !item.symlink && item.path.endsWith(".yaml"))
    .map((item) => item.path.slice(draftRoot.length + 1, -".yaml".length));
  const wanted = request.slugs === "all" ? available : request.slugs;
  const missing = wanted.filter((slug) => !available.includes(slug));

  const manifestPath = `${pluginRoot}/plugin.yaml`;
  if ((await storage.read(manifestPath)) === null) {
    await storage.replaceAtomically(
      manifestPath,
      stringify({
        id: pluginId,
        kind: "rules",
        version: "1.0.0",
        sdk: "^1",
        system: `${system.id}@^1`,
        requires: request.requires,
        distribution: "private",
      }),
    );
  }

  const approved: string[] = [];
  for (const slug of wanted) {
    if (!available.includes(slug)) continue;
    const text = await storage.read(`${draftRoot}/${slug}.yaml`);
    if (text === null) continue;
    const draft = DraftFileSchema.parse(parse(text));
    await storage.replaceAtomically(
      `${pluginRoot}/${folder}/${slug}.yaml`,
      stringify([draft.entry]),
    );
    approved.push(slug);
  }
  return { approved, missing };
}
