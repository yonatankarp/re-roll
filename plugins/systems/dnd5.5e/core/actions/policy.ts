import { classOptionPolicy } from "../class-options.ts";
import {
  choosePolicy,
  type Context,
  MOVE,
  PASS,
  stepToward,
  within5,
} from "../combat.ts";
import { encodeOption, parseOption } from "../combat/ids.ts";
import { teleportSquares } from "../combat/movement.ts";
import { STRIKE, TRADE, tradeFits, tradesOf } from "../combat/trade.ts";
import { knownFoes } from "../fog.ts";
import { type Square, squareKey } from "../grid.ts";
import { moveOf, reachesFrom } from "../policy.ts";
import { type Actor, NS } from "../state.ts";
import { deriveStats } from "../stats.ts";
import { hasTactic } from "../tactics.ts";
import { dyingNow, standing } from "./common.ts";
import {
  BONUS_DASH,
  BONUS_HIDE,
  BREAK_OUT,
  DASH,
  DODGE,
  ESCAPE,
  HELP,
  HEW,
  OFFHAND,
  POLE_STRIKE,
  SEARCH,
  SLIP,
  STAND,
} from "./ids.ts";
import { isTactic } from "./options.ts";
import { type Decision, PLAYER_ACTOR } from "#sdk";

// Where a creature that spent its action on a Dash walks: toward the foe it means to fight next turn.
function dashTarget(actor: Actor, context: Context): Square | null {
  return stepToward(
    { ...actor, budget: { ...actor.budget, action: true } },
    context,
  );
}

// The system's tactics, with these actions: stand up first, escape a grapple that does more than hold, take
// the off-hand attack, walk on after a Dash, and spend an action that would otherwise go unused on an escape,
// a Search, a Dash toward the foe or a Dodge.
// Grapple, Shove, Help, Hide, Study and Ready are never picked: here each costs a whole action that an
// attack or spell uses better. Disengage would need a step away from foes, which stepToward never takes,
// so a Bonus Action Disengage is never picked either. A Bonus Action Dash or Hide is, as above.
export function tacticalPolicy(decision: Decision, context: Context): string {
  const mover = context.state.actors[decision.actor];
  if (
    decision.id.startsWith(`${NS}:moveTo:`) &&
    mover &&
    hasTactic(mover, "dash")
  ) {
    const square = dashTarget(mover, context);
    if (square) return squareKey(square);
  }
  const classOption = classOptionPolicy(decision, context);
  if (classOption !== null) return classOption;
  if (!decision.id.startsWith(`${NS}:turn:`)) {
    return choosePolicy(decision, context);
  }
  const ids = new Set(decision.options.map((option) => option.id));
  if (ids.has(STAND)) return STAND;
  const slip = decision.options.find((option) =>
    option.id.startsWith(encodeOption(SLIP, "")),
  );
  if (slip) return slip.id;
  // Shut in a Maze, getting out is all there is to do.
  const breakOut = decision.options.find((option) =>
    option.id.startsWith(encodeOption(BREAK_OUT, "")),
  );
  if (breakOut) return breakOut.id;
  const escapes = decision.options.filter((option) =>
    option.id.startsWith(encodeOption(ESCAPE, "")),
  );
  // Restrained, swallowed up or crushed each turn "until the grapple ends".
  const crushing = escapes.find(({ id }) => {
    const [, grappler, source] = parseOption(id);
    return mover?.activeEffects.some(
      ({ sourceId, casterId, modifier }) =>
        sourceId === source &&
        casterId === grappler &&
        (modifier.kind !== "condition" || modifier.condition !== "grappled"),
    );
  });
  if (crushing) return crushing.id;
  const chosen = choosePolicy(
    {
      ...decision,
      // Dodge stays, for the party to weigh against attacking (policy.ts).
      options: decision.options.filter(
        (option) => !isTactic(option.id) || option.id === DODGE,
      ),
    },
    context,
  );
  const { state } = context;
  const actor = state.actors[decision.actor];
  if (!actor) return chosen;
  // A dying friend in reach is stabilized with the Action, unless the choice already heals it or leaves the
  // Action free. The player's character first, since its death ends the run; a companion once it has failed a save.
  const [dying] = decision.options
    .flatMap((option) => {
      const [kind, id = ""] = parseOption(option.id);
      const who = state.actors[id];
      return kind === HELP && who && dyingNow(who) ? [{ option, who }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.who.id === PLAYER_ACTOR) - Number(a.who.id === PLAYER_ACTOR) ||
        b.who.deathSaves.failures - a.who.deathSaves.failures,
    );
  const [chosenId = "", chosenTarget] = parseOption(chosen);
  const chosenAction = deriveStats(actor, context).actions.find(
    (item) => item.id === chosenId,
  );
  if (
    dying &&
    chosenTarget !== dying.who.id &&
    (chosen === PASS ||
      chosen === MOVE ||
      chosenAction?.activation.cost.includes("action")) &&
    (dying.who.id === PLAYER_ACTOR ||
      dying.who.deathSaves.failures > 0 ||
      chosen === PASS)
  ) {
    return dying.option.id;
  }
  // A cantrip or Breath Weapon that can stand in for one of the Attack action's attacks is traded for it first,
  // which keeps the attacks it leaves.
  const trade = chosenAction
    ? decision.options.find((option) => {
        const [kind, , index = ""] = parseOption(option.id);
        const passive = tradesOf(deriveStats(actor, context))[Number(index)];
        return kind === TRADE && passive && tradeFits(passive, chosenAction);
      })
    : undefined;
  if (trade) return trade.id;
  // A teleport or Leap that lands in reach when walking won't get there.
  if (chosen === MOVE && actor.budget.action) {
    const step = stepToward(actor, context);
    const stats = deriveStats(actor, context);
    const leap =
      step && reachesFrom(actor, step, context)
        ? undefined
        : decision.options.find((option) => {
            const [id, target] = parseOption(option.id);
            const action = stats.actions.find((item) => item.id === id);
            const move = action && moveOf(action);
            return (
              target === actor.id &&
              move &&
              teleportSquares(
                actor,
                move.feet,
                move.movement,
                state,
                context,
              ).some((square) => reachesFrom(actor, square, context))
            );
          });
    if (leap) return leap.id;
  }
  // Cunning Action's Dash when walking alone won't bring a foe into reach this turn.
  if (chosen === MOVE && ids.has(BONUS_DASH) && actor.budget.action) {
    const step = stepToward(actor, context);
    if (!step || !reachesFrom(actor, step, context)) return BONUS_DASH;
  }
  if (chosen !== PASS) return chosen;
  if (ids.has(BONUS_HIDE)) return BONUS_HIDE;
  const offhand = decision.options
    .filter(
      (option) =>
        option.id.startsWith(encodeOption(STRIKE, "")) ||
        option.id.startsWith(encodeOption(OFFHAND, "")) ||
        option.id.startsWith(encodeOption(POLE_STRIKE, "")) ||
        option.id.startsWith(encodeOption(HEW, "")),
    )
    .sort(
      (a, b) =>
        (state.actors[parseOption(a.id)[1] ?? ""]?.hp ?? 0) -
        (state.actors[parseOption(b.id)[1] ?? ""]?.hp ?? 0),
    )[0];
  if (offhand) return offhand.id;
  if (hasTactic(actor, "dash") && ids.has(MOVE) && dashTarget(actor, context)) {
    return MOVE;
  }
  const foes = standing(knownFoes(state, actor, context));
  const [escape] = escapes;
  if (escape) return escape.id;
  if (ids.has(SEARCH)) return SEARCH;
  if (ids.has(DASH) && !ids.has(MOVE) && foes.length > 0) return DASH;
  if (ids.has(DODGE) && foes.some((foe) => within5(foe, actor))) return DODGE;
  return PASS;
}
