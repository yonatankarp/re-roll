import {
  type ContentAccess,
  PLAYER_ACTOR,
  type SceneAction,
  type SceneHere,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import {
  type Check,
  CheckSchema,
  EnvironmentalEffectSchema,
  ClassSchema,
  ItemSchema,
  type LeafEffect,
  type Modifier,
  SKILL_ABILITIES,
  SpeciesSchema,
  type Spell,
  SpellSchema,
} from "./schemas.ts";
import { carriedWeight, carryingCapacity } from "./carry.ts";
import { focusFrame } from "./combat/check-choice.ts";
import { featureCheck, hasWater } from "./environment.ts";
import { aidsAny } from "./explore.ts";
import {
  type Actor,
  type DndState,
  NS,
  dndEvent,
  frame,
  isDead,
} from "./state.ts";
import {
  type KnownAction,
  type Stats,
  chargesOf,
  deriveStats,
  itemHealing,
  lookup,
  scaleActivation,
  maybeLookup,
} from "./stats.ts";
import {
  canAfford,
  deadWithin,
  fitsType,
  goldFor,
  spellSource,
  upcastSlots,
} from "./combat/queries.ts";
import { leafEvents, payCosts, sharedHealing } from "./combat/effects.ts";
import { ITEM_PREFIX, spellOfSource } from "./combat/ids.ts";
import { SHORT_REST_GIVEN, canRegain, regainCap } from "./rest.ts";

// Healing between fights: a party member's spell or feature that heals or raises the dead, used on the party from
// the character sheet, as Cure Wounds after a fight or Raise Dead, which takes an hour. It costs what it costs in a
// fight, less the action, and reaches anyone in the party, who can walk over to be touched. A spell may be cast with
// a higher slot, and a ritual is cast as one, with no slot.
// Exploring (#153): a spell or feature that helps the player's scene checks, as Guidance, or deals with what a check
// here is about, as Knock with a lock (explore.ts), offered only where the scene has such a check; drinkable water
// where the party is exposed without it; and a load carried for one who is over capacity, as Floating Disk.

type Context = SystemContext<DndState>;

const CAST = "cast:";
const NEVER_MIND = "never-mind";

// Only effects that mean something outside a fight. Conditions all end with the fight, so curing them has
// nothing to do yet, and other effects would linger into the next fight.
const BETWEEN: ReadonlySet<LeafEffect["kind"]> = new Set([
  "heal",
  "hitDieHeal",
  "cure",
  "removeCondition",
  "ordeal",
  "repose",
  "shortRest",
  "regain",
  "transference",
  "reincarnate",
  "clone",
  "modifier", // only those modifierHelps allows
  "exhaustion",
  "untilLongRest",
  "rechargeItem",
]);

// What the scene here offers, and the state, for what a modifier would do between fights. `here` is unknown while
// the cast resolves, which trusts the offer.
interface Between {
  readonly state: DndState;
  readonly here: readonly Check[] | undefined;
  readonly fights?: boolean | undefined; // a fight can start here (SceneHere)
}

// The skill and ability a check rolls, for the modifiers that apply to it.
function focusOf(
  check: Check,
  access: ContentAccess,
): { skill: string | undefined; ability: string | undefined } {
  const parsed = featureCheck(check, access);
  const skill = "skill" in parsed ? parsed.skill : undefined;
  return {
    skill,
    ability:
      ("ability" in parsed ? parsed.ability : undefined) ??
      (skill ? SKILL_ABILITIES[skill] : undefined),
  };
}

function appliesTo(
  modifier: Modifier,
  pick: readonly string[] | undefined,
  { skill, ability }: ReturnType<typeof focusOf>,
): boolean {
  if (pick) return pick.some((focus) => focus === skill || focus === ability);
  const skills =
    "skills" in modifier
      ? modifier.skills
      : "skill" in modifier && modifier.skill
        ? [modifier.skill]
        : undefined;
  return (
    (!skills || (skill !== undefined && skills.includes(skill as never))) &&
    (!("ability" in modifier) ||
      !modifier.ability ||
      modifier.ability === ability)
  );
}

// Whether a modifier would mean something to the target between fights: on the player's checks (only the player
// makes a scene's), dealing with what one here is about, water where the party is exposed without it, or a load
// for one carrying more than it can.
function modifierHelps(
  modifier: Modifier,
  pick: readonly string[] | undefined,
  target: Actor,
  access: ContentAccess,
  { state, here, fights }: Between,
): boolean {
  const player = target.id === PLAYER_ACTOR;
  switch (modifier.kind) {
    case "sceneAid":
      return player && (!here || aidsAny(modifier.about, here, access));
    case "water":
      return (
        player &&
        !hasWater(state, access) &&
        (state.ambient ?? []).some(
          (id) =>
            EnvironmentalEffectSchema.safeParse(access.content(id)).data
              ?.exposure?.water === true,
        )
      );
    case "holds": {
      const build =
        target.source.kind === "character" ? target.source.build : null;
      if (!build) return false;
      const { size } = lookup(access, SpeciesSchema, build.speciesId);
      return (
        carriedWeight(target, access) >
        carryingCapacity(deriveStats(target, access).abilities.str, size)
      );
    }
    case "bonus":
    case "advantage":
      if (("to" in modifier ? modifier.to : modifier.on) !== "checks")
        return false;
      break;
    case "checkFloor":
    case "expertise":
      break;
    // A ward helps where a fight can start here, once; a shelter where the place harms a rest.
    case "prepared":
      return (
        (here === undefined || fights === true) &&
        !target.activeEffects.some(
          (effect) => effect.modifier.kind === "prepared",
        )
      );
    case "sheltered":
      return (state.ambient ?? []).some((id) => {
        const rest = EnvironmentalEffectSchema.safeParse(access.content(id))
          .data?.rest;
        return rest?.condition !== undefined || rest?.keepExhaustion === true;
      });
    default:
      return false;
  }
  return (
    player &&
    (!here ||
      here.some((check) => appliesTo(modifier, pick, focusOf(check, access))))
  );
}

// Whether the effect would do something for this creature between fights.
function helps(
  effect: LeafEffect,
  target: Actor,
  access: ContentAccess,
  slotLevel: number | null,
  between: Between,
): boolean {
  switch (effect.kind) {
    case "modifier":
      return modifierHelps(
        effect.modifier,
        effect.pick,
        target,
        access,
        between,
      );
    case "heal":
    case "hitDieHeal":
    case "shortRest":
    case "transference":
      return target.hp < deriveStats(target, access).maxHp;
    case "repose":
      return !target.reposed;
    case "reincarnate":
      return true; // its targeting already asks for the dead
    case "clone":
      return target.clone === undefined;
    case "exhaustion":
      return effect.clear === true && target.exhaustion > 0;
    case "untilLongRest":
      return true;
    // An Arcane Battery, for an item with charges spent that come back at dawn.
    case "rechargeItem":
      return [...new Set(target.inventory)].some((id) => {
        const item = ItemSchema.safeParse(access.content(id)).data;
        return (
          item !== undefined &&
          chargesOf(item).resources.some(
            (pool) =>
              pool.recharge.some((entry) => entry.on === "dawn") &&
              (target.resourcesSpent[pool.id] ?? 0) > 0,
          )
        );
      });
    case "cure":
      return (
        (effect.exhaustion === true && target.exhaustion > 0) ||
        (effect.maxHp === true && (target.maxHpLoss ?? 0) > 0)
      );
    case "regain":
      return canRegain(
        target,
        effect.resource,
        deriveStats(target, access),
        regainCap(effect, slotLevel),
      );
    default:
      return false;
  }
}

// Whether the action is a spell that can be cast as a Ritual, with time to spare between fights.
function ritual(action: KnownAction, access: ContentAccess): boolean {
  const id = spellOfSource(action.id);
  return id !== null && maybeLookup(access, SpellSchema, id)?.ritual === true;
}

// The action with only what it costs between fights: its slot, uses and gold, not an action of a turn. A ritual
// needs no slot.
function between(action: KnownAction, access: ContentAccess): KnownAction {
  const free = ritual(action, access);
  return {
    ...action,
    activation: {
      ...action.activation,
      cost: action.activation.cost.filter(
        (cost) => typeof cost === "object" || (cost === "slot" && !free),
      ),
    },
  };
}

// The action as cast with this slot, its upcast applied.
function atSlot(action: KnownAction, slot: number | undefined): KnownAction {
  return slot !== undefined && action.upcast && action.spellLevel !== null
    ? {
        ...action,
        activation: scaleActivation(
          action.activation,
          action.upcast.perSlotLevel,
          slot - action.spellLevel,
        ),
      }
    : action;
}

function effectsOf(action: KnownAction): readonly LeafEffect[] {
  const { resolution } = action.activation;
  return resolution.kind === "automatic" ? resolution.effects : [];
}

// A healing potion is drunk from its own row (gear.ts), so only spells, features and other items are used here,
// as a Potion of Vitality's end to Exhaustion.
function usable(action: KnownAction, access: ContentAccess): boolean {
  const effects = effectsOf(action);
  return (
    !(
      action.id.startsWith(ITEM_PREFIX) &&
      itemHealing(
        lookup(access, ItemSchema, action.id.slice(ITEM_PREFIX.length)),
      )
    ) &&
    !action.activation.trigger &&
    !(
      "side" in action.activation.targeting &&
      action.activation.targeting.side === "enemy"
    ) &&
    effects.length > 0 &&
    effects.every((effect) => BETWEEN.has(effect.kind))
  );
}

function members(state: DndState): readonly Actor[] {
  return Object.values(state.actors).filter(
    (actor) => actor.side === "party" && actor.source.kind === "character",
  );
}

// Those it would do something for, such as the dead it's in time for, or the living missing Hit Points.
function targetsOf(
  action: KnownAction,
  caster: Actor,
  state: DndState,
  access: ContentAccess,
  here?: readonly Check[],
  fights?: boolean,
): readonly Actor[] {
  const { targeting } = action.activation;
  const dead = "dead" in targeting && targeting.dead === true;
  // What deals with a scene's obstacle, or waters the party, is the player's to use, whoever casts it.
  const party = effectsOf(action).every(
    (effect) =>
      effect.kind === "modifier" &&
      (effect.modifier.kind === "sceneAid" || effect.modifier.kind === "water"),
  );
  const player = state.actors[PLAYER_ACTOR];
  const pool =
    party && player
      ? [player]
      : "self" in targeting
        ? [caster]
        : members(state);
  return pool.filter(
    (item) =>
      // Not again on one it already lasts on.
      !item.activeEffects.some(({ sourceId }) => sourceId === action.id) &&
      isDead(item) === dead &&
      deadWithin(item, targeting) &&
      fitsType(item, targeting, access, caster) &&
      // Prayer of Healing reaches no one it already gave a Short Rest's benefits since a Long Rest.
      !(
        item.resourcesSpent[SHORT_REST_GIVEN] &&
        effectsOf(action).some((effect) => effect.kind === "shortRest")
      ) &&
      effectsOf(action).some((effect) =>
        helps(effect, item, access, action.spellLevel, { state, here, fights }),
      ),
  );
}

// Each class list's level 1+ ritual spells, found once for the content.
const ritualsByList = new WeakMap<
  ContentAccess["content"],
  Map<string, readonly Spell[]>
>();
function listRituals(list: string, access: ContentAccess): readonly Spell[] {
  let byList = ritualsByList.get(access.content);
  if (!byList) {
    byList = new Map();
    ritualsByList.set(access.content, byList);
  }
  const known = byList.get(list);
  if (known) return known;
  const named = new Set(
    maybeLookup(access, ClassSchema, list)?.spellList ?? [],
  );
  const found = access.contentIds().flatMap((id) => {
    if (!id.includes(":spell/")) return [];
    const spell = maybeLookup(access, SpellSchema, id);
    return spell?.ritual &&
      spell.activation &&
      spell.level >= 1 &&
      (named.has(id) || spell.classes.includes(list))
      ? [spell]
      : [];
  });
  byList.set(list, found);
  return found;
}

// Ritual spells a Ritual Adept casts from its list without having them prepared, of levels it has slots for.
// shortcut: the spellbook is the Wizard list, as it isn't kept apart from it (swap.ts says the same).
function ritualsOnHand(
  stats: Stats,
  access: ContentAccess,
): readonly KnownAction[] {
  const lists = stats.passives.flatMap((passive) =>
    passive.kind === "ritualAdept" ? [passive.list] : [],
  );
  if (lists.length === 0) return [];
  const highest = stats.slots.findLastIndex((count) => count > 0) + 1;
  const known = new Set(stats.actions.map((action) => action.id));
  return lists.flatMap((list) =>
    listRituals(list, access).flatMap((spell): KnownAction[] =>
      spell.activation &&
      spell.level <= highest &&
      !known.has(`spell:${spell.id}`)
        ? [
            {
              id: `spell:${spell.id}`,
              name: spell.name,
              activation: spell.activation,
              spellLevel: spell.level,
              upcast: spell.upcast,
            },
          ]
        : [],
    ),
  );
}

function castable(
  caster: Actor,
  state: DndState,
  access: ContentAccess,
  here?: readonly Check[],
  fights?: boolean,
): readonly KnownAction[] {
  if (isDead(caster) || caster.hp <= 0) return [];
  const stats = deriveStats(caster, access);
  return [...stats.actions, ...ritualsOnHand(stats, access)].filter(
    (action) =>
      usable(action, access) &&
      goldFor(action) <= (state.gold ?? 0) &&
      canAfford(between(action, access), caster, stats) &&
      targetsOf(action, caster, state, access, here, fights).length > 0,
  );
}

export function castId(caster: string, action: string, slot?: number): string {
  return `${CAST}${caster}:${action}${slot === undefined ? "" : `@${String(slot)}`}`;
}

export function sceneCastActions(
  state: DndState,
  access: ContentAccess,
  scene: SceneHere = { checks: [] },
): SceneAction[] {
  const here = scene.checks.flatMap((check) => {
    const parsed = CheckSchema.safeParse(check);
    return parsed.success ? [parsed.data] : [];
  });
  const player = state.actors[PLAYER_ACTOR];
  if (
    state.combat ||
    player?.source.kind !== "character" ||
    !player.source.build
  ) {
    return [];
  }
  // Most scenes find the party whole and fresh, and then nothing here is worth working out.
  const needy = members(state).some(
    (item) =>
      item.hp < deriveStats(item, access).maxHp ||
      item.exhaustion > 0 ||
      Object.keys(item.resourcesSpent).some((key) => key.startsWith("slot:")),
  );
  // A spell that keeps creatures between fights, as Animate Dead, is worth casting in any scene.
  const keeps = (action: KnownAction): boolean =>
    action.activation.resolution.kind === "automatic" &&
    action.activation.resolution.effects.some(
      (effect) => effect.kind === "retain",
    );
  if (
    !needy &&
    here.length === 0 &&
    !state.ambient &&
    !members(state).some((item) =>
      deriveStats(item, access).actions.some(keeps),
    )
  ) {
    return [];
  }
  return members(state).flatMap((caster) => {
    const stats = deriveStats(caster, access);
    return castable(caster, state, access, here, scene.fights).flatMap(
      (action): SceneAction[] => {
        const name =
          caster.id === PLAYER_ACTOR
            ? action.name
            : `${caster.name}: ${action.name}`;
        // A ritual costs no slot, so a higher one is never worth it.
        const slots = ritual(action, access)
          ? []
          : upcastSlots(action, caster, stats);
        // A spell of several shapes, as Ceremony's rites, is one choice for each, at its own level.
        const { shapes } = action.activation;
        if (shapes) {
          return shapes.map((shape, index) => ({
            id: `${castId(caster.id, action.id, undefined)}:shape${String(index)}`,
            label: `${name}: ${shape.name}${ritual(action, access) ? " (ritual)" : ""}`,
            effect: `${NS}:castBetween`,
            args: { caster: caster.id, action: action.id, shape: index },
            ...(action.activation.outOfCombat === true ? { rest: true } : {}),
          }));
        }
        return [undefined, ...slots].map((slot) => ({
          id: castId(caster.id, action.id, slot),
          label:
            slot === undefined
              ? `${name}${ritual(action, access) ? " (ritual)" : ""}`
              : `${name} (level ${String(slot)} slot)`,
          effect: `${NS}:castBetween`,
          args: {
            caster: caster.id,
            action: action.id,
            ...(slot === undefined ? {} : { slot }),
          },
          // An hour's casting only where the scene leaves time to rest.
          ...(action.activation.outOfCombat === true ? { rest: true } : {}),
        }));
      },
    );
  });
}

function found(
  casterId: string,
  actionId: string,
  context: Context,
): { caster: Actor; action: KnownAction } {
  const caster = context.state.actors[casterId];
  const action = caster
    ? castable(caster, context.state, context).find(
        (item) => item.id === actionId,
      )
    : undefined;
  if (!caster || !action) {
    throw new Error(`${casterId} can't use ${actionId} now`);
  }
  return { caster, action };
}

function resolve(
  caster: Actor,
  action: KnownAction, // as cast with `slot`
  targets: readonly Actor[],
  context: Context,
  slot?: number,
): SystemResult {
  const shared = sharedHealing(effectsOf(action), targets, caster, context);
  const events: SystemEvent[] = [
    ...payCosts(between(action, context), caster, context, slot),
    // An item used up, as a potion drunk.
    ...(action.id.startsWith(ITEM_PREFIX)
      ? [
          dndEvent(`${NS}:itemUsed`, {
            actor: caster.id,
            item: action.id.slice(ITEM_PREFIX.length),
          }),
        ]
      : []),
  ];
  // A spell held with Concentration ends the one held before, as in a fight.
  const held = effectsOf(action).some(
    (effect) =>
      effect.kind === "modifier" &&
      typeof effect.duration === "object" &&
      "concentration" in effect.duration,
  );
  // The slot it's cast with, its own level's unless a higher one was picked, so Disciple of Life sees it.
  const spent =
    slot ??
    (between(action, context).activation.cost.includes("slot")
      ? (action.spellLevel ?? undefined)
      : undefined);
  if (held) {
    if (caster.concentratingOn !== null)
      events.push(dndEvent(`${NS}:concentrationEnded`, { actor: caster.id }));
    events.push(
      dndEvent(`${NS}:concentrationStarted`, {
        actor: caster.id,
        spell: spellSource(action),
      }),
    );
  }
  for (const target of targets) {
    events.push(
      ...leafEvents(
        shared(target),
        action.id,
        caster,
        target,
        context,
        undefined,
        spent,
      ),
    );
  }
  // The player spends the Hit Dice a Short Rest it gave them, as they would in one (rest.ts), and picks what a
  // reincarnated body's species asks for (reincarnate.ts).
  const player = targets.some((target) => target.id === PLAYER_ACTOR);
  const given = (kind: LeafEffect["kind"]) =>
    player && effectsOf(action).some((effect) => effect.kind === kind);
  // The player picks a skill or ability the spell asks for, as Guidance's, for whoever casts it.
  const focus = targets.flatMap((target) => {
    const asked = focusFrame(
      effectsOf(action),
      action.id,
      caster,
      target,
      slot,
      PLAYER_ACTOR,
    );
    return asked ? [asked] : [];
  });
  const frames = [
    ...(given("shortRest") ? [frame("givenDice")] : []),
    ...(given("reincarnate") ? [frame("reincarnate", { picks: {} })] : []),
    ...focus,
  ];
  return { events, ...(frames.length > 0 ? { frames } : {}) };
}

const CastSchema = z.strictObject({
  caster: z.string(),
  action: z.string(),
  slot: z.number().int().min(1).max(9).optional(), // a higher slot it's cast with
  shape: z.number().int().min(0).optional(), // which of its shapes, as Ceremony's rite
});

// The action as cast in one of its shapes: the shape's effects or resolution in place of its own.
function inShape(action: KnownAction, index: number | undefined): KnownAction {
  const shape =
    index === undefined ? undefined : action.activation.shapes?.[index];
  if (!shape) return action;
  const { resolution } = action.activation;
  return {
    ...action,
    activation: {
      ...action.activation,
      resolution:
        shape.resolution ??
        (shape.effects && resolution.kind === "automatic"
          ? { ...resolution, effects: shape.effects }
          : resolution),
    },
  };
}

function runCast(
  {
    caster: casterId,
    action: actionId,
    slot,
    shape,
  }: z.infer<typeof CastSchema>,
  context: Context,
): SystemResult {
  const { caster, action: unscaled } = found(casterId, actionId, context);
  const action = inShape(atSlot(unscaled, slot), shape);
  const targets = targetsOf(action, caster, context.state, context);
  const { targeting } = action.activation;
  // Several at once go to the most hurt first, as in a fight.
  if (
    "area" in targeting ||
    ("creatures" in targeting && targeting.creatures > 1)
  ) {
    const most =
      "creatures" in targeting ? targeting.creatures : targets.length;
    const order = [...targets].sort((a, b) => a.hp - b.hp).slice(0, most);
    return resolve(caster, action, order, context, slot);
  }
  const [only] = targets;
  if (only && targets.length === 1)
    return resolve(caster, action, [only], context, slot);
  return {
    frames: [
      awaitDecision({
        id: `${NS}:castOn:${caster.id}:${action.id}`,
        actor: PLAYER_ACTOR,
        prompt: `${action.name}: on whom?`,
        options: [
          ...targets.map((item) => ({ id: item.id, label: item.name })),
          { id: NEVER_MIND, label: "Never mind" },
        ],
        resume: frame("castOn", {
          caster: caster.id,
          action: action.id,
          ...(slot === undefined ? {} : { slot }),
          ...(shape === undefined ? {} : { shape }),
        }),
      }),
    ],
  };
}

const CastOnSchema = CastSchema.extend({ answer: z.string() });

function runCastOn(
  {
    caster: casterId,
    action: actionId,
    answer,
    slot,
    shape,
  }: z.infer<typeof CastOnSchema>,
  context: Context,
): SystemResult {
  if (answer === NEVER_MIND) return {};
  const { caster, action: unscaled } = found(casterId, actionId, context);
  const action = inShape(atSlot(unscaled, slot), shape);
  const target = targetsOf(action, caster, context.state, context).find(
    (item) => item.id === answer,
  );
  if (!target) throw new Error(`${action.name} can't reach ${answer}`);
  return resolve(caster, action, [target], context, slot);
}

export const campEffects = {
  [`${NS}:castBetween`]: storyEffect({
    schema: CastSchema,
    apply: runCast,
  }),
};

export const campFrames = {
  [`${NS}:castOn`]: frameHandler({ schema: CastOnSchema, run: runCastOn }),
};
