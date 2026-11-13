import { describe, expect, it } from "vitest";
import {
  type SentenceSplitter,
  canPlayThrough,
  evenOut,
  groupSentences,
  paragraphs,
  readAloud,
  spokenText,
} from "../engine/shell/read-aloud.ts";

describe("game terms said aloud", () => {
  it("says dice as a player would", () => {
    expect(spokenText("Roll 1d6.")).toBe("Roll 1 D 6.");
    expect(spokenText("It deals 2d8 + 3 damage")).toBe(
      "It deals 2 D 8 plus 3 damage",
    );
    expect(spokenText("Take 1d4−1")).toBe("Take 1 D 4 minus 1");
    expect(spokenText("a d20")).toBe("a D 20");
  });

  it("says checks, armour, coins and distances", () => {
    expect(spokenText("a DC 12 Wisdom save")).toBe("a D C 12 Wisdom save");
    expect(spokenText("AC 15, 22 HP")).toBe("A C 15, 22 hit points");
    expect(spokenText("He pays 300 gp and 1 sp.")).toBe(
      "He pays 300 gold pieces and 1 silver piece.",
    );
    expect(spokenText("80 ft. away, 30 ft wide")).toBe(
      "80 feet away, 30 feet wide",
    );
    expect(spokenText("a +1 longsword")).toBe("a plus 1 longsword");
  });

  it("leaves ordinary words alone", () => {
    const text = "The dragon's acid gpu-free; she said 2nd, add 3.";
    expect(spokenText(text)).toBe(text);
  });
});

describe("pieces read together", () => {
  it("splits on blank lines and tidies each paragraph", () => {
    expect(paragraphs("One\nline.\n\n  Two.  \n \nThree.")).toEqual([
      "One line.",
      "Two.",
      "Three.",
    ]);
  });

  it("joins a short sentence to its neighbour", () => {
    const long = "The wind howls across the broken battlements of the keep.";
    const longer = `${long} Rain lashes the stones.`;
    expect(groupSentences(["He nods.", "Then he leaves."])).toEqual([
      "He nods. Then he leaves.",
    ]);
    expect(groupSentences([longer, longer])).toEqual([longer, longer]);
    expect(groupSentences([longer, "He nods."])).toEqual([
      `${longer} He nods.`,
    ]);
  });

  it("can keep the first piece short, so the first word comes soon", () => {
    const sentences = [
      "The rain has not stopped for three days.",
      "It runs in the gutters of the old town, under shuttered windows.",
      "A dog barks.",
    ];
    expect(groupSentences(sentences, 100)).toEqual([
      sentences[0],
      `${sentences[1]} ${sentences[2]}`,
    ]);
  });

  it("keeps a joined piece well inside Kokoro's limit", () => {
    const pieces = groupSentences(Array.from({ length: 40 }, () => "Go."));
    expect(Math.max(...pieces.map((piece) => piece.length))).toBeLessThan(220);
  });
});

describe("even joins", () => {
  const rate = 1000;
  const piece = new Float32Array([0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0, 0, 0]);

  it("trims the piece's own silence and puts an even pause before it", () => {
    const out = evenOut(piece, rate, 0.004);
    expect(out.length).toBe(4 + 4 + 3); // pause, sound, the tail kept (capped at the piece's end)
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("fades in and out at the cut", () => {
    const loud = new Float32Array(100).fill(1);
    const out = evenOut(loud, rate, 0);
    expect(out[0]).toBe(0);
    expect(out[50]).toBe(1);
    expect(out.at(-1)).toBe(0);
  });

  it("leaves only the pause for a silent piece", () => {
    expect(evenOut(new Float32Array(10), rate, 0.002).length).toBe(2);
  });
});

describe("reading a scene", () => {
  class Splitter implements SentenceSplitter {
    private text = "";
    push(text: string): void {
      this.text += text;
    }
    close(): void {
      // all pushed already
    }
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      await Promise.resolve();
      yield* this.text.split(/(?<=\.) /);
    }
  }
  const read: string[] = [];
  const tts = {
    generate: (text: string) => {
      read.push(text);
      return Promise.resolve({
        audio: new Float32Array(10).fill(0.5),
        sampling_rate: 100,
      });
    },
  };

  it("reads pieces in order, longer pauses between paragraphs", async () => {
    read.length = 0;
    const long =
      "The wind howls across the broken battlements of the old keep.";
    const pieces = [];
    for await (const piece of readAloud(
      tts,
      Splitter,
      `${long} ${long}\n\nIt costs 5 gp.`,
      "af_heart",
    )) {
      pieces.push(piece);
    }
    expect(read).toEqual([long, long, "It costs 5 gold pieces."]);
    // 10 samples each (the tail is capped at the end), after 0, 0.35 s and 0.7 s of quiet.
    expect(pieces.map((piece) => piece.samples.length)).toEqual([
      10,
      35 + 10,
      70 + 10,
    ]);
    expect(pieces.every((piece) => piece.spent >= 0)).toBe(true);
    // Characters still to read after each piece, for the player's guess at what's left.
    expect(pieces.map((piece) => piece.left)).toEqual([
      [long.length, 23],
      [23],
      [],
    ]);
  });
});

describe("waiting before playing", () => {
  it("plays at once when the voice keeps up", () => {
    expect(canPlayThrough(3, [4, 3, 4], 0, 0.5)).toBe(true);
    expect(canPlayThrough(2, [], 0, 3)).toBe(true);
  });

  it("waits while a piece to come would be late", () => {
    // At 1.6 s per second of speech, the 8 s piece takes about 14.7 s, and 2 s ready isn't enough.
    expect(canPlayThrough(2, [8, 6], 0, 1.6)).toBe(false);
    // With 16 s ready, each piece is made before playback reaches it.
    expect(canPlayThrough(16, [5, 3], 0, 1.6)).toBe(true);
  });

  it("counts the time the piece being read has had", () => {
    expect(canPlayThrough(10, [8], 0, 1.6)).toBe(false);
    expect(canPlayThrough(10, [8], 5, 1.6)).toBe(true);
  });

  it("catches a late piece further on, which arrives whole", () => {
    // The first piece to come is quick, but the long one after it isn't ready in time.
    expect(canPlayThrough(3, [1, 12], 0, 1.5)).toBe(false);
  });
});
