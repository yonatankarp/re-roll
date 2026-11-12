import { NARRATOR_VOICES } from "../story/narration.ts";
import { ambiencePlayer } from "./ambience.ts";
import {
  type SoundSettings,
  loadSettings,
  saveSettings,
  setMasterVolume,
} from "./audio.ts";
import { narrator } from "./narration.ts";
import type { GameView } from "./session.ts";

// The game's sound: a "Sound…" entry for the game menu that opens a small panel (volume,
// ambience, effects, narration, voice), the narrator's controls for under the scene text, and an
// update to call on each redraw, which picks the ambience and starts or stops the narrator.

let settings = loadSettings();

function field(label: string, input: HTMLElement): HTMLLabelElement {
  const row = document.createElement("label");
  row.append(input, document.createTextNode(label));
  return row;
}

export function soundControls(
  clipUrl: (path: string) => string | Promise<string | null> | null,
): {
  readonly menuItem: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  readonly narration: HTMLElement;
  readonly effects: () => boolean;
  readonly volume: () => number;
  readonly update: (view: GameView) => void;
  readonly follow: (camp: HTMLDialogElement) => void; // campfire sound while it's open
} {
  const ambience = ambiencePlayer();
  let view: GameView | null = null;
  let camping = false;
  let decision: string | null = null;

  let watch: ReturnType<typeof setInterval> | undefined;
  // Silent once the game screen has gone, such as back to the menu, which sends no update.
  const gone = (): boolean => {
    if (narration.controls.isConnected) return false;
    clearInterval(watch);
    narration.stop();
    ambience.play("none");
    return true;
  };

  const apply = (): void => {
    if (!view || gone()) return;
    watch ??= setInterval(gone, 1000);
    ambience.play(
      !settings.ambience ? "none" : camping ? "campfire" : view.ambience,
    );
    ambience.duck(view.combat !== null || narration.speaking());
    // Any choice stops the narrator; only a new scene starts it again.
    const asked = view.decision?.id ?? null;
    if (asked !== decision) {
      decision = asked;
      narration.stop();
    }
    narration.show(
      settings.narration && !camping ? view.scene : null,
      view.upcoming,
      view.adventureRoot,
      settings.voice,
    );
  };
  const narration = narrator(clipUrl, () => {
    ambience.duck(view?.combat !== null || narration.speaking());
  });

  const change = (next: Partial<SoundSettings>): void => {
    settings = { ...settings, ...next };
    saveSettings(settings);
    setMasterVolume(settings.volume);
    apply();
  };

  const volume = document.createElement("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "100";
  volume.value = String(Math.round(settings.volume * 100));
  volume.addEventListener("input", () => {
    change({ volume: Number(volume.value) / 100 });
  });
  const toggle = (
    label: string,
    key: "ambience" | "effects" | "narration",
  ): HTMLLabelElement => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = settings[key];
    box.addEventListener("change", () => {
      change({ [key]: box.checked });
    });
    return field(label, box);
  };
  const voice = document.createElement("select");
  voice.append(
    ...NARRATOR_VOICES.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      option.selected = item.id === settings.voice;
      return option;
    }),
  );
  voice.addEventListener("change", () => {
    change({
      voice:
        NARRATOR_VOICES.find((item) => item.id === voice.value)?.id ??
        settings.voice,
    });
  });
  const voiceRow = document.createElement("label");
  voiceRow.className = "sound-voice";
  voiceRow.append(document.createTextNode("Narrator "), voice);
  const note = document.createElement("p");
  note.className = "sound-note";
  note.textContent =
    "Without a recorded reading, the narrator's voice is downloaded once (90 MB, or 330 MB to use the graphics card) and read on this device.";

  const dialog = document.createElement("dialog");
  dialog.className = "sound-panel";
  dialog.setAttribute("aria-label", "Sound");
  const heading = document.createElement("h2");
  heading.textContent = "Sound";
  const volumeRow = document.createElement("label");
  volumeRow.className = "sound-volume";
  volumeRow.append(document.createTextNode("Volume "), volume);
  const done = document.createElement("button");
  done.textContent = "Done";
  const form = document.createElement("form");
  form.method = "dialog";
  form.append(done);
  dialog.append(
    heading,
    volumeRow,
    toggle("Ambience", "ambience"),
    toggle("Effects", "effects"),
    toggle("Narration", "narration"),
    voiceRow,
    note,
    form,
  );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  const menuItem = document.createElement("button");
  menuItem.type = "button";
  menuItem.textContent = "Sound…";
  menuItem.addEventListener("click", () => {
    menuItem.closest("details")?.removeAttribute("open");
    dialog.showModal();
  });

  return {
    menuItem,
    dialog,
    narration: narration.controls,
    effects: () => settings.effects,
    volume: () => settings.volume,
    update(next) {
      view = next;
      apply();
    },
    follow(camp) {
      new MutationObserver(() => {
        camping = camp.open;
        apply();
      }).observe(camp, { attributes: true, attributeFilter: ["open"] });
    },
  };
}
