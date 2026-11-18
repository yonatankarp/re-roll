import { z } from "zod";
import { concentrationBonus } from "../school.ts";
import { dndEvent, isDown, NS } from "../../state.ts";
import { spellOfSource } from "../ids.ts";
import { type SystemResult } from "#sdk";
import { reactFrames } from "../reactions.ts";
import { deriveStats, passiveModifiers } from "../../stats.ts";
import { SpellSchema } from "../../schemas.ts";
import { rescuedSave } from "../../trait-rules.ts";
import { actorOf, type Context } from "../queries.ts";
import { rollSave } from "../effects.ts";

export const ConcentrationSchema = z.object({
  actor: z.string(),
  dc: z.number(),
  disadvantage: z.boolean().optional(), // from a Mage Slayer's damage
});

export function runConcentrationSave(
  payload: z.infer<typeof ConcentrationSchema>,
  context: Context,
): SystemResult {
  const actor = actorOf(context.state, payload.actor);
  if (actor.concentratingOn === null) return {};
  // Boon of the Iron Mind: damage alone never breaks the bearer's Concentration.
  const held = actor.concentratingOn
    .replace(/^spell:/, "")
    .replace(/:free$/, "");
  const school = SpellSchema.safeParse(
    context.content(spellOfSource(actor.concentratingOn) ?? held),
  ).data?.school;
  if (
    !isDown(actor) &&
    deriveStats(actor, context).passives.some(
      (passive) =>
        passive.kind === "unshakableFocus" &&
        (!passive.spells || passive.spells.includes(held)) &&
        (!passive.schools ||
          (school !== undefined && passive.schools.includes(school))),
    )
  ) {
    return {};
  }
  // Being down ends Concentration outright, as does any failed save.
  const save = isDown(actor)
    ? null
    : rollSave(
        actor,
        "con",
        payload.dc - concentrationBonus(actor, context),
        context,
        false,
        0,
        ["concentration"],
        payload.disadvantage === true ||
          // An eerie chanting zone hampers Concentration (environment.ts).
          passiveModifiers(deriveStats(actor, context).passives).some(
            (modifier) =>
              modifier.kind === "disadvantage" &&
              modifier.on === "saves" &&
              modifier.concentration === true,
          ),
      );
  // A Ring of Dedicated Focus: Hit Point Dice added to a failed save.
  const rescued =
    save && !save.saved
      ? rescuedSave(
          actor,
          "con",
          ["concentration"],
          deriveStats(actor, context),
          save.events,
          [],
          context.dice,
          false,
          { access: context },
        )
      : [];
  const rolled = [...(save?.events ?? []), ...rescued];
  // A reaction to the save, as with Warp Mind.
  const watched = save
    ? reactFrames({ kind: "concentrationSave", actor: actor.id }, context)
    : [];
  if (!save?.saved && rescued.length === 0) {
    return {
      events: [
        ...rolled,
        dndEvent(`${NS}:concentrationEnded`, { actor: actor.id }),
      ],
      frames: watched,
    };
  }
  return { events: rolled, frames: watched };
}
