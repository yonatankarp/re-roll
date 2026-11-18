import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SOUND_LICENCES,
  type SoundCredit,
  soundCredits,
} from "../engine/shell/sound-credits.ts";
import { stingsBetween } from "../engine/shell/sound-files.ts";

const FOLDERS = ["engine/shell/sounds", "plugins/systems/dnd5.5e/ui/sounds"];

describe("bundled sounds", () => {
  for (const folder of FOLDERS) {
    it(`credits every file in ${folder}, under a licence that allows shipping it`, () => {
      const credits = JSON.parse(
        readFileSync(join(folder, "credits.json"), "utf8"),
      ) as SoundCredit[];
      const files = readdirSync(folder).filter(
        (file) => file !== "credits.json",
      );
      const credited = credits.map((credit) => credit.file);
      // Each sound comes as Opus in Ogg and as AAC, for a WebKit without Ogg.
      expect(files.sort()).toEqual(
        credited
          .flatMap((file) => [file, file.replace(/\.ogg$/, ".m4a")])
          .sort(),
      );
      for (const credit of credits) {
        expect(Object.keys(SOUND_LICENCES)).toContain(credit.licence);
        expect(credit.source).toMatch(/^https:\/\//);
        expect(credit.title && credit.author).toBeTruthy();
      }
    });
  }

  it("names each CC BY work and thanks each CC0 pack once", () => {
    const lines = soundCredits([
      {
        file: "a.ogg",
        title: "Song",
        author: "Ann",
        source: "https://a",
        licence: "CC-BY-4.0",
      },
      {
        file: "b.ogg",
        title: "b",
        author: "Kit",
        source: "https://k",
        licence: "CC0-1.0",
      },
      {
        file: "c.ogg",
        title: "c",
        author: "Kit",
        source: "https://k",
        licence: "CC0-1.0",
      },
    ]);
    expect(lines).toEqual([
      "Audio: “Song” by Ann, from https://a, under the Creative Commons Attribution 4.0 licence.",
      "Sounds from https://k by Kit, under CC0 1.0 (public domain).",
    ]);
  });
});

describe("moment sounds", () => {
  const view = {
    run: "r",
    ended: null,
    scene: "The road.",
    moments: [],
    shop: null,
  } as const;

  it("sounds a new scene, a level gained, a shop and an ending, but not a new or loaded game", () => {
    expect(stingsBetween(null, view)).toEqual([]);
    expect(stingsBetween({ ...view, run: "old" }, view)).toEqual([]);
    expect(stingsBetween(view, view)).toEqual([]);
    expect(stingsBetween(view, { ...view, scene: "The camp." })).toEqual([
      "page",
    ]);
    expect(
      stingsBetween(view, {
        ...view,
        scene: "The camp.",
        moments: ["foeDefeated", "levelUp"],
        shop: {} as never,
      }),
    ).toEqual(["page", "level-up", "shop"]);
    // An ending has its own sound in place of the page turning.
    expect(
      stingsBetween(view, { ...view, scene: "The end.", ended: "ending" }),
    ).toEqual(["victory"]);
    expect(stingsBetween(view, { ...view, ended: "defeat" })).toEqual([
      "defeat",
    ]);
  });
});
