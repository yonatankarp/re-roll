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

  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
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
  await term.hover();
  await expect(pop).toBeVisible();
  await expect(pop.locator("h4")).toHaveText("Ducking [Made Up]");
  await expect(pop).toContainText("You bob and weave like a fixture.");

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

  expect(errors).toEqual([]);
});
