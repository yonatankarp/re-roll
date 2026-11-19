import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

export type Entries = Record<string, string>;

// The test project has no DOM types, so code that touches IndexedDB is sent to the page as text.
const READ_FILES = `new Promise((done, fail) => {
  const open = indexedDB.open("re-roll");
  open.onerror = () => fail(open.error);
  open.onsuccess = () => {
    const entries = {};
    const cursor = open.result.transaction("files", "readonly").objectStore("files").openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) {
        open.result.close();
        done(entries);
        return;
      }
      entries[String(at.key)] = String(at.value);
      at.continue();
    };
  };
})`;

// The browser build's saves, read straight from IndexedDB.
export const savedFiles = (page: Page): Promise<Entries> =>
  page.evaluate<Entries>(READ_FILES);

// Puts a golden save (tests/fixtures/saves/) in the browser build's saves, as a manual save,
// then reloads so the menu lists it. The page must already be open, so the game made its database.
export async function seedSave(page: Page, golden: string): Promise<void> {
  const contents = readFileSync(`tests/fixtures/saves/${golden}.json`, "utf8");
  const path = `saves/goblin-ambush-${golden}.json`;
  await page.evaluate(`new Promise((done, fail) => {
    const open = indexedDB.open("re-roll");
    open.onerror = () => fail(open.error);
    open.onsuccess = () => {
      const write = open.result.transaction("files", "readwrite");
      write.objectStore("files").put(${JSON.stringify(contents)}, ${JSON.stringify(path)});
      write.oncomplete = () => { open.result.close(); done(); };
      write.onerror = () => fail(write.error);
    };
  })`);
  await page.reload();
}
