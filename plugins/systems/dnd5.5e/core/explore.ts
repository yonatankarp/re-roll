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
import { toolByName, toolKeyOf } from "./tools.ts";
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
  const parsed = featureCheck(check, access);
  return "about" in parsed ? (parsed.about ?? []) : [];
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
  const item = ItemSchema.safeParse(access.content(tool)).data;
  return item?.type === "tool" && item.artisan === true;
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
    const item = ItemSchema.safeParse(access.content(id)).data;
    return item?.type === "tool" &&
      item.handles?.some((obstacle) => about.includes(obstacle))
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
  const about = parsed.about ?? [];
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
  const rolled = abilityCheck(
    actor,
    skill,
    ability,
    parsed.dc,
    () => skill ?? ability,
    context,
    aid?.aid === "advantage" || edge.advantage,
    tool ? { id: tool.id, proficient: edge.proficient } : undefined,
  );
  return { success: rolled.success, events: [...rolled.events, ...spent] };
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
