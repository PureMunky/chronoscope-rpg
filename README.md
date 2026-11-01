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

Quests are generated from what is really happening around the person who
gives them, and each ends in deeds recorded in the timeline. Besides the
eight personal deeds, quests can trigger the engine's larger interventions:
prophets, blessed or salted land, a newly founded people, lost knowledge,
plague.

| Quest (from) | How it plays | Deed recorded |
| --- | --- | --- |
| Raider camp (elder) | Clear a camp nearby | Irrigate the village |
| Riders on the frontier (elder) | Break an enemy warband on your border | Rally the border and the village |
| The X are coming (elder of a border village) | **Siege:** hold the village against three waves | Rally the village and the border |
| Moonwort for the sick (elder, plague nearby) | Gather herbs among plague rats | Tend the sick |
| Land for the young families (elder) | Defend the settlers' camp against beasts | Settle the empty land |
| The exiles' road (elder) | **Escort** three exiles far into empty country; ambushes on the road | **Found a new people** |
| The holy wanderer / voice of the people (elder, ruler) | **Escort** a prophet to the capital alive | **Prophet:** solidarity surges across a region |
| The hunt for Greymaw… (elder) | **Named great beast** that calls its pack when wounded | **Bless:** the wild land turns rich |
| The rising (elder, where solidarity is low) | **Choose a side:** break the garrison, or crush the rebels | **A new people** or a rally |
| The drowned library (elder, scholar) | Ruins guarded by tomb wardens; bring back the tablets | **Lost knowledge:** the realm leaps ahead |
| The stolen codex (elder) / Teach (elder, scholar) | Thief's hideout / a season of teaching | Learn / teach |
| Hold the borders (ruler), the great canal (scholar) | Several warbands / a brigand camp | Rallies / irrigation |
| Granaries (spymaster) | Burn three granaries in the rival capital | Discord |
| Salt their fields (spymaster, renown 2) | Break storehouses in their breadbasket | **Salted earth** |
| The poisoned wells (spymaster, renown 3) | Foul two wells in their capital | **Plague** (it may spread to you) |
| The death of the ruler (spymaster, renown 4) | Royal guard and a boss ruler | Assassination |

Enemies include shieldbearers (they block blows from the front unless
mid-swing: flank them, or hit them as they attack) and named elites with
traits (swift, brutal, stalwart) who drop the gear of their age.

### Echoes

The Chronoscope also reads turning points out of *your* timeline and offers
them as quests that can only be done in their own years (press 1–6 in the
Chronoscope, then Enter to travel there): the Oracle's **threads of fate**
(the deeds that would save your people, at their exact time and place),
**border wars** your people lose, your people's **last stand** before their
foretold fall, and from the chronicle: plagues, sacked capitals, and rivals
in their cradle. Echo quests stay with you through time travel.

### Quests travel with you

A quest belongs to its years: from when you take it on until 12 years later.
Travel elsewhere in time and it waits, dormant ("Travel back to 1003–1015 to
turn it in"); its people only recognise you in those years. The Chronoscope
lists your quests' years and the year you left (**B** jumps back there; **[ ]**
cycles through them). If your meddling wipes out the village or realm that
gave you a quest, it fails when you return. An escort already on the road is
lost if you leave: the people you were leading stay behind.

### Your deeds leave marks

Where a deed of yours stands in the current timeline, a **stone marker**
records it (who, what, when), weathering as the years pass. Villagers and
elders nearby tell the **legend** of the stranger who did it, differently a
few years later, a lifetime later, or centuries on. Undo the deed by
changing the past and the marker and the stories are gone.

## Gear from other ages

Every weapon, armour and ammunition belongs to an age of the simulation:

| Age | Melee | Ranged (ammo) | Armour |
| --- | --- | --- | --- |
| Stone | Stone club | Sling (stones) | Hides |
| Bronze | Bronze sword | Hunting bow (arrows) | Bronze scale |
| Iron | Iron sword | Recurve bow (arrows) | Iron mail |
| Classical | Steel gladius | Composite bow (arrows) | Lorica |
| Medieval | Longsword | Crossbow (bolts) | Plate armour |
| Renaissance | Rapier | Arquebus (shot) | Breastplate |
| Industrial | Cavalry sabre | Rifle (cartridges) | Greatcoat |

You start with your own people's gear. **Smiths** (capitals, some large
towns) sell what their age can make, and buy what you bring. Gear from later
ages is stronger, so you can travel to the future, buy a gun, and bring it
back. But:

- **Ammunition is era-locked.** Resting or a smith only restocks what the
  local age can make; nobody in the Middle Ages makes cartridges.
- **Suspicion.** Wielding gear two or more ages ahead of the people around
  you (or any gun among people who have never seen one) makes them
  suspicious, and a gunshot makes it much worse. At *whispers*, elders,
  rulers and smiths refuse you and nobody gives you a bed. At *witch hunt*,
  witch-hunters come for you. Stow it and the talk dies down, faster in the
  wilds where no one sees you. **U conceals** everything out of its time
  among the people here (or the nearest people, from the wilds) in one go,
  and U again takes it all back out. While hidden you lose that attack or
  defence: bare fists (weak), nothing to shoot, plain clothes. Single items
  can be stowed or wielded from the inventory (I).
- **Clothing.** Clothes belong to an age and a people. Nobody attacks you for
  them, but dress like a foreigner and prices rise; dress two or more ages off
  (**strange**) and villagers walk away, some elders and smiths won't deal with
  you, and quests and sales pay less; four ages off (**outlandish**), ordinary
  people won't talk to you at all. Smiths' markets sell the local dress.
- **Inventory screen (I).** Every slot, your pack and hidden items, with how
  each reads *here*. ↑↓ choose, Enter wield / wear / stow / take out, X drop,
  U conceal.
- **Selling the future.** Sell a far-future item to a smith and their
  people take it apart: a real knowledge deed for their whole realm.

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
locked target) · Space roll · Q potion · E talk · R rest · I gear · U conceal · T Chronoscope · L journal · H help.
Attacks lock on to the nearest foe in front of you. Dialogs: 1–9 / Enter / Esc.
Chronoscope: , . (Shift ×10), PgUp/PgDn, [ ] threads and quest years, B where you left, Home, Enter to travel.

## Files

```
index.html, css/game.css
js/engine/   sim.js, timeline.js, story.js, oracle.js   (from Chronoscope, unchanged)
js/rpg/local.js    provinces → walkable tiles, settlements, rendering cache
js/rpg/quests.js   quest generation, escorts, choices, echoes; quests → deeds
js/rpg/gear.js     era weapons, armour, ammunition, smiths, suspicion
js/rpg/game.js     player, combat, AI (flow-field pathfinding), time, story, HUD, Chronoscope
```

In the browser console, `RPG.debug` has helpers (`travelTo`, `teleport`, `curFate`, …).
