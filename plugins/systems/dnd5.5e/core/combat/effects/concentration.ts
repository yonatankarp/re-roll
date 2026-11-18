import { type Actor, frame } from "../../state.ts";
import { type Frame } from "#sdk";
import { concentrationDc } from "../../rules.ts";

// Concentration saves against damage.

// `breaker` gives the save Disadvantage, as damage from a Mage Slayer does.
export function concentrationFrame(
  target: Actor,
  amount: number,
  breaker = false,
): readonly Frame[] {
  return target.concentratingOn !== null && amount > 0
    ? [
        frame("concentrationSave", {
          actor: target.id,
          dc: concentrationDc(amount),
          ...(breaker ? { disadvantage: true } : {}),
        }),
      ]
    : [];
}
