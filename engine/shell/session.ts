import { parse } from "yaml";
import { z } from "zod";
import {
  type Decision,
  type GameEvent,
  type GameState,
  isNamespacedEvent,
  isNarrativeEvent,
} from "../kernel/events.ts";
import { formatIssue } from "../kernel/issues.ts";
import { type Registry, loadRun, scanPlugins } from "../kernel/loader.ts";
import { type LogEntry, createSave, loadSave } from "../kernel/save.ts";
import type { Storage } from "../kernel/storage.ts";
import { sceneText } from "../story/runtime.ts";
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
  OptionGroup,
  SheetView,
  SystemUi,
} from "./system-ui.ts";

// Everything the page does to the game, with no DOM, so tests can play through the same code.

const SAVES = "saves";
// Saves have a strict format with no clock in it, so the times live beside them.
const SAVE_TIMES = `${SAVES}/times`;
// What each save's card shows. Kept apart from the times, which older builds still read as plain strings.
const SAVE_DETAILS = `${SAVES}/details`;
const ASSETS = "private/assets";
const LIBRARY = "private/library";
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const BARE_NAME = /^[^/\\]+$/;

export interface LogLine {
  readonly kind: "scene" | "event";
  readonly text: string;
  readonly actor?: string | null;
}

export interface GameView {
  readonly title: string;
  readonly scene: string | null;
  readonly sceneArt: string | null; // a content path, for imageUrl
  readonly endingName: string | null;
  readonly optionGroups: readonly OptionGroup[];
  readonly monsterArt: Readonly<Record<string, string>>; // by combatant id
  readonly tokenArt: Readonly<Record<string, TokenArt>>; // by combatant id, with its face
  readonly adventureRoot: string; // where the adventure's own pictures are
  readonly decision: Decision | null;
  readonly combat: CombatView | null;
  readonly sheets: readonly SheetView[]; // the player's first
  readonly log: readonly LogLine[];
  // Plain data for the system's encounter board to animate, in order, from the start of the run.
  readonly cues: readonly unknown[];
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
}

export interface SaveChoice {
  readonly path: string;
  readonly label: string;
  readonly adventure: string;
  readonly savedAt: string | null;
  readonly title: string;
  readonly kind: "autosave" | "manual";
  readonly when: string | null; // savedAt, for people
  readonly steps: number;
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

function endingName(id: string): string {
  const words = id.replace(/-/g, " ");
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

function narrate(
  run: RunContext,
  ui: SystemUi,
  from: GameState | null,
  events: readonly GameEvent[],
): {
  readonly state: GameState | null;
  readonly lines: readonly LogLine[];
  readonly cues: readonly unknown[];
} {
  let state = from;
  const lines: LogLine[] = [];
  const cues: unknown[] = [];
  for (const event of events) {
    if (event.kind === "runStarted") {
      state = event.state;
      continue;
    }
    if (state === null) throw new Error("The log has no run start");
    if (isNarrativeEvent(event) || isNamespacedEvent(event)) {
      const text = ui.describe(event, state.system, run);
      if (text !== null) {
        lines.push({
          kind: "event",
          text,
          actor: ui.actorOf(event, state.system),
        });
      }
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
  return { state, lines, cues };
}

function narrated(told: ReturnType<typeof narrate>): {
  readonly lines: LogLine[];
  readonly cues: unknown[];
} {
  return { lines: [...told.lines], cues: [...told.cues] };
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

  // Art is optional and still being extracted, so a bad index only loses its pictures.
  const loadArt = async (): Promise<void> => {
    const found = new Map<string, string>();
    const tokens = new Map<string, TokenArt[]>();
    try {
      const entries = await storage.list(ASSETS);
      for (const { path } of entries) {
        if (!/^private\/assets\/[^/]+\/index\.json$/.test(path)) continue;
        const folder = path.slice(0, -"/index.json".length);
        const parsed = ArtIndexSchema.safeParse(
          JSON.parse((await storage.read(path)) ?? "null"),
        );
        for (const { file, monster, subjects, face } of parsed.data ?? []) {
          if (!BARE_NAME.test(file)) continue;
          const art = { path: `${folder}/${file}`, ...(face ? { face } : {}) };
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
  };

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

  const openFresh = async (adventure: string) => {
    const catalog = await scanPlugins(storage, roots);
    const loaded = await loadRun(storage, catalog, systems, [adventure]);
    if (!loaded.ok) {
      throw new Error(loaded.issues.map(formatIssue).join("\n"));
    }
    const { registry } = loaded;
    const ui = uis.find((item) => item.systemId === registry.system.id);
    if (!ui) throw new Error(`No UI for the ${registry.system.id} system`);
    await loadArt();
    return {
      registry,
      ui,
      root: catalog.plugins.get(adventure)?.root ?? "",
      run: createRunContext(registry, adventure),
    };
  };

  const active = (): Current => {
    if (!current) throw new Error("No game is running");
    return current;
  };

  // What a save's card shows, read from the game as it stands.
  const detailsOf = ({ run, ui, state, root, log }: Current): SaveDetails => {
    const scene = run.adventure.scenes.find(
      (item) => item.id === state.story.scene,
    );
    const [first] = log;
    const chosen =
      first?.input.kind === "start" ? (first.input.settings ?? {}) : {};
    return {
      scene: scene ? endingName(scene.id) : null,
      level: ui.sheets(state.system, run)[0]?.level ?? null,
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

  const write = async (game: Current, name: string): Promise<string> => {
    const path = `${SAVES}/${game.adventure}-${name}.json`;
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

  // One file per run, so starting again never overwrites an earlier run.
  // A failed autosave must not stop play, so the player is told and carries on.
  const autosave = async (game: Current): Promise<void> => {
    try {
      await write(game, `${game.seed}-autosave`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      game.warnings = [`Autosave failed: ${reason}`];
    }
  };

  return {
    async listAdventures(): Promise<readonly AdventureChoice[]> {
      const catalog = await scanPlugins(storage, roots);
      const adventures: AdventureChoice[] = [];
      for (const plugin of catalog.plugins.values()) {
        if (plugin.manifest.kind !== "adventure") continue;
        const text = await storage.read(`${plugin.root}/adventure.yaml`);
        const info = AdventureInfoSchema.safeParse(parse(text ?? ""));
        adventures.push({
          id: plugin.manifest.id,
          title: info.success ? info.data.title : plugin.manifest.id,
          source: plugin.manifest.distribution,
          levels: info.data?.levels ?? null,
        });
      }
      return adventures.sort((a, b) => (a.title < b.title ? -1 : 1));
    },

    async listSaves(): Promise<readonly SaveChoice[]> {
      const entries = await storage.list(SAVES);
      const times = await readSaveTimes();
      const allDetails = await readSaveDetails();
      const adventures = await this.listAdventures();
      const saves: SaveChoice[] = [];
      for (const { path } of entries) {
        if (!path.endsWith(".json")) continue;
        const name = path.slice(SAVES.length + 1, -".json".length);
        let info: z.infer<typeof SaveInfoSchema> | undefined;
        try {
          info = SaveInfoSchema.safeParse(
            JSON.parse((await storage.read(path)) ?? "null"),
          ).data;
        } catch {
          info = undefined;
        }
        const details = allDetails[path];
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
          savedAt,
          when,
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
          });
          continue;
        }
        const { adventure, seed, log } = info;
        const title =
          adventures.find((item) => item.id === adventure)?.title ?? adventure;
        const kind = path.endsWith(`-${seed}-autosave.json`)
          ? "autosave"
          : "manual";
        saves.push({
          ...bare,
          path,
          label: `${title}: ${kind === "autosave" ? "Autosave" : "Saved"}, ${when ?? `run ${seed}`}, ${String(log.length)} steps`,
          adventure,
          title,
          kind,
          steps: log.length,
        });
      }
      // Oldest saves have no time, and go last.
      return saves.sort(
        (a, b) =>
          (b.savedAt ?? "").localeCompare(a.savedAt ?? "") ||
          b.path.localeCompare(a.path),
      );
    },

    async deleteSave(path: string): Promise<void> {
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
    },

    // The owner's local copy, so it is only ever read through the local content route.
    async listBooks(): Promise<readonly string[]> {
      const entries = await storage.list(LIBRARY).catch(() => []);
      return entries.flatMap(
        ({ path }) =>
          /^private\/library\/([^/]+)\/index\.json$/.exec(path)?.[1] ?? [],
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
        state: started.state,
        log: [{ input: start, events: started.events }],
        ...narrated(narrate(run, ui, null, started.events)),
        warnings: [],
      };
      current = game;
      await autosave(game);
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
      const told = narrate(game.run, game.ui, game.state, outcome.events);
      game.lines.push(...told.lines);
      game.cues.push(...told.cues);
      game.state = outcome.state;
      game.log.push({ input, events: outcome.events });
      game.warnings = [];
      await autosave(game);
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
        state: loaded.state,
        log: [...log],
        ...narrated(
          narrate(
            run,
            ui,
            null,
            log.flatMap((entry) => entry.events),
          ),
        ),
        warnings: loaded.warnings,
      };
      current = game;
      // A save from before cards had details gets them now, so its card shows them next time.
      // The game is already loaded, so a failure here only leaves the card bare.
      try {
        if ((await readSaveDetails())[path] === undefined) {
          await writeDetails(path, detailsOf(game));
        }
      } catch {
        // Tried again on the next load.
      }
    },

    view(): GameView {
      const { run, ui, state, lines, cues, registry, warnings, root } =
        active();
      const currentScene = run.adventure.scenes.find(
        (item) => item.id === state.story.scene,
      );
      const decision = pendingDecision(run, state);
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
      return {
        title: run.adventure.title,
        scene: currentScene ? sceneText(run, state, currentScene) : null,
        sceneArt:
          currentScene?.art && IMAGE_FILE.test(currentScene.art)
            ? `${root}/${currentScene.art}`
            : null,
        endingName:
          state.story.ended === "ending" && currentScene
            ? endingName(currentScene.id)
            : null,
        decision,
        optionGroups: decision
          ? ui.optionGroups(decision, state.system, run)
          : [],
        monsterArt: pictures,
        tokenArt: tokens,
        adventureRoot: root,
        combat,
        sheets: ui.sheets(state.system, run),
        log: [...lines],
        cues: [...cues],
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
