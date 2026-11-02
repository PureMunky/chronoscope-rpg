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
  var DEED_NAMES = { irrigate: 'Irrigation', rally: 'Rally', heal: 'Tending the sick', settle: 'Settlement', learn: 'Learning', teach: 'Teaching', discord: 'Discord', assassinate: 'Assassination',
    prophet: 'A prophet\'s word', bless: 'The land heals', blight: 'Salted earth', tribe: 'A new people', knowledge: 'Lost knowledge', plague: 'Plague' };
  var Gear = window.Gear;

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
    branchNames: {}, renown: 0, standing: {}, hudT: 0, activeT: 0, edgeWarned: false
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
  // ---------------------------------------------------------------------------
  // Relations between realms, read from the simulation's own history
  // ---------------------------------------------------------------------------
  // at war   one took provinces from the other in the last 20 years, or will within 5 (the war records)
  // kin      one split from the other, or both from the same parent realm
  // friendly not at war, but fighting a common enemy
  // uneasy   neighbours sharing a border
  // peace    everyone else
  var REL = { bid: -1, bver: -1, year: -1, wl: -1, war: {}, enemies: {}, borderVer: -1, border: {}, memo: {} };
  function relData() {
    var b = G.cur;
    if (REL.bid !== b.id || REL.bver !== b.version || REL.year !== G.year || REL.wl !== b.warLog.length) {
      REL.bid = b.id; REL.bver = b.version; REL.year = G.year; REL.wl = b.warLog.length;
      REL.war = {}; REL.enemies = {}; REL.memo = {};
      b.warLog.forEach(function (w) {
        if (w.dec * 10 > G.year + 5 || w.dec * 10 + 9 < G.year - 20) return;   // fought in the last 20 years, or about to be
        REL.war[w.a + '|' + w.d] = REL.war[w.d + '|' + w.a] = 1;
        (REL.enemies[w.a] = REL.enemies[w.a] || {})[w.d] = 1;
        (REL.enemies[w.d] = REL.enemies[w.d] || {})[w.a] = 1;
      });
    }
    if (REL.borderVer !== G.ver) {
      REL.borderVer = G.ver; REL.border = {}; REL.memo = {};
      var s = G.s;
      for (var i = 0; i < N; i++) {
        var c = s.owner[i];
        if (c < 0) continue;
        for (var d = 1; d <= 2; d++) {
          var n = NB[i * 4 + d];
          if (n < 0 || s.owner[n] < 0 || s.owner[n] === c) continue;
          var a = s.cSig[c], bb = s.cSig[s.owner[n]];
          REL.border[a + '|' + bb] = REL.border[bb + '|' + a] = 1;
        }
      }
    }
    return REL;
  }
  function relation(a, b) {
    if (!a || !b) return 'none';
    if (a === b) return 'self';
    var R = relData(), mk = a + '|' + b, m = R.memo[mk];
    if (m) return m;
    return (R.memo[mk] = R.memo[b + '|' + a] = relationRaw(a, b, R));
  }
  function relationRaw(a, b, R) {
    if (R.war[a + '|' + b]) return 'war';
    var ca = civIdx(a), cb = civIdx(b), s = G.s;
    if (ca >= 0 && cb >= 0) {
      var pa = s.cParent[ca], pb = s.cParent[cb];
      if (pa === b || pb === a || (pa && pa === pb)) return 'kin';
    }
    var ea = R.enemies[a], eb = R.enemies[b];
    if (ea && eb) for (var k in ea) if (eb[k]) return 'friendly';
    return R.border[a + '|' + b] ? 'uneasy' : 'peace';
  }
  var REL_TEXT = { war: 'at war with', kin: 'kin to', friendly: 'friendly with', uneasy: 'uneasy neighbours of', peace: 'at peace with', self: '', none: '' };
  function warsOf(sig) { var e = relData().enemies[sig] || {}; return Object.keys(e).map(Number).filter(function (x) { return civIdx(x) >= 0; }); }

  // Your standing with each realm: what they think of you. Your own people start out on your side.
  function standingOf(sig) { return (G.standing[sig] || 0) + (G.home && sig === G.home.sig ? 40 : 0); }
  function hostileToPlayer(sig) {
    if (!sig) return true;
    var st = standingOf(sig);
    if (st <= -30) return true;
    if (st >= 30) return false;
    return G.home ? relation(G.home.sig, sig) === 'war' : false;
  }
  function friendlyToPlayer(sig) {
    if (!sig) return false;
    var st = standingOf(sig);
    if (st >= 30) return true;
    if (st <= -30) return false;
    var r = G.home ? relation(G.home.sig, sig) : 'none';
    return r === 'kin' || r === 'friendly';
  }
  function changeStanding(sig, by, why) {
    if (!sig) return;
    var before = standingOf(sig);
    G.standing[sig] = (G.standing[sig] || 0) + by;
    var after = standingOf(sig), name = esc(civName(sig));
    if (before > -30 && after <= -30) toast('The <b>' + name + '</b> now count you as an enemy' + (why ? ' (' + why + ')' : '') + '. Their soldiers will attack you on sight.', 7000);
    else if (before < 30 && after >= 30) toast('The <b>' + name + '</b> count you as a friend. Their soldiers will leave you be.', 6000);
    reassessHostility();
  }
  /** Soldiers decide again whether you are their enemy (after a year passes or your standing changes). */
  function reassessHostility() {
    G.actors.forEach(function (a) {
      if (!a.faction || !a.armed || a.forceHostile || a.offended) return;
      a.hostile = hostileToPlayer(a.faction);
    });
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
    p.suspicion = 0;
    return p;
  }
  /** A new bearer starts with the gear of the people they were born among. */
  function equipNative(p, pi) {
    var la = Gear.localAge(pi);
    var c = G.s.owner[pi];
    Gear.starter(p, la >= 0 ? la : 2, c >= 0 ? G.s.cSig[c] : (G.home ? G.home.sig : 0));
  }
  function maxHp(p) {
    var f = p.age > 50 ? Math.max(0.55, 1 - (p.age - 50) * 0.012) : 1;
    return Math.round((100 + 15 * (p.level - 1)) * f);
  }
  function swordDmg() { return Math.round((15 + BAL.swordPer * (G.player.level - 1)) * G.player.eq.melee.mult); }
  function bowDmg() { return Math.round((11 + BAL.bowPer * (G.player.level - 1)) * G.player.eq.ranged.mult); }
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
    var dr = Gear.dressInfo(provOf(p.x, p.y)), silver = Math.round(xp * 0.4 * dr.pay);
    p.silver += silver;
    toast('+' + xp + ' XP, +' + silver + ' silver' + (potions ? ', +' + potions + ' potion' : '') + (dr.pay < 1 ? ' <span class="muted">(less than they would pay one of their own: you look ' + dr.label + ')</span>' : ''));
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
    var here = provOf(p.x, p.y), before = G.active[here] != null && G.s.owner[here] >= 0 ? Life.outlook(here) : null;
    seekYear(G.year + 1);
    var news = Life.yearNews(before);
    if (news) toast(news, 7000);
    refreshActive();
    reassessHostility();
    yearEvents();
    autosave();
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
    if (!block && type === 'tribe' && !Sim.isLand(s.terrain[pi])) block = 'There is no land here.';
    if (!block && type === 'plague' && s.pop[pi] <= 0) block = 'No one lives here any more.';
    if (!block && type === 'knowledge' && s.owner[pi] < 0) block = 'No people here to learn it.';
    if (block) { toast('<b>' + DEED_NAMES[type] + '</b> came to nothing: ' + esc(block), 7000); return false; }
    var before = measure(type, pi), prev = readFate(G.cur), old = G.cur;
    G.cur = G.world.intervene(G.cur, G.year, { type: type, x: x, y: y, v: v || 0, note: why || '' });
    if (G.cur !== old) G.cur.name = lifeBranchName();
    var iv = G.cur.interventions[G.cur.interventions.length - 1];
    if (type === 'bless' || type === 'blight') { L.clearCaches(); window.Pixel.clearCaches(); }
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
      case 'prophet': msg = 'Solidarity here ' + pct(before.local) + ' → ' + pct(after.local) + (before.c >= 0 ? '; across all of the ' + rn + ': ' + (before.realm / 100).toFixed(1) + '% → ' + (after.realm / 100).toFixed(1) + '%' : '') + '.'; break;
      case 'bless': case 'blight': msg = 'Soil fertility here ' + pct(before.soil) + ' → ' + pct(after.soil) + '.'; break;
      case 'tribe': msg = after.sig ? 'A new people is born: the <b>' + esc(civName(after.sig)) + '</b>.' : 'A new people is born.'; break;
      case 'knowledge': msg = 'The knowledge of the ' + rn + ': ' + before.tech + ' → ' + after.tech + ' (' + Sim.AGES[Sim.ageOf(after.tech)].name + ').'; break;
      case 'plague': msg = 'Plague breaks out among the ' + rn + '.'; break;
    }
    G.deeds.push({ year: G.year, type: type, pi: pi, why: why || '', msg: msg, who: p.name, iv: iv, sig: before.sig, newSig: after.sig });
    toast('<b>History changes. ' + DEED_NAMES[type] + '</b> in ' + G.year + ': ' + msg, 8000);
    journal('<b>' + DEED_NAMES[type] + '</b> at (' + x + ', ' + y + ') in ' + G.year + '. ' + msg);
    G.fateWatch = { prev: prev };
    G.oracle = null;
    autosave();
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
    toast(msg + ' <span class="muted">(Press <b>V</b> to watch the two histories diverge.)</span>', 9000);
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
    shield: { name: 'Shieldbearer', hp: 40, dmg: 9, speed: 2.5, r: 0.33, xp: 20, reach: 1.1, wind: 0.42, aggro: 8, scale: 1, uniform: 1, shield: 1 },
    rebel: { name: 'Rebel', hp: 30, dmg: 8, speed: 3.0, r: 0.3, xp: 12, reach: 1.0, wind: 0.34, aggro: 8, scale: 1 },
    hunter: { name: 'Witch-hunter', hp: 40, dmg: 10, speed: 3.2, r: 0.3, xp: 14, reach: 1.15, wind: 0.36, aggro: 12, scale: 1, uniform: 1 },
    warden: { name: 'Tomb warden', hp: 55, dmg: 12, speed: 2.6, r: 0.34, xp: 22, reach: 1.2, wind: 0.42, aggro: 7, scale: 1 },
    greatbeast: { name: 'Great beast', hp: 260, dmg: 20, speed: 3.3, r: 0.6, xp: 120, reach: 1.45, wind: 0.5, aggro: 9, beast: 1, boss: 1 },
    granary: { name: 'Granary', hp: 45, r: 0.5, xp: 5, obj: 1 },
    storehouse: { name: 'Storehouse', hp: 50, r: 0.5, xp: 5, obj: 1 },
    well: { name: 'Well', hp: 40, r: 0.45, xp: 5, obj: 1 }
  };
  var NPC_ROLES = { villager: 1, elder: 1, royal: 1, spymaster: 1, scholar: 1, stranger: 1, settler: 1, lord: 1, sentry: 1, smith: 1, prophet: 1, exile: 1, stele: 1 };
  var EPITHETS = [['the Cruel', 'brutal'], ['the Swift', 'swift'], ['the Unbroken', 'stalwart'], ['Ironhide', 'stalwart'], ['the Butcher', 'brutal'], ['Quickblade', 'swift']];
  /** A named elite: tougher, with a trait, and it drops the gear of its age. */
  function makeElite(a) {
    var e = EPITHETS[(Math.random() * EPITHETS.length) | 0];
    a.elite = e[1];
    a.name = Story.personName(a.faction || G.world.seed, a.id) + ' ' + e[0];
    a.maxHp = a.hp = Math.round(a.maxHp * (e[1] === 'stalwart' ? 2.2 : 1.7));
    if (e[1] === 'brutal') a.dmg = Math.round(a.dmg * 1.4);
    if (e[1] === 'swift') { a.speed *= 1.35; a.wind *= 0.8; }
    a.xp = Math.round(a.xp * 2.5);
  }

  function spawnAt(kind, x, y, o) {
    o = o || {};
    var a = { id: G.nextId++, kind: kind, x: x, y: y, hx: x, hy: y, face: Math.random() * 6.28, state: 'idle', t: 0, cd: rnd(0.3, 1.2), cd2: 3, flash: 0, kbx: 0, kby: 0, wt: 0, wx: x, wy: y, walkT: Math.random() * 9 };
    for (var k in o) a[k] = o[k];
    if (a.prov == null) a.prov = provOf(x, y);
    if (NPC_ROLES[kind]) {
      a.npc = true; a.role = kind; a.r = kind === 'stele' ? 0.4 : 0.3; a.speed = kind === 'villager' || kind === 'settler' ? 1.2 : kind === 'stele' ? 0 : 0.5;
      a.hostile = false;
      if (a.follow) { a.maxHp = a.hp = kind === 'prophet' ? 140 : 70; a.speed = 4.2; }
      else a.maxHp = a.hp = 25;
      if (!a.name) a.name = kind === 'villager' ? 'Villager' : kind;
    } else if (kind === 'ghost') {
      a.ghost = true; a.r = 0.3; a.hostile = false;
    } else if (kind === 'tent' || kind === 'fire' || kind === 'ruins') {
      a.deco = true; a.r = 0.4;
    } else {
      var K = KINDS[kind], age = 0;
      if (K.scale) {
        var fc = a.faction ? civIdx(a.faction) : G.s.owner[a.prov];
        age = fc >= 0 ? Sim.ageOf(G.s.cTech[fc]) : 1;
        if (o.age != null) age = o.age;
      }
      a.name = kind === 'ruler' && a.faction ? rulerName(a.faction) : kind === 'greatbeast' && a.beastName ? a.beastName : K.name;
      a.age = age;
      a.maxHp = a.hp = Math.round(K.hp * (1 + BAL.hpAge * age));
      a.dmg = Math.round((K.dmg || 0) * (1 + BAL.dmgAge * age));
      a.speed = K.speed || 0; a.r = K.r; a.xp = Math.round(K.xp * (1 + 0.1 * age)); a.reach = K.reach || 1; a.wind = K.wind || 0.3;
      a.aggro = K.aggro || 8; a.ranged = !!K.ranged; a.boss = !!K.boss; a.obj = !!K.obj; a.beast = !!K.beast; a.uniform = !!K.uniform; a.shield = !!K.shield;
      a.armed = !!K.uniform && kind !== 'hunter';
      a.forceHostile = o.hostile === true;
      // a realm's soldiers are your enemies only if your people are at war with them, or they have reason to hate you
      if (a.hostile == null) a.hostile = a.faction && a.armed ? hostileToPlayer(a.faction) : true;
      if (a.obj) a.hostile = false;
      if (kind === 'greatbeast') a.look = Sim.hash4(a.prov, 1, 2, 3) % 2 ? 'bear' : 'wolf';
      if (!a.obj && !a.boss && !a.beast && !o.noElite && Math.random() < (o.qid ? 0.12 : 0.08) && !G.simMode) makeElite(a);
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
      var nv = Math.min(7, 2 + ((dyn.houses.length / 2) | 0));
      for (k = 0; k < nv; k++) spawnNear('villager', bx + C + rnd(-3, 3), by + C + rnd(-3, 3), { prov: pi, faction: sig, name: 'Villager' });
      if (cap) {
        if (c === hc) {
          spawnNear('royal', bx + C + 1.5, by + C - 0.5, { prov: pi, faction: sig, key: 'royal:' + sig, name: rulerName(sig) });
          if (G.stage === 'quest' || G.stage === 'won') {
            spawnNear('spymaster', bx + C - 1.5, by + C - 1.5, { prov: pi, faction: sig, key: 'spymaster:' + sig, name: 'Spymaster ' + Story.personName(sig, 501) });
            spawnNear('scholar', bx + C - 1.5, by + C + 2.5, { prov: pi, faction: sig, key: 'scholar:' + sig, name: 'Scholar ' + Story.personName(sig, 502) });
          }
        } else if (!hasQuestAt(pi, 'regicide') && !hasQuestAt(pi, 'cradle')) {
          spawnNear('lord', bx + C + 1.5, by + C - 0.5, { prov: pi, faction: sig, name: rulerName(sig) });
          spawnNear('sentry', bx + C - 0.5, by + C - 0.5, { prov: pi, faction: sig, name: 'Sentry of the ' + civName(sig) });
          spawnNear('sentry', bx + C + 3.5, by + C - 0.5, { prov: pi, faction: sig, name: 'Sentry of the ' + civName(sig) });
        }
      } else if (pop >= 15 && Sim.hash4(G.world.seed, pi, 0, 951) % 3 === 0) {
        spawnNear('elder', bx + C + 2.5, by + C + 1.5, { prov: pi, faction: sig, key: 'elder:' + pi, name: 'Elder ' + Story.personName(sig, pi) });
      }
      if (cap || (pop >= 900 && Sim.hash4(G.world.seed, pi, 1, 952) % 5 === 0)) {
        spawnNear('smith', bx + C - 2.5, by + C + 1.5, { prov: pi, faction: sig, name: 'Smith ' + Story.personName(sig, pi + 3) });
      }
    }
    // the marks your deeds left on this place
    deedsHere(pi).forEach(function (d, k) {
      if (k > 1) return;
      spawnNear('stele', bx + C + (k ? -3.5 : 3.5), by + C + 3.5, { prov: pi, deed: d, name: 'A stone marker' });
    });
    if (!(G.cleared[pi] >= G.year)) {
      var t = s.terrain[pi];
      if (c < 0 && pop === 0) {
        var ch = { 2: 0.3, 3: 0.55, 4: 0.45, 5: 0.25, 6: 0.35 }[t] || 0.3;
        if (Math.random() < ch) {
          var wk = t === TER.DESERT ? 'jackal' : t === TER.MOUNTAIN || (t === TER.FOREST && Math.random() < 0.2) ? 'bear' : 'wolf';
          spawnGroup(pi, wk === 'bear' ? ['bear'] : wk === 'jackal' ? ['jackal', 'jackal'] : Math.random() < 0.5 ? ['wolf', 'wolf'] : ['wolf', 'wolf', 'wolf']);
        }
      } else if (c >= 0) {
        // a war front: a neighbouring realm this one is really at war with (by the simulation's records)
        var foeTile = -1;
        for (var fy = -1; fy <= 1 && foeTile < 0; fy++) for (var fx = -1; fx <= 1; fx++) {
          var fj = pi + fy * W + fx;
          if (fj < 0 || fj >= N || s.owner[fj] < 0 || s.owner[fj] === c) continue;
          if (relation(sig, s.cSig[s.owner[fj]]) === 'war') { foeTile = fj; break; }
        }
        if (foeTile >= 0 && Math.random() < 0.35) {
          var fsig = s.cSig[s.owner[foeTile]], ang = Math.atan2(((foeTile / W) | 0) - ((pi / W) | 0), foeTile % W - pi % W);
          var cx = bx + C + 0.5, cy = by + C + 0.5;
          // defenders hold the village; attackers come from the enemy's side
          Quests.warband(s, c, 2 + (Math.random() * 2 | 0), false).forEach(function (kd, i) { spawnNear(kd, cx + Math.cos(ang) * 1.5 + (i - 1), cy + Math.sin(ang) * 1.5, { prov: pi, faction: sig, front: true }); });
          Quests.warband(s, s.owner[foeTile], 2 + (Math.random() * 2 | 0), Math.random() < 0.4).forEach(function (kd, i) {
            var at = spawnNear(kd, cx + Math.cos(ang) * 5.5 + (i - 1) * 0.9, cy + Math.sin(ang) * 5.5 + (i % 2), { prov: pi, faction: fsig, front: true });
            if (at) at.state = 'chase';
          });
        } else if (hc >= 0 && c !== hc && bordersRealm(pi, hc) && Math.random() < 0.35) {
          // a patrol on a quiet border: it only troubles you if your people are at war, or you have wronged them
          spawnGroup(pi, Math.random() < 0.5 ? ['soldier', 'bowman'] : ['soldier', 'soldier', 'bowman'], { faction: sig, patrol: true });
        }
      }
      if (c >= 0 && (s.starve[pi] || Sim.meanAsab(s, c) < 2200) && Math.random() < 0.45) spawnGroup(pi, Math.random() < 0.5 ? ['bandit'] : ['bandit', 'archer']);
      if (s.plague[pi]) spawnGroup(pi, ['rat', 'rat', 'rat'].slice(0, 2 + (Math.random() * 2 | 0)));
    }
    if (withQuests) Quests.spawnFor(pi);
  }

  /** Deeds of yours that still stand in this timeline, done here by this year. */
  function deedsHere(pi) {
    return G.deeds.filter(function (d) { return d.pi === pi && d.year <= G.year && G.cur.interventions.indexOf(d.iv) >= 0; });
  }
  function deedsNear(pi, r) {
    return G.deeds.filter(function (d) { return md(d.pi, pi) <= r && d.year < G.year && G.cur.interventions.indexOf(d.iv) >= 0; });
  }
  function despawnProv(pi, keepQuest) {
    G.actors = G.actors.filter(function (a) { return a.prov !== pi || (keepQuest && a.qid) || a.role === 'stranger' || a.follow || a.ghost; });
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
    G.hist = []; G.trail = [];
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
  function pursue(a, speed, dt, target) {
    var p = target || G.player;
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
    dmg = Math.max(1, Math.round(dmg * (1 - p.eq.armor.reduce)));
    p.hp -= dmg; p.inv = 0.45; p.hurt = 0.3; p.calm = 0; G.shake = 0.22;
    floatText(p.x, p.y, '-' + dmg, '#ff6b6b');
    if (src) { var a = Math.atan2(p.y - src.y, p.x - src.x); move(p, Math.cos(a) * 0.25, Math.sin(a) * 0.25, false); }
    if (p.hp <= 0) { p.hp = 0; playerDies(src); }
  }

  function damageActor(a, dmg, kb, sx, sy) {
    var p = G.player;
    if (sx == null) { sx = p.x; sy = p.y; }
    // a shieldbearer blocks blows from the front unless it is mid-swing
    if (a.shield && a.state !== 'wind' && a.state !== 'recover' && angDiff(a.face, Math.atan2(sy - a.y, sx - a.x)) < 1.1) {
      dmg *= 0.15;
      if (G.time - (a.blockT || -9) > 0.6) { floatText(a.x, a.y - 0.2, 'Blocked', '#b8c4d4'); a.blockT = G.time; }
    }
    dmg = Math.round(dmg);
    if (!a.hostile && a.armed && a.faction) offend(a);
    a.hp -= dmg; a.flash = 0.12;
    floatText(a.x, a.y, String(dmg), '#ffe08a');
    if (!a.obj) {
      var ang = Math.atan2(a.y - sy, a.x - sx);
      var kf = (a.boss ? 0.3 : 1) * (a.state === 'wind' ? BAL.kbWind : 1);
      a.kbx += Math.cos(ang) * kb * kf; a.kby += Math.sin(ang) * kb * kf;
      if (a.state === 'idle' || a.state === 'return') { a.state = 'chase'; alertNear(a); }
      if (a.state === 'wind' && !a.boss) a.t += BAL.windStun;
    }
    if (a.hp <= 0) kill(a);
  }
  function alertNear(a) {
    G.actors.forEach(function (b) {
      if (b.state !== 'idle' || Math.hypot(b.x - a.x, b.y - a.y) >= 7 || b.npc || b.obj || b.deco || b.ghost) return;
      if ((a.faction && b.faction === a.faction) || (b.hostile && a.hostile && !a.faction)) b.state = 'chase';
    });
  }

  /** You struck a soldier who was not your enemy: their comrades turn on you, and their realm remembers. */
  function offend(a) {
    var sig = a.faction;
    G.actors.forEach(function (b) {
      if (b.faction === sig && b.armed && Math.hypot(b.x - a.x, b.y - a.y) < 10) { b.hostile = true; b.offended = true; if (b.state === 'idle') b.state = 'chase'; }
    });
    if (!G.offendT || G.time - G.offendT > 5) { G.offendT = G.time; toast('You strike a soldier of the <b>' + esc(civName(sig)) + '</b>. Their comrades turn on you.'); }
    changeStanding(sig, -12, 'you attacked their soldiers');
  }
  function kill(a) {
    var i = G.actors.indexOf(a);
    if (i < 0) return;
    // a realm remembers who killed its soldiers, and who defended its land
    if (a.faction && a.armed) {
      changeStanding(a.faction, -5);
      var land = G.s.owner[a.prov], lsig = land >= 0 ? G.s.cSig[land] : 0;
      if (lsig && lsig !== a.faction && relation(lsig, a.faction) === 'war') changeStanding(lsig, 4);
    }
    G.actors.splice(i, 1);
    addEffect({ type: 'puff', x: a.x, y: a.y, life: 0.5, color: a.obj ? '#ff9a3c' : '#ddd' });
    if (a.obj) addEffect({ type: 'fireburst', x: a.x, y: a.y, life: 1.6 });
    if (a.xp) gainXp(a.xp);
    if (!a.obj && !a.npc) {
      if (Math.random() < (a.boss || a.elite ? 1 : 0.1)) spawnPickup('potion', a.x + 0.3, a.y, { prov: a.prov });
      if (a.ranged && Math.random() < 0.6) spawnPickup('arrows', a.x - 0.3, a.y, { prov: a.prov, n: 3 + (Math.random() * 4 | 0) });
      if (!a.beast && Math.random() < 0.45) spawnPickup('coin', a.x, a.y - 0.3, { prov: a.prov, n: 2 + (Math.random() * 4 | 0) + (a.age || 0) * 2 + (a.elite ? 15 : 0) + (a.boss ? 40 : 0) });
      if ((a.elite && Math.random() < 0.6) || (a.boss && !a.beast)) Gear.dropFor(a, a.age || 0);
    }
    if (a.boss) toast('<b>' + esc(a.name) + '</b> is dead.', 6000);
    if (a.qid) Quests.onKill(a);
    else if (a.hostile && !G.actors.some(function (b) { return b.hostile && !b.qid && b.prov === a.prov; })) G.cleared[a.prov] = G.year;
  }

  /** Keyboard aim assist. Sword: turn to the nearest foe within reach. Bow: the best target in a cone ahead. */
  /** Neutral soldiers can be struck, deliberately: in a skirmish you pick your side. Friends cannot. */
  function canHit(a) { return a.hostile || a.obj || (a.armed && !a.npc && !friendlyToPlayer(a.faction)); }
  function targets() {
    var t = G.actors.filter(function (a) { return a.hostile || a.obj; });
    return t.length ? t : G.actors.filter(function (a) { return canHit(a) && a.state !== 'idle'; });
  }
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
  function dismount() { var p = G.player; if (p.mounted) { p.mounted = false; addEffect({ type: 'puff', x: p.x, y: p.y, life: 0.3, color: '#a88a6a' }); } }
  function toggleMount() {
    var p = G.player;
    if (p.dead) return;
    if (!p.horse) { toast('You have no horse. Markets in the Bronze Age or later sell them.'); return; }
    if (p.mounted) { dismount(); return; }
    if (L.isWaterAt(G.s, p.x, p.y)) { toast('Not in a boat.'); return; }
    p.mounted = true;
    if (!G.rideTold) { G.rideTold = true; toast('You swing into the saddle. Faster, and every month on the road covers twice the ground. (Fighting puts you back on your feet.)', 6000); }
  }
  function swordAttack() {
    var p = G.player;
    if (p.swingCd > 0 || p.rollT > 0 || p.dead) return;
    dismount();
    var st = swordTarget();
    if (st) p.face = Math.atan2(st.y - p.y, st.x - p.x);
    p.swingT = 0.2; p.swingCd = 0.38;
    addEffect({ type: 'slash', x: p.x, y: p.y, ang: p.face, life: 0.18 });
    var dmg = swordDmg();
    meleeHit(p.x, p.y, p.face, dmg);
    G.frameEv.swing = dmg;
  }
  /** One sword stroke from (x, y) facing `face`: everything hostile in the arc is hit. */
  function meleeHit(x, y, face, dmg) {
    var inArc = G.actors.filter(function (a) {
      if (!canHit(a)) return false;
      var d = Math.hypot(a.x - x, a.y - y) - a.r;
      if (d > 1.25) return false;
      return !(d > 0.35 && angDiff(face, Math.atan2(a.y - y, a.x - x)) > 1.25);
    });
    // a stroke at your enemies does not catch neutral soldiers beside them
    var foes = inArc.filter(function (a) { return a.hostile || a.obj; });
    (foes.length ? foes : inArc).forEach(function (a) { damageActor(a, dmg * rnd(0.85, 1.15), 4.5, x, y); });
  }
  function shoot() {
    var p = G.player;
    if (p.bowCd > 0 || p.rollT > 0 || p.dead) return;
    var rw = p.eq.ranged;
    dismount();
    if (rw.none) { if (G.time - (G.noArrowT || -9) > 2) { toast('You have nothing to shoot with. (U or I to take out a weapon.)'); G.noArrowT = G.time; } p.bowCd = 0.4; return; }
    var am = Gear.AMMO[rw.ammo];
    if (Gear.ammoOf(p) <= 0) {
      if (G.time - (G.noArrowT || -9) > 2) { toast('Out of ' + am.label + '. ' + (am.age > 4 ? 'Only a people of the ' + Gear.AGE_NAMES[am.age] + ' can make more.' : 'Rest in a village (R) or visit a smith.')); G.noArrowT = G.time; }
      p.bowCd = 0.4; return;
    }
    p.bowCd = rw.cd; Gear.useAmmo(p); p.bowT = 0.3;
    var bt = bowTarget();
    if (bt) p.face = Math.atan2(bt.y - p.y, bt.x - p.x);
    var sp = rw.speed;
    var shot = { x: p.x + Math.cos(p.face) * 0.4, y: p.y + Math.sin(p.face) * 0.4, vx: Math.cos(p.face) * sp, vy: Math.sin(p.face) * sp, dmg: bowDmg(), mine: true, life: 12.5 / sp, bullet: !!rw.gun, stone: rw.w === 'sling' };
    G.projectiles.push(shot);
    G.frameEv.shot = { vx: shot.vx, vy: shot.vy, dmg: shot.dmg, life: shot.life, bullet: shot.bullet, stone: shot.stone, w: rw.w };
    if (rw.gun) { addEffect({ type: 'muzzle', x: p.x + Math.cos(p.face) * 0.7, y: p.y + Math.sin(p.face) * 0.7, life: 0.12 }); G.shake = 0.12; Gear.onShot(); }
  }
  function enemyShoot(a) {
    var p = foeTarget(a) || G.player, d = Math.hypot(p.x - a.x, p.y - a.y), sp = 9;
    var lead = d / sp * 0.5, tx = p.x + (p.lastVx || 0) * lead, ty = p.y + (p.lastVy || 0) * lead;
    var ang = Math.atan2(ty - a.y, tx - a.x) + rnd(-0.08, 0.08);
    a.face = ang;
    G.projectiles.push({ x: a.x + Math.cos(ang) * 0.4, y: a.y + Math.sin(ang) * 0.4, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, dmg: a.dmg, mine: false, life: 1.4, src: a, faction: a.faction, atPlayer: a.hostile });
  }
  /**
   * Who an enemy goes for: you, someone you are escorting if they are closer, or your past
   * self, whom enemies keep fighting as they did the first time (it is the you they were facing).
   */
  function foeTarget(a) {
    var p = G.player, best = null, bd = 1e9;
    if (a.hostile && !p.dead) { best = p; bd = Math.hypot(p.x - a.x, p.y - a.y); }
    var reachFoes = (a.aggro || 8) * 1.6;
    for (var k = 0; k < G.actors.length; k++) {
      var f = G.actors[k], d;
      if (f === a) continue;
      if (a.hostile && (f.follow || (f.ghost && !f.hidden))) {
        d = Math.hypot(f.x - a.x, f.y - a.y) - (f.ghost ? 2.5 : -0.8);
      } else if (a.faction && f.faction && f.faction !== a.faction && (f.armed || f.role === 'villager' || f.role === 'settler') && !f.follow) {
        if (relation(a.faction, f.faction) !== 'war' && !(f.armed && f.offendedBy === a.faction)) continue;
        d = Math.hypot(f.x - a.x, f.y - a.y);
        if (d > reachFoes) continue;
        if (f.role) d += 1.5;                       // soldiers before villagers
      } else continue;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
  /** A blow landing on someone who is not you: soldiers, villagers, escorts, past selves. */
  function hitNpc(t, dmg, src) {
    if (t.follow || t.ghost) { hurtFollower(t, dmg); return; }
    if (t.inv > 0) return;
    t.hp -= dmg; t.flash = 0.12; t.inv = 0.15;
    floatText(t.x, t.y, String(Math.round(dmg)), '#c8c8d0');
    if (src) { var an = Math.atan2(t.y - src.y, t.x - src.x); t.kbx = (t.kbx || 0) + Math.cos(an) * 3; t.kby = (t.kby || 0) + Math.sin(an) * 3; }
    if (t.npc) t.fleeT = 4;
    else if (t.state === 'idle' || t.state === 'return') t.state = 'chase';
    if (t.hp <= 0) {
      var i = G.actors.indexOf(t);
      if (i >= 0) G.actors.splice(i, 1);
      addEffect({ type: 'puff', x: t.x, y: t.y, life: 0.5, color: '#ccc' });
      if (t.qid) Quests.onKill(t);      // allies who finish your quest's foes still count
    }
  }
  function hurtFollower(f, dmg) {
    if (f.inv > 0) return;
    f.hp -= dmg; f.flash = 0.15; f.inv = 0.4;
    floatText(f.x, f.y, '-' + dmg, '#ff9a9a');
    if (f.hp <= 0) {
      var i = G.actors.indexOf(f);
      if (i >= 0) G.actors.splice(i, 1);
      addEffect({ type: 'puff', x: f.x, y: f.y, life: 0.6, color: f.ghost ? '#9ff' : '#ddd' });
      if (f.ghost) paradox(f); else Quests.onFollowerDeath(f);
    }
  }
  function hurt(target, dmg, src) { if (target === G.player) hurtPlayer(dmg, src); else hitNpc(target, dmg, src); }
  function roll() {
    var p = G.player;
    if (p.rollCd > 0 || p.dead) return;
    dismount();
    var ix = p.inX || 0, iy = p.inY || 0;
    if (!ix && !iy) { ix = Math.cos(p.face); iy = Math.sin(p.face); }
    var l = Math.hypot(ix, iy);
    p.rollX = ix / l; p.rollY = iy / l; p.rollT = 0.22; p.rollCd = 0.75; p.inv = Math.max(p.inv, 0.3);
    G.frameEv.roll = true;
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
    equipNative(p, best);
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
    autosave();
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------
  function update(dt) {
    G.time += dt;
    G.wt = (G.wt || 0) + dt;      // world time: the clock a rewind turns back
    G.frameEv = {};
    updatePlayer(dt);
    recordFrame(dt);
    var p = G.player;
    G.flowT = (G.flowT || 0) - dt;
    if (G.flowT <= 0) { updateFlow(); G.flowT = 0.2; }
    for (var k = G.actors.length - 1; k >= 0; k--) { var a = G.actors[k]; if (a) updateActor(a, dt); }
    separate();
    updateProjectiles(dt);
    updatePickups(dt);
    for (k = G.effects.length - 1; k >= 0; k--) { var e = G.effects[k]; e.t += dt; if (e.t >= e.life) G.effects.splice(k, 1); }
    G.activeT -= dt;
    if (G.activeT <= 0) { if (!G.noSpawn) manageActive(); Quests.tick(); G.activeT = 0.25; }
    if (!G.simMode) Gear.update(dt);
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
      if (p.mounted && L.isWaterAt(G.s, p.x + ix * 0.6, p.y + iy * 0.6)) { p.mounted = false; toast('You lead your horse aboard a boat.'); }
      var sp = 4.5 * L.speedAt(G.s, p.x, p.y) * (p.mounted ? 1.8 : 1) * (p.hp < maxHp(p) * 0.25 ? 0.85 : 1) * (p.swingT > 0 ? 0.6 : 1);
      move(p, ix * sp * dt, iy * sp * dt, false);
    }
    var dist = Math.hypot(p.x - ox, p.y - oy);
    p.lastVx = (p.x - ox) / dt; p.lastVy = (p.y - oy) / dt;
    p.moving = dist > 0.001;
    if (p.moving) p.walkT += dist * 3;
    p.boat = L.isWaterAt(G.s, p.x, p.y);
    p.distAcc += p.mounted ? dist / 2 : dist;       // a horse covers twice the ground in a month of your life
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
    if (a.ghost) { updateGhost(a, dt); return; }
    if (a.kbx || a.kby) {
      move(a, a.kbx * dt, a.kby * dt, true);
      var dec = Math.pow(0.0005, dt);
      a.kbx *= dec; a.kby *= dec;
      if (Math.abs(a.kbx) + Math.abs(a.kby) < 0.05) a.kbx = a.kby = 0;
    }
    if (a.obj) return;
    var p = G.player, dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
    if (a.follow) {
      a.inv = (a.inv || 0) - dt;
      a.prov = provOf(a.x, a.y);
      if (d > 14) { var f = findFreeNear(p.x - Math.cos(p.face) * 1.5, p.y - Math.sin(p.face) * 1.5, 4); if (f) { a.x = f.x; a.y = f.y; } }
      else if (d > 1.8 && pursue(a, a.speed * (d > 5 ? 1.1 : 1), dt) > 0.001) a.walkT += a.speed * dt * 3;
      a.face = Math.atan2(dy, dx);
      return;
    }
    if (a.npc) {
      // villagers run from soldiers of a realm at war with theirs
      a.scareT = (a.scareT || 0) - dt;
      if (a.scareT <= 0 && a.role === 'villager' && a.faction) {
        a.scareT = 0.5;
        for (var sk = 0; sk < G.actors.length; sk++) {
          var r = G.actors[sk];
          if (r.armed && r.faction && r.faction !== a.faction && Math.hypot(r.x - a.x, r.y - a.y) < 4.5 && relation(r.faction, a.faction) === 'war') { a.fleeT = 2; a.fleeFrom = r; break; }
        }
      }
      if (a.fleeT > 0) {
        a.fleeT -= dt;
        var fx2 = a.fleeFrom && G.actors.indexOf(a.fleeFrom) >= 0 ? a.fleeFrom.x : p.x, fy2 = a.fleeFrom && G.actors.indexOf(a.fleeFrom) >= 0 ? a.fleeFrom.y : p.y;
        if (steer(a, a.x + (a.x - fx2), a.y + (a.y - fy2), 2.2, dt) > 0.001) { a.face = Math.atan2(a.y - fy2, a.x - fx2); a.walkT += 2.2 * dt * 3; }
        return;
      }
      // villagers out of sight live their day four times a second, not every frame
      if (a.role === 'villager' && d > 22) { a.lodT = (a.lodT || 0) + dt; if (a.lodT < 0.25) return; var ldt = a.lodT; a.lodT = 0; if (Life.update(a, ldt, d)) return; }
      else if (Life.update(a, dt, d)) return;
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
    // go for the nearest enemy: you (if they are your enemy), those you escort, or soldiers of a realm at war with theirs
    var tg = foeTarget(a);
    if (!tg) { if (a.state !== 'idle' && a.state !== 'return') a.state = 'return'; d = 1e9; dx = dy = 0; }
    else { dx = tg.x - a.x; dy = tg.y - a.y; d = Math.hypot(dx, dy); }
    var tgBoat = tg === p && p.boat;
    if (a.kind === 'greatbeast' && !a.summoned && a.hp < a.maxHp * 0.5) {
      a.summoned = true;
      toast('<b>' + esc(a.name) + '</b> howls. The pack answers!');
      for (var w = 0; w < 2; w++) { var cub = spawnNear('wolf', a.x + (w ? 2 : -2), a.y + 1, { prov: a.prov, hostile: true, noElite: true }); if (cub) cub.state = 'chase'; }
    }
    switch (a.state) {
      case 'idle':
        a.wt -= dt;
        if (a.wt <= 0) { a.wx = a.hx + rnd(-2.5, 2.5); a.wy = a.hy + rnd(-2.5, 2.5); a.wt = rnd(2, 5); }
        if (steer(a, a.wx, a.wy, a.speed * 0.35, dt) > 0.001) { a.face = Math.atan2(a.wy - a.y, a.wx - a.x); a.walkT += a.speed * dt; }
        a.ignoreT = (a.ignoreT || 0) - dt;
        if (tg && d < a.aggro && (!tgBoat || d < 3) && a.ignoreT <= 0) { a.state = 'chase'; alertNear(a); }
        break;
      case 'chase':
        if (!tg || home > 18 || d > a.aggro * 2.4 || (tgBoat && d > 4)) { a.state = 'return'; break; }
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
          var sight = clearLine(a.x, a.y, tg.x, tg.y, true);
          if (d > 6.5 || !sight) pursue(a, a.speed, dt, tg);
          else if (d < 3.5) steer(a, a.x - dx, a.y - dy, a.speed * 0.8, dt);
          else steer(a, a.x - dy * 0.3, a.y + dx * 0.3, a.speed * 0.4, dt);
          a.walkT += a.speed * dt * 2;
          if (a.cd <= 0 && d < 10 && sight) { a.state = 'aim'; a.t = 0.45; }
        } else if (a.boss && a.cd2 <= 0 && d > 2.8 && d < 8) {
          a.state = 'chargeWind'; a.t = 0.65;
        } else if (d > a.reach * 0.8 + p.r) {
          pursue(a, a.speed, dt, tg);
          a.walkT += a.speed * dt * 3;
        } else if (a.cd <= 0) { a.state = 'wind'; a.t = a.wind; }
        break;
      case 'aim':
        a.face = Math.atan2(dy, dx);
        a.t -= dt;
        if (a.t <= 0) { if (clearLine(a.x, a.y, tg.x, tg.y, true)) { enemyShoot(a); a.shotT = G.time; } a.state = 'chase'; a.cd = rnd(1.3, 2.1); }
        break;
      case 'wind':
        a.t -= dt;
        if (a.t <= 0) {
          addEffect({ type: 'eslash', x: a.x, y: a.y, ang: a.face, life: 0.15, r: a.reach });
          if (d < a.reach + p.r && angDiff(a.face, Math.atan2(dy, dx)) < 1.15) hurt(tg, a.dmg, a);
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
        if (!a.hitCharge && d < a.r + p.r + 0.25) { a.hitCharge = true; hurt(tg, Math.round(a.dmg * 1.3), a); }
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
        if (tg && d < a.aggro * 0.6 && home < 10 && a.ignoreT <= 0) a.state = 'chase';
        break;
    }
  }

  function separate() {
    var A = G.actors, p = G.player;
    for (var i = 0; i < A.length; i++) {
      var a = A[i];
      if (a.deco || a.ghost) continue;
      for (var j = i + 1; j < A.length; j++) {
        var b = A[j];
        if (b.ghost) continue;
        if (b.deco) continue;
        var dx = b.x - a.x, dy = b.y - a.y, m = a.r + b.r;
        if (dx > m || dx < -m || dy > m || dy < -m) continue;
        var d = Math.hypot(dx, dy);
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
            if (!canHit(a) || Math.hypot(a.x - pr.x, a.y - pr.y) > a.r + 0.12) continue;
            damageActor(a, pr.dmg * rnd(0.9, 1.1), pr.bullet ? 5 : 3, pr.x - pr.vx, pr.y - pr.vy);
            hit = true; break;
          }
        } else if (pr.atPlayer !== false && !p.dead && Math.hypot(p.x - pr.x, p.y - pr.y) < p.r + 0.12) {
          if (p.inv <= 0) { hurtPlayer(pr.dmg, pr.src); hit = true; }
        } else {
          for (var j = 0; j < G.actors.length; j++) {
            var f = G.actors[j];
            if (f === pr.src || Math.hypot(f.x - pr.x, f.y - pr.y) >= f.r + 0.12) continue;
            if (pr.atPlayer !== false && (f.follow || (f.ghost && !f.hidden))) { hurtFollower(f, pr.dmg); hit = true; break; }
            if (pr.faction && f.faction && f.faction !== pr.faction && (f.armed || f.role === 'villager') && relation(pr.faction, f.faction) === 'war') { hitNpc(f, pr.dmg, pr.src); hit = true; break; }
          }
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
      else if (pk.kind === 'arrows') { if ((p.ammo.arrows || 0) >= 40) continue; p.ammo.arrows = Math.min(40, (p.ammo.arrows || 0) + pk.n); floatText(p.x, p.y, '+' + pk.n + ' arrows', '#e8d8a8'); }
      else if (pk.kind === 'coin') { p.silver += pk.n; floatText(p.x, p.y, '+' + pk.n + ' silver', '#e8e8f0'); }
      else if (pk.kind === 'gear') { if (!Gear.pickUp(pk)) continue; }
      G.pickups.splice(k, 1);
      if (pk.qid) Quests.onPickup(pk);
    }
  }

  // ---------------------------------------------------------------------------
  // Rewind: hold G to slip a few seconds back and fight beside your past self
  // ---------------------------------------------------------------------------
  // Everything still alive goes back (positions, wounds, attacks, arrows in flight,
  // people you escort); the dead stay dead, so kills, loot and deeds stay consistent.
  // You keep your wounds: time flows on for you. Your past self, with the health you had then,
  // replays exactly what you did, and the enemies who wounded you are still fighting it, so
  // those wounds land on it (unless this time things go differently). Strain limits it.
  var REWIND = { min: 2, max: 10, keep: 10.5, snapEvery: 0.1, maxGhosts: 3, strainBase: 12, strainPerSec: 3.5, drain: 5 };
  G.hist = []; G.trail = []; G.frameEv = {};

  function canRewind() { return G.stage === 'quest' || G.stage === 'won' || G.simMode; }
  function snapActor(a) {
    var o = { id: a.id, x: a.x, y: a.y, hp: a.hp, state: a.state, t: a.t, cd: a.cd, cd2: a.cd2, face: a.face, kbx: a.kbx, kby: a.kby, hitCharge: a.hitCharge, inv: a.inv, flash: 0 };
    if (a.role === 'villager') o.life = Life.snap(a);
    return o;
  }
  function recordFrame(dt) {
    var p = G.player, ev = G.frameEv;
    G.trail.push({ t: G.wt, x: p.x, y: p.y, face: p.face, walkT: p.walkT, boat: p.boat, rollT: p.rollT, w: G.keys.k ? p.eq.ranged.w : p.eq.melee.w,
      swing: ev.swing || 0, shot: ev.shot || null, roll: !!ev.roll });
    while (G.trail.length && G.trail[0].t < G.wt - REWIND.keep) G.trail.shift();
    G.snapT = (G.snapT || 0) - dt;
    if (G.snapT <= 0) {
      G.snapT = REWIND.snapEvery;
      G.hist.push({
        t: G.wt, hp: p.hp,
        actors: G.actors.filter(function (a) { return (a.hostile || a.obj || a.follow || a.role === 'villager') && !a.ghost; }).map(snapActor),
        work: Life.snapWork(),
        proj: G.projectiles.map(function (pr) { return Object.assign({}, pr); })
      });
      while (G.hist.length && G.hist[0].t < G.wt - REWIND.keep) G.hist.shift();
    }
    p.strain = Math.max(0, (p.strain || 0) - REWIND.drain * dt);
  }
  /** How far back you could go right now (seconds). */
  function rewindAvail() {
    if (!G.hist.length || !G.trail.length) return 0;
    return Math.min(REWIND.max, G.wt - Math.max(G.hist[0].t, G.trail[0].t));
  }
  function rewindCost(sec) { return Math.round(REWIND.strainBase + REWIND.strainPerSec * sec); }
  function rewindAmount() {
    var held = (performance.now() - G.rewindHold.start) / 1000;
    return Math.max(REWIND.min, Math.min(REWIND.min + held * 6, REWIND.max, rewindAvail()));
  }
  function trailAt(t) {
    var tr = G.trail, lo = 0, hi = tr.length - 1;
    if (!tr.length) return null;
    if (t <= tr[0].t) return tr[0];
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tr[mid].t <= t) lo = mid; else hi = mid - 1; }
    return tr[lo];
  }
  function startRewindHold() {
    var p = G.player;
    if (p.dead || G.rewindHold) return;
    if (!canRewind()) { toast('Only the Chronoscope could do that, and you do not have it yet.'); return; }
    if (rewindAvail() < REWIND.min) { toast('The glass shows nothing to go back to yet.'); return; }
    G.rewindHold = { start: performance.now() };
  }
  function releaseRewind() {
    if (!G.rewindHold) return;
    var sec = rewindAmount();
    G.rewindHold = null;
    rewind(sec);
  }
  /** Slip back `sec` seconds. Returns true if it happened. */
  function rewind(sec) {
    var p = G.player;
    sec = Math.min(sec, rewindAvail());
    if (sec < REWIND.min - 0.01) return false;
    var cost = rewindCost(sec), ghosts = G.actors.filter(function (a) { return a.ghost; });
    if ((p.strain || 0) + cost > 100) { toast('The Chronoscope burns in your hand. <b>Too much strain</b>: wait for it to cool (' + Math.round(p.strain) + '/100).'); return false; }
    if (ghosts.length >= REWIND.maxGhosts) { toast('Three of you are already here. The glass will not split again.'); return false; }
    var t0 = G.wt - sec, snap = null;
    for (var k = G.hist.length - 1; k >= 0; k--) if (G.hist[k].t <= t0) { snap = G.hist[k]; break; }
    if (!snap) snap = G.hist[0];
    t0 = snap.t;
    // your past self: everything you did from t0 until now
    var track = G.trail.filter(function (e) { return e.t >= t0; });
    // restore the living world (the dead stay dead)
    var byId = {};
    snap.actors.forEach(function (sa) { byId[sa.id] = sa; });
    G.actors.forEach(function (a) { var sa = byId[a.id]; if (sa) { for (var key in sa) if (key !== 'life') a[key] = sa[key]; if (sa.life) Life.restore(a, sa.life); } });
    if (snap.work) Life.restoreWork(snap.work);
    G.projectiles = snap.proj.map(function (pr) { return Object.assign({}, pr); });
    // the world clock turns back; earlier past selves replay from the same moment
    G.wt = t0;
    ghosts.forEach(function (gh) { gh.lastT = Math.min(gh.lastT, t0); });
    // you go back to where you stood; your wounds are yours, and time keeps flowing for you
    var at = track[0] || trailAt(t0);
    if (at) { p.x = at.x; p.y = at.y; p.face = at.face; }
    p.rollT = 0; p.swingT = 0; p.inv = 0.6;
    G.cam.x = p.x; G.cam.y = p.y;
    if (track.length > 4) {
      var gh = spawnAt('ghost', at.x, at.y, { track: track, lastT: t0 - 0.001, prov: provOf(at.x, at.y), name: 'Your past self' });
      // your past self is you, as you were then: the wounds you took since are about to happen to it
      gh.maxHp = maxHp(p); gh.hp = snap.hp != null ? snap.hp : p.hp;
    }
    p.strain = (p.strain || 0) + cost;
    G.hist = G.hist.filter(function (h) { return h.t <= t0; });
    G.trail = G.trail.filter(function (e) { return e.t <= t0; });
    G.flash = 0.35; G.rewound = 0.6;
    addEffect({ type: 'ring', x: p.x, y: p.y, life: 0.7, color: '#9fe8ff' });
    // two of the same stranger, in plain sight
    var pi = provOf(p.x, p.y);
    if (Gear.localAge(pi) >= 0) { p.suspicion = Math.min(100, (p.suspicion || 0) + 12); }
    if (!G.rewindTold) { G.rewindTold = true; toast('The world lurches ' + sec.toFixed(1) + ' seconds back. <b>Your past self</b> fights on beside you, doing exactly what you did. Keep it alive: if it dies, the paradox hurts.', 8000); }
    return true;
  }
  function updateGhost(a, dt) {
    var local = G.wt, tr = a.track, end = tr[tr.length - 1].t;
    // the moment your past self lifted the Chronoscope, it is gone, exactly as you were
    if (local > end) {
      var last = tr[tr.length - 1], i = G.actors.indexOf(a);
      if (i >= 0) G.actors.splice(i, 1);
      a.vanishedAt = local;
      addEffect({ type: 'ring', x: last.x, y: last.y, life: 0.6, color: '#9fe8ff' });
      addEffect({ type: 'puff', x: last.x, y: last.y, life: 0.4, color: '#bff3ff' });
      return;
    }
    a.hidden = local < tr[0].t;
    if (a.hidden) return;
    a.inv = (a.inv || 0) - dt;
    // replay every recorded frame between where we were and where we are now
    var lo = 0, hi = tr.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tr[mid].t <= local) lo = mid; else hi = mid - 1; }
    var e = tr[lo];
    a.x = e.x; a.y = e.y; a.face = e.face; a.walkT = e.walkT; a.boat = e.boat; a.w = e.w; a.rollT = e.rollT;
    for (var k = 0; k < tr.length; k++) {
      var f = tr[k];
      if (f.t <= a.lastT) continue;
      if (f.t > local) break;
      if (f.swing) { addEffect({ type: 'gslash', x: f.x, y: f.y, ang: f.face, life: 0.18 }); meleeHit(f.x, f.y, f.face, f.swing); }
      if (f.shot) {
        var sh = f.shot;
        G.projectiles.push({ x: f.x + Math.cos(f.face) * 0.4, y: f.y + Math.sin(f.face) * 0.4, vx: sh.vx, vy: sh.vy, dmg: sh.dmg, mine: true, life: sh.life, bullet: sh.bullet, stone: sh.stone });
        if (sh.bullet) addEffect({ type: 'muzzle', x: f.x + Math.cos(f.face) * 0.7, y: f.y + Math.sin(f.face) * 0.7, life: 0.12 });
      }
    }
    a.lastT = local;
  }
  /** Your past self was killed: the paradox snaps back on you. */
  function paradox(gh) {
    var p = G.player, hurtBy = Math.round(maxHp(p) * 0.06);
    p.strain = Math.min(100, (p.strain || 0) + 15);
    p.hp = Math.max(1, p.hp - hurtBy);
    G.shake = 0.4; G.flash = 0.25;
    floatText(p.x, p.y, '-' + hurtBy + ' paradox', '#9ff');
    toast('<b>Paradox!</b> Your past self falls, and something tears inside you. (−' + hurtBy + ' health, +15 strain)', 6000);
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

  var DEED_LEGEND = {
    irrigate: 'dug the canals beside our grandparents', rally: 'stood with us when the raiders came, and gave us heart', heal: 'brought the moonwort when the sickness came',
    settle: 'led the first families into this land', teach: 'taught our people the learning of far-off lands', discord: 'set fire to the royal granaries', assassinate: 'murdered a king in his own hall',
    prophet: 'walked beside the prophet', bless: 'killed the beast that haunted the wild country, so the land could bloom', blight: 'salted the fields until nothing grew',
    tribe: 'was there when a new people was born', knowledge: 'brought back the old knowledge', plague: 'poisoned the wells'
  };
  /** How people remember a deed of yours, depending on how long ago it was. */
  function legend(d) {
    var ago = G.year - d.year, what = DEED_LEGEND[d.type] || 'changed everything';
    if (ago <= 3) return 'Everyone is talking about the stranger, ' + esc(d.who) + ', who ' + what + '.';
    if (ago <= 45) return 'When I was young, a stranger called ' + esc(d.who) + ' ' + what + '. You look a little like them, you know.';
    return 'The old songs tell of ' + esc(d.who) + ', who ' + what + ' in the year ' + d.year + '. ' + (ago > 300 ? 'Nobody knows if it really happened.' : '');
  }
  function villagerLine(a) {
    var s = G.s, pi = a.prov, c = s.owner[pi], lines = [];
    var sus = G.player.suspicion || 0;
    if (sus >= Gear.SUSPECT) return pick(['What is that thing? Get it away from my children!', 'Sorcerer. I knew it the moment I saw you.', 'The priest says things like that come from the devil.'], a.id);
    var told = deedsNear(pi, 3);
    if (told.length && (a.id + Math.floor(G.time / 20)) % 2 === 0) return legend(told[(a.id) % told.length]);
    if (Gear.anachronism(pi) > 0) lines.push('Where did you get that ' + esc(G.player.eq.melee.age > G.player.eq.ranged.age ? G.player.eq.melee.name.toLowerCase() : G.player.eq.ranged.name.toLowerCase()) + '? I\'ve never seen the like.');
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

  function pick(arr, n) { return arr[Math.abs(n) % arr.length]; }

  // ---------------------------------------------------------------------------
  // Village life: the timeline a year and three years on, and what people say about it
  // ---------------------------------------------------------------------------
  function futureState(dy) {
    var y = clamp(G.year + dy, 0, HORIZON - 1);
    if (dy === 1) { G.lifeV1 = G.lifeV1 || new Timeline.View(G.world); return G.lifeV1.seek(G.cur, y); }
    G.lifeV3 = G.lifeV3 || new Timeline.View(G.world); return G.lifeV3.seek(G.cur, y);
  }
  var REPLIES = ['Truly?', 'Gods keep us.', 'So I heard.', 'Hah! Never.', 'Hush, someone\'s listening.', 'Mm.', 'That\'s what I said!', 'Better than last year, at least.', 'We\'ll manage. We always do.'];
  /** What two villagers talk about: whatever the timeline holds for their village. */
  function gossip(a, o) {
    var s = G.s, sig = o.sig, nm = sig ? civName(sig) : '', ru = sig ? rulerName(sig) : 'the chief', mon = MONTHS[(G.month + 2) % 12], L2 = [], r = null;
    var add = function (lines, reply) { L2.push({ lines: lines, reply: reply }); };
    if (o.build.length) add(['We\'ll have the new house roofed by ' + mon + '.', o.build.length > 1 ? 'That makes ' + (o.build.length + 1) + ' new roofs this year. The village keeps growing.' : 'My sister\'s family needs the room. The babies keep coming.'], 'I\'ll lend a hand after the harvest.');
    if (o.leave) add(['The ' + Story.personName(sig || 1, a.prov + 7) + ' family are packing up.', 'The land won\'t feed us all. Some of us have to go.'], 'Where will they go?');
    if (o.starveNow) add(['Nothing in the fields again. We\'re eating acorns.', 'The children cry all night. I gave them the last of the barley.'], 'Gods, let next year be better.');
    else if (o.starveNext || o.soilTired) add(['The soil\'s tired. Every year it gives less.', 'Mark me: next year the harvest fails.'], 'Don\'t say that out loud.');
    if (o.plagueNow) add(['Three more sick on our lane.', 'Don\'t touch the water from the east well.'], 'Keep your door shut.');
    else if (o.plagueNear || o.plagueNext) add(['They\'re coughing in the next valley.', o.plagueNext ? 'It\'ll be here before the year is out, you\'ll see.' : 'Pray it stays there.'], 'Gods keep us.');
    if (o.ageUp) add(['The scholars in the capital say there\'s a better way to build.', 'Everyone\'s pulling down their old walls and doing it the new way.'], 'My father would turn in his grave.');
    if (o.takenBy && relation(sig, o.takenBy) === 'war') add(['The ' + civName(o.takenBy) + ' are massing on the border.', 'We\'re driving stakes on the ' + ['east', 'south', 'west', 'north'][o.threat ? ((Math.round(Math.atan2(o.threat.dy, o.threat.dx) / (Math.PI / 2)) + 4) % 4) : 0] + ' side. For all the good it\'ll do.'], 'If they come, I\'m taking the children to the hills.');
    else if (o.takenBy) add(['They say we\'ll all be ' + civName(o.takenBy) + ' soon, one way or another.', 'My cousin already speaks their tongue.'], 'As long as they leave the fields alone.');
    if (o.foes.length) add(['My son marched against the ' + civName(o.foes[0].sig) + '.', 'Drill every evening now. My arms ache.'], 'Bring him home, gods.');
    if (o.festival) add(['Come dance! It\'s ' + MONTHS[G.month] + '!', 'Best year anyone can remember.'], 'Another cup!');
    if (sig && o.asab > 6000) add(['We\'d follow ' + ru + ' into the sea.', 'The ' + nm + ' have never been stronger.'], 'Long may it last.');
    if (sig && o.asab > 0 && o.asab < 2000) add(['Why should we fight for ' + ru + '? The tax men take everything.', 'If the enemy came tomorrow, I\'d open the gate myself.'], 'Hush, someone\'s listening.');
    var told = deedsNear(a.prov, 3);
    if (told.length) add([legend(told[a.id % told.length])], 'My grandmother told it the same way.');
    if (!L2.length) {
      var m = G.month;
      if (m >= 2 && m <= 4) add(['Barley\'s in. If the rain holds, we\'ll eat well.', 'The oxen are getting old.'], 'So are we.');
      else if (m >= 5 && m <= 6) add(['Hot one today.', 'The stream\'s lower than last year.'], 'It\'ll rain. It always does.');
      else if (m >= 7 && m <= 9) add(['Good harvest. The granary\'s full.', 'We\'ll take the surplus to market.'], 'Better than last year, at least.');
      else add(['The woodpile won\'t last till Thaw.', 'Cold enough to freeze the ' + (nm ? nm + ' ' : '') + 'river.'], 'We\'ll manage. We always do.');
    }
    r = L2[(a.id + Math.floor(G.time / 30)) % L2.length];
    return { lines: r.lines, reply: r.reply };
  }
  function steleText(a) {
    var d = a.deed, ago = G.year - d.year, carved = { irrigate: 'Here the canals were dug', rally: 'Here the people stood fast', heal: 'Here the sickness was driven out',
      settle: 'Here the first families came', teach: 'Here the new learning was taught', discord: 'Here the granaries burned', assassinate: 'Here a king fell',
      prophet: 'Here the prophet spoke', bless: 'Here the beast was slain and the land bloomed', blight: 'Here the fields were salted', tribe: 'Here a people was born',
      knowledge: 'Here the old knowledge returned', plague: 'Here the wells were poisoned' }[d.type] || 'Here history turned';
    return '<p class="vision">' + carved + ', in the year ' + d.year + ', by ' + esc(d.who) + '.</p>' +
      '<p class="muted">' + (ago <= 1 ? 'The stone is freshly cut.' : ago < 60 ? 'Lichen is starting on the letters. ' + ago + ' years have passed.' : 'The letters are worn almost smooth. It has been ' + ago + ' years.') + ' ' + esc(d.why) + '</p>';
  }
  function talk(a) {
    if (!Quests.waitingOn(a) && Gear.refuses(a)) return;
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
      case 'smith': Gear.smithTalk(a); return;
      case 'stele': dialog({ kicker: 'A stone marker', title: '', html: steleText(a), buttons: [{ label: 'Step back' }] }); return;
      case 'prophet': dialog({ kicker: a.name, title: '', html: '<p>"' + pick(['Walk on. I am right behind you.', 'They will listen. They have been waiting so long for someone to tell them they belong to each other.', 'Do not fear for me. Fear for the road.'], Math.floor(G.time)) + '"</p>', buttons: [{ label: 'Onward' }] }); return;
      case 'exile': dialog({ kicker: 'Exile', title: '', html: '<p>"' + pick(['Is it much further?', 'My father would never have dared. Neither would I, without you.', 'When we get there, we will need a name.'], a.id + Math.floor(G.time)) + '"</p>', buttons: [{ label: 'Onward' }] }); return;
      case 'royal': if (royalTalk(a)) return; break;
    }
    var waiting = Quests.waitingOn(a);
    if (waiting) {
      var obj = Quests.objectives().filter(function (o) { return o.q === waiting; })[0];
      dialog({ kicker: a.name, title: waiting.title, html: '<p>"Is it done?"</p><p class="obj">' + (obj ? esc(obj.text) + (obj.pi >= 0 ? ', ' + dirText(provOf(G.player.x, G.player.y), obj.pi) : '') : '') + '</p>', buttons: [{ label: 'Not yet' }] });
      return;
    }
    if (Gear.suspected() && (a.role === 'elder' || a.role === 'scholar' || a.role === 'royal' || a.role === 'spymaster')) {
      dialog({ kicker: a.name, title: '', html: '<p>' + esc(a.name) + ' will not come near you. "People are talking about you, stranger, and about that ' + esc(G.player.eq.ranged.gun ? G.player.eq.ranged.name.toLowerCase() : 'thing you carry') + '. Put away whatever devilry that is and let the talk die down. Then we\'ll see."</p><p class="muted">Suspicion fades when you carry nothing out of its time (I to change what you wield), or in the wilds where no one sees you.</p>', buttons: [{ label: 'Leave' }] });
      return;
    }
    var intro = '', offers = Quests.offersFor(a);
    if (a.role === 'elder') {
      var told = deedsNear(a.prov, 3);
      intro = '<p>' + esc(a.name) + ' leans on a staff.</p>' + (told.length ? '<p><i>"' + legend(told[told.length - 1]) + '"</i></p>' : '') + localReport(a.prov);
    }
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
    var q = offers[idx], btns = q.choices ? q.choices.map(function (c, ci) { return { label: c.label, fn: function () { Quests.accept(q, ci); } }; }) : [{ label: 'Accept', fn: function () { Quests.accept(q); } }];
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

  /** Is the person a quest must be turned in to still there, in this timeline and year? '' if so. */
  function giverGone(q) {
    var parts = (q.returnKey || '').split(':'), role = parts[0], v = +parts[1], s = G.s;
    if (role === 'elder') {
      if (s.owner[v] < 0 || s.pop[v] < 15) return 'The village at (' + (v % W) + ', ' + ((v / W) | 0) + ') no longer exists in this timeline';
      return '';
    }
    if (role === 'royal' || role === 'spymaster' || role === 'scholar') return civIdx(v) < 0 ? 'The ' + civName(v) + ' no longer exist in this timeline' : '';
    return '';
  }
  /** Where to turn a quest in: the giver's village, or wherever their realm's capital is now. */
  function returnPi(q) {
    var parts = (q.returnKey || '').split(':'), role = parts[0], v = +parts[1];
    if (role === 'royal' || role === 'spymaster' || role === 'scholar') { var c = civIdx(v); if (c >= 0) return G.s.cCap[c]; }
    return q.returnPi;
  }
  function onQuestDone(q) {
    setTimeout(autosave, 0);
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
    if (Gear.suspected()) { toast('No one here will give you a bed. Not with that ' + esc(G.player.eq.ranged.gun ? G.player.eq.ranged.name.toLowerCase() : 'strange gear') + '.'); return; }
    p.hp = maxHp(p); p.potions = Math.min(5, Math.max(p.potions, p.potions + 1));
    var stock = Gear.restock(pi);
    toast('You rest a season among the ' + esc(civName(s.cSig[s.owner[pi]])) + '. Health restored, +1 potion. ' + stock + ' It is now ' + MONTHS[G.month] + ', year ' + G.year + '.', 7000);
  }

  function travelTo(y) {
    y = clamp(y | 0, 1, HORIZON - 1);
    var p = G.player;
    if (y === G.year) return;
    var from = G.year;
    G.leftFrom = { year: from };
    Quests.abandonAll('', true);
    seekYear(y);
    p.suspicion = 0; G.gunWarned = false;
    G.month = 2;
    G.edgeWarned = false;
    resetActors();
    var f = findFreeNear(p.x, p.y, 8);
    if (f && collides(p.x, p.y, p.r, false)) { p.x = f.x; p.y = f.y; }
    addEffect({ type: 'ring', x: p.x, y: p.y, life: 1.2, color: '#9fe8ff' });
    G.flash = 0.8;
    journal('You travel from ' + from + ' to the year ' + y + '.');
    autosave();
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
    var ox, oy, labels = [];
    var pw = renderPixelWorld(sx, sy, labels);
    ox = pw.ox; oy = pw.oy;
    // overheard talk, sharp at full resolution
    drawSpeech(ox, oy);
    // names of bosses and elites, sharp at full resolution
    ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'center';
    labels.forEach(function (lb) { ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillText(lb.text, ox + lb.x * TS + 1, oy + lb.y * TS + 1); ctx.fillStyle = lb.col; ctx.fillText(lb.text, ox + lb.x * TS, oy + lb.y * TS); });
    ctx.textAlign = 'left';
    if (G.target && G.actors.indexOf(G.target) >= 0 && !p.dead) {
      var rt = G.target, rx = ox + rt.x * TS, ry = oy + rt.y * TS - rt.r * TS - 6;
      ctx.strokeStyle = G.keys.k ? 'rgba(255,215,90,0.95)' : 'rgba(255,215,90,0.45)'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (var rk = 0; rk < 4; rk++) { var a0 = rk * Math.PI / 2 + G.time * 2; ctx.moveTo(rx + Math.cos(a0) * 14, ry + Math.sin(a0) * 14); ctx.arc(rx, ry, 14, a0, a0 + 0.9); }
      ctx.stroke();
    }
    G.effects.forEach(function (e) { drawEffect(e, ox, oy); });
    // objective markers
    objectiveList().forEach(function (o) { if (o.pi >= 0) drawMarker(o, ox, oy); });
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
    if (G.rewindHold) {
      var amt = rewindAmount(), past = trailAt(G.wt - amt), cost = rewindCost(amt);
      ctx.fillStyle = 'rgba(90,170,230,0.16)'; ctx.fillRect(0, 0, vw, vh);
      if (past) {
        var gx = ox + past.x * TS, gy = oy + past.y * TS;
        ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(160,240,255,0.8)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ox + p.x * TS, oy + p.y * TS - 12); ctx.lineTo(gx, gy - 12); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(gx, gy - 12, 16, 0, 7); ctx.stroke();
      }
      var over = (p.strain || 0) + cost > 100;
      ctx.font = '700 18px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = over ? '#ff8a8a' : '#bff3ff';
      ctx.fillText('◀◀  ' + amt.toFixed(1) + ' s', vw / 2, 118);
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(over ? 'Too much strain: the glass will not turn' : 'Release G to slip back · strain +' + cost, vw / 2, 138);
      ctx.textAlign = 'left';
    }
    if (G.rewound > 0) { ctx.fillStyle = 'rgba(120,220,255,' + (G.rewound * 0.35) + ')'; ctx.fillRect(0, 0, vw, vh); G.rewound -= 1 / 60; }
    if (p.hurt > 0) { ctx.fillStyle = 'rgba(200,30,30,' + (p.hurt * 0.6) + ')'; ctx.fillRect(0, 0, vw, vh); }
    if (G.flash > 0) { ctx.fillStyle = 'rgba(190,240,255,' + Math.min(1, G.flash) + ')'; ctx.fillRect(0, 0, vw, vh); G.flash -= 1 / 60; }
    var lowHp = !p.dead && p.hp < maxHp(p) * 0.3;
    if (lowHp) {
      var gr = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.35, vw / 2, vh / 2, Math.max(vw, vh) * 0.7);
      gr.addColorStop(0, 'rgba(120,0,0,0)'); gr.addColorStop(1, 'rgba(120,0,0,' + (0.35 + Math.sin(G.time * 5) * 0.1) + ')');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, vw, vh);
    }
  }

  // ---------------------------------------------------------------------------
  // 16-bit rendering: the world at 16 pixels a tile, scaled up 2x with crisp pixels
  // ---------------------------------------------------------------------------
  var pxBuf = null, pxCtx = null;
  var PX = window.Pixel, PT2 = 16;
  var PX_HUMAN = { villager: 1, settler: 1, exile: 1, elder: 1, royal: 1, lord: 1, ruler: 1, spymaster: 1, scholar: 1, stranger: 1, prophet: 1, sentry: 1, soldier: 1, guard: 1,
    captain: 1, bowman: 1, shield: 1, bandit: 1, thief: 1, archer: 1, chief: 1, rebel: 1, hunter: 1, warden: 1, smith: 1 };
  function rgbArr(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  /** What a person looks like as a sprite, and what they carry. */
  function pixelSpec(a) {
    var sig = a.faction, cr = sig ? PX.civRamp(sig) : null, tunic = cr ? cr[2] : [122, 106, 88], light = cr ? cr[3] : [176, 150, 112];
    var sp = { body: tunic, skin: PX.skinFor(a.id), hair: PX.hairFor(a.id), hat: 'none' }, w = null;
    switch (a.kind) {
      case 'villager': case 'settler': case 'exile': sp.body = light; if (a.id % 3 === 0) { sp.hat = 'hood'; sp.hatCol = [138, 106, 72]; } break;
      case 'elder': sp.body = [142, 124, 174]; sp.robe = true; sp.hair = [216, 208, 196]; w = 'staff'; break;
      case 'royal': case 'lord': case 'ruler': sp.hat = 'crown'; sp.belt = rgbArr('#f2c84a'); w = a.kind === 'ruler' ? 'sword' : null; break;
      case 'spymaster': sp.body = [47, 52, 64]; sp.hat = 'hood'; sp.hatCol = [31, 35, 44]; break;
      case 'scholar': sp.body = [60, 90, 154]; sp.robe = true; sp.hat = 'hood'; sp.hatCol = [44, 68, 122]; w = 'staff'; break;
      case 'stranger': sp.body = [138, 143, 152]; sp.robe = true; sp.hat = 'hood'; sp.hatCol = [106, 111, 120]; w = 'staff'; break;
      case 'prophet': sp.body = [236, 230, 218]; sp.robe = true; sp.hat = 'hood'; sp.hatCol = [214, 206, 190]; w = 'staff'; break;
      case 'sentry': case 'soldier': case 'guard': sp.hat = 'helmet'; sp.belt = [58, 42, 26]; w = 'spear'; break;
      case 'shield': sp.hat = 'helmet'; sp.belt = [58, 42, 26]; w = 'shield'; break;
      case 'bowman': sp.hat = 'helmet'; w = 'bow'; break;
      case 'captain': sp.hat = 'goldhelm'; sp.belt = rgbArr('#f2c84a'); w = 'sword'; break;
      case 'bandit': sp.body = [106, 80, 56]; sp.hat = 'hood'; sp.hatCol = [74, 56, 40]; w = 'club'; break;
      case 'thief': sp.body = [80, 70, 60]; sp.hat = 'hood'; sp.hatCol = [50, 44, 40]; w = 'sword'; break;
      case 'archer': sp.body = [90, 96, 56]; sp.hat = 'hood'; sp.hatCol = [58, 64, 40]; w = 'bow'; break;
      case 'chief': sp.body = [110, 48, 30]; sp.hat = 'helmet'; w = 'axe'; break;
      case 'rebel': sp.body = [138, 74, 58]; sp.hat = 'hood'; sp.hatCol = [106, 42, 42]; w = 'club'; break;
      case 'hunter': sp.body = [44, 44, 46]; sp.hat = 'hood'; sp.hatCol = [26, 26, 28]; sp.belt = [200, 70, 40]; w = 'spear'; break;
      case 'warden': sp.body = [88, 104, 88]; sp.hat = 'helmet'; sp.skin = [[184, 196, 176], [140, 156, 134]]; w = 'axe'; break;
      case 'smith': sp.body = [96, 78, 60]; sp.belt = [42, 26, 12]; w = 'club'; break;
    }
    if (a.state === 'aim' && a.ranged) w = w || 'bow';
    return { spec: sp, weapon: w };
  }
  function playerSpec(p) {
    var cl = p.eq.clothes, body = cl && cl.sig ? PX.civRamp(cl.sig)[cl.age >= 4 ? 1 : 2] : [47, 127, 143];
    var sp = { body: body, skin: PX.skinFor(Sim.hash4(G.world.seed, p.lives, 3, 3)), hair: PX.hairFor(p.lives + 2), hat: 'none', belt: rgbArr('#c8a050') };
    if (p.eq.armor.age >= 4 && !p.eq.armor.none) { sp.hat = 'helmet'; }
    else if (cl && cl.age >= 6) { sp.hat = 'tophat'; }
    else if (cl && cl.age <= 1) { sp.hat = 'hood'; sp.hatCol = [106, 74, 42]; }
    return sp;
  }
  function pxRing(g, x, y, rx, ry, col) {
    g.fillStyle = col;
    for (var k = 0; k < 28; k++) { var an = k / 28 * Math.PI * 2; g.fillRect(Math.round(x + Math.cos(an) * rx), Math.round(y + Math.sin(an) * ry), 1, 1); }
  }
  function pxBar(g, x, y, w, f, col) {
    x = Math.round(x - w / 2); y = Math.round(y);
    g.fillStyle = 'rgba(16,12,24,0.9)'; g.fillRect(x - 1, y - 1, w + 2, 4);
    g.fillStyle = col; g.fillRect(x, y, Math.max(0, Math.round(w * f)), 2);
  }
  function pxMark(g, x, y, ch, col) {
    x = Math.round(x); y = Math.round(y);
    g.fillStyle = '#18121e'; g.fillRect(x - 2, y - 1, 4, ch === '?' ? 9 : 9);
    g.fillStyle = col;
    if (ch === '!') { g.fillRect(x - 1, y, 2, 5); g.fillRect(x - 1, y + 6, 2, 2); }
    else { g.fillRect(x - 1, y, 3, 1); g.fillRect(x + 1, y + 1, 1, 2); g.fillRect(x, y + 3, 1, 2); g.fillRect(x, y + 6, 1, 2); }
  }
  function renderPixelWorld(sx, sy, labels) {
    var vw = G.vw, vh = G.vh, bw = Math.ceil(vw / 2), bh = Math.ceil(vh / 2), s = G.s, p = G.player;
    if (!pxBuf || pxBuf.width !== bw || pxBuf.height !== bh) { pxBuf = pxBuf || document.createElement('canvas'); pxBuf.width = bw; pxBuf.height = bh; pxCtx = pxBuf.getContext('2d'); }
    var g = pxCtx;
    g.setTransform(1, 0, 0, 1, 0, 0); g.imageSmoothingEnabled = false;
    PX.beginFrame(); PX.setSeason(G.month);
    var box = Math.round(bw / 2 - G.cam.x * PT2 + sx / 2), boy = Math.round(bh / 2 - G.cam.y * PT2 + sy / 2);
    var PWp = P * PT2;
    // exactly the provinces on screen (the one below pokes up by PAD: tall trees and towers)
    var px0 = Math.floor((-box - 4) / PWp), px1 = Math.floor((bw - box + 4) / PWp);
    var py0 = Math.floor((-boy - 4) / PWp), py1 = Math.floor((bh - boy + PX.PAD + 4) / PWp);
    g.fillStyle = '#1a3f72'; g.fillRect(0, 0, bw, bh);
    var px, py, pi;
    for (py = py0; py <= py1; py++) for (px = px0; px <= px1; px++) {
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      pi = py * W + px;
      g.drawImage(PX.renderProvince(s, pi, G.ver), box + px * PWp, boy + py * PWp - PX.PAD);
    }
    // with any time left this frame, get the next provinces ready before they scroll into view, nearest first
    var ring = [], cpx = G.cam.x / P, cpy = G.cam.y / P;
    for (py = py0 - 2; py <= py1 + 2; py++) for (px = px0 - 2; px <= px1 + 2; px++) {
      if (px < 0 || py < 0 || px >= W || py >= H || (px >= px0 && px <= px1 && py >= py0 && py <= py1)) continue;
      ring.push({ pi: py * W + px, d: Math.abs(px + 0.5 - cpx) + Math.abs(py + 0.5 - cpy) });
    }
    ring.sort(function (a, b) { return a.d - b.d; });
    for (var rk = 0; rk < ring.length; rk++) PX.prefetch(s, ring[rk].pi, G.ver);
    // plague: a sickly haze and drifting motes
    for (py = py0; py <= py1; py++) for (px = px0; px <= px1; px++) {
      if (px < 0 || py < 0 || px >= W || py >= H || !s.plague[py * W + px]) continue;
      var bx = box + px * PWp, by = boy + py * PWp;
      g.fillStyle = 'rgba(110,150,50,0.16)'; g.fillRect(bx, by, PWp, PWp);
      g.fillStyle = 'rgba(180,220,100,0.6)';
      for (var k = 0; k < 14; k++) g.fillRect(bx + Math.floor((k * 97 + G.time * (4 + k % 5)) % PWp), by + Math.floor((k * 53 + Math.sin(G.time + k) * 10 + 400) % PWp), 1, 1);
    }
    var list = [];
    G.pickups.forEach(function (pk) { list.push({ y: pk.y - 0.5, pk: pk }); });
    G.actors.forEach(function (a) { var ax = box + a.x * PT2, ay = boy + a.y * PT2; if (ax > -48 && ax < bw + 48 && ay > -24 && ay < bh + 72) list.push({ y: a.y, a: a }); });
    if (!p.dead) list.push({ y: p.y, me: true });
    // what the villagers are building: next year's houses going up, stakes against the coming war
    for (py = py0; py <= py1; py++) for (px = px0; px <= px1; px++) {
      if (px < 0 || py < 0 || px >= W || py >= H || G.active[py * W + px] == null) continue;
      var lo = Life.outlook(py * W + px);
      lo.build.forEach(function (b, i) { list.push({ y: b.y + 0.45, site: b, prog: Life.siteProgress(lo, i) }); });
      var up = Life.stakesUp(lo);
      for (var sk2 = 0; sk2 < up; sk2++) list.push({ y: lo.stakes[sk2].y + 0.4, stake: lo.stakes[sk2] });
    }
    list.sort(function (a, b) { return a.y - b.y; });
    list.forEach(function (o) {
      if (o.site) { PX.drawSite(g, box + o.site.x * PT2, boy + o.site.y * PT2, o.prog); return; }
      if (o.stake) { PX.drawStake(g, box + o.stake.x * PT2, boy + o.stake.y * PT2); return; }
      if (o.pk) { PX.drawPickup(g, o.pk, box + o.pk.x * PT2, boy + o.pk.y * PT2, G.time); return; }
      if (o.me) { drawPixelPlayer(g, p, box + p.x * PT2, boy + p.y * PT2); return; }
      var a = o.a, x = box + a.x * PT2, y = boy + a.y * PT2;
      if (a.ghost) {
        if (a.hidden) return;
        var gs = playerSpec(p); gs.body = [111, 216, 240]; gs.hair = [190, 244, 252]; gs.skin = [[205, 239, 247], [150, 210, 225]]; gs.belt = [150, 240, 255];
        PX.drawCharacter(g, gs, a.face, a.walkT, true, x, y, 0.6);
        PX.drawWeapon(g, a.w, PX.dirRow(a.face), x, y, false);
        if (a.hp < a.maxHp) pxBar(g, x, y - 27, 12, a.hp / a.maxHp, '#7df0ff');
        return;
      }
      if (a.deco || a.obj || a.role === 'stele') { drawPixelThing(g, a, x, y); return; }
      if (a.beast) {
        var big = a.kind === 'greatbeast', hh = PX.drawBeast(g, a, x, y, big ? 2 : 1);
        if (big) { g.fillStyle = 'rgba(160,20,20,0.18)'; g.fillRect(Math.round(x - 20), Math.round(y - hh - 4), 40, hh + 6); }
        if (a.hp < a.maxHp || big) pxBar(g, x, y - hh - 4, big ? 24 : 12, a.hp / a.maxHp, '#e04848');
        if (big || a.boss || a.elite) labels.push({ x: a.x, y: a.y - (hh + 8) / PT2, text: a.name, col: '#ffd76a' });
        return;
      }
      if (!PX_HUMAN[a.kind]) return;
      var ps = pixelSpec(a), moving = a.state === 'chase' || a.state === 'return' || a.fleeT > 0 || (a.npc && Math.hypot(a.wx - a.x, a.wy - a.y) > 0.1) || a.follow;
      if (a.elite) pxRing(g, x, y, 7, 3, '#ffc94a');
      if (a.state === 'wind' || a.state === 'chargeWind' || a.state === 'aim') pxRing(g, x, y - 10, 10, 12, Math.sin(G.time * 30) > 0 ? '#ff4a3a' : '#ff9a6a');
      if (a.kind === 'prophet') { g.fillStyle = 'rgba(255,240,180,0.25)'; g.fillRect(Math.round(x - 9), Math.round(y - 26), 18, 26); }
      if (a.flash > 0) g.filter = 'brightness(2.6)';
      var bob = a.anim ? PX.lifeBob(a.anim, a.lifeT || 0) : 0, cy = y + bob;
      if (a.anim === 'sick' || a.anim === 'talk' || a.anim === 'dance') moving = a.anim === 'dance' && Math.sin((a.lifeT || 0) * 5) > 0;
      var row = PX.drawCharacter(g, ps.spec, a.face, a.anim === 'dance' ? (a.lifeT || 0) * 4 : a.walkT * 0.8, moving, x, cy);
      g.filter = 'none';
      if (a.anim) PX.drawTool(g, a.anim, row, x, cy, a.lifeT || 0);
      else PX.drawWeapon(g, ps.weapon, row, x, y, a.state === 'wind' || a.state === 'recover');
      if (a.carry) PX.drawCarry(g, a.carry, x, cy);
      if (a.bubble && !a.say) PX.drawBubble(g, x + 6, y - 24, a.bubble.icon);
      if (a.state === 'chargeWind') { g.fillStyle = 'rgba(255,40,40,0.8)'; for (var cl = 4; cl < 60; cl += 2) g.fillRect(Math.round(x + Math.cos(a.face) * cl), Math.round(y - 6 + Math.sin(a.face) * cl), 1, 1); }
      if ((a.hostile || a.armed || a.follow) && (a.hp < a.maxHp || a.boss || a.elite)) pxBar(g, x, y - 27, a.boss ? 24 : 12, a.hp / a.maxHp, a.follow ? '#7dffa0' : '#e04848');
      if (a.boss || a.elite) labels.push({ x: a.x, y: a.y - 1.95, text: a.name, col: a.boss ? '#ffd76a' : '#ffc94a' });
      if (a.npc) {
        var mark = '', q = Quests.waitingOn(a);
        if (q && q.stage === 'return' && q.returnKey === a.key) mark = '?';
        else if (!q && (a.role === 'elder' || a.role === 'spymaster' || a.role === 'scholar' || a.role === 'stranger' || (a.role === 'royal' && (G.stage === 'prologue' || G.stage === 'quest' || G.stage === 'won')))) {
          if (a.offerVer !== G.ver) { a.offerVer = G.ver; a.hasOffer = a.role === 'stranger' || (a.role === 'royal' && G.stage === 'prologue') || Quests.offersFor(a).length > 0; }
          if (a.hasOffer) mark = '!';
        }
        if (mark) pxMark(g, x, y - 34 + Math.round(Math.sin(G.time * 4)), mark, mark === '?' ? '#7df0ff' : '#ffd23c');
      }
    });
    // arrows, shot and steel, in the same pixels as everything else
    G.projectiles.forEach(function (pr) { PX.drawProjectile(g, pr, box + pr.x * PT2, boy + pr.y * PT2); });
    G.effects.forEach(function (e) { if (e.type !== 'num') PX.drawEffect(g, e, box + e.x * PT2, boy + e.y * PT2, box + p.x * PT2, boy + p.y * PT2); });
    PX.ambient(g, { s: s, ver: G.ver, time: G.time, month: G.month, box: box, boy: boy, bw: bw, bh: bh });
    // the world, twice as large, with crisp pixels
    ctx.drawImage(pxBuf, 0, 0, bw, bh, 0, 0, bw * 2, bh * 2);
    return { ox: box * 2, oy: boy * 2 };
  }
  /** Camps, ruins, granaries, wells and the old stones, as pixel sprites. */
  function drawPixelThing(g, a, x, y) {
    if (a.deco && a.kind !== 'ruins' && a.kind !== 'tent') { PX.drawFire(g, x, y, G.time); return; }
    var sp = PX.objectSprite(a.role === 'stele' ? 'stele' : a.kind);
    if (!sp) return;
    var X = Math.round(x - sp.width / 2), Y = Math.round(y - sp.height + 1);
    PX.shadow(g, x, y, Math.round(sp.width / 2.4));
    if (a.flash > 0) g.filter = 'brightness(2.2)';
    g.drawImage(sp, X, Y);
    g.filter = 'none';
    if (a.role === 'stele') { g.fillStyle = 'rgba(255,220,120,' + (0.14 + Math.sin(G.time * 2) * 0.06) + ')'; g.fillRect(X - 3, Y - 2, sp.width + 6, sp.height + 2); }
    if (a.obj && a.hp < a.maxHp) {
      var burn = 1 - a.hp / a.maxHp;
      for (var k = 0; k < 3 + Math.round(burn * 5); k++) { g.fillStyle = ['#ff9a3c', '#ffd23c', '#ff5a2c'][k % 3]; g.fillRect(Math.round(x - 6 + ((k * 37 + Math.floor(G.time * 14)) % 12)), Math.round(Y - 1 - ((k * 13 + Math.floor(G.time * 20)) % 6)), 2, 2); }
      pxBar(g, x, Y - 6, 14, a.hp / a.maxHp, '#e04848');
    }
  }
  function drawPixelPlayer(g, p, x, y) {
    if (p.mounted) PX.drawHorse(g, x, y, p.face, p.walkT, p.moving);
    // which way you face, on the ground
    g.fillStyle = 'rgba(255,255,255,0.6)';
    for (var k = 0; k < 3; k++) g.fillRect(Math.round(x + Math.cos(p.face) * (8 + k)), Math.round(y + Math.sin(p.face) * (8 + k) * 0.6), 1, 1);
    var flash = p.inv > 0 && p.hurt > 0 && Math.sin(G.time * 40) > 0;
    if (flash) g.filter = 'brightness(2.4)';
    var row = PX.drawCharacter(g, playerSpec(p), p.face, p.walkT, p.moving || p.rollT > 0, x, y - (p.mounted ? 7 : 0), p.rollT > 0 ? 0.6 : null);
    g.filter = 'none';
    var w = p.bowT > 0 || G.keys.k ? p.eq.ranged.w : p.eq.melee.w;
    PX.drawWeapon(g, w, row, x, y - (p.mounted ? 7 : 0), p.swingT > 0);
    if (G.stage === 'quest' || G.stage === 'won') {
      var h = G.oracle ? G.oracle.hum(Math.floor(p.x / P), Math.floor(p.y / P), G.year) : null;
      g.fillStyle = h ? (h.level === 3 ? '#bff' : h.level === 2 ? '#7cd' : '#5ab') : '#d8b25a';
      g.fillRect(Math.round(x + 3), Math.round(y - 8 - (p.mounted ? 7 : 0)), 2, 2);
      if (h && Math.sin(G.time * (4 + h.level * 4)) > 0) { g.fillStyle = 'rgba(160,240,255,0.5)'; g.fillRect(Math.round(x + 2), Math.round(y - 9 - (p.mounted ? 7 : 0)), 4, 4); }
    }
  }

  function drawSpeech(ox, oy) {
    var p = G.player;
    ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center';
    G.actors.forEach(function (a) {
      if (!a.say || Math.hypot(a.x - p.x, a.y - p.y) > 7) return;
      var words = a.say.text.split(' '), lines = [], cur = '';
      words.forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > 210 && cur) { lines.push(cur); cur = w; } else cur = t; });
      if (cur) lines.push(cur);
      var wmax = 0; lines.forEach(function (l) { wmax = Math.max(wmax, ctx.measureText(l).width); });
      var bw = wmax + 16, bh = lines.length * 15 + 8, x = ox + a.x * TS, y = oy + a.y * TS - 62 - bh, al = Math.min(1, a.say.t * 2);
      ctx.globalAlpha = al;
      ctx.fillStyle = 'rgba(251,248,240,0.96)'; ctx.strokeStyle = '#18121e'; ctx.lineWidth = 2;
      roundRect(x - bw / 2, y, bw, bh, 4); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 5, y + bh); ctx.lineTo(x, y + bh + 7); ctx.lineTo(x + 5, y + bh); ctx.fillStyle = 'rgba(251,248,240,0.96)'; ctx.fill();
      ctx.fillStyle = '#2a2430';
      lines.forEach(function (l, i) { ctx.fillText(l, x, y + 16 + i * 15); });
      ctx.globalAlpha = 1;
    });
    ctx.textAlign = 'left';
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  /** Damage numbers float up at full resolution; every other effect is pixel art. */
  function drawEffect(e, ox, oy) {
    if (e.type !== 'num') return;
    var x = ox + e.x * TS, y = oy + e.y * TS, f = e.t / e.life;
    ctx.font = '700 14px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,' + (1 - f) + ')'; ctx.fillText(e.text, x + 1, y - f * 24 - 19);
    ctx.globalAlpha = 1 - f; ctx.fillStyle = e.color; ctx.fillText(e.text, x, y - f * 24 - 20); ctx.globalAlpha = 1; ctx.textAlign = 'left';
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
    var amL = p.eq.ranged.none ? 'nothing' : Gear.AMMO[p.eq.ranged.ammo].label, sus = p.suspicion || 0, susL = Gear.suspicionLabel(sus);
    $('h-items').innerHTML = '<span title="' + esc(p.eq.ranged.name) + ' · ' + amL + '">' + (p.eq.ranged.gun ? '⁍ ' : '➶ ') + Gear.ammoOf(p) + '</span><span title="Potions (Q)">⚱ ' + p.potions + '</span><span title="Silver">◉ ' + p.silver + '</span>' + (p.knowledge ? '<span title="Knowledge you carry">✎ ' + p.knowledge.tech + '</span>' : '');
    var dr = Gear.dressInfo(provOf(p.x, p.y));
    $('h-dress').textContent = 'Dressed in ' + Gear.lower(p.eq.clothes) + ' · ' + (Gear.localAge(provOf(p.x, p.y)) < 0 ? 'no one to see' : 'you look ' + dr.label);
    $('h-dress').className = 'gearline' + (dr.price >= 1.5 ? ' bad' : dr.price > 1 ? ' warnc' : '');
    $('h-gear').textContent = p.eq.melee.name + ' · ' + p.eq.ranged.name + ' · ' + p.eq.armor.name + (p.concealed && p.concealed.length ? ' · hidden: ' + p.concealed.map(function (it) { return it.name; }).join(', ') : '');
    $('h-sus').hidden = sus < 1;
    $('h-sus').className = 'sus' + (sus >= Gear.HUNT ? ' hunt' : sus >= Gear.SUSPECT ? ' warn' : '');
    $('h-sus').innerHTML = '<span>Suspicion' + (susL ? ': ' + susL : '') + '</span><div class="bar sb"><div style="width:' + sus + '%"></div></div>';
    var strain = p.strain || 0;
    $('h-strain').hidden = strain < 0.5;
    $('h-strain').className = 'strain' + (strain > 70 ? ' hot' : '');
    $('h-strain').innerHTML = '<span>Chronoscope strain</span><div class="bar sb"><div style="width:' + strain + '%"></div></div>';
    $('h-year').textContent = 'Year ' + G.year;
    $('h-month').textContent = MONTHS[G.month];
    var pi = provOf(p.x, p.y), c = s.owner[pi], t = s.terrain[pi];
    var place = !Sim.isLand(t) ? 'Open sea' : c >= 0 ? (s.pop[pi] > 0 ? (L.isCapital(s, pi) ? 'Capital of the ' : 'Village of the ') : 'Lands of the ') + civName(s.cSig[c]) : 'Wilderness';
    var relTxt = '', relCls = '';
    if (c >= 0 && G.home) {
      var rsig = s.cSig[c], rr = relation(G.home.sig, rsig), st = standingOf(rsig);
      relTxt = rsig === G.home.sig ? 'your people' : rr === 'war' ? 'at war with your people' : rr === 'kin' ? 'kin of your people' : rr === 'friendly' ? 'friends of your people' : rr === 'uneasy' ? 'uneasy neighbours' : 'at peace';
      if (rsig !== G.home.sig && st <= -30) relTxt += ', and they hate you';
      else if (rsig !== G.home.sig && st >= 30) relTxt += ', and they like you';
      relCls = hostileToPlayer(rsig) ? 'bad' : friendlyToPlayer(rsig) ? 'good' : '';
    }
    $('h-place').innerHTML = esc(place) + ' · ' + Sim.TERRAIN_NAMES[t] + ' (' + (pi % W) + ', ' + ((pi / W) | 0) + ')' + (relTxt ? '<br><span class="rel ' + relCls + '">' + esc(relTxt) + '</span>' : '');
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
      return '<div class="obj' + (o.main ? ' main' : '') + (o.dormant ? ' dormant' : '') + '"><span class="dot"></span><div><div>' + esc(o.text) + '</div>' + (o.q ? '<div class="qt">' + esc(o.q.title) + '</div>' : '') +
        (o.pi >= 0 ? '<div class="dir">' + (o.pi === ppi ? 'here' : dirName(o.pi % W - ppi % W, ((o.pi / W) | 0) - ((ppi / W) | 0)) + ' · ' + md(o.pi, ppi) + ' prov') + '</div>' : '') + '</div></div>';
    }).join('');
    $('k-potion').textContent = p.potions;
    $('k-arrows').textContent = Gear.ammoOf(p);
    $('k-ranged').textContent = p.eq.ranged.none ? 'Nothing' : p.eq.ranged.gun ? 'Gun' : p.eq.ranged.w === 'sling' ? 'Sling' : p.eq.ranged.w === 'crossbow' ? 'Crossbow' : 'Bow';
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

  function openPanel(id, opts) {
    closePanels();
    G.panel = id;
    $(id).hidden = false;
    G.keys = {};
    if (id === 'scope') openScope(opts);
    if (id === 'journal') renderJournal();
    if (id === 'inv') { G.invSel = 0; renderInv(); }
    if (id === 'travel') openTravel();
  }
  function closePanels() { ['scope', 'journal', 'help', 'inv', 'travel'].forEach(function (id) { $(id).hidden = true; }); G.panel = null; }
  function renderInv() {
    var r = Gear.renderInventory(G.invSel);
    G.invSel = r.sel;
    $('inv-body').innerHTML = r.html;
    Array.prototype.forEach.call($('inv-body').querySelectorAll('.inv-row'), function (el) {
      el.onclick = function () { G.invSel = +el.getAttribute('data-i'); invUse('use'); };
    });
    var cur = $('inv-body').querySelector('.inv-row.sel');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function invUse(action) {
    var msg = Gear.invAction(G.invSel, action);
    if (msg) toast(msg);
    renderInv();
  }

  function realmsHTML() {
    var s = G.s, hc = homeCiv();
    if (!G.home) return '';
    var rows = [], seen = {};
    function add(sig) {
      if (seen[sig] || sig === G.home.sig || civIdx(sig) < 0) return;
      seen[sig] = 1;
      var r = relation(G.home.sig, sig), st = standingOf(sig);
      rows.push('<li><b>' + esc(civName(sig)) + '</b>: ' + REL_TEXT[r].replace(/ (with|to|of)$/, '') + (r === 'war' ? ' with your people' : '') +
        ' · your standing ' + (st > 0 ? '+' : '') + st + (hostileToPlayer(sig) ? ' <span class="bad">(hostile to you)</span>' : friendlyToPlayer(sig) ? ' <span class="good">(friendly)</span>' : '') + '</li>');
    }
    warsOf(G.home.sig).forEach(add);
    if (hc >= 0) Story.survey(s, hc).neighbours.forEach(function (n) { add(n.sig); });
    Object.keys(G.standing).map(Number).forEach(add);
    return '<h3>Realms (in ' + G.year + ')</h3><ul class="deeds">' + (rows.join('') || '<li class="muted">Your people have no neighbours to speak of.</li>') + '</ul>' +
      '<p class="muted">Wars come from the history itself: who took land from whom in the last 20 years (or is massing to). Change history and they change.</p>';
  }
  function renderJournal() {
    var h = '<h3>Quests</h3>';
    h += G.quests.length ? G.quests.map(function (q) {
      var o = Quests.objectives().filter(function (x) { return x.q === q; })[0];
      return '<div class="jq"><b>' + esc(q.title) + '</b> <span class="muted">from ' + esc(q.giverName) + ', ' + q.year + '</span><div>' + (o ? esc(o.text) : '') + '</div></div>';
    }).join('') : '<p class="muted">No quests. Look for <b style="color:#ffd23c">!</b> over elders in villages.</p>';
    h += '<h3>Your deeds in this timeline</h3>';
    var mine = G.cur.interventions;
    h += G.deeds.length ? '<ul class="deeds">' + G.deeds.slice().reverse().map(function (d) { return '<li><span class="t">' + d.year + '</span> <b>' + DEED_NAMES[d.type] + '</b> ' + esc(d.why ? '(' + d.why + ')' : '') + '<div class="muted">' + d.msg + '</div></li>'; }).join('') + '</ul>' : '<p class="muted">None yet. Every quest you finish becomes a deed.</p>';
    h += realmsHTML();
    h += '<p class="muted">Renown among the ' + esc(G.home.name) + ': <b>' + G.renown + '</b> (quests done for your own people).</p>';
    h += '<p class="muted">This timeline holds ' + mine.length + ' recorded deed' + (mine.length === 1 ? '' : 's') + ' in all (including earlier lives).</p>';
    h += '<h3>Chronicle of your lives</h3><ul class="log">' + G.log.slice().reverse().slice(0, 80).map(function (l) { return '<li><span class="t">' + l.year + '</span> ' + l.html + '</li>'; }).join('') + '</ul>';
    $('journal-body').innerHTML = h;
  }

  // ---- The Chronoscope ----
  var scope = { year: START, view: null, rootView: null, pending: false, compare: false, playing: false, playTo: 0 };
  function scopeUnlocked() { return G.stage === 'quest' || G.stage === 'won'; }
  function openScope(opts) {
    opts = opts || {};
    scope.year = opts.year != null ? clamp(opts.year, 1, HORIZON - 1) : G.year;
    scope.compare = !!opts.compare;
    scope.playing = !!opts.play;
    scope.playTo = opts.playTo || Math.min(HORIZON - 1, (G.goal ? G.goal.target : G.year + 150) + 30);
    var r = $('scope-year');
    r.min = 1; r.max = HORIZON - 1; r.value = scope.year;
    renderScope();
  }
  function renderScope() {
    if (!scope.view) scope.view = new Timeline.View(G.world);
    $('scope-label').textContent = 'Year ' + scope.year + (scope.year === G.year ? ' (now)' : scope.year < G.year ? ' (' + (G.year - scope.year) + ' years ago)' : ' (' + (scope.year - G.year) + ' years ahead)');
    $('scope-go').textContent = scope.year === G.year ? 'You are here' : 'Travel to ' + scope.year;
    $('scope-go').disabled = scope.year === G.year;
    $('scope-map').hidden = scope.compare;
    $('scope-cmp').hidden = !scope.compare;
    $('scope-legend').hidden = scope.compare;
    if (scope.compare) drawCompare(); else drawScopeMap();
    drawScopeChart();
    renderScopeText();
  }

  // ---- Travel: the long road, paid for in months of your life ----
  var trav = { x: 0, y: 0, mass: null, massVer: -1 };
  /** Landmasses (provinces joined by land), to know when the road needs a sea passage. */
  function landmass() {
    if (trav.massVer === G.ver && trav.mass) return trav.mass;
    var s = G.s, m = new Int32Array(N).fill(-1), id = 0, q = new Int32Array(N);
    for (var i = 0; i < N; i++) {
      if (m[i] >= 0 || !Sim.isLand(s.terrain[i])) continue;
      var h = 0, t = 0; q[t++] = i; m[i] = id;
      while (h < t) { var c = q[h++]; for (var d = 0; d < 4; d++) { var n = NB[c * 4 + d]; if (n >= 0 && m[n] < 0 && Sim.isLand(s.terrain[n])) { m[n] = id; q[t++] = n; } } }
      id++;
    }
    trav.mass = m; trav.massVer = G.ver;
    return m;
  }
  function travelCost(to) {
    var p = G.player, from = provOf(p.x, p.y), dist = md(from, to), m = landmass();
    var sea = m[from] < 0 || m[to] !== m[from];
    var months = Math.max(1, Math.ceil(dist / (p.horse ? 2 : 1))) + (sea ? 4 : 0);
    return { dist: dist, months: months, sea: sea };
  }
  function travelDests() {
    var out = [], seen = {}, hc = homeCiv(), ppi = provOf(G.player.x, G.player.y);
    function add(pi, label) { if (pi < 0 || seen[pi] || pi === ppi) return; seen[pi] = 1; out.push({ pi: pi, label: label }); }
    if (hc >= 0) add(G.s.cCap[hc], 'Capital of the ' + civName(G.s.cSig[hc]));
    objectiveList().forEach(function (o) { if (o.pi >= 0) add(o.pi, o.text); });
    if (G.home) add(G.home.birth, 'Where you were born');
    return out.slice(0, 9);
  }
  function openTravel() {
    var ppi = provOf(G.player.x, G.player.y);
    trav.x = ppi % W; trav.y = (ppi / W) | 0;
    renderTravel();
  }
  function renderTravel() {
    var cv = $('travel-map'), sc = 4, s = G.s, hs = G.home ? G.home.sig : 0;
    paintWorld(cv, s, null, hs);
    var g = cv.getContext('2d'), p = G.player, ppi = provOf(p.x, p.y), dests = travelDests();
    g.font = '700 11px system-ui, sans-serif';
    dests.forEach(function (d, i) {
      var x = (d.pi % W) * sc + 2, y = ((d.pi / W) | 0) * sc + 2;
      g.fillStyle = '#7df0ff'; g.strokeStyle = '#000'; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.fillText(String(i + 1), x + 5, y - 3);
    });
    G.deeds.forEach(function (d) { if (G.cur.interventions.indexOf(d.iv) < 0) return; g.fillStyle = 'rgba(255,220,120,0.9)'; g.fillRect((d.pi % W) * sc + 1, ((d.pi / W) | 0) * sc + 1, 2, 2); });
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(p.x / P * sc, p.y / P * sc, 4, 0, 7); g.fill(); g.stroke();
    var to = trav.y * W + trav.x, cx = trav.x * sc + 2, cy = trav.y * sc + 2;
    g.strokeStyle = '#ffd23c'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - 9, cy); g.lineTo(cx - 4, cy); g.moveTo(cx + 4, cy); g.lineTo(cx + 9, cy); g.moveTo(cx, cy - 9); g.lineTo(cx, cy - 4); g.moveTo(cx, cy + 4); g.lineTo(cx, cy + 9); g.stroke();
    g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,210,60,0.6)'; g.beginPath(); g.moveTo(p.x / P * sc, p.y / P * sc); g.lineTo(cx, cy); g.stroke(); g.setLineDash([]);
    // info
    var c = s.owner[to], land = Sim.isLand(s.terrain[to]), h = '';
    h += '<div class="sline"><span class="lbl">Destination</span> ' + (land ? (c >= 0 ? (s.pop[to] > 0 ? 'a village of the ' : 'lands of the ') + esc(civName(s.cSig[c])) : 'wilderness') + ' · ' + Sim.TERRAIN_NAMES[s.terrain[to]] : 'the sea') + ' (' + trav.x + ', ' + trav.y + ')</div>';
    if (c >= 0 && G.home && s.cSig[c] !== G.home.sig) h += '<div class="sline ' + (hostileToPlayer(s.cSig[c]) ? 'bad' : '') + '"><span class="lbl">Realm</span> ' + esc(REL_TEXT[relation(G.home.sig, s.cSig[c])] || '') + ' your people' + (hostileToPlayer(s.cSig[c]) ? ': their soldiers will attack you' : '') + '</div>';
    if (land && to !== ppi) {
      var cost = travelCost(to), y = G.year, mo = G.month + cost.months;
      y += Math.floor(mo / 12); mo = mo % 12;
      h += '<div class="sline"><span class="lbl">The road</span> ' + cost.dist + ' provinces ' + (p.horse ? 'on horseback' : 'on foot') + (cost.sea ? ', with a sea passage' : '') + ': <b>' + cost.months + ' month' + (cost.months > 1 ? 's' : '') + '</b> of your life</div>';
      h += '<div class="sline"><span class="lbl">Arrive</span> ' + MONTHS[mo] + ' of ' + Math.min(y, HORIZON - 1) + ', aged ' + (G.player.age + Math.floor((G.month + cost.months) / 12)) + '</div>';
    }
    h += '<div class="lbl" style="margin-top:8px">Places</div>' + dests.map(function (d, i) {
      var cc = travelCost(d.pi);
      return '<button class="thread dest" data-pi="' + d.pi + '"><span class="kk">' + (i + 1) + '</span> ' + esc(d.label) + ' <span class="muted">· ' + cc.months + ' mo</span></button>';
    }).join('');
    h += '<p class="muted small">↑↓←→ / WASD move (Shift ×5) · 1–9 jump to a place · Enter set out · M or Esc close.' + (p.horse ? '' : ' A horse halves the time.') + '</p>';
    $('travel-text').innerHTML = h;
    Array.prototype.forEach.call($('travel-text').querySelectorAll('.dest'), function (b) {
      b.onclick = function () { var pi = +b.getAttribute('data-pi'); trav.x = pi % W; trav.y = (pi / W) | 0; renderTravel(); };
    });
  }
  function journey() {
    var p = G.player, to = trav.y * W + trav.x, s = G.s;
    if (!Sim.isLand(s.terrain[to])) { toast('You cannot settle down in the middle of the sea.'); return; }
    if (to === provOf(p.x, p.y)) { closePanels(); return; }
    if (G.actors.some(function (a) { return a.hostile && a.state !== 'idle' && a.state !== 'return' && Math.hypot(a.x - p.x, a.y - p.y) < 12; })) { toast('Not with enemies on your heels.'); return; }
    var cost = travelCost(to), fl = G.actors.filter(function (a) { return a.follow; });
    closePanels();
    passMonths(cost.months);
    if (p.dead || G.player !== p) return;        // the road was long enough to end a life
    var f = findFree(to, C + 1, C + 1) || provCenter(to);
    p.x = f.x; p.y = f.y; G.cam.x = p.x; G.cam.y = p.y;
    G.actors = G.actors.filter(function (a) { return a.follow; });
    fl.forEach(function (a, i) { a.x = p.x + (i - 1) * 0.9; a.y = p.y + 1; a.prov = to; });
    G.pickups = []; G.projectiles = []; G.hist = []; G.trail = [];
    for (var key in G.active) Quests.despawned(+key);
    G.active = {}; G.lastProv = -1;
    manageActive();
    G.flash = 0.3;
    toast('After ' + cost.months + ' month' + (cost.months > 1 ? 's' : '') + ' on the road' + (cost.sea ? ' and a sea passage' : '') + ', you arrive. It is ' + MONTHS[G.month] + ' of ' + G.year + '.', 6000);
    autosave();
  }

  // ---- Compare: the world without you beside your world ----
  var TER_RGB2 = [[29, 58, 92], [44, 90, 132], [125, 150, 86], [79, 116, 72], [138, 124, 88], [154, 150, 142], [205, 184, 134]];
  function paintWorld(cv, s, other, hs) {
    var g = cv.getContext('2d'), img = g.createImageData(W, H), d = img.data;
    for (var i = 0; i < N; i++) {
      var c = s.owner[i], rgb = c >= 0 ? L.civRGB(s.cSig[c]) : TER_RGB2[s.terrain[i]];
      var diff = other && (c >= 0 ? s.cSig[c] : 0) !== (other.owner[i] >= 0 ? other.cSig[other.owner[i]] : 0);
      if (c >= 0 && s.cSig[c] !== hs && !diff) rgb = [rgb[0] * 0.55 + 45, rgb[1] * 0.55 + 45, rgb[2] * 0.55 + 45];
      d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255;
    }
    var tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(tmp, 0, 0, cv.width, cv.height);
    var sc = cv.width / W;
    // your people outlined in gold; provinces ruled differently in the other history outlined in white
    for (var j = 0; j < N; j++) {
      var cj = s.owner[j], x = (j % W) * sc, y = ((j / W) | 0) * sc;
      if (cj >= 0 && s.cSig[cj] === hs) {
        for (var k = 0; k < 4; k++) {
          var n = NB[j * 4 + k];
          if (n >= 0 && s.owner[n] === cj) continue;
          g.fillStyle = '#ffd23c';
          if (k === 0) g.fillRect(x, y, sc, 1); if (k === 1) g.fillRect(x + sc - 1, y, 1, sc); if (k === 2) g.fillRect(x, y + sc - 1, sc, 1); if (k === 3) g.fillRect(x, y, 1, sc);
        }
      }
      if (other && Sim.isLand(s.terrain[j]) && (cj >= 0 ? s.cSig[cj] : 0) !== (other.owner[j] >= 0 ? other.cSig[other.owner[j]] : 0)) {
        g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x + sc * 0.3, y + sc * 0.3, sc * 0.4, sc * 0.4);
      }
    }
  }
  function drawCompare() {
    if (!scope.rootView) scope.rootView = new Timeline.View(G.world);
    var a = scope.rootView.seek(G.world.root, scope.year), b = scope.view.seek(G.cur, scope.year), hs = G.home.sig;
    paintWorld($('cmp-a'), a, null, hs);
    paintWorld($('cmp-b'), b, a, hs);
    $('cmp-sum').innerHTML = compareSummary(a, b);
  }
  function realmList(s) {
    var out = {};
    for (var c = 0; c < s.g[1]; c++) if (s.cAlive[c] && s.sTiles[c] >= 3) out[s.cSig[c]] = { tiles: s.sTiles[c], pop: s.sPop[c] };
    return out;
  }
  /** What is different at scope.year between the world without you (a) and yours (b). */
  function compareSummary(a, b) {
    var imp = Timeline.impact(a, b), ra = realmList(a), rb = realmList(b), hs = G.home.sig, popA = 0, popB = 0;
    for (var i = 0; i < N; i++) { popA += a.pop[i]; popB += b.pop[i]; }
    var onlyB = Object.keys(rb).filter(function (k) { return !ra[k]; }).sort(function (x, y) { return rb[y].tiles - rb[x].tiles; });
    var onlyA = Object.keys(ra).filter(function (k) { return !rb[k]; }).sort(function (x, y) { return ra[y].tiles - ra[x].tiles; });
    var mine = rb[hs], theirs = ra[hs];
    function names(list, src) { return list.slice(0, 4).map(function (k) { return '<b>' + esc(civName(+k)) + '</b> (' + src[k].tiles + ')'; }).join(', ') + (list.length > 4 ? ' and ' + (list.length - 4) + ' more' : ''); }
    var h = '<div class="cmp-year">In ' + scope.year + '</div>';
    h += '<div><span class="lbl">Your people</span> ' + (mine ? mine.tiles + ' provinces, ' + fmtPop(mine.pop) + ' people' : '<span class="bad">gone</span>') + ' · without you: ' + (theirs ? theirs.tiles + ' provinces' : '<span class="bad">gone</span>') + '</div>';
    var differ = 0;
    for (var j = 0; j < N; j++) if (Sim.isLand(b.terrain[j]) && (a.owner[j] >= 0 ? a.cSig[a.owner[j]] : 0) !== (b.owner[j] >= 0 ? b.cSig[b.owner[j]] : 0)) differ++;
    h += '<div><span class="lbl">Lands</span> ' + differ + ' provinces ruled by someone else (' + Math.round(imp.owners * 100) + '% of the world)</div>';
    h += '<div><span class="lbl">People</span> ' + fmtPop(popB) + ' alive, ' + (popB >= popA ? '<span class="good">' + fmtPop(popB - popA) + ' more</span>' : '<span class="bad">' + fmtPop(popA - popB) + ' fewer</span>') + ' than without you</div>';
    if (onlyB.length) h += '<div><span class="lbl">Only in yours</span> ' + names(onlyB, rb) + '</div>';
    if (onlyA.length) h += '<div><span class="lbl">Never were</span> ' + names(onlyA, ra) + '</div>';
    return h;
  }
  function scopeTick() {
    if (G.panel !== 'scope' || !scope.playing) return;
    scope.frameN = (scope.frameN || 0) + 1;
    if (scope.frameN % 2) return;
    scope.year = Math.min(scope.playTo, scope.year + 1);
    $('scope-year').value = scope.year;
    renderScope();
    if (scope.year >= scope.playTo) scope.playing = false;
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
  function takeEcho(i) {
    var ec = scope.echoes && scope.echoes[i];
    if (!ec) return;
    if (G.quests.length >= 6) { toast('You carry too many threads already (6 quests).'); return; }
    var q = Quests.takeEcho(ec);
    scope.year = clamp(ec.y0, 1, HORIZON - 1);
    $('scope-year').value = scope.year;
    toast('You take up the thread: <b>' + esc(q.title) + '</b>. Press Enter to travel to ' + scope.year + '.', 7000);
    renderScope();
  }
  function renderScopeText() {
    var f = curFate(), base = readFate(G.world.root), h = '';
    h += '<div class="sline"><span class="lbl">This timeline</span> ' + esc(G.cur.parent < 0 ? 'The world without you' : G.cur.name) + ' · ' + G.cur.interventions.length + ' deed' + (G.cur.interventions.length === 1 ? '' : 's') + '</div>';
    h += '<div class="sline ' + (saved(f) ? 'good' : 'bad') + '"><span class="lbl">Your people</span> ' + fateText(f) + '</div>';
    h += '<div class="sline muted"><span class="lbl">Without you</span> ' + fateText(base) + '</div>';
    if (G.goal) h += '<div class="sline"><span class="lbl">Goal</span> hold land in <b>' + G.goal.target + '</b></div>';
    // your quests across time, and the way back
    if (G.leftFrom || G.quests.length) {
      h += '<div class="threads"><div class="lbl">Your quests across time</div>';
      if (G.leftFrom && G.leftFrom.year !== G.year) h += '<div class="qline back"><b>B</b> back to <b>' + G.leftFrom.year + '</b>, where you left</div>';
      G.quests.forEach(function (q) {
        var w = Quests.windowOf(q), here = Quests.inWindow(q);
        h += '<div class="qline' + (here ? ' here' : '') + '">' + esc(q.title) + ' · <b>' + (w ? w.y0 + (w.y1 !== w.y0 ? '–' + w.y1 : '') : 'any year') + '</b> · ' +
          (here ? (q.stage === 'return' ? 'ready to turn in, now' : 'now') : (q.stage === 'return' ? 'ready to turn in, travel back' : 'travel back')) + '</div>';
      });
      h += '<div class="muted">[ and ] jump between these years; Enter travels.</div></div>';
    }
    // echoes first: turning points of this timeline you could stand in (they include the Oracle's threads of fate)
    scope.echoes = G.world.isComplete(G.cur) ? Quests.echoes() : [];
    var dif = G.oracle && G.oracle.done ? G.oracle.difficulty() : null;
    if (scope.echoes.length) {
      h += '<div class="threads"><div class="lbl">Echoes of this timeline</div><div class="muted">Moments you could stand in. Press a number to take one up; it stays with you through time.' + (dif ? ' ' + dif.label + '.' : '') + '</div>' +
        scope.echoes.map(function (e, i) {
          return '<button class="thread echo' + (e.kind === 'thread' ? ' fated' : '') + '" data-echo="' + i + '"><span class="kk">' + (i + 1) + '</span> <b>' + esc(e.title) + '</b><br><span class="muted">' + esc(e.text) + '</span></button>';
        }).join('') + '</div>';
    } else if (G.stage === 'quest' && !(G.oracle && G.oracle.done)) h += '<div class="muted" style="margin:6px 0">The Chronoscope is still reading this timeline' + (G.oracle ? ' (' + Math.round(G.oracle.progress() * 100) + '%)' : '') + '…</div>';
    else if (dif) h += '<div class="muted" style="margin:6px 0">' + dif.label + '.</div>';
    if (f.state === 'falls' && G.world.isComplete(G.cur)) {
      var key = G.cur.id + ':' + G.cur.version;
      if (!scope.whyKey || scope.whyKey !== key) { scope.whyKey = key; scope.why = Story.whyFall(G.cur, G.home.sig, f.end, null); }
      var w = scope.why;
      if (w && w.verdict) h += '<div class="why"><b>Why they fall:</b> ' + w.verdict + (w.advice && w.advice[0] ? '<div class="advice">' + w.advice[0] + '</div>' : '') + '</div>';
    }
    // chronicle around the selected year
    var evs = G.cur.events.filter(function (e) { return Math.abs(e.t - scope.year) <= 15 && (e.major || e.a === G.home.sig || e.b === G.home.sig || (G.goal && (e.a === G.goal.foeSig || e.b === G.goal.foeSig))); }).slice(-8);
    if (evs.length) h += '<div class="lbl" style="margin-top:8px">Around ' + scope.year + '</div><ul class="log">' + evs.map(function (e) { return '<li><span class="t">' + e.t + '</span> ' + esc(e.text) + '</li>'; }).join('') + '</ul>';
    $('scope-text').innerHTML = h;
    Array.prototype.forEach.call($('scope-text').querySelectorAll('.echo'), function (b) {
      b.onclick = function () { takeEcho(+b.getAttribute('data-echo')); };
    });
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  function bindInput() {
    window.addEventListener('keydown', function (e) {
      var k = e.key.toLowerCase();
      if (e.target && (e.target.tagName === 'INPUT' && e.target.type === 'text')) return;
      if (G.stage === 'loading') return;
      if (G.stage === 'title' && !G.modal) return;
      if (G.modal) {
        if (e.repeat) return;
        var btns = $('d-actions').querySelectorAll('button');
        if (k === 'enter' || k === 'e' || k === ' ') { e.preventDefault(); if (btns[0]) btns[0].click(); }
        else if (k === 'escape') { if (btns.length) btns[btns.length - 1].click(); }
        else if (/^[1-9]$/.test(k) && btns[+k - 1]) btns[+k - 1].click();
        return;
      }
      if (G.panel) {
        if (k === 'escape' || (k === 't' && G.panel === 'scope') || (k === 'l' && G.panel === 'journal') || (k === 'h' && G.panel === 'help') || (k === 'i' && G.panel === 'inv')) { closePanels(); return; }
        if (G.panel === 'travel') {
          e.preventDefault();
          if (k === 'm') { closePanels(); return; }
          var st = e.shiftKey ? 5 : 1;
          if (k === 'arrowup' || k === 'w') trav.y = clamp(trav.y - st, 0, H - 1);
          else if (k === 'arrowdown' || k === 's') trav.y = clamp(trav.y + st, 0, H - 1);
          else if (k === 'arrowleft' || k === 'a') trav.x = clamp(trav.x - st, 0, W - 1);
          else if (k === 'arrowright' || k === 'd') trav.x = clamp(trav.x + st, 0, W - 1);
          else if (/^[1-9]$/.test(k)) { var dd = travelDests()[+k - 1]; if (dd) { trav.x = dd.pi % W; trav.y = (dd.pi / W) | 0; } }
          else if (k === 'enter' || k === 'e') { journey(); return; }
          renderTravel();
          return;
        }
        if (G.panel === 'inv') {
          e.preventDefault();
          if (k === 'arrowup' || k === 'w') { G.invSel--; renderInv(); }
          else if (k === 'arrowdown' || k === 's') { G.invSel++; renderInv(); }
          else if (k === 'enter' || k === 'e' || k === ' ') invUse('use');
          else if (k === 'x' || k === 'delete') invUse('drop');
          else if (k === 'u') { Gear.toggleConceal(); renderInv(); }
          return;
        }
        if (G.panel === 'scope') {
          var step = e.shiftKey ? 10 : 1;
          if (k === ',' || k === 'arrowleft') { scope.year = Math.max(1, scope.year - step); $('scope-year').value = scope.year; renderScope(); }
          if (k === '.' || k === 'arrowright') { scope.year = Math.min(HORIZON - 1, scope.year + step); $('scope-year').value = scope.year; renderScope(); }
          if (k === 'pageup') { scope.year = Math.max(1, scope.year - 50); $('scope-year').value = scope.year; renderScope(); }
          if (k === 'pagedown') { scope.year = Math.min(HORIZON - 1, scope.year + 50); $('scope-year').value = scope.year; renderScope(); }
          if (k === 'home') { scope.year = G.year; $('scope-year').value = scope.year; renderScope(); }
          if (k === 'v') { scope.compare = !scope.compare; renderScope(); }
          if (k === ' ') { e.preventDefault(); if (!scope.compare) scope.compare = true; scope.playing = !scope.playing; if (scope.playing && scope.year >= scope.playTo) scope.year = Math.max(1, G.year); renderScope(); }
          if (k === 'b' && G.leftFrom) { scope.year = G.leftFrom.year; $('scope-year').value = scope.year; renderScope(); }
          if (k === '[' || k === ']') {
            var ts = G.oracle ? G.oracle.wins().map(function (r) { return r.t; }) : [];
            if (G.goal) ts.push(G.goal.end, G.goal.target);
            if (G.leftFrom) ts.push(G.leftFrom.year);
            G.quests.forEach(function (q) { var w = Quests.windowOf(q); if (w) ts.push(w.y0); });
            ts.sort(function (a, b) { return a - b; });
            var nx = k === ']' ? ts.filter(function (t) { return t > scope.year; })[0] : ts.filter(function (t) { return t < scope.year; }).pop();
            if (nx != null) { scope.year = nx; $('scope-year').value = scope.year; renderScope(); }
          }
          if (k === 'enter') { e.preventDefault(); $('scope-go').click(); }
          if (/^[1-6]$/.test(k)) takeEcho(+k - 1);
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
      else if (k === 'i') openPanel('inv');
      else if (k === 'u') Gear.toggleConceal();
      else if (k === 'g' && !e.repeat) startRewindHold();
      else if (k === 'p' || k === 'escape') pauseMenu();
      else if (k === 'b') toggleMount();
      else if (k === 'm') openPanel('travel');
      else if (k === 'v') {
        if (!scopeUnlocked()) toast('You do not have the Chronoscope yet.');
        else { var from = G.deeds.length ? G.deeds[G.deeds.length - 1].year : G.year; openPanel('scope', { year: Math.max(1, from - 5), compare: true, play: true }); }
      }
      else if (k === 'h' || k === '?') openPanel('help');
    });
    window.addEventListener('keyup', function (e) {
      var k = e.key.toLowerCase();
      G.keys[k] = false;
      if (k === 'g') releaseRewind();
    });
    window.addEventListener('blur', function () { G.keys = {}; G.rewindHold = null; });
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
  // ---------------------------------------------------------------------------
  // Saving and loading
  // ---------------------------------------------------------------------------
  // A timeline is only (world number, deeds), so a save stores the deeds and replays them:
  // the whole of history comes back exactly. The rest is you, your quests and what realms think of you.
  var SAVE_KEY = 'chronoscope-wayfarer:saves', SAVE_VERSION = 1, SLOTS = ['auto', '1', '2', '3'];
  function readSaves() { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function writeSaves(all) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(all)); return true; } catch (e) { return false; } }
  function latestSave() {
    var all = readSaves(), best = null;
    SLOTS.forEach(function (k) { if (all[k] && (!best || all[k].savedAt > best.data.savedAt)) best = { slot: k, data: all[k] }; });
    return best;
  }
  function saveLabel(d) {
    var m = d.meta, ago = Math.round((Date.now() - d.savedAt) / 60000);
    return m.name + ' of the ' + m.realm + ' · year ' + m.year + ' · level ' + m.level + (m.lives > 1 ? ' · bearer #' + m.lives : '') + ' · world ' + d.seed +
      ' (' + (ago < 1 ? 'just now' : ago < 60 ? ago + ' min ago' : ago < 1440 ? Math.round(ago / 60) + ' h ago' : Math.round(ago / 1440) + ' d ago') + ')';
  }
  function snapshotGame() {
    var p = G.player, ivs = G.cur.interventions;
    var pl = {};
    ['name', 'x', 'y', 'face', 'hp', 'level', 'xp', 'potions', 'silver', 'age', 'deathAge', 'lives', 'knowledge', 'eq', 'pack', 'concealed', 'ammo', 'distAcc', 'horse'].forEach(function (k) { pl[k] = p[k]; });
    return {
      v: SAVE_VERSION, savedAt: Date.now(), seed: G.world.seed,
      meta: { name: p.name, lives: p.lives, level: p.level, year: G.year, realm: G.home ? G.home.name : '', deeds: ivs.length, stage: G.stage },
      timeline: { name: G.cur.name, ivs: ivs.map(function (iv) { return { t: iv.t, type: iv.type, x: iv.x, y: iv.y, v: iv.v || 0, note: iv.note || '' }; }) },
      year: G.year, month: G.month, stage: G.stage, home: G.home,
      goal: G.goal ? { end: G.goal.end, target: G.goal.target, foeSig: G.goal.foeSig } : null,
      renown: G.renown, standing: G.standing, leftFrom: G.leftFrom || null, echoesDone: G.echoesDone || [], taughtBy: G.taughtBy || {},
      branchNames: G.branchNames, questsDone: G.questsDone, log: G.log.slice(-200),
      deeds: G.deeds.map(function (d) { var o = {}; for (var k in d) if (k !== 'iv') o[k] = d[k]; o.ivIndex = ivs.indexOf(d.iv); return o; }),
      quests: Quests.exportState(), player: pl
    };
  }
  function saveGame(slot, quiet) {
    if (!G.player || !G.home || G.stage === 'title' || G.stage === 'loading') return false;
    var all = readSaves(), data;
    try { data = snapshotGame(); } catch (e) { if (!quiet) toast('Could not save: ' + esc(e.message)); return false; }
    all[slot] = data;
    var ok = writeSaves(all);
    if (!quiet) toast(ok ? 'Saved to ' + (slot === 'auto' ? 'the autosave' : 'slot ' + slot) + '.' : '<b>Could not save</b>: your browser refused local storage.');
    G.lastSaveT = G.time;
    return ok;
  }
  function autosave() { if (G.time - (G.lastAutoT || -999) > 8) { G.lastAutoT = G.time; saveGame('auto', true); } }

  /** Load: rebuild the world, replay your deeds into it, then put you back. */
  function loadGame(data) {
    closeDialog(); closePanels();
    startWorld(data.seed);
    G.pending = data;
    if (data.timeline.ivs.length) {
      var b = G.world._newBranch(G.world.root, 0, data.timeline.ivs.map(function (iv) { var o = { t: iv.t, type: iv.type, x: iv.x, y: iv.y }; if (iv.v) o.v = iv.v; if (iv.note) o.note = iv.note; return o; }));
      b.name = data.timeline.name;
      G.cur = b;
    }
  }
  function finishLoad() {
    var d = G.pending, p;
    G.pending = null;
    seekYear(d.year);
    G.month = d.month; G.stage = d.stage; G.home = d.home; G.goal = d.goal; G.renown = d.renown || 0; G.standing = d.standing || {};
    G.leftFrom = d.leftFrom; G.echoesDone = d.echoesDone || []; G.taughtBy = d.taughtBy || {}; G.branchNames = d.branchNames || {};
    G.questsDone = d.questsDone || []; G.log = d.log || [];
    G.deeds = (d.deeds || []).map(function (x) { var o = {}; for (var k in x) if (k !== 'ivIndex') o[k] = x[k]; o.iv = x.ivIndex >= 0 ? G.cur.interventions[x.ivIndex] : null; return o; });
    p = newPlayer(d.player.name, d.player.level, d.player.lives);
    for (var k in d.player) p[k] = d.player[k];
    p.dead = false; p.suspicion = 0; p.strain = 0;
    G.player = p;
    G.cam.x = p.x; G.cam.y = p.y;
    resetActors();
    Quests.importState(d.quests || { quests: [] });
    $('loading').hidden = true;
    $('hud').hidden = false;
    toast('Welcome back, <b>' + esc(p.name) + '</b>. It is ' + MONTHS[G.month] + ' of the year ' + G.year + '.', 6000);
  }

  function pauseMenu() {
    var all = readSaves();
    var btns = [];
    ['1', '2', '3'].forEach(function (k) { btns.push({ label: 'Save to slot ' + k + (all[k] ? ' (overwrite)' : ''), fn: function () { saveGame(k); } }); });
    btns.push({ label: 'Load…', fn: function () { loadMenu(true); } });
    btns.push({ label: 'Return to the title (autosaves)', fn: function () { saveGame('auto', true); location.reload(); } });
    btns.push({ label: 'Resume' });
    dialog({ kicker: 'Paused', title: 'The world holds its breath', html:
      SLOTS.map(function (k) { return '<p class="muted"><b>' + (k === 'auto' ? 'Autosave' : 'Slot ' + k) + '</b>: ' + (all[k] ? esc(saveLabel(all[k])) : 'empty') + '</p>'; }).join('') +
      '<p class="muted">The game autosaves after every deed, quest, journey through time and new year.</p>', buttons: btns });
  }
  function loadMenu(inGame) {
    var all = readSaves(), btns = [];
    SLOTS.forEach(function (k) { if (all[k]) btns.push({ label: (k === 'auto' ? 'Autosave' : 'Slot ' + k) + ': ' + saveLabel(all[k]), fn: function () { loadGame(all[k]); } }); });
    btns.push({ label: inGame ? 'Back' : 'Cancel', fn: inGame ? pauseMenu : null });
    dialog({ kicker: 'Load', title: btns.length > 1 ? 'Which life?' : 'No saved games yet', html: '', buttons: btns });
  }

  function todaySeed() { var d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  function startWorld(seed) {
    seed = seed >>> 0;
    G.world = new Timeline.World(seed, { horizon: HORIZON });
    G.cur = G.world.root;
    G.view = new Timeline.View(G.world);
    G.lifeV1 = G.lifeV3 = null; Life.reset();
    scope.view = null;
    L.clearCaches();
    window.Pixel.clearCaches();
    G.stage = 'loading';
    $('title').hidden = true;
    $('loading').hidden = false;
    try { history.replaceState(null, '', '#seed=' + seed); } catch (e) { /* file:// */ }
  }
  function loadingFrame() {
    var target = START + 600;
    if (G.pending) {
      // the world without you first, then your timeline up to the year you were in
      var need = G.pending.year + 1, rootDone = G.world.root.computedTo >= target;
      if (!rootDone) G.world.compute(G.world.root, 40);
      else if (G.cur !== G.world.root) G.world.compute(G.cur, 40);
      var done = rootDone && (G.cur === G.world.root || G.cur.computedTo >= need);
      var prog = (Math.min(G.world.root.computedTo, target) + (G.cur === G.world.root ? need : Math.min(G.cur.computedTo, need))) / (target + need);
      $('load-bar').style.width = Math.min(100, 100 * prog) + '%';
      $('load-text').textContent = !rootDone ? 'The world without you… year ' + G.world.root.computedTo : 'Your deeds ripple through history… year ' + G.cur.computedTo;
      if (done) finishLoad();
      return;
    }
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
    equipNative(G.player, birth);
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
      if (G.rewindHold && (G.modal || G.panel || G.player.dead)) G.rewindHold = null;
      if (!G.modal && !G.panel) update(G.rewindHold ? dt * 0.15 : dt);   // the world crawls while you choose how far back
      else G.time += 0; // the world holds still while you read
      storyFrame();
      render();
      if (G.time - (G.lastAutoT || 0) > 90 && !G.modal) autosave();
      scopeTick();
      G.hudT -= dt;
      if (G.hudT <= 0) { hud(); G.hudT = 0.12; if (G.panel === 'scope' && !G.world.isComplete(G.cur)) renderScopeText(); }
    }
    requestAnimationFrame(frame);
  }

  function init() {
    document.body.classList.add('px');
    Life.init({ G: G, steer: steer, addEffect: addEffect, relation: relation, Gear: Gear, future: futureState, gossip: gossip,
      reply: function (n) { return REPLIES[(n * 7 + Math.floor(G.time)) % REPLIES.length]; } });
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
    var last = latestSave();
    if (last) {
      $('save-row').hidden = false;
      $('btn-continue').innerHTML = 'Continue<span>' + esc(saveLabel(last.data)) + '</span>';
      $('btn-continue').onclick = function () { loadGame(last.data); };
      $('btn-load').onclick = function () { loadMenu(false); };
      $('btn-continue').focus();
    } else $('seed').focus();
    requestAnimationFrame(frame);
  }

  window.RPG = {
    G: G, esc: esc, findFree: findFree, dirText: dirText, homeCiv: homeCiv, foeCiv: foeCiv, rulerName: rulerName, isActive: isActive,
    spawnAt: spawnAt, spawnNear: spawnNear, spawnPickup: spawnPickup, spawnDeco: spawnDeco, applyDeed: applyDeed, toast: toast,
    journal: journal, passMonths: passMonths, dialog: dialog, provCenter: provCenter,
    curFate: function () { return curFate(); },
    giverGone: giverGone, returnPi: returnPi,
    stateAt: function (y) { G.echoView = G.echoView || new Timeline.View(G.world); return G.echoView.seek(G.cur, clamp(y, 0, HORIZON - 1)); }, renown: function () { return G.renown; }, RENOWN_REGICIDE: RENOWN_REGICIDE, level: function () { return G.player.level; }, reward: reward, onQuestDone: onQuestDone, provOf: provOf,
    // for testing and debugging from the console
    debug: { travelCost: travelCost, landmass: landmass, saveGame: saveGame, readSaves: readSaves, loadGame: loadGame, snapshotGame: snapshotGame, travelTo: travelTo, readFate: readFate, gainXp: gainXp, talk: talk, kill: kill, nearestTalker: nearestTalker, curFate: curFate,
      step: function (dt) { update(dt); }, rewind: rewind, rewindAvail: rewindAvail, relation: relation, standingOf: standingOf, roll: roll, drink: drinkPotion, maxHp: function () { return maxHp(G.player); }, KINDS: KINDS, BAL: BAL,
      teleport: function (x, y) { G.player.x = x; G.player.y = y; G.cam.x = x; G.cam.y = y; manageActive(); }, provCenter: provCenter, homeCiv: homeCiv, foeCiv: foeCiv }
  };
  window.addEventListener('DOMContentLoaded', init);
}());
