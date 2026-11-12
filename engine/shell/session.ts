import { parse } from "yaml";
import { z } from "zod";
import {
  type Decision,
  type GameEvent,
  type GameState,
  PLAYER_ACTOR,
  isNamespacedEvent,
  isNarrativeEvent,
} from "../kernel/events.ts";
import { formatIssue } from "../kernel/issues.ts";
import {
  type Catalog,
  type Registry,
  loadRun,
  scanPlugins,
} from "../kernel/loader.ts";
import { type LogEntry, createSave, loadSave } from "../kernel/save.ts";
import type { Storage } from "../kernel/storage.ts";
import { type Ambience, sceneAmbience } from "../story/ambience.ts";
import { scenesAhead } from "../story/narration.ts";
import { REST_OPTION_PREFIX, sceneText } from "../story/runtime.ts";
import type { Adventure } from "../story/adventure.ts";
import type { GameSystem, SystemSetting } from "../kernel/system.ts";
import {
  type RunContext,
  applyEvent,
  createRunContext,
  pendingDecision,
  resolveSettings,
  startRun,
  step,
} from "../kernel/turn.ts";
import type {
  CombatView,
  DecisionCard,
  ShopView,
  OptionGroup,
  OptionView,
  RollView,
  SheetView,
  SystemUi,
} from "./system-ui.ts";

// Everything the page does to the game, with no DOM, so tests can play through the same code.

const SAVES = "saves";
// Saves have a strict format with no clock in it, so the times live beside them.
const SAVE_TIMES = `${SAVES}/times`;
// What each save's card shows. Kept apart from the times, which older builds still read as plain strings.
const SAVE_DETAILS = `${SAVES}/details`;
const AUTOSAVE = "-autosave";
const AUTOSAVE_END = `${AUTOSAVE}.json`;
const AUTOSAVES_KEPT = 5; // the current run's included
const ASSETS = "books/assets";
const LIBRARY = "books/library";
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const BARE_NAME = /^[^/\\]+$/;

export interface LogLine {
  readonly kind: "scene" | "event";
  readonly text: string;
  readonly actor?: string | null;
  // A line worth more than the ticker: the player's level-up, or a foe defeated, which the ending counts.
  readonly moment?: "levelUp" | "foeDefeated";
}

// A roll, with the step of the log it came in, so the latest choice's rolls can be found.
export interface RollLine extends RollView {
  readonly step: number;
}

// The clues found that point to one secret, newest first. Only the clue text, never what the secret is.
export interface LeadGroup {
  readonly clues: readonly { readonly text: string; readonly step: number }[];
}

export interface GameView {
  readonly title: string;
  readonly scene: string | null;
  readonly sceneTitle: string | null; // a name for the scene, such as for the window title
  readonly sceneArt: string | null; // a content path, for imageUrl
  readonly ambience: Ambience; // the background sound the scene asks for
  readonly upcoming: readonly string[]; // the text of scenes the choices go to, to read ahead
  readonly endingName: string | null;
  readonly optionGroups: readonly OptionGroup[];
  readonly card: DecisionCard | null; // shown above the choices, such as treasure found
  readonly shop: ShopView | null; // a merchant's screen, shown in place of the choices
  readonly rests: readonly OptionView[]; // offered at the campfire, apart from the choices
  readonly monsterArt: Readonly<Record<string, string>>; // by combatant id
  readonly tokenArt: Readonly<Record<string, TokenArt>>; // by combatant id, with its face
  readonly adventureRoot: string; // where the adventure's own pictures are
  readonly decision: Decision | null;
  readonly combat: CombatView | null;
  readonly sheets: readonly SheetView[]; // the player's first
  readonly log: readonly LogLine[];
  // Plain data for the system's encounter board to animate, in order, from the start of the run.
  readonly cues: readonly unknown[];
  readonly rolls: readonly RollLine[]; // from the start of the run, oldest first
  readonly leads: readonly LeadGroup[]; // the group with the newest clue first
  readonly steps: number; // inputs so far, the run's start included
  readonly canUndo: boolean; // a forgiving setting is on and there's a choice to take back
  readonly system: string;
  readonly systemState: unknown; // for the system's own board
  readonly ended: GameState["story"]["ended"];
  readonly playerDied: boolean;
  readonly about: string;
  readonly attributions: readonly string[];
  readonly warnings: readonly string[];
}

export interface AdventureChoice {
  readonly id: string;
  readonly title: string;
  readonly source: "shipped" | "private";
  readonly levels: string | null;
  readonly cover: string | null; // a content path, for imageUrl
}

export interface SaveChoice {
  readonly path: string;
  readonly label: string;
  readonly adventure: string;
  readonly savedAt: string | null;
  readonly title: string;
  readonly kind: "autosave" | "manual";
  readonly when: string | null; // savedAt, for people
  readonly ago: string | null; // savedAt from now, such as "2 min ago"
  readonly steps: number;
  readonly current: boolean; // the autosave of the run being played
  // Who is playing, such as "Human Wizard", and the first number the system sums them up with, such as "6/8 HP".
  readonly character: string | null;
  readonly characterKind: string | null; // such as "Human Wizard", when the name doesn't already say it
  readonly health: string | null;
  // Missing on saves made before these were recorded, until the save is next loaded.
  readonly scene: string | null;
  readonly level: number | null;
  readonly settings: readonly string[]; // option labels, such as the difficulty
  readonly art: string | null; // a content path, for imageUrl
}

export interface BookSection {
  readonly heading: string;
  readonly depth: number;
  readonly file: string;
}

interface Current {
  readonly adventure: string;
  readonly seed: string;
  readonly root: string;
  readonly registry: Registry;
  readonly run: RunContext;
  readonly ui: SystemUi;
  readonly log: LogEntry[];
  readonly lines: LogLine[];
  readonly cues: unknown[];
  readonly rolls: RollLine[];
  readonly clues: Clue[];
  state: GameState;
  warnings: readonly string[];
}

const SaveHeaderSchema = z.object({ adventure: z.string() });
const AdventureInfoSchema = z.object({
  title: z.string(),
  levels: z.string().optional(),
});
const SaveInfoSchema = z.object({
  adventure: z.string(),
  seed: z.string(),
  log: z.array(z.unknown()),
});
const SaveTimesSchema = z.record(z.string(), z.string());
const SaveDetailsSchema = z.record(
  z.string(),
  z.object({
    scene: z.string().nullable(),
    level: z.number().nullable(),
    settings: z.array(z.string()),
    art: z.string().nullable(),
    // Added later, so older records have none, and a record without them must still parse.
    character: z.string().nullable().optional(),
    characterKind: z.string().nullable().optional(),
    health: z.string().nullable().optional(),
    // Kept so the menu needn't read every whole save; older records read the save instead.
    adventure: z.string().optional(),
    seed: z.string().optional(),
    steps: z.number().optional(),
  }),
);
type SaveDetails = z.infer<typeof SaveDetailsSchema>[string];
const FaceSchema = z.object({
  x: z.number(), // the face's centre, as a share of the picture's width
  y: z.number(), // and of its height
  size: z.number(), // the face's width, as a share of the picture's width
});
const ArtIndexSchema = z.array(
  z.object({
    file: z.string(),
    monster: z.string().optional(),
    subjects: z.array(z.string()).optional(), // other names it can stand for, such as "dwarf cleric"
    face: FaceSchema.optional(),
    cover: z.array(z.string()).optional(), // ids of the adventures this picture is the cover of
  }),
);

export interface TokenArt {
  readonly path: string;
  readonly face?: z.infer<typeof FaceSchema>;
}
const BookIndexSchema = z.object({
  title: z.string(),
  entries: z.array(z.object({ path: z.array(z.string()), file: z.string() })),
});

// "Goblin Warrior", "goblin-warrior" and "srd52:monster/goblin-warrior" all find the same picture.
function artKey(name: string): string {
  return (name.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stableIndex(id: string, count: number): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return count > 0 ? hash % count : 0;
}

// The scene's own title, or its id made readable for one that has none.
function sceneTitle(scene: Adventure["scenes"][number]): string {
  if (scene.title) return scene.title;
  const words = scene.id.replace(/-/g, " ");
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

export function stepsText(count: number): string {
  return `${String(count)} ${count === 1 ? "step" : "steps"}`;
}

// How long ago, such as "2 min ago", or null after a week, when the date itself says more.
function agoText(savedAt: string, now: number): string | null {
  const seconds = Math.max(0, (now - Date.parse(savedAt)) / 1000);
  if (Number.isNaN(seconds) || seconds >= 7 * 86400) return null;
  if (seconds < 60) return "just now";
  const format = new Intl.RelativeTimeFormat(undefined, { style: "short" });
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400)
    return format.format(-Math.floor(seconds / 3600), "hour");
  return format.format(-Math.floor(seconds / 86400), "day");
}

// What came back between two looks at the party, such as over a rest: per member whose sheet changed,
// a line per change, such as "Hit Points 7 → 12 of 12". Keyed by section too, since the same label,
// such as a weapon, can sit in two sections with different values.
export function sheetChanges(
  before: readonly SheetView[],
  after: readonly SheetView[],
): { readonly title: string; readonly changes: readonly string[] }[] {
  const key = (sheet: SheetView, section: string, label: string): string =>
    `${sheet.id}\u0000${section}\u0000${label}`;
  const was = new Map<string, string>();
  for (const sheet of before) {
    for (const section of sheet.sections) {
      for (const row of section.rows) {
        was.set(key(sheet, section.title, row.label), row.value);
      }
    }
  }
  return after.flatMap((sheet) => {
    const changes = sheet.sections.flatMap((section) =>
      section.rows.flatMap((row) => {
        const old = was.get(key(sheet, section.title, row.label));
        return old === undefined || old === row.value
          ? []
          : [
              `${row.label} ${old} → ${row.value}${row.note ? ` ${row.note}` : ""}`,
            ];
      }),
    );
    return changes.length > 0 ? [{ title: sheet.title, changes }] : [];
  });
}

interface Clue {
  readonly secret: string;
  readonly text: string;
  readonly step: number;
}

// Clues of the same secret together, the newest first in each and the group found last at the top.
export function leadGroups(clues: readonly Clue[]): LeadGroup[] {
  const groups = new Map<string, Clue[]>();
  for (const clue of [...clues].reverse()) {
    groups.set(clue.secret, [...(groups.get(clue.secret) ?? []), clue]);
  }
  return [...groups.values()].map((group) => ({
    clues: group.map(({ text, step }) => ({ text, step })),
  }));
}

function narrate(
  run: RunContext,
  ui: SystemUi,
  from: GameState | null,
  events: readonly GameEvent[],
  step: number, // the log entry these events belong to
): {
  readonly state: GameState | null;
  readonly lines: readonly LogLine[];
  readonly cues: readonly unknown[];
  readonly rolls: readonly RollLine[];
  readonly clues: readonly Clue[];
} {
  let state = from;
  const lines: LogLine[] = [];
  const cues: unknown[] = [];
  const rolls: RollLine[] = [];
  const clues: Clue[] = [];
  for (const event of events) {
    if (event.kind === "clueRevealed") {
      clues.push({ secret: event.secret, text: event.text, step });
    }
    if (event.kind === "runStarted") {
      state = event.state;
      continue;
    }
    if (state === null) throw new Error("The log has no run start");
    if (isNarrativeEvent(event) || isNamespacedEvent(event)) {
      const text = ui.describe(event, state.system, run);
      if (text !== null) {
        const moment =
          event.kind === "levelGained" && event.actor === PLAYER_ACTOR
            ? "levelUp"
            : event.kind === "actorDefeated" &&
                !state.partyIds.includes(event.actor)
              ? "foeDefeated"
              : undefined;
        lines.push({
          kind: "event",
          text,
          actor: ui.actorOf(event, state.system),
          ...(moment ? { moment } : {}),
        });
      }
    }
    if (ui.roll && isNamespacedEvent(event)) {
      const rolled = ui.roll(event, state.system, run);
      if (rolled) rolls.push({ ...rolled, step });
    }
    const before = state;
    state = applyEvent(run, state, event);
    if (ui.cue && (isNarrativeEvent(event) || isNamespacedEvent(event))) {
      const cue = ui.cue(event, before.system, state.system, run);
      if (cue !== null && cue !== undefined) cues.push(cue);
    }
    // Scene text is chosen after the event, so a "visited" variant counts this visit.
    if (event.kind === "sceneEntered") {
      const scene = run.adventure.scenes.find(
        (item) => item.id === event.scene,
      );
      if (scene) {
        lines.push({ kind: "scene", text: sceneText(run, state, scene) });
      }
    }
  }
  return { state, lines, cues, rolls, clues };
}

// The whole log told again from the start, as on loading or taking back a choice.
function retell(
  run: RunContext,
  ui: SystemUi,
  log: readonly LogEntry[],
): {
  readonly state: GameState | null;
  readonly lines: LogLine[];
  readonly cues: unknown[];
  readonly rolls: RollLine[];
  readonly clues: Clue[];
} {
  let state: GameState | null = null;
  const told = {
    lines: [] as LogLine[],
    cues: [] as unknown[],
    rolls: [] as RollLine[],
    clues: [] as Clue[],
  };
  log.forEach((entry, step) => {
    const part = narrate(run, ui, state, entry.events, step);
    state = part.state;
    told.lines.push(...part.lines);
    told.cues.push(...part.cues);
    told.rolls.push(...part.rolls);
    told.clues.push(...part.clues);
  });
  return { state, ...told };
}

// Whether the run's settings include a forgiving one that lets the player take back a choice.
function undoAllowed(run: RunContext, log: readonly LogEntry[]): boolean {
  const [first] = log;
  const chosen = resolveSettings(
    run,
    first?.input.kind === "start" ? first.input.settings : undefined,
  );
  return (run.system.settings ?? []).some(
    (setting) =>
      setting.options.find((option) => option.id === chosen[setting.id])
        ?.undo === true,
  );
}

export interface GameDependencies {
  readonly storage: Storage & {
    readonly remove?: (path: string) => Promise<void>;
  };
  readonly roots: readonly string[];
  readonly systems: readonly GameSystem[];
  readonly uis: readonly SystemUi[];
  readonly imageUrl?: (path: string) => string | Promise<string | null>;
}

export function createGame({
  storage,
  roots,
  systems,
  uis,
  imageUrl,
}: GameDependencies) {
  let current: Current | null = null;
  let monsterArt: ReadonlyMap<string, string> = new Map();
  // Every picture each name can use, so party members who share a look don't all share one face.
  let tokenArt: ReadonlyMap<string, readonly TokenArt[]> = new Map();
  let covers: ReadonlyMap<string, string> = new Map();

  // Art is optional and still being extracted, so a bad index only loses its pictures.
  const loadArt = async (): Promise<void> => {
    const found = new Map<string, string>();
    const tokens = new Map<string, TokenArt[]>();
    const coverPaths = new Map<string, string>();
    try {
      const entries = await storage.list(ASSETS);
      for (const { path } of entries) {
        if (!/^books\/assets\/[^/]+\/index\.json$/.test(path)) continue;
        const folder = path.slice(0, -"/index.json".length);
        const parsed = ArtIndexSchema.safeParse(
          JSON.parse((await storage.read(path)) ?? "null"),
        );
        for (const { file, monster, subjects, face, cover } of parsed.data ??
          []) {
          if (!BARE_NAME.test(file)) continue;
          const art = { path: `${folder}/${file}`, ...(face ? { face } : {}) };
          if (IMAGE_FILE.test(file)) {
            for (const id of cover ?? []) coverPaths.set(id, art.path);
          }
          if (monster) found.set(artKey(monster), art.path);
          for (const name of [
            ...(monster ? [monster] : []),
            ...(subjects ?? []),
          ]) {
            const key = artKey(name);
            tokens.set(key, [...(tokens.get(key) ?? []), art]);
          }
        }
      }
    } catch {
      // Nothing to show is the same as no art at all.
    }
    monsterArt = found;
    tokenArt = tokens;
    covers = coverPaths;
  };
  // The art is scanned once, and again when the plugins' files change.
  let artScan: Promise<void> | null = null;
  const scanArt = (): Promise<void> => (artScan ??= loadArt());

  // A missing or broken record only loses what the cards show, never the saves.
  const readRecord = async <T>(
    path: string,
    schema: z.ZodType<Record<string, T>>,
  ): Promise<Record<string, T>> => {
    const text = await storage.read(path);
    if (text === null) return {};
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      return {};
    }
  };
  const readSaveTimes = () => readRecord(SAVE_TIMES, SaveTimesSchema);
  const readSaveDetails = () => readRecord(SAVE_DETAILS, SaveDetailsSchema);

  // The setup screen opens an adventure to ask its settings, and starting it right after reuses that.
  let prepared: {
    readonly adventure: string;
    readonly opened: ReturnType<typeof openFresh>;
  } | null = null;
  const open = (adventure: string): ReturnType<typeof openFresh> => {
    const reuse = prepared?.adventure === adventure ? prepared.opened : null;
    prepared = null;
    return reuse ?? openFresh(adventure);
  };

  const loadFresh = async (adventure: string, catalog: Catalog) => {
    const loaded = await loadRun(storage, catalog, systems, [adventure]);
    if (!loaded.ok) {
      throw new Error(loaded.issues.map(formatIssue).join("\n"));
    }
    const { registry } = loaded;
    const ui = uis.find((item) => item.systemId === registry.system.id);
    if (!ui) throw new Error(`No UI for the ${registry.system.id} system`);
    return {
      registry,
      ui,
      root: catalog.plugins.get(adventure)?.root ?? "",
    };
  };
  // The last adventure loaded, kept while the plugins' files stay the same, so Continue, Load and
  // Restart don't load it all again. One, since a book's content is large.
  // shortcut: keyed on file lists, so an edit inside a file is missed; key on contents if content is edited during play.
  let loadedLast: {
    readonly key: string;
    readonly loading: ReturnType<typeof loadFresh>;
  } | null = null;

  const openFresh = async (adventure: string) => {
    const catalog = await scanPlugins(storage, roots);
    const key = JSON.stringify([
      adventure,
      [...catalog.plugins.values()].map(({ root, files }) => [root, files]),
    ]);
    if (loadedLast?.key !== key) {
      artScan = null;
      const loading = loadFresh(adventure, catalog);
      const entry = { key, loading };
      loadedLast = entry;
      loading.catch(() => {
        if (loadedLast === entry) loadedLast = null;
      });
    }
    const { registry, ui, root } = await loadedLast.loading;
    await scanArt();
    return { registry, ui, root, run: createRunContext(registry, adventure) };
  };

  const active = (): Current => {
    if (!current) throw new Error("No game is running");
    return current;
  };

  // What a save's card shows, read from the game as it stands.
  const detailsOf = (game: Current): SaveDetails => {
    const { run, ui, state, root, log } = game;
    const scene = run.adventure.scenes.find(
      (item) => item.id === state.story.scene,
    );
    const [first] = log;
    const chosen =
      first?.input.kind === "start" ? (first.input.settings ?? {}) : {};
    const [sheet] = ui.sheets(state.system, run);
    const [health] = sheet?.summary ?? [];
    return {
      adventure: game.adventure,
      seed: game.seed,
      steps: log.length,
      scene: scene ? sceneTitle(scene) : null,
      level: sheet?.level ?? null,
      character: sheet?.title ?? null,
      characterKind:
        sheet?.kind && sheet.kind !== sheet.title ? sheet.kind : null,
      health: health ? `${health.value} ${health.label}` : null,
      settings: (run.system.settings ?? []).flatMap((setting) => {
        const option = setting.options.find(
          (item) => item.id === chosen[setting.id],
        );
        return option ? [option.label] : [];
      }),
      art:
        scene?.art && IMAGE_FILE.test(scene.art)
          ? `${root}/${scene.art}`
          : null,
    };
  };

  const writeDetails = async (
    path: string,
    details: SaveDetails,
  ): Promise<void> => {
    const all = await readSaveDetails();
    all[path] = details;
    await storage.replaceAtomically(SAVE_DETAILS, JSON.stringify(all));
  };

  const savePath = (game: Current, name: string): string =>
    `${SAVES}/${game.adventure}-${name}.json`;
  const autosavePath = (game: Current): string =>
    savePath(game, `${game.seed}${AUTOSAVE}`);

  const write = async (game: Current, name: string): Promise<string> => {
    const path = savePath(game, name);
    await storage.replaceAtomically(
      path,
      JSON.stringify(
        createSave(game.registry, game.adventure, game.seed, game.log),
      ),
    );
    const times = await readSaveTimes();
    times[path] = new Date().toISOString();
    await storage.replaceAtomically(SAVE_TIMES, JSON.stringify(times));
    await writeDetails(path, detailsOf(game));
    return path;
  };

  const removeSave = async (path: string): Promise<void> => {
    if (!storage.remove) throw new Error("Saves can't be deleted here");
    await storage.remove(path);
    for (const [record, read] of [
      [SAVE_TIMES, readSaveTimes],
      [SAVE_DETAILS, readSaveDetails],
    ] as const) {
      const entries = Object.entries(await read());
      await storage.replaceAtomically(
        record,
        JSON.stringify(
          Object.fromEntries(entries.filter(([key]) => key !== path)),
        ),
      );
    }
  };

  // Every run leaves an autosave, so only the newest few are kept. Manual saves are never pruned.
  // Run when a run starts, the only time a new autosave appears.
  const pruneAutosaves = async (game: Current): Promise<void> => {
    if (!storage.remove) return;
    try {
      const times = await readSaveTimes();
      const own = autosavePath(game);
      const old = (await storage.list(SAVES))
        .map(({ path }) => path)
        .filter((path) => path.endsWith(AUTOSAVE_END) && path !== own)
        .sort((a, b) => (times[b] ?? "").localeCompare(times[a] ?? ""))
        .slice(AUTOSAVES_KEPT - 1);
      for (const path of old) await removeSave(path);
    } catch (error) {
      console.warn("Couldn't prune old autosaves", error);
    }
  };

  // One file per run, so starting again never overwrites an earlier run.
  // A failed autosave must not stop play, so the player is told and carries on.
  const autosave = async (game: Current): Promise<void> => {
    try {
      await write(game, `${game.seed}${AUTOSAVE}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      game.warnings = [`Autosave failed: ${reason}`];
    }
  };

  return {
    async listAdventures(): Promise<readonly AdventureChoice[]> {
      const [catalog] = await Promise.all([
        scanPlugins(storage, roots),
        scanArt(),
      ]);
      const adventures: AdventureChoice[] = [];
      for (const plugin of catalog.plugins.values()) {
        if (plugin.manifest.kind !== "adventure") continue;
        // One broken adventure only loses its title, so the menu and its saves stay reachable.
        let info: ReturnType<typeof AdventureInfoSchema.safeParse>;
        try {
          const text = await storage.read(`${plugin.root}/adventure.yaml`);
          info = AdventureInfoSchema.safeParse(parse(text ?? ""));
        } catch (error) {
          console.warn(`Can't read ${plugin.root}/adventure.yaml`, error);
          info = AdventureInfoSchema.safeParse(null);
        }
        adventures.push({
          id: plugin.manifest.id,
          title: info.success ? info.data.title : plugin.manifest.id,
          source: plugin.manifest.distribution,
          levels: info.data?.levels ?? null,
          cover: covers.get(plugin.manifest.id) ?? null,
        });
      }
      return adventures.sort((a, b) => (a.title < b.title ? -1 : 1));
    },

    // The menu passes the adventures it already listed, so it scans once.
    async listSaves(
      listed?: readonly AdventureChoice[],
    ): Promise<readonly SaveChoice[]> {
      const entries = await storage.list(SAVES);
      const times = await readSaveTimes();
      const allDetails = await readSaveDetails();
      const adventures = listed ?? (await this.listAdventures());
      const now = Date.now();
      const saves: SaveChoice[] = [];
      for (const { path } of entries) {
        if (!path.endsWith(".json")) continue;
        const name = path.slice(SAVES.length + 1, -".json".length);
        const details = allDetails[path];
        let info:
          { adventure: string; seed: string; steps: number } | undefined =
          details?.adventure !== undefined &&
          details.seed !== undefined &&
          details.steps !== undefined
            ? {
                adventure: details.adventure,
                seed: details.seed,
                steps: details.steps,
              }
            : undefined;
        if (!info) {
          try {
            const save = SaveInfoSchema.safeParse(
              JSON.parse((await storage.read(path)) ?? "null"),
            ).data;
            info = save && { ...save, steps: save.log.length };
          } catch {
            info = undefined;
          }
        }
        const savedAt = times[path] ?? null;
        const when = savedAt
          ? new Date(savedAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : null;
        const bare = {
          scene: details?.scene ?? null,
          level: details?.level ?? null,
          settings: details?.settings ?? [],
          art: details?.art ?? null,
          character: details?.character ?? null,
          characterKind: details?.characterKind ?? null,
          health: details?.health ?? null,
          savedAt,
          when,
          ago: savedAt ? agoText(savedAt, now) : null,
        };
        // A broken save still gets listed, so it can be deleted.
        if (!info) {
          saves.push({
            ...bare,
            path,
            label: name,
            adventure: "",
            title: name,
            kind: "manual",
            steps: 0,
            current: false,
          });
          continue;
        }
        const { adventure, seed, steps } = info;
        const title =
          adventures.find((item) => item.id === adventure)?.title ?? adventure;
        const kind = path.endsWith(`-${seed}-autosave.json`)
          ? "autosave"
          : "manual";
        saves.push({
          ...bare,
          path,
          label: `${title}: ${kind === "autosave" ? "Autosave" : "Saved"}, ${when ?? `run ${seed}`}, ${stepsText(steps)}`,
          adventure,
          title,
          kind,
          steps,
          current:
            kind === "autosave" &&
            current?.adventure === adventure &&
            current.seed === seed,
        });
      }
      // Oldest saves have no time, and go last.
      return saves.sort(
        (a, b) =>
          (b.savedAt ?? "").localeCompare(a.savedAt ?? "") ||
          b.path.localeCompare(a.path),
      );
    },

    deleteSave: removeSave,

    // The owner's local copy, so it is only ever read through the local content route.
    async listBooks(): Promise<readonly string[]> {
      const entries = await storage.list(LIBRARY).catch(() => []);
      return entries.flatMap(
        ({ path }) =>
          /^books\/library\/([^/]+)\/index\.json$/.exec(path)?.[1] ?? [],
      );
    },

    async openBook(
      id: string,
    ): Promise<{ title: string; sections: readonly BookSection[] }> {
      if (!BARE_NAME.test(id)) throw new Error("That isn't a book");
      const text = await storage.read(`${LIBRARY}/${id}/index.json`);
      if (text === null) throw new Error(`There is no book called ${id}`);
      const book = BookIndexSchema.parse(JSON.parse(text));
      return {
        title: book.title,
        sections: book.entries.map(({ path, file }) => ({
          heading: path[path.length - 1] ?? file,
          depth: path.length,
          file,
        })),
      };
    },

    async readSection(id: string, file: string): Promise<string> {
      if (!BARE_NAME.test(id) || !BARE_NAME.test(file)) {
        throw new Error("That isn't part of a book");
      }
      return (await storage.read(`${LIBRARY}/${id}/${file}`)) ?? "";
    },

    imageUrl(path: string): string | Promise<string | null> | null {
      return imageUrl ? imageUrl(path) : null;
    },

    // The same adventure again from its first scene, with fresh dice and the same settings.
    async restart(seed: string): Promise<void> {
      const game = active();
      const [first] = game.log;
      const settings =
        first?.input.kind === "start" ? first.input.settings : undefined;
      await this.start(game.adventure, seed, settings);
    },

    // What the adventure's system asks before a game starts, such as difficulty.
    async settingsFor(adventure: string): Promise<readonly SystemSetting[]> {
      const opened = openFresh(adventure);
      prepared = { adventure, opened };
      const { run } = await opened;
      return run.system.settings ?? [];
    },

    async start(
      adventure: string,
      seed: string,
      settings?: Readonly<Record<string, string>>,
    ): Promise<void> {
      const { registry, ui, run, root } = await open(adventure);
      const chosen = settings ? resolveSettings(run, settings) : undefined;
      const started = startRun(run, seed, chosen);
      const start = chosen
        ? { kind: "start" as const, settings: { ...chosen } }
        : { kind: "start" as const };
      const game: Current = {
        adventure,
        seed,
        root,
        registry,
        run,
        ui,
        log: [{ input: start, events: started.events }],
        ...retell(run, ui, [{ input: start, events: started.events }]),
        state: started.state,
        warnings: [],
      };
      current = game;
      await autosave(game);
      await pruneAutosaves(game);
    },

    async answer(optionId: string): Promise<void> {
      const game = active();
      const decision = pendingDecision(game.run, game.state);
      if (!decision) throw new Error("No decision is waiting");
      const input = {
        kind: "answer",
        decisionId: decision.id,
        optionId,
      } as const;
      const outcome = step(game.run, game.state, input);
      if (!outcome.ok) throw new Error(outcome.error);
      const told = narrate(
        game.run,
        game.ui,
        game.state,
        outcome.events,
        game.log.length,
      );
      game.lines.push(...told.lines);
      game.cues.push(...told.cues);
      game.rolls.push(...told.rolls);
      game.clues.push(...told.clues);
      game.state = outcome.state;
      game.log.push({ input, events: outcome.events });
      game.warnings = [];
      await autosave(game);
    },

    // Takes back the last choice by telling the log again without it. The dice live in the state,
    // so making the same choice again rolls the same numbers.
    async undo(): Promise<void> {
      const game = active();
      if (!undoAllowed(game.run, game.log)) {
        throw new Error("This difficulty doesn't allow undoing a choice");
      }
      if (game.log.length < 2) throw new Error("There is no choice to undo");
      const log = game.log.slice(0, -1);
      const told = retell(game.run, game.ui, log);
      if (told.state === null) throw new Error("The log has no run start");
      const undone: Current = {
        ...game,
        ...told,
        state: told.state,
        log,
        warnings: [],
      };
      current = undone;
      await autosave(undone);
    },

    // Each save gets its own file. Only a run's own autosave is ever overwritten.
    async save(name: string): Promise<string> {
      return write(active(), name);
    },

    async load(path: string): Promise<void> {
      const text = await storage.read(path);
      if (text === null) throw new Error(`There is no save at ${path}`);
      let header: unknown;
      try {
        header = JSON.parse(text);
      } catch {
        throw new Error("The save file isn't valid JSON");
      }
      const parsed = SaveHeaderSchema.safeParse(header);
      if (!parsed.success) throw new Error("The save file names no adventure");
      const { adventure } = parsed.data;
      const { registry, ui, run, root } = await open(adventure);
      const loaded = loadSave(text, registry, run);
      if (!loaded.ok) throw new Error(loaded.error);
      const log = loaded.save.log as readonly LogEntry[];
      const game: Current = {
        adventure,
        seed: loaded.save.seed,
        root,
        registry,
        run,
        ui,
        log: [...log],
        ...retell(run, ui, log),
        state: loaded.state,
        warnings: loaded.warnings,
      };
      current = game;
      // A save from before cards had details gets them now, so its card shows them next time.
      // The game is already loaded, so a failure here only leaves the card bare.
      try {
        // Details from before the steps were recorded are written again too.
        if ((await readSaveDetails())[path]?.steps === undefined) {
          await writeDetails(path, detailsOf(game));
        }
      } catch {
        // Tried again on the next load.
      }
    },

    view(): GameView {
      const {
        run,
        ui,
        state,
        lines,
        cues,
        rolls,
        clues,
        log: entries,
        registry,
        warnings,
        root,
      } = active();
      const currentScene = run.adventure.scenes.find(
        (item) => item.id === state.story.scene,
      );
      const decision = pendingDecision(run, state);
      const isRest = (id: string): boolean => id.startsWith(REST_OPTION_PREFIX);
      const choices = decision && {
        ...decision,
        options: decision.options.filter((option) => !isRest(option.id)),
      };
      const combat = ui.combat(state.system, run);
      const pictures: Record<string, string> = {};
      const tokens: Record<string, TokenArt> = {};
      for (const actor of combat?.combatants ?? []) {
        const art = actor.monster && monsterArt.get(artKey(actor.monster));
        if (art) pictures[actor.id] = art;
        // The first of its looks with a picture, picked by id among several, so it's the same every time.
        for (const look of actor.looks ?? []) {
          const options = tokenArt.get(artKey(look)) ?? [];
          const chosen = options[stableIndex(actor.id, options.length)];
          if (chosen) {
            tokens[actor.id] = chosen;
            break;
          }
        }
      }
      const text = currentScene ? sceneText(run, state, currentScene) : null;
      return {
        title: run.adventure.title,
        scene: text,
        sceneTitle: currentScene ? sceneTitle(currentScene) : null,
        ambience: sceneAmbience(currentScene?.ambience, text ?? ""),
        upcoming: scenesAhead(currentScene).flatMap((id) => {
          const next = run.adventure.scenes.find((item) => item.id === id);
          return next ? [sceneText(run, state, next)] : [];
        }),
        sceneArt:
          currentScene?.art && IMAGE_FILE.test(currentScene.art)
            ? `${root}/${currentScene.art}`
            : null,
        endingName:
          state.story.ended === "ending" && currentScene
            ? sceneTitle(currentScene)
            : null,
        decision,
        optionGroups: choices
          ? ui.optionGroups(choices, state.system, run)
          : [],
        card: decision
          ? (ui.card?.(decision, state.system, run) ?? null)
          : null,
        shop: decision
          ? (ui.shop?.(decision, state.system, run) ?? null)
          : null,
        rests: (decision?.options ?? [])
          .filter((option) => isRest(option.id))
          .map((option) => ({
            ...option,
            detail:
              run.system
                .rests?.(state.system)
                .find((rest) => `${REST_OPTION_PREFIX}${rest.id}` === option.id)
                ?.detail ?? null,
          })),
        monsterArt: pictures,
        tokenArt: tokens,
        adventureRoot: root,
        combat,
        // A row's own choice only on the decider's sheet while it's offered, so a companion's row can't answer for the player.
        sheets: ui.sheets(state.system, run).map((sheet) => ({
          ...sheet,
          sections: sheet.sections.map((section) => ({
            ...section,
            rows: section.rows.map(({ option, ...row }) =>
              option &&
              sheet.id === decision?.actor &&
              decision.options.some((item) => item.id === option.id)
                ? { ...row, option }
                : row,
            ),
          })),
        })),
        log: [...lines],
        cues: [...cues],
        rolls: [...rolls],
        leads: leadGroups(clues),
        steps: entries.length,
        canUndo: entries.length > 1 && undoAllowed(run, entries),
        system: ui.systemId,
        systemState: state.system,
        ended: state.story.ended,
        playerDied: ui.playerDied(state.system),
        about: ui.about,
        attributions: registry.plugins.flatMap(
          (plugin) => plugin.attribution ?? [],
        ),
        warnings,
      };
    },
  };
}

export type Game = ReturnType<typeof createGame>;
