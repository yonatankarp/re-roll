import { ContentIdSchema, type Frame, type SystemEvent } from "#sdk";
import { z } from "zod";
import {
  AbilitySchema,
  CharacterBuildSchema,
  ConditionSchema,
  DamageSchema,
  DamageTypeSchema,
  LootSchema,
  ModifierSchema,
} from "./schemas.ts";
import { settleForms } from "./forms.ts";

export const NS = "dnd5.5e";

// Every frame kind the plugin registers, without its namespace. Saves store them, so none is ever renamed;
// a test checks this list against the handlers index.ts registers.
export const FRAME_KINDS = [
  "advanceParty",
  "advanceTurn",
  "afterAction",
  "afterHit",
  "afterMove",
  "afterReaction",
  "afterTurnStart",
  "aimArea",
  "applyHit",
  "attackRoll",
  "buildAnswer",
  "buildStep",
  "characterChosen",
  "checkCombatEnd",
  "companionsSpend",
  "concentrationSave",
  "endTurn",
  "escape",
  "finishMove",
  "finishRest",
  "finishTurn",
  "gearAnswer",
  "gearStep",
  "inspiration",
  "lairAction",
  "lairTurn",
  "legendaryAction",
  "legendaryTurn",
  "lingeringTick",
  "masteryHit",
  "masteryMiss",
  "metamagic",
  "metamagicSpent",
  "move",
  "pickTargets",
  "precision",
  "projectile",
  "recheckHit",
  "shopAnswer",
  "shopStep",
  "shortRestAnswer",
  "shortRestStep",
  "sheetAnswer",
  "sheetStep",
  "smite",
  "takeAction",
  "teleport",
  "useAction",
  "useItem",
] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

export function frame(kind: FrameKind, payload: Frame["payload"] = {}): Frame {
  return { kind: `${NS}:${kind}`, payload };
}
export const LEGENDARY_USE = "legendary";
export const LEGENDARY_RESISTANCE = "legendaryResistance";

export const TACTICS = [
  "dodge",
  "disengage",
  "dash",
  "hidden",
  "ready",
  "slowed",
  "metamagic", // a Metamagic option waiting for its spell, or Extended Spell's hold on Concentration (metamagic.ts)
  "exiting", // the feet of movement climbing out of a dead swallower still costs (combat/swallow.ts)
] as const;

const EndsSchema = z.enum([
  "concentration",
  "casterNextTurn",
  "casterNextTurnEnd",
  "casterTurnEnd",
  "spellDuration",
]);

const ActiveEffectSchema = z.strictObject({
  sourceId: z.string(),
  casterId: z.string(),
  modifier: z.union([
    ModifierSchema,
    z.strictObject({
      kind: z.literal("condition"),
      condition: ConditionSchema,
    }),
    // Another creature's shape, by its stat block (core/forms.ts).
    z.strictObject({ kind: z.literal("form"), monster: ContentIdSchema }),
    // An area a spell left on the map, kept on its caster (core/zones.ts).
    z.strictObject({
      kind: z.literal("zone"),
      zone: z.enum(["darkness", "fog", "thorns", "light"]),
      at: z.strictObject({ x: z.number().int(), y: z.number().int() }),
      radius: z.number().int(),
      damage: z.array(DamageSchema).optional(),
    }),
    // What an action anyone can take, such as Dodge, or a weapon mastery, leaves behind (core/tactics.ts).
    z.strictObject({
      kind: z.literal("tactic"),
      tactic: z.enum(TACTICS),
      value: z.number().int().optional(), // hidden: the Stealth total a Search must beat
      action: z.string().optional(), // ready: the attack it makes; metamagic: the spell it changes
    }),
  ]),
  // "casterNextTurnEnd" becomes "casterTurnEnd" when the caster's next turn starts, and ends with that turn.
  ends: EndsSchema,
  repeatSave: z
    .strictObject({ ability: AbilitySchema, dc: z.number().int() })
    .optional(),
  endsOnDamage: z.boolean().optional(),
  endsOnSpell: z.boolean().optional(), // ends when another spell targets the creature
  level: z.number().int().optional(), // the slot a spell was cast with, when it was given one
  // Inside its caster, as swallowed (combat/swallow.ts): what took the creature out of a grapple and into itself.
  swallowed: z.boolean().optional(),
  // The condition a failed repeat save leaves instead of this one (combat/turn.ts).
  secondFailure: z
    .strictObject({
      condition: ConditionSchema,
      ends: EndsSchema,
      endsOnDamage: z.boolean().optional(),
    })
    .optional(),
});
export type ActiveEffect = z.infer<typeof ActiveEffectSchema>;

const SquareSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
});
const GridSchema = z.strictObject({
  width: z.number().int(),
  height: z.number().int(),
});
// A battle map's ground, cover and light, as "x,y" squares. Missing in fights on plain maps and older saves.
export const TerrainSchema = z.strictObject({
  difficult: z.array(z.string()),
  half: z.array(z.string()), // half cover
  threeQuarters: z.array(z.string()),
  dim: z.array(z.string()),
  dark: z.array(z.string()),
  light: z.enum(["bright", "dim", "dark"]), // everywhere else
});
export type Terrain = z.infer<typeof TerrainSchema>;
// The picture a fight is drawn on, when its encounter has a battle map.
const FightMapSchema = z.strictObject({
  image: z.string(),
  imageWidth: z.number().int(),
  imageHeight: z.number().int(),
  crop: z.strictObject({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  }),
});

const ActorSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  side: z.enum(["party", "enemy"]),
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("character"),
      build: CharacterBuildSchema.nullable(), // null until the player has chosen
    }),
    z.strictObject({
      kind: z.literal("monster"),
      statBlockId: ContentIdSchema,
    }),
  ]),
  hp: z.number().int(),
  tempHp: z.number().int(),
  deathSaves: z.strictObject({
    successes: z.number().int(),
    failures: z.number().int(),
  }),
  exhaustion: z.number().int(),
  heroicInspiration: z.boolean(),
  budget: z.strictObject({
    action: z.boolean(),
    bonusAction: z.boolean(),
    reaction: z.boolean(),
  }),
  usedThisTurn: z.array(z.string()),
  resourcesSpent: z.record(z.string(), z.number().int()),
  activeEffects: z.array(ActiveEffectSchema),
  concentratingOn: z.string().nullable(),
  inventory: z.array(ContentIdSchema),
  // Copies in `inventory` carried in the pack rather than worn or wielded. Missing in older saves, where all is worn.
  stowed: z.array(ContentIdSchema).optional(),
  attuned: z.array(ContentIdSchema).optional(), // magic items attuned to, at most MAX_ATTUNED
  xp: z.number().int().optional(), // only the player's is tracked, and the party levels together
  // Where the creature stands in a fight, null outside one. Saves from before the grid have none.
  position: SquareSchema.nullable().default(null),
  moved: z.number().int().default(0), // feet moved this turn
  // Damage taken this turn from creatures it has swallowed. Missing until there is some.
  insideDamage: z.number().int().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const DIFFICULTIES = ["story", "normal", "hard"] as const;

const SurpriseSchema = z.enum(["party", "enemies"]);
// A fight in a monster's lair. Lair actions come just before the turn at `at` in the order: initiative 20, losing ties.
const LairSchema = z.strictObject({ at: z.number().int() });
export const MAX_ATTUNED = 3;

export const StateSchema = z.strictObject({
  // Chosen when the game starts. Missing in saves from before there was a choice, which played as normal.
  difficulty: z.enum(DIFFICULTIES).optional(),
  gold: z.number().min(0).optional(), // the party's coins, in gold pieces, with copper as hundredths
  // What each merchant has sold, by name, so limited stock stays sold on a later visit.
  shopBought: z.record(z.string(), z.array(ContentIdSchema)).optional(),
  actors: z.record(z.string(), ActorSchema),
  // Hours since the last Long Rest began. Missing until the first, so the first is always allowed.
  sinceLongRest: z.number().int().optional(),
  surprise: SurpriseSchema.optional(), // set by the story for the next fight, such as after a Stealth check
  combat: z
    .strictObject({
      encounter: z.string(),
      order: z.array(z.string()),
      index: z.number().int(),
      round: z.number().int(),
      canFlee: z.boolean().optional(),
      defeatContinues: z.boolean().optional(),
      grid: GridSchema.optional(),
      walls: z.array(z.string()).optional(), // squares no one can enter, as "x,y"
      terrain: TerrainSchema.optional(),
      map: FightMapSchema.optional(),
      loot: LootSchema.optional(), // found if the party wins
      lair: LairSchema.optional(),
    })
    .nullable(),
});
export type DndState = z.infer<typeof StateSchema>;

const CharacterChosenSchema = z.strictObject({
  actor: z.string(),
  name: z.string(),
  build: CharacterBuildSchema,
  inventory: z.array(ContentIdSchema),
  hp: z.number().int(),
});
const CharacterAdvancedSchema = z.strictObject({
  actor: z.string(),
  entry: CharacterBuildSchema.shape.levels.element,
  hp: z.number().int(),
});
const XpAwardedSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
});
const RestedSchema = z.strictObject({
  actor: z.string(),
  rest: z.enum(["short", "long"]),
  maxHp: z.number().int(),
  resourcesSpent: z.record(z.string(), z.number().int()),
});
// Rests are the only thing that passes time, so they're the clock for the one-Long-Rest-a-day rule.
export const REST_HOURS = { short: 1, long: 8 } as const;
const RestFinishedSchema = z.strictObject({ rest: z.enum(["short", "long"]) });
const CombatStartedSchema = z.strictObject({
  encounter: z.string(),
  monsters: z.array(ActorSchema),
  order: z.array(z.string()),
  canFlee: z.boolean().optional(),
  defeatContinues: z.boolean().optional(),
  grid: GridSchema.optional(),
  positions: z.record(z.string(), SquareSchema).optional(),
  walls: z.array(z.string()).optional(),
  terrain: TerrainSchema.optional(),
  map: FightMapSchema.optional(),
  loot: LootSchema.optional(),
  surprised: SurpriseSchema.optional(),
  lair: LairSchema.optional(),
});
const TreasureFoundSchema = z.strictObject({
  actor: z.string(), // who carries the items
  gold: z.number().int(),
  items: z.array(ContentIdSchema),
  stowed: z.array(ContentIdSchema), // the found gear that goes in the pack
});
const GearChangedSchema = z.strictObject({
  actor: z.string(),
  stowed: z.array(ContentIdSchema),
  attuned: z.array(ContentIdSchema),
});
const TradedSchema = z.strictObject({
  actor: z.string(),
  merchant: z.string(),
  item: ContentIdSchema,
  bought: z.boolean(), // false for sold
  priceCp: z.number().int().min(0),
  stowed: z.boolean(), // bought gear goes in the pack, as found gear does
});
const ItemUsedSchema = z.strictObject({
  actor: z.string(),
  item: ContentIdSchema,
});
const MovedSchema = z.strictObject({
  actor: z.string(),
  to: SquareSchema,
  feet: z.number().int(),
});
const ActorOnlySchema = z.strictObject({ actor: z.string() });
const BudgetSpentSchema = z.strictObject({
  actor: z.string(),
  kind: z.enum(["action", "bonusAction", "reaction"]),
});
const ResourceSpentSchema = z.strictObject({
  actor: z.string(),
  resource: z.string(),
});
const ResourceRestoredSchema = z.strictObject({
  actor: z.string(),
  resource: z.string(),
  amount: z.number().int().min(1).optional(), // only so many uses, as Font of Magic gives; all when missing
});
const OncePerTurnSchema = z.strictObject({
  actor: z.string(),
  key: z.string(),
});
const DamagedSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
  type: DamageTypeSchema,
  critical: z.boolean(),
  massive: z.boolean(),
});
const HealedSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
  max: z.number().int(),
});
const TempHpSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
});
const EffectAddedSchema = z.strictObject({
  actor: z.string(),
  effect: ActiveEffectSchema,
});
// With casterId, only that caster's effects from the source end, so one of two snakes letting go leaves the other's
// grapple. Older saves have none, and ended every caster's.
const EffectEndedSchema = z.strictObject({
  actor: z.string(),
  sourceId: z.string(),
  casterId: z.string().optional(),
});
const DamagedFromInsideSchema = z.strictObject({
  actor: z.string(), // the swallower
  amount: z.number().int(),
});
const ConditionRemovedSchema = z.strictObject({
  actor: z.string(),
  condition: ConditionSchema,
});
const ConcentrationStartedSchema = z.strictObject({
  actor: z.string(),
  spell: z.string(),
});
const DeathSaveSchema = z.strictObject({
  actor: z.string(),
  natural: z.number().int(),
});
const RollReportSchema = z.strictObject({
  actor: z.string(),
  against: z.string(),
  natural: z.number().int(),
  total: z.number().int(),
  target: z.number().int(),
  success: z.boolean(),
  label: z.string(),
});
// A saving throw against something other than a spell, such as a Grapple, so it shows in the log.
const SaveReportSchema = z.strictObject({
  actor: z.string(),
  ability: AbilitySchema,
  dc: z.number().int(),
  success: z.boolean(),
  label: z.string(),
});

// A saving throw, recorded only for the roll history: the outcome lives in the events that follow it.
const SaveRolledSchema = z.strictObject({
  actor: z.string(),
  ability: AbilitySchema,
  natural: z.number().int(),
  total: z.number().int(),
  dc: z.number().int(),
  success: z.boolean(),
});

// `key` marks one that can't be taken again until the monster's next turn.
const LegendaryActionTakenSchema = z.strictObject({
  actor: z.string(),
  name: z.string(),
  cost: z.number().int(),
  key: z.string().optional(),
});
const LairActionTakenSchema = z.strictObject({
  actor: z.string(),
  name: z.string(),
});

export const EVENT_SCHEMAS = {
  [`${NS}:characterChosen`]: CharacterChosenSchema,
  [`${NS}:characterAdvanced`]: CharacterAdvancedSchema,
  [`${NS}:xpAwarded`]: XpAwardedSchema,
  [`${NS}:rested`]: RestedSchema,
  [`${NS}:restFinished`]: RestFinishedSchema,
  [`${NS}:combatStarted`]: CombatStartedSchema,
  [`${NS}:combatEnded`]: z.strictObject({}),
  [`${NS}:turnAdvanced`]: z.strictObject({}),
  [`${NS}:moved`]: MovedSchema,
  [`${NS}:budgetSpent`]: BudgetSpentSchema,
  [`${NS}:actionRegained`]: ActorOnlySchema,
  [`${NS}:resourceSpent`]: ResourceSpentSchema,
  [`${NS}:resourceRestored`]: ResourceRestoredSchema,
  [`${NS}:oncePerTurnUsed`]: OncePerTurnSchema,
  [`${NS}:damaged`]: DamagedSchema,
  [`${NS}:damagedFromInside`]: DamagedFromInsideSchema,
  [`${NS}:healed`]: HealedSchema,
  [`${NS}:tempHpGained`]: TempHpSchema,
  [`${NS}:effectAdded`]: EffectAddedSchema,
  [`${NS}:effectEnded`]: EffectEndedSchema,
  [`${NS}:conditionRemoved`]: ConditionRemovedSchema,
  [`${NS}:concentrationStarted`]: ConcentrationStartedSchema,
  [`${NS}:concentrationEnded`]: ActorOnlySchema,
  [`${NS}:deathSaveRolled`]: DeathSaveSchema,
  [`${NS}:rollReported`]: RollReportSchema,
  [`${NS}:saveReported`]: SaveReportSchema,
  [`${NS}:saveRolled`]: SaveRolledSchema,
  [`${NS}:inspirationGranted`]: ActorOnlySchema,
  [`${NS}:inspirationSpent`]: ActorOnlySchema,
  [`${NS}:treasureFound`]: TreasureFoundSchema,
  [`${NS}:gearChanged`]: GearChangedSchema,
  [`${NS}:itemUsed`]: ItemUsedSchema,
  [`${NS}:legendaryActionTaken`]: LegendaryActionTakenSchema,
  [`${NS}:legendaryResistanceUsed`]: ActorOnlySchema,
  [`${NS}:lairActionTaken`]: LairActionTakenSchema,
  [`${NS}:surpriseSet`]: z.strictObject({ side: SurpriseSchema }),
  [`${NS}:traded`]: TradedSchema,
  // A dying creature someone stabilized with the Help action: Stable, as after three successes.
  [`${NS}:stabilized`]: ActorOnlySchema,
} as const;

export type EventKind = keyof typeof EVENT_SCHEMAS;

export function dndEvent<K extends EventKind>(
  kind: K,
  payload: z.infer<(typeof EVENT_SCHEMAS)[K]>,
): SystemEvent {
  return { kind: kind as `${string}:${string}`, payload };
}

export function freshActor(
  fields: Pick<Actor, "id" | "name" | "side" | "source" | "hp" | "inventory">,
): Actor {
  return {
    ...fields,
    tempHp: 0,
    deathSaves: { successes: 0, failures: 0 },
    exhaustion: 0,
    heroicInspiration: false,
    budget: { action: true, bonusAction: true, reaction: true },
    usedThisTurn: [],
    resourcesSpent: {},
    activeEffects: [],
    concentratingOn: null,
    position: null,
    moved: 0,
  };
}

// Removes one copy of each id in `taken`, so two daggers stay two daggers.
export function without(
  list: readonly string[],
  taken: readonly string[],
): string[] {
  const left = [...taken];
  return list.filter((id) => {
    const at = left.indexOf(id);
    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
}

// What the actor wears and wields: everything carried that isn't stowed.
export function equipped(actor: Actor): string[] {
  return without(actor.inventory, actor.stowed ?? []);
}

type Condition = z.infer<typeof ConditionSchema>;

export function hasCondition(
  actor: Actor,
  ...conditions: readonly Condition[]
): boolean {
  return actor.activeEffects.some(
    ({ modifier }) =>
      modifier.kind === "condition" && conditions.includes(modifier.condition),
  );
}

// Invisible to this viewer: it has the condition and the viewer has nothing that sees through it.
export function invisibleTo(target: Actor, viewer: Actor): boolean {
  return (
    hasCondition(target, "invisible") &&
    !viewer.activeEffects.some(
      ({ modifier }) => modifier.kind === "seeInvisible",
    )
  );
}

export const INCAPACITATING: readonly Condition[] = [
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
];

export function isDown(actor: Actor): boolean {
  return actor.hp <= 0;
}

export function isDead(actor: Actor): boolean {
  if (actor.hp > 0) return false;
  return actor.side === "enemy" || actor.deathSaves.failures >= 3;
}

// Three successes make a dying character Stable: no more death saves until healed.
export function isStable(actor: Actor): boolean {
  return (
    actor.side === "party" &&
    actor.hp <= 0 &&
    actor.deathSaves.successes >= 3 &&
    actor.deathSaves.failures < 3
  );
}

function updateActor(
  state: DndState,
  id: string,
  change: (actor: Actor) => Actor,
): DndState {
  const actor = state.actors[id];
  if (!actor) throw new Error(`Unknown actor ${id}`);
  return { ...state, actors: { ...state.actors, [id]: change(actor) } };
}

function advanceTurn(state: DndState): DndState {
  const { combat } = state;
  if (!combat) return state;
  const count = combat.order.length;
  let { index, round } = combat;
  for (let step = 0; step < count; step += 1) {
    index += 1;
    if (index >= count) {
      index = 0;
      round += 1;
    }
    const next = state.actors[combat.order[index] ?? ""];
    if (next && !isDead(next) && !isStable(next)) break;
  }
  const nextId = combat.order[index] ?? "";
  const endingId = combat.order[combat.index];
  const actors = Object.fromEntries(
    Object.entries(state.actors).map(([id, actor]) => [
      id,
      {
        ...actor,
        // Damage from inside counts within a single turn.
        ...(actor.insideDamage ? { insideDamage: 0 } : {}),
        // A "until your next turn" effect ends when its caster's turn comes round.
        activeEffects: actor.activeEffects
          .filter(
            (effect) =>
              (effect.ends !== "casterNextTurn" ||
                effect.casterId !== nextId) &&
              (effect.ends !== "casterTurnEnd" || effect.casterId !== endingId),
          )
          .map((effect) =>
            effect.ends === "casterNextTurnEnd" && effect.casterId === nextId
              ? { ...effect, ends: "casterTurnEnd" as const }
              : effect,
          ),
        ...(id === nextId
          ? {
              budget: { action: true, bonusAction: true, reaction: true },
              usedThisTurn: [],
              moved: 0,
            }
          : {}),
      },
    ]),
  );
  return { ...state, actors, combat: { ...combat, index, round } };
}

function removeConcentration(state: DndState, casterId: string): DndState {
  const actors = Object.fromEntries(
    Object.entries(state.actors).map(([id, actor]) => [
      id,
      {
        ...actor,
        activeEffects: actor.activeEffects.filter(
          (effect) =>
            effect.ends !== "concentration" || effect.casterId !== casterId,
        ),
        concentratingOn: id === casterId ? null : actor.concentratingOn,
      },
    ]),
  );
  return { ...state, actors };
}

function endCombat(state: DndState): DndState {
  const actors = Object.fromEntries(
    Object.entries(state.actors)
      .filter(([, actor]) => actor.side === "party")
      .map(([id, actor]) => [
        id,
        {
          ...actor,
          activeEffects: [],
          concentratingOn: null,
          budget: { action: true, bonusAction: true, reaction: true },
          usedThisTurn: [],
          position: null,
          moved: 0,
          // shortcut: everyone downed but not dead gets back up, since an adventure doesn't have to offer a rest.
          hp: actor.hp <= 0 && !isDead(actor) ? 1 : actor.hp,
          deathSaves: isDead(actor)
            ? actor.deathSaves
            : { successes: 0, failures: 0 },
        },
      ]),
  );
  return { ...state, actors, combat: null };
}

function applyDamage(
  actor: Actor,
  amount: number,
  critical: boolean,
  massive: boolean,
): Actor {
  const absorbed = Math.min(actor.tempHp, amount);
  const remaining = amount - absorbed;
  const wasDown = actor.hp <= 0;
  const hp = Math.max(0, actor.hp - remaining);
  const hitWhileDown =
    wasDown && remaining > 0 && actor.side === "party" ? (critical ? 2 : 1) : 0;
  const unsettled = hitWhileDown > 0 && isStable(actor);
  return {
    ...actor,
    activeEffects:
      amount > 0
        ? actor.activeEffects.filter((effect) => !effect.endsOnDamage)
        : actor.activeEffects,
    tempHp: actor.tempHp - absorbed,
    hp,
    // Becoming Stable reset both counts, so damage that ends it starts death saves from nothing.
    deathSaves: {
      successes: unsettled ? 0 : actor.deathSaves.successes,
      // Massive damage kills outright, which three failures also represent.
      failures: massive
        ? 3
        : (unsettled ? 0 : actor.deathSaves.failures) + hitWhileDown,
    },
  };
}

function applyDeathSave(actor: Actor, natural: number): Actor {
  if (natural === 20) {
    return { ...actor, hp: 1, deathSaves: { successes: 0, failures: 0 } };
  }
  const { successes, failures } = actor.deathSaves;
  return {
    ...actor,
    deathSaves:
      natural >= 10
        ? { successes: successes + 1, failures }
        : { successes, failures: failures + (natural === 1 ? 2 : 1) },
  };
}

function payload<S extends z.ZodType>(
  schema: S,
  event: SystemEvent,
): z.infer<S> {
  return schema.parse("payload" in event ? event.payload : {});
}

export function applyDndEvent(state: DndState, event: SystemEvent): DndState {
  return settleForms(state, applyOne(state, event));
}

function applyOne(state: DndState, event: SystemEvent): DndState {
  switch (event.kind) {
    case `${NS}:characterChosen`: {
      const data = payload(CharacterChosenSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        name: data.name,
        source: { kind: "character", build: data.build },
        inventory: data.inventory,
        hp: data.hp,
      }));
    }
    case `${NS}:characterAdvanced`: {
      const data = payload(CharacterAdvancedSchema, event);
      return updateActor(state, data.actor, (actor) => {
        if (actor.source.kind !== "character" || !actor.source.build) {
          throw new Error(`${actor.id} has no character build`);
        }
        const { build } = actor.source;
        return {
          ...actor,
          source: {
            kind: "character",
            build: { ...build, levels: [...build.levels, data.entry] },
          },
          hp: data.hp,
        };
      });
    }
    case `${NS}:xpAwarded`: {
      const data = payload(XpAwardedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        xp: (actor.xp ?? 0) + data.amount,
      }));
    }
    case `${NS}:rested`: {
      const data = payload(RestedSchema, event);
      return updateActor(state, data.actor, (actor) =>
        data.rest === "short"
          ? { ...actor, resourcesSpent: data.resourcesSpent }
          : {
              ...actor,
              resourcesSpent: data.resourcesSpent,
              hp: data.maxHp,
              tempHp: 0,
              deathSaves: { successes: 0, failures: 0 },
              exhaustion: Math.max(0, actor.exhaustion - 1),
            },
      );
    }
    case `${NS}:restFinished`: {
      const { rest } = payload(RestFinishedSchema, event);
      if (rest === "long") return { ...state, sinceLongRest: REST_HOURS.long };
      return state.sinceLongRest === undefined
        ? state
        : { ...state, sinceLongRest: state.sinceLongRest + REST_HOURS.short };
    }
    case `${NS}:combatStarted`: {
      const data = payload(CombatStartedSchema, event);
      const actors = {
        ...state.actors,
        ...Object.fromEntries(data.monsters.map((item) => [item.id, item])),
      };
      // The surprise was for this fight, so it's spent now.
      const rest = Object.fromEntries(
        Object.entries(state).filter(([key]) => key !== "surprise"),
      ) as Omit<DndState, "surprise">;
      return {
        ...rest,
        actors: Object.fromEntries(
          Object.entries(actors).map(([id, actor]) => [
            id,
            { ...actor, position: data.positions?.[id] ?? null, moved: 0 },
          ]),
        ),
        combat: {
          encounter: data.encounter,
          order: data.order,
          index: 0,
          round: 1,
          ...(data.canFlee ? { canFlee: true } : {}),
          ...(data.defeatContinues ? { defeatContinues: true } : {}),
          ...(data.grid ? { grid: data.grid } : {}),
          ...(data.walls ? { walls: data.walls } : {}),
          ...(data.terrain ? { terrain: data.terrain } : {}),
          ...(data.map ? { map: data.map } : {}),
          ...(data.loot ? { loot: data.loot } : {}),
          ...(data.lair ? { lair: data.lair } : {}),
        },
      };
    }
    case `${NS}:combatEnded`:
      return endCombat(state);
    case `${NS}:turnAdvanced`:
      return advanceTurn(state);
    case `${NS}:moved`: {
      const data = payload(MovedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        position: data.to,
        moved: actor.moved + data.feet,
      }));
    }
    case `${NS}:budgetSpent`: {
      const data = payload(BudgetSpentSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        budget: { ...actor.budget, [data.kind]: false },
      }));
    }
    case `${NS}:actionRegained`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({ ...actor, budget: { ...actor.budget, action: true } }),
      );
    case `${NS}:resourceSpent`: {
      const data = payload(ResourceSpentSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        resourcesSpent: {
          ...actor.resourcesSpent,
          [data.resource]: (actor.resourcesSpent[data.resource] ?? 0) + 1,
        },
      }));
    }
    case `${NS}:resourceRestored`: {
      const data = payload(ResourceRestoredSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        resourcesSpent: Object.fromEntries(
          Object.entries(actor.resourcesSpent).flatMap(([resource, spent]) => {
            if (resource !== data.resource) return [[resource, spent]];
            const left = spent - (data.amount ?? spent);
            return left > 0 ? [[resource, left]] : [];
          }),
        ),
      }));
    }
    case `${NS}:oncePerTurnUsed`: {
      const data = payload(OncePerTurnSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        usedThisTurn: [...actor.usedThisTurn, data.key],
      }));
    }
    case `${NS}:damaged`: {
      const data = payload(DamagedSchema, event);
      return updateActor(state, data.actor, (actor) =>
        applyDamage(actor, data.amount, data.critical, data.massive),
      );
    }
    case `${NS}:damagedFromInside`: {
      const data = payload(DamagedFromInsideSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        insideDamage: (actor.insideDamage ?? 0) + data.amount,
      }));
    }
    case `${NS}:healed`: {
      const data = payload(HealedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        hp: Math.min(data.max, Math.max(actor.hp, 0) + data.amount),
        deathSaves: { successes: 0, failures: 0 },
      }));
    }
    case `${NS}:tempHpGained`: {
      const data = payload(TempHpSchema, event);
      // Temporary Hit Points don't stack: the higher amount is kept.
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        tempHp: Math.max(actor.tempHp, data.amount),
      }));
    }
    case `${NS}:effectAdded`: {
      const data = payload(EffectAddedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        activeEffects: [...actor.activeEffects, data.effect],
      }));
    }
    case `${NS}:effectEnded`: {
      const data = payload(EffectEndedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        activeEffects: actor.activeEffects.filter(
          (effect) =>
            effect.sourceId !== data.sourceId ||
            (data.casterId !== undefined && effect.casterId !== data.casterId),
        ),
      }));
    }
    case `${NS}:conditionRemoved`: {
      const data = payload(ConditionRemovedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        activeEffects: actor.activeEffects.filter(
          ({ modifier }) =>
            modifier.kind !== "condition" ||
            modifier.condition !== data.condition,
        ),
      }));
    }
    case `${NS}:concentrationStarted`: {
      const data = payload(ConcentrationStartedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        concentratingOn: data.spell,
      }));
    }
    case `${NS}:concentrationEnded`:
      return removeConcentration(state, payload(ActorOnlySchema, event).actor);
    case `${NS}:deathSaveRolled`: {
      const data = payload(DeathSaveSchema, event);
      return updateActor(state, data.actor, (actor) =>
        applyDeathSave(actor, data.natural),
      );
    }
    case `${NS}:stabilized`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({ ...actor, deathSaves: { successes: 3, failures: 0 } }),
      );
    case `${NS}:inspirationGranted`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({
          ...actor,
          heroicInspiration: true,
        }),
      );
    case `${NS}:inspirationSpent`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({ ...actor, heroicInspiration: false }),
      );
    case `${NS}:treasureFound`: {
      const data = payload(TreasureFoundSchema, event);
      const found = updateActor(state, data.actor, (actor) => ({
        ...actor,
        inventory: [...actor.inventory, ...data.items],
        stowed: [...(actor.stowed ?? []), ...data.stowed],
      }));
      return {
        ...found,
        gold: Math.round(((state.gold ?? 0) + data.gold) * 100) / 100,
      };
    }
    case `${NS}:gearChanged`: {
      const data = payload(GearChangedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        stowed: data.stowed,
        attuned: data.attuned,
      }));
    }
    case `${NS}:traded`: {
      const data = payload(TradedSchema, event);
      const traded = updateActor(state, data.actor, (actor) => {
        if (data.bought) {
          return {
            ...actor,
            inventory: [...actor.inventory, data.item],
            ...(data.stowed
              ? { stowed: [...(actor.stowed ?? []), data.item] }
              : {}),
          };
        }
        // A copy in the pack goes before one worn, and attunement ends with the last copy.
        const inventory = without(actor.inventory, [data.item]);
        return {
          ...actor,
          inventory,
          ...(actor.stowed
            ? { stowed: without(actor.stowed, [data.item]) }
            : {}),
          ...(actor.attuned && !inventory.includes(data.item)
            ? { attuned: actor.attuned.filter((id) => id !== data.item) }
            : {}),
        };
      });
      const change = (data.bought ? -data.priceCp : data.priceCp) / 100;
      return {
        ...traded,
        gold: Math.round(((state.gold ?? 0) + change) * 100) / 100,
        ...(data.bought
          ? {
              shopBought: {
                ...state.shopBought,
                [data.merchant]: [
                  ...(state.shopBought?.[data.merchant] ?? []),
                  data.item,
                ],
              },
            }
          : {}),
      };
    }
    case `${NS}:itemUsed`: {
      const data = payload(ItemUsedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        inventory: without(actor.inventory, [data.item]),
      }));
    }
    // Uses are marks in usedThisTurn, which clears when the monster's own turn starts, as its uses come back.
    case `${NS}:legendaryActionTaken`: {
      const data = payload(LegendaryActionTakenSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        usedThisTurn: [
          ...actor.usedThisTurn,
          ...Array<string>(data.cost).fill(LEGENDARY_USE),
          ...(data.key ? [data.key] : []),
        ],
      }));
    }
    case `${NS}:legendaryResistanceUsed`: {
      const { actor: id } = payload(ActorOnlySchema, event);
      return updateActor(state, id, (actor) => ({
        ...actor,
        resourcesSpent: {
          ...actor.resourcesSpent,
          [LEGENDARY_RESISTANCE]:
            (actor.resourcesSpent[LEGENDARY_RESISTANCE] ?? 0) + 1,
        },
      }));
    }
    case `${NS}:surpriseSet`:
      return {
        ...state,
        surprise: payload(z.strictObject({ side: SurpriseSchema }), event).side,
      };
    default:
      return state;
  }
}
