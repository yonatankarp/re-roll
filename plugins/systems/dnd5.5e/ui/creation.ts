import { type ContentAccess, type Decision, PLAYER_ACTOR } from "#sdk";
import type { z } from "zod";
import {
  BuildStepSchema,
  STANDARD_ARRAY,
  parseIncrease,
  startingGear,
} from "../core/character.ts";
import { CREATE_CHARACTER } from "../core/combat/ids.ts";
import {
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  type AbilityScores,
  BackgroundSchema,
  ClassSchema,
  FeatSchema,
  FeatureSchema,
  ItemSchema,
  PregenSchema,
  SKILL_ABILITIES,
  type Skill,
  SpeciesSchema,
  SpellSchema,
  SubclassSchema,
} from "../core/schemas.ts";
import { NS } from "../core/state.ts";
import { lookup } from "../core/stats.ts";
import { parseState } from "./parse-state.ts";

// Matched by shape, as SystemUi is, so the plugin never imports the shell.
interface Choice {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  readonly detail?: string;
  readonly looks?: readonly string[];
}
interface Row {
  readonly label: string;
  readonly value: string;
}
type Status = "done" | "current" | "todo";
type Draft = z.infer<typeof BuildStepSchema>["draft"];

const STEPS = [
  "Species",
  "Class",
  "Background",
  "Abilities",
  "Features",
  "Name",
] as const;

export function find<T>(
  access: ContentAccess,
  schema: z.ZodType<T>,
  id: string,
) {
  if (!access.content(id)) return null;
  try {
    return lookup(access, schema, id);
  } catch {
    return null;
  }
}

export function nameOf(
  access: ContentAccess,
  id: string | undefined,
): string | null {
  if (id === undefined) return null;
  const entry = access.content(id);
  return entry && typeof entry === "object" && "name" in entry
    ? String(entry.name)
    : null;
}

export function list(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : "None";
}

export function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function skillName(skill: string): string {
  return capital(skill.replace(/([A-Z])/g, " $1").replace(" Of ", " of "));
}

function abilityShort(abilities: readonly Ability[]): string {
  return abilities.map((ability) => ability.toUpperCase()).join(", ");
}

// Where a build step's key falls among the steps of making a character.
function stepOf(key: string): number {
  if (key === "species") return 0;
  if (key === "class") return 1;
  if (key === "background") return 2;
  if (key.startsWith("score-") || key === "increase") return 3;
  if (key === "name") return 5;
  return 4;
}

export function speciesChoice(
  access: ContentAccess,
  id: string,
  label: string,
) {
  const species = find(access, SpeciesSchema, id);
  if (!species) return { id, label };
  const traits = species.traits.flatMap((trait) => {
    const feature = find(access, FeatureSchema, trait);
    return feature ? [`${feature.name}. ${feature.text}`] : [];
  });
  return {
    id,
    label,
    summary: `${capital(species.size)} · ${String(species.speed)} ft speed`,
    detail: [species.text, ...traits].join("\n\n"),
    looks: [species.name],
  };
}

export function classChoice(
  access: ContentAccess,
  id: string,
  label: string,
  speciesName: string | null,
) {
  const classDef = find(access, ClassSchema, id);
  if (!classDef) return { id, label };
  const first = classDef.levels.find((level) => level.level === 1);
  const features = (first?.grants ?? []).flatMap((grant) => {
    const feature = find(access, FeatureSchema, grant);
    return feature ? [`${feature.name}. ${feature.text}`] : [];
  });
  const primary = classDef.primaryAbilities
    .map((ability) => ABILITY_NAMES[ability])
    .join(" or ");
  return {
    id,
    label: classDef.name,
    summary: `${classDef.hitDie} hit die · ${primary}${classDef.spellcasting ? " · Spells" : ""}`,
    detail: [
      `Saving throws: ${abilityShort(classDef.savingThrows)}`,
      `Armor: ${list(classDef.armor.map(capital))}`,
      `Weapons: ${list(classDef.weapons.map(capital))}`,
      ...features,
    ].join("\n\n"),
    looks: [
      ...(speciesName ? [`${speciesName} ${classDef.name}`] : []),
      classDef.name,
    ],
  };
}

export function backgroundChoice(
  access: ContentAccess,
  id: string,
  label: string,
) {
  const background = find(access, BackgroundSchema, id);
  if (!background) return { id, label };
  const feat = find(access, FeatSchema, background.feat);
  return {
    id,
    label: background.name,
    summary: `${abilityShort(background.abilities)} · ${feat?.name ?? "a feat"}`,
    detail: [
      `Abilities: ${background.abilities.map((ability) => ABILITY_NAMES[ability]).join(", ")}`,
      `Skills: ${background.skills.map(skillName).join(", ")}`,
      `Tool: ${background.tool}`,
      ...(feat ? [`${feat.name}. ${feat.text}`] : []),
    ].join("\n\n"),
  };
}

// Whatever an option names, such as a spell, a feat or a skill, with what it does.
export function contentChoice(
  access: ContentAccess,
  id: string,
  label: string,
) {
  const spell = find(access, SpellSchema, id);
  if (spell) {
    const what =
      spell.level === 0
        ? `${capital(spell.school)} cantrip`
        : `Level ${String(spell.level)} ${spell.school}`;
    return {
      id,
      label: label.replace(/ \(level \d\)/, ""), // the summary says the level
      summary: `${what} · ${spell.castingTime} · ${spell.range}`,
      detail: spell.text,
    };
  }
  const feat = find(access, FeatSchema, id);
  if (feat) return { id, label, detail: feat.text };
  const feature = find(access, FeatureSchema, id);
  if (feature) return { id, label, detail: feature.text };
  const subclass = find(access, SubclassSchema, id);
  if (subclass) {
    const features = subclass.levels.flatMap((level) =>
      level.grants.flatMap((grant) => {
        const named = find(access, FeatureSchema, grant);
        return named
          ? [`Level ${String(level.level)}: ${named.name}. ${named.text}`]
          : [];
      }),
    );
    const className = nameOf(access, subclass.class) ?? "";
    return {
      id,
      label,
      detail: features.join("\n\n"),
      looks: [`${className} ${subclass.name}`, className],
    };
  }
  const item = find(access, ItemSchema, id);
  if (item) return { id, label, summary: capital(item.type) };
  if (id in SKILL_ABILITIES) {
    return {
      id,
      label,
      summary: ABILITY_NAMES[SKILL_ABILITIES[id as Skill]],
    };
  }
  return { id, label };
}

// The scores so far: the standard array as placed, then the background's increase.
function scoresOf(draft: Draft): AbilityScores {
  const order = [
    ...draft.scores,
    ...ABILITIES.filter((ability) => !draft.scores.includes(ability)),
  ];
  const raised = draft.increase ? parseIncrease(draft.increase) : {};
  return Object.fromEntries(
    order.map((ability, index) => [
      ability,
      (STANDARD_ARRAY[index] ?? 8) + (raised[ability] ?? 0),
    ]),
  ) as AbilityScores;
}

function summaryOf(draft: Draft, access: ContentAccess): Row[] {
  const rows: Row[] = [];
  const add = (label: string, value: string | null): void => {
    if (value) rows.push({ label, value });
  };
  add("Species", nameOf(access, draft.speciesId));
  add("Class", nameOf(access, draft.classId));
  const background =
    draft.backgroundId === undefined
      ? null
      : find(access, BackgroundSchema, draft.backgroundId);
  add("Background", background?.name ?? null);
  const placed = draft.scores.length > 0;
  if (placed) {
    const scores = scoresOf(draft);
    // Only placed scores are known; the last goes wherever is left once five are.
    const known = draft.scores.length >= ABILITIES.length - 1;
    add(
      "Abilities",
      ABILITIES.filter((ability) => known || draft.scores.includes(ability))
        .map((ability) => `${ability.toUpperCase()} ${String(scores[ability])}`)
        .join(" · "),
    );
  }
  const picked = Object.values(draft.picks).flat();
  const skills = [
    ...(background?.skills ?? []),
    ...picked.filter((id) => id in SKILL_ABILITIES),
  ];
  if (skills.length > 0) add("Skills", skills.map(skillName).join(", "));
  const spells = picked.flatMap((id) => {
    const spell = find(access, SpellSchema, id);
    return spell ? [spell.name] : [];
  });
  if (spells.length > 0) add("Spells", spells.join(", "));
  const classDef =
    draft.classId === undefined
      ? null
      : find(access, ClassSchema, draft.classId);
  // Gear follows from the class and the scores, so it shows once both are settled.
  if (classDef && draft.increase !== undefined) {
    add(
      "Gear",
      startingGear(classDef, scoresOf(draft), access)
        .flatMap((id) => nameOf(access, id) ?? [])
        .join(", "),
    );
  }
  return rows;
}

// What the step is about beyond its prompt: the scores still to place, or whose choice a feature is.
function headingOf(key: string, draft: Draft, access: ContentAccess): string {
  if (key.startsWith("score-")) {
    const left = STANDARD_ARRAY.slice(draft.scores.length);
    return `Scores left: ${left.join(", ")}`;
  }
  if (stepOf(key) !== 4) return "";
  const choice = key.replace(/^\d+:/, "").replace(/-\d+$/, "");
  const background =
    draft.backgroundId === undefined
      ? null
      : find(access, BackgroundSchema, draft.backgroundId);
  const featOf = /^feat(\d+)-/.exec(choice);
  if (featOf) {
    const speciesFeats = Object.entries(draft.picks).flatMap(([id, picks]) =>
      id.startsWith("species-")
        ? picks.filter((pick) => find(access, FeatSchema, pick))
        : [],
    );
    const index = Number(featOf[1]);
    return (
      nameOf(
        access,
        index === 0 ? background?.feat : speciesFeats[index - 1],
      ) ?? ""
    );
  }
  if (choice.startsWith("species-"))
    return nameOf(access, draft.speciesId) ?? "";
  // A feat's own choices, such as a fighting style's, under its choice id.
  const owner = /^([^:]+):feat\d+-/.exec(choice)?.[1];
  const ownerFeat = owner === undefined ? undefined : draft.picks[owner]?.[0];
  return nameOf(access, ownerFeat) ?? nameOf(access, draft.classId) ?? "";
}

function creationSteps(draft: Draft, current: number) {
  const done = [
    draft.speciesId !== undefined,
    draft.classId !== undefined,
    draft.backgroundId !== undefined,
    draft.increase !== undefined,
    current > 4,
    false,
  ];
  return STEPS.map((title, index): { title: string; status: Status } => ({
    title,
    status: index === current ? "current" : done[index] ? "done" : "todo",
  }));
}

export function pregenChoices(
  decision: Decision,
  access: ContentAccess,
): Choice[] {
  return decision.options.map((option) => {
    if (option.id === CREATE_CHARACTER) {
      return {
        id: option.id,
        label: "Create your own",
        summary: "Choose a species, class and background, step by step.",
      };
    }
    const pregen = find(access, PregenSchema, option.id);
    if (!pregen) return { id: option.id, label: option.label };
    const species = nameOf(access, pregen.build.speciesId);
    const classes = pregen.build.levels.flatMap(
      (level) => nameOf(access, level.classId) ?? [],
    );
    const className = classes[0] ?? "";
    const { baseAbilities } = pregen.build;
    return {
      id: option.id,
      label: pregen.name,
      summary: [
        `Level ${String(pregen.build.levels.length)}`,
        nameOf(access, pregen.build.backgroundId),
      ]
        .filter(Boolean)
        .join(" · "),
      detail: [
        ABILITIES.map(
          (ability) =>
            `${ability.toUpperCase()} ${String(baseAbilities[ability])}`,
        ).join(" · "),
        `Gear: ${list(pregen.equipment.flatMap((id) => nameOf(access, id) ?? []))}`,
      ].join("\n\n"),
      looks: [pregen.name, `${species ?? ""} ${className}`.trim(), className],
    };
  });
}

export function creation(
  decision: Decision,
  rawState: unknown,
  access: ContentAccess,
) {
  if (decision.id === `${NS}:chooseCharacter`) {
    return {
      steps: [],
      heading: "",
      layout: "cards" as const,
      choices: pregenChoices(decision, access),
      summary: [],
    };
  }
  const prefix = `${NS}:build:${decision.actor}:`;
  if (decision.actor !== PLAYER_ACTOR || !decision.id.startsWith(prefix)) {
    return null;
  }
  const payload = BuildStepSchema.safeParse(decision.resume.payload);
  if (!payload.success) return null;
  const { draft } = payload.data;
  const key = decision.id.slice(prefix.length);
  const actor = parseState(rawState).actors[decision.actor];
  const base = actor?.source.kind === "character" ? actor.source.build : null;
  const speciesName = nameOf(access, base ? base.speciesId : draft.speciesId);
  const choices: Choice[] = decision.options.map((option) => {
    if (key === "species")
      return speciesChoice(access, option.id, option.label);
    if (key === "class") {
      return classChoice(access, option.id, option.label, speciesName);
    }
    if (key === "background") {
      return backgroundChoice(access, option.id, option.label);
    }
    if (key.startsWith("score-")) {
      const classDef =
        draft.classId === undefined
          ? null
          : find(access, ClassSchema, draft.classId);
      const ability = option.id as Ability;
      const role =
        classDef?.primaryAbilities.includes(ability) === true
          ? `Key for a ${classDef.name}`
          : classDef?.spellcasting?.ability === ability
            ? "Spellcasting"
            : undefined;
      return {
        id: option.id,
        label: ABILITY_NAMES[ability],
        ...(role ? { summary: role } : {}),
      };
    }
    return contentChoice(access, option.id, option.label);
  });
  const pictured = choices.some(
    (choice) => choice.looks !== undefined || choice.summary !== undefined,
  );
  if (base) {
    return {
      steps: [],
      heading: `Level ${String(base.levels.length + 1)}`,
      layout: pictured ? ("cards" as const) : ("list" as const),
      choices,
      summary: [],
    };
  }
  const current = stepOf(key);
  return {
    steps: creationSteps(draft, current),
    heading: headingOf(key, draft, access),
    layout: pictured && current !== 3 ? ("cards" as const) : ("list" as const),
    choices: key === "name" ? [] : choices,
    summary: summaryOf(draft, access),
  };
}
