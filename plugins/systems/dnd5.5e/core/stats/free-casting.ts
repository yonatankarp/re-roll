// Spells cast without a slot, as a feat or feature allows.
import type { ContentAccess } from "#sdk";
import {
  type Activation,
  ActivationSchema,
  type FreeCast,
  type Feature,
  SpellSchema,
} from "../schemas.ts";
import { lookup } from "./content.ts";
import type { KnownAction } from "./model.ts";
import { doesSomething } from "./resolution.ts";
import { scaleActivation, cantripTier } from "./scaling.ts";

// The activation with each Concentration duration made a plain one of these minutes, as War God's Blessing's.
function unconcentrated(activation: Activation, minutes: number): Activation {
  return ActivationSchema.parse(
    JSON.parse(JSON.stringify(activation), (_key, value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      "concentration" in value &&
      "minutes" in value
        ? { minutes }
        : value,
    ),
  );
}

// A leveled spell a feat or feature lets the character cast without a slot, as its own action (FreeCastSchema). The
// ways a spell has share one action and pool when they're its own once-a-rest uses, as Hex from two traits, and each
// spending another resource is an action of its own, "spell:<spell>:free:<resource>" after the first.
export function freeCastActions(
  spells: ReadonlyMap<string, readonly FreeCast[]>,
  access: ContentAccess,
  level: number,
): { action: KnownAction; resource: Feature["resources"][number] | null }[] {
  return [...spells].flatMap(([spellId, ways]) => {
    if (!access.content(spellId)) return [];
    const spell = lookup(access, SpellSchema, spellId);
    const { activation } = spell;
    const quick = (how: FreeCast) => typeof how === "object" && how.bonusAction;
    if (!activation || (spell.level === 0 && !ways.some(quick))) return [];
    if (!doesSomething(activation.resolution)) return [];
    const isOwn = (how: FreeCast) => how === true || how === "shortRest";
    const own = ways.filter(isOwn);
    const [first] = own;
    const kinds = [
      ...(first === undefined ? [] : [first]),
      ...new Set(ways.filter((how) => !isOwn(how))),
    ];
    return kinds.flatMap((how, index) => {
      if (spell.level === 0 && !quick(how)) return [];
      const id =
        typeof how === "object" && how.resource
          ? how.resource
          : `free:${spellId}`;
      const unlimited =
        how === "atWill" || (typeof how === "object" && !how.resource);
      const slot =
        typeof how === "object" && how.slotLevel
          ? Object.entries(how.slotLevel)
              .filter(([from]) => Number(from) <= level)
              .reduce((best, [, at]) => Math.max(best, at), 0)
          : spell.level;
      if (slot < spell.level) return [];
      const step = spell.upcast?.perSlotLevel;
      const leveled =
        spell.level === 0 && spell.cantrip
          ? scaleActivation(
              activation,
              spell.cantrip.perTier,
              cantripTier(level),
            )
          : slot > spell.level && step
            ? scaleActivation(activation, step, slot - spell.level)
            : activation;
      const lasting =
        typeof how === "object" && how.minutes !== undefined
          ? unconcentrated(leveled, how.minutes)
          : leveled;
      const targeted =
        typeof how === "object" && how.self
          ? { ...lasting, targeting: { self: true as const } }
          : lasting;
      const cast =
        typeof how === "object" && how.whileIn
          ? { ...targeted, whileIn: how.whileIn }
          : targeted;
      const suffix =
        index === 0
          ? ""
          : `:${typeof how === "object" ? (how.resource ?? "free") : how}`;
      return [
        {
          action: {
            id: `spell:${spellId}:free${suffix}`,
            name: `${spell.name} (free)`,
            activation: {
              ...cast,
              cost: [
                ...activation.cost
                  .filter((cost) => cost !== "slot")
                  .map((cost) =>
                    quick(how) && cost === "action" ? "bonusAction" : cost,
                  ),
                ...(unlimited
                  ? []
                  : [
                      typeof how === "object" && how.perLevel && slot > 1
                        ? { resource: id, count: slot }
                        : typeof how === "object" && how.count
                          ? { resource: id, count: how.count }
                          : { resource: id },
                    ]),
              ],
            },
            spellLevel: slot,
          },
          resource: isOwn(how)
            ? {
                id,
                max: { base: own.length, add: [] },
                recharge: [
                  {
                    on: how === true ? "longRest" : "shortRest",
                    amount: "all",
                  },
                ],
              }
            : null,
        },
      ];
    });
  });
}

// How a feature casts one of its spells without a slot: all alike, or each as its own entry says.
export function freeCastOf(
  how: Feature["freeCast"],
  spell: string,
): FreeCast | undefined {
  if (how === undefined || how === true || typeof how === "string") return how;
  return "resource" in how && typeof how.resource === "string"
    ? how
    : (how as Record<string, FreeCast>)[spell];
}
