/*
 * Quests: the action-RPG face of the Chronoscope's deeds.
 *
 * Every quest is generated from the live simulation around the person who
 * gives it (plague next door, an empty valley, a hostile border, a rival's
 * capital), and every quest ends in one or more *deeds*: the same recorded
 * interventions the original Chronoscope uses (rally, irrigate, heal, settle,
 * learn, teach, discord, assassinate). Completing a quest therefore really
 * changes the timeline, and the future is re-simulated from that moment.
 *
 * A quest is a list of encounters. Each encounter lives in one province and
 * is spawned whenever that province is near the player:
 *   { pi, lx, ly, foes: [kinds], objs: [kinds], herbs: [{lx,ly}], faction,
 *     clear: 'all' | 'objs' | 'boss', arrive, waves, deeds, done, label }
 */
(function (root) {
  'use strict';
  var Sim = root.Sim, Story = root.Story, L = root.Local;
  var W = Sim.W, H = Sim.H, NB = Sim.NB, TER = Sim.TER;
  var R = function () { return root.RPG; };

  var DEED_TEXT = {
    irrigate: 'Dig irrigation: soil fertility +12% here and next door',
    rally: 'Rally the people: solidarity +15 points here and next door',
    heal: 'Tend the sick: the plague ends here and next door',
    settle: 'Lead settlers: neighbours move into the empty land, or you found a new people',
    learn: 'Learn: you carry this people\'s knowledge (no change to the world)',
    teach: 'Teach: their whole realm closes half the gap to the knowledge you carry',
    discord: 'Sow discord: solidarity −15 points around the target',
    assassinate: 'Assassinate: a realm-wide succession crisis (solidarity ×0.68)'
  };

  var nextId = 1;
  function esc(t) { return R().esc(t); }
  function G() { return R().G; }
  function md(a, b) { return Math.abs(a % W - b % W) + Math.abs(((a / W) | 0) - ((b / W) | 0)); }
  function isLand(s, pi) { return Sim.isLand(s.terrain[pi]); }
  function hpick(a, b, n) { return Sim.hash4(G().world.seed, a, b, 931) % n; }
  function civName(sig) { return Sim.civName(sig); }

  /** Land provinces within Manhattan distance r of pi, nearest first (ties broken by hash). */
  function around(pi, r, filter) {
    var s = G().s, out = [], x = pi % W, y = (pi / W) | 0;
    for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
      var d = Math.abs(dx) + Math.abs(dy), nx = x + dx, ny = y + dy;
      if (d > r || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var j = ny * W + nx;
      if (!isLand(s, j) || (filter && !filter(j, d))) continue;
      out.push({ pi: j, d: d, h: Sim.hash4(s.seed, j, G().year, 932) });
    }
    out.sort(function (a, b) { return a.d - b.d || a.h - b.h; });
    return out;
  }

  /** A spot for a camp inside province pi, away from the village green. */
  function campSpot(pi) {
    var h = Sim.hash4(G().world.seed, pi, 7, 933), corner = h & 3;
    var lx = corner & 1 ? 8 : 3, ly = corner & 2 ? 8 : 3;
    var f = R().findFree(pi, lx, ly);
    return { lx: f ? f.x - (pi % W) * L.P : lx + 0.5, ly: f ? f.y - ((pi / W) | 0) * L.P : ly + 0.5 };
  }

  function foreignNeighbour(s, j, c) {
    for (var d = 0; d < 4; d++) {
      var n = NB[j * 4 + d];
      if (n >= 0 && s.owner[n] >= 0 && s.owner[n] !== c) return s.owner[n];
    }
    return -1;
  }

  function enc(pi, o) {
    var sp = campSpot(pi);
    var e = { pi: pi, lx: sp.lx, ly: sp.ly, foes: [], objs: [], herbs: [], faction: 0, clear: 'all', arrive: false, waves: null, deeds: [], done: false, label: '' };
    for (var k in o) e[k] = o[k];
    return e;
  }

  function make(kind, o) {
    var q = { id: 0, kind: kind, title: '', story: '', stage: 'offer', enc: [], deeds: [], returnKey: null, returnPi: -1, returnName: '', xp: 40, potions: 0, giverKey: '', giverName: '', year: G().year };
    for (var k in o) q[k] = o[k];
    return q;
  }

  // ---------------------------------------------------------------------------
  // Offers
  // ---------------------------------------------------------------------------
  function warband(s, c, n, captain) {
    var a = c >= 0 ? Sim.ageOf(s.cTech[c]) : 0, out = [];
    for (var k = 0; k < n; k++) out.push(k === 1 && a >= 1 ? 'bowman' : 'soldier');
    if (captain) out.push('captain');
    return out;
  }
  function wild(s, pi) {
    var t = s.terrain[pi];
    return t === TER.DESERT ? 'jackal' : t === TER.MOUNTAIN ? 'bear' : 'wolf';
  }

  function elderOffers(npc) {
    var g = G(), s = g.s, pi = npc.prov, c = s.owner[pi], out = [];
    if (c < 0) return out;
    var sig = s.cSig[c], realm = civName(sig), giver = { giverKey: npc.key, giverName: npc.name, returnKey: npc.key, returnPi: pi, returnName: npc.name };
    var know = g.player.knowledge;
    // plague is always the most urgent
    var sick = s.plague[pi] > 0;
    for (var d = 0; d < 4; d++) { var n = NB[pi * 4 + d]; if (n >= 0 && s.plague[n]) sick = true; }
    if (sick) {
      var spots = around(pi, 2, function (j) { return s.pop[j] === 0 || j === pi; }).slice(0, 3);
      if (!spots.length) spots = [{ pi: pi }];
      var herbs = [];
      for (var k = 0; k < 4; k++) {
        var hp = spots[k % spots.length].pi, sp = R().findFree(hp, 2 + hpick(hp, k, 8), 2 + hpick(k, hp, 8));
        if (sp) herbs.push({ pi: hp, x: sp.x, y: sp.y });
      }
      out.push(make('plague', Object.assign({}, giver, {
        title: 'Moonwort for the sick',
        story: 'The coughing sickness is in our houses. The old remedy is moonwort, which grows in the wild places nearby. Bring me four sprigs and I will brew it for every family. Mind the rats; they carry it.',
        enc: [{ pi: pi, foes: [], objs: [], herbs: herbs, clear: 'all', deeds: [], done: false, label: 'Gather moonwort' }],
        deeds: [{ type: 'heal', pi: pi }], xp: 40, potions: 1
      })));
      return out;
    }
    var opts = [];
    // a raider camp threatening the canals
    var campP = around(pi, 2, function (j, dd) { return dd >= 1 && s.terrain[j] !== TER.MOUNTAIN; });
    var cp = campP.length ? campP[0].pi : pi;
    opts.push(make('camp', Object.assign({}, giver, {
      title: 'Raiders at the canal works',
      story: 'We would dig new canals to water the fields, but raiders have made camp ' + R().dirText(pi, cp) + ' and fall on anyone who goes out with a spade. Clear them out and the whole village will dig.',
      enc: [enc(cp, { foes: ['bandit', 'archer', 'bandit', 'chief'], label: 'Clear the raider camp' })],
      deeds: [{ type: 'irrigate', pi: pi }], xp: 45
    })));
    // a hostile warband on the frontier
    var front = around(pi, 5, function (j) { return s.owner[j] === c && foreignNeighbour(s, j, c) >= 0; });
    if (front.length) {
      var fp = front[0].pi, fc = foreignNeighbour(s, fp, c), fsig = s.cSig[fc];
      opts.push(make('frontier', Object.assign({}, giver, {
        title: 'Riders on the frontier',
        story: 'A warband of the <b>' + esc(civName(fsig)) + '</b> is burning farms on our border ' + R().dirText(pi, fp) + '. Break them, and our people will remember that someone stood up for them.',
        enc: [enc(fp, { foes: warband(s, fc, 3, true), faction: fsig, label: 'Break the ' + civName(fsig) + ' warband', deeds: [{ type: 'rally', pi: fp }] })],
        deeds: [{ type: 'rally', pi: pi }], xp: 60
      })));
    }
    // empty land waiting for settlers
    var empty = around(pi, 4, function (j, dd) { return dd >= 1 && s.owner[j] < 0 && s.pop[j] === 0 && s.terrain[j] !== TER.MOUNTAIN; });
    if (empty.length && s.pop[pi] > 60) {
      var ep = empty[0].pi, beast = wild(s, ep);
      opts.push(make('settlers', Object.assign({}, giver, {
        title: 'Land for the young families',
        story: 'There are too many mouths here and good empty land ' + R().dirText(pi, ep) + '. Lead our young families there and hold the camp against the beasts until the first houses stand.',
        enc: [enc(ep, { arrive: true, waves: [[beast, beast], [beast, beast, beast]], label: 'Defend the settlers\' camp', deeds: [{ type: 'settle', pi: ep }] })],
        returnKey: null, deeds: [], xp: 50
      })));
    }
    // a stolen codex, for people who know more than you
    if (s.cTech[c] > (know ? know.tech : 0) + 150) {
      var tp = around(pi, 2, function (j, dd) { return dd >= 1; });
      var tpi = tp.length ? tp[tp.length > 1 ? 1 : 0].pi : pi;
      opts.push(make('codex', Object.assign({}, giver, {
        title: 'The stolen codex',
        story: 'Thieves took our great codex, the book where our scholars write all that the ' + esc(realm) + ' know. They are hiding ' + R().dirText(pi, tpi) + '. Bring it back and I will let you study it.',
        enc: [enc(tpi, { foes: ['bandit', 'archer', 'thief'], label: 'Recover the codex' })],
        deeds: [{ type: 'learn', pi: pi }], xp: 50
      })));
    }
    out.push(opts[hpick(pi, Math.floor(g.year / 3), opts.length)]);
    if (know && know.tech > s.cTech[c] + 50) out.push(teachOffer(npc, pi, giver));
    return out;
  }

  function teachOffer(npc, pi, giver) {
    var g = G(), s = g.s, c = s.owner[pi];
    return make('teach', Object.assign({}, giver, {
      title: 'Teach what you know',
      story: 'You carry the learning of the <b>' + esc(civName(g.player.knowledge.sig)) + '</b> (' + Sim.AGES[Sim.ageOf(g.player.knowledge.tech)].name + '). Stay a season and teach it to the ' + esc(civName(s.cSig[c])) + '. (It takes three months.)',
      enc: [], deeds: [{ type: 'teach', pi: pi, v: g.player.knowledge.tech }], returnKey: null, instant: 3, xp: 30
    }));
  }

  function homeOffers(npc) {
    var g = G(), s = g.s, out = [], hc = R().homeCiv();
    if (hc < 0) return out;
    var cap = s.cCap[hc], sig = s.cSig[hc], giver = { giverKey: npc.key, giverName: npc.name, returnKey: npc.key, returnPi: npc.prov, returnName: npc.name };
    if (npc.role === 'royal') {
      var borders = around(cap, 8, function (j) { return s.owner[j] === hc && foreignNeighbour(s, j, hc) >= 0; });
      var foeC = R().foeCiv();
      var pref = borders.filter(function (b) { return foeC >= 0 && foreignNeighbour(s, b.pi, hc) === foeC; });
      var picks = (pref.length ? pref : borders).slice(0, 3);
      if (picks.length) {
        out.push(make('muster', Object.assign({}, giver, {
          title: 'Hold the borders',
          story: 'Our borders bleed. Ride to the frontier, break the warbands raiding our provinces, and show our people the realm still stands. Each victory will rally the province where you win it. Then come back to me and I will rally the capital.',
          enc: picks.map(function (b) {
            var fc = foreignNeighbour(s, b.pi, hc);
            return enc(b.pi, { foes: warband(s, fc, 3, true), faction: s.cSig[fc], label: 'Break the ' + civName(s.cSig[fc]) + ' warband', deeds: [{ type: 'rally', pi: b.pi }] });
          }),
          deeds: [{ type: 'rally', pi: cap }], xp: 120, potions: 1
        })));
      }
    } else if (npc.role === 'spymaster') {
      var fc2 = R().foeCiv();
      if (fc2 >= 0) {
        var fcap = s.cCap[fc2], fsig = s.cSig[fc2], fname = esc(civName(fsig)), ruler = R().rulerName(fsig);
        out.push(make('granaries', Object.assign({}, giver, {
          title: 'Burn the granaries of the ' + civName(fsig),
          story: 'The <b>' + fname + '</b> are the danger. Their capital lies ' + R().dirText(cap, fcap) + '. Slip in and burn the three royal granaries. Hungry people quarrel, and quarrelling people do not march.',
          enc: [enc(fcap, { foes: ['guard', 'bowman', 'guard'], objs: ['granary', 'granary', 'granary'], faction: fsig, clear: 'objs', label: 'Burn the granaries', deeds: [{ type: 'discord', pi: fcap }] })],
          returnKey: null, deeds: [], xp: 90
        })));
        if (R().renown() >= R().RENOWN_REGICIDE) out.push(make('regicide', Object.assign({}, giver, {
          title: 'The death of ' + ruler,
          story: '<b>' + esc(ruler) + '</b> holds the <b>' + fname + '</b> together. Their seat lies ' + R().dirText(cap, fcap) + '. Kill them in their own hall and the realm will tear itself apart over the succession. Their guard is strong; be ready.',
          enc: [enc(fcap, { lx: L.C + 1.5, ly: L.C + 0.5, foes: ['guard', 'guard', 'bowman', 'guard', 'ruler'], faction: fsig, clear: 'boss', label: 'Kill ' + ruler, deeds: [{ type: 'assassinate', pi: fcap }] })],
          returnKey: null, deeds: [], xp: 200, potions: 1
        })));
      }
    } else if (npc.role === 'scholar') {
      var near = around(cap, 2, function (j, dd) { return dd >= 1 && s.terrain[j] !== TER.MOUNTAIN; });
      var cp = near.length ? near[0].pi : cap;
      out.push(make('canal', Object.assign({}, giver, {
        title: 'The great canal',
        story: 'I have drawn plans for a great canal to water the capital\'s fields, but brigands camp ' + R().dirText(cap, cp) + ' on the line it must take. Drive them off and the diggers can begin.',
        enc: [enc(cp, { foes: ['bandit', 'archer', 'bandit', 'archer', 'chief'], label: 'Drive off the brigands', deeds: [{ type: 'irrigate', pi: cp }] })],
        deeds: [{ type: 'irrigate', pi: cap }], xp: 60
      })));
      var know = g.player.knowledge;
      if (know && know.tech > s.cTech[hc] + 50) out.push(teachOffer(npc, cap, giver));
    }
    return out;
  }

  /** What this person would ask of you right now (possibly nothing). */
  function offersFor(npc) {
    var g = G();
    if (g.quests.some(function (q) { return q.giverKey === npc.key; })) return [];
    if (g.quests.length >= 6) return [];
    if (npc.role === 'elder') return elderOffers(npc);
    if (npc.role === 'royal' || npc.role === 'spymaster' || npc.role === 'scholar') return homeOffers(npc);
    return [];
  }

  var DANGER = { plague: 1, camp: 1, codex: 1, trial: 1, teach: 0, settlers: 2, frontier: 2, canal: 2, muster: 3, granaries: 3, regicide: 5 };
  /** Recommended level: the quest's base danger, plus a little for foes from more advanced ages. */
  function recommended(q) {
    var base = DANGER[q.kind] || 1, s = G().s, age = 0;
    q.enc.forEach(function (e) {
      var c = e.faction ? -1 : s.owner[e.pi];
      if (e.faction) for (var k = 0; k < s.g[1]; k++) if (s.cSig[k] === e.faction && s.cAlive[k]) c = k;
      if (c >= 0) age = Math.max(age, Sim.ageOf(s.cTech[c]));
    });
    return base ? base + Math.max(0, Math.floor((age - 2) / 2)) : 0;
  }
  function describe(q) {
    var deeds = [];
    q.enc.forEach(function (e) { e.deeds.forEach(function (d) { deeds.push(d); }); });
    q.deeds.forEach(function (d) { deeds.push(d); });
    var seen = {};
    var lines = deeds.filter(function (d) { if (seen[d.type]) return false; seen[d.type] = 1; return true; })
      .map(function (d) { return '<li>' + DEED_TEXT[d.type] + '</li>'; }).join('');
    return '<p>' + q.story + '</p>' +
      (lines ? '<div class="deedbox"><div class="dh">If you succeed, history records:</div><ul>' + lines + '</ul></div>' : '') +
      '<p class="reward">Reward: ' + q.xp + ' XP' + (q.potions ? ', ' + q.potions + ' potion' : '') + '</p>' + dangerLine(q);
  }

  function dangerLine(q) {
    var r = recommended(q);
    if (!r) return '';
    var lvl = R().level(), cls = lvl >= r ? 'ok' : lvl >= r - 1 ? 'warn' : 'bad';
    return '<p class="danger ' + cls + '">Danger: ' + '★★★★★'.slice(0, Math.min(5, r)) + ' · recommended level ' + r + (cls === 'bad' ? ' (you are level ' + lvl + ': this will likely kill you)' : cls === 'warn' ? ' (you are level ' + lvl + ')' : '') + '</p>';
  }

  function accept(q) {
    var g = G();
    q.id = nextId++;
    q.stage = 'go';
    q.year = g.year;
    g.quests.push(q);
    R().journal('Quest accepted: <b>' + esc(q.title) + '</b> (from ' + esc(q.giverName) + ').');
    if (q.instant) {
      R().passMonths(q.instant, 'teaching');
      complete(q);
      return;
    }
    if (!q.enc.length) { q.stage = 'return'; return; }
    // spawn encounters already in range
    q.enc.forEach(function (e, ei) {
      if (R().isActive(e.pi)) spawnEnc(q, e, ei);
      e.herbs.forEach(function (h) { if (R().isActive(h.pi)) spawnHerb(q, ei, h); });
    });
  }

  // ---------------------------------------------------------------------------
  // Encounters in the world
  // ---------------------------------------------------------------------------
  function spawnEnc(q, e, ei) {
    if (e.done || e.spawned) return;
    if (e.arrive && !e.arrived) return;
    var px = (e.pi % W) * L.P, py = ((e.pi / W) | 0) * L.P;
    var cx = px + e.lx, cy = py + e.ly;
    if (e.arrive) { var p = G().player; cx = p.x; cy = p.y; }
    e.spawned = true;
    var opts = { qid: q.id, ei: ei, faction: e.faction, prov: e.pi, hostile: true };
    e.foes.forEach(function (kind, k) {
      var ang = k * 2.4 + 0.5, rr = e.arrive ? 6 : 1.2 + (k % 3) * 0.8;
      if (kind === 'ruler') { R().spawnAt(kind, cx, cy, opts); return; }
      R().spawnNear(kind, cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, opts);
    });
    e.objs.forEach(function (kind, k) {
      var f = R().findFree(e.pi, [3, 8, 3, 8][k % 4], [8, 8, 3, 3][k % 4]);
      if (f) R().spawnAt(kind, f.x, f.y, opts);
    });
    if (e.foes.length && !e.arrive && q.kind !== 'regicide' && q.kind !== 'granaries') {
      R().spawnDeco('tent', cx + 1.4, cy - 1.2, { qid: q.id, prov: e.pi });
      R().spawnDeco('fire', cx, cy + 0.2, { qid: q.id, prov: e.pi });
    }
  }

  function spawnHerb(q, ei, h) {
    if (h.taken || h.spawned) return;
    h.spawned = true;
    R().spawnPickup('herb', h.x, h.y, { qid: q.id, ei: ei, ref: h, prov: h.pi });
  }

  /** Province pi has come into range: spawn quest encounters there. */
  function spawnFor(pi) {
    G().quests.forEach(function (q) {
      if (q.stage !== 'go') return;
      q.enc.forEach(function (e, ei) {
        if (e.pi === pi) spawnEnc(q, e, ei);
        e.herbs.forEach(function (h) { if (h.pi === pi) spawnHerb(q, ei, h); });
      });
    });
  }
  /** Province pi left range: its encounters will respawn (with what is left) next time. */
  function despawned(pi) {
    G().quests.forEach(function (q) {
      q.enc.forEach(function (e) {
        if (e.pi === pi) e.spawned = false;
        e.herbs.forEach(function (h) { if (h.pi === pi) h.spawned = false; });
      });
    });
  }
  function owns(e, pi) { return e.pi === pi || e.herbs.some(function (h) { return h.pi === pi; }); }

  function enterProvince(pi) {
    G().quests.forEach(function (q) {
      if (q.stage !== 'go') return;
      q.enc.forEach(function (e, ei) {
        if (e.pi !== pi || !e.arrive || e.arrived || e.done) return;
        e.arrived = true;
        e.foes = e.waves.shift();
        R().toast('Your settlers pitch their tents. <b>Something is moving in the dark.</b>');
        for (var k = 0; k < 3; k++) R().spawnNear('settler', G().player.x + (k - 1) * 1.2, G().player.y + 0.8, { prov: pi, qid: q.id, friendly: true });
        spawnEnc(q, e, ei);
      });
    });
  }

  function find(id) { var g = G(); for (var k = 0; k < g.quests.length; k++) if (g.quests[k].id === id) return g.quests[k]; return null; }

  function onKill(a) {
    var q = find(a.qid);
    if (!q || q.stage !== 'go') return;
    var e = q.enc[a.ei];
    if (!e || e.done) return;
    var list = a.kind === 'granary' ? e.objs : e.foes, k = list.indexOf(a.kind);
    if (k >= 0) list.splice(k, 1);
    if (a.kind === 'ruler') e.bossDead = true;
    if (a.kind === 'thief') R().spawnPickup('codex', a.x, a.y, { qid: q.id, ei: a.ei });
    if (a.kind === 'thief') e.needCodex = true;
    if (e.arrive && !e.foes.length && e.waves && e.waves.length) {
      e.foes = e.waves.shift();
      e.spawned = false;
      R().toast('More of them come out of the dark!');
      spawnEnc(q, e, a.ei);
      return;
    }
    check(q, e);
  }

  function onPickup(pk) {
    var q = find(pk.qid);
    if (!q || q.stage !== 'go') return;
    var e = q.enc[pk.ei];
    if (pk.kind === 'herb') { pk.ref.taken = true; R().toast('Moonwort (' + e.herbs.filter(function (h) { return h.taken; }).length + '/' + e.herbs.length + ')'); }
    if (pk.kind === 'codex') { e.needCodex = false; R().toast('You recover the codex.'); }
    check(q, e);
  }

  function cleared(e) {
    var herbsLeft = e.herbs.some(function (h) { return !h.taken; });
    if (e.clear === 'boss') return !!e.bossDead;
    if (e.clear === 'objs') return !e.objs.length;
    return !e.foes.length && !e.objs.length && !herbsLeft && !e.needCodex && (!e.waves || !e.waves.length);
  }

  function check(q, e) {
    if (e.done || !cleared(e)) return;
    e.done = true;
    e.deeds.forEach(function (d) { R().applyDeed(d.type, d.pi, d.v, q.title); });
    if (q.enc.every(function (x) { return x.done; })) {
      if (q.returnKey) {
        q.stage = 'return';
        R().toast('Return to <b>' + esc(q.returnName) + '</b>.');
      } else complete(q);
    }
  }

  function complete(q) {
    var g = G();
    q.deeds.forEach(function (d) { R().applyDeed(d.type, d.pi, d.v, q.title); });
    q.stage = 'done';
    g.quests.splice(g.quests.indexOf(q), 1);
    g.questsDone.push({ title: q.title, year: g.year, kind: q.kind });
    R().reward(q.xp, q.potions);
    R().journal('Quest complete: <b>' + esc(q.title) + '</b>.');
    R().onQuestDone(q);
  }

  /** Talking to someone: hand in any quest they are waiting on. Returns true if handled. */
  function turnIn(npc) {
    var g = G();
    for (var k = 0; k < g.quests.length; k++) {
      var q = g.quests[k];
      if (q.stage === 'return' && q.returnKey === npc.key) { complete(q); return q; }
    }
    return null;
  }
  function waitingOn(npc) {
    return G().quests.filter(function (q) { return q.returnKey === npc.key || q.giverKey === npc.key; })[0] || null;
  }

  function objectives() {
    var out = [], p = G().player, ppi = R().provOf(p.x, p.y);
    G().quests.forEach(function (q) {
      if (q.stage === 'return') { out.push({ q: q, text: 'Return to ' + q.returnName, pi: q.returnPi }); return; }
      for (var k = 0; k < q.enc.length; k++) {
        var e = q.enc[k];
        if (e.done) continue;
        if (e.herbs.length) {
          var left = e.herbs.filter(function (h) { return !h.taken; });
          left.sort(function (a, b) { return md(a.pi, ppi) - md(b.pi, ppi); });
          out.push({ q: q, text: 'Gather moonwort (' + (e.herbs.length - left.length) + '/' + e.herbs.length + ')', pi: left.length ? left[0].pi : e.pi, x: left[0] && left[0].x, y: left[0] && left[0].y });
        } else {
          var n = e.clear === 'objs' ? e.objs.length + ' granaries left' : e.clear === 'boss' ? '' : e.needCodex ? 'pick up the codex' : e.arrive && !e.arrived ? 'lead them there' : (e.foes.length + (e.waves ? e.waves.reduce(function (a, w) { return a + w.length; }, 0) : 0)) + ' left';
          out.push({ q: q, text: e.label + (n ? ' (' + n + ')' : ''), pi: e.pi });
        }
        break;
      }
    });
    return out;
  }

  function abandonAll(why) {
    var g = G();
    if (!g.quests.length) return;
    g.quests.forEach(function (q) { R().journal('Quest abandoned: ' + esc(q.title) + (why ? ' (' + why + ')' : '') + '.'); });
    g.quests.length = 0;
  }

  root.Quests = {
    DEED_TEXT: DEED_TEXT, offersFor: offersFor, describe: describe, accept: accept, spawnFor: spawnFor, despawned: despawned,
    enterProvince: enterProvince, onKill: onKill, onPickup: onPickup, turnIn: turnIn, waitingOn: waitingOn, objectives: objectives,
    abandonAll: abandonAll, make: make, enc: enc, warband: warband, around: around, owns: owns
  };
}(this));
