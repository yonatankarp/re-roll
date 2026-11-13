import type { PageBoard } from "./context.ts";
import type { ShellContext } from "./context.ts";
import type { journalTabs, rollsWhy } from "./journal-tabs.ts";
import type { shopPanel } from "./shop.ts";
import type { soundControls } from "./sound-panel.ts";

// What the game screen's parts share: the elements showGame makes once, the state each redraw reads and
// writes, and its redraw. The parts are game-options.ts, game-journal.ts, game-sheet.ts and ending.ts.
export interface GamePage {
  readonly ctx: ShellContext;
  readonly sound: ReturnType<typeof soundControls>;
  readonly ending: HTMLElement;
  // The newest lines of the journal, under the board, read out as they change.
  readonly ticker: HTMLElement;
  readonly levelUp: HTMLElement; // the player's level-up, set apart from the ticker as the books set off a callout
  readonly prompt: HTMLElement;
  readonly card: HTMLElement;
  readonly options: HTMLElement;
  readonly log: HTMLElement;
  readonly about: HTMLElement;
  readonly fullSheet: HTMLElement;
  // One panel per party member, kept between redraws so each keeps its own open sections.
  readonly sheetPanels: Map<string, HTMLElement>;
  readonly sheetTabs: HTMLElement;
  readonly journalTabsView: ReturnType<typeof journalTabs>;
  readonly why: ReturnType<typeof rollsWhy>;
  readonly hud: HTMLElement;
  readonly stage: HTMLElement;
  readonly shop: ReturnType<typeof shopPanel>;
  readonly draw: () => void;
  readonly flashSaved: () => void;
  readonly firstFocus: () => HTMLElement;
  readonly restart: () => void;
  board: PageBoard | null;
  decisionShown: string | null;
  openGroup: string | null;
  showAll: boolean;
  sheetShown: string | null; // null for the player's
  quickQuestion: boolean; // a plain list of choices in a fight, such as a reaction, not a whole turn
  hudShown: number; // the latest HUD update, so a stale one never lands
  linesShown: number;
  tickerShown: number; // the latest ticker update, so a stale one never lands
  choiceShown: number; // the same, for revealing the choices
}
