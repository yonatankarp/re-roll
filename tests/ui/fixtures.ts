import { test as base, expect } from "@playwright/test";

// Sent to the page as text, since the test project has no DOM types. A blocked style, script or host
// raises securitypolicyviolation in every engine, where console wording differs.
// WebKit's own shadow tree inside a <select> trips the page's style-src, which no page can avoid,
// so that one is let through; the self-check in csp.e2e.ts shows a page's own <style> still fails.
const WATCH_CSP = `document.addEventListener("securitypolicyviolation", (event) => {
  if (event.violatedDirective === "style-src-attr" && event.target?.nodeName === "SELECT" && !event.sample) return;
  window.reportCsp(event.violatedDirective + " blocked " + (event.blockedURI || "inline") + " at " + event.sourceFile + ":" + event.lineNumber + ":" + event.columnNumber + (event.sample ? " (" + event.sample + ")" : ""));
});`;

const SEED = "5eed0001";

// Every test plays under the desktop app's CSP and fails on a violation, a console error or an
// uncaught error. `problems` is the list, for a test that checks the watch itself.
export const test = base.extend<{ problems: string[] }>({
  problems: async ({}, use) => {
    await use([]);
  },
  page: async ({ page, problems, browserName }, use) => {
    await page.exposeFunction("reportCsp", (text: string) => {
      problems.push(`CSP: ${text}`);
    });
    await page.addInitScript(WATCH_CSP);
    // A run's seed is the only thing the page draws from randomUUID, so every test plays the same dice:
    // with a random one the party's allies sometimes won the first fight before the hero's turn.
    await page.addInitScript(
      `crypto.randomUUID = () => "${SEED}-0000-4000-8000-000000000000";`,
    );
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // WebKit logs the <select> one above too, without saying where; the event reports any real one.
      const select =
        browserName === "webkit" &&
        message.text().startsWith("Refused to apply a stylesheet");
      if (!select) problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    // The narrator's model is never fetched in a test.
    await page.route(
      /^https:\/\/([^/]+\.)?(huggingface\.co|hf\.co)\//,
      (route) => route.abort(),
    );
    await use(page);
    expect(problems).toEqual([]);
  },
});

export { type Page, expect } from "@playwright/test";
