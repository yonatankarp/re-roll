# Writing an adventure

An adventure is a folder of YAML and art, with no code. Drop it into `plugins/adventures/` in a checkout, or into the desktop app's content folder (see the README), and it shows in the library with no rebuild. [`plugins/adventures/goblin-ambush`](../plugins/adventures/goblin-ambush) is a small complete one to copy.

## The files

```text
my-adventure/
  plugin.yaml       # what it is and what it needs
  adventure.yaml    # title, starting scene, blurb
  scenes.yaml       # the story
  encounters.yaml   # fights, used by startEncounter
  npcs.yaml         # optional
  secrets.yaml      # optional: truths with several clues
  monsters/         # optional: monsters of its own
  assets/           # optional: scene art and sound
```

`plugin.yaml`:

```yaml
id: my-adventure            # lowercase letters, digits, "." and "-"
kind: adventure
version: 1.0.0
sdk: ^1
system: dnd5.5e@^1
requires:
  - { plugin: srd52, version: ^1 }
distribution: shipped       # or private, for content you may not share
```

`adventure.yaml` names the `title`, the `startScene` and a one-line `blurb`, and may declare party `resources` such as gold.

## Scenes

A scene has an `id`, `text` and `choices`, and a scene with no choices is an ending. A choice runs its `effects` in order, or makes a `check` and runs the `results` for each outcome:

```yaml
- id: gate
  title: The Gate
  text: The gate is shut and the guard is asleep.
  choices:
    - label: "[Stealth] Slip past"
      check: { skill: stealth, dc: 13 }
      results:
        success: [{ kind: goto, scene: courtyard }]
        failure:
          - { kind: startEncounter, encounter: guard }
          - { kind: goto, scene: courtyard }
    - label: Knock
      when: { kind: flag, flag: has-pass }
      effects: [{ kind: goto, scene: courtyard }]
```

The story effects are `goto`, `setFlag`, `advanceClock`, `adjustAttitude`, `adjustResource`, `startEncounter` and `reveal`. The D&D system adds its own, such as `dnd5.5e:treasure`, `dnd5.5e:levelUp`, `dnd5.5e:shortRest` and `dnd5.5e:longRest`. A `when` condition hides a choice until it holds.

## Encounters and monsters

An encounter lists monsters by id and count, and may branch on how it ends with `onVictory`, `onDefeat` and `onFlee`. Monsters come from the `srd52` rules plugin (`srd52:monster/goblin-warrior`), or from the adventure's own `monsters/` folder, with ids under its own name (`my-adventure:monster/chief`).

## Check it and play it

```sh
npm run check-pack              # checks every plugin, and reports the file and path of each problem
npm run play -- my-adventure    # plays it in the terminal
npm run bot -- 50 my-adventure  # plays it 50 times to find dead ends
```

The full schema is in [technical-design.md](technical-design.md): section 4 for plugins and ids, section 7 for scenes, conditions, effects and encounter outcomes, and section 8 for the D&D content schemas.
