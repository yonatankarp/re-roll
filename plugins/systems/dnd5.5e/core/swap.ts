import {
  awaitDecision,
  type ContentAccess,
  frameHandler,
  PLAYER_ACTOR,
  type SceneAction,
  storyEffect,
  type SystemResult,
} from "#sdk";
import { z } from "zod";
import {
  choiceOptions,
  latePick,
  levelChoices,
  widening,
} from "./character.ts";
import {
  BackgroundSchema,
  type CharacterBuild,
  type ChoiceDef,
  ClassSchema,
  FeatSchema,
  FeatureSchema,
  SpeciesSchema,
  SubclassSchema,
} from "./schemas.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  effectiveBuild,
  frame,
  NS,
} from "./state.ts";
import {
  deriveStats,
  latePickKey,
  lookup,
  type Stats,
  traitCantrips,
} from "./stats.ts";

// Picks a feat, species or class lets the character change after a Long Rest, as Weapon Master's weapons, or once a level,
// as Magic Initiate's spells, or picks it makes between scenes, as Ritual Caster's, offered beside a scene's choices so
// a save from before them never meets a new decision.
// shortcut: only the player swaps, any time until the next Long Rest (or level), and only picks made since builds
// record whose they are.

type Context = ContentAccess & { readonly state: DndState };

const KINDS = {
  skills: "skills",
  weaponMastery: "weaponMastery",
  features: "option",
  spells: "spells",
} as const;
const KEEP = "keep";
const ADD = "+"; // the "pick" dropped when a late pick adds one

interface Swappable {
  readonly key: string; // "<level>:<answer>" in the build, "trait:<feature>", or latePickKey
  readonly owner: string;
  readonly choices: readonly ChoiceDef[]; // what the new pick comes from, one list each
  readonly values: readonly string[];
  readonly open: boolean; // offered now
  readonly mark?: string; // kept as swapped in place of the key
  readonly adds?: true; // a late pick: one more, nothing dropped
  readonly classId?: string; // a class's own pick, whose options it filters
}

// The answer each kind of choice leaves in a level's build.
const ANSWER_KINDS: Partial<Record<ChoiceDef["kind"], string>> = {
  spells: "spells",
  option: "features",
};

// A class's own picks, matched to the choices its levels ask in order, that its `swaps` (or its subclass's
// Spellcasting's) let it change: one a level, one after each Long Rest, or each after a Long Rest.
// shortcut: a Wizard swaps in any Wizard spell it has slots for, as the spellbook isn't kept apart from its list.
// shortcut: "prepare" changes one spell of each level's picks after a Long Rest, not the whole list at once.
function classPicks(
  build: CharacterBuild,
  access: ContentAccess,
  swapped: readonly string[],
  highestSlot: number,
): Swappable[] {
  const level = build.levels.length;
  const classLevels: Record<string, number> = {};
  const subclasses: Record<string, string> = {};
  return build.levels.flatMap((entry, at) => {
    const classLevel = (classLevels[entry.classId] ?? 0) + 1;
    classLevels[entry.classId] = classLevel;
    for (const answer of entry.answers) {
      if (answer.kind === "subclass" && answer.values[0]) {
        subclasses[entry.classId] = answer.values[0];
      }
    }
    const classDef = ClassSchema.safeParse(access.content(entry.classId)).data;
    if (!classDef) return [];
    const subclassId = subclasses[entry.classId];
    const subclass = subclassId
      ? SubclassSchema.safeParse(access.content(subclassId)).data
      : undefined;
    const rules = { ...subclass?.spellcasting?.swaps, ...classDef.swaps };
    let next = 0;
    // The answer a choice left, the next of its kind in the level's answers.
    const answerFor = (choice: ChoiceDef) => {
      const kind = ANSWER_KINDS[choice.kind];
      const index = entry.answers.findIndex(
        (answer, place) => place >= next && answer.kind === kind,
      );
      const answer = entry.answers[index];
      if (!kind || !answer || !("values" in answer)) return null;
      next = index + 1;
      return "feat" in answer && answer.feat
        ? null
        : { index, values: answer.values };
    };
    // Prepared spells come from any level the class now has slots for, and the lists its features add by now.
    const now = widening(
      classDef,
      build.levels.filter((item) => item.classId === entry.classId).length,
      subclass,
      access,
    );
    const widen = (choice: ChoiceDef): ChoiceDef => {
      if (choice.kind !== "spells") return choice;
      const widened =
        choice.id === "spells" || (choice.id === "cantrips" && now.cantrips)
          ? {
              ...choice,
              ...(now.lists.length > 0 ? { lists: now.lists } : {}),
              ...(now.spells.length > 0 ? { also: now.spells } : {}),
            }
          : choice;
      return widened.id === "spells" || widened.upToSlots
        ? { ...widened, maxLevel: Math.max(widened.maxLevel, highestSlot) }
        : widened;
    };
    const swap = (
      choice: ChoiceDef,
      found: { index: number; values: readonly string[] },
      when: string,
      owner: string,
    ): Swappable => {
      const key = `${String(at)}:${String(found.index)}`;
      const mark =
        when === "levelUp"
          ? `${entry.classId}:${choice.id}@${String(level)}`
          : when === "longRest"
            ? `${entry.classId}:${choice.id}`
            : undefined;
      return {
        key,
        owner,
        choices: [widen(choice)],
        values: found.values,
        // "shortRest" is offered whenever the party is between fights, as a Book of Shadows conjured again.
        open:
          when === "shortRest" ||
          ((when !== "levelUp" || level > at + 1) &&
            !swapped.includes(mark ?? key)),
        ...(mark ? { mark } : {}),
        classId: entry.classId,
      };
    };
    const options: string[] = []; // options picked here, whose own choices come after the level's
    const own = levelChoices(classDef, classLevel, subclassId, access).flatMap(
      (choice): Swappable[] => {
        const found = answerFor(choice);
        if (!found) return [];
        if (choice.kind === "option") options.push(...found.values);
        const group =
          choice.kind === "option"
            ? "options"
            : choice.kind === "spells" && choice.maxLevel === 0
              ? "cantrips"
              : "spells";
        const stated =
          choice.kind === "spells" && choice.swap ? choice.swap : undefined;
        const when =
          stated ??
          (choice.id === group || choice.kind === "option"
            ? rules[group]
            : undefined);
        return when
          ? [swap(choice, found, when, `${classDef.name} ${group}`)]
          : [];
      },
    );
    // An option's own choices that can be picked again, as Pact of the Tome's after a rest.
    const fromOptions = options.flatMap((id) => {
      const feature = FeatureSchema.safeParse(access.content(id)).data;
      return (feature?.choices ?? []).flatMap((choice): Swappable[] => {
        const found = answerFor(choice);
        return found && choice.kind === "spells" && choice.swap
          ? [swap(choice, found, choice.swap, feature?.name ?? id)]
          : [];
      });
    });
    return [...own, ...fromOptions];
  });
}

export function swappable(
  actor: Actor,
  access: ContentAccess,
): readonly Swappable[] {
  const build = effectiveBuild(actor);
  if (!build) return [];
  const level = build.levels.length;
  const swapped = actor.swapped ?? [];
  const fromAnswers = build.levels.flatMap((entry, at) =>
    entry.answers.flatMap((answer, index): Swappable[] => {
      if (answer.kind === "variant") {
        const feature = FeatureSchema.safeParse(
          access.content(answer.feature),
        ).data;
        // shortcut: "shortRest" is offered between fights whenever the party has rested, once or not.
        return feature?.variantSwap
          ? [
              {
                key: `${String(at)}:${String(index)}`,
                owner: feature.name,
                choices: [
                  {
                    kind: "variant",
                    id: `variant:${feature.id}`,
                    feature: feature.id,
                    count: 1,
                  },
                ],
                values: answer.values,
                // "longRest" once after each Long Rest, as Circle of the Land's land.
                open:
                  feature.variantSwap === "shortRest" ||
                  !swapped.includes(`${String(at)}:${String(index)}`),
              },
            ]
          : [];
      }
      if (!(answer.kind in KINDS) || !("feat" in answer) || !answer.feat) {
        return [];
      }
      const kind = KINDS[answer.kind as keyof typeof KINDS];
      const content = access.content(answer.feat);
      const owner =
        FeatSchema.safeParse(content).data ??
        SpeciesSchema.safeParse(content).data;
      if (!owner || !("values" in answer)) return [];
      // A feat's second spells answer is its second spells choice, as Magic Initiate's level 1 spell.
      const nth = entry.answers
        .slice(0, index)
        .filter(
          (other) =>
            other.kind === answer.kind &&
            "feat" in other &&
            other.feat === answer.feat,
        ).length;
      const choice =
        kind === "spells"
          ? owner.choices.filter(
              (item) => item.kind === "spells" && !latePick(item),
            )[nth]
          : owner.choices.find(
              (item) =>
                item.kind === kind &&
                "swap" in item &&
                item.swap === "longRest" &&
                (item.kind !== "skills" ||
                  Boolean(item.expertise) ===
                    (answer.kind === "skills" && answer.expertise === true)),
            );
      if (!choice || !("swap" in choice) || !choice.swap) return [];
      const key = `${String(at)}:${String(index)}`;
      const mark =
        choice.swap === "levelUp"
          ? `${answer.feat}@${String(level)}`
          : undefined;
      return [
        {
          key,
          owner: owner.name,
          choices: [choice],
          values: answer.values,
          open: mark
            ? level > at + 1 && !swapped.includes(mark)
            : !swapped.includes(key),
          ...(mark ? { mark } : {}),
        },
      ];
    }),
  );
  const stats = deriveStats(actor, access);
  const fromClasses = classPicks(
    build,
    access,
    swapped,
    stats.slots.findLastIndex((count) => count > 0) + 1,
  );
  const traits = stats.features.flatMap((id): Swappable[] => {
    const feature = FeatureSchema.safeParse(access.content(id)).data;
    if (!feature?.swapCantrip) return [];
    const key = `trait:${id}`;
    return [
      {
        key,
        owner: feature.name,
        choices: feature.swapCantrip.map((list) => ({
          kind: "spells" as const,
          id: key,
          count: 1,
          maxLevel: 0,
          list,
        })),
        values: actor.swaps?.[key] ?? traitCantrips(feature, access),
        open: !swapped.includes(key),
      },
    ];
  });
  const background = lookup(access, BackgroundSchema, build.backgroundId);
  const feats = new Set([
    background.feat,
    ...build.levels.flatMap((entry) =>
      entry.answers.flatMap((answer) =>
        answer.kind === "feats" ? answer.values : [],
      ),
    ),
  ]);
  const late = [...feats].flatMap((featId) => {
    const feat = FeatSchema.safeParse(access.content(featId)).data;
    return (feat?.choices ?? []).flatMap((choice): Swappable[] => {
      if (choice.kind !== "spells" || !latePick(choice)) return [];
      const key = latePickKey(featId, choice.id);
      const values = actor.swaps?.[key] ?? [];
      const wanted = choice.grows
        ? stats.proficiency
        : choice.late
          ? choice.count
          : knowsElsewhere(
                actor,
                stats,
                feat?.grants ?? [],
                choice.ifKnown,
                access,
              )
            ? choice.count
            : 0;
      return [
        {
          key,
          owner: feat?.name ?? featId,
          choices: [choice],
          values,
          open: values.length < wanted,
          adds: true,
        },
      ];
    });
  });
  return [...fromAnswers, ...fromClasses, ...traits, ...late];
}

// Whether the character knows the spell other than through these features, as a Light from a class.
function knowsElsewhere(
  actor: Actor,
  stats: Stats,
  except: readonly string[],
  spell: string | undefined,
  access: ContentAccess,
): boolean {
  if (spell === undefined) return false;
  const build = effectiveBuild(actor);
  const picked = (build?.levels ?? []).some((entry) =>
    entry.answers.some(
      (answer) => answer.kind === "spells" && answer.values.includes(spell),
    ),
  );
  return (
    picked ||
    stats.features.some(
      (id) =>
        !except.includes(id) &&
        Object.values(
          FeatureSchema.safeParse(access.content(id)).data?.spells ?? {},
        ).some((ids) => ids.includes(spell)),
    )
  );
}

export function sceneSwapActions(
  state: DndState,
  access: ContentAccess,
): SceneAction[] {
  const actor = state.actors[PLAYER_ACTOR];
  if (!actor || state.combat || state.sinceLongRest === undefined) return [];
  return swappable(actor, access)
    .filter(({ open }) => open)
    .map(({ key, owner, adds }) => ({
      id: `swap:${key}`,
      label: adds ? `Make a pick of ${owner}` : `Change a pick of ${owner}`,
      effect: `${NS}:swap`,
      args: { key },
    }));
}

function nameOf(id: string, access: ContentAccess, choice?: ChoiceDef): string {
  if (choice?.kind === "variant") {
    const feature = FeatureSchema.safeParse(
      access.content(choice.feature),
    ).data;
    return feature?.variants?.find((item) => item.id === id)?.name ?? id;
  }
  const entry = access.content(id) as { name?: unknown } | undefined;
  return typeof entry?.name === "string" ? entry.name : id;
}

const StepSchema = z.object({
  actor: z.string(),
  key: z.string(),
  drop: z.string().optional(),
});
const AnswerSchema = StepSchema.extend({ answer: z.string() });

function runSwapStep(
  payload: z.infer<typeof StepSchema>,
  context: Context,
): SystemResult {
  const actor = context.state.actors[payload.actor];
  const found = actor
    ? swappable(actor, context).find(({ key }) => key === payload.key)
    : undefined;
  const build = actor ? effectiveBuild(actor) : null;
  if (!actor || !found || !build) return {};
  const id = `${NS}:swap:${actor.id}:${payload.key}:${payload.drop ?? ""}`;
  const keep = { id: KEEP, label: "Keep it as it is" };
  const resume = (drop?: string) =>
    frame("swapAnswer", {
      actor: actor.id,
      key: payload.key,
      ...(drop === undefined ? {} : { drop }),
    });
  // With several picks, which one changes is asked first.
  const [only] = found.values;
  const drop =
    payload.drop ??
    (found.adds ? ADD : found.values.length === 1 ? only : undefined);
  if (drop === undefined) {
    return {
      frames: [
        awaitDecision({
          id,
          actor: actor.id,
          prompt: `Which pick of ${found.owner} do you change?`,
          options: [
            ...found.values.map((value) => ({
              id: value,
              label: nameOf(value, context),
            })),
            keep,
          ],
          resume: resume(),
        }),
      ],
    };
  }
  const [first] = build.levels;
  const classDef = lookup(
    context,
    ClassSchema,
    found.classId ?? first?.classId ?? "",
  );
  const seen = new Set(found.values);
  const options = found.choices.flatMap(
    (choice) =>
      choiceOptions(choice, { picks: {}, scores: [] }, build, classDef, context)
        .options,
  );
  return {
    frames: [
      awaitDecision({
        id,
        actor: actor.id,
        prompt:
          drop === ADD
            ? `${found.owner}: which do you pick?`
            : `${found.owner}: what takes the place of ${nameOf(drop, context, found.choices[0])}?`,
        options: [
          ...options.filter((option) => {
            const fresh = !seen.has(option.id);
            seen.add(option.id);
            return fresh;
          }),
          keep,
        ],
        resume: resume(drop),
      }),
    ],
  };
}

function runSwapAnswer(
  payload: z.infer<typeof AnswerSchema>,
  context: Context,
): SystemResult {
  const { actor, key, drop, answer } = payload;
  if (answer === KEEP) return {};
  const holder = context.state.actors[actor];
  const found = holder
    ? swappable(holder, context).find((item) => item.key === key)
    : undefined;
  if (!found) return {};
  if (drop === undefined) {
    return { frames: [frame("swapStep", { actor, key, drop: answer })] };
  }
  return {
    events: [
      dndEvent(`${NS}:answerSwapped`, {
        actor,
        key,
        values:
          drop === ADD
            ? [...found.values, answer]
            : found.values.map((value) => (value === drop ? answer : value)),
        ...(found.mark ? { mark: found.mark } : {}),
      }),
    ],
  };
}

export const swapEffects = {
  [`${NS}:swap`]: storyEffect({
    schema: z.object({ key: z.string() }),
    apply: ({ key }, _context: Context) => ({
      frames: [frame("swapStep", { actor: PLAYER_ACTOR, key })],
    }),
  }),
};

export const swapFrames = {
  [`${NS}:swapStep`]: frameHandler({ schema: StepSchema, run: runSwapStep }),
  [`${NS}:swapAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runSwapAnswer,
  }),
};
