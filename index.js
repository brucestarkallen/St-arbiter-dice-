/*
 * Arbiter v0.1 — outcome adjudication for SillyTavern roleplay.
 *
 * Philosophy: the storyteller LLM must never decide whether the player
 * succeeds or fails. A local trigger gate (free, instant) decides whether an
 * action *might* need a check; a micro LLM call on a separate, fast
 * connection profile classifies the attempt (domain, opposition,
 * circumstance); the extension does ALL math and randomness itself using a
 * logistic (Elo) probability curve and real crypto RNG; the result is
 * injected as a binding, ephemeral, depth-0 system note. The storyteller
 * narrates a predetermined outcome.
 *
 * Design rules:
 *  - Never block or delay generation on failure: every path degrades to
 *    "no injection" with a log line.
 *  - Never mutate chat messages.
 *  - Outcomes are cached per user message: swipes / regenerates / retries
 *    re-use the same outcome (no re-roll cheese).
 */

(() => {
    'use strict';

    const MODULE = 'arbiter';
    const VERSION = '0.16.0';
    const INJECT_KEY = 'ARBITER_OUTCOME';
    const LOG = '[Arbiter]';

    // Live activity state, surfaced as a floating indicator with a cancel.
    const activity = { label: '', busy: false, canceled: false, startedAt: 0 };

    function setActivity(label) {
        activity.label = label || '';
        activity.busy = !!label;
        activity.canceled = false;
        activity.startedAt = label ? Date.now() : 0;
        try { renderActivity(); } catch (e) { /* not ready */ }
    }

    function clearActivity() {
        // Keep the indicator up for a minimum perceptible time so a fast
        // operation (or a fast failure) doesn't flash-and-vanish invisibly.
        const MIN_VISIBLE = 900;
        const elapsed = activity.startedAt ? Date.now() - activity.startedAt : MIN_VISIBLE;
        const finish = () => {
            activity.label = '';
            activity.busy = false;
            activity.startedAt = 0;
            try { renderActivity(); } catch (e) { /* not ready */ }
        };
        if (elapsed < MIN_VISIBLE && activity.busy) {
            setTimeout(finish, MIN_VISIBLE - elapsed);
        } else {
            finish();
        }
    }

    function activityCanceled() {
        return activity.canceled;
    }

    /* ------------------------------------------------------------------ */
    /* Small utils                                                        */
    /* ------------------------------------------------------------------ */

    function ctx() {
        return SillyTavern.getContext();
    }

    function dlog(...args) {
        try {
            if (getSettings().debug) console.log(LOG, ...args);
        } catch (e) { /* settings not ready */ }
    }

    function warn(...args) {
        console.warn(LOG, ...args);
    }

    function toast(kind, msg, title) {
        try {
            if (typeof toastr !== 'undefined' && toastr[kind]) toastr[kind](msg, title || 'Arbiter');
        } catch (e) { /* no toastr */ }
    }

    function clamp(n, lo, hi) {
        n = Number(n);
        if (!Number.isFinite(n)) return lo;
        return Math.min(hi, Math.max(lo, n));
    }

    function escHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[m]));
    }

    function hashStr(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h.toString(16);
    }

    function sleep(ms) {
        return new Promise(res => setTimeout(res, ms));
    }

    function escapeRegex(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /* ------------------------------------------------------------------ */
    /* ENGINE — pure functions, no SillyTavern dependencies.               */
    /* Exposed on globalThis.ArbiterEngine for tests / console tinkering.  */
    /* ------------------------------------------------------------------ */

    /** Logistic (Elo-style) probability of success for an edge delta. */
    function probFromDelta(delta) {
        return 1 / (1 + Math.pow(10, -delta / 4));
    }

    /**
     * Slice the [0,1) interval into outcome tiers around the success
     * threshold P. Slice widths depend on P so that:
     *  - experts win clean and rarely botch (disaster ~0.4% at P=0.9),
     *  - underdogs who do win mostly win narrow and costly,
     *  - failures near the threshold become fail-forward setbacks.
     * u near 0 = best possible outcome, u near 1 = worst.
     */
    function sliceOutcome(P, u, mods) {
        const m = mods || { dec: 1, cost: 1, sb: 1, dis: 1 };
        const F = 1 - P;
        let decisiveW = P * (0.05 + 0.15 * P) * m.dec;         // deepest success
        let costW = P * (0.15 + 0.35 * F) * m.cost;            // scraped-by success
        let setbackW = F * (0.30 + 0.20 * P) * m.sb;           // fail-forward
        let disasterW = F * (0.03 + 0.12 * F) * m.dis;         // far tail
        costW = Math.min(costW, Math.max(0, P - decisiveW));   // safety clamps
        disasterW = Math.min(disasterW, Math.max(0, F - setbackW));

        if (u < P) {
            if (u < decisiveW) return 'DECISIVE';
            if (u >= P - costW) return 'SUCCESS_COST';
            return 'SUCCESS';
        }
        if (u < P + setbackW) return 'SETBACK';
        if (u >= 1 - disasterW) return 'DISASTER';
        return 'FAILURE';
    }

    /**
     * Exchange tie detection. When an exchange lands genuinely even (the roll
     * u sits close to the win/lose boundary P), remap the directional tier to
     * a tie: a near-miss on either side that was almost the opposite becomes a
     * TRADE (both land, both bleed) or STALEMATE (both whiff, tense reset),
     * chosen by which side of the boundary and how the poise stands. band=0
     * disables ties entirely. Only applied to fighting exchanges, never lone
     * checks. Decisive/disaster extremes never tie.
     */
    function tieCheck(tier, P, u, band) {
        if (!band || band <= 0) return tier;
        if (tier === 'DECISIVE' || tier === 'DISASTER') return tier; // clear extremes stand
        if (Math.abs(u - P) > band) return tier;                    // not close enough
        // Even exchange. Marginal successes/setbacks (the ones adjacent to the
        // boundary) trade blows; deeper-but-still-near ones lock into stalemate.
        const veryClose = Math.abs(u - P) <= band * 0.5;
        return veryClose ? 'TRADE' : 'STALEMATE';
    }

    /** One uniform sample from real (crypto) RNG, [0,1). */
    function rngFloat() {
        try {
            const a = new Uint32Array(1);
            (globalThis.crypto || window.crypto).getRandomValues(a);
            return a[0] / 4294967296;
        } catch (e) {
            return Math.random();
        }
    }

    const TIERS = {
        DECISIVE: {
            name: 'DECISIVE SUCCESS',
            text: 'It succeeds decisively and cleanly — better than intended.',
        },
        SUCCESS: {
            name: 'SUCCESS',
            text: 'It succeeds as intended.',
        },
        SUCCESS_COST: {
            name: 'SUCCESS WITH COST',
            text: 'It succeeds, BUT introduce a real cost or complication (position, resource, attention, or minor harm).',
        },
        SETBACK: {
            name: 'SETBACK',
            text: 'It fails, but fail forward: the failed attempt yields an opening, information, or partial progress — never a free win.',
        },
        FAILURE: {
            name: 'FAILURE',
            text: 'It fails. Let consequences follow naturally.',
        },
        DISASTER: {
            name: 'DISASTER',
            text: 'It fails badly. Escalate with a serious consequence beyond the immediate attempt.',
        },
        TRADE: {
            name: 'TRADE',
            text: 'Both land — an even, clashing exchange where each fighter takes a hit. Neither gains the upper hand; show the mutual toll.',
        },
        STALEMATE: {
            name: 'STALEMATE',
            text: 'Neither lands cleanly — the exchange is read and countered, a tense reset with no clear advantage. Show the deadlock, not a winner.',
        },
    };

    /** Difficulty / opposition tier presets (unopposed tasks + unnamed foes). */
    const TIER_RATINGS = {
        trivial: 1, easy: 3, moderate: 5, hard: 7, extreme: 9,
        mook: 2, trained: 4, elite: 6, formidable: 8,
        // relative tiers, resolved against the actor's own rating:
        inferior: 'A-2', peer: 'A', superior: 'A+2',
    };

    /** Difficulty presets: a flat player edge plus tier-width modifiers. */
    const PRESETS = {
        gritty: { bonus: 0, mods: { dec: 0.8, cost: 1.3, sb: 1.0, dis: 1.5 } },
        realistic: { bonus: 0, mods: { dec: 1, cost: 1, sb: 1, dis: 1 } },
        heroic: { bonus: 1, mods: { dec: 1.25, cost: 1.0, sb: 1.0, dis: 0.5 } },
    };

    /**
     * Duel exchange effects, from the PLAYER's roll perspective.
     * opp/self = poise damage dealt; injuries are persistent -1 rating tags;
     * SETBACK grants the player a fail-forward "opening" (+1 next round).
     */
    const EXCHANGE_EFFECTS = {
        DECISIVE: { opp: 2, self: 0, injureOpp: true, winner: 'self' },
        SUCCESS: { opp: 1.5, self: 0, winner: 'self' },
        SUCCESS_COST: { opp: 1, self: 0.5, winner: 'self' },
        SETBACK: { opp: 0, self: 1, winner: 'opp', opening: true },
        FAILURE: { opp: 0, self: 1.5, winner: 'opp' },
        DISASTER: { opp: 0, self: 2, injureSelf: true, winner: 'opp' },
        // Ties — neither side clearly prevails in the exchange:
        TRADE: { opp: 1, self: 1, winner: 'none' },      // both land; both bleed
        STALEMATE: { opp: 0, self: 0, winner: 'none' },  // both whiff; tense reset
    };

    /**
     * Pure: apply one exchange tier to (player, opponent) side states.
     * Side shape: { poise, injuries, momentum, opening }. Returns new sides
     * plus over/victor. Momentum: exchange winner +0.5 (cap 1), loser resets.
     */
    function applyExchangeEffects(pl, op, tier) {
        const fx = EXCHANGE_EFFECTS[tier] || EXCHANGE_EFFECTS.FAILURE;
        const p = Object.assign({}, pl);
        const o = Object.assign({}, op);
        p.poise = Math.round((p.poise - fx.self) * 2) / 2;
        o.poise = Math.round((o.poise - fx.opp) * 2) / 2;
        if (fx.injureOpp) o.injuries = (o.injuries || 0) + 1;
        if (fx.injureSelf) p.injuries = (p.injuries || 0) + 1;
        if (fx.winner === 'self') {
            p.momentum = Math.min(1, (p.momentum || 0) + 0.5);
            o.momentum = 0;
        } else if (fx.winner === 'opp') {
            o.momentum = Math.min(1, (o.momentum || 0) + 0.5);
            p.momentum = 0;
        } else {
            // Tie: a trade bleeds momentum from both (scrappy, no control);
            // a stalemate leaves momentum as-is (a held, tense reset).
            if (fx.self > 0 || fx.opp > 0) { p.momentum = 0; o.momentum = 0; }
        }
        p.opening = !!fx.opening; // player fail-forward (SETBACK): exploitable next round
        // Symmetric fail-forward for the opponent: on SUCCESS_COST the player
        // wins but leaves themselves exposed, so the opponent earns the same
        // +1 opening the player gets on a SETBACK. Without this the player
        // accrues openings the opponent never can — a quiet bias toward the MC.
        if (tier === 'SUCCESS_COST') o.opening = true;
        else if (fx.winner === 'self') o.opening = false; // clean win closes any prior opening
        let over = false;
        let victor = null;
        if (p.poise <= 0 || o.poise <= 0) {
            over = true;
            if (p.poise <= 0 && o.poise <= 0) victor = fx.winner === 'self' ? 'player' : (fx.winner === 'opp' ? 'opp' : 'draw');
            else victor = o.poise <= 0 ? 'player' : 'opp';
        }
        return { player: p, opp: o, over, victor };
    }

    /** Narration-safe condition word for a poise fraction. */
    function poiseWord(cur, max) {
        const r = max > 0 ? cur / max : 0;
        if (r > 0.8) return 'fresh';
        if (r > 0.5) return 'pressed';
        if (r > 0.2) return 'staggered';
        if (r > 0) return 'breaking';
        return 'beaten';
    }

    /** Ambient event engines: escalating pity-timer randomness (pure).
     *  Three tiers at NE-P's numbers: Surprise d100 vs 95 (−3/quiet turn),
     *  Encounter d200 vs 198 (−2), World d500 vs 498 (−2). */
    const EVENT_TYPES = ['a complication', 'an opportunity', 'an unexpected arrival', 'a small discovery', 'an environment shift', 'a rumor or overheard word'];
    const EVENT_TONES = ['tense', 'mundane', 'comic', 'ominous', 'warm', 'dramatic'];
    const ENCOUNTER_TYPES = ['a rival or obstacle appears', 'a challenge is issued', 'someone needs help', 'a threat surfaces', 'a tempting shortcut opens', 'an old acquaintance resurfaces', 'a passing stranger crosses the player\'s path — invent a fitting minor NPC (beggar, peddler, courier, pickpocket, street kid, drunk, off-duty guard)', 'someone new arrives with a small want or offer — invent them concretely'];
    const ENCOUNTER_TONES = ['tense', 'dangerous', 'promising', 'awkward', 'urgent', 'quiet'];
    const WORLD_WHO = ['a powerful faction', 'an unknown actor', 'an old enemy', 'the authorities', 'a rising newcomer'];
    const WORLD_WHAT = ['makes a decisive move', 'suffers a sudden collapse', 'reveals a long-held secret', 'declares open intent', 'shifts the balance of power'];
    const WORLD_WHERE = ['far away, arriving as news', 'closer than expected', 'at the heart of things'];

    const ENGINE_DEFAULTS = {
        surprise: { sides: 100, dc0: 95, decay: 3 },
        encounter: { sides: 200, dc0: 198, decay: 2 },
        world: { sides: 500, dc0: 498, decay: 2 },
    };

    function rollTier(dc, sides, decay, resetDC, rng) {
        const r = rng || Math.random;
        const roll = Math.floor(r() * sides) + 1;
        if (roll >= dc) return { fired: true, roll, nextDC: resetDC };
        return { fired: false, roll, nextDC: Math.max(5, dc - decay) };
    }

    /** Back-compat wrapper: the Surprise tier with flavor. */
    function rollEventTick(dc, rng) {
        const r = rng || Math.random;
        const t = rollTier(dc, 100, 3, 96, r);
        if (t.fired) {
            return {
                fired: true,
                type: EVENT_TYPES[Math.floor(r() * EVENT_TYPES.length)],
                tone: EVENT_TONES[Math.floor(r() * EVENT_TONES.length)],
                nextDC: t.nextDC,
            };
        }
        return { fired: false, nextDC: Math.max(20, dc - 3) };
    }

    /** World Threads: dice-driven background plot ladders (NE-P World Arcs +
     *  goal heartbeats, unified). Pure tick: returns {step, done} where step
     *  is rung delta (-1, 0, +1, +2). */
    function tickThread(bias, rng) {
        const P = probFromDelta(clamp(bias, -13, 13));
        const tier = sliceOutcome(P, (rng || Math.random)());
        if (tier === 'DECISIVE') return 2;
        if (tier === 'SUCCESS' || tier === 'SUCCESS_COST') return 1;
        if (tier === 'DISASTER') return -1;
        return 0;
    }

    /**
     * War stratagem outcomes ("burn the woods", "feign retreat"): commander
     * roll tier → battlefield effect. Conditions are persistent field
     * modifiers; DISASTER means the stratagem BACKFIRES and favors the enemy.
     */
    const STRATAGEM_EFFECTS = {
        DECISIVE: { condMod: 2, favors: 'allies' },
        SUCCESS: { condMod: 1, favors: 'allies' },
        SUCCESS_COST: { condMod: 1, favors: 'allies', selfCost: 0.5 },
        SETBACK: { condMod: 0, opening: true },
        FAILURE: { condMod: 0, enemyMomentum: true },
        DISASTER: { condMod: 1, favors: 'enemies' },
    };

    /**
     * Local, zero-LLM recovery detector — FAST MODE ONLY. Adjudicated mode uses
     * the LLM's move_kind:"recover" (see DUEL_SYSTEM). Fast mode has no
     * classifier, so without this every disengage-to-heal in a fast-mode duel
     * was resolved as an ATTACK — incoherent narration, and on a good roll the
     * "heal" dealt free poise damage to the opponent, a mild tilt toward the
     * player that this project forbids. Deliberately conservative: a false
     * positive turns a real attack into a heal (denying the player their offence
     * AND ceding tempo), so the bar is an explicit self-restoration that
     * DISENGAGES, with no offensive strike at the foe. Anything that still
     * contests the opponent (a defensive counter, a heal-and-strike) stays an
     * attack — exactly the rule the adjudicated prompt applies. Recall is
     * intentionally imperfect: a missed cue simply falls back to attack (the
     * prior behaviour, so never a regression). Dialogue is stripped first, like
     * the trigger gate, so a spoken "I'll heal you!" never triggers it.
     */
    function looksLikeRecovery(text) {
        const t = stripDialogue(String(text || '')).toLowerCase();
        if (!t) return false;
        // Explicit disengage-to-restore idioms (poise / composure / wounds); the
        // move cedes tempo rather than contesting the opponent.
        const restore = new RegExp('\\b(?:' + [
            'disengag\\w*', 'retreat\\w*', 'withdraw\\w*',
            'fall(?:s|ing)?\\s+back', 'fell\\s+back',
            'pull(?:s|ing)?\\s+back', 'back(?:s|ing)?\\s+(?:off|away)',
            'catch(?:es|ing)?\\s+(?:\\w+\\s+){0,2}breath', 'caught\\s+(?:\\w+\\s+){0,2}breath',
            'regain(?:s|ed|ing)?\\s+(?:\\w+\\s+){0,2}composure',
            'steady(?:ing)?\\s+(?:my|him|her|them)self', 'steadies\\s+(?:my|him|her|them)self',
            'heal(?:s|ed|ing)?\\s+(?:my|him|her|them)self',
            'mend(?:s|ed|ing)?\\s+(?:my|his|her|their)\\b',
            'tend(?:s|ed|ing)?\\s+(?:to\\s+)?(?:my|his|her|their)\\b',
            'bandag\\w*',
            '(?:drink(?:s|ing)?|drank|quaff\\w*|gulp(?:s|ed|ing)?|swig\\w*)\\s+(?:a\\s+|the\\s+|down\\s+)?(?:\\w+\\s+){0,2}(?:potion|elixir|draught|tonic)',
            'take[sn]?\\s+a\\s+(?:moment|breath)\\s+to\\s+(?:recover|breathe|breath|heal|rest)',
        ].join('|') + ')\\b');
        if (!restore.test(t)) return false;
        // Vetoed if the move also drives an offensive strike at the foe — that is
        // a contesting action ("defensive counter"), which stays an attack.
        const offense = /\b(?:attack\w*|strik\w*|struck|slash\w*|stab\w*|thrust\w*|shoot\w*|shot|fir(?:e|es|ed|ing)|blast\w*|lung(?:e|es|ed|ing)|charg\w*|swing\w*|swung|hack\w*|cleav\w*|impal\w*|pierc\w*|smash\w*|punch\w*|kick\w*|riposte\w*|counter-?attack\w*|shov\w*|tackl\w*)\b/;
        return !offense.test(t);
    }

    globalThis.ArbiterEngine = {
        probFromDelta, sliceOutcome, rngFloat, TIERS, TIER_RATINGS,
        PRESETS, EXCHANGE_EFFECTS, applyExchangeEffects, poiseWord,
        rollEventTick, rollTier, tickThread, ENGINE_DEFAULTS,
        EVENT_TYPES, ENCOUNTER_TYPES, extractJsonCandidates, collectMemoryBlock,
        STRATAGEM_EFFECTS, tieCheck, ratingFor, composurePenalty, applyComposureChange,
        looksLikeRecovery, combatantComposurePenalty, applyMoraleShock, passiveComposureRecovery,
    };

    /* ------------------------------------------------------------------ */
    /* Settings (global) and per-chat metadata                             */
    /* ------------------------------------------------------------------ */

    const DEFAULT_VERBS = [
        'attack', 'strike', 'struck', 'swing', 'swung', 'stab', 'slash', 'shoot', 'shot', 'fire', 'fired',
        'punch', 'kick', 'grapple', 'tackle', 'throw', 'threw', 'hurl', 'lunge', 'charge', 'parry',
        'dodge', 'duck', 'block', 'counter', 'deflect', 'disarm', 'feint', 'aim', 'snipe', 'wrestle',
        'choke', 'slam', 'shove', 'push', 'pull', 'drag', 'grab', 'seize', 'snatch', 'cast', 'invoke',
        'channel', 'sneak', 'creep', 'hide', 'hid', 'stalk', 'steal', 'stole', 'pickpocket', 'lockpick',
        'hack', 'bypass', 'disable', 'sabotage', 'climb', 'scale', 'leap', 'leapt', 'jump', 'vault',
        'sprint', 'dash', 'race', 'chase', 'pursue', 'flee', 'fled', 'escape', 'evade', 'outrun',
        'swim', 'dive', 'dove', 'balance', 'catch', 'caught', 'intercept', 'persuade', 'convince',
        'bluff', 'lie', 'lied', 'deceive', 'mislead', 'intimidate', 'threaten', 'coerce', 'seduce',
        'charm', 'negotiate', 'haggle', 'bribe', 'distract', 'provoke', 'taunt', 'search', 'investigate',
        'examine', 'inspect', 'track', 'spot', 'eavesdrop', 'decipher', 'decode', 'recall', 'analyze',
        'pilot', 'maneuver', 'ram', 'board', 'breach', 'force', 'pry', 'smash', 'break', 'broke',
        'shatter', 'draw', 'drew', 'fight', 'fought', 'duel', 'spar', 'defend', 'resist', 'withstand',
        'endure', 'brace', 'explode', 'blast', 'detonate', 'ignite', 'burn', 'scorch', 'incinerate',
        'freeze', 'shock', 'electrocute', 'summon', 'conjure', 'unleash', 'erupt', 'obliterate',
        'crush', 'cleave', 'slice', 'impale', 'pierce', 'skewer', 'bombard', 'barrage', 'volley',
        'rush', 'flank', 'pounce', 'blow', 'blew', 'sever', 'launch', 'sweep', 'swept', 'order', 'ordered',
        'command', 'commanded', 'direct', 'directed', 'rally', 'rallied', 'lead', 'led', 'overwhelm',
        'surround', 'ambush', 'raid', 'storm', 'siege', 'besiege', 'assault', 'engage', 'mow', 'scatter',
        'cripple', 'maim', 'wound', 'curse', 'hex', 'poison', 'blind', 'break', 'shatter', 'mend', 'heal', 'cleanse', 'cure',
    ].join(', ');

    const DEFAULTS = {
        enabled: true,
        profileId: '',            // Connection Manager profile for the adjudicator
        seedProfileId: '',        // OPTIONAL separate profile for seeding (bulk/background); empty = use adjudicator profile
        timeoutMs: 6000,          // hard budget for the micro-call; on expiry: skip
        ctxMsgs: 6,               // recent messages given to the adjudicator
        sensitivity: 'normal',    // conservative | normal | aggressive
        injectDepth: 0,
        injectRole: 'system',     // system | user | assistant
        defaultRating: 5,         // rating when an actor/domain is unknown
        toastResults: true,
        showMath: false,          // include the math line in the toast
        forceTag: '[roll]',
        skipTag: '[skip]',
        verbs: DEFAULT_VERBS,
        mode: 'adjudicated',      // adjudicated | fast (fast = zero-LLM pre-rolled pool)
        preset: 'realistic',      // gritty | realistic | heroic
        autoDuel: true,           // let the adjudicator open/close duels from the fiction
        autoBattle: true,         // let the adjudicator open group battles from the fiction
        autoWar: true,            // open commander-mode wars when the player leads armies
        warStrength: 10,          // default formation strength pool (sheet 'poise' overrides)
        eventEngine: true,        // ambient escalating random events (pity-timer RNG)
        autoSeed: true,           // background sheet/thread seeding — no commands needed
        autoSeedEvery: 100,       // FALLBACK timer only; post-fight seeding is primary
        seedTranscriptK: 80,      // seed transcript window in thousands of chars (2026-scale default)
        seedMemoryK: 60,          // seed memory block in thousands of chars — ingest full Summaryception context
        seedOutTokens: 4000,      // max tokens the seeder may emit (large casts fit comfortably)
        encounterTypes: '',       // comma list overriding built-in encounter hooks ('' = defaults)
        duelPoise: 5,             // default poise pool (sheet "poise" per actor overrides)
        tieBand: 0.06,            // exchange tie window (0 disables; ~even rolls become TRADE/STALEMATE)
        composure: true,          // model mental strain (fear/horror/trauma erode focus)
        composureMax: 6,          // starting mental-strain pool (like poise, for the mind)
        showHud: true,
        showActivity: true,      // floating 'Arbiter is working…' indicator
        debug: false,
    };

    function getSettings() {
        const c = ctx();
        const store = c.extensionSettings || {};
        if (!store[MODULE]) store[MODULE] = {};
        const s = store[MODULE];
        for (const k of Object.keys(DEFAULTS)) {
            if (s[k] === undefined) s[k] = DEFAULTS[k];
        }
        return s;
    }

    function saveSettings() {
        try { ctx().saveSettingsDebounced?.(); } catch (e) { warn('saveSettings failed', e); }
    }

    function getMeta() {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata;
        if (!md) return null;
        if (!md[MODULE]) md[MODULE] = {};
        const m = md[MODULE];
        if (!m.sheet || typeof m.sheet !== 'object') m.sheet = { actors: {} };
        if (!m.sheet.actors || typeof m.sheet.actors !== 'object') m.sheet.actors = {};
        if (!Array.isArray(m.log)) m.log = [];
        if (m.oneShot === undefined) m.oneShot = null;
        if (m.cache === undefined) m.cache = null;
        if (!m.engines || typeof m.engines !== 'object') {
            m.engines = {
                surprise: { dc: Number.isFinite(m.eventDC) ? m.eventDC : ENGINE_DEFAULTS.surprise.dc0 },
                encounter: { dc: ENGINE_DEFAULTS.encounter.dc0 },
                world: { dc: ENGINE_DEFAULTS.world.dc0 },
            };
            delete m.eventDC;
        }
        if (!Array.isArray(m.threads)) m.threads = [];
        if (!Number.isFinite(m.tickCount)) m.tickCount = 0;
        if (!Number.isFinite(m.turnCount)) m.turnCount = 0;
        if (!Number.isFinite(m.lastAutoSeedAt)) m.lastAutoSeedAt = -999999;
        return m;
    }

    function saveMeta() {
        try {
            const c = ctx();
            if (c.saveMetadataDebounced) c.saveMetadataDebounced();
            else if (c.saveMetadata) c.saveMetadata();
        } catch (e) { warn('saveMeta failed', e); }
    }

    /* ------------------------------------------------------------------ */
    /* Trigger gate — local, instant, zero cost                            */
    /* ------------------------------------------------------------------ */

    let verbsRegexCache = { src: null, re: null };

    function getVerbsRegex() {
        const s = getSettings();
        if (verbsRegexCache.src === s.verbs && verbsRegexCache.re) return verbsRegexCache.re;
        const words = String(s.verbs || '')
            .split(',')
            .map(w => w.trim().toLowerCase())
            .filter(w => /^[a-z][a-z-]*$/.test(w));
        const body = words.map(escapeRegex).join('|') || 'attack';
        const re = new RegExp('\\b(?:' + body + ')(?:s|es|ed|ing)?\\b', 'gi');
        verbsRegexCache = { src: s.verbs, re };
        return re;
    }

    const ATTEMPT_RE = /\b(?:try|tries|tried|trying|attempt(?:s|ed|ing)?|go(?:es)?\s+for|aim(?:s|ed|ing)?\s+to)\b/i;
    const OOC_RE = /^\s*(?:\(\(|\/\/|OOC\b)/i;

    function stripDialogue(text) {
        return String(text || '')
            .replace(/"[^"\n]{0,400}"/g, ' ')
            .replace(/\u201C[^\u201D\n]{0,400}\u201D/g, ' ');
    }

    function gatePasses(rawText) {
        const s = getSettings();
        if (OOC_RE.test(rawText)) return false;
        const text = stripDialogue(rawText);
        const re = getVerbsRegex();
        re.lastIndex = 0;
        let hits = 0;
        while (re.exec(text) !== null) {
            hits++;
            if (hits >= 3) break;
        }
        const attempt = ATTEMPT_RE.test(text);
        switch (s.sensitivity) {
            case 'conservative': return attempt || hits >= 2;
            case 'aggressive': return attempt || hits >= 1 || /\?\s*$/.test(rawText.trim());
            case 'normal':
            default: return attempt || hits >= 1;
        }
    }

    function hasTag(rawText, tag) {
        if (!tag || !tag.trim()) return false;
        return new RegExp(escapeRegex(tag.trim()), 'i').test(rawText);
    }

    /* ------------------------------------------------------------------ */
    /* LLM plumbing — separate profile first, raw fallback second          */
    /* ------------------------------------------------------------------ */

    function getProfiles() {
        try {
            const c = ctx();
            const list = c.extensionSettings?.connectionManager?.profiles;
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }

    /** True if the seeder/adjudicator has some route it can call: either a
     *  chosen Connection Manager profile, or a usable raw generate fallback
     *  on a currently-connected main API. */
    function hasWorkingRoute() {
        try {
            const c = ctx();
            const s = getSettings();
            if (s.profileId && c.ConnectionManagerRequestService?.sendRequest) return true;
            // Raw fallback: only counts if a main API looks connected.
            if (typeof c.generateRaw === 'function') {
                const online = c.onlineStatus;
                if (online === undefined || (online && online !== 'no_connection')) return true;
            }
            return false;
        } catch (e) { return true; } // never block on uncertainty
    }

    /**
     * One guarded LLM call. Returns a trimmed string ('' on any failure).
     * Never throws. Respects the hard time budget.
     */
    async function callLLM(systemText, userText, maxTokens, budgetMs, profileOverride) {
        const c = ctx();
        const s = getSettings();
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => { try { controller.abort(); } catch (e) { } }, budgetMs);
        // Poll the activity cancel flag so the floating ✕ aborts this request.
        const cancelPoll = setInterval(() => { if (activityCanceled()) { try { controller.abort(); } catch (e) { } } }, 150);
        if (cancelPoll && typeof cancelPoll.unref === 'function') cancelPoll.unref();

        const extract = (res) => {
            if (typeof res === 'string') return res.trim();
            if (res && typeof res === 'object') return String(res.content ?? res.text ?? '').trim();
            return '';
        };

        try {
            const pid = profileOverride || s.profileId;
            const svc = c.ConnectionManagerRequestService;
            if (pid && svc && typeof svc.sendRequest === 'function') {
                const messages = [
                    { role: 'system', content: systemText },
                    { role: 'user', content: userText },
                ];
                const res = await Promise.race([
                    svc.sendRequest(pid, messages, maxTokens, { signal: controller.signal, extractData: true }),
                    sleep(budgetMs + 250).then(() => null),
                ]);
                const out = extract(res);
                if (out) return out;
                dlog('profile call returned empty after', Date.now() - started, 'ms');
                return '';
            }

            // Fallback: raw generation on the current API (may be your slow
            // thinking model — the timeout still protects the turn).
            if (typeof c.generateRaw === 'function') {
                const attempt = async (fn) => {
                    const res = await Promise.race([fn(), sleep(budgetMs).then(() => null)]);
                    return extract(res);
                };
                let out = '';
                try {
                    out = await attempt(() => c.generateRaw({
                        prompt: userText,
                        systemPrompt: systemText,
                        responseLength: maxTokens,
                    }));
                } catch (e) { dlog('generateRaw(object) failed', e); }
                if (!out) {
                    try {
                        out = await attempt(() => c.generateRaw(userText, null, false, false, systemText, maxTokens));
                    } catch (e) { dlog('generateRaw(positional) failed', e); }
                }
                return out;
            }

            warn('No LLM route available (set an adjudicator Connection Profile).');
            return '';
        } catch (e) {
            dlog('callLLM failed/aborted:', e?.message || e);
            return '';
        } finally {
            clearTimeout(timer);
            clearInterval(cancelPoll);
        }
    }

    /** Extract balanced {...} objects from model output. Thinking models may
     *  emit reasoning (possibly containing braces) before the real JSON, so
     *  we scan for up to `limit` parseable candidates; callers try each. */
    function extractJsonCandidates(text, limit) {
        const out = [];
        if (!text) return out;
        const cleaned = String(text).replace(/```(?:json)?/gi, '');
        let i = 0;
        while (out.length < (limit || 5)) {
            const start = cleaned.indexOf('{', i);
            if (start === -1) break;
            let depth = 0, inStr = false, escNext = false, end = -1;
            for (let j = start; j < cleaned.length; j++) {
                const ch = cleaned[j];
                if (escNext) { escNext = false; continue; }
                if (ch === '\\') { escNext = true; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
            }
            if (end === -1) break;
            try { out.push(JSON.parse(cleaned.slice(start, end + 1))); } catch (e) { /* skip */ }
            i = (end === -1 ? start : end) + 1;
        }
        return out;
    }

    function extractJson(text) {
        const c = extractJsonCandidates(text, 1);
        return c.length ? c[0] : null;
    }

    /* ------------------------------------------------------------------ */
    /* Adjudication                                                        */
    /* ------------------------------------------------------------------ */

    const ADJ_SYSTEM = [
        'You are Arbiter, an outcome adjudicator for a roleplay. Decide whether the player\'s latest action needs a resolution check, and if so, classify it. You NEVER decide success or failure — only the parameters. Output STRICT JSON only: one object, no markdown, no commentary.',
        '',
        'Schema:',
        '{"check": true|false,',
        ' "action": "<the attempt, 3-10 words>",',
        ' "domain": "<one lowercase word for the SKILL the act actually uses, chosen by its PHYSICAL nature: a strike, punch, kick, feint, swing, or grapple is melee (never stealth just because it is a feint or sneaky); a shot or throw is ranged; moving unseen is stealth; persuasion/intimidation is social. Prefer a domain the actor has on the sheet when it fits. e.g. melee, ranged, stealth, social, athletics, intellect, willpower, pilot, craft>",',
        ' "actor": "<MUST be exactly the player character named in <player>. Checks are always for the PLAYER attempting the action; second-person you in <action> is the player, never the narrator or storyteller card name>",',
        ' "opposition_kind": "actor" | "tier",',
        ' "opposition": "<a character name from the sheet if a known character opposes; otherwise a task tier: trivial|easy|moderate|hard|extreme, or an unnamed-opponent tier: mook|trained|elite|formidable|inferior|peer|superior>",',
        ' "circumstance": <integer -3..3>,',
        ' "why": "<one short clause justifying circumstance>",',
        ' "stakes": "<what success or failure means here, one short clause>",',
        ' "duel_start": null | "<opponent name — set this whenever the action opens physical combat against ONE named person: a strike, a draw, a lunge, an attack with a weapon or power, even if you expect it to be quick or one-sided. When in doubt between a single check and a duel for an attack on a person, prefer the duel.>",',
        ' "opponent_rating": null | <integer 0-10 — set ONLY when you also set duel_start or battle_start AND the opponent is NOT already in the sheet. Estimate combat capability from the scene and description. Scale (by effective threat, NOT species): 2 untrained, 4 trained, 5 competent professional, 6 veteran, 7 elite, 8 master, 9 legendary, 10 apex. This applies to ANY combatant — a person, beast, dragon, alien, machine, or monster — rated by how dangerous it actually is: a feral dog 3, a trained warhound 5, a dire beast 7, an ancient dragon or apex monster 9-10. When a creature is so far beyond human scale that raw skill barely matters, rate it 10 AND set scale_mismatch below.>",',
        ' "scale_mismatch": null | <integer -4..4 — set ONLY in combat where the two sides are CATEGORICALLY mismatched in size, mass, or power (a human vs a dragon, a footsoldier vs a war-mech, a child vs a bear). This is an ADDITIONAL swing on top of ratings, representing that skill alone cannot close the gap. From the PLAYER\'s perspective: strongly negative when the player is hopelessly outmatched by something vast (a normal human attacking a dragon head-on: -3 or -4), strongly positive when the player is the vast one crushing something tiny. 0 or null when both sides are roughly the same scale (human vs human, dragon vs dragon), even if their skill differs. An equalizer in the fiction — a dragon-slaying spear, a mech of their own, a weak point exposed — reduces the magnitude.>",',
        ' "composure_change": null | <integer -3..3 — the mental toll or relief of THIS moment on the player. Negative when the player faces horror, terror, gruesome death, existential dread, betrayal, or crushing loss (a mild shock -1, witnessing atrocity -2, mind-shattering cosmic horror -3). Positive when the player finds safety, rest, reassurance, or a grounding victory (+1 to +2). 0 for ordinary moments. This is the FICTION\'s emotional weight, independent of any dice outcome. Judge from what happens to the player, not whether an action succeeds.>",',
        ' "condition_change": null | {"who": "<player or a named character>", "add": "<short lasting condition or piece of gear just established, e.g. broken left arm, poisoned, exhausted, OR a signature weapon/armor like masterwork blade, enchanted plate — or null>", "remove": "<a prior condition/gear the fiction just resolved (healed, lost, broken), or null>", "mod": <integer -4..3, effect while it lasts; afflictions negative (broken arm -2), good gear positive (fine sword +1, legendary weapon +2 or +3)>, "domain": "<optional: the ONE domain this affects, e.g. melee for a sword, ranged for a bow; omit for whole-body effects like a curse or exhaustion>", "gear": true|false}. Set the moment the story establishes/removes something PERSISTENT (lasts beyond this scene). Gear (weapons, armor, tools) sets gear:true so it is not stripped by healing. Leave null when nothing persistent changed.',
        ' "battle_start": null | {"allies": ["<name>", ...], "enemies": ["<name or generic squad like Guard x3>", ...]} — set this when combat begins against MULTIPLE opponents at once, OR when the player attacks/affects a GROUP (e.g. "sweep through the guards", "hit all of them"). If the opponents are unnamed, invent a fitting generic squad with a count (e.g. "Guard x3", "Bandit x4"). List allies EXCLUDING the player. This is for skirmish-scale group combat (a handful per side), NOT army-scale warfare.},',
        ' "war_start": null | {"allies": ["<formation, e.g. Left Flank, 3rd Cavalry, Zero Squadron>", ...], "enemies": ["<enemy formation>", ...], "enemy_commander": "<name or null>"} — set when the player takes COMMAND of army-scale combat: leading forces, issuing orders to units/formations/squadrons. Invent sensible formation names from the fiction if unnamed (2-5 per side).,',
        ' "army_scale": null | "<short name for the larger conflict — set ONLY when the player is caught in mass warfare WITHOUT commanding it (a soldier or bystander in the melee); if they command, use war_start instead>"}',
        '',
        'Rules:',
        '- check=false for dialogue, routine or trivial actions with no meaningful chance of interesting failure, pure narration, OOC talk, or actions attempted by characters other than the player.',
        '- circumstance is PHYSICAL tactical advantage ONLY: position, momentum, surprise, preparation, exposure of the target, terrain, impairment, haste. Reward concrete tactics and exploited PHYSICAL weaknesses (+); penalize bad position, impairment, or haste (-). Use 0 when nothing notable applies.',
        '- NEVER penalize an action for being illegal, dishonorable, a foul, against duel etiquette, unsporting, or immoral, and never mention rules, sanctions, penalties, or disqualification. You do not know this world\'s rules; whether a move is "allowed" is the storyteller\'s to narrate, not yours to score. A dirty tactic that gives a real physical edge (a groin kick, sand in the eyes, a low blow) is a POSITIVE circumstance, not a negative one. Judge only what works, not what is permitted.',
        '- The opponent is WHOEVER the fiction says the player is fighting in <recent>/<action>. Use that name. If they are also on the sheet, use the sheet spelling; if not, still name them from the fiction and set opposition_kind "actor" (they will be rated as trained). NEVER substitute a different sheet name just because it is familiar — the scene\'s named opponent always wins over a sheet entry.',
        '- opposition must be a PERSON or creature the player fights. Never use a place, academy, house, faction, or organization name as the opposition.',
    ].join('\n');

    function compactRecent(chat, n, excludeMes) {
        const out = [];
        for (let i = chat.length - 1; i >= 0 && out.length < n; i--) {
            const m = chat[i];
            if (!m || !m.mes || m.is_system || m === excludeMes) continue;
            const name = m.name || (m.is_user ? 'Player' : 'AI');
            out.push(name + ': ' + String(m.mes).replace(/\s+/g, ' ').slice(0, 300));
        }
        return out.reverse().join('\n');
    }

    function buildAdjUserPrompt(chat, lastUserMes, meta) {
        const s = getSettings();
        const playerName = ctx().name1 || 'Player';
        const sheet = JSON.stringify(meta.sheet || { actors: {} });
        const recent = compactRecent(chat, clamp(s.ctxMsgs, 1, 10), lastUserMes);
        const action = String(lastUserMes.mes).slice(0, 700);
        return '<player>\nThe player character is "' + playerName + '". The text in <action> is written BY the player: "I" and second-person "you" in it both mean ' + playerName + ' acting. The storyteller\'s messages in <recent> may be labeled with a card/narrator name that is NOT a combatant.\n</player>\n\n<sheet>\n' + sheet + '\n</sheet>\n\n<recent>\n' + recent + '\n</recent>\n\n<action>\n' + action + '\n</action>';
    }

    function normalizeAdj(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.check === false) return { check: false };
        if (obj.check !== true) return null;
        const domain = String(obj.domain || 'general').toLowerCase().trim() || 'general';
        // The actor is ALWAYS the player. Model discretion here caused an
        // identity swap (narrator card scored as the actor vs the player's
        // own stats), so we enforce it: keep the model's claim only to
        // repair an inverted duel_start below.
        const playerName = ctx().name1 || 'Player';
        const modelActor = String(obj.actor || '').trim();
        const actor = playerName;
        const kind = obj.opposition_kind === 'actor' ? 'actor' : 'tier';
        let opposition = String(obj.opposition || 'moderate').trim() || 'moderate';

        // Swap repair: an inverted referee names the PLAYER as the foe.
        const isPlayerish = (n) => {
            if (!n) return false;
            const a = n.toLowerCase(), b = playerName.toLowerCase();
            return a === b || a.includes(b) || b.includes(a);
        };
        let duelStart = (typeof obj.duel_start === 'string' && obj.duel_start.trim()) ? obj.duel_start.trim().slice(0, 60) : null;
        if (isPlayerish(duelStart)) {
            // The model put the player on the wrong side. If it named someone
            // else as "actor", that someone is the real opponent; else drop.
            duelStart = (modelActor && !isPlayerish(modelActor)) ? modelActor.slice(0, 60) : null;
            dlog('inverted duel_start repaired →', duelStart || '(dropped)');
        }
        if (kind === 'actor' && isPlayerish(opposition)) {
            // Opposition can never be the player either.
            opposition = (modelActor && !isPlayerish(modelActor)) ? modelActor : 'hard';
            dlog('inverted opposition repaired →', opposition);
        }
        let battleStart = normalizeRoster(obj.battle_start);
        if (battleStart) {
            battleStart.enemies = (battleStart.enemies || []).filter(n => !isPlayerish(n));
            if (!battleStart.enemies.length) battleStart = null;
        }

        return {
            check: true,
            action: String(obj.action || 'the attempt').slice(0, 140),
            domain,
            actor,
            kind,
            opposition,
            circumstance: clamp(Math.round(Number(obj.circumstance) || 0), -3, 3),
            scale_mismatch: (obj.scale_mismatch === null || obj.scale_mismatch === undefined) ? 0 : clamp(Math.round(Number(obj.scale_mismatch)), -4, 4),
            why: String(obj.why || '').slice(0, 160),
            stakes: String(obj.stakes || '').slice(0, 160),
            duel_start: duelStart,
            battle_start: battleStart,
            war_start: normalizeWarStart(obj.war_start),
            opponent_rating: (obj.opponent_rating === null || obj.opponent_rating === undefined) ? null : clamp(Math.round(Number(obj.opponent_rating)), 0, 10),
            condition_change: normalizeConditionChange(obj.condition_change),
            composure_change: (obj.composure_change === null || obj.composure_change === undefined) ? 0 : clamp(Math.round(Number(obj.composure_change)), -3, 3),
            army_scale: (typeof obj.army_scale === 'string' && obj.army_scale.trim()) ? obj.army_scale.trim().slice(0, 80) : null,
        };
    }

    function normalizeConditionChange(cc) {
        if (!cc || typeof cc !== 'object') return null;
        const who = (typeof cc.who === 'string' && cc.who.trim()) ? cc.who.trim().slice(0, 60) : null;
        if (!who) return null;
        const add = (typeof cc.add === 'string' && cc.add.trim()) ? cc.add.trim().slice(0, 80) : null;
        const remove = (typeof cc.remove === 'string' && cc.remove.trim()) ? cc.remove.trim().slice(0, 80) : null;
        if (!add && !remove) return null;
        const gear = cc.gear === true;
        const mod = clamp(Math.round(Number(cc.mod) || (add ? (gear ? 1 : -1) : 0)), -4, 3);
        const domain = (typeof cc.domain === 'string' && cc.domain.trim()) ? cc.domain.trim().toLowerCase().slice(0, 24) : null;
        return { who, add, remove, mod, domain, gear };
    }

    /** Apply a persistent condition change to the sheet, resolving "player"
     *  to the persona. Creates the actor entry if needed so the condition
     *  sticks even for someone not yet rated. Returns a note for narration. */
    function applyConditionChange(meta, cc) {
        if (!cc) return null;
        const playerName = ctx().name1 || 'Player';
        const name = /^(you|player|me|myself)$/i.test(cc.who) ? playerName : cc.who;
        meta.sheet = meta.sheet || { actors: {} };
        let entry = findActor(meta, name);
        if (!entry) { entry = { default: clamp(getSettings().defaultRating, 0, 10), domains: {}, _auto: true, conditions: [] }; meta.sheet.actors[name] = entry; }
        entry.conditions = Array.isArray(entry.conditions) ? entry.conditions : [];
        const notes = [];
        if (cc.remove) {
            const before = entry.conditions.length;
            const rl = cc.remove.toLowerCase();
            entry.conditions = entry.conditions.filter(c => {
                const cn = String(c.name || '').toLowerCase();
                return !(cn === rl || cn.includes(rl) || rl.includes(cn));
            });
            if (entry.conditions.length < before) notes.push(name + ' recovers from ' + cc.remove);
        }
        if (cc.add) {
            const al = cc.add.toLowerCase();
            if (!entry.conditions.some(c => String(c.name || '').toLowerCase() === al)) {
                const item = { name: cc.add, mod: cc.mod };
                if (cc.domain) item.domain = cc.domain;
                if (cc.gear) item.gear = true;
                entry.conditions.push(item);
                if (entry.conditions.length > 8) entry.conditions.shift();
                const scope = cc.domain ? ' to ' + cc.domain : '';
                notes.push(cc.gear
                    ? name + ' gains ' + cc.add + ' (' + (cc.mod >= 0 ? '+' : '') + cc.mod + scope + ')'
                    : name + ' now suffers ' + cc.add + ' (' + (cc.mod >= 0 ? '+' : '') + cc.mod + scope + ' while it lasts)');
            }
        }
        if (!entry.conditions.length) delete entry.conditions;
        return notes.length ? notes.join('; ') : null;
    }

    function normalizeWarStart(ws) {
        const r = normalizeRoster(ws);
        if (!r) return null;
        r.enemy_commander = (ws && typeof ws.enemy_commander === 'string' && ws.enemy_commander.trim())
            ? ws.enemy_commander.trim().slice(0, 60) : null;
        return r;
    }

    function normalizeRoster(bs) {
        if (!bs || typeof bs !== 'object') return null;
        const cleanList = (a) => Array.isArray(a)
            ? a.map(x => String(x || '').trim().slice(0, 60)).filter(Boolean).slice(0, 8)
            : [];
        const allies = cleanList(bs.allies);
        const enemies = cleanList(bs.enemies);
        if (!enemies.length) return null;
        return { allies, enemies };
    }

    /* ------------------------------------------------------------------ */
    /* Battle mode — party / battlefield engagements                       */
    /* ------------------------------------------------------------------ */

    const BATTLE_SYSTEM = [
        'You are Arbiter, refereeing one round of an ACTIVE group battle in a roleplay. Score the player\'s move for this round. You NEVER decide who wins — only the parameters. Output STRICT JSON only: one object, no markdown, no commentary.',
        '',
        'Schema:',
        '{"exchange": true|false,',
        ' "move_kind": "fight" | "command",',
        ' "target": "<standing enemy name from the roster, or null>",',
        ' "action": "<the move, 3-10 words>",',
        ' "circumstance": <integer -3..3>,',
        ' "why": "<one short clause>",',
        ' "combat_ended": true|false}',
        '',
        'Rules:',
        '- move_kind "fight": the player personally engages one enemy (use "target"). move_kind "command": the player directs the whole side — orders, tactics, formation, rallying.',
        '- In an active duel nearly every player turn IS an exchange — the enemy presses regardless. Passive or hesitant turns are exchanges with NEGATIVE circumstance.',
        '- circumstance is PHYSICAL advantage only (position, momentum, feints that create real openings, exposure). NEVER penalize a move for being a foul, dirty, illegal, dishonorable, or against duel rules, and never mention sanctions or penalties — a dirty move that works (a low blow, a groin kick) is a POSITIVE circumstance. You judge what is effective, not what is permitted; the fiction owns the rules.',
        '- exchange=false only for a genuine lull with no fighting possible.',
        '- circumstance rewards concrete tactics, terrain, exploited weaknesses (+); penalizes impairment, bad position, chaos (-). 0 if nothing notable.',
        '- combat_ended=true ONLY if the fiction has already clearly ended the battle (rout, surrender, separation, scene left combat).',
    ].join('\n');

    function normalizeBattleAdj(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.combat_ended === true) return { combat_ended: true };
        if (obj.exchange === false) return { exchange: false };
        if (obj.exchange !== true) return null;
        return {
            exchange: true,
            kind: obj.move_kind === 'command' ? 'command' : 'fight',
            target: (typeof obj.target === 'string' && obj.target.trim()) ? obj.target.trim().slice(0, 60) : null,
            action: String(obj.action || 'the exchange').slice(0, 140),
            circumstance: clamp(Math.round(Number(obj.circumstance) || 0), -3, 3),
            why: String(obj.why || '').slice(0, 160),
        };
    }

    function battleActive(meta) {
        return !!(meta && meta.battle && meta.battle.active && !meta.battle.over);
    }

    /** Expand roster names ("Bandit x3") into unit objects with sheet lookups. */
    function buildUnits(meta, names, domain, isEnemySide) {
        const s = getSettings();
        const fallback = clamp(s.defaultRating, 0, 10);
        const units = [];
        for (const raw of names) {
            const m = raw.match(/^(.*?)(?:\s*[x×]\s*(\d{1,2}))\s*$/i);
            const base = (m ? m[1] : raw).trim();
            const count = m ? clamp(parseInt(m[2], 10), 1, 8) : 1;
            for (let i = 1; i <= count && units.length < 10; i++) {
                const name = count > 1 ? base + ' ' + i : base;
                const entry = findActor(meta, base) || findActor(meta, name);
                const rating = entry ? ratingFor(entry, domain, fallback)
                    : (isEnemySide ? clamp(TIER_RATINGS.trained, 0, 10) : fallback);
                const poise = poiseFor(entry, s.duelPoise);
                const cMax = clamp(s.composureMax, 3, 12);
                units.push({ name, rating, poise, maxPoise: poise, injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: false, composure: cMax, composureMax: cMax });
            }
        }
        return units;
    }

    function startBattle(meta, allyNames, enemyNames, domain, scaleMismatch) {
        const s = getSettings();
        const d = String(domain || 'melee').toLowerCase();
        const playerName = ctx().name1 || 'Player';
        const pEntry = findActor(meta, playerName);
        const mc = {
            name: playerName,
            rating: ratingFor(pEntry, d, clamp(s.defaultRating, 0, 10)),
            poise: poiseFor(pEntry, s.duelPoise), maxPoise: poiseFor(pEntry, s.duelPoise),
            injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: true,
        };
        const pn = playerName.toLowerCase();
        const allies = buildUnits(meta, (allyNames || []).filter(n => {
            const x = n.toLowerCase();
            return x !== pn && !x.includes(pn) && !pn.includes(x);
        }), d, false);
        const enemies = buildUnits(meta, enemyNames || [], d, true);
        if (!enemies.length) return null;
        meta.battle = {
            active: true, over: false, victor: null, mcDown: false, round: 0, domain: d,
            scaleMismatch: clamp(Math.round(Number(scaleMismatch) || 0), -4, 4),
            allies: [mc].concat(allies),
            enemies,
        };
        dlog('battle started:', meta.battle.allies.length, 'vs', enemies.length, '(' + d + ')');
        return meta.battle;
    }

    function endBattle(meta, silent) {
        if (meta && meta.battle) meta.battle = null;
        renderHud();
        if (!silent) toast('info', 'Battle ended.');
    }

    const standing = (units) => units.filter(u => u.standing);
    const moraleOf = (units) => units.length ? standing(units).length / units.length : 0;
    const moraleWord = (f) => f > 0.75 ? 'steady' : f > 0.4 ? 'wavering' : f > 0 ? 'breaking' : 'broken';

    /** One ally-vs-enemy pairing, from the ally's perspective. Returns a report line. */
    function resolvePairing(a, e, extraDelta, preset) {
        const openingBonus = a.opening ? 1 : 0; a.opening = false;
        const delta = clamp((a.rating - a.injuries + a.momentum + openingBonus) - (e.rating - e.injuries + e.momentum) + combatantComposurePenalty(a) - combatantComposurePenalty(e) + extraDelta + preset.bonus, -13, 13);
        const _P = probFromDelta(delta); const _u = rngFloat();
        const tier = tieCheck(sliceOutcome(_P, _u, preset.mods), _P, _u, getSettings().tieBand);
        const r = applyExchangeEffects(a, e, tier);
        Object.assign(a, r.player); Object.assign(e, r.opp);
        if (a.poise <= 0) a.standing = false;
        if (e.poise <= 0) e.standing = false;
        if (!e.standing) return a.name + ' puts ' + e.name + ' out of the fight.';
        if (!a.standing) return e.name + ' takes ' + a.name + ' down.';
        const fx = EXCHANGE_EFFECTS[tier] || {};
        if (fx.winner === 'self') return a.name + ' gets the better of ' + e.name + ' (' + e.name + ' is ' + poiseWord(e.poise, e.maxPoise) + ').';
        return e.name + ' pressures ' + a.name + ' (' + a.name + ' is ' + poiseWord(a.poise, a.maxPoise) + ').';
    }

    /** Resolve one battle round for the player's scored move. */
    function resolveBattleRound(meta, mv) {
        const b = meta.battle;
        const preset = getPreset();
        const mAll = clamp(Math.round((moraleOf(b.allies) - moraleOf(b.enemies)) * 2) / 2, -1, 1);
        const mc = b.allies.find(u => u.isPlayer);
        const aStand0 = standing(b.allies.filter(u => !u.isPlayer)).length; // for post-round morale shock
        const eStand0 = standing(b.enemies).length;
        const reports = [];
        let mcRes = null;
        let sideMod = 0;
        let mcTargetName = null;

        if (mv.kind === 'command') {
            const oppLead = Math.max(3, ...standing(b.enemies).map(u => u.rating));
            const openingBonus = mc.opening ? 1 : 0; mc.opening = false;
            const delta = clamp(mc.rating - mc.injuries + openingBonus - oppLead + mv.circumstance + preset.bonus + mAll + composurePenalty(meta) + (b.scaleMismatch || 0), -13, 13);
            const P = probFromDelta(delta); const u = rngFloat();
            const tier = sliceOutcome(P, u, preset.mods);
            sideMod = ({ DECISIVE: 2, SUCCESS: 1, SUCCESS_COST: 1, SETBACK: -1, FAILURE: -1, DISASTER: -2 })[tier] || 0;
            if (tier === 'SUCCESS_COST' || tier === 'DISASTER') { mc.poise = Math.max(0, mc.poise - 0.5); if (mc.poise <= 0) mc.standing = false; }
            mcRes = { delta, P, u, tier, command: true };
        } else {
            let target = standing(b.enemies).find(u => mv.target && u.name.toLowerCase() === mv.target.toLowerCase());
            if (!target) target = standing(b.enemies).slice().sort((x, y) => y.rating - x.rating)[0];
            if (target) {
                mcTargetName = target.name;
                const openingBonus = mc.opening ? 1 : 0; mc.opening = false;
                const delta = clamp((mc.rating - mc.injuries + mc.momentum + openingBonus) - (target.rating - target.injuries + target.momentum) + mv.circumstance + preset.bonus + mAll + composurePenalty(meta) - combatantComposurePenalty(target) + (b.scaleMismatch || 0), -13, 13);
                const P = probFromDelta(delta); const u = rngFloat();
                const tier = tieCheck(sliceOutcome(P, u, preset.mods), P, u, getSettings().tieBand);
                const r = applyExchangeEffects(mc, target, tier);
                Object.assign(mc, r.player); Object.assign(target, r.opp);
                if (mc.poise <= 0) mc.standing = false;
                if (target.poise <= 0) target.standing = false;
                mcRes = { delta, P, u, tier, command: false };
            }
        }

        // Auto-resolve the rest of the field: pair standing allies vs enemies.
        const freeAllies = standing(b.allies).filter(u => !u.isPlayer);
        const freeEnemies = standing(b.enemies).filter(u => u.name !== mcTargetName);
        const A = freeAllies.slice().sort((x, y) => y.rating - x.rating);
        const Ev = freeEnemies.slice().sort((x, y) => y.rating - x.rating);
        const pairs = Math.min(A.length, Ev.length);
        const gang = A.length === Ev.length ? 0 : (A.length > Ev.length ? 1 : -1); // outnumbering side supports its pairs
        for (let i = 0; i < pairs; i++) {
            reports.push(resolvePairing(A[i], Ev[i], sideMod + mAll + gang + (b.scaleMismatch || 0), preset));
        }

        b.round += 1;
        if (!standing(b.enemies).length) { b.over = true; b.victor = 'allies'; }
        else if (!standing(b.allies).length) { b.over = true; b.victor = 'enemies'; }
        else if (!mc.standing) {
            // The MC is out: conclude the field fairly, without player agency.
            b.mcDown = true;
            let guard = 0;
            while (!b.over && guard++ < 6) {
                const As = standing(b.allies).filter(u => !u.isPlayer).sort((x, y) => y.rating - x.rating);
                const Es = standing(b.enemies).sort((x, y) => y.rating - x.rating);
                if (!As.length) { b.over = true; b.victor = 'enemies'; break; }
                if (!Es.length) { b.over = true; b.victor = 'allies'; break; }
                const n = Math.min(As.length, Es.length);
                const g2 = As.length === Es.length ? 0 : (As.length > Es.length ? 1 : -1);
                for (let i = 0; i < n; i++) reports.push(resolvePairing(As[i], Es[i], g2, preset));
                if (!standing(b.enemies).length) { b.over = true; b.victor = 'allies'; }
                else if (!standing(b.allies).filter(u => !u.isPlayer).length) { b.over = true; b.victor = 'enemies'; }
            }
            if (!b.over) {
                const aSum = standing(b.allies).filter(u => !u.isPlayer).reduce((t, u) => t + u.rating, 0);
                const eSum = standing(b.enemies).reduce((t, u) => t + u.rating, 0);
                b.over = true; b.victor = aSum >= eSum ? 'allies' : 'enemies';
            }
        }
        // Individual nerve frays as the round's casualties mount; a controlled
        // round steadies. Only matters while the fight continues.
        if (!b.over) applyMoraleShock(meta, b, aStand0 - standing(b.allies.filter(u => !u.isPlayer)).length, eStand0 - standing(b.enemies).length);
        return { mcRes, reports };
    }

    function buildBattleDirective(meta, adj, out) {
        const b = meta.battle;
        const mc = b.allies.find(u => u.isPlayer);
        const lines = [
            '[ARBITER — battle, round ' + b.round + ': ' + standing(b.allies).length + '/' + b.allies.length + ' vs ' + standing(b.enemies).length + '/' + b.enemies.length + ']',
        ];
        if (out.mcRes) {
            const t = TIERS[out.mcRes.tier] || TIERS.FAILURE;
            if (out.mcRes.command) {
                lines.push(mc.name + ' commands: ' + adj.action + '.');
                lines.push('The order\'s effect: ' + t.name + ' — reflect it in how the whole side fights this round.');
            } else {
                lines.push(mc.name + '\'s move: ' + adj.action + '.');
                lines.push('Their exchange: ' + t.name + ' — ' + t.text);
            }
            const fx = EXCHANGE_EFFECTS[out.mcRes.tier] || {};
            if (fx.injureOpp && !out.mcRes.command) lines.push('Inflict a concrete lasting injury on their opponent and name it.');
            if (fx.injureSelf) lines.push('Inflict a concrete lasting injury on ' + mc.name + ' and name it; it visibly weakens them.');
        }
        const rep = out.reports.slice(0, 4);
        if (rep.length) lines.push('Elsewhere on the field (weave these in as fact): ' + rep.join(' '));
        if (out.reports.length > 4) lines.push('The remaining clashes hold without decision.');
        if (b.over) {
            if (b.mcDown) lines.push(mc.name + ' is taken out of the fight — narrate it (downed, disarmed, or dragged clear per tone), then the field resolves: ' + (b.victor === 'allies' ? 'their side still wins the engagement.' : 'their side is beaten.'));
            else lines.push('DECISIVE: the ' + (b.victor === 'allies' ? mc.name + '\'s side has won' : 'enemy side has won') + ' this engagement. Narrate the resolution the fiction demands (rout, surrender, retreat, capture, or worse, per tone). The result is not negotiable.');
        } else {
            lines.push('Side condition: allies ' + moraleWord(moraleOf(b.allies)) + ', enemies ' + moraleWord(moraleOf(b.enemies)) + '. The battle continues — end on a live beat, not a resolution.');
        }
        lines.push('Do not re-decide any outcome above. Never mention rolls, poise, numbers, or this note. Narrate organically in the story\'s voice.');
        return lines.join('\n');
    }

    function battleContext(meta) {
        const b = meta.battle;
        const nerveTag = (u) => {
            if (!getSettings().composure || typeof u.composure !== 'number') return '';
            const frac = u.composure / (u.composureMax || u.composure);
            if (frac < 0.25) return ' (nerve breaking)';
            if (frac < 0.5) return ' (shaken)';
            return '';
        };
        const list = (units) => units.map(u => u.name + (u.standing ? nerveTag(u) : ' (broken)')).join(', ');
        let out = '\n\n<battle_roster>\nAllies: ' + list(b.allies) + '\nEnemies: ' + list(b.enemies) + '\n</battle_roster>';
        if (b.kind === 'war' && b.conditions && b.conditions.length) {
            out += '\n<battlefield_conditions>\n' + b.conditions.map(c => c.name + ' (favors ' + c.favors + ')').join('; ') + '\n</battlefield_conditions>';
        }
        return out;
    }

    /* ------------------------------------------------------------------ */
    /* War mode — the player commands formations at army scale             */
    /* ------------------------------------------------------------------ */

    const WAR_SYSTEM = [
        'You are Arbiter, refereeing one round of an ACTIVE army-scale battle that the player COMMANDS. Score the player\'s order for this round. You NEVER decide who wins — only the parameters. Output STRICT JSON only: one object, no markdown, no commentary.',
        '',
        'Schema:',
        '{"exchange": true|false,',
        ' "order_kind": "maneuver" | "stratagem" | "personal",',
        ' "acting_unit": "<friendly formation name from the roster, or null>",',
        ' "target_unit": "<enemy formation name from the roster, or null>",',
        ' "action": "<the order, 3-12 words>",',
        ' "circumstance": <integer -3..3>,',
        ' "why": "<one short clause>",',
        ' "combat_ended": true|false}',
        '',
        'Rules:',
        '- "maneuver": a formation is ordered against an enemy element (flank, charge, hold, envelop, pincer, screen, withdraw-and-counter). Fill acting_unit and target_unit from the roster.',
        '- "stratagem": the order reshapes the FIELD rather than one clash — burn the woods, feign retreat, poison the wells, cut supply, deception, weather/terrain exploitation. Leave units null.',
        '- "personal": the commander personally sorties into the fight (a duelist-commander, an ace in their machine). Fill target_unit.',
        '- circumstance is the tactical soundness of THIS order given terrain, intel, enemy posture, timing, and prior conditions: a flank against an exposed side +2; a frontal charge uphill into prepared lines -2; 0 when unremarkable.',
        '- In an active engagement nearly every commander turn IS an order; hesitation is a maneuver at negative circumstance. exchange=false only for genuine lulls (parley, night camp).',
        '- combat_ended=true ONLY if the fiction has clearly ended the engagement (rout already narrated, surrender, retreat completed, relief arrived).',
    ].join('\n');

    function normalizeWarAdj(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.combat_ended === true) return { combat_ended: true };
        if (obj.exchange === false) return { exchange: false };
        if (obj.exchange !== true) return null;
        const kind = obj.order_kind === 'stratagem' ? 'stratagem' : (obj.order_kind === 'personal' ? 'personal' : 'maneuver');
        const pick = (v) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 60) : null;
        return {
            exchange: true,
            kind,
            acting: pick(obj.acting_unit),
            target: pick(obj.target_unit),
            action: String(obj.action || 'the order').slice(0, 160),
            circumstance: clamp(Math.round(Number(obj.circumstance) || 0), -3, 3),
            why: String(obj.why || '').slice(0, 160),
        };
    }

    function warActive(meta) {
        return battleActive(meta) && meta.battle.kind === 'war';
    }

    function startWar(meta, allyNames, enemyNames, enemyCommander, scaleMismatch) {
        const s = getSettings();
        const d = 'war';
        const playerName = ctx().name1 || 'Player';
        const pEntry = findActor(meta, playerName);
        const fallback = clamp(s.defaultRating, 0, 10);
        // Commander tactics: prefer a tactics/command/intellect domain, else default.
        const cmdA = ratingFor(pEntry, 'tactics', ratingFor(pEntry, 'command', ratingFor(pEntry, 'intellect', fallback)));
        const ecEntry = enemyCommander ? findActor(meta, enemyCommander) : null;
        const cmdE = ecEntry ? ratingFor(ecEntry, 'tactics', ratingFor(ecEntry, 'command', 5)) : 5;
        const mc = {
            name: playerName,
            rating: ratingFor(pEntry, 'melee', fallback),
            poise: poiseFor(pEntry, s.duelPoise), maxPoise: poiseFor(pEntry, s.duelPoise),
            injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: true,
        };
        const mkUnits = (names, isEnemy) => {
            const units = [];
            for (const raw of (names || [])) {
                const m2 = raw.match(/^(.*?)(?:\s*[x×]\s*(\d{1,2}))\s*$/i);
                const base = (m2 ? m2[1] : raw).trim();
                const count = m2 ? clamp(parseInt(m2[2], 10), 1, 6) : 1;
                for (let i = 1; i <= count && units.length < 8; i++) {
                    const name = count > 1 ? base + ' ' + i : base;
                    const entry = findActor(meta, base) || findActor(meta, name);
                    const rating = entry ? ratingFor(entry, 'war', ratingFor(entry, 'melee', fallback)) : (isEnemy ? 4 : fallback);
                    const strength = poiseFor(entry, clamp(s.warStrength, 4, 40));
                    const cMax = clamp(s.composureMax, 3, 12);
                    units.push({ name, rating, poise: strength, maxPoise: strength, injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: false, composure: cMax, composureMax: cMax });
                }
            }
            return units;
        };
        const pn = playerName.toLowerCase();
        const allies = mkUnits((allyNames || []).filter(n => { const x = n.toLowerCase(); return x !== pn && !x.includes(pn) && !pn.includes(x); }), false);
        const enemies = mkUnits(enemyNames || [], true);
        if (!enemies.length) return null;
        meta.battle = {
            kind: 'war', active: true, over: false, victor: null, mcDown: false, round: 0, domain: d,
            cmdA, cmdE, enemyCommander: enemyCommander || null,
            conditions: [],
            scaleMismatch: clamp(Math.round(Number(scaleMismatch) || 0), -4, 4),
            allies: [mc].concat(allies),
            enemies,
        };
        dlog('war started:', allies.length, 'formations vs', enemies.length, '· cmd', cmdA, 'vs', cmdE);
        return meta.battle;
    }

    function conditionsField(b) {
        return (b.conditions || []).reduce((t, c) => t + (c.favors === 'allies' ? c.mod : -c.mod), 0);
    }

    const nonPlayer = (units) => units.filter(u => !u.isPlayer);

    function pickUnit(units, name) {
        const st = standing(units);
        if (name) {
            const t = name.toLowerCase();
            const hit = st.find(u => u.name.toLowerCase() === t) || st.find(u => u.name.toLowerCase().includes(t) || t.includes(u.name.toLowerCase()));
            if (hit) return hit;
        }
        return st.slice().sort((x, y) => y.rating - x.rating)[0] || null;
    }

    /** Resolve one war round for the commander's scored order. */
    function resolveWarRound(meta, mv) {
        const b = meta.battle;
        const preset = getPreset();
        const F = conditionsField(b);
        const mAll = clamp(Math.round((moraleOf(nonPlayer(b.allies)) - moraleOf(b.enemies)) * 2) / 2, -1, 1);
        const cmdEdge = clamp(Math.round((b.cmdA - b.cmdE) / 2 * 2) / 2, -2, 2);
        const mc = b.allies.find(u => u.isPlayer);
        const aStand0 = standing(nonPlayer(b.allies)).length; // for post-round morale shock
        const eStand0 = standing(b.enemies).length;
        const reports = [];
        let focalRes = null;
        let condNote = null;
        let acting = null, target = null;

        if (mv.kind === 'stratagem') {
            const delta = clamp(b.cmdA - b.cmdE + mv.circumstance + mAll + preset.bonus + composurePenalty(meta), -13, 13);
            const P = probFromDelta(delta); const u = rngFloat();
            const tier = sliceOutcome(P, u, preset.mods);
            focalRes = { delta, P, u, tier, stratagem: true };
            const fx = STRATAGEM_EFFECTS[tier] || {};
            if (fx.condMod > 0) {
                b.conditions = b.conditions || [];
                b.conditions.push({ name: mv.action.slice(0, 60), favors: fx.favors, mod: fx.condMod });
                if (b.conditions.length > 3) b.conditions.shift();
                condNote = { favors: fx.favors, mod: fx.condMod };
            }
            if (fx.selfCost) {
                const strongest = pickUnit(nonPlayer(b.allies), null);
                if (strongest) { strongest.poise = Math.max(0, strongest.poise - fx.selfCost); if (strongest.poise <= 0) strongest.standing = false; }
            }
            if (fx.opening && mc) mc.opening = true; // commander finds an angle for next order
            if (fx.enemyMomentum) { const e = pickUnit(b.enemies, null); if (e) e.momentum = Math.min(1, (e.momentum || 0) + 0.5); }
        } else if (mv.kind === 'personal' && mc) {
            target = pickUnit(b.enemies, mv.target);
            if (target) {
                const openingBonus = mc.opening ? 1 : 0; mc.opening = false;
                const delta = clamp((mc.rating - mc.injuries + mc.momentum + openingBonus) - (target.rating - target.injuries + target.momentum) + mv.circumstance + F + mAll + preset.bonus + composurePenalty(meta) - combatantComposurePenalty(target) + (b.scaleMismatch || 0), -13, 13);
                const P = probFromDelta(delta); const u = rngFloat();
                const tier = tieCheck(sliceOutcome(P, u, preset.mods), P, u, getSettings().tieBand);
                const r = applyExchangeEffects(mc, target, tier);
                Object.assign(mc, r.player); Object.assign(target, r.opp);
                if (mc.poise <= 0) mc.standing = false;
                if (target.poise <= 0) target.standing = false;
                focalRes = { delta, P, u, tier, personal: true };
            }
        } else {
            acting = pickUnit(nonPlayer(b.allies), mv.acting);
            target = pickUnit(b.enemies, mv.target);
            if (acting && target) {
                const openingBonus = acting.opening ? 1 : 0; acting.opening = false;
                const delta = clamp((acting.rating - acting.injuries + acting.momentum + openingBonus + cmdEdge) - (target.rating - target.injuries + target.momentum) + mv.circumstance + F + mAll + preset.bonus + combatantComposurePenalty(acting) - combatantComposurePenalty(target) + (b.scaleMismatch || 0), -13, 13);
                const P = probFromDelta(delta); const u = rngFloat();
                const tier = tieCheck(sliceOutcome(P, u, preset.mods), P, u, getSettings().tieBand);
                const r = applyExchangeEffects(acting, target, tier);
                Object.assign(acting, r.player); Object.assign(target, r.opp);
                if (acting.poise <= 0) acting.standing = false;
                if (target.poise <= 0) target.standing = false;
                focalRes = { delta, P, u, tier };
            }
        }

        // The rest of the line clashes: remaining formations auto-pair.
        const A = standing(nonPlayer(b.allies)).filter(u => u !== acting).sort((x, y) => y.rating - x.rating);
        const Ev = standing(b.enemies).filter(u => u !== target).sort((x, y) => y.rating - x.rating);
        const pairs = Math.min(A.length, Ev.length);
        const gang = A.length === Ev.length ? 0 : (A.length > Ev.length ? 1 : -1);
        for (let i = 0; i < pairs; i++) {
            reports.push(resolvePairing(A[i], Ev[i], F + mAll + gang + Math.round(cmdEdge / 2 * 2) / 2 + (b.scaleMismatch || 0), preset));
        }

        b.round += 1;

        // Collapse & rout.
        const aliveA = standing(nonPlayer(b.allies)).length;
        const aliveE = standing(b.enemies).length;
        const strength = (units) => standing(units).reduce((t, u) => t + Math.max(0, u.poise), 0);
        const maxStrength = (units) => units.reduce((t, u) => t + u.maxPoise, 0) || 1;
        if (!aliveE) { b.over = true; b.victor = 'allies'; }
        else if (!aliveA) { b.over = true; b.victor = 'enemies'; }
        else {
            const eFrac = strength(b.enemies) / maxStrength(b.enemies);
            const aFrac = strength(nonPlayer(b.allies)) / maxStrength(nonPlayer(b.allies));
            const focalLostByE = focalRes && !focalRes.stratagem && ['DECISIVE', 'SUCCESS', 'SUCCESS_COST'].includes(focalRes.tier);
            const focalLostByA = focalRes && !focalRes.stratagem && ['SETBACK', 'FAILURE', 'DISASTER'].includes(focalRes.tier);
            if (eFrac <= 0.25 && focalLostByE) { b.over = true; b.victor = 'allies'; }        // the line breaks
            else if (aFrac <= 0.25 && focalLostByA) { b.over = true; b.victor = 'enemies'; }
        }
        if (mc && !mc.standing && !b.over) { b.over = true; b.victor = 'enemies'; b.mcDown = true; } // the commander falls

        // Formation nerve frays with the round's losses; a controlled round steadies.
        if (!b.over) applyMoraleShock(meta, b, aStand0 - standing(nonPlayer(b.allies)).length, eStand0 - standing(b.enemies).length);
        return { focalRes, reports, condNote, acting, target };
    }

    function buildWarDirective(meta, adj, out) {
        const b = meta.battle;
        const mc = b.allies.find(u => u.isPlayer);
        const aliveA = standing(nonPlayer(b.allies)).length;
        const aliveE = standing(b.enemies).length;
        const lines = [
            '[ARBITER — war, round ' + b.round + ': ' + aliveA + '/' + nonPlayer(b.allies).length + ' formations vs ' + aliveE + '/' + b.enemies.length + ']',
            mc.name + ' orders: ' + adj.action + '.',
        ];
        if (out.focalRes) {
            const t = TIERS[out.focalRes.tier] || TIERS.FAILURE;
            if (out.focalRes.stratagem) {
                if (out.condNote && out.condNote.favors === 'allies') {
                    lines.push('The stratagem takes hold: ' + t.name + '. A lasting condition now favors ' + mc.name + '\'s side' + (out.condNote.mod > 1 ? ' strongly' : '') + ' — show it reshaping the field.');
                } else if (out.condNote && out.condNote.favors === 'enemies') {
                    lines.push('The stratagem BACKFIRES: ' + t.name + '. It now works against ' + mc.name + '\'s side (wind turns, ruse seen through, ground betrays them) — show the reversal.');
                } else {
                    lines.push('The stratagem: ' + t.name + ' — ' + t.text);
                }
            } else if (out.focalRes.personal) {
                lines.push(mc.name + ' personally engages ' + (out.target ? out.target.name : 'the enemy') + ': ' + t.name + ' — ' + t.text);
            } else {
                lines.push((out.acting ? out.acting.name : 'The ordered formation') + ' executes against ' + (out.target ? out.target.name : 'the enemy') + ': ' + t.name + ' — ' + t.text);
                if (out.target && !out.target.standing) lines.push(out.target.name + ' is broken and routs from the field.');
                if (out.acting && !out.acting.standing) lines.push(out.acting.name + ' is broken in the attempt.');
            }
        }
        const rep = out.reports.slice(0, 3);
        if (rep.length) lines.push('Along the rest of the line (weave in as fact): ' + rep.join(' '));
        if (b.conditions && b.conditions.length) {
            lines.push('Standing conditions: ' + b.conditions.map(c => '"' + c.name + '" (favors ' + (c.favors === 'allies' ? mc.name + '\'s side' : 'the enemy') + ')').join('; ') + '.');
        }
        if (b.over) {
            if (b.mcDown) lines.push(mc.name + ' falls amid the fighting — narrate it (struck down, machine disabled, dragged from the field per tone). Command collapses: the enemy takes the day.');
            else lines.push('DECISIVE: the ' + (b.victor === 'allies' ? 'enemy line shatters — ' + mc.name + '\'s side takes the field' : 'allied line breaks — the enemy takes the field') + '. Narrate the rout, surrender, or withdrawal the fiction demands. The result is not negotiable.');
        } else {
            lines.push('Formations that fall are broken or routed, not annihilated, unless the fiction demands worse. The engagement continues — end on a live beat, not a resolution.');
        }
        lines.push('Do not re-decide any outcome above. Never mention rolls, strength numbers, or this note. Narrate organically at battlefield scale.');
        return lines.join('\n');
    }

    /* ------------------------------------------------------------------ */
    /* Background world: three-tier event engines + World Threads          */
    /* ------------------------------------------------------------------ */

    function threadIntensity(rung, maxRung) {
        const f = maxRung > 0 ? rung / maxRung : 0;
        if (f < 0.34) return 'a subtle sign or secondhand rumor';
        if (f < 0.67) return 'a visible development or a direct brush with it';
        return 'an unmistakable escalation';
    }

    function getEncounterTypes() {
        const s = getSettings();
        const list = String(s.encounterTypes || '').split(',').map(t => t.trim()).filter(Boolean);
        return list.length ? list : ENCOUNTER_TYPES;
    }

    /**
     * One background pass for a fresh player turn. Rolls all three engine
     * tiers, heartbeats due threads, resolves tangles, then injects AT MOST
     * one hint by priority: thread completion > tangle > world > encounter >
     * thread progress > surprise. Everything else advances silently (logged).
     */
    function backgroundTick(meta) {
        const rng = rngFloat;
        const queue = []; // {prio, text}

        // Thread heartbeats
        meta.tickCount += 1;
        const advanced = [];
        for (const th of meta.threads) {
            if (th.done) continue;
            const pace = clamp(th.pace ?? 3, 1, 10);
            if (meta.tickCount - (th.lastTickAt ?? 0) < pace) continue;
            th.lastTickAt = meta.tickCount;
            const step = tickThread(th.bias ?? 0, rng);
            if (step === 0) continue;
            th.rung = clamp((th.rung ?? 0) + step, 0, th.maxRung ?? 8);
            dlog('thread tick:', th.name, 'step', step, '→', th.rung + '/' + (th.maxRung ?? 8));
            if (th.rung >= (th.maxRung ?? 8)) {
                th.done = true;
                queue.push({ prio: 6, text: '[ARBITER WORLD — a background current comes to a head: "' + th.name + '" (' + (th.desc || '') + '). Bring it into the open this scene or the next; it is no longer deniable.]' });
            } else if (step > 0) {
                advanced.push(th);
                queue.push({ prio: 2, text: '[ARBITER WORLD — background current: "' + th.name + '" advances (stage ' + th.rung + '/' + (th.maxRung ?? 8) + '). Surface it as ' + threadIntensity(th.rung, th.maxRung ?? 8) + '. One beat; do not derail the player\'s action.]' });
            } else {
                queue.push({ prio: 2, text: '[ARBITER WORLD — background current: "' + th.name + '" suffers a setback (stage ' + th.rung + '/' + (th.maxRung ?? 8) + '). Show a hint of friction or reversal around it. One beat only.]' });
            }
        }

        // Tangle: two currents advancing at once collide.
        if (advanced.length >= 2) {
            const [a, b] = advanced.slice().sort((x, y) => (y.rung / (y.maxRung ?? 8)) - (x.rung / (x.maxRung ?? 8)));
            const P = probFromDelta(clamp((a.bias ?? 0) - (b.bias ?? 0), -13, 13));
            const aWins = rng() < P;
            const w = aWins ? a : b, l = aWins ? b : a;
            w.rung = clamp(w.rung + 1, 0, w.maxRung ?? 8);
            l.rung = clamp(l.rung - 1, 0, l.maxRung ?? 8);
            queue.push({ prio: 5, text: '[ARBITER WORLD — collision of currents: "' + w.name + '" gains ground at the expense of "' + l.name + '". Let the friction between them show somewhere in this reply.]' });
        }

        // Engine tiers (NE-P numbers)
        const eng = meta.engines;
        const w = rollTier(eng.world.dc, ENGINE_DEFAULTS.world.sides, ENGINE_DEFAULTS.world.decay, ENGINE_DEFAULTS.world.dc0, rng);
        eng.world.dc = w.nextDC;
        if (w.fired) {
            const who = WORLD_WHO[Math.floor(rng() * WORLD_WHO.length)];
            const what = WORLD_WHAT[Math.floor(rng() * WORLD_WHAT.length)];
            const where = WORLD_WHERE[Math.floor(rng() * WORLD_WHERE.length)];
            queue.push({ prio: 4, text: '[ARBITER EVENT — seismic shift: ' + who + ' ' + what + ', ' + where + '. Land it as news or rumor first unless the fiction puts it on top of the player; it must fit the setting\'s tone and scale.]' });
        }
        const e = rollTier(eng.encounter.dc, ENGINE_DEFAULTS.encounter.sides, ENGINE_DEFAULTS.encounter.decay, ENGINE_DEFAULTS.encounter.dc0, rng);
        eng.encounter.dc = e.nextDC;
        if (e.fired) {
            const table = getEncounterTypes();
            const type = table[Math.floor(rng() * table.length)];
            const tone = ENCOUNTER_TONES[Math.floor(rng() * ENCOUNTER_TONES.length)];
            queue.push({ prio: 3, text: '[ARBITER EVENT — a hook fires: ' + type + ' (' + tone + '). Introduce it as a real beat the player can engage or ignore. It must fit the current tone, genre, and scale of the scene — no forced combat, no genre breaks. If it calls for a new minor NPC, invent one concretely.]' });
        }
        const su = rollTier(eng.surprise.dc, ENGINE_DEFAULTS.surprise.sides, ENGINE_DEFAULTS.surprise.decay, ENGINE_DEFAULTS.surprise.dc0, rng);
        eng.surprise.dc = su.nextDC;
        if (su.fired) {
            const type = EVENT_TYPES[Math.floor(rng() * EVENT_TYPES.length)];
            const tone = EVENT_TONES[Math.floor(rng() * EVENT_TONES.length)];
            queue.push({ prio: 1, text: '[ARBITER EVENT HINT — weave one ambient beat into this reply: ' + type + ' (' + tone + '). Keep it subtle and true to the scene\'s tone; do not derail the player\'s action or force combat.]' });
        }

        if (!queue.length) return null;
        queue.sort((x, y) => y.prio - x.prio);
        for (let i = 1; i < queue.length; i++) dlog('background beat (silent):', queue[i].text);
        return queue[0].text;
    }

    /** Gather everything the memory stack currently injects: Summaryception
     *  snippets/recall, Continuity Copilot's character ledger, notepads,
     *  lore/plot keys, and the Author's Note. Returns block + source list. */
    function collectMemoryBlock(limitChars) {
        const sources = [];
        const chunks = [];
        try {
            const c = ctx();
            const eps = c.extensionPrompts || c.extension_prompts || {};
            const memRe = /summar|ception|memory|qvink|notepad|ledger|lore|plot/i;
            for (const [k, v] of Object.entries(eps)) {
                const val = v && typeof v === 'object' ? v.value : v;
                if (memRe.test(k) && typeof val === 'string' && val.trim()) {
                    chunks.push(val.trim());
                    sources.push({ key: k, chars: val.trim().length });
                }
            }
            const md = c.chatMetadata || c.chat_metadata || {};
            if (typeof md.note_prompt === 'string' && md.note_prompt.trim()) {
                chunks.push(md.note_prompt.trim());
                sources.push({ key: "author's note", chars: md.note_prompt.trim().length });
            }
        } catch (e) { dlog('memory gather failed', e); }
        const block = chunks.length ? '<memory>\n' + chunks.join('\n---\n').slice(0, limitChars || 5000) + '\n</memory>' : '';
        return { block, sources };
    }

    /** Harvest a rough roster of named characters from memory + the existing
     *  sheet, so the seeder is reminded of the whole cast even when most are
     *  off-screen. Heuristic only — the model does the real judgement. */
    function collectKnownNames(meta, mem) {
        const names = new Set();
        for (const k of Object.keys(meta.sheet?.actors || {})) if (k.trim()) names.add(k.trim());
        try {
            const text = (mem && mem.block) ? mem.block : '';
            const re = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g;
            const stop = new Set(['The', 'This', 'That', 'They', 'Then', 'There', 'When', 'With', 'From', 'Your', 'What', 'Where', 'While', 'After', 'Before', 'Player', 'Author', 'Note', 'Memory', 'Scene', 'Chapter', 'Summary', 'And', 'But', 'For', 'His', 'Her', 'She', 'Their', 'Them', 'Have', 'Has', 'Was', 'Were', 'Will', 'Would', 'Could', 'Should']);
            let m, count = 0;
            while ((m = re.exec(text)) !== null && count < 4000) {
                count++;
                const cand = m[1].trim();
                if (stop.has(cand) || stop.has(cand.split(' ')[0])) continue;
                names.add(cand);
            }
        } catch (e) { /* heuristic only */ }
        return Array.from(names).slice(0, 200);
    }

    const THREAD_SEED_SYSTEM = [
        'You read a roleplay transcript plus its memory notes and propose BACKGROUND CURRENTS: off-screen storylines that should advance on their own (a rival\'s scheme, an investigation closing in, a faction\'s move, an NPC\'s ambition). Output STRICT JSON only, one object, no markdown.',
        '',
        'Schema: {"threads": [{"name": "<short name>", "desc": "<one line>", "maxRung": <5-12>, "bias": <-2..2, how strongly the world favors it>, "pace": <2-4, turns between heartbeats>}]}',
        '',
        'Rules: 2-5 threads. Only currents grounded in the story so far. Do NOT include the player\'s own active goals — these are what moves WITHOUT the player.',
    ].join('\n');

    async function seedThreads(opts) {
        const o = opts || {};
        const c = ctx();
        const meta = getMeta();
        if (!meta) { if (!o.auto) toast('warning', 'No chat open.'); return; }
        const chat = c.chat || [];
        if (!chat.length) { if (!o.auto) toast('warning', 'Chat is empty.'); return; }
        if (!hasWorkingRoute()) { if (!o.auto) toast('error', 'No AI connection for seeding. Set an Adjudicator profile first.', 'Arbiter'); clearActivity(); return; }
        setActivity(o.auto ? 'Arbiter: auto-seeding threads' : 'Arbiter: finding background currents');
        if (!o.auto) toast('info', 'Reading the story for background currents…', 'Arbiter threads');
        const parts = [];
        let chars = 0;
        const ts = getSettings();
        const tCap = Math.round(clamp(ts.seedTranscriptK, 4, 2000) * 1000 * 0.6);
        for (let i = chat.length - 1; i >= 0 && chars < tCap; i--) {
            const m = chat[i];
            if (!m || !m.mes || m.is_system) continue;
            const line = (m.name || (m.is_user ? 'Player' : 'AI')) + ': ' + String(m.mes).replace(/\s+/g, ' ').slice(0, 1000);
            chars += line.length;
            parts.push(line);
        }
        const mem = collectMemoryBlock(clamp(ts.seedMemoryK, 2, 500) * 1000);
        const existing = meta.threads.map(t => t.name).join(', ') || 'none';
        const out = await callLLM(THREAD_SEED_SYSTEM, (mem.block ? mem.block + '\n\n' : '') + '<existing_threads>' + existing + '</existing_threads>\n\n<transcript>\n' + parts.reverse().join('\n') + '\n</transcript>', 700, 45000, ts.seedProfileId || undefined);
        clearActivity();
        if (activityCanceled()) { if (!o.auto) toast('warning', 'Thread seed canceled.'); return; }
        let obj = null;
        for (const cand of extractJsonCandidates(out, 5)) {
            if (cand && Array.isArray(cand.threads)) { obj = cand; break; }
        }
        if (!obj) { if (o.auto) dlog('auto thread seed: nothing valid'); else toast('error', 'Thread seeding failed.'); return; }
        let added = 0;
        for (const t of obj.threads.slice(0, 6)) {
            const name = String(t.name || '').trim().slice(0, 60);
            if (!name) continue;
            if (meta.threads.some(x => x.name.toLowerCase() === name.toLowerCase())) continue;
            if (meta.threads.length >= 8) break;
            meta.threads.push({
                name, desc: String(t.desc || '').slice(0, 160),
                rung: 0, maxRung: clamp(t.maxRung ?? 8, 5, 12),
                bias: clamp(Math.round(Number(t.bias) || 0), -3, 3),
                pace: clamp(t.pace ?? 3, 1, 10),
                lastTickAt: meta.tickCount, done: false,
            });
            added++;
        }
        saveMeta();
        renderThreads();
        if (o.auto) { if (added) dlog('auto threads: +' + added); }
        else toast('success', 'Threads added: ' + added + '.', 'Arbiter threads');
    }

    /* ------------------------------------------------------------------ */
    /* Duel mode                                                           */
    /* ------------------------------------------------------------------ */

    const DUEL_SYSTEM = [
        'You are Arbiter, refereeing one round of an ACTIVE duel in a roleplay. Score the player\'s stated move for this exchange. You NEVER decide who wins — only the parameters. Output STRICT JSON only: one object, no markdown, no commentary.',
        '',
        'Schema:',
        '{"exchange": true|false,',
        ' "move_kind": "attack" | "recover",',
        ' "opp_composure": <integer -2..2 — how THIS moment affects the OPPONENT\'s nerve: negative when the player\'s action frightens, awes, or demoralizes them (a brutal display, a revealed power, their ally falling); positive when they rally or steel themselves. 0 usually.>",',
        ' "self_composure": <integer -2..2 — how THIS moment affects the PLAYER\'s nerve in the fight: negative under terror or horror, positive on a grounding surge. 0 usually.>",',
        ' "action": "<the move, 3-10 words>",',
        ' "circumstance": <integer -3..3>,',
        ' "why": "<one short clause>",',
        ' "combat_ended": true|false}',
        '',
        'Rules:',
        '- move_kind "recover": the player DISENGAGES to restore themselves — healing magic on themselves, a water/life node, catching their breath, a defensive reset that regains composure, mending their own wounds. This regains poise but yields tempo (the opponent acts freely). Everything else is "attack" (including defensive counters that still contest the opponent).',
        '- For a "recover" move, circumstance reflects how SAFELY they can recover: unopposed with a reliable method +2; snatched under pressure with the enemy closing -2. Recovery never "fails into damage" — at worst it barely helps.',
        '- In an active duel nearly every player turn IS an exchange — the opponent presses regardless. A passive, hesitant, or purely defensive turn is an exchange with NEGATIVE circumstance, not exchange=false.',
        '- circumstance is PHYSICAL advantage ONLY: position, momentum, a feint that creates a real opening, an exposed target, terrain, impairment, haste. NEVER penalize a move for being a foul, dirty, illegal, dishonorable, unsporting, or against duel etiquette, and NEVER mention rules, sanctions, penalties, or disqualification — you do not know this world\'s rules, and legality is the storyteller\'s to narrate, not yours to score. A dirty move that gives a real physical edge (a groin kick, sand in the eyes, a sucker punch) is a POSITIVE circumstance. Judge only what is effective, never what is permitted.',
        '- exchange=false only for a genuine lull: pure dialogue while circling, with no blows possible.',
        '- circumstance rewards concrete tactics, exploited weaknesses and openings (+); penalizes recklessness noted in the fiction, bad footing, impairment (-). 0 if nothing notable.',
        '- circumstance is TWO-SIDED and impartial: weigh what the OPPONENT is doing as much as the player. If the opponent has the better position, has set a trap, is pressing an advantage, or is simply the more dangerous fighter seizing control of the exchange, that is NEGATIVE circumstance for the player even when the player\'s own move is sound. Do not grade only the player\'s cleverness upward; a good move into a worse position still nets negative. Judge the exchange as a neutral observer would, not from the player\'s hopes.',
        '- combat_ended=true ONLY if the fiction has already clearly ended the fight (someone fled, yielded, was separated, or the scene left combat).',
    ].join('\n');

    function normalizeDuelAdj(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.combat_ended === true) return { combat_ended: true };
        if (obj.exchange === false) return { exchange: false };
        if (obj.exchange !== true) return null;
        return {
            exchange: true,
            moveKind: obj.move_kind === 'recover' ? 'recover' : 'attack',
            oppComposure: clamp(Math.round(Number(obj.opp_composure) || 0), -2, 2),
            selfComposure: clamp(Math.round(Number(obj.self_composure) || 0), -2, 2),
            action: String(obj.action || 'the exchange').slice(0, 140),
            circumstance: clamp(Math.round(Number(obj.circumstance) || 0), -3, 3),
            why: String(obj.why || '').slice(0, 160),
        };
    }

    function getPreset() {
        const s = getSettings();
        return PRESETS[s.preset] || PRESETS.realistic;
    }

    function duelActive(meta) {
        return !!(meta && meta.duel && meta.duel.active && !meta.duel.over);
    }

    function poiseFor(actorEntry, fallbackPoise) {
        if (actorEntry && Number.isFinite(Number(actorEntry.poise))) return clamp(actorEntry.poise, 1, 20);
        return clamp(fallbackPoise, 1, 20);
    }

    function startDuel(meta, playerName, oppName, domain, oppEstimate, scaleMismatch) {
        const s = getSettings();
        const fallback = clamp(s.defaultRating, 0, 10);
        const pEntry = findActor(meta, playerName);
        const oEntry = findActor(meta, oppName);
        const d = String(domain || 'melee').toLowerCase();
        const pPoise = poiseFor(pEntry, s.duelPoise);
        const oPoise = poiseFor(oEntry, s.duelPoise);
        // Opponent rating priority: sheet entry > context estimate > trained fallback.
        const oppRating = oEntry
            ? ratingFor(oEntry, d, fallback)
            : (Number.isFinite(oppEstimate) ? clamp(oppEstimate, 0, 10) : clamp(TIER_RATINGS.trained, 0, 10));
        meta.duel = {
            active: true,
            over: false,
            victor: null,
            round: 0,
            domain: d,
            scaleMismatch: clamp(Math.round(Number(scaleMismatch) || 0), -4, 4),
            player: { name: playerName, rating: ratingFor(pEntry, d, fallback), poise: pPoise, maxPoise: pPoise, injuries: 0, momentum: 0, opening: false },
            opp: { name: oppName, rating: oppRating, poise: oPoise, maxPoise: oPoise, injuries: 0, momentum: 0, opening: false, estimated: !oEntry && Number.isFinite(oppEstimate), composure: clamp(s.composureMax, 3, 12), composureMax: clamp(s.composureMax, 3, 12) },
        };
        dlog('duel started:', playerName, 'vs', oppName, '(' + d + ') opp rating', oppRating, 'scale', meta.duel.scaleMismatch, oEntry ? '(sheet)' : (Number.isFinite(oppEstimate) ? '(estimated)' : '(fallback)'));
        return meta.duel;
    }

    function endDuel(meta, silent) {
        if (meta && meta.duel) {
            // Persist an estimated opponent's rating as a sheet baseline so the
            // same foe doesn't get re-estimated (and wobble) next encounter.
            // Flagged _estimated so a considered seed can still overwrite it.
            try {
                const d = meta.duel;
                if (d.opp && d.opp.estimated && d.opp.name && !findActor(meta, d.opp.name)) {
                    meta.sheet = meta.sheet || { actors: {} };
                    meta.sheet.actors[d.opp.name] = {
                        default: clamp(d.opp.rating, 0, 10),
                        domains: { [d.domain || 'melee']: clamp(d.opp.rating, 0, 10) },
                        _estimated: true,
                    };
                    dlog('persisted estimated opponent', d.opp.name, 'at', d.opp.rating, 'as sheet baseline');
                }
            } catch (e) { /* non-fatal */ }
            meta.duel = null;
            saveMeta();
        }
        renderHud();
        if (!silent) toast('info', 'Duel ended.');
    }

    /** Resolve one duel exchange: consume opening, roll, apply, advance. */
    /**
     * Recovery amounts by tier (poise regained). Recovery can't backfire into
     * damage — the worst outcome is a small gain. Capped at maxPoise by caller.
     */
    const RECOVER_EFFECTS = {
        DECISIVE: 2.5, SUCCESS: 2, SUCCESS_COST: 1.5, SETBACK: 1, FAILURE: 0.5, DISASTER: 0.5,
        TRADE: 1, STALEMATE: 1,
    };

    function resolveDuelRecovery(meta, circumstance) {
        const duel = meta.duel;
        const preset = getPreset();
        duel.player.opening = false;
        // Recovery quality: a mild self-check. Circumstance (safety of the
        // moment) is the main lever; opponent rating pressures it slightly.
        const delta = clamp(5 - duel.opp.rating + circumstance + preset.bonus, -13, 13);
        const P = probFromDelta(delta);
        const u = rngFloat();
        const tier = sliceOutcome(P, u, preset.mods);
        const heal = RECOVER_EFFECTS[tier] ?? 1;
        const before = duel.player.poise;
        duel.player.poise = Math.min(duel.player.maxPoise, Math.round((duel.player.poise + heal) * 2) / 2);
        // The opponent gets a free swing while the player disengages. A more
        // dangerous or unimpaired foe lands harder; a rattled one less. This
        // is what stops recovery from being a risk-free heal loop — against a
        // real threat, catching your breath COSTS you.
        const oppEff = duel.opp.rating - duel.opp.injuries + combatantComposurePenalty(duel.opp);
        let counter = 0;
        if (oppEff >= 7) counter = 1.5;
        else if (oppEff >= 5) counter = 1;
        else if (oppEff >= 3) counter = 0.5;
        // Safe circumstance (a secured position, +) reduces the free hit; a
        // desperate snatch under pressure (-) increases it.
        counter = Math.max(0, counter - circumstance * 0.5);
        if (counter > 0) {
            duel.player.poise = Math.round((duel.player.poise - counter) * 2) / 2;
        }
        const gained = Math.round((duel.player.poise - before) * 2) / 2;
        // Ceding tempo: the opponent presses freely and gains momentum.
        duel.opp.momentum = Math.min(1, (duel.opp.momentum || 0) + 0.5);
        duel.player.momentum = 0;
        duel.opp.opening = true; // the opening the player gave up is exploitable
        duel.round += 1;
        let over = false, victor = null;
        if (duel.player.poise <= 0) { over = true; victor = 'opp'; duel.over = true; duel.victor = 'opp'; } // caught fatally mid-recovery
        return { recover: true, tier, gained, counter, delta, P, u, over, victor };
    }

    function resolveDuelExchange(meta, circumstance, moveKind) {
        const duel = meta.duel;
        const preset = getPreset();

        // Recovery: the player disengages to restore poise, ceding tempo.
        if (moveKind === 'recover') {
            return resolveDuelRecovery(meta, circumstance);
        }

        const openingBonus = duel.player.opening ? 1 : 0;
        duel.player.opening = false;
        const oppOpeningBonus = duel.opp.opening ? 1 : 0;
        duel.opp.opening = false;

        const effP = duel.player.rating - duel.player.injuries + duel.player.momentum + openingBonus;
        const effO = duel.opp.rating - duel.opp.injuries + duel.opp.momentum + oppOpeningBonus;
        const compPen = composurePenalty(meta);                    // player's strain (hurts player)
        const oppCompPen = combatantComposurePenalty(duel.opp);    // opponent's strain (negative → hurts opp)
        const delta = clamp(effP - effO + circumstance + (duel.scaleMismatch || 0) + compPen - oppCompPen + preset.bonus, -13, 13);
        const P = probFromDelta(delta);
        const u = rngFloat();
        const tier = tieCheck(sliceOutcome(P, u, preset.mods), P, u, getSettings().tieBand);

        const applied = applyExchangeEffects(duel.player, duel.opp, tier);
        duel.player = Object.assign({ name: duel.player.name, rating: duel.player.rating, maxPoise: duel.player.maxPoise }, applied.player);
        duel.opp = Object.assign({ name: duel.opp.name, rating: duel.opp.rating, maxPoise: duel.opp.maxPoise }, applied.opp);
        duel.round += 1;
        if (applied.over) {
            duel.over = true;
            duel.victor = applied.victor;
        }
        return { aR: effP, oR: effO, oppLabel: duel.opp.name, delta, P, u, tier, opening: openingBonus > 0 };
    }

    function sideStatus(side) {
        const p = Math.max(0, side.poise);
        let t = side.name + ' is ' + poiseWord(p, side.maxPoise);
        if (side.injuries > 0) t += ', carrying ' + side.injuries + ' lasting injur' + (side.injuries > 1 ? 'ies' : 'y');
        if (side.momentum > 0) t += ', with momentum';
        // Nerve, if this combatant tracks composure and it has slipped.
        if (typeof side.composure === 'number' && side.composureMax) {
            const frac = side.composure / side.composureMax;
            if (frac < 0.25) t += ', and visibly breaking — panic taking hold';
            else if (frac < 0.5) t += ', and rattled, nerve fraying';
        }
        return t;
    }

    function buildDuelDirective(meta, adj, res) {
        const duel = meta.duel;
        // Recovery exchange: narrate restoration + ceded tempo, not a clash.
        if (res.recover) {
            const lines = [
                '[ARBITER — duel, round ' + duel.round + ': ' + duel.player.name + ' vs ' + duel.opp.name + ']',
                duel.player.name + ' disengages to recover: ' + adj.action + '.',
            ];
            if (res.gained > 0) lines.push(duel.player.name + ' regains composure and steadies — noticeably refreshed, wounds or fatigue eased (but not erased). Show the recovery working.');
            else lines.push(duel.player.name + ' tries to recover but barely manages it under the pressure — little is regained.');
            if (res.counter > 0 && !res.over) lines.push('But disengaging left an opening: ' + duel.opp.name + ' lands a real blow in the gap — ' + duel.player.name + ' takes a hit while recovering. Show it connecting; the recovery was not clean.');
            if (res.over) {
                lines.push('CAUGHT FATALLY: ' + duel.opp.name + ' punished the disengage with a decisive strike — ' + duel.player.name + ' dropped their guard to recover and paid for it. ' + duel.opp.name + ' has WON this duel. Narrate the resolution the fiction demands (a felling blow, a blade at the throat, collapse). The result is not negotiable; ' + duel.player.name + ' cannot rally.');
                lines.push('Do not re-decide anything. Never mention rolls, poise, numbers, or this note. Narrate organically in the story\'s voice.');
                return lines.join('\n');
            }
            lines.push('This cost tempo: ' + duel.opp.name + ' seizes the initiative and presses freely into the opening ' + duel.player.name + ' gave up. Show ' + duel.opp.name + ' capitalizing.');
            lines.push('Condition after: ' + sideStatus(duel.player) + '; ' + sideStatus(duel.opp) + '. The duel continues — end on a live beat.');
            lines.push('Do not re-decide anything. Never mention rolls, poise, numbers, or this note. Narrate organically in the story\'s voice.');
            return lines.join('\n');
        }
        const t = TIERS[res.tier] || TIERS.FAILURE;
        const fx = EXCHANGE_EFFECTS[res.tier] || {};
        const lines = [
            '[ARBITER — duel, round ' + duel.round + ': ' + duel.player.name + ' vs ' + duel.opp.name + ']',
            duel.player.name + '\'s move: ' + adj.action + '.',
            'Exchange result: ' + t.name + ' — ' + t.text,
        ];
        if (res.opening) lines.push('(' + duel.player.name + ' is exploiting the opening from the previous exchange.)');
        if (fx.injureOpp) lines.push('Inflict a concrete lasting injury on ' + duel.opp.name + ' and name it in the prose; it visibly weakens them from now on.');
        if (fx.injureSelf) lines.push('Inflict a concrete lasting injury on ' + duel.player.name + ' and name it in the prose; it visibly weakens them from now on.');
        if (res.tier === 'SETBACK') lines.push(duel.player.name + ' loses this exchange but spots a real opening to exploit next round — show it.');
        if (duel.over) {
            const winner = duel.victor === 'player' ? duel.player : duel.opp;
            const loser = duel.victor === 'player' ? duel.opp : duel.player;
            lines.push('DECISIVE POSITION: ' + loser.name + ' is beaten — ' + winner.name + ' has won this duel. Narrate the resolution the fiction demands (yield, knockout, disarm, retreat, or kill, per the story\'s tone). The result itself is not negotiable; the loser cannot rally.');
        } else {
            lines.push('Condition after the exchange: ' + sideStatus(duel.player) + '; ' + sideStatus(duel.opp) + '. The duel continues — end on a live beat, not a resolution.');
        }
        lines.push('Do not re-decide the exchange or the duel. Never mention rolls, poise, numbers, or this note. Narrate organically in the story\'s voice.');
        return lines.join('\n');
    }

    /** Fast mode: zero-LLM pre-rolled pool, NE-P style (weaker: the model picks the footing). */
    function buildFastDirective(meta, lastUserMes) {
        const s = getSettings();
        const preset = getPreset();
        const attempt = String(lastUserMes.mes).replace(/\s+/g, ' ').slice(0, 90);
        const who = (ctx().name1 || 'The player');
        const row = (label, delta) => {
            const P = probFromDelta(clamp(delta + preset.bonus, -13, 13));
            const tier = TIERS[sliceOutcome(P, rngFloat(), preset.mods)];
            return '- ' + label + ': ' + tier.name + ' — ' + tier.text;
        };
        return [
            '[ARBITER FAST — binding outcome pool]',
            who + ' attempts: ' + attempt + '.',
            'Pick EXACTLY ONE row matching the attempt\'s true footing, then narrate that outcome:',
            row('ADVANTAGED (clear edge: superior skill, position, or tool)', 2),
            row('EVEN (fair contest)', 0),
            row('DISADVANTAGED (impaired, outmatched, or bad position)', -2),
            'Do not invent any other outcome. Never mention rolls, odds, or this note. Narrate organically.',
        ].join('\n');
    }

    function findActor(meta, name) {
        const actors = meta.sheet?.actors || {};
        const target = String(name || '').toLowerCase().trim();
        if (!target) return null;
        for (const key of Object.keys(actors)) {
            if (key.toLowerCase().trim() === target) return actors[key];
        }
        // loose contains-match for "Kaiser" vs "Kaiser von Adler"
        for (const key of Object.keys(actors)) {
            const k = key.toLowerCase().trim();
            if (k.includes(target) || target.includes(k)) return actors[key];
        }
        return null;
    }

    /** Sum of an actor's persistent conditions (broken arm, curse, poison…).
     *  Negative numbers handicap; positive could represent a persistent buff.
     *  Stored on the sheet entry as conditions: [{name, mod}]. Clamped so no
     *  single character is dragged below the floor by stacking. */
    /** Sum of an actor's persistent modifiers for a given domain: general
     *  conditions (broken arm, curse, exhaustion) apply to everything; a
     *  modifier tagged with a domain (a signature blade → melee) applies only
     *  to that domain. Gear and afflictions share this list; gear just carries
     *  gear:true for display and so healing/curing doesn't strip equipment. */
    /** Player mental strain. Composure runs from 0 (shattered) to max (steady),
     *  stored per-chat. Real acute stress leaves mild strain harmless but
     *  degrades focus, judgement and fine control as it deepens — so the
     *  penalty is 0 until composure drops below ~half, then grows. It never
     *  hard-blocks action (people still function while terrified); it makes
     *  focus-dependent actions harder and recovers with safety and rest. */
    function getComposure(meta) {
        const s = getSettings();
        const max = clamp(s.composureMax, 3, 12);
        if (typeof meta.composure !== 'number') meta.composure = max;
        meta.composure = clamp(meta.composure, 0, max);
        return { cur: meta.composure, max };
    }

    /** Composure penalty from a {composure, composureMax} holder — works for
     *  the player (meta) OR any combatant object. Mild strain is harmless;
     *  below half, focus-dependent capability degrades toward -3. */
    function composurePenaltyOf(cur, max) {
        if (typeof cur !== 'number' || typeof max !== 'number' || max <= 0) return 0;
        const half = max / 2;
        if (cur >= half) return 0;
        const frac = (half - cur) / half;
        return -Math.round(frac * 3);
    }

    function composurePenalty(meta) {
        const s = getSettings();
        if (!s.composure) return 0;
        const { cur, max } = getComposure(meta);
        return composurePenaltyOf(cur, max);
    }

    /** A combatant's own composure penalty (0 if composure disabled or the
     *  combatant has no composure pool — e.g. a mindless construct). */
    function combatantComposurePenalty(unit) {
        if (!getSettings().composure || !unit || typeof unit.composure !== 'number') return 0;
        return composurePenaltyOf(unit.composure, unit.composureMax || unit.composure);
    }

    /** Erode/restore a combatant's composure in place, clamped. */
    function shiftCombatantComposure(unit, delta) {
        if (!unit || typeof unit.composure !== 'number' || !delta) return;
        unit.composure = clamp(unit.composure + delta, 0, unit.composureMax || unit.composure);
    }

    function applyComposureChange(meta, delta) {
        const s = getSettings();
        if (!s.composure || !delta) return null;
        const max = clamp(s.composureMax, 3, 12);
        if (typeof meta.composure !== 'number') meta.composure = max;
        const before = meta.composure;
        meta.composure = clamp(meta.composure + delta, 0, max);
        const now = meta.composure;
        if (now === before) return null;
        // Narration-relevant thresholds so the storyteller can show the strain.
        const state = (v) => v >= max * 0.75 ? 'steady' : v >= max * 0.5 ? 'shaken' : v >= max * 0.25 ? 'badly rattled' : 'near breaking';
        return { before, now, max, worsened: now < before, state: state(now) };
    }

    /** Post-round morale shock for battles/wars. Watching same-side units fall
     *  frays the survivors' individual nerve (composure) — a real driver of
     *  formations breaking, and DISTINCT from headcount morale (moraleOf), which
     *  is an attrition proxy. A clean round with no losses and a numerical edge
     *  lets a side steady. The player commander/fighter shares the ally side's
     *  fortune via meta composure. Purely mechanical — no LLM — so it works in
     *  fast mode too, and it never breaks a unit (composure is mental, only
     *  poise felling is lethal); a rattled unit merely fights worse next round.
     *  breaks are counted among NON-player units (the MC is tracked via meta). */
    function applyMoraleShock(meta, b, allyBreaks, enemyBreaks) {
        if (!getSettings().composure) return;
        const allyUnits = b.allies.filter(u => !u.isPlayer);
        const enemyUnits = b.enemies;
        const mc = b.allies.find(u => u.isPlayer);
        const aStand = standing(allyUnits).length;
        const eStand = standing(enemyUnits).length;
        const nerve = (units, breaks, edge) => {
            const shock = clamp(breaks, 0, 2); // 1–2+ comrades down this round → up to -2
            for (const u of standing(units)) {
                if (shock > 0) shiftCombatantComposure(u, -shock);
                else if (edge) shiftCombatantComposure(u, +1); // a controlled, winning round steadies nerves
            }
        };
        nerve(allyUnits, allyBreaks, aStand >= eStand);
        nerve(enemyUnits, enemyBreaks, eStand >= aStand);
        if (mc && mc.standing) {
            if (allyBreaks > 0) applyComposureChange(meta, -clamp(allyBreaks, 0, 2)); // their line buckling rattles them
            else if (aStand >= eStand) applyComposureChange(meta, +1);                // holding the line steadies them
        }
    }

    /** Gentle between-scenes recovery of the player's nerve on quiet turns out of
     *  combat — real minds settle with time and safety. Slow by design so it
     *  never trivialises a horror beat; the fiction's own composure_change still
     *  lands on top. Units aren't covered (they don't persist between scenes;
     *  their nerve recovers in-fight via a controlled round). */
    const PASSIVE_COMPOSURE_REGEN = 0.5;
    function passiveComposureRecovery(meta) {
        const s = getSettings();
        if (!s.composure) return;
        const max = clamp(s.composureMax, 3, 12);
        if (typeof meta.composure !== 'number') { meta.composure = max; return; }
        if (meta.composure >= max) return;
        meta.composure = clamp(meta.composure + PASSIVE_COMPOSURE_REGEN, 0, max);
    }

    function conditionMod(actorEntry, domain) {
        if (!actorEntry || !Array.isArray(actorEntry.conditions)) return 0;
        const d = String(domain || '').toLowerCase();
        let sum = 0;
        for (const c of actorEntry.conditions) {
            const m = Number(c && c.mod);
            if (!Number.isFinite(m)) continue;
            const cd = c.domain ? String(c.domain).toLowerCase() : null;
            if (!cd || cd === d) sum += m; // untagged = applies to all; tagged = only its domain
        }
        return clamp(sum, -6, 5);
    }

    function ratingFor(actorEntry, domain, fallback) {
        if (!actorEntry || typeof actorEntry !== 'object') return fallback;
        const domains = actorEntry.domains || {};
        const d = String(domain || '').toLowerCase();
        let base = fallback;
        let found = false;
        for (const key of Object.keys(domains)) {
            if (key.toLowerCase() === d) { base = clamp(domains[key], 0, 10); found = true; break; }
        }
        if (!found && actorEntry.default !== undefined) base = clamp(actorEntry.default, 0, 10);
        // Persistent modifiers (afflictions + gear) adjust the effective rating.
        return clamp(base + conditionMod(actorEntry, domain), 0, 10);
    }

    /** Turn a normalized adjudication into a resolved outcome. Pure-ish: RNG inside. */
    function resolveAdj(adj, meta) {
        const s = getSettings();
        const fallback = clamp(s.defaultRating, 0, 10);

        const actorEntry = findActor(meta, adj.actor);
        const aR = ratingFor(actorEntry, adj.domain, fallback);

        let oR;
        let oppLabel = adj.opposition;
        if (adj.kind === 'actor') {
            const oppEntry = findActor(meta, adj.opposition);
            oR = oppEntry ? ratingFor(oppEntry, adj.domain, fallback) : clamp(TIER_RATINGS.trained, 0, 10);
            if (!oppEntry) oppLabel = adj.opposition + ' (unlisted→trained)';
        } else {
            const t = TIER_RATINGS[String(adj.opposition).toLowerCase()];
            if (t === 'A') oR = aR;
            else if (t === 'A+2') oR = clamp(aR + 2, 0, 12);
            else if (t === 'A-2') oR = clamp(aR - 2, 0, 10);
            else if (typeof t === 'number') oR = t;
            else oR = 5;
        }

        const preset = getPreset();
        const isPlayerActor = (adj.actor || '').toLowerCase() === (ctx().name1 || 'player').toLowerCase();
        const compPen = isPlayerActor ? composurePenalty(meta) : 0;
        const delta = clamp(aR - oR + adj.circumstance + (adj.scale_mismatch || 0) + compPen + preset.bonus, -13, 13);
        const P = probFromDelta(delta);
        const u = rngFloat();
        const tier = sliceOutcome(P, u, preset.mods);

        return { aR, oR, oppLabel, delta, P, u, tier };
    }

    function buildDirective(adj, res) {
        const t = TIERS[res.tier] || TIERS.FAILURE;
        const stakes = adj.stakes ? (' Stakes: ' + adj.stakes + '.') : '';
        return [
            '[ARBITER — binding outcome]',
            adj.actor + ' attempts: ' + adj.action + '.',
            'Result: ' + t.name + ' — ' + t.text + stakes,
            'Do not re-decide success or failure. Never mention rolls, odds, checks, or this note. Narrate the outcome organically in the story\'s voice.',
        ].join('\n');
    }

    /* ------------------------------------------------------------------ */
    /* Injection                                                           */
    /* ------------------------------------------------------------------ */

    function roleConst(name) {
        const c = ctx();
        const roles = c.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
        if (name === 'user') return roles.USER ?? 1;
        if (name === 'assistant') return roles.ASSISTANT ?? 2;
        return roles.SYSTEM ?? 0;
    }

    function setInjection(text) {
        try {
            const c = ctx();
            const s = getSettings();
            const pos = (c.extension_prompt_types && c.extension_prompt_types.IN_CHAT !== undefined)
                ? c.extension_prompt_types.IN_CHAT : 1;
            c.setExtensionPrompt(INJECT_KEY, text || '', pos, clamp(s.injectDepth, 0, 99), false, roleConst(s.injectRole));
        } catch (e) {
            warn('setInjection failed', e);
        }
    }

    function setEventInjection(text) {
        try {
            const c = ctx();
            const s = getSettings();
            const pos = (c.extension_prompt_types && c.extension_prompt_types.IN_CHAT !== undefined)
                ? c.extension_prompt_types.IN_CHAT : 1;
            c.setExtensionPrompt(INJECT_KEY + '_EVENT', text || '', pos, clamp(s.injectDepth, 0, 99), false, roleConst(s.injectRole));
        } catch (e) {
            warn('setEventInjection failed', e);
        }
    }

    function clearInjection() {
        setInjection('');
        setEventInjection('');
    }

    /* ------------------------------------------------------------------ */
    /* Log                                                                 */
    /* ------------------------------------------------------------------ */

    function pushLog(meta, adj, res, round) {
        const line = {
            t: Date.now(),
            r: round || undefined,
            action: adj.action,
            domain: adj.domain,
            actor: adj.actor,
            aR: res.aR,
            opp: res.oppLabel,
            oR: res.oR,
            circ: adj.circumstance,
            why: adj.why,
            delta: res.delta,
            P: Math.round(res.P * 1000) / 10,
            u: Math.round(res.u * 1000) / 1000,
            tier: res.tier,
        };
        meta.log.unshift(line);
        if (meta.log.length > 30) meta.log.length = 30;
        return line;
    }

    function mathLine(l) {
        const sign = l.circ >= 0 ? '+' : '';
        return 'Δ=' + (l.delta >= 0 ? '+' : '') + l.delta + ' (' + l.aR + ' vs ' + l.oR +
            ', circ ' + sign + l.circ + ') → P ' + l.P + '% → u ' + l.u;
    }

    /* ------------------------------------------------------------------ */
    /* The interceptor                                                     */
    /* ------------------------------------------------------------------ */

    let inFlight = false;

    async function interceptorBody(chat, contextSize, abort, type) {
        const s = getSettings();
        if (!s.enabled) return;

        const genType = type || 'normal';
        const eligible = ['normal', 'swipe', 'regenerate', 'continue'];
        if (!eligible.includes(genType)) return; // quiet / impersonate / etc.

        // Start every eligible generation clean; we re-set below if needed.
        // (GENERATION_ENDED/STOPPED also clear, this covers abnormal exits.)
        clearInjection();

        if (!Array.isArray(chat) || chat.length === 0) return;

        let lastUser = null;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && m.is_user && !m.is_system && m.mes && m.mes.trim()) { lastUser = m; break; }
        }
        if (!lastUser) return;

        const meta = getMeta();
        if (!meta) return;

        const key = hashStr(String(lastUser.mes) + '|' + String(lastUser.send_date || ''));

        // One-shot flags from /arb and /arbskip
        let force = meta.oneShot === 'force';
        const skipFlag = meta.oneShot === 'skip';
        if (meta.oneShot) { meta.oneShot = null; saveMeta(); }

        // Inline tags. A [roll] tag only forces on a FRESH send — on swipes /
        // regenerates the committed outcome must win, or the tag becomes a
        // re-roll fishing lever. Explicit /arb (oneShot) can always force.
        const raw = String(lastUser.mes);
        const tagForce = hasTag(raw, s.forceTag);
        const tagSkip = hasTag(raw, s.skipTag);
        if (tagForce && genType === 'normal') force = true;

        if (skipFlag || tagSkip) {
            dlog('skip requested; committing a no-check verdict for this message');
            meta.cache = { key, directive: '', tier: null };
            saveMeta();
            if (s.eventEngine && meta.eventCache && meta.eventCache.key === key) setEventInjection(meta.eventCache.text);
            return;
        }

        // Same triggering user message as the committed decision: replay it.
        // Swiping/regenerating rerolls the PROSE, never the FATE — the only
        // ways past a committed decision are /arb (explicit re-adjudication)
        // or editing the action itself (handled below).
        if (!force && meta.cache && meta.cache.key === key) {
            if (meta.cache.directive) {
                dlog('cache hit — re-injecting committed outcome (' + genType + ')');
                setInjection(meta.cache.directive);
            } else {
                dlog('cache hit — committed no-check verdict stands (' + genType + ')');
            }
            if (s.eventEngine && meta.eventCache && meta.eventCache.key === key) setEventInjection(meta.eventCache.text);
            return;
        }

        // Reaching here on a swipe/regenerate means the player EDITED their
        // action (key mismatch) or nothing was ever committed for it. An
        // edited action is a NEW attempt and gets a fresh, fair roll.
        // Player-initiated retries are a save-point choice, not model
        // sycophancy — the odds never bend, only the dice recast.

        // Re-rolling the SAME message (edit or /arb): rewind any fight AND the
        // background world to the state before that turn, or effects double.
        const sendDate = String(lastUser.send_date || '');
        if (meta.cache && meta.cache.sendDate === sendDate && meta.cache.duelSnapshot !== undefined) {
            const snap = meta.cache.duelSnapshot;
            const copy = (o) => o ? JSON.parse(JSON.stringify(o)) : null;
            if (snap && typeof snap === 'object' && ('d' in snap || 'b' in snap)) {
                meta.duel = copy(snap.d);
                meta.battle = copy(snap.b);
                if (snap.t !== undefined) meta.threads = copy(snap.t) || [];
                if (snap.e !== undefined && snap.e) meta.engines = copy(snap.e);
                if (snap.tc !== undefined) meta.tickCount = snap.tc;
            } else {
                meta.duel = copy(snap); // legacy v0.2 snapshot: duel-or-null
            }
            if (meta.eventCache && meta.eventCache.key === key) delete meta.eventCache;
            // The committed fate no longer matches the rewound state: drop it.
            // If the re-roll below fails, the next attempt rolls fresh instead
            // of replaying a directive from a divergent timeline.
            meta.cache = null;
            renderHud();
            dlog('fight + world state rewound for re-roll of the same message; stale fate invalidated');
        }
        // Concluded fights clear once the story moves to a new message. A
        // finished fight is the highest-value moment to re-seed: combatants were
        // just wounded, revealed power, leveled, or broke — so mark a seed due
        // rather than waiting for a blind turn timer.
        if (meta.duel && meta.duel.over) { meta.duel = null; meta.seedDueAfterFight = true; }
        if (meta.battle && meta.battle.over) { meta.battle = null; meta.seedDueAfterFight = true; }
        renderHud(); // re-sync every turn: any previously missed render self-heals

        if (genType === 'normal') meta.turnCount = (meta.turnCount || 0) + 1;

        // Snapshot the pre-turn world BEFORE any ticks or exchanges mutate it.
        const duelSnapshot = {
            d: meta.duel ? JSON.parse(JSON.stringify(meta.duel)) : null,
            b: meta.battle ? JSON.parse(JSON.stringify(meta.battle)) : null,
            t: JSON.parse(JSON.stringify(meta.threads || [])),
            e: meta.engines ? JSON.parse(JSON.stringify(meta.engines)) : null,
            tc: meta.tickCount || 0,
        };

        // Background world: replay on the same message, tick on new ones.
        if (s.eventEngine) {
            if (meta.eventCache && meta.eventCache.key === key) {
                setEventInjection(meta.eventCache.text);
            } else if (genType === 'normal' && !duelActive(meta) && !battleActive(meta)) {
                const txt = backgroundTick(meta);
                if (txt) {
                    setEventInjection(txt);
                    meta.eventCache = { key, text: txt };
                    dlog('background beat fired');
                }
                renderThreads();
                saveMeta();
            }
        }

        const inDuel = duelActive(meta);
        const inBattle = !inDuel && battleActive(meta);
        const inWar = inBattle && meta.battle.kind === 'war';
        const inFight = inDuel || inBattle;
        if (!force && !inFight && !gatePasses(raw)) {
            dlog('gate: no check plausible');
            // A calm narrative turn (no action attempted, no fight): the player's
            // nerve settles a little. Slow by design — a horror beat erodes far
            // faster than this heals — and only on genuinely quiet turns, never
            // on an active or stressful adjudicated beat.
            if (genType === 'normal') passiveComposureRecovery(meta);
            // Commit a no-check verdict WITH the pre-turn world snapshot, so
            // an edited resend of this message rewinds background ticks
            // instead of stacking a second one.
            meta.cache = { key, sendDate, directive: '', tier: null, duelSnapshot };
            saveMeta();
            return;
        }

        if (inFlight) { dlog('adjudication already in flight; skipping'); return; }
        inFlight = true;
        const t0 = Date.now();
        try {
            const budget = clamp(s.timeoutMs, 1500, 60000);
            const commitCache = (directive, tier) => { meta.cache = { key, sendDate, directive, tier, duelSnapshot }; };
            const duelToast = (adjAction, res) => {
                if (!s.toastResults) return;
                const t = TIERS[res.tier] || {};
                const rnd = inBattle ? meta.battle.round : (meta.duel ? meta.duel.round : 0);
                toast('info', escHtml(adjAction) + (s.showMath ? '<br><small>' + escHtml('Δ=' + (res.delta >= 0 ? '+' : '') + res.delta + ' → P ' + Math.round(res.P * 100) + '% → u ' + (Math.round(res.u * 1000) / 1000)) + '</small>' : ''), 'R' + rnd + ' · ' + t.name);
            };

            // ── FAST MODE: zero LLM calls, pre-rolled outcomes ──
            if (s.mode === 'fast') {
                const action = String(lastUser.mes).replace(/\s+/g, ' ').slice(0, 90);
                if (inDuel) {
                    // No LLM classifier in fast mode: detect a disengage-to-recover
                    // locally (conservative — see looksLikeRecovery); else resolve
                    // as an attack. Scale mismatch and composure still apply: they
                    // are read off the duel/meta inside resolveDuelExchange, not
                    // passed as arguments. Only per-move circumstance is 0 here.
                    const mk = looksLikeRecovery(lastUser.mes) ? 'recover' : 'attack';
                    const res = resolveDuelExchange(meta, 0, mk);
                    const directive = buildDuelDirective(meta, { action }, res);
                    setInjection(directive);
                    commitCache(directive, res.tier);
                    pushLog(meta, { action, domain: meta.duel.domain, actor: meta.duel.player.name, circumstance: 0, why: 'fast' }, res, meta.duel.round);
                    saveMeta(); renderHud(); renderLog();
                    duelToast(action, res);
                } else if (inWar) {
                    const out = resolveWarRound(meta, { kind: 'maneuver', acting: null, target: null, action, circumstance: 0 });
                    const directive = buildWarDirective(meta, { action }, out);
                    setInjection(directive);
                    commitCache(directive, out.focalRes ? out.focalRes.tier : null);
                    if (out.focalRes) pushLog(meta, { action, domain: 'war', actor: ctx().name1 || 'Player', circumstance: 0, why: 'fast' }, out.focalRes, meta.battle.round);
                    saveMeta(); renderHud(); renderLog();
                    if (out.focalRes) duelToast(action, out.focalRes);
                } else if (inBattle) {
                    const out = resolveBattleRound(meta, { kind: 'fight', target: null, action, circumstance: 0 });
                    const directive = buildBattleDirective(meta, { action }, out);
                    setInjection(directive);
                    commitCache(directive, out.mcRes ? out.mcRes.tier : null);
                    if (out.mcRes) pushLog(meta, { action, domain: meta.battle.domain, actor: ctx().name1 || 'Player', circumstance: 0, why: 'fast' }, out.mcRes, meta.battle.round);
                    saveMeta(); renderHud(); renderLog();
                    if (out.mcRes) duelToast(action, out.mcRes);
                } else {
                    const directive = buildFastDirective(meta, lastUser);
                    setInjection(directive);
                    commitCache(directive, 'FAST');
                    saveMeta();
                    dlog('fast pool injected');
                }
                return;
            }

            // ── ADJUDICATED MODE ──
            setActivity(inDuel ? 'Arbiter: resolving exchange' : (inBattle ? 'Arbiter: resolving battle round' : 'Arbiter: checking outcome'));
            const sysPrompt = inDuel ? DUEL_SYSTEM : (inWar ? WAR_SYSTEM : (inBattle ? BATTLE_SYSTEM : ADJ_SYSTEM));
            let userPrompt = buildAdjUserPrompt(chat, lastUser, meta);
            if (inBattle) userPrompt += battleContext(meta);

            let rawOut = await callLLM(sysPrompt, userPrompt, 260, budget);
            const normalize = (r) => {
                for (const cand of extractJsonCandidates(r, 5)) {
                    const n = inDuel ? normalizeDuelAdj(cand) : (inWar ? normalizeWarAdj(cand) : (inBattle ? normalizeBattleAdj(cand) : normalizeAdj(cand)));
                    if (n) return n;
                }
                return null;
            };
            let adj = normalize(rawOut);

            // One fast retry if the model returned junk and time remains.
            if (!adj && rawOut && (Date.now() - t0) < budget - 1500) {
                dlog('invalid JSON, retrying once');
                rawOut = await callLLM(
                    sysPrompt + '\n\nYour previous output was invalid. Output ONLY the JSON object.',
                    userPrompt, 260, budget - (Date.now() - t0));
                adj = normalize(rawOut);
            }

            clearActivity();
            if (!adj) {
                dlog('adjudicator unavailable or invalid — turn proceeds unmodified');
                return;
            }

            // Persistent conditions (handicaps, curses, lasting wounds, or their
            // healing) established by the fiction — applied before anything else
            // so the change is reflected from this turn forward.
            let conditionNote = null;
            if (adj.condition_change) {
                conditionNote = applyConditionChange(meta, adj.condition_change);
                if (conditionNote) { saveMeta(); renderSheet(); dlog('condition:', conditionNote); }
            }
            // Mental strain from the fiction's emotional weight.
            let composureNote = null;
            if (adj.composure_change) {
                const cr = applyComposureChange(meta, adj.composure_change);
                if (cr) {
                    composureNote = cr.worsened
                        ? 'The strain shows — ' + (ctx().name1 || 'the player') + ' is ' + cr.state + '.'
                        : (ctx().name1 || 'the player') + ' steadies, now ' + cr.state + '.';
                    saveMeta(); renderHud(); dlog('composure', cr.before, '→', cr.now, '(' + cr.state + ')');
                }
            }

            if (inWar) {
                if (adj.combat_ended) {
                    endBattle(meta, true);
                    commitCache('', null);
                    saveMeta();
                    toast('info', 'The fiction ended the engagement.');
                    return;
                }
                if (adj.exchange === false) {
                    dlog('war lull — no round this turn');
                    commitCache('', null);
                    saveMeta();
                    return;
                }
                const out = resolveWarRound(meta, adj);
                const directive = buildWarDirective(meta, adj, out);
                setInjection(directive);
                commitCache(directive, out.focalRes ? out.focalRes.tier : null);
                if (out.focalRes) pushLog(meta, { action: adj.action, domain: 'war', actor: ctx().name1 || 'Player', circumstance: adj.circumstance, why: adj.why }, out.focalRes, meta.battle.round);
                saveMeta(); renderHud(); renderLog();
                dlog('war round', meta.battle.round, 'resolved');
                if (out.focalRes) duelToast(adj.action, out.focalRes);
                return;
            }

            if (inBattle) {
                if (adj.combat_ended) {
                    endBattle(meta, true);
                    commitCache('', null);
                    saveMeta();
                    toast('info', 'The fiction ended the battle.');
                    return;
                }
                if (adj.exchange === false) {
                    dlog('battle lull — no round this turn');
                    commitCache('', null);
                    saveMeta();
                    return;
                }
                const out = resolveBattleRound(meta, adj);
                const directive = buildBattleDirective(meta, adj, out);
                setInjection(directive);
                commitCache(directive, out.mcRes ? out.mcRes.tier : null);
                if (out.mcRes) pushLog(meta, { action: adj.action, domain: meta.battle.domain, actor: ctx().name1 || 'Player', circumstance: adj.circumstance, why: adj.why }, out.mcRes, meta.battle.round);
                saveMeta(); renderHud(); renderLog();
                dlog('battle round', meta.battle.round, 'resolved in', Date.now() - t0, 'ms');
                if (out.mcRes) duelToast(adj.action, out.mcRes);
                return;
            }

            if (inDuel) {
                if (adj.combat_ended) {
                    endDuel(meta, true);
                    commitCache('', null);
                    saveMeta();
                    toast('info', 'The fiction ended the duel.');
                    return;
                }
                if (adj.exchange === false) {
                    dlog('duel lull — no exchange this turn');
                    commitCache('', null);
                    saveMeta();
                    return;
                }
                const res = resolveDuelExchange(meta, adj.circumstance, adj.moveKind);
                // Fear/steel from this exchange shifts each fighter's nerve.
                if (adj.oppComposure && meta.duel && meta.duel.opp) shiftCombatantComposure(meta.duel.opp, adj.oppComposure);
                if (adj.selfComposure) applyComposureChange(meta, adj.selfComposure);
                const directive = buildDuelDirective(meta, adj, res);
                setInjection(directive);
                commitCache(directive, res.tier);
                pushLog(meta, { action: adj.action, domain: meta.duel.domain, actor: meta.duel.player.name, circumstance: adj.circumstance, why: adj.why }, res, meta.duel.round);
                saveMeta(); renderHud(); renderLog();
                dlog('duel round', meta.duel.round, 'resolved in', Date.now() - t0, 'ms →', res.tier);
                duelToast(adj.action, res);
                return;
            }

            if (adj.check === false) {
                dlog('adjudicator: no check needed');
                commitCache('', null); // remember the "no check" verdict too
                saveMeta();
                return;
            }

            // Auto duel start: this attempt initiates sustained combat, so it
            // resolves as round 1 of a fresh duel.
            if (adj.duel_start && !adj.battle_start && s.autoDuel) {
                // If the opponent isn't rated yet, kick a background seed so the
                // NEXT rounds use scene-derived stats instead of the flat default.
                if (s.autoSeed && !findActor(meta, adj.duel_start) && !autoSeedRunning) {
                    autoSeedRunning = true;
                    Promise.resolve(seedSheet({ auto: true })).finally(() => { autoSeedRunning = false; });
                }
                startDuel(meta, adj.actor, adj.duel_start, adj.domain, adj.opponent_rating, adj.scale_mismatch);
                const res = resolveDuelExchange(meta, adj.circumstance);
                const directive = buildDuelDirective(meta, adj, res);
                setInjection(directive);
                commitCache(directive, res.tier);
                pushLog(meta, adj, res, meta.duel.round);
                saveMeta(); renderHud(); renderLog();
                toast('info', escHtml(meta.duel.player.name + ' vs ' + meta.duel.opp.name), 'DUEL — R1 · ' + (TIERS[res.tier] || {}).name);
                return;
            }

            // Auto battle start: group combat begins — this attempt resolves
            // as round 1 of a fresh battle.
            if (adj.battle_start && s.autoBattle) {
                const started = startBattle(meta, adj.battle_start.allies, adj.battle_start.enemies, adj.domain, adj.scale_mismatch);
                if (started) {
                    const out = resolveBattleRound(meta, { kind: 'fight', target: null, action: adj.action, circumstance: adj.circumstance });
                    const directive = buildBattleDirective(meta, adj, out);
                    setInjection(directive);
                    commitCache(directive, out.mcRes ? out.mcRes.tier : null);
                    if (out.mcRes) pushLog(meta, adj, out.mcRes, meta.battle.round);
                    saveMeta(); renderHud(); renderLog();
                    toast('info', escHtml(standing(meta.battle.allies).length + ' vs ' + standing(meta.battle.enemies).length), 'BATTLE — R1');
                    return;
                }
            }

            // The player takes COMMAND of army-scale combat: open a war.
            if (adj.war_start && s.autoWar) {
                const started = startWar(meta, adj.war_start.allies, adj.war_start.enemies, adj.war_start.enemy_commander, adj.scale_mismatch);
                if (started) {
                    const out = resolveWarRound(meta, { kind: 'maneuver', acting: null, target: null, action: adj.action, circumstance: adj.circumstance });
                    const directive = buildWarDirective(meta, adj, out);
                    setInjection(directive);
                    commitCache(directive, out.focalRes ? out.focalRes.tier : null);
                    if (out.focalRes) pushLog(meta, adj, out.focalRes, meta.battle.round);
                    saveMeta(); renderHud(); renderLog();
                    toast('info', escHtml(standing(nonPlayer(meta.battle.allies)).length + ' formations vs ' + standing(meta.battle.enemies).length), 'WAR — R1');
                    return;
                }
            }

            // Army-scale warfare routes to a World Thread (background war),
            // while THIS action resolves as the player's personal moment in it.
            // Prefer duel/battle if the referee also flagged a concrete foe/group.
            if (adj.army_scale && !adj.duel_start && !adj.battle_start) {
                let threadNote = '';
                if (s.eventEngine) {
                    const exists = (meta.threads || []).some(t => t.name.toLowerCase() === adj.army_scale.toLowerCase());
                    if (!exists && (meta.threads || []).length < 8) {
                        meta.threads.push({
                            name: adj.army_scale, desc: 'Ongoing large-scale conflict',
                            rung: 1, maxRung: 10, bias: 0, pace: 2,
                            lastTickAt: meta.tickCount || 0, done: false,
                        });
                        renderThreads();
                        threadNote = ' The wider battle "' + adj.army_scale + '" is now tracked as an ongoing background conflict that will develop over coming turns.';
                    }
                }
                const res = resolveAdj(adj, meta);
                const t = TIERS[res.tier] || TIERS.FAILURE;
                const directive = [
                    '[ARBITER — amid the ' + adj.army_scale + ']',
                    adj.actor + ' attempts: ' + adj.action + '.',
                    'Result: ' + t.name + ' — ' + t.text,
                    'This resolves ' + adj.actor + '\'s personal action within the larger battle; the war\'s overall tide is not decided by this single moment.' + threadNote,
                    'Do not re-decide the outcome. Never mention rolls, odds, or this note. Narrate organically.',
                ].join('\n');
                setInjection(directive);
                commitCache(directive, res.tier);
                pushLog(meta, adj, res);
                saveMeta();
                if (s.toastResults) toast('info', escHtml(adj.action), 'War · ' + t.name);
                renderLog();
                return;
            }

            const res = resolveAdj(adj, meta);
            const directive = buildDirective(adj, res)
                + (conditionNote ? '\n[ARBITER — lasting condition] ' + conditionNote + '. Reflect this in the prose; it persists until resolved.' : '')
                + (composureNote ? '\n[ARBITER — composure] ' + composureNote + ' Let it color their focus and demeanor; do not mention meters.' : '');
            setInjection(directive);

            commitCache(directive, res.tier);
            const line = pushLog(meta, adj, res);
            saveMeta();

            dlog('resolved in', Date.now() - t0, 'ms:', mathLine(line), '→', res.tier);
            if (s.toastResults) {
                const t = TIERS[res.tier];
                toast('info', escHtml(adj.action) + (s.showMath ? '<br><small>' + escHtml(mathLine(line)) + '</small>' : ''), t.name);
            }
            renderLog();
        } finally {
            inFlight = false;
            clearActivity();
        }
    }

    // Assigned at load so ST can find it whenever generation starts.
    globalThis.arbiterInterceptor = async function (chat, contextSize, abort, type) {
        try {
            await interceptorBody(chat, contextSize, abort, type);
        } catch (e) {
            warn('interceptor error (generation proceeds):', e);
            inFlight = false;
        }
    };

    /* ------------------------------------------------------------------ */
    /* Sheet seeding                                                       */
    /* ------------------------------------------------------------------ */

    const SEED_SYSTEM = [
        'You read a roleplay transcript and produce a capability sheet for outcome adjudication. Output STRICT JSON only, one object, no markdown.',
        '',
        'Schema:',
        '{"actors": {"<Name>": {"default": <0-10>, "domains": {"<domain>": <0-10>, ...}}, ...}}',
        '',
        'Rating guide (by effective threat, ANY kind of combatant — person, beast, monster, machine, alien): 2 untrained, 4 trained, 5 competent professional, 6 veteran, 7 elite, 8 master, 9 legendary, 10 apex. Rate creatures by how dangerous they are, not their species: a feral dog 3, a warhound 5, a dire beast or trained monster 7, an ancient dragon or apex predator 9-10. A domain like "melee" for a beast means its natural weapons (claws, fangs, breath).',
        'Domains are lowercase single words (melee, ranged, stealth, social, athletics, intellect, willpower, pilot, craft — invent others only if the story clearly needs them).',
        'Include the player character AND every named CHARACTER in the story — allies, rivals, mentors, recurring NPCs, and people listed in <known_characters> — not only those active in the recent transcript. A large cast is expected; cover everyone named and do NOT silently drop characters to save space. 2-4 domains per actor is plenty. Rate from evidence in the transcript and memory; when unsure, prefer 4-6. Merge obvious duplicates or aliases into a single entry.',
        'Rate each character at their CURRENT power level as of the latest events. If the story shows someone has trained, leveled up, unlocked new power, or grown stronger since earlier, reflect that higher rating now — a character who was trained (4) and has since become elite should be rated elite (7). The <existing_sheet> shows prior ratings; when the fiction clearly shows growth beyond them, rate the new, higher level.',
        'CRITICAL: actors are PEOPLE and creatures ONLY. Never create an entry for a place, city, academy, school, house, clan, faction, organization, team name, region, or title. If a name in <known_characters> is a location or institution (e.g. an academy or a noble house), leave it out entirely. When a name is ambiguous, include it only if the story clearly uses it as an individual who acts and fights.',
    ].join('\n');

    async function seedSheet(opts) {
        const o = opts || {};
        const c = ctx();
        const meta = getMeta();
        if (!meta) { if (!o.auto) toast('warning', 'No chat open.'); return; }
        const chat = c.chat || [];
        if (!chat.length) { if (!o.auto) toast('warning', 'Chat is empty.'); return; }
        if (!hasWorkingRoute()) {
            if (!o.auto) toast('error', 'No AI connection for seeding. Pick an Adjudicator profile in Arbiter → Core (or connect an API), then seed again.', 'Arbiter');
            dlog('seed skipped: no working LLM route');
            clearActivity();
            return;
        }

        setActivity(o.auto ? 'Arbiter: auto-seeding cast' : 'Arbiter: reading story, building sheet');
        if (!o.auto) toast('info', 'Reading the story and building the sheet…', 'Arbiter seed');
        const parts = [];
        let chars = 0;
        const s = getSettings();
        const transcriptCap = clamp(s.seedTranscriptK, 4, 2000) * 1000;
        for (let i = chat.length - 1; i >= 0 && chars < transcriptCap; i--) {
            const m = chat[i];
            if (!m || !m.mes || m.is_system) continue;
            const line = (m.name || (m.is_user ? 'Player' : 'AI')) + ': ' + String(m.mes).replace(/\s+/g, ' ').slice(0, 1200);
            chars += line.length;
            parts.push(line);
        }
        const existing = JSON.stringify(meta.sheet || { actors: {} });

        // Memory-aware seeding: memory FIRST (it names the established cast,
        // including characters off-screen right now), then the transcript.
        const mem = collectMemoryBlock(clamp(s.seedMemoryK, 2, 500) * 1000);
        const roster = collectKnownNames(meta, mem);
        const rosterBlock = roster.length ? '<known_characters>\n' + roster.join(', ') + '\n</known_characters>\n\n' : '';
        const playerName = c.name1 || 'Player';
        const cardName = c.name2 || '';
        const voices = '<voices>\nplayer_character: ' + playerName + '\n' +
            (cardName ? 'storyteller_label: ' + cardName + ' — this labels the narrator/storyteller\'s messages in the transcript. Do NOT create an actor entry for it unless the story clearly shows an individual PERSON by this exact name who acts and fights in scenes.\n' : '') +
            '</voices>\n\n';
        const userPrompt = '<existing_sheet>\n' + existing + '\n</existing_sheet>\n\n' + voices + rosterBlock + (mem.block ? mem.block + '\n\n' : '') + '<transcript>\n' +
            parts.reverse().join('\n') + '\n</transcript>';

        const out = await callLLM(SEED_SYSTEM, userPrompt, clamp(s.seedOutTokens, 400, 8000), 60000, s.seedProfileId || undefined);
        clearActivity();
        if (activityCanceled()) { if (!o.auto) toast('warning', 'Seed canceled.'); return; }
        let obj = null;
        for (const cand of extractJsonCandidates(out, 5)) {
            if (cand && typeof cand.actors === 'object' && cand.actors !== null) { obj = cand; break; }
        }
        if (!obj) {
            if (o.auto) dlog('auto sheet seed: no valid sheet returned');
            else toast('error', 'Seeding failed — model returned no valid sheet.');
            return;
        }
        let added = 0;
        for (const [name, entry] of Object.entries(obj.actors)) {
            if (!name.trim() || !entry || typeof entry !== 'object') continue;
            const key = name.trim();
            const existing = findActor(meta, key);
            const clean = { default: clamp(entry.default ?? 5, 0, 10), domains: {}, _auto: true };
            for (const [d, v] of Object.entries(entry.domains || {})) {
                const dk = String(d).toLowerCase().trim();
                if (dk) clean.domains[dk] = clamp(v, 0, 10);
            }
            if (o.auto && existing && !existing._estimated) {
                // Growth-aware refresh. An entry Arbiter generated (_auto) may be
                // RAISED as the story shows a character getting stronger, but never
                // lowered. An entry YOU hand-edited (no _auto flag) is fully locked
                // — neither raised nor lowered — so your explicit numbers win.
                const auto = existing._auto === true;
                if (auto) {
                    if (clean.default > (existing.default ?? 0)) existing.default = clean.default; // level up
                    existing.domains = existing.domains || {};
                    for (const [dk, dv] of Object.entries(clean.domains)) {
                        if (existing.domains[dk] === undefined || dv > existing.domains[dk]) existing.domains[dk] = dv;
                    }
                } else {
                    // Hand-edited: only ADD brand-new domains, never touch existing numbers.
                    existing.domains = existing.domains || {};
                    for (const [dk, dv] of Object.entries(clean.domains)) {
                        if (existing.domains[dk] === undefined) existing.domains[dk] = dv;
                    }
                }
                continue;
            }
            // A fresh considered rating replaces a prior estimated baseline (or is new).
            meta.sheet.actors[key] = clean;
            added++;
        }
        saveMeta();
        renderSheet();
        if (o.auto) {
            if (o.firstRun && added) toast('success', 'Arbiter learned the cast: ' + added + ' actor(s).', 'Auto seed');
            else dlog('auto sheet refresh: +' + added + ' actors');
        } else {
            toast('success', 'Sheet updated: ' + added + ' actor(s).', 'Arbiter seed');
        }
    }

    /* ------------------------------------------------------------------ */
    /* Auto-seeding: no commands needed                                    */
    /* ------------------------------------------------------------------ */

    let autoSeedRunning = false;

    async function maybeAutoSeed() {
        try {
            const s = getSettings();
            if (!s.enabled || !s.autoSeed || autoSeedRunning) return;
            const meta = getMeta();
            if (!meta) return;
            const actorsN = Object.keys(meta.sheet.actors || {}).length;
            const tc = meta.turnCount || 0;
            const every = clamp(s.autoSeedEvery, 10, 500);
            const firstRun = actorsN === 0 && tc >= 2;
            // PRIMARY trigger: a fight just ended — combatants changed, seed now.
            const postFight = meta.seedDueAfterFight === true;
            // FALLBACK: a slow safety-net timer for gradual off-screen change
            // (training, growth in dialogue) that no fight captured. Not the
            // main mechanism — just a backstop so the sheet never goes fully
            // stale in a long fightless stretch.
            const refresh = tc - (meta.lastAutoSeedAt ?? -999999) >= every;
            if (!firstRun && !postFight && !refresh) return;
            autoSeedRunning = true;
            meta.lastAutoSeedAt = tc;
            meta.seedDueAfterFight = false;
            saveMeta();
            const reason = firstRun ? '(first run)' : postFight ? '(post-fight)' : '(timer fallback)';
            dlog('auto-seed pass at turn', tc, reason);
            await seedSheet({ auto: true, firstRun });
            if (s.eventEngine) await seedThreads({ auto: true });
        } catch (e) {
            dlog('auto-seed failed', e);
        } finally {
            autoSeedRunning = false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Settings UI                                                         */
    /* ------------------------------------------------------------------ */

    function settingsHtml() {
        return `
<div id="arb_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Arbiter</b>&nbsp;<small class="arb_ver">v${VERSION}</small>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div id="arb_status" class="arb_status"></div>
      <div id="arb_inline_status" class="arb_inline_status" style="display:none"></div>

      <details class="arb_group" open>
        <summary><i class="fa-solid fa-sliders"></i> Core</summary>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_enabled" type="checkbox"><span>Enabled</span></label>
          <label class="checkbox_label"><input id="arb_toast" type="checkbox"><span>Toast results</span></label>
          <label class="checkbox_label"><input id="arb_showmath" type="checkbox"><span>Show math</span></label>
          <label class="checkbox_label"><input id="arb_debug" type="checkbox"><span>Debug</span></label>
        </div>
        <div class="arb_hint">Master switch · popup per ruling · include the Δ/P math in that popup · verbose console output.</div>
        <div class="arb_row">
          <label>Adjudicator profile</label>
          <select id="arb_profile" class="text_pole"></select>
          <div id="arb_profile_refresh" class="menu_button fa-solid fa-rotate" title="Refresh profiles"></div>
        </div>
        <div class="arb_hint">Point this at a fast, non-thinking endpoint. Empty = raw call on the current API (slow if your main model thinks).</div>
        <div class="arb_row">
          <label>Seeding profile <span class="arb_dim">(optional)</span></label>
          <select id="arb_seedprofile" class="text_pole"></select>
        </div>
        <div class="arb_hint">A SEPARATE connection for building the capability sheet (a bulk background task). Empty = use the adjudicator profile. Set this to a cheap, high-context model so seeding never competes with your live rulings.</div>
        <div class="arb_row">
          <label>Timeout (ms)</label><input id="arb_timeout" type="number" min="1500" max="60000" step="500" class="text_pole arb_num">
          <label>Context msgs</label><input id="arb_ctx" type="number" min="1" max="10" class="text_pole arb_num">
        </div>
        <div class="arb_hint">Timeout: max wait for the referee — on expiry the turn proceeds with no check. Context msgs: how much recent story the referee reads to judge circumstance.</div>
        <div class="arb_row">
          <label>Gate sensitivity</label>
          <select id="arb_sens" class="text_pole">
            <option value="conservative">conservative</option>
            <option value="normal">normal</option>
            <option value="aggressive">aggressive</option>
          </select>
          <label>Default rating</label><input id="arb_defrating" type="number" min="0" max="10" class="text_pole arb_num">
        </div>
        <div class="arb_hint">Gate = the free, instant filter deciding if a message even <i>might</i> be a risky attempt. Default rating: skill 0-10 assumed for anyone not on the sheet.</div>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_autoseed" type="checkbox"><span>Auto seed</span></label>
          <label>Refresh every</label><input id="arb_autoseedevery" type="number" min="10" max="500" class="text_pole arb_num">
        </div>
        <div class="arb_hint">Arbiter builds the capability sheet by itself after a few messages, then quietly re-reads story + memory every N turns — it never overwrites ratings you edited, only adds.</div>
        <div class="arb_row">
          <label>Seed transcript (k)</label><input id="arb_seedtk" type="number" min="4" max="2000" class="text_pole arb_num">
          <label>Memory (k)</label><input id="arb_seedmk" type="number" min="2" max="500" class="text_pole arb_num">
          <label>Out tokens</label><input id="arb_seedout" type="number" min="400" max="8000" step="100" class="text_pole arb_num">
        </div>
        <div class="arb_hint">Seeding runs on the adjudicator profile and ingests your full memory context plus recent transcript. Defaults (memory 60k, transcript 80k) suit a 2026 large-context model and cover a big cast out of the box; lower them only if your adjudicator is small or slow. Values are thousands of characters; output tokens cap the sheet the seeder emits.</div>
      </details>

      <details class="arb_group">
        <summary><i class="fa-solid fa-dice"></i> Outcome feel</summary>
        <div class="arb_row">
          <label>Mode</label>
          <select id="arb_mode" class="text_pole">
            <option value="adjudicated">adjudicated</option>
            <option value="fast">fast</option>
          </select>
          <label>Preset</label>
          <select id="arb_preset" class="text_pole">
            <option value="gritty">gritty</option>
            <option value="realistic">realistic</option>
            <option value="heroic">heroic</option>
          </select>
        </div>
        <div class="arb_hint">Adjudicated = referee micro-call per check (accurate). Fast = zero-latency pre-rolled pool, storyteller picks the footing (weaker). Preset: gritty = harsher tails · realistic = neutral curve · heroic = +1 player edge, halved disasters.</div>
        <div class="arb_row">
          <label>Tie window</label><input id="arb_tieband" type="number" min="0" max="0.2" step="0.01" class="text_pole arb_num">
        </div>
        <div class="arb_hint">In duels/battles, how often an even exchange becomes a TRADE (both take a hit) or STALEMATE (neither lands) instead of always having a winner — adds ebb and mutual damage to fights. 0 = off (every exchange is decisive); 0.06 default; higher = more ties. Only affects fighting exchanges, never single checks.</div>
      </details>

      <details class="arb_group">
        <summary><i class="fa-solid fa-shield-halved"></i> Combat — duels &amp; battles</summary>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_autoduel" type="checkbox"><span>Auto duel</span></label>
          <label class="checkbox_label"><input id="arb_autobattle" type="checkbox"><span>Auto battle</span></label>
          <label class="checkbox_label"><input id="arb_autowar" type="checkbox"><span>Auto war</span></label>
          <label class="checkbox_label"><input id="arb_showhud" type="checkbox"><span>HUD</span></label>
          <label class="checkbox_label"><input id="arb_showact" type="checkbox"><span>Activity bar</span></label>
          <label>Poise</label><input id="arb_poise" type="number" min="1" max="20" class="text_pole arb_num">
          <label>War strength</label><input id="arb_warstr" type="number" min="4" max="40" class="text_pole arb_num">
        </div>
        <div class="arb_hint">The referee opens duels/battles when combat clearly starts and closes them when the fiction ends one. HUD: floating round + poise bars (✕ ends the fight). Poise: 5 suits people, 6-8 mecha Frames; a "poise" key per actor in the sheet overrides.</div>
        <div class="arb_row">
          <label>Duel vs</label><input id="arb_duel_name" type="text" class="text_pole" placeholder="opponent name">
          <div id="arb_duel_start" class="menu_button">Start duel</div>
          <div id="arb_duel_end" class="menu_button">End duel</div>
        </div>
        <div class="arb_row">
          <input id="arb_battle_allies" type="text" class="text_pole" placeholder="allies: Stella, Alexia">
          <input id="arb_battle_enemies" type="text" class="text_pole" placeholder="enemies: Bandit x3, Ogre">
        </div>
        <div class="arb_buttons">
          <div id="arb_battle_start" class="menu_button">Start battle</div>
          <div id="arb_war_start" class="menu_button">Start war</div>
          <div id="arb_battle_end" class="menu_button">End battle</div>
        </div>
        <div class="arb_hint">Manual controls — same as /duel &lt;name&gt;, /duelend, /battle allies | enemies, /battleend. You are added to allies automatically; "x3" clones a unit; unlisted foes count as trained. Battle turns = a personal fight or a command to the whole side; everyone else auto-resolves.</div>
      </details>

      <details class="arb_group">
        <summary><i class="fa-solid fa-globe"></i> Background world</summary>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_eventengine" type="checkbox"><span>Event engine + threads</span></label>
        </div>
        <div class="arb_hint">Three escalating pity-timer tiers — Surprise d100 vs 95 (−3/quiet turn, ambient color), Encounter d200 vs 198 (−2, real hooks), World d500 vs 498 (−2, seismic shifts) — plus World Thread heartbeats. Never during fights; max ONE hint per turn.</div>
        <b>Encounter table</b>
        <div class="arb_hint">Comma-separated hooks the Encounter tier draws from; empty = defaults (includes new-NPC strangers: beggars, couriers, pickpockets). Hooks are tone-guarded and never force combat.</div>
        <textarea id="arb_enctypes" rows="2"></textarea>
        <b>World threads (per chat)</b>
        <div class="arb_hint">Background currents advancing on dice heartbeats: ladders rung 0 → maxRung (5-12); bias tilts odds; pace = turns between beats; two advancing at once tangle. Seeded automatically; edit freely.</div>
        <div id="arb_threads_list" class="arb_hint arb_threadlist"></div>
        <textarea id="arb_threads" rows="5"></textarea>
        <div class="arb_buttons">
          <div id="arb_threads_save" class="menu_button">Save threads</div>
          <div id="arb_threads_reload" class="menu_button">Reload</div>
          <div id="arb_threads_seed" class="menu_button">Seed from story</div>
        </div>
      </details>

      <details class="arb_group">
        <summary><i class="fa-solid fa-database"></i> Data &amp; tools</summary>
        <div class="arb_buttons">
          <div id="arb_btn_force" class="menu_button">Force next</div>
          <div id="arb_btn_skip" class="menu_button">Skip next</div>
          <div id="arb_btn_seed" class="menu_button">Seed sheet</div>
        </div>
        <div class="arb_hint">Force next: make Arbiter roll a check on your NEXT message even if the gate would not (same as /arb). Skip next: skip the check on your NEXT message (same as /arbskip). Both fire once, then reset. Seed sheet: full manual re-read of memory + story (same as /arbseed).</div>
        <div class="arb_buttons">
          <div id="arb_memsources" class="menu_button">Memory sources</div>
          <div id="arb_reset_settings" class="menu_button">Reset settings</div>
          <div id="arb_reset_chat" class="menu_button">Reset chat data</div>
        </div>
        <div class="arb_hint">Memory sources: exactly which memory injections the seeder reads right now. Reset settings: every knob back to factory defaults (asks first). Reset chat data: wipes THIS chat's sheet, threads, log, fights, caches — auto-seed rebuilds (asks first).</div>
        <b>Capability sheet (per chat)</b>
        <div class="arb_hint">{"actors": {"Name": {"default": 6, "poise": 7, "domains": {"melee": 7}}}} · scale: 2 untrained · 4 trained · 5 pro · 6 veteran · 7 elite · 8 master · 9 legendary.</div>
        <textarea id="arb_sheet" rows="7"></textarea>
        <div class="arb_buttons">
          <div id="arb_sheet_save" class="menu_button">Save sheet</div>
          <div id="arb_sheet_reload" class="menu_button">Reload</div>
        </div>
      </details>

      <details class="arb_group">
        <summary><i class="fa-solid fa-gear"></i> Advanced</summary>
        <div class="arb_row">
          <label>Inject depth</label><input id="arb_depth" type="number" min="0" max="99" class="text_pole arb_num">
          <label>Inject role</label>
          <select id="arb_role" class="text_pole">
            <option value="system">system</option>
            <option value="user">user</option>
            <option value="assistant">assistant</option>
          </select>
        </div>
        <div class="arb_hint">Where the binding note enters the prompt. Depth 0 + system = bottom of context, strongest adherence. Leave as-is unless you know why.</div>
        <div class="arb_row">
          <label>Force tag</label><input id="arb_forcetag" type="text" class="text_pole arb_num">
          <label>Skip tag</label><input id="arb_skiptag" type="text" class="text_pole arb_num">
        </div>
        <div class="arb_hint">Type these anywhere in a message: force tag guarantees a check on that fresh send, skip tag guarantees none.</div>
        <b>Verb gate list</b>
        <div class="arb_hint">Action words the free gate scans for (word-boundary + s/es/ed/ing; quoted dialogue ignored). Firing on chatter → remove verbs · attempts slipping through → add your prose's verbs.</div>
        <textarea id="arb_verbs" rows="3"></textarea>
      </details>

      <details class="arb_group">
        <summary><i class="fa-solid fa-scroll"></i> Recent adjudications</summary>
        <div class="arb_hint">Last 30 rulings with the math: Δ = actor − opposition + circumstance → P = success chance → u = the roll (low = good).</div>
        <div id="arb_log" class="arb_log"></div>
        <div class="arb_buttons"><div id="arb_log_clear" class="menu_button">Clear log</div></div>
      </details>
    </div>
  </div>
</div>`;
    }

    function renderStatus() {
        const el = $('#arb_status');
        if (!el.length) return;
        const s = getSettings();
        const meta = getMeta();
        const p = getProfiles().find(x => x.id === s.profileId);
        const chips = [];
        chips.push('<span class="arb_chip ' + (s.enabled ? 'ok' : 'bad') + '">' + (s.enabled ? 'ACTIVE' : 'DISABLED') + '</span>');
        const routed = hasWorkingRoute();
        if (p) chips.push('<span class="arb_chip ok" title="Adjudicator route">' + escHtml(p.name) + '</span>');
        else if (routed) chips.push('<span class="arb_chip warn" title="Using the main API as fallback">raw fallback</span>');
        else chips.push('<span class="arb_chip bad" title="No adjudicator profile and no connected API — seeding and checks cannot run">NO CONNECTION</span>');
        chips.push('<span class="arb_chip">' + escHtml(s.mode + ' · ' + s.preset) + '</span>');
        if (meta) {
            const actors = Object.keys(meta.sheet.actors || {}).length;
            const threads = (meta.threads || []).filter(t => !t.done).length;
            chips.push('<span class="arb_chip">' + actors + ' actors · ' + threads + ' threads</span>');
        }
        el.html(chips.join(''));
    }

    function refreshProfiles() {
        const s = getSettings();
        const sel = $('#arb_profile');
        if (!sel.length) return;
        const profiles = getProfiles();
        sel.empty();
        sel.append('<option value="">— current API (raw fallback) —</option>');
        for (const p of profiles) {
            const id = escHtml(p.id || '');
            const name = escHtml(p.name || p.id || 'profile');
            sel.append('<option value="' + id + '">' + name + '</option>');
        }
        sel.val(s.profileId || '');
        // Mirror into the optional seeding-profile selector.
        const ssel = $('#arb_seedprofile');
        if (ssel.length) {
            ssel.empty();
            ssel.append('<option value="">— same as adjudicator —</option>');
            for (const p of getProfiles()) {
                const id = escHtml(p.id || '');
                const name = escHtml(p.name || p.id || 'profile');
                ssel.append('<option value="' + id + '">' + name + '</option>');
            }
            ssel.val(s.seedProfileId || '');
        }
    }

    function renderSheet() {
        const meta = getMeta();
        const el = $('#arb_sheet');
        if (!el.length) return;
        // Show a clean view without internal flags (_auto/_estimated). Editing
        // and saving from this view yields hand-edited (locked) entries.
        let view = { actors: {} };
        try {
            const actors = meta?.sheet?.actors || {};
            for (const [name, entry] of Object.entries(actors)) {
                const { _auto, _estimated, ...rest } = entry || {};
                view.actors[name] = rest;
            }
        } catch (e) { view = meta ? meta.sheet : { actors: {} }; }
        el.val(JSON.stringify(view, null, 2));
        renderStatus();
    }

    function renderThreads() {
        const meta = getMeta();
        const el = $('#arb_threads');
        const list = $('#arb_threads_list');
        if (el.length) el.val(meta ? JSON.stringify(meta.threads, null, 1) : '[]');
        if (list.length) {
            if (!meta || !meta.threads.length) { list.html('<i>No threads. Seed some or add JSON below.</i>'); return; }
            list.html(meta.threads.map(t => {
                const max = t.maxRung ?? 8;
                const filled = Math.max(0, Math.min(max, t.rung ?? 0));
                return escHtml(t.name) + (t.done ? ' — <b>concluded</b>' : ' — ' + '▮'.repeat(filled) + '▯'.repeat(max - filled) + ' ' + filled + '/' + max);
            }).join('<br>'));
        }
        renderStatus();
    }

    function renderLog() {
        const meta = getMeta();
        const el = $('#arb_log');
        if (!el.length) return;
        if (!meta || !meta.log.length) { el.html('<i>No adjudications yet.</i>'); return; }
        const rows = meta.log.map(l => {
            const t = TIERS[l.tier] || { name: l.tier };
            return '<div class="arb_log_entry"><span class="arb_badge arb_t_' + escHtml(l.tier) + '">' +
                escHtml(t.name) + '</span>' + (l.r ? '[R' + escHtml(String(l.r)) + '] ' : '') + escHtml(l.actor + ': ' + l.action) +
                '<br><small>' + escHtml(l.domain + ' vs ' + l.opp + ' · ' + mathLine(l)) +
                (l.why ? ' · ' + escHtml(l.why) : '') + '</small></div>';
        });
        el.html(rows.join(''));
    }

    /* ------------------------------------------------------------------ */
    /* Duel HUD — floating round/poise bars                                */
    /* ------------------------------------------------------------------ */

    function poiseTone(pct) {
        if (pct > 60) return 'hi';
        if (pct > 30) return 'mid';
        return 'lo';
    }

    function combatantCell(side, sideCls) {
        const pct = Math.max(0, Math.min(100, Math.round((Math.max(0, side.poise) / side.maxPoise) * 100)));
        const initial = escHtml((side.name || '?').trim().charAt(0).toUpperCase() || '?');
        const glyphs =
            (side.momentum > 0 ? '<span class="arb_g arb_g_mom" title="momentum">▲</span>' : '') +
            (side.injuries > 0 ? '<span class="arb_g arb_g_inj" title="' + side.injuries + ' injury">✚' + (side.injuries > 1 ? side.injuries : '') + '</span>' : '') +
            (side.opening ? '<span class="arb_g arb_g_open" title="opening">◹</span>' : '');
        const low = pct <= 30 && pct > 0 ? ' arb_low' : '';
        return '' +
            '<div class="arb_cell ' + sideCls + '">' +
              '<div class="arb_disc ' + sideCls + '">' + initial + '</div>' +
              '<div class="arb_cellmain">' +
                '<div class="arb_cellrow"><span class="arb_cname">' + escHtml(side.name) + '</span>' + glyphs +
                  '<span class="arb_cnum">' + (Math.round(Math.max(0, side.poise) * 10) / 10) + '<span class="arb_cmax">/' + side.maxPoise + '</span></span></div>' +
                '<div class="arb_track"><div class="arb_fill ' + poiseTone(pct) + low + '" style="width:' + pct + '%"></div></div>' +
              '</div>' +
            '</div>';
    }

    let _lastHudHtml = '';

    function renderActivity() {
        try {
            if (typeof document === 'undefined' || !document.body || !document.createElement) return;
            const show = activity.busy && getSettings().showActivity;
            const secs = activity.startedAt ? Math.floor((Date.now() - activity.startedAt) / 1000) : 0;

            // In-panel status line (always visible where the user is looking).
            const inline = document.getElementById('arb_inline_status');
            if (inline) {
                if (activity.busy) {
                    inline.style.display = 'flex';
                    inline.innerHTML = '<span class="arb_act_spin"></span><span>' + escHtml(activity.label || 'Working') + (secs ? ' · ' + secs + 's' : '') + '</span>' +
                        '<span class="arb_act_x" title="Cancel">✕</span>';
                    const ix = inline.querySelector('.arb_act_x');
                    if (ix) { const cx = (ev) => { if (ev) { ev.preventDefault(); ev.stopPropagation(); } activity.canceled = true; }; ix.onclick = cx; ix.ontouchend = cx; }
                } else {
                    inline.style.display = 'none';
                    inline.innerHTML = '';
                }
            }

            // Floating pill.
            let el = document.getElementById('arb_activity');
            if (!show) { if (el) el.remove(); return; }
            if (!el) {
                el = document.createElement('div');
                el.id = 'arb_activity';
                // Force positioning inline so no theme/layout can bury or displace it.
                el.style.cssText = 'position:fixed;bottom:80px;right:14px;z-index:2147483647;';
                document.body.appendChild(el);
            }
            el.innerHTML = '<span class="arb_act_spin"></span>' +
                '<span class="arb_act_label">' + escHtml(activity.label) + (secs ? ' · ' + secs + 's' : '') + '</span>' +
                '<span class="arb_act_x" title="Cancel">✕</span>';
            const x = el.querySelector('.arb_act_x');
            if (x) {
                const cancel = (ev) => { if (ev) { ev.preventDefault(); ev.stopPropagation(); } activity.canceled = true; el.querySelector('.arb_act_label').textContent = 'Canceling…'; };
                x.onclick = cancel; x.ontouchend = cancel;
            }
        } catch (e) { /* the indicator must never break anything */ }
    }

    // Tick the elapsed-seconds display while busy.
    const _actTimer = setInterval(() => { if (activity.busy) { try { renderActivity(); } catch (e) { } } }, 1000);
    if (_actTimer && typeof _actTimer.unref === 'function') _actTimer.unref();

    function hudDismiss() {
        try {
            const m = getMeta();
            if (!m) return;
            if (m.battle) endBattle(m, false);
            else if (m.duel) endDuel(m, false);
            m.cache = null; // an ended fight can't be resurrected by a re-roll
            saveMeta();
        } catch (e) { warn('HUD dismiss failed', e); }
    }

    function setHudHtml(el, html) {
        el.innerHTML = html;
        const x = el.querySelector('.arb_hud_x');
        if (x) {
            x.onclick = (ev) => { ev.stopPropagation(); hudDismiss(); };
            x.ontouchend = (ev) => { ev.preventDefault(); ev.stopPropagation(); hudDismiss(); };
        }
        if (html !== _lastHudHtml) {
            _lastHudHtml = html;
            el.classList.remove('arb_hud_flash');
            void el.offsetWidth; // restart the animation
            el.classList.add('arb_hud_flash');
            setTimeout(() => { try { el.classList.remove('arb_hud_flash'); } catch (e) { } }, 700);
        }
    }

    function renderHud() {
        try {
            if (typeof document === 'undefined' || !document.body || !document.createElement) return;
            const s = getSettings();
            const meta = getMeta();
            const duel = meta && meta.duel;
            const battle = meta && meta.battle;
            let el = document.getElementById('arb_hud');
            if ((!duel || !duel.active) && (!battle || !battle.active) || !s.showHud) { if (el) el.remove(); return; }
            if (!el) {
                el = document.createElement('div');
                el.id = 'arb_hud';
                document.body.appendChild(el);
            }
            if (battle && battle.active) {
                const mc = battle.allies.find(u => u.isPlayer) || battle.allies[0];
                const sideAgg = (units) => {
                    const cur = standing(units).reduce((t, u) => t + Math.max(0, u.poise), 0);
                    const max = units.reduce((t, u) => t + u.maxPoise, 0) || 1;
                    return { pct: Math.max(0, Math.min(100, Math.round((cur / max) * 100))), up: standing(units).length, total: units.length };
                };
                const A = sideAgg(battle.allies), E = sideAgg(battle.enemies);
                const aCell = {
                    name: 'Allies', poise: A.pct, maxPoise: 100,
                    momentum: standing(battle.allies).some(u => u.momentum > 0) ? 1 : 0,
                    injuries: 0, opening: false,
                };
                const eCell = {
                    name: 'Enemies', poise: E.pct, maxPoise: 100,
                    momentum: standing(battle.enemies).some(u => u.momentum > 0) ? 1 : 0,
                    injuries: 0, opening: false,
                };
                const warTag = battle.kind === 'war' ? 'WAR ' : '';
                const badge = battle.over
                    ? '<div class="arb_badge_over">' + (battle.victor === 'allies' ? (battle.kind === 'war' ? 'FIELD TAKEN' : 'ALLIES WIN') : (battle.kind === 'war' ? 'LINE BROKEN' : 'ENEMIES WIN')) + '</div>'
                    : '<div class="arb_rbadge">' + warTag + 'R' + battle.round + '</div>';
                const counts = '<div class="arb_counts">' + A.up + '/' + A.total + ' vs ' + E.up + '/' + E.total + '</div>';
                setHudHtml(el,
                    '<div class="arb_hud_inner">' +
                      '<div class="arb_hud_top">' + badge + counts +
                        '<span class="arb_hud_x" title="End battle">✕</span></div>' +
                      '<div class="arb_hud_body">' +
                        combatantCell(aCell, 'pl') +
                        '<div class="arb_vs">VS</div>' +
                        combatantCell(eCell, 'op') +
                      '</div>' +
                      '<div class="arb_mc">' + escHtml(mc.name) + ' · ' + (Math.round(Math.max(0, mc.poise) * 10) / 10) + '/' + mc.maxPoise + (mc.injuries ? ' ✚' + mc.injuries : '') + ((battle.kind === 'war' && battle.conditions && battle.conditions.length) ? ' · ⚑' + battle.conditions.length : '') + '</div>' +
                    '</div>');
                return;
            }
            const badge = duel.over
                ? '<div class="arb_badge_over">' + (duel.victor === 'draw' ? 'DRAW — BOTH DOWN' : escHtml((duel.victor === 'player' ? duel.player.name : duel.opp.name)) + ' WINS') + '</div>'
                : '<div class="arb_rbadge">R' + duel.round + '</div>';
            setHudHtml(el,
                '<div class="arb_hud_inner">' +
                  '<div class="arb_hud_top">' + badge +
                    '<span class="arb_hud_x" title="End duel">✕</span></div>' +
                  '<div class="arb_hud_body">' +
                    combatantCell(duel.player, 'pl') +
                    '<div class="arb_vs">VS</div>' +
                    combatantCell(duel.opp, 'op') +
                  '</div>' +
                '</div>');
        } catch (e) { /* the HUD must never break anything */ }
    }

    function applySettingsToUI() {
        const s = getSettings();
        $('#arb_enabled').prop('checked', !!s.enabled);
        $('#arb_toast').prop('checked', !!s.toastResults);
        $('#arb_showmath').prop('checked', !!s.showMath);
        $('#arb_debug').prop('checked', !!s.debug);
        $('#arb_timeout').val(s.timeoutMs);
        $('#arb_ctx').val(s.ctxMsgs);
        $('#arb_sens').val(s.sensitivity);
        $('#arb_defrating').val(s.defaultRating);
        $('#arb_depth').val(s.injectDepth);
        $('#arb_role').val(s.injectRole);
        $('#arb_forcetag').val(s.forceTag);
        $('#arb_skiptag').val(s.skipTag);
        $('#arb_verbs').val(s.verbs);
        $('#arb_enctypes').val(s.encounterTypes);
        $('#arb_mode').val(s.mode);
        $('#arb_preset').val(s.preset);
        $('#arb_autoduel').prop('checked', !!s.autoDuel);
        $('#arb_autobattle').prop('checked', !!s.autoBattle);
        $('#arb_autowar').prop('checked', !!s.autoWar);
        $('#arb_warstr').val(s.warStrength);
        $('#arb_eventengine').prop('checked', !!s.eventEngine);
        $('#arb_autoseed').prop('checked', !!s.autoSeed);
        $('#arb_autoseedevery').val(s.autoSeedEvery);
        $('#arb_seedtk').val(s.seedTranscriptK);
        $('#arb_seedmk').val(s.seedMemoryK);
        $('#arb_seedout').val(s.seedOutTokens);
        $('#arb_showhud').prop('checked', !!s.showHud);
        $('#arb_showact').prop('checked', !!s.showActivity);
        $('#arb_poise').val(s.duelPoise);
        $('#arb_tieband').val(s.tieBand);
        $('#arb_profile').val(s.profileId || '');
        renderStatus();
    }

    function resetSettingsToDefaults() {
        const s = getSettings();
        for (const k of Object.keys(DEFAULTS)) s[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
        saveSettings();
        applySettingsToUI();
        renderHud();
        toast('success', 'All settings restored to factory defaults.');
    }

    function resetChatData() {
        const meta = getMeta(); if (!meta) return;
        meta.sheet = { actors: {} };
        meta.threads = [];
        meta.log = [];
        meta.cache = null;
        meta.oneShot = null;
        meta.duel = null;
        meta.battle = null;
        delete meta.eventCache;
        meta.engines = {
            surprise: { dc: ENGINE_DEFAULTS.surprise.dc0 },
            encounter: { dc: ENGINE_DEFAULTS.encounter.dc0 },
            world: { dc: ENGINE_DEFAULTS.world.dc0 },
        };
        meta.tickCount = 0;
        meta.turnCount = 0;
        meta.lastAutoSeedAt = -999999;
        saveMeta();
        renderSheet(); renderThreads(); renderLog(); renderHud();
        clearInjection();
        toast('success', 'Chat data wiped. Auto-seed will rebuild the sheet as you play.');
    }

    function bindUI() {
        const s = getSettings();

        $('#arb_enabled').prop('checked', !!s.enabled).on('change', function () { s.enabled = this.checked; saveSettings(); renderStatus(); });
        $('#arb_toast').prop('checked', !!s.toastResults).on('change', function () { s.toastResults = this.checked; saveSettings(); });
        $('#arb_showmath').prop('checked', !!s.showMath).on('change', function () { s.showMath = this.checked; saveSettings(); });
        $('#arb_debug').prop('checked', !!s.debug).on('change', function () { s.debug = this.checked; saveSettings(); });

        $('#arb_timeout').val(s.timeoutMs).on('input', function () { s.timeoutMs = clamp(this.value, 1500, 60000); saveSettings(); });
        $('#arb_ctx').val(s.ctxMsgs).on('input', function () { s.ctxMsgs = clamp(this.value, 1, 10); saveSettings(); });
        $('#arb_sens').val(s.sensitivity).on('change', function () { s.sensitivity = this.value; saveSettings(); });
        $('#arb_defrating').val(s.defaultRating).on('input', function () { s.defaultRating = clamp(this.value, 0, 10); saveSettings(); });
        $('#arb_depth').val(s.injectDepth).on('input', function () { s.injectDepth = clamp(this.value, 0, 99); saveSettings(); });
        $('#arb_role').val(s.injectRole).on('change', function () { s.injectRole = this.value; saveSettings(); });
        $('#arb_forcetag').val(s.forceTag).on('input', function () { s.forceTag = this.value; saveSettings(); });
        $('#arb_skiptag').val(s.skipTag).on('input', function () { s.skipTag = this.value; saveSettings(); });
        $('#arb_verbs').val(s.verbs).on('change', function () { s.verbs = this.value; saveSettings(); });
        $('#arb_enctypes').val(s.encounterTypes).on('change', function () { s.encounterTypes = this.value; saveSettings(); });
        $('#arb_autoseed').prop('checked', !!s.autoSeed).on('change', function () { s.autoSeed = this.checked; saveSettings(); });
        $('#arb_autoseedevery').val(s.autoSeedEvery).on('input', function () { s.autoSeedEvery = clamp(this.value, 10, 500); saveSettings(); });
        $('#arb_seedtk').val(s.seedTranscriptK).on('input', function () { s.seedTranscriptK = clamp(this.value, 4, 2000); saveSettings(); });
        $('#arb_seedmk').val(s.seedMemoryK).on('input', function () { s.seedMemoryK = clamp(this.value, 2, 500); saveSettings(); });
        $('#arb_seedout').val(s.seedOutTokens).on('input', function () { s.seedOutTokens = clamp(this.value, 400, 8000); saveSettings(); });

        $('#arb_mode').val(s.mode).on('change', function () { s.mode = this.value; saveSettings(); renderStatus(); });
        $('#arb_preset').val(s.preset).on('change', function () { s.preset = this.value; saveSettings(); renderStatus(); });
        $('#arb_autoduel').prop('checked', !!s.autoDuel).on('change', function () { s.autoDuel = this.checked; saveSettings(); });
        $('#arb_showhud').prop('checked', !!s.showHud).on('change', function () { s.showHud = this.checked; saveSettings(); renderHud(); });
        $('#arb_showact').prop('checked', !!s.showActivity).on('change', function () { s.showActivity = this.checked; saveSettings(); renderActivity(); });
        $('#arb_poise').val(s.duelPoise).on('input', function () { s.duelPoise = clamp(this.value, 1, 20); saveSettings(); });
        $('#arb_tieband').val(s.tieBand).on('input', function () { s.tieBand = clamp(this.value, 0, 0.2); saveSettings(); });
        $('#arb_duel_start').on('click', () => {
            const name = String($('#arb_duel_name').val() || '').trim();
            if (!name) { toast('warning', 'Give the opponent a name first.'); return; }
            const meta = getMeta(); if (!meta) return;
            startDuel(meta, ctx().name1 || 'Player', name, 'melee');
            saveMeta(); renderHud();
            toast('success', (ctx().name1 || 'Player') + ' vs ' + name + ' — duel armed. Your next message is round 1.');
        });
        $('#arb_duel_end').on('click', () => { const m = getMeta(); if (m && m.duel) { endDuel(m); saveMeta(); } });

        $('#arb_autobattle').prop('checked', !!s.autoBattle).on('change', function () { s.autoBattle = this.checked; saveSettings(); });
        $('#arb_autowar').prop('checked', !!s.autoWar).on('change', function () { s.autoWar = this.checked; saveSettings(); });
        $('#arb_warstr').val(s.warStrength).on('input', function () { s.warStrength = clamp(this.value, 4, 40); saveSettings(); });
        $('#arb_war_start').on('click', () => {
            const allies = String($('#arb_battle_allies').val() || '').split(',').map(x => x.trim()).filter(Boolean);
            const enemies = String($('#arb_battle_enemies').val() || '').split(',').map(x => x.trim()).filter(Boolean);
            if (!enemies.length) { toast('warning', 'Name at least one enemy formation.'); return; }
            const meta = getMeta(); if (!meta) return;
            const b = startWar(meta, allies, enemies, null);
            if (!b) { toast('error', 'War setup failed.'); return; }
            saveMeta(); renderHud();
            toast('success', standing(nonPlayer(b.allies)).length + ' formations vs ' + standing(b.enemies).length + ' — war armed. Your next message is your first order.');
        });
        $('#arb_eventengine').prop('checked', !!s.eventEngine).on('change', function () { s.eventEngine = this.checked; saveSettings(); });
        $('#arb_battle_start').on('click', () => {
            const allies = String($('#arb_battle_allies').val() || '').split(',').map(x => x.trim()).filter(Boolean);
            const enemies = String($('#arb_battle_enemies').val() || '').split(',').map(x => x.trim()).filter(Boolean);
            if (!enemies.length) { toast('warning', 'Name at least one enemy.'); return; }
            const meta = getMeta(); if (!meta) return;
            const b = startBattle(meta, allies, enemies, 'melee');
            if (!b) { toast('error', 'Battle setup failed.'); return; }
            saveMeta(); renderHud();
            toast('success', standing(b.allies).length + ' vs ' + standing(b.enemies).length + ' — battle armed. Your next message is round 1.');
        });
        $('#arb_battle_end').on('click', () => { const m = getMeta(); if (m && m.battle) { endBattle(m); saveMeta(); } });

        $('#arb_threads_save').on('click', () => {
            const meta = getMeta(); if (!meta) return;
            try {
                const arr = JSON.parse(String($('#arb_threads').val() || '[]'));
                if (!Array.isArray(arr)) throw new Error('expected a JSON array');
                meta.threads = arr.slice(0, 8).map(t => ({
                    name: String(t.name || 'thread').slice(0, 60),
                    desc: String(t.desc || '').slice(0, 160),
                    rung: clamp(t.rung ?? 0, 0, 12),
                    maxRung: clamp(t.maxRung ?? 8, 5, 12),
                    bias: clamp(Math.round(Number(t.bias) || 0), -3, 3),
                    pace: clamp(t.pace ?? 3, 1, 10),
                    lastTickAt: Number.isFinite(t.lastTickAt) ? t.lastTickAt : meta.tickCount,
                    done: !!t.done,
                }));
                saveMeta(); renderThreads();
                toast('success', 'Threads saved.');
            } catch (e) { toast('error', 'Invalid JSON: ' + e.message); }
        });
        $('#arb_threads_reload').on('click', renderThreads);
        $('#arb_threads_seed').on('click', () => { seedThreads(); });

        $('#arb_memsources').on('click', () => {
            const mem = collectMemoryBlock(5000);
            if (!mem.sources.length) { toast('warning', 'No memory injections detected right now. Open the chat and let your memory extensions inject first.'); return; }
            const lines = mem.sources.map(x => escHtml(x.key) + ' (' + x.chars + ' chars)').join('<br>');
            toast('info', lines, 'Seeder reads ' + mem.sources.length + ' source(s)');
        });
        $('#arb_reset_settings').on('click', () => {
            const sure = (typeof confirm === 'function') ? confirm('Reset ALL Arbiter settings to factory defaults?') : true;
            if (sure) resetSettingsToDefaults();
        });
        $('#arb_reset_chat').on('click', () => {
            const sure = (typeof confirm === 'function') ? confirm('Wipe THIS chat\'s Arbiter data (sheet, threads, log, fights, caches)?') : true;
            if (sure) resetChatData();
        });

        applySettingsToUI();

        $('#arb_profile').on('change', function () { s.profileId = this.value; saveSettings(); renderStatus(); });
        $('#arb_seedprofile').on('change', function () { s.seedProfileId = this.value; saveSettings(); });
        $('#arb_profile_refresh').on('click', refreshProfiles);

        $('#arb_btn_force').on('click', () => {
            const meta = getMeta(); if (!meta) return;
            meta.oneShot = 'force'; saveMeta();
            toast('info', 'Next action will be adjudicated.');
        });
        $('#arb_btn_skip').on('click', () => {
            const meta = getMeta(); if (!meta) return;
            meta.oneShot = 'skip'; saveMeta();
            toast('info', 'Next action will skip adjudication.');
        });
        $('#arb_btn_seed').on('click', () => { seedSheet(); });

        $('#arb_sheet_save').on('click', () => {
            const meta = getMeta(); if (!meta) return;
            try {
                const obj = JSON.parse(String($('#arb_sheet').val() || '{}'));
                if (!obj.actors || typeof obj.actors !== 'object') throw new Error('missing "actors" object');
                meta.sheet = obj;
                getMeta(); // re-normalize
                saveMeta();
                toast('success', 'Sheet saved.');
            } catch (e) {
                toast('error', 'Invalid JSON: ' + e.message);
            }
        });
        $('#arb_sheet_reload').on('click', renderSheet);
        $('#arb_log_clear').on('click', () => {
            const meta = getMeta(); if (!meta) return;
            meta.log = []; saveMeta(); renderLog();
        });

        refreshProfiles();
        renderSheet();
        renderLog();
        renderThreads();
    }

    /* ------------------------------------------------------------------ */
    /* Slash commands                                                      */
    /* ------------------------------------------------------------------ */

    function registerCommands() {
        const c = ctx();
        const defs = [
            ['arb', () => { const m = getMeta(); if (m) { m.oneShot = 'force'; saveMeta(); } toast('info', 'Next action will be adjudicated.'); return ''; }, 'Force Arbiter to adjudicate the next action.'],
            ['arbskip', () => { const m = getMeta(); if (m) { m.oneShot = 'skip'; saveMeta(); } toast('info', 'Next action will skip adjudication.'); return ''; }, 'Skip Arbiter on the next action.'],
            ['arbseed', () => { seedSheet(); return ''; }, 'Build/refresh the Arbiter capability sheet from the story.'],
            ['duel', (na, text) => {
                const name = String(text || '').trim();
                if (!name) { toast('warning', 'Usage: /duel <opponent name>'); return ''; }
                const m = getMeta(); if (!m) return '';
                startDuel(m, ctx().name1 || 'Player', name, 'melee');
                saveMeta(); renderHud();
                toast('success', 'Duel armed vs ' + name + '. Your next message is round 1.');
                return '';
            }, 'Start a duel against <opponent name>.'],
            ['duelend', () => { const m = getMeta(); if (m && m.duel) { endDuel(m); saveMeta(); } return ''; }, 'End the active duel.'],
            ['battle', (na, text) => {
                const t = String(text || '');
                const parts = t.split('|');
                const enemiesStr = parts.length > 1 ? parts[1] : parts[0];
                const alliesStr = parts.length > 1 ? parts[0] : '';
                const allies = alliesStr.split(',').map(x => x.trim()).filter(Boolean);
                const enemies = enemiesStr.split(',').map(x => x.trim()).filter(Boolean);
                if (!enemies.length) { toast('warning', 'Usage: /battle allies | enemies  (e.g. /battle Stella, Alexia | Bandit x3, Ogre)'); return ''; }
                const m = getMeta(); if (!m) return '';
                const b = startBattle(m, allies, enemies, 'melee');
                if (!b) { toast('error', 'Battle setup failed.'); return ''; }
                saveMeta(); renderHud();
                toast('success', standing(b.allies).length + ' vs ' + standing(b.enemies).length + ' — battle armed. Your next message is round 1.');
                return '';
            }, 'Start a group battle: /battle allies | enemies (allies optional; x3 clones a unit).'],
            ['battleend', () => { const m = getMeta(); if (m && m.battle) { endBattle(m); saveMeta(); } return ''; }, 'End the active battle.'],
            ['war', (na, text) => {
                const t = String(text || '');
                const parts = t.split('|');
                const enemiesStr = parts.length > 1 ? parts[1] : parts[0];
                const alliesStr = parts.length > 1 ? parts[0] : '';
                const allies = alliesStr.split(',').map(x => x.trim()).filter(Boolean);
                const enemies = enemiesStr.split(',').map(x => x.trim()).filter(Boolean);
                if (!enemies.length) { toast('warning', 'Usage: /war allied formations | enemy formations'); return ''; }
                const m = getMeta(); if (!m) return '';
                const b = startWar(m, allies, enemies, null);
                if (!b) { toast('error', 'War setup failed.'); return ''; }
                saveMeta(); renderHud();
                toast('success', standing(nonPlayer(b.allies)).length + ' formations vs ' + standing(b.enemies).length + ' — war armed. Your next message is your first order.');
                return '';
            }, 'Take command: /war allied formations | enemy formations (xN clones).'],
            ['warend', () => { const m = getMeta(); if (m && m.battle) { endBattle(m); saveMeta(); } return ''; }, 'End the active war/battle.'],
            ['foe', (na, text) => {
                const name = String(text || '').trim();
                if (!name) { toast('warning', 'Usage: /foe <correct opponent name>'); return ''; }
                const m = getMeta(); if (!m) return '';
                if (m.duel && m.duel.active) { m.duel.opp.name = name.slice(0, 60); saveMeta(); renderHud(); toast('success', 'Opponent renamed to ' + name + '.'); }
                else { toast('warning', 'No active duel to rename. (For battles/wars, edit the roster.)'); }
                return '';
            }, 'Rename the current duel opponent (fixes a misnamed foe live).'],
            ['arbforget', (na, text) => {                const name = String(text || '').trim();
                const m = getMeta(); if (!m) return '';
                if (!name) { toast('warning', 'Usage: /arbforget <name to remove from the sheet>'); return ''; }
                const actors = m.sheet?.actors || {};
                let removed = null;
                for (const k of Object.keys(actors)) {
                    if (k.toLowerCase() === name.toLowerCase() || k.toLowerCase().includes(name.toLowerCase())) { delete actors[k]; removed = k; break; }
                }
                saveMeta(); renderSheet();
                toast(removed ? 'success' : 'warning', removed ? 'Removed "' + removed + '" from the sheet.' : 'No sheet entry matched "' + name + '".');
                return '';
            }, 'Remove a wrongly-added actor (e.g. a place) from the capability sheet.'],
            ['condition', (na, text) => {
                // /condition Name | broken arm | -2      → add a handicap
                // /condition Name | -remove | broken arm → clear one
                const t = String(text || '').trim();
                const parts = t.split('|').map(x => x.trim());
                const m = getMeta(); if (!m) return '';
                if (parts.length < 2) { toast('warning', 'Usage: /condition <name> | <condition> | <mod, e.g. -2>   ·   or   /condition <name> | -remove | <condition>'); return ''; }
                const name = parts[0];
                if (/^-?remove$/i.test(parts[1])) {
                    const note = applyConditionChange(m, { who: name, remove: parts[2] || '', add: null, mod: 0 });
                    saveMeta(); renderSheet();
                    toast(note ? 'success' : 'warning', note || 'No matching condition to remove.');
                } else {
                    const cond = parts[1];
                    const mod = parts.length >= 3 ? clamp(parseInt(parts[2], 10) || -1, -4, 2) : -1;
                    const note = applyConditionChange(m, { who: name, add: cond, remove: null, mod });
                    saveMeta(); renderSheet();
                    toast('success', note || (name + ': ' + cond + ' (' + mod + ')'));
                }
                return '';
            }, 'Set or clear a lasting handicap: /condition Name | broken arm | -2  (or)  /condition Name | -remove | broken arm.'],
            ['arbthreads', () => { seedThreads(); return ''; }, 'Seed World Threads (background currents) from the story.'],
        ];
        let registered = false;
        try {
            if (typeof c.registerSlashCommand === 'function') {
                for (const [name, cb, help] of defs) c.registerSlashCommand(name, cb, [], help, true, true);
                registered = true;
            }
        } catch (e) { dlog('legacy slash registration failed', e); }
        if (!registered) {
            try {
                const P = c.SlashCommandParser;
                const SC = c.SlashCommand;
                if (P?.addCommandObject && SC?.fromProps) {
                    for (const [name, cb, help] of defs) {
                        P.addCommandObject(SC.fromProps({ name, callback: cb, helpString: help }));
                    }
                    registered = true;
                }
            } catch (e) { dlog('modern slash registration failed', e); }
        }
        if (!registered) warn('Slash commands unavailable — use the panel buttons instead.');
    }

    /* ------------------------------------------------------------------ */
    /* Init                                                                */
    /* ------------------------------------------------------------------ */

    function initEvents() {
        const c = ctx();
        const es = c.eventSource;
        const et = c.event_types || {};
        if (!es || !es.on) { warn('eventSource unavailable'); return; }
        if (et.GENERATION_ENDED) es.on(et.GENERATION_ENDED, () => { clearInjection(); maybeAutoSeed(); });
        if (et.GENERATION_STOPPED) es.on(et.GENERATION_STOPPED, () => clearInjection());
        if (et.CHAT_CHANGED) es.on(et.CHAT_CHANGED, () => {
            clearInjection();
            renderSheet();
            renderLog();
            renderHud();
            renderThreads();
        });
    }

    async function init() {
        try {
            getSettings();
            const target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
            target.append(settingsHtml());
            bindUI();
            registerCommands();
            initEvents();
            clearInjection();
            renderHud();
            console.log(LOG, 'v0.1 ready');
        } catch (e) {
            console.error(LOG, 'init failed', e);
        }
    }

    if (typeof jQuery === 'function') {
        jQuery(() => {
            const c = (() => { try { return ctx(); } catch (e) { return null; } })();
            const et = c?.event_types || {};
            if (c?.eventSource?.on && et.APP_READY) {
                let done = false;
                c.eventSource.on(et.APP_READY, () => { if (!done) { done = true; init(); } });
                // APP_READY may already have fired before this extension loaded:
                setTimeout(() => { if (!done && document.getElementById('extensions_settings')) { done = true; init(); } }, 3000);
            } else {
                init();
            }
        });
    }
})();
