import {
  type ContentAccess,
  type Decision,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { z } from "zod";
import { weaponProficient } from "../core/character.ts";
import { meleeReachOf, moveSquares, provokers } from "../core/combat.ts";
import { HIT_DICE, parseOption } from "../core/combat/ids.ts";
import { OFFHAND, isTactic } from "../core/actions.ts";
import { carriedWeight, carryingCapacity } from "../core/carry.ts";
import { foundText } from "../core/gear.ts";
import { coverBonus, coverFor } from "../core/sight.ts";
import { coins } from "../core/shop.ts";
import { shop } from "./shop.ts";
import { creation } from "./creation.ts";
import { legendOf, resistancesLeft } from "../core/legendary.ts";
import type { BoardExtra } from "./board-data.ts";
import { dndCue } from "./cues.ts";
import {
  ABILITIES,
  ABILITY_NAMES,
  type Amount,
  type CharacterBuild,
  ClassSchema,
  type Damage,
  ItemSchema,
  LootSchema,
  SKILL_ABILITIES,
  type Skill,
  SpeciesSchema,
} from "../core/schemas.ts";
import {
  type Actor,
  type DndState,
  EVENT_SCHEMAS,
  MAX_ATTUNED,
  equipped,
  isDead,
  isDown,
  isStable,
} from "../core/state.ts";
import { parseState } from "./parse-state.ts";
import {
  type KnownAction,
  type Stats,
  attackBonus,
  checkBonus,
  deriveStats,
  evaluateFormula,
  modifierFor,
  saveBonus,
  scaledDice,
  spellModifier,
  spellSaveDc,
} from "../core/stats.ts";
import {
  HIDE_SOURCE,
  TACTIC_WORDS,
  tacticSourceName,
} from "../core/tactics.ts";

const NamedSchema = z.object({ name: z.string() });
const TextSchema = z.object({ name: z.string(), text: z.string() });
const HitDieSchema = z.object({ hitDie: z.string() });

function contentText(access: ContentAccess, id: string) {
  const parsed = TextSchema.safeParse(access.content(id));
  return parsed.success ? parsed.data : null;
}

function amountText(amount: Amount, stats: Stats): string {
  const dice = scaledDice(amount, stats.scaling);
  const bonus = amount.bonus ? evaluateFormula(amount.bonus, stats) : 0;
  if (!dice) return String(bonus);
  return bonus === 0 ? dice : `${dice}${signed(bonus)}`;
}

function damageText(damage: readonly Damage[], stats: Stats): string {
  return damage
    .map((item) => `${amountText(item.amount, stats)} ${item.type}`)
    .join(" plus ");
}

// shortcut: flat numbers only, leaving out dice bonuses such as Bless and upcast dice.
function actionNumbers(action: KnownAction, stats: Stats): string {
  const { resolution } = action.activation;
  switch (resolution.kind) {
    case "attack": {
      const bonus = attackBonus(resolution, stats);
      return `${signed(bonus)} to hit, ${damageText(resolution.damage, stats)} damage on a hit.`;
    }
    case "save": {
      const dc =
        action.spellLevel === null
          ? evaluateFormula(resolution.dc, stats)
          : spellSaveDc(stats);
      const hurt =
        resolution.damage.length > 0
          ? `, ${damageText(resolution.damage, stats)} damage on a failure${resolution.onSuccessDamage === "half" ? ", half on a success" : ""}`
          : "";
      return `DC ${String(dc)} ${resolution.ability.toUpperCase()} save${hurt}.`;
    }
    case "automatic":
      return resolution.damage.length > 0
        ? `${damageText(resolution.damage, stats)} damage, no roll.`
        : "No roll needed.";
  }
}

function actionDetail(
  action: KnownAction,
  stats: Stats,
  access: ContentAccess,
): string {
  const source = contentText(access, action.id.replace(/^[a-z]+:/, ""));
  const upcast = action.upcast?.perSlotLevel;
  return [
    actionNumbers(action, stats),
    upcast
      ? `Each slot level above ${String(action.spellLevel)} adds ${"addDice" in upcast ? `${upcast.addDice} damage` : `${String(upcast.addTargets)} target${upcast.addTargets > 1 ? "s" : ""}`}.`
      : "",
    source?.text ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// What each of the actions anyone can take does, shown under its option.
const TACTIC_DETAILS: Readonly<Record<string, string>> = {
  dash: "Gain extra movement equal to your Speed for the rest of this turn.",
  disengage:
    "Your movement doesn't provoke Opportunity Attacks for the rest of this turn.",
  dodge:
    "Until your next turn, attacks against you have Disadvantage and you have Advantage on Dexterity saving throws.",
  hide: "A Stealth check against DC 15. On a success you're Invisible until you attack, cast a spell or a foe finds you.",
  search:
    "A Perception check. Each hidden foe whose Stealth total it matches is found.",
  study:
    "A check to recall what you know about a creature. On a DC 15 success you learn its AC and what damage it resists.",
  help: "On a foe beside you, the next attack against it before your next turn has Advantage. On an ally, their next check has Advantage.",
  grapple:
    "An Unarmed Strike. The target makes a Strength or Dexterity saving throw, and on a failure it's Grappled, with Speed 0, until it escapes.",
  shove:
    "An Unarmed Strike. The target makes a Strength or Dexterity saving throw, and on a failure it's pushed 5 feet away or knocked Prone.",
  ready:
    "Hold an attack. When a foe steps into your reach before your next turn, you attack it with your Reaction.",
  stand: "Standing up from Prone costs half your Speed.",
  offhand:
    "The extra attack of a second Light weapon, as a Bonus Action. It doesn't add your ability modifier to the damage.",
};

function tacticDetail(optionId: string): string | null {
  const kind = parseOption(optionId)[0]?.split(":")[1] ?? "";
  return TACTIC_DETAILS[kind] ?? null;
}

function groupOf(action: KnownAction | undefined): string {
  if (!action) return "Other";
  if (action.id.startsWith("item:")) return "Items";
  if (action.spellLevel === 0) return "Cantrips";
  if (action.spellLevel !== null) {
    return `Level ${String(action.spellLevel)} spells`;
  }
  return action.activation.resolution.kind === "attack" ? "Attacks" : "Other";
}

function optionGroups(
  decision: Decision,
  rawState: unknown,
  access: ContentAccess,
) {
  const state = parseState(rawState);
  const actor = state.actors[decision.actor];
  const plain = [
    {
      title: null,
      options: decision.options.map((option) => ({ ...option, detail: null })),
    },
  ];
  if (!state.combat || !actor) return plain;
  if (actor.source.kind === "character" && !actor.source.build) return plain;
  const stats = deriveStats(actor, access);
  const known = (id: string) =>
    stats.actions.find((item) => item.id === parseOption(id)[0]);
  if (!decision.options.some((option) => known(option.id))) return plain;
  // Only a full turn is grouped. A quick question, such as whether to cast Shield, stays a plain list.
  if (!decision.id.startsWith("dnd5.5e:turn:")) {
    return [
      {
        title: null,
        options: decision.options.map((option) => {
          const action = known(option.id);
          return {
            ...option,
            detail: action ? actionDetail(action, stats, access) : null,
          };
        }),
      },
    ];
  }
  const groups = new Map<
    string,
    { id: string; label: string; detail: string | null }[]
  >();
  for (const option of decision.options) {
    const action = known(option.id);
    // Dodge, Grapple and the rest have a tab of their own, and an off-hand attack goes with the attacks.
    const title = option.id.startsWith(OFFHAND)
      ? "Attacks"
      : isTactic(option.id)
        ? "Actions"
        : groupOf(action);
    groups.set(title, [
      ...(groups.get(title) ?? []),
      {
        ...option,
        detail: action
          ? actionDetail(action, stats, access)
          : tacticDetail(option.id),
      },
    ]);
  }
  const rank = (title: string): number =>
    title === "Attacks" ? 0 : title === "Other" ? 2 : 1;
  return [...groups]
    .map(([title, options]) => ({ title, options }))
    .sort(
      (a, b) =>
        rank(a.title) - rank(b.title) ||
        (a.title === "Cantrips"
          ? -1
          : b.title === "Cantrips"
            ? 1
            : a.title.localeCompare(b.title)),
    );
}

function actorOf(event: SystemEvent, rawState: unknown): string | null {
  // A fight starting or someone falling belongs to nobody in particular.
  if (!("payload" in event)) return null;
  const state = parseState(rawState);
  const reported =
    event.kind === "dnd5.5e:rollReported" && "payload" in event
      ? EVENT_SCHEMAS["dnd5.5e:rollReported"].parse(event.payload).actor
      : null;
  const id = reported ?? state.combat?.order[state.combat.index];
  return id ? (state.actors[id]?.name ?? null) : null;
}

// The names a token picture can be found by, best first: a monster's own name, or a character's
// species and class together, then each alone.
function looksOf(actor: Actor, access: ContentAccess): readonly string[] {
  const { source } = actor;
  if (source.kind === "monster") {
    return [nameOf(access, source.statBlockId), actor.name];
  }
  const build = source.build;
  const classId = build?.levels[0]?.classId;
  if (!build || !classId) return [];
  const species = nameOf(access, build.speciesId);
  const className = nameOf(access, classId);
  return [`${species} ${className}`, species, className];
}

function nameOf(access: ContentAccess, id: string): string {
  return NamedSchema.safeParse(access.content(id)).data?.name ?? id;
}

// "sleightOfHand" becomes "Sleight of Hand".
function skillName(skill: string): string {
  const spaced = skill.replace(/([A-Z])/g, " $1").replace(" Of ", " of ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function hitDiceLeft(player: Actor, access: ContentAccess): string {
  const levels =
    player.source.kind === "character"
      ? (player.source.build?.levels ?? [])
      : [];
  const spent = player.resourcesSpent[HIT_DICE] ?? 0;
  // Dice are spent in level order, as core/rest.ts does.
  const dice = new Map<string, number>();
  for (const level of levels.slice(spent)) {
    const die = HitDieSchema.safeParse(access.content(level.classId)).data
      ?.hitDie;
    if (die) dice.set(die, (dice.get(die) ?? 0) + 1);
  }
  return (
    [...dice].map(([die, count]) => `${String(count)}${die}`).join(" + ") ||
    "none"
  );
}

function pips(left: number, max: number): string {
  return "●".repeat(Math.max(0, left)) + "○".repeat(Math.max(0, max - left));
}

// The short numbers for an action, next to its name.
function actionSummary(action: KnownAction, stats: Stats): string {
  const { resolution } = action.activation;
  switch (resolution.kind) {
    case "attack":
      return [
        signed(attackBonus(resolution, stats)),
        damageText(resolution.damage, stats),
      ]
        .filter(Boolean)
        .join(", ");
    case "save":
      return `DC ${String(
        action.spellLevel === null
          ? evaluateFormula(resolution.dc, stats)
          : spellSaveDc(stats),
      )} ${resolution.ability.toUpperCase()}`;
    case "automatic":
      return damageText(resolution.damage, stats);
  }
}

// Effects and concentration store ids such as "spell:srd52:spell/bless", which also name the content.
function sourceName(access: ContentAccess, source: string): string {
  const tactic = tacticSourceName(source);
  if (tactic) return tactic;
  const id = source.replace(/^(spell|feature):/, "").replace(/:\d+$/, "");
  const named = NamedSchema.safeParse(access.content(id));
  return named.success ? named.data.name : "an effect";
}

// Hiding reads as hidden rather than the Invisible condition it gives.
function conditionsOf(actor: Actor): string[] {
  return [
    ...new Set(
      actor.activeEffects.flatMap(({ modifier, sourceId }) => {
        if (modifier.kind === "tactic") return [TACTIC_WORDS[modifier.tactic]];
        return modifier.kind === "condition" && sourceId !== HIDE_SOURCE
          ? [modifier.condition]
          : [];
      }),
    ),
  ];
}

function statusOf(actor: Actor): string | null {
  if (isDead(actor)) return "dead";
  if (isStable(actor)) return "stable";
  return isDown(actor) ? "dying" : null;
}

function signed(value: number): string {
  return value < 0 ? String(value) : `+${String(value)}`;
}

const GEAR_HINT = "Change gear during a rest";

// Whether any of the character's classes trains them with it, or for a scroll, whether they cast spells.
// shortcut: a multiclass character counts every class's training, not the narrower multiclass list.
function canUse(
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

// The player first, then the companions; none until the player has chosen a character.
// What the character carries, with a way to change it whenever the pending choice allows, such as on a rest.
// Only the player changes gear, so a companion's rows have no buttons at all.
function equipmentRows(
  actor: Actor,
  gold: number | null,
  stats: Stats,
  access: ContentAccess,
  capacity: number,
) {
  const worn = equipped(actor);
  const attuned = actor.attuned ?? [];
  const changes = actor.id === PLAYER_ACTOR;
  const items = [...new Set(actor.inventory)].flatMap((id) => {
    const parsed = ItemSchema.safeParse(access.content(id));
    if (!parsed.success) return [];
    const item = parsed.data;
    const count = actor.inventory.filter((other) => other === id).length;
    const wornCount = worn.filter((other) => other === id).length;
    const label =
      (count > 1 ? `${item.name} ×${String(count)}` : item.name) +
      (canUse(item, stats, access) ? "" : " (can't use)");
    const detail = "text" in item && item.text ? { detail: item.text } : {};
    if (
      item.type === "weapon" ||
      item.type === "armor" ||
      item.type === "shield"
    ) {
      return [
        {
          label,
          value: wornCount === 0 ? "In pack" : "Equipped",
          ...(changes
            ? {
                option:
                  wornCount < count
                    ? { id: `equip:${id}`, label: "Equip", hint: GEAR_HINT }
                    : { id: `stow:${id}`, label: "Stow", hint: GEAR_HINT },
              }
            : {}),
          ...detail,
        },
      ];
    }
    if (item.type === "magicItem" && item.attunement) {
      const on = attuned.includes(id);
      return [
        {
          label,
          value: on ? "Attuned" : "Not attuned",
          ...(changes
            ? {
                option: on
                  ? {
                      id: `unattune:${id}`,
                      label: "End attunement",
                      hint: GEAR_HINT,
                    }
                  : {
                      id: `attune:${id}`,
                      label: "Attune",
                      hint:
                        attuned.length < MAX_ATTUNED
                          ? GEAR_HINT
                          : `Already attuned to ${String(MAX_ATTUNED)} items`,
                    },
              }
            : {}),
          ...detail,
        },
      ];
    }
    return [{ label, value: "", ...detail }];
  });
  return [
    ...(gold === null ? [] : [{ label: "Gold", value: coins(gold) }]),
    carryRow(carriedWeight(actor, access), capacity),
    ...(attuned.length > 0 ||
    actor.inventory.some((id) => {
      const parsed = ItemSchema.safeParse(access.content(id));
      return (
        parsed.success &&
        parsed.data.type === "magicItem" &&
        parsed.data.attunement
      );
    })
      ? [
          {
            label: "Attunement",
            value: `${String(attuned.length)} of ${String(MAX_ATTUNED)}`,
          },
        ]
      : []),
    ...items,
  ];
}

// The weight carried against what Strength allows, and what going over does to Speed.
function carryRow(carried: number, capacity: number) {
  const pounds = (weight: number): string =>
    String(Math.round(weight * 10) / 10);
  return {
    label: "Carrying",
    value: `${pounds(carried)} of ${pounds(capacity)} lb`,
    ...(carried > capacity * 2
      ? { note: "Too heavy to move" }
      : carried > capacity
        ? { note: "Over capacity: Speed 5 feet" }
        : {}),
  };
}

function sheets(rawState: unknown, access: ContentAccess) {
  const { actors, gold } = parseState(rawState);
  const player = actors[PLAYER_ACTOR];
  if (player?.source.kind !== "character" || !player.source.build) return [];
  return [
    player,
    ...Object.values(actors).filter((actor) => actor.id !== PLAYER_ACTOR),
  ].flatMap((actor) =>
    actor.side === "party" &&
    actor.source.kind === "character" &&
    actor.source.build
      ? [
          sheetOf(
            actor,
            actor.source.build,
            access,
            actor.id === PLAYER_ACTOR ? (gold ?? 0) : null,
          ),
        ]
      : [],
  );
}

function sheetOf(
  player: Actor,
  build: CharacterBuild,
  access: ContentAccess,
  gold: number | null, // the party's, shown on the player's sheet
) {
  const stats = deriveStats(player, access);
  const subclasses = build.levels
    .flatMap((level) => level.answers)
    .flatMap((answer) => (answer.kind === "subclass" ? answer.values : []))
    .map((id) => nameOf(access, id));
  const classes = Object.entries(stats.classLevels)
    .map(([id, level]) => `${nameOf(access, id)} ${String(level)}`)
    .join(" / ");
  const effects = [
    ...new Set(
      player.activeEffects
        .filter(
          ({ modifier }) =>
            modifier.kind !== "condition" && modifier.kind !== "tactic",
        )
        .map(({ sourceId }) => sourceName(access, sourceId)),
    ),
  ];
  const status = statusOf(player);
  const perception =
    10 + checkBonus(stats, player, { ability: "wis", skill: "perception" });
  const spells = stats.actions.filter((action) => action.spellLevel !== null);
  const actionRow = (action: KnownAction) => ({
    label: action.name,
    value: actionSummary(action, stats),
    detail: actionDetail(action, stats, access),
  });
  return {
    id: player.id,
    title: player.name,
    level: stats.level,
    kind: `${nameOf(access, build.speciesId)} ${Object.keys(stats.classLevels)
      .map((id) => nameOf(access, id))
      .join(" / ")}`,
    subtitle: [
      `${nameOf(access, build.speciesId)} ${classes}`,
      ...(subclasses.length > 0 ? [subclasses.join(", ")] : []),
      nameOf(access, build.backgroundId),
      `Level ${String(stats.level)}, ${String(player.xp ?? 0)} XP`,
    ].join(" · "),
    summary: [
      {
        label: "HP",
        value: `${String(player.hp)}/${String(stats.maxHp)}`,
        meter: stats.maxHp > 0 ? player.hp / stats.maxHp : 0,
      },
      { label: "AC", value: String(stats.ac) },
    ],
    tags: [
      ...(status ? [status] : []),
      ...conditionsOf(player),
      ...(player.exhaustion > 0
        ? [`exhaustion ${String(player.exhaustion)}`]
        : []),
      ...(player.concentratingOn
        ? [`concentrating on ${sourceName(access, player.concentratingOn)}`]
        : []),
      ...effects,
    ],
    sections: [
      {
        title: "Combat",
        layout: "boxes" as const,
        pinned: true,
        rows: [
          { label: "Armor Class", value: String(stats.ac) },
          {
            label: "Hit Points",
            value: String(player.hp),
            note:
              `of ${String(stats.maxHp)}` +
              (player.tempHp > 0 ? `, +${String(player.tempHp)} temp` : ""),
          },
          { label: "Speed", value: String(stats.speed), note: "feet" },
          { label: "Initiative", value: signed(stats.initiative) },
          { label: "Proficiency", value: signed(stats.proficiency) },
          {
            label: "Hit Dice",
            value: hitDiceLeft(player, access),
            note: `of ${String(stats.level)}`,
          },
        ],
      },
      // Near the top, so what the party carries and its gold are found without scrolling.
      {
        title: "Equipment",
        rows: equipmentRows(
          player,
          gold,
          stats,
          access,
          carryingCapacity(
            stats.abilities.str,
            SpeciesSchema.parse(access.content(build.speciesId)).size,
          ),
        ),
      },
      {
        title: "Abilities",
        layout: "boxes" as const,
        pinned: true,
        rows: ABILITIES.map((ability) => ({
          label: ability.toUpperCase(),
          value: signed(modifierFor(stats, ability)),
          note: String(stats.abilities[ability]),
        })),
      },
      {
        title: "Saving throws",
        layout: "marks" as const,
        rows: ABILITIES.map((ability) => ({
          label: ABILITY_NAMES[ability],
          value: signed(saveBonus(stats, ability)),
          marked: stats.savingThrows.includes(ability),
        })),
      },
      {
        title: "Skills",
        layout: "marks" as const,
        rows: [
          ...Object.entries(SKILL_ABILITIES).map(([skill, ability]) => ({
            label: skillName(skill),
            value: signed(
              checkBonus(stats, player, { ability, skill: skill as Skill }),
            ),
            note: ability.toUpperCase(),
            marked: stats.skills.includes(skill as Skill),
          })),
        ],
      },
      {
        title: "Senses",
        rows: [{ label: "Passive Perception", value: String(perception) }],
      },
      {
        title: "Attacks and actions",
        pinned: true,
        rows: stats.actions
          .filter((action) => action.spellLevel === null)
          .map(actionRow),
      },
      {
        title: "Spellcasting",
        pinned: true,
        rows: stats.spellAbility
          ? [
              {
                label: "Ability",
                value: ABILITY_NAMES[stats.spellAbility],
              },
              { label: "Save DC", value: String(spellSaveDc(stats)) },
              {
                label: "Attack",
                value: signed(stats.proficiency + spellModifier(stats)),
              },
              ...stats.slots.flatMap((max, index) => {
                const level = String(index + 1);
                const spent = player.resourcesSpent[`slot:${level}`] ?? 0;
                return max > 0
                  ? [
                      {
                        label: `Level ${level} slots`,
                        value: pips(max - spent, max),
                      },
                    ]
                  : [];
              }),
            ]
          : [],
      },
      {
        title: "Cantrips",
        rows: spells.filter((action) => action.spellLevel === 0).map(actionRow),
      },
      {
        title: "Spells",
        rows: spells
          .filter((action) => (action.spellLevel ?? 0) > 0)
          .map((action) => ({
            ...actionRow(action),
            label: `${action.name} (${String(action.spellLevel)})`,
          })),
      },
      {
        title: "Features",
        rows: stats.features.flatMap((id) => {
          const feature = contentText(access, id);
          return feature
            ? [{ label: feature.name, value: "", detail: feature.text }]
            : [];
        }),
      },
    ],
  };
}

function combat(rawState: unknown, access: ContentAccess) {
  const state = parseState(rawState);
  if (!state.combat) return null;
  const { order, index, round } = state.combat;
  // Where the player can walk this turn, so the board can move them with one click.
  const player = state.actors[PLAYER_ACTOR];
  const moves =
    player && order[index] === PLAYER_ACTOR
      ? moveSquares(player, state, deriveStats(player, access)).map(
          ({ square, feet, path }) => ({
            ...square,
            feet,
            path: path.map(({ x, y }) => [x, y] as const),
            provokes: provokers(player, square, state, access).length,
          }),
        )
      : [];
  // How far each creature's melee reaches, for shading the squares it threatens.
  const reach = Object.fromEntries(
    order.flatMap((id) => {
      const actor = state.actors[id];
      const feet = actor && !isDown(actor) ? meleeReachOf(actor, access) : null;
      return feet === null ? [] : [[id, feet]];
    }),
  );
  // The cover each creature has against the player, for the shield shown while picking a target.
  const cover = Object.fromEntries(
    order.flatMap((id) => {
      const actor = state.actors[id];
      const bonus =
        player && actor && id !== PLAYER_ACTOR
          ? coverBonus(coverFor(state, player.position, actor, [PLAYER_ACTOR]))
          : 0;
      return bonus > 0 ? [[id, bonus]] : [];
    }),
  );
  // Each of the player's area actions, by id, so the board can outline where it lands with the rules' own geometry.
  const shapes = Object.fromEntries(
    player && order[index] === PLAYER_ACTOR
      ? deriveStats(player, access).actions.flatMap((action) => {
          const { targeting } = action.activation;
          return "area" in targeting ? [[action.id, targeting]] : [];
        })
      : [],
  );
  return {
    round,
    board: {
      moves,
      reach,
      shapes,
      cover,
      terrain: state.combat.terrain ?? null,
      map: state.combat.map ?? null,
    } satisfies BoardExtra,
    combatants: order.flatMap((id, position) => {
      const actor = state.actors[id];
      if (!actor) return [];
      return [
        {
          id,
          name: actor.name,
          side: actor.side === "party" ? "Ally" : "Enemy",
          active: position === index,
          hp: actor.hp,
          maxHp: deriveStats(actor, access).maxHp,
          tempHp: actor.tempHp,
          conditions: [
            ...conditionsOf(actor),
            ...(legendOf(actor, access).legendaryResistance
              ? [
                  `Legendary Resistance (${String(resistancesLeft(actor, access, state))} left)`,
                ]
              : []),
          ],
          concentration: actor.concentratingOn
            ? sourceName(access, actor.concentratingOn)
            : null,
          status: statusOf(actor),
          monster:
            actor.source.kind === "monster"
              ? (NamedSchema.safeParse(access.content(actor.source.statBlockId))
                  .data?.name ?? null)
              : null,
          looks: looksOf(actor, access),
        },
      ];
    }),
  };
}

function describeRoll(
  state: DndState,
  event: z.infer<(typeof EVENT_SCHEMAS)["dnd5.5e:rollReported"]>,
): string {
  const { actor, against, label, natural, total, target, success } = event;
  const rolled = `rolled ${String(natural)}, total ${String(total)}`;
  if (against === "check") {
    return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)} check: ${rolled} against DC ${String(target)}, ${success ? "success" : "failure"}.`;
  }
  const attacker = state.actors[actor]?.name ?? actor;
  const defender = state.actors[against]?.name ?? against;
  return `${attacker} uses ${label} on ${defender}: ${rolled} against AC ${String(target)}, ${success ? "hit" : "miss"}.`;
}

// "14 + 5 = 19 vs AC 15": the die, what was added, and what it had to reach.
function rollMath(natural: number, total: number, against: string): string {
  const bonus = total - natural;
  const added =
    bonus === 0
      ? String(natural)
      : `${String(natural)} ${bonus > 0 ? "+" : "−"} ${String(Math.abs(bonus))} = ${String(total)}`;
  return `${added} vs ${against}`;
}

// One line of the roll history, from the state just before the event.
function roll(
  event: SystemEvent,
  rawState: unknown,
): {
  readonly actor: string;
  readonly label: string;
  readonly math: string;
  readonly success: boolean | null;
} | null {
  if (!("payload" in event)) return null;
  const state = parseState(rawState);
  const name = (id: string): string => state.actors[id]?.name ?? id;
  switch (event.kind) {
    case "dnd5.5e:rollReported": {
      const data = EVENT_SCHEMAS["dnd5.5e:rollReported"].parse(event.payload);
      if (data.against === "check") {
        const what =
          data.label in ABILITY_NAMES
            ? ABILITY_NAMES[data.label as keyof typeof ABILITY_NAMES]
            : skillName(data.label);
        return {
          actor: name(data.actor),
          label: `${what} check`,
          math: rollMath(data.natural, data.total, `DC ${String(data.target)}`),
          success: data.success,
        };
      }
      // A natural 1 or 20 decides an attack whatever the total, so the line says why.
      const natural =
        data.natural === 20 || data.natural === 1
          ? `, natural ${String(data.natural)}`
          : "";
      return {
        actor: name(data.actor),
        label: `${data.label} → ${name(data.against)}`,
        math: `${rollMath(data.natural, data.total, `AC ${String(data.target)}`)}${natural}`,
        success: data.success,
      };
    }
    case "dnd5.5e:saveRolled": {
      const data = EVENT_SCHEMAS["dnd5.5e:saveRolled"].parse(event.payload);
      return {
        actor: name(data.actor),
        label: `${ABILITY_NAMES[data.ability]} save`,
        math: rollMath(data.natural, data.total, `DC ${String(data.dc)}`),
        success: data.success,
      };
    }
    case "dnd5.5e:deathSaveRolled": {
      const data = EVENT_SCHEMAS["dnd5.5e:deathSaveRolled"].parse(
        event.payload,
      );
      return {
        actor: name(data.actor),
        label: "Death save",
        math: `${String(data.natural)} vs 10`,
        success: data.natural >= 10,
      };
    }
    case "dnd5.5e:damaged": {
      const data = EVENT_SCHEMAS["dnd5.5e:damaged"].parse(event.payload);
      return {
        actor: name(data.actor),
        label: "Damage taken",
        math: `${String(data.amount)} ${data.type}${data.critical ? ", critical hit" : ""}`,
        success: null,
      };
    }
    default:
      return null;
  }
}

function describe(
  event: SystemEvent,
  rawState: unknown,
  access: ContentAccess,
): string | null {
  const state = parseState(rawState);
  const name = (id: string): string => state.actors[id]?.name ?? id;
  if (!("payload" in event)) {
    switch (event.kind) {
      case "encounterStarted":
        return "A fight breaks out!";
      case "encounterEnded":
        return event.outcome === "flee"
          ? "You get away."
          : event.outcome === "defeat"
            ? "The fight is lost."
            : "The fight is over.";
      case "clueRevealed":
        return event.text;
      case "actorDowned":
        return `${name(event.actor)} is down!`;
      case "actorDefeated":
        return `${name(event.actor)} is defeated.`;
      case "partyDefeated":
        return "The fight is lost.";
      // Told here rather than at characterAdvanced, so the shell can mark the engine's own event.
      case "levelGained": {
        const actor = state.actors[event.actor];
        const levels =
          actor?.source.kind === "character"
            ? (actor.source.build?.levels.length ?? null)
            : null;
        return `${name(event.actor)} reaches ${levels === null ? "a new level" : `level ${String(levels)}`}, with ${String(actor?.hp ?? 0)} HP.`;
      }
      default:
        return null;
    }
  }
  const { payload } = event;
  switch (event.kind) {
    case "dnd5.5e:characterChosen": {
      const { name: chosen, build } =
        EVENT_SCHEMAS["dnd5.5e:characterChosen"].parse(payload);
      const kind = `${nameOf(access, build.speciesId)} ${nameOf(access, build.levels[0]?.classId ?? "")}`;
      // A character named for what it is reads "the Human Fighter"; one with its own name says what it is.
      return chosen === kind
        ? `You are playing the ${chosen}.`
        : `You are playing ${chosen}, ${/^[AEIOU]/i.test(kind) ? "an" : "a"} ${kind}.`;
    }
    case "dnd5.5e:characterAdvanced":
      return null; // the levelGained after it says so
    case "dnd5.5e:xpAwarded": {
      const data = EVENT_SCHEMAS["dnd5.5e:xpAwarded"].parse(payload);
      return `The party earns ${String(data.amount)} XP.`;
    }
    case "dnd5.5e:rested": {
      const data = EVENT_SCHEMAS["dnd5.5e:rested"].parse(payload);
      return `${name(data.actor)} finishes a ${data.rest} rest.`;
    }
    case "dnd5.5e:rollReported":
      return describeRoll(
        state,
        EVENT_SCHEMAS["dnd5.5e:rollReported"].parse(payload),
      );
    case "dnd5.5e:resourceSpent": {
      // Spells that never roll have no other line saying who cast them.
      const data = EVENT_SCHEMAS["dnd5.5e:resourceSpent"].parse(payload);
      const slot = /^slot:(\d+)$/.exec(data.resource)?.[1];
      if (slot) return `${name(data.actor)} spends a level ${slot} spell slot.`;
      return data.resource === HIT_DICE
        ? `${name(data.actor)} spends a Hit Die.`
        : `${name(data.actor)} uses ${data.resource.replace(/[-_:]/g, " ")}.`;
    }
    case "dnd5.5e:damaged": {
      const data = EVENT_SCHEMAS["dnd5.5e:damaged"].parse(payload);
      return `${name(data.actor)} takes ${String(data.amount)} ${data.type} damage${data.critical ? " from a critical hit" : ""}.`;
    }
    case "dnd5.5e:healed": {
      const data = EVENT_SCHEMAS["dnd5.5e:healed"].parse(payload);
      return `${name(data.actor)} regains ${String(data.amount)} HP.`;
    }
    case "dnd5.5e:tempHpGained": {
      const data = EVENT_SCHEMAS["dnd5.5e:tempHpGained"].parse(payload);
      return `${name(data.actor)} gains ${String(data.amount)} temporary HP.`;
    }
    case "dnd5.5e:effectAdded": {
      const { actor, effect } =
        EVENT_SCHEMAS["dnd5.5e:effectAdded"].parse(payload);
      if (effect.modifier.kind === "tactic") {
        return `${name(actor)} is ${TACTIC_WORDS[effect.modifier.tactic]}.`;
      }
      if (effect.sourceId === HIDE_SOURCE) return null; // the hidden line says it
      return effect.modifier.kind === "condition"
        ? `${name(actor)} is ${effect.modifier.condition}.`
        : `${name(actor)} is affected by ${sourceName(access, effect.sourceId)}.`;
    }
    case "dnd5.5e:saveReported": {
      const data = EVENT_SCHEMAS["dnd5.5e:saveReported"].parse(payload);
      return `${name(data.actor)} ${data.success ? "resists" : "fails to resist"} ${data.label} (DC ${String(data.dc)} ${ABILITY_NAMES[data.ability]} save).`;
    }
    case "dnd5.5e:effectEnded": {
      const data = EVENT_SCHEMAS["dnd5.5e:effectEnded"].parse(payload);
      return `${sourceName(access, data.sourceId)} ends on ${name(data.actor)}.`;
    }
    case "dnd5.5e:conditionRemoved": {
      const data = EVENT_SCHEMAS["dnd5.5e:conditionRemoved"].parse(payload);
      return `${name(data.actor)} is no longer ${data.condition}.`;
    }
    case "dnd5.5e:concentrationStarted": {
      const data = EVENT_SCHEMAS["dnd5.5e:concentrationStarted"].parse(payload);
      return `${name(data.actor)} is concentrating on ${sourceName(access, data.spell)}.`;
    }
    case "dnd5.5e:concentrationEnded": {
      const data = EVENT_SCHEMAS["dnd5.5e:concentrationEnded"].parse(payload);
      return `${name(data.actor)} stops concentrating.`;
    }
    case "dnd5.5e:deathSaveRolled": {
      const data = EVENT_SCHEMAS["dnd5.5e:deathSaveRolled"].parse(payload);
      return `${name(data.actor)} rolls a death saving throw: ${String(data.natural)}.`;
    }
    case "dnd5.5e:inspirationGranted": {
      const data = EVENT_SCHEMAS["dnd5.5e:inspirationGranted"].parse(payload);
      return `${name(data.actor)} gains Heroic Inspiration.`;
    }
    case "dnd5.5e:treasureFound": {
      const data = EVENT_SCHEMAS["dnd5.5e:treasureFound"].parse(payload);
      const found = foundText(data, access);
      return found.length > 0 ? `Found: ${found.join(", ")}.` : null;
    }
    case "dnd5.5e:itemUsed": {
      const data = EVENT_SCHEMAS["dnd5.5e:itemUsed"].parse(payload);
      const item = ItemSchema.safeParse(access.content(data.item)).data;
      const scroll = item?.type === "magicItem" && item.category === "scroll";
      return `${name(data.actor)} uses ${nameOf(access, data.item)}${scroll ? ", and it crumbles to dust" : ""}.`;
    }
    case "dnd5.5e:traded": {
      const data = EVENT_SCHEMAS["dnd5.5e:traded"].parse(payload);
      return `${name(data.actor)} ${data.bought ? "buys" : "sells"} ${nameOf(access, data.item)} for ${coins(data.priceCp / 100)}.`;
    }
    case "dnd5.5e:gearChanged": {
      const data = EVENT_SCHEMAS["dnd5.5e:gearChanged"].parse(payload);
      return `${name(data.actor)} changes gear.`;
    }
    default:
      return null;
  }
}

// The moment treasure is found, shown as a card above its choices, with the purse it ends up in.
function card(decision: Decision, rawState: unknown, access: ContentAccess) {
  if (!decision.id.startsWith("dnd5.5e:found:")) return null;
  const found = LootSchema.safeParse(decision.resume.payload.found);
  return found.success
    ? {
        title: "Found",
        icon: "\u{1FA99}",
        lines: foundText(found.data, access),
        footer: `Purse: ${coins(parseState(rawState).gold ?? 0)}`,
      }
    : null;
}

function playerDied(rawState: unknown): boolean {
  const player = parseState(rawState).actors[PLAYER_ACTOR];
  return player !== undefined && isDead(player);
}

export const dndUi = {
  cue: dndCue,
  roll,
  systemId: "dnd5.5e",
  about: "Compatible with fifth edition.",
  sheets,
  combat,
  describe,
  actorOf,
  optionGroups,
  card,
  shop,
  creation,
  playerDied,
};
