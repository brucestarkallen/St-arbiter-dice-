// v0.28 — FAIRNESS / anti-sycophancy simulation for mass combat. The prime directive
// is that the player must be able to GENUINELY LOSE. Locks in the war stratagem-
// condition symmetry fix: an evenly-matched war/battle must be losable (not a
// guaranteed player win), and skill + force balance must move the outcome.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
global.SillyTavern = { getContext: () => ({ name1: 'Player', extensionSettings: { arbiter: { composure:true, composureMax:6, preset:'realistic', tieBand:0.06, defaultRating:5, duelPoise:5, warStrength:10 } }, chatMetadata: {}, setExtensionPrompt(){}, eventSource: { on(){} }, event_types: {} }) };
require(require('path').join(__dirname, '..', 'index.js'));
const E = globalThis.ArbiterEngine;
let fails = 0; const ok = (n, c) => { console.log((c ? '  OK  ' : ' FAIL ') + n); if (!c) fails++; };

function eqSheet(nA, nE) { const s = { actors: {} }; for (let i=0;i<nA;i++) s.actors['DA'+i]={default:5,domains:{war:5,melee:5}}; for (let i=0;i<nE;i++) s.actors['DE'+i]={default:5,domains:{war:5,melee:5}}; s.actors['Player']={default:5,domains:{melee:5,tactics:5}}; s.actors['Warlord']={default:5,domains:{tactics:5}}; return s; }
function war(nA, nE, circ) { const meta={sheet:eqSheet(nA,nE)}; if(!E.startWar(meta,Array.from({length:nA},(_,i)=>'DA'+i),Array.from({length:nE},(_,i)=>'DE'+i),'Warlord',0)||!meta.battle) return 'x'; let r=0; while(!meta.battle.over&&r<400){const k=r%3;const mv=k===0?{kind:'stratagem',action:'x',circumstance:circ}:k===1?{kind:'personal',target:'DE'+Math.floor(Math.random()*nE),circumstance:circ}:{kind:'formation',acting:'DA'+Math.floor(Math.random()*nA),target:'DE'+Math.floor(Math.random()*nE),circumstance:circ};E.resolveWarRound(meta,mv);r++;} return meta.battle.over?meta.battle.victor:'stall'; }
function battle(nA, nE, circ) { const s={actors:{}}; for(let i=0;i<nA;i++)s.actors['A'+i]={default:5,domains:{melee:5}}; for(let i=0;i<nE;i++)s.actors['E'+i]={default:5,domains:{melee:5}}; s.actors['Player']={default:5,domains:{melee:5}}; const meta={sheet:s}; if(!E.startBattle(meta,Array.from({length:nA},(_,i)=>'A'+i),Array.from({length:nE},(_,i)=>'E'+i),'melee',0)) return 'x'; let r=0; while(!meta.battle.over&&r<400){const mv=(r%2===0)?{kind:'command',circumstance:circ}:{kind:'attack',target:'E'+Math.floor(Math.random()*nE),circumstance:circ};E.resolveBattleRound(meta,mv);r++;} return meta.battle.over?meta.battle.victor:'stall'; }
function winRate(fn, N) { let a=0; for(let i=0;i<N;i++) if(fn()==='allies') a++; return a/N; }

const N = 400;
// Balanced total forces (MC + 2 vs 3), neutral play.
const warEqual = winRate(()=>war(2,3,0), N);
const batEqual = winRate(()=>battle(2,3,0), N);
console.log('  [war equal/neutral ally win% = ' + (warEqual*100).toFixed(1) + ', battle = ' + (batEqual*100).toFixed(1) + ']');

ok('an evenly-matched WAR is LOSABLE (allies do not always win)', warEqual < 0.75);
ok('an evenly-matched WAR is WINNABLE (not rigged against the player either)', warEqual > 0.08);
ok('an evenly-matched BATTLE is LOSABLE', batEqual < 0.80);
ok('an evenly-matched BATTLE is WINNABLE', batEqual > 0.08);

// Skill must move the needle.
const warGood = winRate(()=>war(2,3,2), N);
const warBad = winRate(()=>war(2,3,-2), N);
ok('skilled command wins far more than blundering (war +2 >> war -2)', warGood - warBad > 0.30);

// Force balance must move the needle.
const warOutnumber = winRate(()=>war(3,2,0), N); // MC+3 vs 2
const warOutmatched = winRate(()=>war(1,4,0), N); // MC+1 vs 4
ok('numerical superiority helps (outnumber > outmatched)', warOutnumber - warOutmatched > 0.30);

// Stratagem conditions must net to zero on a balanced record (the actual fix).
const w = E.STRATAGEM_EFFECTS.DECISIVE.condMod + E.STRATAGEM_EFFECTS.SUCCESS.condMod + E.STRATAGEM_EFFECTS.SUCCESS_COST.condMod;
const l = E.STRATAGEM_EFFECTS.DISASTER.condMod + E.STRATAGEM_EFFECTS.FAILURE.condMod + E.STRATAGEM_EFFECTS.SETBACK.condMod;
ok('stratagem battlefield conditions are symmetric (win total == loss total)', w === l && w > 0);

console.log(fails === 0 ? '\nALL v47 FAIRNESS TESTS PASSED' : '\n' + fails + ' FAILURES'); process.exit(fails ? 1 : 0);
