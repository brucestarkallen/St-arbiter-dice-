// v0.11.0: exchange ties (TRADE/STALEMATE) + tie plumbing.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let settings = { arbiter: { enabled: true, tieBand: 0.06 } };
global.SillyTavern = { getContext: () => ({ extensionSettings: settings, chatMetadata: {}, name1: 'X', setExtensionPrompt(){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} }) };
const E = require(require('path').join(__dirname, '..', 'index.js')) && globalThis.ArbiterEngine;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };

// TRADE: both lose poise, no injuries, winner none
const a1 = { poise: 5, injuries: 0, momentum: 0, opening: false };
const b1 = { poise: 5, injuries: 0, momentum: 0, opening: false };
const trade = E.applyExchangeEffects(a1, b1, 'TRADE');
ok('TRADE damages BOTH sides', trade.player.poise === 4 && trade.opp.poise === 4);
ok('TRADE has no victor mid-fight', !trade.over);
ok('TRADE zeroes both momenta', trade.player.momentum === 0 && trade.opp.momentum === 0);

// STALEMATE: neither loses
const stale = E.applyExchangeEffects({poise:5,injuries:0,momentum:0.5,opening:false}, {poise:5,injuries:0,momentum:0.5,opening:false}, 'STALEMATE');
ok('STALEMATE spares both sides', stale.player.poise === 5 && stale.opp.poise === 5);
ok('STALEMATE preserves standing momentum', stale.player.momentum === 0.5 && stale.opp.momentum === 0.5);

// tieCheck remaps an even roll, leaves lopsided ones alone, never ties extremes
ok('near-even roll becomes a tie', ['TRADE','STALEMATE'].includes(E.tieCheck ? E.tieCheck('SUCCESS', 0.50, 0.51, 0.06) : 'x') || !E.tieCheck);
// tieCheck isn't exported; validate the band behavior through sliceOutcome+manual reimpl if needed.
if (E.tieCheck) {
  ok('lopsided roll is NOT tied', E.tieCheck('SUCCESS', 0.95, 0.40, 0.06) === 'SUCCESS');
  ok('DECISIVE never becomes a tie', E.tieCheck('DECISIVE', 0.50, 0.50, 0.06) === 'DECISIVE');
  ok('band 0 disables ties', E.tieCheck('SUCCESS', 0.50, 0.50, 0) === 'SUCCESS');
  ok('very close = TRADE, near = STALEMATE', E.tieCheck('SUCCESS', 0.50, 0.51, 0.06) === 'TRADE' && E.tieCheck('SUCCESS', 0.50, 0.545, 0.06) === 'STALEMATE');
} else {
  console.log('(tieCheck not exported — exporting for coverage)');
  fails++;
}

// double-KO on a TRADE yields a draw
const ko = E.applyExchangeEffects({poise:1,injuries:0,momentum:0,opening:false}, {poise:1,injuries:0,momentum:0,opening:false}, 'TRADE');
ok('mutual knockout on a trade = draw', ko.over && ko.victor === 'draw');

console.log(fails === 0 ? 'ALL V20 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
