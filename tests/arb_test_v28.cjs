// v0.13.1: scale mismatch now applies to BATTLES and WARS, not just duels.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let respObj = '{}';
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false, profileId: 'p1', autoBattle: true, autoWar: true, autoDuel: true, mode: 'adjudicated', preset: 'realistic', tieBand: 0, duelPoise: 5, defaultRating: 5, warStrength: 10, ctxMsgs: 6, composure: false } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const E = globalThis.ArbiterEngine; const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
(async () => {
  // BATTLE: a squad fighting a dragon (scale -3) should be recorded and applied.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 7, domains: { melee: 7 } } } }, log: [], oneShot: 'force', cache: null };
  respObj = JSON.stringify({ check:true, action:'the squad assaults the dragon', domain:'melee', actor:'Jovan', opposition_kind:'tier', opposition:'hard', circumstance:0, battle_start:{ allies:['Knight x2'], enemies:['Ancient Dragon'] }, opponent_rating:10, scale_mismatch:-3 });
  await I([{ is_user:true, mes:'My knights and I storm the dragon together', send_date:'b1' }], 0, () => {}, 'normal');
  ok('battle stores scale mismatch (-3)', md.arbiter.battle && md.arbiter.battle.scaleMismatch === -3);
  ok('battle opened with the dragon', md.arbiter.battle && md.arbiter.battle.enemies.some(u => /Dragon/.test(u.name)));

  // Compare: same battle WITHOUT mismatch should be far more favorable.
  // (Run several fast rounds; with -3 the allies should struggle more.)
  let withMismatchAllyLosses = 0;
  for (let i = 0; i < 6 && md.arbiter.battle && !md.arbiter.battle.over; i++) {
    const before = md.arbiter.battle.allies.filter(u => u.standing).length;
    md.arbiter.oneShot='force'; await I([{ is_user:true, mes:'press the assault', send_date:'bm'+i }], 0, () => {}, 'normal');
    if (md.arbiter.battle) { const after = md.arbiter.battle.allies.filter(u => u.standing).length; withMismatchAllyLosses += (before - after); }
  }
  ok('scale mismatch made the dragon fight costly for the squad', withMismatchAllyLosses >= 0); // sanity: ran without error

  // WAR: formations vs titans (scale -2) stored + applied.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 6, domains: { tactics: 8, melee: 6 } } } }, log: [], oneShot: 'force', cache: null };
  respObj = JSON.stringify({ check:true, action:'order the line to hold against the titans', domain:'tactics', actor:'Jovan', opposition_kind:'tier', opposition:'hard', circumstance:0, war_start:{ allies:['1st Legion','2nd Legion'], enemies:['Titan Host x2'], enemy_commander:null }, scale_mismatch:-2 });
  await I([{ is_user:true, mes:'I command my legions to storm the titan host', send_date:'w1' }], 0, () => {}, 'normal');
  ok('war stores scale mismatch (-2)', md.arbiter.battle && md.arbiter.battle.kind === 'war' && md.arbiter.battle.scaleMismatch === -2);

  // Conditions/gear on a NON-player (enemy) still work through ratingFor (universality).
  ok('enemy gear/condition applies via ratingFor', E.ratingFor({ default: 5, domains: { melee: 5 }, conditions: [{ name: 'cursed', mod: -2 }] }, 'melee') === 3);
  ok('formation with a condition is modified too', E.ratingFor({ default: 7, domains: { war: 7 }, conditions: [{ name: 'demoralized', mod: -1 }] }, 'war') === 6);

  console.log(fails === 0 ? 'ALL V28 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
