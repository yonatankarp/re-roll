import { expect, test } from "@playwright/test";

// Shows a made-up ruling beside the section it rules on (#130), and a monster's family (#133), in a made-up library.
const BOOK = "fixture-book";
const SAGE = "fixture-sage";
const FILES: Readonly<Record<string, string>> = {
  [`books/library/${BOOK}/index.json`]: JSON.stringify({
    plugin: BOOK,
    title: "Fixture Book",
    entries: [
      { path: ["Spells", "Hush"], file: "0001-hush.md" },
      { path: ["Bestiary", "Gloomwings"], file: "0002-gloomwings.md" },
      {
        path: ["Bestiary", "Gloomwings", "Elder Gloomwing"],
        file: "0003-elder-gloomwing.md",
      },
    ],
  }),
  [`books/library/${BOOK}/0001-hush.md`]: "### Hush\n\nA fixture spell.",
  [`books/library/${BOOK}/0002-gloomwings.md`]:
    "## Gloomwings\n\nA fixture family.",
  [`books/library/${BOOK}/0003-elder-gloomwing.md`]:
    "### Elder Gloomwing\n\nA fixture stat block.",
  [`books/library/${BOOK}/links.json`]: JSON.stringify({
    links: {
      "0003-elder-gloomwing.md": [
        { file: "0002-gloomwings.md", heading: "Gloomwings", rel: "family" },
      ],
    },
  }),
  [`books/library/${SAGE}/index.json`]: JSON.stringify({
    plugin: SAGE,
    title: "Fixture Sage",
    entries: [{ path: ["Spells"], file: "0001-spells.md" }],
  }),
  [`books/library/${SAGE}/0001-spells.md`]:
    "## Spells\n\n#### Is Hush loud?\n\nNever, says the fixture.\n\n#### Is Gloom dark?\n\nAnother answer.",
  [`books/library/${SAGE}/rulings.json`]: JSON.stringify({
    rulings: {
      [`${BOOK}/0001-hush.md`]: [
        { book: SAGE, file: "0001-spells.md", heading: "Is Hush loud?" },
      ],
    },
  }),
};

test("shows the rulings on a book section beside it", async ({ page }) => {
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

  await page.goto("/");
  await page.getByRole("button", { name: "Book library" }).click();
  await page.getByRole("button", { name: "Fixture Book" }).click();
  await page.getByRole("button", { name: "Hush" }).click();
  await expect(page.locator(".book-text").first()).toContainText(
    "A fixture spell.",
  );
  await page.getByText("Rulings (1)").click();
  await page.getByText("Is Hush loud?").click();
  const ruling = page.locator(".book-ruling .book-text");
  await expect(ruling).toHaveText("Never, says the fixture.");

  // A section nothing rules on has no drawer.
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: "Fixture Sage" }).click();
  await page.getByRole("button", { name: "Spells" }).click();
  await expect(page.locator(".book-text").first()).toContainText(
    "Another answer.",
  );
  await expect(page.locator(".book-rulings")).toHaveCount(0);

  // A stat block links to its family's section.
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: "Fixture Book" }).click();
  await expect(page.locator(".book-links")).toHaveCount(0);
  await page.getByRole("button", { name: "Elder Gloomwing" }).click();
  await page.getByRole("button", { name: "Family: Gloomwings" }).click();
  await expect(page.locator(".book-text").first()).toContainText(
    "A fixture family.",
  );
  expect(errors).toEqual([]);
});
