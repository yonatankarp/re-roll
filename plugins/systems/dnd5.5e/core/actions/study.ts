import { distanceFeet } from "../grid.ts";
import { type Skill } from "../schemas.ts";
import { type Actor, type DndState } from "../state.ts";
import { damageResponses, deriveStats } from "../stats.ts";
import { believes, zonesOf } from "../zones.ts";
import { type ContentAccess } from "#sdk";

const STUDY_SKILLS: Readonly<Record<string, Skill>> = {
  aberration: "arcana",
  construct: "arcana",
  dragon: "arcana",
  elemental: "arcana",
  fey: "arcana",
  monstrosity: "arcana",
  beast: "nature",
  ooze: "nature",
  plant: "nature",
  celestial: "religion",
  fiend: "religion",
  undead: "religion",
};

export function studySkill(target: Actor, access: ContentAccess): Skill {
  return (
    STUDY_SKILLS[deriveStats(target, access).creatureType ?? ""] ?? "history"
  );
}

// What studying a creature tells you: its AC and how it takes damage.
export function lore(target: Actor, access: ContentAccess): string {
  const { resistances, immunities, vulnerabilities } = damageResponses(
    target,
    access,
  );
  return [
    `AC ${String(deriveStats(target, access).ac)}`,
    ...(vulnerabilities.length > 0
      ? [`weak to ${vulnerabilities.join(", ")}`]
      : []),
    ...(resistances.length > 0 ? [`resists ${resistances.join(", ")}`] : []),
    ...(immunities.length > 0 ? [`immune to ${immunities.join(", ")}`] : []),
  ].join(", ");
}

// The illusions within 60 feet a creature hasn't seen through, which it can study.
export function studyableImages(actor: Actor, state: DndState) {
  return zonesOf(state).filter(
    (zone) =>
      zone.zone === "image" &&
      zone.owner !== actor.id &&
      distanceFeet(actor.position, zone.at) <= STUDY_REACH &&
      (zone.decoy
        ? !discernsZone(actor, zone)
        : believes(zone, state, actor.id)),
  );
}

const STUDY_REACH = 60;

const discernsZone = (
  actor: Actor,
  zone: ReturnType<typeof zonesOf>[number],
): boolean =>
  actor.activeEffects.some(
    ({ modifier }) =>
      modifier.kind === "discerned" &&
      modifier.source === zone.sourceId &&
      modifier.caster === zone.owner,
  );

// Illusion Adept: checks to see through its maker's illusions have Disadvantage.
export function subtle(
  maker: string,
  state: DndState,
  access: ContentAccess,
): boolean {
  const owner = state.actors[maker];
  return (
    owner !== undefined &&
    deriveStats(owner, access).passives.some(
      (passive) => passive.kind === "subtleIllusions",
    )
  );
}
