import {
  type ContentAccess,
  type Decision,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { z } from "zod";
import { dndCue } from "./cues.ts";
import {
  ABILITIES,
  type Amount,
  type Damage,
  SKILL_ABILITIES,
  type Skill,
} from "../core/schemas.ts";
import {
  type Actor,
  type DndState,
  EVENT_SCHEMAS,
  StateSchema,
  isDead,
  isDown,
  isStable,
} from "../core/state.ts";
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

const NamedSchema = z.object({ name: z.string() });
const TextSchema = z.object({ name: z.string(), text: z.string() });
const HitDieSchema = z.object({ hitDie: z.string() });
const HIT_DICE_RESOURCE = "hitDice"; // repeated from core/combat.ts, which ui code doesn't import

// The separator inside an option id, repeated from core/combat.ts, which doesn't export it.
const OPTION_SEPARATOR = "|";

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

function groupOf(action: KnownAction | undefined): string {
  if (!action) return "Other";
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
  const state = StateSchema.parse(rawState);
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
    stats.actions.find((item) => item.id === id.split(OPTION_SEPARATOR)[0]);
  // A reaction or a death save offers no group worth its own heading.
  if (!decision.options.some((option) => known(option.id))) return plain;
  const groups = new Map<
    string,
    { id: string; label: string; detail: string | null }[]
  >();
  for (const option of decision.options) {
    const action = known(option.id);
    const title = groupOf(action);
    groups.set(title, [
      ...(groups.get(title) ?? []),
      {
        ...option,
        detail: action ? actionDetail(action, stats, access) : null,
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
  const state = StateSchema.parse(rawState);
  const reported =
    event.kind === "dnd5.5e:rollReported" && "payload" in event
      ? EVENT_SCHEMAS["dnd5.5e:rollReported"].parse(event.payload).actor
      : null;
  const id = reported ?? state.combat?.order[state.combat.index];
  return id ? (state.actors[id]?.name ?? null) : null;
}

const ABILITY_NAMES = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
} as const;

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
  const spent = player.resourcesSpent[HIT_DICE_RESOURCE] ?? 0;
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
  const id = source.replace(/^(spell|feature):/, "").replace(/:\d+$/, "");
  const named = NamedSchema.safeParse(access.content(id));
  return named.success ? named.data.name : "an effect";
}

function conditionsOf(actor: Actor): string[] {
  return actor.activeEffects.flatMap(({ modifier }) =>
    modifier.kind === "condition" ? [modifier.condition] : [],
  );
}

function statusOf(actor: Actor): string | null {
  if (isDead(actor)) return "dead";
  if (isStable(actor)) return "stable";
  return isDown(actor) ? "dying" : null;
}

function signed(value: number): string {
  return value < 0 ? String(value) : `+${String(value)}`;
}

function sheet(rawState: unknown, access: ContentAccess) {
  const player = StateSchema.parse(rawState).actors[PLAYER_ACTOR];
  // There are no stats to show until the player has chosen a character.
  if (player?.source.kind !== "character" || !player.source.build) return null;
  const { build } = player.source;
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
        .filter(({ modifier }) => modifier.kind !== "condition")
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
    title: player.name,
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
  const state = StateSchema.parse(rawState);
  if (!state.combat) return null;
  const { order, index, round } = state.combat;
  return {
    round,
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
          conditions: conditionsOf(actor),
          concentration: actor.concentratingOn
            ? sourceName(access, actor.concentratingOn)
            : null,
          status: statusOf(actor),
          monster:
            actor.source.kind === "monster"
              ? (NamedSchema.safeParse(access.content(actor.source.statBlockId))
                  .data?.name ?? null)
              : null,
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

function describe(
  event: SystemEvent,
  rawState: unknown,
  access: ContentAccess,
): string | null {
  const state = StateSchema.parse(rawState);
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
      default:
        return null;
    }
  }
  const { payload } = event;
  switch (event.kind) {
    case "dnd5.5e:characterChosen": {
      const { name: chosen } =
        EVENT_SCHEMAS["dnd5.5e:characterChosen"].parse(payload);
      return `You are playing the ${chosen}.`;
    }
    case "dnd5.5e:characterAdvanced": {
      const data = EVENT_SCHEMAS["dnd5.5e:characterAdvanced"].parse(payload);
      return `${name(data.actor)} reaches a new level, with ${String(data.hp)} HP.`;
    }
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
      return data.resource === HIT_DICE_RESOURCE
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
      return effect.modifier.kind === "condition"
        ? `${name(actor)} is ${effect.modifier.condition}.`
        : `${name(actor)} is affected by ${sourceName(access, effect.sourceId)}.`;
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
    default:
      return null;
  }
}

function playerDied(rawState: unknown): boolean {
  const player = StateSchema.parse(rawState).actors[PLAYER_ACTOR];
  return player !== undefined && isDead(player);
}

export const dndUi = {
  cue: dndCue,
  systemId: "dnd5.5e",
  about: "Compatible with fifth edition.",
  sheet,
  combat,
  describe,
  actorOf,
  optionGroups,
  playerDied,
};
