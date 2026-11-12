import { PLAYER_ACTOR } from "#sdk";
import { parseOption } from "../core/combat/ids.ts";
import { NS } from "../core/state.ts";
import type { AreaTargeting } from "../core/targeting.ts";
import type {
  BoardExtra,
  BoardHost,
  BoardUpdate,
  Option,
} from "./board-data.ts";
import type { DndCue } from "./cues.ts";

// What every part of the board shares: its elements, which mountDndBoard makes once, and the state they
// all read and write. State lives only here, so no part keeps a copy that could fall out of step.

export interface Token {
  readonly node: HTMLElement;
  readonly disc: HTMLElement;
  readonly tip: HTMLElement; // the name, HP and conditions, shown on hover or under the cursor
  readonly shield: HTMLElement; // the cover it has against the player, shown on hover while the player can attack it
  readonly name: string;
  notes: readonly string[]; // status and conditions
  side: string;
  x: number | null;
  y: number | null;
  hp: number;
  maxHp: number;
  art: string | null;
}

export interface BoardDom {
  readonly slot: HTMLElement;
  readonly host: BoardHost;
  readonly board: HTMLElement;
  readonly said: HTMLElement; // read out by screen readers, not shown
  readonly cursorBox: HTMLElement;
  readonly field: HTMLElement; // a parchment mat until a picture loads
  readonly banner: HTMLElement;
  readonly hint: HTMLElement;
  readonly caption: HTMLElement; // who is doing what, during an attack
  readonly cells: HTMLElement;
  readonly route: SVGSVGElement;
  readonly line: SVGPolylineElement;
  readonly reachZone: HTMLElement;
  readonly blast: HTMLElement;
  readonly ground: HTMLElement; // difficult terrain, cover and shadow, faint under everything
  readonly routeCost: HTMLElement;
  readonly menu: HTMLElement;
  readonly pickBar: HTMLElement; // while choosing targets or aiming an area: how many are chosen, Cast and Back
}

export interface BoardState {
  cursor: { x: number; y: number } | null;
  // The first player turn of the first fight says how the map works, until the player uses it.
  howTo: "unseen" | "showing" | "done";
  decisionSeen: string | null;
  cursorHome: boolean; // the cursor goes back to the player once the board settles
  groundShown: string;
  readonly tokens: Map<string, Token>;
  readonly queue: DndCue[];
  latest: BoardUpdate | null;
  playing: boolean;
  skipping: boolean;
  wake: (() => void) | null;
  sceneArt: string | null;
  grid: { readonly width: number; readonly height: number } | null;
  dragged: boolean;
  // The player throws their own dice: the die waits for a click, Enter or Space.
  throwNow: (() => void) | null;
  // The damage dice the last attack rolls, kept until its damage arrives.
  pendingDamage: {
    readonly target: string;
    readonly dice: string;
    readonly mine: boolean;
  } | null;
  readonly waiting: (() => void)[];
}

export type BoardContext = BoardDom & BoardState;

export function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function extraOf(update: BoardUpdate | null): BoardExtra {
  return update?.combat?.board ?? {};
}

function reduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function fast(ctx: BoardContext): boolean {
  return ctx.skipping || reduced();
}

export function wait(ctx: BoardContext, ms: number): Promise<void> {
  return fast(ctx)
    ? Promise.resolve()
    : new Promise((resolve) => {
        const done = (): void => {
          ctx.wake = null;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, ms);
        ctx.wake = done;
      });
}

export function animate(
  ctx: BoardContext,
  node: Element,
  frames: Keyframe[],
  options: KeyframeAnimationOptions,
): void {
  if (!fast(ctx)) node.animate(frames, options);
}

export function showCaption(ctx: BoardContext, text: string): void {
  ctx.caption.textContent = text;
  ctx.caption.classList.toggle("shown", text !== "");
}

export function playerOptions(ctx: BoardContext): readonly Option[] {
  return !ctx.playing && ctx.latest?.decision?.actor === PLAYER_ACTOR
    ? ctx.latest.decision.options
    : [];
}

// The follow-up the player is answering: aiming an area (with its shape), or choosing targets.
export function pendingId(ctx: BoardContext): string {
  return playerOptions(ctx).length > 0 ? (ctx.latest?.decision?.id ?? "") : "";
}

export function aiming(ctx: BoardContext): AreaTargeting | null {
  const id = pendingId(ctx);
  if (!id.startsWith(`${NS}:aim:`)) return null;
  return extraOf(ctx.latest).shapes?.[parseOption(id).at(-1) ?? ""] ?? null;
}

export function picking(ctx: BoardContext): boolean {
  return pendingId(ctx).startsWith(`${NS}:targets:`);
}
