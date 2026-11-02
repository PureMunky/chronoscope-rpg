/*
 * Local map: turns each province of the simulated world into a walkable
 * P x P patch of tiles.
 *
 *   static layer  terrain look (grass, forest, rocks, sea, rivers, trails),
 *                 derived only from the province's terrain and river, so it
 *                 never changes when history does.
 *   dynamic layer villages, fields, castles and realm borders, rebuilt from
 *                 the simulation state whenever the province's owner,
 *                 population, capital status or famine changes.
 *
 * Provinces are pre-rendered to offscreen canvases and cached.
 */
(function (root) {
  'use strict';
  var Sim = root.Sim, W = Sim.W, H = Sim.H, TER = Sim.TER, NB = Sim.NB;
  var P = 12, TS = 32, C = 6, LW = W * P, LH = H * P;

  var T = { DEEP: 0, SHALLOW: 1, GRASS: 2, DGRASS: 3, DIRT: 4, SAND: 5, ROCKY: 6, ROAD: 7, BRIDGE: 8, STREAM: 9, TREE: 10, PINE: 11, ROCK: 12, CACTUS: 13, SNOW: 14 };
  var SOLID = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0];
  var WATER = [1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
  var SPEED = [0.5, 0.55, 1, 1, 0.97, 0.9, 0.9, 1.15, 1.1, 0.6, 1, 1, 1, 1, 0.9];
  // dynamic decorations
  var D = { NONE: 0, HOUSE: 1, WALL: 2, KEEP: 3, FIELD: 4, DEADFIELD: 5, GATE: 6, KEEPPART: 7 };

  function isLandT(t) { return t >= TER.PLAINS; }
  function r01(seed, a, b, c) { return (Sim.hash4(seed, a, b, c) % 100000) / 100000; }
  function noise(seed, x, y, cell, ch) {
    var gx = Math.floor(x / cell), gy = Math.floor(y / cell), fx = x / cell - gx, fy = y / cell - gy;
    var a = r01(seed, gx, gy, ch), b = r01(seed, gx + 1, gy, ch), c = r01(seed, gx, gy + 1, ch), d = r01(seed, gx + 1, gy + 1, ch);
    var sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  // ---------------------------------------------------------------------------
  // Colours (same formula as the original Chronoscope so realms look familiar)
  // ---------------------------------------------------------------------------
  var colorCache = {};
  function hsl2rgb(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { return Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))); };
    return [f(0), f(8), f(4)];
  }
  function civRGB(sig) {
    var c = colorCache[sig];
    if (!c) { c = hsl2rgb(sig % 360, 55 + ((sig >>> 9) % 30), 46 + ((sig >>> 17) % 16)); colorCache[sig] = c; }
    return c;
  }
  function civCSS(sig, a, dl) {
    var c = civRGB(sig), m = dl || 0;
    return 'rgba(' + clamp255(c[0] + m) + ',' + clamp255(c[1] + m) + ',' + clamp255(c[2] + m) + ',' + (a == null ? 1 : a) + ')';
  }
  function clamp255(v) { return Math.max(0, Math.min(255, v | 0)); }

  // ---------------------------------------------------------------------------
  // Static layer
  // ---------------------------------------------------------------------------
  var staticCache = {}, segCache = {};   // segCache: which edge's path (bit k) each path tile belongs to
  function groundFor(t) {
    return t === TER.FOREST ? T.DGRASS : t === TER.HILLS ? T.DIRT : t === TER.MOUNTAIN ? T.ROCKY : t === TER.DESERT ? T.SAND :
      t === TER.DEEP ? T.DEEP : t === TER.SEA ? T.SHALLOW : T.GRASS;
  }
  /** Terrain a tile looks like: province boundaries are jittered so coasts and forests aren't square. */
  function lookTerrain(s, gx, gy) {
    // a broad wobble and a fine one, so coasts, hills and woods form blobs and fingers instead of squares
    var jx = Math.round((noise(s.seed, gx, gy, 7, 903) - 0.5) * 10 + (noise(s.seed, gx, gy, 2, 905) - 0.5) * 3);
    var jy = Math.round((noise(s.seed, gx, gy, 7, 904) - 0.5) * 10 + (noise(s.seed, gx, gy, 2, 906) - 0.5) * 3);
    var px = Math.max(0, Math.min(W - 1, Math.floor((gx + jx) / P))), py = Math.max(0, Math.min(H - 1, Math.floor((gy + jy) / P)));
    return s.terrain[py * W + px];
  }

  /** Where a province's paths meet (its hub, near the centre) and where its river rises. */
  function hubOf(s, pi) {
    var h = Sim.hash4(s.seed, pi, 3, 992);   // fixed per province: terrain never depends on who rules it
    return { x: C - 1 + h % 3, y: C - 1 + (h >> 4) % 3, river: [2 + (h >> 8) % 8, 2 + (h >> 12) % 8] };
  }
  /** The tile where a path (or river) crosses edge k (0 N, 1 E, 2 S, 3 W). Both neighbours compute the same spot. */
  function edgePoint(s, pi, k, ch) {
    var x = pi % W, y = (pi / W) | 0;
    if (k === 1 || k === 3) { var ex = k === 1 ? pi : pi - 1; var off = 2 + Sim.hash4(s.seed, ex, 1, ch) % 8; return [k === 1 ? P - 1 : 0, off]; }
    var ey = k === 2 ? pi : pi - W, off2 = 2 + Sim.hash4(s.seed, ey, 2, ch) % 8;
    return [off2, k === 2 ? P - 1 : 0];
  }
  /** Carve a winding, 4-connected line of tiles from (x0,y0) to (x1,y1): a path (bridging streams) or a river. */
  function carve(a, x0, y0, x1, y1, seed, salt, width, river, seg, bit) {
    var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var bend = ((Sim.hash4(seed, salt, 5, 993) % 1000) / 1000 - 0.5) * 5;
    var cx = (x0 + x1) / 2 - dy / len * bend, cy = (y0 + y1) / 2 + dx / len * bend;
    var px = x0, py = y0;
    function mark(tx, ty) {
      for (var oy = 0; oy < width; oy++) for (var ox = 0; ox < width; ox++) {
        var mx = tx + ox, my = ty + oy;
        if (mx < 0 || my < 0 || mx >= P || my >= P) continue;
        var i = my * P + mx;
        if (river) { if (a[i] !== T.ROAD && a[i] !== T.BRIDGE) a[i] = T.STREAM; }
        else { a[i] = a[i] === T.STREAM || a[i] === T.BRIDGE ? T.BRIDGE : T.ROAD; if (seg) seg[i] |= bit; }
      }
    }
    mark(px, py);
    for (var t = 0.04; t <= 1.0001; t += 0.04) {
      var u = 1 - t, fx = u * u * x0 + 2 * u * t * cx + t * t * x1, fy = u * u * y0 + 2 * u * t * cy + t * t * y1;
      var tx = Math.max(0, Math.min(P - 1, Math.round(fx))), ty = Math.max(0, Math.min(P - 1, Math.round(fy)));
      while (px !== tx || py !== ty) {
        if (px !== tx && (py === ty || Math.abs(tx - px) >= Math.abs(ty - py))) px += tx > px ? 1 : -1;
        else py += ty > py ? 1 : -1;
        mark(px, py);
      }
    }
    while (px !== x1 || py !== y1) { if (px !== x1) px += x1 > px ? 1 : -1; else py += y1 > py ? 1 : -1; mark(px, py); }
  }

  function staticTiles(s, pi) {
    var a = staticCache[pi];
    if (a) return a;
    a = new Uint8Array(P * P);
    var t0 = s.terrain[pi], px = pi % W, py = (pi / W) | 0, seed = s.seed, land = isLandT(t0);
    var lx, ly, k;
    for (ly = 0; ly < P; ly++) for (lx = 0; lx < P; lx++) {
      var gx = px * P + lx, gy = py * P + ly, t = lookTerrain(s, gx, gy);
      var n = noise(seed, gx, gy, 5, 901), r = r01(seed, gx, gy, 902), v;
      switch (t) {
        case TER.DEEP: v = T.DEEP; break;
        case TER.SEA: v = T.SHALLOW; break;
        case TER.PLAINS: v = r < 0.025 ? T.TREE : r < 0.035 ? T.ROCK : n > 0.74 ? T.DGRASS : T.GRASS; break;
        case TER.FOREST: {
          var big = noise(seed, gx, gy, 16, 907), dense = big > 0.66, glade = big < 0.3;
          var tree = glade ? r < 0.035 : dense ? (n > 0.3 && r < 0.72) || r < 0.15 : (n > 0.42 && r < 0.55) || r < 0.08;
          v = tree ? (noise(seed, gx, gy, 7, 905) > 0.5 ? T.PINE : T.TREE) : glade ? T.GRASS : T.DGRASS;
          break;
        }
        case TER.HILLS: v = r < 0.09 ? T.ROCK : r < 0.12 ? T.PINE : n > 0.5 ? T.GRASS : T.DIRT; break;
        case TER.MOUNTAIN: v = (n > 0.38 && r < 0.6) || r < 0.14 ? T.ROCK : r < 0.3 ? T.SNOW : T.ROCKY; break;
        case TER.DESERT: v = r < 0.02 ? T.CACTUS : r < 0.03 ? T.ROCK : T.SAND; break;
        default: v = T.GRASS;
      }
      // beaches next to water
      if (!WATER[v] && t !== TER.DESERT) {
        var wn = 0;
        for (var d = 0; d < 4; d++) {
          var ox = gx + [0, 1, 0, -1][d], oy = gy + [-1, 0, 1, 0][d];
          if (!isLandT(lookTerrain(s, ox, oy))) wn++;
        }
        if (wn && r < 0.85) v = T.SAND;
      }
      a[ly * P + lx] = v;
    }
    var ground = groundFor(t0), hubs = hubOf(s, pi), segs = segCache[pi] = new Uint8Array(P * P);
    // rivers: winding two-tile streams from a source point to where the river crosses into each neighbour
    if (s.river[pi] && land) {
      var links = 0;
      for (k = 0; k < 4; k++) {
        var nb = NB[pi * 4 + k];
        if (nb < 0 || !(s.river[nb] || !isLandT(s.terrain[nb]))) continue;
        links++;
        var ep = edgePoint(s, pi, k, 991);
        carve(a, hubs.river[0], hubs.river[1], ep[0], ep[1], s.seed, pi * 4 + k + 77, 2, true);
      }
      if (!links) for (ly = hubs.river[1] - 1; ly <= hubs.river[1] + 1; ly++) for (lx = hubs.river[0] - 1; lx <= hubs.river[0] + 1; lx++) a[ly * P + lx] = T.STREAM;
    }
    if (land) {
      // a village green round the hub
      for (ly = hubs.y - 2; ly <= hubs.y + 2; ly++) for (lx = hubs.x - 2; lx <= hubs.x + 2; lx++) {
        if (Math.abs(lx - hubs.x) + Math.abs(ly - hubs.y) > 3) continue;
        var cur = a[ly * P + lx];
        if (SOLID[cur] || (WATER[cur] && cur !== T.STREAM)) a[ly * P + lx] = ground;
      }
      // paths that wander from the hub to each neighbouring land province (they always connect)
      for (k = 0; k < 4; k++) {
        var nn = NB[pi * 4 + k];
        if (nn < 0 || !isLandT(s.terrain[nn])) continue;
        var pp = edgePoint(s, pi, k, 990);
        carve(a, hubs.x, hubs.y, pp[0], pp[1], s.seed, pi * 4 + k, 1, false, segs, 1 << k);
      }
    }
    staticCache[pi] = a;
    return a;
  }

  // ---------------------------------------------------------------------------
  // Dynamic layer: settlements from the simulation
  // ---------------------------------------------------------------------------
  function houseCount(pop) { return pop <= 0 ? 0 : Math.min(11, 1 + Math.floor(pop / 170)); }
  function isCapital(s, pi) { var c = s.owner[pi]; return c >= 0 && s.cCap[c] === pi; }
  function sigAt(s, pi) { var c = pi >= 0 ? s.owner[pi] : -1; return c >= 0 ? s.cSig[c] : 0; }

  function dynKey(s, pi) {
    if (!isLandT(s.terrain[pi])) return 'w';
    var c = s.owner[pi];
    var k = sigAt(s, pi) + ':' + houseCount(s.pop[pi]) + ':' + (isCapital(s, pi) ? 1 : 0) + ':' + (s.starve[pi] ? 1 : 0) + ':' + (c >= 0 ? Sim.ageOf(s.cTech[c]) : 0);
    for (var d = 0; d < 4; d++) k += ':' + sigAt(s, NB[pi * 4 + d]);
    return k;
  }

  var dynCache = {};
  function getDyn(s, pi, ver) {
    var d = dynCache[pi];
    if (d && d.ver === ver) return d;
    var key = dynKey(s, pi);
    if (d && d.key === key) { d.ver = ver; return d; }
    d = buildDyn(s, pi, key);
    d.ver = ver;
    dynCache[pi] = d;
    return d;
  }

  function buildDyn(s, pi, key) {
    var st = staticTiles(s, pi), deco = new Uint8Array(P * P), solid = new Uint8Array(P * P);
    var d = { key: key, deco: deco, solid: solid, houses: [], sig: sigAt(s, pi), age: 0, cap: false, nb: [] };
    for (var k = 0; k < 4; k++) d.nb.push(sigAt(s, NB[pi * 4 + k]));
    if (!isLandT(s.terrain[pi])) return d;
    var c = s.owner[pi], pop = s.pop[pi], lx, ly, i;
    d.age = c >= 0 ? Sim.ageOf(s.cTech[c]) : 0;
    d.cap = isCapital(s, pi);
    var hub = hubOf(s, pi), road = function (i) { return st[i] === T.ROAD || st[i] === T.BRIDGE; };
    d.hub = hub;
    if (d.cap) {
      // the castle: a square of walls (castles are square), with a gate wherever a road meets the wall
      for (ly = 1; ly < P - 1; ly++) for (lx = 1; lx < P - 1; lx++) {
        if (Math.max(Math.abs(lx - C), Math.abs(ly - C)) !== 5) continue;
        i = ly * P + lx;
        if (road(i)) deco[i] = D.GATE;
        else { deco[i] = D.WALL; solid[i] = 1; }
      }
      for (ly = C - 3; ly <= C - 2; ly++) for (lx = C + 1; lx <= C + 2; lx++) { i = ly * P + lx; deco[i] = D.KEEPPART; solid[i] = 1; }
      deco[(C - 3) * P + C + 1] = D.KEEP;
    }
    var nh = houseCount(pop) + (d.cap ? 3 : 0);
    if (nh) {
      // houses cluster along the road and round the green, a little ragged
      var cands = [];
      for (ly = 1; ly < P - 1; ly++) for (lx = 1; lx < P - 1; lx++) {
        i = ly * P + lx;
        var ddx = lx - hub.x, ddy = ly - hub.y, dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist < 1.5 || dist > (d.cap ? 4.4 : 6) || deco[i] || SOLID[st[i]] || WATER[st[i]] || road(i)) continue;
        if (lx === C + 1 && ly === C - 1) continue; // where the ruler stands
        var byRoad = (lx > 0 && road(i - 1)) || (lx < P - 1 && road(i + 1)) || (ly > 0 && road(i - P)) || (ly < P - 1 && road(i + P));
        var score = dist + noise(s.seed, (pi % W) * P + lx, ((pi / W) | 0) * P + ly, 3, 913) * 2.2 - (byRoad ? 1.6 : 0);
        cands.push({ i: i, lx: lx, ly: ly, h: score });
      }
      cands.sort(function (a, b) { return a.h - b.h; });
      for (k = 0; k < cands.length && d.houses.length < nh; k++) {
        var cd = cands[k];
        // keep a lane beside every house
        var crowded = d.houses.some(function (h) { return Math.abs(h.lx - cd.lx) <= 1 && Math.abs(h.ly - cd.ly) <= 1 && (h.lx === cd.lx || h.ly === cd.ly); });
        if (crowded) continue;
        deco[cd.i] = D.HOUSE; solid[cd.i] = 1;
        d.houses.push({ lx: cd.lx, ly: cd.ly });
      }
      var t0 = s.terrain[pi];
      if (t0 === TER.PLAINS || t0 === TER.HILLS || t0 === TER.FOREST) {
        // fields in irregular plots around the outskirts
        var want = nh * 2, made = 0, seeds = [];
        for (ly = 0; ly < P; ly++) for (lx = 0; lx < P; lx++) {
          i = ly * P + lx;
          var fdx = lx - hub.x, fdy = ly - hub.y, fd = Math.sqrt(fdx * fdx + fdy * fdy);
          if (fd < 2.6 || fd > 7 || deco[i] || (st[i] !== T.GRASS && st[i] !== T.DIRT && st[i] !== T.DGRASS)) continue;
          seeds.push({ i: i, h: Sim.hash4(s.seed, pi, i, 912) % 1000 + fd * 90 });
        }
        seeds.sort(function (a, b) { return a.h - b.h; });
        var fieldOK = function (j) { return j >= 0 && j < P * P && !deco[j] && (st[j] === T.GRASS || st[j] === T.DIRT || st[j] === T.DGRASS); };
        for (k = 0; k < seeds.length && made < want; k++) {
          var plot = [seeds[k].i], size = 2 + Sim.hash4(s.seed, pi, k, 914) % 4;
          if (!fieldOK(plot[0])) continue;
          for (var q = 0; q < plot.length && plot.length < size; q++) {
            var c0 = plot[q], dirs = [1, -1, P, -P];
            for (var dd = 0; dd < 4 && plot.length < size; dd++) {
              var nj = c0 + dirs[(dd + Sim.hash4(s.seed, c0, k, 915)) % 4];
              if ((dirs[dd] === 1 && nj % P === 0) || (dirs[dd] === -1 && c0 % P === 0)) continue;
              if (fieldOK(nj) && plot.indexOf(nj) < 0) plot.push(nj);
            }
          }
          plot.forEach(function (j) { if (fieldOK(j)) { deco[j] = s.starve[pi] ? D.DEADFIELD : D.FIELD; made++; } });
        }
      }
    }
    return d;
  }

  function isSolid(s, tx, ty, ver, blockWater) {
    if (tx < 0 || ty < 0 || tx >= LW || ty >= LH) return true;
    var pi = ((ty / P) | 0) * W + ((tx / P) | 0), i = (ty % P) * P + (tx % P);
    var st = staticTiles(s, pi)[i];
    if (SOLID[st]) return true;
    if (blockWater && WATER[st] && st !== T.STREAM) return true; // streams are fords; only the sea stops people on foot
    return getDyn(s, pi, ver).solid[i] === 1;
  }
  function tileAt(s, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= LW || ty >= LH) return T.DEEP;
    return staticTiles(s, ((ty / P) | 0) * W + ((tx / P) | 0))[(ty % P) * P + (tx % P)];
  }
  function speedAt(s, x, y) { return SPEED[tileAt(s, Math.floor(x), Math.floor(y))]; }
  function isWaterAt(s, x, y) { var t = tileAt(s, Math.floor(x), Math.floor(y)); return WATER[t] === 1 && t !== T.STREAM; }
  /** Does a projectile pass over this tile? (not through trees, rocks or buildings) */
  function blocksShot(s, tx, ty, ver) {
    if (tx < 0 || ty < 0 || tx >= LW || ty >= LH) return true;
    return isSolid(s, tx, ty, ver, false);
  }

  function clearCaches() { staticCache = {}; segCache = {}; dynCache = {}; }

  root.Local = {
    P: P, TS: TS, C: C, LW: LW, LH: LH, T: T, D: D, SOLID: SOLID, WATER: WATER,
    staticTiles: staticTiles, getDyn: getDyn, buildDyn: buildDyn, dynKey: dynKey, houseCount: houseCount, isSolid: isSolid, tileAt: tileAt, speedAt: speedAt, isWaterAt: isWaterAt,
    blocksShot: blocksShot, clearCaches: clearCaches, civRGB: civRGB, civCSS: civCSS,
    houseCount: houseCount, isCapital: isCapital, isLandT: isLandT,
    groundFor: groundFor, lookTerrain: lookTerrain, sigAt: sigAt, noise: noise, hubOf: hubOf,
    pathSegments: function (s, pi) { staticTiles(s, pi); return segCache[pi]; }
  };
}(this));
