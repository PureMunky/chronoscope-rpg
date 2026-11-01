# Chronoscope: Wayfarer

An action RPG built on the deterministic history engine of
[Chronoscope](https://github.com/PureMunky/chronoscope). Walk the world as one
person, with a sword and a bow, take quests from the people you meet, and
change the course of 3,000 years of simulated history. Then look through the
Chronoscope, see what your deeds did, and travel to any year to try again.

**Play locally:** open `index.html` in a browser (works from `file://`, no build
step). Played entirely on the keyboard.

## How it differs from the original

| Original Chronoscope | Wayfarer |
| --- | --- |
| A map of provinces; you click deeds on a hotbar | Each province is a 12×12 walkable area with villages, castles, fields, forests, rivers and realm borders, all generated from the live simulation |
| A deed takes a year | Deeds are **quest rewards**: clear a raider camp and the village digs its canals (irrigation); break a frontier warband and the border rallies; burn a rival's granaries (discord); kill their ruler in their own hall (assassination) |
| Time moves with Play or deeds | Time moves as you live: about a month per province walked, a season per rest |
| Drag the history chart to travel | The **Chronoscope** (T): world map at any year, your people's provinces over time vs. the world without you, why they fall, the Oracle's "threads of fate", and travel to any year |

The simulation (`js/engine/`) is copied **unchanged** from the original, so a
world number produces the same history in both games, and a deed done here is
exactly the same recorded intervention.

## The story

1. **Prologue (year 1000).** You are twenty, born into a realm whose fall is
   foretold. Walk to the capital and swear the oath.
2. **The trial.** The ruler sends you to clear raiders near the capital.
3. **The Chronoscope.** A stranger gives you the instrument and shows you your
   people's fall, and why. **Goal: your people must still hold land 50 years
   after their foretold fall.**
4. The ruler, their **spymaster** and **scholar** now have work for you, and
   every village elder has their own troubles.

When you die, or grow old, the Chronoscope passes to someone young nearby. Your
deeds stand; your level carries over; unfinished quests are forgotten.

## Quests → deeds

| Quest (from) | Spawns | Deed recorded |
| --- | --- | --- |
| Raiders at the canal works (elder) | Bandit camp nearby | Irrigate the village |
| Riders on the frontier (elder) | Enemy warband on your border | Rally the border and the village |
| Moonwort for the sick (elder, when plague is near) | Herbs in the wilds, plague rats | Tend the sick |
| Land for the young families (elder) | Waves of beasts at the empty land | Settle it |
| The stolen codex (elder of a learned people) | Thief's hideout | Learn their knowledge |
| Teach what you know (elder or scholar) | A season of teaching | Teach (realm-wide) |
| Hold the borders (ruler) | Up to three warbands | Rally each border, then the capital |
| The great canal (scholar) | Brigand camp | Irrigate the capital and the camp land |
| Burn the granaries (spymaster) | Granaries and guards in the rival capital | Sow discord there |
| The death of the rival ruler (spymaster) | Royal guard and a boss ruler | Assassinate: realm-wide succession crisis |

A deed is applied in the year you finish the quest. Then the future is
re-simulated in the background, and the HUD tells you when your people now fall.

## Renown and danger

Quests done for your own people earn **renown**. The spymaster offers the
granaries at once, but only trusts you to kill a rival ruler at renown 4: in
half the worlds tested, that single deed saves your people, so it is kept for
when you have earned it (about level 4–5). Every quest offer shows a danger
rating and a recommended level, in red when it would likely kill you.

## Balance

Tuned with a headless bot (keyboard-style 8-way movement, human-like reaction
delays and dodge odds, potions at 35% health) fighting each encounter 14 times
per level and skill tier. Combat knobs live in `BAL` and `KINDS` in `game.js`.

| Encounter | Level 1 novice | Level 3 average | Level 5 average |
| --- | --- | --- | --- |
| Wolves ×3 | ~11 damage taken | trivial | trivial |
| Trial camp (2 bandits, archer) | ~17 damage | ~7 | ~5 |
| Raider camp (+ chief) | ~48 damage, about half your health | ~18 | ~17 |
| Frontier warband, Classical Age | ~88 damage, often a potion | ~35 | ~29 |
| Royal guard + ruler, Classical Age | **dies every time** | 86% win, ~2 potions, 14% die | wins, ~1 potion |

Strategically (engine-only replays across worlds 1–12, trying each plan every
10 years before the fall): one regicide saves your people in 6 of 12 worlds,
muster + canal + teaching in 3, both together in 7, and two such campaigns
30 years apart in 11. World 11 resisted everything tried.

## Controls

WASD move (you face the way you walk) · J sword · K bow (hold to strafe around the
locked target) · Space roll · Q potion · E talk · R rest · T Chronoscope · L journal · H help.
Attacks lock on to the nearest foe in front of you. Dialogs: 1–9 / Enter / Esc.
Chronoscope: , . (Shift ×10), PgUp/PgDn, [ ] threads of fate, Home, Enter to travel.

## Files

```
index.html, css/game.css
js/engine/   sim.js, timeline.js, story.js, oracle.js   (from Chronoscope, unchanged)
js/rpg/local.js    provinces → walkable tiles, settlements, rendering cache
js/rpg/quests.js   quest generation from the simulation; quests → deeds
js/rpg/game.js     player, combat, AI (flow-field pathfinding), time, story, HUD, Chronoscope
```

In the browser console, `RPG.debug` has helpers (`travelTo`, `teleport`, `curFate`, …).
