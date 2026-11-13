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
