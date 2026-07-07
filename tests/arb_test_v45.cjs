// v0.26.0 — opponent naming: the player is never the foe, and no PART of the
// player's name (given name OR surname) may become the opponent. Guards the
// "Jovan Wessex -> opponent Wessex" name-split misparse while keeping legitimate
// opponents (single- and multi-word) and genuine actor/opponent inversions.
global.$=()=>({length:0,append(){return this},on(){return this},val(){return""},prop(){return this},html(){return this},empty(){return this},find(){return this}});
global.window=global; global.document={getElementById:()=>null}; global.toastr={info(){},warning(){},error(){},success(){}};
let NAME1='Jovan';
global.SillyTavern={getContext:()=>({name1:NAME1,extensionSettings:{arbiter:{defaultRating:5}},chatMetadata:{sheet:{actors:{}}},setExtensionPrompt(){},eventSource:{on(){}},event_types:{}})};
const E=require(require('path').join(__dirname, '..', 'index.js'))&&globalThis.ArbiterEngine;
let fails=0; const ok=(n,c)=>{console.log((c?'  OK  ':' FAIL ')+n); if(!c)fails++;};

// THE REPORTED BUG: persona 'Jovan', referee splits full name and returns surname as opponent.
NAME1='Jovan';
let a=E.normalizeAdj({check:true,action:'strike',domain:'melee',actor:'Jovan Wessex',opposition_kind:'actor',opposition:'Wessex',duel_start:'Wessex',opponent_rating:5});
ok("persona 'Jovan' + actor 'Jovan Wessex' + duel_start 'Wessex' -> opponent NOT 'Wessex'", a.duel_start !== 'Wessex');
ok("   ...and the bogus surname duel is dropped (falls back to a plain check)", a.duel_start === null);
ok("   ...opposition 'Wessex' is also not accepted as the foe", a.opposition !== 'Wessex');

// Persona already full name -> existing guard catches surname.
NAME1='Jovan Wessex';
a=E.normalizeAdj({check:true,action:'strike',domain:'melee',actor:'Jovan Wessex',opposition_kind:'actor',opposition:'moderate',duel_start:'Wessex',opponent_rating:5});
ok("persona 'Jovan Wessex' + duel_start 'Wessex' -> dropped", a.duel_start === null);

// LEGIT opponent must still work (not over-blocked).
NAME1='Jovan';
a=E.normalizeAdj({check:true,action:'strike',domain:'melee',actor:'Jovan',opposition_kind:'actor',opposition:'Piers',duel_start:'Piers',opponent_rating:5});
ok("legit foe 'Piers' with distinct name -> kept", a.duel_start === 'Piers');

// LEGIT multi-word opponent kept.
a=E.normalizeAdj({check:true,action:'strike',domain:'melee',actor:'Jovan',opposition_kind:'actor',opposition:'Piers Halloway',duel_start:'Piers Halloway',opponent_rating:5});
ok("legit multi-word foe 'Piers Halloway' -> kept", a.duel_start === 'Piers Halloway');

// REAL inversion (player named as foe) still recovers the true opponent from actor slot, even multi-word.
a=E.normalizeAdj({check:true,action:'strike',domain:'melee',actor:'Piers Halloway',opposition_kind:'actor',opposition:'moderate',duel_start:'Jovan',opponent_rating:5});
ok("inverted: duel_start 'Jovan' (player) recovers real foe 'Piers Halloway' from actor", a.duel_start === 'Piers Halloway');

// A foe whose name is unrelated to the player, with a multi-word player actor claim, must NOT be dropped.
a=E.normalizeAdj({check:true,action:'strike',domain:'melee',actor:'Jovan',opposition_kind:'actor',opposition:'Eugeo',duel_start:'Eugeo',opponent_rating:5});
ok("unrelated foe 'Eugeo' -> kept", a.duel_start === 'Eugeo');

console.log(fails===0?'\nALL NAME-REPAIR TESTS PASSED':'\n'+fails+' FAILURES'); process.exit(fails?1:0);
