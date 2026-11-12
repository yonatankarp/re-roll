// The background sound a scene asks for. A scene can name one, or "none" for quiet; otherwise
// a few words in its text pick one, so adventures sound right without being marked up.

export const AMBIENCES = [
  "wind",
  "cave",
  "town",
  "rain",
  "storm",
  "campfire",
  "none",
] as const;
export type Ambience = (typeof AMBIENCES)[number];

// In order of precedence when two match equally: weather drowns out the place.
const KEYWORDS: readonly (readonly [Ambience, RegExp])[] = [
  ["storm", /\b(storms?|stormy|thunder\w*|lightning|gales?|tempests?)\b/gi],
  ["rain", /\b(rain\w*|drizzl\w*|downpour)\b/gi],
  [
    "cave",
    /\b(caves?|caverns?|cavernous|tunnels?|dungeons?|crypts?|tombs?|underground|mines?|grottos?|catacombs?|cellars?|sewers?|vaults?|lairs?|underdark)\b/gi,
  ],
  [
    "town",
    /\b(taverns?|inns?|towns?|villages?|markets?|marketplace|city|cities|streets?|crowds?|crowded|alehouses?|festivals?|innkeeper|patrons?)\b/gi,
  ],
  ["campfire", /\b(campfires?|camp|bonfire|hearth)\b/gi],
  [
    "wind",
    /\b(forests?|woods?|woodland|roads?|trails?|paths?|hills?|moors?|fields?|winds?|windswept|plains?|mountains?|cliffs?|shores?|coast\w*|beach\w*|sea|meadows?|ridges?|valleys?|outdoors|wilderness)\b/gi,
  ],
];

export function guessAmbience(text: string): Ambience {
  let best: Ambience = "none";
  let most = 0;
  for (const [ambience, pattern] of KEYWORDS) {
    const count = text.match(pattern)?.length ?? 0;
    if (count > most) {
      best = ambience;
      most = count;
    }
  }
  return best;
}

export function sceneAmbience(
  chosen: Ambience | undefined,
  text: string,
): Ambience {
  return chosen ?? guessAmbience(text);
}
