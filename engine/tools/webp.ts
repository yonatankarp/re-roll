import {
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
// posix paths on every OS: the books name files with "/", and Node reads those on Windows too.
import { dirname, extname, join, relative } from "node:path/posix";
import sharp from "sharp";

// Converts a books folder's pictures to WebP and crops battle maps to the part their fights use (books#26).
// Safe to run again: done pictures are skipped, and new PNGs or JPGs (and references to them) are picked up.
// Only file formats and framing change: YAML and JSON are edited as text, so the books' words stay as they are.

export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The smallest rectangle holding every crop.
export function unionCrop(crops: readonly Crop[]): Crop {
  const x = Math.min(...crops.map((crop) => crop.x));
  const y = Math.min(...crops.map((crop) => crop.y));
  const right = Math.max(...crops.map((crop) => crop.x + crop.width));
  const bottom = Math.max(...crops.map((crop) => crop.y + crop.height));
  return { x, y, width: right - x, height: bottom - y };
}

// A crop measured from the union's corner instead of the picture's, so squares land on the same pixels.
export function rebase(crop: Crop, union: Crop): Crop {
  return { ...crop, x: crop.x - union.x, y: crop.y - union.y };
}

const OLD = /\.(png|jpe?g)$/i;
const PICTURE = /\.(png|jpe?g|webp)$/i;
const TEXT = /\.(ya?ml|json|md)$/i;
// A path naming a picture, as YAML, JSON and Markdown write them.
const REFERENCE = /[\w./-]+\.(?:png|jpe?g|webp)\b/gi;
const WEBP_MAX = 16383;

const stem = (path: string): string => path.replace(PICTURE, "");

async function walk(folder: string, found: string[] = []): Promise<string[]> {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.name.startsWith(".")) continue;
    const path = join(folder, item.name);
    if (item.isDirectory()) await walk(path, found);
    else if (item.isFile()) found.push(path);
  }
  return found;
}

interface Reference {
  readonly file: string;
  readonly index: number; // where the match starts in the file's text
  readonly text: string;
  readonly target: string; // the picture's stem it names
  readonly battlemap: boolean; // a battle map's image: line
}

interface Block {
  readonly file: string;
  readonly line: number; // the image: line
  readonly target: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly crop: Crop;
}

const BLOCK_LINES = [
  /^(\s*)image: (\S+)$/,
  /^(\s*)imageWidth: (\d+)$/,
  /^(\s*)imageHeight: (\d+)$/,
  /^(\s*)crop: \{ x: (\d+), y: (\d+), width: (\d+), height: (\d+) \}$/,
] as const;

export interface Report {
  readonly converted: number;
  readonly cropped: readonly string[];
  readonly uncropped: readonly string[]; // maps a scene also shows whole
  readonly skipped: readonly string[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly missing: readonly string[]; // references to pictures the books don't have in any format
}

export async function convertBooks(
  root: string,
  log: (line: string) => void = () => undefined,
): Promise<Report> {
  sharp.cache(false);
  const files = await walk(root);
  const pictures = new Map<string, string[]>(); // stem → files with it
  for (const file of files.filter((path) => PICTURE.test(path))) {
    pictures.set(stem(file), [...(pictures.get(stem(file)) ?? []), file]);
  }
  const skipped: string[] = [];
  for (const [key, paths] of pictures) {
    if (paths.filter((path) => OLD.test(path)).length > 1) {
      skipped.push(
        `${relative(root, key)}: both ${paths.map((path) => extname(path)).join(" and ")}`,
      );
      pictures.delete(key);
    }
  }
  const bytesBefore = await totalSize([...pictures.values()].flat());

  // Every reference, resolved against the file's folder and its plugin's root (where plugin.yaml is).
  const texts = new Map<string, string>();
  const references: Reference[] = [];
  const pluginRoots = new Set(
    files.filter((path) => path.endsWith("/plugin.yaml")).map(dirname),
  );
  for (const file of files.filter((path) => TEXT.test(path))) {
    const text = await readFile(file, "utf8");
    texts.set(file, text);
    const bases = [dirname(file)];
    for (
      let folder = dirname(file);
      folder.startsWith(root);
      folder = dirname(folder)
    ) {
      if (pluginRoots.has(folder)) bases.push(folder);
      if (folder === root) break;
    }
    for (const match of text.matchAll(REFERENCE)) {
      const target = bases
        .map((base) => stem(join(base, match[0])))
        .find((key) => pictures.has(key));
      if (target === undefined) continue;
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      references.push({
        file,
        index: match.index,
        text: match[0],
        target,
        battlemap: /^\s*image: $/.test(text.slice(lineStart, match.index)),
      });
    }
  }
  const blocks = battlemapBlocks(texts, references);

  // Which pictures need writing, and the crop for each battle map that only fights use.
  const shownWhole = new Set(
    references.filter((ref) => !ref.battlemap).map((ref) => ref.target),
  );
  const highQuality = new Set([
    ...blocks.map((block) => block.target),
    ...(await indexedMaps(root, files, pictures)),
  ]);
  const crops = new Map<string, Crop>();
  const reframed = new Map<Block, Crop>(); // block → the union its crop is now measured from
  const uncropped = new Set<string>();
  const leftovers: string[] = []; // old files whose WebP is already written and in use
  for (const [key, group] of groupBy(blocks, (block) => block.target)) {
    const paths = pictures.get(key) ?? [];
    const source = paths.find((path) => OLD.test(path)) ?? paths[0];
    const done = paths.find((path) => path.endsWith(".webp"));
    if (source === undefined) continue;
    const size = await dimensions(source);
    const matches = (
      block: Block,
      of: { width: number; height: number },
    ): boolean =>
      block.imageWidth === of.width && block.imageHeight === of.height;
    if (!group.every((block) => matches(block, size))) {
      // A crash between writing the WebP and removing the old file leaves the YAML measured on the WebP.
      if (done && source !== done) {
        const written = await dimensions(done);
        if (group.every((block) => matches(block, written))) {
          leftovers.push(source);
          continue;
        }
      }
      throw new Error(
        `${relative(root, source)} is ${String(size.width)}×${String(size.height)}, but its battle maps say otherwise`,
      );
    }
    if (shownWhole.has(key)) {
      uncropped.add(relative(root, `${key}.webp`));
      continue;
    }
    const union = unionCrop(group.map((block) => block.crop));
    if (union.width === size.width && union.height === size.height) continue;
    crops.set(key, union);
    for (const block of group) reframed.set(block, union);
  }

  // Write each WebP beside its old file, then point the text at it, then remove the old file.
  const jobs = [...pictures]
    .filter(
      ([key, paths]) => crops.has(key) || paths.some((path) => OLD.test(path)),
    )
    .filter(([key]) => !leftovers.some((path) => stem(path) === key));
  let converted = 0;
  const unwritten = new Set<string>();
  await pool(jobs, 3, async ([key, paths]) => {
    const source = paths.find((path) => OLD.test(path)) ?? `${key}.webp`;
    const size = await dimensions(source);
    if (size.width > WEBP_MAX || size.height > WEBP_MAX) {
      skipped.push(
        `${relative(root, source)}: ${String(size.width)}×${String(size.height)} is over WebP's limit`,
      );
      unwritten.add(key);
      return;
    }
    const crop = crops.get(key);
    let image = sharp(source, { limitInputPixels: false });
    if (crop)
      image = image.extract({
        left: crop.x,
        top: crop.y,
        width: crop.width,
        height: crop.height,
      });
    const hq = highQuality.has(key);
    await image
      .webp(hq ? { quality: 95, smartSubsample: true } : { quality: 85 })
      .toFile(`${key}.webp.part`);
    await rename(`${key}.webp.part`, `${key}.webp`);
    converted += 1;
    log(
      `${relative(root, source)}${crop ? " (cropped)" : ""}${hq ? " (map)" : ""}`,
    );
  });

  for (const [file, text] of texts) {
    const edits = references
      .filter(
        (ref) =>
          ref.file === file && OLD.test(ref.text) && !unwritten.has(ref.target),
      )
      .map((ref) => ({
        index: ref.index,
        from: ref.text,
        to: ref.text.replace(OLD, ".webp"),
      }));
    // References first, while their offsets hold; they never add a line, so block line numbers hold after.
    let next = text;
    for (const edit of edits.sort((a, b) => b.index - a.index)) {
      next =
        next.slice(0, edit.index) +
        edit.to +
        next.slice(edit.index + edit.from.length);
    }
    const lines = next.split("\n");
    let reframedHere = false;
    for (const [block, union] of reframed) {
      if (block.file !== file) continue;
      const crop = rebase(block.crop, union);
      const indent = /^\s*/.exec(lines[block.line + 1] ?? "")?.[0] ?? "";
      lines[block.line + 1] = `${indent}imageWidth: ${String(union.width)}`;
      lines[block.line + 2] = `${indent}imageHeight: ${String(union.height)}`;
      lines[block.line + 3] =
        `${indent}crop: { x: ${String(crop.x)}, y: ${String(crop.y)}, width: ${String(crop.width)}, height: ${String(crop.height)} }`;
      reframedHere = true;
    }
    if (edits.length === 0 && !reframedHere) continue;
    next = lines.join("\n");
    await writeFile(file, next);
  }

  for (const [key, paths] of pictures) {
    if (unwritten.has(key)) continue;
    for (const path of paths.filter((path) => OLD.test(path))) await rm(path);
  }

  const missing = await selfCheck(root);
  const after = (await walk(root)).filter((path) => PICTURE.test(path));
  return {
    converted,
    cropped: [...crops.keys()]
      .map((key) => relative(root, `${key}.webp`))
      .sort(),
    uncropped: [...uncropped].sort(),
    skipped: skipped.sort(),
    bytesBefore,
    bytesAfter: await totalSize(after),
    missing,
  };
}

// Each battle map's image, imageWidth, imageHeight and crop lines, which the books write the same way every time.
function battlemapBlocks(
  texts: ReadonlyMap<string, string>,
  references: readonly Reference[],
): Block[] {
  const blocks: Block[] = [];
  for (const ref of references.filter((item) => item.battlemap)) {
    const text = texts.get(ref.file) ?? "";
    const line = text.slice(0, ref.index).split("\n").length - 1;
    const lines = text.split("\n").slice(line, line + 4);
    const found = BLOCK_LINES.map((pattern, at) =>
      pattern.exec(lines[at] ?? ""),
    );
    const [, width, height, crop] = found;
    if (!width || !height || !crop) {
      throw new Error(
        `${ref.file}:${String(line + 1)}: a battle map not laid out as image, imageWidth, imageHeight, crop`,
      );
    }
    blocks.push({
      file: ref.file,
      line,
      target: ref.target,
      imageWidth: Number(width[2]),
      imageHeight: Number(height[2]),
      crop: {
        x: Number(crop[2]),
        y: Number(crop[3]),
        width: Number(crop[4]),
        height: Number(crop[5]),
      },
    });
  }
  return blocks;
}

// Pictures the books' art indexes tag as maps, or as monster faces cut into tokens: these keep crisp lines.
async function indexedMaps(
  root: string,
  files: readonly string[],
  pictures: ReadonlyMap<string, readonly string[]>,
): Promise<string[]> {
  const found: string[] = [];
  for (const file of files.filter(
    (path) =>
      path.endsWith("/index.json") && path.startsWith(join(root, "assets")),
  )) {
    const entries = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as {
      file?: unknown;
      kind?: unknown;
      face?: unknown;
    }[]) {
      if (typeof entry.file !== "string") continue;
      const key = stem(join(dirname(file), entry.file));
      if (
        pictures.has(key) &&
        (entry.kind === "map" || entry.face !== undefined)
      )
        found.push(key);
    }
  }
  return found;
}

// Fails loudly if a battle map's size doesn't match its file, or a reference still names a converted picture's old file.
async function selfCheck(root: string): Promise<string[]> {
  const files = await walk(root);
  const problems: string[] = [];
  const missing: string[] = [];
  const texts = files.filter(
    (path) =>
      (path.includes("/adventures/") && /\.ya?ml$/.test(path)) ||
      (path.startsWith(join(root, "assets")) && path.endsWith("/index.json")),
  );
  const existing = new Set(files);
  const pluginRoots = new Set(
    files.filter((path) => path.endsWith("/plugin.yaml")).map(dirname),
  );
  for (const file of texts) {
    const text = await readFile(file, "utf8");
    const plugin = [...pluginRoots].find((folder) =>
      file.startsWith(`${folder}/`),
    );
    for (const match of text.matchAll(REFERENCE)) {
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      if (text.slice(lineStart).trimStart().startsWith("#")) continue; // a YAML comment
      const named = [dirname(file), ...(plugin ? [plugin] : [])].map((base) =>
        join(base, match[0]),
      );
      if (named.some((path) => existing.has(path))) continue;
      // The picture under another extension means this run left the reference behind; under none, it was missing before.
      const elsewhere = named.some((path) =>
        [".png", ".jpg", ".jpeg", ".webp"].some((ext) =>
          existing.has(stem(path) + ext),
        ),
      );
      (elsewhere ? problems : missing).push(
        `${relative(root, file)} names ${match[0]}, which isn't there`,
      );
    }
    if (!plugin) continue;
    const lines = text.split("\n");
    for (let at = 0; at < lines.length; at += 1) {
      const image = BLOCK_LINES[0].exec(lines[at] ?? "");
      const width = BLOCK_LINES[1].exec(lines[at + 1] ?? "");
      const height = BLOCK_LINES[2].exec(lines[at + 2] ?? "");
      const crop = BLOCK_LINES[3].exec(lines[at + 3] ?? "");
      if (!image?.[2] || !width || !height || !crop) continue;
      const path = join(plugin, image[2]);
      if (!existing.has(path)) continue; // reported above
      const size = await dimensions(path);
      const [x, y, w, h] = crop.slice(2).map(Number) as [
        number,
        number,
        number,
        number,
      ];
      if (
        size.width !== Number(width[2]) ||
        size.height !== Number(height[2])
      ) {
        problems.push(
          `${relative(root, file)}:${String(at + 1)}: ${image[2]} is ${String(size.width)}×${String(size.height)}, not ${width[2]}×${height[2]}`,
        );
      } else if (x + w > size.width || y + h > size.height) {
        problems.push(
          `${relative(root, file)}:${String(at + 1)}: the crop runs off ${image[2]}`,
        );
      }
    }
  }
  if (problems.length > 0)
    throw new Error(`Check failed:\n${problems.join("\n")}`);
  return missing;
}

async function dimensions(
  path: string,
): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(path, {
    limitInputPixels: false,
  }).metadata();
  return { width, height };
}

async function totalSize(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += (await stat(path)).size;
  return total;
}

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items)
    groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

async function pool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await work(items[next++] as T);
  };
  await Promise.all(Array.from({ length: size }, worker));
}
