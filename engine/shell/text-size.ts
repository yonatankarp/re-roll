import { button, el } from "./dom.ts";
import { MOD } from "./keys.ts";

// The player's text size, a share of the root font that every rem in the page follows, kept in the
// page's localStorage. Its buttons sit in the top bar on every screen, and Ctrl or ⌘ with = or +, - and
// 0 work too, by key position so other layouts have them.
export const TEXT_SIZES = [100, 115, 130, 150, 175] as const;
const KEY = "re-roll:text-size";

function stored(): number {
  try {
    const at = TEXT_SIZES.indexOf(
      Number(localStorage.getItem(KEY)) as (typeof TEXT_SIZES)[number],
    );
    return Math.max(0, at);
  } catch {
    return 0; // storage can be blocked
  }
}

export function textSizeControls(): HTMLElement {
  let at = stored();
  const smaller = button("A−", () => {
    set(at - 1);
  });
  const larger = button("A+", () => {
    set(at + 1);
  });
  smaller.setAttribute("aria-label", "A− Smaller text"); // starting with what it shows, for voice control
  larger.setAttribute("aria-label", "A+ Larger text");
  smaller.setAttribute("aria-keyshortcuts", "Control+- Meta+-");
  larger.setAttribute("aria-keyshortcuts", "Control+= Meta+=");
  smaller.title = `Smaller text (${MOD}−)`;
  larger.title = `Larger text (${MOD}+)`;
  const apply = (): void => {
    const size = TEXT_SIZES[at] ?? 100;
    // The page's base is 17px, 106.25% of the usual 16px, and follows a larger browser default too.
    document.documentElement.style.setProperty(
      "font-size",
      `${String(size * 1.0625)}%`,
    );
    // aria-disabled, not disabled, so focus stays on a button pressed to its end.
    smaller.setAttribute("aria-disabled", String(at === 0));
    larger.setAttribute("aria-disabled", String(at === TEXT_SIZES.length - 1));
  };
  const set = (next: number): void => {
    at = Math.min(TEXT_SIZES.length - 1, Math.max(0, next));
    apply();
    try {
      localStorage.setItem(KEY, String(TEXT_SIZES[at]));
    } catch {
      // the size holds until the page closes
    }
  };
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const step = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1 }[
      event.code
    ];
    if (step === undefined && event.code !== "Digit0") return;
    event.preventDefault();
    set(step === undefined ? 0 : at + step);
  });
  apply();
  const group = el("div", { class: "text-size" }, smaller, larger);
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Text size");
  return group;
}
