/*
 * Quests: the action-RPG face of the Chronoscope's deeds.
 *
 * Every quest is generated from the live simulation around the person who
 * gives it (plague next door, an empty valley, a hostile border, unrest, a
 * rival's capital), and every quest ends in one or more *deeds*: recorded
 * interventions in the timeline (the original eight deeds, plus the rarer,
 * larger ones: prophets, blessing or salting land, founding a people, lost
 * knowledge, plague). The future is then re-simulated from that moment.
 *
 * Quest mechanics:
 *   encounters  { pi, foes, objs, herbs, relic, clear, arrive, siege, waves, deeds }
 *               spawned whenever their province is near the player
 *   escorts     followers who must reach a destination alive (ambushes on the way)
 *   choices     the player picks a side; each side is its own set of encounters
 *   echoes      quests read from the future of your own timeline, active only in
 *               a window of years: travel there with the Chronoscope
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
    assassinate: 'Assassinate: a realm-wide succession crisis (solidarity ×0.68)',
    prophet: 'A prophet\'s word: solidarity surges to 90% across a wide region',
    bless: 'The land heals: the soil around here turns rich and green',
    blight: 'Salt the earth: their soil is ruined for generations',
    tribe: 'A new people is founded here, fierce and united',
    knowledge: 'Lost knowledge returns: their whole realm leaps ahead (+800)',
    plague: 'Plague breaks out in their capital. It may not stay there.'
  };

  var nextId = 1;
  function esc(t) { return R().esc(t); }
  function G() { return R().G; }
  function md(a, b) { return Math.abs(a % W - b % W) + Math.abs(((a / W) | 0) - ((b / W) | 0)); }
  function isLand(s, pi) { return Sim.isLand(s.terrain[pi]); }
  function hpick(a, b, n) { return Sim.hash4(G().world.seed, a, b, 931) % n; }
  function civName(sig) { return Sim.civName(sig); }
  function pickText(arr, a, b) { return arr[hpick(a, b, arr.length)]; }
  function fill(t, o) { return t.replace(/\{(\w+)\}/g, function (m, k) { return o[k] != null ? o[k] : m; }); }

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
  function civBySig(s, sig) { for (var c = 0; c < s.g[1]; c++) if (s.cSig[c] === sig && s.cAlive[c] && s.sTiles[c] > 0) return c; return -1; }

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
  // Foes
  // ---------------------------------------------------------------------------
  function warband(s, c, n, captain) {
    var a = c >= 0 ? Sim.ageOf(s.cTech[c]) : 0, out = [];
    for (var k = 0; k < n; k++) out.push(k === 1 && a >= 1 ? 'bowman' : k === 2 && a >= 2 ? 'shield' : 'soldier');
    if (captain) out.push('captain');
    return out;
  }
  function wild(s, pi) {
    var t = s.terrain[pi];
    return t === TER.DESERT ? 'jackal' : t === TER.MOUNTAIN ? 'bear' : 'wolf';
  }
  var BEASTS = ['Greymaw', 'Old Tusk', 'Hollowfang', 'Bloodhide', 'Ironjaw', 'the Pale Hunter', 'the Widow of the Woods', 'Ashenmane'];

  // ---------------------------------------------------------------------------
  // Village elders: what this place actually needs
  // ---------------------------------------------------------------------------
  var T_CAMP = [
    'We would dig new canals to water the fields, but raiders have made camp {dir} and fall on anyone who goes out with a spade. Clear them out and the whole village will dig.',
    'A band calling themselves the {gang} has dug in {dir}. They took our seed grain last spring. Drive them off and we can finally cut the new channels from the river.',
    'Every time we start on the irrigation ditches, {chief} and their cutthroats come down from their camp {dir}. End them, and we dig.'
  ];
  var T_FRONT = [
    'A warband of the <b>{foe}</b> is burning farms on our border {dir}. Break them, and our people will remember that someone stood up for them.',
    'The <b>{foe}</b> test us every harvest. This year their riders camp {dir}, bold as anything. Send them home bloody and the whole border will take heart.'
  ];
  var T_SETTLE = [
    'There are too many mouths here and good empty land {dir}. Lead our young families there and hold the camp against the beasts until the first houses stand.',
    'My grandchildren have no fields of their own. There is open country {dir}, but nobody comes back from it. Take them there and keep them safe.'
  ];
  var T_CODEX = [
    'Thieves took our great codex, the book where our scholars write all that the {realm} know. They are hiding {dir}. Bring it back and I will let you study it.',
    'Someone sold our codex to bandits {dir}, every page our scholars ever wrote. Get it back and you may read it before it goes home to the shelf.'
  ];
  var GANGS = ['Red Hands', 'Crows', 'Ditch Kings', 'Salt Wolves', 'Hollow Men', 'Bell Thieves'];

  function giverOf(npc) { return { giverKey: npc.key, giverName: npc.name, returnKey: npc.key, returnPi: npc.prov, returnName: npc.name }; }

  function elderOffers(npc) {
    var g = G(), s = g.s, pi = npc.prov, c = s.owner[pi], out = [];
    if (c < 0) return out;
    var sig = s.cSig[c], realm = civName(sig), giver = giverOf(npc), know = g.player.knowledge, salt = Math.floor(g.year / 3);
    // plague is always the most urgent
    var sick = s.plague[pi] > 0;
    for (var d = 0; d < 4; d++) { var n = NB[pi * 4 + d]; if (n >= 0 && s.plague[n]) sick = true; }
    if (sick) out.push(plagueQuest(pi, giver, 'The coughing sickness is in our houses. The old remedy is moonwort, which grows in the wild places nearby. Bring me four sprigs and I will brew it for every family. Mind the rats; they carry it.'));

    var opts = [];
    // a raider camp threatening the canals
    var campP = around(pi, 2, function (j, dd) { return dd >= 1 && s.terrain[j] !== TER.MOUNTAIN; });
    var cp = campP.length ? campP[0].pi : pi;
    var chief = Story.personName(sig, pi * 7 + salt);
    opts.push(make('camp', Object.assign({}, giver, {
      title: pickText(['Raiders at the canal works', 'The ' + GANGS[hpick(pi, salt, GANGS.length)], chief + '\'s camp'], pi, salt),
      story: fill(pickText(T_CAMP, pi, salt + 1), { dir: R().dirText(pi, cp), gang: GANGS[hpick(pi, salt, GANGS.length)], chief: esc(chief) }),
      enc: [enc(cp, { foes: ['bandit', 'archer', 'bandit', 'chief'], label: 'Clear the raider camp' })],
      deeds: [{ type: 'irrigate', pi: pi }], xp: 45
    })));
    // a hostile warband on the frontier, or a siege of this very village
    var front = around(pi, 5, function (j) { return s.owner[j] === c && foreignNeighbour(s, j, c) >= 0; });
    if (front.length) {
      var fp = front[0].pi, fc = foreignNeighbour(s, fp, c), fsig = s.cSig[fc];
      if (front[0].d <= 1 && s.pop[pi] >= 60) {
        var ang = Math.atan2(((fp / W) | 0) - ((pi / W) | 0), fp % W - pi % W) + (fp === pi ? hpick(pi, 3, 6) : 0);
        opts.push(make('siege', Object.assign({}, giver, {
          title: 'The ' + civName(fsig) + ' are coming',
          story: 'Our scouts saw the <b>' + esc(civName(fsig)) + '</b> mustering across the border. They will come for this village, in waves, and our people will not stand alone. Will you stand with them? Wait in the village and hold until the last wave breaks.',
          enc: [enc(pi, { lx: L.C + 0.5, ly: L.C + 0.5, arrive: true, siege: true, ang: ang, faction: fsig, arriveText: 'War horns across the fields. <b>Here they come!</b>',
            waves: [warband(s, fc, 2, false), warband(s, fc, 3, false), warband(s, fc, 3, true)], label: 'Hold the village', deeds: [{ type: 'rally', pi: pi }] })],
          returnKey: null, deeds: [{ type: 'rally', pi: fp }], xp: 90, potions: 1
        })));
      } else {
        opts.push(make('frontier', Object.assign({}, giver, {
          title: 'Riders on the frontier',
          story: fill(pickText(T_FRONT, pi, salt), { foe: esc(civName(fsig)), dir: R().dirText(pi, fp) }),
          enc: [enc(fp, { foes: warband(s, fc, 3, true), faction: fsig, label: 'Break the ' + civName(fsig) + ' warband', deeds: [{ type: 'rally', pi: fp }] })],
          deeds: [{ type: 'rally', pi: pi }], xp: 60
        })));
      }
    }
    // empty land waiting for settlers (near), or exiles who want a land of their own (far)
    var empty = around(pi, 4, function (j, dd) { return dd >= 1 && s.owner[j] < 0 && s.pop[j] === 0 && s.terrain[j] !== TER.MOUNTAIN; });
    if (empty.length && s.pop[pi] > 60) {
      var ep = empty[0].pi, beast = wild(s, ep);
      opts.push(make('settlers', Object.assign({}, giver, {
        title: 'Land for the young families',
        story: fill(pickText(T_SETTLE, pi, salt), { dir: R().dirText(pi, ep) }),
        enc: [enc(ep, { arrive: true, waves: [[beast, beast], [beast, beast, beast]], label: 'Defend the settlers\' camp', deeds: [{ type: 'settle', pi: ep }] })],
        returnKey: null, deeds: [], xp: 50
      })));
    }
    var far = around(pi, 12, function (j, dd) { return dd >= 6 && s.owner[j] < 0 && s.pop[j] === 0 && s.terrain[j] !== TER.MOUNTAIN && s.terrain[j] !== TER.DESERT; });
    if (far.length && s.pop[pi] > 150 && hpick(pi, salt, 3) === 0) {
      var xp2 = far[0].pi;
      opts.push(make('exiles', Object.assign({}, giver, {
        title: 'The exiles\' road',
        story: 'There is a family here, and their friends, who will not bow to the ' + esc(realm) + ' any longer. They are not wicked; they want land where they can be their own people. There is empty country ' + R().dirText(pi, xp2) + '. Lead them there. If they arrive alive, a new people begins.',
        enc: [], escort: { kind: 'exile', n: 3, to: xp2, name: 'the exiles', deeds: [{ type: 'tribe', pi: xp2 }] },
        returnKey: null, deeds: [], xp: 90, potions: 1
      })));
    }
    // a stolen codex, for people who know more than you
    if (s.cTech[c] > (know ? know.tech : 0) + 150) {
      var tp = around(pi, 2, function (j, dd) { return dd >= 1; });
      var tpi = tp.length ? tp[tp.length > 1 ? 1 : 0].pi : pi;
      opts.push(make('codex', Object.assign({}, giver, {
        title: 'The stolen codex',
        story: fill(pickText(T_CODEX, pi, salt), { realm: esc(realm), dir: R().dirText(pi, tpi) }),
        enc: [enc(tpi, { foes: ['bandit', 'archer', 'thief'], label: 'Recover the codex' })],
        deeds: [{ type: 'learn', pi: pi }], xp: 50
      })));
    }
    // a legendary beast in the wilds
    var lair = around(pi, 3, function (j, dd) { return dd >= 1 && s.owner[j] < 0 && s.pop[j] === 0; });
    if (lair.length && hpick(pi, salt, 2) === 0) {
      var lp = lair[lair.length > 2 ? 2 : 0].pi, bname = BEASTS[hpick(lp, salt, BEASTS.length)];
      opts.push(make('beast', Object.assign({}, giver, {
        title: 'The hunt for ' + bname,
        story: 'Something lives in the wild country ' + R().dirText(pi, lp) + '. We call it <b>' + esc(bname) + '</b>. It takes sheep, then dogs, and last winter a boy. No one will farm that land while it lives. Kill it, and the land is ours to work: the old women say the earth there will bloom.',
        enc: [enc(lp, { foes: ['greatbeast'], beastName: bname, clear: 'boss', label: 'Kill ' + bname, deeds: [{ type: 'bless', pi: lp }] })],
        deeds: [], xp: 110, potions: 1
      })));
    }
    // unrest: pick a side
    var unrest = around(pi, 3, function (j) { return s.owner[j] === c && s.pop[j] > 20 && s.asab[j] < 2500; });
    if (unrest.length && Sim.meanAsab(s, c) < 4500) {
      var up = unrest[0].pi, leader = Story.personName(sig, up * 3 + salt), lord = R().rulerName(sig);
      opts.push(make('rebels', Object.assign({}, giver, {
        title: 'The rising at ' + (up === pi ? 'our village' : '(' + (up % W) + ', ' + ((up / W) | 0) + ')'),
        story: 'People ' + (up === pi ? 'here' : R().dirText(pi, up)) + ' have had enough of ' + esc(lord) + '. <b>' + esc(leader) + '</b> leads them; they talk of a people of their own. The garrison will march on them any day. Some here want you to help the rebels; some want you to help put them down. It is your choice, and either way, nothing will be the same.',
        choices: [
          { label: 'Side with the rebels', desc: 'Break the ' + civName(sig) + ' garrison. If you win, ' + esc(leader) + '\'s people declare themselves a new people.',
            enc: [enc(up, { foes: warband(s, c, 3, true), faction: sig, label: 'Break the garrison', deeds: [{ type: 'tribe', pi: up }] })] },
          { label: 'Crush the rising', desc: 'Defeat ' + esc(leader) + '\'s rebels. The ' + civName(sig) + ' grow stronger for it.',
            enc: [enc(up, { foes: ['rebel', 'rebel', 'archer', 'rebel', 'chief'], label: 'Crush the rebels', deeds: [{ type: 'rally', pi: up }] })] }
        ],
        returnKey: null, deeds: [], xp: 85
      })));
    }
    // ruins in the wild with something worth knowing
    var ruin = around(pi, 4, function (j, dd) { return dd >= 2 && s.owner[j] < 0; });
    if (ruin.length && hpick(pi, salt + 5, 3) === 0) {
      var rp = ruin[0].pi;
      opts.push(make('relic', Object.assign({}, giver, {
        title: 'The drowned library',
        story: 'Long before the ' + esc(realm) + ', some people built in stone ' + R().dirText(pi, rp) + '. Our shepherds say there are tablets there, covered in writing, and that the place is guarded. Bring me what you find. If the old knowledge is real, it could lift our whole people.',
        enc: [enc(rp, { foes: ['warden', 'warden', 'warden'], relic: true, ruins: true, label: 'Search the ruins' })],
        deeds: [{ type: 'knowledge', pi: pi }], xp: 90
      })));
    }
    // a holy wanderer who could unite a divided people
    if (Sim.meanAsab(s, c) < 3500 && md(s.cCap[c], pi) >= 3) {
      var wname = Story.personName(sig, pi + 99);
      opts.push(make('prophet', Object.assign({}, giver, {
        title: 'The holy wanderer',
        story: 'A wanderer named <b>' + esc(wname) + '</b> preaches here that the ' + esc(realm) + ' are one family. People weep when she speaks. She wants to preach in the capital, ' + R().dirText(pi, s.cCap[c]) + ', but the roads are dangerous and some would rather she never arrived. Get her there alive.',
        enc: [], escort: { kind: 'prophet', n: 1, to: s.cCap[c], name: wname, deeds: [{ type: 'prophet', pi: s.cCap[c] }] },
        returnKey: null, deeds: [], xp: 100, potions: 1
      })));
    }
    // offer a few, in an order that changes over the years
    var start = hpick(pi, salt, opts.length);
    for (var k = 0; k < Math.min(3, opts.length); k++) out.push(opts[(start + k) % opts.length]);
    if (know && know.tech > s.cTech[c] + 50) out.push(teachOffer(npc, pi, giver));
    return out;
  }

  function plagueQuest(pi, giver, story, extra) {
    var s = G().s;
    var spots = around(pi, 2, function (j) { return s.pop[j] === 0 || j === pi; }).slice(0, 3);
    if (!spots.length) spots = [{ pi: pi }];
    var herbs = [];
    for (var k = 0; k < 4; k++) {
      var hp = spots[k % spots.length].pi, sp = R().findFree(hp, 2 + hpick(hp, k, 8), 2 + hpick(k, hp, 8));
      if (sp) herbs.push({ pi: hp, x: sp.x, y: sp.y });
    }
    return make('plague', Object.assign({}, giver, {
      title: 'Moonwort for the sick', story: story,
      enc: [{ pi: pi, foes: [], objs: [], herbs: herbs, clear: 'all', deeds: [], done: false, label: 'Gather moonwort' }],
      deeds: [{ type: 'heal', pi: pi }], xp: 40, potions: 1
    }, extra || {}));
  }

  function teachOffer(npc, pi, giver) {
    var g = G(), s = g.s, c = s.owner[pi];
    return make('teach', Object.assign({}, giver, {
      title: 'Teach what you know',
      story: 'You carry the learning of the <b>' + esc(civName(g.player.knowledge.sig)) + '</b> (' + Sim.AGES[Sim.ageOf(g.player.knowledge.tech)].name + '). Stay a season and teach it to the ' + esc(civName(s.cSig[c])) + '. (It takes three months.)',
      enc: [], deeds: [{ type: 'teach', pi: pi, v: g.player.knowledge.tech }], returnKey: null, instant: 3, xp: 30
    }));
  }

  // ---------------------------------------------------------------------------
  // The capital: ruler, spymaster, scholar
  // ---------------------------------------------------------------------------
  function homeOffers(npc) {
    var g = G(), s = g.s, out = [], hc = R().homeCiv();
    if (hc < 0) return out;
    var cap = s.cCap[hc], giver = giverOf(npc), renown = R().renown();
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
      var town = around(cap, 9, function (j, dd) { return dd >= 4 && s.owner[j] === hc && s.pop[j] > 100; });
      if (Sim.meanAsab(s, hc) < 4500 && town.length) {
        var tpi = town[town.length - 1].pi, pname = Story.personName(s.cSig[hc], tpi + 77);
        out.push(make('prophet', Object.assign({}, giver, {
          title: 'The voice of the people',
          story: 'Our people have stopped believing in this realm. But in the hills, ' + R().dirText(cap, tpi) + ', a holy woman named <b>' + esc(pname) + '</b> fills the fields with listeners. Bring her to the capital to preach. Our enemies will try to stop her. Keep her alive.',
          enc: [], escort: { kind: 'prophet', n: 1, from: tpi, to: cap, name: pname, deeds: [{ type: 'prophet', pi: cap }] },
          returnKey: null, deeds: [], xp: 120, potions: 1
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
        if (renown >= 2) {
          var bread = around(fcap, 6, function (j) { return s.owner[j] === fc2 && j !== fcap && s.pop[j] > 0; });
          bread.sort(function (a, b) { return s.pop[b.pi] - s.pop[a.pi]; });
          if (bread.length) {
            var bp = bread[0].pi;
            out.push(make('salt', Object.assign({}, giver, {
              title: 'Salt their fields',
              story: 'The <b>' + fname + '</b> feed their armies from the farmland ' + R().dirText(cap, bp) + '. I have three wagons of salt hidden in their own storehouses there. Break the storehouses open and spread it on the fields. Nothing will grow there for a generation. It is an ugly thing. Wars are.',
              enc: [enc(bp, { foes: ['soldier', 'shield', 'bowman'], objs: ['storehouse', 'storehouse', 'storehouse'], faction: fsig, clear: 'objs', label: 'Break the storehouses', deeds: [{ type: 'blight', pi: bp }] })],
              returnKey: null, deeds: [], xp: 100, dark: true
            })));
          }
        }
        if (renown >= 3) {
          out.push(make('wells', Object.assign({}, giver, {
            title: 'The poisoned wells',
            story: 'A physician sold me a flask of sickness. Pour it in the two great wells of the <b>' + fname + '</b> capital and their people will die in thousands. Plague is no friend, though: it will not care whose border it is on. Think before you take this.',
            enc: [enc(fcap, { foes: ['guard', 'shield', 'bowman'], objs: ['well', 'well'], faction: fsig, clear: 'objs', label: 'Poison the wells', deeds: [{ type: 'plague', pi: fcap }] })],
            returnKey: null, deeds: [], xp: 110, dark: true
          })));
        }
        if (renown >= R().RENOWN_REGICIDE) out.push(make('regicide', Object.assign({}, giver, {
          title: 'The death of ' + ruler,
          story: '<b>' + esc(ruler) + '</b> holds the <b>' + fname + '</b> together. Their seat lies ' + R().dirText(cap, fcap) + '. Kill them in their own hall and the realm will tear itself apart over the succession. Their guard is strong; be ready.',
          enc: [enc(fcap, { lx: L.C + 1.5, ly: L.C + 0.5, foes: ['guard', 'shield', 'bowman', 'guard', 'ruler'], faction: fsig, clear: 'boss', label: 'Kill ' + ruler, deeds: [{ type: 'assassinate', pi: fcap }] })],
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
      var ruin = around(cap, 7, function (j, dd) { return dd >= 3 && s.owner[j] < 0; });
      if (ruin.length && renown >= 2) {
        var rp = ruin[0].pi;
        out.push(make('relic', Object.assign({}, giver, {
          title: 'The tablets of the first kings',
          story: 'The old chronicles speak of a city that stood ' + R().dirText(cap, rp) + ' before ours, and a library of stone tablets beneath it. If they are real, their knowledge could carry our whole people an age ahead. Something guards the place. Bring the tablets to me.',
          enc: [enc(rp, { foes: ['warden', 'warden', 'warden', 'warden'], relic: true, ruins: true, label: 'Search the ruins' })],
          deeds: [{ type: 'knowledge', pi: cap }], xp: 110
        })));
      }
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

  // ---------------------------------------------------------------------------
  // Echoes: quests read from the future (and past) of your own timeline
  // ---------------------------------------------------------------------------
  function echoes() {
    var g = G(), hs = g.home ? g.home.sig : 0, fs = g.goal ? g.goal.foeSig : 0, b = g.cur, out = [];
    if (!hs) return out;
    var homeCap = null, s = g.s, hc = R().homeCiv();
    if (hc >= 0) homeCap = s.cCap[hc];
    var p = g.player, ppi = R().provOf(p.x, p.y), taken = {};
    g.quests.forEach(function (q) { if (q.echoKey) taken[q.echoKey] = 1; });
    (g.echoesDone || []).forEach(function (k) { taken[k] = 1; });
    var seen = {};
    for (var k = 0; k < b.events.length; k++) {
      var e = b.events[k];
      if (e.t < g.year - 80 || e.t > g.year + 120 || e.x < 0) continue;
      var pi = e.y * W + e.x, key = e.t + ':' + e.type + ':' + pi;
      if (taken[key] || seen[e.type + pi]) continue;
      var near = (homeCap != null && md(pi, homeCap) <= 14) || md(pi, ppi) <= 10;
      if (e.type === 'plague' && (e.a === hs || near)) {
        out.push({ key: key, kind: 'plague', t: e.t, pi: pi, y0: e.t, y1: e.t + 3, sig: e.a,
          title: 'The plague of ' + e.t, text: 'In ' + e.t + ' plague erupts among the ' + civName(e.a) + ' at (' + e.x + ', ' + e.y + '). Be there between ' + e.t + ' and ' + (e.t + 3) + ' with moonwort.' });
      } else if (e.type === 'sack' && (e.b === hs || (near && e.b !== fs))) {
        out.push({ key: key, kind: 'siege', t: e.t, pi: pi, y0: Math.max(1, e.t - 4), y1: e.t - 1, sig: e.b, foe: e.a,
          title: 'The siege of the ' + civName(e.b) + ' (' + e.t + ')', text: 'In ' + e.t + ' the ' + civName(e.a) + ' sack the capital of the ' + civName(e.b) + '. Stand on its walls in the years before, ' + Math.max(1, e.t - 4) + '–' + (e.t - 1) + ', and break the first assault.' });
      } else if (e.type === 'rise' && (near || e.a === fs) && e.a !== hs) {
        out.push({ key: key, kind: 'cradle', t: e.t, pi: pi, y0: e.t + 1, y1: e.t + 15, sig: e.a,
          title: 'The cradle of the ' + civName(e.a), text: 'In ' + e.t + ' the ' + civName(e.a) + ' rise' + (e.a === fs ? ': the very people who will destroy yours' : ' near your people') + '. Their founder rules from (' + e.x + ', ' + e.y + '). Kill them while the realm is young (' + (e.t + 1) + '–' + (e.t + 15) + ').' });
      } else continue;
      seen[e.type + pi] = 1;
    }
    // the fall itself: a last stand on the walls of your capital
    var fate = R().curFate();
    if (fate.state === 'falls' && !taken['fall:' + fate.end]) {
      var vs = R().stateAt(Math.max(1, fate.end - 6)), vc = civBySig(vs, hs);
      if (vc >= 0) out.push({ key: 'fall:' + fate.end, kind: 'laststand', t: fate.end, pi: vs.cCap[vc], y0: Math.max(1, fate.end - 6), y1: fate.end - 1, sig: hs, foe: fate.by || fs,
        title: 'The last stand of the ' + civName(hs), text: 'In ' + fate.end + ' your people fall' + (fate.by ? ' to the ' + civName(fate.by) : '') + '. Stand on the walls of their capital in the years before (' + Math.max(1, fate.end - 6) + '–' + (fate.end - 1) + ') and give them a reason to hold.' });
    }
    // border wars your people lose, from the per-decade war records
    var wars = {};
    b.warLog.forEach(function (w) {
      if (w.d !== hs || w.n < 3 || w.dec * 10 < g.year - 80 || w.dec * 10 > g.year + 120) return;
      var k2 = 'war:' + w.a + ':' + w.dec;
      if (taken[k2] || wars[w.a]) return;
      wars[w.a] = 1;
      var ws = R().stateAt(w.dec * 10), hc2 = civBySig(ws, hs), ac = civBySig(ws, w.a);
      if (hc2 < 0 || ac < 0) return;
      var best = -1, bd = 1e9;
      for (var i = 0; i < Sim.N; i++) {
        if (ws.owner[i] !== hc2 || ws.pop[i] <= 0 || foreignNeighbour(ws, i, hc2) !== ac) continue;
        var dd = md(i, ws.cCap[hc2]);
        if (dd < bd) { bd = dd; best = i; }
      }
      if (best >= 0) out.push({ key: k2, kind: 'war', t: w.dec * 10, pi: best, y0: w.dec * 10, y1: w.dec * 10 + 9, sig: hs, foe: w.a,
        title: 'The ' + civName(w.a) + ' war of the ' + w.dec * 10 + 's', text: 'In the ' + w.dec * 10 + 's the ' + civName(w.a) + ' take ' + w.n + ' provinces from your people. Their first blow falls on the border at (' + (best % W) + ', ' + ((best / W) | 0) + '). Be there.' });
    });
    // the Oracle's threads of fate: deeds that would save your people, at their exact time and place
    var orc = g.oracle;
    if (orc) orc.wins().forEach(function (r) {
      var k3 = 'thread:' + r.t + ':' + r.type;
      if (taken[k3] || (r.type !== 'assassinate' && r.type !== 'discord' && r.type !== 'rally' && r.type !== 'irrigate')) return;
      var tsig = r.type === 'assassinate' || r.type === 'discord' ? fs : hs;
      out.push({ key: k3, kind: 'thread', deed: r.type, t: r.t, pi: r.y * W + r.x, y0: Math.max(1, r.t - 2), y1: r.t + 3, sig: tsig,
        title: '◈ Thread of fate, ' + r.t, text: { assassinate: 'Kill the ruler of the ' + civName(tsig), discord: 'Burn the granaries of the ' + civName(tsig), rally: 'Defend the capital of the ' + civName(tsig), irrigate: 'Clear the way for the great canal of the ' + civName(tsig) }[r.type] +
          ' at (' + r.x + ', ' + r.y + ') between ' + Math.max(1, r.t - 2) + ' and ' + (r.t + 3) + '. The Chronoscope is certain: done then and there, your people survive.' });
    });
    out.sort(function (a, c) { return (a.kind === 'thread' ? -1000 : 0) + Math.abs(a.t - g.year) - ((c.kind === 'thread' ? -1000 : 0) + Math.abs(c.t - g.year)); });
    return out.slice(0, 6);
  }

  function takeEcho(ec) {
    var s = G().s, base = { giverKey: 'echo:' + ec.key, giverName: 'the Chronoscope', echoKey: ec.key, echo: { y0: ec.y0, y1: ec.y1 }, returnKey: null };
    var q;
    if (ec.kind === 'plague') {
      q = plagueQuest(ec.pi, base, 'The glass shows it: ' + esc(ec.text), { returnKey: null, title: ec.title, xp: 60 });
      q.enc[0].deeds = q.deeds; q.deeds = [];
    } else if (ec.kind === 'siege') {
      var fc = civBySig(s, ec.foe);
      q = make('siege', Object.assign({}, base, {
        title: ec.title, story: esc(ec.text),
        enc: [enc(ec.pi, { lx: L.C + 0.5, ly: L.C + 0.5, arrive: true, siege: true, ang: hpick(ec.pi, ec.t, 628) / 100, faction: ec.foe, arriveText: 'The ' + civName(ec.foe) + ' are at the gates. <b>Hold the walls!</b>',
          waves: [warband(s, fc, 3, false), warband(s, fc, 3, true), ['shield', 'soldier', 'bowman', 'captain']], label: 'Break the assault', deeds: [{ type: 'prophet', pi: ec.pi }] })],
        deeds: [], xp: 150, potions: 1
      }));
    } else if (ec.kind === 'laststand' || ec.kind === 'war' || (ec.kind === 'thread' && ec.deed === 'rally')) {
      var foeSig = ec.foe || G().goal && G().goal.foeSig || 0, fc2 = civBySig(s, foeSig);
      q = make('siege', Object.assign({}, base, {
        title: ec.title, story: esc(ec.text),
        enc: [enc(ec.pi, { lx: L.C + 0.5, ly: L.C + 0.5, arrive: true, siege: true, ang: hpick(ec.pi, ec.t, 628) / 100, faction: foeSig, arriveText: (foeSig ? 'The ' + civName(foeSig) : 'The enemy') + ' are here. <b>Hold!</b>',
          waves: [warband(s, fc2, 3, false), warband(s, fc2, 3, true), ['shield', 'soldier', 'bowman', 'captain']], label: 'Break the assault',
          deeds: ec.kind === 'war' ? [{ type: 'rally', pi: ec.pi }] : [{ type: 'rally', pi: ec.pi }, { type: 'prophet', pi: ec.pi }] })],
        deeds: [], xp: ec.kind === 'war' ? 110 : 160, potions: 1
      }));
    } else if (ec.kind === 'thread' && ec.deed === 'discord') {
      q = make('granaries', Object.assign({}, base, {
        title: ec.title, story: esc(ec.text),
        enc: [enc(ec.pi, { foes: ['guard', 'bowman', 'guard'], objs: ['granary', 'granary', 'granary'], faction: ec.sig, clear: 'objs', label: 'Burn the granaries', deeds: [{ type: 'discord', pi: ec.pi }] })],
        deeds: [], xp: 110
      }));
    } else if (ec.kind === 'thread' && ec.deed === 'irrigate') {
      q = make('canal', Object.assign({}, base, {
        title: ec.title, story: esc(ec.text),
        enc: [enc(ec.pi, { foes: ['bandit', 'archer', 'bandit', 'chief'], label: 'Clear the brigands', deeds: [{ type: 'irrigate', pi: ec.pi }] })],
        deeds: [], xp: 80
      }));
    } else if (ec.kind === 'thread') {
      q = make('regicide', Object.assign({}, base, {
        title: ec.title, story: esc(ec.text),
        enc: [enc(ec.pi, { lx: L.C + 1.5, ly: L.C + 0.5, foes: ['guard', 'shield', 'bowman', 'guard', 'ruler'], faction: ec.sig, clear: 'boss', label: 'Kill the ruler of the ' + civName(ec.sig), deeds: [{ type: 'assassinate', pi: ec.pi }] })],
        deeds: [], xp: 220, potions: 1
      }));
    } else {
      q = make('cradle', Object.assign({}, base, {
        title: ec.title, story: esc(ec.text),
        enc: [enc(ec.pi, { lx: L.C + 1.5, ly: L.C + 0.5, foes: ['guard', 'bowman', 'ruler'], faction: ec.sig, clear: 'boss', label: 'Kill the founder of the ' + civName(ec.sig), deeds: [{ type: 'assassinate', pi: ec.pi }] })],
        deeds: [], xp: 160, potions: 1
      }));
    }
    accept(q);
    return q;
  }
  /** A quest belongs to its years: echoes to the moment they echo, others to when you took them on. */
  var ERA_SPAN = 12;
  function windowOf(q) { return q.echo || q.era || null; }
  function inWindow(q) { var y = G().year, w = windowOf(q); return !w || (y >= w.y0 && y <= w.y1); }

  // ---------------------------------------------------------------------------
  // Describing and accepting
  // ---------------------------------------------------------------------------
  var DANGER = { plague: 1, camp: 1, codex: 1, trial: 1, teach: 0, settlers: 2, frontier: 2, canal: 2, siege: 3, beast: 3, rebels: 2, relic: 2, prophet: 2, exiles: 2,
    muster: 3, granaries: 3, salt: 3, wells: 4, regicide: 5, cradle: 3 };
  /** Recommended level: the quest's base danger, plus a little for foes from more advanced ages. */
  function recommended(q) {
    var base = DANGER[q.kind] || 1, s = G().s, age = 0;
    var encs = q.enc.concat(q.choices ? q.choices[0].enc : []);
    encs.forEach(function (e) {
      var c = e.faction ? civBySig(s, e.faction) : s.owner[e.pi];
      if (c >= 0) age = Math.max(age, Sim.ageOf(s.cTech[c]));
    });
    return base ? base + Math.max(0, Math.floor((age - 2) / 2)) : 0;
  }
  function deedList(q) {
    var deeds = [];
    var encs = q.choices ? [] : q.enc;
    encs.forEach(function (e) { e.deeds.forEach(function (d) { deeds.push(d); }); });
    if (q.escort) q.escort.deeds.forEach(function (d) { deeds.push(d); });
    q.deeds.forEach(function (d) { deeds.push(d); });
    var seen = {};
    return deeds.filter(function (d) { if (seen[d.type]) return false; seen[d.type] = 1; return true; });
  }
  function describe(q) {
    var lines = deedList(q).map(function (d) { return '<li>' + DEED_TEXT[d.type] + '</li>'; }).join('');
    var choices = q.choices ? '<div class="deedbox"><div class="dh">Choose a side:</div><ul>' + q.choices.map(function (c) {
      var ds = []; c.enc.forEach(function (e) { e.deeds.forEach(function (d) { ds.push(DEED_TEXT[d.type]); }); });
      return '<li><b>' + esc(c.label) + '</b>: ' + c.desc + '<br><span class="muted">' + ds.join('; ') + '</span></li>';
    }).join('') + '</ul></div>' : '';
    return '<p>' + q.story + '</p>' + choices +
      (lines ? '<div class="deedbox' + (q.dark ? ' dark' : '') + '"><div class="dh">If you succeed, history records:</div><ul>' + lines + '</ul></div>' : '') +
      (q.echo ? '<p class="obj">Only possible between the years ' + q.echo.y0 + ' and ' + q.echo.y1 + '.</p>' : '') +
      '<p class="reward">Reward: ' + q.xp + ' XP' + (q.potions ? ', ' + q.potions + ' potion' : '') + '</p>' + dangerLine(q);
  }

  function dangerLine(q) {
    var r = recommended(q);
    if (!r) return '';
    var lvl = R().level(), cls = lvl >= r ? 'ok' : lvl >= r - 1 ? 'warn' : 'bad';
    return '<p class="danger ' + cls + '">Danger: ' + '★★★★★'.slice(0, Math.min(5, r)) + ' · recommended level ' + r + (cls === 'bad' ? ' (you are level ' + lvl + ': this will likely kill you)' : cls === 'warn' ? ' (you are level ' + lvl + ')' : '') + '</p>';
  }

  function accept(q, choice) {
    var g = G();
    if (q.choices) {
      var ch = q.choices[choice || 0];
      q.enc = ch.enc;
      q.title = q.title + ': ' + ch.label.toLowerCase();
      q.choices = null;
    }
    q.id = nextId++;
    q.stage = 'go';
    q.year = g.year;
    if (!q.echo) q.era = { y0: g.year, y1: g.year + ERA_SPAN };
    g.quests.push(q);
    R().journal('Quest accepted: <b>' + esc(q.title) + '</b> (from ' + esc(q.giverName) + ').');
    if (q.instant) {
      R().passMonths(q.instant, 'teaching');
      complete(q);
      return;
    }
    if (q.escort) { startEscort(q); return; }
    if (!q.enc.length) { q.stage = 'return'; return; }
    // spawn encounters already in range
    q.enc.forEach(function (e, ei) {
      if (R().isActive(e.pi)) spawnEnc(q, e, ei);
      e.herbs.forEach(function (h) { if (R().isActive(h.pi)) spawnHerb(q, ei, h); });
    });
  }

  // ---------------------------------------------------------------------------
  // Escorts
  // ---------------------------------------------------------------------------
  function startEscort(q) {
    var es = q.escort, p = G().player;
    es.ids = [];
    if (es.from != null) { es.waiting = true; return; } // collect them first: they wait at their home
    spawnFollowers(q, p.x, p.y);
  }
  function spawnFollowers(q, x, y) {
    var es = q.escort;
    es.waiting = false;
    for (var k = 0; k < es.n; k++) {
      var a = R().spawnNear(es.kind, x + (k - 1) * 0.9, y + 1.2, { qid: q.id, name: es.n === 1 ? es.name : 'Exile', follow: true, prov: R().provOf(x, y) });
      if (a) es.ids.push(a.id);
    }
    R().toast(es.n === 1 ? '<b>' + esc(es.name) + '</b> will follow you. Keep her alive.' : 'The exiles gather their things and follow you. Keep them alive.');
  }
  function followers(q) { return G().actors.filter(function (a) { return a.qid === q.id && a.follow; }); }

  /** Called a few times a second: escorts arriving, echo windows opening. */
  function tick() {
    var g = G(), p = g.player, ppi = R().provOf(p.x, p.y);
    g.quests.slice().forEach(function (q) {
      if (q.stage === 'return' && inWindow(q)) {
        var gone = R().giverGone(q);
        if (gone) fail(q, gone);
        return;
      }
      if (q.stage !== 'go') return;
      if (q.escort) {
        var es = q.escort;
        if (es.waiting) { if (ppi === es.from) spawnFollowers(q, p.x, p.y); return; }
        var fl = followers(q);
        if (!fl.length) return;
        var c = R().provCenter(es.to);
        if (fl.some(function (a) { return Math.hypot(a.x - c.x, a.y - c.y) < 5; })) {
          fl.forEach(function (a) { a.follow = false; a.hx = a.x; a.hy = a.y; a.qid = 0; a.prov = es.to; });
          R().toast(es.kind === 'prophet' ? '<b>' + esc(es.name) + '</b> climbs the steps of the square and begins to speak. The crowd grows and grows.' : 'The exiles drop their bundles and look around at their new country.', 7000);
          es.deeds.forEach(function (d) { R().applyDeed(d.type, d.pi, d.v, q.title); });
          complete(q);
        }
        return;
      }
      if (windowOf(q) && inWindow(q)) {
        q.enc.forEach(function (e, ei) {
          if (e.done) return;
          if (R().isActive(e.pi) && !e.arrive) spawnEnc(q, e, ei);
          e.herbs.forEach(function (h) { if (R().isActive(h.pi)) spawnHerb(q, ei, h); });
          if (e.arrive && !e.arrived && ppi === e.pi) arrive(q, e, ei);
        });
      }
    });
  }

  /** Entering a province on an escort: maybe an ambush. */
  function ambush(pi) {
    var g = G(), s = g.s, p = g.player;
    g.quests.forEach(function (q) {
      if (q.stage !== 'go' || !q.escort || q.escort.waiting || pi === q.escort.to) return;
      q.escort.legs = (q.escort.legs || 0) + 1;
      if (q.escort.legs < 2 || hpick(pi, g.year + q.escort.legs, 100) > 35) return;
      var c = s.owner[pi], kinds = c >= 0 ? ['bandit', 'archer', 'bandit'] : [wild(s, pi), wild(s, pi), wild(s, pi)];
      if (q.kind === 'prophet' && c >= 0) kinds = ['rebel', 'rebel', 'archer'];
      var tc = R().provCenter(q.escort.to), ang = Math.atan2(tc.y - p.y, tc.x - p.x) + (hpick(pi, 5, 100) - 50) / 80;
      kinds.forEach(function (k, i) { var a = R().spawnNear(k, p.x + Math.cos(ang) * (6 + i * 0.6), p.y + Math.sin(ang) * (6 + i * 0.6), { prov: pi, hostile: true }); if (a) a.state = 'chase'; });
      R().toast(c >= 0 ? '<b>Ambush!</b> They are after ' + (q.escort.n === 1 ? esc(q.escort.name) : 'the exiles') + '.' : '<b>Beasts on the road!</b>');
    });
  }

  function onFollowerDeath(a) {
    var q = find(a.qid);
    if (!q || !q.escort) return;
    if (followers(q).length) { R().toast('One of the exiles has fallen.'); return; }
    fail(q, q.escort.n === 1 ? esc(q.escort.name) + ' is dead.' : 'The exiles are dead.');
  }
  function fail(q, why) {
    var g = G();
    q.stage = 'failed';
    g.quests.splice(g.quests.indexOf(q), 1);
    R().toast('<b>Quest failed:</b> ' + esc(q.title) + '. ' + why, 7000);
    R().journal('Quest failed: <b>' + esc(q.title) + '</b>. ' + why);
  }

  // ---------------------------------------------------------------------------
  // Encounters in the world
  // ---------------------------------------------------------------------------
  function spawnEnc(q, e, ei) {
    if (e.done || e.spawned || !inWindow(q)) return;
    if (e.arrive && !e.arrived) return;
    var px = (e.pi % W) * L.P, py = ((e.pi / W) | 0) * L.P;
    var cx = px + e.lx, cy = py + e.ly;
    if (e.arrive && !e.siege) { var p = G().player; cx = p.x; cy = p.y; }
    e.spawned = true;
    var opts = { qid: q.id, ei: ei, faction: e.faction, prov: e.pi, hostile: true, beastName: e.beastName };
    e.foes.forEach(function (kind, k) {
      var ang = k * 2.4 + 0.5, rr = e.arrive ? 6 : 1.2 + (k % 3) * 0.8, a;
      if (kind === 'ruler') { R().spawnAt(kind, cx, cy, opts); return; }
      if (e.siege) a = R().spawnNear(kind, cx + Math.cos(e.ang) * 7 + Math.cos(ang) * 1.2, cy + Math.sin(e.ang) * 7 + Math.sin(ang) * 1.2, opts);
      else a = R().spawnNear(kind, cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, opts);
      if (a && e.arrive) a.state = 'chase';
    });
    e.objs.forEach(function (kind, k) {
      var f = R().findFree(e.pi, [3, 8, 3, 8][k % 4], [8, 8, 3, 3][k % 4]);
      if (f) R().spawnAt(kind, f.x, f.y, opts);
    });
    if (e.ruins) {
      R().spawnDeco('ruins', cx - 1.2, cy - 1.4, { qid: q.id, prov: e.pi });
      R().spawnDeco('ruins', cx + 1.6, cy + 0.6, { qid: q.id, prov: e.pi });
    } else if (e.foes.length && !e.arrive && ['regicide', 'granaries', 'salt', 'wells', 'cradle', 'beast'].indexOf(q.kind) < 0) {
      R().spawnDeco('tent', cx + 1.4, cy - 1.2, { qid: q.id, prov: e.pi });
      R().spawnDeco('fire', cx, cy + 0.2, { qid: q.id, prov: e.pi });
    }
  }

  function spawnHerb(q, ei, h) {
    if (h.taken || h.spawned || !inWindow(q)) return;
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
        if (e.relicDropped && !e.relicTaken && e.pi === pi && !e.relicSpawned) dropRelic(q, e, ei);
      });
    });
  }
  /** Province pi left range: its encounters will respawn (with what is left) next time. */
  function despawned(pi) {
    G().quests.forEach(function (q) {
      q.enc.forEach(function (e) {
        if (e.pi === pi) { e.spawned = false; e.relicSpawned = false; }
        e.herbs.forEach(function (h) { if (h.pi === pi) h.spawned = false; });
      });
    });
  }
  function owns(e, pi) { return e.pi === pi || e.herbs.some(function (h) { return h.pi === pi; }); }

  function arrive(q, e, ei) {
    var p = G().player;
    e.arrived = true;
    e.foes = e.waves.shift();
    if (e.siege) R().toast(e.arriveText || '<b>Here they come!</b>', 6000);
    else {
      R().toast('Your settlers pitch their tents. <b>Something is moving in the dark.</b>');
      for (var k = 0; k < 3; k++) R().spawnNear('settler', p.x + (k - 1) * 1.2, p.y + 0.8, { prov: e.pi, qid: q.id, friendly: true });
    }
    spawnEnc(q, e, ei);
  }

  function enterProvince(pi) {
    G().quests.forEach(function (q) {
      if (q.stage !== 'go' || !inWindow(q)) return;
      q.enc.forEach(function (e, ei) {
        if (e.pi !== pi || !e.arrive || e.arrived || e.done) return;
        arrive(q, e, ei);
      });
    });
    ambush(pi);
  }

  function find(id) { var g = G(); for (var k = 0; k < g.quests.length; k++) if (g.quests[k].id === id) return g.quests[k]; return null; }

  function dropRelic(q, e, ei) {
    e.relicSpawned = true;
    R().spawnPickup('relic', (e.pi % W) * L.P + e.lx, ((e.pi / W) | 0) * L.P + e.ly, { qid: q.id, ei: ei, prov: e.pi });
  }

  function onKill(a) {
    var q = find(a.qid);
    if (!q || q.stage !== 'go') return;
    var e = q.enc[a.ei];
    if (!e || e.done) return;
    var list = a.obj ? e.objs : e.foes, k = list.indexOf(a.kind);
    if (k >= 0) list.splice(k, 1);
    if (a.kind === 'ruler' || a.kind === 'greatbeast') e.bossDead = true;
    if (a.kind === 'thief') { R().spawnPickup('codex', a.x, a.y, { qid: q.id, ei: a.ei }); e.needCodex = true; }
    if (e.relic && !e.relicDropped && !e.foes.length) {
      e.relicDropped = true; e.needRelic = true;
      dropRelic(q, e, a.ei);
      R().toast('The last guardian falls. Among the stones, something glints.');
    }
    if (e.arrive && !e.foes.length && e.waves && e.waves.length) {
      e.foes = e.waves.shift();
      e.spawned = false;
      R().toast(e.siege ? 'Another wave comes on! (' + (e.waves.length + 1) + ' left)' : 'More of them come out of the dark!');
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
    if (pk.kind === 'relic') { e.needRelic = false; e.relicTaken = true; R().toast('You lift a stack of clay tablets, covered edge to edge in writing.'); }
    check(q, e);
  }

  function cleared(e) {
    var herbsLeft = e.herbs.some(function (h) { return !h.taken; });
    if (e.clear === 'boss') return !!e.bossDead;
    if (e.clear === 'objs') return !e.objs.length;
    return !e.foes.length && !e.objs.length && !herbsLeft && !e.needCodex && !e.needRelic && (!e.relic || e.relicTaken) && (!e.waves || !e.waves.length);
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
    var i = g.quests.indexOf(q);
    if (i >= 0) g.quests.splice(i, 1);
    if (q.echoKey) (g.echoesDone = g.echoesDone || []).push(q.echoKey);
    g.questsDone.push({ title: q.title, year: g.year, kind: q.kind });
    R().reward(q.xp, q.potions);
    R().journal('Quest complete: <b>' + esc(q.title) + '</b>.');
    R().onQuestDone(q);
  }

  /** Talking to someone: hand in any quest they are waiting on. */
  function turnIn(npc) {
    var g = G();
    for (var k = 0; k < g.quests.length; k++) {
      var q = g.quests[k];
      if (q.stage === 'return' && q.returnKey === npc.key && inWindow(q)) { complete(q); return q; }
    }
    return null;
  }
  function waitingOn(npc) {
    return G().quests.filter(function (q) { return (q.returnKey === npc.key || q.giverKey === npc.key) && inWindow(q); })[0] || null;
  }

  function objectives() {
    var out = [], g = G(), p = g.player, ppi = R().provOf(p.x, p.y);
    g.quests.forEach(function (q) {
      if (!inWindow(q)) {
        var w = windowOf(q), span = w.y0 + (w.y1 !== w.y0 ? '–' + w.y1 : '');
        var what = q.echo ? 'Travel to ' + span : q.stage === 'return' ? 'Travel back to ' + span + ' to turn it in to ' + q.returnName : 'Travel back to ' + span + ' to finish it';
        out.push({ q: q, text: what + ' (T)', pi: q.stage === 'return' ? R().returnPi(q) : q.enc[0] ? q.enc[0].pi : q.escort ? q.escort.to : -1, dormant: true });
        return;
      }
      if (q.stage === 'return') { out.push({ q: q, text: 'Return to ' + q.returnName, pi: R().returnPi(q) }); return; }
      if (q.escort) {
        var es = q.escort;
        if (es.waiting) out.push({ q: q, text: 'Find ' + es.name, pi: es.from });
        else {
          var hp = followers(q).map(function (a) { return Math.ceil(a.hp / a.maxHp * 100) + '%'; }).join(', ');
          out.push({ q: q, text: 'Escort ' + (es.n === 1 ? es.name : 'the exiles') + ' (' + hp + ')', pi: es.to });
        }
        return;
      }
      for (var k = 0; k < q.enc.length; k++) {
        var e = q.enc[k];
        if (e.done) continue;
        if (e.herbs.length) {
          var left = e.herbs.filter(function (h) { return !h.taken; });
          left.sort(function (a, b) { return md(a.pi, ppi) - md(b.pi, ppi); });
          out.push({ q: q, text: 'Gather moonwort (' + (e.herbs.length - left.length) + '/' + e.herbs.length + ')', pi: left.length ? left[0].pi : e.pi, x: left[0] && left[0].x, y: left[0] && left[0].y });
        } else {
          var objName = e.objs.length ? (e.objs[0] === 'well' ? 'wells' : e.objs[0] === 'storehouse' ? 'storehouses' : 'granaries') : '';
          var n = e.clear === 'objs' ? e.objs.length + ' ' + objName + ' left' : e.clear === 'boss' ? '' : e.needCodex ? 'pick up the codex' : e.needRelic ? 'take the tablets' :
            e.arrive && !e.arrived ? (e.siege ? 'wait in the village' : 'lead them there') : (e.foes.length + (e.waves ? e.waves.reduce(function (a, w) { return a + w.length; }, 0) : 0)) + ' left';
          out.push({ q: q, text: e.label + (n ? ' (' + n + ')' : ''), pi: e.pi });
        }
        break;
      }
    });
    return out;
  }

  /**
   * Travelling in time keeps your quests: each waits in its own years. Only an escort already on
   * the road is lost (the people you were leading stay behind). A new bearer forgets everything.
   */
  function abandonAll(why, travelling) {
    var g = G();
    var keep = g.quests.filter(function (q) { return travelling && !(q.escort && !q.escort.waiting); });
    g.quests.forEach(function (q) {
      if (keep.indexOf(q) >= 0) return;
      var reason = travelling ? 'you left ' + (q.escort.n === 1 ? q.escort.name : 'the exiles') + ' behind in ' + g.year : why;
      R().journal('Quest abandoned: ' + esc(q.title) + (reason ? ' (' + esc(reason) + ')' : '') + '.');
      if (travelling) R().toast('<b>' + esc(q.title) + '</b> is lost: ' + esc(reason) + '.', 6000);
    });
    keep.forEach(function (q) {
      q.enc.forEach(function (e) {
        e.spawned = false; e.relicSpawned = false;
        if (e.arrive && !e.done && e.arrived) { e.arrived = false; if (e.foes.length && e.waves) { e.waves.unshift(e.foes); e.foes = []; } }
        e.herbs.forEach(function (h) { h.spawned = false; });
      });
    });
    g.quests = keep;
  }

  root.Quests = {
    DEED_TEXT: DEED_TEXT, offersFor: offersFor, describe: describe, accept: accept, spawnFor: spawnFor, despawned: despawned,
    enterProvince: enterProvince, onKill: onKill, onPickup: onPickup, turnIn: turnIn, waitingOn: waitingOn, objectives: objectives,
    abandonAll: abandonAll, make: make, enc: enc, warband: warband, around: around, owns: owns,
    tick: tick, echoes: echoes, takeEcho: takeEcho, onFollowerDeath: onFollowerDeath, inWindow: inWindow, windowOf: windowOf, ERA_SPAN: ERA_SPAN
  };
}(this));
