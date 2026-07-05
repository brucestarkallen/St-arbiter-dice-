// v0.10.3: referee must not invent rules-penalties; domain matches the physical act.
// These are prompt-content guarantees (the model obeys them at runtime); we assert
// the shipped prompts carry the prohibitions in every combat referee.
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };

// Extract each _SYSTEM block by name
function block(name) {
  const i = src.indexOf('const ' + name + ' = [');
  if (i < 0) return '';
  const j = src.indexOf('].join', i);
  return src.slice(i, j);
}
const adj = block('ADJ_SYSTEM'), duel = block('DUEL_SYSTEM'), battle = block('BATTLE_SYSTEM'), war = block('WAR_SYSTEM');

ok('ADJ forbids scoring legality/fouls', /never penalize an action for being illegal|foul, dishonorable/i.test(adj));
ok('ADJ circumstance is physical-only', /circumstance is PHYSICAL/i.test(adj));
ok('ADJ domain guided by physical nature (feint≠stealth)', /never stealth just because it is a feint/i.test(adj));
ok('DUEL forbids foul/sanction penalties', /NEVER penalize a move for being a foul|groin kick/i.test(duel));
ok('DUEL never mentions sanctions/disqualification', /never mention rules, sanctions, penalties, or disqualification/i.test(duel));
ok('BATTLE forbids foul penalties too', /foul, dirty, illegal/i.test(battle));

// Runtime sanity: a "fake jab + kick" style action still resolves and the domain
// the ENGINE uses is whatever the referee returns — confirm melee rating is read.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let respObj = '{"check":false}';
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false, profileId: 'p1', autoDuel: true, mode: 'adjudicated' } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
(async () => {
  // With correct domain=melee and a POSITIVE circumstance for the dirty move,
  // the player's melee rating (7) is used and odds are high — not a 57% coin flip.
  md.arbiter = { sheet: { actors: { 'Jovan': { default: 6, domains: { melee: 7 } }, 'Kael': { default: 4, domains: { melee: 4 } } } }, log: [], oneShot: null, cache: null,
    duel: { active:true, over:false, victor:null, round:1, domain:'melee',
      player:{name:'Jovan',rating:7,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false},
      opp:{name:'Kael',rating:4,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false} } };
  respObj = '{"exchange":true,"move_kind":"fight","target":"Kael","action":"fake jab then hard groin kick","circumstance":2,"why":"feint opens his guard, exposed target"}';
  await I([{ is_user: true, mes: 'I throw a fake left jab and hard kick to the groin', send_date: 'k1' }], 0, () => {}, 'normal');
  ok('dirty move scored as advantage (circ +2), high odds not a coinflip', md.arbiter.log.length && md.arbiter.log[0].circ === 2 && md.arbiter.log[0].P > 90);
  console.log(fails === 0 ? 'ALL V19 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
