/*
 * Era gear: weapons, armour and ammunition from every age of the simulation,
 * and the suspicion you draw by carrying things that should not exist yet.
 *
 *   - Each item has an age (Stone Age 0 … Industrial Age 6, the simulation's AGES).
 *   - Smiths sell what their own people can make (their realm's age).
 *   - Ammunition is era-locked: nobody in the Middle Ages can make cartridges.
 *   - Carrying gear two or more ages ahead of the people around you raises
 *     suspicion; a gunshot where guns are unknown raises it sharply. Elders and
 *     smiths stop dealing with you, and at the worst, witch-hunters come.
 *   - Selling a far-future item to a smith lets their people reverse-engineer
 *     it: a real "knowledge" deed in the timeline.
 */
(function (root) {
  'use strict';
  var Sim = root.Sim;
  var R = function () { return root.RPG; };
  function G() { return R().G; }
  function esc(t) { return R().esc(t); }

  var AGE_NAMES = Sim.AGES.map(function (a) { return a.name; });
  var MELEE = [
    { name: 'Stone club', w: 'club' }, { name: 'Bronze sword', w: 'sword' }, { name: 'Iron sword', w: 'sword' },
    { name: 'Steel gladius', w: 'sword' }, { name: 'Longsword', w: 'longsword' }, { name: 'Rapier', w: 'rapier' }, { name: 'Cavalry sabre', w: 'sabre' }
  ];
  var RANGED = [
    { name: 'Sling', w: 'sling', ammo: 'stones', mult: 0.8, cd: 0.5, speed: 13 },
    { name: 'Hunting bow', w: 'bow', ammo: 'arrows', mult: 0.9, cd: 0.45, speed: 14 },
    { name: 'Recurve bow', w: 'bow', ammo: 'arrows', mult: 1.0, cd: 0.45, speed: 15 },
    { name: 'Composite bow', w: 'bow', ammo: 'arrows', mult: 1.1, cd: 0.45, speed: 16 },
    { name: 'Crossbow', w: 'crossbow', ammo: 'bolts', mult: 1.5, cd: 0.85, speed: 20 },
    { name: 'Arquebus', w: 'gun', ammo: 'shot', mult: 2.2, cd: 1.4, speed: 30, gun: 1 },
    { name: 'Rifle', w: 'gun', ammo: 'cartridges', mult: 2.6, cd: 0.85, speed: 34, gun: 1 }
  ];
  var ARMOR = ['Hides', 'Bronze scale', 'Iron mail', 'Lorica', 'Plate armour', 'Breastplate', 'Greatcoat'];
  var CLOTHES = ['furs and hides', 'woven kilt', 'wool tunic', 'toga and sandals', 'doublet and hose', 'ruffled doublet', 'frock coat'];
  // how people take your clothes: no one attacks you for them, but they pay less, charge more, or walk away
  var DRESS = [
    { label: 'fits in', price: 1, pay: 1 },
    { label: 'foreign', price: 1.15, pay: 0.85 },
    { label: 'strange', price: 1.5, pay: 0.5 },
    { label: 'outlandish', price: 2, pay: 0.25 }
  ];
  // the age at which people can make each kind of ammunition, and how much you can carry
  var AMMO = { stones: { age: 0, max: 40, label: 'stones' }, arrows: { age: 1, max: 40, label: 'arrows' }, bolts: { age: 4, max: 30, label: 'bolts' },
    shot: { age: 5, max: 20, label: 'shot' }, cartridges: { age: 6, max: 24, label: 'cartridges' } };
  var SUSPECT = 35, HUNT = 70;

  // what you have in a slot with nothing wielded: you blend in, but you lose that attack or defence
  var EMPTY = {
    melee: { slot: 'melee', none: 1, age: -9, name: 'Bare fists', w: 'fist', mult: 0.4 },
    ranged: { slot: 'ranged', none: 1, age: -9, name: 'Nothing to shoot', w: 'none', mult: 0, ammo: null, cd: 0.4, speed: 1 },
    armor: { slot: 'armor', none: 1, age: -9, name: 'Plain clothes', reduce: 0 }
  };
  function empty(slot) { return Object.assign({}, EMPTY[slot]); }
  function ageMult(age) { return (1 + 0.2 * age) / 1.5; }   // tuned so same-age gear matches same-age foes
  function item(slot, age, sig) {
    age = Math.max(0, Math.min(6, age | 0));
    var it = { slot: slot, age: age };
    if (slot === 'melee') { it.name = MELEE[age].name; it.w = MELEE[age].w; it.mult = ageMult(age); }
    else if (slot === 'ranged') { var r = RANGED[age]; for (var k in r) it[k] = r[k]; it.mult = r.mult * ageMult(age); }
    else if (slot === 'armor') { it.name = ARMOR[age]; it.reduce = age * 0.045; }
    else { it.sig = sig || 0; it.name = (sig ? Sim.civName(sig) + ' ' : '') + CLOTHES[age]; if (!sig) it.name = it.name.charAt(0).toUpperCase() + it.name.slice(1); }
    return it;
  }
  /** An item's name mid-sentence (keeps a people's name capitalised). */
  function lower(it) { return it.sig ? it.name : it.name.toLowerCase(); }
  function price(it) {
    if (it.slot === 'clothes') return 12 + 8 * it.age;
    return Math.round((it.slot === 'armor' ? 40 : 30) + (it.slot === 'ranged' ? 32 : 25) * it.age);
  }

  function starter(p, age, sig) {
    p.eq = { melee: item('melee', age), ranged: item('ranged', age), armor: item('armor', Math.max(0, age - 1)), clothes: item('clothes', age, sig) };
    p.concealed = [];
    p.pack = [];
    p.ammo = {}; p.ammo[p.eq.ranged.ammo] = 25;
    p.silver = 30;
  }
  function ammoOf(p) { return p.eq.ranged.none ? 0 : p.ammo[p.eq.ranged.ammo] || 0; }
  function useAmmo(p) { p.ammo[p.eq.ranged.ammo] = ammoOf(p) - 1; }

  /** Age of the people at province pi, or -1 in empty land (no witnesses). */
  function localAge(pi) {
    var s = G().s, c = s.owner[pi];
    return c >= 0 && s.pop[pi] > 0 ? Sim.ageOf(s.cTech[c]) : -1;
  }
  /** How far out of its time your visible gear is here (0 = nothing strange). */
  function anachronism(pi) {
    var p = G().player, la = localAge(pi);
    if (la < 0) return 0;
    var worst = 0;
    ['melee', 'ranged', 'armor'].forEach(function (slot) {
      var d = outOfTime(p.eq[slot], la);
      if (d > worst) worst = d;
    });
    return worst;
  }
  /** How far out of its time an item looks to a people of age la (0 = it passes). */
  function outOfTime(it, la) {
    if (!it || it.none || la < 0) return 0;
    var d = it.age - la - 1;                 // one age ahead is just fine foreign work
    if (it.gun && la < 5) d += 1;            // nobody mistakes a gun for anything else
    return Math.max(0, d);
  }
  /** The age of the people you are among, or of the nearest people if you are in the wilds. */
  function nearbyAge(pi) {
    var la = localAge(pi);
    if (la >= 0) return la;
    var W = Sim.W, x = pi % W, y = (pi / W) | 0, best = -1, bd = 1e9;
    for (var dy = -8; dy <= 8; dy++) for (var dx = -8; dx <= 8; dx++) {
      var nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= Sim.H) continue;
      var a = localAge(ny * W + nx), d = Math.abs(dx) + Math.abs(dy);
      if (a >= 0 && d < bd) { bd = d; best = a; }
    }
    return best;
  }

  /** How your clothes read among the people at pi: 0 fits in … 3 outlandish. */
  function dress(pi) {
    var g = G(), p = g.player, s = g.s, c = s.owner[pi], la = localAge(pi), cl = p.eq.clothes;
    if (la < 0 || !cl) return 0;
    var gap = Math.abs(cl.age - la);
    if (gap >= 4) return 3;
    if (gap >= 2) return 2;
    return cl.sig && cl.sig !== s.cSig[c] ? 1 : 0;
  }
  function dressInfo(pi) { return DRESS[dress(pi)]; }
  /** Ordinary people may turn away from someone dressed wrong. Returns true (and they walk off) if so. */
  function refuses(npc) {
    var civil = { villager: 1, elder: 2, sentry: 1, settler: 1 }[npc.role];
    if (!civil) return false;
    var d = dress(npc.prov), p = G().player;
    var no = d >= 3 || (d === 2 && (civil === 1 || Sim.hash4(npc.id, 3, 4, 5) % 2 === 0));
    if (!no) return false;
    npc.fleeT = 3;
    var what = lower(p.eq.clothes);
    R().toast('<b>' + esc(npc.name) + '</b> looks you up and down, at your ' + esc(what) + ', and walks away without a word.' + (d >= 2 ? ' <span class="muted">(Dress like the people here: a smith\'s market sells local clothes.)</span>' : ''), 5000);
    return true;
  }

  /** U: hide everything that would look out of place among the people here, or take it all back out. */
  function toggleConceal() {
    var p = G().player, pi = R().provOf(p.x, p.y);
    if (p.concealed && p.concealed.length) {
      var names = [];
      p.concealed.forEach(function (it) {
        var cur = p.eq[it.slot];
        if (cur && !cur.none) p.pack.push(cur);
        p.eq[it.slot] = it;
        names.push(it.name.toLowerCase());
      });
      p.concealed = [];
      R().toast('You unwrap your ' + esc(names.join(' and ')) + '.' + (anachronism(pi) > 0 ? ' <b>People will notice.</b>' : ''));
      return;
    }
    var la = nearbyAge(pi), hid = [];
    if (la < 0) { R().toast('There is no one for days in any direction. Nothing to hide from.'); return; }
    ['melee', 'ranged', 'armor'].forEach(function (slot) {
      var it = p.eq[slot];
      if (!outOfTime(it, la)) return;
      hid.push(it);
      p.eq[slot] = empty(slot);
    });
    if (!hid.length) { R().toast('Nothing you carry would look out of place among a ' + AGE_NAMES[la] + ' people.'); return; }
    p.concealed = hid;
    var lost = hid.map(function (it) { return it.slot === 'melee' ? 'you fight with your fists' : it.slot === 'ranged' ? 'you have nothing to shoot' : 'you have no armour'; });
    R().toast('You wrap your ' + esc(hid.map(function (it) { return it.name.toLowerCase(); }).join(' and ')) + ' in cloth and hide them. You blend in now, but ' + lost.join(', ') + '. (U to take them out.)', 7000);
  }

  function update(dt) {
    var g = G(), p = g.player;
    if (!p || p.dead) return;
    var pi = R().provOf(p.x, p.y), a = anachronism(pi), before = p.suspicion || 0;
    p.suspicion = a > 0 ? Math.min(100, before + a * 5 * dt) : Math.max(0, before - (localAge(pi) < 0 ? 12 : 5) * dt);
    if (before < SUSPECT && p.suspicion >= SUSPECT) R().toast('People stare at your ' + esc(worstItem(pi).name.toLowerCase()) + ' and whisper. <b>They are suspicious of you.</b> (Put it away with I.)', 7000);
    if (before < HUNT && p.suspicion >= HUNT) R().toast('<b>"Witch! Sorcerer!"</b> Word has spread. They are coming for you.', 7000);
    g.huntT = (g.huntT || 0) - dt;
    if (p.suspicion >= HUNT && localAge(pi) >= 0 && g.huntT <= 0) {
      g.huntT = 25;
      var s = g.s, sig = s.cSig[s.owner[pi]], ang = Math.random() * 6.28;
      ['hunter', 'hunter', 'hunter'].forEach(function (k, i) {
        var h = R().spawnNear(k, p.x + Math.cos(ang) * (8 + i), p.y + Math.sin(ang) * (8 + i), { faction: sig, hostile: true, prov: pi });
        if (h) h.state = 'chase';
      });
    }
  }
  function worstItem(pi) {
    var p = G().player, la = Math.max(0, localAge(pi)), best = p.eq.melee;
    ['melee', 'ranged', 'armor'].forEach(function (s) { var it = p.eq[s]; if (it && it.age - la > best.age - la) best = it; });
    return best;
  }
  function onShot() {
    var p = G().player, pi = R().provOf(p.x, p.y), la = localAge(pi);
    if (p.eq.ranged.gun && la >= 0 && la < 5) {
      p.suspicion = Math.min(100, (p.suspicion || 0) + 22);
      if (!G().gunWarned) { G().gunWarned = true; R().toast('The thunder of your ' + esc(p.eq.ranged.name.toLowerCase()) + ' echoes off the houses. Shutters slam. <b>Nobody here has heard a gun before.</b>', 7000); }
    }
  }
  function suspicionLabel(v) { return v >= HUNT ? 'witch hunt' : v >= SUSPECT ? 'whispers' : v > 5 ? 'stares' : ''; }
  function suspected() { return (G().player.suspicion || 0) >= SUSPECT; }

  /** Rest: restock the ammunition the people here can make. */
  function restock(pi) {
    var p = G().player, la = localAge(pi), got = [];
    for (var k in AMMO) {
      if (AMMO[k].age > la) continue;
      if (k !== p.eq.ranged.ammo && !(p.ammo[k] > 0)) continue;
      if ((p.ammo[k] || 0) < AMMO[k].max) { p.ammo[k] = AMMO[k].max; got.push(AMMO[k].label); }
    }
    var need = p.eq.ranged.ammo;
    var note = need && AMMO[need].age > la ? ' Nobody here can make ' + AMMO[need].label + ' for your ' + p.eq.ranged.name.toLowerCase() + '.' : '';
    return (got.length ? 'Restocked ' + got.join(', ') + '.' : '') + note;
  }

  // ---------------------------------------------------------------------------
  // Smiths and the inventory (both keyboard dialogs)
  // ---------------------------------------------------------------------------
  function smithTalk(npc) {
    var g = G(), p = g.player, s = g.s, la = localAge(npc.prov), c = s.owner[npc.prov];
    if (suspected()) {
      R().dialog({ kicker: npc.name, title: '', html: '<p>The smith looks at your ' + esc(worstItem(npc.prov).name.toLowerCase()) + ' and then at you, and does not put down the hammer. "I don\'t know what you are, and I don\'t want your silver. Go."</p>', buttons: [{ label: 'Leave' }] });
      return;
    }
    la = Math.max(0, la);
    var dr = dressInfo(npc.prov), sig = s.cSig[c];
    var wares = [item('clothes', la, sig), item('melee', la), item('ranged', la), item('armor', la)];
    var btns = [], d = dress(npc.prov);
    // a smith who doesn't like the look of you will only sell you something decent to wear
    var clothesOnly = d >= 3 || (d === 2 && Sim.hash4(npc.id, 3, 4, 5) % 2 === 0);
    if (clothesOnly) {
      var cl = wares[0], cc = Math.round(price(cl) * dr.price);
      R().dialog({ kicker: npc.name, title: '', html: '<p>The smith looks at your ' + esc(lower(p.eq.clothes)) + ' and folds their arms. "I don\'t trade with ' + (d >= 3 ? 'whatever you are' : 'mummers') + '. Get yourself decent clothes first, then we\'ll talk. My cousin has some, if you have silver."</p><p class="muted">You have <b>' + p.silver + '</b> silver.</p>',
        buttons: [{ label: 'Buy ' + cl.name + ' (' + cc + ' silver)', fn: function () { buy(npc, cl, cc); } }, { label: 'Leave' }] });
      return;
    }
    wares.forEach(function (it) {
      var cur = p.eq[it.slot], have = cur && !cur.none && cur.age === it.age && (it.slot !== 'clothes' || cur.sig === it.sig);
      if (have) return;
      var cost = Math.round(price(it) * dr.price);
      btns.push({ label: 'Buy ' + it.name + ' (' + cost + ' silver)', fn: function () { buy(npc, it, cost); } });
    });
    if (la >= 1 && !p.horse) {
      var hp = Math.round((50 + 12 * la) * dr.price);
      btns.push({ label: 'Buy a horse (' + hp + ' silver)', fn: function () {
        if (p.silver < hp) { R().toast('Not enough silver.'); smithTalk(npc); return; }
        p.silver -= hp; p.horse = { age: la };
        R().toast('The horse is yours. Press <b>B</b> to ride; on the travel map (M) every journey takes half the time.', 7000);
        smithTalk(npc);
      } });
    }
    var am = item('ranged', la).ammo, amPrice = Math.round((AMMO[am].age >= 5 ? 20 : 8) * dr.price);
    btns.push({ label: 'Buy ' + AMMO[am].max / 2 + ' ' + AMMO[am].label + ' (' + amPrice + ' silver)', fn: function () {
      if (p.silver < amPrice) return R().toast('Not enough silver.');
      p.silver -= amPrice; p.ammo[am] = Math.min(AMMO[am].max, (p.ammo[am] || 0) + AMMO[am].max / 2);
      R().toast('+' + AMMO[am].max / 2 + ' ' + AMMO[am].label + '.'); smithTalk(npc);
    } });
    if (p.pack.length) btns.push({ label: 'Sell something…', fn: function () { sellDialog(npc); } });
    btns.push({ label: 'Leave' });
    R().dialog({ kicker: npc.name, title: 'The ' + Sim.civName(s.cSig[c]) + ' forge and market',
      html: '<p>The forge is hot and the stalls are full. "We make what any ' + AGE_NAMES[la] + ' people makes, and make it well."</p>' +
        (dr.price > 1 ? '<p class="warn">The smith eyes your ' + esc(lower(p.eq.clothes)) + '. Prices go up ' + Math.round((dr.price - 1) * 100) + '% for someone who looks ' + dr.label + '.</p>' : '') +
        '<p class="muted">You have <b>' + p.silver + '</b> silver.</p>', buttons: btns.slice(0, 9) });
  }
  function buy(npc, it, cost) {
    var p = G().player;
    cost = cost || price(it);
    if (p.silver < cost) { R().toast('Not enough silver (' + cost + ' needed).'); smithTalk(npc); return; }
    p.silver -= cost;
    var old = p.eq[it.slot];
    p.eq[it.slot] = it;
    if (old && !old.none) p.pack.push(old);
    if (it.slot === 'ranged' && !(p.ammo[it.ammo] > 0)) p.ammo[it.ammo] = Math.round(AMMO[it.ammo].max / 2);
    R().toast('You buy the ' + esc(it.name.toLowerCase()) + (old && !old.none ? ' and put your old ' + esc(old.name.toLowerCase()) + ' in your pack.' : '.'));
    smithTalk(npc);
  }
  function sellDialog(npc) {
    var g = G(), p = g.player, la = Math.max(0, localAge(npc.prov)), c = g.s.owner[npc.prov], sig = g.s.cSig[c];
    g.taughtBy = g.taughtBy || {};
    var btns = p.pack.slice(0, 8).map(function (it) {
      var future = it.slot !== 'clothes' && it.age >= la + 2, val = Math.round(price(it) * (future ? 1 : 0.5) * dressInfo(npc.prov).pay);
      return { label: 'Sell ' + it.name + ' (' + AGE_NAMES[it.age] + ', ' + val + ' silver)' + (future ? ' ✦' : ''), fn: function () {
        p.pack.splice(p.pack.indexOf(it), 1);
        p.silver += val;
        if (future && !g.taughtBy[sig + ':' + it.slot + ':' + it.age]) {
          g.taughtBy[sig + ':' + it.slot + ':' + it.age] = 1;
          R().dialog({ kicker: npc.name, title: 'Reverse-engineered', html: '<p>The smith turns the ' + esc(it.name.toLowerCase()) + ' over and over, then calls for the other masters. By lamplight they take it apart, piece by piece, and draw every piece.</p><p>"Who made this? No, don\'t tell me. Just leave it with us."</p>',
            buttons: [{ label: 'Leave it with them', fn: function () { R().applyDeed('knowledge', npc.prov, 0, 'A ' + it.name.toLowerCase() + ' out of its time'); } }] });
        } else { R().toast('Sold for ' + val + ' silver.'); sellDialog(npc); }
      } };
    });
    btns.push({ label: 'Back', fn: function () { smithTalk(npc); } });
    R().dialog({ kicker: npc.name, title: 'Sell', html: '<p>"Let\'s see what you have."</p><p class="muted">✦ = made in an age this smith has never seen. Selling it teaches their whole people (a deed in the timeline).</p>', buttons: btns });
  }

  // ---------------------------------------------------------------------------
  // Inventory screen
  // ---------------------------------------------------------------------------
  var SLOT_NAMES = { melee: 'Melee', ranged: 'Ranged', armor: 'Armour', clothes: 'Clothes' };
  function invRows() {
    var p = G().player, rows = [];
    ['melee', 'ranged', 'armor', 'clothes'].forEach(function (slot) { rows.push({ kind: 'eq', slot: slot, item: p.eq[slot] }); });
    (p.concealed || []).forEach(function (it) { rows.push({ kind: 'hidden', item: it }); });
    p.pack.forEach(function (it) { rows.push({ kind: 'pack', item: it }); });
    return rows;
  }
  function stats(it, pi) {
    var la = localAge(pi);
    if (it.none) return it.slot === 'melee' ? 'weak blows (×' + it.mult + ')' : it.slot === 'ranged' ? 'no ranged attack' : 'no protection';
    var out = [];
    if (it.slot === 'melee') out.push('damage ×' + it.mult.toFixed(2));
    if (it.slot === 'ranged') out.push('damage ×' + it.mult.toFixed(2), (it.cd >= 0.8 ? 'slow' : 'quick') + ' to reload', AMMO[it.ammo].label + ' (made from the ' + AGE_NAMES[AMMO[it.ammo].age] + ')');
    if (it.slot === 'armor') out.push('−' + Math.round(it.reduce * 100) + '% damage taken');
    if (it.slot === 'clothes') {
      var c = G().s.owner[pi], gap = la >= 0 ? Math.abs(it.age - la) : 0;
      out.push(la < 0 ? 'no one here to see' : gap >= 4 ? 'outlandish here' : gap >= 2 ? 'strange here' : it.sig && c >= 0 && it.sig !== G().s.cSig[c] ? 'foreign here' : 'fits in here');
    } else if (outOfTime(it, la)) out.push('<span class="bad">out of its time here</span>');
    return out.join(' · ');
  }
  function renderInventory(sel) {
    var g = G(), p = g.player, pi = R().provOf(p.x, p.y), la = localAge(pi), rows = invRows();
    sel = Math.max(0, Math.min(rows.length - 1, sel || 0));
    var d = dressInfo(pi), sus = p.suspicion || 0;
    var h = '<div class="inv-top"><div><span class="lbl">Here</span> ' + (la >= 0 ? 'a ' + AGE_NAMES[la] + ' people, the ' + esc(Sim.civName(g.s.cSig[g.s.owner[pi]])) : 'the wilds: no one to see you') + '</div>' +
      '<div><span class="lbl">Dress</span> you look <b class="' + (d.price > 1.2 ? 'bad' : '') + '">' + d.label + '</b>' + (d.price > 1 ? ' (prices ×' + d.price + ', pay ×' + d.pay + ')' : '') + '</div>' +
      '<div><span class="lbl">Suspicion</span> ' + Math.round(sus) + (suspicionLabel(sus) ? ' (' + suspicionLabel(sus) + ')' : '') + '</div>' +
      '<div><span class="lbl">Silver</span> ' + p.silver + ' · <span class="lbl" style="min-width:0">Ammo</span> ' + Object.keys(p.ammo).filter(function (k) { return p.ammo[k] > 0; }).map(function (k) { return p.ammo[k] + ' ' + AMMO[k].label; }).join(', ') + '</div></div>';
    var group = '';
    rows.forEach(function (r, i) {
      var head = r.kind === 'eq' ? 'Wearing and wielding' : r.kind === 'hidden' ? 'Hidden away (U takes them all out)' : 'Pack (' + p.pack.length + '/10)';
      if (head !== group) { h += '<div class="inv-h">' + head + '</div>'; group = head; }
      var it = r.item, age = it.none ? '' : '<span class="age">' + AGE_NAMES[it.age] + '</span>';
      h += '<div class="inv-row' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' +
        (r.kind === 'eq' ? '<span class="slot">' + SLOT_NAMES[r.slot] + '</span>' : '<span class="slot">' + SLOT_NAMES[it.slot] + '</span>') +
        '<span class="nm">' + esc(it.name) + '</span>' + age + '<span class="st">' + stats(it, pi) + '</span></div>';
    });
    if (!p.pack.length) h += '<div class="muted inv-empty">Your pack is empty. Smiths sell gear and clothes; elite foes and rulers drop theirs.</div>';
    var r0 = rows[sel], act = '';
    if (r0) {
      if (r0.kind === 'eq') act = r0.slot === 'clothes' ? 'Clothes can only be changed for other clothes from your pack.' : r0.item.none ? 'Nothing wielded. Pick an item from your pack to wield it.' : '<b>Enter</b>: stow it in your pack (you lose this ' + (r0.slot === 'armor' ? 'defence' : 'attack') + ', but no one sees it)';
      else if (r0.kind === 'hidden') act = '<b>Enter</b>: take it out and ' + (r0.item.slot === 'armor' ? 'wear' : 'wield') + ' it';
      else act = '<b>Enter</b>: ' + (r0.item.slot === 'clothes' ? 'change into it' : r0.item.slot === 'armor' ? 'wear it' : 'wield it') + ' · <b>X</b>: drop it';
    }
    h += '<div class="inv-help">' + act + '<br><span class="muted">↑ ↓ choose · U conceal everything out of its time · I or Esc close</span></div>';
    return { html: h, sel: sel, rows: rows };
  }
  /** Act on row i: 'use' (wield, wear, stow, take out) or 'drop'. Returns a message or ''. */
  function invAction(i, action) {
    var p = G().player, r = invRows()[i];
    if (!r) return '';
    var it = r.item;
    if (action === 'drop') {
      if (r.kind !== 'pack') return '';
      p.pack.splice(p.pack.indexOf(it), 1);
      R().spawnPickup('gear', p.x + 0.6, p.y + 0.4, { item: it, prov: R().provOf(p.x, p.y) });
      return 'You drop the ' + it.name.toLowerCase() + '.';
    }
    if (r.kind === 'eq') {
      if (it.none || r.slot === 'clothes') return '';
      p.eq[r.slot] = empty(r.slot); p.pack.push(it);
      return 'You stow the ' + it.name.toLowerCase() + '.';
    }
    var from = r.kind === 'hidden' ? p.concealed : p.pack, old = p.eq[it.slot];
    from.splice(from.indexOf(it), 1);
    p.eq[it.slot] = it;
    if (old && !old.none) p.pack.push(old);
    if (it.slot === 'ranged' && !(p.ammo[it.ammo] >= 0)) p.ammo[it.ammo] = p.ammo[it.ammo] || 0;
    return (it.slot === 'clothes' ? 'You change into the ' : it.slot === 'armor' ? 'You put on the ' : 'You take up the ') + it.name.toLowerCase() + '.';
  }

  /** Elites and rulers drop the gear of their own age. */
  function dropFor(a, ageHint) {
    var slots = ['melee', 'ranged', 'armor', 'clothes'], slot = slots[(Math.random() * 4) | 0];
    var it = slot === 'clothes' ? item('clothes', ageHint, a.faction || 0) : item(slot, ageHint);
    R().spawnPickup('gear', a.x, a.y + 0.3, { item: it, prov: a.prov });
  }
  function pickUp(pk) {
    var p = G().player;
    if (p.pack.length >= 10) { R().toast('Your pack is full.'); return false; }
    p.pack.push(pk.item);
    R().toast('You take the ' + esc(pk.item.name.toLowerCase()) + ' (' + AGE_NAMES[pk.item.age] + '). Press I to wield it.');
    return true;
  }

  root.Gear = {
    AGE_NAMES: AGE_NAMES, AMMO: AMMO, SUSPECT: SUSPECT, HUNT: HUNT, item: item, starter: starter, ammoOf: ammoOf, useAmmo: useAmmo,
    localAge: localAge, anachronism: anachronism, outOfTime: outOfTime, toggleConceal: toggleConceal, empty: empty, update: update, onShot: onShot, suspicionLabel: suspicionLabel, suspected: suspected,
    restock: restock, lower: lower, smithTalk: smithTalk, renderInventory: renderInventory, invAction: invAction, dress: dress, dressInfo: dressInfo, refuses: refuses, dropFor: dropFor, pickUp: pickUp, price: price
  };
}(this));
