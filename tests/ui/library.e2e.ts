import { expect, test } from "./fixtures.ts";

// The book library from the menu, over a made-up library: a book that opens, one that doesn't,
// its headings searched, a section read as Markdown, and the way back.
const FILES: Readonly<Record<string, string>> = {
  "books/library/fixture-tome/index.json": JSON.stringify({
    plugin: "fixture-tome",
    title: "Fixture Tome",
    entries: [
      { path: ["Lands"], file: "0001-lands.md" },
      { path: ["Lands", "Marshes"], file: "0002-marshes.md" },
      { path: ["Beasts"], file: "0003-beasts.md" },
    ],
  }),
  "books/library/fixture-tome/0001-lands.md": "## Lands\n\nWide and *flat*.",
  "books/library/fixture-tome/0002-marshes.md":
    "### Marshes\n\nWet ground.\n\n- reeds\n- mud",
  "books/library/fixture-tome/0003-beasts.md": "## Beasts\n\nMade-up beasts.",
  "books/library/torn-tome/index.json": "{ not json",
};

test("opens the book library, searches a book and reads a section", async ({
  page,
}) => {
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
  await expect(
    page.getByRole("heading", { name: "Book library" }),
  ).toBeVisible();
  // A book that won't open is named rather than left out without a word.
  await expect(page.getByText(/couldn't be opened/)).toContainText("Torn-tome");
  await page.getByRole("button", { name: "Fixture Tome" }).click();

  await expect(
    page.getByRole("heading", { name: "Fixture Tome" }),
  ).toBeVisible();
  const contents = page.locator(".book-contents");
  await expect(contents.getByRole("button")).toHaveCount(3);
  const search = page.getByRole("searchbox", { name: "Search headings" });
  await search.fill("mar");
  await expect(contents.getByRole("button")).toHaveText(["Marshes"]);
  await search.fill("nothing like it");
  await expect(contents).toContainText("No heading has that in it.");
  await search.fill("");

  await contents.getByRole("button", { name: "Marshes" }).click();
  const text = page.locator(".book-text");
  await expect(text.getByRole("heading", { name: "Marshes" })).toBeVisible();
  await expect(text.getByRole("listitem")).toHaveText(["reeds", "mud"]);
  await contents.getByRole("button", { name: "Lands" }).click();
  await expect(text.locator("em")).toHaveText("flat");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Book library" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose an adventure" }),
  ).toBeVisible();
});
