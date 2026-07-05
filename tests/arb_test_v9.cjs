// v0.7.1: restore invalidates the stale fate; ended fights can't resurrect.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null };
global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; const injections = {};
global.SillyTavern = { getContext: () => ({ extensionSettings: { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false } }, chatMetadata: md, name1: 'Jovan', setExtensionPrompt(k,v){ injections[k]=v; }, extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 } }) };
require(require('path').join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
const duelState = (round, pPoise, oPoise) => ({ active: true, over: false, victor: null, round, domain: 'melee',
  player: { name: 'Jovan', rating: 6, poise: pPoise, maxPoise: 5, injuries: 0, momentum: 0, opening: false },
  opp: { name: 'Piers', rating: 6, poise: oPoise, maxPoise: 5, injuries: 0, momentum: 0.5, opening: false } });
(async () => {
  // A) Force re-roll of the same message with a failing referee: state rewinds,
  //    stale cache is DROPPED (no divergent replay possible), duel back at round 0.
  md.arbiter = { sheet: { actors: {} }, log: [], oneShot: 'force', cache: {
      key: 'oldkey', sendDate: 'd1', directive: 'STALE FAILURE DIRECTIVE', tier: 'FAILURE',
      duelSnapshot: { d: duelState(0, 5, 5), b: null, t: [], e: null, tc: 0 } },
    duel: duelState(1, 3.5, 5) };
  await I([{ is_user: true, mes: 'I strike with everything', send_date: 'd1' }], 0, () => {}, 'normal');
  ok('rewound to the pre-exchange state', md.arbiter.duel && md.arbiter.duel.round === 0 && md.arbiter.duel.player.poise === 5);
  ok('stale fate invalidated (cache dropped)', md.arbiter.cache === null);
  injections.ARBITER_OUTCOME = '';
  await I([{ is_user: true, mes: 'I strike with everything', send_date: 'd1' }], 0, () => {}, 'swipe');
  ok('subsequent swipe cannot replay the divergent directive', injections.ARBITER_OUTCOME === '' );
  console.log(fails === 0 ? 'ALL V9 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
