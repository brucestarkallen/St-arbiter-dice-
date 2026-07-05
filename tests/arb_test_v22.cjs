const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let respObj = '{}';
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false, profileId: 'p1', autoDuel: true, autoSeed: false, mode: 'adjudicated', preset: 'realistic', tieBand: 0, duelPoise: 5, defaultRating: 5, ctxMsgs: 6 } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
(async () => {
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 8, domains: { melee: 9 } } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'strike at Vheydros', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Vheydros', circumstance:0, duel_start:'Vheydros', opponent_rating:9 });
  await I([{ is_user:true, mes:'I attack the legendary warlord Vheydros', send_date:'e1' }], 0, () => {}, 'normal');
  ok('round 1 opponent uses the context estimate (9), not fallback (4)', md.arbiter.duel.opp.rating === 9);
  ok('opponent flagged as estimated', md.arbiter.duel.opp.estimated === true);
  ok('9 vs 9 is an even fight (Δ=0)', md.arbiter.log[0].delta === 0);

  md.arbiter = { sheet: { actors: { 'Jovan': { default: 8, domains: { melee: 9 } } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'strike the farmhand', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Farmhand', circumstance:0, duel_start:'Farmhand', opponent_rating:2 });
  await I([{ is_user:true, mes:'I strike the trembling farmhand', send_date:'e2' }], 0, () => {}, 'normal');
  ok('weak foe estimated low (2)', md.arbiter.duel.opp.rating === 2);

  md.arbiter = { sheet: { actors: { 'Jovan': { default: 8, domains: { melee: 9 } }, 'Vheydros': { default: 6, domains: { melee: 6 } } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'strike at Vheydros', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Vheydros', circumstance:0, duel_start:'Vheydros', opponent_rating:10 });
  await I([{ is_user:true, mes:'I attack Vheydros', send_date:'e3' }], 0, () => {}, 'normal');
  ok('sheet rating (6) overrides the estimate (10)', md.arbiter.duel.opp.rating === 6 && !md.arbiter.duel.opp.estimated);

  md.arbiter = { sheet: { actors: { 'Jovan': { default: 8, domains: { melee: 9 } } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'strike at Stranger', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Stranger', circumstance:0, duel_start:'Stranger', opponent_rating:null });
  await I([{ is_user:true, mes:'I attack the stranger', send_date:'e4' }], 0, () => {}, 'normal');
  ok('no estimate + unrated -> trained fallback (4)', md.arbiter.duel.opp.rating === 4 && !md.arbiter.duel.opp.estimated);

  console.log(fails === 0 ? 'ALL V22 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
