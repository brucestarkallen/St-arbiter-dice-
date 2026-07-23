// v0.33 — FIGHT-OR-NOT INTELLIGENCE: declarations arm, attempts roll.
// Root cause closed (the "Zaraki trace"): the schema gave the referee no way
// to open a fight without rolling — check=false dropped duel_start on the
// floor, so arming a duel REQUIRED check=true, which forced a melee exchange
// onto a message that only taunted, declared, and drew steel (SETBACK/FAILURE
// on "prepare to duel"). Worse, the duel armed with the arming message's OWN
// domain, so a taunt classified 'social' armed a SOCIAL duel (the 9v9 TRADE).
// And the in-duel rule "nearly every player turn IS an exchange" forced
// standoff talk into rolled exchanges.
// Fixes locked here:
//   1. THE TRACE, FIXED: a taunt/declaration/unsheathe message arms the duel
//      with check=false — round 0, NOTHING rolled, no log entry, and the
//      directive forbids resolving anything ("No blow has landed").
//   2. combatDomain: a 'social'-classified opener still arms a MELEE duel
//      (social/intellect/craft/stealth sanitize to melee; ranged/pilot/
//      willpower pass through) — on both the arm-only and check=true paths.
//   3. normalizeAdj check=false carries duel/battle/war starts, with the
//      full self-alias hardening (the player is never the foe).
//   4. Replay safety: regenerating the arming message re-injects the
//      committed arm — one duel, still round 0, no second referee call.
//   5. The NEXT real attempt rolls as round 1; an in-duel standoff turn
//      (exchange=false) rolls nothing and advances nothing.
//   6. A genuine attack-opener (check=true + duel_start) still arms AND
//      resolves round 1 — the legitimate path is unchanged.
//   7. Referee criteria locked in source: declarations/intent, preparation/
//      posture, OOC/directorial text ("what would <character> do",
//      intervention windows), already-resolved recaps; the duel standoff-vs-
//      pressed distinction ("words do not parry steel").
//   8. Every tier the engine can emit has a plain-language meaning, and the
//      log line carries it — a bare SETBACK/TRADE is never a mystery.
const fs = require('fs');
const path = require('path');
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(v){return v === undefined ? '' : this;}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null };
global.toastr = { info(){}, warning(){}, error(){}, success(){} };

let md = {};
let respObj = JSON.stringify({ check: false });
let genRawCalls = 0;
function makeCtx() {
    return {
        name1: 'LO', name2: 'Narrator',
        extensionSettings: { arbiter: { enabled: true, timeoutMs: 4000, toastResults: false, autoSeed: false, autoDuel: true, autoBattle: true, eventEngine: false, composure: true, composureMax: 6 } },
        chatMetadata: md,
        chat: [],
        setExtensionPrompt: () => {},
        extension_prompt_types: { IN_CHAT: 1 },
        extension_prompt_roles: { SYSTEM: 0 },
        eventSource: { on(){} }, event_types: {},
        generateRaw: async () => { genRawCalls++; return respObj; },
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
const fresh = () => { md.arbiter = { sheet: { actors: { 'Jovan Oda': { default: 7, domains: { melee: 8, social: 9 } }, 'Kenpachi Zaraki': { default: 9, domains: { melee: 10, social: 9 } } } }, log: [], oneShot: null, cache: null, composure: 6, mcName: 'Jovan Oda' }; return md.arbiter; };
const zarakiMsg = 'You move and take position. You look at Zaraki and say calm down captain. You unsheathe a sky silver blue blade and say so you are the one who cut a literal meteor. Perhaps I am going to be the third. I am not going to use my bankai. You put your blade between your eyes. Intervention window what would Zaraki do.... [roll]';

(async () => {
    /* ── 7. criteria locked in source (model-agnostic briefs) ───────────── */
    ok('brief: an attempt must be committed RIGHT NOW to roll', SRC.includes('genuinely uncertain RIGHT NOW'));
    ok('brief: declarations/negations attempt nothing', SRC.includes('describe what MAY happen — nothing is attempted now'));
    ok('brief: preparation/posture can open a fight without a roll', SRC.includes('PREPARATION and POSTURE'));
    ok('brief: OOC/directorial text is never an attempt', SRC.includes('what would <character> do') && SRC.includes('intervention windows'));
    ok('brief: already-resolved actions never re-roll', SRC.includes('never re-roll what has already happened'));
    ok('brief: squared-up arming = duel_start + check=false, first attempt is round 1', SRC.includes('set duel_start together with check=false'));
    ok('duel brief: a pressed player still fights — words do not parry steel', SRC.includes('words do not parry steel'));
    ok('duel brief: a mutual standoff is a lull', SRC.includes('NEITHER side commits an attack this beat'));

    /* ── 8. every tier has a plain meaning ──────────────────────────────── */
    for (const t of ['DECISIVE', 'SUCCESS', 'SUCCESS_COST', 'TRADE', 'STALEMATE', 'SETBACK', 'FAILURE', 'DISASTER', 'ARMED']) {
        ok('tier ' + t + ' has a plain-language meaning', SRC.includes("TIER_MEANING = {") && new RegExp('\\n        ' + t + ':').test(SRC));
    }
    ok('the log line carries the meaning', SRC.includes("TIER_MEANING[l.tier] ? TIER_MEANING[l.tier] + ' · '"));

    /* ── 2. combatDomain sanitizer ──────────────────────────────────────── */
    ok('talk domains sanitize to melee', ['social', 'intellect', 'craft', 'stealth', ''].every(d => E.combatDomain(d) === 'melee'));
    ok('combat domains pass through', E.combatDomain('ranged') === 'ranged' && E.combatDomain('pilot') === 'pilot' && E.combatDomain('willpower') === 'willpower');

    /* ── 3. normalizeAdj: check=false carries fight starts, hardened ────── */
    let meta = fresh();
    let n = E.normalizeAdj({ check: false, duel_start: 'Kenpachi Zaraki', domain: 'social', action: 'square up and taunt' }, meta);
    ok('check=false preserves duel_start for arming', n.check === false && n.duel_start === 'Kenpachi Zaraki' && n.action === 'square up and taunt');
    n = E.normalizeAdj({ check: false, duel_start: 'Jovan Oda' }, meta);
    ok('the player (story name) is never the foe on the arm path', n.check === false && n.duel_start === undefined);
    n = E.normalizeAdj({ check: false, duel_start: 'LO' }, meta);
    ok('the persona label is never the foe on the arm path', n.duel_start === undefined);
    n = E.normalizeAdj({ check: false, duel_start: 'Oda' }, meta);
    ok('a name fragment is never the foe on the arm path', n.duel_start === undefined);
    n = E.normalizeAdj({ check: false, battle_start: { allies: [], enemies: ['Guard x3', 'Jovan Oda'] } }, meta);
    ok('battle arm path keeps real enemies, drops the player', n.battle_start && n.battle_start.enemies.length === 1 && n.battle_start.enemies[0] === 'Guard x3');

    /* ── 1. THE ZARAKI TRACE, FIXED (end-to-end) ────────────────────────── */
    meta = fresh();
    genRawCalls = 0;
    respObj = JSON.stringify({ check: false, action: 'face Zaraki, taunt, and square up to duel', domain: 'social', duel_start: 'Kenpachi Zaraki' });
    const m1 = um(zarakiMsg, 'z1');
    await I([m1], 0, () => {}, 'normal');
    ok('the taunt/declaration message ARMS the duel', !!(meta.duel && meta.duel.active));
    ok('nothing is rolled: round 0, no log entry, full poise', !!meta.duel && meta.duel.round === 0 && meta.log.length === 0 && meta.duel.player.poise === meta.duel.player.maxPoise && meta.duel.opp.poise === meta.duel.opp.maxPoise);
    ok('a social-classified opener still arms a MELEE duel at real ratings', !!meta.duel && meta.duel.domain === 'melee' && meta.duel.player.rating === 8 && meta.duel.opp.rating === 10);
    ok('the player is armed under the STORY name', !!meta.duel && meta.duel.player.name === 'Jovan Oda');
    ok('the directive binds the storyteller to the brink, resolving nothing', !!(meta.cache && meta.cache.directive) && meta.cache.directive.includes('No blow has landed') && meta.cache.directive.includes('round 1') && meta.cache.tier === 'ARMED');

    /* ── 4. regenerating the arming message replays, never re-rolls ─────── */
    const callsAfterArm = genRawCalls;
    await I([m1], 0, () => {}, 'swipe');
    ok('regen replays the committed arm: no second referee call', genRawCalls === callsAfterArm);
    ok('still exactly one duel at round 0', !!meta.duel && meta.duel.active && meta.duel.round === 0 && meta.log.length === 0);

    /* ── 5. the first REAL attempt is round 1; standoffs stay silent ────── */
    respObj = JSON.stringify({ exchange: true, action: 'a committed diagonal cut', circumstance: 0, why: 'first blood attempt' });
    await I([m1, um('I lunge with a committed diagonal cut [roll]', 'z2')], 0, () => {}, 'normal');
    ok('the first committed attempt rolls as round 1', !!meta.duel && meta.duel.round === 1 && meta.log.length === 1 && meta.log[0] && meta.log[0].r === 1);
    respObj = JSON.stringify({ exchange: false });
    const poiseBefore = meta.duel ? meta.duel.player.poise + meta.duel.opp.poise : -1;
    await I([m1, um('I lunge with a committed diagonal cut [roll]', 'z2'), um('We circle. You will not beat me, I say. [roll]', 'z3')], 0, () => {}, 'normal');
    ok('an in-duel standoff turn rolls nothing and advances nothing', !!meta.duel && meta.duel.round === 1 && meta.log.length === 1 && (meta.duel.player.poise + meta.duel.opp.poise) === poiseBefore);

    /* ── 6. a genuine attack-opener still arms AND rolls round 1 ────────── */
    meta = fresh();
    respObj = JSON.stringify({ check: true, action: 'lunge blade-first at Zaraki', domain: 'melee', actor: 'Jovan Oda', opposition_kind: 'actor', opposition: 'Kenpachi Zaraki', circumstance: 0, duel_start: 'Kenpachi Zaraki' });
    await I([um('I lunge blade-first at Zaraki [roll]', 'a1')], 0, () => {}, 'normal');
    ok('an actual attack opener arms and resolves round 1 (unchanged)', meta.duel && meta.duel.active && meta.duel.round === 1 && meta.log.length === 1);
    ok('the attack opener also arms in a combat domain', !!meta.duel && meta.duel.domain === 'melee');

    console.log(fails ? 'SUITE FAILED (' + fails + ')' : 'ALL v52 FIGHT-OR-NOT INVARIANTS GREEN');
    process.exit(fails ? 1 : 0);
})();
