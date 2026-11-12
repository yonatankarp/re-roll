import type { ParsedImport } from "#sdk";
import {
  abilitiesIn,
  blockText,
  bodyOf,
  camelCase,
  type Heading,
  headingsIn,
  headingsUnder,
  knownId,
} from "./book.ts";
import { plainText, slugOf } from "./spells.ts";

function labelled(body: string, label: string): string {
  const open = `<strong>${label}:</strong>`;
  const start = body.indexOf(open);
  if (start < 0) return "";
  const from = start + open.length;
  return plainText(body.slice(from, body.indexOf("</p>", from)));
}

interface SpeciesSection {
  readonly name: string;
  readonly intro: string;
  readonly traits: string;
  readonly rest: string;
}

// Found by its "X Traits" heading under a heading named X, wherever a book puts its species.
function speciesSections(html: string): readonly SpeciesSection[] {
  const headings = headingsIn(html);
  return headings.flatMap((heading) => {
    const name = /^(.*) Traits$/.exec(heading.title)?.[1];
    const parent = headings.findLast(
      (item) => item.start < heading.start && item.tag < heading.tag,
    );
    const traits = bodyOf(html, headings, heading);
    if (
      name === undefined ||
      parent?.title !== name ||
      !traits.includes("<strong>Creature Type:</strong>")
    ) {
      return [];
    }
    const body = bodyOf(html, headings, parent);
    return [
      {
        name,
        intro: html.slice(parent.end, heading.start),
        traits,
        // Anything printed after the traits, such as a table of origins.
        rest: body.slice(heading.end + traits.length - parent.end),
      },
    ];
  });
}

export function parseSpeciesFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  return speciesSections(html).map(({ name, intro, traits, rest }) => {
    const slug = slugOf(name);
    const sizeText = labelled(traits, "Size");
    const sizes = [...sizeText.matchAll(/\b(Tiny|Small|Medium|Large)\b/g)].map(
      (match) => (match[1] ?? "").toLowerCase(),
    );
    const isChoice = new Set(sizes).size > 1;
    return {
      slug,
      // shortcut: a choice of size stores the first one listed, like the srd52 Human, and text keeps the printed line.
      notes: isChoice ? [`size is a choice, stored as ${sizes[0] ?? ""}`] : [],
      entry: {
        id: `${pluginId}:species/${slug}`,
        name,
        // Some books go straight from a species' name to its traits, so the name is the fallback.
        text:
          [
            blockText(intro),
            ...(isChoice ? [`Size: ${sizeText}`] : []),
            blockText(rest),
          ]
            .filter(Boolean)
            .join("\n") || name,
        creatureType: labelled(traits, "Creature Type"),
        size: sizes[0],
        speed: Number(/\d+/.exec(labelled(traits, "Speed"))?.[0]),
        traits: traitsIn(traits).map(
          (trait) => `${pluginId}:feature/${slug}-${slugOf(trait.name)}`,
        ),
      },
    };
  });
}

function traitsIn(
  html: string,
): readonly { readonly name: string; readonly text: string }[] {
  const italic = [
    ...html.matchAll(/<p\b[^>]*>\s*<strong><em>([\s\S]*?)<\/em><\/strong>/g),
  ];
  // Plain bold labels sub-options in most books, so it only names traits in a section with no bold italics.
  const labels =
    italic.length > 0
      ? italic
      : [...html.matchAll(/<p\b[^>]*>\s*<strong>([^<]*\.)<\/strong>/g)];
  return labels.map((label, index) => ({
    name: plainText(label[1] ?? "").replace(/\.$/, ""),
    text: blockText(
      `<p>${html.slice(label.index + label[0].length, labels[index + 1]?.index ?? html.length)}`,
    ),
  }));
}

// Mechanics only for a trait whose whole text is one of these sentences, so nothing it says is left out.
function traitMechanics(text: string): object {
  const resisted =
    /^You have Resistance to (\w+) damage(?: and (\w+) damage)?\.$/.exec(text);
  if (resisted) {
    return {
      automation: "full",
      passives: resisted.slice(1).flatMap((type) =>
        type
          ? [
              {
                kind: "modifier",
                modifier: { kind: "resistance", damage: type.toLowerCase() },
              },
            ]
          : [],
      ),
    };
  }
  const tougher =
    /^Your Hit Point maximum increases by (\d+), and it increases by \1 again whenever you gain a level\.$/.exec(
      text,
    );
  if (tougher) {
    const level = { kind: "level" };
    return {
      automation: "full",
      passives: [
        {
          kind: "modifier",
          modifier: {
            kind: "bonus",
            to: "maxHp",
            amount: {
              bonus: { add: Array<object>(Number(tougher[1])).fill(level) },
            },
          },
        },
      ],
    };
  }
  return { automation: "text" };
}

export function parseSpeciesTraits(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  return speciesSections(html).flatMap(({ name, traits }) =>
    traitsIn(traits).map((trait) => {
      const slug = `${slugOf(name)}-${slugOf(trait.name)}`;
      return {
        slug,
        notes: [],
        entry: {
          id: `${pluginId}:feature/${slug}`,
          name: trait.name,
          text: trait.text,
          ...traitMechanics(trait.text),
        },
      };
    }),
  );
}

// Every background prints its ability scores in a label, which also tells it apart from a mere list of them.
const ABILITY_LABEL = /<strong>Ability Scores?:<\/strong>/g;

export function parseBackgroundsFromHtml(
  html: string,
  pluginId: string,
  knownIds?: readonly string[],
): readonly ParsedImport[] {
  const headings = headingsIn(html);
  const ownFeats = parseFeatsFromHtml(html, pluginId);
  return [...html.matchAll(ABILITY_LABEL)].flatMap((match) => {
    const heading = headings.findLast((item) => item.start < match.index);
    if (!heading) return [];
    const body = bodyOf(html, headings, heading);
    const slug = slugOf(heading.title);
    const feat = labelled(body, "Feat");
    const [, first = feat, alternative] =
      /^(.*?) or (?:an? )?(.*?)(?: \(see .*)?$/.exec(feat) ?? [];
    const featChoice =
      /^[^(]*\((?!see )([^)]*)\)/.exec(feat)?.[1] ?? alternative;
    const named = slugOf(first.split("(")[0] ?? "");
    // shortcut: a background holds one feat, so "any Dark Gift" stores the first one, until backgrounds can offer a choice.
    const anyOfKind = first.includes("Dark Gift")
      ? ownFeats.find(
          (item) =>
            (item.entry as { readonly category: string }).category ===
            "darkGift",
        )?.slug
      : undefined;
    const featSlug = anyOfKind ?? named;
    return [
      {
        slug,
        notes: [
          ...(featChoice ? [`feat option not held: ${featChoice}`] : []),
          ...(anyOfKind ? ["feat is a choice of Dark Gift"] : []),
        ],
        entry: {
          id: `${pluginId}:background/${slug}`,
          name: heading.title,
          abilities: abilitiesIn(
            labelled(body, "Ability Scores") || labelled(body, "Ability Score"),
          ),
          feat:
            (ownFeats.some((item) => item.slug === featSlug)
              ? undefined
              : knownId(knownIds ?? [], "feat", featSlug)) ??
            `${pluginId}:feat/${featSlug}`,
          skills: labelled(body, "Skill Proficiencies")
            .split(/\s+and\s+|,\s*/)
            .map(camelCase),
          tool: labelled(body, "Tool Proficiency")
            .replace(/\s*\(see [^)]*\)/, "")
            .trim(),
        },
      },
    ];
  });
}

const FEAT_CATEGORIES: Readonly<Record<string, string>> = {
  Origin: "origin",
  General: "general",
  "Fighting Style": "fightingStyle",
  "Epic Boon": "epicBoon",
  "Dark Gift": "darkGift",
  Dragonmark: "dragonmark",
};
const FEAT_LINE =
  /^(Origin|General|Fighting Style|Epic Boon|Dark Gift|Dragonmark) Feat\b/;
const FIRST_PARAGRAPH =
  /^\s*(?:<figure\b[\s\S]*?<\/figure>\s*)?<p\b[^>]*>([\s\S]*?)<\/p>/;

// The line under a feat's name says what it is, however a book arranges its chapters.
export function parseFeatsFromHtml(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  const headings = headingsIn(html);
  const feat = (heading: Heading, category: string | undefined) => {
    const slug = slugOf(heading.title);
    return {
      slug,
      notes: [],
      entry: {
        id: `${pluginId}:feat/${slug}`,
        name: heading.title,
        category,
        text: blockText(bodyOf(html, headings, heading)),
        // Its mechanics live in a feature of the same text, encoded like a class feature's.
        grants: [`${pluginId}:feature/feat-${slug}`],
      },
    };
  };
  return [
    ...headings.flatMap((heading) => {
      const [, kind] =
        FEAT_LINE.exec(
          plainText(FIRST_PARAGRAPH.exec(html.slice(heading.end))?.[1] ?? ""),
        ) ?? [];
      return kind ? [feat(heading, FEAT_CATEGORIES[kind])] : [];
    }),
    // 2014 books have a chapter of racial feats and no line saying what each one is. No level asks for this category,
    // so these never join a character's choices.
    ...headings
      .filter(
        (heading) =>
          heading.tag === 1 && heading.title.endsWith("Racial Feats"),
      )
      .flatMap((chapter) => headingsUnder(headings, chapter))
      .filter((heading) => heading.tag === 3)
      .map((heading) => feat(heading, "racial")),
  ];
}

// The feature each feat grants, printed text only, as a class feature starts out.
export function parseFeatFeatures(
  html: string,
  pluginId: string,
): readonly ParsedImport[] {
  return parseFeatsFromHtml(html, pluginId).map(({ slug, entry }) => {
    const { name, text } = entry as {
      readonly name: string;
      readonly text: string;
    };
    return {
      slug: `feat-${slug}`,
      notes: [],
      entry: {
        id: `${pluginId}:feature/feat-${slug}`,
        name,
        text,
        automation: "text",
      },
    };
  });
}
