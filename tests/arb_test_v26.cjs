// v0.12.2: non-human creatures + scale mismatch (dragon vs human should be near-hopeless).
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
  // Human (elite 8) attacks an ancient dragon (10) head-on: scale_mismatch -4.
  // Without mismatch: 8 vs 10 = Δ-2 (~31%). With -4: Δ-6 (~7%) — near-hopeless, correct.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 8, domains: { melee: 8 } } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'charge the dragon head-on with my sword', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Ancient Dragon', circumstance:0, duel_start:'Ancient Dragon', opponent_rating:10, scale_mismatch:-4 });
  await I([{ is_user:true, mes:'I charge the ancient dragon head-on', send_date:'d1' }], 0, () => {}, 'normal');
  const d = md.arbiter.duel;
  ok('dragon rated at apex (10)', d.opp.rating === 10);
  ok('scale mismatch stored on the duel (-4)', d.scaleMismatch === -4);
  ok('the fight is near-hopeless for the human (Δ very negative)', md.arbiter.log[0].delta <= -5);
  ok('but still POSSIBLE, not impossible (P>0)', md.arbiter.log[0].P > 0);

  // Same dragon, but the player has a dragon-slaying spear (equalizer): mismatch only -1.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 8, domains: { melee: 8 } } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'drive the dragon-slaying spear into its heart', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Ancient Dragon', circumstance:1, duel_start:'Ancient Dragon', opponent_rating:10, scale_mismatch:-1 });
  await I([{ is_user:true, mes:'I strike with the legendary dragon-slaying spear', send_date:'d2' }], 0, () => {}, 'normal');
  ok('equalizer makes it a real fight, not hopeless', md.arbiter.log[0].delta > md.arbiter.log[0].delta - 1 && md.arbiter.duel.scaleMismatch === -1);

  // Player IS the huge one: crushing a tiny goblin, mismatch +4.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 6, domains: { melee: 6 } } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'step on the goblin', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Goblin', circumstance:0, duel_start:'Goblin', opponent_rating:2, scale_mismatch:4 });
  await I([{ is_user:true, mes:'As a giant I crush the goblin underfoot', send_date:'d3' }], 0, () => {}, 'normal');
  ok('player crushing something tiny is near-certain (Δ very positive)', md.arbiter.log[0].delta >= 7);

  // Same-scale fight (human vs human) ignores mismatch even with skill gap.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 7, domains: { melee: 7 } }, 'Kael': { default: 5, domains: { melee: 5 } } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'duel Kael', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Kael', circumstance:0, duel_start:'Kael', opponent_rating:null, scale_mismatch:0 });
  await I([{ is_user:true, mes:'I strike at Kael with my blade', send_date:'d4' }], 0, () => {}, 'normal');
  ok('same-scale fight uses only skill (Δ=+2, no mismatch)', md.arbiter.log[0].delta === 2 && md.arbiter.duel.scaleMismatch === 0);

  console.log(fails === 0 ? 'ALL V26 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
