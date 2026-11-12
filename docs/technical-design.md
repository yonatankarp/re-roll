# Technical Design: Re-roll

**Status:** Draft for review. The engine, the D&D 5.5e plugin, the importer and the UI are playable in the browser, the Tauri app and the terminal.
**Checked:** 5 November 2026. Package versions came from the npm registry that day. Sections 3, 7.1 to 7.4, 8.12 to 8.17 and 9 were brought up to date against the code on 12 November 2026.

## 1. Goal and assumptions

Re-roll is a single-player game where you join a generated party and play a published-style adventure. A local model prepares each session in the background from what actually happened in earlier sessions. Play itself needs no model.

The engine contains no game rules and no adventure content. **Everything specific to a game lives in a plugin.**

**Requirements**
- Adventures and rulebooks are added as plugins, with no engine change.
- The first rule system is D&D 5.5e (2024), including full book content in private local plugins.
- A new rule system can be added later as a plugin, with no engine change. Daggerheart is the known future case.
- It needs no subscription, service account or expensive machine.
- No two runs play out the same way.

**In scope:** the plugin system, and the D&D 5.5e system plugin.

**Not in scope:** implementing other rule systems (the design must allow them, but only D&D is built now), multiplayer, a database, a plugin marketplace or remote installs, and live model calls during play. The live model may return later as an optional add-on.

**Assumptions to confirm**
- **Platform:** TypeScript, with illustrated scenes and grid combat for D&D. Free roaming would add map-position state and change the UI, but the rest of the design would stand.
- **Target machine:** the prep model must fit in 16 GB of memory, even though this development machine has 32 GB.

## 2. TypeScript best-practice findings

| Topic | Decision | Why | Source |
|---|---|---|---|
| Compiler version | Pin `typescript@~6.0.3`, not 7.0 | `typescript-eslint` declares `typescript >=4.8.4 <6.1.0`, so 7.0.2 is outside its supported range | npm registry, [typescript-eslint](https://typescript-eslint.io/users/dependency-versions/) |
| Upgrade path | Move to 7 when `typescript-eslint` supports it | Community guides say 7.0 has no compiler API yet. I couldn't reach Microsoft's announcement, so this is unconfirmed | Third party: [migration guide](https://github.com/boranfurkan/typescript-7-migration) |
| Strictness | `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, all set explicitly | The engine looks up content by ID everywhere, so unchecked lookups would be a common bug. The docs mark the first two as recommended, and the third is my choice | [TSConfig reference](https://www.typescriptlang.org/tsconfig/) |
| Syntax | `erasableSyntaxOnly` and `verbatimModuleSyntax`, so no enums, runtime namespaces or parameter properties | Node can then run the source directly | [Node TypeScript docs](https://nodejs.org/api/typescript.html) |
| Import extensions | Write `.ts` in relative imports, with `allowImportingTsExtensions` and `noEmit` in every config | Nothing emits JavaScript, as Node strips types and Vite bundles, so `rewriteRelativeImportExtensions` isn't needed | [Node TypeScript docs](https://nodejs.org/api/typescript.html), [Choosing compiler options](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html) |
| Closed sets | `as const` lists turned into Zod enums and inferred literal unions | Replaces enums, and gives runtime checks and types from one definition | Follows from the syntax row |
| Runtime | Node 26.13.0, pinned in `.nvmrc`, minimum 24.12 | Type stripping is marked stable from 24.12 and 25.2 | [Node TypeScript docs](https://nodejs.org/api/typescript.html), [Node releases](https://nodejs.org/dist/index.json) |
| Modules | `module: nodenext` for shared code, bundler settings only in the UI | Bundler-only code can fail in Node, while Node-valid code generally works in bundlers | [Choosing compiler options](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html) |
| Aliases | No tsconfig `paths`. Plugins import the SDK through the `#sdk` subpath import | Node ignores `tsconfig.json` at runtime, and subpath imports are its supported alternative | [Node TypeScript docs](https://nodejs.org/api/typescript.html) |
| Repo shape | One package, with plugins as folders rather than workspace packages | Node refuses to strip types under `node_modules`, and workspaces link packages there | [Node TypeScript docs](https://nodejs.org/api/typescript.html) |
| Variants | Discriminated unions, plus exhaustive `switch` checks ending in `never` | The handbook recommends a separate type per case over one type with optional fields, and the compiler flags forgotten cases | [TS handbook](https://www.typescriptlang.org/docs/handbook/2/narrowing.html) |
| External data | Parse once at the boundary with Zod, then trust the inferred type | This covers plugins, saves and model output. Community guidance rather than official docs | Third party: [tutorial](https://dev.to/paradane/parse-dont-validate-in-typescript-a-practical-tutorial-1ahc) |
| IDs | Branded types created only through the schema | TypeScript is structural, so a spell ID would otherwise be accepted as a monster ID. Community guidance | [Zod docs](https://zod.dev/) and third-party guides |
| Linting | `strict-type-checked` and `stylistic-type-checked`, plus `switch-exhaustiveness-check`. Pin exact versions | The strict configs aren't stable under semver | [typescript-eslint configs](https://typescript-eslint.io/users/configs/) |
| Formatting | Prettier | The lint presets deliberately leave out formatting | [typescript-eslint configs](https://typescript-eslint.io/users/configs/) |
| Testing | Vitest and `@fast-check/vitest`, with fixed seeds to replay failures | 0.5.0 declares support for Vitest 5 | npm registry, [fast-check docs](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-vitest/) |

### Versions to start from

| Package | Version | Package | Version |
|---|---|---|---|
| `typescript` | 6.0.3 | `vitest` | 5.1.0 |
| `typescript-eslint` | 8.72.1 | `fast-check` | 4.10.2 |
| `eslint` | 10.14.0 | `@fast-check/vitest` | 0.5.0 |
| `zod` | 4.6.7 | `yaml` | 2.9.1 |
| `prettier` | 3.9.10 | `vite` | 8.3.6 |
| `@tauri-apps/cli` | 2.12.4 | | |

The D&D combat board is drawn with the DOM and CSS animations rather than PixiJS: a grid of a few dozen squares doesn't need WebGL, it saves a dependency, and pictures from the content folders work as plain images.

The app looks like a fifth edition book page. Its fonts are Solbera's CC BY-SA 4.0 recreations of the book fonts (Bookinsanity, Mr Eaves Small Caps, Nodesto Caps Condensed and Scaly Sans), bundled unchanged in `app/desktop/fonts` with their licence and credited in About, because the desktop app can't load fonts from the web and the original fonts are commercial.

## 3. Architecture and layout

```text
engine/                    Knows no game rules and no adventure
  kernel/                  IDs, Storage interface, plugin loader, registry, dice, turn loop, events, saves
  story/                   Scenes, clocks, secrets, variants, director, companions, ambience ids, narration clip names
  prep/                    Session prep logic and the ModelClient interface
  sdk/                     The only part of the engine plugins may import
  shell/                   App UI. Knows no rule system:
    session.ts             The game layer: views, saves, autosave, undo (also used headless)
    shell.ts               Page layout, menus, drawers, the option list
    adventure-picker.ts    Cover cards on the main menu
    load-screen.ts         Save cards
    campfire.ts            Rests from the top bar
    journal-tabs.ts        Story, Rolls and Leads tabs
    shop.ts                The merchant panel
    narration*.ts          Read-aloud with Kokoro-82M, in a worker
    ambience.ts audio.ts sound-panel.ts   Soundscapes and sound settings
    system-ui.ts           The seam a system's UI implements
  platform/                Storage and ModelClient for browser/, node/ and tauri/
  tools/                   check-pack, test bot, headless play driver, book importer logic

plugins/
  systems/
    dnd5.5e/            Code plugin: the D&D 5.5e rules
      core/                Schemas, rules, combat, character building, AI policies, and:
        gear.ts            Treasure, the pack, equipping and attunement
        shop.ts carry.ts   Merchants, and carrying capacity
        rest.ts            Short and Long Rests, and when they're allowed
        legendary.ts       Legendary and lair actions, Legendary Resistance, surprise, fleeing
        targeting.ts       Picking spell targets and aiming areas
        feature-rules.ts class-rules.ts   Mechanics for class features, by id
        import/            Book parsers for the importer
      ui/                  Character sheet, combat board, cues, shop and sound (DOM and CSS)
  rules/
    srd52/                 Data plugin for dnd5.5e
      plugin.yaml
      classes/ subclasses/ species/ backgrounds/ feats/ features/ spells/ equipment/ monsters/ pregens/
  adventures/
    goblin-ambush/         Data plugin, original sample using dnd5.5e
    haunted-house/         Data plugin, original sample using dnd5.5e

books/                   Your book plugins, same structure, excluded from git (its own private repository)
  rules/ adventures/ assets/ library/

app/
  systems.ts               The one static list of system plugins
  desktop/                 Vite entry, styles, fonts, and the Tauri app in src-tauri/
  cli/                     Command-line entry points: play, bot, check-pack, import, narrate

docs/
  technical-design.md      This document
  class-features.md        Generated by npm run class-features (section 8.17)

tests/fixtures/
  system-d6/               Tiny test-only rule system (section 12)
  rules/ adventures/       Data plugins for it. These d6 copies keep proving the engine works with any rule system
```

`app/` is the only place that imports both the engine and system plugins. It passes them to the engine, so the engine never refers to a plugin by name.

### Boundaries, enforced by `no-restricted-imports`

| Layer | May import |
|---|---|
| `engine/*` | Other engine layers, never `plugins/` or `app/` |
| `plugins/systems/<id>/core` | `#sdk` and its own folder. Never the rest of the engine or another plugin |
| `plugins/systems/<id>/ui` | `#sdk`, its own `core`, and UI libraries |
| `app/` | Everything |

**Determinism rules, enforced by lint** in `engine/kernel`, `engine/story` and every `plugins/systems/*/core`: no `Math.random`, `Date`, `fetch` or `node:` imports. Dice come from the seeded generator held in game state.

### TSConfig layout

Each layer gets a config that limits what it can reach:

| Config | Covers | `lib` and `types` | Effect |
|---|---|---|---|
| `tsconfig.core.json` | `engine/{kernel,story,prep,sdk}`, `plugins/systems/*/core` | `ES2023`, `types: []` | Can't compile against DOM or Node APIs |
| `tsconfig.tools.json` | `engine/tools`, `engine/platform/node`, `app/cli` | `ES2023`, `types: ["node"]` | Runs directly in Node |
| `tsconfig.test.json` | `tests/`, except the fixture system | `ES2023`, `types: ["node"]` | Tests can read fixtures from disk |
| `tsconfig.ui.json` (added in step 6) | `engine/shell`, `engine/platform/tauri`, `plugins/systems/*/ui`, `app/desktop` | `ES2023, DOM`, bundler resolution | Built by Vite |

All three set `strict`, `types` and `rootDir` explicitly, so changes in compiler defaults can't alter behavior on a later upgrade.

### File and network access

Only `engine/platform` touches files or the network. The plugin loader, prep and saves depend on two small interfaces, so the same logic runs from a Node command during development and inside the Tauri app. `Storage` lives in `engine/kernel` because the loader needs it, and `ModelClient` lives in `engine/prep`:

```ts
export interface Storage {
  read(path: string): Promise<string | null>;
  replaceAtomically(path: string, contents: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>; // text, finish reason, tokens, duration
}
```

The UI runs in Tauri through `npm run desktop`, which needs a Rust toolchain for development but not for playing. It also runs in a plain browser through `npm run ui`, reading `plugins/` and `books/` through a read-only endpoint on the dev server. A built desktop app has no checkout: it reads the shipped plugins from its bundled resources, and the player's own from a content folder in its app data, laid out like `books/` (see the README). Both keep saves in the webview's own storage for now, so the file scopes stay limited to the two content folders (section 9).

One exception to "only `engine/platform` touches the network": the narration worker in `engine/shell` downloads the Kokoro-82M model from Hugging Face on first use, and the Tauri CSP allows only that host (section 7.2).

## 4. Plugin system

### 4.1 Plugin kinds

| Kind | Contains | Loaded | Example |
|---|---|---|---|
| `system` | TypeScript rules and UI | Built in, through `app/systems.ts` | `dnd5.5e` |
| `rules` | Data only | Found at runtime | `srd52`, your `phb24` |
| `adventure` | Data and art only | Found at runtime | `goblin-ambush` |

**Adding an adventure or book means adding a folder, with no rebuild.** Adding a rule system means adding a code plugin and one line in `app/systems.ts`, followed by a rebuild.

**Data plugins can't contain code.** The loader accepts only an allowlist of YAML, text, image and audio formats, and rejects symlinks. SVG is left out because it can carry scripts. This means downloading an adventure can't run code on your machine, and there's no need to load scripts at runtime inside Tauri. If an adventure needs an unusual mechanic, it goes into the system plugin as a new effect.

### 4.2 Manifest

Data plugins have a `plugin.yaml`. A system plugin's ID and version live in `defineSystem`, so it doesn't need one.

```yaml
id: srd52
kind: rules                  # rules | adventure
version: 1.0.0
sdk: ^1                      # engine SDK version it was written for
system: dnd5.5e@^1           # the rule system it was written for
requires: []                 # such as { plugin: srd52, version: ^1 }
distribution: shipped        # or private
edition: "2024"              # optional; each system says what an unset edition means
precedence: [phb]            # adventures only: plugins whose entries win in this adventure's runs
attribution: >-
  Credit text, shown on the About screen whenever this plugin is loaded
```

### 4.3 Loading

1. Scan `plugins/` and `books/`, plus a user plugin folder in the packaged app.
2. Parse each `plugin.yaml` with Zod, and check that its SDK and system versions match.
3. Sort by dependency, and reject missing dependencies and cycles.
4. A run uses one system. The loader refuses to mix plugins from different systems.
5. Parse each content file with the schema the system registered for that folder, reporting the file and the path within it.
6. Apply replacements. Because IDs are namespaced, a book's version of a spell declares `replaces: srd52:spell/fireball`. It replaces the whole entry, with no deep merging, and any reference to the old ID resolves to the replacement.
7. Resolve every reference, and report anything missing.
8. Order the plugins by precedence: the adventure being played, then the plugins its `precedence` lists, then the rest by the system's `precedence` rank and ID. `contentIds()` lists entries in that order, so when two books print an entry of the same name, a system takes the first. The D&D system ranks `phb`, `monster-manual` and `dmg` first, then other books, then `srd52`, then 2014-edition books.
9. Freeze the result into a read-only registry.

**Data plugin files are untrusted input.** Asset paths must stay inside the plugin folder, and all text is rendered as text, never as HTML. The same applies to model output.

### 4.4 IDs

IDs are namespaced by plugin and kind, and branded per kind in the system plugin:

```ts
// srd52:spell/fireball, phb24:feat/alert
const idPattern = /^[a-z0-9.-]+:[a-z-]+\/[a-z0-9-]+$/;
export const SpellIdSchema = z.string().regex(idPattern).brand<"SpellId">();
export type SpellId = z.infer<typeof SpellIdSchema>;
```

## 5. The game system interface

This is the seam that keeps rules out of the engine. A system plugin uses `defineSystem`, which infers its types and validates its payloads. The engine sees only opaque, serializable values, so generics don't spread through engine code.

```ts
export const dnd55e = defineSystem({
  id: "dnd5.5e",
  version: "1.0.0",
  sdk: "^1",

  contentKinds: {                    // keyed by folder name
    spells: contentKind({ idPrefix: "spell", schema: SpellSchema }),
    /* ... */
  },
  stateSchema: SystemStateSchema,    // actors and run-level state, checked when a save loads
  eventSchemas: { "dnd5.5e:damaged": DamagedSchema },
  checkSchema: CheckSchema,          // what a scene's check looks like
  encounters: encounterKind({ schema: EncounterSchema }),
  outcomes: { keys: ["success", "failure"] },

  storyEffects: { "dnd5.5e:awardXp": storyEffect({ schema, apply }) },
  storyPredicates: { "dnd5.5e:partyHasClass": storyPredicate({ schema, evaluate }) },
  frames: { "dnd5.5e:resolveAttack": frameHandler({ schema, run }) },

  createRun,            // starting state, including the party's characters
  resolveCheck,         // returns an outcome key, events and frames
  startEncounter,
  applyEvent,           // the only place system state changes
  nextDecision,         // whose decision comes next, if anyone's, with read access to content
  decidePolicy,         // non-player decisions, without a model
  // Still to come: describeFacts for prep, glossary, and importSchemas for the book importer.
});
```

The `contentKind` and `encounterKind` helpers keep each kind's exact type in a closure, so the engine never casts an entry. Today, `defineSystem` holds the slots the loader and checker use, and the runtime slots arrive with the kernel in step 3.

At startup, the engine confirms that every namespaced kind has exactly one handler and that no two collide.

The UI half is registered separately from `plugins/systems/<id>/ui`: sheet view, encounter view, and any decision views the shell doesn't handle generically.

### 5.1 Checking the seam against Daggerheart

Every slot must make sense for both systems. If a Daggerheart cell had to say "not applicable" or use a D&D concept under a new name, that would be D&D leaking into the engine. I checked the Daggerheart cells against its [SRD 1.0](https://www.daggerheart.com/srd).

| Slot | D&D 5.5e | Daggerheart |
|---|---|---|
| Content kinds | Classes, species, backgrounds, feats, spells, monsters | Classes, ancestries, communities, domain cards, adversaries, environments |
| Check | Ability or skill against a DC | Trait against a Difficulty, using a pair of d12s |
| Outcome keys | `success`, `failure` | `critical`, `successHope`, `successFear`, `failureHope`, `failureFear` |
| `nextDecision` | Initiative order, turn by turn | Spotlight moves with the story and roll results, with no initiative |
| `gmOpportunity` event | Failed checks and director moments | Rolls with Fear and failed rolls, where the GM makes a move |
| Actor state | HP, spell slots, exhaustion, action budget | HP, Stress, Armor Slots, Hope, domain card loadout |
| Run state | Initiative order, round number | GM's Fear pool, current spotlight |
| Positions | 5-foot grid | Range bands from Melee to Very Far |
| Damage | Subtract after Resistance and Vulnerability | Compare to thresholds, then mark 1, 2 or 3 HP |
| Recovery | Short and Long Rests | Downtime moves during a rest |
| Advancement | XP thresholds and class levels | Level-up advancement choices |
| Encounter UI | Grid board | Range band view, built by that plugin |

**What this changed in the engine**
- **Outcomes aren't pass or fail.** Each system declares its own keys, and scenes branch on them. A system can also declare groups, such as `success` covering `successHope` and `successFear`, so writers aren't forced to handle every case.
- **The engine has no concept of turns.** It only asks `nextDecision`, which covers both initiative and spotlight.
- **The grid belongs to the D&D plugin.** The engine shell only provides space for a system's encounter view: `app/` passes `mountShell` a board for each system id, and the shell hands it the view, the pending decision and the cues since its last update. A system's `cue` turns each event into plain data to animate, so the board is the only system code that touches the DOM.
- **HP isn't an engine concept.** Damage and health stay entirely inside each system.
- **Clocks stay in the engine.** Daggerheart's countdowns map onto them directly, which suggests that the concept is general enough.
- **The director doubles as the GM.** It answers `gmOpportunity` events, which handles Daggerheart's GM moves without a new mechanism.

## 6. Engine kernel

### 6.1 Game state

```ts
export interface GameState {
  readonly rng: { readonly world: RngState; readonly play: RngState };
  readonly partyIds: readonly ActorId[];
  readonly companions: Readonly<Record<ActorId, CompanionProfile>>;
  readonly stack: readonly Frame[];
  readonly story: StoryState;       // scene, flags, clocks, attitudes, secrets, beats, variants, ending
  readonly system: unknown;         // opaque to the engine, checked by the system's stateSchema on load
}
```

World generation and play use separate dice streams, so a change to how a world is generated doesn't shift the rolls of a replayed session.

### 6.2 The turn loop

```ts
export function step(
  state: GameState,
  input: Input,
  context: RunContext,        // registry and the loaded system
): { readonly state: GameState; readonly events: readonly GameEvent[] };
```

**One code path for state:** handlers decide what happens and return events, and the new state is always `events.reduce(applyEvent, state)`. Live play and loading a save therefore can't drift apart. This includes bookkeeping: dice results, pushed and popped frames, and the whole starting state are all events.

**Pending work is data.** Rules often interrupt each other, and callbacks or async code would break saving and replay. So the engine keeps a stack of frames with namespaced kinds, and the owning handler processes each one:

```ts
export interface Frame {
  readonly kind: string;              // "story:resolveChoice", "dnd5.5e:resolveAttack"
  readonly payload: OpaquePayload;    // checked by that handler's schema
}
```

`step` works through frames until the stack is empty or a decision is needed, then waits for the next input. A game can be saved at any moment, including halfway through an attack.

### 6.3 Decisions

All decisions use one interface. The UI answers for the player, the system's `decidePolicy` answers for companions and opponents, and the test bot answers with random valid options. The engine doesn't know which one it's talking to.

Combat AI is plain code rather than a model, so play stays fast and works without one.

### 6.4 Narrative events

Every system must emit these events, so that prep, the director and companions can react without knowing the rules:

| Event | Meaning |
|---|---|
| `checkResolved` | A check finished, with its outcome key |
| `actorDowned` / `actorDefeated` | Someone is out of the fight, or gone for good |
| `encounterStarted` / `encounterEnded` | A fight or similar conflict began or finished. An optional outcome says `defeat` or `flee`, and with none it was won |
| `clueRevealed` | The player learned a secret's clue, with its text. The engine emits this one, when a `reveal` effect fires |
| `levelGained` | A character advanced |
| `itemGained` / `itemLost` | Something changed hands |
| `gmOpportunity` | The rules say the GM may now act |
| `partyDefeated` | The party has lost. The engine ends the run instead of continuing to the choice's next scene |

Systems may emit any further events under their own namespace. Those are saved and replayed, but the engine doesn't interpret them.

## 7. Story runtime

These are generic concepts, and the engine has no knowledge of any particular adventure or rule system.

| Concept | Purpose |
|---|---|
| **Scene** | Text, art and choices, and an optional short `title` for save cards and the window title. A scene with no choices is an ending. Optional `textVariants` replace the text when their condition holds, and the first match wins. Unless it sets `rest: false`, the player may also rest once per visit, from the rests the system allows (`rests`), offered as `rest:` options beside the choices |
| **Condition** | Flags, attitudes, clocks and resources (`atLeast`, `atMost` or both), scenes `visited`, combined with `all` or `any`, plus predicates registered by the system |
| **Story effect** | Engine effects: `setFlag`, `goto`, `advanceClock`, `adjustAttitude`, `adjustResource`, `startEncounter`, `reveal`. Everything else is a namespaced system effect |
| **Resource** | A named party number such as gold, declared with its starting value under `resources` in `adventure.yaml`. It can't go below 0, so a choice that costs something checks the price with a condition first |
| **NPC** | Motives, knowledge, attitude, and a system-specific stat reference |
| **Faction and clock** | Goals that advance with time and player choices, with effects at set thresholds |
| **Secret** | Hidden truth with several clues and unlock conditions, so one failed roll can't end the story. A `reveal` shows the player the clue for the current scene, or the first clue if this scene has none, and never the truth |
| **Variant** | Seed-chosen alternatives, such as who the spy is |
| **Beat** | Event in the director's pool, with conditions and a weight |

A scene's `check` and `results` are the only part tied to rules. The system's schema validates the check, and `check-pack` confirms that each result uses a declared outcome and that all outcomes are covered:

```yaml
- id: road-ambush
  text: Two dead horses block the trail.
  choices:
    - label: "[Perception] Check the treeline"
      check: { skill: perception, dc: 12 }   # validated by the dnd5.5e plugin
      results:
        success:
          - { kind: setFlag, flag: spotted-ambush }
          - { kind: goto, scene: ambush-prepared }
        failure:
          - { kind: goto, scene: ambush-surprised }
```

Scene checks are made by the player's character.

**Encounter outcomes.** An encounter can branch on how it ends, using three optional lists of story effects. These keys belong to the story, and the rest of the entry goes to the system's encounter schema:

```yaml
- id: rearguard
  monsters:
    - { monster: "srd52:monster/goblin-warrior", count: 3 }
  onVictory: [{ kind: setFlag, flag: road-clear }]
  onDefeat: [{ kind: goto, scene: captured }]
  onFlee: [{ kind: goto, scene: back-at-camp }]
```

| Ending | With the list | Without it |
|---|---|---|
| **Win** | The choice's remaining effects run, then `onVictory`. Its `goto` replaces the choice's own | The choice's remaining effects run |
| **Party down, player's character alive** | `onDefeat` runs and the choice's remaining effects are dropped | The run ends in defeat |
| **Fleeing** | The player can flee on their turn. `onFlee` runs and the choice's remaining effects are dropped | Fleeing isn't offered |
| **Player's character dead** | The run ends in defeat | The run ends in defeat |

An outcome with no `goto` leaves the party in the current scene. The engine tells the system what's allowed through the third argument of `startEncounter`, `{ canFlee, defeatContinues }`, and the system reports the ending as an `encounterEnded` outcome, keeping `partyDefeated` for a loss the run can't survive. A system with no such rules can ignore the argument.

**Party scaling and rests** are the D&D plugin's. An encounter's optional `forPartySize` says how big a party its monster counts were written for, and each count scales to the living party when the fight starts, rounded and never below 1. The plugin's `shortRest` effect spends hit dice between fights.

**The director** is a plain function that picks the next beat from the eligible ones, using the seed and current state. It also answers `gmOpportunity` events. If an adventure has no eligible beats, the base story continues as written.

**Companions** are split between the engine and the system, so any party works in any adventure:
- **The system** builds the character through `createCharacter`.
- **The engine** holds personality, goal, secret and loyalty. Loyalty thresholds trigger arguments, departures or betrayals, and prep writes their voices.
- **Adventures** only offer hooks, such as "a companion with a reason to hate goblins".

**Adventure plugin layout**

```text
plugins/adventures/<id>/
  plugin.yaml
  adventure.yaml    # title, starting scene
  scenes.yaml
  npcs.yaml
  factions.yaml
  secrets.yaml
  encounters.yaml   # validated by the system's encounter schema
  variants.yaml
  beats.yaml
  assets/
  monsters/ equipment/ ...   # optional: any content folder its system registers
```

Published adventures bring their own monsters, NPC stat blocks and magic items, so an adventure can hold any content folder its system registers. These files use the same schemas as a rules plugin and are namespaced by the adventure's ID, so a module needs no companion rules plugin.

An adventure targets one system. Running it under another means a converted copy, as with converting a book at a real table. Conversion note: Lost Mine and Phandelver and Below predate the 2024 rules, so plugins for them need their monsters and rule references updated.

### 7.1 Rests at the campfire

A scene decision also offers `rest:short` and `rest:long`, from the system's optional `rests(state)` hook (`engine/story/runtime.ts`). A rest is allowed once per scene visit (`story.restedIn`) and never on a scene with `rest: false`. Answering one is an ordinary input, so saves replay it.

The D&D plugin (`availableRests` in `core/rest.ts`) allows a Short Rest at any time out of combat, and a Long Rest when there has been none yet or 24 hours have passed since the last one began. Only rests pass time: 1 hour and 8 hours.

`engine/shell/campfire.ts` puts a campfire button in the top bar. Its dialog asks which rest, plays the rest's own questions (such as spending Hit Dice), then lists what came back by comparing each sheet before and after. It knows no rule system. The test bot never rests, so balance numbers leave rests out.

**Gaps:** rests don't advance adventure clocks, and a Long Rest the story triggers ignores the 24-hour rule.

### 7.2 Narration and ambience

**Ambience.** A scene may name an `ambience` (`wind`, `cave`, `town`, `rain`, `storm`, `campfire` or `none`). Without one, `guessAmbience` in `engine/story/ambience.ts` picks one from words in the text. `engine/shell/ambience.ts` makes each soundscape with Web Audio from looped noise, filters and random one-off sounds, so there are no sound files. A new scene crossfades, and a fight or the narrator ducks it.

**Narration.** `engine/story/narration.ts` names each clip `<voice>/<hash of the text>.mp3` under the adventure's `narration/` folder, so changed text is a new clip. `narration/index.yaml` holds ids, hashes and durations, never text. The loader skips that folder and leaves it out of the plugin hash.

- **Made ahead:** `npm run narrate -- <adventure> [--voice=…]` (`app/cli/narrate.ts`) reads each scene once with Kokoro-82M in Node and encodes it with `ffmpeg`. It runs only on adventures under `books/`, skips unchanged text, and removes a changed text's old clip.
- **Read in the app:** when a clip is missing, `engine/shell/narration-worker.ts` reads the scene in a worker, a sentence at a time, on WebGPU or else WASM. `narration.ts` reads ahead the scenes the current choices lead to, because a CPU reads slower than speech, and restarts a worker that stays silent too long. If no voice can be had, the controls hide rather than fall back to a system voice.
- **Settings** live in the Sound panel (`sound-panel.ts`), from the game menu.

### 7.3 Adventure covers

The main menu shows each adventure as a cover card (`engine/shell/adventure-picker.ts`) with a title plate under the picture. A cover is an entry in a `books/assets/<folder>/index.json` art index with `cover: [<adventure id>, …]`. An adventure with no cover, or one whose picture won't load, still gets a designed card with its title and levels. The shipped adventures have none.

### 7.4 Roll history, Leads and rewind

The Journal drawer has three tabs (`engine/shell/journal-tabs.ts`):

- **Story:** the log so far.
- **Rolls:** every die rolled, oldest first, such as "Sera · Longsword → Goblin · 14 + 5 = 19 vs AC 15 ✓". The system writes each line through the optional `SystemUi.roll(event, stateBefore, access)` seam, so the shell knows no rules. A "Why?" button beside the ticker shows the latest choice's rolls. The D&D plugin's saving throws emit a `dnd5.5e:saveRolled` event that only this history reads.
- **Leads:** the clues `reveal` has shown, grouped by secret with the newest first. Only the clue text appears, never the secret.

**Rewind.** A system setting option can set `undo: true`, as D&D's Story difficulty does. Then the game menu offers "Undo last choice" (shortcut `z`). `undo()` in `session.ts` drops the last input and tells the log again (`retell`), as loading does, then autosaves. The dice live in the state, so making the same choice again rolls the same numbers.

## 8. The D&D 5.5e system plugin

Everything in this section lives in `plugins/systems/dnd5.5e`. The rest of the design doesn't depend on it.

### 8.1 Modeling decisions

**D&D classes aren't TypeScript classes.** A `Fighter extends Character` hierarchy breaks on multiclassing, and new books would need new code. Instead:

- **Content is immutable data.** Classes, spells and monsters are validated records in the registry.
- **State is minimal and serializable.** It records what happened, such as choices, damage and spent resources.
- **Derived values are computed.** AC, save DCs, attack bonuses and slot counts come from pure functions and are never stored.
- **Behavior is a fixed set of interpreters.** New content adds data, and only a genuinely new mechanic adds code.

### 8.2 Rules this model must fit

Checked directly against the SRD 5.2 text, because these are the details that would change the schema:

| Rule | Consequence for the design |
|---|---|
| Backgrounds supply ability increases from a list of three, plus an Origin feat, skills and a tool | `Background` holds these, and the increase is a recorded choice |
| Species supply creature type, size, Speed and traits, but no ability increases | `Species` has no ability field |
| All 12 classes gain their subclass at level 3 | Stored per class as level data, not hardcoded |
| Weapons each have a mastery property, usable only if unlocked | Weapon data plus a per-character choice |
| Feats are Origin, General, Fighting Style or Epic Boon | `category` is a required field |
| Only one AC calculation applies at a time | Base formulas are alternatives, and bonuses are separate |
| Advantage never stacks, and advantage and disadvantage cancel | Modeled as flags, not counters |
| Damage order: adjustments, then Resistance (round down), then Vulnerability. Multiple instances count once, and Immunity means no damage of that type | One tested pipeline |
| An effect that forces several targets to save at once rolls its damage once for all of them, and a successful save usually halves it, rounded down | Damage belongs to the resolution, not to each target's outcome |
| Different spells' effects add. The same spell's effects don't combine: the strongest applies, or the most recent if equal | Every active effect has a source ID |
| Concentration save DC is the higher of 10 or half the damage, to a maximum of 30. It also ends on Incapacitated, death or a new Concentration effect | Handled in one rule |
| Exhaustion is cumulative: D20 Tests drop by 2 per level, Speed by 5 feet per level, and level 6 is death. A Long Rest removes 1 | Stored as a level, with effects computed |

### 8.3 Closed sets

```ts
export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export const AbilitySchema = z.enum(ABILITIES);
export type Ability = z.infer<typeof AbilitySchema>;
```

Skills, damage types, conditions, mastery properties, spell schools, feat categories and rest types all follow this pattern. Conditions and damage types are closed because the rules code branches on them. Content can use them but can't add to them.

### 8.4 Features: the shared building block

Class features, species traits, feats, magic item powers and monster abilities all share one shape, so one interpreter handles all of them.

```ts
export const FeatureSchema = z.object({
  id: FeatureIdSchema,
  name: z.string(),
  text: z.string(),                              // always available to read
  automation: z.enum(["full", "partial", "text"]),
  passives: z.array(PassiveSchema).default([]),   // always-on modifiers
  activations: z.array(ActivationSchema).default([]),
  resources: z.array(ResourceDefSchema).default([]),
});
```

| `automation` | Meaning |
|---|---|
| `full` | The plugin applies the feature completely |
| `partial` | The plugin handles the numbers, and the rest becomes a prepared choice or a note to you |
| `text` | Readable only. `check-pack` reports these |

### 8.5 Classes and progression

```ts
export const ClassSchema = z.object({
  id: ClassIdSchema,
  name: z.string(),
  hitDie: z.enum(["d6", "d8", "d10", "d12"]),
  primaryAbilities: z.array(AbilitySchema).min(1),
  savingThrows: z.array(AbilitySchema),
  proficiencies: ProficienciesSchema,
  multiclass: MulticlassRulesSchema,
  spellcasting: SpellcastingSchema.optional(),
  levels: z.array(ClassLevelSchema).length(20),
});

export const ClassLevelSchema = z.object({
  level: z.number().int().min(1).max(20),
  grants: z.array(FeatureIdSchema).default([]),
  choices: z.array(ChoiceDefSchema).default([]),
  scaling: z.record(z.string(), z.number()).default({}), // such as rage damage
});
```

Choices are first-class data, so character creation, level-up and companion generation all use the same flow:

```ts
export const ChoiceDefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subclass"), id: ChoiceIdSchema }),
  z.object({ kind: z.literal("feat"), id: ChoiceIdSchema, category: FeatCategorySchema }),
  z.object({ kind: z.literal("skills"), id: ChoiceIdSchema, count: z.number(), from: z.array(SkillSchema) }),
  z.object({ kind: z.literal("weaponMastery"), id: ChoiceIdSchema, count: z.number() }),
  z.object({ kind: z.literal("spells"), id: ChoiceIdSchema, count: z.number(), maxLevel: z.number(), list: ClassIdSchema }),
  z.object({ kind: z.literal("option"), id: ChoiceIdSchema, count: z.number(), from: z.array(FeatureIdSchema) }),
]);
```

Subclasses have the same level structure and point to a parent class. Species, backgrounds and feats are smaller records that also grant features and choices.

### 8.6 Spells, equipment and monsters

```ts
export const SpellSchema = z.object({
  id: SpellIdSchema,
  name: z.string(),
  level: z.number().int().min(0).max(9),
  school: SpellSchoolSchema,
  classes: z.array(ClassIdSchema),
  castingTime: CastingTimeSchema,
  ritual: z.boolean(),
  range: RangeSchema,
  components: ComponentsSchema,
  duration: DurationSchema,                       // includes concentration
  text: z.string(),
  automation: AutomationSchema,
  activation: ActivationSchema.optional(),        // absent when text only
  upcast: UpcastSchema.optional(),
});
```

- **Equipment** is a discriminated union of `weapon`, `armor`, `shield`, `gear`, `tool` and `magicItem`. Weapons hold their mastery property, and armor holds its AC formula and restrictions. Magic items grant features while equipped or attuned.
- **Monsters** are stat blocks that use the same `FeatureSchema` for traits, actions, bonus actions, reactions and legendary actions.
- **Shared runtime:** characters and monsters use one actor type during play, so a monster's ability works through the same rules as a player's.

### 8.7 Effects

An activation states its cost, targets and how it resolves. Nesting is **deliberately limited to one level**: a resolution holds a list of leaf effects, and a leaf can't contain another resolution. Section 10.1 explains why this matters for the local model.

```ts
export const AmountSchema = z.object({
  dice: DiceSchema.optional(),                 // 8d6
  bonus: FormulaSchema.optional(),             // spellcasting modifier
});

export const DamageSchema = z.object({ amount: AmountSchema, type: DamageTypeSchema });

export const ModifierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bonus"), to: BonusTargetSchema, amount: AmountSchema }), // AC, attacks, saves
  z.object({ kind: z.literal("advantage"), on: RollTargetSchema }),
  z.object({ kind: z.literal("disadvantage"), on: RollTargetSchema }),
  z.object({ kind: z.literal("resistance"), damage: DamageTypeSchema }),
  z.object({ kind: z.literal("vulnerability"), damage: DamageTypeSchema }),
  z.object({ kind: z.literal("immunity"), damage: DamageTypeSchema }),
  z.object({ kind: z.literal("acFormula"), formula: FormulaSchema }),
]);

export const LeafEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heal"), amount: AmountSchema }),
  z.object({ kind: z.literal("tempHp"), amount: AmountSchema }),
  z.object({ kind: z.literal("applyCondition"), condition: ConditionSchema, duration: DurationSchema }),
  z.object({ kind: z.literal("removeCondition"), condition: ConditionSchema }),
  z.object({ kind: z.literal("modifier"), modifier: ModifierSchema, duration: DurationSchema }),
  z.object({ kind: z.literal("forcedMove"), feet: z.number(), direction: PushDirectionSchema }),
  z.object({ kind: z.literal("note"), text: z.string() }),
]);

export const ResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("automatic"), damage: z.array(DamageSchema).default([]),
             effects: z.array(LeafEffectSchema) }),
  z.object({ kind: z.literal("attack"), attack: AttackDefSchema, damage: z.array(DamageSchema),
             onHit: z.array(LeafEffectSchema), onMiss: z.array(LeafEffectSchema) }),
  z.object({ kind: z.literal("save"), ability: AbilitySchema, dc: FormulaSchema,
             damage: z.array(DamageSchema).default([]),   // rolled once per activation
             onSuccessDamage: z.enum(["half", "none"]).default("none"),
             onFail: z.array(LeafEffectSchema), onSuccess: z.array(LeafEffectSchema) }),
]);

export const ActivationSchema = z.object({
  cost: z.array(CostSchema),                   // action, bonus action, reaction, slot, resource
  trigger: TriggerSchema.optional(),           // for reactions
  targeting: TargetingSchema,                  // self, creatures with count and range, or area
  resolution: ResolutionSchema,
});
```

Anything that doesn't fit becomes `partial` or `text`, and the vocabulary grows only when real content needs it. Unusual spells such as *Wish* may stay `text` or get handwritten code.

Every `switch` over `kind` ends with an exhaustive check, so adding an effect type produces a compile error wherever it isn't handled.

**Test encodings.** I worked these entries through the schema by hand against the SRD text. My first draft couldn't express shared damage rolls, healing dice or ability bonuses on damage, and these shapes are the corrected version. They become permanent test fixtures:

```yaml
- name: Fireball            # automation: full
  cost: [action, slot]
  targeting: { area: { shape: sphere, radius: 20 }, range: 150 }
  resolution:
    kind: save
    ability: dex
    dc: { add: [{ kind: spellSaveDc }] }
    damage: [{ amount: { dice: 8d6 }, type: fire }]
    onSuccessDamage: half
  upcast: { perSlotLevel: { addDice: 1d6 } }

- name: Cure Wounds         # automation: full
  cost: [action, slot]
  targeting: { creatures: 1, range: touch }
  resolution:
    kind: automatic
    effects:
      - { kind: heal, amount: { dice: 2d8, bonus: { add: [{ kind: spellMod }] } } }
  upcast: { perSlotLevel: { addDice: 2d8 } }

- name: Longsword attack    # built by the plugin from weapon data
  resolution:
    kind: attack
    attack: { type: weapon, ability: str }
    damage:
      - { amount: { dice: 1d8, bonus: { add: [{ kind: abilityMod, ability: str }] } }, type: slashing }

- name: Bless               # automation: full
  cost: [action, slot]
  targeting: { creatures: 3, range: 30 }
  resolution:
    kind: automatic
    effects:
      - { kind: modifier, duration: { concentration: true, minutes: 1 },
          modifier: { kind: bonus, to: attacks, amount: { dice: 1d4 } } }
      - { kind: modifier, duration: { concentration: true, minutes: 1 },
          modifier: { kind: bonus, to: saves, amount: { dice: 1d4 } } }
  upcast: { perSlotLevel: { addTargets: 1 } }

- name: Shield              # automation: partial
  cost: [reaction, slot]
  trigger: { hitByAttack: true, targetedBySpell: magic-missile }
  targeting: { self: true }
  resolution:
    kind: automatic
    effects:
      - { kind: modifier, duration: { until: yourNextTurnStart },
          modifier: { kind: bonus, to: ac, amount: { bonus: { base: 5 } } } }
      - { kind: note, text: Magic Missile immunity is not yet automated }
```

Weapon options such as Finesse are handled by the plugin when it builds the attack. On a *Shield* trigger, the plugin holds the hit in a pending frame (section 6.2) and rechecks it against the new AC.

### 8.8 Formulas

Formulas are a flat sum, with no expression language:

```ts
export const FormulaSchema = z.object({
  base: z.number().default(0),
  add: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("abilityMod"), ability: AbilitySchema }),
    z.object({ kind: z.literal("proficiency") }),
    z.object({ kind: z.literal("classLevel"), class: ClassIdSchema }),
    z.object({ kind: z.literal("scaling"), key: z.string() }),
    z.object({ kind: z.literal("spellMod") }),
    z.object({ kind: z.literal("spellSaveDc") }),
  ])).default([]),
  min: z.number().optional(),
});
```

### 8.9 Actor state

An actor stores only what can't be computed:

```ts
export interface CharacterBuild {
  readonly baseAbilities: Readonly<Record<Ability, number>>;
  readonly speciesId: SpeciesId;
  readonly backgroundId: BackgroundId;
  readonly backgroundIncrease: BackgroundIncrease;   // +2/+1 or +1/+1/+1
  readonly levels: readonly LevelUpRecord[];         // one per level gained
}

export interface LevelUpRecord {
  readonly classId: ClassId;                         // multiclassing is just this varying
  readonly hitPointGain: number;
  readonly answers: readonly ChoiceAnswer[];
}

export interface Actor {
  readonly id: ActorId;
  readonly source:
    | { readonly kind: "character"; readonly build: CharacterBuild }
    | { readonly kind: "monster"; readonly statBlockId: MonsterId };
  readonly hp: number;
  readonly tempHp: number;
  readonly deathSaves: { readonly successes: number; readonly failures: number };
  readonly exhaustion: number;
  readonly heroicInspiration: boolean;
  readonly turn: TurnBudget;                         // action, bonus action, reaction, movement used
  readonly resourcesSpent: Readonly<Record<string, number>>;
  readonly activeEffects: readonly ActiveEffect[];   // each has sourceId and casterId
  readonly concentratingOn: ActiveEffectId | null;
  readonly inventory: readonly ItemInstance[];
  readonly position: GridPosition | null;            // null outside combat
}
```

Run-level D&D state, held alongside the actors, covers initiative order and the round number.

`deriveStats(actor, registry)` is a pure function that returns abilities, proficiency bonus, AC, speed, save and skill bonuses, spell DC, maximum HP, available slots, resistances and active condition effects. It is recalculated rather than stored, and caching waits until it proves slow.

The resolution order follows section 8.2. For example, AC is the best available base formula (with an option to choose another) plus all bonuses. Damage is tested against the SRD's own worked example, where 28 Fire damage with a −5 aura, Resistance to all damage and Vulnerability to Fire ends at 22.

### 8.10 Resources

One pool type covers spell slots, Pact Magic, Rage, Second Wind, once-per-turn features and monster recharge abilities:

```ts
export const ResourceDefSchema = z.object({
  id: ResourceIdSchema,
  max: FormulaSchema,
  recharge: z.array(z.object({
    on: z.enum(["turnStart", "shortRest", "longRest", "dawn"]),
    amount: z.union([z.literal("all"), z.number()]),
    rollAtLeast: z.number().optional(),          // monster abilities such as Recharge 5-6
  })),
});
```

Multiclass spell slots are computed using the SRD's multiclass table, and Pact Magic stays a separate pool.

### 8.11 Frames

The plugin registers frames such as `dnd5.5e:resolveAttack`, `dnd5.5e:applyDamage` and `dnd5.5e:concentrationSave`. These model chains such as an attack triggering *Shield*, then damage triggering a Concentration save, or movement triggering an Opportunity Attack.

### 8.12 What step 4 has built so far

**Content:** four level 1 pregens, and Fighter, Rogue, Cleric and Wizard from level 1 to 5 with one subclass each, three species, three monsters, the SRD's 339 spells, and enough of the rest of the SRD to support them. The adventures can also bring their own monsters, as the Goblin Chief does. A potion of healing, a ring of protection and a spell scroll of *Magic Missile* give the sample adventures loot.

| Automation | Content |
|---|---|
| `full` | Weapon attacks, Extra Attack, Second Wind, Fire Bolt, Sacred Flame, Cure Wounds, Healing Word, Bless, Fireball, Magic Missile |
| `partial` | Sneak Attack, Shield (no Magic Missile immunity) |
| `text` | Fighting Style, Weapon Mastery, Expertise, Thieves' Cant, Spellcasting, Divine Order, Ritual Adept, Arcane Recovery, species traits, origin feats, Sleep |

**Characters run through the engine's decision system too** (`core/character.ts`, `core/rest.ts`), so the terminal and the UI need nothing of their own:
- **Creation:** the player takes a pregen or creates a character: class, species, background, the standard array one score at a time, the background increase, then the level's choices one pick at a time. Gear is picked automatically.
- **In-progress choices live in frames** on the stack, with `awaitDecision`, so a save mid-creation resumes in place and the state schema gains nothing but `xp`. The finished character arrives as the existing `characterChosen` event.
- **What a level asks for** comes from `levelChoices`. A class can state `choices`, and imported classes don't, so the rest is read from the level's grants (a name ending `-subclass`, `-ability-score-improvement`, `-fighting-style` or `-epic-boon`) and how `scaling.cantrips`, `scaling.preparedSpells` and `scaling.weaponMastery` change. A stated choice replaces an inferred one with the same id. The same convention reads Extra Attack and Pact Magic from their names.
- **Levelling:** the story decides. `dnd5.5e:awardXp` adds XP, and `dnd5.5e:levelUp` is a milestone that awards whatever reaches the next level, so one number drives both. Hit points use the fixed value (half the die plus one), and a higher Constitution raises every earlier level too. Content can stop short of level 20, and characters then stay where they are.
- **Rests:** `dnd5.5e:shortRest` lets the player spend Hit Dice one at a time, and `dnd5.5e:longRest` restores HP, Hit Dice and slots, clears temporary HP and removes one level of Exhaustion. Features recharge from their `resources` data, and Pact Magic slots return on a Short Rest.
- **Rests, gear, shops and carrying** have their own sections: 7.1, 8.13 and 8.14.
- **Companions** get their personality from `rollCompanions` and their character from the same steps the player answers, answered by policy with the world dice, so each run differs. They favor their class's abilities and spells that do something in play, avoid repeating a class, and level whenever the player does.

**To finish this for an imported book,** parse it again with `npm run import -- parse`. That adds what older imports lack: each class's skill list (until then, any two skills), Martial weapon limits such as the Rogue's (`martialWeaponProperties`, until then all Martial weapons), and the new `subclasses` kind (until then the subclass choice is skipped).

**Combat runs through the engine's decision system.** Initiative and turns are handled entirely by the plugin, and simple code-based tactics play monsters and companions: heal an ally below half HP, otherwise attack the weakest enemy, stepping toward the nearest foe they can hurt by the shortest walk. Companions use cantrips and weapons, and spend at most one spell slot a turn, on a spell that isn't already running.

**The grid:** without a battle map, the party starts along the bottom edge and the enemies 30 feet away along the top. An encounter's `battlemap` (`BattlemapSchema`) instead places the fight on part of a book picture, cut to whole squares, with walls (`#` in one string per row) and each side's start squares. Walls block movement and placement. The schema checks that the party can walk to a monster.

**Conditions** apply in play: advantage and disadvantage on attacks (Blinded, Frightened, Invisible, Paralyzed, Poisoned, Prone near or far, Restrained, Stunned, Unconscious and the like), automatic failure of Strength and Dexterity saves while Paralyzed, Petrified, Stunned or Unconscious, disadvantage on Dexterity saves while Restrained, Speed 0 while Grappled, Restrained or Incapacitated, and Incapacitated ending Concentration.

**Dying:** the SRD's death saves, Stable at three successes, and Massive Damage all apply. **If the player's character dies, the run ends, even if companions win the fight.** That's a design choice, because the story follows the player, and could change once there's a way to carry on with another character.

**Deliberately cut for now, each with a `shortcut:` comment where it applies:**
- **The grid:** no difficult terrain, cover, line of sight or creature sizes, and no flanking. An Opportunity Attack checks only where a move starts and ends.
- **Character building:** no multiclassing, swapping prepared spells, feat prerequisites, feat ability increases other than Ability Score Improvement, or starting gear from the class tables. Expertise, Eldritch Invocations and other options with no choice data stay as text. Companions' classes don't follow their personalities.
- **Spell rules:** no swapping prepared spells or one-spell-slot-per-turn rule. Upcasting works for spells whose data has `upcast`, and cantrips scale by tier from their `cantrip` data.
- **Other rules:** no Arcane Recovery, weapon mastery effects or armor training limits, and forced movement is stored in data but does nothing yet. Section 8.17 lists which class features work.
- **Recovery after a fight:** anyone down but not dead gets back up with 1 HP, since an adventure doesn't have to offer a rest. HP otherwise carries over between fights.
- **Branded IDs:** content IDs are checked strings, not per-kind branded types as section 4.4 planned.

### 8.13 Loot and gear

`core/gear.ts` handles treasure and what each character carries.

- **Treasure** comes from the story effect `dnd5.5e:treasure` `{ gold?, items? }`, or from an encounter's `loot`, which is granted only on a win. Item ids are checked through the `references` hook on `storyEffect()`, so the plugin loader, and with it `check-pack`, catches a typo. A `treasureFound` event adds the coins and items to the player's character. Companions never carry loot.
- **The pack:** `Actor.stowed` holds what's carried but not worn, and `Actor.attuned` up to three magic items. Both are optional, so pregens and older saves keep everything worn. Stowed weapons, armour and shields give no attack or AC. Putting on armour or a shield stows the one worn before. Every change is a `gearChanged` event with the full lists.
- **Attunement:** an attuned magic item, or one that needs no attunement, adds its bonuses. Attuning happens during a Short Rest.
- **When gear changes:** the **Found card** (`SystemUi.card`, shown above the choices with the purse it went into) offers "Equip X" for found weapons, armour and shields. A Short Rest offers "Change gear" when something can be equipped or attuned. The Character drawer's Equipment rows show Equip, Stow, Attune and End attunement buttons whenever the pending decision offers them, and only on the deciding character's sheet.
- **Items in a fight:** an item with `healing` becomes "Drink X" (a Bonus Action), and a magic item with a `spell` becomes "Read X" for spellcasters, with no slot spent. Both sit in an Items tab and are used up by a `useItem` frame once the action resolves.

### 8.14 Shops and carrying

**Shops** (`core/shop.ts`): the story effect `dnd5.5e:shop` opens a merchant with `merchant`, a `stock` of item ids (each with an optional `price` in gp and a `quantity`) and a `discount` percent. Prices come from each item's `costCp`, and selling pays half, rounded down to the copper. An item with no cost, such as every magic item today, can't be sold. Each step is a decision (`dnd5.5e:shop:<n>`) with Leave first, answered by a `traded` event, so saves replay it. Sales are kept per merchant name (`shopBought`), so limited stock stays sold on later visits. A friendlier price is the adventure's to give: gate two trade choices on an attitude's `atLeast` and `atMost`. Gold keeps copper as hundredths of a gp, shown by `coins()` as "12 gp, 5 sp". The shell draws the panel through the optional `SystemUi.shop` hook (`engine/shell/shop.ts`) in place of the choices.

**Carrying** (`core/carry.ts`): capacity is Strength × 15 lb (× 7.5 Tiny, × 30 Large), from the items' `weightLb`. Past it, Speed is at most 5 feet, and past twice it, 0. Coins weigh nothing. The importer reads Cost and Weight for weapons, armour, shields and gear, so an older import needs `npm run import -- parse` again before those have a price or weight.

### 8.15 Legendary actions, lairs and surprise

`core/legendary.ts` holds boss fights and ambushes. `MonsterSchema` gains optional `legendary`, `legendaryResistance` and `lairActions`. A stat block imported before them has them read from its printed text at run time (`legendOf`), as Multiattack is.

- **Legendary actions:** right after another creature's turn, each monster with a use left may take one. `runFinishTurn` splits off `runAdvanceTurn` (frame `dnd5.5e:advanceTurn`) so they run between turns. A legendary move toward a target never provokes Opportunity Attacks.
- **Legendary Resistance** turns a failed save into a success while uses remain. "Per day" is per fight, since a monster exists for one fight.
- **Lair actions:** an encounter's `lair` takes them on initiative count 20, losing ties.
- **Surprise:** an encounter's `surprise` (`party` or `enemies`), or the story effect `dnd5.5e:surprise`, such as after a Stealth check, makes that side roll initiative with disadvantage. The story's word beats the encounter's.
- **Fleeing:** when the encounter allows it, the player may flee on their turn. Every foe that can reach them gets an Opportunity Attack first, unless they Disengaged, and the party gets away if the player is still standing. Companions run with the player and draw no attacks.

### 8.16 Spell targeting

`core/targeting.ts` is pure geometry with no rolls and no content, so the combat board uses the same rules as the engine.

- **Choosing targets:** a spell with one target is offered once per creature. One with more targets, or with darts and rays, opens a follow-up decision (frame `pickTargets`, options `+id`, `-id`, Cast and Back), like choosing where to move. Darts and rays may go at the same creature more than once, and all must be aimed before casting. `targetCount` scales with the slot.
- **Aiming areas:** on a grid, an area opens frame `aimArea`. A cone, line or cube from the caster is aimed by one of the eight squares around them, named by direction, and any other area at a square in range. The area catches everyone in it, both sides and the caster (`caughtBy`), and the option says who. Emanations, and areas with no grid, keep catching one side.
- **The AI** scores each aim with `aimScore` (foes caught against allies caught, the caster counting most) and drops aims worth nothing, so it avoids hitting its own side where it can.
- **The board** lights covered squares on hover, and rings picked and caught tokens.

Saves that answered a multi-target `|all` option, or a gridded area aimed at a creature, still load from their events but no longer replay from their inputs, since those options are gone. `SAVE_FORMAT_VERSION` stayed at 1 (section 9).

### 8.17 Class-feature audit

`npm run class-features` (`tests/class-features.ts`) levels every class and subclass from 1 to 20 through the real level-up decisions and checks each feature gained against what the engine does with it. It writes [class-features.md](class-features.md), with each feature marked working, partial or text-only and why. It reads the imported classes under `books/`, and falls back to SRD content without them.

Mechanics for features that are text in the content live in `core/feature-rules.ts`, by feature id: ids and numbers only, merged in at the one lookup in `stats.ts`. It also holds always-prepared subclass spells (`grantedSpells`). `core/class-rules.ts` holds the turn-based recharges, a wider critical range, and spending Heroic Inspiration on a reroll after a missed attack.

## 9. Saves

```ts
export interface SaveFile {
  readonly formatVersion: number;
  readonly system: { readonly id: string; readonly version: string };
  readonly plugins: readonly { id: string; version: string; hash: string }[];
  readonly seed: string;
  readonly log: readonly { input: Input; events: readonly GameEvent[] }[];
}
```

`engine/kernel/save.ts` holds the format, `SAVE_FORMAT_VERSION` (1), loading and replay. `engine/shell/session.ts` decides when to write and how saves are listed.

- **Loading** checks the file with Zod, checks every system event against its schema, and rebuilds state by applying the recorded events, so it doesn't re-roll dice and is safe if content later changes. The shell then tells the log again (`retell`) to rebuild the story text, rolls and leads.
- **Replay checking:** `replayInputs` runs the inputs again from the seed. The tests confirm that the same events and final state come out. This is the core determinism test.
- **Refusals and warnings:** a different `formatVersion`, a different system or a missing plugin stops the load with a clear message rather than risking the save. A plugin whose hash has changed only warns.
- **Migrations aren't implemented.** Any other `formatVersion` is refused, so a format change today would orphan old saves. See [issue #35](https://github.com/yonatankarp/re-roll/issues/35). Rule changes don't bump the version either: a save whose answers a newer build no longer offers still loads from its events, but `replayInputs` on it fails (section 8.16).
- **Autosaves:** each run has one, `saves/<adventure>-<seed>-autosave.json`, written after the start, every choice and every undo. Starting the same seed again replaces it. A failed autosave warns and play carries on. Continue on the main menu loads the newest save.
- **Manual saves** from the game menu each get a file of their own. Only a run's own autosave is ever overwritten.
- **Save cards:** the Load screen (`engine/shell/load-screen.ts`) lists saves newest first, as cards with the adventure, character, health, scene, party level, settings such as the difficulty, and scene art. It deletes on a second press. The save format has no clock and no card data, so two records sit beside the saves: `saves/times` (path to ISO time, kept in its old shape so older builds can read it) and `saves/details` (what each card shows). A save made before details existed shows a bare card until it's next loaded.
- **Where they live:** the browser and the Tauri app keep saves in the webview's `localStorage`, under `saves/` (`withSaves` in `engine/platform/browser/storage.ts`). Content stays read-only, and only `saves/` paths can be written. That store is about 5 MB and tied to the page's origin, so another dev-server port has its own saves. Moving them to real files is still to do. `npm run play` writes files under `<dir>/saves` through Node storage.
- **Writes:** Node storage writes a temporary file and renames it, so a crash can't destroy a save. `localStorage` writes one key at a time, which is atomic per save.
- **Snapshots** wait until loading is actually slow.

## 10. Session prep

Prep is a background job in the engine that never changes game state. The same logic runs from a Node command during development and from the Tauri app when packaged, through the interfaces in section 3. It reads the plugins and the save log, then writes an overlay:

```text
saves/<run>/prep/session-03.json
```

**Pipeline**
1. **Digest:** narrative events and the system's `describeFacts` become plain facts: choices, deaths, attitudes, clocks.
2. **Plan:** the director's logic finds nearby locations, active NPCs and likely beats. This is code, not the model.
3. **Queue:** each item to write becomes a small job, such as one scene description, one conversation or one set of banter.
4. **Write:** one model call per job, with only the facts that job needs and the system's `glossary`.
5. **Check:** parse, verify references and check for spoilers. Retry on failure.
6. **Save:** each finished job is saved immediately, so prep can stop and resume safely.

**At play time:** the game uses overlay text when it's present and valid, and the base adventure text otherwise. It always works, even if prep never ran.

**Model connection:** the `ModelClient` implementations use plain `fetch` to `llama-server`'s OpenAI-compatible endpoint, with no SDK.

### 10.1 Model output can't be trusted

`llama-server` supports schema-constrained output, but its issue tracker reports two relevant failure modes: [silently unconstrained output with a 200 response](https://github.com/ggml-org/llama.cpp/issues/19051), and [`$ref` and `$defs` schemas losing their constraint](https://github.com/ggml-org/llama.cpp/issues/21228). I haven't checked whether these are fixed. The design therefore doesn't rely on the constraint:

- **Schemas for the model are separate** from internal ones: small and non-recursive.
- **They're generated without references**, using [`z.toJSONSchema(schema, { reused: "inline", cycles: "throw" })`](https://zod.dev/json-schema), so a recursive schema fails at build time.
- **Every response is parsed again with Zod.** The constraint is treated as a helpful hint only.
- **Allowed IDs are built into each request's schema** as an enum, so the model chooses from real NPCs and items. Very large lists may be slow, so this needs testing.
- **Failures are bounded:** after a set number of retries, that job falls back to base text and the failure is logged.

This is why effects in section 8.7 have only one level of nesting. It also means the book importer can use the same constraint.

### 10.2 Secrets

Prep needs some secrets to write good foreshadowing, so a job's prompt only gets those the director has allowed for that job. Locked secrets can list spoiler terms that cause a rejection if they appear in the output. This catches direct leaks but not paraphrases, so some spoilers could slip through.

## 11. Book importer

The importer turns the owner's saved book pages and PDFs into private plugins under `books/`, which git ignores, with no manual review. It never logs in to or downloads from D&D Beyond. Whether exporting fits D&D Beyond's terms is the owner's call.

**How each kind of content gets in**

| Content | Method |
|---|---|
| Monsters, classes, subclasses, features, species, backgrounds, feats, equipment, magic items, roll tables, lookups, traps, hazards, poisons, bastions, companions | Code parses the HTML with `npm run import -- parse`, and `approve` creates the private plugin |
| Spell facts and text | Code. A spell whose text matches a reviewed SRD spell reuses its mechanics |
| Spell, class feature, feat and species trait mechanics that code can't read | Claude agents encode them, then code checks them. They write mechanics only, and code copies the book's wording |
| Adventures | Agents write the scene graph in their own words, and `tests/tools/fill-read-aloud.ts` copies read-aloud text |
| Reference library | `npm run import -- library` writes each book's sections and an index to `books/library/` |
| Images | `pdfimages` from local PDFs to `books/assets/`, matched to monsters and scenes by page |

Leaving out `--encodings` on `draft` uses the local model instead, which is free but slower and less accurate.

**Rules when re-importing**
- Never run `approve --all` on PHB features, feats, species or spells: their mechanics and choices exist only in the approved files.
- Each feat grants a feature of its own text (`feature/feat-<slug>`), which holds its mechanics. A species' or feat's `choices` are asked at character creation, and a choice of lineage or ancestry picks one feature among several.
- Parse subclasses and backgrounds with `--requires phb`.
- A book's plugin id can't match an adventure's, so book plugins use a `-rules` suffix in that case.
- Older-edition content is marked and kept out of the character builder by default.

### 11.1 Accuracy

An independent audit checked 145 encoded spells and 120 monsters against their own text: 12.4% of spells and 16.7% of monsters were wrong in play. The monster parser's systematic errors and the spell errors the engine can now express were then fixed, but the audit wasn't re-run, so current rates are unmeasured. `books/audit/mechanics-audit.md` holds the list. Local model encodings were worse, at about a quarter wrong among those it accepted.

**Known gaps:** the extra parsing since the audit is unaudited, including the 2014-format books. Monster matches and scene art are by page and unchecked by eye. Many monster abilities and most class features above the priority list stay text only. Sage Advice errata aren't applied.

## 12. Testing

| Check | What it proves |
|---|---|
| Unit tests with fixed seeds | Individual rules, including the SRD's own worked examples |
| Encoding fixtures | The schema can really express sample entries such as *Fireball* and *Shield*, and the plugin resolves them correctly |
| Property tests | Engine: any input keeps state valid. D&D plugin: HP stays in range, advantage and disadvantage always cancel, Resistance never stacks |
| Replay test | Same seed and inputs always produce the same events and final state |
| `check-pack` | Broken references, unreachable scenes, uncovered outcomes, code in data plugins, automation coverage |
| Test bot | Each adventure can be finished, with no dead ends or crashes across many seeds |
| Headless play | The game layer the UI uses offers every choice a decision has, and only those, through whole adventures |
| Second adventure | The engine is adventure-agnostic: it must work with no engine change |
| **Fixture system** | The engine is system-agnostic: a tiny test-only rule system runs a story with no engine change |
| Prep evaluation | You read generated overlays and judge them, as automated checks can't measure writing quality |

**The fixture system** lives in `tests/fixtures/system-d6`. It rolls one d6 with three outcome keys and has no turn order, HP or grid. It isn't a copy of any published game. Because it's so unlike D&D, any D&D assumption that creeps into the engine breaks a test straight away, rather than being discovered when Daggerheart is built.

A failed bot run prints its seed and input list, so any failure can be reproduced exactly.

### Headless play

The bot plays at the engine level, so it can't see what the page shows. Headless play goes through `createGame` in `engine/shell/session.ts`, the same game layer as the UI, with no DOM. `engine/tools/headless.ts` has the driver, and `app/cli/headless-game.ts` wires it to Node storage, the systems and their UIs.

**What counts as on screen** is what `shell.ts` draws from the view. It is the option list, the campfire's rests, and the sheet row buttons, such as Equip. `view()` keeps a row's button only on the sheet of whoever the decision is for, and only while the decision offers it. The driver chooses by a choice's number on screen, its id or its label, and refuses anything that isn't on screen. `act(...ids)` answers ids one after another, as the combat board does, such as `move` then `3,4`. The board itself is only a shortcut: token menus offer the list's own options, and every square it lights is offered once Move is chosen. Dice are rolled inside each answer, so rolling means choosing the option, such as a check or a death save. The board's throw is only animation. Saves, the save list, loading, deleting and restarting are the session's own.

**Stuck states** are reported with every screen as `problems`:

- a decision that shows no choice, or only rests;
- a choice shown that the decision doesn't offer;
- an option the decision offers that nothing shows;
- no decision, before the story has ended.

`tests/headless.test.ts` plays `goblin-ambush` through a fight with a move and an attack, treasure, equipping from the sheet, buying and selling at Tam's camp, a rest, a save and load, an ending and a restart. It also plays random on-screen choices through every adventure. Book adventures run only where `books/` exists.

**The CLI** plays an adventure from a terminal:

```sh
npm run play -- <adventure> [--seed=N] [--difficulty=story|normal|hard] [--saves=dir] [--script=file.json|-]
npm run play -- --load=<n|path> [--saves=dir] [--script=file.json|-]
```

Without an adventure it lists them. Saves go under `<dir>/saves`, which defaults to the current folder. Every step autosaves to `saves/<adventure>-<seed>-autosave.json`. Starting the same seed again replaces that autosave, so `--load` resumes a run, by its number in the save list (newest first) or its path. Content is read-only, and a symlinked `books/`, such as a worktree's link to the main checkout, is read through its real folder.

- **Interactive** prints the screen and numbered choices. It reads a number or label, or `act <ids…>`, `save [name]`, `saves`, `load <n|path>`, `delete <n|path>`, `restart [seed]`, `json` or `quit`.
- **Scripted** (`--script`) reads a JSON array from a file, or one JSON command per line from stdin with `-`, so an agent can read each screen before it sends the next command. A command is a choice: a JSON number is its `n`, and a string is its id or else its label, never a number, since story options have ids such as `"0"`. Or it is or one of `{"choose": ref}`, `{"act": [ids]}`, `{"save": name}`, `{"saves": true}`, `{"load": ref}`, `{"delete": ref}` and `{"restart": seed|null}`. Each command prints one JSON line: `{version, step, command, result?, screen}`. Step 0 is the start. The screen has `version`, `title`, `scene`, `lines` (the log since the last action), `card`, `decision`, `actor`, `prompt`, `choices` (each with `n`, `id`, `label`, `where`, `group` and `detail`), `combat` (its `board` holds the squares to move to), `party`, `ended`, `endingName`, `playerDied`, `warnings` and `problems`. A failed command prints `{version, step, command, error, screen}`, where the screen is the game as it now stands, since an `act` may have answered some of its ids. A file script stops there with status 1. From stdin, play carries on and the exit status is 1 at the end. A failed start or load prints `{version, step: 0, command, error}` and exits with status 1. Any change to that shape bumps `version`.

## 13. Legal and licensing

- **Attribution:** plugins carry their own `attribution`, and the About screen shows it for every loaded plugin.
- **SRD 5.2:** the `srd52` plugin must use the exact attribution statement from the SRD's legal page, and no other credit to Wizards. The game may say "compatible with fifth edition" or "5E compatible". `dnd5.5e` is the internal plugin ID, so any public wording should use one of those two phrases.
- **Book plugins:** stay in `books/`, excluded from git. `npm run desktop:build` fails if a `distribution: private` plugin, a `books/` path or a symlink would be bundled (`npm run check-bundle`, see [release.md](release.md)).
- **Source material:** data plugins come from copies you own. The engine won't include an importer for sites that host unlicensed copies.
- **Daggerheart:** treat its content as private until the license is checked. [The license page](https://darringtonpress.com/license) describes permitted formats and approved virtual tabletops, but doesn't address standalone software. It also lists SRD 2.0 and license 2.0 from August 2026, while I read SRD 1.0, so the mechanics need rechecking before that plugin is built.

## 14. Build order

1. **Foundations (done):** tooling, the SDK, the plugin loader and `check-pack`, with the fixture system and two tiny original adventures kept in `tests/fixtures`.
2. **Prep test (three runs done, awaiting your read):** generate an overlay from a sample log using a model that fits in 16 GB. Judge quality and speed. **If this fails, the design needs rethinking, so it comes early.** See section 16.
3. **Engine kernel and story runtime (done):** turn loop, seeded dice, replay test and test bot, all running against the fixture system. Not included yet: companion loyalty triggers, levels and items, prep digests built from the log, and a smarter director.
4. **D&D plugin core (first slice done):** derived stats, damage pipeline and frames, with both adventures copied to `plugins/adventures` in D&D form and playable from the command line. See section 8.12.
5. **Levels 1–5 content (importer started):** all classes and the monsters they meet. The importer's spell path is built and tested on SRD text, and other kinds of content come next.
6. **UI (first slice done):** the engine shell, in a browser and in Tauri, with the sheet and combat data from `plugins/systems/dnd5.5e/ui`, and the D&D combat board: tokens on a 5-foot grid over the scene's picture, animated dice, hits, damage and movement, and clicking a token or square to act. It previews the route to a square and whether it gives an Opportunity Attack, shades an enemy's reach, and outlines an area spell's squares, and a cursor moved with the arrow keys does everything a click does. A game starts with the system's settings, which D&D uses for difficulty: Story cuts the damage the party takes to a third, Normal is the book as written, and Hard adds half again. Monsters keep the books' numbers. The choice is recorded in the run's start input, so saves and replays keep it. An encounter can name a battle map from its book (`battlemap` in `EncounterSchema`): the picture, the crop that holds the fight on the printed grid, its columns and rows, one string per row marking walls with `#`, and where each side starts. Walls block movement, and the picture sits under the grid. Tokens show a picture from the image index, cropped to the `face` marked there, found by a monster's name or a character's species and class (`subjects`).
7. **Full loop:** play, prep, play. Then package the app with `llama-server` as a Tauri sidecar.
8. **Your books:** import, review and expand automation over time.

Daggerheart would come after this as a new plugin in `plugins/systems/daggerheart`, with its own rules data and adventures.

## 15. Open questions and risks

**Questions for you**
1. Which book or adventure should come first after the two samples? I suggest Lost Mine, as it's much shorter than Phandelver and Below.

**Confirmed in steps 1 to 3:** the TSConfig layout, `.ts` imports and `#sdk` work in Node, `tsc` and Vitest, and Zod's optional fields work with `exactOptionalPropertyTypes`. `defineSystem` keeps engine payloads opaque, with one commented cast at the boundary.

**Things still to verify**
- `.ts` imports and the `#sdk` subpath also work through Vite, in step 6.
- The type sketches here compile. They illustrate the design and haven't been run, and some helper schemas such as `TargetingSchema` are named but not yet defined.
- The Tauri app can call `llama-server` on localhost and run it as a sidecar.

**Main risks**

| Risk | Impact | Response |
|---|---|---|
| Small-model writing feels generic | Undermines the main feature | Test in step 2, then consider better prompts, a larger model or more handwritten base text |
| The system interface is shaped by one real system and a paper check | Daggerheart may still need SDK changes | The fixture system and section 5.1 reduce this but can't remove it. Version the SDK and expect some change |
| Encoding content is larger than estimated | Delays full-book support | `automation` levels let content work partly from the start |
| Effect vocabulary can't express enough | More `partial` content | Grow it from real content, and track coverage in `check-pack` |
| Wrong mechanics pass the importer's checks | Bad rules in the game | Claude encodes instead of the local model, code checks every encoding, and uncertain spells stay text only |
| Prep doesn't anticipate what you do | Falls back to plainer base text | Prepare situations rather than plots, and add a short prep at natural breaks |
| `typescript-eslint` falls behind TypeScript | Stuck on 6.0 for longer | No real harm: 6.0 is enough for this project |

## 16. Prep test results

**First run, 5 November 2026:** Gemma 4 12B Q4_0 (7.2 GB, Apache 2.0) on `llama-server` 0.8.0, with four hand-written session histories and four jobs each. These are development numbers from a 32 GB M2 Max with other apps competing for the GPU.

| Measure | Result |
|---|---|
| Jobs ending valid | 16 of 16, using 21 model calls |
| Retries | All 5 were answers over a length limit, and all 4 rumors went over on the first try |
| Schema constraint | No invalid output in 22 calls, but this doesn't prove the constraint is enforced |
| Time | About 45 seconds per job, or 3 minutes per four-job pack. Unreliable, because other apps were using the machine |

**What worked:** each run clearly reflects its own history, and companion banter is the strongest output.

**Problems found by reading the text**
- **Character facts drift between jobs:** the elder is a man in the scene text and a woman in the conversation, because the scene job isn't told about the NPC.
- **Companion voice can flip:** Sera calls the retreat cowardice in the history, then defends cowardice as survival in her banter.
- **Scene links don't make sense yet:** dialogue options can lead back to scenes the party has already finished, because jobs don't know what comes next.
- **No player character:** options and text sometimes address companions as if they were the players.
- **Paraphrased spoilers get through:** one rumor all but gives the secret away, and the spoiler-term check can't catch this, as section 10.2 predicted.
- **Invented details can contradict clues:** a rumor says the village is hoarding grain, while a clue says the granary is half empty.

**Later runs**

| Run | Change | Result |
|---|---|---|
| 2 | Told each job about the player and NPC, limited options to reachable scenes, and added reviews | The writing improved, but all 16 jobs fell back. The consistency review rejected text while saying it found no violations |
| 3 | The consistency review now passes by default and must quote the words at fault, which code verifies. It also sees the scene's own text | 15 of 16 jobs written. One rumor kept running too long and got cut off, so it used no text |

**Limits of run 3**
- **Reviews may be too lenient now:** neither review rejected anything, so this run doesn't show that they catch real errors. The spoiler review did catch one real leak in run 2.
- **Invented details remain:** Elder Maren is shown "sketches of the trap" that the history never mentions.
- **Near-spoilers remain:** one rumor has timber hauled to the cellar, close to the secret without naming anyone.

**Speed and memory:** about 54 seconds per job including reviews, or 3.6 minutes per four-job pack, with Godot competing for the machine. At that rate, a 30-job session pack takes about 27 minutes here. All 49 layers run on the GPU, using about 8.5 GB of buffers.

**Not yet tested:** a real 16 GB machine, writing quality with a smaller model, and longer campaigns.

## Sources

**Official documentation and primary sources**
- [TSConfig reference](https://www.typescriptlang.org/tsconfig/)
- [TypeScript handbook: Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [TypeScript handbook: Choosing compiler options](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html)
- [Node.js: TypeScript](https://nodejs.org/api/typescript.html)
- [Node.js release index](https://nodejs.org/dist/index.json)
- [typescript-eslint: Shared configs](https://typescript-eslint.io/users/configs/)
- [typescript-eslint: Dependency versions](https://typescript-eslint.io/users/dependency-versions/)
- [Zod](https://zod.dev/) and [Zod: JSON Schema](https://zod.dev/json-schema)
- [fast-check with Vitest](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-vitest/)
- [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [SRD 5.2](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.pdf)
- [Daggerheart SRD](https://www.daggerheart.com/srd)
- [Darrington Press Community Gaming License](https://darringtonpress.com/license)

**Third party, lower confidence**
- [TypeScript 7 migration notes](https://github.com/boranfurkan/typescript-7-migration): compiler API status
- [Parse, don't validate tutorial](https://dev.to/paradane/parse-dont-validate-in-typescript-a-practical-tutorial-1ahc): boundary parsing
- llama.cpp issues [#19051](https://github.com/ggml-org/llama.cpp/issues/19051) and [#21228](https://github.com/ggml-org/llama.cpp/issues/21228): user reports, current status unchecked
