import { type GameView } from "./session.ts";
import type { OptionView } from "./system-ui.ts";
import type { GamePage } from "./game-page.ts";
import { button, el, picture } from "./dom.ts";

export function endingOf(view: GameView): {
  readonly title: string;
  readonly text: string;
} | null {
  switch (view.ended) {
    case null:
      return null;
    case "ending":
      // The ending scene's own text is already on the page above this.
      return view.scene
        ? { title: view.endingName ?? "The end", text: "" }
        : {
            title: "Adventure complete",
            text: "You have reached the end of this story.",
          };
    case "deadEnd":
      return {
        title: "A dead end",
        text: "The story has no choices left to offer you.",
      };
    case "defeat":
      return view.playerDied
        ? {
            title: "You have died",
            text: "Your story ends here, whatever became of your companions.",
          }
        : {
            title: "Your party has fallen",
            text: "Nobody is left standing to carry on.",
          };
  }
}

// The end of the run, once it has one: what happened, and Play again.
export function drawEnding(page: GamePage, view: GameView): void {
  const end = endingOf(view);
  const endTitle = el("h3", { text: end?.title ?? "" });
  endTitle.tabIndex = -1;
  const again = button("Play again", page.restart);
  again.className = "begin";
  const tally = (moment: string, one: string, many: string): string[] => {
    const count = view.moments.filter((each) => each === moment).length;
    return count > 0 ? [`${String(count)} ${count === 1 ? one : many}`] : [];
  };
  const summary = [
    ...tally("foeDefeated", "foe defeated", "foes defeated"),
    ...tally("levelUp", "level gained", "levels gained"),
  ].join(" · ");
  // A closing plate: the ending scene's own picture, or the adventure's cover. The scene's picture
  // moves down here from the top of the page, so it isn't shown twice.
  const art = (view.ended === "ending" ? view.sceneArt : null) ?? view.cover;
  page.stage.classList.toggle("ended", end !== null);
  page.ending.replaceChildren(
    ...(end
      ? [
          ...(art ? [picture(page.ctx.game, art, "", "ending-art")] : []),
          endTitle,
          ...(end.text ? [el("p", { text: end.text })] : []),
          ...(summary
            ? [el("p", { class: "ending-tally", text: summary })]
            : []),
          el(
            "div",
            { class: "ending-actions" },
            again,
            button("Back to the menu", () => {
              page.ctx.act(page.ctx.showMenu);
            }),
          ),
        ]
      : []),
  );
  // A run that ends under a map can leave its ending below the fold, so it comes into view once
  // the board has shown how it ended.
  if (end && page.ending.hidden) {
    void (page.board?.settled?.() ?? Promise.resolve()).then(() => {
      page.ending.scrollIntoView({ block: "nearest" });
    });
  }
  page.ending.hidden = !end;
  page.ending.dataset.ending = view.ended ?? "";
}

// Asks before a story choice that ends the adventure while others carry on. Only the page asks, so
// nothing reaches the log, and a save replays the same, until the player confirms.
export function confirmEnding(
  page: GamePage,
  option: OptionView,
  take: () => void,
): void {
  const keepPlaying = (): void => {
    page.draw();
    [...page.options.querySelectorAll<HTMLElement>(".option > button")]
      .find((item) => item.textContent === option.label)
      ?.focus();
  };
  const end = button("End the adventure here", take);
  end.className = "begin";
  const keep = button("Keep playing", keepPlaying);
  const panel = el(
    "div",
    { class: "end-confirm" },
    el("h3", { text: "End the adventure here?" }),
    el("p", {
      text: `"${option.label}" ends this adventure. Other choices carry the story on.`,
    }),
    el("div", { class: "ending-actions" }, end, keep),
  );
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-label", "End the adventure here?");
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    keepPlaying();
  });
  page.options.replaceChildren(panel);
  keep.focus();
}
