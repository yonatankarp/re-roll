import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { convertBooks, rebase, unionCrop } from "../engine/tools/webp.ts";

describe("unionCrop and rebase", () => {
  it("frames every crop and measures each from the union's corner", () => {
    const a = { x: 100, y: 50, width: 200, height: 100 };
    const b = { x: 150, y: 20, width: 300, height: 60 };
    const union = unionCrop([a, b]);
    expect(union).toEqual({ x: 100, y: 20, width: 350, height: 130 });
    expect(rebase(a, union)).toEqual({ x: 0, y: 30, width: 200, height: 100 });
    expect(rebase(b, union)).toEqual({ x: 50, y: 0, width: 300, height: 60 });
  });
});

describe("convertBooks", () => {
  let dir = "";
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const picture = (
    width: number,
    height: number,
    path: string,
  ): Promise<unknown> =>
    sharp({ create: { width, height, channels: 3, background: "#806040" } })
      .png()
      .toFile(path);

  it("converts, crops a map only fights use, and does nothing the second time", async () => {
    dir = await mkdtemp(join(tmpdir(), "webp-"));
    const adventure = join(dir, "adventures/a");
    await mkdir(join(adventure, "assets"), { recursive: true });
    await mkdir(join(dir, "assets/book"), { recursive: true });
    await writeFile(join(adventure, "plugin.yaml"), "id: a\n");
    await picture(400, 300, join(adventure, "assets/fight.png"));
    await picture(400, 300, join(adventure, "assets/shown.png"));
    await picture(64, 64, join(dir, "assets/book/face.png"));
    const map = (image: string, crop: string): string =>
      `- id: x\n  battlemap:\n    image: ${image}\n    imageWidth: 400\n    imageHeight: 300\n    crop: ${crop}\n    columns: 2\n`;
    await writeFile(
      join(adventure, "encounters.yaml"),
      map("assets/fight.png", "{ x: 100, y: 50, width: 200, height: 100 }") +
        map("assets/fight.png", "{ x: 150, y: 20, width: 100, height: 60 }") +
        map("assets/shown.png", "{ x: 10, y: 10, width: 50, height: 50 }"),
    );
    await writeFile(
      join(adventure, "scenes.yaml"),
      "- { id: s, art: assets/shown.png }\n",
    );
    await writeFile(
      join(dir, "assets/book/index.json"),
      JSON.stringify([{ file: "face.png", kind: "monster", face: { x: 1 } }]),
    );

    const report = await convertBooks(dir);
    expect(report.converted).toBe(3);
    expect(report.cropped).toEqual(["adventures/a/assets/fight.webp"]);
    expect(report.uncropped).toEqual(["adventures/a/assets/shown.webp"]);
    expect((await readdir(join(adventure, "assets"))).sort()).toEqual([
      "fight.webp",
      "shown.webp",
    ]);
    const fight = await sharp(join(adventure, "assets/fight.webp")).metadata();
    expect([fight.width, fight.height]).toEqual([200, 130]);
    const encounters = await readFile(
      join(adventure, "encounters.yaml"),
      "utf8",
    );
    expect(encounters).toContain(
      "image: assets/fight.webp\n    imageWidth: 200\n    imageHeight: 130\n    crop: { x: 0, y: 30, width: 200, height: 100 }",
    );
    expect(encounters).toContain(
      "crop: { x: 50, y: 0, width: 100, height: 60 }",
    );
    expect(encounters).toContain(
      "image: assets/shown.webp\n    imageWidth: 400\n    imageHeight: 300\n    crop: { x: 10, y: 10, width: 50, height: 50 }",
    );
    expect(await readFile(join(adventure, "scenes.yaml"), "utf8")).toContain(
      "art: assets/shown.webp",
    );
    expect(
      await readFile(join(dir, "assets/book/index.json"), "utf8"),
    ).toContain('"face.webp"');

    const again = await convertBooks(dir);
    expect(again.converted).toBe(0);
    expect(again.cropped).toEqual([]);
    expect(await readFile(join(adventure, "encounters.yaml"), "utf8")).toBe(
      encounters,
    );
  });
});
