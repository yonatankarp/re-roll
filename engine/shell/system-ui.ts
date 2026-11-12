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
  // A choice of the pending decision this row can make, such as equipping an item. With a hint, it's
  // shown disabled while not offered, and the hint says when it will be, such as "Change gear during a rest".
  readonly option?: {
    readonly id: string;
    readonly label: string;
    readonly hint?: string;
  };
}

// A short moment shown above a decision's choices, such as treasure just found.
export interface DecisionCard {
  readonly title: string;
  readonly lines: readonly string[];
  readonly icon?: string; // a glyph beside the title, such as a coin
  readonly footer?: string; // a closing line, such as the purse after the find
}

// One thing at a merchant's: what it is, what it costs, and the choice that trades it.
export interface ShopCard {
  readonly item: string;
  readonly name: string;
  readonly summary: string; // a short mechanical line, such as "1d8 slashing, Versatile"
  readonly price: string;
  readonly note?: string; // such as "2 left" or "Not enough gold"
  readonly option: string | null; // null while it can't be traded
}

// A merchant's screen in place of the choices, with Buy and Sell tabs over one decision.
export interface ShopView {
  readonly merchant: string;
  readonly purse: string;
  readonly buy: readonly ShopCard[];
  readonly sell: readonly ShopCard[];
  readonly leave: string; // the option that ends the visit
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
  readonly id: string; // the actor it shows
  readonly title: string;
  readonly subtitle?: string;
  readonly level?: number; // shown on save cards
  readonly kind?: string; // what the character is, such as "Human Wizard", shown on save cards
  // The few numbers kept in the top bar, such as HP. The first also goes on save cards.
  readonly summary?: readonly SheetRow[];
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
  readonly looks?: readonly string[]; // names to find its token picture by, best first
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
  readonly sound?: () => boolean; // whether the player has sound on
  readonly volume?: () => number; // the player's master volume, 0 to 1
}

export interface BoardUpdate {
  readonly state: unknown;
  readonly decision: Decision | null; // the board may answer it, as the option list does
  readonly combat: CombatView | null;
  readonly art: Readonly<Record<string, string>>; // by combatant id
  readonly tokens: Readonly<
    Record<string, { readonly path: string; readonly face?: unknown }>
  >; // by combatant id, with where the face is
  readonly assetRoot: string; // where the adventure's own pictures are, such as a battle map
  readonly sceneArt: string | null;
  readonly cues: readonly unknown[]; // only those since the last update
}

export interface Board {
  readonly update: (update: BoardUpdate) => void;
  readonly settled?: () => Promise<void>; // once what it was given has finished playing
}

// One die roll for the roll history, such as "Sera · Longsword → Goblin · 14 + 5 = 19 vs AC 15 ✓".
export interface RollView {
  readonly actor: string; // who rolled, or for damage who took it, by name
  readonly label: string; // what was rolled
  readonly math: string; // the die, what was added, and what it had to reach
  readonly success: boolean | null; // null when it wasn't against anything, such as damage
}

export interface SystemUi {
  readonly systemId: string;
  readonly about: string;
  // The player's first, then the rest of the party; empty until the player has a character.
  readonly sheets: (
    state: unknown,
    access: ContentAccess,
  ) => readonly SheetView[];
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
  readonly card?: (
    decision: Decision,
    state: unknown,
    access: ContentAccess,
  ) => DecisionCard | null;
  // A merchant's screen for the decision, shown in place of its choices.
  readonly shop?: (
    decision: Decision,
    state: unknown,
    access: ContentAccess,
  ) => ShopView | null;
  readonly playerDied: (state: unknown) => boolean;
  // Turns an event into plain data for the board to animate, given the state either side of it.
  readonly cue?: (
    event: SystemEvent,
    before: unknown,
    after: unknown,
    access: ContentAccess,
  ) => unknown; // null for an event with nothing to show
  // The event as a roll for the history, given the state from just before it; null for one that rolled nothing.
  readonly roll?: (
    event: SystemEvent,
    state: unknown,
    access: ContentAccess,
  ) => RollView | null;
}
