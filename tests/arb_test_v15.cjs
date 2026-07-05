const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null };
global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let injected = '';
let respObj = '{"check":false}';
let ctxObj = { extensionSettings: { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: true, profileId: 'p1', autoBattle: true, autoDuel: true } }, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(k,v){ if(k==='ARBITER_OUTCOME') injected = v; }, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
(async () => {
  // Multi-target -> battle opens against a generic squad
  md.arbiter = { sheet:{actors:{'Jovan':{default:8,domains:{ice:10}}}}, log:[], oneShot:null, cache:null, engines:{surprise:{dc:999},encounter:{dc:999},world:{dc:999}}, tickCount:0, threads:[] };
  respObj = '{"check":true,"action":"sweep vines through the guards","domain":"ice","actor":"Jovan","opposition_kind":"tier","opposition":"trained","circumstance":1,"battle_start":{"allies":[],"enemies":["Guard x3"]}}';
  await I([{ is_user: true, mes: 'I sweep the vines through all the guards', send_date: 'm1' }], 0, () => {}, 'normal');
  ok('multi-target attack opened a battle', md.arbiter.battle && md.arbiter.battle.active);
  ok('generic squad spawned (3 enemies)', md.arbiter.battle && md.arbiter.battle.enemies.length === 3);
  ok('battle directive injected', injected.includes('[ARBITER — battle'));

  // Army-scale -> thread created, personal action still resolves, no battle
  md.arbiter = { sheet:{actors:{'Jovan':{default:8,domains:{ice:10}}}}, log:[], oneShot:null, cache:null, engines:{surprise:{dc:999},encounter:{dc:999},world:{dc:999}}, tickCount:0, threads:[] };
  injected = '';
  respObj = '{"check":true,"action":"hold the line with ice","domain":"ice","actor":"Jovan","opposition_kind":"tier","opposition":"hard","circumstance":0,"army_scale":"Siege of Mithraic"}';
  await I([{ is_user: true, mes: 'I storm the enemy line and raise ice walls as the armies clash', send_date: 'a1' }], 0, () => {}, 'normal');
  ok('army-scale did NOT open a battle HUD', !md.arbiter.battle);
  ok('army-scale created a World Thread', md.arbiter.threads.length === 1 && /Siege of Mithraic/.test(md.arbiter.threads[0].name));
  ok('personal action still resolved + injected', injected.includes('amid the Siege of Mithraic'));

  console.log(fails === 0 ? 'ALL V15 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
