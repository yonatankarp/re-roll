import { describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { guessAmbience, sceneAmbience } from "../engine/story/ambience.ts";
import {
  type StoryFile,
  validateAdventure,
} from "../engine/story/adventure.ts";
import {
  EMPTY_INDEX,
  type NarrationIndex,
  NarrationIndexSchema,
  clipFile,
  narratedTexts,
  planNarration,
  scenesAhead,
  textHash,
} from "../engine/story/narration.ts";

describe("scene ambience", () => {
  it("guesses from the words in a scene", () => {
    expect(guessAmbience("Water drips in the dark cavern.")).toBe("cave");
    expect(guessAmbience("The tavern is loud with patrons.")).toBe("town");
    expect(guessAmbience("The road winds into the forest.")).toBe("wind");
    expect(guessAmbience("Rain lashes the roof.")).toBe("rain");
    expect(guessAmbience("You sit by the campfire.")).toBe("campfire");
    expect(guessAmbience("A clerk hands you a letter.")).toBe("none");
  });

  it("lets the weather win a tie with the place", () => {
    expect(guessAmbience("A storm breaks over the forest.")).toBe("storm");
  });

  it("goes by the most mentions", () => {
    expect(
      guessAmbience("Leaving the village, you enter a tunnel, then a cave."),
    ).toBe("cave");
  });

  it("prefers the scene's own choice, including quiet", () => {
    expect(sceneAmbience("town", "A dark cave.")).toBe("town");
    expect(sceneAmbience("none", "A dark cave.")).toBe("none");
    expect(sceneAmbience(undefined, "A dark cave.")).toBe("cave");
  });

  it("is unset unless a scene names one, and rejects unknown ids", () => {
    const [system] = systems;
    if (!system) throw new Error("no system");
    const parse = (scene: Record<string, unknown>) =>
      validateAdventure({
        pluginId: "test",
        system,
        fileName: (file) => file,
        assetPaths: new Set(),
        documents: new Map<StoryFile, unknown>([
          ["adventure", { title: "Test", startScene: "start" }],
          ["scenes", [{ id: "start", text: "Start.", ...scene }]],
        ]),
      });
    expect(parse({}).adventure?.scenes[0]?.ambience).toBeUndefined();
    expect(parse({ ambience: "cave" }).adventure?.scenes[0]?.ambience).toBe(
      "cave",
    );
    expect(parse({ ambience: "jungle" }).issues).not.toHaveLength(0);
  });
});

describe("narration index", () => {
  it("accepts the clip names it makes and refuses paths out of the folder", () => {
    const clip = { scene: "s", voice: "af_heart", seconds: 1 };
    const index = (file: string) =>
      NarrationIndexSchema.safeParse({ version: 1, clips: { [file]: clip } })
        .success;
    expect(index(clipFile("af_heart", "The road is long."))).toBe(true);
    for (const file of [
      "../x.mp3",
      "af_heart/../../x.mp3",
      "/etc/x.mp3",
      "af_heart/abc.wav",
      "af_heart\\abc.mp3",
      "abc.mp3",
    ]) {
      expect(index(file)).toBe(false);
    }
    expect(
      NarrationIndexSchema.safeParse({ version: 2, clips: {} }).success,
    ).toBe(false);
  });

  const texts = [
    { scene: "start", text: "The road is long." },
    { scene: "cave", text: "Water drips." },
  ];

  it("names a clip by voice and text, ignoring spacing", () => {
    expect(clipFile("af_heart", "The road  is\nlong. ")).toBe(
      clipFile("af_heart", "The road is long."),
    );
    expect(clipFile("bm_george", "x")).not.toBe(clipFile("af_heart", "x"));
    expect(textHash("a")).not.toBe(textHash("b"));
  });

  it("reads every text a scene can show", () => {
    expect(
      narratedTexts({
        scenes: [
          {
            id: "s",
            text: "One.",
            textVariants: [
              {
                when: { kind: "visited", scene: "s", atLeast: 1 },
                text: "Two.",
              },
            ],
            rest: true,
            choices: [],
          },
        ],
      }).map((item) => item.text),
    ).toEqual(["One.", "Two."]);
  });

  it("reads ahead the scenes a scene's choices go to", () => {
    expect(
      scenesAhead({
        id: "s",
        text: "One.",
        textVariants: [],
        rest: true,
        choices: [
          { label: "Go", effects: [{ kind: "goto", scene: "a" }] },
          {
            label: "Try",
            check: {},
            results: {
              success: [{ kind: "goto", scene: "b" }],
              failure: [{ kind: "goto", scene: "a" }],
            },
          },
        ],
      }),
    ).toEqual(["a", "b"]);
  });

  it("makes everything the first time", () => {
    const plan = planNarration(EMPTY_INDEX, texts, "af_heart", () => false);
    expect(plan.make.map((item) => item.scene)).toEqual(["start", "cave"]);
    expect(plan.keep).toEqual([]);
  });

  it("skips unchanged text and remakes changed or missing clips", () => {
    const made = (
      scene: string,
      text: string,
    ): [string, NarrationIndex["clips"][string]] => [
      clipFile("af_heart", text),
      { scene, voice: "af_heart", seconds: 1 },
    ];
    const index: NarrationIndex = {
      version: 1,
      clips: Object.fromEntries([
        made("start", "The road is long."),
        made("cave", "Water dripped."), // the text has since changed
        [
          clipFile("bm_george", "Water dripped."),
          { scene: "cave", voice: "bm_george", seconds: 1 },
        ],
      ]),
    };
    const onDisk = new Set(Object.keys(index.clips));
    const plan = planNarration(index, texts, "af_heart", (file) =>
      onDisk.has(file),
    );
    expect(plan.keep).toEqual([clipFile("af_heart", "The road is long.")]);
    expect(plan.make.map((item) => item.file)).toEqual([
      clipFile("af_heart", "Water drips."),
    ]);
    // Only this voice's old clip goes; another voice's is left alone.
    expect(plan.stale).toEqual([clipFile("af_heart", "Water dripped.")]);

    onDisk.delete(clipFile("af_heart", "The road is long."));
    expect(
      planNarration(index, texts, "af_heart", (file) => onDisk.has(file)).make,
    ).toHaveLength(2);
  });
});
