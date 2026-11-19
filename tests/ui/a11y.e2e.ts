import AxeBuilder from "@axe-core/playwright";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { playUntil } from "./onward.ts";

// Keyboard, focus and screen-reader checks (#218), with an axe pass on each main screen.

// axe's WCAG A and AA rules, failing on any violation it finds on the page as it stands.
async function axe(page: Page): Promise<void> {
  // Colours mid fade-in aren't the page's colours, so finite animations end first.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    violations.map(
      (rule) =>
        `${rule.id}: ${rule.nodes.map((node) => `${node.target.join(" ")} (${node.failureSummary ?? ""})`).join(", ")}`,
    ),
  ).toEqual([]);
}

async function readyHero(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Pick a ready hero/ }).click();
  await page.getByRole("button", { name: /^Human Fighter/ }).click();
  await expect(
    page.getByRole("button", { name: /Perception ?\] Check the treeline$/ }),
  ).toBeVisible();
}

test("the menu, setup and game pass axe, and the setup's choices work by keyboard", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Ambush on the Old Road" }),
  ).toBeVisible();
  await axe(page);

  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  const difficulty = page.getByRole("radiogroup", { name: "Difficulty" });
  await expect(difficulty).toBeVisible();
  await axe(page);
  // Named cards, one tab stop for the group, and arrows that move the choice.
  const normal = difficulty.getByRole("radio", { name: "Normal" });
  await expect(normal).toBeChecked();
  await expect(difficulty.locator('[tabindex="0"]')).toHaveCount(1);
  await normal.focus();
  await page.keyboard.press("ArrowRight");
  const hard = difficulty.getByRole("radio", { name: "Hard" });
  await expect(hard).toBeChecked();
  await expect(hard).toBeFocused();
  await expect(hard).toHaveAttribute("tabindex", "0");
  await expect(normal).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowRight"); // round to the first
  await expect(difficulty.getByRole("radio", { name: "Story" })).toBeFocused();
  await expect(
    page.getByRole("switch", { name: "Encumbrance" }),
  ).not.toBeVisible(); // folded in its drawer, but named

  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await readyHero(page);
  await expect(
    page.getByRole("button", {
      name: /^Hollis Brand .*, open the character sheet$/,
    }),
  ).toHaveAttribute("aria-keyshortcuts", "Control+I Meta+I");
  await axe(page);
});

test("the die waits as a focused button and the foe's plate has a way out", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await readyHero(page);
  await page
    .getByRole("button", { name: /Perception ?\] Check the treeline$/ })
    .click();
  const die = page.getByRole("button", {
    name: "Throw the d20: Perception · DC 12",
  });
  await expect(die).toBeFocused();
  await expect(die).toContainText("press Enter");
  await page.keyboard.press("Enter");
  await expect(die).toHaveCount(0);

  // Focus goes on, to the choices that follow, never left on the page itself.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .not.toBe("BODY");

  // The battle map, once the fight starts.
  await playUntil(page, () => page.locator(".dnd-cell").first().isVisible());
  await axe(page);

  // The page's own module draws a foe's plate, so it opens with focus on a known button.
  const plateModule = `/@fs/${resolve(
    import.meta.dirname,
    "../../engine/shell/art-plate.ts",
  )
    .replaceAll("\\", "/")
    .replace(/^\//, "")}`;
  const journal = page.getByRole("button", { name: "Journal", exact: true });
  await journal.focus();
  await page.evaluate(async (url) => {
    const { artPlate } = (await import(
      url
    )) as typeof import("../../engine/shell/art-plate.ts");
    const plate = artPlate();
    document.body.append(plate.element);
    plate.show(null as never, {
      kind: "foe",
      kicker: "A foe appears",
      title: "Goblin",
      pictures: [],
    });
  }, plateModule);
  const plate = page.getByRole("status").filter({ hasText: "A foe appears" });
  const leave = plate.getByRole("button", { name: /^Continue/ });
  await expect(leave).toHaveAttribute("aria-keyshortcuts", "Escape");
  await expect(plate).toContainText("Esc");
  // Its button gives focus back to where it was as the plate came.
  await leave.focus();
  await page.keyboard.press("Enter");
  await expect(plate).toBeHidden();
  await expect(journal).toBeFocused();
});

test("shortcuts work on a non-Latin layout and say Ctrl off a Mac", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await readyHero(page);
  const journal = page.getByRole("button", { name: "Journal", exact: true });
  await expect(journal).toHaveAttribute("title", "Journal (Ctrl+J)");
  // Ctrl+J on a Hebrew layout types ח, in the J key's place.
  await page.evaluate(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ח",
        code: "KeyJ",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByRole("dialog", { name: "Journal" })).toBeVisible();
});

test("text size grows the page's text and is kept", async ({ page }) => {
  await page.goto("/");
  const size = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.body).fontSize);
  expect(await size()).toBe("17px");
  const group = page.getByRole("group", { name: "Text size" });
  await group.getByRole("button", { name: /Larger text/ }).click();
  await group.getByRole("button", { name: /Larger text/ }).click();
  expect(await size()).toBe("22.1px");
  await page.reload();
  expect(await size()).toBe("22.1px");
  // On a phone-width window the bar wraps and grows: the page doesn't scroll sideways, and a focused
  // control scrolls clear of the bar.
  await page.setViewportSize({ width: 360, height: 800 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>("header.top");
        const padding = parseFloat(
          getComputedStyle(document.documentElement).scrollPaddingTop,
        );
        return (
          document.documentElement.scrollWidth <= innerWidth &&
          padding >= (bar?.offsetHeight ?? Infinity)
        );
      }),
    )
    .toBe(true);
  await page.keyboard.press("Control+0");
  expect(await size()).toBe("17px");
  await expect(
    group.getByRole("button", { name: /Smaller text/ }),
  ).toHaveAttribute("aria-disabled", "true");
});

// Sent to the page as text, like the reader in saved-files.ts.
const WRITE_DAMAGED = `new Promise((done, fail) => {
  const open = indexedDB.open("re-roll");
  open.onerror = () => fail(open.error);
  open.onsuccess = () => {
    const put = open.result.transaction("files", "readwrite").objectStore("files").put("{ not a save", "saves/damaged.json");
    put.onsuccess = () => { open.result.close(); done(); };
    put.onerror = () => fail(put.error);
  };
})`;

// A damaged save's Open is disabled, so deleting the card above it gives focus to its Delete.
test("deleting a save leaves focus on something that takes it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await readyHero(page);
  // A damaged file beside the autosave, written where the browser build keeps saves.
  await page.evaluate(WRITE_DAMAGED);

  await page.locator(".game-menu summary").click();
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("button", { name: /^Load a game/ }).click();
  await expect(
    page.getByRole("button", { name: /^Damaged save/ }),
  ).toBeDisabled();
  // A card is named by its own words, after a "Load" read out but not shown.
  await expect(
    page.getByRole("button", {
      name: /^Load Hollis Brand, .*Ambush on the Old Road/,
    }),
  ).toBeEnabled();
  await axe(page);
  const deletes = page.locator(".save-delete");
  await expect(deletes).toHaveCount(2);
  const first = deletes.first();
  await first.click();
  await first.click();
  await expect(deletes).toHaveCount(1);
  await expect(deletes.first()).toBeFocused();
  // Esc on the Load screen goes back.
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Ambush on the Old Road" }).first(),
  ).toBeVisible();
});

test("the dark scheme's menu, setup and game pass axe", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Ambush on the Old Road" }),
  ).toBeVisible();
  await axe(page);
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await expect(
    page.getByRole("radiogroup", { name: "Difficulty" }),
  ).toBeVisible();
  await axe(page);
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await readyHero(page);
  await axe(page);
});
