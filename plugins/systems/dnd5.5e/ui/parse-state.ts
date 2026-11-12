import { type DndState, StateSchema } from "../core/state.ts";

// Every describer, cue and roll looks at the same state after an event, and states are never
// changed in place, so each is parsed once.
const parsed = new WeakMap<object, DndState>();

export function parseState(raw: unknown): DndState {
  if (typeof raw !== "object" || raw === null) return StateSchema.parse(raw);
  let state = parsed.get(raw);
  if (!state) {
    state = StateSchema.parse(raw);
    parsed.set(raw, state);
  }
  return state;
}
