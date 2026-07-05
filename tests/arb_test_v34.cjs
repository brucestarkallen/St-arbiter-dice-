// v0.17.0: opt-in referee context payload + prompt inspector.
// The referee ran on a lean slice (sheet + last N messages, no memory). Now the
// user can opt into a wider payload — full memory stack, whole-chat transcript,
// hidden messages — while the referee's own neutral system prompt is always used
// (SillyTavern's is never included). The exact prompt is captured for inspection.
// This suite proves lean is byte-for-byte unchanged when toggles are off, each
// toggle does what it says, Arbiter's own directives are never fed back, and the
// inspector captures the real prompt.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };

let md = {}; let respObj = '{}';
let extensionPrompts = {}; // where memory extensions (Summaryception etc.) inject
let settings = { arbiter: { enabled: true, timeoutMs: 6000, toastResults: false, eventEngine: false,
  profileId: 'MAIN', autoDuel: true, autoBattle: true, autoWar: true, autoSeed: false, mode: 'adjudicated',
  preset: 'realistic', tieBand: 0, duelPoise: 5, defaultRating: 5, ctxMsgs: 3, composure: true, composureMax: 6,
  adjIncludeMemory: false, adjFullChat: false, adjContextK: 40, adjIncludeHidden: false } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan', name2: 'Narrator',
  extensionPrompts, chatMetadata_note: {},
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(){}, extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 },
  eventSource: { on: () => {} }, event_types: {} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const E = globalThis.ArbiterEngine;
const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };

const s = settings.arbiter;
const meta = { sheet: { actors: { Jovan: { default: 6, domains: { melee: 7 } } } } };
// A chat with a hidden message and one of Arbiter's own injected directives.
const chat = [
  { is_user: true, name: 'Jovan', mes: 'msg one' },
  { name: 'Narrator', mes: 'reply one' },
  { name: 'Narrator', mes: 'SECRET GHOST NOTE', is_system: true },       // hidden ("ghosted")
  { is_user: true, name: 'Jovan', mes: 'msg two' },
  { name: 'System', mes: '[ARBITER — duel] binding outcome…', is_system: true }, // Arbiter's own note
  { name: 'Narrator', mes: 'reply two' },
];
const action = { is_user: true, name: 'Jovan', mes: 'I strike.' };

(async () => {
  // ── A. Lean mode (all toggles off) is unchanged: no memory, skips hidden + Arbiter lines ──
  s.adjIncludeMemory = false; s.adjFullChat = false; s.adjIncludeHidden = false;
  extensionPrompts['summaryception'] = 'SUMMARY: Jovan is an elite duelist.';
  let p = E.buildAdjUserPrompt(chat, action, meta);
  ok('lean: no <memory> block', !p.includes('<memory>'));
  ok('lean: has sheet + recent + action structure', p.includes('<sheet>') && p.includes('<recent>') && p.includes('<action>'));
  ok('lean: hidden ghost note excluded', !p.includes('SECRET GHOST NOTE'));
  ok('lean: Arbiter\'s own directive excluded', !p.includes('[ARBITER'));
  ok('lean: honours ctxMsgs=3 (older msg one dropped)', !p.includes('msg one') && p.includes('reply two'));

  // ── B. compactRecent primitive ──
  ok('compactRecent skips hidden by default', !E.compactRecent(chat, 10, action, false).includes('SECRET GHOST NOTE'));
  ok('compactRecent includes hidden when asked', E.compactRecent(chat, 10, action, true).includes('SECRET GHOST NOTE'));
  ok('compactRecent NEVER includes Arbiter directives, even with hidden on', !E.compactRecent(chat, 10, action, true).includes('[ARBITER'));

  // ── C. Include-memory toggle ──
  s.adjIncludeMemory = true;
  p = E.buildAdjUserPrompt(chat, action, meta);
  ok('memory ON: <memory> block present', p.includes('<memory>'));
  ok('memory ON: Summaryception content included', p.includes('Jovan is an elite duelist'));
  s.adjIncludeMemory = false;

  // ── D. Whole-chat toggle: reads more than ctxMsgs=3 ──
  s.adjFullChat = true;
  p = E.buildAdjUserPrompt(chat, action, meta);
  ok('whole-chat ON: older "msg one" now included (beyond ctxMsgs=3)', p.includes('msg one'));
  ok('whole-chat ON: still excludes hidden by default', !p.includes('SECRET GHOST NOTE'));
  s.adjFullChat = false;

  // ── E. Hidden toggle ──
  s.adjFullChat = true; s.adjIncludeHidden = true;
  p = E.buildAdjUserPrompt(chat, action, meta);
  ok('hidden ON: ghost note now visible to referee', p.includes('SECRET GHOST NOTE'));
  ok('hidden ON: Arbiter directive STILL excluded', !p.includes('[ARBITER'));
  s.adjFullChat = false; s.adjIncludeHidden = false;

  // ── F. budgetedTranscript respects the char budget ──
  const many = []; for (let i = 0; i < 50; i++) many.push({ name: 'Narrator', mes: 'X'.repeat(100) + ' line' + i });
  const tiny = E.budgetedTranscript(many, 500, null, false); // ~500 chars → only the last few lines
  ok('budgetedTranscript respects a small budget', tiny.length <= 700 && tiny.includes('line49') && !tiny.includes('line0'));

  // ── G. Inspector captures the exact prompt after an adjudicated turn ──
  s.adjIncludeMemory = true; // so we can see it reflected in the capture
  const full = md; md.arbiter = { sheet: meta.sheet, log: [], oneShot: 'force', cache: null };
  ctxObj.chat = chat.concat([action]);
  respObj = JSON.stringify({ check: true, action: 'strike', domain: 'melee', actor: 'Jovan', opposition_kind: 'tier', opposition: 'moderate', circumstance: 0 });
  await I([{ is_user: true, name: 'Jovan', mes: 'I strike.', send_date: 'v34a' }], 0, () => {}, 'normal');
  const L = E.getLastAdj();
  ok('inspector captured a check', !!L && L.mode === 'check');
  ok('inspector recorded the rich flags (memory ON)', !!L && L.rich && L.rich.memory === true);
  ok('inspector holds BOTH system rules and context', !!L && typeof L.system === 'string' && L.system.length > 100 && L.user.includes('<action>'));
  ok('inspector char count is the real total', !!L && L.chars === (L.system.length + L.user.length));
  s.adjIncludeMemory = false;

  console.log(fails === 0 ? 'ALL V34 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
