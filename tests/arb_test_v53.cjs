// v0.34 — ESTABLISHED DEFENSES: guards and counter-paths.
// Root cause closed (the "Infinity trace"): the referee had NO channel for a
// stated defense — Gojo-style Infinity got flattened into "circ +1", and a
// FAILURE/TRADE verdict then FORCED the storyteller to narrate the opponent
// landing contact through an untouchable barrier (the downstream model's own
// thinking showed the confusion: "how does Zaraki land a hit?").
// New shared schema fields in ALL FOUR referees (single check, duel, battle,
// war): player_guard (the maintained defense, stated as a constraint) and
// counter_path (the ONE honest way through it this beat — or null; never
// invented "to seem fair"). Directives then SCOPE every outcome:
//   - guard + counter_path: any toll on the player comes ONLY through that
//     named path — the "how" LO asked for, in the prose.
//   - guard + NO path: the opponent cannot land contact; a bad result is the
//     player's OWN attempt failing (read, evaded, stopped) and costs are
//     strain/footing/tempo; forced-injury commands are suppressed; poise
//     under an intact guard is fighting capacity, not flesh.
//   - no guard: byte-identical to before.
// The rule text also makes an unanswered guard strong POSITIVE circumstance
// for safety while the player's own attack can still fail on its merits —
// which is exactly the honest reading of the original FAILURE.
const fs = require('fs');
const path = require('path');
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(v){return v === undefined ? '' : this;}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null };
global.toastr = { info(){}, warning(){}, error(){}, success(){} };

let md = {};
let respObj = JSON.stringify({ check: false });
function makeCtx() {
    return {
        name1: 'LO', name2: 'Narrator',
        extensionSettings: { arbiter: { enabled: true, timeoutMs: 4000, toastResults: false, autoSeed: false, autoDuel: true, eventEngine: false, composure: true, composureMax: 6 } },
        chatMetadata: md,
        chat: [],
        setExtensionPrompt: () => {},
        extension_prompt_types: { IN_CHAT: 1 },
        extension_prompt_roles: { SYSTEM: 0 },
        eventSource: { on(){} }, event_types: {},
        generateRaw: async () => respObj,
        saveMetadataDebounced: () => {}, saveSettingsDebounced: () => {},
    };
}
global.SillyTavern = { getContext: makeCtx };
require(path.join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
const E = globalThis.ArbiterEngine;
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
let fails = 0; const ok = (n, c) => { console.log((c ? '  OK  ' : ' FAIL ') + n); if (!c) fails++; };
const um = (mes, d) => ({ is_user: true, name: 'LO', mes, send_date: d });
const fresh = () => { md.arbiter = { sheet: { actors: { 'Jovan Oda': { default: 7, domains: { melee: 8 } }, 'Kenpachi Zaraki': { default: 9, domains: { melee: 10 } } } }, log: [], oneShot: null, cache: null, composure: 6, mcName: 'Jovan Oda' }; return md.arbiter; };
const INFINITY = "Infinity holds: nothing physical reaches his body; only the sword's veil is lowered";
const PATH = 'the veil must widen the instant he commits, and Zaraki can strike that instant';
const GUARD_NEG = ['TRADE', 'SETBACK', 'FAILURE', 'DISASTER', 'SUCCESS_COST'];

(async () => {
    /* ── source locks: the fields and the rule live in ALL FOUR briefs ──── */
    ok('player_guard/counter_path fields injected into all four schemas', (SRC.match(/' ' \+ GUARD_FIELD \+ ','/g) || []).length === 4 && (SRC.match(/' ' \+ COUNTER_FIELD \+ ','/g) || []).length === 4);
    ok('the guard rule is in all four rule lists', (SRC.match(/^\s*GUARD_RULE,$/gm) || []).length === 4);
    ok('the rule forbids inventing a path to seem fair', SRC.includes('do NOT invent one to seem fair'));
    ok('the rule defines foreclosed harm as the player\'s own attempt failing', SRC.includes('never an impossible touch'));

    /* ── normalizers parse the fields everywhere ────────────────────────── */
    let meta = fresh();
    const d = E.normalizeDuelAdj({ exchange: true, action: 'strike through the veil', circumstance: 1, player_guard: INFINITY, counter_path: 'none' });
    ok('duel: guard parsed, "none" counter-path is null (foreclosed)', d.playerGuard === INFINITY && d.counterPath === null);
    const d2 = E.normalizeDuelAdj({ exchange: true, action: 'strike', circumstance: 0, player_guard: INFINITY, counter_path: PATH });
    ok('duel: a real counter-path survives verbatim', d2.counterPath === PATH);
    const b = E.normalizeBattleAdj({ exchange: true, move_kind: 'fight', target: null, action: 'cut', circumstance: 0, player_guard: INFINITY, counter_path: null });
    ok('battle: guard parsed', b.playerGuard === INFINITY && b.counterPath === null);
    const w = E.normalizeWarAdj({ exchange: true, order_kind: 'personal', acting_unit: null, target_unit: 'Black Wing', action: 'sortie', circumstance: 0, player_guard: INFINITY, counter_path: PATH });
    ok('war: guard parsed', w.playerGuard === INFINITY && w.counterPath === PATH);
    const a = E.normalizeAdj({ check: true, action: 'cross the ward-line', domain: 'melee', actor: 'Jovan Oda', opposition_kind: 'actor', opposition: 'Kenpachi Zaraki', circumstance: 0, player_guard: INFINITY, counter_path: 'nothing' }, meta);
    ok('single check: guard parsed, "nothing" is a foreclosed path', a.playerGuard === INFINITY && a.counterPath === null);

    /* ── duel directives: the verdict is SCOPED by the guard ────────────── */
    E.startDuel(meta, 'Jovan Oda', 'Kenpachi Zaraki', 'melee');
    const adjNoPath = { action: 'advance holding Infinity, strike through the narrowed veil', playerGuard: INFINITY, counterPath: null };
    const adjPath = Object.assign({}, adjNoPath, { counterPath: PATH });
    let dir = E.buildDuelDirective(meta, adjNoPath, { tier: 'FAILURE', opening: false });
    ok('FAILURE + foreclosed guard: the failure is the player\'s OWN attempt', dir.includes('Standing guard (established fiction): ' + INFINITY) && dir.includes('has NO path through that guard') && dir.includes("OWN attempt failing") && dir.includes('The guard itself holds'));
    ok('FAILURE + foreclosed guard: impossible contact is forbidden', dir.includes('do NOT narrate them landing direct contact or a wound'));
    dir = E.buildDuelDirective(meta, adjNoPath, { tier: 'TRADE', opening: false });
    ok('TRADE + foreclosed guard is scoped the same way (the original trace)', dir.includes('has NO path through that guard'));
    dir = E.buildDuelDirective(meta, adjNoPath, { tier: 'DISASTER', opening: false });
    ok('DISASTER + foreclosed guard: forced self-injury is suppressed', !dir.includes('Inflict a concrete lasting injury on Jovan Oda') && dir.includes('has NO path through that guard'));
    dir = E.buildDuelDirective(meta, adjPath, { tier: 'DISASTER', opening: false });
    ok('DISASTER + real path: the toll is licensed AND the path is named', dir.includes('Inflict a concrete lasting injury on Jovan Oda') && dir.includes('ONLY through this path') && dir.includes(PATH));
    dir = E.buildDuelDirective(meta, adjNoPath, { tier: 'SUCCESS', opening: false });
    ok('a positive verdict shows the guard without opponent scoping', dir.includes('Standing guard') && !dir.includes('has NO path'));
    dir = E.buildDuelDirective(meta, { action: 'a plain cut' }, { tier: 'FAILURE', opening: false });
    ok('no guard = byte-identical legacy directive (no guard lines)', !dir.includes('Standing guard'));
    const combo = E.buildDuelSequenceDirective(meta, Object.assign({}, adjNoPath), { steps: [{ strike: 'feint', tier: 'SUCCESS' }, { strike: 'cut', tier: 'FAILURE' }], overall: 'FAILURE', outcome: false, victor: null });
    ok('combo directive carries the guard scoping', combo.includes('has NO path through that guard'));
    meta.duel = null;

    /* ── battle / war / single-check scoping ────────────────────────────── */
    E.startBattle(meta, ['Stella'], ['Bandit x2'], 'melee');
    let bd = E.buildBattleDirective(meta, adjNoPath, { mcRes: { tier: 'FAILURE', command: false }, reports: [] });
    ok('battle fight verdicts are guard-scoped', bd.includes('has NO path through that guard'));
    bd = E.buildBattleDirective(meta, adjNoPath, { mcRes: { tier: 'DISASTER', command: false }, reports: [] });
    ok('battle: forced self-injury suppressed under a foreclosed guard', !bd.includes('Inflict a concrete lasting injury on Jovan Oda'));
    meta.battle = null;
    E.startWar(meta, ['1st Lance'], ['Black Wing'], 'Warlord', 0);
    const tgt = meta.battle.enemies[0];
    const wd = E.buildWarDirective(meta, adjPath, { focalRes: { tier: 'FAILURE', personal: true }, reports: [], condNote: null, acting: null, target: tgt });
    ok('war personal orders are guard-scoped with the named path', wd.includes('ONLY through this path') && wd.includes(PATH));
    meta.battle = null;
    const sd = E.buildDirective(Object.assign({ actor: 'Jovan Oda', kind: 'actor', opposition: 'Kenpachi Zaraki', stakes: '' }, adjNoPath), { tier: 'FAILURE' });
    ok('single checks are guard-scoped too, naming the opponent', sd.includes('Kenpachi Zaraki has NO path through that guard'));

    /* ── E2E: LO\'s exact Infinity exchange through the real referee ─────── */
    meta = fresh();
    E.startDuel(meta, 'Jovan Oda', 'Kenpachi Zaraki', 'melee');
    respObj = JSON.stringify({ exchange: true, action: 'advance holding Infinity, strike through the narrowed veil', circumstance: 1, why: 'total defense maintained; his own strike must pass a narrowed gap', player_guard: INFINITY, counter_path: null });
    await I([um('I keep Infinity up, lower it only around my sword, and strike Zaraki [roll]', 'g1')], 0, () => {}, 'normal');
    const dr = meta.cache.directive;
    ok('E2E: the directive carries the standing guard', dr.includes('Standing guard (established fiction): ' + INFINITY));
    ok('E2E: negative outcomes are scoped, positive ones left free', GUARD_NEG.includes(meta.cache.tier) ? dr.includes('has NO path through that guard') : !dr.includes('has NO path'));
    ok('E2E: the log records guard held with no counter path', meta.log.length === 1 && meta.log[0].guard === INFINITY && meta.log[0].path === undefined);

    console.log(fails ? 'SUITE FAILED (' + fails + ')' : 'ALL v53 GUARD INVARIANTS GREEN');
    process.exit(fails ? 1 : 0);
})();
