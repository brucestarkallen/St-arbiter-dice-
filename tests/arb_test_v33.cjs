// v0.16.0: per-unit composure in battles/wars. Previously composure applied
// ONLY in duels; battle/war units (and even the player) had no nerve at all.
// Now every unit carries a composure pool, it feeds every battle/war delta, a
// controlled/losing round mechanically steadies/rattles nerve (morale shock,
// distinct from headcount morale), and the player's nerve recovers slowly on
// calm turns. This suite proves the maths and the mechanics.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };

let md = {};
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false,
  profileId: 'MAIN', autoDuel: false, autoBattle: false, autoWar: false, autoSeed: false,
  mode: 'fast', preset: 'realistic', tieBand: 0, duelPoise: 5, warStrength: 10, defaultRating: 5,
  ctxMsgs: 6, composure: true, composureMax: 6 } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan', name2: 'Narrator',
  ConnectionManagerRequestService: { sendRequest: async () => '{}' },
  setExtensionPrompt(){}, extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 },
  eventSource: { on: () => {} }, event_types: {} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
const E = globalThis.ArbiterEngine;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
const isWin = (tier) => tier === 'DECISIVE' || tier === 'SUCCESS' || tier === 'SUCCESS_COST';

// A fresh single-enemy battle so the MC's exchange is deterministic to isolate,
// with high poise so one round never ends it. playerComp / targetComp set nerve.
const freshBattle = (playerComp, targetComp) => { md.arbiter = { sheet: { actors: {} }, log: [], oneShot: null, cache: null, composure: playerComp,
  battle: { active: true, over: false, victor: null, mcDown: false, round: 1, domain: 'melee', scaleMismatch: 0,
    allies: [{ name: 'Jovan', rating: 5, poise: 20, maxPoise: 20, injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: true }],
    enemies: [{ name: 'Brute', rating: 5, poise: 20, maxPoise: 20, injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: false, composure: targetComp, composureMax: 6 }] } }; };

let seq = 0;
const battleWinRate = async (playerComp, targetComp, N) => { let w = 0; for (let i = 0; i < N; i++) { freshBattle(playerComp, targetComp); seq++; await I([{ is_user: true, name: 'Jovan', mes: 'I strike the Brute.', send_date: 'b' + seq }], 0, () => {}, 'normal'); if (md.arbiter.log[0] && isWin(md.arbiter.log[0].tier)) w++; } return w / N; };

(async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');

  // ── A. combatantComposurePenalty is unit-generic ──
  ok('full pool → no penalty', E.combatantComposurePenalty({ composure: 6, composureMax: 6 }) === 0);
  ok('half pool → no penalty (mild strain harmless)', E.combatantComposurePenalty({ composure: 3, composureMax: 6 }) === 0);
  ok('below half → penalty', E.combatantComposurePenalty({ composure: 1, composureMax: 6 }) < 0);
  ok('shattered → -3', E.combatantComposurePenalty({ composure: 0, composureMax: 6 }) === -3);
  ok('no pool → 0 (mindless construct)', E.combatantComposurePenalty({}) === 0);

  // ── B. Units are created WITH composure pools (source) ──
  ok('battle units get a composure pool', /isPlayer: false, composure: cMax, composureMax: cMax \}\)/.test(src));
  ok('war formations get a composure pool', /poise: strength[\s\S]{0,140}composure: cMax, composureMax: cMax \}\)/.test(src));

  // ── C. Target composure feeds the battle delta (a rattled foe is easier) ──
  const N = 400;
  const vsSteady = await battleWinRate(6, 6, N);   // Δ≈0 → ~0.5
  const vsBroken = await battleWinRate(6, 0, N);   // target -3 → Δ≈+3 → ~0.76
  console.log('  vs steady foe:', vsSteady.toFixed(3), '| vs shattered foe:', vsBroken.toFixed(3));
  ok('a shattered enemy is markedly easier to beat in battle', vsBroken - vsSteady > 0.15);
  ok('a shattered enemy win rate reflects the +3 edge (~0.85)', vsBroken > 0.78);

  // ── D. The player's OWN strain penalizes their battle attack ──
  const rattledPlayer = await battleWinRate(0, 6, N); // player -3 → Δ≈-3 → ~0.24
  console.log('  rattled player win rate:', rattledPlayer.toFixed(3));
  ok('a rattled player fights worse in battle', vsSteady - rattledPlayer > 0.15);

  // ── E. Morale shock: watching comrades fall rattles survivors; a clean
  //    winning round steadies. (Pure mechanical, no LLM.) ──
  const mkUnit = (name, comp) => ({ name, rating: 5, poise: 10, maxPoise: 10, injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: false, composure: comp, composureMax: 6 });
  // Enemy side takes 2 breaks this round → surviving enemies lose 2 composure.
  let b = { allies: [{ name: 'Jovan', isPlayer: true, standing: true }, mkUnit('AllyA', 4), mkUnit('AllyB', 4)],
            enemies: [mkUnit('EnemyA', 5), mkUnit('EnemyB', 5), mkUnit('EnemyC', 5)] };
  let meta = { composure: 6 };
  E.applyMoraleShock(meta, b, 0, 2); // allyBreaks 0, enemyBreaks 2
  ok('surviving enemies rattled by watching 2 comrades fall', b.enemies.every(u => u.composure === 3));
  ok('allies without the numerical edge do NOT spuriously steady', b.allies.filter(u => !u.isPlayer).every(u => u.composure === 4));
  // A clean round (no breaks) for the side that holds the numerical edge steadies it.
  let b3 = { allies: [{ name: 'Jovan', isPlayer: true, standing: true }, mkUnit('AllyA', 4), mkUnit('AllyB', 4), mkUnit('AllyC', 4)],
             enemies: [mkUnit('EnemyA', 4), mkUnit('EnemyB', 4)] };
  E.applyMoraleShock({ composure: 6 }, b3, 0, 0);
  ok('a clean winning-position round steadies the allies', b3.allies.filter(u => !u.isPlayer).every(u => u.composure === 5));
  ok('the outnumbered enemies do not steady on that round', b3.enemies.every(u => u.composure === 4));
  // The commander's own nerve frays when their line buckles.
  let b2 = { allies: [{ name: 'Jovan', isPlayer: true, standing: true }, mkUnit('AllyA', 4)],
             enemies: [mkUnit('EnemyA', 5)] };
  let meta2 = { composure: 6 };
  E.applyMoraleShock(meta2, b2, 2, 0); // 2 ally formations fell
  ok('the commander is rattled when their formations fall', meta2.composure < 6);
  // Shock never breaks a unit (composure is mental, not lethal).
  ok('morale shock leaves units standing (nerve ≠ death)', b.enemies.every(u => u.standing) && b2.allies.every(u => u.standing));

  // ── F. War deltas include composure (source: stratagem, personal, maneuver) ──
  ok('war stratagem delta includes commander composure', /b\.cmdA - b\.cmdE \+ mv\.circumstance \+ mAll \+ preset\.bonus \+ composurePenalty\(meta\)/.test(src));
  ok('war personal-sortie delta includes commander + target composure', /personal[\s\S]{0,400}composurePenalty\(meta\) - combatantComposurePenalty\(target\)/.test(src));
  ok('war maneuver delta includes formation + target composure', /cmdEdge\)[\s\S]{0,220}combatantComposurePenalty\(acting\) - combatantComposurePenalty\(target\)/.test(src));

  // ── G. Passive between-scenes recovery of the player's nerve ──
  let m = { composure: 2 }; E.passiveComposureRecovery(m); ok('quiet turn nudges nerve up (2 → 2.5)', m.composure === 2.5);
  let mFull = { composure: 6 }; E.passiveComposureRecovery(mFull); ok('nerve does not exceed max', mFull.composure === 6);

  console.log(fails === 0 ? 'ALL V33 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
