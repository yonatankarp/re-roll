import type { ContentAccess, SystemContext, SystemEvent } from "#sdk";
import { abilityCheck } from "./actions.ts";
import { featureCheck } from "./environment.ts";
import {
  type Ability,
  BackgroundSchema,
  type Check,
  ClassSchema,
  ItemSchema,
  type Obstacle,
  SKILL_ABILITIES,
  type Skill,
} from "./schemas.ts";
import { type Actor, type DndState, NS, dndEvent } from "./state.ts";
import { deriveStats, lookup } from "./stats.ts";
import { toolByName, toolKeyOf, toolOf } from "./tools.ts";
import { SKILLS_WITH_DIFFERENT_ABILITIES, variantOn } from "./variant-rules.ts";

// Exploring outside a fight (#153, #185): a scene check says what it acts on (`about`), as a lock or a climb, and
// what deals with that helps. A spell cast between fights (camp.ts) or an item carried gives a `sceneAid`, which
// succeeds without a roll or rolls with Advantage. A tool's proficiency counts on a check with it, or about what it
// deals with when it's carried, as Thieves' Tools on a lock: the Proficiency Bonus, and Advantage with the skill too.

type Context = SystemContext<DndState>;

export interface SceneAid {
  readonly aid: "success" | "advantage";
  readonly sourceId: string; // the effect's or the passive's source, for the log
  readonly spent: boolean; // an active effect with `once`, which this check ends
}

// The best aid the creature has for a check about these: success over Advantage, and one that lasts over one that's
// spent on it.
export function aidFor(
  actor: Actor,
  about: readonly Obstacle[],
  access: ContentAccess,
): SceneAid | null {
  if (about.length === 0) return null;
  const stats = deriveStats(actor, access);
  const aids: SceneAid[] = [
    ...stats.passives.flatMap((passive) =>
      passive.kind === "modifier" &&
      passive.modifier.kind === "sceneAid" &&
      passive.modifier.chance === undefined &&
      passive.modifier.about.some((item) => about.includes(item))
        ? [{ aid: passive.modifier.aid, sourceId: "", spent: false }]
        : [],
    ),
    ...actor.activeEffects.flatMap(({ modifier, sourceId }) =>
      modifier.kind === "sceneAid" &&
      modifier.chance === undefined &&
      modifier.about.some((item) => about.includes(item))
        ? [{ aid: modifier.aid, sourceId, spent: modifier.once === true }]
        : [],
    ),
  ];
  const rank = (aid: SceneAid) =>
    (aid.aid === "success" ? 0 : 2) + (aid.spent ? 1 : 0);
  return [...aids].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// An item carried that may deal with it, by chance, as a Mystery Key with a lock.
function chanceAid(
  actor: Actor,
  about: readonly Obstacle[],
  access: ContentAccess,
): {
  readonly item: string;
  readonly chance: number;
  readonly spends: boolean;
} | null {
  for (const id of new Set(actor.inventory)) {
    const item = ItemSchema.safeParse(access.content(id)).data;
    if (item?.type !== "magicItem") continue;
    for (const passive of item.passives ?? []) {
      if (
        passive.kind === "modifier" &&
        passive.modifier.kind === "sceneAid" &&
        passive.modifier.chance !== undefined &&
        passive.modifier.about.some((obstacle) => about.includes(obstacle))
      )
        return {
          item: id,
          chance: passive.modifier.chance,
          spends: passive.modifier.spends === true,
        };
    }
  }
  return null;
}

// Whether any of these is about one of the obstacles, for offering an aid only where it would help.
export function aidsAny(
  about: readonly Obstacle[],
  checks: readonly Check[],
  access: ContentAccess,
): boolean {
  return checks.some((check) =>
    obstaclesOf(check, access).some((item) => about.includes(item)),
  );
}

export function obstaclesOf(
  check: Check,
  access: ContentAccess,
): readonly Obstacle[] {
  return aboutOf(featureCheck(check, access));
}

// What a check's skill deals with, as swaying someone with Persuasion.
const SKILL_OBSTACLES: Partial<Record<Skill, Obstacle>> = {
  persuasion: "influence",
  deception: "influence",
  intimidation: "influence",
  performance: "influence",
  insight: "truth",
  animalHandling: "beast",
  perception: "hidden",
  investigation: "hidden",
  arcana: "lore",
  history: "lore",
  nature: "lore",
  religion: "lore",
  survival: "way",
};

// What a check is about: what it says, and what its skill deals with.
function aboutOf(check: Check): readonly Obstacle[] {
  const printed = "about" in check ? (check.about ?? []) : [];
  const read =
    "skill" in check && check.skill ? SKILL_OBSTACLES[check.skill] : undefined;
  return read && !printed.includes(read) ? [...printed, read] : printed;
}

// Advantage on a check with the creature it names, from a modifier that goes by whom it's made with (Modifier
// advantage `with`), and Disadvantage on one to influence a Hostile creature, unless the bearer has Cunning Speaker.
export function withEdge(
  actor: Actor,
  check: Check,
  about: readonly Obstacle[],
  access: ContentAccess,
): { readonly advantage: boolean; readonly disadvantage: boolean } {
  const other = "with" in check ? check.with : undefined;
  if (!other) return { advantage: false, disadvantage: false };
  const stats = deriveStats(actor, access);
  const skill = "skill" in check ? check.skill : undefined;
  const advantage = [
    ...actor.activeEffects.map(({ modifier }) => modifier),
    ...stats.passives.flatMap((passive) =>
      passive.kind === "modifier" ? [passive.modifier] : [],
    ),
  ].some(
    (modifier) =>
      modifier.kind === "advantage" &&
      modifier.on === "checks" &&
      modifier.with !== undefined &&
      (!modifier.skills ||
        (skill !== undefined && modifier.skills.includes(skill))) &&
      (!modifier.with.creatureTypes ||
        (other.creatureType !== undefined &&
          modifier.with.creatureTypes.includes(other.creatureType))) &&
      (!modifier.with.kin ||
        (other.kin !== undefined && modifier.with.kin.includes(other.kin))) &&
      (modifier.with.maxCr === undefined ||
        (other.cr !== undefined && other.cr <= modifier.with.maxCr)),
  );
  const disadvantage =
    other.hostile === true &&
    about.includes("influence") &&
    !stats.passives.some(({ kind }) => kind === "cunningSpeaker");
  return { advantage, disadvantage };
}

// Whether someone in the party understands this language: knows it, or understands every language while a spell or
// trait lasts, as Comprehend Languages (the story predicate dnd5.5e:understands).
export function understands(
  language: string,
  party: readonly Actor[],
  access: ContentAccess,
): boolean {
  return party.some((actor) => {
    const stats = deriveStats(actor, access);
    return (
      stats.passives.some(
        (passive) =>
          (passive.kind === "languages" &&
            passive.languages.includes(language)) ||
          (passive.kind === "modifier" &&
            passive.modifier.kind === "comprehension"),
      ) ||
      actor.activeEffects.some(
        ({ modifier }) => modifier.kind === "comprehension",
      )
    );
  });
}

// The tools a character is proficient with, by name (toolKeyOf): its classes', its background's (a choice of kind, as
// "one kind of Gaming Set", names none), and those its features give.
// shortcut: a class taken later gives its tools too, where multiclassing gives only some of them.
export function toolProficiencies(
  actor: Actor,
  access: ContentAccess,
): ReadonlySet<string> {
  const stats = deriveStats(actor, access);
  const build = actor.source.kind === "character" ? actor.source.build : null;
  const background = build
    ? BackgroundSchema.safeParse(access.content(build.backgroundId)).data
    : undefined;
  return new Set(
    [
      ...Object.keys(stats.classLevels).flatMap(
        (id) => lookup(access, ClassSchema, id).tools ?? [],
      ),
      ...(background ? [toolByName(background.tool, access) ?? []].flat() : []),
      ...stats.passives.flatMap((passive) =>
        passive.kind === "toolProficiency" ? passive.tools : [],
      ),
    ].map((id) => toolKeyOf(id, access)),
  );
}

export function isArtisan(tool: string, access: ContentAccess): boolean {
  return toolOf(tool, access)?.artisan === true;
}

// Whether it turns into any Artisan's Tools, as a Manifold Tool, which it's proficient with too.
function anyArtisan(actor: Actor, access: ContentAccess): boolean {
  return deriveStats(actor, access).passives.some(
    ({ kind }) => kind === "anyTool",
  );
}

// Whether it has the tool at hand: carried, or a Manifold Tool that turns into it.
export function hasTool(
  actor: Actor,
  tool: string,
  access: ContentAccess,
): boolean {
  const wanted = toolKeyOf(tool, access);
  return (
    actor.inventory.some((id) => toolKeyOf(id, access) === wanted) ||
    (isArtisan(tool, access) && anyArtisan(actor, access))
  );
}

export interface ToolUse {
  readonly id: string;
  readonly proficient: boolean;
}

// The tool a check uses: the one it names, or, for a check about what a tool deals with, the best one carried.
function toolFor(
  actor: Actor,
  check: Check,
  about: readonly Obstacle[],
  access: ContentAccess,
): ToolUse | null {
  const known = toolProficiencies(actor, access);
  const proficient = {
    has: (id: string) =>
      known.has(toolKeyOf(id, access)) ||
      (isArtisan(id, access) && anyArtisan(actor, access)),
  };
  if ("tool" in check)
    return { id: check.tool, proficient: proficient.has(check.tool) };
  if (about.length === 0) return null;
  const carried = actor.inventory.flatMap((id) => {
    const handles = toolOf(id, access)?.handles;
    return handles && about.some((obstacle) => handles.has(obstacle))
      ? [{ id, proficient: proficient.has(id) }]
      : [];
  });
  return carried.find((use) => use.proficient) ?? carried[0] ?? null;
}

// A scene check by the player's character: an aid that does it outright, a tool it needs and doesn't have, or the
// roll, with the tool's proficiency and any Advantage an aid gives. A skill paired with another ability adds the
// skill's proficiency only with Skills with Different Abilities, and is that ability's plain check without it.
export function sceneCheck(
  actor: Actor,
  check: Check,
  context: Context,
): { readonly success: boolean; readonly events: SystemEvent[] } {
  const parsed = featureCheck(check, context);
  if ("feature" in parsed) throw new Error("A feature check resolves first");
  const about = aboutOf(parsed);
  const aid = aidFor(actor, about, context);
  const spent = aid?.spent
    ? [
        dndEvent(`${NS}:effectEnded`, {
          actor: actor.id,
          sourceId: aid.sourceId,
        }),
      ]
    : [];
  if (aid?.aid === "success") {
    return {
      success: true,
      events: [
        dndEvent(`${NS}:obstacleCleared`, {
          actor: actor.id,
          source: aid.sourceId,
        }),
        ...spent,
      ],
    };
  }
  // An item that works by chance is tried first, and gone once it has worked if it spends itself.
  const lucky = aid ? null : chanceAid(actor, about, context);
  if (lucky && context.dice.roll(100) <= lucky.chance)
    return {
      success: true,
      events: [
        dndEvent(`${NS}:obstacleCleared`, {
          actor: actor.id,
          source: lucky.item,
        }),
        ...(lucky.spends
          ? [dndEvent(`${NS}:itemUsed`, { actor: actor.id, item: lucky.item })]
          : []),
      ],
    };
  if ("tool" in parsed && parsed.needs && !hasTool(actor, parsed.tool, context))
    return {
      success: false,
      events: [
        dndEvent(`${NS}:toolMissing`, { actor: actor.id, tool: parsed.tool }),
      ],
    };
  const printed =
    "skill" in parsed && parsed.skill !== undefined ? parsed.skill : undefined;
  const ability =
    parsed.ability ??
    (printed
      ? SKILL_ABILITIES[printed]
      : "tool" in parsed
        ? toolAbility(parsed.tool, context)
        : undefined);
  if (!ability) throw new Error("A tool check needs an ability");
  const paired =
    printed !== undefined &&
    parsed.ability !== undefined &&
    parsed.ability !== SKILL_ABILITIES[printed];
  const skill =
    printed !== undefined &&
    (!paired || variantOn(context, SKILLS_WITH_DIFFERENT_ABILITIES))
      ? printed
      : undefined;
  const tool = toolFor(actor, parsed, about, context);
  const edge = toolEdge(actor, skill, tool, context);
  const whom = withEdge(actor, parsed, about, context);
  const rolled = abilityCheck(
    actor,
    skill,
    ability,
    parsed.dc,
    () => skill ?? ability,
    context,
    aid?.aid === "advantage" ||
      edge.advantage ||
      whom.advantage ||
      passes(actor, skill, context),
    tool ? { id: tool.id, proficient: edge.proficient } : undefined,
    whom.disadvantage,
  );
  return { success: rolled.success, events: [...rolled.events, ...spent] };
}

// A disguise: Advantage on Deception in a scene, and with Actor's Impersonation on Performance too.
// shortcut: whatever the check is about, as a scene doesn't say whom the character is passing itself off to.
function passes(
  actor: Actor,
  skill: Skill | undefined,
  access: ContentAccess,
): boolean {
  if (skill !== "deception" && skill !== "performance") return false;
  if (
    !actor.activeEffects.some(({ modifier }) => modifier.kind === "disguise")
  ) {
    return false;
  }
  return (
    skill === "deception" ||
    deriveStats(actor, access).passives.some(
      (passive) => passive.kind === "impersonation",
    )
  );
}

function toolAbility(tool: string, access: ContentAccess): Ability | undefined {
  const item = ItemSchema.safeParse(access.content(tool)).data;
  return item?.type === "tool" ? item.ability : undefined;
}

// A tool's proficiency counts as the skill's would, and with the skill as well it gives Advantage.
function toolEdge(
  actor: Actor,
  skill: Skill | undefined,
  tool: ToolUse | null,
  access: ContentAccess,
): { readonly proficient: boolean; readonly advantage: boolean } {
  if (!tool?.proficient) return { proficient: false, advantage: false };
  const skilled =
    skill !== undefined && deriveStats(actor, access).skills.includes(skill);
  return { proficient: true, advantage: skilled };
}
