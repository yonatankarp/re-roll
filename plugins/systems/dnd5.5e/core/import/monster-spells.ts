import type { Activation, Spell } from "../schemas.ts";
import { SpellSchema } from "../schemas.ts";
import { doesSomething } from "../stats.ts";
import { slugOf } from "./spells.ts";

// A monster's spells become ordinary actions with its own numbers, so play needs nothing a stat block doesn't have.
export type SpellLookup = (name: string) => Spell | undefined;

// Of several printings of a spell, the first that can be played wins, in the order the content is loaded.
export function spellLookup(
  knownIds: readonly string[] | undefined,
  contentOf: ((id: string) => unknown) | undefined,
): SpellLookup | undefined {
  if (!knownIds || !contentOf) return undefined;
  const ids = new Map<string, string[]>();
  for (const id of knownIds) {
    const slug = /:spell\/(.+)$/.exec(id)?.[1];
    if (slug) ids.set(slug, [...(ids.get(slug) ?? []), id]);
  }
  return (name) => {
    const spells = (ids.get(slugOf(name)) ?? []).flatMap((id) => {
      const spell = SpellSchema.safeParse(contentOf(id)).data;
      return spell ? [spell] : [];
    });
    return spells.find((spell) => spell.activation) ?? spells[0];
  };
}

export interface Caster {
  readonly dc: number | null;
  readonly toHit: number | null;
  readonly mod: number | null; // null when the text names no ability, so the block's own Spellcasting decides
}

const ABILITY_NAMES = [
  "Strength",
  "Dexterity",
  "Constitution",
  "Intelligence",
  "Wisdom",
  "Charisma",
] as const;

// "using Wisdom as the spellcasting ability (spell save DC 13, +5 to hit with spell attacks)"
export function casterIn(
  text: string,
  scores: Readonly<Record<string, number | undefined>>,
  proficiency: number,
): Caster {
  // Older books say "its spellcasting ability is Intelligence".
  const names = ABILITY_NAMES.join("|");
  const ability = new RegExp(
    `\\b(${names}) as (?:the|its) spellcasting ability|spellcasting ability is (${names})`,
    "i",
  )
    .exec(text)
    ?.slice(1)
    .find(Boolean);
  const score = ability ? scores[ability.slice(0, 3).toLowerCase()] : undefined;
  const mod = score === undefined ? null : Math.floor((score - 10) / 2);
  const toHit = /([+−-]\d+) to hit with spell attacks/.exec(text)?.[1];
  const dc = /spell save DC (\d+)/i.exec(text)?.[1];
  return {
    // A block that prints no DC has the usual one.
    dc: dc ? Number(dc) : mod === null ? null : 8 + proficiency + mod,
    toHit: toHit === undefined ? null : Number(toHit.replace("−", "-")),
    mod,
  };
}

export interface MonsterAction {
  readonly name: string;
  readonly recharge?: number;
  readonly perDay?: number;
  readonly activation: Activation;
}

export interface Use {
  readonly cost: readonly Activation["cost"][number][]; // the action it takes, or empty for the spell's own
  readonly perDay?: number;
  readonly resource?: string;
  readonly recharge?: number;
}

type Json = unknown;

// The spell's formulas use a caster's spell numbers, and a monster has its printed ones instead.
function withNumbers(value: Json, dc: number, mod: number): Json {
  if (Array.isArray(value))
    return value.map((item) => withNumbers(item, dc, mod));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, Json>;
  if (Array.isArray(object.add)) {
    const terms = object.add as { readonly kind: string }[];
    const base = terms.reduce(
      (sum, term) =>
        sum +
        (term.kind === "spellSaveDc" ? dc : term.kind === "spellMod" ? mod : 0),
      typeof object.base === "number" ? object.base : 0,
    );
    return {
      ...object,
      base,
      add: terms.filter(
        (term) => term.kind !== "spellSaveDc" && term.kind !== "spellMod",
      ),
    };
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      withNumbers(item, dc, mod),
    ]),
  );
}

const moreDice = (dice: string, step: string, times: number): string | null => {
  const [count = "", size] = dice.split("d");
  const [stepCount = "", stepSize] = step.split("d");
  return size === stepSize
    ? `${String(Number(count) + Number(stepCount) * times)}d${size ?? ""}`
    : null;
};

// "Fireball (level 5 version)": the spell as if cast with a higher slot, where its upcast says how.
function upcast(
  spell: Spell,
  activation: Activation,
  level: number,
): Activation | null {
  const times = level - spell.level;
  const step = spell.upcast?.perSlotLevel;
  if (times <= 0) return activation;
  if (!step) return null;
  if ("addTargets" in step) {
    const { targeting } = activation;
    return "creatures" in targeting
      ? {
          ...activation,
          targeting: {
            ...targeting,
            creatures: targeting.creatures + step.addTargets * times,
          },
        }
      : null;
  }
  const { resolution } = activation;
  const [first, ...rest] = "damage" in resolution ? resolution.damage : [];
  if (first?.amount.dice) {
    const dice = moreDice(first.amount.dice, step.addDice, times);
    return dice
      ? {
          ...activation,
          resolution: {
            ...resolution,
            damage: [{ ...first, amount: { ...first.amount, dice } }, ...rest],
          },
        }
      : null;
  }
  if (resolution.kind !== "automatic") return null;
  const [heal, ...others] = resolution.effects;
  const dice =
    heal?.kind === "heal" && heal.amount.dice
      ? moreDice(heal.amount.dice, step.addDice, times)
      : null;
  return heal?.kind === "heal" && dice
    ? {
        ...activation,
        resolution: {
          ...resolution,
          effects: [{ ...heal, amount: { ...heal.amount, dice } }, ...others],
        },
      }
    : null;
}

// One spell as a monster action, or null with a note when it can't be played.
function spellAction(
  item: string,
  use: Use,
  caster: Caster,
  spells: SpellLookup,
  notes: string[],
): MonsterAction | null {
  const [, raw = "", aside = ""] =
    /^\s*(.+?)\s*(?:\(([^)]*)\))?[\s*†]*$/.exec(item) ?? [];
  const name = raw.replace(/^the\s+/i, "").replace(/\s+spell$/i, "");
  // Mage Armor already counts in the printed AC, and a spell cast before the fight is already running.
  if (!name || /included in AC|before combat/i.test(aside)) return null;
  const spell = spells(name);
  const activation = spell?.activation;
  if (!spell || !activation) return null;
  const level = Number(
    /\blevel (\d) version\b/i.exec(aside)?.[1] ?? spell.level,
  );
  const cost = activation.cost.filter((item) => item !== "slot");
  if (
    activation.trigger ||
    cost.includes("reaction") ||
    !doesSomething(activation.resolution)
  ) {
    return null;
  }
  // A higher level the spell's data can't express is cast at its own level.
  const higher = upcast(spell, activation, level);
  if (!higher) notes.push(`partial: ${spell.name}: left out its higher level`);
  const scaled = higher ?? activation;
  const mod = caster.mod ?? 0;
  const dc = caster.dc ?? 8 + mod;
  const numbered = withNumbers(scaled, dc, mod) as Activation;
  const { resolution } = numbered;
  return {
    name: spell.name,
    ...(use.recharge ? { recharge: use.recharge } : {}),
    ...(use.perDay ? { perDay: use.perDay } : {}),
    activation: {
      ...numbered,
      cost: [
        ...(use.cost.length > 0 ? use.cost : cost),
        ...(use.resource ? [{ resource: use.resource }] : []),
      ],
      resolution:
        resolution.kind === "attack"
          ? {
              ...resolution,
              attack: { type: "spell", flatBonus: caster.toHit ?? dc - 8 },
            }
          : resolution,
    },
  };
}

// Commas inside "(level 7 version)" or "(self only)" don't separate spells.
const namesIn = (list: string): string[] =>
  list
    .replace(/\.\s*$/, "")
    .split(/,(?![^(]*\))|\s+or\s+(?![^(]*\))/)
    .map((item) => item.trim())
    .filter(Boolean);

// Some books run one list into the next with no break, as in "…, Prestidigitation2/Day Each: …".
const LIST =
  /(?:\b|(?<=[a-z)]))(At Will|Cantrips \(at will\)|(\d+)\/Day(?: Each)?|(\d)(?:st|nd|rd|th)[- ]level \((\d+) slots?\))\s*:\s*/gi;

// A Spellcasting entry: "At Will: …", "2/Day Each: …", or an older "1st level (4 slots): …", in one paragraph
// or one per line. An older slot is shared by every spell of its level.
export function spellcastingActions(
  text: string,
  cost: Use["cost"],
  caster: Caster,
  spells: SpellLookup,
  notes: string[],
): MonsterAction[] {
  const labels = [...text.matchAll(LIST)];
  return labels.flatMap((label, index) => {
    const list = text.slice(
      label.index + label[0].length,
      labels[index + 1]?.index ?? text.length,
    );
    const [, , perDay, slotLevel, slots] = label;
    const each = /each/i.test(label[1] ?? "");
    return namesIn(list).flatMap((item) => {
      const name = item.replace(/\s*\(.*$/, "");
      const use: Use = perDay
        ? {
            cost,
            perDay: Number(perDay),
            resource: `day:${each ? slugOf(name) : `spells-${perDay}`}`,
          }
        : slots
          ? {
              cost,
              perDay: Number(slots),
              resource: `day:level-${slotLevel ?? ""}-slots`,
            }
          : { cost };
      const action = spellAction(item, use, caster, spells, notes);
      return action ? [action] : [];
    });
  });
}

// "The priest casts Bless, Dispel Magic, or Healing Word, using …": each spell is an option of the same action.
export function castActions(
  text: string,
  use: Use,
  caster: Caster,
  spells: SpellLookup,
  notes: string[],
): MonsterAction[] {
  const [, list = ""] =
    /\bcasts (.+?)(?:,? (?:using|requiring|with|on|targeting|twice|at)\b|\.(?:\s|$)|$)/.exec(
      text,
    ) ?? [];
  const { recharge: first, ...shared } = use;
  let recharge = first; // options share one recharge, so only the first rolls for it
  return namesIn(list).flatMap((item) => {
    const action = spellAction(
      item,
      { ...shared, ...(recharge ? { recharge } : {}) },
      caster,
      spells,
      notes,
    );
    if (!action) return [];
    recharge = undefined;
    return [action];
  });
}
