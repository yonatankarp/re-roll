import {
  type ContentAccess,
  ContentIdSchema,
  type Decision,
  type Dice,
  type Frame,
  PLAYER_ACTOR,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import {
  ABILITIES,
  type Ability,
  AbilitySchema,
  type AbilityScores,
  BackgroundSchema,
  type CharacterBuild,
  CharacterBuildSchema,
  type ChoiceDef,
  type ClassDef,
  ClassSchema,
  FeatSchema,
  FeatureSchema,
  ItemSchema,
  type Item,
  SKILL_ABILITIES,
  type Skill,
  SpeciesSchema,
  SpellSchema,
  type Spell,
  SubclassSchema,
  type Weapon,
} from "./schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  dndEvent,
  freshActor,
  isDead,
  frame,
} from "./state.ts";
import {
  abilityModifier,
  buildAbilities,
  deriveStats,
  doesSomething,
  lookup,
  weaponProficient,
} from "./stats.ts";

export { weaponProficient };

type Context = SystemContext<DndState>;
type LevelEntry = CharacterBuild["levels"][number];

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;
// The Experience Points needed for each level, from level 1 upward.
const XP_FOR_LEVEL = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000,
  120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
] as const;
const ALL_SKILLS = Object.keys(SKILL_ABILITIES) as [Skill, ...Skill[]];

export function levelForXp(xp: number): number {
  return XP_FOR_LEVEL.filter((needed) => xp >= needed).length;
}

// A half-built character travels in the frames on the stack, so a save resumes mid-creation with no extra state.
const DraftSchema = z.strictObject({
  classId: ContentIdSchema.optional(),
  speciesId: ContentIdSchema.optional(),
  backgroundId: ContentIdSchema.optional(),
  scores: z.array(AbilitySchema), // given the standard array's values in order
  increase: z.string().optional(),
  picks: z.record(z.string(), z.array(z.string())), // choice id to what was picked so far
  name: z.string().optional(), // what the player called the character, asked last
});
type Draft = z.infer<typeof DraftSchema>;

interface Option {
  readonly id: string;
  readonly label: string;
}

interface Step {
  readonly key: string;
  readonly prompt: string;
  readonly options: readonly Option[];
  readonly prefer?: readonly string[]; // companions pick among these when any are on offer
  readonly text?: { readonly label: string; readonly maxLength: number }; // the answer may be typed
  readonly apply: (draft: Draft, answer: string) => Draft;
}

const NAME_LENGTH = 40;
const NameSchema = z
  .string()
  .trim()
  .min(1)
  .max(NAME_LENGTH)
  .regex(/^\P{C}+$/u);

// How a build's steps are ordered. Frames from before the order was recorded keep the old one, class first,
// since an answer is applied to whatever step its draft asks next.
const SPECIES_FIRST = 2;

// When two loaded books print the same name, the first in content id order wins: the run's precedence.
function namedContent<T extends { readonly name: string }>(
  access: ContentAccess,
  kind: string,
  schema: z.ZodType<T>,
  // Applied before names are compared, so an entry that can't be offered doesn't hide one that can.
  offered: (entry: T) => boolean = () => true,
): readonly T[] {
  const byName = new Map<string, T>();
  for (const id of access.contentIds()) {
    if (!id.includes(`:${kind}/`)) continue;
    const entry = lookup(access, schema, id);
    if (offered(entry) && !byName.has(entry.name))
      byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

// The score a companion should raise first: the class's own, then staying alive.
function abilityPriority(classDef: ClassDef): readonly Ability[] {
  return [
    ...new Set<Ability>([
      ...classDef.primaryAbilities,
      ...(classDef.spellcasting ? [classDef.spellcasting.ability] : []),
      "con",
      "dex",
      "wis",
      "cha",
      "int",
      "str",
    ]),
  ];
}

function encodeIncrease(
  increase: readonly (readonly [Ability, number])[],
): string {
  return increase
    .map(([ability, amount]) => `${ability}:${String(amount)}`)
    .join(",");
}

export function parseIncrease(text: string): Partial<Record<Ability, number>> {
  return Object.fromEntries(
    text.split(",").map((part) => {
      const [ability, amount] = part.split(":");
      return [AbilitySchema.parse(ability), Number(amount)];
    }),
  );
}

function describeIncrease(text: string): string {
  return Object.entries(parseIncrease(text))
    .map(([ability, amount]) => `+${String(amount)} ${ability.toUpperCase()}`)
    .join(", ");
}

function backgroundIncreaseStep(
  abilities: readonly Ability[],
  classDef: ClassDef,
): Step {
  const pairs = abilities.flatMap((first) =>
    abilities.flatMap((second) =>
      first === second
        ? []
        : [
            encodeIncrease([
              [first, 2],
              [second, 1],
            ]),
          ],
    ),
  );
  const even = encodeIncrease(abilities.map((ability) => [ability, 1]));
  const [best, next] = abilityPriority(classDef).filter((ability) =>
    abilities.includes(ability),
  );
  return {
    key: "increase",
    prompt: "Raise the ability scores your background allows.",
    options: [...pairs, even].map((id) => ({
      id,
      label: describeIncrease(id),
    })),
    ...(best && next
      ? {
          prefer: [
            encodeIncrease([
              [best, 2],
              [next, 1],
            ]),
          ],
        }
      : {}),
    apply: (draft, increase) => ({ ...draft, increase }),
  };
}

function originStep(
  draft: Draft,
  access: ContentAccess,
  speciesFirst: boolean,
): Step | null {
  if (speciesFirst && draft.speciesId === undefined) return speciesStep(access);
  if (draft.classId === undefined) {
    return {
      key: "class",
      prompt: "Choose your class.",
      options: namedContent(access, "class", ClassSchema).map((item) => ({
        id: item.id,
        label: `${item.name} (${item.hitDie})`,
      })),
      apply: (current, classId) => ({ ...current, classId }),
    };
  }
  if (draft.speciesId === undefined) return speciesStep(access);
  if (draft.backgroundId === undefined) {
    return {
      key: "background",
      prompt: "Choose your background.",
      options: namedContent(access, "background", BackgroundSchema).map(
        (item) => ({
          id: item.id,
          label: `${item.name} (${item.abilities.join(", ").toUpperCase()})`,
        }),
      ),
      apply: (current, backgroundId) => ({ ...current, backgroundId }),
    };
  }
  const classDef = lookup(access, ClassSchema, draft.classId);
  const score = STANDARD_ARRAY[draft.scores.length];
  // The last score has only one place left to go.
  if (score !== undefined && draft.scores.length < ABILITIES.length - 1) {
    const free = ABILITIES.filter((item) => !draft.scores.includes(item));
    const [best] = abilityPriority(classDef).filter((item) =>
      free.includes(item),
    );
    return {
      key: `score-${String(score)}`,
      prompt: `Which ability gets the ${String(score)}?`,
      options: free.map((id) => ({ id, label: id.toUpperCase() })),
      ...(best ? { prefer: [best] } : {}),
      apply: (current, ability) => ({
        ...current,
        scores: [...current.scores, AbilitySchema.parse(ability)],
      }),
    };
  }
  if (draft.increase === undefined) {
    const { abilities } = lookup(access, BackgroundSchema, draft.backgroundId);
    return backgroundIncreaseStep(abilities, classDef);
  }
  return null;
}

function speciesStep(access: ContentAccess): Step {
  return {
    key: "species",
    prompt: "Choose your species.",
    options: namedContent(access, "species", SpeciesSchema).map((item) => ({
      id: item.id,
      label: item.name,
    })),
    apply: (current, speciesId) => ({ ...current, speciesId }),
  };
}

// The last step, once everything else is chosen. The suggestion is what a character was called before names.
function nameStep(draft: Draft, access: ContentAccess): Step | null {
  if (draft.name !== undefined) return null;
  const suggested = defaultName(draft, access);
  return {
    key: "name",
    prompt: "What is your character's name?",
    options: [{ id: suggested, label: suggested }],
    text: { label: "Name", maxLength: NAME_LENGTH },
    apply: (current, name) => ({ ...current, name: NameSchema.parse(name) }),
  };
}

function defaultName(draft: Draft, access: ContentAccess): string {
  const species = lookup(access, SpeciesSchema, draft.speciesId ?? "");
  const classDef = lookup(access, ClassSchema, draft.classId ?? "");
  return `${species.name} ${classDef.name}`;
}

function levelOf(classDef: ClassDef, level: number) {
  return classDef.levels.find((item) => item.level === level);
}

function answered(
  build: CharacterBuild | null,
  kind: LevelEntry["answers"][number]["kind"],
): readonly string[] {
  return (build?.levels ?? []).flatMap((entry) =>
    entry.answers.flatMap((answer) =>
      answer.kind === kind && "values" in answer ? answer.values : [],
    ),
  );
}

function chosenSubclass(
  picks: Draft["picks"],
  base: CharacterBuild | null,
): string | undefined {
  return (
    Object.values(picks)
      .flat()
      .find((value) => value.includes(":subclass/")) ??
    answered(base, "subclass")[0]
  );
}

const OPTION_KEYS = /invocations|maneuvers|metamagic/i;

// shortcut: an option's prerequisites are only in its text, so they aren't checked, as for feats.
function optionFeatures(classDef: ClassDef, access: ContentAccess): string[] {
  const [plugin = "", slug = ""] = classDef.id.split(":class/");
  const granted = new Set(classDef.levels.flatMap((level) => level.grants));
  for (const id of access.contentIds()) {
    if (!id.includes(":subclass/")) continue;
    const subclass = SubclassSchema.safeParse(access.content(id)).data;
    if (subclass?.class !== classDef.id) continue;
    for (const level of subclass.levels) {
      for (const grant of level.grants) granted.add(grant);
    }
  }
  const prefix = `${plugin}:feature/${slug}-`;
  return access
    .contentIds()
    .filter(
      (id) =>
        id.startsWith(prefix) && !granted.has(id) && !id.endsWith("-options"),
    );
}

// What a level asks for. A class can state this in `choices`. Imported classes don't, so the rest is read from
// what the level grants and how its table changes. A stated choice replaces an inferred one with the same id.
export function levelChoices(
  classDef: ClassDef,
  level: number,
  subclassId: string | undefined,
  access: ContentAccess,
): readonly ChoiceDef[] {
  const data = levelOf(classDef, level);
  if (!data) return [];
  const before = levelOf(classDef, level - 1)?.scaling ?? {};
  const gained = (key: string): number =>
    Math.max(0, (data.scaling[key] ?? 0) - (before[key] ?? 0));
  const highestSlot = data.slots.findLastIndex((count) => count > 0) + 1;

  const inferred: ChoiceDef[] = [];
  // shortcut: re-imported classes state their skill list, until then an old import offers any two.
  if (level === 1) {
    inferred.push({ kind: "skills", id: "skills", count: 2, from: ALL_SKILLS });
  }
  for (const grant of data.grants) {
    if (grant.endsWith("subclass")) {
      inferred.push({ kind: "subclass", id: "subclass" });
    } else if (grant.endsWith("ability-score-improvement")) {
      inferred.push({ kind: "feat", id: "feat", category: "general" });
    } else if (grant.endsWith("fighting-style")) {
      inferred.push({
        kind: "feat",
        id: "fighting-style",
        category: "fightingStyle",
      });
    } else if (grant.endsWith("epic-boon")) {
      inferred.push({ kind: "feat", id: "boon", category: "epicBoon" });
    }
  }
  if (gained("weaponMastery") > 0) {
    inferred.push({
      kind: "weaponMastery",
      id: "weapon-mastery",
      count: gained("weaponMastery"),
    });
  }
  // Older imports state no option choice, so the class's own features that no level grants are the options.
  for (const key of Object.keys(data.scaling)) {
    if (!OPTION_KEYS.test(key) || gained(key) === 0) continue;
    const from = optionFeatures(classDef, access);
    if (from.length > 0) {
      inferred.push({
        kind: "option",
        id: key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        count: gained(key),
        from,
      });
    }
  }
  if (gained("cantrips") > 0) {
    inferred.push({
      kind: "spells",
      id: "cantrips",
      count: gained("cantrips"),
      maxLevel: 0,
      list: classDef.id,
    });
  }
  if (gained("preparedSpells") > 0 && highestSlot > 0) {
    inferred.push({
      kind: "spells",
      id: "spells",
      count: gained("preparedSpells"),
      maxLevel: highestSlot,
      list: classDef.id,
    });
  }
  const subclass =
    subclassId === undefined
      ? undefined
      : lookup(access, SubclassSchema, subclassId);
  const stated = [
    ...data.choices,
    ...(subclass?.levels.find((item) => item.level === level)?.choices ?? []),
  ];
  return [
    ...stated,
    ...inferred.filter((item) => !stated.some(({ id }) => id === item.id)),
  ];
}

// What the species and the origin feats ask for, at level 1 only. Ids get a prefix so they can't meet a class's.
function originChoices(
  draft: Draft,
  base: CharacterBuild | null,
  access: ContentAccess,
): readonly ChoiceDef[] {
  if (base || !draft.speciesId || !draft.backgroundId) return [];
  const prefixed = (owner: string, choices: readonly ChoiceDef[]) =>
    choices.map((choice) => ({ ...choice, id: `${owner}-${choice.id}` }));
  const species = prefixed(
    "species",
    lookup(access, SpeciesSchema, draft.speciesId).choices,
  );
  // A feat picked here, such as a Human's Versatile origin feat, asks its own choices too.
  const feats = [
    lookup(access, BackgroundSchema, draft.backgroundId).feat,
    ...species.flatMap((choice) =>
      choice.kind === "feat" ? (draft.picks[choice.id] ?? []) : [],
    ),
  ];
  return [
    ...species,
    ...feats.flatMap((id, index) =>
      prefixed(`feat${String(index)}`, lookup(access, FeatSchema, id).choices),
    ),
  ];
}

// Each spell choice looks at every spell, and companions make many of them when a run starts.
const parsedSpells = new WeakMap<ContentAccess["content"], readonly Spell[]>();

function classSpells(
  access: ContentAccess,
  list: string | undefined,
): readonly Spell[] {
  let spells = parsedSpells.get(access.content);
  if (!spells) {
    spells = access
      .contentIds()
      .filter((id) => id.includes(":spell/"))
      .map((id) => lookup(access, SpellSchema, id));
    parsedSpells.set(access.content, spells);
  }
  const named =
    list === undefined
      ? undefined
      : ClassSchema.safeParse(access.content(list)).data?.spellList;
  const byName = new Map<string, Spell>();
  // The list is applied first, as namedContent applies `offered`; then the first spell of each name wins.
  for (const spell of spells) {
    const listed =
      list === undefined ||
      spell.classes.includes(list) ||
      named?.includes(spell.id);
    if (listed && !byName.has(spell.name)) byName.set(spell.name, spell);
  }
  return [...byName.values()];
}

function skillLabel(skill: string): string {
  const spaced = skill.replace(/[A-Z]/g, (letter) => ` ${letter}`);
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

export function choiceOptions(
  choice: ChoiceDef,
  draft: Draft,
  base: CharacterBuild | null,
  classDef: ClassDef,
  access: ContentAccess,
): Pick<Step, "options" | "prefer"> & { readonly what: string } {
  // Every pick so far counts, so a species' skill can't repeat the class's at level 1.
  const taken = (kind: LevelEntry["answers"][number]["kind"]) =>
    new Set([...answered(base, kind), ...Object.values(draft.picks).flat()]);
  const backgroundId = base?.backgroundId ?? draft.backgroundId ?? "";
  const background = lookup(access, BackgroundSchema, backgroundId);

  switch (choice.kind) {
    case "subclass":
      return {
        what: "a subclass",
        options: namedContent(
          access,
          "subclass",
          SubclassSchema,
          (item) => !item.edition,
        )
          .filter((item) => item.class === classDef.id)
          .map((item) => ({ id: item.id, label: item.name })),
      };
    case "feat": {
      const had = taken("feats").add(background.feat);
      const feats = namedContent(access, "feat", FeatSchema).filter(
        (item) =>
          item.category === choice.category &&
          // shortcut: a feat's prerequisites are only in its text, so they aren't checked.
          (!had.has(item.id) || item.text.includes("Repeatable")),
      );
      return {
        what: "a feat",
        options: feats.map((item) => ({ id: item.id, label: item.name })),
        prefer: feats.flatMap((item) =>
          isAbilityImprovement(item.id) ? [item.id] : [],
        ),
      };
    }
    case "skills": {
      const had = taken("skills");
      const known = choice.from.filter(
        (skill) => !had.has(skill) && !background.skills.includes(skill),
      );
      return {
        what: "a skill",
        options: known.map((id) => ({ id, label: skillLabel(id) })),
      };
    }
    case "weaponMastery": {
      const had = taken("weaponMastery");
      return {
        what: "a weapon to master",
        options: namedContent(access, "item", ItemSchema).flatMap((item) =>
          item.type === "weapon" &&
          weaponProficient(classDef, item) &&
          !had.has(item.id)
            ? [{ id: item.id, label: item.name }]
            : [],
        ),
        // A companion masters the weapons it starts with, so the mastery gets used.
        prefer: startingGear(
          classDef,
          buildAbilities(
            base ?? originBuild(draft, placeholderEntry(classDef)),
          ),
          access,
        ),
      };
    }
    case "spells": {
      const had = taken("spells");
      const spells = classSpells(access, choice.list).filter(
        (spell) =>
          !had.has(spell.id) &&
          (choice.schools?.includes(spell.school) ?? true) &&
          (choice.maxLevel === 0
            ? spell.level === 0
            : spell.level >= 1 && spell.level <= choice.maxLevel),
      );
      const works = (spell: Spell): boolean =>
        spell.activation !== undefined &&
        doesSomething(spell.activation.resolution);
      // Spells the rules can't play yet stay on offer for the story, marked and listed last.
      const sorted = [
        ...spells.filter(works),
        ...spells.filter((spell) => !works(spell)),
      ];
      return {
        what: choice.maxLevel === 0 ? "a cantrip" : "a spell",
        options: sorted.map((spell) => ({
          id: spell.id,
          label:
            (spell.level === 0
              ? spell.name
              : `${spell.name} (level ${String(spell.level)})`) +
            (works(spell) ? "" : " (story only)"),
        })),
        prefer: spells.filter(works).map((spell) => spell.id),
      };
    }
    case "option": {
      const had = taken("features");
      return {
        what: "an option",
        options: choice.from.flatMap((id) =>
          had.has(id)
            ? []
            : [{ id, label: lookup(access, FeatureSchema, id).name }],
        ),
      };
    }
    default:
      return choice satisfies never;
  }
}

function abilityImprovementStep(
  stepKey: string,
  key: string,
  scores: AbilityScores,
  classDef: ClassDef,
): Step {
  const room = (ability: Ability, amount: number): boolean =>
    scores[ability] + amount <= 20;
  const single = ABILITIES.filter((item) => room(item, 2)).map((item) =>
    encodeIncrease([[item, 2]]),
  );
  const open = ABILITIES.filter((item) => room(item, 1));
  const split = open.flatMap((first, index) =>
    open.slice(index + 1).map((second) =>
      encodeIncrease([
        [first, 1],
        [second, 1],
      ]),
    ),
  );
  const [best] = abilityPriority(classDef).filter((item) => room(item, 2));
  return {
    key: stepKey,
    prompt: "Raise your ability scores: +2 to one, or +1 to two.",
    options: [...single, ...split].map((id) => ({
      id,
      label: describeIncrease(id),
    })),
    ...(best ? { prefer: [encodeIncrease([[best, 2]])] } : {}),
    apply: (draft, answer) => ({
      ...draft,
      picks: { ...draft.picks, [key]: [answer] },
    }),
  };
}

// null when every ability it could raise is already 20.
function plusOneStep(
  stepKey: string,
  key: string,
  scores: AbilityScores,
  from: readonly Ability[],
  classDef: ClassDef,
): Step | null {
  const open = ABILITIES.filter(
    (item) => from.includes(item) && scores[item] < 20,
  );
  if (open.length === 0) return null;
  const [best] = abilityPriority(classDef).filter((item) =>
    open.includes(item),
  );
  return {
    key: stepKey,
    prompt: "Raise one ability score by 1.",
    options: open.map((item) => {
      const id = encodeIncrease([[item, 1]]);
      return { id, label: describeIncrease(id) };
    }),
    ...(best ? { prefer: [encodeIncrease([[best, 1]])] } : {}),
    apply: (draft, answer) => ({
      ...draft,
      picks: { ...draft.picks, [key]: [answer] },
    }),
  };
}

function isAbilityImprovement(featId: string): boolean {
  return featId.endsWith("/ability-score-improvement");
}

// Everything this level asks. A feat picked at this level, such as a general feat at level 4, asks its own choices
// too, under `<choice>:feat<n>-` so they can't meet the class's, the origin's or `<choice>:increase`.
function stepChoices(
  draft: Draft,
  base: CharacterBuild | null,
  classDef: ClassDef,
  level: number,
  access: ContentAccess,
): readonly ChoiceDef[] {
  const choices = levelChoices(
    classDef,
    level,
    chosenSubclass(draft.picks, base),
    access,
  );
  const featChoices = choices.flatMap((choice) =>
    choice.kind === "feat"
      ? (draft.picks[choice.id] ?? []).flatMap((id, index) =>
          lookup(access, FeatSchema, id).choices.map((own) => ({
            ...own,
            id: `${choice.id}:feat${String(index)}-${own.id}`,
          })),
        )
      : [],
  );
  return [...choices, ...featChoices, ...originChoices(draft, base, access)];
}

function classStep(
  draft: Draft,
  base: CharacterBuild | null,
  access: ContentAccess,
): Step | null {
  const classDef = lookup(access, ClassSchema, draft.classId ?? "");
  const level = (base?.levels.length ?? 0) + 1;
  for (const choice of stepChoices(draft, base, classDef, level, access)) {
    const picked = draft.picks[choice.id] ?? [];
    const count = "count" in choice ? choice.count : 1;
    if (picked.length < count) {
      const { what, options, prefer } = choiceOptions(
        choice,
        draft,
        base,
        classDef,
        access,
      );
      // Content may have too little on offer, such as a book with no subclasses, and that isn't an error.
      if (options.length > 0) {
        return {
          key: `${String(level)}:${choice.id}-${String(picked.length)}`,
          prompt:
            count > 1
              ? `Choose ${what} (${String(picked.length + 1)} of ${String(count)}).`
              : `Choose ${what}.`,
          options,
          ...(prefer ? { prefer } : {}),
          apply: (current, answer) => ({
            ...current,
            picks: { ...current.picks, [choice.id]: [...picked, answer] },
          }),
        };
      }
    }
    const increaseKey = `${choice.id}:increase`;
    if (draft.picks[increaseKey] || choice.kind !== "feat") continue;
    const scores = () =>
      buildAbilities(base ?? originBuild(draft, placeholderEntry(classDef)));
    if (picked.some(isAbilityImprovement)) {
      return abilityImprovementStep(
        `${String(level)}:${increaseKey}`,
        increaseKey,
        scores(),
        classDef,
      );
    }
    // Most feats raise one of a few abilities by 1, as their Ability Score Increase says.
    const from = picked.flatMap(
      (id) => lookup(access, FeatSchema, id).abilityIncrease ?? [],
    );
    const plusOne =
      from.length > 0
        ? plusOneStep(
            `${String(level)}:${increaseKey}`,
            increaseKey,
            scores(),
            from,
            classDef,
          )
        : null;
    if (plusOne) return plusOne;
  }
  return null;
}

function nextStep(
  draft: Draft,
  base: CharacterBuild | null,
  access: ContentAccess,
  order?: number,
): Step | null {
  if (base) return classStep(draft, base, access);
  const speciesFirst = order === SPECIES_FIRST;
  return (
    originStep(draft, access, speciesFirst) ??
    classStep(draft, base, access) ??
    (speciesFirst ? nameStep(draft, access) : null)
  );
}

function answersOf(
  choices: readonly ChoiceDef[],
  picks: Draft["picks"],
): readonly unknown[] {
  return choices.flatMap((choice): readonly unknown[] => {
    const values = picks[choice.id];
    if (!values || values.length === 0) return [];
    switch (choice.kind) {
      case "subclass":
        return [{ kind: "subclass", values }];
      case "skills":
        return [{ kind: "skills", values }];
      case "spells":
        return [{ kind: "spells", values }];
      case "weaponMastery":
        return [{ kind: "weaponMastery", values }];
      case "option":
        return [{ kind: "features", values }];
      case "feat": {
        const [increase] = picks[`${choice.id}:increase`] ?? [];
        return [
          { kind: "feats", values },
          ...(increase === undefined
            ? []
            : [{ kind: "abilities", increases: parseIncrease(increase) }]),
        ];
      }
      default:
        return choice satisfies never;
    }
  });
}

const LevelEntrySchema = CharacterBuildSchema.shape.levels.element;

function placeholderEntry(classDef: ClassDef): LevelEntry {
  return { classId: classDef.id, hitPointGain: 1, answers: [] };
}

function levelEntry(
  draft: Draft,
  base: CharacterBuild | null,
  access: ContentAccess,
): LevelEntry {
  const classDef = lookup(access, ClassSchema, draft.classId ?? "");
  const level = (base?.levels.length ?? 0) + 1;
  const sides = Number(classDef.hitDie.slice(1));
  return LevelEntrySchema.parse({
    classId: classDef.id,
    // The highest roll at level 1, then the fixed value: half the die plus one.
    hitPointGain: level === 1 ? sides : sides / 2 + 1,
    answers: answersOf(
      stepChoices(draft, base, classDef, level, access),
      draft.picks,
    ),
  });
}

function originBuild(draft: Draft, entry: LevelEntry): CharacterBuild {
  const order = [
    ...draft.scores,
    ...ABILITIES.filter((item) => !draft.scores.includes(item)),
  ];
  return CharacterBuildSchema.parse({
    baseAbilities: Object.fromEntries(
      order.map((ability, index) => [ability, STANDARD_ARRAY[index]]),
    ),
    speciesId: draft.speciesId,
    backgroundId: draft.backgroundId,
    backgroundIncrease: parseIncrease(draft.increase ?? ""),
    levels: [entry],
  });
}

function averageDamage(weapon: Weapon): number {
  const { dice, flat = 0 } = weapon.damage;
  if (dice === undefined) return flat;
  const [count = "0", sides = "0"] = dice.split("d");
  return (Number(count) * (Number(sides) + 1)) / 2;
}

// shortcut: everyone starts with the best gear they can use. The class and background tables, and money, aren't modeled.
export function startingGear(
  classDef: ClassDef,
  abilities: AbilityScores,
  access: ContentAccess,
): readonly string[] {
  const items: readonly Item[] = namedContent(access, "item", ItemSchema);
  const dex = abilityModifier(abilities.dex);
  const str = abilityModifier(abilities.str);
  const best = <T>(list: readonly T[], score: (item: T) => number) =>
    [...list].sort((a, b) => score(b) - score(a))[0];

  const armor = best(
    items.flatMap((item) =>
      item.type === "armor" && classDef.armor.includes(item.armorType)
        ? [item]
        : [],
    ),
    (item) => item.base + (item.addDex ? Math.min(dex, item.maxDex ?? dex) : 0),
  );
  const shield = classDef.armor.includes("shield")
    ? items.find((item) => item.type === "shield")
    : undefined;
  const weapons = items.flatMap((item) =>
    item.type === "weapon" && weaponProficient(classDef, item) ? [item] : [],
  );
  const melee = best(
    weapons.filter(
      (item) =>
        !item.properties.includes("ammunition") &&
        !(shield && item.properties.includes("twoHanded")),
    ),
    (item) =>
      averageDamage(item) +
      2 * (item.properties.includes("finesse") ? Math.max(dex, str) : str),
  );
  const ranged = best(
    weapons.filter((item) => item.properties.includes("ammunition")),
    averageDamage,
  );
  const unarmored = 10 + dex;
  const armorWorthWearing =
    armor &&
    armor.base + (armor.addDex ? Math.min(dex, armor.maxDex ?? dex) : 0) >
      unarmored;
  return [
    ...(melee ? [melee.id] : []),
    ...(ranged ? [ranged.id] : []),
    ...(armorWorthWearing ? [armor.id] : []),
    ...(shield ? [shield.id] : []),
  ];
}

function autoPlay(
  start: Draft,
  base: CharacterBuild | null,
  access: ContentAccess,
  dice: Dice,
): Draft {
  let draft = start;
  for (
    let step = nextStep(draft, base, access);
    step;
    step = nextStep(draft, base, access)
  ) {
    draft = step.apply(draft, pickStep(step, dice));
  }
  return draft;
}

function pickStep(step: Step, dice: Dice): string {
  const { options, prefer } = step;
  const preferred = options.filter((item) => prefer?.includes(item.id));
  const pool = preferred.length > 0 ? preferred : options;
  const option = pool[dice.below(pool.length)];
  if (!option) throw new Error(`${step.key} has no options`);
  return option.id;
}

function finishedCharacter(
  id: string,
  name: string,
  draft: Draft,
  access: ContentAccess,
): Actor {
  const entry = levelEntry(draft, null, access);
  const build = originBuild(draft, entry);
  const classDef = lookup(access, ClassSchema, entry.classId);
  const actor = freshActor({
    id,
    name,
    side: "party",
    source: { kind: "character", build },
    hp: 1,
    inventory: [...startingGear(classDef, buildAbilities(build), access)],
  });
  return { ...actor, hp: deriveStats(actor, access).maxHp };
}

// Built by the same steps the player answers. Companions avoid repeating a class while there are others to take.
export function buildCompanion(
  id: string,
  name: string,
  takenClasses: ReadonlySet<string>,
  access: ContentAccess,
  dice: Dice,
): Actor {
  const classes = namedContent(access, "class", ClassSchema);
  const fresh = classes.filter((item) => !takenClasses.has(item.id));
  const pool = fresh.length > 0 ? fresh : classes;
  const classDef = pool[dice.below(pool.length)];
  if (!classDef) throw new Error("There are no classes to build a companion");
  const draft = autoPlay(
    { classId: classDef.id, scores: [], picks: {} },
    null,
    access,
    dice,
  );
  return finishedCharacter(id, name, draft, access);
}

export function beginCreation(): SystemResult {
  return {
    frames: [
      frame("buildStep", {
        actor: PLAYER_ACTOR,
        draft: { scores: [], picks: {} },
        order: SPECIES_FIRST,
      }),
    ],
  };
}

function actorBuild(actor: Actor): CharacterBuild | null {
  return actor.source.kind === "character" ? actor.source.build : null;
}

function advanceEvents(
  actor: Actor,
  draft: Draft,
  access: ContentAccess,
): readonly SystemEvent[] {
  const build = actorBuild(actor);
  if (!build) throw new Error(`${actor.id} has no character build`);
  const entry = levelEntry(draft, build, access);
  const raised: Actor = {
    ...actor,
    source: {
      kind: "character",
      build: { ...build, levels: [...build.levels, entry] },
    },
  };
  // A higher Constitution raises every earlier level too, so the difference is what counts.
  const gained =
    deriveStats(raised, access).maxHp - deriveStats(actor, access).maxHp;
  return [
    dndEvent(`${NS}:characterAdvanced`, {
      actor: actor.id,
      entry,
      hp: actor.hp + gained,
    }),
    { kind: "levelGained", actor: actor.id },
  ];
}

export const BuildStepSchema = z.object({
  actor: z.string(),
  draft: DraftSchema,
  order: z.literal(SPECIES_FIRST).optional(),
});
const BuildAnswerSchema = BuildStepSchema.extend({ answer: z.string() });

function requireActor(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(`Unknown actor ${id}`);
  return actor;
}

function runBuildStep(
  payload: z.infer<typeof BuildStepSchema>,
  context: Context,
): SystemResult {
  const actor = requireActor(context.state, payload.actor);
  const base = actorBuild(actor);
  const step = nextStep(payload.draft, base, context, payload.order);
  if (step) {
    return {
      frames: [
        awaitDecision({
          id: `${NS}:build:${actor.id}:${step.key}`,
          actor: actor.id,
          prompt: step.prompt,
          options: [...step.options],
          resume: frame("buildAnswer", payload),
          ...(step.text ? { text: step.text } : {}),
          // Nothing has happened yet while a character is being made, so a step can be taken back.
          ...(base ? {} : { revisable: true as const }),
        }),
      ],
    };
  }
  if (base) return { events: advanceEvents(actor, payload.draft, context) };

  const name = payload.draft.name ?? defaultName(payload.draft, context);
  const built = finishedCharacter(actor.id, name, payload.draft, context);
  const build = actorBuild(built);
  if (!build) throw new Error("A new character has no build");
  return {
    events: [
      dndEvent(`${NS}:characterChosen`, {
        actor: actor.id,
        name,
        build,
        inventory: built.inventory,
        hp: built.hp,
      }),
    ],
  };
}

// The player's build step answered as a companion's would, for the balance bot.
export function buildPolicy(decision: Decision, context: Context): string {
  const { actor, draft, order } = BuildStepSchema.parse(
    decision.resume.payload,
  );
  const step = nextStep(
    draft,
    actorBuild(requireActor(context.state, actor)),
    context,
    order,
  );
  if (!step) throw new Error(`${decision.id} has no step`);
  return pickStep(step, context.dice);
}

function runBuildAnswer(
  payload: z.infer<typeof BuildAnswerSchema>,
  context: Context,
): SystemResult {
  const base = actorBuild(requireActor(context.state, payload.actor));
  const step = nextStep(payload.draft, base, context, payload.order);
  if (!step) throw new Error(`Nothing is waiting on ${payload.answer}`);
  return {
    frames: [
      frame("buildStep", {
        actor: payload.actor,
        draft: step.apply(payload.draft, payload.answer),
        ...(payload.order === undefined ? {} : { order: payload.order }),
      }),
    ],
  };
}

// Everyone alive goes up together, which keeps companions at the player's level.
function runAdvanceParty(context: Context): SystemResult {
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  for (const actor of Object.values(context.state.actors)) {
    const build = actorBuild(actor);
    const classId = build?.levels.at(-1)?.classId;
    if (!build || classId === undefined || isDead(actor)) continue;
    const classDef = lookup(context, ClassSchema, classId);
    // Content can stop short of level 20, and the character then stays where it is.
    if (!levelOf(classDef, build.levels.length + 1)) continue;
    const draft: Draft = { classId, scores: [], picks: {} };
    if (actor.id === PLAYER_ACTOR) {
      frames.push(frame("buildStep", { actor: actor.id, draft }));
    } else {
      events.push(
        ...advanceEvents(
          actor,
          autoPlay(draft, build, context, context.dice),
          context,
        ),
      );
    }
  }
  return { events, frames };
}

function awardXp(amount: number, context: Context): SystemResult {
  const player = requireActor(context.state, PLAYER_ACTOR);
  const level = actorBuild(player)?.levels.length ?? 1;
  const reached = levelForXp((player.xp ?? 0) + amount);
  return {
    events: [dndEvent(`${NS}:xpAwarded`, { actor: player.id, amount })],
    frames: Array.from({ length: Math.max(0, reached - level) }, () =>
      frame("advanceParty", {}),
    ),
  };
}

export const characterEffects = {
  [`${NS}:awardXp`]: storyEffect({
    schema: z.strictObject({ amount: z.number().int().min(1) }),
    apply: ({ amount }, context: Context) => awardXp(amount, context),
  }),
  // A milestone is the XP that reaches the next level, so one number drives both ways of levelling.
  [`${NS}:levelUp`]: storyEffect({
    schema: z.strictObject({}),
    apply: (_args, context: Context) => {
      const player = requireActor(context.state, PLAYER_ACTOR);
      const level = actorBuild(player)?.levels.length ?? 1;
      const needed = XP_FOR_LEVEL[level];
      if (needed === undefined) return {};
      return awardXp(Math.max(1, needed - (player.xp ?? 0)), context);
    },
  }),
};

export const characterFrames = {
  [`${NS}:buildStep`]: frameHandler({
    schema: BuildStepSchema,
    run: runBuildStep,
  }),
  [`${NS}:buildAnswer`]: frameHandler({
    schema: BuildAnswerSchema,
    run: runBuildAnswer,
  }),
  [`${NS}:advanceParty`]: frameHandler({
    schema: z.object({}),
    run: (_payload, context: Context) => runAdvanceParty(context),
  }),
};
