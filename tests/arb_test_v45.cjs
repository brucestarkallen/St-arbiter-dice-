// v0.26.0 — opponent-identity fool-proofing. The player is never the foe, and no
// PART of the player's name may become the opponent — but this must NOT over-fire:
// a distinct foe that merely shares a surname (a sibling) or contains the player's
// short name as letters (Ana/Anakin) stays a valid foe. When the referee mislabels
// the foe, the real name is RECOVERED from its other fields before the duel is
// dropped. Unseeded foes must still open a duel with an estimated rating.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let NAME1 = 'Jovan';
global.SillyTavern = { getContext: () => ({ name1: NAME1, extensionSettings: { arbiter: { defaultRating: 5, duelPoise: 5, composureMax: 6 } }, chatMetadata: { sheet: { actors: {} } }, setExtensionPrompt(){}, eventSource: { on(){} }, event_types: {} }) };
require(require('path').join(__dirname, '..', 'index.js'));
const E = globalThis.ArbiterEngine;
let fails = 0; const ok = (n, c) => { console.log((c ? '  OK  ' : ' FAIL ') + n); if (!c) fails++; };
const N = (o) => E.normalizeAdj(o);
const duel = (over) => ({ check: true, action: 'strike', domain: 'melee', opposition_kind: 'actor', opponent_rating: 5, ...over });

// ── THE BUG: referee splits the player's full name, hands back the surname ──
NAME1 = 'Jovan';
let a = N(duel({ actor: 'Jovan Wessex', opposition: 'Wessex', duel_start: 'Wessex' }));
ok("persona 'Jovan': foe 'Wessex' (from split full name) is NOT accepted", a.duel_start !== 'Wessex' && a.opposition !== 'Wessex');
ok("   ...and with no other name available, the duel drops to a plain check", a.duel_start === null);

// ── RECOVERY: mislabeled duel_start but the real foe is in the opposition field ──
a = N(duel({ actor: 'Jovan Wessex', opposition: 'Piers', duel_start: 'Wessex' }));
ok("recovers real foe 'Piers' from the opposition field when duel_start is bad", a.duel_start === 'Piers');
// ── RECOVERY: inversion — real foe sits in the actor slot ──
a = N(duel({ actor: 'Piers Halloway', opposition: 'moderate', opposition_kind: 'tier', duel_start: 'Jovan' }));
ok("recovers real foe 'Piers Halloway' from the actor slot on an inversion", a.duel_start === 'Piers Halloway');

// ── MUST NOT OVER-FIRE (the fool-proof part) ──
NAME1 = 'Ana';
a = N(duel({ actor: 'Ana', opposition: 'Anakin', duel_start: 'Anakin' }));
ok("persona 'Ana': distinct foe 'Anakin' is NOT mistaken for the player", a.duel_start === 'Anakin');

NAME1 = 'Jovan Wessex';
a = N(duel({ actor: 'Jovan Wessex', opposition: 'Claire Wessex', duel_start: 'Claire Wessex' }));
ok("persona 'Jovan Wessex': sibling 'Claire Wessex' (shares surname) IS a valid foe", a.duel_start === 'Claire Wessex');
a = N(duel({ actor: 'Jovan Wessex', opposition: 'Wessex', duel_start: 'Wessex' }));
ok("persona 'Jovan Wessex': bare 'Wessex' (own surname) is still caught", a.duel_start === null);

// ── Ordinary legit foes, seeded or not ──
NAME1 = 'Jovan';
ok("distinct single-word foe 'Eugeo' kept", N(duel({ actor: 'Jovan', opposition: 'Eugeo', duel_start: 'Eugeo' })).duel_start === 'Eugeo');
ok("distinct multi-word foe 'Piers Halloway' kept", N(duel({ actor: 'Jovan', opposition: 'Piers Halloway', duel_start: 'Piers Halloway' })).duel_start === 'Piers Halloway');
ok("a real foe whose name merely contains 'Jo' as letters ('Jonas') kept", N(duel({ actor: 'Jovan', opposition: 'Jonas', duel_start: 'Jonas' })).duel_start === 'Jonas');

// ── Recovery never yields a difficulty word as a 'name' ──
a = N(duel({ actor: 'Jovan', opposition: 'hard', opposition_kind: 'tier', duel_start: 'Jovan' }));
ok("bad duel_start with only a tier word available drops (never names foe 'hard')", a.duel_start === null);

// ── Battle rosters: the player is stripped from the enemy list ──
NAME1 = 'Jovan';
let b = N({ check: true, action: 'charge', domain: 'melee', actor: 'Jovan', opposition_kind: 'actor', opposition: 'Guards', battle_start: { allies: ['Ksenia'], enemies: ['Jovan', 'Guard x3'] } });
ok("battle enemies: the player is filtered out of the enemy list", b.battle_start && !b.battle_start.enemies.some(e => /jovan/i.test(e)) && b.battle_start.enemies.length === 1);
b = N({ check: true, action: 'charge', domain: 'melee', actor: 'Jovan Wessex', opposition_kind: 'actor', opposition: 'x', battle_start: { allies: [], enemies: ['Wessex'] } });
ok("battle with only the player's own surname as the enemy drops the battle", b.battle_start === null);

// ── UNSEEDED foe still opens a real duel with an ESTIMATED rating ──
const meta = { sheet: { actors: {} } }; // Piers is NOT on the sheet
E.startDuel(meta, 'Jovan', 'Piers', 'melee', 7, 0);
ok("unseeded foe 'Piers' opens a duel labelled correctly", meta.duel && meta.duel.opp.name === 'Piers' && meta.duel.active);
ok("unseeded foe uses the referee's estimated rating (7), flagged estimated", meta.duel.opp.rating === 7 && meta.duel.opp.estimated === true);
ok("unseeded foe gets a full poise + composure pool", meta.duel.opp.poise > 0 && meta.duel.opp.composure > 0);

console.log(fails === 0 ? '\nALL v45 FOOL-PROOFING TESTS PASSED' : '\n' + fails + ' FAILURES'); process.exit(fails ? 1 : 0);
