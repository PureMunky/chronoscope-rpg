/*
 * 16-bit renderer: pixel art generated from the simulation, in the spirit of
 * SNES-era action RPGs.
 *
 *   - The world is drawn at 16 pixels per tile into a low-resolution buffer,
 *     then scaled up 2x with nearest-neighbour sampling (crisp pixels).
 *   - A curated palette of shading ramps, with autumn and winter versions.
 *     Ground is mostly flat colour with sparse details; ground types blend
 *     along ragged edges, and coasts get foam.
 *   - Roads follow history: the footpath network never moves (it keeps the
 *     land walkable), but which paths are roads, and how grand, comes from the
 *     year you are in: faint footpaths in the wilds, dirt roads in villages,
 *     and on the routes from each realm's capital to its towns, cobbles
 *     (Classical, Medieval) or paving (Renaissance on). Capitals move and
 *     highways move with them.
 *   - Buildings in 3/4 view change with the age of the people who live there;
 *     roofs, banners and border posts take the realm's colour.
 *   - Characters and beasts are outlined sprites with walk cycles.
 *   - Life: sparkling water, chimney smoke, birds, butterflies, falling
 *     leaves and snow.
 *
 * Everything is generated (no image files) and cached.
 */
(function (root) {
  'use strict';
  var Sim = root.Sim, L = root.Local, W = Sim.W, H = Sim.H, N = Sim.N, NB = Sim.NB, TER = Sim.TER;
  var P = L.P, C = L.C, T = L.T, D = L.D;
  var PT = 16, PAD = 16, PW = P * PT;

  // ---------------------------------------------------------------------------
  // Palette: shading ramps, dark to light; seasons swap a few of them
  // ---------------------------------------------------------------------------
  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function ramp(list) { return list.map(hex); }
  var R = {
    grass: ramp(['#2d5427', '#3f7432', '#53913b', '#6eaa45', '#91c25a']),
    dgrass: ramp(['#1f3d23', '#2c5530', '#3d6f37', '#52883f']),
    dirt: ramp(['#4e3622', '#6a4a2c', '#86603a', '#a27b4c']),
    sand: ramp(['#a07c4c', '#bf9a62', '#d8b87c', '#ead09a']),
    rocky: ramp(['#4c4a4e', '#666369', '#827e84', '#a19ca1']),
    snow: ramp(['#8d9bb5', '#b8c4d8', '#dce4f0', '#f4f7fc']),
    road: ramp(['#6a5034', '#86683f', '#a3824f', '#bd9d64']),
    cobble: ramp(['#3e3a3a', '#5e5856', '#7e7672', '#9c948c']),
    paved: ramp(['#5a5a60', '#7c7c84', '#9a9aa2', '#b6b6bc']),
    shallow: ramp(['#245b8a', '#2f72a6', '#3f8bc0', '#62aad6']),
    deep: ramp(['#14305a', '#1a3f72', '#224f88', '#2d619c']),
    foam: ramp(['#9fd4ee', '#d6f0fb']),
    wood: ramp(['#3e2615', '#5e3a1e', '#7e522c', '#9e6c3e']),
    stone: ramp(['#3e3d47', '#5a5866', '#7a7787', '#9d9aa8', '#c0bdc8']),
    leaf: ramp(['#173c1f', '#255a28', '#367833', '#4f9a3e', '#78bb52']),
    pine: ramp(['#12301f', '#1d4a2e', '#2a643c', '#3b7f4b']),
    thatch: ramp(['#6e5228', '#93703a', '#b7914c', '#d2ae63']),
    plaster: ramp(['#a99a83', '#cdbea3', '#e8dcc4']),
    crop: ramp(['#7d8a2c', '#a5b23a', '#cfd25a']),
    wheat: ramp(['#9a7a2a', '#c8a23c', '#e6c65a']),
    dead: ramp(['#6e5a3a', '#8a7450', '#a08a62']),
    gold: ramp(['#8a5a12', '#c8901e', '#f2c84a', '#fff0a0']),
    cactus: ramp(['#2a5a2c', '#3e7a3a', '#5a9a4a']),
    wolf: ramp(['#3e4048', '#5e6068', '#80828c', '#a8aab2']),
    jackal: ramp(['#6a5030', '#8e6c40', '#b08c58', '#ccaa72']),
    bear: ramp(['#2e1e14', '#4a3020', '#684630', '#845c40']),
    rat: ramp(['#2e2a2c', '#46403e', '#5e5754']),
    horse: ramp(['#3a2414', '#5a3a20', '#7c5432', '#9a6e46']),
    canvas: ramp(['#7a6a4a', '#a08c62', '#c4b082', '#dccca0']),
    outline: hex('#18121e')
  };
  var SEASONAL = {
    1: { grass: ramp(['#4a5424', '#66702c', '#8a8434', '#a89a3e', '#c4ac4a']), dgrass: ramp(['#3a3a1e', '#54502a', '#6e6430', '#86783a']),
      leaf: ramp(['#5a2410', '#8a3a14', '#b85a1c', '#d8862a', '#eab04a']) },
    2: { grass: ramp(['#9aa6bc', '#bcc6d8', '#d8e0ec', '#eef2f8', '#ffffff']), dgrass: ramp(['#8894aa', '#aab6ca', '#c8d2e2', '#e2e8f2']),
      leaf: ramp(['#2e2016', '#3e2c1e', '#54402c', '#6a523a', '#82684a']), dirt: ramp(['#6a6070', '#8a8090', '#a8a0b0', '#c4bccc']),
      road: ramp(['#5c5466', '#7a7284', '#988fa2', '#b4acbe']), crop: ramp(['#c8d0de', '#dfe5ee', '#f2f5fa']), wheat: ramp(['#c8d0de', '#dfe5ee', '#f2f5fa']) }
  };
  var SEASON = 0, RS = R;
  function setSeason(month) {
    var sn = month === 11 || month <= 1 ? 2 : month >= 8 ? 1 : 0;
    if (sn === SEASON) return;
    SEASON = sn;
    RS = Object.assign({}, R, SEASONAL[sn] || {});
  }
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function bayer(x, y) { return BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5; }
  function pick(rmp, v, x, y) { var i = Math.floor(v * rmp.length + bayer(x, y) * 0.9); return rmp[i < 0 ? 0 : i >= rmp.length ? rmp.length - 1 : i]; }
  function hrand(seed, x, y, ch) { return (Sim.hash4(seed, x, y, ch) % 10007) / 10007; }
  function css(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a == null ? 1 : a) + ')'; }
  function shadeOf(c, k) { return [Math.max(0, Math.min(255, Math.round(c[0] * k))), Math.max(0, Math.min(255, Math.round(c[1] * k))), Math.max(0, Math.min(255, Math.round(c[2] * k)))]; }
  var civRamps = {};
  function civRamp(sig) {
    var r = civRamps[sig];
    if (!r) { var c = L.civRGB(sig); r = civRamps[sig] = [shadeOf(c, 0.55), shadeOf(c, 0.8), c, shadeOf(c, 1.18)]; }
    return r;
  }

  // ---------------------------------------------------------------------------
  // Roads from history: highways from each capital to its towns
  // ---------------------------------------------------------------------------
  var HW = { ver: -1, bits: null };
  var OPP = [2, 3, 0, 1];
  function highways(s, ver) {
    if (HW.ver === ver && HW.bits) return HW.bits;
    var bits = new Uint8Array(N), parent = new Int8Array(N).fill(-1), seen = new Uint8Array(N), q = new Int32Array(N);
    for (var c = 0; c < s.g[1]; c++) {
      if (!s.cAlive[c] || s.sTiles[c] < 4) continue;
      var cap = s.cCap[c];
      if (cap < 0 || s.owner[cap] !== c) continue;
      var h = 0, t = 0; q[t++] = cap; seen[cap] = 1; parent[cap] = -1;
      while (h < t) {
        var u = q[h++];
        for (var d = 0; d < 4; d++) {
          var n = NB[u * 4 + d];
          if (n < 0 || seen[n] || s.owner[n] !== c) continue;
          seen[n] = 1; parent[n] = OPP[d]; q[t++] = n;
        }
      }
      // every sizeable town gets a road to the capital
      for (var k = 0; k < t; k++) {
        var v = q[k];
        if (s.pop[v] < 300) continue;
        var guard = 0;
        while (parent[v] >= 0 && guard++ < 400) {
          var dir = parent[v], nxt = NB[v * 4 + dir];
          if ((bits[v] >> dir) & 1) break;            // joins a road already built
          bits[v] |= 1 << dir; bits[nxt] |= 1 << OPP[dir];
          v = nxt;
        }
      }
    }
    HW.ver = ver; HW.bits = bits;
    return bits;
  }
  /** What a road tile looks like in this year: 0 footpath, 1 dirt road, 2 cobbles, 3 paving. */
  function roadGrade(s, pi, i, ver) {
    var c = s.owner[pi];
    if (c < 0 || s.pop[pi] <= 0) return 0;
    var seg = L.pathSegments(s, pi)[i], hw = highways(s, ver)[pi], age = Sim.ageOf(s.cTech[c]);
    var main = (seg & hw) !== 0 || s.cCap[c] === pi;
    if (!main) return 1;
    return age >= 5 ? 3 : age >= 3 ? 2 : 1;
  }

  // ---------------------------------------------------------------------------
  // Ground materials and their pixels
  // ---------------------------------------------------------------------------
  var MAT = {};
  MAT[T.DEEP] = 'deep'; MAT[T.SHALLOW] = 'shallow'; MAT[T.STREAM] = 'shallow'; MAT[T.GRASS] = 'grass'; MAT[T.DGRASS] = 'dgrass';
  MAT[T.DIRT] = 'dirt'; MAT[T.SAND] = 'sand'; MAT[T.ROCKY] = 'rocky'; MAT[T.SNOW] = 'snow';
  var ROADMAT = ['path', 'road', 'cobble', 'paved'];
  var PRIO = { deep: 0, shallow: 1, sand: 2, path: 2, road: 3, dirt: 3, rocky: 3, bridge: 9, sbridge: 9, grass: 5, dgrass: 6, snow: 4, cobble: 3.5, paved: 3.5 };
  var SOFT = { grass: 1, dgrass: 1, dirt: 1, sand: 1, snow: 1, rocky: 1 };
  function isWaterMat(m) { return m === 'deep' || m === 'shallow'; }
  var curVer = -1;

  function groundMat(s, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= W * P || ty >= H * P) return 'deep';
    var t = L.tileAt(s, tx, ty);
    if (t === T.ROAD || t === T.BRIDGE) {
      var pi = ((ty / P) | 0) * W + ((tx / P) | 0), g = roadGrade(s, pi, (ty % P) * P + (tx % P), curVer);
      return t === T.BRIDGE ? (g >= 2 ? 'sbridge' : 'bridge') : ROADMAT[g];
    }
    if (L.SOLID[t]) { var gr = L.groundFor(L.lookTerrain(s, tx, ty)); if (L.WATER[gr]) gr = T.GRASS; return MAT[gr]; }
    return MAT[t] || 'grass';
  }

  function flat(rmp, base, n, wx, wy, spread) {
    var v = base + (n - 0.5) * spread;
    var i = Math.floor(v * rmp.length + bayer(wx, wy) * 0.35);
    return rmp[i < 0 ? 0 : i >= rmp.length ? rmp.length - 1 : i];
  }
  function cellDetail(seed, wx, wy, ch, odds) {
    var cx = wx >> 2, cy = wy >> 2, h = hrand(seed, cx, cy, ch);
    if (h > odds) return -1;
    var ax = (Sim.hash4(seed, cx, cy, ch + 1) % 3), ay = (Sim.hash4(seed, cx, cy, ch + 2) % 2);
    var lx = (wx & 3) - ax, ly = (wy & 3) - ay;
    return ly >= 0 && ly <= 1 && lx >= 0 && lx <= 2 ? ly * 3 + lx : -1;
  }
  function groundPixel(m, wx, wy, seed) {
    var n = L.noise(seed, wx, wy, 14, 951);
    switch (m) {
      case 'grass': {
        var gd = cellDetail(seed, wx, wy, 953, 0.16);
        if (gd === 0 || gd === 2) return RS.grass[3];
        if (gd === 1) return RS.grass[4];
        if (gd === 4) return RS.grass[1];
        if (SEASON === 0) { var fl = cellDetail(seed, wx, wy, 957, 0.012); if (fl === 1) return hrand(seed, wx >> 2, wy >> 2, 958) > 0.5 ? [236, 214, 90] : [236, 150, 190]; }
        return flat(RS.grass, 0.5, n, wx, wy, 0.38);
      }
      case 'dgrass': { var dd = cellDetail(seed, wx, wy, 954, 0.14); if (dd === 1) return RS.dgrass[3]; if (dd === 4) return RS.dgrass[0]; return flat(RS.dgrass, 0.5, n, wx, wy, 0.4); }
      case 'dirt': { var pd = cellDetail(seed, wx, wy, 955, 0.08); if (pd === 1) return RS.dirt[0]; if (pd === 0) return RS.dirt[3]; return flat(RS.dirt, 0.55, n, wx, wy, 0.35); }
      case 'sand': { var sd = cellDetail(seed, wx, wy, 956, 0.06); if (sd === 4) return R.sand[1]; return flat(R.sand, 0.62, n, wx, wy, 0.3); }
      case 'rocky': { var rd = cellDetail(seed, wx, wy, 959, 0.12); if (rd === 1 || rd === 4) return R.rocky[0]; if (rd === 0) return R.rocky[3]; return flat(SEASON === 2 ? R.snow : R.rocky, 0.5, n, wx, wy, 0.35); }
      case 'snow': return flat(R.snow, 0.68, n, wx, wy, 0.3);
      case 'path': {
        // a worn trail: earth showing through the grass
        var hp = hrand(seed, wx, wy, 964);
        return hp > 0.45 ? flat(RS.road, 0.6, n, wx, wy, 0.3) : flat(RS.grass, 0.45, n, wx, wy, 0.3);
      }
      case 'road': { var od = cellDetail(seed, wx, wy, 961, 0.07); if (od === 1) return RS.road[0]; if (od === 0) return RS.road[3]; return flat(RS.road, 0.55, n, wx, wy, 0.25); }
      case 'cobble': {
        // rounded stones in staggered rows, dark mortar between
        var row = wy >> 2, sx = (wx + (row & 1) * 2) & 3, sy = wy & 3;
        if (sx === 3 || sy === 3) return R.cobble[0];
        var lit = sx === 0 && sy === 0 ? 3 : hrand(seed, (wx + (row & 1) * 2) >> 2, row, 965) > 0.5 ? 2 : 1;
        return SEASON === 2 && hrand(seed, wx, wy, 966) > 0.6 ? R.snow[2] : R.cobble[lit];
      }
      case 'paved': {
        var px2 = (wx & 7), py2 = (wy & 7);
        if (px2 === 7 || py2 === 7) return R.paved[0];
        return px2 === 0 || py2 === 0 ? R.paved[3] : hrand(seed, wx >> 3, wy >> 3, 967) > 0.5 ? R.paved[2] : R.paved[1];
      }
      case 'shallow': {
        var band = Math.sin(wx * 0.22 + wy * 0.55 + n * 4);
        var cr = cellDetail(seed, wx, wy, 962, 0.05);
        if (cr === 0 || cr === 1) return R.foam[0];
        return band > 0.75 ? R.shallow[3] : band > -0.2 ? R.shallow[2] : R.shallow[1];
      }
      case 'deep': {
        var db = Math.sin(wx * 0.18 + wy * 0.42 + n * 4);
        var dc = cellDetail(seed, wx, wy, 963, 0.03);
        if (dc === 1) return R.deep[3];
        return db > 0.8 ? R.deep[2] : db > -0.5 ? R.deep[1] : R.deep[0];
      }
      case 'bridge': { var plank = (wy & 3) === 3, rail = (wx & 15) === 0 || (wx & 15) === 15; return rail ? R.wood[0] : plank ? R.wood[1] : R.wood[(wx >> 3) & 1 ? 2 : 3]; }
      case 'sbridge': { var arail = (wx & 15) <= 1 || (wx & 15) >= 14; return arail ? R.stone[3] : ((wy & 3) === 3 ? R.stone[1] : R.stone[2]); }
    }
    return RS.grass[2];
  }

  // ---------------------------------------------------------------------------
  // Sprites, drawn pixel by pixel and cached (keys include the season where it matters)
  // ---------------------------------------------------------------------------
  var spriteCache = {};
  function sprite(key, w, h, draw, noOutline) {
    var c = spriteCache[key];
    if (c) return c;
    c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d'), px = function (x, y, col) { if (col) { g.fillStyle = css(col); g.fillRect(x, y, 1, 1); } };
    draw(px, g);
    if (!noOutline) outline(g, w, h);
    spriteCache[key] = c;
    return c;
  }
  function outline(g, w, h) {
    var img = g.getImageData(0, 0, w, h), d = img.data, out = [];
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3]) continue;
      var near = (x > 0 && d[(y * w + x - 1) * 4 + 3] > 200) || (x < w - 1 && d[(y * w + x + 1) * 4 + 3] > 200) ||
        (y > 0 && d[((y - 1) * w + x) * 4 + 3] > 200) || (y < h - 1 && d[((y + 1) * w + x) * 4 + 3] > 200);
      if (near) out.push(x, y);
    }
    g.fillStyle = css(R.outline);
    for (var k = 0; k < out.length; k += 2) g.fillRect(out[k], out[k + 1], 1, 1);
  }

  // ---- trees, rocks, undergrowth
  function treeSprite(v) {
    return sprite('tree' + v + ':' + SEASON, 18, 24, function (px) {
      var cx = 9, cy = 9, r = 6.5 + (v % 3) * 0.6, bare = SEASON === 2;
      for (var y = 0; y < 24; y++) for (var x = 0; x < 18; x++) {
        if (x >= 8 && x <= 9 && y >= 14 && y <= 21) { px(x, y, x === 8 ? R.wood[2] : R.wood[1]); continue; }
        var dx = x - cx + 0.5, dy = (y - cy + 0.5) * 1.05, dist = Math.sqrt(dx * dx + dy * dy);
        var lumpy = r + Math.sin(Math.atan2(dy, dx) * 5 + v) * 0.8;
        if (dist > lumpy) continue;
        if (bare) {
          // bare branches with a dusting of snow
          var branch = (Math.abs(dx * 1.3 - dy) < 0.8 || Math.abs(dx * -1.2 - dy) < 0.8 || Math.abs(dx) < 0.6) && dist < lumpy - 0.5;
          if (!branch) continue;
          px(x, y, dy < -2 && hrand(v, x, y, 4) > 0.5 ? R.snow[3] : R.wood[1]);
          continue;
        }
        var light = 0.75 - (dx + dy) / (r * 2.6) - dist / (r * 4) + (hrand(v, x, y, 3) - 0.5) * 0.25;
        px(x, y, pick(RS.leaf, light, x, y));
      }
    });
  }
  function pineSprite(v, snowy) {
    var sn = snowy || SEASON === 2;
    return sprite('pine' + v + (sn ? 's' : ''), 16, 26, function (px) {
      for (var y = 1; y < 26; y++) for (var x = 0; x < 16; x++) {
        if (x >= 7 && x <= 8 && y >= 21) { px(x, y, R.wood[1]); continue; }
        if (y > 21) continue;
        var tier = (y - 1) % 7, half = 1 + tier + Math.floor((y - 1) / 7) * 1.4 - (v % 2) * 0.5;
        var dx = x - 7.5;
        if (Math.abs(dx) > half) continue;
        var light = 0.7 - dx / 12 - tier / 14 + (hrand(v, x, y, 5) - 0.5) * 0.2;
        var col = pick(R.pine, light, x, y);
        if (sn && tier < 2 && hrand(v, x, y, 6) > 0.35) col = R.snow[3];
        px(x, y, col);
      }
    });
  }
  function rockSprite(v, big) {
    var w = big ? 16 : 13, h = big ? 13 : 9;
    return sprite('rock' + v + (big ? 'b' : '') + (SEASON === 2 ? 'w' : ''), w, h, function (px) {
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
        var dx = (x - w / 2 + 0.5) / (w / 2), dy = (y - h / 2 + 0.5) / (h / 2);
        if (dx * dx + dy * dy * (1 + hrand(v, x, 0, 7) * 0.3) > 1) continue;
        var light = 0.65 - dx * 0.25 - dy * 0.35 + (hrand(v, x, y, 8) - 0.5) * 0.2;
        var col = pick(R.stone, light, x, y);
        if ((big || SEASON === 2) && dy < -0.35 && hrand(v, x, y, 9) > 0.25) col = R.snow[3];
        px(x, y, col);
      }
    });
  }
  function cactusSprite() {
    return sprite('cactus', 12, 18, function (px) {
      var put = function (x, y) { px(x, y, x === 5 || x === 2 || x === 9 ? R.cactus[2] : R.cactus[1]); };
      for (var y = 2; y < 18; y++) for (var x = 4; x < 8; x++) put(x, y);
      for (y = 6; y < 11; y++) { put(1, y); put(2, y); }
      for (var x2 = 1; x2 < 5; x2++) put(x2, 10);
      for (y = 4; y < 9; y++) { put(9, y); put(10, y); }
      for (x2 = 7; x2 < 11; x2++) put(x2, 8);
    });
  }
  function bushSprite(v) {
    return sprite('bush' + (v % 3) + ':' + SEASON, 10, 7, function (px) {
      for (var y = 0; y < 7; y++) for (var x = 0; x < 10; x++) {
        var dx = (x - 4.5) / 4.8, dy = (y - 4) / 3.4;
        if (dx * dx + dy * dy > 1) continue;
        var col = pick(RS.leaf, 0.7 - dx * 0.2 - dy * 0.35 + (hrand(v, x, y, 11) - 0.5) * 0.3, x, y);
        if (SEASON === 2 && dy < -0.2) col = R.snow[3];
        if (SEASON === 0 && v % 3 === 0 && hrand(v, x, y, 12) > 0.86) col = [220, 70, 80];   // berries
        px(x, y, col);
      }
    });
  }
  function fernSprite(v) {
    return sprite('fern' + (v % 2) + ':' + SEASON, 9, 7, function (px) {
      var c1 = SEASON === 1 ? R.dead[2] : RS.leaf[3], c2 = SEASON === 1 ? R.dead[1] : RS.leaf[2];
      for (var k = -3; k <= 3; k++) { var x = 4 + k; for (var y = Math.abs(k); y < 7; y++) if ((x + y + v) % 3 !== 0) px(x, y, y === Math.abs(k) ? c1 : c2); }
    }, true);
  }
  function reedSprite(v) {
    return sprite('reed' + (v % 2) + ':' + SEASON, 7, 10, function (px) {
      for (var k = 0; k < 4; k++) {
        var x = 1 + k * 2 - (k > 1 ? 1 : 0), top = 1 + ((v + k) % 3);
        for (var y = top; y < 10; y++) px(x, y, SEASON === 2 ? R.dead[0] : y < top + 2 ? R.wood[1] : R.leaf[2]);
      }
    }, true);
  }
  function bannerSprite(sig) {
    var cr = civRamp(sig);
    return sprite('banner' + sig, 9, 18, function (px) {
      for (var y = 1; y < 18; y++) px(1, y, R.wood[y < 3 ? 2 : 1]);
      px(1, 0, R.gold[2]);
      for (var y2 = 2; y2 < 8; y2++) for (var x = 2; x < 9; x++) { if (x === 8 && (y2 === 4 || y2 === 5)) continue; px(x, y2, y2 < 4 ? cr[3] : x > 6 ? cr[1] : cr[2]); }
      px(4, 4, R.gold[2]); px(5, 5, R.gold[2]);
    });
  }

  // ---- buildings
  function houseSprite(age, sig, v) {
    var cr = sig ? civRamp(sig) : [R.wood[0], R.wood[1], R.wood[2], R.wood[3]];
    var style = age <= 1 ? 0 : age <= 3 ? 1 : 2, winter = SEASON === 2;
    return sprite('house' + style + ':' + sig + ':' + (v & 3) + (winter ? 'w' : ''), 16, 24, function (px) {
      if (style === 0) {
        for (var y = 6; y < 24; y++) for (var x = 0; x < 16; x++) {
          var dx = (x - 7.5) / 7.8, dy = (y - 15) / 9;
          if (y < 15 && dx * dx + dy * dy > 1) continue;
          if (y >= 15 && Math.abs(x - 7.5) > 7.5) continue;
          if (y >= 17) { px(x, y, x >= 6 && x <= 9 && y >= 18 ? R.wood[0] : pick(R.dirt, 0.6 - (x - 8) / 20, x, y)); continue; }
          if (y === 15 || y === 16) { px(x, y, cr[1]); continue; }
          var thatchCol = pick(R.thatch, 0.75 - dx * 0.3 - dy * 0.2 + ((x + y * 2) % 3 === 0 ? -0.15 : 0), x, y);
          if (winter && dy < -0.3) thatchCol = R.snow[(x + y) & 1 ? 3 : 2];
          px(x, y, thatchCol);
        }
      } else {
        var wallTop = style === 2 ? 12 : 14, wide = v & 2;
        for (var ry = 2; ry < wallTop; ry++) {
          var half = Math.min(8, 2 + (ry - 2) * (wide ? 1.1 : 0.9));
          for (var rx = 0; rx < 16; rx++) {
            if (Math.abs(rx - 7.5) > half) continue;
            var col = rx < 8 ? cr[2] : cr[1];
            if (ry === wallTop - 1) col = cr[0];
            if ((ry + (rx < 8 ? 0 : 1)) % 3 === 0) col = rx < 8 ? cr[3] : cr[0];
            if (winter && ry < wallTop - 2 && (rx < 8 || ry < 5)) col = R.snow[rx < 8 ? 3 : 2];
            px(rx, ry, col);
          }
        }
        if (v & 1) for (var cy = 0; cy < 6; cy++) { px(11, cy, R.stone[1]); px(12, cy, R.stone[2]); }
        for (var wy = wallTop; wy < 24; wy++) for (var wx = 1; wx < 15; wx++) {
          var wc = style === 2 ? R.plaster[(wx + wy) % 5 === 0 ? 1 : 2] : pick(R.thatch, 0.55 + (wx < 8 ? 0.15 : 0), wx, wy);
          if (style === 2 && (wx === 1 || wx === 14 || wy === wallTop || wy === 18)) wc = R.wood[1];
          if (style === 1 && (wx === 1 || wx === 14)) wc = R.wood[1];
          var door = (v & 2) ? (wx >= 9 && wx <= 12) : (wx >= 6 && wx <= 9);
          if (door && wy >= 18) wc = wy === 18 ? R.wood[2] : R.wood[0];
          var win = (v & 2) ? (wx === 3 || wx === 4) : ((wx === 3 || wx === 4) || (wx === 11 || wx === 12));
          if (win && (wy === wallTop + 2 || wy === wallTop + 3)) wc = winter || (v & 4) ? [240, 200, 110] : [70, 110, 150];
          px(wx, wy, wc);
        }
      }
    });
  }
  function wallSprite(age, kind, vert) {
    var wooden = age <= 1;
    return sprite('wall' + (wooden ? 'w' : 's') + kind + (vert ? 'v' : '') + (SEASON === 2 ? 'S' : ''), 16, 24, function (px) {
      if (kind === 'gate') {
        var posts = vert ? [[0, 2], [13, 15]] : [[0, 3], [12, 15]];
        posts.forEach(function (pp) { for (var y = 2; y < 24; y++) for (var x = pp[0]; x <= pp[1]; x++) px(x, y, wooden ? R.wood[x === pp[0] ? 2 : 1] : R.stone[x === pp[0] ? 3 : 2]); });
        return;
      }
      for (var y = 4; y < 24; y++) for (var x = 0; x < 16; x++) {
        if (wooden) {
          var stake = x % 4, top = 4 + (stake === 1 || stake === 2 ? 0 : 1);
          if (y < top) continue;
          px(x, y, stake === 3 ? R.wood[0] : stake === 0 ? R.wood[2] : R.wood[1]);
        } else {
          if (y < 8 && (x % 6 >= 4)) continue;
          var brick = ((y >> 2) & 1) ? x + 3 : x;
          var c = (y & 3) === 3 || brick % 6 === 5 ? R.stone[1] : R.stone[y < 8 ? 3 : 2];
          if (SEASON === 2 && (y === 4 || y === 8 && x % 6 >= 4)) c = R.snow[3];
          px(x, y, c);
        }
      }
    });
  }
  function keepSprite(age, sig) {
    var cr = sig ? civRamp(sig) : [R.wood[0], R.wood[1], R.wood[2], R.wood[3]], wooden = age <= 1;
    return sprite('keep' + (wooden ? 'w' : 's') + ':' + sig + (SEASON === 2 ? 'S' : ''), 32, 48, function (px) {
      for (var y = 10; y < 48; y++) for (var x = 2; x < 30; x++) {
        if (y < 14 && (x % 6 >= 4)) continue;
        var c;
        if (wooden) c = x % 4 === 3 ? R.wood[0] : x % 4 === 0 ? R.wood[2] : R.wood[1];
        else { var br = ((y >> 2) & 1) ? x + 3 : x; c = (y & 3) === 3 || br % 6 === 5 ? R.stone[1] : R.stone[x < 16 ? 3 : 2]; }
        if (x >= 13 && x <= 18 && y >= 38) c = y === 38 ? R.wood[2] : R.wood[0];
        if ((x === 8 || x === 9 || x === 22 || x === 23) && y >= 22 && y <= 25) c = [240, 200, 110];
        if (SEASON === 2 && y === 10) c = R.snow[3];
        px(x, y, c);
      }
      for (var py = 0; py < 12; py++) px(16, py, R.wood[0]);
      for (py = 0; py < 6; py++) for (var fx = 17; fx < 25; fx++) px(fx, py, fx < 21 ? cr[2] : cr[1]);
    });
  }

  // ---------------------------------------------------------------------------
  // A province as one small canvas
  // ---------------------------------------------------------------------------
  var provCache = {}, provOrder = [], budget = 99;
  function beginFrame() { budget = 4; }
  function provKey(s, pi, ver, dyn) {
    var c = s.owner[pi];
    return dyn.key + '|' + SEASON + '|' + (c >= 0 && s.pop[pi] > 0 ? highways(s, ver)[pi] + ':' + (s.cCap[c] === pi ? 1 : 0) : 'w');
  }
  function renderProvince(s, pi, ver) {
    curVer = ver;
    var dyn = L.getDyn(s, pi, ver), key = provKey(s, pi, ver, dyn), rc = provCache[pi];
    if (rc && rc.key === key) return rc.canvas;
    // a few repaints a frame (seasons change everything at once); show the old picture meanwhile
    if (rc && budget <= 0) return rc.canvas;
    budget--;
    var cv = rc ? rc.canvas : document.createElement('canvas');
    cv.width = PW; cv.height = PW + PAD;
    var g = cv.getContext('2d'), seed = s.seed, px0 = (pi % W) * P, py0 = ((pi / W) | 0) * P;
    g.clearRect(0, 0, PW, PW + PAD);
    var img = g.createImageData(PW, PW + PAD), buf = new Uint32Array(img.data.buffer);
    var st = L.staticTiles(s, pi), lx, ly, x, y;
    for (ly = 0; ly < P; ly++) for (lx = 0; lx < P; lx++) {
      var tx = px0 + lx, ty = py0 + ly, m = groundMat(s, tx, ty);
      var nb = [groundMat(s, tx, ty - 1), groundMat(s, tx + 1, ty), groundMat(s, tx, ty + 1), groundMat(s, tx - 1, ty)];
      // diagonals, for rounding off square corners: NE, SE, SW, NW
      var dg = [groundMat(s, tx + 1, ty - 1), groundMat(s, tx + 1, ty + 1), groundMat(s, tx - 1, ty + 1), groundMat(s, tx - 1, ty - 1)];
      var deco = dyn.deco[ly * P + lx], field = deco === D.FIELD || deco === D.DEADFIELD;
      for (y = 0; y < PT; y++) for (x = 0; x < PT; x++) {
        var wx = tx * PT + x, wy = ty * PT + y, mm = m, foam = false;
        var dists = [y, PT - 1 - x, PT - 1 - y, x], best = -1, bestP = PRIO[m];
        for (var k = 0; k < 4; k++) {
          var n = nb[k];
          if (n === m) continue;
          if (SOFT[m] && SOFT[n]) {
            // a soft edge wanders both ways: the same world noise decides on either side
            var hi = PRIO[n] > PRIO[m], off = (L.noise(seed, wx, wy, 7, 961) - 0.5) * 16 + (L.noise(seed, wx, wy, 2, 962) - 0.5) * 3;
            if (hi ? off > dists[k] : -off > dists[k]) { best = k; bestP = 99; }
            continue;
          }
          var th = (m === 'path' ? 4 : 1.5) + L.noise(seed, wx, wy, 3, 960 + k) * 3.5;
          if (dists[k] < th && PRIO[n] > bestP && PRIO[m] < 8 && PRIO[n] < 9) { best = k; bestP = PRIO[n]; }
          if (isWaterMat(m) && !isWaterMat(n) && dists[k] < 1 + L.noise(seed, wx, wy, 2, 970) * 1.6) foam = true;
        }
        if (best >= 0) mm = nb[best];
        else if (PRIO[m] < 9) {
          // round a corner that sticks out into something else
          for (var c2 = 0; c2 < 4; c2++) {
            var ea = c2 === 0 || c2 === 3 ? 0 : 2, eb = c2 < 2 ? 1 : 3, n2 = dg[c2];
            if (n2 === m || nb[ea] !== n2 || nb[eb] !== n2 || PRIO[n2] >= 9) continue;
            var rr = 4 + L.noise(seed, wx, wy, 4, 963) * 5, ux = rr - dists[eb], uy = rr - dists[ea];
            if (ux > 0 && uy > 0 && ux * ux + uy * uy > rr * rr) { mm = n2; break; }
          }
        }
        var col = foam && isWaterMat(mm) ? (SEASON === 2 ? R.snow[3] : R.foam[(wx + wy) & 1]) : groundPixel(mm, wx, wy, seed);
        if (field && mm === m) {
          var row = (y + (lx & 1) * 2) % 4, ripe = (lx + ly) & 1;
          if (deco === D.DEADFIELD) col = row < 2 ? R.dead[1] : R.dead[0];
          else if (SEASON === 1) col = row === 0 ? RS.dirt[1] : (x + y) % 3 === 0 ? R.wheat[2] : R.wheat[ripe ? 1 : 0];   // harvest stubble
          else col = row === 0 ? RS.dirt[1] : row === 1 ? RS.dirt[2] : ripe ? RS.wheat[(x + y) % 3 === 0 ? 2 : 1] : RS.crop[(x + y) % 3 === 0 ? 2 : 1];
          if (x === 0 || x === PT - 1 || y === 0) col = RS.dirt[0];
        }
        buf[(y + ly * PT + PAD) * PW + x + lx * PT] = 0xff000000 | (col[2] << 16) | (col[1] << 8) | col[0];
      }
    }
    g.putImageData(img, 0, 0);
    // things on the ground, back to front, each nudged off the grid
    for (ly = 0; ly < P; ly++) for (lx = 0; lx < P; lx++) {
      var i = ly * P + lx, v = st[i], d = dyn.deco[i], bx = lx * PT, by = ly * PT + PAD, h = Sim.hash4(seed, px0 + lx, py0 + ly, 980);
      var jx = (h % 7) - 3, jy = ((h >> 4) % 5) - 2, sp = null, sx = bx, sy = by;
      if (v === T.TREE) { sp = treeSprite(h % 5); sx = bx - 1 + jx; sy = by - 9 + jy; }
      else if (v === T.PINE) { var t0 = s.terrain[pi]; sp = pineSprite(h % 4, t0 === TER.MOUNTAIN || t0 === TER.HILLS); sx = bx + jx; sy = by - 11 + jy; }
      else if (v === T.ROCK) { var big = s.terrain[pi] === TER.MOUNTAIN; sp = rockSprite(h % 3, big); sx = bx + (big ? 0 : 2) + jx; sy = by + (big ? 2 : 5) + (jy >> 1); }
      else if (v === T.CACTUS) { sp = cactusSprite(); sx = bx + 2 + jx; sy = by - 2; }
      else if (!d && (v === T.GRASS || v === T.DGRASS || v === T.DIRT || v === T.SAND)) {
        // undergrowth: bushes and ferns in the woods, reeds by the water
        var r2 = (h >> 9) % 1000 / 1000, nearWater = false;
        for (var q = 0; q < 4 && !nearWater; q++) { var nt = L.tileAt(s, px0 + lx + [0, 1, 0, -1][q], py0 + ly + [-1, 0, 1, 0][q]); nearWater = nt === T.STREAM || nt === T.SHALLOW; }
        if (nearWater && r2 < 0.45) { sp = reedSprite(h); sx = bx + 4 + (jx >> 1); sy = by + 4; }
        else if (v === T.DGRASS && r2 < 0.3) { sp = r2 < 0.12 ? bushSprite(h) : fernSprite(h); sx = bx + 3 + jx; sy = by + 6 + jy; }
        else if (v === T.GRASS && r2 < 0.07) { sp = r2 < 0.03 ? bushSprite(h) : fernSprite(h); sx = bx + 3 + jx; sy = by + 6 + jy; }
      }
      if (sp) g.drawImage(sp, sx, sy);
      if (d === D.HOUSE) g.drawImage(houseSprite(dyn.age, dyn.sig, h), bx + (jx >> 1), by - 8);
      else if (d === D.WALL) g.drawImage(wallSprite(dyn.age, 'wall'), bx, by - 8);
      else if (d === D.GATE) g.drawImage(wallSprite(dyn.age, 'gate', lx === C || L.tileAt(s, px0 + lx, py0 + ly - 1) === T.ROAD), bx, by - 8);
      else if (d === D.KEEP) g.drawImage(keepSprite(dyn.age, dyn.sig), bx, by - 16);
    }
    // borders: a banner where a road enters this realm from another
    if (dyn.sig) {
      var segs = L.pathSegments(s, pi);
      for (var e = 0; e < 4; e++) {
        if (dyn.nb[e] === dyn.sig) continue;
        for (var t = 0; t < P; t++) {
          var ex = e === 1 ? P - 1 : e === 3 ? 0 : t, ey = e === 0 ? 0 : e === 2 ? P - 1 : t, ei = ey * P + ex;
          if (!(segs[ei] & (1 << e))) continue;
          var ix = ex + (e === 1 ? -1 : e === 3 ? 1 : 0), iy = ey + (e === 2 ? -1 : e === 0 ? 1 : 0);
          g.drawImage(bannerSprite(dyn.sig), ix * PT + (e === 0 || e === 2 ? 11 : 4), iy * PT + PAD - 6);
          break;
        }
      }
    }
    if (!rc) {
      provCache[pi] = rc = { canvas: cv, key: '' };
      provOrder.push(pi);
      if (provOrder.length > 90) { var old = provOrder.shift(); delete provCache[old]; }
    }
    rc.key = key;
    return cv;
  }
  function clearCaches() { provCache = {}; provOrder = []; HW.ver = -1; }

  // ---------------------------------------------------------------------------
  // Characters: 16x24 sprite sheets built from parts
  // ---------------------------------------------------------------------------
  var SKINS = [['#f2c69c', '#d49a72'], ['#d9a273', '#a8704a'], ['#a8704a', '#7a4c2e'], ['#7a4c2e', '#57341e']].map(function (p) { return p.map(hex); });
  var HAIRS = ['#2a1c14', '#5a3a1e', '#8a5a2a', '#c49a50', '#d8d0c0', '#3a2a2a'].map(hex);
  var sheetCache = {};
  function sheet(spec) {
    var key = JSON.stringify(spec), c = sheetCache[key];
    if (c) return c;
    c = document.createElement('canvas'); c.width = 16 * 3; c.height = 24 * 4;
    var g = c.getContext('2d');
    for (var dir = 0; dir < 3; dir++) for (var f = 0; f < 3; f++) drawFrame(g, spec, dir, f, f * 16, dir * 24);
    g.save(); g.translate(16 * 3, 0); g.scale(-1, 1);
    for (f = 0; f < 3; f++) g.drawImage(c, (2 - f) * 16, 24, 16, 24, f * 16, 72, 16, 24);
    g.restore();
    sheetCache[key] = c;
    return c;
  }
  function drawFrame(g0, spec, dir, f, ox, oy) {
    var tmp = document.createElement('canvas'); tmp.width = 16; tmp.height = 24;
    var g = tmp.getContext('2d');
    var put = function (x, y, col) { if (col && x >= 0 && y >= 0 && x < 16 && y < 24) { g.fillStyle = css(col); g.fillRect(x, y, 1, 1); } };
    var body = spec.body, bl = shadeOf(body, 1.2), bd = shadeOf(body, 0.72), skin = spec.skin[0], skinD = spec.skin[1];
    var hair = spec.hair, pants = shadeOf(body, 0.5), boots = R.wood[0], belt = spec.belt || R.wood[1];
    var x, y, step = f === 0 ? 0 : f === 1 ? 1 : -1;
    var front = dir === 0, back = dir === 2, side = dir === 1;
    if (!spec.robe) {
      if (side) {
        var a = step === 0 ? [6, 9] : step > 0 ? [5, 10] : [7, 8];
        a.forEach(function (lxx, i) { for (y = 18; y < 22; y++) { put(lxx, y, pants); put(lxx + 1, y, pants); } put(lxx - (i === 0 ? 1 : 0), 22, boots); put(lxx, 22, boots); put(lxx + 1, 22, boots); });
      } else {
        var liftL = step > 0 ? 1 : 0, liftR = step < 0 ? 1 : 0;
        for (y = 18; y < 22 - liftL; y++) { put(5, y, pants); put(6, y, pants); }
        for (y = 18; y < 22 - liftR; y++) { put(9, y, pants); put(10, y, pants); }
        put(5, 22 - liftL, boots); put(6, 22 - liftL, boots); put(9, 22 - liftR, boots); put(10, 22 - liftR, boots);
      }
    } else {
      for (y = 18; y < 23; y++) for (x = 3; x < 13; x++) { var wdt = 4 + (y - 18) * 0.3; if (Math.abs(x - 7.5) > wdt) continue; put(x, y, x < 6 ? bl : x > 10 ? bd : body); }
      put(5 + (step > 0 ? -1 : 0), 23, boots); put(10 + (step < 0 ? 1 : 0), 23, boots);
    }
    var tx0 = side ? 5 : 4, tx1 = side ? 10 : 11;
    for (y = 11; y < 18; y++) for (x = tx0; x <= tx1; x++) put(x, y, x === tx0 ? bl : x === tx1 ? bd : body);
    for (x = tx0 + 1; x < tx1; x++) put(x, 16, belt);
    if (spec.belt && front) put(7, 16, R.gold[2]);
    if (side) {
      var ax = step > 0 ? 5 : step < 0 ? 8 : 7;
      for (y = 12; y < 16; y++) { put(ax, y, bd); put(ax + 1, y, body); }
      put(ax, 16, skin); put(ax + 1, 16, skin);
    } else {
      var la = step > 0 ? -1 : 0, ra = step < 0 ? -1 : 0;
      for (y = 12 + la; y < 16 + la; y++) put(3, y, bl);
      for (y = 12 + ra; y < 16 + ra; y++) put(12, y, bd);
      put(3, 16 + la, skin); put(12, 16 + ra, skin);
    }
    var hx0 = 4, hx1 = side ? 10 : 11;
    for (y = 3; y < 11; y++) for (x = hx0; x <= hx1; x++) { if ((y === 3 || y === 10) && (x === hx0 || x === hx1)) continue; put(x, y, x === hx1 ? skinD : skin); }
    if (back) { for (y = 3; y < 10; y++) for (x = hx0; x <= hx1; x++) if (!((y === 3) && (x === hx0 || x === hx1))) put(x, y, (x + y) % 4 === 0 ? shadeOf(hair, 1.3) : hair); }
    else if (side) { for (x = hx0; x <= hx1; x++) { put(x, 3, hair); put(x, 4, hair); } for (y = 5; y < 9; y++) { put(hx1, y, hair); put(hx1 - 1, y, hair); } put(hx0, 5, hair); }
    else { for (x = hx0; x <= hx1; x++) { put(x, 3, hair); put(x, 4, hair); } put(hx0, 5, hair); put(hx1, 5, hair); put(hx0, 6, hair); put(hx1, 6, hair); }
    if (front) { put(6, 7, R.outline); put(9, 7, R.outline); put(7, 9, skinD); put(8, 9, skinD); }
    else if (side) { put(5, 7, R.outline); put(3, 8, skin); }
    var hc = spec.hatCol;
    if (spec.hat === 'hood') {
      for (x = hx0 - (side ? 0 : 1); x <= hx1 + 1; x++) { put(x, 2, hc); put(x, 3, hc); put(x, 4, hc); }
      if (front) for (y = 5; y < 11; y++) { put(3, y, hc); put(12, y, hc); }
      else if (side) for (y = 5; y < 11; y++) { put(hx1, y, hc); put(hx1 + 1, y, hc); put(hx1 - 1, y, shadeOf(hc, 0.8)); }
      else for (y = 2; y < 11; y++) for (x = 3; x <= 12; x++) put(x, y, (x + y) % 5 ? hc : shadeOf(hc, 0.8));
    } else if (spec.hat === 'helmet' || spec.hat === 'goldhelm') {
      var m1 = spec.hat === 'goldhelm' ? R.gold[2] : R.stone[3], m2 = spec.hat === 'goldhelm' ? R.gold[1] : R.stone[2], m3 = spec.hat === 'goldhelm' ? R.gold[3] : R.stone[4];
      for (y = 1; y < 6; y++) for (x = hx0; x <= hx1; x++) { if (y === 1 && (x === hx0 || x === hx1)) continue; put(x, y, x < 7 ? m3 : x > 9 ? m2 : m1); }
      if (front) { put(7, 6, m2); put(8, 6, m2); }
      put(7, 0, m2); put(8, 0, m2);
    } else if (spec.hat === 'crown') {
      for (x = hx0; x <= hx1; x++) { put(x, 2, R.gold[2]); put(x, 1, (x - hx0) % 3 === 0 ? R.gold[3] : null); }
      put(hx0, 0, R.gold[3]); put(hx1, 0, R.gold[3]); put(7, 0, R.gold[3]);
      if (front) put(7, 2, [200, 40, 60]);
    } else if (spec.hat === 'tophat') {
      for (y = 0; y < 4; y++) for (x = hx0 + 1; x < hx1; x++) put(x, y, [30, 30, 36]);
      for (x = hx0 - 1; x <= hx1 + 1; x++) put(x, 4, [30, 30, 36]);
    }
    outline(g, 16, 24);
    g0.drawImage(tmp, ox, oy);
  }
  function dirRow(face) {
    var a = ((face % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (a < Math.PI / 4 || a >= 7 * Math.PI / 4) return 3;
    if (a < 3 * Math.PI / 4) return 0;
    if (a < 5 * Math.PI / 4) return 1;
    return 2;
  }
  function drawCharacter(g, spec, face, walk, moving, x, y, alpha) {
    var sh = sheet(spec), row = dirRow(face), frame = moving ? 1 + (Math.floor(walk) % 2) : 0;
    shadow(g, x, y, 5);
    if (alpha != null) g.globalAlpha = alpha;
    g.drawImage(sh, frame * 16, row * 24, 16, 24, Math.round(x - 8), Math.round(y - 23), 16, 24);
    g.globalAlpha = 1;
    return row;
  }
  function shadow(g, x, y, r) {
    r = r || 5;
    g.fillStyle = 'rgba(10,10,20,0.32)';
    g.fillRect(Math.round(x - r), Math.round(y - 1), r * 2, 2);
    g.fillRect(Math.round(x - r + 1), Math.round(y - 2), r * 2 - 2, 4);
  }
  function drawWeapon(g, kind, row, x, y, swinging) {
    if (!kind || kind === 'fist' || kind === 'none') return;
    var X = Math.round(x), Y = Math.round(y), f = function (c, a, b, w, h) { g.fillStyle = css(c); g.fillRect(X + a, Y + b, w || 1, h || 1); };
    var steel = R.stone[4], steelD = R.stone[2], wood = R.wood[2], woodD = R.wood[1];
    var hand = row === 0 ? [4, -7] : row === 2 ? [-5, -8] : row === 1 ? [-3, -7] : [2, -7];
    var hx = hand[0], hy = hand[1];
    switch (kind) {
      case 'sword': case 'longsword': case 'rapier': case 'sabre': {
        var len = kind === 'longsword' ? 9 : kind === 'rapier' ? 9 : 7;
        if (swinging) { if (row === 1) f(steel, hx - len, hy - 1, len, 1); else if (row === 3) f(steel, hx + 1, hy - 1, len, 1); else f(steel, hx, row === 2 ? hy - len : hy + 1, 1, len); }
        else if (row === 0) { f(R.gold[1], hx - 1, hy, 3, 1); f(steel, hx, hy + 1, 1, len - 2); }
        else if (row === 2) { f(steel, hx, hy - len + 2, 1, len - 2); f(R.gold[1], hx - 1, hy, 3, 1); }
        else { f(R.gold[1], hx, hy - 1, 1, 3); f(steel, hx + (row === 1 ? -1 : 1), hy - len + 3, 1, len - 3); }
        break;
      }
      case 'club': f(woodD, hx, hy - 4, 1, 6); f(wood, hx - 1, hy - 6, 3, 3); break;
      case 'axe': f(woodD, hx, hy - 6, 1, 8); f(steel, hx + 1, hy - 6, 2, 3); break;
      case 'spear': f(woodD, hx, hy - 12, 1, 15); f(steel, hx, hy - 15, 1, 3); f(steelD, hx - 1, hy - 13, 3, 1); break;
      case 'staff': f(woodD, hx, hy - 10, 1, 14); f(R.gold[2], hx, hy - 11, 1, 1); break;
      case 'bow': case 'crossbow': {
        if (kind === 'crossbow') { f(woodD, hx - 3, hy, 7, 1); f(woodD, hx - 3, hy - 2, 1, 5); break; }
        var bx = row === 1 ? hx - 1 : hx + 1;
        f(woodD, bx, hy - 5, 1, 2); f(woodD, bx + (row === 1 ? -1 : 1), hy - 3, 1, 5); f(woodD, bx, hy + 2, 1, 2); f(steel, bx, hy - 3, 1, 5);
        break;
      }
      case 'sling': f(woodD, hx, hy, 1, 3); f(R.stone[2], hx, hy + 3, 2, 1); break;
      case 'gun': {
        if (row === 1) f([40, 40, 48], hx - 8, hy, 8, 1); else if (row === 3) f([40, 40, 48], hx + 1, hy, 8, 1); else f([40, 40, 48], hx, row === 2 ? hy - 8 : hy + 1, 1, 8);
        f(woodD, hx - 1, hy, 2, 2);
        break;
      }
      case 'shield': {
        var sx2 = row === 1 ? -7 : row === 3 ? 3 : row === 0 ? -6 : 2;
        f(R.wood[1], sx2, -15, 5, 7); f(R.stone[3], sx2 + 1, -14, 3, 5); f(R.gold[2], sx2 + 2, -12, 1, 1);
        break;
      }
    }
  }
  function skinFor(id) { return SKINS[Math.abs(id) % SKINS.length]; }
  function hairFor(id) { return HAIRS[Math.abs(id * 7 + 3) % HAIRS.length]; }

  // ---------------------------------------------------------------------------
  // Beasts and the horse: side-view sprites, two walking frames, flipped to face right
  // ---------------------------------------------------------------------------
  function beastSprite(kind, frame, angry) {
    var dims = { wolf: [20, 13], jackal: [18, 12], bear: [24, 16], rat: [11, 7] }[kind] || [20, 13];
    var rp = R[kind] || R.wolf;
    return sprite('beast' + kind + frame + (angry ? 'a' : ''), dims[0], dims[1], function (px) {
      var w = dims[0], h = dims[1], x, y;
      var ell = function (cx, cy, rx, ry, light) {
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
          var dx = (x - cx + 0.5) / rx, dy = (y - cy + 0.5) / ry;
          if (dx * dx + dy * dy > 1) continue;
          px(x, y, pick(rp, light - dy * 0.35 - dx * 0.1, x, y));
        }
      };
      if (kind === 'rat') {
        ell(5.5, 3.5, 3.6, 2.3, 0.6); ell(2, 3, 1.8, 1.6, 0.7);
        for (x = 9; x < 11; x++) px(x, 3 + (x - 9), [150, 110, 110]);
        px(1, 2, angry ? [255, 60, 50] : R.outline);
        px(3 + frame, 6, rp[0]); px(7 - frame, 6, rp[0]);
        return;
      }
      var big = kind === 'bear';
      var bcx = big ? 13 : w / 2 + 1, bcy = big ? 7.5 : 6, brx = big ? 9 : w / 2 - 3.5, bry = big ? 4.8 : 3.3;
      // legs
      var lx = big ? [6, 9, 15, 18] : [5, 7, w - 7, w - 5], top = Math.round(bcy + bry - 1), len = big ? 4 : 4;
      lx.forEach(function (x0, k) {
        var off = (k % 2 === frame) ? 1 : -1;
        for (y = top; y < top + len; y++) { px(x0 + (y > top + 1 ? off : 0), y, rp[k < 2 ? 1 : 0]); if (big) px(x0 + 1 + (y > top + 1 ? off : 0), y, rp[1]); }
      });
      ell(bcx, bcy, brx, bry, 0.65);
      // head
      var hcx = big ? 5 : 4, hcy = big ? 6 : 4.5, hr = big ? 3.6 : 2.8;
      ell(hcx, hcy, hr, hr * 0.95, 0.75);
      // snout and ears
      if (big) { for (x = 0; x < 3; x++) px(x, 7, rp[2]); px(3, 2, rp[1]); px(6, 2, rp[1]); }
      else { for (x = 0; x < 3; x++) { px(x, 5, rp[2]); px(x, 6, rp[1]); } px(3, 0, rp[1]); px(3, 1, rp[2]); px(5, 1, rp[1]); }
      // tail
      if (!big) for (x = w - 4; x < w; x++) { px(x, Math.round(bcy - 1 - (x - (w - 4)) * 0.6), rp[2]); px(x, Math.round(bcy - (x - (w - 4)) * 0.6), rp[1]); }
      px(big ? 3 : 2, big ? 5 : 3, angry ? [255, 60, 50] : R.outline);
    });
  }
  function drawBeast(g, a, x, y, scale) {
    var kind = a.kind === 'greatbeast' ? (a.look === 'bear' ? 'bear' : 'wolf') : a.kind;
    var angry = a.state === 'chase' || a.state === 'wind' || a.state === 'chargeWind' || a.state === 'charge';
    var moving = a.state === 'chase' || a.state === 'return' || a.state === 'charge' || (a.state === 'idle' && Math.hypot((a.wx || a.x) - a.x, (a.wy || a.y) - a.y) > 0.1);
    var sp = beastSprite(kind, moving ? Math.floor(a.walkT * 2) % 2 : 0, angry), sc = scale || 1;
    var w = sp.width * sc, h = sp.height * sc, right = Math.cos(a.face) > 0;
    shadow(g, x, y, Math.round(w / 2.6));
    g.save();
    g.translate(Math.round(x), Math.round(y - h + 1));
    if (right) { g.scale(-1, 1); g.translate(-Math.round(w / 2), 0); } else g.translate(-Math.round(w / 2), 0);
    if (a.flash > 0) g.filter = 'brightness(2.6)';
    if (a.kind === 'greatbeast') g.filter = (a.flash > 0 ? 'brightness(2.6) ' : '') + 'saturate(0.6) brightness(0.75)';
    g.drawImage(sp, 0, 0, w, h);
    g.restore();
    g.filter = 'none';
    return h;
  }
  function horseSprite(frame) {
    return sprite('horse' + frame, 24, 18, function (px) {
      var rp = R.horse, x, y;
      var ell = function (cx, cy, rx, ry, light) { for (y = 0; y < 18; y++) for (x = 0; x < 24; x++) { var dx = (x - cx + 0.5) / rx, dy = (y - cy + 0.5) / ry; if (dx * dx + dy * dy <= 1) px(x, y, pick(rp, light - dy * 0.35, x, y)); } };
      [7, 9, 16, 18].forEach(function (x0, k) { var off = (k % 2 === frame) ? 1 : -1; for (y = 10; y < 17; y++) px(x0 + (y > 13 ? off : 0), y, rp[k < 2 ? 1 : 0]); px(x0 + (off), 17, R.outline); });
      ell(13, 8, 8, 3.6, 0.65);
      for (y = 2; y < 8; y++) { px(5 + Math.round((7 - y) * 0.2), y, rp[2]); px(6 + Math.round((7 - y) * 0.2), y, rp[2]); px(7 + Math.round((7 - y) * 0.2), y, rp[1]); }
      for (y = 1; y < 5; y++) for (x = 1; x < 6; x++) px(x, y, rp[y < 2 ? 3 : 2]);
      px(2, 2, R.outline);
      for (y = 1; y < 8; y++) px(8 + Math.round((7 - y) * 0.2), y, R.wood[0]);
      for (y = 6; y < 12; y++) px(21 + (y > 8 ? 1 : 0), y, R.wood[0]);
      for (x = 11; x < 16; x++) { px(x, 4, [150, 40, 40]); px(x, 5, [120, 30, 30]); }
    });
  }
  function drawHorse(g, x, y, face, walk, moving) {
    var sp = horseSprite(moving ? Math.floor(walk * 2) % 2 : 0), right = Math.cos(face) > 0;
    shadow(g, x, y + 1, 10);
    g.save(); g.translate(Math.round(x), Math.round(y - 16));
    if (right) { g.scale(-1, 1); }
    g.drawImage(sp, -12, 0);
    g.restore();
  }

  // ---------------------------------------------------------------------------
  // Objects, camps, pickups
  // ---------------------------------------------------------------------------
  function objectSprite(kind) {
    switch (kind) {
      case 'granary': return sprite('granary', 18, 22, function (px) {
        for (var y = 0; y < 22; y++) for (var x = 0; x < 18; x++) {
          if (y < 9) { var half = 2 + y; if (Math.abs(x - 8.5) <= half) px(x, y, pick(R.thatch, 0.8 - (x - 9) / 18 - y / 20, x, y)); continue; }
          if (x < 1 || x > 16) continue;
          px(x, y, x % 4 === 0 ? R.wood[0] : (x + y) % 5 ? R.wood[2] : R.wood[1]);
          if (x >= 7 && x <= 10 && y >= 14) px(x, y, R.wood[0]);
        }
        px(4, 13, R.wheat[2]); px(13, 15, R.wheat[2]);
      });
      case 'storehouse': return sprite('storehouse', 18, 20, function (px) {
        for (var y = 0; y < 20; y++) for (var x = 0; x < 18; x++) {
          if (y < 7) { if (Math.abs(x - 8.5) <= 3 + y * 1.2) px(x, y, y % 2 ? R.stone[1] : R.stone[2]); continue; }
          if (x < 1 || x > 16) continue;
          var br = ((y >> 2) & 1) ? x + 3 : x;
          px(x, y, (y & 3) === 3 || br % 6 === 5 ? R.stone[1] : R.stone[3]);
          if (x >= 7 && x <= 10 && y >= 13) px(x, y, R.wood[0]);
        }
      });
      case 'well': return sprite('well', 16, 20, function (px) {
        for (var y = 0; y < 20; y++) for (var x = 0; x < 16; x++) {
          if (y < 4 && Math.abs(x - 7.5) <= 2 + y * 1.6) { px(x, y, R.wood[y % 2 ? 1 : 2]); continue; }
          if ((x === 2 || x === 13) && y >= 4 && y < 13) { px(x, y, R.wood[1]); continue; }
          var dx = (x - 7.5) / 7.5, dy = (y - 15) / 4.5;
          if (y >= 11 && dx * dx + dy * dy <= 1) { var inner = (dx * dx) / 0.36 + ((y - 14) * (y - 14)) / 4 <= 1 && y < 16; px(x, y, inner ? R.deep[1] : ((x + y) & 1 ? R.stone[2] : R.stone[3])); }
        }
        for (var x2 = 3; x2 < 13; x2++) px(x2, 7, R.wood[0]);
        px(7, 8, R.stone[3]); px(7, 9, R.wood[2]);
      });
      case 'tent': return sprite('tent', 20, 16, function (px) {
        for (var y = 0; y < 16; y++) for (var x = 0; x < 20; x++) {
          var half = (y + 1) * 0.62;
          if (Math.abs(x - 9.5) > half) continue;
          var door = Math.abs(x - 9.5) < (y - 7) * 0.4 && y > 7;
          px(x, y, door ? [40, 30, 22] : pick(R.canvas, 0.75 - (x - 9.5) / 20, x, y));
        }
        px(9, 0, R.wood[0]); px(10, 0, R.wood[0]);
      });
      case 'ruins': return sprite('ruins', 18, 24, function (px) {
        var col = function (x0, top) { for (var y = top; y < 24; y++) for (var x = x0; x < x0 + 4; x++) px(x, y, x === x0 ? R.stone[3] : x === x0 + 3 ? R.stone[1] : R.stone[2]); };
        col(1, 4); col(11, 11);
        for (var x = 0; x < 6; x++) px(x, 4, R.stone[4]);
        for (var r = 0; r < 6; r++) px(6 + r, 20 + (r % 2), R.stone[r % 2 ? 1 : 2]);
        for (var v = 0; v < 5; v++) px(2 + v % 3, 9 + v * 2, R.leaf[2]);
      });
      case 'stele': return sprite('stele', 12, 18, function (px) {
        for (var y = 0; y < 18; y++) for (var x = 0; x < 12; x++) {
          if (y < 3 && Math.abs(x - 5.5) > 2 + y * 1.5) continue;
          if (x < 1 || x > 10) continue;
          var c = x < 4 ? R.stone[4] : x > 8 ? R.stone[2] : R.stone[3];
          if (y > 4 && y < 14 && x > 2 && x < 9 && y % 2 === 0 && (x + y) % 3) c = R.stone[1];
          px(x, y, c);
        }
      });
    }
    return null;
  }
  function drawFire(g, x, y, t) {
    x = Math.round(x); y = Math.round(y);
    g.fillStyle = css(R.wood[1]); g.fillRect(x - 5, y - 2, 10, 2);
    g.fillStyle = css(R.wood[0]); g.fillRect(x - 4, y - 1, 8, 1);
    var cols = [[255, 210, 80], [255, 150, 50], [230, 80, 40]];
    for (var k = 0; k < 7; k++) {
      var h = 3 + ((k * 37 + Math.floor(t * 12)) % 5), fx = x - 3 + k;
      for (var j = 0; j < h; j++) { g.fillStyle = css(cols[Math.min(2, Math.floor(j / 2 + (k % 2)))]); g.fillRect(fx, y - 3 - j, 1, 1); }
    }
    g.fillStyle = 'rgba(255,190,90,0.12)'; g.fillRect(x - 10, y - 12, 20, 14);
  }
  function drawPickup(g, pk, x, y, t) {
    var b = Math.round(Math.sin(pk.t * 3) * 1.5), X = Math.round(x), Y = Math.round(y) + b;
    var f = function (c, a, bb, w, h) { g.fillStyle = typeof c === 'string' ? c : css(c); g.fillRect(X + a, Y + bb, w || 1, h || 1); };
    shadow(g, x, y + 1, 3);
    switch (pk.kind) {
      case 'coin': f(R.outline, -3, -5, 6, 5); f(R.stone[4], -2, -4, 4, 3); f([255, 255, 255], -1, -4); break;
      case 'potion': f(R.outline, -3, -9, 6, 8); f([230, 90, 170], -2, -6, 4, 4); f([255, 170, 220], -2, -6); f(R.stone[4], -1, -8, 2, 2); break;
      case 'arrows': for (var k = 0; k < 3; k++) { f(R.wood[2], -4, -3 - k * 2, 8, 1); f(R.stone[4], 4, -3 - k * 2); f([220, 220, 220], -5, -3 - k * 2); } break;
      case 'herb': {
        var glow = 0.25 + Math.sin(pk.t * 4) * 0.15;
        f('rgba(180,220,255,' + glow + ')', -6, -12, 12, 12);
        f(R.leaf[2], 0, -6, 1, 5); f([200, 216, 255], -2, -9, 2, 2); f([200, 216, 255], 1, -9, 2, 2); f([230, 240, 255], -1, -10, 2, 2);
        break;
      }
      case 'codex': f('rgba(255,220,120,' + (0.3 + Math.sin(pk.t * 4) * 0.2) + ')', -7, -12, 14, 12); f(R.outline, -4, -9, 9, 7); f([140, 40, 40], -3, -8, 7, 5); f(R.gold[2], -3, -6, 7, 1); break;
      case 'relic': f('rgba(180,240,255,' + (0.3 + Math.sin(pk.t * 4) * 0.2) + ')', -8, -13, 16, 13); f(R.outline, -5, -10, 10, 9); f([184, 154, 106], -4, -9, 4, 7); f([200, 170, 122], 0, -8, 4, 6); break;
      case 'gear': {
        f('rgba(255,200,80,' + (0.3 + Math.sin(pk.t * 4) * 0.15) + ')', -7, -12, 14, 12);
        var it = pk.item || {};
        if (it.slot === 'melee') { f(R.outline, -1, -11, 3, 10); f(R.stone[4], 0, -10, 1, 6); f(R.gold[2], -1, -4, 3, 1); }
        else if (it.slot === 'ranged') { f(it.gun ? [40, 40, 48] : R.wood[2], -5, -6, 10, 2); f(R.outline, -5, -4, 3, 2); }
        else { f(R.outline, -4, -10, 8, 9); f(it.slot === 'clothes' ? [170, 120, 80] : R.stone[3], -3, -9, 6, 7); }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Projectiles and effects
  // ---------------------------------------------------------------------------
  function line(g, x0, y0, x1, y1, col) {
    g.fillStyle = col;
    var n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) | 0;
    for (var k = 0; k <= n; k++) g.fillRect(Math.round(x0 + (x1 - x0) * k / (n || 1)), Math.round(y0 + (y1 - y0) * k / (n || 1)), 1, 1);
  }
  function drawProjectile(g, pr, x, y) {
    var a = Math.atan2(pr.vy, pr.vx), cx = Math.cos(a), cy = Math.sin(a);
    if (pr.bullet) { line(g, x - cx * 9, y - cy * 9 - 6, x, y - 6, 'rgba(255,240,170,0.7)'); g.fillStyle = '#fff6c8'; g.fillRect(Math.round(x) - 1, Math.round(y) - 7, 2, 2); return; }
    if (pr.stone) { g.fillStyle = css(R.stone[2]); g.fillRect(Math.round(x) - 1, Math.round(y) - 7, 2, 2); return; }
    line(g, x - cx * 6, y - cy * 6 - 6, x, y - 6, css(R.wood[2]));
    g.fillStyle = css(R.stone[4]); g.fillRect(Math.round(x), Math.round(y - 6), 1, 1);
    g.fillStyle = pr.mine ? '#e8e8e8' : '#ff8a6a'; g.fillRect(Math.round(x - cx * 6), Math.round(y - cy * 6 - 6), 1, 1);
  }
  function drawEffect(g, e, x, y, px, py) {
    var f = e.t / e.life;
    switch (e.type) {
      case 'slash': case 'eslash': case 'gslash': {
        var cx = e.type === 'slash' ? px : x, cy = (e.type === 'slash' ? py : y) - 8, r = (e.r || 1.25) * 16 * (0.75 + f * 0.25);
        var col = e.type === 'slash' ? [255, 255, 255] : e.type === 'eslash' ? [255, 100, 70] : [140, 240, 255];
        g.fillStyle = css(col, 0.95 - f);
        var a0 = e.ang - 1.1 + f * 0.6, a1 = e.ang + 1.1 * (f * 1.2 - 0.1);
        for (var k = 0; k <= 14; k++) { var an = a0 + (a1 - a0) * k / 14; g.fillRect(Math.round(cx + Math.cos(an) * r), Math.round(cy + Math.sin(an) * r), 1, 1); if (f < 0.5) g.fillRect(Math.round(cx + Math.cos(an) * (r - 1)), Math.round(cy + Math.sin(an) * (r - 1)), 1, 1); }
        break;
      }
      case 'puff': {
        g.fillStyle = e.color; g.globalAlpha = 1 - f;
        for (var p = 0; p < 6; p++) { var aa = p * 1.05; g.fillRect(Math.round(x + Math.cos(aa) * f * 8), Math.round(y - 5 + Math.sin(aa) * f * 6), 2 - (f > 0.5 ? 1 : 0), 2 - (f > 0.5 ? 1 : 0)); }
        g.globalAlpha = 1;
        break;
      }
      case 'ring': {
        g.globalAlpha = 1 - f; g.fillStyle = e.color;
        var rr = 5 + f * 20;
        for (var q = 0; q < 32; q++) { var b = q / 32 * 6.283; g.fillRect(Math.round(x + Math.cos(b) * rr), Math.round(y - 5 + Math.sin(b) * rr * 0.8), 1, 1); }
        g.globalAlpha = 1;
        break;
      }
      case 'fireburst': {
        g.globalAlpha = 1 - f;
        for (var j = 0; j < 8; j++) { g.fillStyle = ['#ff9a3c', '#ffd23c', '#ff5a2c'][j % 3]; g.fillRect(Math.round(x + Math.sin(j * 2.1 + e.t * 6) * 5), Math.round(y - 6 - f * 15 - j * 1.5), 2, 2); }
        g.globalAlpha = 1;
        break;
      }
      case 'muzzle': g.fillStyle = 'rgba(255,230,140,' + (1 - f) + ')'; g.fillRect(Math.round(x) - 2, Math.round(y) - 8, 4, 4); g.fillStyle = 'rgba(255,255,255,' + (1 - f) + ')'; g.fillRect(Math.round(x) - 1, Math.round(y) - 7, 2, 2); break;
    }
  }

  // ---------------------------------------------------------------------------
  // Life: water sparkles, chimney smoke, birds, butterflies, leaves, snow
  // ---------------------------------------------------------------------------
  function ambient(g, o) {
    var s = o.s, t = o.time, box = o.box, boy = o.boy, bw = o.bw, bh = o.bh;
    var tx0 = Math.floor(-box / PT) - 1, tx1 = tx0 + Math.ceil(bw / PT) + 2, ty0 = Math.floor(-boy / PT) - 1, ty1 = ty0 + Math.ceil(bh / PT) + 2;
    // water sparkles
    for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) {
      var tt = L.tileAt(s, tx, ty);
      if (tt !== T.SHALLOW && tt !== T.DEEP && tt !== T.STREAM) continue;
      var h = Sim.hash4(s.seed, tx, ty, 990);
      if (Math.sin(t * 1.7 + (h % 628) / 100) < 0.9) continue;
      var sx = box + tx * PT + (h % 13) + 1, sy = boy + ty * PT + ((h >> 5) % 13) + 1;
      g.fillStyle = SEASON === 2 ? 'rgba(240,248,255,0.9)' : 'rgba(214,240,251,0.9)';
      g.fillRect(sx, sy, 2, 1); g.fillRect(sx + 1, sy - 1, 1, 1);
    }
    // chimney smoke from inhabited houses
    var px0 = Math.floor(tx0 / P), px1 = Math.floor(tx1 / P), py0 = Math.floor(ty0 / P), py1 = Math.floor((ty1 + 2) / P);
    for (var py = py0; py <= py1; py++) for (var px = px0; px <= px1; px++) {
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      var pi = py * W + px;
      if (s.pop[pi] <= 0) continue;
      var dyn = L.getDyn(s, pi, o.ver);
      if (!dyn.houses.length) continue;
      for (var k = 0; k < dyn.houses.length; k++) {
        var hh = dyn.houses[k], gx = px * P + hh.lx, gy = py * P + hh.ly, hv = Sim.hash4(s.seed, gx, gy, 980);
        if (!(hv & 1)) continue;
        var cx = box + gx * PT + (dyn.age <= 1 ? 8 : 11.5) + ((hv % 7) - 3 >> 1), cy = boy + gy * PT - 8 + (dyn.age <= 1 ? 6 : 0);
        for (var pf = 0; pf < 3; pf++) {
          var ph = ((t * (SEASON === 2 ? 0.45 : 0.32) + (hv % 100) / 100 + pf / 3) % 1);
          var rr = 1 + Math.floor(ph * 2.5);
          g.fillStyle = 'rgba(200,200,210,' + (0.55 * (1 - ph)) + ')';
          g.fillRect(Math.round(cx + Math.sin(ph * 5 + hv) * 2 + ph * 4), Math.round(cy - ph * 16), rr, rr);
        }
      }
    }
    // weather
    if (SEASON === 2) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      for (var f = 0; f < 90; f++) {
        var fx = ((f * 97 + t * (8 + f % 5) + Math.sin(t + f) * 6) % (bw + 20) + bw + 20) % (bw + 20) - 10;
        var fy = ((f * 61 + t * (14 + f % 7)) % (bh + 20)) - 10;
        g.fillRect(Math.round(fx), Math.round(fy), f % 9 === 0 ? 2 : 1, f % 9 === 0 ? 2 : 1);
      }
    } else if (SEASON === 1) {
      var lc = ['#d8862a', '#b85a1c', '#eab04a', '#8a3a14'];
      for (var l = 0; l < 26; l++) {
        g.fillStyle = lc[l % 4];
        var lx = ((l * 131 + t * (10 + l % 6)) % (bw + 30)) - 15, ly = ((l * 79 + t * (7 + l % 4)) % (bh + 30)) - 15;
        lx += Math.sin(t * 2 + l) * 4;
        g.fillRect(Math.round(lx), Math.round(ly), 2, 1);
        if (Math.sin(t * 6 + l) > 0) g.fillRect(Math.round(lx) + 1, Math.round(ly) + 1, 1, 1);
      }
    } else if (o.month >= 3 && o.month <= 7) {
      // butterflies over land
      var bc = [[240, 220, 90], [240, 150, 190], [250, 250, 250], [160, 200, 250]];
      for (var bf = 0; bf < 7; bf++) {
        var bx = ((bf * 173 + Math.sin(t * 0.6 + bf) * 30 + t * 6) % bw + bw) % bw, by = ((bf * 97 + Math.cos(t * 0.5 + bf * 2) * 22) % bh + bh) % bh;
        var wtx = Math.floor((bx - box) / PT), wty = Math.floor((by - boy) / PT), bt = L.tileAt(s, wtx, wty);
        if (bt !== T.GRASS && bt !== T.DGRASS) continue;
        g.fillStyle = css(bc[bf % 4]);
        var flap = Math.sin(t * 18 + bf) > 0;
        g.fillRect(Math.round(bx) - (flap ? 1 : 0), Math.round(by), flap ? 3 : 1, 1);
        g.fillRect(Math.round(bx), Math.round(by) + 1, 1, 1);
      }
    }
    // a flock of birds, now and then, with their shadows on the ground
    var period = 16, ft = t % period;
    if (ft < 7 && SEASON !== 2) {
      var seedB = Math.floor(t / period), byy = 20 + (Sim.hash4(seedB, 1, 2, 3) % Math.max(1, bh - 60)), dir = seedB % 2 ? 1 : -1;
      for (var bd = 0; bd < 5; bd++) {
        var off = [[0, 0], [-6, -3], [-6, 3], [-12, -6], [-12, 6]][bd];
        var bxx = dir > 0 ? -20 + ft / 7 * (bw + 40) + off[0] : bw + 20 - ft / 7 * (bw + 40) - off[0], byb = byy + off[1] + Math.sin(t * 3 + bd) * 1.5;
        g.fillStyle = 'rgba(10,10,20,0.18)'; g.fillRect(Math.round(bxx + 18), Math.round(byb + 30), 3, 1);
        g.fillStyle = '#2a2a34';
        var up = Math.sin(t * 12 + bd) > 0;
        g.fillRect(Math.round(bxx) - 2, Math.round(byb) - (up ? 1 : 0), 1, 1); g.fillRect(Math.round(bxx) - 1, Math.round(byb), 1, 1);
        g.fillRect(Math.round(bxx), Math.round(byb) + 1, 1, 1);
        g.fillRect(Math.round(bxx) + 1, Math.round(byb), 1, 1); g.fillRect(Math.round(bxx) + 2, Math.round(byb) - (up ? 1 : 0), 1, 1);
      }
    }
  }

  root.Pixel = {
    PT: PT, PAD: PAD, PW: PW, R: R, renderProvince: renderProvince, clearCaches: clearCaches, beginFrame: beginFrame, setSeason: setSeason,
    drawCharacter: drawCharacter, drawWeapon: drawWeapon, drawBeast: drawBeast, drawHorse: drawHorse, objectSprite: objectSprite, drawFire: drawFire,
    drawPickup: drawPickup, drawProjectile: drawProjectile, drawEffect: drawEffect, ambient: ambient, shadow: shadow,
    civRamp: civRamp, skinFor: skinFor, hairFor: hairFor, shadeOf: shadeOf, css: css, outline: outline, sprite: sprite, dirRow: dirRow, highways: highways
  };
}(this));
