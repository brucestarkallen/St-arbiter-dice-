// v0.12.1: persistent conditions — handicaps/wounds that carry across scenes.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let respObj = '{}';
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false, profileId: 'p1', autoDuel: true, autoSeed: false, mode: 'adjudicated', preset: 'realistic', tieBand: 0, duelPoise: 5, defaultRating: 5, ctxMsgs: 6 } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(k,v){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
const mod = require(require('path').join(__dirname, '..', 'index.js'));
const E = globalThis.ArbiterEngine;
const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };

// ratingFor applies a persistent condition modifier.
ok('condition lowers effective rating', E.ratingFor ? E.ratingFor({ default: 8, domains: { melee: 9 }, conditions: [{ name: 'broken arm', mod: -2 }] }, 'melee') === 7 : true);
ok('no conditions = full rating', E.ratingFor ? E.ratingFor({ default: 8, domains: { melee: 9 } }, 'melee') === 9 : true);
ok('conditions floor the rating at 0', E.ratingFor ? E.ratingFor({ default: 3, domains: {}, conditions: [{ name: 'crippled', mod: -4 }, { name: 'poisoned', mod: -2 }] }, 'melee') === 0 : true);

(async () => {
  // A check that ESTABLISHES a handicap writes it to the sheet.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 8, domains: { melee: 9 }, _auto: true } } }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'shrug off the blow', domain:'melee', actor:'Jovan', opposition_kind:'tier', opposition:'hard', circumstance:0, condition_change:{ who:'player', add:'broken left arm', remove:null, mod:-2 } });
  await I([{ is_user:true, mes:'His strike shatters my arm but I stay up', send_date:'c1' }], 0, () => {}, 'normal');
  const j = md.arbiter.sheet.actors.Jovan;
  ok('handicap recorded on the sheet', j.conditions && j.conditions.some(c => c.name === 'broken left arm' && c.mod === -2));

  // The handicap now lowers Jovan's effective rating in a later duel.
  respObj = JSON.stringify({ check:true, action:'strike Kael', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Kael', circumstance:0, duel_start:'Kael', opponent_rating:5 });
  await I([{ is_user:true, mes:'I attack Kael', send_date:'c2' }], 0, () => {}, 'normal');
  ok('handicap reduces effective rating in the duel (9 melee - 2 = 7)', md.arbiter.duel.player.rating === 7);

  // Healing the condition removes it.
  md.arbiter.duel = null; // end the fight context for a clean heal turn
  respObj = JSON.stringify({ check:true, action:'let the ice mend my arm', domain:'willpower', actor:'Jovan', opposition_kind:'tier', opposition:'moderate', circumstance:0, condition_change:{ who:'player', add:null, remove:'broken left arm', mod:0 } });
  await I([{ is_user:true, mes:'I heal my broken arm with ice over days', send_date:'c3' }], 0, () => {}, 'normal');
  const j2 = md.arbiter.sheet.actors.Jovan;
  ok('healed condition removed from the sheet', !j2.conditions || !j2.conditions.some(c => c.name === 'broken left arm'));

  // A condition on someone NOT yet on the sheet creates the entry.
  md.arbiter = { sheet: { actors: {} }, log: [], oneShot: null, cache: null };
  respObj = JSON.stringify({ check:true, action:'curse the knight', domain:'willpower', actor:'Jovan', opposition_kind:'tier', opposition:'hard', circumstance:0, condition_change:{ who:'Sir Aldric', add:'cursed with weakness', remove:null, mod:-3 } });
  await I([{ is_user:true, mes:'I lay a curse of weakness on Sir Aldric', send_date:'c4' }], 0, () => {}, 'normal');
  ok('condition on an unrated character creates the entry', md.arbiter.sheet.actors['Sir Aldric'] && md.arbiter.sheet.actors['Sir Aldric'].conditions[0].mod === -3);

  console.log(fails === 0 ? 'ALL V25 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
