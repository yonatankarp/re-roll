import {
  type ContentAccess,
  type Frame,
  PLAYER_ACTOR,
  type SystemContext,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import { ItemSchema, type Loot, LootSchema } from "./schemas.ts";
import {
  type Actor,
  type DndState,
  MAX_ATTUNED,
  NS,
  dndEvent,
  equipped,
  without,
} from "./state.ts";
import { lookup } from "./stats.ts";

type Context = SystemContext<DndState>;

const DONE = "done";
const WORN_TYPES = new Set(["weapon", "armor", "shield"]);

function frame(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): Frame {
  return { kind: `${NS}:${kind}`, payload };
}

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

// What can be put on, taken off, attuned or let go, as during a Short Rest, which attuning takes.
// With `found`, only putting on what was just found, so the moment stays short.
export function gearOptions(
  actor: Actor,
  access: ContentAccess,
  found?: readonly string[],
): { id: string; label: string }[] {
  const worn = equipped(actor);
  const attuned = actor.attuned ?? [];
  return [...new Set(actor.inventory)]
    .filter((id) => !found || found.includes(id))
    .flatMap((id) => {
      const item = itemOf(access, id);
      if (WORN_TYPES.has(item.type)) {
        return [
          ...((actor.stowed ?? []).includes(id)
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
function changed(
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

export const gearEffects = {
  [`${NS}:treasure`]: storyEffect({
    schema: LootSchema,
    references: (loot) => loot.items,
    apply: (loot, context: Context) => treasure(loot, context),
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
