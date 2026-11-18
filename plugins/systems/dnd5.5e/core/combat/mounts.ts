import type { ContentAccess, SystemEvent } from "#sdk";
import { TACTIC } from "../tactics.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  isDown,
  mountOf,
  NS,
} from "../state.ts";
import { deriveStats, type Stats } from "../stats.ts";
import { distanceFeet } from "../grid.ts";
import { encodeOption } from "./ids.ts";
import { allies, hasPassive, ridden, sizeOf, speedLeft } from "./queries.ts";
import { teleportSquares } from "./movement.ts";

// Mounted combat. A creature mounts a willing ally at least one size larger that can be ridden, within 5 feet, for
// half its Speed, and gets off again into an open square beside it for the same. While it rides, the mount is
// controlled: it moves where its rider walks, with its own Speed, on its rider's turn and with no turn of its own,
// and may take only the Dash, Disengage or Dodge action. Riding is an effect on the rider, so it ends with the fight.

export const MOUNT = `${TACTIC}mount`;
export const DISMOUNT = `${TACTIC}dismount`;
export const STEED = `${TACTIC}steed`; // the mount's own action, as "steed|dash"
export const MOUNTED = "mounted"; // the riding effect's source
const STEED_ACTIONS = ["dash", "disengage", "dodge"] as const;

function halfOf(stats: Stats): number {
  // Born to the Saddle: only 5 feet.
  if (stats.passives.some(({ kind }) => kind === "quickMount")) return 5;
  return Math.ceil(stats.speed / 10) * 5;
}

export function mountOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): { id: string; label: string }[] {
  if (!actor.position) return [];
  const stats = deriveStats(actor, access);
  const half = halfOf(stats);
  const mount = ridden(actor, state);
  if (mount) {
    const off =
      speedLeft(actor, stats) >= half &&
      teleportSquares(mount, 5, 0, state, access).length > 0
        ? [
            {
              id: DISMOUNT,
              label: `Dismount (${String(half)} ft of movement)`,
            },
          ]
        : [];
    const own = mount.budget.action
      ? STEED_ACTIONS.map((tactic) => ({
          id: encodeOption(STEED, tactic),
          label: `${mount.name}: ${tactic.charAt(0).toUpperCase()}${tactic.slice(1)}`,
        }))
      : [];
    return [...off, ...own];
  }
  if (mountOf(actor) || speedLeft(actor, stats) < half) return [];
  const size = sizeOf(actor, access);
  return allies(state, actor)
    .filter(
      (item) =>
        item.id !== actor.id &&
        !isDown(item) &&
        distanceFeet(actor.position, item.position) <= 5 &&
        hasPassive(deriveStats(item, access), "rideable") &&
        sizeOf(item, access) > size &&
        !Object.values(state.actors).some(
          (other) => mountOf(other) === item.id,
        ),
    )
    .map((item) => ({
      id: encodeOption(MOUNT, item.id),
      label: `Mount ${item.name} (${String(half)} ft of movement)`,
    }));
}

// The events of a mounted-combat option, or null for another option.
export function mountEvents(
  actor: Actor,
  kind: string,
  detail: string,
  state: DndState,
  access: ContentAccess,
): SystemEvent[] | null {
  const half = halfOf(deriveStats(actor, access));
  if (kind === MOUNT) {
    const mount = state.actors[detail];
    if (!mount?.position) return [];
    return [
      dndEvent(`${NS}:effectAdded`, {
        actor: actor.id,
        effect: {
          sourceId: MOUNTED,
          casterId: mount.id,
          modifier: { kind: "riding" },
          ends: "spellDuration",
        },
      }),
      dndEvent(`${NS}:moved`, {
        actor: actor.id,
        to: mount.position,
        feet: half,
      }),
    ];
  }
  const mount = ridden(actor, state);
  if (kind === DISMOUNT) {
    const [to] = mount ? teleportSquares(mount, 5, 0, state, access) : [];
    if (!to) return [];
    return [
      dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId: MOUNTED }),
      dndEvent(`${NS}:moved`, { actor: actor.id, to, feet: half }),
    ];
  }
  if (kind === STEED) {
    const tactic = STEED_ACTIONS.find((item) => item === detail);
    if (!mount || !tactic) return [];
    // It lasts until the rider's next turn, when the mount's turn comes again.
    return [
      dndEvent(`${NS}:budgetSpent`, { actor: mount.id, kind: "action" }),
      dndEvent(`${NS}:effectAdded`, {
        actor: mount.id,
        effect: {
          sourceId: `${TACTIC}${tactic}`,
          casterId: actor.id,
          modifier: { kind: "tactic", tactic },
          ends: "casterNextTurn",
        },
      }),
    ];
  }
  return null;
}
