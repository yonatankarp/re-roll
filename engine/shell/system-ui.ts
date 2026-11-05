import type { Decision, SystemEvent } from "../kernel/events.ts";
import type { ContentAccess } from "../kernel/system.ts";

// What a system's ui folder gives the shell: plain data, so the shell knows no rules
// and the system needs no DOM code. Matched by shape, so plugins never import this file.

export interface SheetRow {
  readonly label: string;
  readonly value: string;
  readonly detail?: string; // opened on demand
  readonly note?: string; // a small line under the value, in boxes and marks
  readonly marked?: boolean; // such as proficient, in marks
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
  readonly combatants: readonly CombatantView[];
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
}
