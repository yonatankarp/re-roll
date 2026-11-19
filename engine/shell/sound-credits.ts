// The bundled sounds' credits, as each folder's sounds/credits.json lists them, in words for the
// journal's About: one line per CC BY work, with its title, author, source and licence, as the
// licence asks, and one line for each CC0 pack, which asks for nothing but is owed thanks.

export interface SoundCredit {
  readonly file: string;
  readonly title: string;
  readonly author: string;
  readonly source: string;
  readonly licence: "CC0-1.0" | "CC-BY-3.0" | "CC-BY-4.0";
  readonly changes?: string;
}

export const SOUND_LICENCES: Readonly<Record<SoundCredit["licence"], string>> =
  {
    "CC0-1.0":
      "CC0 1.0 (public domain, https://creativecommons.org/publicdomain/zero/1.0/)",
    "CC-BY-3.0":
      "the Creative Commons Attribution 3.0 licence (https://creativecommons.org/licenses/by/3.0/)",
    "CC-BY-4.0":
      "the Creative Commons Attribution 4.0 licence (https://creativecommons.org/licenses/by/4.0/)",
  };

export function soundCredits(credits: readonly SoundCredit[]): string[] {
  const attributed = credits
    .filter((credit) => credit.licence !== "CC0-1.0")
    .map(
      (credit) =>
        `Audio: “${credit.title}” by ${credit.author}, from ${credit.source}, under ${SOUND_LICENCES[credit.licence]}${credit.changes ? `; ${credit.changes}` : ""}.`,
    );
  const packs = new Map<string, string>(); // source → author
  for (const credit of credits) {
    if (credit.licence === "CC0-1.0") packs.set(credit.source, credit.author);
  }
  const free = [...packs].map(
    ([source, author]) =>
      `Sounds from ${source} by ${author}, under ${SOUND_LICENCES["CC0-1.0"]}.`,
  );
  return [...attributed, ...free];
}
