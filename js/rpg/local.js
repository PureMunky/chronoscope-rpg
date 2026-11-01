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
  var staticCache = {};
  function groundFor(t) {
    return t === TER.FOREST ? T.DGRASS : t === TER.HILLS ? T.DIRT : t === TER.MOUNTAIN ? T.ROCKY : t === TER.DESERT ? T.SAND :
      t === TER.DEEP ? T.DEEP : t === TER.SEA ? T.SHALLOW : T.GRASS;
  }
  /** Terrain a tile looks like: province boundaries are jittered so coasts and forests aren't square. */
  function lookTerrain(s, gx, gy) {
    var jx = Math.round((noise(s.seed, gx, gy, 3, 903) - 0.5) * 5), jy = Math.round((noise(s.seed, gx, gy, 3, 904) - 0.5) * 5);
    var px = Math.max(0, Math.min(W - 1, Math.floor((gx + jx) / P))), py = Math.max(0, Math.min(H - 1, Math.floor((gy + jy) / P)));
    return s.terrain[py * W + px];
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
        case TER.FOREST: v = (n > 0.42 && r < 0.55) || r < 0.08 ? (noise(seed, gx, gy, 7, 905) > 0.5 ? T.PINE : T.TREE) : T.DGRASS; break;
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
    var ground = groundFor(t0);
    // rivers: lanes at x/y = 2..3 joining the river network of neighbouring provinces
    if (s.river[pi] && land) {
      var links = 0;
      for (k = 0; k < 4; k++) {
        var nb = NB[pi * 4 + k];
        if (nb < 0 || !(s.river[nb] || !isLandT(s.terrain[nb]))) continue;
        links++;
        for (var q = 0; q < P; q++) for (var w = 2; w <= 3; w++) {
          if (k === 0 && q <= 3) a[q * P + w] = T.STREAM;
          if (k === 2 && q >= 2) a[q * P + w] = T.STREAM;
          if (k === 3 && q <= 3) a[w * P + q] = T.STREAM;
          if (k === 1 && q >= 2) a[w * P + q] = T.STREAM;
        }
      }
      if (!links) for (ly = 2; ly <= 4; ly++) for (lx = 2; lx <= 4; lx++) a[ly * P + lx] = T.STREAM;
    }
    if (land) {
      // clear the village green
      for (ly = C - 2; ly <= C + 2; ly++) for (lx = C - 2; lx <= C + 2; lx++) {
        var cur = a[ly * P + lx];
        if (SOLID[cur] || (WATER[cur] && cur !== T.STREAM)) a[ly * P + lx] = ground;
      }
      // trails to neighbouring land provinces
      var west = NB[pi * 4 + 3], east = NB[pi * 4 + 1], north = NB[pi * 4], south = NB[pi * 4 + 2];
      var x0 = west >= 0 && isLandT(s.terrain[west]) ? 0 : C, x1 = east >= 0 && isLandT(s.terrain[east]) ? P - 1 : C;
      var y0 = north >= 0 && isLandT(s.terrain[north]) ? 0 : C, y1 = south >= 0 && isLandT(s.terrain[south]) ? P - 1 : C;
      for (lx = x0; lx <= x1; lx++) a[C * P + lx] = a[C * P + lx] === T.STREAM ? T.BRIDGE : T.ROAD;
      for (ly = y0; ly <= y1; ly++) a[ly * P + C] = a[ly * P + C] === T.STREAM ? T.BRIDGE : T.ROAD;
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

  var dynCache = {}, renderCache = {}, renderOrder = [];
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
    if (d.cap) {
      for (ly = 1; ly < P - 1; ly++) for (lx = 1; lx < P - 1; lx++) {
        if (Math.max(Math.abs(lx - C), Math.abs(ly - C)) !== 5) continue;
        i = ly * P + lx;
        if (lx === C || ly === C) deco[i] = D.GATE;
        else { deco[i] = D.WALL; solid[i] = 1; }
      }
      for (ly = C - 3; ly <= C - 2; ly++) for (lx = C + 1; lx <= C + 2; lx++) { i = ly * P + lx; deco[i] = D.KEEPPART; solid[i] = 1; }
      deco[(C - 3) * P + C + 1] = D.KEEP;
    }
    var nh = houseCount(pop) + (d.cap ? 3 : 0);
    if (nh) {
      var cands = [];
      for (ly = 1; ly < P - 1; ly++) for (lx = 1; lx < P - 1; lx++) {
        i = ly * P + lx;
        var dist = Math.max(Math.abs(lx - C), Math.abs(ly - C));
        if (dist < 1 || dist > (d.cap ? 4 : 5) || deco[i] || SOLID[st[i]] || WATER[st[i]] || st[i] === T.ROAD || st[i] === T.BRIDGE) continue;
        if (lx === C + 1 && ly === C - 1) continue; // where the ruler stands
        cands.push({ i: i, lx: lx, ly: ly, h: Sim.hash4(s.seed, pi, i, 911) + dist * 0x1000000 });
      }
      cands.sort(function (a, b) { return a.h - b.h; });
      for (k = 0; k < cands.length && d.houses.length < nh; k++) {
        var cd = cands[k];
        // keep houses apart a little so lanes stay open
        var crowded = d.houses.some(function (h) { return Math.abs(h.lx - cd.lx) <= 1 && Math.abs(h.ly - cd.ly) <= 1 && (h.lx === cd.lx || h.ly === cd.ly); });
        if (crowded) continue;
        deco[cd.i] = D.HOUSE; solid[cd.i] = 1;
        d.houses.push({ lx: cd.lx, ly: cd.ly });
      }
      var t0 = s.terrain[pi];
      if (t0 === TER.PLAINS || t0 === TER.HILLS || t0 === TER.FOREST) {
        var nf = nh * 2, fields = [];
        for (ly = 0; ly < P; ly++) for (lx = 0; lx < P; lx++) {
          i = ly * P + lx;
          var fd = Math.max(Math.abs(lx - C), Math.abs(ly - C));
          if (fd < 3 || deco[i] || (st[i] !== T.GRASS && st[i] !== T.DIRT && st[i] !== T.DGRASS)) continue;
          fields.push({ i: i, h: Sim.hash4(s.seed, pi, i, 912) + fd * 0x2000000 });
        }
        fields.sort(function (a, b) { return a.h - b.h; });
        for (k = 0; k < Math.min(nf, fields.length); k++) deco[fields[k].i] = s.starve[pi] ? D.DEADFIELD : D.FIELD;
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

  // ---------------------------------------------------------------------------
  // Rendering a province to an offscreen canvas
  // ---------------------------------------------------------------------------
  var GROUND_RGB = {};
  GROUND_RGB[T.DEEP] = [34, 70, 112]; GROUND_RGB[T.SHALLOW] = [52, 112, 156]; GROUND_RGB[T.GRASS] = [104, 146, 70];
  GROUND_RGB[T.DGRASS] = [72, 116, 58]; GROUND_RGB[T.DIRT] = [142, 124, 86]; GROUND_RGB[T.SAND] = [214, 194, 140];
  GROUND_RGB[T.ROCKY] = [128, 124, 116]; GROUND_RGB[T.ROAD] = [164, 140, 98]; GROUND_RGB[T.BRIDGE] = [120, 84, 48];
  GROUND_RGB[T.STREAM] = [70, 140, 190]; GROUND_RGB[T.SNOW] = [226, 230, 236];

  function shade(rgb, k) { return 'rgb(' + clamp255(rgb[0] * k) + ',' + clamp255(rgb[1] * k) + ',' + clamp255(rgb[2] * k) + ')'; }

  function renderProvince(s, pi, ver) {
    var dyn = getDyn(s, pi, ver);
    var rc = renderCache[pi];
    if (rc && rc.key === dyn.key) return rc.canvas;
    var cv = rc ? rc.canvas : document.createElement('canvas');
    cv.width = cv.height = P * TS;
    var g = cv.getContext('2d');
    var st = staticTiles(s, pi), px = pi % W, py = (pi / W) | 0, seed = s.seed, lx, ly, i, x0, y0, v, r;
    var t0 = s.terrain[pi];
    // ground
    for (ly = 0; ly < P; ly++) for (lx = 0; lx < P; lx++) {
      i = ly * P + lx; v = st[i]; x0 = lx * TS; y0 = ly * TS;
      var gx = px * P + lx, gy = py * P + ly;
      r = r01(seed, gx, gy, 920);
      var base = SOLID[v] ? groundFor(lookTerrain(s, gx, gy)) : v;
      if (SOLID[v] && WATER[base]) base = v === T.CACTUS ? T.SAND : T.GRASS;
      g.fillStyle = shade(GROUND_RGB[base] || GROUND_RGB[T.GRASS], 0.94 + r * 0.12);
      g.fillRect(x0, y0, TS, TS);
      drawGroundDetail(g, base, x0, y0, seed, gx, gy);
    }
    // fields and roads
    for (ly = 0; ly < P; ly++) for (lx = 0; lx < P; lx++) {
      i = ly * P + lx; x0 = lx * TS; y0 = ly * TS;
      if (dyn.deco[i] === D.FIELD || dyn.deco[i] === D.DEADFIELD) drawField(g, x0, y0, dyn.deco[i] === D.DEADFIELD, (px + py + lx) & 1);
    }
    // civ tint
    if (dyn.sig) { g.fillStyle = civCSS(dyn.sig, 0.07); g.fillRect(0, 0, P * TS, P * TS); }
    // objects, top to bottom
    for (ly = 0; ly < P; ly++) for (lx = 0; lx < P; lx++) {
      i = ly * P + lx; v = st[i]; x0 = lx * TS; y0 = ly * TS;
      var gx2 = px * P + lx, gy2 = py * P + ly;
      if (v === T.TREE) drawTree(g, x0, y0, r01(seed, gx2, gy2, 921));
      else if (v === T.PINE) drawPine(g, x0, y0, r01(seed, gx2, gy2, 921), t0 === TER.MOUNTAIN || t0 === TER.HILLS);
      else if (v === T.ROCK) drawRock(g, x0, y0, r01(seed, gx2, gy2, 921), t0 === TER.MOUNTAIN);
      else if (v === T.CACTUS) drawCactus(g, x0, y0);
      var dc = dyn.deco[i];
      if (dc === D.HOUSE) drawHouse(g, x0, y0, dyn.age, dyn.sig, r01(seed, gx2, gy2, 922));
      else if (dc === D.WALL) drawWall(g, x0, y0, dyn.age);
      else if (dc === D.GATE) drawGate(g, x0, y0, dyn.age, lx === C);
      else if (dc === D.KEEP) drawKeep(g, x0, y0, dyn.age, dyn.sig);
    }
    // realm borders
    if (dyn.sig) {
      g.save();
      g.strokeStyle = civCSS(dyn.sig, 0.85, -20);
      g.lineWidth = 4;
      g.setLineDash([10, 6]);
      var E = P * TS - 2;
      if (dyn.nb[0] !== dyn.sig) line(g, 2, 2, E, 2);
      if (dyn.nb[1] !== dyn.sig) line(g, E, 2, E, E);
      if (dyn.nb[2] !== dyn.sig) line(g, 2, E, E, E);
      if (dyn.nb[3] !== dyn.sig) line(g, 2, 2, 2, E);
      g.restore();
    }
    if (!rc) {
      renderCache[pi] = rc = { canvas: cv, key: '' };
      renderOrder.push(pi);
      if (renderOrder.length > 70) { var old = renderOrder.shift(); delete renderCache[old]; }
    }
    rc.key = dyn.key;
    return cv;
  }
  function line(g, a, b, c, d) { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); }

  function drawGroundDetail(g, v, x0, y0, seed, gx, gy) {
    var r = r01(seed, gx, gy, 923), r2 = r01(seed, gx, gy, 924);
    if (v === T.GRASS || v === T.DGRASS) {
      g.strokeStyle = v === T.GRASS ? 'rgba(60,100,40,0.55)' : 'rgba(40,80,36,0.6)';
      g.lineWidth = 1;
      for (var k = 0; k < 3; k++) {
        var x = x0 + 4 + ((r * 97 + k * 31) % 24), y = y0 + 6 + ((r2 * 89 + k * 17) % 22);
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - 1, y - 4); g.moveTo(x + 2, y); g.lineTo(x + 3, y - 3); g.stroke();
      }
      if (r > 0.93) { g.fillStyle = r2 > 0.5 ? '#e8d86a' : '#e8a0c0'; g.fillRect(x0 + 8 + r2 * 14, y0 + 10 + r * 6, 3, 3); }
    } else if (v === T.SHALLOW || v === T.DEEP || v === T.STREAM) {
      g.strokeStyle = 'rgba(255,255,255,' + (v === T.DEEP ? 0.10 : 0.18) + ')';
      g.lineWidth = 1.5;
      g.beginPath();
      var wx = x0 + 4 + r * 16, wy = y0 + 8 + r2 * 16;
      g.moveTo(wx, wy); g.quadraticCurveTo(wx + 4, wy - 3, wx + 8, wy); g.stroke();
    } else if (v === T.SAND || v === T.DIRT || v === T.ROCKY || v === T.SNOW) {
      g.fillStyle = 'rgba(0,0,0,0.08)';
      g.fillRect(x0 + r * 26, y0 + r2 * 26, 3, 2);
      g.fillRect(x0 + r2 * 26, y0 + r * 24 + 4, 2, 2);
    } else if (v === T.ROAD) {
      g.fillStyle = 'rgba(90,70,40,0.18)';
      g.fillRect(x0 + r * 24, y0 + r2 * 26, 4, 2);
    } else if (v === T.BRIDGE) {
      g.fillStyle = 'rgba(40,24,10,0.5)';
      for (var p = 0; p < TS; p += 6) g.fillRect(x0, y0 + p, TS, 1);
      g.fillStyle = '#5a3a1c';
      g.fillRect(x0, y0, 3, TS); g.fillRect(x0 + TS - 3, y0, 3, TS);
    }
  }
  function drawField(g, x0, y0, dead, alt) {
    g.fillStyle = dead ? '#8a7448' : '#7a6a3a';
    g.fillRect(x0 + 1, y0 + 1, TS - 2, TS - 2);
    g.fillStyle = dead ? '#a08a58' : (alt ? '#c8b84a' : '#9cc050');
    for (var k = 3; k < TS - 2; k += 6) g.fillRect(x0 + 2, y0 + k, TS - 4, 3);
  }
  function drawTree(g, x0, y0, r) {
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.ellipse(x0 + 17, y0 + 27, 12, 4, 0, 0, 7); g.fill();
    g.fillStyle = '#5a3b20'; g.fillRect(x0 + 14, y0 + 18, 5, 10);
    g.fillStyle = r > 0.5 ? '#3b7a32' : '#447f2c';
    g.beginPath(); g.arc(x0 + 16, y0 + 13, 12, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.arc(x0 + 12, y0 + 9, 5, 0, 7); g.fill();
  }
  function drawPine(g, x0, y0, r, snowy) {
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.ellipse(x0 + 16, y0 + 28, 10, 3.5, 0, 0, 7); g.fill();
    g.fillStyle = '#4a3018'; g.fillRect(x0 + 14, y0 + 22, 4, 7);
    g.fillStyle = r > 0.5 ? '#285a30' : '#2e6436';
    g.beginPath(); g.moveTo(x0 + 16, y0 + 1); g.lineTo(x0 + 28, y0 + 24); g.lineTo(x0 + 4, y0 + 24); g.closePath(); g.fill();
    if (snowy) { g.fillStyle = '#eef'; g.beginPath(); g.moveTo(x0 + 16, y0 + 1); g.lineTo(x0 + 20, y0 + 9); g.lineTo(x0 + 12, y0 + 9); g.closePath(); g.fill(); }
  }
  function drawRock(g, x0, y0, r, big) {
    var s = big ? 1.25 : 0.9;
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.ellipse(x0 + 16, y0 + 25, 12 * s, 4 * s, 0, 0, 7); g.fill();
    g.fillStyle = r > 0.5 ? '#8d8a84' : '#7b7872';
    g.beginPath(); g.ellipse(x0 + 16, y0 + 18, 11 * s, 9 * s, 0, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.beginPath(); g.ellipse(x0 + 12, y0 + 14, 4 * s, 3 * s, 0, 0, 7); g.fill();
    if (big) { g.fillStyle = '#e8ecf0'; g.beginPath(); g.ellipse(x0 + 16, y0 + 11, 6, 3, 0, 0, 7); g.fill(); }
  }
  function drawCactus(g, x0, y0) {
    g.fillStyle = '#4f8a3c';
    g.fillRect(x0 + 13, y0 + 6, 6, 22); g.fillRect(x0 + 7, y0 + 12, 4, 8); g.fillRect(x0 + 7, y0 + 18, 8, 3);
    g.fillRect(x0 + 21, y0 + 10, 4, 8); g.fillRect(x0 + 17, y0 + 16, 8, 3);
  }
  function drawHouse(g, x0, y0, age, sig, r) {
    var roof = sig ? civCSS(sig, 1, -30) : '#8a5a3a';
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x0 + 3, y0 + 24, 28, 6);
    if (age <= 1) {
      g.fillStyle = '#9a7a48'; g.beginPath(); g.arc(x0 + 16, y0 + 17, 13, 0, 7); g.fill();
      g.strokeStyle = roof; g.lineWidth = 3; g.beginPath(); g.arc(x0 + 16, y0 + 17, 11, 0, 7); g.stroke();
      g.fillStyle = '#6a4a28'; g.beginPath(); g.arc(x0 + 16, y0 + 17, 4, 0, 7); g.fill();
    } else if (age <= 3) {
      g.fillStyle = '#d8c49a'; g.fillRect(x0 + 4, y0 + 12, 24, 16);
      g.fillStyle = '#5a3a20'; g.fillRect(x0 + 14, y0 + 20, 5, 8);
      g.fillStyle = roof; g.beginPath(); g.moveTo(x0 + 1, y0 + 14); g.lineTo(x0 + 16, y0 + 2); g.lineTo(x0 + 31, y0 + 14); g.closePath(); g.fill();
    } else {
      g.fillStyle = '#ece4d4'; g.fillRect(x0 + 4, y0 + 10, 24, 18);
      g.strokeStyle = '#4a3020'; g.lineWidth = 2; g.strokeRect(x0 + 4, y0 + 10, 24, 18);
      g.beginPath(); g.moveTo(x0 + 4, y0 + 19); g.lineTo(x0 + 28, y0 + 19); g.stroke();
      g.fillStyle = '#6a8ab0'; g.fillRect(x0 + 8, y0 + 13, 5, 4); g.fillRect(x0 + 19, y0 + 13, 5, 4);
      g.fillStyle = roof; g.fillRect(x0 + 1, y0 + 2, 30, 9);
    }
    if (r > 0.75) { g.fillStyle = '#555'; g.fillRect(x0 + 22, y0 + 2, 4, 7); }
  }
  function drawWall(g, x0, y0, age) {
    if (age <= 1) {
      g.fillStyle = '#7a5530';
      for (var k = 0; k < 4; k++) { g.fillRect(x0 + 1 + k * 8, y0 + 4, 6, 26); g.beginPath(); g.moveTo(x0 + 1 + k * 8, y0 + 4); g.lineTo(x0 + 4 + k * 8, y0); g.lineTo(x0 + 7 + k * 8, y0 + 4); g.fill(); }
    } else {
      g.fillStyle = '#8f8a80'; g.fillRect(x0, y0 + 4, TS, TS - 4);
      g.fillStyle = '#a9a398'; g.fillRect(x0, y0, 9, 6); g.fillRect(x0 + 12, y0, 9, 6); g.fillRect(x0 + 24, y0, 8, 6);
      g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1;
      for (var y = 10; y < TS; y += 7) line(g, x0, y0 + y, x0 + TS, y0 + y);
    }
  }
  function drawGate(g, x0, y0, age, vertical) {
    g.fillStyle = age <= 1 ? '#5a3a1c' : '#6f6a62';
    if (vertical) { g.fillRect(x0, y0, 5, TS); g.fillRect(x0 + TS - 5, y0, 5, TS); }
    else { g.fillRect(x0, y0, TS, 5); g.fillRect(x0, y0 + TS - 5, TS, 5); }
  }
  function drawKeep(g, x0, y0, age, sig) {
    var w = TS * 2;
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x0 + 4, y0 + w - 6, w, 8);
    g.fillStyle = age <= 1 ? '#8a6a40' : '#9d978c'; g.fillRect(x0 + 2, y0 + 10, w - 4, w - 12);
    g.fillStyle = age <= 1 ? '#6a4a28' : '#b8b2a6';
    for (var k = 0; k < 5; k++) g.fillRect(x0 + 2 + k * 13, y0 + 4, 8, 8);
    g.fillStyle = '#3a2a1a'; g.fillRect(x0 + w / 2 - 6, y0 + w - 18, 12, 16);
    g.fillStyle = '#222'; g.fillRect(x0 + w / 2 - 1, y0 - 14, 2, 22);
    g.fillStyle = sig ? civCSS(sig) : '#c33'; g.fillRect(x0 + w / 2 + 1, y0 - 14, 14, 9);
  }

  function clearCaches() { staticCache = {}; dynCache = {}; renderCache = {}; renderOrder = []; }

  root.Local = {
    P: P, TS: TS, C: C, LW: LW, LH: LH, T: T, D: D, SOLID: SOLID, WATER: WATER,
    staticTiles: staticTiles, getDyn: getDyn, isSolid: isSolid, tileAt: tileAt, speedAt: speedAt, isWaterAt: isWaterAt,
    blocksShot: blocksShot, renderProvince: renderProvince, clearCaches: clearCaches, civRGB: civRGB, civCSS: civCSS,
    houseCount: houseCount, isCapital: isCapital, isLandT: isLandT
  };
}(this));
