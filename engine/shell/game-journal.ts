import type { GameView } from "./session.ts";
import type { GamePage } from "./game-page.ts";
import { el, enter } from "./dom.ts";

// The journal's new lines, the ticker of the latest under the board, a level-up, and the About section.

export function drawJournal(
  page: GamePage,
  view: GameView,
  firstDraw: boolean,
): void {
  const { decision } = view;
  const added = view.log.slice(page.linesShown);
  page.log.append(
    ...added.map((line) =>
      el(
        "li",
        { class: line.kind },
        ...(line.actor && !line.text.startsWith(line.actor)
          ? [el("span", { class: "log-actor", text: `${line.actor}: ` })]
          : []),
        document.createTextNode(line.text),
      ),
    ),
  );
  page.linesShown = view.log.length;
  page.journalTabsView.update(view);
  page.log.scrollTop = page.log.scrollHeight;
  const levels = added.filter((line) => line.moment === "levelUp");
  // A card stands in for the prompt, which repeats a journal line, so the ticker leaves that line out.
  const events = added
    .filter((line) => line.kind === "event" && !levels.includes(line))
    .filter((line) => !(view.card && line.text === decision?.prompt));
  // A fight has more to tell; the player's own latest result stays, even when allies act after it.
  const limit = view.combat ? 5 : 3;
  const own = events.findLast(
    (line) => line.actor && line.actor === view.sheets[0]?.title,
  );
  const latest = events.slice(-limit);
  const news =
    own && !latest.includes(own) ? [own, ...events.slice(1 - limit)] : latest;
  if (!firstDraw && (news.length > 0 || levels.length > 0)) {
    // The words wait for the board to finish showing what they describe.
    const shown = ++page.tickerShown;
    page.ticker.replaceChildren();
    page.why.update(null);
    page.levelUp.hidden = true;
    void (page.board?.settled?.() ?? Promise.resolve()).then(() => {
      if (shown !== page.tickerShown) return;
      page.levelUp.replaceChildren(
        el("strong", { text: "Level up!" }),
        ...levels.map((line) => el("span", { text: ` ${line.text}` })),
      );
      page.levelUp.hidden = levels.length === 0;
      if (levels.length > 0) enter(page.levelUp);
      page.ticker.replaceChildren(
        ...news.map((line, index) => {
          const item = el("li", { text: line.text });
          item.style.setProperty("--i", String(index));
          return item;
        }),
      );
      enter(page.ticker);
      page.why.update(view);
    });
  }
  page.about.replaceChildren(
    el("summary", { text: "About" }),
    el("p", { text: `Re-roll. ${view.about}` }),
    ...view.attributions.map((text) => el("p", { text })),
    ...page.ctx.credits.map((text) => el("p", { text })),
  );
}
