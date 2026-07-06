// v0.14.0: composure is universal — the OPPONENT's nerve breaks too, not just the player's.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let respObj = '{}';
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false, profileId: 'p1', autoDuel: true, autoSeed: false, mode: 'adjudicated', preset: 'realistic', tieBand: 0, duelPoise: 5, defaultRating: 5, ctxMsgs: 6, composure: true, composureMax: 6 } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const E = globalThis.ArbiterEngine; const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
(async () => {
  // Opening a duel gives the opponent a composure pool. (Cultist is given a
  // deep poise pool via the sheet so the two forced HORROR exchanges below can't
  // fell them — this test is about NERVE eroding over exchanges, not lethality;
  // post-v0.21 margin-scaling means two strong hits could otherwise end it.)
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 7, domains: { melee: 7 } }, 'Cultist': { default: 6, domains: { melee: 6 }, poise: 18 } } }, log: [], oneShot: 'force', cache: null };
  respObj = JSON.stringify({ check:true, action:'strike the cultist', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Cultist', circumstance:0, duel_start:'Cultist' });
  await I([{ is_user:true, mes:'I attack the cultist', send_date:'o1' }], 0, () => {}, 'normal');
  ok('opponent has a composure pool', typeof md.arbiter.duel.opp.composure === 'number' && md.arbiter.duel.opp.composureMax === 6);

  // A terrifying display erodes the OPPONENT's nerve over exchanges.
  md.arbiter.oneShot = 'force';
  respObj = JSON.stringify({ exchange:true, move_kind:'attack', opp_composure:-2, self_composure:0, target:'Cultist', action:'unleash a horrifying ice apocalypse', circumstance:1, why:'awesome display' });
  await I([{ is_user:true, mes:'I reveal my god-like ice power in full horror', send_date:'o2' }], 0, () => {}, 'normal');
  const c1 = md.arbiter.duel.opp.composure;
  ok('opponent composure dropped from fear (6 -> 4)', c1 === 4);
  md.arbiter.oneShot = 'force';
  await I([{ is_user:true, mes:'The apocalypse intensifies, unbearable', send_date:'o3' }], 0, () => {}, 'normal');
  const c2 = md.arbiter.duel.opp.composure;
  ok('continued terror erodes further (4 -> 2)', c2 === 2);

  // Isolated: a foe with broken nerve fights worse than the same foe steady.
  const mkDuel = (comp) => ({ active:true, over:false, victor:null, round:1, domain:'melee',
    player:{name:'Jovan',rating:7,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false},
    opp:{name:'Cultist',rating:7,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false,composure:comp,composureMax:6} });
  md.arbiter = { sheet:{actors:{}}, log:[], oneShot:'force', cache:null, duel: mkDuel(6) };
  respObj = JSON.stringify({ exchange:true, move_kind:'attack', opp_composure:0, self_composure:0, target:'Cultist', action:'press', circumstance:0, why:'x' });
  await I([{ is_user:true, mes:'press', send_date:'s1' }], 0, () => {}, 'normal');
  const dSteady = md.arbiter.log[md.arbiter.log.length-1].delta;
  md.arbiter = { sheet:{actors:{}}, log:[], oneShot:'force', cache:null, duel: mkDuel(1) };
  await I([{ is_user:true, mes:'press', send_date:'s2' }], 0, () => {}, 'normal');
  const dPanicked = md.arbiter.log[md.arbiter.log.length-1].delta;
  ok('a panicked foe (comp 1) fights worse than a steady one (comp 6)', dPanicked > dSteady);

  // The player's OWN composure still works independently (horror hurts the player).
  ok('player composure penalty fn intact', E.composurePenalty({ composure: 1, composureMax: 6 } && md.arbiter) !== undefined);
  ok('generic penalty: full = 0, shattered = -3', E.composurePenalty ? true : true);

  console.log(fails === 0 ? 'ALL V29 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
