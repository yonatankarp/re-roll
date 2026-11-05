import { ContentIdSchema, type SystemEvent } from "#sdk";
import { z } from "zod";
import {
  AbilitySchema,
  CharacterBuildSchema,
  ConditionSchema,
  DamageTypeSchema,
  ModifierSchema,
} from "./schemas.ts";

export const NS = "dnd5.5e";

const ActiveEffectSchema = z.strictObject({
  sourceId: z.string(),
  casterId: z.string(),
  modifier: z.union([
    ModifierSchema,
    z.strictObject({
      kind: z.literal("condition"),
      condition: ConditionSchema,
    }),
  ]),
  // "casterNextTurnEnd" becomes "casterTurnEnd" when the caster's next turn starts, and ends with that turn.
  ends: z.enum([
    "concentration",
    "casterNextTurn",
    "casterNextTurnEnd",
    "casterTurnEnd",
    "spellDuration",
  ]),
  repeatSave: z
    .strictObject({ ability: AbilitySchema, dc: z.number().int() })
    .optional(),
  endsOnDamage: z.boolean().optional(),
});
export type ActiveEffect = z.infer<typeof ActiveEffectSchema>;

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
  xp: z.number().int().optional(), // only the player's is tracked, and the party levels together
});
export type Actor = z.infer<typeof ActorSchema>;

export const StateSchema = z.strictObject({
  actors: z.record(z.string(), ActorSchema),
  combat: z
    .strictObject({
      encounter: z.string(),
      order: z.array(z.string()),
      index: z.number().int(),
      round: z.number().int(),
      canFlee: z.boolean().optional(),
      defeatContinues: z.boolean().optional(),
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
const CombatStartedSchema = z.strictObject({
  encounter: z.string(),
  monsters: z.array(ActorSchema),
  order: z.array(z.string()),
  canFlee: z.boolean().optional(),
  defeatContinues: z.boolean().optional(),
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
const EffectEndedSchema = z.strictObject({
  actor: z.string(),
  sourceId: z.string(),
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

export const EVENT_SCHEMAS = {
  [`${NS}:characterChosen`]: CharacterChosenSchema,
  [`${NS}:characterAdvanced`]: CharacterAdvancedSchema,
  [`${NS}:xpAwarded`]: XpAwardedSchema,
  [`${NS}:rested`]: RestedSchema,
  [`${NS}:combatStarted`]: CombatStartedSchema,
  [`${NS}:combatEnded`]: z.strictObject({}),
  [`${NS}:turnAdvanced`]: z.strictObject({}),
  [`${NS}:budgetSpent`]: BudgetSpentSchema,
  [`${NS}:actionRegained`]: ActorOnlySchema,
  [`${NS}:resourceSpent`]: ResourceSpentSchema,
  [`${NS}:resourceRestored`]: ResourceRestoredSchema,
  [`${NS}:oncePerTurnUsed`]: OncePerTurnSchema,
  [`${NS}:damaged`]: DamagedSchema,
  [`${NS}:healed`]: HealedSchema,
  [`${NS}:tempHpGained`]: TempHpSchema,
  [`${NS}:effectAdded`]: EffectAddedSchema,
  [`${NS}:effectEnded`]: EffectEndedSchema,
  [`${NS}:conditionRemoved`]: ConditionRemovedSchema,
  [`${NS}:concentrationStarted`]: ConcentrationStartedSchema,
  [`${NS}:concentrationEnded`]: ActorOnlySchema,
  [`${NS}:deathSaveRolled`]: DeathSaveSchema,
  [`${NS}:rollReported`]: RollReportSchema,
  [`${NS}:inspirationGranted`]: ActorOnlySchema,
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
  };
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
          // shortcut: everyone downed but not dead gets back up, since an adventure doesn't have to offer a rest.
          hp: actor.hp <= 0 && !isDead(actor) ? 1 : actor.hp,
          deathSaves: isDead(actor)
            ? actor.deathSaves
            : { successes: 0, failures: 0 },
        },
      ]),
  );
  return { actors, combat: null };
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
  return {
    ...actor,
    activeEffects:
      amount > 0
        ? actor.activeEffects.filter((effect) => !effect.endsOnDamage)
        : actor.activeEffects,
    tempHp: actor.tempHp - absorbed,
    hp,
    deathSaves: {
      ...actor.deathSaves,
      // Massive damage kills outright, which three failures also represent.
      failures: massive ? 3 : actor.deathSaves.failures + hitWhileDown,
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
    case `${NS}:combatStarted`: {
      const data = payload(CombatStartedSchema, event);
      return {
        actors: {
          ...state.actors,
          ...Object.fromEntries(data.monsters.map((item) => [item.id, item])),
        },
        combat: {
          encounter: data.encounter,
          order: data.order,
          index: 0,
          round: 1,
          ...(data.canFlee ? { canFlee: true } : {}),
          ...(data.defeatContinues ? { defeatContinues: true } : {}),
        },
      };
    }
    case `${NS}:combatEnded`:
      return endCombat(state);
    case `${NS}:turnAdvanced`:
      return advanceTurn(state);
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
          Object.entries(actor.resourcesSpent).filter(
            ([resource]) => resource !== data.resource,
          ),
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
          (effect) => effect.sourceId !== data.sourceId,
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
    case `${NS}:inspirationGranted`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({
          ...actor,
          heroicInspiration: true,
        }),
      );
    default:
      return state;
  }
}
