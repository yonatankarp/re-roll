import { type Page, expect } from "@playwright/test";

// Plays the story on until `ready` holds: clicks the scene's way on, or presses Enter for a die that waits for one.
// It retries on Playwright's own clock and fails with its timeout, never after a fixed number of sleeps.
export async function playUntil(
  page: Page,
  ready: () => Promise<boolean>,
): Promise<void> {
  // Alert asks to swap Initiative as a fight starts; until it's answered a map lights no squares.
  const onward = page
    .getByRole("button", {
      name: /^(Carry on|Drive them off|Keep your place)$/,
    })
    .first();
  // A foe's first sight lays its picture over the page; Escape puts it away, as a player would.
  const plate = page.locator(".art-plate");
  const fighting = page.locator(".dnd-token").first();
  await expect(async () => {
    if (await ready()) return;
    if (await plate.isVisible()) await page.keyboard.press("Escape");
    else if (await onward.isVisible()) await onward.click();
    // Once tokens stand on the board, Enter would act on it, so the foes' turns are waited out instead.
    else if (!(await fighting.isVisible())) await page.keyboard.press("Enter");
    expect(await ready()).toBe(true);
  }).toPass({ intervals: [300], timeout: 30_000 });
}
