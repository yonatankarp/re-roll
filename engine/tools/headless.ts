import { randomUUID } from "node:crypto";
import type { Game, GameView, LogLine, SaveChoice } from "../shell/session.ts";
import type { CombatView, DecisionCard } from "../shell/system-ui.ts";

// Plays through the same game layer the page uses, with no DOM, so tests and agents can do what a player does.
// What counts as on screen mirrors engine/shell/shell.ts: the option list, the campfire's rests, and the
// buttons on the sheet of whoever the decision is for.

export const SCREEN_VERSION = 1;

export interface Choice {
  readonly n: number; // 1-based, as numbered on this screen
  readonly id: string;
  readonly label: string;
  readonly where: "list" | "rest" | "sheet";
  readonly group: string | null; // the list's tab, such as Attacks
  readonly detail: string | null;
}

export interface Screen {
  readonly version: typeof SCREEN_VERSION;
  readonly title: string;
  readonly scene: string | null;
  readonly lines: readonly LogLine[]; // only those since the last action
  readonly card: DecisionCard | null;
  readonly decision: string | null;
  readonly actor: string | null;
  readonly prompt: string | null;
  readonly choices: readonly Choice[];
  readonly combat: CombatView | null; // board holds the system's map data, such as squares to move to
  readonly party: readonly {
    readonly id: string;
    readonly title: string;
    readonly subtitle: string | null;
    readonly summary: readonly { label: string; value: string }[];
    readonly tags: readonly string[];
  }[];
  readonly ended: GameView["ended"];
  readonly endingName: string | null;
  readonly playerDied: boolean;
  readonly warnings: readonly string[];
  readonly problems: readonly string[]; // stuck states, which a player couldn't get past
}

export function choicesOf(view: GameView): Choice[] {
  const { decision } = view;
  if (!decision) return [];
  const found: Omit<Choice, "n">[] = [
    ...view.optionGroups.flatMap((group) =>
      group.options.map((option) => ({
        id: option.id,
        label: option.label,
        where: "list" as const,
        group: group.title,
        detail: option.detail,
      })),
    ),
    ...view.rests.map((option) => ({
      id: option.id,
      label: option.label,
      where: "rest" as const,
      group: null,
      detail: null,
    })),
    // The view keeps a row's choice only on the decider's sheet while it's offered, as the shell shows it.
    ...view.sheets
      .flatMap((sheet) => sheet.sections.flatMap((section) => section.rows))
      .flatMap(({ option, label, detail }) =>
        option
          ? [
              {
                id: option.id,
                label: `${option.label} ${label}`,
                where: "sheet" as const,
                group: null,
                detail: detail ?? null,
              },
            ]
          : [],
      ),
  ];
  return found.map((choice, index) => ({ n: index + 1, ...choice }));
}

// What would leave a player unable to go on, or offer something the game can't take.
export function problemsOf(view: GameView): string[] {
  const { decision } = view;
  if (!decision) {
    return view.ended === null
      ? ["Nothing to decide, but the story hasn't ended"]
      : [];
  }
  const choices = choicesOf(view);
  const shown = new Set(choices.map((choice) => choice.id));
  const offered = new Set(decision.options.map((option) => option.id));
  const problems: string[] = [];
  if (choices.length === 0) problems.push(`${decision.id} shows no choice`);
  else if (choices.every((choice) => choice.where === "rest")) {
    problems.push(`${decision.id} shows only rests, which come back to it`);
  }
  for (const id of shown) {
    if (!offered.has(id))
      problems.push(`${decision.id} shows ${id}, which it doesn't offer`);
  }
  for (const id of offered) {
    if (!shown.has(id))
      problems.push(`${decision.id} offers ${id}, which nothing shows`);
  }
  return problems;
}

export function screenOf(view: GameView, since: number): Screen {
  return {
    version: SCREEN_VERSION,
    title: view.title,
    scene: view.scene,
    lines: view.log.slice(since),
    card: view.card,
    decision: view.decision?.id ?? null,
    actor: view.decision?.actor ?? null,
    prompt: view.decision?.prompt ?? null,
    choices: choicesOf(view),
    combat: view.combat,
    party: view.sheets.map((sheet) => ({
      id: sheet.id,
      title: sheet.title,
      subtitle: sheet.subtitle ?? null,
      summary: (sheet.summary ?? []).map(({ label, value }) => ({
        label,
        value,
      })),
      tags: sheet.tags ?? [],
    })),
    ended: view.ended,
    endingName: view.endingName,
    playerDied: view.playerDied,
    warnings: view.warnings,
    problems: problemsOf(view),
  };
}

// A screen as plain text, for people at a terminal.
export function screenText(screen: Screen): string {
  const out: string[] = [];
  for (const line of screen.lines) {
    out.push(line.kind === "scene" ? `\n${line.text}\n` : `  ${line.text}`);
  }
  if (screen.card) {
    out.push(
      `\n[${screen.card.title}]`,
      ...screen.card.lines.map((line) => `  ${line}`),
    );
  }
  if (screen.combat) {
    out.push(`\nRound ${String(screen.combat.round)}`);
    for (const actor of screen.combat.combatants) {
      out.push(
        `  ${actor.active ? ">" : " "} ${actor.name} (${actor.side}) ${String(actor.hp)}/${String(actor.maxHp)} HP${actor.status ? `, ${actor.status}` : ""}${actor.conditions.length > 0 ? `, ${actor.conditions.join(", ")}` : ""}`,
      );
    }
  }
  const [player] = screen.party;
  if (player && player.summary.length > 0) {
    out.push(
      `\n${player.title}: ${player.summary.map((row) => `${row.label} ${row.value}`).join(", ")}`,
    );
  }
  if (screen.ended) {
    out.push(
      `\nThe end${screen.endingName ? `: ${screen.endingName}` : ""} (${screen.ended}).`,
    );
  }
  // A story choice's prompt is its scene's text, already shown when the scene was entered.
  const told = screen.lines.some(
    (line) => line.kind === "scene" && line.text === screen.prompt,
  );
  if (screen.prompt && !told) out.push(`\n${screen.prompt}`);
  let group: string | null = null;
  for (const choice of screen.choices) {
    const heading =
      choice.where === "list"
        ? choice.group
        : choice.where === "rest"
          ? "Campfire"
          : "Character sheet";
    if (heading !== group && heading !== null) out.push(`  ${heading}:`);
    group = heading;
    out.push(`  ${String(choice.n)}. ${choice.label}`);
  }
  for (const warning of screen.warnings) out.push(`Warning: ${warning}`);
  for (const problem of screen.problems) out.push(`Stuck: ${problem}`);
  return out.join("\n");
}

export type Driver = ReturnType<typeof createDriver>;

export function createDriver(game: Game) {
  let since = 0; // log lines already shown
  let seed = "";

  const view = (): GameView => game.view();
  const mark = (): void => {
    since = view().log.length;
  };

  // A number is its place on this screen. A string is its id, or else its label (ignoring case).
  // Never a string as a number, since story options have ids such as "0" and "1".
  const find = (ref: string | number): Choice => {
    const choices = choicesOf(view());
    if (typeof ref === "number") {
      const byNumber = choices.find((c) => c.n === ref);
      if (byNumber) return byNumber;
      throw new Error(`There is no choice ${String(ref)} on screen`);
    }
    const byId = choices.find((c) => c.id === ref);
    if (byId) return byId;
    const text = ref.trim().toLowerCase();
    const byLabel = choices.filter((c) => c.label.toLowerCase() === text);
    if (new Set(byLabel.map((c) => c.id)).size > 1) {
      throw new Error(
        `"${ref}" matches more than one choice; use its number or id`,
      );
    }
    const [label] = byLabel;
    if (label) return label;
    throw new Error(`"${ref}" isn't one of the choices on screen`);
  };

  const saveRef = async (ref: string | number): Promise<SaveChoice> => {
    const saves = await game.listSaves();
    const save =
      typeof ref === "number"
        ? saves[ref - 1]
        : saves.find((item) => item.path === ref);
    if (!save) throw new Error(`There is no save ${String(ref)}`);
    return save;
  };

  return {
    game,
    view,
    screen: (): Screen => screenOf(view(), since),
    listAdventures: () => game.listAdventures(),
    settingsFor: (adventure: string) => game.settingsFor(adventure),
    seed: () => seed,

    async start(
      adventure: string,
      options: {
        readonly seed?: string;
        readonly settings?: Readonly<Record<string, string>>;
      } = {},
    ): Promise<void> {
      seed = options.seed ?? randomUUID().slice(0, 8);
      // Asked first as the setup screen does, so an unknown setting fails here rather than later.
      await game.settingsFor(adventure);
      await game.start(adventure, seed, options.settings);
      since = 0;
    },

    // One on-screen choice: what clicking it does.
    async choose(ref: string | number): Promise<Choice> {
      const choice = find(ref);
      mark();
      await game.answer(choice.id);
      return choice;
    },

    // Option ids answered one after another, as the map sends them, such as "move" then "3,4".
    // Each must be on screen when its turn comes, so a map shortcut can't do what the page can't.
    async act(...ids: readonly string[]): Promise<void> {
      mark();
      for (const id of ids) {
        if (!choicesOf(view()).some((choice) => choice.id === id)) {
          throw new Error(`"${id}" isn't one of the choices on screen`);
        }
        await game.answer(id);
      }
    },

    async save(name: string): Promise<string> {
      return game.save(name);
    },
    saves: () => game.listSaves(),
    // By its number in the save list (newest first), or by its path.
    async load(ref: string | number): Promise<SaveChoice> {
      const save = await saveRef(ref);
      await game.load(save.path);
      since = view().log.length;
      return save;
    },
    async deleteSave(ref: string | number): Promise<SaveChoice> {
      const save = await saveRef(ref);
      await game.deleteSave(save.path);
      return save;
    },
    async restart(again: string = randomUUID().slice(0, 8)): Promise<void> {
      await game.restart(again);
      seed = again;
      since = 0;
    },
  };
}
