import {
  NARRATION_FOLDER,
  clipFile,
  normaliseText,
} from "../story/narration.ts";
import { shellAudio } from "./audio.ts";
import type { NarrationReply, NarrationRequest } from "./narration-worker.ts";

// Reads the scene aloud: a clip made ahead of time (npm run narrate) when there is one, or else
// read in a worker, a sentence at a time, as it plays. On a CPU that reads slower than speech,
// the scenes the choices lead to are read ahead while the player listens. Play, pause and skip;
// a new scene or a choice stops it, and it never moves the story on. If no voice can be had,
// the controls hide for that scene rather than fall back to a robotic one.

const KEPT = 12; // clips kept in memory, so going back or reading ahead isn't wasted
const STALL_MS = 120_000; // a busy worker silent this long is stuck; one long sentence on a slow CPU can take a minute
const RESTARTS = 2; // then a stuck reading is given up, and its scene isn't read

interface Clip {
  readonly key: string;
  readonly buffers: AudioBuffer[]; // each sentence as it comes, or one whole clip
  done: boolean;
  failed: boolean;
  job: number | null; // the worker's reading of it, while that's under way
  readonly text: string; // as sent to the worker, to send again after a restart
  readonly voice: string;
  readonly changed: Set<() => void>;
}

let worker: Worker | null = null;
let jobs = 0;
const working = new Map<number, Clip>();
const clips = new Map<string, Clip>(); // oldest first
let loading: ((percent: number) => void) | null = null;
let heard = 0; // when the worker last said anything
let restarts = 0;

function tell(clip: Clip): void {
  for (const listener of clip.changed) listener();
}

function narrationWorker(): Worker | null {
  try {
    worker ??= (() => {
      const made = new Worker(
        new URL("./narration-worker.ts", import.meta.url),
        { type: "module" },
      );
      made.addEventListener(
        "message",
        (event: MessageEvent<NarrationReply>) => {
          const reply = event.data;
          heard = performance.now();
          if (reply.type === "loading") {
            loading?.(reply.percent);
            return;
          }
          if (reply.type === "ready") {
            console.info(
              `Narration voice ready on ${reply.device} in ${reply.seconds.toFixed(1)}s`,
            );
            return;
          }
          const clip = working.get(reply.id);
          const audio = shellAudio();
          if (!clip) return;
          if (reply.type === "chunk" && audio) {
            const buffer = audio.context.createBuffer(
              1,
              reply.samples.length,
              reply.rate,
            );
            buffer.copyToChannel(new Float32Array(reply.samples), 0);
            clip.buffers.push(buffer);
          } else if (reply.type === "done") {
            working.delete(reply.id);
            clip.job = null;
            clip.done = true;
            console.info(
              `Narration: ${reply.audio.toFixed(1)}s of speech read in ${reply.seconds.toFixed(1)}s`,
            );
          } else if (reply.type === "error") {
            working.delete(reply.id);
            clip.job = null;
            clip.failed = true;
            clips.delete(clip.key);
            console.warn(`Narration unavailable: ${reply.message}`);
          }
          tell(clip);
        },
      );
      // A worker that can't load or crashes, say out of memory, never answers again, so its clips fail.
      const fail = (event: Event): void => {
        if (worker !== made) return;
        console.warn(
          `Narration worker failed: ${event instanceof ErrorEvent ? event.message : event.type}`,
        );
        made.terminate();
        worker = null;
        for (const clip of working.values()) {
          clip.job = null;
          clip.failed = true;
          clips.delete(clip.key);
          tell(clip);
        }
        working.clear();
      };
      made.addEventListener("error", fail);
      made.addEventListener("messageerror", fail);
      heard = performance.now();
      return made;
    })();
    return worker;
  } catch {
    return null;
  }
}

function send(request: NarrationRequest): void {
  narrationWorker()?.postMessage(request);
}

function speak(clip: Clip): void {
  jobs += 1;
  clip.job = jobs;
  working.set(jobs, clip);
  send({ type: "speak", id: jobs, text: clip.text, voice: clip.voice });
}

// A reading can hang, as WebGPU work did in a hidden Tauri window and stayed hung once shown.
// The worker reads in order, so everything after it would wait forever: a silent busy worker is
// replaced and its readings asked for again. Time hidden doesn't count, since nothing plays then.
setInterval(() => {
  if (working.size === 0 || document.hidden) {
    heard = performance.now();
    return;
  }
  if (performance.now() - heard < STALL_MS) return;
  console.warn("Narration worker stopped answering, so it was restarted");
  worker?.terminate();
  worker = null;
  restarts += 1;
  const stuck = [...working.values()];
  working.clear();
  for (const clip of stuck) {
    clip.job = null;
    clip.buffers.length = 0; // read again from the start; playback carries on where it was
    if (restarts <= RESTARTS) {
      speak(clip);
    } else {
      clip.failed = true;
      clips.delete(clip.key);
      tell(clip);
    }
  }
}, 5000);

// Stops the worker reading a clip that isn't finished, and forgets the part read.
function drop(clip: Clip): void {
  if (clip.job === null) return;
  send({ type: "cancel", id: clip.job });
  working.delete(clip.job);
  clip.job = null;
  clips.delete(clip.key);
}

// A clip made ahead of time, or null when there isn't one.
async function fetchClip(
  clipUrl: (path: string) => string | Promise<string | null> | null,
  path: string,
): Promise<AudioBuffer | null> {
  const audio = shellAudio();
  try {
    const url = await clipUrl(path);
    if (!url || !audio) return null;
    const response = await fetch(url);
    if (!response.ok) return null;
    return await audio.context.decodeAudioData(await response.arrayBuffer());
  } catch {
    return null;
  }
}

// The clip for a text in a voice: kept, recorded, or read in the worker.
function obtain(
  clipUrl: (path: string) => string | Promise<string | null> | null,
  text: string,
  root: string,
  voice: string,
): Clip {
  const file = clipFile(voice, text);
  const key = `${root}/${file}`;
  const known = clips.get(key);
  if (known) {
    clips.delete(key); // moved to the newest end
    clips.set(key, known);
    return known;
  }
  const clip: Clip = {
    key,
    buffers: [],
    done: false,
    failed: false,
    job: null,
    text: normaliseText(text),
    voice,
    changed: new Set(),
  };
  clips.set(key, clip);
  for (const [oldKey, old] of clips) {
    if (clips.size <= KEPT) break;
    if (old.job === null && old.changed.size === 0) clips.delete(oldKey);
  }
  void fetchClip(clipUrl, `${root}/${NARRATION_FOLDER}/${file}`).then(
    (recorded) => {
      if (recorded) {
        clip.buffers.push(recorded);
        clip.done = true;
      } else if (clips.get(key) === clip && narrationWorker()) {
        speak(clip);
        return;
      } else {
        clip.failed = true;
      }
      tell(clip);
    },
  );
  return clip;
}

export interface Narrator {
  readonly controls: HTMLElement;
  // The scene's text (null stops and hides it), the texts its choices lead to, its adventure's
  // folder and the voice.
  readonly show: (
    text: string | null,
    ahead: readonly string[],
    root: string,
    voice: string,
  ) => void;
  readonly stop: () => void;
  readonly speaking: () => boolean;
}

export function narrator(
  clipUrl: (path: string) => string | Promise<string | null> | null,
  onChange: () => void, // told when speaking starts or stops, for ducking
): Narrator {
  const controls = document.createElement("div");
  controls.className = "narration";
  controls.hidden = true;
  const play = document.createElement("button");
  play.type = "button";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.textContent = "Skip";
  const status = document.createElement("span");
  status.className = "narration-status";
  status.setAttribute("role", "status");
  controls.append(play, skip, status);

  let scene: {
    readonly text: string;
    readonly ahead: readonly string[];
    readonly root: string;
    readonly voice: string;
  } | null = null;
  let shown: string | null = null; // which scene, voice and folder
  let reading: {
    readonly clip: Clip;
    index: number; // the sentence playing, or next to play
    offset: number; // seconds into it, when paused
    source: AudioBufferSourceNode | null;
    startedAt: number;
    paused: boolean;
  } | null = null;
  let readAhead = false;

  const speaking = (): boolean => reading?.source != null && !reading.paused;

  const draw = (): void => {
    const waiting =
      reading !== null &&
      !reading.paused &&
      reading.source === null &&
      !reading.clip.done;
    play.textContent = speaking()
      ? "❚❚ Pause"
      : reading?.paused
        ? "▶ Resume"
        : "▶ Read aloud";
    play.disabled = waiting;
    skip.hidden = reading === null;
    if (!waiting) status.textContent = "";
    else if (!status.textContent) status.textContent = "Preparing voice…";
    onChange();
  };

  const halt = (): void => {
    if (!reading?.source) return;
    reading.source.onended = null;
    reading.source.stop();
    reading.source.disconnect();
    reading.source = null;
  };

  // Once this scene is read, the worker reads the scenes it can lead to while the player listens.
  const readOn = (): void => {
    if (!scene || readAhead) return;
    readAhead = true;
    for (const text of scene.ahead) {
      obtain(clipUrl, text, scene.root, scene.voice);
    }
  };

  const playNext = (): void => {
    const audio = shellAudio();
    if (!reading || !audio || reading.paused || reading.source) return;
    const { clip } = reading;
    if (clip.failed) {
      reading = null;
      controls.hidden = true; // no voice for this scene, so it just isn't read
      draw();
      return;
    }
    if (clip.done) readOn();
    const buffer = clip.buffers[reading.index];
    if (!buffer) {
      if (clip.done) {
        clip.changed.delete(playNext);
        reading = null; // finished; the button reads it again
      }
      draw();
      return;
    }
    const source = audio.context.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.narration);
    const current = reading;
    source.onended = () => {
      current.source = null;
      current.index += 1;
      current.offset = 0;
      playNext();
    };
    current.source = source;
    current.startedAt = audio.context.currentTime - current.offset;
    source.start(0, current.offset);
    draw();
  };

  const stop = (): void => {
    halt();
    reading?.clip.changed.delete(playNext);
    reading = null;
    draw();
  };

  const start = (): void => {
    if (!scene) return;
    const clip = obtain(clipUrl, scene.text, scene.root, scene.voice);
    // The worker reads in order, so read-ahead for scenes not taken would hold this one up.
    for (const other of [...clips.values()]) {
      if (other !== clip) drop(other);
    }
    clip.changed.add(playNext);
    reading = {
      clip,
      index: 0,
      offset: 0,
      source: null,
      startedAt: 0,
      paused: false,
    };
    loading = (percent) => {
      if (reading?.clip === clip && !reading.source) {
        status.textContent = `Preparing voice… ${String(percent)}%`;
      }
    };
    draw();
    playNext();
  };

  play.addEventListener("click", () => {
    if (!reading) {
      start();
    } else if (reading.paused) {
      reading.paused = false;
      playNext();
    } else if (reading.source) {
      const audio = shellAudio();
      reading.offset = audio
        ? audio.context.currentTime - reading.startedAt
        : 0;
      halt();
      reading.paused = true;
      draw();
    }
  });
  skip.addEventListener("click", stop);

  return {
    controls,
    show(text, ahead, root, voice) {
      const key = text === null ? null : `${root}\u0000${voice}\u0000${text}`;
      if (key === shown) return;
      shown = key;
      stop();
      readAhead = false;
      scene = text === null ? null : { text, ahead, root, voice };
      controls.hidden = text === null;
      start();
    },
    stop,
    speaking,
  };
}
