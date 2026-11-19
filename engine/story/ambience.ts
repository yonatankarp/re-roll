// The background sound a scene asks for. A scene can name one, or "none" for quiet; otherwise
// a few words in its text pick one, so adventures sound right without being marked up.

export const AMBIENCES = [
  "wind",
  "cave",
  "town",
  "rain",
  "storm",
  "campfire",
  "sea",
  "swamp",
  "temple",
  "interior",
  "none",
] as const;
export type Ambience = (typeof AMBIENCES)[number];

// In order of precedence when two match equally: weather drowns out the place.
const KEYWORDS: readonly (readonly [Ambience, RegExp])[] = [
  ["storm", /\b(storms?|stormy|thunder\w*|lightning|gales?|tempests?)\b/gi],
  ["rain", /\b(rain\w*|drizzl\w*|downpour)\b/gi],
  [
    "sea",
    /\b(seas?|ocean\w*|waves?|ships?|deck|harbou?rs?|docks?|piers?|boats?|sail\w*|shores?|coast\w*|beach\w*|tides?|islands?|isles?|surf|bay)\b/gi,
  ],
  [
    "swamp",
    /\b(swamps?|marsh\w*|bogs?|fens?|mires?|bayous?|wetlands?|reeds|frogs?|quagmire)\b/gi,
  ],
  [
    "cave",
    /\b(caves?|caverns?|cavernous|tunnels?|dungeons?|crypts?|tombs?|underground|mines?|grottos?|catacombs?|cellars?|sewers?|vaults?|lairs?|underdark|quarry|rubble)\b/gi,
  ],
  [
    "temple",
    /\b(temples?|shrines?|altars?|chapels?|church\w*|cathedrals?|sanctum|sanctuary|monaster\w*|abbey|rituals?|dais|sarcophag\w*|statues?|runes?|priests?|priestess\w*|holy|unholy)\b/gi,
  ],
  [
    "town",
    /\b(taverns?|inns?|towns?|villages?|markets?|marketplace|city|cities|streets?|crowds?|crowded|alehouses?|festivals?|innkeeper|patrons?)\b/gi,
  ],
  ["campfire", /\b(campfires?|camp|bonfire|hearth)\b/gi],
  [
    "wind",
    /\b(forests?|woods?|woodland|roads?|trails?|paths?|hills?|moors?|fields?|winds?|windswept|plains?|mountains?|cliffs?|meadows?|ridges?|valleys?|outdoors|wilderness|sky|desert|dunes?|sand)\b/gi,
  ],
  [
    "interior",
    /\b(rooms?|chambers?|halls?|hallways?|corridors?|offices?|desks?|library|libraries|towers?|fortress\w*|keeps?|castles?|manors?|mansions?|houses?|lounges?|laborator\w*|bedrooms?|stair\w*|upstairs|shops?|study|kitchens?|furniture|shelves|bookshelves|lift|elevators?|workshops?|parlou?rs?|cabins?|barracks|throne)\b/gi,
  ],
];

// Walls, floors and doors say "indoors" only when nothing else in the text says where.
const INDOORS =
  /\b(floors?|walls?|doors?|doorways?|ceilings?|tables?|windows?)\b/i;

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
  return best === "none" && INDOORS.test(text) ? "interior" : best;
}

// What a scene names, else what its text suggests, else `place`: where the story was before it.
export function sceneAmbience(
  chosen: Ambience | undefined,
  text: string,
  place: Ambience = "none",
): Ambience {
  const guess = chosen ?? guessAmbience(text);
  return chosen === undefined && guess === "none" ? place : guess;
}

interface SceneLike {
  readonly id: string;
  readonly text: string;
  readonly ambience?: Ambience | undefined;
  readonly choices: readonly (
    | {
        readonly effects: readonly {
          readonly kind: string;
          readonly scene?: string;
        }[];
      }
    | {
        readonly results: Record<
          string,
          readonly { readonly kind: string; readonly scene?: string }[]
        >;
      }
  )[];
}

const places = new WeakMap<object, ReadonlyMap<string, Ambience>>();

// Each scene's sound, where one whose text names no place takes the sound of a scene that leads to
// it, since talk goes on where it began. Worked out once per adventure.
export function placeAmbience(adventure: {
  readonly scenes: readonly SceneLike[];
}): ReadonlyMap<string, Ambience> {
  const known = places.get(adventure);
  if (known) return known;
  const sound = new Map(
    adventure.scenes.map((scene) => [
      scene.id,
      scene.ambience ?? guessAmbience(scene.text),
    ]),
  );
  const open = new Set(
    adventure.scenes
      .filter(
        (scene) =>
          scene.ambience === undefined && sound.get(scene.id) === "none",
      )
      .map((scene) => scene.id),
  );
  // Passes until nothing changes, so a run of such scenes all carry the place they began in.
  for (let changed = true; changed;) {
    changed = false;
    for (const scene of adventure.scenes) {
      const from = sound.get(scene.id) ?? "none";
      if (from === "none") continue;
      for (const choice of scene.choices) {
        const effects =
          "effects" in choice
            ? choice.effects
            : Object.values(choice.results).flat();
        for (const effect of effects) {
          if (
            effect.kind !== "goto" ||
            !effect.scene ||
            !open.has(effect.scene)
          )
            continue;
          open.delete(effect.scene);
          sound.set(effect.scene, from);
          changed = true;
        }
      }
    }
  }
  places.set(adventure, sound);
  return sound;
}
