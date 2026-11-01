/*
 * The Oracle: what the Chronoscope "knows".
 *
 * Given a timeline and a realm whose fall is foretold, it replays history
 * from a series of candidate years, each time with one simple deed a single
 * person could do (kill a rival's ruler, rally the capital, carry knowledge…),
 * and records which deeds would keep the realm alive to the target year.
 *
 * Because the world is deterministic these are not guesses: standing in that
 * year and place and doing that deed *will* have that result in this timeline.
 * The work is resumable and runs a few milliseconds at a time.
 */
(function (root) {
  'use strict';
  var Sim = (typeof module !== 'undefined' && module.exports) ? require('./sim.js') : root.Sim;
  var Timeline = (typeof module !== 'undefined' && module.exports) ? require('./timeline.js') : root.Timeline;
  var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
  var W = Sim.W;

  function findCiv(s, sig) {
    for (var c = 0; c < s.g[1]; c++) if (s.cSig[c] === sig && s.cAlive[c] && s.sTiles[c] > 0) return c;
    return -1;
  }

  /**
   * opts: { world, branch, homeSig, foeSig, end (foretold fall), target, span, every }
   */
  function Oracle(opts) {
    this.o = opts;
    this.years = [];
    var span = opts.span || 160, every = opts.every || 20;
    for (var t = Math.max(0, opts.end - span); t <= opts.end - 5; t += every) this.years.push(t);
    this.yi = 0;
    this.queue = [];      // candidate jobs for the current year
    this.job = null;
    this.results = [];    // { t, type, x, y, win }
    this.total = 0;
    this.done = false;
    this.view = new Timeline.View(opts.world);
  }

  Oracle.prototype._plan = function (T) {
    var o = this.o, s = this.view.seek(o.branch, T), jobs = [];
    var home = findCiv(s, o.homeSig);
    if (home < 0) return jobs; // nothing to save in this year
    var cap = s.cCap[home], foe = o.foeSig ? findCiv(s, o.foeSig) : -1;
    var best = 0;
    for (var c = 0; c < s.g[1]; c++) if (s.cAlive[c] && s.sTiles[c] > 0 && s.cTech[c] > best) best = s.cTech[c];
    var add = function (type, tile, v) { jobs.push({ t: T, type: type, x: tile % W, y: (tile / W) | 0, v: v || 0 }); };
    if (foe >= 0) { add('assassinate', s.cCap[foe]); add('discord', s.cCap[foe]); }
    add('rally', cap);
    add('irrigate', cap);
    if (best > s.cTech[home] + 300) add('teach', cap, best);
    var snap = Sim.snapshot(s);
    jobs.forEach(function (j) { j.snap = snap; });
    return jobs;
  };

  /** Work for up to budgetMs. Returns true while there is more to do. */
  Oracle.prototype.work = function (budgetMs) {
    if (this.done) return false;
    var o = this.o, start = now();
    while (now() - start < budgetMs) {
      if (!this.job) {
        if (!this.queue.length) {
          if (this.yi >= this.years.length) { this.done = true; return false; }
          this.queue = this._plan(this.years[this.yi++]);
          continue;
        }
        var j = this.queue.shift();
        j.s = Sim.restore(j.snap);
        Sim.applyIntervention(j.s, { t: j.t, type: j.type, x: j.x, y: j.y, v: j.v });
        this.job = j;
      }
      var job = this.job, s = job.s;
      while (Sim.tick(s) < o.target && now() - start < budgetMs) Sim.step(s, null);
      if (Sim.tick(s) >= o.target) {
        Sim.computeStats(s);
        this.results.push({ t: job.t, type: job.type, x: job.x, y: job.y, win: findCiv(s, o.homeSig) >= 0 });
        this.total++;
        this.job = null;
      }
    }
    return true;
  };

  Oracle.prototype.wins = function () { return this.results.filter(function (r) { return r.win; }); };
  Oracle.prototype.progress = function () { return this.years.length ? Math.min(1, this.yi / this.years.length) : 1; };

  /** A word for how hard the quest is, from the share of tested deeds that succeed. */
  Oracle.prototype.difficulty = function () {
    if (!this.total) return null;
    var r = this.wins().length / this.total;
    if (r >= 0.3) return { label: 'Many threads lead to salvation', level: 1 };
    if (r >= 0.1) return { label: 'A few threads lead to salvation', level: 2 };
    if (r > 0) return { label: 'The threads of fate are tangled: very few lead to salvation', level: 3 };
    return { label: 'No single deed will turn this fate. It will take many', level: 4 };
  };

  /** How strongly the Chronoscope hums for someone at (x, y) in year t. */
  Oracle.prototype.hum = function (x, y, t) {
    var best = null;
    this.wins().forEach(function (r) {
      var dt = Math.abs(t - r.t), dd = Math.abs(x - r.x) + Math.abs(y - r.y), level = 0;
      if (dt <= 3 && dd === 0) level = 3;
      else if (dt <= 10 && dd <= 6) level = 2;
      else if (dt <= 25) level = 1;
      if (level && (!best || level > best.level)) best = { level: level, deed: level === 3 ? r.type : null, r: r };
    });
    return best;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Oracle;
  else root.Oracle = Oracle;
}(this));
