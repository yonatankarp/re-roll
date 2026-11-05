// Copies read-aloud boxes from a saved book page into scenes.yaml, so no book prose is ever typed by hand.
// Usage: node tests/tools/fill-read-aloud.ts <book.html> <scenes.yaml> <map.json>
// The map is { "<scene id>": { heading, boxes, paragraphs? } }. heading is the heading's id attribute,
// boxes index the read-aloud boxes under it, paragraphs index the paragraphs of those boxes together.
import { readFileSync, writeFileSync } from "node:fs";
import { isMap, isSeq, parseDocument } from "yaml";

export interface ReadAloudSource {
  readonly heading: string;
  readonly boxes: readonly number[];
  readonly paragraphs?: readonly number[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (_match, code: string) => {
      if (code.startsWith("#")) {
        const hex = code[1]?.toLowerCase() === "x";
        return String.fromCodePoint(
          Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10),
        );
      }
      const decoded = ENTITIES[code];
      if (decoded === undefined) throw new Error(`Unknown entity &${code};`);
      return decoded;
    })
    .replace(/\s+/g, " ")
    .trim();
}

export function readAloudText(html: string, source: ReadAloudSource): string {
  const heading = new RegExp(
    `<h[1-6][^>]*\\sid="${source.heading}"[^>]*>`,
  ).exec(html);
  if (!heading) throw new Error(`No heading with id "${source.heading}"`);
  const start = heading.index + heading[0].length;
  const next = html.slice(start).search(/<h[1-6][\s>]/);
  const section = html.slice(start, next === -1 ? undefined : start + next);

  const found = [
    ...section.matchAll(
      /<aside[^>]*class="[^"]*text--quote-box[^"]*"[^>]*>([\s\S]*?)<\/aside>/g,
    ),
  ].map((match) => match[1] ?? "");
  const paragraphs = source.boxes.flatMap((index) => {
    const box = found[index];
    if (box === undefined) {
      throw new Error(
        `"${source.heading}" has no read-aloud box ${String(index)}`,
      );
    }
    return [...box.matchAll(/<p[\s>][\s\S]*?<\/p>/g)].map((match) =>
      plainText(match[0]),
    );
  });
  const chosen = source.paragraphs
    ? source.paragraphs.map((index) => {
        const paragraph = paragraphs[index];
        if (paragraph === undefined) {
          throw new Error(
            `"${source.heading}" has no paragraph ${String(index)}`,
          );
        }
        return paragraph;
      })
    : paragraphs;
  return chosen.join("\n\n");
}

// Goes through the YAML document so the file's comments and layout survive.
export function fillScenes(
  html: string,
  scenesYaml: string,
  map: Readonly<Record<string, ReadAloudSource>>,
): string {
  const document = parseDocument(scenesYaml);
  if (document.errors[0]) throw document.errors[0];
  if (!isSeq(document.contents)) throw new Error("scenes.yaml must be a list");
  const remaining = new Set(Object.keys(map));
  document.contents.items.forEach((scene, index) => {
    if (!isMap(scene)) return;
    const id = String(scene.get("id"));
    const source = map[id];
    if (!source) return;
    document.setIn([index, "text"], readAloudText(html, source));
    remaining.delete(id);
  });
  if (remaining.size > 0) {
    throw new Error(`Unknown scenes in the map: ${[...remaining].join(", ")}`);
  }
  return document.toString({ lineWidth: 0 });
}

if (import.meta.main) {
  const [htmlPath, scenesPath, mapPath] = process.argv.slice(2);
  if (!htmlPath || !scenesPath || !mapPath) {
    throw new Error(
      "Usage: fill-read-aloud <book.html> <scenes.yaml> <map.json>",
    );
  }
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as Record<
    string,
    ReadAloudSource
  >;
  writeFileSync(
    scenesPath,
    fillScenes(
      readFileSync(htmlPath, "utf8"),
      readFileSync(scenesPath, "utf8"),
      map,
    ),
  );
  // A count only, so a run never prints book text.
  console.log(
    `Filled ${String(Object.keys(map).length)} scenes in ${scenesPath}`,
  );
}
