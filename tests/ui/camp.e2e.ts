import { expect, test } from "./fixtures.ts";
import { seedSave } from "./saved-files.ts";

// From the golden save that stops mid level-up: load it, finish levelling, buy at the peddler's,
// rest at the campfire, then reload and find all of it kept.
test("levels up, buys at the camp's shop, rests and keeps it all over a reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Choose an adventure" }),
  ).toBeVisible();
  await seedSave(page, "level-up");

  // The load screen lists the save, and opens it.
  await page.getByRole("button", { name: "Load a game (1)" }).click();
  await expect(
    page.getByRole("heading", { name: "Load a game" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Load Ambush on the Old Road Saved/ })
    .click();

  // The level-up's last choice, a spell, then the camp scene.
  await expect(page.getByText("Choose a spell.")).toBeVisible();
  await page.getByRole("button", { name: /^Burning Hands/ }).click();
  await expect(
    page.getByRole("main").getByText(/reaches level 2, with 14 HP/),
  ).toBeVisible();
  await expect(page.locator(".hud")).toContainText("14/14");

  // The shop stands in for the choices: buy a dagger, see the purse go down, find it to sell, leave.
  await page
    .getByRole("button", { name: "Trade with Tam the peddler" })
    .click();
  const shop = page.locator(".shop");
  await expect(
    shop.getByRole("heading", { name: "Tam the Peddler" }),
  ).toBeVisible();
  await expect(shop.locator(".shop-purse")).toHaveText("Your purse: 42 gp");
  await expect(
    shop.getByRole("button", { name: /^Buy Potion of Healing/ }),
  ).toBeDisabled();
  await shop.getByRole("button", { name: "Buy Dagger for 2 gp" }).click();
  await expect(shop.locator(".shop-purse")).toHaveText("Your purse: 40 gp");
  await shop.getByRole("tab", { name: "Sell" }).click();
  await expect(shop.getByRole("tab", { name: "Sell" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(shop.locator('[data-item="srd52:item/dagger"]')).toContainText(
    "You have 2",
  );
  await shop.getByRole("button", { name: "Leave" }).click();
  await expect(shop).toBeHidden();

  // The campfire in the top bar: a short rest, its question, what came back, and once a scene.
  const rest = page.getByRole("button", { name: "Rest", exact: true });
  await rest.click();
  const camp = page.getByRole("dialog", { name: "Camp" });
  await expect(camp.getByRole("heading", { name: "Make camp" })).toBeVisible();
  await camp.getByRole("button", { name: /^Short rest/ }).click();
  await camp.getByRole("button", { name: "Finish resting" }).click();
  await expect(camp.getByRole("heading", { name: "Rested" })).toBeVisible();
  await expect(camp).toContainText("Level 1 slots");
  await camp.getByRole("button", { name: "Break camp" }).click();
  await expect(camp).toBeHidden();
  await expect(rest).toHaveAttribute("aria-disabled", "true");

  // A fresh page carries on from the autosave: the dagger bought, the purse spent, the rest taken.
  await page.reload();
  await page.getByRole("button", { name: /^Continue / }).click();
  // Opening the adventure afresh reads its rules again, which a busy runner takes a while over.
  await expect(page.locator(".hud")).toContainText("14/14", {
    timeout: 20_000,
  });
  await expect(rest).toHaveAttribute("aria-disabled", "true");
  await page
    .getByRole("button", { name: "Trade with Tam the peddler" })
    .click();
  await expect(shop.locator(".shop-purse")).toHaveText("Your purse: 40 gp");
});
