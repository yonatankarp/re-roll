import { type ContentAccess, type Decision, PLAYER_ACTOR } from "#sdk";
import {
  BUILD_YOURSELF,
  POINT_BUY_BUDGET,
  POINT_COST,
  READY_PREFIX,
  SECTIONS,
  SHEET_KEY,
  type Section,
  type Sheet,
  SheetStepSchema,
  completeDraft,
  encodeScores,
  heroName,
  pointsSpent,
  sheetSlots,
  slugOf,
} from "../core/character-sheet.ts";
import {
  BACKGROUND_FEAT,
  type Draft,
  NAME_LENGTH,
  STANDARD_ARRAY,
  backgroundFeatOf,
  backgroundIncreaseStep,
  finishedCharacter,
  namedContent,
  parseIncrease,
} from "../core/character.ts";
import { CREATE_CHARACTER } from "../core/combat/ids.ts";
import {
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  type AbilityScores,
  BackgroundSchema,
  type ClassDef,
  ClassSchema,
  FeatSchema,
  SpeciesSchema,
  SpellSchema,
} from "../core/schemas.ts";
import { NS } from "../core/state.ts";
import { abilityModifier, deriveStats } from "../core/stats.ts";
import {
  backgroundChoice,
  classChoice,
  contentChoice,
  find,
  nameOf,
  pregenChoices,
  skillName,
  speciesChoice,
} from "./creation.ts";

// Matched by shape, as SystemUi is, so the plugin never imports the shell.
interface Choice {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  readonly detail?: string;
  readonly looks?: readonly string[];
  readonly answer?: string;
  readonly selected?: boolean;
  readonly recommended?: boolean;
}
interface Stat {
  readonly label: string;
  readonly value: string;
  readonly term?: string;
}

const TITLES: Readonly<Record<Section, string>> = {
  species: "Species",
  class: "Class",
  background: "Background",
  abilities: "Abilities",
  skills: "Skills & spells",
  name: "Name",
  review: "Review",
};

// One line on how each class plays, in our own words, for newcomers.
const PITCHES: Readonly<Record<string, string>> = {
  barbarian: "Shrugs off blows and hits back twice as hard.",
  bard: "Cheers friends on, talks foes down, and knows a spell for it.",
  cleric: "Heals the party and smites whatever threatens it.",
  druid: "Calls on nature's magic, and heals in a pinch.",
  fighter: "Tough, armored, and good with every weapon.",
  monk: "Quick fists and quicker feet.",
  paladin: "A holy knight who guards friends and smites foes.",
  ranger: "Strikes from afar and never loses a trail.",
  rogue: "Sneaks, picks locks, and strikes where it hurts.",
  sorcerer: "Born with magic, and blasts foes with it.",
  warlock: "Bargained for power, and hurls it from afar.",
  wizard: "Studied a spell for every problem.",
};

// How people like to play, and the classes that suit it, best first.
const STYLES: readonly {
  readonly label: string;
  readonly summary: string;
  readonly classes: readonly string[];
}[] = [
  {
    label: "Up close",
    summary: "In the thick of the fight.",
    classes: ["fighter", "barbarian", "paladin"],
  },
  {
    label: "From afar",
    summary: "Out of reach, with bow or blast.",
    classes: ["ranger", "warlock", "fighter"],
  },
  {
    label: "With magic",
    summary: "Spells that change the battle.",
    classes: ["wizard", "sorcerer", "warlock"],
  },
  {
    label: "Sneaky",
    summary: "Unseen, unheard, and right behind them.",
    classes: ["rogue", "monk", "ranger"],
  },
  {
    label: "Helping friends",
    summary: "Healing, guarding and cheering the party on.",
    classes: ["cleric", "bard", "druid", "paladin"],
  },
];

function signed(value: number): string {
  return value >= 0 ? `+${String(value)}` : String(value);
}

function pitchOf(classDef: ClassDef): string {
  return (
    PITCHES[slugOf(classDef.id)] ??
    `Relies on ${classDef.primaryAbilities.map((ability) => ABILITY_NAMES[ability]).join(" or ")}.`
  );
}

function looksOf(draft: Draft, access: ContentAccess): string[] {
  const species = nameOf(access, draft.speciesId) ?? "";
  const className = nameOf(access, draft.classId) ?? "";
  return [`${species} ${className}`, className, `${species} Species`, species];
}

// A ready hero of each class, as the recommendation makes it.
function readyHero(classDef: ClassDef, access: ContentAccess): Choice {
  const draft = completeDraft(
    { classId: classDef.id, scores: [], picks: {} },
    "standard",
    access,
  );
  const species = nameOf(access, draft.speciesId) ?? "";
  return {
    id: `${READY_PREFIX}${classDef.id}`,
    label: heroName(draft, access),
    summary: `${species} ${classDef.name}. ${pitchOf(classDef)}`,
    looks: looksOf(draft, access),
  };
}

function doors(decision: Decision, access: ContentAccess) {
  const offered = new Set(decision.options.map((option) => option.id));
  const classes = namedContent(access, "class", ClassSchema).filter((item) =>
    offered.has(`${READY_PREFIX}${item.id}`),
  );
  const heroes = classes.map((item) => readyHero(item, access));
  const pregens = pregenChoices(
    {
      ...decision,
      options: decision.options.filter((option) =>
        option.id.includes(":pregen/"),
      ),
    },
    access,
  );
  const answers = STYLES.flatMap((style) => {
    const fitting = style.classes.flatMap((wanted) => {
      const index = classes.findIndex((item) => slugOf(item.id) === wanted);
      const hero = heroes[index];
      return hero ? [hero] : [];
    });
    return fitting.length > 0
      ? [
          {
            label: style.label,
            summary: style.summary,
            choices: fitting.map((hero, index) => ({
              ...hero,
              recommended: index === 0,
            })),
          },
        ]
      : [];
  });
  const first = heroes[0];
  return [
    {
      id: "ready",
      label: "Pick a ready hero",
      summary: "One click, and you're playing.",
      ...(first?.looks ? { looks: first.looks } : {}),
      choices: [...pregens, ...heroes],
    },
    ...(answers.length > 0
      ? [
          {
            id: "quiz",
            label: "Answer a question",
            summary: "Say how you like to play; we suggest a hero.",
            looks: ["Wizard", "Human Wizard"],
            question: { prompt: "How do you like to play?", answers },
          },
        ]
      : []),
    ...(offered.has(BUILD_YOURSELF)
      ? [
          {
            id: "build",
            label: "Build it myself",
            summary: "Every choice is yours, and each starts on a good one.",
            looks: ["Fighter", "Human Fighter"],
            answer: BUILD_YOURSELF,
          },
        ]
      : []),
  ];
}

function scoresWithIncrease(draft: Draft): AbilityScores {
  const base = draft.base;
  const raised = draft.increase ? parseIncrease(draft.increase) : {};
  return Object.fromEntries(
    ABILITIES.map((ability) => [
      ability,
      (base?.[ability] ?? 8) + (raised[ability] ?? 0),
    ]),
  ) as AbilityScores;
}

function card(draft: Draft, access: ContentAccess) {
  const name = draft.name ?? heroName(draft, access);
  const actor = finishedCharacter(PLAYER_ACTOR, name, draft, access);
  const stats = deriveStats(actor, access);
  const classDef = find(access, ClassSchema, draft.classId ?? "");
  const numbers: Stat[] = [
    { label: "HP", value: String(stats.maxHp), term: "hit-points" },
    { label: "AC", value: String(stats.ac), term: "armor-class" },
    { label: "Speed", value: `${String(stats.speed)} ft`, term: "speed" },
    {
      label: "Initiative",
      value: signed(stats.initiative),
      term: "initiative",
    },
  ];
  const abilities = ABILITIES.map((ability) => ({
    label: ability.toUpperCase(),
    value: `${String(stats.abilities[ability])} (${signed(abilityModifier(stats.abilities[ability]))})`,
    term: ABILITY_NAMES[ability].toLowerCase(),
  }));
  const spells = Object.values(draft.picks)
    .flat()
    .flatMap((id) => find(access, SpellSchema, id)?.name ?? []);
  const gear = actor.inventory.flatMap((id) => nameOf(access, id) ?? []);
  return {
    title: name,
    subtitle: [
      `Level 1 ${nameOf(access, draft.speciesId) ?? ""} ${classDef?.name ?? ""}`,
      nameOf(access, draft.backgroundId),
    ]
      .filter(Boolean)
      .join(" · "),
    looks: looksOf(draft, access),
    numbers,
    abilities,
    strengths: [
      ...(classDef ? [pitchOf(classDef)] : []),
      `Good at ${stats.skills.map(skillName).join(", ")}`,
      ...(spells.length > 0 ? [`Spells: ${spells.join(", ")}`] : []),
      ...(gear.length > 0 ? [`Carries ${gear.join(", ")}`] : []),
    ],
  };
}

// Whose choice a pick is, by its slot: the species', an origin feat's or the class's.
function slotOwner(slot: string, draft: Draft, access: ContentAccess): string {
  if (slot.startsWith("species-")) return nameOf(access, draft.speciesId) ?? "";
  if (slot === BACKGROUND_FEAT) return nameOf(access, draft.backgroundId) ?? "";
  const feat = /^feat(\d+)-/.exec(slot);
  if (feat) {
    const background = find(access, BackgroundSchema, draft.backgroundId ?? "");
    const speciesFeats = Object.entries(draft.picks).flatMap(([id, picks]) =>
      id.startsWith("species-")
        ? picks.filter((pick) => find(access, FeatSchema, pick))
        : [],
    );
    const index = Number(feat[1]);
    return (
      nameOf(
        access,
        index === 0
          ? background
            ? backgroundFeatOf(draft, background)
            : undefined
          : speciesFeats[index - 1],
      ) ?? ""
    );
  }
  return nameOf(access, draft.classId) ?? "";
}

// Spells the rules can't play in a fight yet are folded away below the rest of their pick.
function foldStoryOnly<T extends { readonly choices: readonly Choice[] }>(
  group: T,
): readonly (T | (T & { readonly folded: true; readonly title: string }))[] {
  const story = (choice: Choice): boolean =>
    choice.label.endsWith("(story only)");
  const later = group.choices.filter(story);
  if (later.length === 0 || later.length === group.choices.length)
    return [group];
  return [
    { ...group, choices: group.choices.filter((choice) => !story(choice)) },
    {
      ...group,
      title: "More, for the story only",
      note: "The rules don't play these in a fight yet.",
      folded: true,
      choices: later,
    },
  ];
}

function skillGroups(draft: Draft, access: ContentAccess) {
  const fresh = completeDraft({ ...draft, picks: {} }, "standard", access);
  return sheetSlots(draft, access).flatMap((slot) => {
    const picked = draft.picks[slot.slot] ?? [];
    const what = slot.prompt
      .replace(/^Choose /, "")
      .replace(/ \(\d+ of \d+\)/, "")
      .replace(/\.$/, "");
    return foldStoryOnly({
      title: `${slotOwner(slot.slot, draft, access)}: ${what}`,
      note:
        slot.count > 1
          ? `Choose ${String(slot.count)}. A new pick replaces the oldest.`
          : "Choose 1.",
      layout: "chips" as const,
      choices: slot.options.map((option): Choice => {
        const chosen = picked.includes(option.id);
        const next =
          slot.count === 1
            ? [option.id]
            : [...picked.slice(picked.length >= slot.count ? 1 : 0), option.id];
        return {
          ...contentChoice(access, option.id, option.label),
          answer: `pick:${slot.slot}=${next.join("|")}`,
          selected: chosen,
          recommended: fresh.picks[slot.slot]?.includes(option.id) === true,
        };
      }),
    });
  });
}

// Scores change by one step at a time: with point-buy within the budget, with the standard array by swapping.
function scoreSteppers(sheet: Sheet, access: ContentAccess) {
  const { draft } = sheet;
  const base = draft.base;
  if (!base) return undefined;
  const classDef = find(access, ClassSchema, draft.classId ?? "");
  const raised = draft.increase ? parseIncrease(draft.increase) : {};
  const spent = pointsSpent(base) ?? 0;
  const change = (ability: Ability, by: 1 | -1): string | undefined => {
    if (sheet.method === "pointBuy") {
      const value = base[ability] + by;
      const cost = POINT_COST[value];
      const before = POINT_COST[base[ability]] ?? 0;
      if (cost === undefined || spent - before + cost > POINT_BUY_BUDGET) {
        return undefined;
      }
      return `scores:${encodeScores({ ...base, [ability]: value })}`;
    }
    // The next value of the array up or down, swapped with whoever holds it.
    const values = [...STANDARD_ARRAY];
    const index = values.indexOf(base[ability] as (typeof values)[number]);
    const target = values[index - by];
    const other = ABILITIES.find((item) => base[item] === target);
    if (target === undefined || !other) return undefined;
    return `scores:${encodeScores({ ...base, [ability]: target, [other]: base[ability] })}`;
  };
  return {
    title: sheet.method === "pointBuy" ? "Point buy" : "Standard array",
    note:
      sheet.method === "pointBuy"
        ? `${String(POINT_BUY_BUDGET - spent)} of ${String(POINT_BUY_BUDGET)} points left. Scores run from 8 to 15.`
        : "Raising one score swaps it with the next.",
    rows: ABILITIES.map((ability) => {
      const bonus = raised[ability] ?? 0;
      const total = base[ability] + bonus;
      const role = classDef?.primaryAbilities.includes(ability)
        ? `Key for a ${classDef.name}`
        : classDef?.spellcasting?.ability === ability
          ? "Spellcasting"
          : "";
      const minus = change(ability, -1);
      const plus = change(ability, 1);
      return {
        label: ABILITY_NAMES[ability],
        value: `${String(total)} (${signed(abilityModifier(total))})`,
        note: [
          bonus > 0
            ? `${String(base[ability])} +${String(bonus)} background`
            : "",
          role,
        ]
          .filter(Boolean)
          .join(" · "),
        term: ABILITY_NAMES[ability].toLowerCase(),
        ...(minus ? { minus } : {}),
        ...(plus ? { plus } : {}),
      };
    }),
  };
}

function originGroups(sheet: Sheet, access: ContentAccess) {
  const { draft } = sheet;
  const classDef = find(access, ClassSchema, draft.classId ?? "");
  const fresh = completeDraft(
    { classId: draft.classId, scores: [], picks: {} },
    "standard",
    access,
  );
  const mark = (
    choice: Choice,
    current: string | undefined,
    best: string | undefined,
    kind: string,
  ): Choice => ({
    ...choice,
    answer: `${kind}:${choice.id}`,
    selected: choice.id === current,
    recommended: choice.id === best,
  });
  switch (sheet.at) {
    case "species":
      return [
        {
          title: "Choose your species",
          note: "Every species is as strong; pick the one you like.",
          layout: "cards" as const,
          choices: namedContent(access, "species", SpeciesSchema).map((item) =>
            mark(
              {
                ...speciesChoice(access, item.id, item.name),
                looks: [`${item.name} Species`, item.name],
              },
              draft.speciesId,
              fresh.speciesId,
              "species",
            ),
          ),
        },
      ];
    case "class": {
      const best = completeDraft({ scores: [], picks: {} }, "standard", access);
      const speciesName = nameOf(access, draft.speciesId);
      return [
        {
          title: "Choose your class",
          note: "Your class is how you fight and what you're best at.",
          layout: "cards" as const,
          choices: namedContent(access, "class", ClassSchema).map((item) => {
            const base = classChoice(access, item.id, item.name, speciesName);
            return mark(
              { ...base, summary: pitchOf(item) },
              draft.classId,
              best.classId,
              "class",
            );
          }),
        },
      ];
    }
    case "background":
      return [
        {
          title: "Choose your background",
          note: "What you did before adventuring. It raises three abilities and gives a feat.",
          layout: "cards" as const,
          choices: namedContent(access, "background", BackgroundSchema).map(
            (item) =>
              mark(
                {
                  ...backgroundChoice(access, item.id, item.name),
                  looks: [`${item.name} Background`],
                },
                draft.backgroundId,
                fresh.backgroundId,
                "background",
              ),
          ),
        },
      ];
    case "abilities": {
      const background = find(
        access,
        BackgroundSchema,
        draft.backgroundId ?? "",
      );
      if (!background || !classDef) return [];
      const increase = backgroundIncreaseStep(background.abilities, classDef);
      const bestIncrease = increase.prefer?.[0];
      return [
        {
          title: "How to set your scores",
          layout: "chips" as const,
          choices: [
            {
              id: "standard",
              label: "Standard array",
              summary: STANDARD_ARRAY.join(", "),
              answer: "method:standard",
              selected: sheet.method === "standard",
              recommended: true,
            },
            {
              id: "pointBuy",
              label: "Point buy",
              summary: `${String(POINT_BUY_BUDGET)} points`,
              answer: "method:pointBuy",
              selected: sheet.method === "pointBuy",
            },
          ],
        },
        {
          title: `${background.name} raises`,
          layout: "chips" as const,
          choices: increase.options.map((option) => ({
            id: option.id,
            label: option.label,
            answer: `increase:${option.id}`,
            selected: option.id === draft.increase,
            recommended: option.id === bestIncrease,
          })),
        },
      ];
    }
    default:
      return [];
  }
}

function reviewRows(sheet: Sheet, access: ContentAccess) {
  const { draft } = sheet;
  const scores = scoresWithIncrease(draft);
  const picked = Object.values(draft.picks).flat();
  const background = find(access, BackgroundSchema, draft.backgroundId ?? "");
  const skills = [
    ...(background?.skills ?? []),
    ...picked.filter((id) => !id.includes(":")),
  ];
  const others = picked.flatMap((id) =>
    id.includes(":") && !/^[a-z]+:\d/.test(id)
      ? (nameOf(access, id) ?? [])
      : [],
  );
  return [
    {
      label: "Name",
      value: draft.name ?? heroName(draft, access),
      change: "at:name",
    },
    {
      label: "Species",
      value: nameOf(access, draft.speciesId) ?? "",
      change: "at:species",
    },
    {
      label: "Class",
      value: nameOf(access, draft.classId) ?? "",
      change: "at:class",
    },
    {
      label: "Background",
      value: background?.name ?? "",
      change: "at:background",
    },
    {
      label: "Abilities",
      value: ABILITIES.map(
        (ability) => `${ability.toUpperCase()} ${String(scores[ability])}`,
      ).join(" · "),
      change: "at:abilities",
    },
    {
      label: "Skills",
      value: skills.map(skillName).join(", "),
      change: "at:skills",
    },
    ...(others.length > 0
      ? [
          {
            label: "Spells & picks",
            value: others.join(", "),
            change: "at:skills",
          },
        ]
      : []),
  ];
}

function sheetView(decision: Decision, sheet: Sheet, access: ContentAccess) {
  const { draft } = sheet;
  const current = SECTIONS.indexOf(sheet.at);
  const steps = SECTIONS.map((section, index) => ({
    title: TITLES[section],
    status:
      index === current
        ? ("current" as const)
        : index < current
          ? ("done" as const)
          : ("todo" as const),
    answer: `at:${section}`,
  }));
  const after = SECTIONS[current + 1];
  const finish = decision.options.find((option) => option.id === "accept");
  const view = {
    steps,
    heading: TITLES[sheet.at],
    layout: "cards" as const,
    choices: [],
    summary: [],
    card: card(draft, access),
    next:
      after === undefined
        ? { label: finish?.label ?? "Begin", answer: "accept" }
        : { label: `Next: ${TITLES[after]}`, answer: "next" },
  };
  switch (sheet.at) {
    case "abilities":
      return {
        ...view,
        groups: originGroups(sheet, access),
        ...(() => {
          const steppers = scoreSteppers(sheet, access);
          return steppers ? { steppers } : {};
        })(),
      };
    case "skills":
      return { ...view, groups: skillGroups(draft, access) };
    case "name":
      return {
        ...view,
        intro: "Call your hero anything you like.",
        name: {
          label: "Name",
          value: draft.name ?? heroName(draft, access),
          prefix: "name:",
          maxLength: NAME_LENGTH,
        },
      };
    case "review":
      return {
        ...view,
        intro: "Here's your hero. Change anything, or begin.",
        review: reviewRows(sheet, access),
      };
    default:
      return { ...view, groups: originGroups(sheet, access) };
  }
}

// The new way of making a character: three doors in, then one sheet that is always complete. null for anything else.
export function sheetCreation(
  decision: Decision,
  _rawState: unknown,
  access: ContentAccess,
) {
  if (decision.id === `${NS}:chooseCharacter`) {
    if (!decision.options.some((option) => option.id === BUILD_YOURSELF)) {
      return null;
    }
    return {
      steps: [],
      heading: "Who will you play?",
      layout: "cards" as const,
      choices: decision.options
        .filter((option) => option.id !== CREATE_CHARACTER)
        .map((option) => ({ id: option.id, label: option.label })),
      summary: [],
      doors: doors(decision, access),
    };
  }
  if (decision.id !== `${NS}:build:${decision.actor}:${SHEET_KEY}`) return null;
  const parsed = SheetStepSchema.safeParse(decision.resume.payload);
  return parsed.success ? sheetView(decision, parsed.data.sheet, access) : null;
}
