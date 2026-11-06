import type { Decision, SystemEvent } from "../kernel/events.ts";
import type { ContentAccess } from "../kernel/system.ts";

// What a system's ui folder gives the shell: plain data, so the shell knows no rules.
// Only an optional board draws its own DOM, and app/ wires it in apart from SystemUi.
// Matched by shape, so plugins never import this file.

export interface SheetRow {
  readonly label: string;
  readonly value: string;
  readonly detail?: string; // opened on demand
  readonly note?: string; // a small line under the value, in boxes and marks
  readonly marked?: boolean; // such as proficient, in marks
  readonly meter?: number; // a share from 0 to 1, drawn as a bar in the top bar's summary
}

export interface SheetSection {
  readonly title: string;
  readonly rows: readonly SheetRow[];
  // list: label and value; boxes: tiles with a large value; marks: a dot, a value and a label.
  readonly layout?: "list" | "boxes" | "marks";
  readonly pinned?: boolean; // also shown in the side panel, not only the full sheet
}

export interface OptionView {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
}

export interface OptionGroup {
  readonly title: string | null; // null for a plain list, such as a story choice
  readonly options: readonly OptionView[];
}

export interface SheetView {
  readonly title: string;
  readonly subtitle?: string;
  readonly summary?: readonly SheetRow[]; // the few numbers kept in the top bar, such as HP
  readonly tags?: readonly string[]; // such as conditions
  readonly sections: readonly SheetSection[];
}

export interface CombatantView {
  readonly id: string;
  readonly name: string;
  readonly side: string;
  readonly active: boolean;
  readonly hp: number;
  readonly maxHp: number;
  readonly tempHp: number;
  readonly conditions: readonly string[];
  readonly concentration: string | null;
  readonly status: string | null; // such as dying or dead
  readonly monster: string | null; // the name to find its picture by
}

export interface CombatView {
  readonly round: number;
  readonly board?: unknown; // read only by the system's own board, such as where the player can move
  readonly combatants: readonly CombatantView[];
}

// What the shell gives a board: pictures, and a way to answer the pending decision.
export interface BoardHost {
  readonly imageUrl: (path: string) => string | Promise<string | null> | null;
  // Several ids answer the decisions that follow one another, such as Move and then a square.
  readonly answer: (...optionIds: readonly string[]) => void;
}

export interface BoardUpdate {
  readonly state: unknown;
  readonly decision: Decision | null; // the board may answer it, as the option list does
  readonly combat: CombatView | null;
  readonly art: Readonly<Record<string, string>>; // by combatant id
  readonly sceneArt: string | null;
  readonly cues: readonly unknown[]; // only those since the last update
}

export interface Board {
  readonly update: (update: BoardUpdate) => void;
  readonly settled?: () => Promise<void>; // once what it was given has finished playing
}

export interface SystemUi {
  readonly systemId: string;
  readonly about: string;
  readonly sheet: (state: unknown, access: ContentAccess) => SheetView | null;
  readonly combat: (state: unknown, access: ContentAccess) => CombatView | null;
  // Called with the state from just before the event, so a monster that leaves with it still has a name.
  readonly describe: (
    event: SystemEvent,
    state: unknown,
    access: ContentAccess,
  ) => string | null;
  // Who the event belongs to, for a log line whose text doesn't say.
  readonly actorOf: (event: SystemEvent, state: unknown) => string | null;
  readonly optionGroups: (
    decision: Decision,
    state: unknown,
    access: ContentAccess,
  ) => readonly OptionGroup[];
  readonly playerDied: (state: unknown) => boolean;
  // Turns an event into plain data for the board to animate, given the state either side of it.
  readonly cue?: (
    event: SystemEvent,
    before: unknown,
    after: unknown,
    access: ContentAccess,
  ) => unknown; // null for an event with nothing to show
}
