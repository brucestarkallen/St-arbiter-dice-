// v0.25.0 AUDIT SUITE 4/4 — END-TO-END production path through the real interceptor.
// Every flow a user actually hits: no-check silence, single checks, duel start/
// exchange/finish, swipe-stability (fate never re-rolls), edit-rewind (no double
// apply), re-seed after a fight, combat_ended, battle + war start, fast mode with
// zero LLM calls — and a hard guarantee that NO injected directive ever leaks a
// mechanical number (delta/probability/dice) to the storyteller.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let respObj = '{}'; let injections = {};
let settings = { arbiter: { enabled:true, timeoutMs:1600, toastResults:false, showMath:false, eventEngine:false, profileId:'p1', autoDuel:true, autoBattle:true, autoWar:true, autoSeed:false, mode:'adjudicated', preset:'realistic', tieBand:0, duelPoise:5, defaultRating:5, ctxMsgs:6, composure:true, composureMax:6, injectDepth:1, injectRole:'system' } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(key, text){ injections[key] = text; }, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log((c?'  OK  ':' FAIL ') + n); if (!c) fails++; };
const mainInj = () => { const k = Object.keys(injections).find(k => !k.endsWith('_EVENT') && injections[k]); return k ? injections[k] : ''; };
// A directive must never leak the machinery to the storyteller.
const LEAK = /(Δ|\bdelta\b|P\s*=|u\s*=|\bprobability\b|%|\brolled?\b|\bdice\b|\bd\d{2,3}\b)/i;
const allInjTexts = [];
const capture = () => { const t = mainInj(); if (t) allInjTexts.push(t); return t; };
const send = async (mes, sd, type='normal', force=true) => { injections = {}; md.arbiter.oneShot = force ? 'force' : null; await I([{ is_user:true, mes, send_date:sd }], 0, ()=>{}, type); return capture(); };
const freshMeta = (extra={}) => { md.arbiter = Object.assign({ sheet:{actors:{'Jovan':{default:7,domains:{melee:7}}}}, log:[], oneShot:null, cache:null }, extra); };

(async () => {
  // A) Plain narrative, no check.
  freshMeta();
  respObj = JSON.stringify({ check:false });
  let inj = await send('I gaze at the sunset and think', 'a1');
  ok('check:false → no injection', inj === '');
  ok('check:false → no duel created', !md.arbiter.duel);

  // B) Single action check → qualitative directive, no leak.
  freshMeta();
  respObj = JSON.stringify({ check:true, action:'leap the chasm', domain:'athletics', actor:'Jovan', opposition_kind:'tier', opposition:'hard', circumstance:0, why:'wide gap', stakes:'a fall' });
  inj = await send('I leap across the chasm', 'b1');
  ok('single check → directive injected', inj.includes('[ARBITER'));
  ok('single check → carries a named outcome tier', /(DECISIVE|SUCCESS|SETBACK|FAILURE|DISASTER)/.test(inj));
  ok('single check → instructs storyteller not to reveal the note', /Never mention/i.test(inj));
  ok('single check → NO mechanical leak', !LEAK.test(inj));

  // C) Duel start.
  freshMeta();
  respObj = JSON.stringify({ check:true, action:'draw and strike the ogre', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Ogre', circumstance:0, duel_start:'Ogre', opponent_rating:6 });
  inj = await send('I draw my blade and attack the ogre', 'c1');
  ok('duel_start → duel state created', !!md.arbiter.duel && md.arbiter.duel.active);
  ok('duel_start → opponent seeded with poise + composure', md.arbiter.duel.opp.poise > 0 && typeof md.arbiter.duel.opp.composure === 'number');
  ok('duel_start → round-1 directive injected', inj.includes('duel') && !LEAK.test(inj));

  // D) Duel exchanges advance state.
  let r0 = md.arbiter.duel.round;
  respObj = JSON.stringify({ exchange:true, move_kind:'attack', target:'Ogre', action:'a fierce cut', circumstance:0, why:'x', opp_composure:-1, self_composure:0 });
  inj = await send('I press the attack fiercely', 'd1');
  ok('exchange → duel round advanced', md.arbiter.duel && md.arbiter.duel.round === r0 + 1);
  ok('exchange → opponent nerve tracked (composure fell)', md.arbiter.duel.opp.composure < 6);
  ok('exchange → directive qualitative, no leak', inj.includes('[ARBITER') && !LEAK.test(inj));
  const rAfterD = md.arbiter.duel.round;

  // E) SWIPE the same message → fate must NOT re-roll or advance.
  injections = {}; md.arbiter.oneShot = null;
  await I([{ is_user:true, mes:'I press the attack fiercely', send_date:'d1' }], 0, ()=>{}, 'swipe');
  ok('swipe (same message) → round does NOT advance (fate is stable)', md.arbiter.duel.round === rAfterD);
  ok('swipe → the committed directive is replayed', mainInj().includes('[ARBITER'));

  // F) EDIT the message (same send_date, new text) → rewind pre-turn + fresh roll (no double-apply).
  const poiseBeforeEdit = md.arbiter.duel.opp.poise;
  injections = {}; md.arbiter.oneShot = null;
  respObj = JSON.stringify({ exchange:true, move_kind:'attack', target:'Ogre', action:'a different strike', circumstance:0, why:'x' });
  await I([{ is_user:true, mes:'I try a different strike instead', send_date:'d1' }], 0, ()=>{}, 'swipe');
  ok('edit (same send_date, new action) → round stays put (rewound, not stacked)', md.arbiter.duel.round === rAfterD);
  ok('edit → still produces a fresh directive', mainInj().includes('[ARBITER'));

  // G) Fight to the finish, then a NEW message clears it and flags a re-seed.
  freshMeta({ duel: { active:true, over:false, victor:null, round:1, domain:'melee',
    player:{name:'Jovan',rating:9,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false},
    opp:{name:'Mook',rating:2,poise:1,maxPoise:1,injuries:0,momentum:0,opening:false,composure:6,composureMax:6} } });
  respObj = JSON.stringify({ exchange:true, move_kind:'attack', target:'Mook', action:'finish it', circumstance:3, why:'overwhelming' });
  let guard=0; while (md.arbiter.duel && !md.arbiter.duel.over && guard++ < 20) { inj = await send('I finish the mook', 'g'+guard); }
  ok('a lopsided fight ends within a few exchanges', md.arbiter.duel && md.arbiter.duel.over);
  ok('finishing directive declares a beaten combatant', /beaten|won this duel|finish/i.test(inj) && !LEAK.test(inj));
  respObj = JSON.stringify({ check:false });
  await send('I catch my breath afterward', 'g-after');
  ok('next message clears the concluded duel', !md.arbiter.duel);
  ok('a concluded fight flags a re-seed', md.arbiter.seedDueAfterFight === true);

  // H) combat_ended clears an active duel.
  freshMeta({ duel: { active:true, over:false, victor:null, round:2, domain:'melee',
    player:{name:'Jovan',rating:7,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false},
    opp:{name:'Rival',rating:7,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false,composure:6,composureMax:6} } });
  respObj = JSON.stringify({ combat_ended:true });
  await send('We both lower our weapons and step back', 'h1');
  ok('combat_ended → duel cleared', !md.arbiter.duel);

  // I) Battle start.
  freshMeta();
  respObj = JSON.stringify({ check:true, action:'charge the guards', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Guards', circumstance:0, battle_start:{ allies:['Ksenia'], enemies:['Guard x3'] } });
  inj = await send('I charge into the three guards', 'i1');
  ok('battle_start → battle created', !!md.arbiter.battle && md.arbiter.battle.active);
  ok('battle directive qualitative, no leak', inj.includes('[ARBITER') && !LEAK.test(inj));

  // J) War start.
  freshMeta();
  respObj = JSON.stringify({ check:true, action:'order the flank to envelop', domain:'tactics', actor:'Jovan', opposition_kind:'actor', opposition:'Legion', circumstance:0, war_start:{ allies:['Left Flank','3rd Cavalry'], enemies:['Iron Legion'], enemy_commander:'Warlord' } });
  inj = await send('I command my forces to envelop their flank', 'j1');
  ok('war_start → war created', !!md.arbiter.battle && md.arbiter.battle.kind === 'war');
  ok('war directive qualitative, no leak', inj.includes('[ARBITER') && !LEAK.test(inj));

  // K) FAST MODE: a duel exchange with zero LLM calls.
  settings.arbiter.mode = 'fast';
  let llmCalls = 0; ctxObj.ConnectionManagerRequestService.sendRequest = async () => { llmCalls++; return '{}'; };
  freshMeta({ duel: { active:true, over:false, victor:null, round:1, domain:'melee',
    player:{name:'Jovan',rating:7,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false},
    opp:{name:'Bandit',rating:5,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false,composure:6,composureMax:6} } });
  inj = await send('I swing hard at the bandit', 'k1');
  ok('fast mode → resolves with ZERO LLM calls', llmCalls === 0);
  ok('fast mode duel → directive injected, no leak', inj.includes('[ARBITER') && !LEAK.test(inj));
  settings.arbiter.mode = 'adjudicated';

  // L) GLOBAL leak scan across every directive captured this run.
  const anyLeak = allInjTexts.filter(t => LEAK.test(t));
  ok('GLOBAL: no captured directive leaks mechanical numbers (' + allInjTexts.length + ' scanned)', anyLeak.length === 0);
  if (anyLeak.length) anyLeak.slice(0,3).forEach(t => console.log('   LEAK >>', t.slice(0,160)));

  console.log(fails === 0 ? '\nALL INTEGRATION CHECKS PASSED' : '\n' + fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
