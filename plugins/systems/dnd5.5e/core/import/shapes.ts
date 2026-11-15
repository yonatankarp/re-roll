import type { LeafEffect, Monster } from "../schemas.ts";

// A stat block's own shapes, read from its plain-text lines (as the stored `text` keeps them): the Shape-Shift entry
// names them, "(Wolf or Hybrid Form Only)" labels gate actions and traits, and the Speed line and the entry give
// each shape's Speed.

type Shape = NonNullable<Monster["shapes"]>[number];
type Speeds = NonNullable<Shape["speeds"]>;

const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const SIZE = /\b(Tiny|Small|Medium|Large|Huge|Gargantuan)\b/gi;
const MODES = ["fly", "swim", "climb", "burrow"] as const;

const nameOf = (text: string): string => text.trim().toLowerCase();

// "Bite (Wolf or Hybrid Form Only)" or "Magic Allergy (Individual Form Only; 1/Day)": the shapes it's printed for.
export function formsOnly(label: string): readonly string[] | undefined {
  const forms = /\(([^();]+?) Forms? Only\b/i.exec(label)?.[1];
  return forms?.split(/,\s*(?:or\s+)?|\s+or\s+/).map(nameOf);
}

// "a Large wolf-humanoid hybrid" is the hybrid, "a Medium cloud of mist" the mist, "a humanoid form" the humanoid.
function itemName(item: string): string {
  const words = item
    .replace(/\(.*$/, "")
    .replace(/\b(?:form|it represents|of (?:its|his|her) size)\b/gi, "")
    .trim()
    .split(/[\s\-–]+/);
  return nameOf(words.at(-1) ?? "");
}

function largest(text: string): Shape["size"] {
  const found = [...text.matchAll(SIZE)].map((match) => nameOf(match[1] ?? ""));
  const index = Math.max(-1, ...found.map((size) => SIZES.indexOf(size)));
  return index < 0 ? undefined : (SIZES[index] as Shape["size"]);
}

// "(Speed 5 ft., Fly Speed 30 ft.)", "(20 ft., Fly 60 ft.)" or "(Speed 20 ft.)".
function inlineSpeeds(item: string): Speeds | undefined {
  const inside = /\(([^)]*\d+ ft\.[^)]*)\)/.exec(item)?.[1];
  const walk = inside && /^(?:Speed )?(\d+) ft\./.exec(inside.trim())?.[1];
  if (!inside || !walk) return undefined;
  const speeds: Speeds = { walk: Number(walk) };
  for (const mode of MODES) {
    const feet = new RegExp(`\\b${mode}(?: Speed)? (\\d+) ft`, "i").exec(
      inside,
    )?.[1];
    if (feet) speeds[mode] = Number(feet);
  }
  return speeds;
}

// The Speed line's parts: "40 ft. (wolf form only)" or "Climb 30 ft. (spider or hybrid form only)".
function speedParts(line: string): readonly {
  readonly mode: "walk" | (typeof MODES)[number];
  readonly feet: number;
  readonly forms?: readonly string[];
}[] {
  return [
    ...line
      .replace(/^Speed\s+/, "")
      .matchAll(/(?:(Fly|Swim|Climb|Burrow)\s+)?(\d+) ft\.(?: \(([^)]*)\))?/gi),
  ].map((match) => {
    const forms = match[3] ? formsOnly(`(${match[3]})`) : undefined;
    return {
      mode: (match[1]?.toLowerCase() ?? "walk") as "walk",
      feet: Number(match[2]),
      ...(forms ? { forms } : {}),
    };
  });
}

// The shapes a stat block's Shape-Shift entry names, true one first, with what each changes; null with no such entry
// or one this can't read.
export function shapesIn(
  lines: readonly string[],
  size: string | undefined,
): {
  readonly shapes: readonly Shape[];
  readonly cost: "action" | "bonusAction";
} | null {
  let section = "";
  let entry: string | undefined;
  let cost: "action" | "bonusAction" = "action";
  const vocabulary: string[] = [];
  let multiattack: readonly string[] | undefined;
  for (const line of lines) {
    if (
      /^(?:Traits|Actions|Bonus Actions?|Reactions|Legendary Actions)$/.test(
        line,
      )
    ) {
      section = line;
      continue;
    }
    const label = /^([^.]+?)\.\s/.exec(line)?.[1] ?? "";
    if (/^Shape-Shift$/.test(label)) {
      entry = line.slice(label.length + 1).trim();
      cost = section.startsWith("Bonus") ? "bonusAction" : "action";
    }
    const forms = formsOnly(label);
    if (forms) vocabulary.push(...forms);
    if (forms && /^Multiattack\b/.test(label)) multiattack = forms;
    if (/^Speed\s/.test(line)) {
      for (const part of speedParts(line))
        vocabulary.push(...(part.forms ?? []));
    }
  }
  if (!entry) return null;
  const list =
    /shape-shifts (?:in)?to(?: resemble)? (.*?),? (?:or (?:it |he |she )?)?(?:returns|back into)\b/i.exec(
      entry,
    )?.[1];
  if (!list) return null;
  const items = list
    .split(/,\s*(?:or\s+)?(?=(?:into )?an?\b)|\s+or\s+(?=(?:into )?an?\b)/i)
    .map((item) => item.replace(/^into\s+/i, ""))
    .filter((item) => /^an?\b/i.test(item));
  if (items.length === 0) return null;
  const others = items.map((item) => {
    const last = itemName(item);
    const name = vocabulary.includes(last)
      ? last
      : (vocabulary.find((word) =>
          new RegExp(`\\b${word}\\b`, "i").test(item.replace(/\(.*$/, "")),
        ) ?? last);
    return { name, item };
  });
  // "returns to its true humanoid form", "to its vampire form", "(that of a Small jackal)", or the one shape the
  // "Form Only" labels name that the entry doesn't.
  const that = /true form \(that of an? (\w+) ([\w-]+)\)/i.exec(entry);
  const named =
    /\b(?:returns|back) (?:in)?to (?:its|his|her) (?:true )?([\w-]+(?: [\w-]+)?) form\b/i.exec(
      entry,
    )?.[1];
  const trueName =
    (that?.[2] && nameOf(that[2])) ??
    (named && !/^true$/i.test(named) ? nameOf(named) : undefined) ??
    vocabulary.find((word) => !others.some(({ name }) => name === word)) ??
    "true";
  const speedLine = lines.find((line) => /^Speed\s/.test(line)) ?? "";
  const parts = speedParts(speedLine);
  const speedsFor = (name: string): Speeds => {
    const speeds: Speeds = { walk: 0 };
    for (const part of parts) {
      if (part.forms && !part.forms.includes(name)) continue;
      // A form's own walking Speed, as "40 ft. (wolf form only)", replaces the plain one.
      if (part.mode === "walk" && speeds.walk > 0 && !part.forms) continue;
      speeds[part.mode] = part.feet;
    }
    return speeds;
  };
  // "its Fly Speed is available only in its true form"
  const trueOnly = MODES.filter((mode) =>
    new RegExp(
      `its ${mode} Speed is available only in its true form`,
      "i",
    ).test(entry),
  );
  const shape = (name: string, item?: string): Shape => {
    const inline = item ? inlineSpeeds(item) : undefined;
    const speeds = Object.fromEntries(
      Object.entries(inline ?? speedsFor(name)).filter(
        ([mode]) => !item || !trueOnly.includes(mode as (typeof MODES)[number]),
      ),
    ) as Speeds;
    const shapeSize = item
      ? largest(item.replace(/\(.*$/, ""))
      : largest(that?.[1] ?? size ?? "");
    return {
      name,
      ...(shapeSize ? { size: shapeSize } : {}),
      speed: speeds.walk,
      speeds,
      passives: [],
      multiattack: !multiattack || multiattack.includes(name),
    };
  };
  return {
    shapes: [
      shape(trueName),
      ...others.map(({ name, item }) => shape(name, item)),
    ],
    cost,
  };
}

// One Shape-Shift action for each shape, so the monster's choice of shape is its choice of action.
export function shapeShiftActions(
  shapes: readonly Shape[],
  cost: "action" | "bonusAction",
): readonly {
  readonly name: string;
  readonly activation: {
    readonly cost: readonly ["action" | "bonusAction"];
    readonly targeting: { readonly self: true };
    readonly resolution: {
      readonly kind: "automatic";
      readonly damage: readonly [];
      readonly effects: readonly LeafEffect[];
    };
  };
}[] {
  return shapes.map(({ name }) => ({
    name: `Shape-Shift (${name})`,
    activation: {
      cost: [cost],
      targeting: { self: true },
      resolution: {
        kind: "automatic",
        damage: [],
        effects: [{ kind: "shapeShift", shape: name }],
      },
    },
  }));
}
