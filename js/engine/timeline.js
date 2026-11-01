/*
 * Timelines: keyframes, branching and time travel on top of the deterministic sim.
 *
 * A timeline (branch) is fully described by (seed, interventions). Everything
 * else -- keyframes, statistics, the chronicle -- is a cache that can be
 * recomputed at any time and will always come out identical.
 *
 *   keyframes[k]  immutable snapshot of the world at year k * kfEvery,
 *                 taken *before* that year's interventions are applied.
 *   computedTo    years [0, computedTo) have been simulated; stats/events for
 *                 those years are valid; the "future" beyond is not yet known.
 *
 * Travelling to year t = restore the nearest keyframe <= t and re-simulate at
 * most kfEvery-1 years. Forking at year T shares every keyframe <= T with the
 * parent (identical history up to that point), so a new branch costs nothing
 * until its future diverges.
 */
(function (root) {
  'use strict';
  var Sim = (typeof module !== 'undefined' && module.exports) ? require('./sim.js') : root.Sim;

  var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
  var SAMPLE = 5; // years between per-civilization census samples (for the history chart)
  var STRIDE = 6; // numbers per realm in a census sample: sig, people, founded, provinces, solidarity, technology

  function World(seed, opts) {
    opts = opts || {};
    this.seed = seed >>> 0;
    this.horizon = opts.horizon || 3000;
    this.kfEvery = opts.kfEvery || 50;
    this.maxCached = opts.maxCached || 4;
    this.branches = [];
    this.useCounter = 0;
    var s0 = Sim.create(this.seed);
    this.genesis = Sim.snapshot(s0);
    this.root = this._newBranch(null, 0, []);
    this.root.name = 'Prime Timeline';
  }

  World.prototype._newBranch = function (parent, forkTick, interventions) {
    var b = {
      id: this.branches.length,
      name: 'Timeline ' + String.fromCharCode(65 + (this.branches.length % 26)) + (this.branches.length >= 26 ? Math.floor(this.branches.length / 26) : ''),
      parent: parent ? parent.id : -1,
      forkTick: forkTick,
      interventions: interventions,
      ivByTick: {},
      keyframes: [this.genesis],
      computedTo: 0,
      work: null,
      events: [],
      popHist: new Float64Array(this.horizon + 1),
      statesHist: new Uint16Array(this.horizon + 1),
      samples: [],
      warLog: [],      // [{dec, a: attackerSig, d: defenderSig, n: provinces taken}]
      warAcc: {},
      lineage: {},     // sig -> { parent: sig, founded: year }
      version: 0,
      lastUsed: ++this.useCounter
    };
    this._index(b);
    this.branches.push(b);
    return b;
  };

  World.prototype._index = function (b) {
    b.ivByTick = {};
    for (var k = 0; k < b.interventions.length; k++) {
      var iv = b.interventions[k];
      (b.ivByTick[iv.t] = b.ivByTick[iv.t] || []).push(iv);
    }
  };

  /** Drop everything that depends on years >= T. Keyframe at T stays valid. */
  World.prototype._truncate = function (b, T) {
    var kf = this.kfEvery;
    var lastK = Math.min(Math.floor(T / kf), b.keyframes.length - 1);
    b.keyframes.length = lastK + 1;
    var to = Math.min(b.computedTo, lastK * kf);
    b.computedTo = to;
    trimDerived(b, to);
    b.work = null;
    b.version++;
  };

  /**
   * The traveller acts at year T. Acting at or after a branch's own latest
   * change (while it has no children) extends that branch, so a life lived
   * forward stays one timeline; going back in time and acting forks a new one.
   */
  World.prototype.intervene = function (b, T, iv) {
    var src = iv;
    iv = { t: T, type: src.type, x: src.x, y: src.y };
    if (src.v) iv.v = src.v | 0;           // e.g. the knowledge level a teacher carries
    if (src.note) iv.note = src.note;      // display only, not part of the timeline's identity
    var self = this;
    var hasChildren = this.branches.some(function (c) { return c.parent === b.id; });
    var own = b.interventions.slice(this._inheritedCount(b));
    // Acting at or after your latest change continues this timeline; going back before it forks.
    var extend = b.parent >= 0 && !hasChildren && own.length > 0 && own.every(function (o) { return o.t <= T; });
    if (extend) {
      b.interventions.push(iv);
      this._index(b);
      this._truncate(b, T);
      return b;
    }
    var inherited = b.interventions.filter(function (o) { return o.t <= T; });
    var child = this._newBranch(b, T, inherited.concat([iv]));
    child.inherited = inherited.length;
    // share the parent's history up to T
    var lastK = Math.min(Math.floor(T / this.kfEvery), b.keyframes.length - 1);
    child.keyframes = b.keyframes.slice(0, lastK + 1);
    child.computedTo = Math.min(b.computedTo, lastK * this.kfEvery);
    var to = child.computedTo;
    child.events = b.events.slice();
    child.samples = b.samples.slice();
    child.warLog = b.warLog.slice();
    child.lineage = Object.assign({}, b.lineage);
    trimDerived(child, to);
    child.popHist.set(b.popHist.subarray(0, to));
    child.statesHist.set(b.statesHist.subarray(0, to));
    self._evict();
    return child;
  };

  World.prototype._inheritedCount = function (b) { return b.inherited || 0; };
  World.prototype.ownInterventions = function (b) { return b.interventions.slice(this._inheritedCount(b)); };

  /** Remove the most recent own intervention of a branch (undo). */
  World.prototype.undo = function (b) {
    if (b.interventions.length <= this._inheritedCount(b)) return false;
    var iv = b.interventions.pop();
    this._index(b);
    this._truncate(b, iv.t);
    return true;
  };

  World.prototype.applyInterventionsAt = function (b, s, t) {
    var list = b.ivByTick[t];
    if (!list) return;
    for (var k = 0; k < list.length; k++) Sim.applyIntervention(s, list[k]);
  };

  World.prototype.isComplete = function (b) { return b.computedTo >= this.horizon; };

  /** Simulate forward for up to budgetMs. Returns true if work was done. */
  World.prototype.compute = function (b, budgetMs) {
    if (b.computedTo >= this.horizon) return false;
    var kf = this.kfEvery, start = now();
    b.lastUsed = ++this.useCounter;
    if (!b.work) {
      var k = Math.min(Math.floor(b.computedTo / kf), b.keyframes.length - 1);
      b.work = Sim.restore(b.keyframes[k]);
      b.computedTo = k * kf;
      var to = b.computedTo;
      trimDerived(b, to);
    }
    var s = b.work, events = b.events;
    var sink = function (e) { e.major = isMajor(s, e); events.push(e); };
    do {
      var t = b.computedTo;
      if (t % kf === 0 && !b.keyframes[t / kf]) b.keyframes[t / kf] = Sim.snapshot(s);
      this.applyInterventionsAt(b, s, t);
      Sim.step(s, sink);
      this._record(b, s, t);
      b.computedTo = t + 1;
    } while (b.computedTo < this.horizon && now() - start < budgetMs);
    if (b.computedTo >= this.horizon) {
      if (this.horizon % kf === 0 && !b.keyframes[this.horizon / kf]) b.keyframes[this.horizon / kf] = Sim.snapshot(s);
      b.work = null; // free memory; keyframes cover everything
    }
    return true;
  };

  function isMajor(s, e) {
    if (e.type === 'age' || e.type === 'rise' || e.type === 'plague') return true;
    // find the subject civ's peak size
    for (var c = 0; c < s.g[1]; c++) if (s.cSig[c] === e.a || (e.type === 'sack' && s.cSig[c] === e.b)) {
      return s.cPeakTiles[c] >= 250;
    }
    return false;
  }

  /** Forget derived history from year `to` on (keyframes are multiples of 50, so decades align). */
  function trimDerived(b, to) {
    b.events = b.events.filter(function (e) { return e.t < to; });
    b.samples.length = Math.min(b.samples.length, Math.ceil(to / SAMPLE));
    b.warLog = b.warLog.filter(function (w) { return w.dec * 10 + 10 <= to; });
    b.warAcc = {};
    for (var sig in b.lineage) if (b.lineage[sig].founded >= to) delete b.lineage[sig];
  }

  World.prototype._record = function (b, s, t) {
    // stats computed at the start of this step (post-intervention state of year t)
    var total = 0, states = 0, nc = s.g[1];
    var sample = t % SAMPLE === 0 ? [] : null;
    for (var c = 0; c < nc; c++) {
      if (s.sTiles[c] <= 0) continue;
      total += s.sPop[c]; states++;
      // census entry: [sig, people, founded, provinces, mean solidarity (0..10000), technology] -- see STRIDE
      if (sample) sample.push(s.cSig[c], s.sPop[c], s.cFounded[c], s.sTiles[c], Math.floor(s.sAsab[c] / s.sTiles[c]), s.cTech[c]);
      var sig = s.cSig[c];
      if (!b.lineage[sig]) b.lineage[sig] = { parent: s.cParent[c], founded: s.cFounded[c] };
    }
    // wars: provinces taken between each pair of peoples, summed per decade
    for (var k = 0; k < s.conq.length; k += 2) {
      var key = s.conq[k] + ',' + s.conq[k + 1];
      b.warAcc[key] = (b.warAcc[key] || 0) + 1;
    }
    if (t % 10 === 9) {
      for (var wk in b.warAcc) {
        if (b.warAcc[wk] < 2) continue;
        var pr = wk.split(',');
        b.warLog.push({ dec: (t - 9) / 10, a: +pr[0], d: +pr[1], n: b.warAcc[wk] });
      }
      b.warAcc = {};
    }
    b.popHist[t] = total;
    b.statesHist[t] = states;
    if (sample) b.samples[t / SAMPLE] = sample;
  };

  /** Free caches of branches not used recently (they recompute on demand). */
  World.prototype._evict = function (keep) {
    var cached = this.branches.filter(function (b) { return b.keyframes.length > 1 || b.work; });
    if (cached.length <= this.maxCached) return;
    cached.sort(function (a, b) { return a.lastUsed - b.lastUsed; });
    for (var k = 0; k < cached.length - this.maxCached; k++) {
      var b = cached[k];
      if (keep && keep.indexOf(b) >= 0) continue;
      b.keyframes.length = 1; b.work = null; b.computedTo = 0; b.events = []; b.samples = []; b.warLog = []; b.warAcc = {}; b.lineage = {}; b.version++;
    }
  };
  World.prototype.touch = function (b, keep) { b.lastUsed = ++this.useCounter; this._evict(keep); };

  // ---------------------------------------------------------------------------
  // A View is a cursor into one branch at one year (used for display).
  // ---------------------------------------------------------------------------
  function View(world) { this.world = world; this.branch = null; this.version = -1; this.s = null; this.tick = -1; }

  /** Move the cursor to year t (interventions of year t applied). */
  View.prototype.seek = function (b, t) {
    var w = this.world, kf = w.kfEvery;
    t = Math.max(0, Math.min(t, w.horizon));
    var cur;
    if (b !== this.branch || b.version !== this.version || !this.s || t < this.tick || t - this.tick > kf) {
      var k = Math.min(Math.floor(t / kf), b.keyframes.length - 1);
      while (k > 0 && !b.keyframes[k]) k--;
      this.s = Sim.restore(b.keyframes[k]);
      cur = k * kf;
      w.applyInterventionsAt(b, this.s, cur);
    } else cur = this.tick;
    while (cur < t) {
      Sim.step(this.s, null);
      cur++;
      w.applyInterventionsAt(b, this.s, cur);
    }
    Sim.computeStats(this.s);
    Sim.computeClimate(this.s);
    this.branch = b; this.version = b.version; this.tick = t;
    return this.s;
  };

  // ---------------------------------------------------------------------------
  // Comparisons between timelines
  // ---------------------------------------------------------------------------
  function tileSig(s, i) { var c = s.owner[i]; return c < 0 ? 0 : s.cSig[c]; }

  /** Fraction (0..1) of land tiles ruled by a different people in the two worlds. */
  function divergence(a, b) {
    var land = 0, diff = 0;
    for (var i = 0; i < Sim.N; i++) {
      if (!Sim.isLand(a.terrain[i]) && !Sim.isLand(b.terrain[i])) continue;
      land++;
      if (tileSig(a, i) !== tileSig(b, i)) diff++;
    }
    return land ? diff / land : 0;
  }

  /** How much two worlds differ: share of land ruled differently, and lives changed. */
  function impact(a, b) {
    var lives = 0;
    for (var i = 0; i < Sim.N; i++) { var d = a.pop[i] - b.pop[i]; lives += d < 0 ? -d : d; }
    return { owners: divergence(a, b), lives: lives };
  }

  function eventKey(e) { return e.t + '|' + e.type + '|' + e.a + '|' + e.b; }

  /**
   * Merge two chronicles. Returns events of `b` annotated with .diff:
   * 'new' (not in compare), plus compare-only events marked 'erased'.
   */
  function diffChronicle(evB, evC, upTo) {
    var keysC = {}, keysB = {}, out = [], k;
    for (k = 0; k < evC.length; k++) if (evC[k].t < upTo) keysC[eventKey(evC[k])] = 1;
    for (k = 0; k < evB.length; k++) {
      var e = evB[k];
      keysB[eventKey(e)] = 1;
      out.push({ e: e, diff: e.t < upTo && !keysC[eventKey(e)] ? 'new' : '' });
    }
    for (k = 0; k < evC.length; k++) {
      if (evC[k].t < upTo && !keysB[eventKey(evC[k])]) out.push({ e: evC[k], diff: 'erased' });
    }
    out.sort(function (x, y) { return x.e.t - y.e.t || (x.diff === 'erased') - (y.diff === 'erased'); });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Sharing: a whole timeline is just (seed, interventions)
  // ---------------------------------------------------------------------------
  function encode(seed, interventions) {
    return 'seed=' + seed + (interventions.length ? '&iv=' + interventions.map(function (iv) {
      return iv.t + '.' + iv.type + '.' + iv.x + '.' + iv.y + (iv.v ? '.' + iv.v : '');
    }).join('_') : '');
  }
  function decode(str) {
    var out = { seed: null, interventions: [] };
    (str || '').replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('=');
      if (p[0] === 'seed') out.seed = parseInt(p[1], 10) >>> 0;
      if (p[0] === 'home') out.home = parseInt(p[1], 10) >>> 0;
      if (p[0] === 'born' && p[1]) { var xy = p[1].split('.'); out.born = { x: parseInt(xy[0], 10), y: parseInt(xy[1], 10) }; }
      if (p[0] === 'iv' && p[1]) out.interventions = p[1].split('_').map(function (s) {
        var q = s.split('.');
        var iv = { t: parseInt(q[0], 10), type: q[1], x: parseInt(q[2], 10), y: parseInt(q[3], 10) };
        if (q[4]) iv.v = parseInt(q[4], 10) | 0;
        return iv;
      }).filter(function (iv) { return !isNaN(iv.t) && !isNaN(iv.x) && !isNaN(iv.y); })
        .sort(function (a, b) { return a.t - b.t; });
    });
    return out;
  }

  var Timeline = { World: World, View: View, divergence: divergence, impact: impact, diffChronicle: diffChronicle,
    encode: encode, decode: decode, SAMPLE: SAMPLE, STRIDE: STRIDE, eventKey: eventKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = Timeline;
  else root.Timeline = Timeline;
}(this));
