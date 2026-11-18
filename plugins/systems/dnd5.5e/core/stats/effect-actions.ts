// What spells and items on a creature do to its actions.
import type { ContentAccess } from "#sdk";
import type { Actor } from "../state.ts";
import {
  type Activation,
  ItemSchema,
  type Spell,
  SpellSchema,
  type WeaponChange,
} from "../schemas.ts";
import {
  GRANTED_PREFIX,
  ITEM_PREFIX,
  castFrom,
  itemUseOf,
  spellOfSource,
} from "../combat/ids.ts";
import { lookup } from "./content.ts";
import type { Stats, KnownAction } from "./model.ts";
import { scaleActivation, cantripTier } from "./scaling.ts";
import { evaluateFormula } from "./formulas.ts";
import { retyped } from "./spell-changes.ts";
import { weaponAttackOf, weaponFits } from "./weapons.ts";

// What spells on the creature do to its actions: a weapon changed by Shillelagh or True Strike, an action given
// by Dragon's Breath, and a spell's weapon attack reaching as far as the weapons it can use.
export function withEffectActions(
  stats: Stats,
  actor: Actor,
  access: ContentAccess,
): Stats {
  // Most creatures have none of these, and stats are derived often.
  if (
    !actor.activeEffects.some(
      ({ modifier }) =>
        modifier.kind === "weaponSpell" ||
        modifier.kind === "grantedAction" ||
        modifier.kind === "wished" ||
        modifier.kind === "stolenSpell" ||
        modifier.kind === "spheres",
    ) &&
    !stats.actions.some((action) =>
      weaponAttackOf(action.activation.resolution),
    )
  ) {
    return stats;
  }
  const granted: KnownAction[] = [];
  const resources: Record<string, number> = {};
  let actions = stats.actions;
  for (const { modifier, sourceId, level } of actor.activeEffects) {
    // Elminster's Effulgent Spheres: each of its actions spends a sphere.
    if (modifier.kind === "spheres") {
      const spellId = spellOfSource(sourceId) ?? "";
      const spell = lookup(access, SpellSchema, spellId);
      if (!spell.spheres) continue;
      const key = `spheres:${spellId}`;
      const { gathered, countMod, count, perSlot } = spell.spheres;
      // Spirit Lantern: as many as it has gathered, up to the caster's spellcasting modifier (an item's count).
      const most =
        countMod && !castFrom(sourceId)
          ? Math.max(
              1,
              evaluateFormula({ base: 0, add: [{ kind: "spellMod" }] }, stats),
            )
          : count;
      resources[key] = gathered
        ? Math.min(most, actor.resourcesSpent[`${key}:gathered`] ?? 0)
        : count + perSlot * Math.max(0, (level ?? spell.level) - spell.level);
      spell.spheres.actions.forEach((activation, index) => {
        granted.push({
          id: `spheres:${sourceId}:${String(index)}`,
          name: `${spell.name}${activation.label ? `: ${activation.label}` : ""}`,
          activation: {
            ...activation,
            cost: [...activation.cost, { resource: key }],
          },
          spellLevel: null,
        });
      });
      continue;
    }
    // Spell Thief: the thief has the spell prepared, cast with its own slots, and its caster can't cast it.
    if (modifier.kind === "stolenSpell") {
      const id = `spell:${modifier.spell}`;
      if (modifier.lost) {
        actions = actions.filter(
          (action) => spellOfSource(action.id) !== modifier.spell,
        );
      } else if (!actions.some((action) => action.id === id)) {
        const spell = lookup(access, SpellSchema, modifier.spell);
        if (spell.activation) {
          actions = [
            ...actions,
            {
              id,
              name: spell.name,
              activation: spell.activation,
              spellLevel: spell.level,
              upcast: spell.upcast,
            },
          ];
        }
      }
    }
    if (modifier.kind === "wished") {
      const id = `spell:${modifier.spell}`;
      const spell = lookup(access, SpellSchema, modifier.spell);
      // Once cast it's no longer offered, yet stays to be found until the turn is over, as its attacks need it.
      const cast = actor.usedThisTurn.includes(wishedKey(modifier.spell));
      const known = actions.some((action) => action.id === id);
      const copy = (
        activation: Activation,
      ): Omit<KnownAction, "id" | "name"> => ({
        activation: { ...activation, cost: [] },
        spellLevel: spell.level,
        ...(spell.upcast ? { upcast: spell.upcast } : {}),
        ...(cast ? { rolled: true as const } : {}),
      });
      if (known && !cast) {
        actions = actions.map((action) =>
          action.id === id ? { ...action, ...copy(action.activation) } : action,
        );
      } else if (!known && spell.activation) {
        actions = [
          ...actions,
          { id, name: spell.name, ...copy(spell.activation) },
        ];
      }
    }
    if (modifier.kind === "weaponSpell") {
      actions = actions.map(
        (action) => changedWeapon(action, modifier, stats, access) ?? action,
      );
    }
    if (modifier.kind !== "grantedAction") continue;
    const giver = grantedBy(sourceId, access);
    if (!giver) continue;
    // A cantrip's action grows with the bearer's level, as Produce Flame's hurl.
    const scaled =
      giver.spell?.upcast && giver.spell.granted
        ? scaleActivation(
            giver.activation,
            giver.spell.upcast.perSlotLevel,
            (level ?? giver.spell.level) - giver.spell.level,
          )
        : giver.spell?.level === 0 && giver.spell.cantrip
          ? scaleActivation(
              giver.activation,
              giver.spell.cantrip.perTier,
              cantripTier(stats.level),
            )
          : giver.activation;
    const { resolution } = scaled;
    const dcSet =
      resolution.kind === "save" && modifier.dc !== undefined
        ? {
            ...scaled,
            resolution: { ...resolution, dc: { base: modifier.dc, add: [] } },
          }
        : scaled;
    const retypedAction = modifier.damage
      ? retyped(dcSet, modifier.damage)
      : dcSet;
    const uses = modifier.uses;
    if (uses !== undefined) resources[grantedKey(sourceId)] = uses;
    granted.push({
      id: `${GRANTED_PREFIX}${sourceId}`,
      name: giver.name,
      activation:
        uses === undefined
          ? retypedAction
          : {
              ...retypedAction,
              cost: [...retypedAction.cost, { resource: grantedKey(sourceId) }],
            },
      spellLevel: null,
    });
  }
  const reaching = actions.flatMap((action) => {
    const attack = weaponAttackOf(action.activation.resolution);
    const { targeting } = action.activation;
    if (!attack || !("creatures" in targeting)) return [action];
    const ranges = actions.flatMap((item) => {
      const reach = item.activation.targeting;
      return weaponFits(item, attack.change, access) && "creatures" in reach
        ? [typeof reach.range === "number" ? reach.range : 5]
        : [];
    });
    // With no weapon to make it with, it can't be cast.
    if (ranges.length === 0) return [];
    return [
      {
        ...action,
        activation: {
          ...action.activation,
          targeting: { ...targeting, range: Math.max(...ranges) },
        },
      },
    ];
  });
  return actions === stats.actions &&
    granted.length === 0 &&
    reaching.length === actions.length &&
    reaching.every((action, index) => action === actions[index])
    ? stats
    : {
        ...stats,
        actions: [...reaching, ...granted],
        ...(Object.keys(resources).length > 0
          ? { resources: { ...stats.resources, ...resources } }
          : {}),
      };
}

// The pool of a `grantedAction` that allows only so many uses, as a Potion of Fire Breath's three exhales.
export const grantedKey = (sourceId: string): string => `granted:${sourceId}`;

// What gave a `grantedAction`: a spell's `granted` action, or a magic item's, as a Potion of Fire Breath's.
function grantedBy(
  sourceId: string,
  access: ContentAccess,
):
  | {
      readonly name: string;
      readonly activation: Activation;
      readonly spell?: Spell;
    }
  | undefined {
  // An item's, from using it up or from one of its activations, as a Staff of the Adder's snake head.
  const itemId = sourceId.startsWith(ITEM_PREFIX)
    ? sourceId.slice(ITEM_PREFIX.length)
    : itemUseOf(sourceId);
  if (itemId) {
    const item = lookup(access, ItemSchema, itemId);
    return "granted" in item && item.granted
      ? { name: item.name, activation: item.granted }
      : undefined;
  }
  const spell = lookup(access, SpellSchema, spellOfSource(sourceId) ?? "");
  return spell.granted
    ? { name: spell.name, activation: spell.granted, spell }
    : undefined;
}

// In usedThisTurn once Wish's copy of the spell has been cast.
export const wishedKey = (spell: string): string => `wished:${spell}`;

// The weapon attack as the spell makes it: its spellcasting ability, its die, its damage type and its extra damage.
// The caster picks the spell's type or the weapon's, whichever the target resists least.
function changedWeapon(
  action: KnownAction,
  change: WeaponChange,
  stats: Stats,
  access: ContentAccess,
): KnownAction | null {
  const { resolution } = action.activation;
  if (resolution.kind !== "attack" || !weaponFits(action, change, access)) {
    return null;
  }
  const [main, ...rest] = resolution.damage;
  if (!main) return null;
  const from = resolution.attack.ability;
  const ability =
    change.spellAbility && stats.spellAbility ? stats.spellAbility : from;
  const tier = cantripTier(stats.level);
  const die = change.dice?.[Math.min(tier, change.dice.length - 1)];
  const { bonus } = main.amount;
  const [count = 1, sides = 6] = (change.extra?.perTier ?? "1d6")
    .split("d")
    .map(Number);
  return {
    ...action,
    activation: {
      ...action.activation,
      resolution: {
        ...resolution,
        attack: { ...resolution.attack, ...(ability ? { ability } : {}) },
        damage: [
          {
            type: change.type ?? main.type,
            ...(change.type && change.type !== main.type
              ? { types: [change.type, main.type] }
              : {}),
            amount: {
              ...main.amount,
              ...(die ? { dice: die } : {}),
              ...(bonus
                ? {
                    bonus: {
                      ...bonus,
                      add: bonus.add.map((term) =>
                        term.kind === "abilityMod" &&
                        term.ability === from &&
                        ability
                          ? { ...term, ability }
                          : term,
                      ),
                    },
                  }
                : {}),
            },
          },
          ...rest,
          ...(change.extra && tier > 0
            ? [
                {
                  amount: { dice: `${String(count * tier)}d${String(sides)}` },
                  type: change.extra.type,
                },
              ]
            : []),
        ],
      },
    },
  };
}
