import {
  type ContentAccess,
  type SystemContext,
  type SystemResult,
  awaitDecision,
  frameHandler,
} from "#sdk";
import { z } from "zod";
import {
  type Draft,
  DraftSchema,
  NameSchema,
  STANDARD_ARRAY,
  type Step,
  abilityPriority,
  backgroundIncreaseStep,
  classStep,
  finishedCharacter,
  namedContent,
} from "./character.ts";
import {
  ABILITIES,
  type Ability,
  type AbilityScores,
  BackgroundSchema,
  type ClassDef,
  ClassSchema,
  SKILL_ABILITIES,
  type Skill,
  SpeciesSchema,
} from "./schemas.ts";
import { type DndState, NS, dndEvent, frame } from "./state.ts";

// Making a character on one sheet that is always complete: every part starts on the recommended choice, and the
// player changes only what they want. Each change is an answer to the sheet's one decision, so saves replay it.

type Context = SystemContext<DndState>;

export const SECTIONS = [
  "species",
  "class",
  "background",
  "abilities",
  "skills",
  "name",
  "review",
] as const;
export type Section = (typeof SECTIONS)[number];
export const METHODS = ["standard", "pointBuy"] as const;

export const SheetSchema = z.strictObject({
  draft: DraftSchema, // always complete, with `base` set and `scores` empty
  method: z.enum(METHODS),
  at: z.enum(SECTIONS), // the part the player is looking at
});
export type Sheet = z.infer<typeof SheetSchema>;
export const SheetStepSchema = z.object({
  actor: z.string(),
  sheet: SheetSchema,
});
const SheetAnswerSchema = SheetStepSchema.extend({ answer: z.string() });

export const ACCEPT = "accept";
export const NEXT = "next";
export const READY_PREFIX = "ready:";
export const BUILD_YOURSELF = "build";
export const SHEET_KEY = "sheet";
// Typed changes are short, such as "pick:1:skills=athletics|perception".
const CHANGE_LENGTH = 300;

export const POINT_BUY_BUDGET = 27;
export const POINT_COST: Readonly<Record<number, number>> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

// A recommended species per class, chosen to match the class's own pictures. Any species is as strong.
const SPECIES_FOR: Readonly<Record<string, string>> = {
  barbarian: "goliath",
  bard: "tiefling",
  cleric: "elf",
  druid: "orc",
  fighter: "dwarf",
  monk: "dragonborn",
  paladin: "human",
  ranger: "human",
  rogue: "elf",
  sorcerer: "elf",
  warlock: "tiefling",
  wizard: "human",
};
const HERO_NAMES: Readonly<Record<string, string>> = {
  barbarian: "Grenna Stormhide",
  bard: "Velis Ashsong",
  cleric: "Aelar Dawnward",
  druid: "Mogra Thornroot",
  fighter: "Bruni Ironhold",
  monk: "Kesh Emberpalm",
  paladin: "Tamsin Hale",
  ranger: "Wren Ashby",
  rogue: "Sylas Quickstep",
  sorcerer: "Nym Starfire",
  warlock: "Kallista Vex",
  wizard: "Edric Quill",
};
// Picks a newcomer gets the most from, by slug, best first. Anything else follows in the order offered.
const SPELL_ORDER = [
  "fire-bolt",
  "eldritch-blast",
  "sacred-flame",
  "toll-the-dead",
  "vicious-mockery",
  "produce-flame",
  "starry-wisp",
  "sorcerous-burst",
  "ray-of-frost",
  "shillelagh",
  "guidance",
  "mind-sliver",
  "shocking-grasp",
  "light",
  "mage-hand",
  "minor-illusion",
  "magic-missile",
  "cure-wounds",
  "healing-word",
  "guiding-bolt",
  "bless",
  "shield",
  "sleep",
  "hex",
  "hunters-mark",
  "thunderwave",
  "burning-hands",
  "chromatic-orb",
  "faerie-fire",
  "entangle",
  "shield-of-faith",
  "mage-armor",
  "dissonant-whispers",
  "detect-magic",
];
const FEAT_ORDER = [
  "defense",
  "alert",
  "tough",
  "lucky",
  "skilled",
  "healer",
  "savage-attacker",
  "magic-initiate",
];
const SKILL_ORDER: readonly Skill[] = [
  "perception",
  "stealth",
  "athletics",
  "insight",
  "persuasion",
  "arcana",
  "investigation",
  "survival",
  "acrobatics",
  "medicine",
  "deception",
  "intimidation",
  "religion",
  "nature",
  "history",
  "sleightOfHand",
  "animalHandling",
  "performance",
];

export function slugOf(id: string): string {
  return id.split("/").pop() ?? id;
}

function orderIn(list: readonly string[], item: string): number {
  const index = list.indexOf(item);
  return index < 0 ? list.length : index;
}

// The pick the sheet starts on for a step. Always the same for the same options, so the preview is the build.
export function recommend(step: Step, classDef: ClassDef): string {
  const priority = abilityPriority(classDef);
  const preferred = (id: string): number => {
    const index = step.prefer?.indexOf(id) ?? -1;
    return index < 0 ? 99 : index;
  };
  const rank = (id: string, index: number): number => {
    if (id.includes(":spell/")) {
      const works = step.prefer?.includes(id) ?? false;
      return (works ? 0 : 1) * 1e6 + orderIn(SPELL_ORDER, slugOf(id)) * 1e3;
    }
    const kind = id.includes(":feat/")
      ? orderIn(FEAT_ORDER, slugOf(id))
      : id in SKILL_ABILITIES
        ? priority.indexOf(SKILL_ABILITIES[id as Skill]) * 20 +
          orderIn(SKILL_ORDER, id)
        : 0;
    return preferred(id) * 1e6 + kind * 1e3 + index;
  };
  const [best] = step.options
    .map((option, index) => ({ id: option.id, rank: rank(option.id, index) }))
    .sort((a, b) => a.rank - b.rank);
  if (!best) throw new Error(`${step.key} has no options`);
  return best.id;
}

// The standard array, highest first, by what the class needs most. It costs exactly the point-buy budget too.
export function recommendedScores(classDef: ClassDef): AbilityScores {
  const priority = abilityPriority(classDef);
  return Object.fromEntries(
    ABILITIES.map((ability) => [
      ability,
      STANDARD_ARRAY[priority.indexOf(ability)] ?? 8,
    ]),
  ) as AbilityScores;
}

export function pointsSpent(scores: AbilityScores): number | null {
  let spent = 0;
  for (const ability of ABILITIES) {
    const cost = POINT_COST[scores[ability]];
    if (cost === undefined) return null;
    spent += cost;
  }
  return spent;
}

export function validScores(
  scores: AbilityScores,
  method: Sheet["method"],
): boolean {
  if (method === "pointBuy") {
    const spent = pointsSpent(scores);
    return spent !== null && spent <= POINT_BUY_BUDGET;
  }
  const values = ABILITIES.map((ability) => scores[ability]).sort(
    (a, b) => b - a,
  );
  return values.every((value, index) => value === STANDARD_ARRAY[index]);
}

// The background that raises what the class needs most, and for a caster one whose feat brings more spells.
function recommendedBackground(classDef: ClassDef, access: ContentAccess) {
  const priority = abilityPriority(classDef);
  const worth = (abilities: readonly Ability[], feat: string): number =>
    (classDef.spellcasting && slugOf(feat).startsWith("magic-initiate")
      ? 20
      : 0) +
    abilities.reduce(
      (sum, ability) =>
        sum + (ABILITIES.length - priority.indexOf(ability)) ** 2,
      0,
    );
  let best: { id: string; worth: number } | null = null;
  for (const item of namedContent(access, "background", BackgroundSchema)) {
    const value = worth(item.abilities, item.feat);
    if (!best || value > best.worth) best = { id: item.id, worth: value };
  }
  return best?.id;
}

function offered(
  access: ContentAccess,
  kind: "class" | "species" | "background",
  id: string,
): boolean {
  const ids = (items: readonly { readonly id: string }[]) =>
    items.some((item) => item.id === id);
  if (kind === "class") return ids(namedContent(access, kind, ClassSchema));
  if (kind === "species") return ids(namedContent(access, kind, SpeciesSchema));
  return ids(namedContent(access, kind, BackgroundSchema));
}

export function heroName(draft: Draft, access: ContentAccess): string {
  const classes = namedContent(access, "class", ClassSchema);
  const species = namedContent(access, "species", SpeciesSchema);
  const classDef = classes.find((item) => item.id === draft.classId);
  const own = classDef && HERO_NAMES[slugOf(classDef.id)];
  if (own) return own;
  const speciesName = species.find((item) => item.id === draft.speciesId)?.name;
  return `${speciesName ?? ""} ${classDef?.name ?? "Hero"}`.trim();
}

// Fills whatever the draft leaves out, or no longer allows, with the recommendation. Choices the draft makes are kept
// while the rules still offer them, so changing the species keeps the class's skills.
export function completeDraft(
  draft: Draft,
  method: Sheet["method"],
  access: ContentAccess,
): Draft {
  const classes = namedContent(access, "class", ClassSchema);
  const classDef =
    classes.find((item) => item.id === draft.classId) ??
    classes.find((item) => slugOf(item.id) === "fighter") ??
    classes[0];
  if (!classDef) throw new Error("There are no classes to build a character");
  const speciesList = namedContent(access, "species", SpeciesSchema);
  const species =
    speciesList.find((item) => item.id === draft.speciesId) ??
    speciesList.find(
      (item) => slugOf(item.id) === SPECIES_FOR[slugOf(classDef.id)],
    ) ??
    speciesList[0];
  const backgroundId =
    draft.backgroundId !== undefined &&
    offered(access, "background", draft.backgroundId)
      ? draft.backgroundId
      : recommendedBackground(classDef, access);
  if (!species || backgroundId === undefined) {
    throw new Error("There are no species or backgrounds to build a character");
  }
  const background = namedContent(access, "background", BackgroundSchema).find(
    (item) => item.id === backgroundId,
  );
  const increaseStep = backgroundIncreaseStep(
    background?.abilities ?? [],
    classDef,
  );
  const increase = increaseStep.options.some(
    (option) => option.id === draft.increase,
  )
    ? draft.increase
    : recommend(increaseStep, classDef);
  const base =
    draft.base && validScores(draft.base, method)
      ? draft.base
      : recommendedScores(classDef);
  let filled: Draft = {
    classId: classDef.id,
    speciesId: species.id,
    backgroundId,
    scores: [],
    increase,
    picks: {},
    base,
    ...(draft.name === undefined ? {} : { name: draft.name }),
  };
  for (
    let step = classStep(filled, null, access);
    step;
    step = classStep(filled, null, access)
  ) {
    const options = new Set(step.options.map((option) => option.id));
    const used = filled.picks[step.slot ?? ""] ?? [];
    const wanted = (draft.picks[step.slot ?? ""] ?? []).find(
      (id) => options.has(id) && !used.includes(id),
    );
    filled = step.apply(filled, wanted ?? recommend(step, classDef));
  }
  return filled;
}

function completeSheet(sheet: Sheet, access: ContentAccess): Sheet {
  return { ...sheet, draft: completeDraft(sheet.draft, sheet.method, access) };
}

function parseScores(text: string): AbilityScores | null {
  const scores: Partial<Record<Ability, number>> = {};
  for (const part of text.split(",")) {
    const [ability, value] = part.split("=");
    const parsed = z.enum(ABILITIES).safeParse(ability);
    if (!parsed.success || !/^\d{1,2}$/.test(value ?? "")) return null;
    scores[parsed.data] = Number(value);
  }
  return ABILITIES.every((ability) => scores[ability] !== undefined)
    ? (scores as AbilityScores)
    : null;
}

export function encodeScores(scores: AbilityScores): string {
  return ABILITIES.map(
    (ability) => `${ability}=${String(scores[ability])}`,
  ).join(",");
}

function without(draft: Draft, keys: readonly (keyof Draft)[]): Draft {
  return Object.fromEntries(
    Object.entries(draft).filter(([key]) => !keys.includes(key as keyof Draft)),
  ) as Draft;
}

// A change the player typed or clicked. Anything the rules don't allow leaves the sheet as it was.
export function changeSheet(
  sheet: Sheet,
  answer: string,
  access: ContentAccess,
): Sheet {
  if (answer === NEXT) {
    const at = SECTIONS[SECTIONS.indexOf(sheet.at) + 1] ?? "review";
    return { ...sheet, at };
  }
  const colon = answer.indexOf(":");
  if (colon < 0) return sheet;
  const kind = answer.slice(0, colon);
  const value = answer.slice(colon + 1);
  const { draft } = sheet;
  const changed = (next: Partial<Draft>, method = sheet.method): Sheet =>
    completeSheet({ ...sheet, method, draft: { ...draft, ...next } }, access);
  switch (kind) {
    case "at": {
      const at = z.enum(SECTIONS).safeParse(value);
      return at.success ? { ...sheet, at: at.data } : sheet;
    }
    case "species":
      return offered(access, "species", value)
        ? changed({ speciesId: value })
        : sheet;
    case "class": {
      if (!offered(access, "class", value)) return sheet;
      // A new class wants its own scores and increase. A species or background still on the old class's suggestion
      // follows the new one; one the player picked stays, as does the rest while the rules allow it.
      const before = completeDraft(
        { classId: draft.classId, scores: [], picks: {} },
        "standard",
        access,
      );
      const drop: (keyof Draft)[] = ["base", "increase"];
      if (draft.speciesId === before.speciesId) drop.push("speciesId");
      if (draft.backgroundId === before.backgroundId) drop.push("backgroundId");
      return completeSheet(
        { ...sheet, draft: { ...without(draft, drop), classId: value } },
        access,
      );
    }
    case "background": {
      if (!offered(access, "background", value)) return sheet;
      return completeSheet(
        {
          ...sheet,
          draft: { ...without(draft, ["increase"]), backgroundId: value },
        },
        access,
      );
    }
    case "method": {
      const method = z.enum(METHODS).safeParse(value);
      if (!method.success) return sheet;
      return completeSheet(
        { ...sheet, method: method.data, draft: without(draft, ["base"]) },
        access,
      );
    }
    case "scores": {
      const scores = parseScores(value);
      return scores && validScores(scores, sheet.method)
        ? changed({ base: scores })
        : sheet;
    }
    case "increase":
      return changed({ increase: value });
    case "pick": {
      const equals = value.indexOf("=");
      if (equals < 1) return sheet;
      const slot = value.slice(0, equals);
      const picks = value
        .slice(equals + 1)
        .split("|")
        .filter(Boolean);
      return changed({ picks: { ...draft.picks, [slot]: picks } });
    }
    case "name": {
      const name = NameSchema.safeParse(value);
      return name.success && name.data === value
        ? { ...sheet, draft: { ...draft, name: value } }
        : sheet;
    }
    default:
      return sheet;
  }
}

// Where a new hero begins: a ready hero of one class goes straight to the review, building it yourself to the start.
export function startSheet(
  answer: string,
  access: ContentAccess,
): Sheet | null {
  const ready = answer.startsWith(READY_PREFIX)
    ? answer.slice(READY_PREFIX.length)
    : null;
  if (ready !== null && !offered(access, "class", ready)) return null;
  if (ready === null && answer !== BUILD_YOURSELF) return null;
  return completeSheet(
    {
      method: "standard",
      at: ready === null ? "species" : "review",
      draft: {
        ...(ready === null ? {} : { classId: ready }),
        scores: [],
        picks: {},
      },
    },
    access,
  );
}

// Offered beside the adventure's own heroes: one ready hero per class, and building one yourself.
export function heroOptions(access: ContentAccess) {
  return [
    ...namedContent(access, "class", ClassSchema).map((item) => ({
      id: `${READY_PREFIX}${item.id}`,
      label: `Ready hero: ${item.name}`,
    })),
    { id: BUILD_YOURSELF, label: "Build a hero yourself" },
  ];
}

export function beginSheet(
  actor: string,
  answer: string,
  access: ContentAccess,
): SystemResult | null {
  const sheet = startSheet(answer, access);
  return sheet ? { frames: [frame("sheetStep", { actor, sheet })] } : null;
}

function runSheetStep(payload: z.infer<typeof SheetStepSchema>): SystemResult {
  const { actor, sheet } = payload;
  const accept = { id: ACCEPT, label: "Begin the adventure" };
  return {
    frames: [
      awaitDecision({
        id: `${NS}:build:${actor}:${SHEET_KEY}`,
        actor,
        prompt: "Make your hero.",
        options:
          sheet.at === "review"
            ? [accept]
            : [{ id: NEXT, label: "Next" }, accept],
        resume: frame("sheetAnswer", payload),
        text: { label: "Change", maxLength: CHANGE_LENGTH },
        revisable: true,
      }),
    ],
  };
}

function runSheetAnswer(
  payload: z.infer<typeof SheetAnswerSchema>,
  context: Context,
): SystemResult {
  const { actor, sheet, answer } = payload;
  if (answer !== ACCEPT) {
    return {
      frames: [
        frame("sheetStep", {
          actor,
          sheet: changeSheet(sheet, answer, context),
        }),
      ],
    };
  }
  const draft = completeDraft(sheet.draft, sheet.method, context);
  const name = draft.name ?? heroName(draft, context);
  const built = finishedCharacter(actor, name, draft, context);
  if (built.source.kind !== "character" || !built.source.build) {
    throw new Error("A new character has no build");
  }
  return {
    events: [
      dndEvent(`${NS}:characterChosen`, {
        actor,
        name,
        build: built.source.build,
        inventory: built.inventory,
        hp: built.hp,
      }),
    ],
  };
}

export const sheetFrames = {
  [`${NS}:sheetStep`]: frameHandler({
    schema: SheetStepSchema,
    run: (payload) => runSheetStep(payload),
  }),
  [`${NS}:sheetAnswer`]: frameHandler({
    schema: SheetAnswerSchema,
    run: runSheetAnswer,
  }),
};

export interface SheetSlot {
  readonly slot: string;
  readonly prompt: string; // the first step's, such as "Choose a skill (1 of 2)."
  readonly options: Step["options"]; // as its first pick sees them
  readonly count: number;
}

// The picks a complete draft holds, in the order the rules ask them, with what each could be instead.
export function sheetSlots(draft: Draft, access: ContentAccess): SheetSlot[] {
  const slots = new Map<string, SheetSlot>();
  let walked: Draft = { ...draft, picks: {} };
  for (
    let step = classStep(walked, null, access);
    step;
    step = classStep(walked, null, access)
  ) {
    const slot = step.slot ?? "";
    const known = slots.get(slot);
    slots.set(
      slot,
      known
        ? { ...known, count: known.count + 1 }
        : { slot, prompt: step.prompt, options: step.options, count: 1 },
    );
    const pick = draft.picks[slot]?.[walked.picks[slot]?.length ?? 0];
    if (pick === undefined) break;
    walked = step.apply(walked, pick);
  }
  return [...slots.values()];
}
