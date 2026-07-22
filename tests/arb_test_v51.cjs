// v0.32 — OUTCOME-ONLY FIGHT STYLE (no health, no engine-called end).
// New setting fightStyle: 'tracked' (default, unchanged) | 'outcome'.
// In outcome style every exchange still rolls the full fair curve and returns
// a verdict (DECISIVE…DISASTER), but NOTHING is tallied: no poise damage, no
// forced injuries, no momentum/openings, and the engine NEVER declares a
// winner — the storyteller ends the fight (the referee's fiction-driven
// combat_ended close and the manual /duelend etc. still work).
//   1. Duel: 40 exchanges leave both sides at full poise, zero injuries and
//      momentum, over=false, victor=null; every exchange still has a tier.
//   2. A 'recover' move has no poise to restore — it resolves as a plain
//      exchange (no recovery mechanics fire).
//   3. Combos keep per-strike texture but tally nothing and never finish.
//   4. Directives: the storyteller-ends line is present; 'is beaten' /
//      'DECISIVE POSITION' and forced-injury commands never appear — even on
//      a DECISIVE verdict.
//   5. Composure still shapes the odds (it is nerve, not health).
//   6. Battle: only the MC's action is scored — no unit ticks, no reports,
//      no rout, no victor, for both fight and command turns.
//   7. War: maneuver/stratagem/personal orders are scored; strengths,
//      conditions and collapse never move.
//   8. The STORYTELLER'S end still ends it: a combat_ended verdict from the
//      referee closes an outcome-style duel through the real interceptor.
//   9. TRACKED CONTROL: flipping the setting back restores poise damage —
//      the gate provably distinguishes the styles.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(v){return v === undefined ? '' : this;}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null };
global.toastr = { info(){}, warning(){}, error(){}, success(){} };

let md = {};
let fightStyle = 'outcome';
let respObj = JSON.stringify({ check: false });
function makeCtx() {
    return {
        name1: 'Jovan', name2: 'Narrator',
        extensionSettings: { arbiter: { enabled: true, timeoutMs: 4000, toastResults: false, autoSeed: false, eventEngine: false, composure: true, composureMax: 6, fightStyle } },
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
require(require('path').join(__dirname, '..', 'index.js'));
const I = globalThis.arbiterInterceptor;
const E = globalThis.ArbiterEngine;
let fails = 0; const ok = (n, c) => { console.log((c ? '  OK  ' : ' FAIL ') + n); if (!c) fails++; };
const um = (mes, d) => ({ is_user: true, name: 'Jovan', mes, send_date: d });
const TIER_SET = new Set(['DECISIVE', 'SUCCESS', 'SUCCESS_COST', 'TRADE', 'STALEMATE', 'SETBACK', 'FAILURE', 'DISASTER']);
const fresh = () => { md.arbiter = { sheet: { actors: {} }, log: [], oneShot: null, cache: null, composure: 6 }; return md.arbiter; };
const fullPoise = (u) => u.poise === u.maxPoise;

(async () => {
    ok('fightStyle defaults to tracked', E.getDefaults().fightStyle === 'tracked');

    /* ── 1. duel: verdicts only, nothing tallied, never ends ────────────── */
    let meta = fresh();
    E.startDuel(meta, 'Jovan', 'Kaiser', 'melee');
    let allTiers = true, allOutcome = true;
    for (let i = 0; i < 40; i++) {
        const r = E.resolveDuelExchange(meta, 0, 'exchange');
        if (!TIER_SET.has(r.tier)) allTiers = false;
        if (r.outcome !== true) allOutcome = false;
    }
    const d = meta.duel;
    ok('40 exchanges: every one carries a valid tier verdict', allTiers);
    ok('every result is flagged outcome-only', allOutcome);
    ok('no health: both sides still at full poise', fullPoise(d.player) && fullPoise(d.opp));
    ok('no injuries, momentum, or openings accrued', d.player.injuries === 0 && d.opp.injuries === 0 && d.player.momentum === 0 && d.opp.momentum === 0 && !d.player.opening && !d.opp.opening);
    ok('no engine-declared end after 40 rounds', d.over === false && d.victor === null && d.round === 40);

    /* ── 2. recover has nothing to restore → plain exchange ─────────────── */
    const rec = E.resolveDuelExchange(meta, 0, 'recover');
    ok('recover resolves as a plain verdict (no recovery mechanics)', rec.recover === undefined && TIER_SET.has(rec.tier) && fullPoise(meta.duel.player));

    /* ── 3. combos: texture without tally ───────────────────────────────── */
    const combo = E.resolveDuelSequence(meta, { sequence: [
        { strike: 'feint high', circumstance: 0 },
        { strike: 'cut low', circumstance: 0 },
        { strike: 'pommel strike', circumstance: 0 },
    ] });
    ok('combo keeps per-strike texture (3 steps, each a tier)', combo.steps.length === 3 && combo.steps.every(st => TIER_SET.has(st.tier)));
    ok('combo tallies nothing and cannot finish the duel', combo.over === false && combo.victor === null && meta.duel.over === false && fullPoise(meta.duel.player) && fullPoise(meta.duel.opp));

    /* ── 4. directives: storyteller ends it; no beaten/forced injuries ──── */
    const dirDecisive = E.buildDuelDirective(meta, { action: 'a perfect riposte' }, { tier: 'DECISIVE', outcome: true, opening: false });
    ok('duel directive hands the ending to the storyteller', dirDecisive.includes('until the STORY ends it') && dirDecisive.includes('will not call a winner'));
    ok('no engine finish or forced injury — even on DECISIVE', !dirDecisive.includes('DECISIVE POSITION') && !dirDecisive.includes('is beaten') && !dirDecisive.includes('Inflict a concrete lasting injury'));
    const comboDir = E.buildDuelSequenceDirective(meta, { action: 'a three-strike chain' }, combo);
    ok('combo directive also hands the ending to the storyteller', comboDir.includes('until the STORY ends it') && !comboDir.includes('is beaten'));

    /* ── 5. composure is nerve, not health — still shapes odds ──────────── */
    meta.composure = 6;
    const steady = E.resolveDuelExchange(meta, 0, 'exchange');
    meta.composure = 1;
    const shaken = E.resolveDuelExchange(meta, 0, 'exchange');
    ok('a shaken fighter rolls at worse odds than a steady one', shaken.delta < steady.delta);
    meta.composure = 6;

    /* ── 6. battle: only the MC scored; field untouched; never ends ─────── */
    meta = fresh();
    meta.sheet.actors = { 'Jovan': { default: 7, domains: { melee: 8 } } };
    E.startBattle(meta, ['Stella'], ['Bandit x2'], 'melee');
    const b = meta.battle;
    const fight = E.resolveBattleRound(meta, { kind: 'fight', target: null, action: 'cut through', circumstance: 0 });
    const cmd = E.resolveBattleRound(meta, { kind: 'command', target: null, action: 'hold the line', circumstance: 0 });
    ok('fight and command turns each yield a verdict', TIER_SET.has(fight.mcRes.tier) && !fight.mcRes.command && TIER_SET.has(cmd.mcRes.tier) && cmd.mcRes.command === true);
    ok('the field is not simulated (no side reports)', fight.reports.length === 0 && cmd.reports.length === 0);
    ok('no unit takes damage or breaks', b.allies.every(u => fullPoise(u) && u.standing) && b.enemies.every(u => fullPoise(u) && u.standing));
    ok('no rout, no victor, no MC-down — rounds still count', !b.over && !b.victor && !b.mcDown && b.round === 2);
    const bDir = E.buildBattleDirective(meta, { action: 'cut through' }, fight);
    ok('battle directive hands the field and the ending to the storyteller', bDir.includes('until the STORY ends it') && !bDir.includes('DECISIVE:') && !bDir.includes('Inflict a concrete lasting injury'));

    /* ── 7. war: orders scored; strengths, conditions, collapse frozen ──── */
    meta = fresh();
    E.startWar(meta, ['1st Lance', '2nd Lance'], ['Iron Legion', 'Black Wing'], 'Warlord', 0);
    const w = meta.battle;
    const strengthOf = (units) => units.reduce((t, u) => t + u.poise, 0);
    const a0 = strengthOf(w.allies), e0 = strengthOf(w.enemies);
    const man = E.resolveWarRound(meta, { kind: 'maneuver', acting: '1st Lance', target: 'Iron Legion', action: 'flank the ridge', circumstance: 0 });
    const str = E.resolveWarRound(meta, { kind: 'stratagem', acting: null, target: null, action: 'fire the granary', circumstance: 0 });
    const per = E.resolveWarRound(meta, { kind: 'personal', acting: null, target: 'Black Wing', action: 'sortie at the standard', circumstance: 0 });
    ok('maneuver, stratagem, and personal orders each yield a verdict', TIER_SET.has(man.focalRes.tier) && str.focalRes.stratagem === true && per.focalRes.personal === true);
    ok('army strengths never move', strengthOf(w.allies) === a0 && strengthOf(w.enemies) === e0);
    ok('no conditions accrue, no line collapses, no victor', !(w.conditions && w.conditions.length) && !w.over && !w.victor && w.round === 3);
    const wDir = E.buildWarDirective(meta, { action: 'flank the ridge' }, man);
    ok('war directive hands the field to the storyteller', wDir.includes('until the STORY ends it') && !wDir.includes('DECISIVE:'));

    /* ── 8. the storyteller's end still ends it (via the real referee) ──── */
    meta = fresh();
    E.startDuel(meta, 'Jovan', 'Kaiser', 'melee');
    respObj = JSON.stringify({ combat_ended: true });
    await I([um('I lower my blade — it is finished [roll]', 'e1')], 0, () => {}, 'normal');
    ok('a fiction-driven combat_ended closes an outcome-style duel', meta.duel === null || meta.duel === undefined || !meta.duel);

    /* ── 9. TRACKED CONTROL: the gate provably distinguishes styles ─────── */
    fightStyle = 'tracked';
    meta = fresh();
    E.startDuel(meta, 'Jovan', 'Kaiser', 'melee');
    let moved = false;
    for (let i = 0; i < 25 && !moved; i++) {
        E.resolveDuelExchange(meta, 0, 'exchange');
        if (!meta.duel) break;
        if (!fullPoise(meta.duel.player) || !fullPoise(meta.duel.opp)) moved = true;
        if (meta.duel.over) break;
    }
    ok('tracked style still deals poise damage (styles are truly distinct)', moved);

    console.log(fails ? 'SUITE FAILED (' + fails + ')' : 'ALL v51 OUTCOME-STYLE INVARIANTS GREEN');
    process.exit(fails ? 1 : 0);
})();
