// v0.11.1: duel recovery — poise can go UP via a recover move, at the cost of tempo.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let injected = ''; let respObj = '{}';
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false, profileId: 'p1', autoDuel: true, mode: 'adjudicated', preset: 'realistic', tieBand: 0.06, duelPoise: 5 } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(k,v){ if(k==='ARBITER_OUTCOME') injected = v; }, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
(async () => {
  // Player at 2/5 poise recovers; poise should INCREASE, opponent gains momentum.
  md.arbiter = { sheet: { actors: {} }, log: [], oneShot: null, cache: null,
    duel: { active:true, over:false, victor:null, round:3, domain:'ice',
      player:{name:'Jovan',rating:7,poise:2,maxPoise:5,injuries:0,momentum:0.5,opening:false},
      opp:{name:'Kael',rating:5,poise:4,maxPoise:5,injuries:0,momentum:0,opening:false} } };
  respObj = '{"exchange":true,"move_kind":"recover","action":"weave ice-vines to mend and catch breath","circumstance":2,"why":"brief opening to disengage"}';
  await I([{ is_user: true, mes: 'I pull back and let the ice close my wounds', send_date: 'r1' }], 0, () => {}, 'normal');
  const d = md.arbiter.duel;
  ok('poise INCREASED from recovery', d.player.poise > 2);
  ok('poise capped at max (<=5)', d.player.poise <= 5);
  ok('opponent gained tempo (momentum up)', d.opp.momentum >= 0.5);
  ok('opponent got the ceded opening', d.opp.opening === true);
  ok('recovery directive narrates restoration + ceded tempo', /disengages to recover/.test(injected) && /seizes the initiative/.test(injected));
  ok('round advanced', d.round === 4);

  // Recovery never overheals past max
  md.arbiter.duel.player.poise = 4.5; md.arbiter.duel.opp.opening = false;
  respObj = '{"exchange":true,"move_kind":"recover","action":"full restoration","circumstance":3,"why":"safe"}';
  await I([{ is_user: true, mes: 'I fully heal', send_date: 'r2' }], 0, () => {}, 'normal');
  ok('cannot exceed maxPoise even on a big heal', md.arbiter.duel.player.poise === 5);

  // An ATTACK move still damages normally (recovery is opt-in)
  md.arbiter.duel = { active:true, over:false, victor:null, round:1, domain:'ice',
    player:{name:'Jovan',rating:9,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false},
    opp:{name:'Kael',rating:3,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false} };
  respObj = '{"exchange":true,"move_kind":"attack","action":"drive the blade in","circumstance":1,"why":"opening"}';
  await I([{ is_user: true, mes: 'I strike hard', send_date: 'a1' }], 0, () => {}, 'normal');
  ok('attack still reduces opponent poise', md.arbiter.duel.opp.poise < 5);

  console.log(fails === 0 ? 'ALL V21 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
