import { isClassOption, runClassOption } from "../class-options.ts";
import { type Context, enemies } from "../combat.ts";
import { leafEvents, tacticRiderEvents } from "../combat/effects.ts";
import { heightOf } from "../combat/falling.ts";
import {
  COLLECT,
  collectable,
  collectEvents,
  escapedEvents,
  escapeFrom,
  SHAKE,
  shakeEvents,
} from "../combat/fear.ts";
import { escapeDc, grapplesOn } from "../combat/grapple.ts";
import { parseOption } from "../combat/ids.ts";
import { mountEvents } from "../combat/mounts.ts";
import { opportunity, provokers } from "../combat/movement.ts";
import { hasPassive } from "../combat/queries.ts";
import { reactFrames } from "../combat/reactions.ts";
import { attacksLeft, STRIKE, strikesLeft, TRADE } from "../combat/trade.ts";
import {
  type ActiveEffect,
  type Actor,
  dndEvent,
  frame,
  NS,
} from "../state.ts";
import { checkBonus, deriveStats } from "../stats.ts";
import {
  bonusDashFeet,
  HEW_USED,
  lightAttackEvents,
  masteryOf,
  POLE_STRUCK,
  tacticsOf,
  walkSpeed,
} from "../tactics.ts";
import { discernEvent, zonesOf } from "../zones.ts";
import { lightCrossbow, twoWeaponStyle } from "./bonus-attacks.ts";
import { abilityCheck, keenSpent, sharpEye } from "./checks.ts";
import { capitalized, dyingNow, effect } from "./common.ts";
import { betterSave, pushEvents, reportedSave, saveDc } from "./contests.ts";
import { hideEvents } from "./hide.ts";
import {
  BONUS_DASH,
  BONUS_DISENGAGE,
  BONUS_DODGE,
  BONUS_HELP,
  BONUS_HIDE,
  BONUS_SEARCH,
  BONUS_STUDY,
  BREAK_OUT,
  CHECK_END,
  DASH,
  DISENGAGE,
  DODGE,
  ESCAPE,
  GRAPPLE,
  HELP,
  HEW,
  HIDE,
  HIDE_DC,
  NICK_USED,
  OFFHAND,
  OFFHAND_USED,
  POLE_STRIKE,
  READY,
  RISE,
  SEARCH,
  SHOVE,
  SINK,
  SLIP,
  STABILIZE_DC,
  STAND,
  STUDY,
  STUDY_DC,
  STUDY_IMAGE,
  STUDY_PHANTASM,
} from "./ids.ts";
import { bonusTacticCost, dashBonus, halfSpeed } from "./options.ts";
import { lore, studySkill, subtle } from "./study.ts";
import { type Frame, type SystemEvent, type SystemResult } from "#sdk";

export function runTactic(
  payload: { readonly actor: string; readonly answer: string },
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = state.actors[payload.actor];
  if (!actor) throw new Error(`Unknown actor ${payload.actor}`);
  if (isClassOption(payload.answer)) return runClassOption(payload, context);
  const [kind = "", targetId = "", detail = ""] = parseOption(payload.answer);
  const target = state.actors[targetId];
  const stats = deriveStats(actor, context);
  const spend = (budget: "action" | "bonusAction"): SystemEvent =>
    dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: budget });
  // An action, or the Bonus Action and whatever a passive charges for it, as Observant's Quick Search.
  const actionOrBonus = (
    action: boolean,
    tactic: "search" | "study",
  ): SystemEvent[] =>
    action
      ? [spend("action")]
      : [
          spend("bonusAction"),
          ...(bonusTacticCost(actor, stats, tactic) ?? []),
        ];
  const self = (
    tactic: "dash" | "disengage" | "dodge" | "ready",
    action?: string,
  ): SystemEvent =>
    effect(
      actor.id,
      kind,
      actor.id,
      { kind: "tactic", tactic, ...(action ? { action } : {}) },
      "casterNextTurn",
    );
  const done: Frame[] = [CHECK_END, frame("afterAction", { actor: actor.id })];
  const needTarget = (): Actor => {
    if (!target) throw new Error(`${payload.answer} has no target`);
    return target;
  };
  // Ensnaring Strike's vines: `by`'s check frees `held` on a success.
  const escapeCheck = (
    by: Actor,
    freed: Actor,
    held: ActiveEffect,
  ): SystemEvent[] => {
    const { escape } = held;
    if (!escape) return [];
    if (escape.free) return escapedEvents(freed, held);
    const rolled = abilityCheck(
      by,
      escape.skill,
      escape.ability,
      escape.dc,
      (success) =>
        success ? `${by.name} frees ${freed.name}` : `${freed.name} stays held`,
      context,
    );
    return [
      ...rolled.events,
      ...(rolled.success ? escapedEvents(freed, held) : []),
    ];
  };

  const mounted = mountEvents(actor, kind, targetId, state, context);
  if (mounted) return { events: mounted };
  switch (kind) {
    case SHAKE: {
      const target = needTarget();
      const held = escapeFrom(target);
      return {
        events: [
          spend("action"),
          ...(held ? escapeCheck(actor, target, held) : shakeEvents(target)),
        ],
        frames: done,
      };
    }
    case COLLECT: {
      const held = collectable(actor).find(
        (item) => item.sourceId === detail && item.casterId === targetId,
      );
      if (!held) throw new Error(`${actor.id} has nothing to collect from`);
      return {
        events: [
          spend("action"),
          ...(held.escape
            ? escapeCheck(actor, actor, held)
            : collectEvents(actor, held, context)),
        ],
        frames: done,
      };
    }
    case SLIP:
      return {
        events: [
          dndEvent(`${NS}:effectEnded`, {
            actor: actor.id,
            sourceId: detail,
            casterId: targetId,
          }),
          ...(actor.position
            ? [
                dndEvent(`${NS}:moved`, {
                  actor: actor.id,
                  to: actor.position,
                  feet: 5,
                }),
              ]
            : []),
        ],
      };
    // Straight up or down out of a foe's reach provokes it, as any move of the creature's own does.
    case RISE:
    case SINK: {
      const step = {
        mode: targetId === "climb" ? ("climb" as const) : ("fly" as const),
        up: kind === RISE,
      };
      const answers = actor.position
        ? provokers(
            actor,
            actor.position,
            state,
            context,
            [actor.position],
            heightOf(actor) + (step.up ? 10 : -10),
          ).map(({ foe, melee }) => opportunity(foe, melee, actor, context))
        : [];
      return {
        events: answers.flatMap((answer) => answer.events ?? []),
        frames: [
          ...answers.flatMap((answer) => answer.frames ?? []),
          frame("changeHeight", { actor: actor.id, ...step }),
        ],
      };
    }
    case STAND:
      return {
        events: [
          dndEvent(`${NS}:conditionRemoved`, {
            actor: actor.id,
            condition: "prone",
          }),
          ...(actor.position
            ? [
                dndEvent(`${NS}:moved`, {
                  actor: actor.id,
                  to: actor.position,
                  feet: hasPassive(stats, "quickStand") ? 5 : halfSpeed(stats),
                }),
              ]
            : []),
        ],
      };
    // Dash and Disengage are for moving, so the turn goes on for it.
    case DASH: {
      const extra = dashBonus(stats);
      return {
        events: [
          spend("action"),
          extra > 0
            ? effect(
                actor.id,
                kind,
                actor.id,
                {
                  kind: "tactic",
                  tactic: "dash",
                  value: walkSpeed(actor, stats) + extra,
                },
                "casterNextTurn",
              )
            : self("dash"),
          ...tacticRiderEvents(actor, stats, "dash"),
        ],
      };
    }
    case DISENGAGE:
      return {
        events: [
          spend("action"),
          self("disengage"),
          ...tacticRiderEvents(actor, stats, "disengage"),
        ],
      };
    case BONUS_DASH: {
      const feet = bonusDashFeet(actor, stats) + dashBonus(stats);
      return {
        events: [
          spend("bonusAction"),
          ...(bonusTacticCost(actor, stats, "dash") ?? []),
          effect(
            actor.id,
            kind,
            actor.id,
            {
              kind: "tactic",
              tactic: "dash",
              ...(feet === walkSpeed(actor, stats) ? {} : { value: feet }),
            },
            "casterNextTurn",
          ),
          // A Tactical Charge moves without provoking Opportunity Attacks.
          ...(stats.passives.some(
            (passive) => passive.kind === "bonusTactics" && passive.safe,
          )
            ? [self("disengage")]
            : []),
          ...tacticRiderEvents(actor, stats, "dash"),
        ],
      };
    }
    case BONUS_DISENGAGE:
      return {
        events: [
          spend("bonusAction"),
          ...(bonusTacticCost(actor, stats, "disengage") ?? []),
          self("disengage"),
          ...tacticRiderEvents(actor, stats, "disengage"),
        ],
      };
    case BONUS_DODGE:
      return {
        events: [
          spend("bonusAction"),
          ...(bonusTacticCost(actor, stats, "dodge") ?? []),
          self("dodge"),
        ],
      };
    case DODGE:
      return {
        events: [
          spend("action"),
          self("dodge"),
          ...(hasPassive(stats, "dodgeHeal")
            ? leafEvents(
                [
                  {
                    kind: "hitDieHeal",
                    bonus: {
                      base: 0,
                      add: [{ kind: "abilityMod", ability: "con" }],
                    },
                  },
                ],
                kind,
                actor,
                actor,
                context,
              )
            : []),
        ],
        frames: done,
      };
    case READY:
      return {
        events: [
          spend("action"),
          self("ready", targetId),
          ...(hasPassive(stats, "vigilant")
            ? [
                effect(
                  actor.id,
                  "vigilant",
                  actor.id,
                  { kind: "disadvantage", on: "attacksAgainst", once: true },
                  "casterNextTurn",
                ),
              ]
            : []),
        ],
        frames: done,
      };
    case HIDE:
    case BONUS_HIDE: {
      return {
        events: [
          spend(kind === HIDE ? "action" : "bonusAction"),
          ...(kind === HIDE
            ? []
            : (bonusTacticCost(actor, stats, "hide") ?? [])),
          ...hideEvents(actor, context),
        ],
        frames: done,
      };
    }
    case SEARCH:
    case BONUS_SEARCH: {
      // A Perception check finds every hidden foe whose Stealth total it matches. One that's harder to perceive, as a
      // Cloak of Elvenkind's wearer, is looked for with a roll of its own, at Disadvantage.
      const hidden = enemies(state, actor).flatMap((foe) => {
        const [mark] = tacticsOf(foe, "hidden");
        return mark
          ? [
              {
                foe,
                dc: mark.value ?? HIDE_DC,
                cloaked: hasPassive(
                  deriveStats(foe, context),
                  "perceivedDisadvantage",
                ),
              },
            ]
          : [];
      });
      const lowest = Math.min(HIDE_DC, ...hidden.map(({ dc }) => dc));
      const keen = sharpEye(actor, stats);
      const look = (dc: number, cloaked: boolean) =>
        abilityCheck(
          actor,
          "perception",
          "wis",
          dc,
          () => "perception",
          context,
          keen !== null,
          undefined,
          cloaked,
        );
      const plain = hidden.filter(({ cloaked }) => !cloaked);
      const rolled = look(
        plain.length > 0 ? Math.min(...plain.map(({ dc }) => dc)) : lowest,
        plain.length === 0 && hidden.length > 0,
      );
      const cloaked = hidden.filter((item) => item.cloaked);
      const second =
        plain.length > 0 && cloaked.length > 0
          ? look(Math.min(...cloaked.map(({ dc }) => dc)), true)
          : null;
      const found = hidden.flatMap(({ foe, dc, cloaked: hard }) =>
        (hard && second ? second.total : rolled.total) >= dc
          ? [
              dndEvent(`${NS}:effectEnded`, {
                actor: foe.id,
                sourceId: HIDE,
              }),
            ]
          : [],
      );
      return {
        events: [
          ...actionOrBonus(kind === SEARCH, "search"),
          ...rolled.events,
          ...(second?.events ?? []),
          ...keenSpent(actor, keen, rolled.success),
          ...found,
        ],
        frames: done,
      };
    }
    case STUDY_IMAGE: {
      const zone = zonesOf(state).find(
        (item) => item.owner === targetId && item.sourceId === detail,
      );
      if (!zone) throw new Error(`${actor.id} has nothing there to study`);
      const rolled = abilityCheck(
        actor,
        "investigation",
        "int",
        zone.dc ?? 10,
        (success) =>
          success ? "investigation (an illusion)" : "investigation",
        context,
        false,
        undefined,
        subtle(zone.owner, state, context),
      );
      return {
        events: [
          spend("action"),
          ...rolled.events,
          ...(rolled.success ? [discernEvent(actor, zone)] : []),
        ],
        frames: done,
      };
    }
    case STUDY_PHANTASM: {
      const phantasm = actor.activeEffects.find(
        (item) =>
          item.sourceId === detail &&
          item.casterId === targetId &&
          item.studyDc !== undefined,
      );
      if (!phantasm) throw new Error(`${actor.id} sees no phantasm`);
      const rolled = abilityCheck(
        actor,
        "investigation",
        "int",
        phantasm.studyDc ?? 10,
        (success) => (success ? "investigation (a phantasm)" : "investigation"),
        context,
        false,
        undefined,
        subtle(phantasm.casterId, state, context),
      );
      return {
        events: [
          spend("action"),
          ...rolled.events,
          ...(rolled.success
            ? [
                dndEvent(`${NS}:effectEnded`, {
                  actor: actor.id,
                  sourceId: phantasm.sourceId,
                  casterId: phantasm.casterId,
                }),
              ]
            : []),
        ],
        frames: done,
      };
    }
    case STUDY:
    case BONUS_STUDY: {
      // shortcut: what's learned is only reported, as nothing else in the rules reads it.
      const studied = needTarget();
      const skill = studySkill(studied, context);
      const keen = sharpEye(actor, stats);
      const rolled = abilityCheck(
        actor,
        skill,
        "int",
        STUDY_DC,
        (success) =>
          success
            ? `${skill} (${studied.name}: ${lore(studied, context)})`
            : skill,
        context,
        keen !== null,
      );
      // A disguise is seen through with Investigation against its DC.
      const guise = studied.activeEffects.find(
        ({ modifier }) => modifier.kind === "disguise",
      );
      const unmasked =
        guise?.modifier.kind === "disguise" && studied.side !== actor.side
          ? abilityCheck(
              actor,
              "investigation",
              "int",
              guise.modifier.dc ?? 10,
              (success) =>
                success
                  ? `investigation (${studied.name} is disguised)`
                  : "investigation",
              context,
            ).events
          : [];
      return {
        events: [
          ...actionOrBonus(kind === STUDY, "study"),
          ...rolled.events,
          ...unmasked,
          ...keenSpent(actor, keen, rolled.success),
        ],
        frames: [
          ...reactFrames({ kind: "studied", actor: actor.id }, context),
          ...done,
        ],
      };
    }
    case HELP:
    case BONUS_HELP: {
      const helped = needTarget();
      const paid =
        kind === HELP
          ? [spend("action")]
          : [
              spend("bonusAction"),
              ...(bonusTacticCost(actor, stats, "help") ?? []),
            ];
      // Tag Team: trading places with a willing ally beside it, which provokes nothing.
      const partner = detail ? state.actors[detail] : undefined;
      const swapped =
        partner?.position && actor.position
          ? [
              dndEvent(`${NS}:moved`, {
                actor: actor.id,
                to: partner.position,
                feet: 0,
              }),
              dndEvent(`${NS}:moved`, {
                actor: partner.id,
                to: actor.position,
                feet: 0,
              }),
            ]
          : [];
      // On a dying creature, a Wisdom (Medicine) check to make it Stable.
      if (helped.side === actor.side && dyingNow(helped)) {
        const rolled = abilityCheck(
          actor,
          "medicine",
          "wis",
          STABILIZE_DC,
          () => "medicine",
          context,
        );
        // Understanding of Death: Heroic Inspiration for the help, once a Long Rest.
        const own = deriveStats(actor, context);
        const inspired = own.passives.find(
          (passive) =>
            passive.kind === "stabilizeInspiration" &&
            (actor.resourcesSpent[passive.resource] ?? 0) <
              (own.resources[passive.resource] ?? 0),
        );
        return {
          events: [
            ...paid,
            ...swapped,
            ...rolled.events,
            ...(rolled.success
              ? [dndEvent(`${NS}:stabilized`, { actor: helped.id })]
              : []),
            ...(inspired?.kind === "stabilizeInspiration" &&
            !actor.heroicInspiration
              ? [
                  dndEvent(`${NS}:resourceSpent`, {
                    actor: actor.id,
                    resource: inspired.resource,
                  }),
                  dndEvent(`${NS}:inspirationGranted`, { actor: actor.id }),
                ]
              : []),
          ],
          frames: done,
        };
      }
      // On a foe, the next attack against it before your next turn has Advantage; on an ally, its next check.
      // shortcut: your own attack could use the Advantage on the foe too, though only an ally should.
      const modifier =
        helped.side === actor.side
          ? ({ kind: "advantage", on: "checks" } as const)
          : ({ kind: "advantage", on: "attacksAgainst", once: true } as const);
      // Harper Teamwork's Withering Wordplay: the foe's next save has Disadvantage too.
      const withering =
        helped.side !== actor.side && hasPassive(stats, "helpRider")
          ? [
              effect(
                helped.id,
                `${HELP}:saves`,
                actor.id,
                { kind: "disadvantage", on: "saves", once: true },
                "casterNextTurn",
              ),
            ]
          : [];
      return {
        events: [
          ...paid,
          ...swapped,
          effect(helped.id, HELP, actor.id, modifier, "casterNextTurn"),
          ...withering,
        ],
        frames: done,
      };
    }
    case GRAPPLE: {
      // The grappled creature escapes with its action; combat/grapple.ts ends the grapple on its own.
      const held = needTarget();
      const dc = saveDc(stats, "str");
      const ability = betterSave(held, context);
      const save = reportedSave(held, ability, dc, "Grapple", context);
      return {
        events: [
          spend("action"),
          ...save.events,
          ...(save.saved
            ? []
            : [
                effect(
                  held.id,
                  GRAPPLE,
                  actor.id,
                  { kind: "condition", condition: "grappled" },
                  "spellDuration",
                ),
              ]),
        ],
        frames: done,
      };
    }
    case BREAK_OUT: {
      const seal = actor.activeEffects.find(
        (item) => item.sourceId === detail && item.casterId === targetId,
      );
      if (seal?.modifier.kind !== "sealed") {
        throw new Error(`${actor.id} isn't sealed away by ${targetId}`);
      }
      // Etherealness ends at will.
      if (!seal.modifier.escape) {
        if (!seal.modifier.leave) throw new Error(`${actor.id} can't leave`);
        return {
          events: [
            spend("action"),
            dndEvent(`${NS}:effectEnded`, {
              actor: actor.id,
              sourceId: seal.sourceId,
              casterId: seal.casterId,
            }),
          ],
          frames: done,
        };
      }
      const { ability, dc, skill } = seal.modifier.escape;
      const rolled = abilityCheck(
        actor,
        skill,
        ability,
        dc,
        () => `Escape (${capitalized(skill)})`,
        context,
      );
      return {
        events: [
          spend("action"),
          ...rolled.events,
          ...(rolled.success
            ? [
                dndEvent(`${NS}:effectEnded`, {
                  actor: actor.id,
                  sourceId: seal.sourceId,
                  casterId: seal.casterId,
                }),
              ]
            : []),
        ],
        frames: done,
      };
    }
    case ESCAPE: {
      // An Athletics or Acrobatics check, whichever is better, against the grapple's escape DC.
      const grapple = grapplesOn(actor).find(
        (item) => item.sourceId === detail && item.casterId === targetId,
      );
      if (!grapple) throw new Error(`${actor.id} isn't held by ${targetId}`);
      const athletics =
        checkBonus(stats, actor, { ability: "str", skill: "athletics" }) >=
        checkBonus(stats, actor, { ability: "dex", skill: "acrobatics" });
      const rolled = abilityCheck(
        actor,
        athletics ? "athletics" : "acrobatics",
        athletics ? "str" : "dex",
        escapeDc(grapple, state, context),
        () => `Escape (${athletics ? "Athletics" : "Acrobatics"})`,
        context,
        hasPassive(stats, "powerfulBuild") ||
          hasPassive(stats, "escapeAdvantage"),
      );
      return {
        events: [
          spend("action"),
          ...rolled.events,
          ...(rolled.success
            ? [
                dndEvent(`${NS}:effectEnded`, {
                  actor: actor.id,
                  sourceId: grapple.sourceId,
                  casterId: grapple.casterId,
                }),
              ]
            : []),
        ],
        frames: done,
      };
    }
    case SHOVE: {
      const shoved = needTarget();
      const save = reportedSave(
        shoved,
        betterSave(shoved, context),
        saveDc(stats, "str"),
        "Shove",
        context,
      );
      const result = save.saved
        ? []
        : detail === "prone"
          ? [
              effect(
                shoved.id,
                SHOVE,
                actor.id,
                { kind: "condition", condition: "prone" },
                "spellDuration",
              ),
            ]
          : pushEvents(actor, shoved, 5, context);
      return {
        events: [spend("action"), ...save.events, ...result],
        frames: done,
      };
    }
    case OFFHAND: {
      const nick =
        masteryOf(actor, detail, context) === "nick" &&
        !actor.usedThisTurn.includes(NICK_USED);
      return {
        events: [
          nick
            ? dndEvent(`${NS}:oncePerTurnUsed`, {
                actor: actor.id,
                key: NICK_USED,
              })
            : spend("bonusAction"),
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: actor.id,
            key: OFFHAND_USED,
          }),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
            ...(twoWeaponStyle(actor) || lightCrossbow(actor, detail, context)
              ? {}
              : { noModifier: true }),
          }),
          ...done,
        ],
      };
    }
    case TRADE:
      return {
        events: [
          effect(
            actor.id,
            TRADE,
            actor.id,
            { kind: "tactic", tactic: "trading", value: Number(detail) },
            "casterTurnEnd",
          ),
        ],
      };
    case STRIKE: {
      const left = attacksLeft(actor);
      return {
        events: [
          dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId: STRIKE }),
          ...(left > 1 ? [strikesLeft(actor, left - 1)] : []),
          ...lightAttackEvents(actor, detail, context),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
          }),
          ...done,
        ],
      };
    }
    case HEW:
      return {
        events: [
          spend("bonusAction"),
          dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key: HEW_USED }),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
          }),
          ...done,
        ],
      };
    case POLE_STRIKE:
      return {
        events: [
          spend("bonusAction"),
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: actor.id,
            key: POLE_STRUCK,
          }),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
            poleStrike: true,
          }),
          ...done,
        ],
      };
    default:
      throw new Error(`Unknown action ${payload.answer}`);
  }
}
