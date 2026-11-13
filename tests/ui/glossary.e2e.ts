import { expect, test } from "@playwright/test";

// Explains a rules term in a fight from a made-up library, as the owner's books would, by hover,
// by "?" on a focused choice, and through More into the book and back.
const BOOK = "fixture-book";
const FILES: Readonly<Record<string, string>> = {
  "books/library/glossary.json": JSON.stringify({
    system: "dnd5.5e",
    terms: { "action:dodge": { book: BOOK, file: "0001-dodge.md" } },
    missing: [],
  }),
  [`books/library/${BOOK}/index.json`]: JSON.stringify({
    plugin: BOOK,
    title: "Fixture Book",
    entries: [{ path: ["Rules Glossary", "Dodge"], file: "0001-dodge.md" }],
  }),
  [`books/library/${BOOK}/0001-dodge.md`]:
    "### Ducking [Made Up]\n\nYou bob and weave like a fixture.\n\nA second fixture line.",
};

test("explains a term in a fight and opens its book section", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__content/read?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    const text = FILES[path];
    return text === undefined
      ? route.fallback()
      : route.fulfill({ body: text, contentType: "text/plain" });
  });

  await page.route("**/__content/list?*", (route) =>
    new URL(route.request().url()).searchParams.get("path") === "books/library"
      ? route.fulfill({
          json: Object.keys(FILES).map((path) => ({ path, symlink: false })),
        })
      : route.fallback(),
  );

  // A monster's first sight covers the page with its picture until a click, as a player would dismiss it.
  await page.addLocatorHandler(page.locator(".art-plate"), (plate) =>
    plate.click(),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await page.getByRole("button", { name: /^Pick a ready hero/ }).click();
  await page.getByRole("button", { name: /^Human Fighter/ }).click();
  await page
    .getByRole("button", { name: "[Perception] Check the treeline" })
    .click();
  const actions = page.getByRole("button", { name: "Actions", exact: true });
  const onward = page.getByRole("button", {
    name: /^(Carry on|Drive them off)$/,
  });
  for (let tries = 0; tries < 40 && !(await actions.isVisible()); tries += 1) {
    if (await onward.first().isVisible()) await onward.first().click();
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  }
  await actions.click();

  const dodge = page.locator(".option > button", { hasText: /^Dodge/ });
  const term = dodge.locator(".term[data-term='action:dodge']");
  const pop = page.locator(".term-pop");
  // The choices drawn again from their words under the resting pointer, before and after it opens. The
  // browser may or may not send the new term a pointerover (and the old one a pointerout) then, so
  // neither gets through here.
  const redraw = () =>
    term.evaluate((span) => {
      span.replaceWith(document.createTextNode(span.textContent));
    });
  const blockOver = (block: boolean) =>
    page.evaluate((on) => {
      const stop = (event: Event) => {
        event.stopImmediatePropagation();
      };
      const holder = window as unknown as { stopOver?: typeof stop };
      for (const kind of ["pointerover", "pointerout"]) {
        if (on) addEventListener(kind, stop, true);
        else if (holder.stopOver)
          removeEventListener(kind, holder.stopOver, true);
      }
      holder.stopOver = stop;
    }, block);
  // Hovered only once the choices stop sliding in, or the resting pointer ends up beside the term.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((run) => run.effect?.getComputedTiming().endTime !== Infinity)
        .map((run) => run.finished.catch(() => undefined)),
    ),
  );
  await term.hover();
  await blockOver(true);
  await redraw();
  await expect(pop).toBeVisible();
  await expect(pop.locator("h4")).toHaveText("Ducking [Made Up]");
  await expect(pop).toContainText("You bob and weave like a fixture.");
  await redraw();
  await expect(term).toBeVisible();
  await expect(pop).toBeVisible();
  await blockOver(false);

  // By keyboard: "?" on the focused choice, then Escape back to it.
  await page.mouse.move(0, 0);
  await expect(pop).toBeHidden();
  await dodge.focus();
  await page.keyboard.press("?");
  await expect(pop).toBeVisible();
  await expect(pop.getByRole("button", { name: "More" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(dodge).toBeFocused();

  await page.keyboard.press("?");
  await pop.getByRole("button", { name: "More" }).click();
  await expect(page.locator(".book-text")).toContainText(
    "A second fixture line.",
  );
  await page.getByRole("button", { name: "Back to the game" }).click();
  await expect(actions).toBeVisible();

  // Dodging shows in the turn order, where Tab reaches it, Enter opens it and Escape goes back to it.
  await actions.click();
  await dodge.click();
  await page.getByText("Turn order and conditions").click();
  // The first, as a monster may be dodging too.
  const dodging = page
    .locator(".initiative .term[data-term='action:dodge']")
    .first();
  await dodging.focus();
  await expect(pop).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(pop.getByRole("button", { name: "More" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(dodging).toBeFocused();

  expect(errors).toEqual([]);
});
