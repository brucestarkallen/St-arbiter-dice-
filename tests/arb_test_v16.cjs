const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null };
global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let injected = '';
let respObj = '{"check":false}';
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false, profileId: 'p1', autoWar: true, mode: 'adjudicated' } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Lelouch',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(k,v){ if(k==='ARBITER_OUTCOME') injected = v; }, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const E = globalThis.ArbiterEngine; const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };

// 1. Stratagem mapping: DISASTER backfires (favors enemies)
ok('stratagem DISASTER backfires to enemy', E.STRATAGEM_EFFECTS.DISASTER.favors === 'enemies' && E.STRATAGEM_EFFECTS.DISASTER.condMod === 1);
ok('stratagem DECISIVE creates strong allied condition', E.STRATAGEM_EFFECTS.DECISIVE.favors === 'allies' && E.STRATAGEM_EFFECTS.DECISIVE.condMod === 2);

(async () => {
  // 2. war_start auto-opens a war with formations + commander ratings
  md.arbiter = { sheet: { actors: { 'Lelouch': { default: 5, domains: { tactics: 10 } }, 'Zero Squadron': { default: 7, poise: 12 } } }, log: [], oneShot: null, cache: null };
  respObj = '{"check":true,"action":"order Zero Squadron to flank the right","domain":"tactics","actor":"Lelouch","opposition_kind":"tier","opposition":"hard","circumstance":2,"war_start":{"allies":["Zero Squadron","1st Infantry"],"enemies":["Britannian Line x2","Royal Guard"],"enemy_commander":null}}';
  await I([{ is_user: true, mes: 'I order Zero Squadron to flank their right line', send_date: 'w1' }], 0, () => {}, 'normal');
  const b = md.arbiter.battle;
  ok('war opened (kind=war)', b && b.kind === 'war' && b.active);
  ok('formations built (2 allies + player, 3 enemies)', b && b.allies.length === 3 && b.enemies.length === 3);
  ok('sheet ratings honored (Zero Squadron r7 s12)', b && b.allies.some(u => u.name === 'Zero Squadron' && u.rating === 7 && u.maxPoise === 12));
  ok('commander tactics from sheet (10)', b && b.cmdA === 10);
  ok('war directive injected', injected.includes('[ARBITER — war, round 1'));

  // 3. Fast-mode war fought to conclusion (no LLM), commander edge 10 vs 5
  settings.arbiter.mode = 'fast';
  let rounds = 1;
  while (md.arbiter.battle && !md.arbiter.battle.over && rounds < 20) {
    await I([{ is_user: true, mes: 'press the assault on their weakest point', send_date: 'w' + (++rounds) }], 0, () => {}, 'normal');
  }
  ok('war concluded within 20 rounds (r=' + rounds + ')', md.arbiter.battle && md.arbiter.battle.over);
  ok('victor decided', md.arbiter.battle && ['allies','enemies'].includes(md.arbiter.battle.victor));

  // 4. army_scale (non-commanding) still routes to thread, not war
  settings.arbiter.mode = 'adjudicated'; settings.arbiter.eventEngine = true;
  md.arbiter = { sheet: { actors: {} }, log: [], oneShot: null, cache: null, engines:{surprise:{dc:999},encounter:{dc:999},world:{dc:999}}, tickCount:0, threads: [] };
  injected = '';
  respObj = '{"check":true,"action":"hold my ground in the melee","domain":"melee","actor":"Lelouch","opposition_kind":"tier","opposition":"hard","circumstance":0,"army_scale":"Battle of Narita"}';
  await I([{ is_user: true, mes: 'I fight to hold my ground as the armies clash', send_date: 'a1' }], 0, () => {}, 'normal');
  ok('non-commanding mass combat -> thread, no war HUD', !md.arbiter.battle && md.arbiter.threads.length === 1);

  console.log(fails === 0 ? 'ALL V16 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
