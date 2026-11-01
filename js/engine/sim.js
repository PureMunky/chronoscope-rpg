/*
 * Chronoscope simulation core.
 *
 * A completely deterministic world simulation. Given the same seed and the
 * same list of interventions, every run produces bit-identical history.
 *
 * Determinism rules this file follows:
 *   1. No Math.random, no Date, no timers. All "chance" comes from a stateless
 *      hash of (seed, tick, tile, channel). Because randomness is keyed by
 *      *where and when* rather than drawn from a shared stream, a change in one
 *      corner of the world does not re-roll the dice everywhere else: changes
 *      only spread through actual cause and effect (migration, war, plague,
 *      trade of ideas).
 *   2. Integer arithmetic only (plus Math.floor/min/max/imul/clz32), so results
 *      are identical across browsers and Node.
 *   3. All state lives in flat typed arrays, so snapshots are cheap copies and
 *      time travel is "restore nearest keyframe, then re-simulate forward".
 *   4. Iteration order is fixed (a hash-chosen permutation per tick), never
 *      dependent on object identity or insertion order.
 *
 * Emergent mechanics (each one is a few lines in step()):
 *   - Land: soil fertility regenerates and is depleted by farming.
 *   - People: populations grow logistically toward what the soil can feed,
 *     starve when climate turns, and spill over into neighbouring land.
 *   - Solidarity (asabiya, after Ibn Khaldun / Peter Turchin): grows on
 *     contested frontiers and decays in comfortable interiors. Strong
 *     solidarity lets a people project power; when it decays, empires shatter.
 *   - War: along every border, power = solidarity x population x technology,
 *     weakened by distance from the capital. Stronger power takes land.
 *   - Ideas: technology grows with population, diffuses across borders,
 *     raises farm yields and military reach, and is partly lost in collapses.
 *   - Plague: dense cities spawn outbreaks that spread tile to tile.
 *   - Climate: slow regional droughts and golden ages.
 *   - Secession and collapse: far-flung provinces of low-solidarity empires
 *     break away; empires whose solidarity runs out fragment into successors.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // World dimensions & configuration
  // ---------------------------------------------------------------------------
  var W = 160, H = 100, N = W * H;
  var MAX_CIVS = 1024;

  var TER = { DEEP: 0, SEA: 1, PLAINS: 2, FOREST: 3, HILLS: 4, MOUNTAIN: 5, DESERT: 6 };
  var TERRAIN_NAMES = ['Deep ocean', 'Shallow sea', 'Plains', 'Forest', 'Hills', 'Mountains', 'Desert'];
  var TERRAIN_FERTILITY = [0, 0, 7800, 5200, 3600, 700, 1000];
  var TERRAIN_DEFENSE = [100, 100, 100, 125, 150, 260, 100];

  var CFG = {
    soilMax: 10000,
    capDivisor: 78000,      // capacity = soil * techMult * climate / capDivisor
    growthPct: 3,           // logistic growth rate per year
    abandonBelow: 3,        // tiles with fewer people are abandoned
    soilRegenDiv: 90,       // soil recovers 1/90th of its deficit per year
    soilDepleteBase: 12,    // depletion per year at full load, before tech
    asabMax: 10000,
    asabGrowDiv: 500000,    // frontier growth: a * (max - a) / div
    asabDecayPerMille: 7,   // interior decay per year
    collapseAsab: 1300,     // mean solidarity below this shatters an empire
    collapseMinTiles: 8,
    notableTiles: 60,       // states this large get into the chronicle
    rebirthAsab: 3500,      // successor states start with at least this
    secessionMinTiles: 20,
    warChance: 1600,        // per 10000, per border tile per year, when stronger
    warAdvantagePct: 125,   // attacker must exceed defender power by this %
    conquestLossPct: 25,
    tribeChance: 180,       // per 10000 per candidate per year
    tribeStartPop: 40,
    tribeStartAsab: 3000,
    plagueOutbreakPop: 1600,
    plagueDuration: 5,
    plagueMortalityPct: 9,
    plagueSpreadChance: 3200,
    plagueImmunity: 90,
    seafaringTech: 1400,
    techDecayDiv: 900,
    crisisYears: 15,        // solidarity must stay below collapse level this long
    graceYears: 40          // new states cannot collapse this young
  };

  var AGES = [
    { name: 'Stone Age', tech: 0 },
    { name: 'Bronze Age', tech: 600 },
    { name: 'Iron Age', tech: 1400 },
    { name: 'Classical Age', tech: 2500 },
    { name: 'Medieval Age', tech: 3800 },
    { name: 'Renaissance', tech: 5400 },
    { name: 'Industrial Age', tech: 7400 }
  ];

  // Hash channels: every independent "dice roll" has its own channel.
  var CH = {
    ELEV: 11, MOIST: 12, RIVER: 13, CLIMATE: 14, FIRST_TRIBES: 15,
    MIG: 21, SEA: 22, WAR: 23, WAR_DIR: 24, TRIBE: 25, TRIBE_POS: 26,
    PLAGUE: 27, PLAGUE_SPREAD: 28, FAR: 29, SECEDE: 30, SHATTER: 31,
    ORDER: 32, SIG: 33
  };

  // ---------------------------------------------------------------------------
  // Hashing (the only source of "randomness")
  // ---------------------------------------------------------------------------
  function mix(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }
  function hash4(a, b, c, d) {
    var h = mix((a | 0) ^ 0x9e3779b9);
    h = mix((h + (b | 0)) ^ 0x85ebca6b);
    h = mix((h + (c | 0)) ^ 0xc2b2ae35);
    h = mix((h + (d | 0)) ^ 0x27d4eb2f);
    return h;
  }
  function roll(s, channel, i) { // 0..9999
    return hash4(s.seed, s.g[G_TICK], i, channel) % 10000;
  }

  // ---------------------------------------------------------------------------
  // Static lookup tables
  // ---------------------------------------------------------------------------
  var TX = new Uint8Array(N), TY = new Uint8Array(N);
  var NB = new Int32Array(N * 4); // 4-neighbourhood, -1 off-map
  (function () {
    for (var i = 0; i < N; i++) {
      var x = i % W, y = (i / W) | 0;
      TX[i] = x; TY[i] = y;
      NB[i * 4] = y > 0 ? i - W : -1;
      NB[i * 4 + 1] = x < W - 1 ? i + 1 : -1;
      NB[i * 4 + 2] = y < H - 1 ? i + W : -1;
      NB[i * 4 + 3] = x > 0 ? i - 1 : -1;
    }
  }());
  function dist(a, b) {
    var dx = TX[a] - TX[b], dy = TY[a] - TY[b];
    return (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
  }
  function ilog2(x) { return x > 0 ? 31 - Math.clz32(x) : 0; }
  function isLand(t) { return t >= TER.PLAINS; }

  // Global scalar slots
  var G_TICK = 0, G_NEXTCIV = 1, G_WORLDAGE = 2, G_LASTPLAGUE = 3;

  // ---------------------------------------------------------------------------
  // State allocation, snapshots
  // ---------------------------------------------------------------------------
  function allocate(seed) {
    return {
      seed: seed >>> 0,
      g: new Int32Array(8),
      // static-ish (changed only by interventions, copy-on-write)
      terrain: new Uint8Array(N), river: new Uint8Array(N),
      base: new Uint16Array(N), elev: new Uint16Array(N),
      ownStatic: true,
      // dynamic tile state
      soil: new Uint16Array(N), pop: new Int32Array(N), owner: new Int16Array(N).fill(-1),
      asab: new Uint16Array(N), plague: new Uint8Array(N), immune: new Uint8Array(N),
      starve: new Uint8Array(N),
      // civ persistent
      cAlive: new Uint8Array(MAX_CIVS), cSig: new Uint32Array(MAX_CIVS),
      cParent: new Uint32Array(MAX_CIVS), cFounded: new Int32Array(MAX_CIVS),
      cTech: new Int32Array(MAX_CIVS), cCap: new Int32Array(MAX_CIVS),
      cPeakTiles: new Int32Array(MAX_CIVS), cPeakPop: new Int32Array(MAX_CIVS),
      cLostTo: new Uint32Array(MAX_CIVS), cCapLostTo: new Uint32Array(MAX_CIVS),
      cFlags: new Uint8Array(MAX_CIVS), cAge: new Uint8Array(MAX_CIVS), cLastSack: new Int32Array(MAX_CIVS),
      cCrisis: new Uint8Array(MAX_CIVS),
      // scratch (recomputed each tick, never snapshotted)
      stamp: new Uint32Array(N), clim: new Uint8Array(N), climTick: -1,
      sPop: new Int32Array(MAX_CIVS), sTiles: new Int32Array(MAX_CIVS),
      sAsab: new Float64Array(MAX_CIVS), sMaxPop: new Int32Array(MAX_CIVS),
      sMaxTile: new Int32Array(MAX_CIVS), sFar: new Int32Array(MAX_CIVS),
      sFarPick: new Int32Array(MAX_CIVS), sFarH: new Uint32Array(MAX_CIVS),
      sFamine: new Int32Array(MAX_CIVS), sPlague: new Int32Array(MAX_CIVS),
      sContact: new Int32Array(MAX_CIVS), sShock: new Uint8Array(MAX_CIVS),
      sPower: new Float64Array(MAX_CIVS), sReach: new Int32Array(MAX_CIVS),
      conq: []                // this year's conquests as [attackerSig, defenderSig] pairs (scratch, for history)
    };
  }

  var DYNAMIC = ['g', 'soil', 'pop', 'owner', 'asab', 'plague', 'immune', 'starve',
    'cAlive', 'cSig', 'cParent', 'cFounded', 'cTech', 'cCap', 'cPeakTiles', 'cPeakPop',
    'cLostTo', 'cCapLostTo', 'cFlags', 'cAge', 'cLastSack', 'cCrisis'];
  var STATIC = ['terrain', 'river', 'base', 'elev'];

  /** Immutable snapshot. Static arrays are shared by reference (copy-on-write). */
  function snapshot(s) {
    var snap = { seed: s.seed };
    for (var k = 0; k < DYNAMIC.length; k++) snap[DYNAMIC[k]] = s[DYNAMIC[k]].slice();
    for (k = 0; k < STATIC.length; k++) snap[STATIC[k]] = s[STATIC[k]];
    s.ownStatic = false; // the snapshot now shares our static arrays
    return snap;
  }

  /** Fresh, mutable state from a snapshot. Scratch arrays start zeroed. */
  function restore(snap) {
    var s = allocate(snap.seed);
    for (var k = 0; k < DYNAMIC.length; k++) s[DYNAMIC[k]].set(snap[DYNAMIC[k]]);
    for (k = 0; k < STATIC.length; k++) s[STATIC[k]] = snap[STATIC[k]];
    s.ownStatic = false;
    return s;
  }

  function ensureOwnStatic(s) {
    if (s.ownStatic) return;
    for (var k = 0; k < STATIC.length; k++) s[STATIC[k]] = s[STATIC[k]].slice();
    s.ownStatic = true;
  }

  /** Stable fingerprint of the full dynamic state (used by tests). */
  function stateHash(s) {
    var h = 0x12345;
    for (var k = 0; k < DYNAMIC.length; k++) {
      var a = s[DYNAMIC[k]];
      for (var i = 0; i < a.length; i++) h = mix((h + a[i]) ^ k);
    }
    for (k = 0; k < STATIC.length; k++) {
      var b = s[STATIC[k]];
      for (i = 0; i < b.length; i++) h = mix((h + b[i]) ^ (k + 100));
    }
    return h >>> 0;
  }

  // ---------------------------------------------------------------------------
  // World generation
  // ---------------------------------------------------------------------------
  function smooth(f) { return (f * f * (768 - 2 * f)) >> 16; }
  function valueNoise(seed, ch, x, y, cell) {
    var ix = (x / cell) | 0, iy = (y / cell) | 0;
    var sx = smooth(((x - ix * cell) * 256 / cell) | 0);
    var sy = smooth(((y - iy * cell) * 256 / cell) | 0);
    var v00 = hash4(seed, ch * 7 + cell, ix, iy) & 1023;
    var v10 = hash4(seed, ch * 7 + cell, ix + 1, iy) & 1023;
    var v01 = hash4(seed, ch * 7 + cell, ix, iy + 1) & 1023;
    var v11 = hash4(seed, ch * 7 + cell, ix + 1, iy + 1) & 1023;
    var a = v00 + (((v10 - v00) * sx) >> 8);
    var b = v01 + (((v11 - v01) * sx) >> 8);
    return a + (((b - a) * sy) >> 8);
  }
  function percentile(values, mask, pct) {
    var hist = new Int32Array(1024), total = 0, i;
    for (i = 0; i < values.length; i++) if (!mask || mask[i]) { hist[values[i]]++; total++; }
    var target = (total * pct / 100) | 0, acc = 0;
    for (i = 0; i < 1024; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 1023;
  }

  function generateWorld(s) {
    var seed = s.seed, i, x, y;
    var e = new Uint16Array(N), m = new Uint16Array(N);
    for (i = 0; i < N; i++) {
      x = TX[i]; y = TY[i];
      var v = (valueNoise(seed, CH.ELEV, x, y, 48) * 8 + valueNoise(seed, CH.ELEV, x, y, 24) * 4 +
        valueNoise(seed, CH.ELEV, x, y, 12) * 2 + valueNoise(seed, CH.ELEV, x, y, 6)) / 15 | 0;
      var edge = Math.min(Math.min(x, W - 1 - x), Math.min(y, H - 1 - y));
      if (edge < 14) v -= (14 - edge) * 28;
      e[i] = Math.max(0, Math.min(1023, v));
      m[i] = (valueNoise(seed, CH.MOIST, x, y, 40) * 4 + valueNoise(seed, CH.MOIST, x, y, 20) * 2 +
        valueNoise(seed, CH.MOIST, x, y, 10)) / 7 | 0;
    }
    var deepLevel = percentile(e, null, 26), seaLevel = percentile(e, null, 44);
    var landMask = new Uint8Array(N);
    for (i = 0; i < N; i++) landMask[i] = e[i] > seaLevel ? 1 : 0;
    var hillLevel = percentile(e, landMask, 78), mountLevel = percentile(e, landMask, 93);
    var dryLevel = percentile(m, landMask, 16), wetLevel = percentile(m, landMask, 68);

    for (i = 0; i < N; i++) {
      var t;
      if (e[i] <= deepLevel) t = TER.DEEP;
      else if (e[i] <= seaLevel) t = TER.SEA;
      else if (e[i] > mountLevel) t = TER.MOUNTAIN;
      else if (e[i] > hillLevel) t = TER.HILLS;
      else if (m[i] < dryLevel) t = TER.DESERT;
      else if (m[i] > wetLevel) t = TER.FOREST;
      else t = TER.PLAINS;
      s.terrain[i] = t;
      s.elev[i] = e[i];
    }

    // Rivers: walk downhill from highland springs to the sea.
    for (var r = 0; r < 60; r++) {
      var src = hash4(seed, CH.RIVER, r, 0) % N;
      if (e[src] < hillLevel || !isLand(s.terrain[src])) continue;
      var cur = src;
      for (var stepN = 0; stepN < 250; stepN++) {
        s.river[cur] = 1;
        var best = -1, bestE = e[cur];
        for (var d = 0; d < 4; d++) {
          var n = NB[cur * 4 + d];
          if (n >= 0 && e[n] < bestE) { bestE = e[n]; best = n; }
        }
        if (best < 0 || !isLand(s.terrain[best])) break;
        cur = best;
      }
    }

    for (i = 0; i < N; i++) recomputeBase(s, i);
    for (i = 0; i < N; i++) s.soil[i] = s.base[i];
  }

  function isCoastal(s, i) {
    for (var d = 0; d < 4; d++) {
      var n = NB[i * 4 + d];
      if (n >= 0 && !isLand(s.terrain[n])) return true;
    }
    return false;
  }

  function recomputeBase(s, i) {
    var t = s.terrain[i];
    if (!isLand(t)) { s.base[i] = 0; return; }
    var f = TERRAIN_FERTILITY[t];
    if (s.river[i]) f = Math.max(f + 2400, t === TER.DESERT ? 6500 : 0);
    if (isCoastal(s, i)) f += 1100;
    s.base[i] = Math.min(CFG.soilMax, f);
  }

  // ---------------------------------------------------------------------------
  // Civilizations
  // ---------------------------------------------------------------------------
  var SYL = ['ka', 'ru', 'men', 'tha', 'lo', 'vor', 'shi', 'an', 'el', 'dor', 'zu', 'ri', 'os', 'ta',
    'in', 'gar', 'mi', 'sa', 'ke', 'bel', 'ur', 'na', 'qe', 'ho', 'ith', 'ba', 'syl', 'tor', 'ae', 'kan', 'ul', 'jen'];
  var SUF = ['ia', 'an', 'or', 'eth', 'um', 'ai', 'os', 'ar', 'ene', 'is', 'avi', 'ur', 'oth', 'a', 'en', 'ir'];

  function civName(sig) {
    var n = 2 + (sig % 3 === 0 ? 1 : 0), name = '', h = sig;
    for (var k = 0; k < n; k++) { name += SYL[h & 31]; h = mix(h + k + 1); }
    name += SUF[(sig >>> 20) & 15];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function ageOf(tech) {
    var a = 0;
    for (var k = 1; k < AGES.length; k++) if (tech >= AGES[k].tech) a = k;
    return a;
  }

  /** Allocates a civ slot. Traits key off (tick, tile) so ids never matter. */
  function newCiv(s, tile, parent, tech) {
    var id = -1;
    if (s.g[G_NEXTCIV] < MAX_CIVS) id = s.g[G_NEXTCIV]++;
    else for (var k = 0; k < MAX_CIVS; k++) if (!s.cAlive[k] && s.sTiles[k] === 0) { id = k; break; }
    if (id < 0) return -1;
    s.cAlive[id] = 1;
    s.cSig[id] = hash4(s.seed, s.g[G_TICK], tile, CH.SIG) || 1;
    s.cParent[id] = parent >= 0 ? s.cSig[parent] : 0;
    s.cFounded[id] = s.g[G_TICK];
    s.cTech[id] = tech;
    s.cAge[id] = ageOf(tech);
    s.cCap[id] = tile;
    s.cPeakTiles[id] = 0; s.cPeakPop[id] = 0;
    s.cLostTo[id] = 0; s.cCapLostTo[id] = 0; s.cFlags[id] = 0; s.cLastSack[id] = -1000; s.cCrisis[id] = 0;
    s.sPop[id] = 0; s.sTiles[id] = 0; s.sAsab[id] = 0; s.sMaxPop[id] = 0; s.sMaxTile[id] = tile;
    s.sShock[id] = 0; s.sContact[id] = 0;
    return id;
  }

  function transferTile(s, i, to) {
    var from = s.owner[i];
    if (from >= 0) { s.sPop[from] -= s.pop[i]; s.sTiles[from]--; s.sAsab[from] -= s.asab[i]; }
    s.owner[i] = to;
    if (to >= 0) {
      s.sPop[to] += s.pop[i]; s.sTiles[to]++; s.sAsab[to] += s.asab[i];
      if (s.pop[i] >= s.sMaxPop[to]) { s.sMaxPop[to] = s.pop[i]; s.sMaxTile[to] = i; }
    }
  }

  function spawnTribe(s, i, pop, asab) {
    var id = newCiv(s, i, -1, 0);
    if (id < 0) return -1;
    s.pop[i] = pop; s.asab[i] = asab; s.plague[i] = 0;
    transferTile(s, i, id);
    s.cCap[id] = i;
    return id;
  }

  function noOwnerWithin(s, i, r) {
    var x0 = TX[i], y0 = TY[i];
    for (var y = Math.max(0, y0 - r); y <= Math.min(H - 1, y0 + r); y++)
      for (var x = Math.max(0, x0 - r); x <= Math.min(W - 1, x0 + r); x++)
        if (s.owner[y * W + x] >= 0) return false;
    return true;
  }

  function seedFirstTribes(s) {
    var placed = 0;
    for (var k = 0; k < 600 && placed < 7; k++) {
      var i = hash4(s.seed, CH.FIRST_TRIBES, k, 0) % N;
      if (isLand(s.terrain[i]) && s.base[i] >= 6500 && noOwnerWithin(s, i, 10)) {
        spawnTribe(s, i, 60, CFG.tribeStartAsab);
        placed++;
      }
    }
  }

  function create(seed) {
    var s = allocate(seed);
    generateWorld(s);
    seedFirstTribes(s);
    computeStats(s);
    return s;
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------
  function techMult(tech) { return 100 + Math.floor(Math.min(tech, 12000) / 40); }

  function capacity(s, i, tech) {
    return Math.floor(s.soil[i] * techMult(tech) * s.clim[i] / CFG.capDivisor);
  }

  /** Regional climate, 75..115 (100 = normal). Slow, smooth, deterministic. */
  var CLIM_CELL = 40, CLIM_PERIOD = 90;
  function computeClimate(s) {
    // Climate is defined per 5-year band, so the cached field depends only on the band.
    var t = s.g[G_TICK] - s.g[G_TICK] % 5, seed = s.seed;
    if (s.climTick === t) return;
    s.climTick = t;
    var p0 = Math.floor(t / CLIM_PERIOD), ft = Math.floor((t - p0 * CLIM_PERIOD) * 256 / CLIM_PERIOD);
    var cw = Math.floor(W / CLIM_CELL) + 2, chh = Math.floor(H / CLIM_CELL) + 2;
    var lat = new Int32Array(cw * chh);
    for (var cy = 0; cy < chh; cy++) for (var cx = 0; cx < cw; cx++) {
      var a = 75 + hash4(seed, CH.CLIMATE, cy * 64 + cx, p0) % 41;
      var b = 75 + hash4(seed, CH.CLIMATE, cy * 64 + cx, p0 + 1) % 41;
      // bias toward normal: average with 103
      a = (a + 103) >> 1 | 0; b = (b + 103) >> 1 | 0;
      lat[cy * cw + cx] = a + (((b - a) * smooth(ft)) >> 8);
    }
    for (var i = 0; i < N; i++) {
      var x = TX[i], y = TY[i];
      var ix = (x / CLIM_CELL) | 0, iy = (y / CLIM_CELL) | 0;
      var sx = smooth(((x - ix * CLIM_CELL) * 256 / CLIM_CELL) | 0);
      var sy = smooth(((y - iy * CLIM_CELL) * 256 / CLIM_CELL) | 0);
      var v00 = lat[iy * cw + ix], v10 = lat[iy * cw + ix + 1];
      var v01 = lat[(iy + 1) * cw + ix], v11 = lat[(iy + 1) * cw + ix + 1];
      var top = v00 + (((v10 - v00) * sx) >> 8), bot = v01 + (((v11 - v01) * sx) >> 8);
      s.clim[i] = top + (((bot - top) * sy) >> 8);
    }
  }

  function reach(tech) { return 7 + Math.floor(Math.min(tech, 10000) / 300); }

  function computeStats(s) {
    var nc = s.g[G_NEXTCIV], t = s.g[G_TICK], c, i;
    for (c = 0; c < nc; c++) {
      s.sPop[c] = 0; s.sTiles[c] = 0; s.sAsab[c] = 0; s.sMaxPop[c] = -1; s.sMaxTile[c] = -1;
      s.sFar[c] = 0; s.sFarPick[c] = -1; s.sFarH[c] = 0; s.sFamine[c] = 0; s.sPlague[c] = 0;
      s.sContact[c] = 0; s.sReach[c] = reach(s.cTech[c]);
    }
    for (i = 0; i < N; i++) {
      c = s.owner[i];
      if (c < 0) continue;
      var p = s.pop[i];
      s.sPop[c] += p; s.sTiles[c]++; s.sAsab[c] += s.asab[i];
      if (p > s.sMaxPop[c]) { s.sMaxPop[c] = p; s.sMaxTile[c] = i; }
      if (s.starve[i]) s.sFamine[c]++;
      if (s.plague[i]) s.sPlague[c]++;
      if (dist(i, s.cCap[c]) > 2 * s.sReach[c]) {
        s.sFar[c]++;
        var hh = hash4(s.seed, t, i, CH.FAR);
        if (hh >= s.sFarH[c]) { s.sFarH[c] = hh; s.sFarPick[c] = i; }
      }
    }
  }

  function meanAsab(s, c) { return s.sTiles[c] > 0 ? Math.floor(s.sAsab[c] / s.sTiles[c]) : 0; }

  // ---------------------------------------------------------------------------
  // Events (the chronicle)
  // ---------------------------------------------------------------------------
  function emit(sink, s, type, a, b, tile, text) {
    if (!sink) return;
    sink({ t: s.g[G_TICK], type: type, a: a, b: b, x: tile >= 0 ? TX[tile] : -1, y: tile >= 0 ? TY[tile] : -1, text: text });
  }
  function notable(s, c) { return (s.cFlags[c] & 1) !== 0; }

  // ---------------------------------------------------------------------------
  // Collapse & secession
  // ---------------------------------------------------------------------------
  function bfsAssign(s, seeds, ids, from, maxDist, maxTiles) {
    // multi-source BFS over tiles owned by `from`
    var q = [], qi = 0, origin = [], count = [];
    for (var k = 0; k < seeds.length; k++) {
      if (ids[k] < 0) continue;
      s.stamp[seeds[k]] = 0xFFFFFFFF; // mark visited
      q.push(seeds[k]); origin.push(k); count[k] = 1;
      transferTile(s, seeds[k], ids[k]);
    }
    while (qi < q.length) {
      var i = q[qi], o = origin[qi]; qi++;
      for (var d = 0; d < 4; d++) {
        var n = NB[i * 4 + d];
        if (n < 0 || s.owner[n] !== from || s.stamp[n] === 0xFFFFFFFF) continue;
        if (maxDist && dist(n, seeds[o]) > maxDist) continue;
        if (maxTiles && count[o] >= maxTiles) continue;
        s.stamp[n] = 0xFFFFFFFF;
        transferTile(s, n, ids[o]);
        count[o]++;
        q.push(n); origin.push(o);
      }
    }
    for (k = 0; k < q.length; k++) s.stamp[q[k]] = 0;
    return count;
  }

  function boostAsab(s, c, min) {
    // called right after creation, only tiles of c matter
    for (var i = 0; i < N; i++) if (s.owner[i] === c && s.asab[i] < min) {
      s.sAsab[c] += min - s.asab[i];
      s.asab[i] = min;
    }
  }

  function shatter(s, c, sink) {
    var t = s.g[G_TICK], tiles = s.sTiles[c];
    var k = Math.max(2, Math.min(7, Math.floor(tiles / 35)));
    var seeds = [], seedH = [];
    for (var i = 0; i < N; i++) {
      if (s.owner[i] !== c || s.pop[i] <= 0) continue;
      var h = hash4(s.seed, t, i, CH.SHATTER);
      if (seeds.length < k) { seeds.push(i); seedH.push(h); continue; }
      var lo = 0;
      for (var j = 1; j < seedH.length; j++) if (seedH[j] < seedH[lo]) lo = j;
      if (h > seedH[lo]) { seeds[lo] = i; seedH[lo] = h; }
    }
    var heir = Math.floor(s.cTech[c] * 85 / 100);
    var ids = [];
    for (j = 0; j < seeds.length; j++) ids.push(newCiv(s, seeds[j], c, heir));
    bfsAssign(s, seeds, ids, c, 0, 0);
    // enclaves not reached become their own small states (or are abandoned)
    for (i = 0; i < N; i++) {
      if (s.owner[i] !== c) continue;
      var id = newCiv(s, i, c, heir);
      if (id < 0) { transferTile(s, i, -1); s.pop[i] = 0; continue; }
      bfsAssign(s, [i], [id], c, 0, 0);
      ids.push(id);
    }
    var names = [];
    for (j = 0; j < ids.length; j++) if (ids[j] >= 0) {
      boostAsab(s, ids[j], CFG.rebirthAsab);
      s.cCap[ids[j]] = s.sMaxTile[ids[j]];
      if (s.sTiles[ids[j]] >= CFG.notableTiles) s.cFlags[ids[j]] |= 1;
      if (s.sTiles[ids[j]] >= 15) names.push(civName(s.cSig[ids[j]]));
    }
    s.cAlive[c] = 0;
    if (notable(s, c)) {
      var years = t - s.cFounded[c];
      emit(sink, s, 'collapse', s.cSig[c], 0, s.cCap[c],
        'The ' + civName(s.cSig[c]) + ' realm collapses after ' + years + ' years' +
        (names.length ? '; from its ruins rise ' + listNames(names) : '') + '.');
    }
  }

  var RISE = [
    function (n, p) { return 'The ' + n + ' rise to power' + (p ? ', heirs of ' + p : '') + '.'; },
    function (n, p) { return (p ? 'Out of the shadow of ' + p + ', the' : 'The') + ' ' + n + ' forge a kingdom of their own.'; },
    function (n, p) { return 'Banners of ' + n + ' are raised over ' + (p ? 'the old lands of ' + p : 'the surrounding tribes') + '.'; },
    function (n, p) { return 'A new power stirs: ' + n + (p ? ', once a province of ' + p : '') + '.'; }
  ];
  function riseText(s, c, parentSig) {
    return RISE[s.cSig[c] % RISE.length](civName(s.cSig[c]), parentSig ? civName(parentSig) : '');
  }

  function listNames(arr) {
    if (arr.length <= 1) return arr.join('');
    if (arr.length > 4) return arr.slice(0, 3).join(', ') + ' and ' + (arr.length - 3) + ' others';
    return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
  }

  function secede(s, c, seed, sink) {
    var id = newCiv(s, seed, c, s.cTech[c]);
    if (id < 0) return;
    var count = bfsAssign(s, [seed], [id], c, 6, 55);
    boostAsab(s, id, 4200);
    s.cCap[id] = s.sMaxTile[id] >= 0 ? s.sMaxTile[id] : seed;
    if (count[0] >= CFG.notableTiles) s.cFlags[id] |= 1;
    if (notable(s, c) && count[0] >= 20) {
      emit(sink, s, 'secede', s.cSig[id], s.cSig[c], seed,
        'Distant provinces of ' + civName(s.cSig[c]) + ' rise in revolt and declare the free state of ' + civName(s.cSig[id]) + '.');
    }
  }

  // ---------------------------------------------------------------------------
  // The step function: one year of history
  // ---------------------------------------------------------------------------
  function step(s, sink) {
    var t = s.g[G_TICK];
    s.conq.length = 0;
    computeStats(s);
    computeClimate(s);
    civPhase(s, sink);
    tilePhase(s);
    plaguePhase(s, sink);
    migrationPhase(s);
    warPhase(s);
    tribePhase(s);
    s.g[G_TICK] = t + 1;
  }

  function civPhase(s, sink) {
    var nc = s.g[G_NEXTCIV], t = s.g[G_TICK];
    for (var c = 0; c < nc; c++) {
      if (!s.cAlive[c]) continue;
      var tiles = s.sTiles[c];
      if (tiles === 0) {
        s.cAlive[c] = 0;
        if (notable(s, c)) {
          var yrs = t - s.cFounded[c];
          emit(sink, s, 'fall', s.cSig[c], s.cLostTo[c], s.cCap[c],
            s.cLostTo[c] ? 'The last stronghold of ' + civName(s.cSig[c]) + ' falls to ' + civName(s.cLostTo[c]) + '. After ' + yrs + ' years, they pass into legend.'
              : civName(s.cSig[c]) + ' fades from history after ' + yrs + ' years.');
        }
        continue;
      }
      // capital
      var cap = s.cCap[c];
      if (s.owner[cap] !== c || s.pop[cap] === 0) {
        if (s.cCapLostTo[c] && notable(s, c) && tiles >= CFG.notableTiles && t - s.cLastSack[c] > 40) {
          s.cLastSack[c] = t;
          emit(sink, s, 'sack', s.cCapLostTo[c], s.cSig[c], cap,
            'The capital of ' + civName(s.cSig[c]) + ' is sacked by ' + civName(s.cCapLostTo[c]) + '.');
        }
        s.cCap[c] = s.sMaxTile[c];
        s.sShock[c] = s.cCapLostTo[c] ? 2 : 1;
        s.cCapLostTo[c] = 0;
      }
      if (tiles > s.cPeakTiles[c]) s.cPeakTiles[c] = tiles;
      if (s.sPop[c] > s.cPeakPop[c]) s.cPeakPop[c] = s.sPop[c];
      if (!notable(s, c) && tiles >= CFG.notableTiles) {
        s.cFlags[c] |= 1;
        var parent = s.cParent[c];
        emit(sink, s, 'rise', s.cSig[c], parent, s.cCap[c], riseText(s, c, parent));
      }
      // technology
      var gain = Math.max(0, ilog2(s.sPop[c]) - 9);
      s.cTech[c] += gain - Math.floor(s.cTech[c] / CFG.techDecayDiv);
      var age = ageOf(s.cTech[c]);
      if (age > s.cAge[c]) {
        s.cAge[c] = age;
        if (age > s.g[G_WORLDAGE]) {
          s.g[G_WORLDAGE] = age;
          emit(sink, s, 'age', s.cSig[c], 0, s.cCap[c],
            'The ' + AGES[age].name + ' dawns in ' + civName(s.cSig[c]) + ', first of all peoples.');
        }
      } else if (age < s.cAge[c]) s.cAge[c] = age;

      var A = meanAsab(s, c);
      if (A < CFG.collapseAsab && tiles >= CFG.collapseMinTiles && t - s.cFounded[c] > CFG.graceYears) {
        if (++s.cCrisis[c] >= CFG.crisisYears) { shatter(s, c, sink); continue; }
      } else if (s.cCrisis[c]) s.cCrisis[c]--;
      if (tiles >= CFG.secessionMinTiles && s.sFarPick[c] >= 0) {
        var p = Math.floor(s.sFar[c] * (CFG.asabMax - A) / CFG.asabMax) * 3;
        if (roll(s, CH.SECEDE, c) < p) secede(s, c, s.sFarPick[c], sink);
      }
    }
    // power for war (after collapses so successors are valid)
    nc = s.g[G_NEXTCIV];
    for (c = 0; c < nc; c++) {
      if (!s.cAlive[c] || s.sTiles[c] === 0) { s.sPower[c] = 0; continue; }
      var size = Math.floor(s.sPop[c] / 120) + s.sTiles[c];
      s.sPower[c] = meanAsab(s, c) * size * techMult(s.cTech[c]) / 100;
      s.sReach[c] = reach(s.cTech[c]);
    }
  }

  function tilePhase(s) {
    var asabMax = CFG.asabMax;
    for (var i = 0; i < N; i++) {
      var c = s.owner[i], soil = s.soil[i], base = s.base[i];
      if (c < 0) {
        if (soil < base) s.soil[i] = soil + Math.ceil((base - soil) / CFG.soilRegenDiv);
        else if (soil > base) s.soil[i] = base;
        if (s.immune[i]) s.immune[i]--;
        s.plague[i] = 0; s.starve[i] = 0;
        continue;
      }
      var tech = s.cTech[c], p = s.pop[i];
      var cap = capacity(s, i, tech), starving = 0;
      if (p < cap) {
        var g = Math.floor(p * CFG.growthPct * (cap - p) / (100 * cap));
        p += g < 1 ? 1 : g;
      } else if (p > cap) {
        p -= Math.floor((p - cap) / 4) + 1;
        starving = 1;
      }
      if (s.plague[i]) {
        p -= Math.floor(p * CFG.plagueMortalityPct / 100);
        if (--s.plague[i] === 0) s.immune[i] = CFG.plagueImmunity;
      } else if (s.immune[i]) s.immune[i]--;
      s.starve[i] = starving;

      // soil
      var load = cap > 0 ? Math.min(300, Math.floor(p * 100 / cap)) : 300;
      var depl = Math.floor(load * (CFG.soilDepleteBase + Math.floor(tech / 300)) / 100);
      var regen = base > soil ? Math.ceil((base - soil) / CFG.soilRegenDiv) : 0;
      var ns = soil + regen - depl;
      s.soil[i] = ns < 0 ? 0 : ns > base ? base : ns;

      // solidarity
      // frontier: 2 = facing another people, 1 = facing wilderness, 0 = interior
      var a = s.asab[i], frontier = 0;
      for (var d = 0; d < 4; d++) {
        var nn = NB[i * 4 + d];
        if (nn < 0 || !isLand(s.terrain[nn])) continue;
        var n = s.owner[nn];
        if (n >= 0 && n !== c) { frontier = 2; break; }
        if (n < 0) frontier = 1;
      }
      if (s.sShock[c]) a = Math.floor(a * (s.sShock[c] === 2 ? 75 : 88) / 100);
      if (frontier) a += Math.floor(a * (asabMax - a) / (CFG.asabGrowDiv * (3 - frontier))) + 1;
      else a -= Math.floor(a * CFG.asabDecayPerMille / 1000) + 1;
      if (starving) a -= Math.floor(a / 60);
      s.asab[i] = a < 0 ? 0 : a > asabMax ? asabMax : a;

      if (p < CFG.abandonBelow) { p = 0; s.owner[i] = -1; s.plague[i] = 0; }
      s.pop[i] = p;
    }
    for (var c2 = 0; c2 < s.g[G_NEXTCIV]; c2++) s.sShock[c2] = 0;
  }

  function plaguePhase(s, sink) {
    var t = s.g[G_TICK], mark = (t + 1) >>> 0, i, d;
    for (i = 0; i < N; i++) {
      var p = s.pop[i];
      if (p === 0) continue;
      if (s.plague[i] && s.stamp[i] !== mark) {
        for (d = 0; d < 4; d++) {
          var n = NB[i * 4 + d];
          if (n < 0 || s.pop[n] === 0 || s.plague[n] || s.immune[n]) continue;
          if (roll(s, CH.PLAGUE_SPREAD, n * 4 + d) < CFG.plagueSpreadChance) {
            s.plague[n] = CFG.plagueDuration; s.stamp[n] = mark;
          }
        }
      } else if (!s.plague[i] && !s.immune[i] && p > CFG.plagueOutbreakPop) {
        if (hash4(s.seed, t, i, CH.PLAGUE) % 1000000 < Math.floor((p - CFG.plagueOutbreakPop) / 30)) {
          s.plague[i] = CFG.plagueDuration; s.stamp[i] = mark;
          var c = s.owner[i];
          if (c >= 0 && notable(s, c) && t - s.g[G_LASTPLAGUE] > 60) {
            s.g[G_LASTPLAGUE] = t;
            emit(sink, s, 'plague', s.cSig[c], 0, i, 'Plague erupts in the crowded cities of ' + civName(s.cSig[c]) + '.');
          }
        }
      }
    }
  }

  var STRIDE = 7919; // prime, coprime with N, used to permute iteration order
  function migrationPhase(s) {
    var t = s.g[G_TICK], start = hash4(s.seed, t, 0, CH.ORDER) % N;
    for (var k = 0, i = start; k < N; k++, i += STRIDE, i = i >= N ? i - N : i) {
      var c = s.owner[i];
      if (c < 0) continue;
      var p = s.pop[i];
      if (p < 16) continue;
      var tech = s.cTech[c], cap = capacity(s, i, tech);
      if (p * 4 < cap * 3) continue;
      var load = cap > 0 ? Math.floor(p * 100 / cap) : 300;
      var best = -1, bestScore = -1;
      for (var d = 0; d < 4; d++) {
        var j = NB[i * 4 + d];
        if (j < 0 || !isLand(s.terrain[j])) continue;
        var score = -1, oj = s.owner[j];
        if (oj < 0) {
          if (s.pop[j] === 0 && s.soil[j] > 400) score = 20000 + s.soil[j] + (hash4(s.seed, t, j, CH.MIG) & 1023);
        } else if (oj === c) {
          var cj = capacity(s, j, tech);
          var lj = cj > 0 ? Math.floor(s.pop[j] * 100 / cj) : 300;
          if (lj + 25 < load) score = (300 - lj) * 30 + (hash4(s.seed, t, j, CH.MIG) & 1023);
        }
        if (score > bestScore) { bestScore = score; best = j; }
      }
      if (best >= 0) {
        var m = p >> 3;
        s.pop[i] -= m;
        if (s.owner[best] < 0) { s.owner[best] = c; s.pop[best] = m; s.asab[best] = s.asab[i]; s.plague[best] = 0; }
        else s.pop[best] += m;
      } else if (tech >= CFG.seafaringTech && isCoastal(s, i) && roll(s, CH.SEA, i) < 40) {
        var h = hash4(s.seed, t, i, CH.SEA + 100);
        var tx = TX[i] + (h % 15) - 7, ty = TY[i] + ((h >>> 8) % 15) - 7;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        var tj = ty * W + tx;
        if (isLand(s.terrain[tj]) && s.owner[tj] < 0 && s.pop[tj] === 0 && s.soil[tj] >= 3000) {
          var mm = Math.floor(p / 10);
          s.pop[i] -= mm; s.owner[tj] = c; s.pop[tj] = mm; s.asab[tj] = s.asab[i]; s.plague[tj] = 0;
        }
      }
    }
  }

  function powerAt(s, c, j) {
    var r = s.sReach[c];
    return s.sPower[c] * r / (r + dist(s.cCap[c], j));
  }

  function warPhase(s) {
    var t = s.g[G_TICK], mark = (t + 1) >>> 0;
    var start = hash4(s.seed, t, 1, CH.ORDER) % N;
    var owner = s.owner;
    for (var k = 0, i = start; k < N; k++, i += STRIDE, i = i >= N ? i - N : i) {
      var c = owner[i];
      if (c < 0 || s.pop[i] < 10 || s.stamp[i] === mark) continue;
      var i4 = i * 4, n0 = NB[i4], n1 = NB[i4 + 1], n2 = NB[i4 + 2], n3 = NB[i4 + 3];
      if ((n0 < 0 || owner[n0] < 0 || owner[n0] === c) && (n1 < 0 || owner[n1] < 0 || owner[n1] === c) &&
          (n2 < 0 || owner[n2] < 0 || owner[n2] === c) && (n3 < 0 || owner[n3] < 0 || owner[n3] === c)) continue;
      var d0 = hash4(s.seed, t, i, CH.WAR_DIR) & 3;
      for (var dd = 0; dd < 4; dd++) {
        var j = NB[i * 4 + ((d0 + dd) & 3)];
        if (j < 0) continue;
        var e = s.owner[j];
        if (e < 0 || e === c) continue;
        // ideas cross borders
        if (s.cTech[e] > s.sContact[c]) s.sContact[c] = s.cTech[e];
        if (s.stamp[j] === mark) continue;
        var pc = powerAt(s, c, j);
        var pe = powerAt(s, e, j) * TERRAIN_DEFENSE[s.terrain[j]] / 100 * (s.river[j] ? 1.15 : 1) * (s.cCap[e] === j ? 2 : 1);
        if (pc * 100 > pe * CFG.warAdvantagePct && roll(s, CH.WAR, i) < CFG.warChance) {
          s.pop[j] -= Math.floor(s.pop[j] * CFG.conquestLossPct / 100);
          s.pop[i] -= Math.floor(s.pop[i] / 16);
          s.cLostTo[e] = s.cSig[c];
          s.conq.push(s.cSig[c], s.cSig[e]);
          if (s.cCap[e] === j) s.cCapLostTo[e] = s.cSig[c];
          s.owner[j] = c;
          s.asab[j] = Math.floor(s.asab[i] * 3 / 4);
          s.stamp[j] = mark; s.stamp[i] = mark;
          break;
        }
      }
    }
    var nc = s.g[G_NEXTCIV];
    for (var c2 = 0; c2 < nc; c2++) {
      if (s.cAlive[c2] && s.sContact[c2] > s.cTech[c2]) {
        s.cTech[c2] += Math.floor((s.sContact[c2] - s.cTech[c2]) / 150);
      }
    }
  }

  function tribePhase(s) {
    for (var k = 0; k < 3; k++) {
      if (roll(s, CH.TRIBE, k) >= CFG.tribeChance) continue;
      var i = hash4(s.seed, s.g[G_TICK], k, CH.TRIBE_POS) % N;
      if (!isLand(s.terrain[i]) || s.owner[i] >= 0 || s.soil[i] < 4000) continue;
      if (!noOwnerWithin(s, i, 4)) continue;
      spawnTribe(s, i, CFG.tribeStartPop, CFG.tribeStartAsab);
    }
  }

  // ---------------------------------------------------------------------------
  // Interventions: the time traveller's hand
  // ---------------------------------------------------------------------------
  var TOOLS = [
    { id: 'bless', name: 'Bless the land', icon: '❀', desc: 'Make the soil around a spot rich and green (radius 2).' },
    { id: 'blight', name: 'Salt the earth', icon: '☠', desc: 'Ruin the soil around a spot (radius 2).' },
    { id: 'tribe', name: 'Seed a people', icon: '⚑', desc: 'Found a new tribe with fierce solidarity here.' },
    { id: 'prophet', name: 'Send a prophet', icon: '✶', desc: 'Inspire solidarity in the people around a spot (radius 3).' },
    { id: 'knowledge', name: 'Gift knowledge', icon: '✎', desc: 'Give the civilization here a leap in technology.' },
    { id: 'plague', name: 'Release plague', icon: '☣', desc: 'Start an epidemic at a spot.' },
    { id: 'smite', name: 'Smite', icon: '⚡', desc: 'Kill most of the people at a spot (radius 1).' },
    { id: 'mountain', name: 'Raise mountains', icon: '▲', desc: 'Push up a small mountain range (radius 1).' },
    { id: 'sea', name: 'Flood', icon: '≈', desc: 'Drown a small area beneath the sea (radius 1).' },
    { id: 'land', name: 'Raise land', icon: '◼', desc: 'Lift land out of the sea: build a bridge (radius 1).' }
  ];

  function forArea(x, y, r, fn) {
    for (var yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++)
      for (var xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++)
        if (Math.abs(xx - x) + Math.abs(yy - y) <= r + (r > 1 ? 1 : 0)) fn(yy * W + xx);
  }

  function killTile(s, i) { s.pop[i] = 0; s.owner[i] = -1; s.plague[i] = 0; }

  function applyIntervention(s, iv) {
    var x = iv.x, y = iv.y;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    var center = y * W + x;
    switch (iv.type) {
      case 'bless':
        ensureOwnStatic(s);
        forArea(x, y, 2, function (i) {
          if (!isLand(s.terrain[i])) return;
          if (s.terrain[i] === TER.DESERT || s.terrain[i] === TER.MOUNTAIN) s.terrain[i] = TER.PLAINS;
          recomputeBase(s, i);
          s.base[i] = Math.min(CFG.soilMax, s.base[i] + 3000);
          s.soil[i] = s.base[i];
        });
        break;
      case 'blight':
        ensureOwnStatic(s);
        forArea(x, y, 2, function (i) {
          if (!isLand(s.terrain[i])) return;
          s.base[i] = Math.floor(s.base[i] / 5);
          if (s.soil[i] > s.base[i]) s.soil[i] = s.base[i];
        });
        break;
      case 'tribe':
        if (!isLand(s.terrain[center])) return;
        killTile(s, center);
        if (s.soil[center] < 3000) s.soil[center] = Math.min(s.base[center] + 3000, 6000);
        spawnTribe(s, center, 120, 6000);
        break;
      case 'prophet':
        forArea(x, y, 3, function (i) { if (s.owner[i] >= 0 && s.asab[i] < 9000) s.asab[i] = 9000; });
        break;
      case 'knowledge':
        if (s.owner[center] >= 0) s.cTech[s.owner[center]] += 800;
        break;
      case 'plague':
        if (s.pop[center] > 0) { s.plague[center] = CFG.plagueDuration + 2; s.immune[center] = 0; }
        break;
      case 'smite':
        forArea(x, y, 1, function (i) {
          s.pop[i] = Math.floor(s.pop[i] / 10);
          s.asab[i] = s.asab[i] >> 1;
          if (s.pop[i] < CFG.abandonBelow) killTile(s, i);
        });
        break;
      case 'mountain':
        ensureOwnStatic(s);
        forArea(x, y, 1, function (i) {
          if (!isLand(s.terrain[i])) return;
          s.terrain[i] = TER.MOUNTAIN; s.elev[i] = 1000; s.river[i] = 0;
          recomputeBase(s, i);
          if (s.soil[i] > s.base[i]) s.soil[i] = s.base[i];
        });
        break;
      case 'sea':
        ensureOwnStatic(s);
        forArea(x, y, 1, function (i) {
          s.terrain[i] = TER.SEA; s.river[i] = 0; s.base[i] = 0; s.soil[i] = 0;
          killTile(s, i);
        });
        forArea(x, y, 3, function (i) { recomputeBase(s, i); if (s.soil[i] > s.base[i]) s.soil[i] = s.base[i]; });
        break;
      case 'land':
        ensureOwnStatic(s);
        forArea(x, y, 1, function (i) {
          if (isLand(s.terrain[i])) return;
          s.terrain[i] = TER.PLAINS; s.elev[i] = 600;
        });
        forArea(x, y, 3, function (i) { recomputeBase(s, i); });
        forArea(x, y, 1, function (i) { s.soil[i] = s.base[i]; });
        break;

      // ---- deeds of a single person (small, local; history amplifies them) ----
      case 'irrigate':
        ensureOwnStatic(s);
        forArea(x, y, 1, function (i) {
          if (!isLand(s.terrain[i])) return;
          s.base[i] = Math.min(CFG.soilMax, s.base[i] + 1200);
          s.soil[i] = Math.min(s.base[i], s.soil[i] + 1200);
        });
        break;
      case 'rally':
        forArea(x, y, 1, function (i) { if (s.owner[i] >= 0) s.asab[i] = Math.min(CFG.asabMax, s.asab[i] + 1500); });
        break;
      case 'discord':
        forArea(x, y, 1, function (i) { if (s.owner[i] >= 0) s.asab[i] = Math.max(0, s.asab[i] - 1500); });
        break;
      case 'heal':
        forArea(x, y, 1, function (i) { s.plague[i] = 0; if (s.pop[i] > 0 && s.immune[i] < 30) s.immune[i] = 30; });
        break;
      case 'settle': {
        if (!isLand(s.terrain[center]) || s.owner[center] >= 0 || s.pop[center] > 0) break;
        var from = -1;
        for (var d = 0; d < 4; d++) {
          var n = NB[center * 4 + d];
          if (n >= 0 && s.owner[n] >= 0 && (from < 0 || s.pop[n] > s.pop[from])) from = n;
        }
        var m = from >= 0 ? Math.max(10, Math.floor(s.pop[from] / 4)) : 0;
        if (from >= 0 && s.pop[from] > m + 10) {
          s.pop[from] -= m;
          s.pop[center] = m; s.owner[center] = s.owner[from]; s.asab[center] = s.asab[from];
          if (s.soil[center] < 1500) s.soil[center] = Math.min(s.base[center], 1500);
        } else {
          spawnTribe(s, center, 25, 5000);
        }
        break;
      }
      case 'teach': {
        var tc = s.owner[center];
        if (tc >= 0 && (iv.v | 0) > s.cTech[tc]) s.cTech[tc] += Math.floor(((iv.v | 0) - s.cTech[tc]) / 2);
        break;
      }
      case 'assassinate': {
        var ac = s.owner[center];
        if (ac < 0 || s.cCap[ac] !== center) break;
        // succession crisis: solidarity drops realm-wide; a fragile realm may not survive it
        for (var k = 0; k < N; k++) if (s.owner[k] === ac) s.asab[k] = Math.floor(s.asab[k] * 68 / 100);
        s.cCrisis[ac] = Math.min(255, s.cCrisis[ac] + 8);
        break;
      }
    }
    computeStats(s);
  }

  /** Deeds a single person can do where they stand. Effects live in applyIntervention. */
  var DEEDS = [
    { id: 'irrigate', key: '1', name: 'Dig irrigation', icon: '⌇', desc: 'Dig canals with the locals: richer soil here and next door.' },
    { id: 'rally', key: '2', name: 'Rally the people', icon: '⚑', desc: 'Stir the solidarity of the people around you.' },
    { id: 'heal', key: '3', name: 'Tend the sick', icon: '✚', desc: 'Nurse and quarantine: stop a plague around you.' },
    { id: 'settle', key: '4', name: 'Lead settlers', icon: '⌂', desc: 'Lead neighbours into this empty land, or gather followers into a new people.' },
    { id: 'learn', key: '5', name: 'Learn', icon: '◎', desc: 'Study what the people here know. You carry it with you.' },
    { id: 'teach', key: '6', name: 'Teach', icon: '✎', desc: 'Teach the knowledge you carry to the people here.' },
    { id: 'discord', key: '7', name: 'Sow discord', icon: '☍', desc: 'Spread rumours that weaken the solidarity around you.' },
    { id: 'assassinate', key: '8', name: 'Assassinate', icon: '†', desc: 'At a ruler\'s seat only: throw the whole realm into a succession crisis.' }
  ];

  /** Whether a deed would do anything here. Returns '' if possible, else the reason. */
  function deedBlocker(s, id, x, y, knowledge) {
    var i = y * W + x, c = s.owner[i], d, n, anyOwned = c >= 0;
    for (d = 0; d < 4; d++) { n = NB[i * 4 + d]; if (n >= 0 && s.owner[n] >= 0) anyOwned = true; }
    switch (id) {
      case 'irrigate': return isLand(s.terrain[i]) ? '' : 'You cannot dig canals at sea.';
      case 'rally': case 'discord': return anyOwned ? '' : 'There is no one here to listen.';
      case 'heal':
        if (s.plague[i]) return '';
        for (d = 0; d < 4; d++) { n = NB[i * 4 + d]; if (n >= 0 && s.plague[n]) return ''; }
        return 'No one around you is sick.';
      case 'settle':
        if (!isLand(s.terrain[i])) return 'You cannot settle the sea.';
        return c < 0 && s.pop[i] === 0 ? '' : 'This land is already settled. Walk to empty land.';
      case 'learn': return c >= 0 ? '' : 'There is no one here to learn from.';
      case 'teach':
        if (!knowledge) return 'You have learned nothing yet. Learn from an advanced people first.';
        if (c < 0) return 'There is no one here to teach.';
        return knowledge.tech > s.cTech[c] ? '' : 'They already know more than you can teach.';
      case 'assassinate': return c >= 0 && s.cCap[c] === i ? '' : 'You must stand at a ruler\'s seat (a capital).';
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------
  var Sim = {
    W: W, H: H, N: N, MAX_CIVS: MAX_CIVS, TER: TER, TERRAIN_NAMES: TERRAIN_NAMES,
    AGES: AGES, TOOLS: TOOLS, DEEDS: DEEDS, deedBlocker: deedBlocker, CFG: CFG, G_TICK: G_TICK, NB: NB,
    create: create, step: step, snapshot: snapshot, restore: restore,
    applyIntervention: applyIntervention, computeStats: computeStats,
    stateHash: stateHash, civName: civName, ageOf: ageOf, meanAsab: meanAsab,
    capacity: capacity, computeClimate: computeClimate, isLand: isLand, hash4: hash4,
    tick: function (s) { return s.g[G_TICK]; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
}(this));
