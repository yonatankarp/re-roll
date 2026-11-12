import { type GameView } from "./session.ts";

export function endingOf(view: GameView): {
  readonly title: string;
  readonly text: string;
} | null {
  switch (view.ended) {
    case null:
      return null;
    case "ending":
      // The ending scene's own text is already on the page above this.
      return view.scene
        ? { title: view.endingName ?? "The end", text: "" }
        : {
            title: "Adventure complete",
            text: "You have reached the end of this story.",
          };
    case "deadEnd":
      return {
        title: "A dead end",
        text: "The story has no choices left to offer you.",
      };
    case "defeat":
      return view.playerDied
        ? {
            title: "You have died",
            text: "Your story ends here, whatever became of your companions.",
          }
        : {
            title: "Your party has fallen",
            text: "Nobody is left standing to carry on.",
          };
  }
}
