import type { Terrain } from "../core/state.ts";
import type { AreaTargeting } from "../core/targeting.ts";
import type { DndCue } from "./cues.ts";

// What the board is given. These match engine/shell's types by shape, since plugins never import it.

export interface Combatant {
  readonly id: string;
  readonly name: string;
  readonly side: string;
  readonly active: boolean;
  readonly hp: number;
  readonly maxHp: number;
  readonly conditions: readonly string[];
  readonly status: string | null;
}

export interface Option {
  readonly id: string;
  readonly label: string;
}

export interface BoardUpdate {
  readonly state: unknown;
  readonly decision: {
    readonly id: string;
    readonly actor: string;
    readonly options: readonly Option[];
  } | null;
  readonly combat: {
    readonly combatants: readonly Combatant[];
    readonly board?: BoardExtra; // written by this plugin's combat view in ui/index.ts
  } | null;
  readonly art: Readonly<Record<string, string>>;
  readonly tokens: Readonly<Record<string, TokenArt>>;
  readonly assetRoot: string;
  readonly sceneArt: string | null;
  readonly cues: readonly DndCue[]; // written by dndCue in ui/cues.ts
}

// The update as the shell types it: it passes the combat view's board data and the cues on unread.
export type ShellUpdate = Omit<BoardUpdate, "combat" | "cues"> & {
  readonly combat: {
    readonly combatants: readonly Combatant[];
    readonly board?: unknown;
  } | null;
  readonly cues: readonly unknown[];
};

export interface Face {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface TokenArt {
  readonly path: string;
  readonly face?: unknown; // a Face, from the picture index
}

export interface FightMap {
  readonly image: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface BoardHost {
  readonly imageUrl: (path: string) => string | Promise<string | null> | null;
  readonly answer: (...optionIds: readonly string[]) => void;
  readonly sound?: () => boolean;
  readonly volume?: () => number;
}

export interface Move {
  readonly x: number;
  readonly y: number;
  readonly feet: number;
  readonly path: readonly (readonly [number, number])[];
  readonly provokes: number; // how many enemies get an Opportunity Attack
}

export interface BoardExtra {
  readonly moves?: readonly Move[];
  readonly reach?: Readonly<Record<string, number>>; // melee reach in feet, by creature
  readonly map?: FightMap | null; // the book's battle map, when the encounter has one
  readonly shapes?: Readonly<Record<string, AreaTargeting>>; // the player's area actions, by id
  readonly cover?: Readonly<Record<string, number>>; // +2 or +5 against the player, by creature
  readonly terrain?: Terrain | null; // the battle map's ground, cover and light
}
