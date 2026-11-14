import {
  type ContentAccess,
  PLAYER_ACTOR,
  type SceneAction,
  type SystemContext,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import { ClassSchema, ItemSchema, type Loot, LootSchema } from "./schemas.ts";
import {
  type Actor,
  type DndState,
  MAX_ATTUNED,
  NS,
  dndEvent,
  equipped,
  without,
  frame,
  isDead,
} from "./state.ts";
import {
  type Stats,
  deriveStats,
  itemHealing,
  lookup,
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

// The coins and items go to the player's character, and found gear goes in the pack until put on.
// shortcut: companions never carry loot, so only the player's character can equip it.
// The party's living members, its summons left out.
function partySize(state: DndState): number {
  return Object.values(state.actors).filter(
    (actor) =>
      actor.side === "party" &&
      actor.source.kind !== "summon" &&
      !isDead(actor),
  ).length;
}

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
    ],
    frames: [frame("gearStep", { step: 0, found: { gold, items } })],
  };
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
      return classes.some((def) => def.armor.includes(item.armorType));
    case "shield":
      return classes.some((def) => def.armor.includes("shield"));
    case "magicItem":
      return !item.spell || stats.spellAbility !== null;
    default:
      return true;
  }
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
      if (WORN_TYPES.has(item.type)) {
        const wearable = item.type === "weapon" || canUse(item, stats, access);
        return [
          ...((actor.stowed ?? []).includes(id) && wearable
            ? [{ id: `equip:${id}`, label: `Equip ${item.name}` }]
            : []),
          ...(worn.includes(id) && !found
            ? [{ id: `stow:${id}`, label: `Stow ${item.name}` }]
            : []),
        ];
      }
      if (item.type !== "magicItem" || !item.attunement || found) return [];
      if (attuned.includes(id)) {
        return [
          { id: `unattune:${id}`, label: `End attunement to ${item.name}` },
        ];
      }
      return attuned.length < MAX_ATTUNED
        ? [{ id: `attune:${id}`, label: `Attune to ${item.name}` }]
        : [];
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
    case "attune":
      if (attuned.length >= MAX_ATTUNED) {
        throw new Error(`Already attuned to ${String(MAX_ATTUNED)} items`);
      }
      return { stowed, attuned: [...attuned, id] };
    case "unattune":
      return { stowed, attuned: attuned.filter((item) => item !== id) };
    default:
      throw new Error(`Unknown gear choice ${answer}`);
  }
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
          : `Change your gear. You are attuned to ${String(attuned.length)} of ${String(MAX_ATTUNED)} items.`,
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
  ];
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
      };
    },
  }),
  [`${NS}:drink`]: storyEffect({
    schema: z.object({ item: z.string() }),
    references: ({ item }) => [item],
    apply: ({ item }, context: Context) => drink(item, context),
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

export const gearFrames = {
  [`${NS}:useItem`]: frameHandler({
    schema: UseItemSchema,
    run: (payload, _context: Context) => ({
      events: [dndEvent(`${NS}:itemUsed`, payload)],
    }),
  }),
  [`${NS}:gearStep`]: frameHandler({ schema: StepSchema, run: runGearStep }),
  [`${NS}:gearAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runGearAnswer,
  }),
};
