// Magic items: their charges, the spells they cast or store, and gear used up once used.
import type { ContentAccess } from "#sdk";
import type { z } from "zod";
import type { Actor } from "../state.ts";
import {
  type Item,
  type ItemCast,
  type Targeting,
  type ResourceDef,
  type Ability,
  type Activation,
  ItemSchema,
  type Passive,
  SpellSchema,
} from "../schemas.ts";
import { itemCastId, itemUseId } from "../combat/ids.ts";
import { lookup } from "./content.ts";
import type { KnownAction } from "./model.ts";
import { doesSomething } from "./resolution.ts";
import { scaleActivation, cantripTier } from "./scaling.ts";
import { diceCount } from "./dice.ts";
import { spellNamed, classSpells, onClassList } from "./spell-lists.ts";
import { castWith } from "./spell-changes.ts";

// A charged item's pools and spells (ChargedSchema). An entry with versions counts as its first, as its passives do.
export function chargesOf(item: Item): {
  readonly resources: readonly ResourceDef[];
  readonly casts: readonly ItemCast[];
} {
  const first = item.type === "magicItem" ? item.variants?.[0] : undefined;
  return {
    resources: [
      ...("resources" in item ? (item.resources ?? []) : []),
      ...(first?.resources ?? []),
    ],
    casts: [
      ...("casts" in item ? (item.casts ?? []) : []),
      ...(first?.casts ?? []),
    ],
  };
}

// A spell cast with an item's own numbers, as a Wand of Web's DC 13, rather than with the bearer's.
export function withItemNumbers(
  activation: Activation,
  dc: number | undefined,
  attack: number | undefined,
  mod?: number, // the spellcasting modifier, as a stored spell's caster's
): Activation {
  const toHit = attack ?? (dc === undefined ? undefined : dc - 8);
  const mapped = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((item) => mapped(item));
    if (value === null || typeof value !== "object") return value;
    const copy: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, mapped(item, name)]),
    );
    const terms = Array.isArray(copy.add)
      ? (copy.add as { readonly kind: string }[])
      : [];
    const fixed = (kind: string, amount: number | undefined): boolean =>
      amount !== undefined && terms.some((term) => term.kind === kind);
    if (fixed("spellSaveDc", dc) || fixed("spellMod", mod)) {
      const replaced = terms.filter(
        (term) =>
          (term.kind === "spellSaveDc" && dc !== undefined) ||
          (term.kind === "spellMod" && mod !== undefined),
      );
      return {
        ...copy,
        base:
          (typeof copy.base === "number" ? copy.base : 0) +
          replaced.reduce(
            (total, term) =>
              total + (term.kind === "spellSaveDc" ? (dc ?? 0) : (mod ?? 0)),
            0,
          ),
        add: terms.filter((term) => !replaced.includes(term)),
      };
    }
    return key === "attack" && copy.type === "spell" && toHit !== undefined
      ? { ...copy, flatBonus: toHit }
      : copy;
  };
  return mapped(activation) as Activation;
}

// The spells a worn item casts (ItemCastSchema): one action for each number of charges it can spend, each at its
// own level, which never spends a slot.
export function itemCasts(
  itemId: string,
  item: Item,
  level: number,
  access: ContentAccess,
  actor: Actor,
): KnownAction[] {
  const { resources, casts } = chargesOf(item);
  return casts.flatMap((cast) => {
    const spellId = spellNamed(cast.spell, access);
    const spell = spellId ? lookup(access, SpellSchema, spellId) : undefined;
    const activation = spell?.activation;
    if (!spellId || !spell || !activation) return [];
    const lasting =
      spell.lasting &&
      typeof spell.duration === "object" &&
      "concentration" in spell.duration;
    if (!lasting && !doesSomething(activation.resolution)) return [];
    const resource = cast.resource ?? resources[0]?.id;
    const lowest = cast.level ?? spell.level;
    const step = spell.upcast?.perSlotLevel;
    return Array.from(
      { length: (cast.upTo ?? cast.charges) - cast.charges + 1 },
      (_, extra) => cast.charges + extra,
    ).flatMap((charges): KnownAction[] => {
      const at = lowest + charges - cast.charges;
      if ((charges > 0 && !resource) || (at > lowest && !step)) return [];
      const scaled =
        spell.level === 0 && spell.cantrip
          ? scaleActivation(
              activation,
              spell.cantrip.perTier,
              cantripTier(level),
            )
          : step
            ? scaleActivation(activation, step, at - spell.level)
            : activation;
      const numbered = limitedCast(
        withItemNumbers(scaled, cast.dc, cast.attack),
        cast,
      );
      const used = resource ? (actor.resourcesSpent[resource] ?? 0) : 0;
      return [
        {
          id: itemCastId(spellId, itemId, charges),
          name:
            cast.upTo === undefined
              ? `${spell.name} (${item.name})`
              : `${spell.name}, level ${String(at)} (${item.name})`,
          activation: {
            ...numbered,
            ...(cast.doom || cast.userEffects
              ? {
                  userEffects: [
                    ...(numbered.userEffects ?? []),
                    ...(cast.userEffects ?? []),
                    ...(cast.doom
                      ? [
                          {
                            kind: "slay" as const,
                            hpAtMost: Number.MAX_SAFE_INTEGER,
                            chance: cast.doom,
                          },
                        ]
                      : []),
                  ],
                }
              : {}),
            cost: [
              ...activation.cost
                .map((cost) =>
                  cast.bonusAction && cost === "action" ? "bonusAction" : cost,
                )
                .filter(
                  (cost) =>
                    cost !== "slot" &&
                    !(
                      cast.gold !== undefined &&
                      typeof cost === "object" &&
                      "gold" in cost
                    ),
                ),
              // the item's own costly component in place of the spell's, as Cauldron of Rebirth's salt
              ...(cast.gold ? [{ gold: cast.gold }] : []),
              ...(charges > 0 && resource
                ? [{ resource, ...(charges > 1 ? { count: charges } : {}) }]
                : []),
            ],
          },
          spellLevel: at,
          ...(lasting ? { concentrates: true as const } : {}),
          // A Wind Fan used again before dawn may tear.
          ...(cast.tears && used > 0
            ? {
                castCheck: {
                  ability: "int" as const,
                  dc: 0,
                  chance: Math.min(100, cast.tears * used),
                  breaks: itemId,
                },
              }
            : {}),
        },
      ];
    });
  });
}

// An item's cast with its limits (ItemCastSchema): on its caster alone, an area of its size, only some creatures,
// and how some creatures' saves go.
function limitedCast(activation: Activation, cast: ItemCast): Activation {
  const { targeting, resolution } = activation;
  const narrowed: Targeting = cast.self
    ? { self: true }
    : "area" in targeting
      ? {
          ...targeting,
          ...(cast.radius
            ? { area: { ...targeting.area, radius: cast.radius } }
            : {}),
          ...(cast.creatureTypes ? { creatureTypes: cast.creatureTypes } : {}),
        }
      : "creatures" in targeting
        ? {
            ...targeting,
            ...(cast.creatureTypes
              ? { creatureTypes: cast.creatureTypes }
              : {}),
            ...(cast.swimmers ? { swimmers: true as const } : {}),
          }
        : targeting;
  return {
    ...activation,
    targeting: narrowed,
    resolution:
      cast.edges && resolution.kind === "save"
        ? { ...resolution, edges: [...(resolution.edges ?? []), ...cast.edges] }
        : resolution,
  };
}

// The spells an item lets its bearer try to cast without knowing them (MagicItemSchema `unknownSpell`): each behind
// its Arcana check, spending the item's use, and for a leveled spell a slot of its level.
export function unknownSpells(
  itemId: string,
  item: Item,
  known: ReadonlySet<string>,
  highest: number,
  ability: Ability,
  level: number,
  access: ContentAccess,
): KnownAction[] {
  if (item.type !== "magicItem" || !item.unknownSpell) return [];
  const rule = item.unknownSpell;
  return classSpells(rule.class, access).flatMap((spellId): KnownAction[] => {
    const spell = lookup(access, SpellSchema, spellId);
    const activation = spell.activation;
    if (
      !activation ||
      known.has(spellId) ||
      (rule.cantrips
        ? spell.level !== 0
        : spell.level < 1 || spell.level > highest) ||
      (rule.action && !activation.cost.includes("action"))
    ) {
      return [];
    }
    const scaled =
      spell.level === 0 && spell.cantrip
        ? scaleActivation(activation, spell.cantrip.perTier, cantripTier(level))
        : activation;
    const cast = castWith(scaled, ability);
    return [
      {
        id: itemCastId(spellId, itemId, 0),
        name: `${spell.name} (${item.name})`,
        activation: {
          ...cast,
          cost: [...cast.cost, { resource: rule.resource }],
        },
        spellLevel: spell.level,
        upcast: spell.upcast,
        castCheck: {
          ability: "int",
          skill: "arcana",
          dc: rule.dc + (rule.perLevel ? spell.level : 0),
          ...(rule.keepOnFailure ? { keep: rule.resource } : {}),
          ...(rule.failTable ? { table: itemId } : {}),
        },
      },
    ];
  });
}

// The spells stored in a worn item, each cast once with the slot and numbers it was stored with, as from a Ring of
// Spell Storing. Two of one spell are one action, which casts the first stored.
export function storedCasts(
  itemId: string,
  item: Item,
  actor: Actor,
  access: ContentAccess,
): KnownAction[] {
  if (item.type !== "magicItem" || !item.storesSpells) return [];
  const seen = new Set<string>();
  return (actor.storedSpells?.[itemId] ?? []).flatMap((stored) => {
    const spell = SpellSchema.safeParse(access.content(stored.spell)).data;
    if (!spell?.activation || seen.has(stored.spell)) return [];
    seen.add(stored.spell);
    const step = spell.upcast?.perSlotLevel;
    const scaled = step
      ? scaleActivation(spell.activation, step, stored.level - spell.level)
      : spell.activation;
    const numbered = withItemNumbers(
      scaled,
      stored.dc,
      stored.attack,
      stored.mod,
    );
    const lasting =
      spell.lasting &&
      typeof spell.duration === "object" &&
      "concentration" in spell.duration;
    return [
      {
        id: itemCastId(stored.spell, itemId, 0),
        name: `${spell.name}, level ${String(stored.level)} (${item.name})`,
        activation: {
          ...numbered,
          cost: numbered.cost.filter(
            (cost) =>
              cost !== "slot" && !(typeof cost === "object" && "gold" in cost),
          ),
        },
        spellLevel: stored.level,
        stored: itemId,
        ...(lasting ? { concentrates: true as const } : {}),
      },
    ];
  });
}

// A worn item's own activations (ChargedSchema `activations`), named after it, as a Pearl of Power's.
export function itemUses(
  itemId: string,
  item: Item,
  actor: Actor,
): KnownAction[] {
  const uses = "activations" in item ? (item.activations ?? []) : [];
  return uses.flatMap(({ name, activation, whileCharged, rolled }, index) =>
    whileCharged && !charged(actor, item, whileCharged)
      ? []
      : [
          {
            id: itemUseId(itemId, index),
            name: uses.length > 1 ? `${name} (${item.name})` : name,
            activation,
            spellLevel: null,
            ...(rolled ? { rolled: true as const } : {}),
          },
        ],
  );
}

// Whether one of the item's pools has a use left, as a Helm of Brilliance's rubies.
// shortcut: a pool's maximum here is its base and what was rolled, without terms worked out from the bearer.
export function charged(actor: Actor, item: Item, resource: string): boolean {
  const def = chargesOf(item).resources.find((pool) => pool.id === resource);
  if (!def) return false;
  const most =
    def.max.base +
    (actor.rolledPools?.[resource] ?? (def.rolled ? diceCount(def.rolled) : 0));
  return most - (actor.resourcesSpent[resource] ?? 0) > 0;
}

// The pools of every item carried, stowed or not, so a wand in the pack still regains its charges. Two of one item
// share theirs.
// shortcut: pools are kept by their ids, so a second Wand of Web adds no charges of its own.
export function itemPools(actor: Actor, access: ContentAccess): ResourceDef[] {
  const pools = new Map<string, ResourceDef>();
  for (const itemId of new Set(actor.inventory)) {
    for (const pool of chargesOf(lookup(access, ItemSchema, itemId))
      .resources) {
      if (!pools.has(pool.id)) pools.set(pool.id, pool);
    }
  }
  return [...pools.values()];
}

// What drinking it heals, for a potion such as a Potion of Healing.
// A potion entry with versions heals as its first, as older saves hold; `<id>--<n>` is the nth (variants.ts).
export function itemHealing(item: z.infer<typeof ItemSchema>) {
  return item.type === "gear"
    ? item.healing
    : item.type === "magicItem"
      ? (item.healing ?? item.variants?.[0]?.healing)
      : undefined;
}

// A spell's save DC and attack bonus when an item made with it casts it, by the spell's level, as a Spell Scroll's or
// an Enspelled Staff's.
export function boundNumbers(level: number): {
  readonly dc: number;
  readonly attack: number;
} {
  const dc =
    level <= 2 ? 13 : level <= 4 ? 15 : level <= 6 ? 17 : level <= 8 ? 18 : 19;
  return { dc, attack: dc - 8 };
}

// A potion to drink or a scroll to read, used up once used. Their action ids start "item:", which spends the item.
export function itemAction(
  itemId: string,
  item: z.infer<typeof ItemSchema>,
  access: ContentAccess,
  // the reader's spellcasting: its classes, ability and highest slot level
  reader:
    | {
        readonly classes: readonly string[];
        readonly ability: Ability;
        readonly highest: number;
        readonly anyScroll?: Ability; // any scroll, by Use Magic Device
      }
    | undefined,
): KnownAction | null {
  const healing = itemHealing(item);
  if (healing) {
    return {
      id: `item:${itemId}`,
      name: `Drink ${item.name}`,
      activation: {
        cost: ["bonusAction"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [{ kind: "heal", amount: healing }],
        },
      },
      spellLevel: null,
    };
  }
  if (item.type === "gear" && item.activation) {
    return {
      id: `item:${itemId}`,
      name: `Throw ${item.name}`,
      activation: item.activation,
      spellLevel: null,
    };
  }
  if (item.type === "magicItem" && item.activation) {
    const verb =
      item.verb ??
      (item.category === "potion"
        ? "Drink"
        : item.category === "scroll"
          ? "Read"
          : "Use");
    return {
      id: `item:${itemId}`,
      name: `${verb} ${item.name}`,
      activation: item.activation,
      spellLevel: null,
    };
  }
  // A Thayan Spell Tattoo's spell cast once without a slot or components, the tattoo gone after, with the bearer's
  // spellcasting or else DC 13 and +5.
  if (
    item.type === "magicItem" &&
    item.spell &&
    item.boundSpell?.as === "tattoo"
  ) {
    const spell = lookup(access, SpellSchema, item.spell);
    if (!spell.activation || !doesSomething(spell.activation.resolution)) {
      return null;
    }
    const activation =
      reader && reader.classes.length > 0
        ? spell.activation
        : withItemNumbers(spell.activation, 13, 5);
    return {
      id: `item:${itemId}`,
      name: `${spell.name} (${item.name})`,
      activation: {
        ...activation,
        cost: activation.cost.filter(
          (cost) =>
            cost !== "slot" && !(typeof cost === "object" && "gold" in cost),
        ),
      },
      spellLevel: spell.level,
    };
  }
  // A Spell Scroll is read by a caster with its spell on their list, with the scroll's numbers. A spell above the
  // slots they have takes a check of their spellcasting ability first, whose failure wastes the scroll.
  if (item.type !== "magicItem" || !item.spell || !reader) return null;
  const spell = lookup(access, SpellSchema, item.spell);
  const listed = onClassList(spell, reader.classes);
  if (
    !spell.activation ||
    !doesSomething(spell.activation.resolution) ||
    (!listed && reader.anyScroll === undefined)
  ) {
    return null;
  }
  const { dc, attack } = boundNumbers(spell.level);
  const numbered = withItemNumbers(spell.activation, dc, attack);
  return {
    id: `item:${itemId}`,
    name: `Read ${item.name}`,
    activation: {
      ...numbered,
      cost: numbered.cost.filter(
        (cost) =>
          cost !== "slot" && !(typeof cost === "object" && "gold" in cost),
      ),
    },
    spellLevel: spell.level,
    ...(listed
      ? spell.level > Math.max(reader.highest, 0)
        ? { castCheck: { ability: reader.ability, dc: 10 + spell.level } }
        : {}
      : spell.level > 1
        ? {
            castCheck: {
              ability: reader.anyScroll ?? reader.ability,
              skill: "arcana" as const,
              dc: 10 + spell.level,
            },
          }
        : {}),
  };
}

// Fast Hands: gear used with an action, as a flask of Acid thrown, takes a Bonus Action instead.
// shortcut: every such use counts as the Utilize action.
export function fastHands(
  action: KnownAction,
  passives: readonly Passive[],
): KnownAction {
  if (!passives.some((passive) => passive.kind === "fastHands")) return action;
  return {
    ...action,
    activation: {
      ...action.activation,
      cost: action.activation.cost.map((cost) =>
        cost === "action" ? "bonusAction" : cost,
      ),
    },
  };
}

// Bomber's Far Lobber: a vial or flask thrown farther.
export function farLobbed(
  action: KnownAction,
  passives: readonly Passive[],
): KnownAction {
  const { targeting } = action.activation;
  const feet = Math.max(
    0,
    ...passives.map((passive) =>
      passive.kind === "farLobber" ? passive.feet : 0,
    ),
  );
  if (
    !("creatures" in targeting) ||
    typeof targeting.range !== "number" ||
    targeting.range >= feet
  ) {
    return action;
  }
  return {
    ...action,
    activation: {
      ...action.activation,
      targeting: { ...targeting, range: feet },
    },
  };
}
