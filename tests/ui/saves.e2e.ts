import { type Page, expect, test } from "@playwright/test";
import { type Entries, savedFiles } from "./saved-files.ts";

// Sent to the page as text, like the reader in saved-files.ts.
const DELETE_FILES = `new Promise((done, fail) => {
  const remove = indexedDB.deleteDatabase("re-roll");
  remove.onsuccess = () => done();
  remove.onerror = () => fail(remove.error);
})`;

const localSaves = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("saves/")),
  );

// Saves go to IndexedDB, and saves an older build left in localStorage are moved there.
test("keeps saves in IndexedDB and moves old localStorage saves there", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await page.getByRole("button", { name: /^Human Fighter/ }).click();
  await expect(
    page.getByRole("button", { name: "[Perception] Check the treeline" }),
  ).toBeVisible();

  let saved: Entries = {};
  await expect
    .poll(async () => {
      saved = await savedFiles(page);
      return Object.keys(saved).some((path) => path.endsWith("-autosave.json"));
    })
    .toBe(true);
  expect(await localSaves(page)).toEqual([]);

  // Put the saves back where an older build kept them, on a same-origin page with no game open.
  await page.goto("/__content/list?path=plugins");
  await page.evaluate(DELETE_FILES);
  await page.evaluate((entries) => {
    for (const [path, contents] of Object.entries(entries)) {
      if (path.endsWith(".json")) localStorage.setItem(path, contents);
    }
  }, saved);

  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Continue / })).toBeVisible();
  const moved = await savedFiles(page);
  for (const path of Object.keys(saved).filter((key) => key.endsWith(".json")))
    expect(moved[path]).toBe(saved[path]);
});
