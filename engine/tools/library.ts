// Turns a saved book page into one Markdown file per section, by code alone: no model reads or rewrites the text.

export type LibraryKind =
  | "setting"
  | "npc"
  | "location"
  | "rules"
  | "adventure"
  | "monster"
  | "spell"
  | "item"
  | "table"
  | "other";

export interface LibraryEntry {
  readonly path: readonly string[]; // heading titles from the top of the book
  readonly anchor: string; // the heading's id in the HTML, or ""
  readonly file: string; // relative to the library folder
  readonly words: number;
  readonly kind: LibraryKind;
}

export interface Library {
  readonly title: string;
  readonly files: ReadonlyMap<string, string>;
  readonly entries: readonly LibraryEntry[];
}

type Block =
  | { t: "h"; level: number; id: string; text: string }
  | { t: "p"; text: string; quote: boolean }
  | { t: "li"; text: string; quote: boolean }
  | { t: "table"; caption: string; rows: string[][]; quote: boolean };

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  times: "×",
  minus: "−",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1]?.toLowerCase() === "x"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : all;
    }
    return NAMED[body.toLowerCase()] ?? all;
  });
}

const VOID = new Set(["br", "img", "hr", "meta", "link", "input", "col"]);
const SKIPPED = new Set(["head", "script", "style", "svg", "figure", "nav"]);
const BREAKS = new Set([
  "p",
  "li",
  "ul",
  "ol",
  "div",
  "aside",
  "blockquote",
  "section",
  "article",
  "table",
  "thead",
  "tbody",
  "tr",
  "caption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
// Read-aloud boxes and sidebars, which become quotes.
const QUOTE_CLASS = /quote-box|aside|sidebar|read-?aloud/i;

function tidy(text: string): string {
  return decodeEntities(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/\*\*\s*\*\*|\*\s+\*(?=\S)/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function blocksOf(html: string): { title: string; blocks: Block[] } {
  const title = tidy(
    (/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "").replace(
      /<[^>]*>/g,
      "",
    ),
  );
  const blocks: Block[] = [];
  const stack: { name: string; quote: boolean }[] = [];
  let skip = 0;
  let buf = "";
  let heading: { level: number; id: string } | null = null;
  let table: { caption: string; rows: string[][]; row: string[] } | null = null;
  let cell: { colspan: number } | null = null;
  let ordered = false;
  const quote = (): boolean => stack.some((frame) => frame.quote);
  const flush = (): void => {
    const text = tidy(buf);
    buf = "";
    if (!text) return;
    if (table) return;
    blocks.push({ t: "p", text, quote: quote() });
  };

  for (const token of html.matchAll(
    /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)|<!--[\s\S]*?-->/gi,
  )) {
    const [, slash, rawName, attrs = "", text] = token;
    if (text !== undefined) {
      if (!skip) buf += text;
      continue;
    }
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    const closing = slash === "/";
    if (SKIPPED.has(name)) {
      if (closing) skip = Math.max(0, skip - 1);
      else if (!VOID.has(name)) skip += 1;
      continue;
    }
    if (skip) continue;

    if (!closing) {
      if (name === "br") {
        buf += " ";
        continue;
      }
      if (VOID.has(name)) continue;
      if (name === "strong" || name === "b") buf += "**";
      else if (name === "em" || name === "i") buf += "*";
      else if (name === "ol") ordered = true;
      else if (name === "ul") ordered = false;
      if (BREAKS.has(name)) {
        // A heading inside a table caption only names that table.
        if (!(table && /^h[1-6]$/.test(name))) flush();
      }
      stack.push({ name, quote: QUOTE_CLASS.test(attrs) });
      if (name === "table") table = { caption: "", rows: [], row: [] };
      else if (name === "tr" && table) table.row = [];
      else if ((name === "td" || name === "th") && table) {
        cell = { colspan: Number(/colspan="(\d+)"/.exec(attrs)?.[1] ?? 1) };
        buf = "";
      } else if (/^h[1-6]$/.test(name) && !table) {
        heading = {
          level: Number(name[1]),
          id: /\bid="([^"]*)"/.exec(attrs)?.[1] ?? "",
        };
      }
      continue;
    }

    // Closing tag: pop to the matching frame.
    const at = stack.map((frame) => frame.name).lastIndexOf(name);
    const frame = at >= 0 ? stack[at] : undefined;
    if (at >= 0) stack.length = at;
    if (name === "strong" || name === "b") buf += "**";
    else if (name === "em" || name === "i") buf += "*";
    if (table && (name === "td" || name === "th") && cell) {
      table.row.push(tidy(buf).replace(/\|/g, "\\|"));
      for (let i = 1; i < cell.colspan; i += 1) table.row.push("");
      buf = "";
      cell = null;
    } else if (table && name === "tr") {
      if (table.row.length) table.rows.push(table.row);
    } else if (table && name === "caption") {
      table.caption = tidy(buf);
      buf = "";
    } else if (name === "table" && table) {
      blocks.push({
        t: "table",
        caption: table.caption,
        rows: table.rows,
        quote: quote(),
      });
      table = null;
    } else if (heading && name === `h${String(heading.level)}`) {
      const text = tidy(buf).replace(/\*/g, "");
      buf = "";
      if (text)
        blocks.push({ t: "h", level: heading.level, id: heading.id, text });
      heading = null;
    } else if (name === "li") {
      const text = tidy(buf);
      buf = "";
      if (text)
        blocks.push({
          t: "li",
          text: `${ordered ? "1." : "-"} ${text}`,
          quote: frame?.quote ?? quote(),
        });
    } else if (BREAKS.has(name) && !(table && /^h[1-6]$/.test(name))) {
      flush();
    }
  }
  flush();
  return { title, blocks };
}

export function tableMarkdown(rows: readonly (readonly string[])[]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (row: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
  const [head = [], ...rest] = rows;
  return [line(head), `|${" --- |".repeat(width)}`, ...rest.map(line)].join(
    "\n",
  );
}

function render(block: Block): string {
  if (block.t === "h") return `${"#".repeat(block.level)} ${block.text}`;
  const quoted = (text: string): string =>
    text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  if (block.t === "table") {
    const body = [
      block.caption ? `**${block.caption}**` : "",
      block.rows.length ? tableMarkdown(block.rows) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return block.quote ? quoted(body) : body;
  }
  return block.quote ? quoted(block.text) : block.text;
}

const wordCount = (text: string): number =>
  text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;

const PATH_KINDS: readonly (readonly [LibraryKind, RegExp])[] = [
  [
    "npc",
    /\b(npcs?|characters?|villains?|allies|personalit\w*|patrons?|nobles?|rulers?|rivals?|cast)\b/,
  ],
  [
    "adventure",
    /\b(adventure|encounters?|quests?|hooks?|part \d|act \d|running|walkthrough|epilogue|conclusion|aftermath|development)\b/,
  ],
  [
    "location",
    /\b(locations?|areas?|maps?|towns?|cit(y|ies)|villages?|castles?|dungeons?|keeps?|regions?|islands?|manors?|towers?|temples?|ruins?|caves?|taverns?|shops?|districts?|settlements?|domains?|lands?)\b/,
  ],
  [
    "setting",
    /\b(history|lore|geography|gods?|pantheons?|calendar|factions?|peoples?|world|setting|overview|backgrounds?|cosmology|planes|realms?|cultures?|religions?|introduction|about)\b/,
  ],
  [
    "rules",
    /\b(rules?|combat|spells?|equipment|class(es)?|feats?|species|conditions?|hazards?|traps?|poisons?|tables?|abilit\w*|skills?|cover|rests?|travel|downtime|crafting|magic items?|monsters?|creatures?|errata|clarification|options?|subclass\w*|playtest)\b/,
  ],
];

export function kindOf(path: readonly string[], body: string): LibraryKind {
  if (
    /\b(Armor Class|AC)\s*\d+/.test(body) &&
    /\b(Hit Points|HP)\s*\d+/.test(body)
  ) {
    return "monster";
  }
  if (/\bCasting Time\b/.test(body) && /\bDuration\b/.test(body))
    return "spell";
  if (
    /^\W*(Wondrous Item|Weapon|Armor|Potion|Ring|Rod|Staff|Wand|Scroll)\b[^\n]{0,80}\b(Common|Uncommon|Rare|Very Rare|Legendary|Artifact)\b/im.test(
      body.slice(0, 600),
    )
  ) {
    return "item";
  }
  // The section's own title wins over its parents'.
  for (const near of [path.slice(-1), path.slice(-3)]) {
    const text = near.join(" / ").toLowerCase();
    for (const [kind, pattern] of PATH_KINDS) {
      if (pattern.test(text)) return kind;
    }
  }
  if (/^> /m.test(body)) return "adventure"; // read-aloud boxes
  return "other";
}

const slugOf = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "section";

// Sections are cut at headings down to this level. Deeper headings stay inside their section.
const CUT_LEVEL = 3;

export function buildLibrary(html: string): Library {
  const { title, blocks } = blocksOf(html);
  const files = new Map<string, string>();
  const entries: LibraryEntry[] = [];
  const trail: { level: number; text: string }[] = [];
  let current: { path: string[]; anchor: string; parts: string[] } | null =
    null;
  let intro: string[] = [];

  const close = (): void => {
    const section = current ?? {
      path: [title || "Front matter"],
      anchor: "",
      parts: intro,
    };
    const text = section.parts.join("\n\n");
    // A heading with nothing under it is only a path for the sections below.
    if (wordCount(text.replace(/^#+ .*$/gm, "")) === 0) return;
    const file = `${String(entries.length + 1).padStart(4, "0")}-${slugOf(section.path.at(-1) ?? "")}.md`;
    files.set(file, `${text}\n`);
    entries.push({
      path: section.path,
      anchor: section.anchor,
      file,
      words: wordCount(text),
      kind: kindOf(section.path, text),
    });
  };

  for (const block of blocks) {
    if (block.t === "h") {
      while (trail.length && (trail.at(-1)?.level ?? 0) >= block.level)
        trail.pop();
      trail.push({ level: block.level, text: block.text });
      if (block.level <= CUT_LEVEL) {
        close();
        intro = [];
        current = {
          path: trail.map((item) => item.text),
          anchor: block.id,
          parts: [render(block)],
        };
        continue;
      }
    }
    (current?.parts ?? intro).push(render(block));
  }
  close();
  return { title, files, entries };
}
