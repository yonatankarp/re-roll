import type { TermEntry } from "./session.ts";

// A rules term's words in the game's text, and the short answer from its book section. No DOM, so tests use it.

export interface Excerpt {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

const plain = (text: string): string =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*+|_{2,}/g, "")
    .trim();

// The start of a section, enough for a quick answer: whole paragraphs up to about a short card's worth.
// A table row named by the word, such as one damage type of many, is added after the first paragraph.
export function excerpt(markdown: string, word: string): Excerpt {
  const blocks = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const title = plain(
    /^#+\s+(.*)$/m.exec(
      blocks.find((block) => block.startsWith("#")) ?? "",
    )?.[1] ?? "",
  );
  const row = markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .map((cell) => plain(cell))
        .filter(Boolean),
    )
    .find((cells) => cells[0]?.toLowerCase() === word.toLowerCase());
  const prose = blocks.filter(
    (block) =>
      !block.startsWith("#") &&
      !block.startsWith("|") &&
      !/^\*\*[^*]+\*\*$/.test(block), // a table's caption
  );
  const paragraphs: string[] = [];
  let length = 0;
  for (const block of prose) {
    const text = plain(block.replace(/^[-*]\s+/gm, "• "));
    if (paragraphs.length > 0 && (row || length + text.length > 420)) break;
    paragraphs.push(
      text.length > 600
        ? `${text.slice(0, 420).replace(/[^.!?]*$/, "")} …`
        : text,
    );
    length += text.length;
    if (paragraphs.length >= 3) break;
  }
  if (row) paragraphs.push(row.join(": "));
  return { title, paragraphs };
}

// Finds terms' words in text: whole words, longest first, matched as written.
export function termFinder(
  terms: readonly TermEntry[],
): (text: string) => { index: number; word: string; term: TermEntry }[] {
  const byWord = new Map<string, TermEntry>();
  for (const term of terms) {
    for (const word of term.words)
      if (!byWord.has(word)) byWord.set(word, term);
  }
  const words = [...byWord.keys()].sort((a, b) => b.length - a.length);
  if (words.length === 0) return () => [];
  const pattern = new RegExp(
    `(?<![\\w-])(?:${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`,
    "g",
  );
  return (text) =>
    [...text.matchAll(pattern)].flatMap((match) => {
      const term = byWord.get(match[0]);
      return term ? [{ index: match.index, word: match[0], term }] : [];
    });
}
