import {
  type ContentAccess,
  type Frame,
  PLAYER_ACTOR,
  type SceneAction,
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
  ABILITY_NAMES,
  type Ability,
  AbilitySchema,
  ClassSchema,
  type Item,
  ItemSchema,
  type Loot,
  LootSchema,
  RollTableSchema,
} from "./schemas.ts";
import {
  type Actor,
  type DndState,
  MAX_ATTUNED,
  NS,
  dndEvent,
  effectiveBuild,
  equipped,
  without,
  frame,
  isDead,
} from "./state.ts";
import { castFrom, spellOfSource } from "./combat/ids.ts";
import {
  type Stats,
  chargesOf,
  imbuedRange,
  deriveStats,
  rollDiceNotation,
  evaluateFormula,
  itemHealing,
  spellAttackBonus,
  spellSaveDc,
  lookup,
  ownAbilities,
  rollAmount,
  weaponProficient,
} from "./stats.ts";

type Context = SystemContext<DndState>;

const DONE = "done";
const WORN_TYPES = new Set(["weapon", "armor", "shield"]);

function player(state: DndState): Actor {
  const actor = state.actors[PLAYER_ACTOR];
  if (!actor) throw new Error("The player has no character");
  return actor;
}

function itemOf(access: ContentAccess, id: string) {
  return lookup(access, ItemSchema, id);
}

// The party's living members, its summons and familiars left out.
function partySize(state: DndState): number {
  return Object.values(state.actors).filter(
    (actor) =>
      actor.side === "party" &&
      actor.source.kind === "character" &&
      !isDead(actor),
  ).length;
}

// The coins and items go to the player's character, and found gear goes in the pack until put on.
// shortcut: companions never carry loot, so only the player's character can equip it.
export function treasure(loot: Loot, context: Context): SystemResult {
  const { gold, items } = loot;
  return {
    events: [
      dndEvent(`${NS}:treasureFound`, {
        actor: PLAYER_ACTOR,
        gold,
        items: [...items],
        stowed: items.filter((id) => WORN_TYPES.has(itemOf(context, id).type)),
      }),
      ...(context.state.actors[PLAYER_ACTOR]
        ? gainRolls(context.state.actors[PLAYER_ACTOR], items, context)
        : []),
    ],
    frames: [frame("gearStep", { step: 0, found: { gold, items } })],
  };
}

// What an item found rolls for as it's found: its pools' `rolled` dice, as a Helm of Brilliance's 1d10 diamonds,
// and its `split` pieces' types, as a Necklace of Prayer Beads' beads. A pool already rolled stays as it is.
export function gainRolls(
  actor: Actor,
  items: readonly string[],
  context: Context,
): SystemEvent[] {
  const rolled = new Set(Object.keys(actor.rolledPools ?? {}));
  const events: SystemEvent[] = [];
  const set = (resource: string, amount: number) => {
    rolled.add(resource);
    events.push(
      dndEvent(`${NS}:poolRolled`, { actor: actor.id, resource, amount }),
    );
  };
  for (const id of items) {
    const item = itemOf(context, id);
    for (const pool of chargesOf(item).resources) {
      if (pool.rolled && !rolled.has(pool.id)) {
        set(pool.id, rollDiceNotation(pool.rolled, context.dice));
      }
      // A Rod of Absorption holds only some of its energy as it's found.
      if (pool.startsWith && !(actor.resourcesSpent[pool.id] ?? 0)) {
        const empty =
          pool.max.base - rollDiceNotation(pool.startsWith, context.dice);
        if (empty > 0) {
          events.push(
            dndEvent(`${NS}:resourceSpent`, {
              actor: actor.id,
              resource: pool.id,
              amount: empty,
            }),
          );
        }
      }
    }
    // An artifact's random properties, its rows' passives carried by the event.
    if (
      item.type === "magicItem" &&
      item.properties &&
      actor.itemProperties?.[id] === undefined
    ) {
      const passives = item.properties.flatMap(({ table: tableId, count }) => {
        const table = RollTableSchema.safeParse(context.content(tableId)).data;
        if (!table) return [];
        const times =
          count.base +
          (count.dice ? rollDiceNotation(count.dice, context.dice) : 0);
        return Array.from({ length: times }).flatMap(() => {
          const face = rollDiceNotation(
            table.die.startsWith("d") ? `1${table.die}` : table.die,
            context.dice,
          );
          return (
            table.rows.find((row) => face >= row.min && face <= row.max)
              ?.passives ?? []
          );
        });
      });
      events.push(
        dndEvent(`${NS}:propertiesRolled`, {
          actor: actor.id,
          item: id,
          passives,
        }),
      );
    }
    const split = "split" in item ? item.split : undefined;
    if (!split || split.rows.every((row) => rolled.has(row.resource))) continue;
    const counts = new Map(split.rows.map((row) => [row.resource, 0]));
    const pieces =
      split.count.base + rollDiceNotation(split.count.dice, context.dice);
    for (let piece = 0; piece < pieces; piece += 1) {
      const face = context.dice.roll(split.die);
      const row = split.rows.find(
        (entry) => face >= entry.min && face <= entry.max,
      );
      if (row) counts.set(row.resource, (counts.get(row.resource) ?? 0) + 1);
    }
    for (const [resource, amount] of counts) set(resource, amount);
  }
  return events;
}

// Whether any of the character's classes trains them with it, or for a scroll, whether they cast spells.
// shortcut: a multiclass character counts every class's training, not the narrower multiclass list.
export function canUse(
  item: z.infer<typeof ItemSchema>,
  stats: Stats,
  access: ContentAccess,
): boolean {
  const classes = Object.keys(stats.classLevels).flatMap((id) => {
    const parsed = ClassSchema.safeParse(access.content(id));
    return parsed.success ? [parsed.data] : [];
  });
  switch (item.type) {
    case "weapon":
      return classes.some((def) => weaponProficient(def, item));
    case "armor":
      return (
        item.anyTraining === true ||
        classes.some((def) => def.armor.includes(item.armorType))
      );
    case "shield":
      return classes.some((def) => def.armor.includes("shield"));
    case "magicItem":
      return !item.spell || stats.spellAbility !== null;
    default:
      return true;
  }
}

// How many magic items a character can be attuned to at once: three, or more by a feature, as Magic Item Adept's four.
export function attunementLimit(stats: Stats): number {
  return Math.max(
    MAX_ATTUNED,
    ...stats.passives.map((passive) =>
      passive.kind === "attunementSlots" ? passive.count : 0,
    ),
  );
}

// Whether a curse holds the actor to an item it's attuned to: no ending that Attunement, nor stowing or selling it.
export function boundTo(
  actor: Actor,
  itemId: string,
  access: ContentAccess,
): boolean {
  if (!(actor.attuned ?? []).includes(itemId)) return false;
  const item = itemOf(access, itemId);
  return "curse" in item && item.curse?.bound === true;
}

// Whether the actor is one an item lets attune to it, as a Talisman of Pure Good only a Cleric or Paladin.
export function canAttune(actor: Actor, item: Item, stats: Stats): boolean {
  const by = "attuneBy" in item ? item.attuneBy : undefined;
  if (!by) return true;
  const named = (id: string, names: readonly string[] | undefined) =>
    names?.some((name) => id.endsWith(`/${name}`)) === true;
  const build = effectiveBuild(actor);
  return (
    Object.keys(stats.classLevels).some((id) => named(id, by.classes)) ||
    (build !== null && named(build.speciesId, by.species)) ||
    (stats.creatureType !== undefined &&
      by.creatureTypes?.includes(stats.creatureType) === true) ||
    (actor.attuned ?? []).some(
      (id) =>
        by.attunedTo?.some((to) => id === to || id.startsWith(`${to}--`)) ===
        true,
    )
  );
}

// What can be put on, taken off, attuned or let go, as during a Short Rest, which attuning takes.
// With `found`, only putting on what was just found, so the moment stays short. Armor and shields the
// character isn't trained with aren't offered, as they'd only hinder; any weapon can be swung.
export function gearOptions(
  actor: Actor,
  access: ContentAccess,
  found?: readonly string[],
): { id: string; label: string }[] {
  const worn = equipped(actor);
  const attuned = actor.attuned ?? [];
  const stats = deriveStats(actor, access);
  return [...new Set(actor.inventory)]
    .filter((id) => !found || found.includes(id))
    .flatMap((id) => {
      const item = itemOf(access, id);
      const attunement =
        !found && "attunement" in item && item.attunement
          ? attuned.includes(id)
            ? boundTo(actor, id, access)
              ? []
              : [
                  {
                    id: `unattune:${id}`,
                    label: `End attunement to ${item.name}`,
                  },
                ]
            : attuned.length < attunementLimit(stats) &&
                canAttune(actor, item, stats)
              ? [{ id: `attune:${id}`, label: `Attune to ${item.name}` }]
              : []
          : [];
      if (WORN_TYPES.has(item.type)) {
        const wearable = item.type === "weapon" || canUse(item, stats, access);
        // A second suit of the armor worn, or of the Shield held, would only change places with it.
        const same = item.type !== "weapon" && worn.includes(id);
        return [
          ...((actor.stowed ?? []).includes(id) && wearable && !same
            ? [{ id: `equip:${id}`, label: `Equip ${item.name}` }]
            : []),
          ...(worn.includes(id) && !found && !boundTo(actor, id, access)
            ? [{ id: `stow:${id}`, label: `Stow ${item.name}` }]
            : []),
          ...attunement,
        ];
      }
      return attunement;
    });
}

// The pack after a change: putting on armor or a shield stows the one worn before.
export function changed(
  actor: Actor,
  answer: string,
  access: ContentAccess,
): { stowed: string[]; attuned: string[] } {
  const split = answer.indexOf(":");
  const verb = answer.slice(0, split);
  const id = answer.slice(split + 1);
  const stowed = actor.stowed ?? [];
  const attuned = actor.attuned ?? [];
  if ((verb === "stow" || verb === "unattune") && boundTo(actor, id, access)) {
    throw new Error(`A curse holds ${id}`);
  }
  switch (verb) {
    case "equip": {
      const { type } = itemOf(access, id);
      const replaced =
        type === "armor" || type === "shield"
          ? equipped(actor).filter(
              (other) => itemOf(access, other).type === type,
            )
          : [];
      return { stowed: [...without(stowed, [id]), ...replaced], attuned };
    }
    case "stow":
      return { stowed: [...stowed, id], attuned };
    case "attune": {
      const stats = deriveStats(actor, access);
      const limit = attunementLimit(stats);
      if (attuned.length >= limit) {
        throw new Error(`Already attuned to ${String(limit)} items`);
      }
      if (!canAttune(actor, itemOf(access, id), stats)) {
        throw new Error(`${id} won't take this attunement`);
      }
      return { stowed, attuned: [...attuned, id] };
    }
    case "unattune":
      return { stowed, attuned: attuned.filter((item) => item !== id) };
    default:
      throw new Error(`Unknown gear choice ${answer}`);
  }
}

// The save attuning to an item calls for, as the Wand of Orcus's, read off the magic item a weapon is made from.
export function attuneSaveFrames(
  actor: Actor,
  answer: string,
  access: ContentAccess,
): Frame[] {
  if (!answer.startsWith("attune:")) return [];
  const item = answer.slice("attune:".length);
  const magic = ItemSchema.safeParse(
    access.content(item.split("--")[0] ?? item),
  ).data;
  return magic?.type === "magicItem" && magic.attuneSave
    ? [frame("attuneSave", { actor: actor.id, item })]
    : [];
}

export function foundText(found: Loot, access: ContentAccess): string[] {
  return [
    ...(found.gold > 0 ? [`${String(found.gold)} gp`] : []),
    ...found.items.map((id) => itemOf(access, id).name),
  ];
}

const StepSchema = z.object({
  step: z.number().int(),
  found: LootSchema.optional(), // set for the moment treasure is found
});

function runGearStep(
  { step, found }: z.infer<typeof StepSchema>,
  context: Context,
): SystemResult {
  const actor = player(context.state);
  const options = gearOptions(actor, context, found?.items);
  const attuned = actor.attuned ?? [];
  return {
    frames: [
      awaitDecision({
        id: `${NS}:${found ? "found" : "gear"}:${String(actor.inventory.length)}:${String(step)}`,
        actor: actor.id,
        prompt: found
          ? `Found: ${foundText(found, context).join(", ") || "nothing of value"}.`
          : `Change your gear. You are attuned to ${String(attuned.length)} of ${String(attunementLimit(deriveStats(actor, context)))} items.`,
        // "Done" comes last, which is also what the bot picks when it has no reason to change anything.
        options: [...options, { id: DONE, label: found ? "Carry on" : "Done" }],
        resume: frame("gearAnswer", { step, ...(found ? { found } : {}) }),
      }),
    ],
  };
}

const AnswerSchema = StepSchema.extend({ answer: z.string() });

function runGearAnswer(
  { answer, step, found }: z.infer<typeof AnswerSchema>,
  context: Context,
): SystemResult {
  if (answer === DONE) return {};
  const actor = player(context.state);
  return {
    events: [
      dndEvent(`${NS}:gearChanged`, {
        actor: actor.id,
        ...changed(actor, answer, context),
      }),
    ],
    frames: [
      ...attuneSaveFrames(actor, answer, context),
      frame("gearStep", { step: step + 1, ...(found ? { found } : {}) }),
    ],
  };
}

// From the character sheet between a scene's choices, outside a fight: changing gear, attuning where the
// party could rest, as attuning takes a Short Rest, and drinking a potion.
// shortcut: attuning between choices doesn't pass the Short Rest's hour, which only the rest itself counts.
export function sceneGearActions(
  state: DndState,
  access: ContentAccess,
): SceneAction[] {
  const actor = state.actors[PLAYER_ACTOR];
  // Before a character is chosen there is nothing to carry.
  if (
    state.combat ||
    actor?.source.kind !== "character" ||
    !actor.source.build
  ) {
    return [];
  }
  // One choice per item, as the sheet's row has one button: putting on a spare comes before stowing.
  const rows = new Set<string>();
  const full = actor.hp >= deriveStats(actor, access).maxHp;
  return [
    ...gearOptions(actor, access)
      .filter(({ id }) => {
        const item = id.slice(id.indexOf(":") + 1);
        return !rows.has(item) && Boolean(rows.add(item));
      })
      .map(({ id, label }) => ({
        id,
        label,
        effect: `${NS}:changeGear`,
        args: { answer: id },
        ...(/^(un)?attune:/.test(id) ? { rest: true } : {}),
      })),
    ...[...new Set(actor.inventory)].flatMap((id) => {
      const item = itemOf(access, id);
      return itemHealing(item)
        ? [
            {
              id: `drink:${id}`,
              label: `Drink ${item.name}`,
              effect: `${NS}:drink`,
              args: { item: id },
              // A potion only heals, so at full health the sheet shows Drink disabled.
              ...(full ? { hidden: true as const } : {}),
            },
          ]
        : [];
    }),
    ...storeActions(state, access),
    ...coatActions(actor, access),
    ...[...new Set(actor.inventory)].flatMap((id) => {
      const item = itemOf(access, id);
      if (item.type !== "magicItem" || !item.chooseSkill) return [];
      const picked = actor.itemSkills?.[id];
      return item.chooseSkill
        .filter((skill) => skill !== picked)
        .map((skill) => ({
          id: `skill:${id}:${skill}`,
          label: `${item.name}: proficiency in ${skill.replace(/^./, (first) => first.toUpperCase())}`,
          effect: `${NS}:pickItemSkill`,
          args: { item: id, skill },
          // The first pick comes with attuning; a change waits on a Long Rest's time.
          ...(picked ? { rest: true as const } : {}),
        }));
    }),
    ...[...new Set(actor.inventory)].flatMap((id) => {
      const item = itemOf(access, id);
      if (item.type !== "magicItem" || !item.study) return [];
      const { ability: printed } = item.study;
      return (printed === "any" ? ABILITIES : [printed])
        .filter((ability) => studyGain(actor, item, ability) > 0)
        .map((ability) => ({
          id: printed === "any" ? `study:${id}:${ability}` : `study:${id}`,
          label:
            printed === "any"
              ? `Study ${item.name}: ${ABILITY_NAMES[ability]}`
              : `Study ${item.name}`,
          effect: `${NS}:study`,
          args: { item: id, ...(printed === "any" ? { ability } : {}) },
          rest: true,
        }));
    }),
  ];
}

// Applying an oil to a plain weapon or ammunition carried (MagicItemSchema `coats`), as Oil of Sharpness.
function coatActions(actor: Actor, access: ContentAccess): SceneAction[] {
  return [...new Set(actor.inventory)].flatMap((oilId) => {
    const oil = itemOf(access, oilId);
    if (oil.type !== "magicItem" || !oil.coats) return [];
    const { coats } = oil;
    return [...new Set(actor.inventory)].flatMap((targetId) => {
      const target = itemOf(access, targetId);
      const melee =
        target.type === "weapon" &&
        !target.baseWeapon &&
        !target.properties.includes("ammunition") &&
        coats.damage.includes(target.damage.type);
      const ammunition =
        target.type === "gear" && target.category === "ammunition";
      if (!melee && !ammunition) return [];
      const made = melee
        ? `${coats.weapon}--${targetId.slice(targetId.lastIndexOf("/") + 1)}`
        : coats.ammunition;
      if (!access.content(made)) return [];
      return [
        {
          id: `coat:${oilId}:${targetId}`,
          label: `Apply ${oil.name} to ${target.name}`,
          effect: `${NS}:coat`,
          args: {
            oil: oilId,
            target: targetId,
            items: Array<string>(melee ? 1 : coats.pieces).fill(made),
          },
        },
      ];
    });
  });
}

// The oil and what it coats are used up, and what it makes is carried in their place.
function coat(
  args: z.infer<typeof CoatSchema>,
  context: Context,
): SystemResult {
  const actor = player(context.state);
  const offered = coatActions(actor, context).find(
    (option) => option.id === `coat:${args.oil}:${args.target}`,
  );
  if (!offered) throw new Error(`${args.oil} can't coat ${args.target}`);
  const { items } = CoatSchema.parse(offered.args);
  return {
    events: [
      dndEvent(`${NS}:itemUsed`, { actor: actor.id, item: args.oil }),
      dndEvent(`${NS}:itemUsed`, { actor: actor.id, item: args.target }),
      dndEvent(`${NS}:treasureFound`, {
        actor: actor.id,
        gold: 0,
        items,
        stowed: [],
      }),
    ],
  };
}

const CoatSchema = z.object({
  oil: z.string(),
  target: z.string(),
  items: z.array(z.string()),
});

// Casting a spell into an item a party member carries, as into a Ring of Spell Storing (MagicItemSchema
// `storesSpells`): each party caster's leveled spells that fit, with the lowest slot they have that the item takes.
function storeActions(state: DndState, access: ContentAccess): SceneAction[] {
  const party = Object.values(state.actors).filter(
    (item) =>
      item.side === "party" &&
      item.source.kind === "character" &&
      !isDead(item) &&
      item.hp > 0,
  );
  return party.flatMap((holder) =>
    [...new Set(holder.inventory)].flatMap((itemId) => {
      const item = itemOf(access, itemId);
      if (item.type !== "magicItem" || !item.storesSpells) return [];
      const { levels, maxLevel } = item.storesSpells;
      const room =
        levels -
        (holder.storedSpells?.[itemId] ?? []).reduce(
          (total, stored) => total + stored.level,
          0,
        );
      return party.flatMap((caster) => {
        const stats = deriveStats(caster, access);
        return stats.actions.flatMap((action) => {
          const spell = action.id.startsWith("spell:")
            ? spellOfSource(action.id)
            : null;
          const least = action.spellLevel;
          if (
            !spell ||
            castFrom(action.id) ||
            least === null ||
            least < 1 ||
            !action.activation.cost.includes("slot")
          ) {
            return [];
          }
          const slot = Array.from(
            { length: Math.min(maxLevel, room) - least + 1 },
            (_, index) => least + index,
          ).find(
            (level) =>
              (stats.slots[level - 1] ?? 0) >
              (caster.resourcesSpent[`slot:${String(level)}`] ?? 0),
          );
          if (slot === undefined) return [];
          const who = caster.id === PLAYER_ACTOR ? "" : `${caster.name}: `;
          return [
            {
              id: `store:${caster.id}:${spell}:${itemId}`,
              label: `${who}Store ${action.name} in ${item.name}`,
              effect: `${NS}:storeSpell`,
              args: {
                caster: caster.id,
                holder: holder.id,
                spell,
                item: itemId,
                slot,
              },
            },
          ];
        });
      });
    }),
  );
}

// The caster spends the slot, and the item holds the spell with the caster's numbers.
function storeSpell(
  args: z.infer<typeof StoreSchema>,
  context: Context,
): SystemResult {
  const offered = storeActions(context.state, context).some(
    (option) =>
      option.args.caster === args.caster &&
      option.args.spell === args.spell &&
      option.args.item === args.item &&
      option.args.holder === args.holder,
  );
  const caster = context.state.actors[args.caster];
  if (!offered || !caster) {
    throw new Error(`${args.caster} can't store ${args.spell} in ${args.item}`);
  }
  const stats = deriveStats(caster, context);
  return {
    events: [
      dndEvent(`${NS}:resourceSpent`, {
        actor: caster.id,
        resource: `slot:${String(args.slot)}`,
      }),
      dndEvent(`${NS}:spellStored`, {
        actor: args.holder,
        item: args.item,
        stored: {
          spell: args.spell,
          level: args.slot,
          dc: spellSaveDc(stats),
          attack: spellAttackBonus(stats),
          mod: evaluateFormula({ base: 0, add: [{ kind: "spellMod" }] }, stats),
        },
      }),
    ],
  };
}

const StoreSchema = z.object({
  caster: z.string(),
  holder: z.string(),
  spell: z.string(),
  item: z.string(),
  slot: z.number().int().min(1).max(9),
});

// How much studying the item raises the character's own score, which may be nothing once at its maximum, once
// studied where it's studied once, or while not attuned to it where it needs Attunement.
function studyGain(
  actor: Actor,
  item: z.infer<typeof ItemSchema>,
  ability: Ability,
): number {
  const build = effectiveBuild(actor);
  if (item.type !== "magicItem" || !item.study || !build) return 0;
  const { raise, max, keep, passives } = item.study;
  if ((keep || passives) && (actor.studied ?? []).includes(item.id)) return 0;
  if (item.attunement && !(actor.attuned ?? []).includes(item.id)) return 0;
  const score = ownAbilities(actor, build)[ability];
  return Math.max(0, Math.min(raise, max - score));
}

// Studying a Manual or Tome: the score it raises, by as much as it rose, and the item, whose magic is spent, unless
// it's kept. One that lowers another score lowers the reader's lowest other one, as far as it goes.
// shortcut: the 48 hours over six days pass with a rest, as attuning's hour does, and so do a book's 80.
function study(
  id: string,
  chosen: Ability | undefined,
  context: Context,
): SystemResult {
  const actor = player(context.state);
  const item = itemOf(context, id);
  const build = effectiveBuild(actor);
  if (item.type !== "magicItem" || !item.study || !build) {
    throw new Error(`${actor.id} can't study ${id}`);
  }
  const ability = item.study.ability === "any" ? chosen : item.study.ability;
  const amount = ability ? studyGain(actor, item, ability) : 0;
  if (!ability || amount === 0) {
    throw new Error(`${actor.id} can't study ${id}`);
  }
  if (!actor.inventory.includes(id)) {
    throw new Error(`${actor.id} has no ${id} to study`);
  }
  const { lower, keep, passives } = item.study;
  const own = ownAbilities(actor, build);
  const lowest = lower
    ? ABILITIES.filter((other) => other !== ability).reduce((low, other) =>
        own[other] < own[low] ? other : low,
      )
    : undefined;
  const lowered =
    lower && lowest ? Math.min(lower.amount, own[lowest] - lower.min) : 0;
  return {
    events: [
      dndEvent(`${NS}:abilityRaised`, {
        actor: actor.id,
        ability,
        amount,
        item: id,
      }),
      ...(lowest && lowered > 0
        ? [
            dndEvent(`${NS}:abilityRaised`, {
              actor: actor.id,
              ability: lowest,
              amount: -lowered,
              item: id,
            }),
          ]
        : []),
      ...(keep || passives
        ? [dndEvent(`${NS}:itemStudied`, { actor: actor.id, item: id })]
        : []),
      ...(keep
        ? []
        : [dndEvent(`${NS}:itemUsed`, { actor: actor.id, item: id })]),
    ],
  };
}

// The healing is rolled here and carried by the event, so a later rules change can't rewrite it.
function drink(id: string, context: Context): SystemResult {
  const actor = player(context.state);
  const healing = itemHealing(itemOf(context, id));
  if (!healing || !actor.inventory.includes(id)) {
    throw new Error(`${actor.id} has no ${id} to drink`);
  }
  const stats = deriveStats(actor, context);
  const rolled = rollAmount(healing, stats, context.dice);
  return {
    events: [
      dndEvent(`${NS}:healed`, {
        actor: actor.id,
        amount: Math.min(rolled, stats.maxHp - Math.max(actor.hp, 0)),
        max: stats.maxHp,
      }),
      dndEvent(`${NS}:itemUsed`, { actor: actor.id, item: id }),
    ],
  };
}

export const gearEffects = {
  [`${NS}:changeGear`]: storyEffect({
    schema: z.object({ answer: z.string() }),
    apply: ({ answer }, context: Context) => {
      const actor = player(context.state);
      return {
        events: [
          dndEvent(`${NS}:gearChanged`, {
            actor: actor.id,
            ...changed(actor, answer, context),
          }),
        ],
        frames: attuneSaveFrames(actor, answer, context),
      };
    },
  }),
  [`${NS}:drink`]: storyEffect({
    schema: z.object({ item: z.string() }),
    references: ({ item }) => [item],
    apply: ({ item }, context: Context) => drink(item, context),
  }),
  [`${NS}:pickItemSkill`]: storyEffect({
    schema: z.object({ item: z.string(), skill: z.string() }),
    references: ({ item }) => [item],
    apply: ({ item, skill }, context: Context) => {
      const actor = player(context.state);
      const entry = itemOf(context, item);
      if (
        !actor.inventory.includes(item) ||
        entry.type !== "magicItem" ||
        !entry.chooseSkill?.some((option) => option === skill)
      ) {
        throw new Error(`${item} gives no ${skill}`);
      }
      return {
        events: [
          dndEvent(`${NS}:itemSkillPicked`, { actor: actor.id, item, skill }),
        ],
      };
    },
  }),
  [`${NS}:coat`]: storyEffect({
    schema: CoatSchema,
    references: ({ oil, target, items }) => [oil, target, ...items],
    apply: coat,
  }),
  [`${NS}:storeSpell`]: storyEffect({
    schema: StoreSchema,
    references: ({ item, spell }) => [item, spell],
    apply: storeSpell,
  }),
  [`${NS}:study`]: storyEffect({
    schema: z.object({ item: z.string(), ability: AbilitySchema.optional() }),
    references: ({ item }) => [item],
    apply: ({ item, ability }, context: Context) =>
      study(item, ability, context),
  }),
  // `goldEach` is paid to every living party member, as "150 GP each", so the total follows the party's size then.
  [`${NS}:treasure`]: storyEffect({
    schema: LootSchema.extend({
      goldEach: z.number().int().min(0).default(0),
    }),
    references: (loot) => loot.items,
    apply: ({ goldEach, ...loot }, context: Context) =>
      treasure(
        {
          ...loot,
          gold: loot.gold + goldEach * partySize(context.state),
        },
        context,
      ),
  }),
};

const UseItemSchema = z.object({ actor: z.string(), item: z.string() });
const ThrowWeaponSchema = z.object({
  actor: z.string(),
  item: z.string(),
  target: z.string(),
});

// A thrown weapon lands where its target stood, hit or miss.
// shortcut: in a fight without a grid it lands at 0,0, and comes back when the fight ends.
function throwWeapon(
  payload: z.infer<typeof ThrowWeaponSchema>,
  context: Context,
): SystemResult {
  const { actors } = context.state;
  const thrower = actors[payload.actor];
  if (!thrower || !equipped(thrower).includes(payload.item)) return {};
  // A Returning Weapon comes back to the hand that threw it.
  const item = itemOf(context, payload.item);
  if (
    item.type === "weapon" &&
    (item.returning || imbuedRange(thrower, payload.item))
  ) {
    return {};
  }
  const at = actors[payload.target]?.position ??
    thrower.position ?? { x: 0, y: 0 };
  return {
    events: [
      dndEvent(`${NS}:weaponThrown`, {
        item: payload.item,
        at,
        by: thrower.id,
      }),
    ],
  };
}

export const gearFrames = {
  [`${NS}:useItem`]: frameHandler({
    schema: UseItemSchema,
    run: (payload, _context: Context) => ({
      events: [dndEvent(`${NS}:itemUsed`, payload)],
    }),
  }),
  [`${NS}:throwWeapon`]: frameHandler({
    schema: ThrowWeaponSchema,
    run: throwWeapon,
  }),
  [`${NS}:gearStep`]: frameHandler({ schema: StepSchema, run: runGearStep }),
  [`${NS}:gearAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runGearAnswer,
  }),
};
