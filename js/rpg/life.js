/*
 * Chronoscope: Wayfarer: village life.
 *
 * Villagers do the work that makes the history the simulation records. Each province gets an
 * outlook from the timeline itself, read now and one and three years ahead:
 *   - houses that will stand next year are being raised now, on the very tiles where they will
 *     appear (and families pack up where a village will shrink);
 *   - farmers hoe, reap and carry sheaves while the soil feeds them; when it is spent and famine is
 *     coming they say so, and in a famine the fields lie dead and people forage in the woods;
 *   - a realm about to reach a new age rebuilds; plague brings the sick to their doorsteps and
 *     neighbours carrying water; war brings drilling on the green, and a conquest that is coming
 *     brings stakes dug in on the side the enemy will come from;
 *   - strong solidarity brings festivals; weak solidarity, quarrels.
 * Their talk, overheard, is about the same things. Everything here is snapshotted for the short
 * rewind (G), so turning back a few seconds turns back their work too.
 */
(function (root) {
  'use strict';
  var Sim = root.Sim, L = root.Local, W = Sim.W, H = Sim.H, N = Sim.N, P = L.P, C = L.C, T = L.T, D = L.D;
  var host = null;
  function init(h) { host = h; outlooks = {}; placeCache = {}; }
  function G() { return host.G; }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function hsh(a, k) { return Sim.hash4(a.id, k, 3, 977); }
  var DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];

  // ---------------------------------------------------------------------------
  // What the timeline holds for a province
  // ---------------------------------------------------------------------------
  var outlooks = {};
  function sigOf(s, pi) { var c = s.owner[pi]; return c >= 0 ? s.cSig[c] : 0; }
  function outlook(pi) {
    var g = G(), key = g.ver + ':' + g.year, o = outlooks[pi];
    if (o && o.key === key) return o;
    var s = g.s, c = s.owner[pi], sig = sigOf(s, pi), dyn = L.getDyn(s, pi, g.ver), bx = (pi % W) * P, by = ((pi / W) | 0) * P;
    o = { key: key, pi: pi, sig: sig, age: dyn.age, build: [], leave: 0, starveNow: !!s.starve[pi], plagueNow: !!s.plague[pi], foes: [], stakes: [], work: {} };
    // next year
    var s1 = host.future(1), sig1 = sigOf(s1, pi), k1 = L.dynKey(s1, pi), d1 = k1 === dyn.key ? dyn : L.buildDyn(s1, pi, k1);
    if (sig1 === sig && sig) {
      d1.houses.forEach(function (h) {
        if (dyn.houses.some(function (q) { return q.lx === h.lx && q.ly === h.ly; })) return;
        if (L.isSolid(s, bx + h.lx, by + h.ly, g.ver, true)) return;
        o.build.push({ x: bx + h.lx + 0.5, y: by + h.ly + 0.5, lx: h.lx, ly: h.ly });
      });
      o.leave = Math.max(0, dyn.houses.length - d1.houses.length);
      var c1 = s1.owner[pi];
      o.ageUp = c1 >= 0 && Sim.ageOf(s1.cTech[c1]) > dyn.age;
    }
    o.starveNext = !o.starveNow && !!s1.starve[pi];
    o.plagueNext = !o.plagueNow && !!s1.plague[pi];
    o.popNext = s1.pop[pi] - s.pop[pi];
    o.soilTired = s.base[pi] > 0 && s.soil[pi] < s.base[pi] * 0.55;
    o.takenNext = sig && sig1 && sig1 !== sig ? sig1 : 0;
    // three years on
    var s3 = host.future(3), sig3 = sigOf(s3, pi);
    o.takenBy = o.takenNext || (sig && sig3 && sig3 !== sig ? sig3 : 0);
    // a new age within three years: people are already rebuilding the new way
    var c3 = s3.owner[pi];
    if (!o.ageUp && sig3 === sig && c3 >= 0 && Sim.ageOf(s3.cTech[c3]) > dyn.age) o.ageUp = true;
    // neighbours: war, plague
    var px = pi % W, py = (pi / W) | 0, seen = {};
    o.plagueNear = false;
    for (var dy = -3; dy <= 3; dy++) for (var dx = -3; dx <= 3; dx++) {
      var qx = px + dx, qy = py + dy;
      if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
      var j = qy * W + qx, sj = sigOf(s, j);
      if (s.plague[j] && Math.abs(dx) + Math.abs(dy) <= 3 && j !== pi) o.plagueNear = true;
      if (!sj || sj === sig || seen[sj] || !sig) continue;
      seen[sj] = 1;
      if (host.relation(sig, sj) === 'war') o.foes.push({ sig: sj, dx: dx, dy: dy });
    }
    o.asab = c >= 0 ? Sim.meanAsab(s, c) : 0;
    // where the stakes go: on the side the conqueror (or the nearest enemy) will come from
    var threat = o.takenBy && host.relation(sig, o.takenBy) === 'war' ? o.foes.filter(function (f) { return f.sig === o.takenBy; })[0] : null;
    if (threat) {
      var ang = Math.atan2(threat.dy, threat.dx), ex = Math.round(C + Math.cos(ang) * 4.5), ey = Math.round(C + Math.sin(ang) * 4.5);
      for (var k = -2; k <= 2; k++) {
        var sx = ex + Math.round(-Math.sin(ang) * k), sy = ey + Math.round(Math.cos(ang) * k);
        if (sx < 0 || sy < 0 || sx >= P || sy >= P || L.isSolid(s, bx + sx, by + sy, g.ver, true)) continue;
        o.stakes.push({ x: bx + sx + 0.5, y: by + sy + 0.5 });
      }
      o.threat = threat;
    }
    o.festival = o.asab > 6000 && !o.starveNow && !o.plagueNow && !o.foes.length && (g.month === 5 || g.month === 7);
    outlooks[pi] = o;
    return o;
  }
  /** How far along the year's building is (0..1): the months that have passed, and the hammering you have seen. */
  function siteProgress(o, i) { return Math.min(0.97, G().month / 12 * 0.85 + (o.work['b' + i] || 0) / 120); }
  function stakesUp(o) { return Math.min(o.stakes.length, Math.floor(G().month / 12 * o.stakes.length + (o.work.stakes || 0) / 20)); }

  // ---------------------------------------------------------------------------
  // Places to work, in a province
  // ---------------------------------------------------------------------------
  var placeCache = {};
  function places(pi) {
    var g = G(), s = g.s, key = g.ver, c = placeCache[pi];
    if (c && c.key === key) return c;
    var dyn = L.getDyn(s, pi, g.ver), bx = (pi % W) * P, by = ((pi / W) | 0) * P, st = L.staticTiles(s, pi);
    var free = function (x, y) { return !L.isSolid(s, x, y, g.ver, true) && L.tileAt(s, x, y) !== T.STREAM; };
    var hub = dyn.hub || { x: C, y: C };
    c = { key: key, fields: [], trees: [], water: [], doors: [], hub: { x: bx + hub.x + 0.5, y: by + hub.y + 0.5 } };
    for (var ly = 0; ly < P; ly++) for (var lx = 0; lx < P; lx++) {
      var i = ly * P + lx, gx = bx + lx, gy = by + ly, d = dyn.deco[i], t = st[i], k, nx, ny;
      if ((d === D.FIELD || d === D.DEADFIELD) && free(gx, gy)) c.fields.push({ x: gx + 0.5, y: gy + 0.5, fx: gx + 0.5, fy: gy + 1.5 });
      if (t === T.TREE || t === T.PINE) {
        for (k = 0; k < 4; k++) { nx = gx + DX[k]; ny = gy + DY[k]; if (free(nx, ny)) { c.trees.push({ x: nx + 0.5, y: ny + 0.5, fx: gx + 0.5, fy: gy + 0.5 }); break; } }
      }
      if (t === T.STREAM || t === T.SHALLOW) {
        for (k = 0; k < 4; k++) { nx = gx + DX[k]; ny = gy + DY[k]; if (free(nx, ny) && !L.WATER[L.tileAt(s, nx, ny)]) { c.water.push({ x: nx + 0.5, y: ny + 0.5, fx: gx + 0.5, fy: gy + 0.5 }); break; } }
      }
    }
    dyn.houses.forEach(function (h) {
      var gx = bx + h.lx, gy = by + h.ly;
      if (free(gx, gy + 1)) c.doors.push({ x: gx + 0.5, y: gy + 1.5, fx: gx + 0.5, fy: gy + 0.5 });
    });
    placeCache[pi] = c;
    return c;
  }
  function pickNear(list, a, spread) {
    if (!list.length) return null;
    var best = null, bd = Infinity;
    for (var k = 0; k < 6; k++) {
      var c = list[(Math.random() * list.length) | 0], d = Math.hypot(c.x - a.x, c.y - a.y) + Math.random() * (spread || 4);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  function freeNear(x, y, avoid) {
    var g = G(), tx = Math.floor(x), ty = Math.floor(y);
    for (var r = 0; r <= 3; r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var cx = tx + dx, cy = ty + dy;
      if (avoid && avoid.some(function (q) { return Math.floor(q.x) === cx && Math.floor(q.y) === cy; })) continue;
      if (!L.isSolid(g.s, cx, cy, g.ver, true) && L.tileAt(g.s, cx, cy) !== T.STREAM) return { x: cx + 0.5, y: cy + 0.5 };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Paths: a small breadth-first search round houses, trees and water, then pulled straight
  // ---------------------------------------------------------------------------
  function solidAt(x, y) { var g = G(); return L.isSolid(g.s, Math.floor(x), Math.floor(y), g.ver, true); }
  function clearLine(x0, y0, x1, y1) {
    var d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 0.2);
    for (var k = 1; k <= n; k++) {
      var x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n;
      if (solidAt(x - 0.28, y - 0.28) || solidAt(x + 0.28, y - 0.28) || solidAt(x - 0.28, y + 0.28) || solidAt(x + 0.28, y + 0.28)) return false;
    }
    return true;
  }
  function findPath(a, tx, ty) {
    var g = G(), s = g.s, pi = a.prov, x0 = (pi % W) * P - 5, y0 = ((pi / W) | 0) * P - 5, w = P + 10;
    var sx = Math.floor(a.x) - x0, sy = Math.floor(a.y) - y0, gx = Math.floor(tx) - x0, gy = Math.floor(ty) - y0;
    if (sx < 0 || sy < 0 || sx >= w || sy >= w || gx < 0 || gy < 0 || gx >= w || gy >= w) return null;
    var prev = new Int16Array(w * w).fill(-1), start = sy * w + sx, goal = gy * w + gx, q = [start];
    prev[start] = start;
    for (var qi = 0; qi < q.length && prev[goal] < 0; qi++) {
      var cur = q[qi], cx = cur % w, cy = (cur / w) | 0;
      for (var k = 0; k < 4; k++) {
        var nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= w) continue;
        var ni = ny * w + nx;
        if (prev[ni] >= 0) continue;
        if (ni !== goal && L.isSolid(s, nx + x0, ny + y0, g.ver, true)) continue;
        prev[ni] = cur; q.push(ni);
      }
    }
    if (prev[goal] < 0) return null;
    var raw = [], n = goal;
    while (n !== start) { raw.push({ x: n % w + x0 + 0.5, y: ((n / w) | 0) + y0 + 0.5 }); n = prev[n]; }
    raw.reverse();
    raw[raw.length - 1] = { x: tx, y: ty };
    // pull the string: keep only the corners we cannot see past
    var out = [], fx = a.x, fy = a.y, i = 0;
    while (i < raw.length) {
      var j = raw.length - 1;
      while (j > i && !clearLine(fx, fy, raw[j].x, raw[j].y)) j--;
      out.push(raw[j]); fx = raw[j].x; fy = raw[j].y; i = j + 1;
    }
    return out;
  }
  /** Walk the task's path. true: arrived; false: on the way; null: cannot get there. */
  function walk(a, t, dt) {
    if (!t.path) { t.path = findPath(a, t.x, t.y); t.pi = 0; if (!t.path) return null; }
    var wp = t.path[t.pi];
    if (!wp) return true;
    var d = Math.hypot(wp.x - a.x, wp.y - a.y);
    if (d < 0.12) { t.pi++; return t.pi >= t.path.length; }
    var sp = a.speed * (a.carry ? 0.85 : 1) * (t.hurry ? 1.6 : 1), m = host.steer(a, wp.x, wp.y, sp, dt);
    a.wx = wp.x; a.wy = wp.y;
    if (m > 0.001) { a.face = Math.atan2(wp.y - a.y, wp.x - a.x); a.walkT += sp * dt * 3; }
    if (m < sp * dt * 0.25) { t.stuck = (t.stuck || 0) + dt; if (t.stuck > 1.2) { t.stuck = 0; t.path = null; if (++t.repath > 2) return null; } }
    else t.stuck = 0;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Choosing work
  // ---------------------------------------------------------------------------
  var TRADES = ['farmer', 'farmer', 'woodcutter', 'water', 'home', 'farmer', 'woodcutter', 'home'];
  function trade(a) { return a.trade || (a.trade = TRADES[hsh(a, 1) % TRADES.length]); }
  function isSick(a, o) { return o.plagueNow && hsh(a, 2) % 3 === 0; }
  function isLeaving(a, o) {
    if (!o.leave) return false;
    var mine = G().actors.filter(function (b) { return b.role === 'villager' && b.prov === a.prov; }).sort(function (x, y) { return hsh(x, 4) - hsh(y, 4); });
    return mine.indexOf(a) < o.leave;
  }
  function task(kind, at, extra) {
    var t = { kind: kind, x: at.x, y: at.y, fx: at.fx != null ? at.fx : at.x, fy: at.fy != null ? at.fy : at.y + 1, phase: 'go', path: null, repath: 0, dur: 6 };
    for (var k in extra) t[k] = extra[k];
    return t;
  }
  function choose(a) {
    var g = G(), o = outlook(a.prov), pl = places(a.prov), m = g.month, tr = trade(a);
    var winter = m >= 10 || m <= 1, harvest = m >= 7 && m <= 9, home = pl.doors.length ? pl.doors[hsh(a, 3) % pl.doors.length] : null;
    a.home = home;
    if (isSick(a, o) && home) return task('sick', home, { dur: rnd(8, 14), anim: 'sick' });
    if (isLeaving(a, o) && !a.left) return leaveTask(a);
    var low = o.asab < 2000, work = low ? 0.6 : 1, w = {};
    var hasFields = pl.fields.length && !o.starveNow;
    w.farm = hasFields && !winter ? (tr === 'farmer' ? 45 : 6) * work * (o.starveNext ? 1.4 : 1) : 0;
    w.forage = o.starveNow && pl.trees.length ? 40 : 0;
    w.glean = o.starveNow && pl.fields.length ? 30 : 0;
    w.tend = o.plagueNow && pl.doors.length ? 22 : 0;
    w.wood = pl.trees.length ? ((tr === 'woodcutter' ? 35 : 4) + (winter ? 14 : 0) + (o.build.length ? 20 : 0)) * work : 0;
    w.build = o.build.length ? (o.asab > 6000 ? 40 : 28) * work : 0;
    w.rebuild = o.ageUp && pl.doors.length ? 22 * work : 0;
    w.water = pl.water.length && (home || o.plagueNow) ? ((tr === 'water' ? 35 : 5) + (o.plagueNow ? 15 : 0)) * work : 0;
    w.sweep = home ? (tr === 'home' ? 30 : 8) : 0;
    w.drill = o.foes.length && tr !== 'farmer' ? 18 : 0;
    w.fortify = o.stakes.length ? 26 : 0;
    w.chat = o.plagueNow ? 2 : a.lastKind === 'chat' ? 1 : 4 + (low ? 4 : 0);
    w.dance = o.festival ? 60 : 0;
    w.stroll = 5;
    var tot = 0, k;
    for (k in w) tot += w[k];
    var r = Math.random() * tot;
    for (k in w) { r -= w[k]; if (r <= 0) break; }
    var t = make(a, k, o, pl, harvest);
    return t || (pl.hub ? task('stroll', freeNear(pl.hub.x + rnd(-2, 2), pl.hub.y + rnd(-2, 2)) || pl.hub, { dur: rnd(3, 6), anim: 'look' }) : null);
  }
  function make(a, kind, o, pl, harvest) {
    var spot, i;
    switch (kind) {
      case 'farm':
        spot = pickNear(pl.fields, a, 6);
        return spot && task(harvest ? 'reap' : 'farm', spot, { dur: rnd(6, 10), anim: harvest ? 'reap' : 'hoe', carry: harvest ? 'sheaf' : null, fy: spot.y + 0.5, fx: spot.x + (Math.random() < 0.5 ? 1 : -1) });
      case 'forage':
        spot = pickNear(pl.trees, a, 6);
        return spot && task('forage', spot, { dur: rnd(4, 7), anim: 'gather', carry: 'basket' });
      case 'glean':
        // picking over the dead fields for anything the famine left
        spot = pickNear(pl.fields, a, 6);
        return spot && task('glean', spot, { dur: rnd(5, 9), anim: 'gather', fy: spot.y + 0.5 });
      case 'tend': {
        var ill = G().actors.filter(function (b) { return b.prov === a.prov && b !== a && b.task && b.task.kind === 'sick' && b.task.phase === 'work'; });
        if (!ill.length) return null;
        var who = ill[(Math.random() * ill.length) | 0];
        spot = freeNear(who.x + 1, who.y);
        return spot && task('tend', spot, { dur: rnd(5, 8), anim: 'gather', fx: who.x, fy: who.y, patient: who });
      }
      case 'wood':
        spot = pickNear(pl.trees, a, 5);
        return spot && task('wood', spot, { dur: rnd(5, 8), anim: 'chop', carry: 'log', toSite: o.build.length > 0 });
      case 'build':
        i = (Math.random() * o.build.length) | 0;
        spot = freeNear(o.build[i].x, o.build[i].y + 1, o.build);
        return spot && task('build', spot, { dur: rnd(7, 12), anim: 'hammer', site: i, fx: o.build[i].x, fy: o.build[i].y });
      case 'rebuild':
        spot = pickNear(pl.doors, a, 6);
        return spot && task('rebuild', spot, { dur: rnd(6, 10), anim: 'hammer' });
      case 'water':
        spot = pickNear(pl.water, a, 4);
        var sick = o.plagueNow ? G().actors.filter(function (b) { return b.prov === a.prov && b.task && b.task.kind === 'sick'; }) : [];
        var to = sick.length ? sick[(Math.random() * sick.length) | 0].task : a.home;
        return spot && to && task('water', spot, { dur: rnd(2.5, 4), anim: 'draw', carry: 'bucket', dest: { x: to.x, y: to.y, fx: to.fx, fy: to.fy }, tend: sick.length > 0 });
      case 'sweep':
        return a.home && task('sweep', a.home, { dur: rnd(6, 12), anim: 'sweep', fy: a.home.y + 1 });
      case 'drill': {
        var f = o.foes[0], ang = Math.atan2(f.dy, f.dx), n = hsh(a, 5) % 4;
        spot = freeNear(pl.hub.x - Math.sin(ang) * (n - 1.5), pl.hub.y + Math.cos(ang) * (n - 1.5));
        return spot && task('drill', spot, { dur: rnd(8, 12), anim: 'drill', fx: spot.x + Math.cos(ang) * 3, fy: spot.y + Math.sin(ang) * 3 });
      }
      case 'fortify':
        i = Math.min(o.stakes.length - 1, stakesUp(o));
        spot = freeNear(o.stakes[i].x, o.stakes[i].y, o.stakes);
        return spot && task('fortify', spot, { dur: rnd(6, 10), anim: 'dig', fx: o.stakes[i].x, fy: o.stakes[i].y });
      case 'chat': return chatTask(a, pl);
      case 'dance': {
        var ring = hsh(a, 6) % 8 / 8 * 6.283;
        spot = freeNear(pl.hub.x + Math.cos(ring) * 1.6, pl.hub.y + Math.sin(ring) * 1.2);
        return spot && task('dance', spot, { dur: rnd(10, 16), anim: 'dance', fx: pl.hub.x, fy: pl.hub.y });
      }
    }
    return null;
  }
  function leaveTask(a) {
    var g = G(), pi = a.prov, bx = (pi % W) * P, by = ((pi / W) | 0) * P, e = hsh(a, 7) % 4;
    var ex = e === 0 ? bx + P - 1 : e === 1 ? bx : bx + C, ey = e === 2 ? by + P - 1 : e === 3 ? by : by + C;
    var spot = freeNear(ex + 0.5, ey + 0.5);
    a.carry = 'bundle';
    return spot && task('leave', spot, { dur: 0.1, anim: null });
  }
  function chatTask(a, pl) {
    var g = G(), best = null, bd = 10;
    g.actors.forEach(function (b) {
      if (b === a || b.role !== 'villager' || b.prov !== a.prov || b.fleeT > 0 || b.carry) return;
      if (b.task && b.task.kind !== 'stroll' && b.task.kind !== 'sweep') return;
      var d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < bd) { bd = d; best = b; }
    });
    if (!best) return null;
    var mx = (a.x + best.x) / 2, my = (a.y + best.y) / 2;
    if (Math.hypot(mx - pl.hub.x, my - pl.hub.y) > 4) { mx = pl.hub.x + rnd(-1.5, 1.5); my = pl.hub.y + rnd(-1.5, 1.5); }
    var sa = freeNear(mx, my), sb = sa && freeNear(sa.x + 1.1, sa.y, [sa]);
    if (!sa || !sb) return null;
    var meet = { A: a, B: best, turn: 0, turnT: 0.6, left: rnd(7, 11), topic: null };
    best.task = task('chat', sb, { meet: meet, fx: sa.x, fy: sa.y, dur: 99 });
    best.idleT = 0;
    return task('chat', sa, { meet: meet, lead: true, fx: sb.x, fy: sb.y, dur: 99 });
  }

  // ---------------------------------------------------------------------------
  // The day: walk there, work, carry the work home
  // ---------------------------------------------------------------------------
  function finish(a, rest) {
    if (a.task) a.lastKind = a.task.kind;
    a.task = null; a.anim = null; a.idleT = rest; a.wx = a.x; a.wy = a.y;
  }
  function bubble(a, icon, t) { a.bubble = { icon: icon, t: t || 1.6 }; }
  function update(a, dt, d) {
    if (!host || a.role !== 'villager') return false;
    var g = G(), p = g.player;
    a.lifeT = (a.lifeT || 0) + dt;
    if (a.bubble && (a.bubble.t -= dt) <= 0) a.bubble = null;
    if (a.say && (a.say.t -= dt) <= 0) a.say = null;
    a.greetT = (a.greetT || rnd(2, 8)) - dt;
    var t = a.task;
    // you, passing by: a wave if you look like one of them, a wary look if not
    if (!p.dead && d < 3.2 && d > 0.9 && a.greetT <= 0 && !(t && t.kind === 'chat' && t.phase === 'work') && !g.modal) {
      a.greetT = rnd(25, 45);
      var dr = host.Gear.dress(a.prov), sus = p.suspicion || 0;
      if (sus >= host.Gear.SUSPECT) { bubble(a, 'bang', 2); a.waveT = 0.6; }
      else if (dr >= 2) { bubble(a, 'ask', 2); a.waveT = 0.8; }
      else { bubble(a, 'wave', 1.4); a.waveT = 1.2; }
    }
    if (a.waveT > 0) { a.waveT -= dt; a.face = Math.atan2(p.y - a.y, p.x - a.x); a.anim = a.bubble && a.bubble.icon === 'wave' ? 'wave' : null; a.wx = a.x; a.wy = a.y; return true; }
    // standing right in someone's way: they stop and look at you
    if (d < 1.3 && !p.dead && t && t.phase !== 'work') { a.face = Math.atan2(p.y - a.y, p.x - a.x); a.anim = null; a.wx = a.x; a.wy = a.y; return true; }
    if (!t) {
      a.idleT = (a.idleT || 0) - dt;
      a.anim = null; a.wx = a.x; a.wy = a.y;
      if (a.idleT > 0) return true;
      a.task = t = choose(a);
      if (!t) { a.idleT = rnd(1, 3); return true; }
    }
    var o = outlook(a.prov);
    if (t.phase === 'go' || t.phase === 'carry') {
      a.anim = null;
      var r = walk(a, t, dt);
      if (r === null) { if (t.meet) endChat(t.meet); a.carry = t.kind === 'leave' ? a.carry : null; finish(a, rnd(1, 3)); return true; }
      if (!r) return true;
      a.wx = a.x; a.wy = a.y;
      if (t.phase === 'carry') {
        // delivered: logs to the building site or the woodpile, water to the sick, sheaves home
        if (t.kind === 'wood' && t.site != null) o.work['b' + t.site] = (o.work['b' + t.site] || 0) + 6;
        if (t.tend) bubble(a, 'heart', 1.5);
        a.carry = null; finish(a, rnd(0.6, 2));
        return true;
      }
      if (t.kind === 'leave') {
        // a family leaves for good: the simulation says this village shrinks next year
        a.left = true;
        host.addEffect({ type: 'puff', x: a.x, y: a.y, life: 0.5, color: 'rgba(220,220,220,0.8)' });
        var i = g.actors.indexOf(a);
        if (i >= 0) g.actors.splice(i, 1);
        return true;
      }
      t.phase = 'work'; t.t = t.dur; t.tick = 0;
    }
    // working
    a.face = Math.atan2(t.fy - a.y, t.fx - a.x);
    a.anim = t.anim;
    t.t -= dt; t.tick += dt;
    switch (t.kind) {
      case 'wood':
        if (t.tick > 0.7) { t.tick = 0; host.addEffect({ type: 'puff', x: t.fx, y: t.fy + 0.3, life: 0.35, color: 'rgba(214,170,110,0.95)' }); }
        break;
      case 'build': case 'rebuild':
        if (t.tick > 0.45) { t.tick = 0; if (t.site != null) o.work['b' + t.site] = (o.work['b' + t.site] || 0) + 0.45; if (Math.random() < 0.3) host.addEffect({ type: 'puff', x: t.fx, y: t.fy, life: 0.25, color: 'rgba(230,220,190,0.9)' }); }
        break;
      case 'fortify':
        if (t.tick > 0.8) { t.tick = 0; o.work.stakes = (o.work.stakes || 0) + 0.8; host.addEffect({ type: 'puff', x: t.fx, y: t.fy + 0.2, life: 0.35, color: 'rgba(120,90,60,0.9)' }); }
        break;
      case 'farm': case 'reap':
        if (t.tick > 1.2) { t.tick = 0; host.addEffect({ type: 'puff', x: a.x + Math.cos(a.face) * 0.5, y: a.y + Math.sin(a.face) * 0.5, life: 0.3, color: t.kind === 'reap' ? 'rgba(230,200,90,0.9)' : 'rgba(110,80,50,0.9)' }); }
        break;
      case 'sick':
        if (t.tick > 2.2) { t.tick = 0; bubble(a, 'cough', 1); }
        break;
      case 'tend':
        if (t.tick > 2) { t.tick = 0; bubble(a, 'heart', 1.2); }
        break;
      case 'glean':
        if (t.tick > 2.5) { t.tick = 0; if (Math.random() < 0.4) bubble(a, 'dots', 1.2); }
        break;
      case 'dance':
        if (t.tick > 2.5) { t.tick = 0; if (Math.random() < 0.6) bubble(a, 'note', 1.2); }
        break;
      case 'chat': chat(a, t, dt, d); return true;
    }
    if (t.t <= 0) {
      if (t.carry) {
        // carry the work somewhere it matters
        var dest = t.dest || (t.toSite && o.build.length ? (function () { var si = (Math.random() * o.build.length) | 0; t.site = si; return freeNear(o.build[si].x, o.build[si].y + 1, o.build); })() : a.home);
        if (!dest) { finish(a, 1); return true; }
        a.carry = t.carry;
        t.phase = 'carry'; t.x = dest.x; t.y = dest.y; t.path = null; t.repath = 0;
        return true;
      }
      finish(a, rnd(0.5, 2.5));
    }
    return true;
  }
  function endChat(m) {
    [m.A, m.B].forEach(function (b) { if (b && b.task && b.task.meet === m) finish(b, rnd(1, 4)); });
  }
  function chat(a, t, dt, d) {
    var m = t.meet, g = G(), other = t.lead ? m.B : m.A;
    a.anim = 'talk';
    if (g.actors.indexOf(other) < 0 || !other.task || other.task.meet !== m || other.fleeT > 0) { endChat(m); finish(a, 1); return; }
    if (!t.lead) return;
    if (other.task.phase !== 'work') { m.wait = (m.wait || 0) + dt; if (m.wait > 12) endChat(m); return; }
    m.left -= dt; m.turnT -= dt;
    if (m.turnT <= 0) {
      var speaker = m.turn % 2 ? m.B : m.A, listener = speaker === m.A ? m.B : m.A, near = Math.hypot(g.player.x - speaker.x, g.player.y - speaker.y) < 5.5;
      if (near) {
        if (!m.topic) m.topic = host.gossip(m.A, outlook(m.A.prov));
        var line = m.turn % 2 ? m.topic.reply : m.topic.lines[(m.turn / 2) % m.topic.lines.length | 0];
        speaker.say = { text: line, t: 3 }; m.turnT = 3.2;
        if (m.turn % 2 === 1) m.topic.reply = host.reply(m.turn);
      } else {
        bubble(speaker, outlook(a.prov).asab < 2000 && Math.random() < 0.5 ? 'angry' : ['dots', 'dots', 'bang', 'ask', 'note'][(Math.random() * 5) | 0], 1.3);
        m.turnT = rnd(1.4, 2.2);
      }
      m.turn++;
    }
    if (m.left <= 0) endChat(m);
  }

  // ---------------------------------------------------------------------------
  // The short rewind: everything about their day goes back too
  // ---------------------------------------------------------------------------
  function snap(a) {
    var t = a.task, st = null;
    if (t) { st = Object.assign({}, t); if (t.meet) st.meetSnap = Object.assign({}, t.meet); }
    return { task: st, carry: a.carry, anim: a.anim, bubble: a.bubble && Object.assign({}, a.bubble), say: a.say && Object.assign({}, a.say), waveT: a.waveT, greetT: a.greetT, idleT: a.idleT, lifeT: a.lifeT, wx: a.wx, wy: a.wy, walkT: a.walkT, fleeT: a.fleeT, left: a.left };
  }
  function restore(a, sn) {
    for (var k in sn) a[k] = sn[k];
    if (sn.task) {
      a.task = Object.assign({}, sn.task);
      if (sn.task.meet) { Object.assign(sn.task.meet, sn.task.meetSnap); a.task.meet = sn.task.meet; }
    }
    if (sn.bubble) a.bubble = Object.assign({}, sn.bubble);
    if (sn.say) a.say = Object.assign({}, sn.say);
  }
  function snapWork() { var out = {}; for (var pi in outlooks) out[pi] = Object.assign({}, outlooks[pi].work); return out; }
  function restoreWork(w) { for (var pi in w) if (outlooks[pi]) outlooks[pi].work = Object.assign({}, w[pi]); }

  /** At the turn of the year: what came of the work you watched (before: the outlook last year). */
  function yearNews(before) {
    if (!before) return '';
    var g = G(), pi = before.pi, s = g.s, dyn = L.getDyn(s, pi, g.ver), out = [], bx = (pi % W) * P, by = ((pi / W) | 0) * P;
    var built = before.build.filter(function (b) { return dyn.houses.some(function (h) { return bx + h.lx + 0.5 === b.x && by + h.ly + 0.5 === b.y; }); }).length;
    if (built) out.push(built === 1 ? 'The house the villagers were raising is finished; a new family moves in.' : 'The ' + built + ' houses the villagers were raising are finished.');
    if (before.leave) out.push(before.leave === 1 ? 'The family that was packing up is gone.' : before.leave + ' families have left the village for good.');
    if (before.starveNext && s.starve[pi]) out.push('The harvest fails, as the farmers said it would.');
    if (before.plagueNext && s.plague[pi]) out.push('The sickness from the next valley has reached the village.');
    var sig = sigOf(s, pi);
    if (before.takenNext && sig === before.takenNext) out.push('The stakes did not hold: the ' + Sim.civName(sig) + ' have taken the village.');
    return out.join(' ');
  }

  root.Life = {
    yearNews: yearNews,
    init: init, update: update, outlook: outlook, siteProgress: siteProgress, stakesUp: stakesUp, places: places,
    snap: snap, restore: restore, snapWork: snapWork, restoreWork: restoreWork, trade: trade,
    reset: function () { outlooks = {}; placeCache = {}; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
