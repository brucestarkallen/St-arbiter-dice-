// v0.13.0: gear (domain-tagged persistent buff) + composure (mental strain).
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

// GEAR: domain-tagged buff only affects its domain.
ok('gear buffs its domain (melee +2 = 9)', E.ratingFor({ default: 7, domains: { melee: 7 }, conditions: [{ name: 'masterwork blade', mod: 2, domain: 'melee', gear: true }] }, 'melee') === 9);
ok('gear does NOT buff other domains (stealth stays 7)', E.ratingFor({ default: 7, domains: { melee: 7, stealth: 7 }, conditions: [{ name: 'masterwork blade', mod: 2, domain: 'melee', gear: true }] }, 'stealth') === 7);
ok('untagged affliction hits ALL domains', E.ratingFor({ default: 7, domains: { melee: 7, stealth: 7 }, conditions: [{ name: 'exhausted', mod: -2 }] }, 'stealth') === 5);

// COMPOSURE: penalty is 0 while steady, grows as it breaks.
md.arbiter = md.arbiter || {}; ok('full composure = no penalty', E.composurePenalty({composure:6}) === 0);
ok('half composure = no penalty (mild strain harmless)', E.composurePenalty({composure:3}) === 0);
ok('below half = penalty begins', E.composurePenalty({composure:2}) < 0);
ok('shattered = max penalty (-3)', E.composurePenalty({composure:0}) === -3);

(async () => {
  // Gear established via fiction, persists, buffs the right domain in a duel.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 6, domains: { melee: 6 } } } }, log: [], oneShot: 'force', cache: null };
  md.arbiter = md.arbiter || {}; md.arbiter.composure = 6;
  respObj = JSON.stringify({ check:true, action:'claim the legendary sword', domain:'melee', actor:'Jovan', opposition_kind:'tier', opposition:'moderate', circumstance:0, condition_change:{ who:'player', add:'Frostfang, a legendary blade', remove:null, mod:2, domain:'melee', gear:true } });
  await I([{ is_user:true, mes:'I take up the legendary blade Frostfang', send_date:'g1' }], 0, () => {}, 'normal');
  const j = md.arbiter.sheet.actors.Jovan;
  ok('gear recorded with domain+gear flag', j.conditions && j.conditions.some(c => c.gear && c.domain === 'melee' && c.mod === 2));

  // Horror erodes composure; a later action is penalized.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 7, domains: { melee: 7 } }, 'Cultist': { default: 5, domains: { melee: 5 } } } }, log: [], oneShot: 'force', cache: null };
  md.arbiter = md.arbiter || {}; md.arbiter.composure = 6;
  respObj = JSON.stringify({ check:true, action:'stare into the writhing horror', domain:'willpower', actor:'Jovan', opposition_kind:'tier', opposition:'hard', circumstance:0, composure_change:-3 });
  await I([{ is_user:true, mes:'I behold the impossible cosmic horror unfolding', send_date:'h1' }], 0, () => {}, 'normal');
  ok('cosmic horror eroded composure (6 -> 3)', md.arbiter.composure === 3);
  // Another horror to push below half
  md.arbiter.oneShot = 'force'; respObj = JSON.stringify({ check:true, action:'endure the whispers', domain:'willpower', actor:'Jovan', opposition_kind:'tier', opposition:'hard', circumstance:0, composure_change:-2 });
  await I([{ is_user:true, mes:'The maddening whispers claw at my mind', send_date:'h2' }], 0, () => {}, 'normal');
  ok('composure now below half (1)', md.arbiter.composure === 1);
  // Now a combat action is penalized by the strain
  md.arbiter.oneShot = 'force'; respObj = JSON.stringify({ check:true, action:'strike the cultist', domain:'melee', actor:'Jovan', opposition_kind:'actor', opposition:'Cultist', circumstance:0, duel_start:'Cultist', opponent_rating:5 });
  await I([{ is_user:true, mes:'Shaking, I attack the cultist', send_date:'h3' }], 0, () => {}, 'normal');
  // Jovan melee 7 vs Cultist 5 = +2 base, minus composure penalty (~-2 at composure 1) → ~0
  ok('mental strain penalizes the strike (Δ reduced below +2)', md.arbiter.log[0].delta < 2);

  // Recovery: safety restores composure.
  md.arbiter.oneShot = 'force'; respObj = JSON.stringify({ check:true, action:'rest by the fire', domain:'willpower', actor:'Jovan', opposition_kind:'tier', opposition:'easy', circumstance:0, composure_change:3 });
  md.arbiter.duel = null;
  await I([{ is_user:true, mes:'I reach safety and rest, breathing slowly', send_date:'h4' }], 0, () => {}, 'normal');
  ok('safety restores composure (1 -> 4)', md.arbiter.composure === 4);

  console.log(fails === 0 ? 'ALL V27 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
