/*
 * Chronoscope: Wayfarer. An action RPG on top of the deterministic
 * Chronoscope world.
 *
 * The world itself (peoples, wars, plague, collapse) is the original
 * simulation, untouched. This file adds a body in that world: you walk,
 * fight, take quests, and every quest you finish records a deed in the
 * timeline, so history really changes. The Chronoscope lets you see the
 * consequences and travel to any year to try again.
 */
(function () {
  'use strict';
  var Sim = window.Sim, Timeline = window.Timeline, Story = window.Story, Oracle = window.Oracle, L = window.Local, Quests = window.Quests;
  var W = Sim.W, H = Sim.H, N = Sim.N, P = L.P, TS = L.TS, C = L.C, NB = Sim.NB, TER = Sim.TER;
  var START = Story.START_YEAR, HORIZON = 2000, TILES_PER_MONTH = 12;
  var MONTHS = ['Deepwinter', 'Thaw', 'Seedtime', 'Bloom', 'Greening', 'Midsummer', 'Highsun', 'Harvest', 'Reaping', 'Leaffall', 'Frost', 'Longnight'];
  var DEED_NAMES = { irrigate: 'Irrigation', rally: 'Rally', heal: 'Tending the sick', settle: 'Settlement', learn: 'Learning', teach: 'Teaching', discord: 'Discord', assassinate: 'Assassination' };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function provOf(x, y) { return clamp(Math.floor(y / P), 0, H - 1) * W + clamp(Math.floor(x / P), 0, W - 1); }
  function provCenter(pi) { return { x: (pi % W) * P + C + 0.5, y: ((pi / W) | 0) * P + C + 0.5 }; }
  function md(a, b) { return Math.abs(a % W - b % W) + Math.abs(((a / W) | 0) - ((b / W) | 0)); }
  var DIRS8 = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  function dirName(dx, dy) { return DIRS8[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8]; }
  function dirText(from, to) {
    var dx = to % W - from % W, dy = ((to / W) | 0) - ((from / W) | 0), d = Math.abs(dx) + Math.abs(dy);
    if (!d) return 'right here';
    return 'to the ' + dirName(dx, dy) + ' (' + d + ' province' + (d > 1 ? 's' : '') + ' away)';
  }
  function angDiff(a, b) { var d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function pct(a) { return (a / 100).toFixed(0) + '%'; }
  function fmtPop(p) { return p >= 1e6 ? (p / 1e6).toFixed(1) + ' million' : p >= 1000 ? Math.round(p / 1000) + ',000' : String(p); }
  function civName(sig) { return Sim.civName(sig); }

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------
  var G = {
    world: null, cur: null, view: null, s: null, ver: 0, year: START, month: 2,
    stage: 'title', home: null, goal: null, player: null,
    actors: [], projectiles: [], pickups: [], effects: [], active: {}, cleared: {},
    quests: [], questsDone: [], log: [], deeds: [], modal: null, panel: null,
    oracle: null, fateCache: null, fateWatch: null, cam: { x: 0, y: 0 }, shake: 0,
    keys: {}, target: null, time: 0, nextId: 1, lastProv: -1,
    branchNames: {}, renown: 0, hudT: 0, activeT: 0, edgeWarned: false
  };

  function civIdx(sig) {
    var s = G.s;
    if (!sig || !s) return -1;
    for (var c = 0; c < s.g[1]; c++) if (s.cSig[c] === sig && s.cAlive[c] && s.sTiles[c] > 0) return c;
    return -1;
  }
  function homeCiv() { return G.home ? civIdx(G.home.sig) : -1; }
  function foeCiv() {
    var s = G.s, hc = homeCiv();
    if (G.goal && G.goal.foeSig) { var f = civIdx(G.goal.foeSig); if (f >= 0 && f !== hc) return f; }
    if (hc < 0) return -1;
    var nbs = Story.survey(s, hc).neighbours.slice().sort(function (a, b) { return s.sPop[b.c] - s.sPop[a.c]; });
    return nbs.length ? nbs[0].c : -1;
  }
  function rulerTitle(sig, c) {
    var age = c >= 0 ? Sim.ageOf(G.s.cTech[c]) : 2, female = Sim.hash4(sig, 2, 77, 3) % 2 === 0;
    if (age <= 1) return female ? 'Chieftess' : 'Chieftain';
    if (age >= 5) return female ? 'Princess' : 'Prince';
    return female ? 'Queen' : 'King';
  }
  function rulerName(sig) { return rulerTitle(sig, civIdx(sig)) + ' ' + Story.personName(sig, Math.floor(G.year / 30)); }

  // ---------------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------------
  function newPlayer(name, level, lives) {
    var p = {
      x: 0, y: 0, r: 0.3, face: 0, hp: 100, level: level || 1, xp: 0, arrows: 25, potions: 3, name: name,
      age: 20, deathAge: 66 + Sim.hash4(G.world.seed, lives || 1, 5, 941) % 18,
      swingT: 0, swingCd: 0, bowCd: 0, rollT: 0, rollCd: 0, rollX: 0, rollY: 0, inv: 0, hurt: 0,
      knowledge: null, lives: lives || 1, distAcc: 0, moving: false, walkT: 0, boat: false, dead: false, calm: 0, bowT: 0
    };
    p.hp = maxHp(p);
    return p;
  }
  function maxHp(p) {
    var f = p.age > 50 ? Math.max(0.55, 1 - (p.age - 50) * 0.012) : 1;
    return Math.round((100 + 15 * (p.level - 1)) * f);
  }
  function swordDmg() { return Math.round(15 + BAL.swordPer * (G.player.level - 1)); }
  function bowDmg() { return Math.round(11 + BAL.bowPer * (G.player.level - 1)); }
  function xpNext(l) { return 40 + 50 * l; }

  function gainXp(n) {
    var p = G.player;
    p.xp += n;
    while (p.xp >= xpNext(p.level)) {
      p.xp -= xpNext(p.level);
      var before = maxHp(p);
      p.level++;
      p.hp = Math.min(maxHp(p), p.hp + (maxHp(p) - before));
      toast('<b>Level ' + p.level + '!</b> You feel stronger (health ' + maxHp(p) + ', sword ' + swordDmg() + ', bow ' + bowDmg() + ').');
      addEffect({ type: 'ring', x: p.x, y: p.y, life: 0.8, color: '#ffd76a' });
    }
  }
  function reward(xp, potions) {
    var p = G.player;
    gainXp(xp);
    if (potions) p.potions = Math.min(6, p.potions + potions);
    toast('+' + xp + ' XP' + (potions ? ', +' + potions + ' potion' : ''));
  }

  // ---------------------------------------------------------------------------
  // Time
  // ---------------------------------------------------------------------------
  function seekYear(y) {
    G.year = clamp(y, 0, HORIZON - 1);
    G.s = G.view.seek(G.cur, G.year);
    G.ver++;
    G.fateCache = null;
  }
  function passMonths(n) {
    for (var k = 0; k < n; k++) {
      G.month++;
      if (G.month >= 12) { G.month = 0; newYear(); }
    }
  }
  function newYear() {
    var p = G.player;
    if (G.year >= HORIZON - 1) {
      if (!G.edgeWarned) toast('The Chronoscope can see no further than the year ' + HORIZON + '. Time stands still here.');
      G.edgeWarned = true;
      return;
    }
    p.age++;
    seekYear(G.year + 1);
    refreshActive();
    yearEvents();
    if (p.hp > maxHp(p)) p.hp = maxHp(p);
    if (p.age >= p.deathAge && !p.dead) passOn('old');
  }

  function yearEvents() {
    var hs = G.home ? G.home.sig : 0, fs = G.goal ? G.goal.foeSig : 0, p = G.player, px = Math.floor(p.x / P), py = Math.floor(p.y / P);
    var evs = G.cur.events, shown = 0;
    for (var k = evs.length - 1; k >= 0 && shown < 3; k--) {
      var e = evs[k];
      if (e.t !== G.year - 1) continue;
      var mine = hs && (e.a === hs || e.b === hs), foe = fs && (e.a === fs || e.b === fs);
      var near = e.x >= 0 && Math.abs(e.x - px) + Math.abs(e.y - py) <= 10;
      if (mine || foe || (near && e.type !== 'secede')) {
        toast('<span class="ev">Year ' + e.t + '.</span> ' + esc(e.text), 7000);
        if (mine || foe) journal(esc(e.text));
        shown++;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Deeds: quests write into history here
  // ---------------------------------------------------------------------------
  function measure(type, pi) {
    var s = G.s, c = s.owner[pi], m = { c: c, sig: c >= 0 ? s.cSig[c] : 0 };
    m.local = s.asab[pi]; m.realm = c >= 0 ? Sim.meanAsab(s, c) : 0; m.soil = s.soil[pi]; m.tech = c >= 0 ? s.cTech[c] : 0;
    var sick = 0;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var j = pi + dy * W + dx; if (j >= 0 && j < N && s.plague[j]) sick++; }
    m.sick = sick;
    return m;
  }

  function lifeBranchName() {
    var p = G.player, key = p.name + p.lives, n = (G.branchNames[key] || 0) + 1;
    G.branchNames[key] = n;
    var ord = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'][p.lives - 1] || (p.lives + 'th');
    return 'Your ' + ord + ' life (' + p.name + ')' + (n > 1 ? ', path ' + n : '');
  }

  function applyDeed(type, pi, v, why) {
    var s = G.s, x = pi % W, y = (pi / W) | 0, p = G.player;
    if (type === 'learn') {
      var lc = s.owner[pi];
      if (lc < 0) { toast('No one is left here to learn from.'); return false; }
      p.knowledge = { tech: s.cTech[lc], sig: s.cSig[lc] };
      toast('You study the codex: you now carry the knowledge of the <b>' + esc(civName(s.cSig[lc])) + '</b> (' + Sim.AGES[Sim.ageOf(s.cTech[lc])].name + ', ' + s.cTech[lc] + ').', 7000);
      journal('You learned the knowledge of the ' + esc(civName(s.cSig[lc])) + ' (' + Sim.AGES[Sim.ageOf(s.cTech[lc])].name + ').');
      return true;
    }
    var block = Sim.deedBlocker(s, type, x, y, v ? { tech: v } : null);
    if (block) { toast('<b>' + DEED_NAMES[type] + '</b> came to nothing: ' + esc(block), 7000); return false; }
    var before = measure(type, pi), prev = readFate(G.cur), old = G.cur;
    G.cur = G.world.intervene(G.cur, G.year, { type: type, x: x, y: y, v: v || 0, note: why || '' });
    if (G.cur !== old) G.cur.name = lifeBranchName();
    seekYear(G.year);
    refreshActive();
    var after = measure(type, pi), msg = '';
    var rn = before.sig ? esc(civName(before.sig)) : '';
    switch (type) {
      case 'rally': case 'discord':
        msg = 'Solidarity here ' + pct(before.local) + ' → ' + pct(after.local) + (before.c >= 0 ? '; across all of the ' + rn + ': ' + (before.realm / 100).toFixed(1) + '% → ' + (after.realm / 100).toFixed(1) + '%' : '') + '.'; break;
      case 'irrigate': msg = 'Soil fertility here ' + pct(before.soil) + ' → ' + pct(after.soil) + '.'; break;
      case 'heal': msg = 'Plague around you: ' + before.sick + ' provinces → ' + after.sick + '.'; break;
      case 'teach': msg = 'The knowledge of the ' + rn + ': ' + before.tech + ' → ' + after.tech + ' (' + Sim.AGES[Sim.ageOf(after.tech)].name + ').'; break;
      case 'assassinate': msg = 'The ' + rn + ' fall into a succession crisis: solidarity ' + (before.realm / 100).toFixed(1) + '% → ' + (after.realm / 100).toFixed(1) + '%.'; break;
      case 'settle': msg = after.sig ? 'The land is settled by the ' + esc(civName(after.sig)) + '.' : 'The settlers take root.'; break;
    }
    G.deeds.push({ year: G.year, type: type, pi: pi, why: why || '', msg: msg });
    toast('<b>History changes. ' + DEED_NAMES[type] + '</b> in ' + G.year + ': ' + msg, 8000);
    journal('<b>' + DEED_NAMES[type] + '</b> at (' + x + ', ' + y + ') in ' + G.year + '. ' + msg);
    G.fateWatch = { prev: prev };
    G.oracle = null;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Fate of your people in a timeline
  // ---------------------------------------------------------------------------
  function readFate(b) {
    if (!G.home) return { state: 'none' };
    if (b.computedTo <= START + 5) return { state: 'pending', known: b.computedTo };
    var f = Story.fate(b, G.home.sig, START);
    if (f.end != null && f.end <= START) return { state: 'never' };
    if (f.end != null) return { state: 'falls', end: f.end, by: f.event && f.event.type === 'fall' ? f.event.b : 0, how: f.event ? f.event.type : 'fade' };
    if (b.computedTo >= HORIZON) return { state: 'endures' };
    return { state: 'pending', known: b.computedTo };
  }
  function curFate() {
    var b = G.cur, key = b.id + ':' + b.version + ':' + b.computedTo;
    if (!G.fateCache || G.fateCache.key !== key) G.fateCache = { key: key, f: readFate(b) };
    return G.fateCache.f;
  }
  function fateText(f, short) {
    var n = G.home ? esc(G.home.name) : '';
    if (f.state === 'pending') return 'The future is still being written… (year ' + f.known + ')';
    if (f.state === 'never') return 'In this timeline the ' + n + ' never rise.';
    if (f.state === 'endures') return 'The ' + n + ' endure beyond ' + HORIZON + '.';
    if (f.state === 'falls') {
      var how = f.how === 'fall' && f.by ? 'conquered by the ' + esc(civName(f.by)) : f.how === 'collapse' ? 'shattered from within' : 'dwindle away';
      return short ? 'Fall in <b>' + f.end + '</b> (' + how + ')' : 'The ' + n + ' fall in <b>' + f.end + '</b>, ' + how + '.';
    }
    return '';
  }
  function saved(f) { return G.goal && (f.state === 'endures' || (f.state === 'falls' && f.end >= G.goal.target)); }

  function watchFate() {
    if (!G.fateWatch) return;
    var f = curFate();
    if (f.state === 'pending') return;
    var prev = G.fateWatch.prev;
    G.fateWatch = null;
    if (!G.goal) return;
    var n = esc(G.home.name), msg;
    if (saved(f)) msg = '<b>The future rewrites itself: the ' + n + ' still hold their land in ' + G.goal.target + '!</b>';
    else if (f.state === 'never') msg = 'Your meddling has unmade your own people: the ' + n + ' never rise.';
    else if (prev.state === 'falls' && f.state === 'falls') {
      if (f.end > prev.end) msg = 'The Chronoscope shudders. The ' + n + ' now fall in <b>' + f.end + '</b>, ' + (f.end - prev.end) + ' years later than before.';
      else if (f.end < prev.end) msg = 'The Chronoscope shudders. The ' + n + ' now fall in <b>' + f.end + '</b>, ' + (prev.end - f.end) + ' years <i>sooner</i>.';
      else msg = 'History bends back toward its course: the ' + n + ' still fall in ' + f.end + '.';
    } else msg = fateText(f);
    toast(msg, 9000);
    journal(msg);
  }

  // ---------------------------------------------------------------------------
  // Actors
  // ---------------------------------------------------------------------------
  // Combat tuning (see the balance notes in README.md)
  // Tuned with the headless balance bot (novice / average / skilled players at levels 1, 3, 5):
  // wildlife and camps are easy, warbands cost real health at level 1, and the royal guard plus a
  // ruler kills most level-1 players but is safe at level 5.
  var BAL = { cdMin: 0.35, cdMax: 0.75, kbWind: 0.25, windStun: 0, hpAge: 0.2, dmgAge: 0.15, recover: 0.3, swordPer: 3.5, bowPer: 2.5, potion: 0.35 };
  var RENOWN_REGICIDE = 4;
  var KINDS = {
    wolf: { name: 'Wolf', hp: 30, dmg: 8, speed: 3.7, r: 0.32, xp: 8, reach: 0.95, wind: 0.3, aggro: 7, beast: 1 },
    jackal: { name: 'Jackal', hp: 16, dmg: 5, speed: 3.9, r: 0.28, xp: 6, reach: 0.9, wind: 0.26, aggro: 7, beast: 1 },
    bear: { name: 'Cave bear', hp: 80, dmg: 15, speed: 2.7, r: 0.46, xp: 30, reach: 1.15, wind: 0.5, aggro: 6, beast: 1 },
    rat: { name: 'Plague rat', hp: 8, dmg: 3, speed: 3.2, r: 0.2, xp: 3, reach: 0.7, wind: 0.22, aggro: 6, beast: 1 },
    bandit: { name: 'Bandit', hp: 30, dmg: 8, speed: 2.9, r: 0.3, xp: 12, reach: 1.0, wind: 0.34, aggro: 8, scale: 1 },
    archer: { name: 'Bandit archer', hp: 22, dmg: 7, speed: 2.7, r: 0.3, xp: 12, ranged: 1, aggro: 10, scale: 1 },
    thief: { name: 'Codex thief', hp: 40, dmg: 8, speed: 3.1, r: 0.3, xp: 20, reach: 1.0, wind: 0.3, aggro: 8, scale: 1 },
    chief: { name: 'Raider chief', hp: 85, dmg: 14, speed: 2.8, r: 0.4, xp: 35, reach: 1.15, wind: 0.45, aggro: 9, scale: 1 },
    soldier: { name: 'Soldier', hp: 34, dmg: 9, speed: 2.8, r: 0.3, xp: 15, reach: 1.15, wind: 0.36, aggro: 8, scale: 1, uniform: 1 },
    bowman: { name: 'Bowman', hp: 26, dmg: 8, speed: 2.6, r: 0.3, xp: 15, ranged: 1, aggro: 10, scale: 1, uniform: 1 },
    captain: { name: 'Captain', hp: 95, dmg: 15, speed: 2.8, r: 0.4, xp: 40, reach: 1.25, wind: 0.45, aggro: 9, scale: 1, uniform: 1 },
    guard: { name: 'Royal guard', hp: 60, dmg: 13, speed: 2.8, r: 0.32, xp: 18, reach: 1.2, wind: 0.38, aggro: 9, scale: 1, uniform: 1 },
    ruler: { name: 'Ruler', hp: 320, dmg: 24, speed: 2.7, r: 0.5, xp: 150, reach: 1.4, wind: 0.55, aggro: 11, scale: 1, uniform: 1, boss: 1 },
    granary: { name: 'Granary', hp: 45, r: 0.5, xp: 5, obj: 1 }
  };
  var NPC_ROLES = { villager: 1, elder: 1, royal: 1, spymaster: 1, scholar: 1, stranger: 1, settler: 1, lord: 1, sentry: 1 };

  function spawnAt(kind, x, y, o) {
    o = o || {};
    var a = { id: G.nextId++, kind: kind, x: x, y: y, hx: x, hy: y, face: Math.random() * 6.28, state: 'idle', t: 0, cd: rnd(0.3, 1.2), cd2: 3, flash: 0, kbx: 0, kby: 0, wt: 0, wx: x, wy: y, walkT: Math.random() * 9 };
    for (var k in o) a[k] = o[k];
    if (a.prov == null) a.prov = provOf(x, y);
    if (NPC_ROLES[kind]) {
      a.npc = true; a.role = kind; a.r = 0.3; a.speed = kind === 'villager' || kind === 'settler' ? 1.2 : 0.5;
      a.hostile = false;
      if (!a.name) a.name = kind === 'villager' ? 'Villager' : kind;
    } else if (kind === 'tent' || kind === 'fire') {
      a.deco = true; a.r = 0.4;
    } else {
      var K = KINDS[kind], age = 0;
      if (K.scale) {
        var fc = a.faction ? civIdx(a.faction) : G.s.owner[a.prov];
        age = fc >= 0 ? Sim.ageOf(G.s.cTech[fc]) : 1;
        if (o.age != null) age = o.age;
      }
      a.name = kind === 'ruler' && a.faction ? rulerName(a.faction) : K.name;
      a.maxHp = a.hp = Math.round(K.hp * (1 + BAL.hpAge * age));
      a.dmg = Math.round((K.dmg || 0) * (1 + BAL.dmgAge * age));
      a.speed = K.speed || 0; a.r = K.r; a.xp = Math.round(K.xp * (1 + 0.1 * age)); a.reach = K.reach || 1; a.wind = K.wind || 0.3;
      a.aggro = K.aggro || 8; a.ranged = !!K.ranged; a.boss = !!K.boss; a.obj = !!K.obj; a.beast = !!K.beast; a.uniform = !!K.uniform;
      if (a.hostile == null) a.hostile = true;
      if (a.obj) a.hostile = false;
    }
    G.actors.push(a);
    return a;
  }
  /** Is (tx, ty) in open, connected ground (not a pocket sealed by houses, trees or water)? */
  function isOpen(tx, ty, need) {
    need = need || 40;
    var seen = {}, q = [tx, ty], n = 0;
    seen[tx + ',' + ty] = 1;
    while (q.length) {
      var x = q.shift(), y = q.shift();
      if (++n >= need) return true;
      for (var k = 0; k < 4; k++) {
        var nx = x + [1, -1, 0, 0][k], ny = y + [0, 0, 1, -1][k], key = nx + ',' + ny;
        if (seen[key] || L.isSolid(G.s, nx, ny, G.ver, true)) continue;
        seen[key] = 1; q.push(nx, ny);
      }
    }
    return false;
  }
  function findFreeNear(x, y, maxR) {
    var tx = Math.floor(x), ty = Math.floor(y);
    for (var r = 0; r <= (maxR || 6); r++) {
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var cx = tx + dx, cy = ty + dy;
        if (!L.isSolid(G.s, cx, cy, G.ver, true) && isOpen(cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
      }
    }
    return null;
  }
  function findFree(pi, lx, ly) { return findFreeNear((pi % W) * P + lx, ((pi / W) | 0) * P + ly, 6); }
  function spawnNear(kind, x, y, o) {
    var f = findFreeNear(x, y, 6);
    return f ? spawnAt(kind, f.x, f.y, o) : null;
  }
  function spawnDeco(kind, x, y, o) { return spawnAt(kind, x, y, o); }
  function spawnPickup(kind, x, y, o) {
    var pk = { kind: kind, x: x, y: y, t: Math.random() * 6 };
    for (var k in (o || {})) pk[k] = o[k];
    if (pk.prov == null) pk.prov = provOf(x, y);
    G.pickups.push(pk);
    return pk;
  }

  function bordersRealm(pi, c) {
    var s = G.s;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var j = pi + dy * W + dx;
      if (j >= 0 && j < N && s.owner[j] === c) return true;
    }
    return false;
  }

  function hasQuestAt(pi, kind) {
    return G.quests.some(function (q) { return q.kind === kind && q.stage === 'go' && q.enc.some(function (e) { return e.pi === pi && !e.done; }); });
  }

  function randomSpotIn(pi) {
    var p = G.player;
    for (var k = 0; k < 12; k++) {
      var lx = rnd(1, P - 1), ly = rnd(1, P - 1);
      if (Math.abs(lx - C) < 2.5 && Math.abs(ly - C) < 2.5) continue;
      var x = (pi % W) * P + lx, y = ((pi / W) | 0) * P + ly;
      if (Math.hypot(x - p.x, y - p.y) < 7) continue;
      var f = findFreeNear(x, y, 2);
      if (f && Math.hypot(f.x - p.x, f.y - p.y) >= 6) return f;
    }
    return null;
  }
  function spawnGroup(pi, kinds, o) {
    var f = randomSpotIn(pi);
    if (!f) return;
    kinds.forEach(function (k, i) { spawnNear(k, f.x + (i % 2) * 1.1, f.y + (i >> 1) * 1.1, Object.assign({ prov: pi }, o || {})); });
  }

  function spawnProvince(pi, withQuests) {
    var s = G.s;
    if (!L.isLandT(s.terrain[pi])) { if (withQuests) Quests.spawnFor(pi); return; }
    var c = s.owner[pi], pop = s.pop[pi], cap = c >= 0 && s.cCap[c] === pi, hc = homeCiv(), sig = c >= 0 ? s.cSig[c] : 0;
    var dyn = L.getDyn(s, pi, G.ver), bx = (pi % W) * P, by = ((pi / W) | 0) * P, k;
    if (c >= 0 && pop > 0) {
      var nv = Math.min(4, 1 + ((dyn.houses.length / 3) | 0));
      for (k = 0; k < nv; k++) spawnNear('villager', bx + C + rnd(-3, 3), by + C + rnd(-3, 3), { prov: pi, faction: sig, name: 'Villager' });
      if (cap) {
        if (c === hc) {
          spawnNear('royal', bx + C + 1.5, by + C - 0.5, { prov: pi, faction: sig, key: 'royal:' + sig, name: rulerName(sig) });
          if (G.stage === 'quest' || G.stage === 'won') {
            spawnNear('spymaster', bx + C - 1.5, by + C - 1.5, { prov: pi, faction: sig, key: 'spymaster:' + sig, name: 'Spymaster ' + Story.personName(sig, 501) });
            spawnNear('scholar', bx + C - 1.5, by + C + 2.5, { prov: pi, faction: sig, key: 'scholar:' + sig, name: 'Scholar ' + Story.personName(sig, 502) });
          }
        } else if (!hasQuestAt(pi, 'regicide')) {
          spawnNear('lord', bx + C + 1.5, by + C - 0.5, { prov: pi, faction: sig, name: rulerName(sig) });
          spawnNear('sentry', bx + C - 0.5, by + C - 0.5, { prov: pi, faction: sig, name: 'Sentry of the ' + civName(sig) });
          spawnNear('sentry', bx + C + 3.5, by + C - 0.5, { prov: pi, faction: sig, name: 'Sentry of the ' + civName(sig) });
        }
      } else if (pop >= 15 && Sim.hash4(G.world.seed, pi, 0, 951) % 3 === 0) {
        spawnNear('elder', bx + C + 2.5, by + C + 1.5, { prov: pi, faction: sig, key: 'elder:' + pi, name: 'Elder ' + Story.personName(sig, pi) });
      }
    }
    if (!(G.cleared[pi] >= G.year)) {
      var t = s.terrain[pi];
      if (c < 0 && pop === 0) {
        var ch = { 2: 0.3, 3: 0.55, 4: 0.45, 5: 0.25, 6: 0.35 }[t] || 0.3;
        if (Math.random() < ch) {
          var wk = t === TER.DESERT ? 'jackal' : t === TER.MOUNTAIN || (t === TER.FOREST && Math.random() < 0.2) ? 'bear' : 'wolf';
          spawnGroup(pi, wk === 'bear' ? ['bear'] : wk === 'jackal' ? ['jackal', 'jackal'] : Math.random() < 0.5 ? ['wolf', 'wolf'] : ['wolf', 'wolf', 'wolf']);
        }
      } else if (c >= 0 && hc >= 0 && c !== hc && bordersRealm(pi, hc) && Math.random() < 0.7) {
        spawnGroup(pi, Math.random() < 0.5 ? ['soldier', 'bowman'] : ['soldier', 'soldier', 'bowman'], { faction: sig, patrol: true });
      }
      if (c >= 0 && (s.starve[pi] || Sim.meanAsab(s, c) < 2200) && Math.random() < 0.45) spawnGroup(pi, Math.random() < 0.5 ? ['bandit'] : ['bandit', 'archer']);
      if (s.plague[pi]) spawnGroup(pi, ['rat', 'rat', 'rat'].slice(0, 2 + (Math.random() * 2 | 0)));
    }
    if (withQuests) Quests.spawnFor(pi);
  }

  function despawnProv(pi, keepQuest) {
    G.actors = G.actors.filter(function (a) { return a.prov !== pi || (keepQuest && a.qid) || a.role === 'stranger'; });
    G.pickups = G.pickups.filter(function (pk) { return pk.prov !== pi || (keepQuest && pk.qid); });
    if (!keepQuest) Quests.despawned(pi);
  }
  function isActive(pi) { return G.active[pi] != null; }

  function manageActive() {
    var p = G.player, ppi = provOf(p.x, p.y), px = ppi % W, py = (ppi / W) | 0;
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
      var x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      var pi = y * W + x;
      if (G.active[pi] == null) { G.active[pi] = L.getDyn(G.s, pi, G.ver).key; spawnProvince(pi, true); }
    }
    for (var key in G.active) {
      var j = +key;
      if (Math.max(Math.abs(j % W - px), Math.abs(((j / W) | 0) - py)) > 3) { despawnProv(j, false); delete G.active[key]; }
    }
  }
  /** After history changes: rebuild provinces whose people changed. */
  function refreshActive() {
    for (var key in G.active) {
      var j = +key, k2 = L.getDyn(G.s, j, G.ver).key;
      if (k2 !== G.active[key]) { despawnProv(j, true); spawnProvince(j, false); G.active[key] = k2; }
    }
  }
  function resetActors() {
    G.actors = [];
    G.pickups = []; G.projectiles = [];
    for (var key in G.active) Quests.despawned(+key);
    G.active = {};
  }

  // ---------------------------------------------------------------------------
  // Movement & collision
  // ---------------------------------------------------------------------------
  function collides(x, y, r, bw) {
    var x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (var ty = y0; ty <= y1; ty++) for (var tx = x0; tx <= x1; tx++) if (L.isSolid(G.s, tx, ty, G.ver, bw)) return true;
    return false;
  }
  function move(e, dx, dy, bw) {
    var moved = 0;
    if (dx && !collides(e.x + dx, e.y, e.r, bw)) { e.x += dx; moved += Math.abs(dx); }
    if (dy && !collides(e.x, e.y + dy, e.r, bw)) { e.y += dy; moved += Math.abs(dy); }
    return moved;
  }
  function steer(a, tx, ty, speed, dt) {
    var dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy);
    if (d < 0.05) return 0;
    var ang = Math.atan2(dy, dx), step = Math.min(d, speed * dt), m = move(a, Math.cos(ang) * step, Math.sin(ang) * step, true);
    if (m < step * 0.3) {
      for (var k = 0; k < 2; k++) {
        var alt = ang + (k ? -1 : 1) * 1.1;
        m = move(a, Math.cos(alt) * step, Math.sin(alt) * step, true);
        if (m > step * 0.3) break;
      }
    }
    return m;
  }

  // Flow field: distances (in steps) from the player over nearby tiles, so
  // enemies can path around houses, walls and woods instead of getting stuck.
  var FR = 24, FS = FR * 2 + 1, flowDist = new Int16Array(FS * FS), flowBlk = new Uint8Array(FS * FS), flowQ = new Int32Array(FS * FS);
  var flow = { ox: 0, oy: 0, ok: false };
  var D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  function updateFlow() {
    var p = G.player, cx = Math.floor(p.x), cy = Math.floor(p.y), k;
    flow.ox = cx - FR; flow.oy = cy - FR;
    for (var y = 0; y < FS; y++) for (var x = 0; x < FS; x++) flowBlk[y * FS + x] = L.isSolid(G.s, flow.ox + x, flow.oy + y, G.ver, true) ? 1 : 0;
    flowDist.fill(-1);
    var head = 0, tail = 0, c0 = FR * FS + FR;
    flowDist[c0] = 0; flowQ[tail++] = c0;
    while (head < tail) {
      var i = flowQ[head++], ix = i % FS, iy = (i / FS) | 0;
      for (k = 0; k < 8; k++) {
        var nx = ix + D8[k][0], ny = iy + D8[k][1];
        if (nx < 0 || ny < 0 || nx >= FS || ny >= FS) continue;
        var j = ny * FS + nx;
        if (flowDist[j] >= 0 || flowBlk[j]) continue;
        if (k >= 4 && (flowBlk[iy * FS + nx] || flowBlk[ny * FS + ix])) continue;
        flowDist[j] = flowDist[i] + 1;
        flowQ[tail++] = j;
      }
    }
    flow.ok = true;
  }
  /** Next waypoint toward the player from (x, y), or null when off the field. */
  function flowNext(x, y) {
    if (!flow.ok) return null;
    var lx = Math.floor(x) - flow.ox, ly = Math.floor(y) - flow.oy;
    if (lx < 0 || ly < 0 || lx >= FS || ly >= FS) return null;
    var here = flowDist[ly * FS + lx], best = -1, bd = here < 0 ? 1e9 : here;
    for (var k = 0; k < 8; k++) {
      var nx = lx + D8[k][0], ny = ly + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= FS || ny >= FS) continue;
      var d = flowDist[ny * FS + nx];
      if (d < 0 || d >= bd) continue;
      if (k >= 4 && (flowBlk[ly * FS + nx] || flowBlk[ny * FS + lx])) continue;
      bd = d; best = k;
    }
    if (best < 0) return null;
    return { x: flow.ox + lx + D8[best][0] + 0.5, y: flow.oy + ly + D8[best][1] + 0.5 };
  }
  function clearLine(ax, ay, bx, by, shot) {
    var d = Math.hypot(bx - ax, by - ay), n = Math.ceil(d / 0.35);
    for (var k = 1; k < n; k++) {
      var x = Math.floor(ax + (bx - ax) * k / n), y = Math.floor(ay + (by - ay) * k / n);
      if (shot ? L.blocksShot(G.s, x, y, G.ver) : L.isSolid(G.s, x, y, G.ver, true)) return false;
    }
    return true;
  }
  /** Is a straight walk clear for a body of radius r? (checks the centre line and both edges) */
  function clearWalk(ax, ay, bx, by, r) {
    var d = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / d * r, ny = (bx - ax) / d * r;
    return clearLine(ax, ay, bx, by, false) && clearLine(ax + nx, ay + ny, bx + nx, by + ny, false) && clearLine(ax - nx, ay - ny, bx - nx, by - ny, false);
  }
  /** Move toward the player: straight when the way is clear, else along the flow field. */
  function pursue(a, speed, dt) {
    var p = G.player;
    if (clearWalk(a.x, a.y, p.x, p.y, a.r)) return steer(a, p.x, p.y, speed, dt);
    var t = flowNext(a.x, a.y);
    return t ? steer(a, t.x, t.y, speed, dt) : steer(a, p.x, p.y, speed, dt);
  }

  // ---------------------------------------------------------------------------
  // Combat
  // ---------------------------------------------------------------------------
  function addEffect(e) { e.t = 0; G.effects.push(e); }
  function floatText(x, y, text, color) { addEffect({ type: 'num', x: x + rnd(-0.2, 0.2), y: y - 0.6, text: text, color: color || '#fff', life: 0.8 }); }

  function hurtPlayer(dmg, src) {
    var p = G.player;
    if (p.inv > 0 || p.dead) return;
    p.hp -= dmg; p.inv = 0.45; p.hurt = 0.3; p.calm = 0; G.shake = 0.22;
    floatText(p.x, p.y, '-' + dmg, '#ff6b6b');
    if (src) { var a = Math.atan2(p.y - src.y, p.x - src.x); move(p, Math.cos(a) * 0.25, Math.sin(a) * 0.25, false); }
    if (p.hp <= 0) { p.hp = 0; playerDies(src); }
  }

  function damageActor(a, dmg, kb) {
    var p = G.player;
    dmg = Math.round(dmg);
    a.hp -= dmg; a.flash = 0.12;
    floatText(a.x, a.y, String(dmg), '#ffe08a');
    if (!a.obj) {
      var ang = Math.atan2(a.y - p.y, a.x - p.x);
      var kf = (a.boss ? 0.3 : 1) * (a.state === 'wind' ? BAL.kbWind : 1);
      a.kbx += Math.cos(ang) * kb * kf; a.kby += Math.sin(ang) * kb * kf;
      if (a.state === 'idle' || a.state === 'return') { a.state = 'chase'; alertNear(a); }
      if (a.state === 'wind' && !a.boss) a.t += BAL.windStun;
    }
    if (a.hp <= 0) kill(a);
  }
  function alertNear(a) {
    G.actors.forEach(function (b) {
      if (b.hostile && b.state === 'idle' && Math.hypot(b.x - a.x, b.y - a.y) < 7) b.state = 'chase';
    });
  }

  function kill(a) {
    var i = G.actors.indexOf(a);
    if (i < 0) return;
    G.actors.splice(i, 1);
    addEffect({ type: 'puff', x: a.x, y: a.y, life: 0.5, color: a.obj ? '#ff9a3c' : '#ddd' });
    if (a.obj) addEffect({ type: 'fireburst', x: a.x, y: a.y, life: 1.6 });
    if (a.xp) gainXp(a.xp);
    if (!a.obj && !a.npc) {
      if (Math.random() < (a.boss ? 1 : 0.1)) spawnPickup('potion', a.x + 0.3, a.y, { prov: a.prov });
      if (a.ranged && Math.random() < 0.6) spawnPickup('arrows', a.x - 0.3, a.y, { prov: a.prov, n: 3 + (Math.random() * 4 | 0) });
    }
    if (a.boss) toast('<b>' + esc(a.name) + '</b> is dead.', 6000);
    if (a.qid) Quests.onKill(a);
    else if (a.hostile && !G.actors.some(function (b) { return b.hostile && !b.qid && b.prov === a.prov; })) G.cleared[a.prov] = G.year;
  }

  /** Keyboard aim assist. Sword: turn to the nearest foe within reach. Bow: the best target in a cone ahead. */
  function targets() { return G.actors.filter(function (a) { return a.hostile || a.obj; }); }
  function swordTarget() {
    var p = G.player, best = null, bd = 2.2;
    targets().forEach(function (a) {
      var d = Math.hypot(a.x - p.x, a.y - p.y) - a.r;
      var score = d + angDiff(p.face, Math.atan2(a.y - p.y, a.x - p.x)) * 0.35;
      if (d < 2.2 && score < bd) { bd = score; best = a; }
    });
    return best;
  }
  function bowTarget() {
    var p = G.player, best = null, bs = 1e9;
    if (p.dead) return null;
    targets().forEach(function (a) {
      var d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d > 11) return;
      var ad = angDiff(p.face, Math.atan2(a.y - p.y, a.x - p.x));
      if (ad > 0.9) return;
      if (!clearLine(p.x, p.y, a.x, a.y, true)) return;
      var sc = d * (1 + ad * 1.5);
      if (sc < bs) { bs = sc; best = a; }
    });
    if (best) return best;
    // nothing ahead: turn to the nearest foe you can see, if it's close
    targets().forEach(function (a) {
      var d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d > 7 || !clearLine(p.x, p.y, a.x, a.y, true)) return;
      if (d < bs) { bs = d; best = a; }
    });
    return best;
  }
  function swordAttack() {
    var p = G.player;
    if (p.swingCd > 0 || p.rollT > 0 || p.dead) return;
    var st = swordTarget();
    if (st) p.face = Math.atan2(st.y - p.y, st.x - p.x);
    p.swingT = 0.2; p.swingCd = 0.38;
    addEffect({ type: 'slash', x: p.x, y: p.y, ang: p.face, life: 0.18 });
    var dmg = swordDmg();
    G.actors.slice().forEach(function (a) {
      if (!a.hostile && !a.obj) return;
      var d = Math.hypot(a.x - p.x, a.y - p.y) - a.r;
      if (d > 1.25) return;
      if (d > 0.35 && angDiff(p.face, Math.atan2(a.y - p.y, a.x - p.x)) > 1.25) return;
      damageActor(a, dmg * rnd(0.85, 1.15), 4.5);
    });
  }
  function shoot() {
    var p = G.player;
    if (p.bowCd > 0 || p.rollT > 0 || p.dead) return;
    if (p.arrows <= 0) { if (G.time - (G.noArrowT || -9) > 2) { toast('Out of arrows. Rest in a village (R) to restock.'); G.noArrowT = G.time; } p.bowCd = 0.4; return; }
    p.bowCd = 0.45; p.arrows--; p.bowT = 0.3;
    var bt = bowTarget();
    if (bt) p.face = Math.atan2(bt.y - p.y, bt.x - p.x);
    var sp = 15;
    G.projectiles.push({ x: p.x + Math.cos(p.face) * 0.4, y: p.y + Math.sin(p.face) * 0.4, vx: Math.cos(p.face) * sp, vy: Math.sin(p.face) * sp, dmg: bowDmg(), mine: true, life: 0.85 });
  }
  function enemyShoot(a) {
    var p = G.player, d = Math.hypot(p.x - a.x, p.y - a.y), sp = 9;
    var lead = d / sp * 0.5, tx = p.x + (p.lastVx || 0) * lead, ty = p.y + (p.lastVy || 0) * lead;
    var ang = Math.atan2(ty - a.y, tx - a.x) + rnd(-0.08, 0.08);
    a.face = ang;
    G.projectiles.push({ x: a.x + Math.cos(ang) * 0.4, y: a.y + Math.sin(ang) * 0.4, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, dmg: a.dmg, mine: false, life: 1.4, src: a });
  }
  function roll() {
    var p = G.player;
    if (p.rollCd > 0 || p.dead) return;
    var ix = p.inX || 0, iy = p.inY || 0;
    if (!ix && !iy) { ix = Math.cos(p.face); iy = Math.sin(p.face); }
    var l = Math.hypot(ix, iy);
    p.rollX = ix / l; p.rollY = iy / l; p.rollT = 0.22; p.rollCd = 0.75; p.inv = Math.max(p.inv, 0.3);
  }
  function drinkPotion() {
    var p = G.player, m = maxHp(p);
    if (p.dead) return;
    if (p.potions <= 0) { toast('No potions left.'); return; }
    if (p.hp >= m) { toast('You are already at full health.'); return; }
    p.potions--;
    var h = Math.round(m * BAL.potion + 10);
    p.hp = Math.min(m, p.hp + h);
    floatText(p.x, p.y, '+' + h, '#7dffa0');
    addEffect({ type: 'ring', x: p.x, y: p.y, life: 0.5, color: '#7dffa0' });
  }

  function playerDies(src) {
    var p = G.player;
    p.dead = true;
    if (G.simMode) return;
    G.actors.forEach(function (a) { if (a.hostile) { a.state = 'return'; } });
    setTimeout(function () {
      if (G.stage === 'prologue' || G.stage === 'trial' || G.stage === 'await') {
        dialog({ kicker: 'Year ' + G.year, title: 'You wake', html: '<p>You come to in your own village, aching and bandaged. Your family carried you home; the healer kept you alive. A season has passed.</p>', buttons: [{ label: 'Get up', fn: function () {
          var pi = G.home.birth, f = findFree(pi, C + 1, C + 1);
          p.x = f.x; p.y = f.y; p.dead = false; p.hp = maxHp(p); p.inv = 2;
          passMonths(3); resetActors();
        } }] });
      } else passOn('slain', src);
    }, 900);
  }

  /** The Chronoscope passes to someone young: a new bearer, same history. */
  function passOn(why, src) {
    var old = G.player, s = G.s, hc = homeCiv();
    var best = -1, bd = 1e9, opi = provOf(old.x, old.y);
    for (var i = 0; i < N; i++) {
      if (s.pop[i] <= 0 || s.owner[i] < 0) continue;
      var d = md(i, opi) + (s.owner[i] === hc ? 0 : 6);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) best = opi;
    var c = s.owner[best], sig = c >= 0 ? s.cSig[c] : G.home.sig;
    var name = Story.personName(sig, G.world.seed + old.lives * 7919);
    var p = newPlayer(name, old.level, old.lives + 1);
    var f = findFree(best, C + 1, C + 1) || { x: old.x, y: old.y };
    p.x = f.x; p.y = f.y;
    G.player = p;
    Quests.abandonAll('the bearer is gone');
    resetActors();
    G.cam.x = p.x; G.cam.y = p.y;
    var how = why === 'old' ? '<p><b>' + esc(old.name) + '</b> grows old. At ' + old.age + ', with failing breath, they press the Chronoscope into younger hands.</p>'
      : '<p><b>' + esc(old.name) + '</b> falls' + (src ? ' to ' + (src.beast ? 'a ' : 'the ') + esc(src.name.toLowerCase()) : '') + ' in the year ' + G.year + ', aged ' + old.age + '. Whoever finds the body finds the Chronoscope, humming.</p>';
    journal(esc(old.name) + (why === 'old' ? ' dies of old age' : ' is slain') + '. ' + esc(name) + ' takes up the Chronoscope.');
    dialog({ kicker: 'Year ' + G.year, title: 'The Chronoscope passes on', html: how +
      '<p>It finds <b>' + esc(name) + '</b>, twenty years old, ' + (c >= 0 ? 'of the <b>' + esc(civName(sig)) + '</b>.</p><p>' + Story.peopleSketch(s, c) : 'a wanderer.') + '</p>' +
      '<p>Every deed of the earlier bearers still stands. The instrument keeps something of their strength, too: you begin at <b>level ' + p.level + '</b>. Their unfinished quests are forgotten.</p>',
      buttons: [{ label: 'Take it up' }] });
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------
  function update(dt) {
    G.time += dt;
    updatePlayer(dt);
    var p = G.player;
    G.flowT = (G.flowT || 0) - dt;
    if (G.flowT <= 0) { updateFlow(); G.flowT = 0.2; }
    for (var k = G.actors.length - 1; k >= 0; k--) { var a = G.actors[k]; if (a) updateActor(a, dt); }
    separate();
    updateProjectiles(dt);
    updatePickups(dt);
    for (k = G.effects.length - 1; k >= 0; k--) { var e = G.effects[k]; e.t += dt; if (e.t >= e.life) G.effects.splice(k, 1); }
    G.activeT -= dt;
    if (G.activeT <= 0) { if (!G.noSpawn) manageActive(); G.activeT = 0.25; }
    var ppi = provOf(p.x, p.y);
    if (ppi !== G.lastProv) { G.lastProv = ppi; Quests.enterProvince(ppi); }
    G.cam.x += (p.x - G.cam.x) * Math.min(1, dt * 8);
    G.cam.y += (p.y - G.cam.y) * Math.min(1, dt * 8);
    G.shake = Math.max(0, G.shake - dt);
  }

  function updatePlayer(dt) {
    var p = G.player;
    p.swingT -= dt; p.swingCd -= dt; p.bowCd -= dt; p.rollCd -= dt; p.inv -= dt; p.hurt -= dt; p.bowT -= dt;
    if (p.dead) return;
    var ix = 0, iy = 0, K = G.keys;
    if (K.w || K.arrowup) iy -= 1;
    if (K.s || K.arrowdown) iy += 1;
    if (K.a || K.arrowleft) ix -= 1;
    if (K.d || K.arrowright) ix += 1;
    var l = Math.hypot(ix, iy);
    if (l) { ix /= l; iy /= l; }
    p.inX = ix; p.inY = iy;
    var ox = p.x, oy = p.y;
    if (p.rollT > 0) {
      p.rollT -= dt;
      move(p, p.rollX * 10.5 * dt, p.rollY * 10.5 * dt, false);
    } else if (l) {
      var sp = 4.5 * L.speedAt(G.s, p.x, p.y) * (p.hp < maxHp(p) * 0.25 ? 0.85 : 1) * (p.swingT > 0 ? 0.6 : 1);
      move(p, ix * sp * dt, iy * sp * dt, false);
    }
    var dist = Math.hypot(p.x - ox, p.y - oy);
    p.lastVx = (p.x - ox) / dt; p.lastVy = (p.y - oy) / dt;
    p.moving = dist > 0.001;
    if (p.moving) p.walkT += dist * 3;
    p.boat = L.isWaterAt(G.s, p.x, p.y);
    p.distAcc += dist;
    while (p.distAcc >= TILES_PER_MONTH) { p.distAcc -= TILES_PER_MONTH; passMonths(1); }
    // aim: you face the way you move; holding the bow keeps your aim on its target so you can strafe
    G.target = bowTarget();
    if (K.k && G.target) p.face = Math.atan2(G.target.y - p.y, G.target.x - p.x);
    else if (l) p.face = Math.atan2(iy, ix);
    if (K.j) swordAttack();
    if (K.k) shoot();
    // recover out of combat
    var threat = G.actors.some(function (a) { return a.hostile && a.state !== 'idle' && a.state !== 'return' && Math.hypot(a.x - p.x, a.y - p.y) < 10; });
    p.calm = threat ? 0 : p.calm + dt;
    if (p.calm > 3 && p.hp < maxHp(p)) {
      var pi = provOf(p.x, p.y), home = G.s.pop[pi] > 0 && G.s.owner[pi] >= 0;
      p.hp = Math.min(maxHp(p), p.hp + (home ? 3 : 0.8) * dt);
    }
  }

  function updateActor(a, dt) {
    a.flash -= dt; a.cd -= dt; a.cd2 -= dt;
    if (a.deco) return;
    if (a.kbx || a.kby) {
      move(a, a.kbx * dt, a.kby * dt, true);
      var dec = Math.pow(0.0005, dt);
      a.kbx *= dec; a.kby *= dec;
      if (Math.abs(a.kbx) + Math.abs(a.kby) < 0.05) a.kbx = a.kby = 0;
    }
    if (a.obj) return;
    var p = G.player, dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
    if (a.npc) {
      if (d < 2 && !p.dead) { a.face = Math.atan2(dy, dx); return; }
      a.wt -= dt;
      if (a.wt <= 0) {
        var rr = a.role === 'villager' || a.role === 'settler' ? 3.5 : 0.8;
        a.wx = a.hx + rnd(-rr, rr); a.wy = a.hy + rnd(-rr, rr); a.wt = rnd(2, 6);
      }
      if (steer(a, a.wx, a.wy, a.speed, dt) > 0.001) { a.face = Math.atan2(a.wy - a.y, a.wx - a.x); a.walkT += a.speed * dt * 3; }
      return;
    }
    var home = Math.hypot(a.x - a.hx, a.y - a.hy);
    if (p.dead && a.state !== 'idle') a.state = 'return';
    switch (a.state) {
      case 'idle':
        a.wt -= dt;
        if (a.wt <= 0) { a.wx = a.hx + rnd(-2.5, 2.5); a.wy = a.hy + rnd(-2.5, 2.5); a.wt = rnd(2, 5); }
        if (steer(a, a.wx, a.wy, a.speed * 0.35, dt) > 0.001) { a.face = Math.atan2(a.wy - a.y, a.wx - a.x); a.walkT += a.speed * dt; }
        a.ignoreT = (a.ignoreT || 0) - dt;
        if (!p.dead && d < a.aggro && (!p.boat || d < 3) && a.ignoreT <= 0) { a.state = 'chase'; alertNear(a); }
        break;
      case 'chase':
        if (home > 18 || d > a.aggro * 2.4 || (p.boat && d > 4)) { a.state = 'return'; break; }
        // can't get to you (across water, walled in, no line of fire)? give up for a while rather than jitter in place
        a.chkT = (a.chkT || 0) + dt;
        if (a.chkT >= 1) {
          var far = d > a.reach + p.r + 0.3, still = Math.hypot(a.x - (a.chkX || 0), a.y - (a.chkY || 0)) < 0.35;
          var shooting = a.ranged && a.shotT != null && G.time - a.shotT < 2.5;
          a.stuck = far && still && !shooting ? (a.stuck || 0) + 1 : 0;
          a.chkT = 0; a.chkX = a.x; a.chkY = a.y;
          if (a.stuck >= 3) { a.stuck = 0; a.state = 'return'; a.ignoreT = 5; break; }
        }
        a.face = Math.atan2(dy, dx);
        if (a.ranged) {
          var sight = clearLine(a.x, a.y, p.x, p.y, true);
          if (d > 6.5 || !sight) pursue(a, a.speed, dt);
          else if (d < 3.5) steer(a, a.x - dx, a.y - dy, a.speed * 0.8, dt);
          else steer(a, a.x - dy * 0.3, a.y + dx * 0.3, a.speed * 0.4, dt);
          a.walkT += a.speed * dt * 2;
          if (a.cd <= 0 && d < 10 && sight) { a.state = 'aim'; a.t = 0.45; }
        } else if (a.boss && a.cd2 <= 0 && d > 2.8 && d < 8) {
          a.state = 'chargeWind'; a.t = 0.65;
        } else if (d > a.reach * 0.8 + p.r) {
          pursue(a, a.speed, dt);
          a.walkT += a.speed * dt * 3;
        } else if (a.cd <= 0) { a.state = 'wind'; a.t = a.wind; }
        break;
      case 'aim':
        a.face = Math.atan2(dy, dx);
        a.t -= dt;
        if (a.t <= 0) { if (clearLine(a.x, a.y, p.x, p.y, true)) { enemyShoot(a); a.shotT = G.time; } a.state = 'chase'; a.cd = rnd(1.3, 2.1); }
        break;
      case 'wind':
        a.t -= dt;
        if (a.t <= 0) {
          addEffect({ type: 'eslash', x: a.x, y: a.y, ang: a.face, life: 0.15, r: a.reach });
          if (d < a.reach + p.r && angDiff(a.face, Math.atan2(dy, dx)) < 1.15) hurtPlayer(a.dmg, a);
          a.state = 'recover'; a.t = a.boss ? 0.5 : BAL.recover; a.cd = rnd(BAL.cdMin, BAL.cdMax);
        }
        break;
      case 'chargeWind':
        a.face = Math.atan2(dy, dx);
        a.t -= dt;
        if (a.t <= 0) { a.state = 'charge'; a.t = 0.55; a.hitCharge = false; }
        break;
      case 'charge':
        a.t -= dt;
        var cm = move(a, Math.cos(a.face) * a.speed * 3.4 * dt, Math.sin(a.face) * a.speed * 3.4 * dt, true);
        if (!a.hitCharge && d < a.r + p.r + 0.25) { a.hitCharge = true; hurtPlayer(Math.round(a.dmg * 1.3), a); }
        if (a.t <= 0 || cm < 0.001) { a.state = 'recover'; a.t = 0.8; a.cd2 = rnd(4, 6); }
        break;
      case 'recover':
        a.t -= dt;
        if (a.t <= 0) a.state = 'chase';
        break;
      case 'return':
        if (steer(a, a.hx, a.hy, a.speed, dt) < 0.0005 && home > 1) { a.x = a.hx; a.y = a.hy; }
        a.walkT += a.speed * dt * 3;
        a.face = Math.atan2(a.hy - a.y, a.hx - a.x);
        a.hp = Math.min(a.maxHp, a.hp + a.maxHp * 0.2 * dt);
        if (home < 1) a.state = 'idle';
        a.ignoreT = (a.ignoreT || 0) - dt;
        if (!p.dead && d < a.aggro * 0.6 && home < 10 && a.ignoreT <= 0) a.state = 'chase';
        break;
    }
  }

  function separate() {
    var A = G.actors, p = G.player;
    for (var i = 0; i < A.length; i++) {
      var a = A[i];
      if (a.deco) continue;
      for (var j = i + 1; j < A.length; j++) {
        var b = A[j];
        if (b.deco) continue;
        var dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), m = a.r + b.r;
        if (d >= m || d < 1e-4) continue;
        var push = (m - d) / 2, ux = dx / d, uy = dy / d;
        if (!a.obj) move(a, -ux * push, -uy * push, true);
        if (!b.obj) move(b, ux * push, uy * push, true);
      }
      if (!p.dead && p.rollT <= 0) {
        var ex = a.x - p.x, ey = a.y - p.y, ed = Math.hypot(ex, ey), em = a.r + p.r;
        if (ed < em && ed > 1e-4) {
          if (a.obj || a.npc) move(p, -ex / ed * (em - ed), -ey / ed * (em - ed), false);
          else move(a, ex / ed * (em - ed), ey / ed * (em - ed), true);
        }
      }
    }
  }

  function updateProjectiles(dt) {
    var p = G.player;
    for (var k = G.projectiles.length - 1; k >= 0; k--) {
      var pr = G.projectiles[k], hit = false;
      pr.life -= dt;
      var steps = 3;
      for (var s = 0; s < steps && !hit; s++) {
        pr.x += pr.vx * dt / steps; pr.y += pr.vy * dt / steps;
        if (L.blocksShot(G.s, Math.floor(pr.x), Math.floor(pr.y), G.ver)) { hit = true; addEffect({ type: 'puff', x: pr.x, y: pr.y, life: 0.25, color: '#bba' }); break; }
        if (pr.mine) {
          for (var i = 0; i < G.actors.length; i++) {
            var a = G.actors[i];
            if ((!a.hostile && !a.obj) || Math.hypot(a.x - pr.x, a.y - pr.y) > a.r + 0.12) continue;
            damageActor(a, pr.dmg * rnd(0.9, 1.1), 3);
            hit = true; break;
          }
        } else if (!p.dead && Math.hypot(p.x - pr.x, p.y - pr.y) < p.r + 0.12) {
          if (p.inv <= 0) { hurtPlayer(pr.dmg, pr.src); hit = true; }
        }
      }
      if (hit || pr.life <= 0) G.projectiles.splice(k, 1);
    }
  }

  function updatePickups(dt) {
    var p = G.player;
    if (p.dead) return;
    for (var k = G.pickups.length - 1; k >= 0; k--) {
      var pk = G.pickups[k];
      pk.t += dt;
      if (Math.hypot(pk.x - p.x, pk.y - p.y) > 0.8) continue;
      if (pk.kind === 'potion') { if (p.potions >= 6) continue; p.potions++; floatText(p.x, p.y, '+1 potion', '#ff8ad8'); }
      else if (pk.kind === 'arrows') { if (p.arrows >= 40) continue; p.arrows = Math.min(40, p.arrows + pk.n); floatText(p.x, p.y, '+' + pk.n + ' arrows', '#e8d8a8'); }
      G.pickups.splice(k, 1);
      if (pk.qid) Quests.onPickup(pk);
    }
  }

  // ---------------------------------------------------------------------------
  // Talking
  // ---------------------------------------------------------------------------
  function nearestTalker() {
    var p = G.player, best = null, bd = 1.8;
    G.actors.forEach(function (a) {
      if (!a.npc) return;
      var d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < bd) { bd = d; best = a; }
    });
    return best;
  }

  function localReport(pi) {
    var s = G.s, c = s.owner[pi];
    if (c < 0) return '';
    var A = Sim.meanAsab(s, c), name = esc(civName(s.cSig[c])), bits = [];
    bits.push('We are the <b>' + name + '</b>, a people of the ' + Sim.AGES[Sim.ageOf(s.cTech[c])].name + ', ' + fmtPop(s.sPop[c]) + ' souls in ' + s.sTiles[c] + ' provinces.');
    bits.push(A >= 6000 ? 'Our people stand together like one family.' : A >= 3500 ? 'We are proud, though the nobles quarrel.' : A >= 2000 ? 'People grumble about the court, and few would answer a call to arms.' : 'Nobody trusts anybody any more. Some say the realm is finished.');
    if (s.starve[pi]) bits.push('The harvest failed and people are hungry.');
    if (s.plague[pi]) bits.push('The sickness is here.');
    return '<p>' + bits.join(' ') + '</p>';
  }

  function villagerLine(a) {
    var s = G.s, pi = a.prov, c = s.owner[pi], lines = [];
    if (s.plague[pi]) lines.push('Stay back! My whole street is coughing.', 'They say the rats bring it. I say it\'s the gods.');
    if (s.starve[pi]) lines.push('There\'s no bread. The fields gave nothing this year.', 'My children are hungry, stranger.');
    if (c >= 0) {
      var A = Sim.meanAsab(s, c);
      if (A < 2000) lines.push('The tax men take and take. What has the throne ever done for us?', 'If the enemy came tomorrow, I doubt anyone would fight.');
      if (A > 6000) lines.push('We\'d follow ' + esc(rulerName(s.cSig[c])) + ' into the sea!', 'Our realm is strong. Strangers are welcome, if they mean no harm.');
      var hc = homeCiv();
      if (hc >= 0 && c !== hc && G.home) lines.push('You talk like one of the ' + esc(G.home.name) + '. We don\'t see many of you here.');
      lines.push('The ' + esc(civName(s.cSig[c])) + ' have farmed this land since my grandmother\'s grandmother.', 'Have you spoken to the elder? They always need help with something.', 'Fine weather for ' + MONTHS[G.month] + '.');
    }
    return lines[(a.id + Math.floor(G.time / 20)) % lines.length];
  }

  function talk(a) {
    var q = Quests.turnIn(a);
    if (q) {
      dialog({ kicker: a.name, title: q.title, html: '<p>"You have done it. Thank you." Word of what you did spreads.</p>', buttons: [{ label: 'Continue' }] });
      return;
    }
    switch (a.role) {
      case 'villager': dialog({ kicker: 'Villager', title: '', html: '<p>"' + villagerLine(a) + '"</p>', buttons: [{ label: 'Goodbye' }] }); return;
      case 'settler': dialog({ kicker: 'Settler', title: '', html: '<p>"We\'ll make a home of this place, if the beasts let us."</p>', buttons: [{ label: 'Goodbye' }] }); return;
      case 'sentry': dialog({ kicker: a.name, title: '', html: '<p>"Keep your hand away from that sword, stranger, and move along."</p>', buttons: [{ label: 'Goodbye' }] }); return;
      case 'lord': dialog({ kicker: civName(a.faction), title: a.name, html: '<p>' + esc(a.name) + ' of the <b>' + esc(civName(a.faction)) + '</b> looks you over. "A traveller. Speak quickly; I have a realm to rule."</p>' + localReport(a.prov), buttons: [{ label: 'Bow and leave' }] }); return;
      case 'stranger': visionTalk(a); return;
      case 'royal': if (royalTalk(a)) return; break;
    }
    var waiting = Quests.waitingOn(a);
    if (waiting) {
      var obj = Quests.objectives().filter(function (o) { return o.q === waiting; })[0];
      dialog({ kicker: a.name, title: waiting.title, html: '<p>"Is it done?"</p><p class="obj">' + (obj ? esc(obj.text) + (obj.pi >= 0 ? ', ' + dirText(provOf(G.player.x, G.player.y), obj.pi) : '') : '') + '</p>', buttons: [{ label: 'Not yet' }] });
      return;
    }
    var intro = '', offers = Quests.offersFor(a);
    if (a.role === 'elder') intro = '<p>' + esc(a.name) + ' leans on a staff.</p>' + localReport(a.prov);
    else if (a.role === 'spymaster') intro = spymasterIntro();
    else if (a.role === 'scholar') intro = scholarIntro();
    else if (a.role === 'royal') intro = royalIntro(a);
    if (!offers.length) {
      dialog({ kicker: a.name, title: '', html: intro + '<p>"' + (G.quests.length >= 6 ? 'You have enough on your plate, friend.' : 'I have nothing to ask of you today.') + '"</p>', buttons: [{ label: 'Goodbye' }] });
      return;
    }
    offerDialog(a, intro, offers);
  }

  function offerDialog(a, intro, offers, idx) {
    idx = idx || 0;
    var q = offers[idx], btns = [{ label: 'Accept', fn: function () { Quests.accept(q); } }];
    if (offers.length > 1) btns.push({ label: 'Something else?', fn: function () { offerDialog(a, '', offers, (idx + 1) % offers.length); }, keep: true });
    btns.push({ label: 'Not now' });
    dialog({ kicker: a.name, title: q.title, html: intro + Quests.describe(q), buttons: btns });
  }

  function spymasterIntro() {
    var s = G.s, hc = homeCiv(), fc = foeCiv();
    if (fc < 0 || hc < 0) return '<p>"No realm threatens us now."</p>';
    var d = Story.danger(s, G.home.sig, s.cSig[fc]);
    return '<p>The spymaster speaks quietly. "The <b>' + esc(civName(s.cSig[fc])) + '</b> are ' + (d && d.ratio ? (1 / d.ratio).toFixed(1) + '× as strong as we are' : 'dangerous') +
      ' (' + fmtPop(s.sPop[fc]) + ' people, solidarity ' + pct(Sim.meanAsab(s, fc)) + ', ' + Sim.AGES[Sim.ageOf(s.cTech[fc])].name + '). Ours stands at ' + pct(Sim.meanAsab(s, hc)) + '."</p>' +
      (G.renown < RENOWN_REGICIDE ? '<p class="muted">"There is darker work I could give you, but I don\'t know you yet. Serve our people (renown ' + G.renown + ' of ' + RENOWN_REGICIDE + ') and we\'ll talk again."</p>' : '');
  }
  function scholarIntro() {
    var s = G.s, hc = homeCiv();
    if (hc < 0) return '';
    var cap = s.cCap[hc], best = -1;
    for (var c = 0; c < s.g[1]; c++) {
      if (!s.cAlive[c] || s.sTiles[c] <= 0 || c === hc) continue;
      if (md(s.cCap[c], cap) > 30) continue;
      if (best < 0 || s.cTech[c] > s.cTech[best]) best = c;
    }
    var k = G.player.knowledge;
    var t = '<p>"Our people know what any ' + Sim.AGES[Sim.ageOf(s.cTech[hc])].name + ' people knows (' + s.cTech[hc] + ').';
    if (best >= 0 && s.cTech[best] > s.cTech[hc] + 100) t += ' The most learned people within reach are the <b>' + esc(civName(s.cSig[best])) + '</b>, ' + dirText(cap, s.cCap[best]) + ', in the ' + Sim.AGES[Sim.ageOf(s.cTech[best])].name + ' (' + s.cTech[best] + '). Their elders guard their learning; help them and they may let you study it. Then come back and teach us.';
    if (k) t += ' You carry the learning of the ' + esc(civName(k.sig)) + ' (' + k.tech + ').';
    return t + '"</p>';
  }
  function royalIntro(a) {
    var hc = homeCiv(), s = G.s;
    if (hc < 0) return '';
    return '<p>' + esc(a.name) + ' greets you as one of their own.</p>' + localReport(s.cCap[hc]);
  }

  function royalTalk(a) {
    var hc = homeCiv();
    if (hc < 0 || a.faction !== G.home.sig) return false;
    if (G.stage === 'prologue') {
      dialog({ kicker: 'Prologue · Year ' + G.year, title: 'The oath', html:
        '<p>The hall is smoky and loud. When your name is called you kneel before <b>' + esc(a.name) + '</b>, and you swear the oath your parents swore.</p>' +
        '<p>The ruler studies you. "Words are cheap. Raiders have been robbing travellers on the roads near the capital. Clear them out and come back to me, and I will know what you are worth."</p>',
        buttons: [{ label: 'I will', fn: function () { startTrial(a); } }] });
      return true;
    }
    if (G.stage === 'trial' || G.stage === 'await') {
      if (Quests.waitingOn(a)) return false;
      dialog({ kicker: a.name, title: '', html: '<p>"You have served well. Rest now; you have earned it."</p>', buttons: [{ label: 'Goodbye' }] });
      return true;
    }
    return false;
  }

  function startTrial(a) {
    var s = G.s, hc = homeCiv(), cap = s.cCap[hc];
    var near = Quests.around(cap, 2, function (j, d) { return d >= 1 && s.terrain[j] !== TER.MOUNTAIN; });
    var cp = near.length ? near[0].pi : cap;
    var q = Quests.make('trial', {
      title: 'Raiders on the king\'s road', giverKey: a.key, giverName: a.name, returnKey: a.key, returnPi: a.prov, returnName: a.name,
      story: 'Clear the raiders ' + dirText(cap, cp) + ' and return to ' + esc(a.name) + '.',
      enc: [Quests.enc(cp, { foes: ['bandit', 'bandit', 'archer'], label: 'Clear the raiders' })],
      deeds: [{ type: 'rally', pi: cap }], xp: 40, potions: 1
    });
    Quests.accept(q);
    G.stage = 'trial';
    journal('You swear the oath before ' + esc(a.name) + '.');
  }

  function onQuestDone(q) {
    // renown: how much your own people trust you
    var hs = G.home ? String(G.home.sig) : '', key = q.giverKey || '', forHome = key.split(':')[1] === hs;
    if (key.indexOf('elder:') === 0) { var hc = homeCiv(), epi = +key.split(':')[1]; forHome = hc >= 0 && G.s.owner[epi] === hc; }
    if (forHome) {
      G.renown++;
      if (G.renown === RENOWN_REGICIDE && (G.stage === 'quest' || G.stage === 'won')) toast('Your name is known across the realm. <b>The spymaster</b> will trust you with their darkest work now.', 8000);
    }
    if (q.kind === 'trial') {
      G.stage = 'await';
      toast('Word of your deed spreads through the capital. That night, <b>a stranger in a grey cloak</b> asks for you by name…', 8000);
    }
  }

  function visionTalk(a) {
    var pr = Story.prophecy(G.cur, G.home.sig, G.year);
    G.actors.splice(G.actors.indexOf(a), 1);
    if (!pr) {
      G.stage = 'won';
      dialog({ kicker: 'Year ' + G.year, title: 'The Chronoscope', html: '<p>The stranger presses a brass instrument into your hands. In its glass you see centuries pass, and the banners of the <b>' + esc(G.home.name) + '</b> never fall.</p><p>History is yours to wander. Press <b>T</b> to look through the Chronoscope and travel in time.</p>', buttons: [{ label: 'Wander' }] });
      respawnCapital();
      return;
    }
    G.goal = { end: pr.end, target: pr.target, foeSig: pr.foeSig, why: pr.why };
    G.stage = 'quest';
    journal('A stranger gives you the Chronoscope and shows you the fall of your people in the year ' + pr.end + '.');
    var w = pr.why;
    dialog({ kicker: 'Chapter one · Year ' + G.year, title: 'The Chronoscope', html:
      '<p>The stranger does not give a name. They press a brass instrument into your hands, cold and humming, and in its glass you see the years run like water. Villages grow and burn. Then, ' + (pr.end - G.year) + ' years from now:</p>' +
      '<p class="vision">Year ' + pr.end + '. ' + esc(pr.vision) + '</p>' +
      (w && w.verdict ? '<p><b>Why:</b> ' + w.verdict + '</p>' : '') +
      (w && w.advice && w.advice.length ? '<p class="advice">' + w.advice[0] + '</p>' : '') +
      '<p><b>Save the ' + esc(G.home.name) + ': they must still hold land in the year ' + pr.target + '.</b></p>' +
      '<p>Every quest you finish is a deed that history remembers. Press <b>T</b> to look through the Chronoscope: see how your people fare in this timeline, and <b>travel to any year</b> to act where it matters. Travelling does not age you; living does.</p>' +
      '<p>The ruler\'s <b>spymaster</b> and <b>scholar</b> will have work for you in the capital now.</p>',
      buttons: [{ label: 'Take up the Chronoscope' }] });
    respawnCapital();
  }
  function respawnCapital() {
    var hc = homeCiv();
    if (hc < 0) return;
    var cap = G.s.cCap[hc];
    if (G.active[cap] != null) { despawnProv(cap, true); spawnProvince(cap, false); }
  }

  function storyFrame() {
    if (G.stage === 'await' && G.world.isComplete(G.cur) && !G.actors.some(function (a) { return a.role === 'stranger'; }) && !G.modal) {
      var p = G.player;
      spawnNear('stranger', p.x + Math.cos(p.face + 1.5) * 2.5, p.y + Math.sin(p.face + 1.5) * 2.5, { name: 'A stranger in grey', prov: provOf(p.x, p.y) });
    }
    if (G.stage === 'quest' && G.goal && !G.modal) {
      var f = curFate();
      if (f.state !== 'pending' && saved(f) && !G.fateWatch) {
        G.stage = 'won';
        journal('<b>The ' + esc(G.home.name) + ' are saved.</b>');
        dialog({ kicker: 'Year ' + G.year, title: 'The thread holds', html:
          '<p>In the glass of the Chronoscope the years run past ' + G.goal.target + ', and the banners of the <b>' + esc(G.home.name) + '</b> are still flying.</p>' +
          '<p>In the world without you they fell in ' + G.goal.end + '. ' + fateText(f) + '</p>' +
          '<p>You did it in <b>' + G.deeds.length + ' deed' + (G.deeds.length === 1 ? '' : 's') + '</b>, across ' + G.player.lives + ' li' + (G.player.lives === 1 ? 'fe' : 'ves') + '.</p>' +
          '<p>History is yours to wander. Keep adventuring, or start a new world from the title screen.</p>',
          buttons: [{ label: 'Wander on' }] });
      }
    }
    watchFate();
    tendOracle();
  }

  function tendOracle() {
    if (G.stage !== 'quest' || !G.goal || !G.world.isComplete(G.cur)) return;
    var f = curFate();
    if (f.state !== 'falls') return;
    var key = G.cur.id + ':' + G.cur.version;
    if (!G.oracle || G.oracle.key !== key) {
      G.oracle = new Oracle({ world: G.world, branch: G.cur, homeSig: G.home.sig, foeSig: G.goal.foeSig, end: f.end, target: G.goal.target, every: 20 });
      G.oracle.key = key;
    }
  }

  // ---------------------------------------------------------------------------
  // Resting and time travel
  // ---------------------------------------------------------------------------
  function rest() {
    var p = G.player, s = G.s, pi = provOf(p.x, p.y);
    if (p.dead) return;
    if (s.pop[pi] <= 0 || s.owner[pi] < 0) { toast('You can only rest in a village or town.'); return; }
    if (G.actors.some(function (a) { return a.hostile && Math.hypot(a.x - p.x, a.y - p.y) < 12; })) { toast('You cannot rest with enemies nearby.'); return; }
    passMonths(3);
    p.hp = maxHp(p); p.arrows = 40; p.potions = Math.min(5, Math.max(p.potions, p.potions + 1));
    toast('You rest a season among the ' + esc(civName(s.cSig[s.owner[pi]])) + '. Health restored, quiver full, +1 potion. It is now ' + MONTHS[G.month] + ', year ' + G.year + '.', 6000);
  }

  function travelTo(y) {
    y = clamp(y | 0, 1, HORIZON - 1);
    var p = G.player;
    if (y === G.year) return;
    var from = G.year;
    Quests.abandonAll('the age they belonged to is gone');
    seekYear(y);
    G.month = 2;
    G.edgeWarned = false;
    resetActors();
    var f = findFreeNear(p.x, p.y, 8);
    if (f && collides(p.x, p.y, p.r, false)) { p.x = f.x; p.y = f.y; }
    addEffect({ type: 'ring', x: p.x, y: p.y, life: 1.2, color: '#9fe8ff' });
    G.flash = 0.8;
    journal('You travel from ' + from + ' to the year ' + y + '.');
    toast('The glass clears. It is the year <b>' + y + '</b>.' + (y < from ? ' Whatever you do now will rewrite everything after it.' : ''), 6000);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  var canvas, ctx, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    G.vw = window.innerWidth; G.vh = window.innerHeight;
    canvas.width = Math.round(G.vw * dpr); canvas.height = Math.round(G.vh * dpr);
    canvas.style.width = G.vw + 'px'; canvas.style.height = G.vh + 'px';
  }

  function render() {
    var vw = G.vw, vh = G.vh, p = G.player, s = G.s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    var sx = G.shake > 0 ? rnd(-3, 3) : 0, sy = G.shake > 0 ? rnd(-3, 3) : 0;
    var ox = Math.round(vw / 2 - G.cam.x * TS + sx), oy = Math.round(vh / 2 - G.cam.y * TS + sy);
    var px0 = Math.floor((G.cam.x - vw / 2 / TS) / P) - 1, px1 = Math.floor((G.cam.x + vw / 2 / TS) / P) + 1;
    var py0 = Math.floor((G.cam.y - vh / 2 / TS) / P) - 1, py1 = Math.floor((G.cam.y + vh / 2 / TS) / P) + 1;
    ctx.fillStyle = '#22466e'; ctx.fillRect(0, 0, vw, vh);
    var py, px, pi;
    for (py = py0; py <= py1; py++) for (px = px0; px <= px1; px++) {
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      pi = py * W + px;
      ctx.drawImage(L.renderProvince(s, pi, G.ver), ox + px * P * TS, oy + py * P * TS);
    }
    // plague miasma
    for (py = py0; py <= py1; py++) for (px = px0; px <= px1; px++) {
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      pi = py * W + px;
      if (!s.plague[pi]) continue;
      var bx = ox + px * P * TS, by = oy + py * P * TS;
      ctx.fillStyle = 'rgba(110,150,50,0.16)'; ctx.fillRect(bx, by, P * TS, P * TS);
      ctx.fillStyle = 'rgba(170,210,90,0.35)';
      for (var k = 0; k < 14; k++) {
        var fx = (k * 97 + G.time * (8 + k % 5)) % (P * TS), fy = (k * 53 + Math.sin(G.time + k) * 20 + 400) % (P * TS);
        ctx.beginPath(); ctx.arc(bx + fx, by + fy, 2 + (k % 3), 0, 7); ctx.fill();
      }
    }
    // objects sorted by depth
    var list = [];
    G.pickups.forEach(function (pk) { list.push({ y: pk.y - 0.5, pk: pk }); });
    G.actors.forEach(function (a) { list.push({ y: a.y, a: a }); });
    if (!p.dead) list.push({ y: p.y, me: true });
    list.sort(function (a, b) { return a.y - b.y; });
    list.forEach(function (o) {
      if (o.pk) drawPickup(o.pk, ox + o.pk.x * TS, oy + o.pk.y * TS);
      else if (o.a) drawActor(o.a, ox + o.a.x * TS, oy + o.a.y * TS);
      else drawPlayer(p, ox + p.x * TS, oy + p.y * TS);
    });
    G.projectiles.forEach(function (pr) {
      var x = ox + pr.x * TS, y = oy + pr.y * TS, a = Math.atan2(pr.vy, pr.vx);
      ctx.strokeStyle = pr.mine ? '#f4e2b0' : '#ffb0a0'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - Math.cos(a) * 12, y - Math.sin(a) * 12); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = '#ddd'; ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill();
    });
    G.effects.forEach(function (e) { drawEffect(e, ox, oy); });
    // objective markers
    objectiveList().forEach(function (o) { if (o.pi >= 0) drawMarker(o, ox, oy); });
    // season tint
    var m = G.month;
    if (m <= 1 || m === 11) { ctx.fillStyle = 'rgba(210,225,255,0.13)'; ctx.fillRect(0, 0, vw, vh); }
    else if (m >= 8) { ctx.fillStyle = 'rgba(200,120,40,0.07)'; ctx.fillRect(0, 0, vw, vh); }
    // talk prompt
    var t = !G.modal && !p.dead && nearestTalker();
    if (t) {
      var tx = ox + t.x * TS, ty = oy + t.y * TS - 46;
      var label = 'E · ' + t.name;
      ctx.font = '600 13px system-ui, sans-serif';
      var tw = ctx.measureText(label).width + 16;
      ctx.fillStyle = 'rgba(15,18,28,0.85)'; roundRect(tx - tw / 2, ty - 12, tw, 22, 6); ctx.fill();
      ctx.fillStyle = '#ffe9a8'; ctx.textAlign = 'center'; ctx.fillText(label, tx, ty + 4); ctx.textAlign = 'left';
    }
    if (p.hurt > 0) { ctx.fillStyle = 'rgba(200,30,30,' + (p.hurt * 0.6) + ')'; ctx.fillRect(0, 0, vw, vh); }
    if (G.flash > 0) { ctx.fillStyle = 'rgba(190,240,255,' + Math.min(1, G.flash) + ')'; ctx.fillRect(0, 0, vw, vh); G.flash -= 1 / 60; }
    var lowHp = !p.dead && p.hp < maxHp(p) * 0.3;
    if (lowHp) {
      var gr = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.35, vw / 2, vh / 2, Math.max(vw, vh) * 0.7);
      gr.addColorStop(0, 'rgba(120,0,0,0)'); gr.addColorStop(1, 'rgba(120,0,0,' + (0.35 + Math.sin(G.time * 5) * 0.1) + ')');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, vw, vh);
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function shadow(x, y, r) { ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(x, y + 2, r, r * 0.4, 0, 0, 7); ctx.fill(); }

  function drawHuman(x, y, o) {
    // o: { body, head, face, walk, hat, r, weapon, flash, wind, boat }
    var r = (o.r || 0.3) * TS, bob = Math.sin(o.walk || 0) * 1.5;
    if (o.boat) {
      ctx.fillStyle = '#6a4424'; ctx.beginPath(); ctx.ellipse(x, y + 2, r * 1.9, r * 0.9, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#8a5c34'; ctx.beginPath(); ctx.ellipse(x, y, r * 1.5, r * 0.6, 0, 0, 7); ctx.fill();
    } else shadow(x, y, r * 1.1);
    var by = y - r * 0.9 + bob;
    // feet
    if (!o.boat) {
      ctx.fillStyle = '#3a2a1e';
      var st = Math.sin(o.walk || 0) * 3;
      ctx.fillRect(x - r * 0.55, y - 3 + st * 0.3, 5, 4); ctx.fillRect(x + r * 0.15, y - 3 - st * 0.3, 5, 4);
    }
    ctx.fillStyle = o.body;
    ctx.beginPath(); ctx.ellipse(x, by, r * 0.85, r, 0, 0, 7); ctx.fill();
    if (o.belt) { ctx.fillStyle = o.belt; ctx.fillRect(x - r * 0.8, by + 1, r * 1.6, 3); }
    // weapon
    if (o.weapon) drawWeapon(x, by, o.face, o.weapon, r, o.wind);
    var hy = by - r * 1.05;
    ctx.fillStyle = o.head || '#e3b98f';
    ctx.beginPath(); ctx.arc(x, hy, r * 0.55, 0, 7); ctx.fill();
    if (o.hat) o.hat(x, hy, r);
    // eyes look where they face
    var fx = Math.cos(o.face) * r * 0.25, fy = Math.sin(o.face) * r * 0.15;
    if (Math.sin(o.face) > -0.5) { ctx.fillStyle = '#222'; ctx.fillRect(x + fx - 3, hy + fy - 1, 2, 2); ctx.fillRect(x + fx + 2, hy + fy - 1, 2, 2); }
    if (o.flash) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.ellipse(x, by - r * 0.3, r, r * 1.5, 0, 0, 7); ctx.fill(); }
    if (o.wind) { ctx.strokeStyle = 'rgba(255,60,40,' + (0.5 + Math.sin(G.time * 30) * 0.3) + ')'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, by - r * 0.3, r * 1.6, 0, 7); ctx.stroke(); }
  }
  function drawWeapon(x, y, face, kind, r, wind) {
    var a = face + (wind ? -0.9 : 0.35), cx = x + Math.cos(face) * r * 0.6, cy = y + Math.sin(face) * r * 0.5;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
    if (kind === 'sword') { ctx.fillStyle = '#d8dde6'; ctx.fillRect(2, -1.5, r * 1.6, 3); ctx.fillStyle = '#8a6a30'; ctx.fillRect(0, -4, 3, 8); }
    else if (kind === 'spear') { ctx.fillStyle = '#7a5530'; ctx.fillRect(-6, -1, r * 2.4, 2); ctx.fillStyle = '#ccd'; ctx.beginPath(); ctx.moveTo(r * 2.4 - 6, -3); ctx.lineTo(r * 2.4, 0); ctx.lineTo(r * 2.4 - 6, 3); ctx.fill(); }
    else if (kind === 'club') { ctx.fillStyle = '#6a4a28'; ctx.fillRect(0, -2, r * 1.4, 4); ctx.beginPath(); ctx.arc(r * 1.4, 0, 4, 0, 7); ctx.fill(); }
    else if (kind === 'bow') { ctx.strokeStyle = '#8a5a2a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 0, r * 0.9, -1.2, 1.2); ctx.stroke(); ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.cos(-1.2) * r * 0.9, Math.sin(-1.2) * r * 0.9); ctx.lineTo(Math.cos(1.2) * r * 0.9, Math.sin(1.2) * r * 0.9); ctx.stroke(); }
    else if (kind === 'staff') { ctx.fillStyle = '#7a5a30'; ctx.fillRect(-2, -1.5, r * 1.8, 3); }
    else if (kind === 'axe') { ctx.fillStyle = '#6a4a28'; ctx.fillRect(0, -1.5, r * 1.6, 3); ctx.fillStyle = '#bbc'; ctx.fillRect(r * 1.2, -6, 6, 9); }
    ctx.restore();
  }
  function hood(color) { return function (x, y, r) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y - 1, r * 0.62, Math.PI * 0.9, Math.PI * 2.1); ctx.fill(); }; }
  function helmet(color) { return function (x, y, r) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y - 2, r * 0.6, Math.PI, 0); ctx.fill(); ctx.fillRect(x - 1, y - r * 0.6 - 6, 2, 5); }; }
  function crown(x, y, r) { ctx.fillStyle = '#f2c94c'; ctx.beginPath(); ctx.moveTo(x - 8, y - 4); ctx.lineTo(x - 8, y - 12); ctx.lineTo(x - 4, y - 7); ctx.lineTo(x, y - 13); ctx.lineTo(x + 4, y - 7); ctx.lineTo(x + 8, y - 12); ctx.lineTo(x + 8, y - 4); ctx.fill(); }

  function drawBeast(a, x, y) {
    var r = a.r * TS, face = a.face, flip = Math.cos(face) < 0 ? -1 : 1, bob = Math.sin(a.walkT * 2) * 1.2;
    var col = { wolf: '#7d7f86', jackal: '#b8925a', bear: '#5e4330', rat: '#4c4a48' }[a.kind];
    shadow(x, y, r * 1.2);
    ctx.save(); ctx.translate(x, y - r * 0.7 + bob); ctx.scale(flip, 1);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.25, r * 0.7, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 1.05, -r * 0.35, r * 0.55, 0, 7); ctx.fill();
    if (a.kind !== 'bear') { ctx.beginPath(); ctx.moveTo(r * 0.85, -r * 0.8); ctx.lineTo(r * 1.0, -r * 1.25); ctx.lineTo(r * 1.15, -r * 0.8); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(r * 0.8, -r * 0.85, r * 0.2, 0, 7); ctx.fill(); }
    ctx.fillStyle = a.state === 'wind' || a.state === 'chase' ? '#ff4030' : '#222';
    ctx.fillRect(r * 1.2, -r * 0.5, 3, 3);
    ctx.strokeStyle = col; ctx.lineWidth = a.kind === 'rat' ? 1.5 : 3;
    ctx.beginPath(); ctx.moveTo(-r * 1.2, -r * 0.1); ctx.lineTo(-r * 1.7, a.kind === 'rat' ? r * 0.3 : -r * 0.5); ctx.stroke();
    if (a.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.ellipse(0, 0, r * 1.3, r * 0.8, 0, 0, 7); ctx.fill(); }
    ctx.restore();
    if (a.state === 'wind') { ctx.strokeStyle = 'rgba(255,60,40,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y - r * 0.7, r * 1.7, 0, 7); ctx.stroke(); }
  }

  function drawActor(a, x, y) {
    if (a.deco) {
      if (a.kind === 'tent') {
        shadow(x, y, 18);
        ctx.fillStyle = '#9a7a52'; ctx.beginPath(); ctx.moveTo(x - 20, y); ctx.lineTo(x, y - 30); ctx.lineTo(x + 20, y); ctx.fill();
        ctx.fillStyle = '#3a2a1a'; ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x, y - 14); ctx.lineTo(x + 5, y); ctx.fill();
      } else {
        ctx.fillStyle = '#5a3a1a'; ctx.fillRect(x - 9, y - 3, 18, 4);
        for (var k = 0; k < 3; k++) {
          ctx.fillStyle = ['#ff9a3c', '#ffd23c', '#ff5a2c'][k];
          var fh = 10 + Math.sin(G.time * 12 + k * 2) * 4;
          ctx.beginPath(); ctx.moveTo(x - 6 + k * 4, y - 2); ctx.lineTo(x - 4 + k * 4, y - 2 - fh); ctx.lineTo(x - 1 + k * 4, y - 2); ctx.fill();
        }
      }
      return;
    }
    if (a.obj) {
      shadow(x, y, 18);
      ctx.fillStyle = '#8a6a3a'; ctx.fillRect(x - 15, y - 26, 30, 26);
      ctx.fillStyle = '#c8a050'; ctx.beginPath(); ctx.moveTo(x - 19, y - 24); ctx.lineTo(x, y - 40); ctx.lineTo(x + 19, y - 24); ctx.fill();
      ctx.fillStyle = '#e8d090'; ctx.fillRect(x - 10, y - 10, 7, 9); ctx.fillRect(x + 3, y - 10, 7, 9);
      if (a.hp < a.maxHp) { ctx.fillStyle = 'rgba(255,' + (120 + Math.sin(G.time * 20) * 60) + ',40,0.8)'; ctx.beginPath(); ctx.arc(x + rnd(-6, 6), y - 30, 5 + (1 - a.hp / a.maxHp) * 8, 0, 7); ctx.fill(); }
      if (a.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(x - 15, y - 40, 30, 40); }
      hpBar(a, x, y - 46);
      return;
    }
    if (a.beast) { drawBeast(a, x, y); if (a.hp < a.maxHp) hpBar(a, x, y - a.r * TS * 2.2); return; }
    var sig = a.faction, o = { face: a.face, walk: a.walkT, r: a.r, flash: a.flash > 0, wind: a.state === 'wind' || a.state === 'chargeWind' || a.state === 'aim' };
    var tunic = sig ? L.civCSS(sig, 1, -10) : '#7a6a58';
    switch (a.kind) {
      case 'villager': case 'settler': o.body = sig ? L.civCSS(sig, 1, 30) : '#a08a68'; o.hat = (a.id % 3 === 0) ? hood('#8a6a48') : null; break;
      case 'elder': o.body = '#8e7cae'; o.weapon = 'staff'; o.hat = hood('#d8d8d8'); o.belt = sig ? L.civCSS(sig) : null; break;
      case 'royal': case 'lord': o.body = tunic; o.hat = crown; o.belt = '#f2c94c'; o.r = 0.36; break;
      case 'spymaster': o.body = '#2f3440'; o.hat = hood('#1f232c'); o.belt = tunic; break;
      case 'scholar': o.body = '#3c5a9a'; o.hat = hood('#2c447a'); o.weapon = 'staff'; break;
      case 'stranger': o.body = '#8a8f98'; o.hat = hood('#6a6f78'); o.weapon = 'staff'; break;
      case 'sentry': o.body = tunic; o.hat = helmet('#9aa0a8'); o.weapon = 'spear'; break;
      case 'bandit': case 'thief': o.body = '#6a5038'; o.hat = hood('#4a3828'); o.weapon = a.kind === 'thief' ? 'sword' : 'club'; break;
      case 'archer': o.body = '#5a6038'; o.hat = hood('#3a4028'); o.weapon = 'bow'; break;
      case 'chief': o.body = '#5a2a1a'; o.hat = helmet('#7a5a3a'); o.weapon = 'axe'; break;
      case 'soldier': case 'guard': o.body = tunic; o.hat = helmet('#a8aeb6'); o.weapon = 'spear'; o.belt = '#3a2a1a'; break;
      case 'bowman': o.body = tunic; o.hat = helmet('#8a9098'); o.weapon = 'bow'; break;
      case 'captain': o.body = tunic; o.hat = helmet('#d8c070'); o.weapon = 'sword'; o.belt = '#f2c94c'; break;
      case 'ruler': o.body = tunic; o.hat = crown; o.weapon = 'sword'; o.belt = '#f2c94c'; break;
      default: o.body = '#888';
    }
    drawHuman(x, y, o);
    if (a.state === 'chargeWind') { ctx.strokeStyle = 'rgba(255,40,40,0.8)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, y - 10); ctx.lineTo(x + Math.cos(a.face) * 120, y - 10 + Math.sin(a.face) * 120); ctx.stroke(); }
    if (a.hostile && (a.hp < a.maxHp || a.boss)) hpBar(a, x, y - a.r * TS * 3.4);
    if (a.boss) { ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd76a'; ctx.fillText(a.name, x, y - a.r * TS * 3.4 - 6); ctx.textAlign = 'left'; }
    if (a.npc) {
      var mark = '', q = Quests.waitingOn(a);
      if (q && q.stage === 'return' && q.returnKey === a.key) mark = '?';
      else if (!q && (a.role === 'elder' || a.role === 'spymaster' || a.role === 'scholar' || a.role === 'stranger' || (a.role === 'royal' && (G.stage === 'prologue' || G.stage === 'quest' || G.stage === 'won')))) {
        if (a.offerVer !== G.ver) { a.offerVer = G.ver; a.hasOffer = a.role === 'stranger' || (a.role === 'royal' && G.stage === 'prologue') || Quests.offersFor(a).length > 0; }
        if (a.hasOffer) mark = '!';
      }
      if (mark) {
        var my = y - a.r * TS * 3.8 + Math.sin(G.time * 4) * 2;
        ctx.font = '900 20px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = '#1a1406'; ctx.fillText(mark, x + 1, my + 1);
        ctx.fillStyle = mark === '?' ? '#7df0ff' : '#ffd23c'; ctx.fillText(mark, x, my); ctx.textAlign = 'left';
      }
    }
  }
  function hpBar(a, x, y) {
    var w = a.boss ? 60 : 30, f = Math.max(0, a.hp / a.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 6);
    ctx.fillStyle = a.obj ? '#ff9a3c' : '#e04848'; ctx.fillRect(x - w / 2, y, w * f, 4);
  }

  function drawPlayer(p, x, y) {
    var o = { face: p.face, walk: p.walkT, r: 0.32, body: '#2f7f8f', belt: '#c8a050', boat: p.boat, hat: hood('#1f5f6f'), flash: p.inv > 0 && p.hurt > 0 && Math.sin(G.time * 40) > 0 };
    o.weapon = p.bowT > 0 || G.keys.k ? 'bow' : 'sword';
    // facing marker on the ground
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.save(); ctx.translate(x, y); ctx.rotate(p.face);
    ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(11, -5); ctx.lineTo(11, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
    var t = G.target;
    if (t && G.actors.indexOf(t) >= 0) {
      var ox2 = x - p.x * TS, oy2 = y - p.y * TS, tx = ox2 + t.x * TS, ty = oy2 + t.y * TS - t.r * TS;
      ctx.strokeStyle = G.keys.k ? 'rgba(255,215,90,0.95)' : 'rgba(255,215,90,0.45)'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (var k = 0; k < 4; k++) { var a0 = k * Math.PI / 2 + G.time * 2; ctx.moveTo(tx + Math.cos(a0) * 14, ty + Math.sin(a0) * 14); ctx.arc(tx, ty, 14, a0, a0 + 0.9); }
      ctx.stroke();
    }
    if (p.rollT > 0) { ctx.globalAlpha = 0.6; }
    drawHuman(x, y, o);
    ctx.globalAlpha = 1;
    // the Chronoscope at the belt
    if (G.stage === 'quest' || G.stage === 'won') {
      var h = G.oracle ? G.oracle.hum(Math.floor(p.x / P), Math.floor(p.y / P), G.year) : null;
      ctx.fillStyle = h ? (h.level === 3 ? '#9ff' : h.level === 2 ? '#7cd' : '#5ab') : '#c9a24a';
      ctx.beginPath(); ctx.arc(x + 7, y - 9, 3 + (h ? Math.sin(G.time * (4 + h.level * 4)) * h.level * 0.6 : 0), 0, 7); ctx.fill();
    }
  }

  function drawPickup(pk, x, y) {
    var b = Math.sin(pk.t * 3) * 3;
    shadow(x, y, 7);
    if (pk.kind === 'herb') {
      ctx.fillStyle = 'rgba(180,220,255,' + (0.25 + Math.sin(pk.t * 4) * 0.15) + ')'; ctx.beginPath(); ctx.arc(x, y - 8 + b, 13, 0, 7); ctx.fill();
      ctx.fillStyle = '#3a8a4a'; ctx.fillRect(x - 1, y - 14 + b, 2, 12);
      ctx.fillStyle = '#c8d8ff'; for (var k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(x + (k - 1) * 4, y - 14 + b - (k === 1 ? 3 : 0), 3, 0, 7); ctx.fill(); }
    } else if (pk.kind === 'potion') {
      ctx.fillStyle = '#ff5ab8'; ctx.beginPath(); ctx.arc(x, y - 8 + b, 6, 0, 7); ctx.fill();
      ctx.fillStyle = '#ddd'; ctx.fillRect(x - 2, y - 17 + b, 4, 4);
    } else if (pk.kind === 'arrows') {
      ctx.strokeStyle = '#e8d8a8'; ctx.lineWidth = 2;
      for (var j = 0; j < 3; j++) { ctx.beginPath(); ctx.moveTo(x - 8, y - 4 - j * 4 + b); ctx.lineTo(x + 8, y - 8 - j * 4 + b); ctx.stroke(); }
    } else if (pk.kind === 'codex') {
      ctx.fillStyle = 'rgba(255,220,120,' + (0.3 + Math.sin(pk.t * 4) * 0.2) + ')'; ctx.beginPath(); ctx.arc(x, y - 8 + b, 14, 0, 7); ctx.fill();
      ctx.fillStyle = '#7a2a2a'; ctx.fillRect(x - 8, y - 14 + b, 16, 12); ctx.fillStyle = '#f2c94c'; ctx.fillRect(x - 6, y - 12 + b, 12, 2);
    }
  }

  function drawEffect(e, ox, oy) {
    var x = ox + e.x * TS, y = oy + e.y * TS, f = e.t / e.life;
    if (e.type === 'num') {
      ctx.font = '700 14px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,' + (1 - f) + ')'; ctx.fillText(e.text, x + 1, y - f * 24 - 19);
      ctx.globalAlpha = 1 - f; ctx.fillStyle = e.color; ctx.fillText(e.text, x, y - f * 24 - 20); ctx.globalAlpha = 1; ctx.textAlign = 'left';
    } else if (e.type === 'slash' || e.type === 'eslash') {
      var p = G.player, cx = e.type === 'slash' ? ox + p.x * TS : x, cy = (e.type === 'slash' ? oy + p.y * TS : y) - 12;
      var rr = (e.r || 1.25) * TS;
      ctx.strokeStyle = e.type === 'slash' ? 'rgba(255,255,255,' + (0.9 - f) + ')' : 'rgba(255,90,60,' + (0.9 - f) + ')';
      ctx.lineWidth = 5 * (1 - f) + 1;
      ctx.beginPath(); ctx.arc(cx, cy, rr * (0.75 + f * 0.25), e.ang - 1.1 + f * 0.6, e.ang + 1.1 * (f * 1.2 - 0.1)); ctx.stroke();
    } else if (e.type === 'puff') {
      ctx.fillStyle = e.color; ctx.globalAlpha = 1 - f;
      for (var k = 0; k < 6; k++) { var a = k * 1.05; ctx.beginPath(); ctx.arc(x + Math.cos(a) * f * 16, y - 10 + Math.sin(a) * f * 12, 4 * (1 - f) + 1, 0, 7); ctx.fill(); }
      ctx.globalAlpha = 1;
    } else if (e.type === 'ring') {
      ctx.strokeStyle = e.color; ctx.globalAlpha = 1 - f; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y - 10, 10 + f * 40, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (e.type === 'fireburst') {
      for (var j = 0; j < 8; j++) {
        ctx.fillStyle = ['#ff9a3c', '#ffd23c', '#ff5a2c'][j % 3]; ctx.globalAlpha = 1 - f;
        ctx.beginPath(); ctx.arc(x + Math.sin(j * 2.1 + G.time * 6) * 10, y - 12 - f * 30 - j * 3, 6 * (1 - f) + 2, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawMarker(o, ox, oy) {
    var c = provCenter(o.pi), tx = o.x != null ? o.x : c.x, ty = o.y != null ? o.y : c.y;
    var x = ox + tx * TS, y = oy + ty * TS, vw = G.vw, vh = G.vh, m = 40;
    if (x > m && y > m + 40 && x < vw - m && y < vh - m - 70) {
      if (o.x == null && Math.hypot(tx - G.player.x, ty - G.player.y) < 4) return;
      var b = Math.sin(G.time * 3) * 4;
      ctx.fillStyle = o.main ? '#ffd23c' : '#7df0ff';
      ctx.beginPath(); ctx.moveTo(x, y - 40 + b); ctx.lineTo(x + 8, y - 52 + b); ctx.lineTo(x, y - 64 + b); ctx.lineTo(x - 8, y - 52 + b); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2; ctx.stroke();
      return;
    }
    var cx = vw / 2, cy = vh / 2, ang = Math.atan2(y - cy, x - cx);
    var ex = clamp(cx + Math.cos(ang) * vw, m, vw - m), ey = clamp(cy + Math.sin(ang) * vh, m + 50, vh - m - 80);
    var k = Math.min((vw / 2 - m) / Math.abs(Math.cos(ang) || 1e-6), (vh / 2 - m - 60) / Math.abs(Math.sin(ang) || 1e-6));
    ex = cx + Math.cos(ang) * k; ey = cy + Math.sin(ang) * k;
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
    ctx.fillStyle = o.main ? '#ffd23c' : '#7df0ff';
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-4, 0); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    var dist = md(o.pi, provOf(G.player.x, G.player.y));
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.fillText(dist + ' prov', ex - Math.cos(ang) * 22, ey - Math.sin(ang) * 22 + 4); ctx.textAlign = 'left';
  }

  // ---------------------------------------------------------------------------
  // Objectives
  // ---------------------------------------------------------------------------
  function mainObjective() {
    var hc = homeCiv(), s = G.s, n = G.home ? esc(G.home.name) : '';
    switch (G.stage) {
      case 'prologue': return hc >= 0 ? { text: 'Swear the oath at the capital of the ' + n, pi: s.cCap[hc], main: true } : { text: 'Your people are gone from this age', pi: -1, main: true };
      case 'await':
        var st = null;
        G.actors.forEach(function (a) { if (a.role === 'stranger') st = a; });
        return st ? { text: 'Speak to the stranger in grey', pi: provOf(st.x, st.y), x: st.x, y: st.y, main: true } : { text: 'Wait. Someone is coming for you…', pi: -1, main: true };
      case 'quest': return G.goal ? { text: 'Save the ' + n + ': hold land in ' + G.goal.target, pi: -1, main: true } : null;
      case 'won': return { text: 'The ' + n + ' are saved. Wander history.', pi: -1, main: true };
    }
    return null;
  }
  function objectiveList() {
    var out = [], m = mainObjective();
    if (m) out.push(m);
    return out.concat(Quests.objectives());
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  var toastEls = [];
  function toast(html, ms) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    $('toasts').appendChild(el);
    toastEls.push(el);
    while (toastEls.length > 5) { var o = toastEls.shift(); if (o.parentNode) o.parentNode.removeChild(o); }
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); var i = toastEls.indexOf(el); if (i >= 0) toastEls.splice(i, 1); }, 500); }, ms || 4500);
  }
  function journal(html) { G.log.push({ year: G.year, html: html }); }

  function hud() {
    var p = G.player, s = G.s, m = maxHp(p);
    $('h-name').textContent = p.name;
    $('h-sub').textContent = 'Age ' + p.age + ' · Level ' + p.level + (p.lives > 1 ? ' · Bearer #' + p.lives : '');
    $('h-hp').style.width = (100 * p.hp / m) + '%';
    $('h-hpt').textContent = Math.ceil(p.hp) + ' / ' + m;
    $('h-xp').style.width = (100 * p.xp / xpNext(p.level)) + '%';
    $('h-items').innerHTML = '<span title="Arrows">➶ ' + p.arrows + '</span><span title="Potions (Q)">⚱ ' + p.potions + '</span>' + (p.knowledge ? '<span title="Knowledge you carry">✎ ' + p.knowledge.tech + '</span>' : '');
    $('h-year').textContent = 'Year ' + G.year;
    $('h-month').textContent = MONTHS[G.month];
    var pi = provOf(p.x, p.y), c = s.owner[pi], t = s.terrain[pi];
    var place = !Sim.isLand(t) ? 'Open sea' : c >= 0 ? (s.pop[pi] > 0 ? (L.isCapital(s, pi) ? 'Capital of the ' : 'Village of the ') : 'Lands of the ') + civName(s.cSig[c]) : 'Wilderness';
    $('h-place').textContent = place + ' · ' + Sim.TERRAIN_NAMES[t] + ' (' + (pi % W) + ', ' + ((pi / W) | 0) + ')';
    $('h-timeline').textContent = G.cur.parent < 0 ? 'The world without you' : G.cur.name;
    // fate
    var fh = '';
    if ((G.stage === 'quest' || G.stage === 'won') && G.goal) {
      var f = curFate();
      fh = '<div class="fh">Fate of the ' + esc(G.home.name) + '</div><div class="' + (saved(f) ? 'good' : f.state === 'falls' || f.state === 'never' ? 'bad' : '') + '">' + fateText(f, true) + '</div>' +
        '<div class="sub">Goal: hold land in ' + G.goal.target + (G.goal.end ? ' · fell in ' + G.goal.end + ' without you' : '') + '</div>';
      if (G.oracle) {
        var h = G.oracle.hum(pi % W, (pi / W) | 0, G.year);
        if (h) fh += '<div class="hum l' + h.level + '">' + (h.level === 3 ? '◈ The Chronoscope <b>sings</b>: ' + DEED_NAMES[h.deed].toLowerCase() + ' here, now, would turn fate' : h.level === 2 ? '◈ The Chronoscope hums: you are near a turning point' : '◈ The Chronoscope hums faintly: this is an era that matters') + '</div>';
        else if (G.oracle.done && !G.oracle.wins().length) fh += '<div class="hum">The Chronoscope is silent: no single deed will turn this fate. It will take many.</div>';
      }
    } else if (!G.world.isComplete(G.cur) && G.stage === 'await') fh = '<div class="sub">The future is being written… (year ' + G.cur.computedTo + ')</div>';
    $('fate').innerHTML = fh;
    $('fate').hidden = !fh;
    // tracker
    var objs = objectiveList(), ppi = pi;
    $('tracker').innerHTML = objs.map(function (o) {
      return '<div class="obj' + (o.main ? ' main' : '') + '"><span class="dot"></span><div><div>' + esc(o.text) + '</div>' + (o.q ? '<div class="qt">' + esc(o.q.title) + '</div>' : '') +
        (o.pi >= 0 ? '<div class="dir">' + (o.pi === ppi ? 'here' : dirName(o.pi % W - ppi % W, ((o.pi / W) | 0) - ((ppi / W) | 0)) + ' · ' + md(o.pi, ppi) + ' prov') + '</div>' : '') + '</div></div>';
    }).join('');
    $('k-potion').textContent = p.potions;
    $('k-arrows').textContent = p.arrows;
    $('k-scope').classList.toggle('locked', !(G.stage === 'quest' || G.stage === 'won'));
    drawMinimap();
  }

  var mini = { cv: null, base: null, ver: -1 };
  function drawMinimap() {
    var cv = $('minimap'), g = cv.getContext('2d'), s = G.s, p = G.player, R = 24, RY = 15, sc = 5;
    var ppi = provOf(p.x, p.y), cx = ppi % W, cy = (ppi / W) | 0, hc = homeCiv();
    g.fillStyle = '#1b3350'; g.fillRect(0, 0, cv.width, cv.height);
    var TER_RGB = ['#1d3a5c', '#2c5a84', '#7d9656', '#4f7448', '#8a7c58', '#9a968e', '#cdb886'];
    for (var dy = -RY; dy <= RY; dy++) for (var dx = -R; dx <= R; dx++) {
      var x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      var i = y * W + x, c = s.owner[i];
      g.fillStyle = c >= 0 ? L.civCSS(s.cSig[c], 1, c === hc ? 20 : -15) : TER_RGB[s.terrain[i]];
      g.fillRect((dx + R) * sc, (dy + RY) * sc, sc, sc);
      if (c >= 0 && s.cCap[c] === i) { g.fillStyle = c === hc ? '#ffd23c' : '#fff'; g.fillRect((dx + R) * sc + 1, (dy + RY) * sc + 1, sc - 2, sc - 2); }
      if (s.plague[i]) { g.fillStyle = 'rgba(160,220,60,0.6)'; g.fillRect((dx + R) * sc + 1, (dy + RY) * sc + 1, 2, 2); }
    }
    objectiveList().forEach(function (o) {
      if (o.pi < 0) return;
      var ox = clamp(o.pi % W - cx, -R, R), oy = clamp(((o.pi / W) | 0) - cy, -RY, RY);
      g.fillStyle = o.main ? '#ffd23c' : '#7df0ff'; g.strokeStyle = '#000';
      g.beginPath(); g.arc((ox + R) * sc + sc / 2, (oy + RY) * sc + sc / 2, 4, 0, 7); g.fill(); g.stroke();
    });
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
    var mx = R * sc + ((p.x % P) / P) * sc, my = RY * sc + ((p.y % P) / P) * sc;
    g.beginPath(); g.arc(mx, my, 3.5, 0, 7); g.fill(); g.stroke();
  }

  // ---------------------------------------------------------------------------
  // Dialogs and panels
  // ---------------------------------------------------------------------------
  function dialog(o) {
    G.modal = o;
    $('d-kicker').textContent = o.kicker || '';
    $('d-title').textContent = o.title || '';
    $('d-title').hidden = !o.title;
    $('d-body').innerHTML = o.html || '';
    var acts = $('d-actions');
    acts.innerHTML = '';
    (o.buttons || [{ label: 'OK' }]).forEach(function (b, k) {
      var el = document.createElement('button');
      el.className = 'btn' + (k === 0 ? ' primary' : '');
      el.innerHTML = '<span class="kk">' + (k + 1) + '</span>' + esc(b.label);
      el.onclick = function () { closeDialog(); if (b.fn) b.fn(); };
      acts.appendChild(el);
    });
    $('dialog').hidden = false;
    G.keys = {};
  }
  function closeDialog() { $('dialog').hidden = true; G.modal = null; }

  function openPanel(id) {
    closePanels();
    G.panel = id;
    $(id).hidden = false;
    G.keys = {};
    if (id === 'scope') openScope();
    if (id === 'journal') renderJournal();
  }
  function closePanels() { ['scope', 'journal', 'help'].forEach(function (id) { $(id).hidden = true; }); G.panel = null; }

  function renderJournal() {
    var h = '<h3>Quests</h3>';
    h += G.quests.length ? G.quests.map(function (q) {
      var o = Quests.objectives().filter(function (x) { return x.q === q; })[0];
      return '<div class="jq"><b>' + esc(q.title) + '</b> <span class="muted">from ' + esc(q.giverName) + ', ' + q.year + '</span><div>' + (o ? esc(o.text) : '') + '</div></div>';
    }).join('') : '<p class="muted">No quests. Look for <b style="color:#ffd23c">!</b> over elders in villages.</p>';
    h += '<h3>Your deeds in this timeline</h3>';
    var mine = G.cur.interventions;
    h += G.deeds.length ? '<ul class="deeds">' + G.deeds.slice().reverse().map(function (d) { return '<li><span class="t">' + d.year + '</span> <b>' + DEED_NAMES[d.type] + '</b> ' + esc(d.why ? '(' + d.why + ')' : '') + '<div class="muted">' + d.msg + '</div></li>'; }).join('') + '</ul>' : '<p class="muted">None yet. Every quest you finish becomes a deed.</p>';
    h += '<p class="muted">Renown among the ' + esc(G.home.name) + ': <b>' + G.renown + '</b> (quests done for your own people).</p>';
    h += '<p class="muted">This timeline holds ' + mine.length + ' recorded deed' + (mine.length === 1 ? '' : 's') + ' in all (including earlier lives).</p>';
    h += '<h3>Chronicle of your lives</h3><ul class="log">' + G.log.slice().reverse().slice(0, 80).map(function (l) { return '<li><span class="t">' + l.year + '</span> ' + l.html + '</li>'; }).join('') + '</ul>';
    $('journal-body').innerHTML = h;
  }

  // ---- The Chronoscope ----
  var scope = { year: START, view: null, pending: false };
  function scopeUnlocked() { return G.stage === 'quest' || G.stage === 'won'; }
  function openScope() {
    scope.year = G.year;
    var r = $('scope-year');
    r.min = 1; r.max = HORIZON - 1; r.value = scope.year;
    renderScope();
  }
  function renderScope() {
    if (!scope.view) scope.view = new Timeline.View(G.world);
    $('scope-label').textContent = 'Year ' + scope.year + (scope.year === G.year ? ' (now)' : scope.year < G.year ? ' (' + (G.year - scope.year) + ' years ago)' : ' (' + (scope.year - G.year) + ' years ahead)');
    $('scope-go').textContent = scope.year === G.year ? 'You are here' : 'Travel to ' + scope.year;
    $('scope-go').disabled = scope.year === G.year;
    drawScopeMap();
    drawScopeChart();
    renderScopeText();
  }
  function drawScopeMap() {
    var cv = $('scope-map'), g = cv.getContext('2d'), sc = 4;
    var s = scope.view.seek(G.cur, scope.year), hs = G.home.sig, fs = G.goal ? G.goal.foeSig : 0;
    var img = g.createImageData(W, H), d = img.data;
    var TER_RGB = [[29, 58, 92], [44, 90, 132], [125, 150, 86], [79, 116, 72], [138, 124, 88], [154, 150, 142], [205, 184, 134]];
    for (var i = 0; i < N; i++) {
      var c = s.owner[i], rgb;
      if (c >= 0) {
        rgb = L.civRGB(s.cSig[c]);
        var sig = s.cSig[c];
        if (sig !== hs && sig !== fs) rgb = [rgb[0] * 0.6 + 40, rgb[1] * 0.6 + 40, rgb[2] * 0.6 + 40];
      } else rgb = TER_RGB[s.terrain[i]];
      d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255;
    }
    var tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(tmp, 0, 0, W * sc, H * sc);
    // outline home realm and foe
    function outline(sigx, col) {
      g.fillStyle = col;
      for (var i = 0; i < N; i++) {
        var c = s.owner[i];
        if (c < 0 || s.cSig[c] !== sigx) continue;
        var x = i % W, y = (i / W) | 0;
        for (var k = 0; k < 4; k++) {
          var n = NB[i * 4 + k];
          if (n >= 0 && s.owner[n] === c) continue;
          if (k === 0) g.fillRect(x * sc, y * sc, sc, 1);
          if (k === 1) g.fillRect(x * sc + sc - 1, y * sc, 1, sc);
          if (k === 2) g.fillRect(x * sc, y * sc + sc - 1, sc, 1);
          if (k === 3) g.fillRect(x * sc, y * sc, 1, sc);
        }
        if (s.cCap[c] === i) { g.fillRect(x * sc - 1, y * sc - 1, sc + 2, sc + 2); }
      }
    }
    outline(hs, '#ffd23c');
    if (fs) outline(fs, '#ff5a5a');
    // threads of fate
    if (G.oracle) G.oracle.wins().forEach(function (r) {
      if (Math.abs(r.t - scope.year) > 10) return;
      g.strokeStyle = '#9ff'; g.lineWidth = 2; g.beginPath(); g.arc(r.x * sc + 2, r.y * sc + 2, 7, 0, 7); g.stroke();
    });
    var p = G.player;
    g.fillStyle = '#fff'; g.strokeStyle = '#000';
    g.beginPath(); g.arc(p.x / P * sc, p.y / P * sc, 4, 0, 7); g.fill(); g.stroke();
  }
  function drawScopeChart() {
    var cv = $('scope-chart'), g = cv.getContext('2d'), w = cv.width, h = cv.height, y0 = 0, y1 = HORIZON;
    g.fillStyle = '#0f1422'; g.fillRect(0, 0, w, h);
    var X = function (t) { return (t - y0) / (y1 - y0) * w; };
    var series = function (b) { return Story.vitals(b, G.home.sig); };
    var mine = series(G.cur), base = series(G.world.root), max = 1;
    mine.concat(base).forEach(function (v) { if (v.tiles > max) max = v.tiles; });
    var Y = function (v) { return h - 14 - v / max * (h - 28); };
    // computed frontier
    g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(X(G.cur.computedTo), 0, w - X(G.cur.computedTo), h);
    function plot(arr, col, dash) {
      if (!arr.length) return;
      g.strokeStyle = col; g.lineWidth = 2; g.setLineDash(dash || []);
      g.beginPath();
      arr.forEach(function (v, k) { if (k) g.lineTo(X(v.t), Y(v.tiles)); else g.moveTo(X(v.t), Y(v.tiles)); });
      g.stroke(); g.setLineDash([]);
    }
    plot(base, 'rgba(200,200,210,0.6)', [5, 4]);
    plot(mine, '#ffd23c');
    function vline(t, col, label, row) {
      if (t == null) return;
      g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(t), 0); g.lineTo(X(t), h); g.stroke();
      g.fillStyle = col; g.font = '11px system-ui, sans-serif'; g.fillText(label, Math.min(w - 70, X(t) + 3), 12 + row * 13);
    }
    if (G.goal) { vline(G.goal.end, '#ff6b6b', 'fell ' + G.goal.end, 1); vline(G.goal.target, '#7dffa0', 'goal ' + G.goal.target, 2); }
    vline(G.year, '#ffffff', 'now', 0);
    g.strokeStyle = '#7df0ff'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(scope.year), 0); g.lineTo(X(scope.year), h); g.stroke();
    G.deeds.forEach(function (d) { g.fillStyle = '#7df0ff'; g.beginPath(); g.arc(X(d.year), h - 6, 3, 0, 7); g.fill(); });
    g.fillStyle = '#8a90a0'; g.font = '10px system-ui, sans-serif';
    for (var t = 0; t <= HORIZON; t += 250) g.fillText(String(t), X(t) + 2, h - 2);
  }
  function renderScopeText() {
    var f = curFate(), base = readFate(G.world.root), h = '';
    h += '<div class="sline"><span class="lbl">This timeline</span> ' + esc(G.cur.parent < 0 ? 'The world without you' : G.cur.name) + ' · ' + G.cur.interventions.length + ' deed' + (G.cur.interventions.length === 1 ? '' : 's') + '</div>';
    h += '<div class="sline ' + (saved(f) ? 'good' : 'bad') + '"><span class="lbl">Your people</span> ' + fateText(f) + '</div>';
    h += '<div class="sline muted"><span class="lbl">Without you</span> ' + fateText(base) + '</div>';
    if (G.goal) h += '<div class="sline"><span class="lbl">Goal</span> hold land in <b>' + G.goal.target + '</b></div>';
    if (f.state === 'falls' && G.world.isComplete(G.cur)) {
      var key = G.cur.id + ':' + G.cur.version;
      if (!scope.whyKey || scope.whyKey !== key) { scope.whyKey = key; scope.why = Story.whyFall(G.cur, G.home.sig, f.end, null); }
      var w = scope.why;
      if (w && w.verdict) h += '<div class="why"><b>Why they fall:</b> ' + w.verdict + (w.advice && w.advice[0] ? '<div class="advice">' + w.advice[0] + '</div>' : '') + '</div>';
    }
    if (G.oracle) {
      var wins = G.oracle.wins().slice(0, 8);
      h += '<div class="threads"><div class="lbl">Threads of fate' + (G.oracle.done ? '' : ' (reading… ' + Math.round(G.oracle.progress() * 100) + '%)') + '</div>';
      var dif = G.oracle.difficulty();
      if (dif) h += '<div class="muted">' + dif.label + '.</div>';
      h += wins.map(function (r) {
        var who = r.type === 'assassinate' || r.type === 'discord' ? (G.goal.foeSig ? civName(G.goal.foeSig) : 'the rival') : G.home.name;
        var q = { assassinate: 'kill the ruler of the ' + who + ' (spymaster)', discord: 'sow discord in the ' + who + ' capital (spymaster)', rally: 'rally the ' + who + ' capital (ruler)', irrigate: 'irrigate the ' + who + ' capital (scholar)', teach: 'teach the ' + who + ' (scholar)' }[r.type];
        return '<button class="thread" data-t="' + r.t + '">◈ <b>' + r.t + '</b>: ' + esc(q) + ' at (' + r.x + ', ' + r.y + ')</button>';
      }).join('') + '</div>';
    } else if (G.stage === 'quest') h += '<div class="muted">The Chronoscope is still reading the threads of this timeline…</div>';
    // chronicle around the selected year
    var evs = G.cur.events.filter(function (e) { return Math.abs(e.t - scope.year) <= 15 && (e.major || e.a === G.home.sig || e.b === G.home.sig || (G.goal && (e.a === G.goal.foeSig || e.b === G.goal.foeSig))); }).slice(-8);
    if (evs.length) h += '<div class="lbl" style="margin-top:8px">Around ' + scope.year + '</div><ul class="log">' + evs.map(function (e) { return '<li><span class="t">' + e.t + '</span> ' + esc(e.text) + '</li>'; }).join('') + '</ul>';
    $('scope-text').innerHTML = h;
    Array.prototype.forEach.call($('scope-text').querySelectorAll('.thread'), function (b) {
      b.onclick = function () { scope.year = +b.getAttribute('data-t'); $('scope-year').value = scope.year; renderScope(); };
    });
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  function bindInput() {
    window.addEventListener('keydown', function (e) {
      var k = e.key.toLowerCase();
      if (e.target && (e.target.tagName === 'INPUT' && e.target.type === 'text')) return;
      if (G.stage === 'title' || G.stage === 'loading') return;
      if (G.modal) {
        if (e.repeat) return;
        var btns = $('d-actions').querySelectorAll('button');
        if (k === 'enter' || k === 'e' || k === ' ') { e.preventDefault(); if (btns[0]) btns[0].click(); }
        else if (k === 'escape') { if (btns.length) btns[btns.length - 1].click(); }
        else if (/^[1-9]$/.test(k) && btns[+k - 1]) btns[+k - 1].click();
        return;
      }
      if (G.panel) {
        if (k === 'escape' || (k === 't' && G.panel === 'scope') || (k === 'l' && G.panel === 'journal') || (k === 'h' && G.panel === 'help')) { closePanels(); return; }
        if (G.panel === 'scope') {
          var step = e.shiftKey ? 10 : 1;
          if (k === ',' || k === 'arrowleft') { scope.year = Math.max(1, scope.year - step); $('scope-year').value = scope.year; renderScope(); }
          if (k === '.' || k === 'arrowright') { scope.year = Math.min(HORIZON - 1, scope.year + step); $('scope-year').value = scope.year; renderScope(); }
          if (k === 'pageup') { scope.year = Math.max(1, scope.year - 50); $('scope-year').value = scope.year; renderScope(); }
          if (k === 'pagedown') { scope.year = Math.min(HORIZON - 1, scope.year + 50); $('scope-year').value = scope.year; renderScope(); }
          if (k === 'home') { scope.year = G.year; $('scope-year').value = scope.year; renderScope(); }
          if (k === '[' || k === ']') {
            var ts = G.oracle ? G.oracle.wins().map(function (r) { return r.t; }) : [];
            if (G.goal) ts.push(G.goal.end, G.goal.target);
            ts.sort(function (a, b) { return a - b; });
            var nx = k === ']' ? ts.filter(function (t) { return t > scope.year; })[0] : ts.filter(function (t) { return t < scope.year; }).pop();
            if (nx != null) { scope.year = nx; $('scope-year').value = scope.year; renderScope(); }
          }
          if (k === 'enter') { e.preventDefault(); $('scope-go').click(); }
        }
        return;
      }
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) >= 0) e.preventDefault();
      G.keys[k] = true;
      if (k === ' ' || k === 'shift') roll();
      else if (k === 'e') { var t = nearestTalker(); if (t) talk(t); }
      else if (k === 'q') drinkPotion();
      else if (k === 'r') rest();
      else if (k === 't') { if (scopeUnlocked()) openPanel('scope'); else toast('You do not have the Chronoscope yet.'); }
      else if (k === 'l') openPanel('journal');
      else if (k === 'h' || k === '?') openPanel('help');
    });
    window.addEventListener('keyup', function (e) { G.keys[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', function () { G.keys = {}; });
    $('scope-year').addEventListener('input', function () { scope.year = +this.value; if (!scope.pending) { scope.pending = true; requestAnimationFrame(function () { scope.pending = false; renderScope(); }); } });
    $('scope-chart').addEventListener('mousedown', function (e) {
      var cv = this, set = function (ev) { var r = cv.getBoundingClientRect(); scope.year = clamp(Math.round((ev.clientX - r.left) / r.width * HORIZON), 1, HORIZON - 1); $('scope-year').value = scope.year; renderScope(); };
      set(e);
      var mv = function (ev) { set(ev); }, up = function () { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });
    $('scope-go').onclick = function () { var y = scope.year; closePanels(); travelTo(y); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) { b.onclick = closePanels; });
    $('k-scope').onclick = function () { if (scopeUnlocked()) openPanel('scope'); else toast('You do not have the Chronoscope yet.'); };
    $('k-journal').onclick = function () { openPanel('journal'); };
    $('k-help').onclick = function () { openPanel('help'); };
    window.addEventListener('resize', resize);
  }

  // ---------------------------------------------------------------------------
  // Title, loading, the beginning of the story
  // ---------------------------------------------------------------------------
  function todaySeed() { var d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  function startWorld(seed) {
    seed = seed >>> 0;
    G.world = new Timeline.World(seed, { horizon: HORIZON });
    G.cur = G.world.root;
    G.view = new Timeline.View(G.world);
    scope.view = null;
    L.clearCaches();
    G.stage = 'loading';
    $('title').hidden = true;
    $('loading').hidden = false;
    try { history.replaceState(null, '', '#seed=' + seed); } catch (e) { /* file:// */ }
  }
  function loadingFrame() {
    var target = START + 600;
    G.world.compute(G.world.root, 40);
    $('load-bar').style.width = Math.min(100, 100 * G.world.root.computedTo / target) + '%';
    $('load-text').textContent = 'History unfolds… year ' + G.world.root.computedTo;
    if (G.world.root.computedTo >= target) beginStory();
  }

  function beginStory() {
    var root = G.world.root;
    G.cur = root;
    seekYear(START);
    var s = G.s, rnd2 = mulberry(G.world.seed ^ 0x5eed);
    var pick = Story.pickHome(root, s, rnd2);
    if (!pick) {
      var best = -1;
      for (var c = 0; c < s.g[1]; c++) if (s.cAlive[c] && s.sTiles[c] > 0 && (best < 0 || s.sTiles[c] > s.sTiles[best])) best = c;
      pick = { c: best, sig: s.cSig[best] };
    }
    var birth = Story.pickBirthplace(s, pick.c, rnd2);
    var tale = Story.homeStory(s, pick.c, root, START, birth);
    G.home = { sig: pick.sig, name: tale.name, ruler: tale.ruler, birth: birth };
    G.player = newPlayer(Story.personName(pick.sig, G.world.seed), 1, 1);
    var f = findFree(birth, C + 1, C + 1) || provCenter(birth);
    G.player.x = f.x; G.player.y = f.y;
    G.cam.x = f.x; G.cam.y = f.y;
    G.stage = 'prologue';
    G.month = 2;
    $('loading').hidden = true;
    $('hud').hidden = false;
    journal('You come of age in a village of the <b>' + esc(tale.name) + '</b>.');
    dialog({ kicker: 'Prologue · Year ' + START, title: G.player.name + ', child of the ' + tale.name, html:
      '<p>Your name is <b>' + esc(G.player.name) + '</b>.</p>' + tale.html +
      '<p><b>Custom demands that every youth of age present themselves to the ruler.</b> Walk to the capital (follow the gold marker) and speak to ' + esc(tale.ruler) + '.</p>' +
      '<p class="muted">WASD to move · J sword · K bow (hold to strafe) · Space to roll · Q potion · E to talk · H for help</p>',
      buttons: [{ label: 'Set out' }] });
  }

  function frame(ts) {
    var dt = Math.min(0.05, (ts - (G.lastTs || ts)) / 1000);
    G.lastTs = ts;
    if (G.stage === 'loading') loadingFrame();
    else if (G.stage !== 'title') {
      if (!G.world.isComplete(G.cur)) G.world.compute(G.cur, 7);
      else if (!G.world.isComplete(G.world.root)) G.world.compute(G.world.root, 5);
      else if (G.oracle && !G.oracle.done) G.oracle.work(4);
      if (!G.modal && !G.panel) update(dt);
      else G.time += 0; // the world holds still while you read
      storyFrame();
      render();
      G.hudT -= dt;
      if (G.hudT <= 0) { hud(); G.hudT = 0.12; if (G.panel === 'scope' && !G.world.isComplete(G.cur)) renderScopeText(); }
    }
    requestAnimationFrame(frame);
  }

  function init() {
    canvas = $('game');
    ctx = canvas.getContext('2d');
    resize();
    bindInput();
    var m = /seed=(\d+)/.exec(location.hash);
    $('seed').value = m ? m[1] : String(todaySeed());
    $('btn-begin').onclick = function () { startWorld(parseInt($('seed').value, 10) || 1); };
    $('btn-rand').onclick = function () { $('seed').value = String(1 + Math.floor(Math.random() * 99999)); };
    $('btn-today').onclick = function () { $('seed').value = String(todaySeed()); };
    $('seed').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btn-begin').click(); });
    $('seed').focus();
    requestAnimationFrame(frame);
  }

  window.RPG = {
    G: G, esc: esc, findFree: findFree, dirText: dirText, homeCiv: homeCiv, foeCiv: foeCiv, rulerName: rulerName, isActive: isActive,
    spawnAt: spawnAt, spawnNear: spawnNear, spawnPickup: spawnPickup, spawnDeco: spawnDeco, applyDeed: applyDeed, toast: toast,
    journal: journal, passMonths: passMonths, renown: function () { return G.renown; }, RENOWN_REGICIDE: RENOWN_REGICIDE, level: function () { return G.player.level; }, reward: reward, onQuestDone: onQuestDone, provOf: provOf,
    // for testing and debugging from the console
    debug: { travelTo: travelTo, readFate: readFate, gainXp: gainXp, talk: talk, kill: kill, nearestTalker: nearestTalker, curFate: curFate,
      step: function (dt) { update(dt); }, roll: roll, drink: drinkPotion, maxHp: function () { return maxHp(G.player); }, KINDS: KINDS, BAL: BAL,
      teleport: function (x, y) { G.player.x = x; G.player.y = y; G.cam.x = x; G.cam.y = y; manageActive(); }, provCenter: provCenter, homeCiv: homeCiv, foeCiv: foeCiv }
  };
  window.addEventListener('DOMContentLoaded', init);
}());
