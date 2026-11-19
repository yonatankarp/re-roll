import { type Page, expect } from "@playwright/test";

// Plays the story on until `ready` holds: clicks the scene's way on, or presses Enter for a die that waits.
// Once the player's fight turn is up (its tabs of actions) it only waits, since an Enter there would take
// the focused action before the board has drawn its squares.
// It retries on Playwright's own clock and fails with its timeout, never after a fixed number of sleeps.
export async function playUntil(
  page: Page,
  ready: () => Promise<boolean>,
): Promise<void> {
  const onward = page
    .getByRole("button", { name: /^(Carry on|Drive them off)$/ })
    .first();
  const turn = page.locator(".options > .tabs").first();
  await expect(async () => {
    if (await ready()) return;
    if (await onward.isVisible()) await onward.click();
    else if (!(await turn.isVisible())) await page.keyboard.press("Enter");
    expect(await ready()).toBe(true);
  }).toPass({ intervals: [300], timeout: 30_000 });
}
