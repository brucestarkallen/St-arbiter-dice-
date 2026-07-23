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
    const VERSION = '0.34.0';
    const INJECT_KEY = 'ARBITER_OUTCOME';
    const LOG = '[Arbiter]';
    // Committed-turn history depth: how many resolved player turns keep a
    // rewindable world snapshot (deleting/branching past this falls back to
    // the oldest retained snapshot).
    const HISTORY_CAP = 12;

    /** Deep copy for snapshot state. structuredClone where available (faster,
     *  far less garbage than JSON round-trips — this runs every turn). */
    function deepCopy(o) {
        if (o === null || o === undefined) return null;
        try {
            if (typeof structuredClone === 'function') return structuredClone(o);
        } catch (e) { /* fall through */ }
        return JSON.parse(JSON.stringify(o));
    }

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
        const token = activity.startedAt; // the activity THIS clear belongs to
        const elapsed = token ? Date.now() - token : MIN_VISIBLE;
        const finish = () => {
            // A newer activity may have started while this finish was pending —
            // never clobber it (its ✕ cancel must stay live for its whole run).
            if (activity.startedAt !== token) return;
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
            text: 'It succeeds, BUT attach a PROPORTIONATE cost — a small tax on the win, never a reversal of it: a ceded position, a strained or half-spent resource, lost tempo, minor harm, or a sliver of unwanted notice. Keep it contained. A cost at THIS level must not undo what the player deliberately achieved — do NOT blow a secret, cover, or concealment they took pains to protect; at most a faint, deniable flicker of suspicion they can still manage. Fully exposing a guarded secret is a SETBACK-or-worse beat, earned by a bad result — not invented off a success.',
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
        // The rating-guide vocabulary the prompts teach (2 untrained … 10 apex).
        // Models emit these words as opposition tiers; unresolved they silently
        // collapsed to a flat 5, flattening a "legendary" foe to average.
        untrained: 2, competent: 5, veteran: 6, master: 8, legendary: 9, apex: 10,
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
    function applyExchangeEffects(pl, op, tier, margin) {
        const fx = EXCHANGE_EFFECTS[tier] || EXCHANGE_EFFECTS.FAILURE;
        const p = Object.assign({}, pl);
        const o = Object.assign({}, op);
        // A lopsided exchange lands HARDER, not just more often. `margin` is the
        // signed Δ from the player/acting side's view; the bigger the winner's
        // edge, the more poise their blow strips (a 7-melee brawler dismantling a
        // 5-mage should wreck them, not chip). Symmetric — a superior foe hits
        // the player just as hard. Close fights (|margin| ≤ 2) are unchanged, so
        // the audited even-odds attrition economy is preserved. Bonus capped so
        // no single blow is unbounded.
        const m = Number(margin) || 0;
        let selfDmg = fx.self, oppDmg = fx.opp;
        if (fx.winner === 'self' && oppDmg > 0) oppDmg += clamp(m - 2, 0, 3);
        else if (fx.winner === 'opp' && selfDmg > 0) selfDmg += clamp(-m - 2, 0, 3);
        p.poise = Math.round((p.poise - selfDmg) * 2) / 2;
        o.poise = Math.round((o.poise - oppDmg) * 2) / 2;
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
        // A botched stratagem hands the ENEMY the same kind of standing advantage
        // a good one hands you — otherwise stratagems are a one-way ratchet and the
        // player's army can't lose. Mirrored: DECISIVE/DISASTER +/-2,
        // SUCCESS/FAILURE +/-1, SUCCESS_COST/SETBACK +/-1.
        SETBACK: { condMod: 1, favors: 'enemies', opening: true },
        FAILURE: { condMod: 1, favors: 'enemies', enemyMomentum: true },
        DISASTER: { condMod: 2, favors: 'enemies' },
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
        compactRecent, budgetedTranscript, buildAdjUserPrompt, collectStoryContext,
        wiActivateEntries, collectWorldInfoBlock, wiResolveBooks, wiViaEngine, backgroundTick,
        resolveDuelSequence, resolveDuelExchange, normalizeDuelAdj, buildDuelDirective, buildDuelSequenceDirective, buildDirective,
        startBattle, resolveBattleRound, buildBattleDirective, startWar, resolveWarRound, buildWarDirective, normalizeBattleAdj, normalizeWarAdj, normalizeAdj, startDuel,
        resolveDuelRecovery, resolveAdj, shiftCombatantComposure, findActor, findActorExact, findActorKey, findActorKeySamePerson, applyConditionChange, liveCombatant, refreshLiveRating, mcName, mcAliases, isMcAlias, samePersonName, reconcilePlayerEntries, seedSheet, combatDomain, buildArmedDirective, guardLines, restoreSnapshot, deepCopy, ratingFor, getDefaults: () => DEFAULTS, getLastAdj: () => LAST_ADJ,
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
        'cripple', 'maim', 'wound', 'curse', 'hex', 'poison', 'blind', 'mend', 'heal', 'cleanse', 'cure',
    ].join(', ');

    const DEFAULTS = {
        enabled: true,
        profileId: '',            // Connection Manager profile for the adjudicator
        seedProfileId: '',        // OPTIONAL separate profile for seeding (bulk/background); empty = use adjudicator profile
        timeoutMs: 12000,         // generous budget so a rich-context check never gets cut off
        ctxMsgs: 10,              // recent messages given to the adjudicator (full immediate window)
        // ── Referee context payload (all opt-in; the referee ALWAYS uses its own
        //    neutral system prompt, never SillyTavern's, so that is never included) ──
        adjIncludeMemory: true,   // feed the full memory stack (Summaryception, ledger, notepad, lore, Author's Note) into EVERY check
        adjIncludeCard: true,     // feed the active character card's descriptive fields (description, personality, scenario) into EVERY check
        adjIncludeWorld: false,   // feed activated World Info / lorebook entries (constant + keyword-triggered) into EVERY check
        adjWorldBooks: '',        // OPTIONAL comma list pinning specific lorebooks; empty = the active book(s) from ST's dropdown
        adjFullChat: false,       // feed a large budgeted transcript instead of just the last ctxMsgs messages
        adjContextK: 40,          // transcript budget in thousands of chars when adjFullChat is on
        adjIncludeHidden: false,  // include ST-hidden ("ghosted") messages too (Arbiter's own directives are always excluded)
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
        fightStyle: 'tracked',    // tracked = poise, injuries & a called winner | outcome = verdicts only, no health, storyteller ends fights
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
        seedOutTokens: 6000,      // max tokens the seeder may emit (headroom for very large casts)
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

    /** Outcome-only fights: every exchange still gets a full-curve verdict,
     *  but nothing is tallied — no poise, no forced injuries, no momentum,
     *  and the engine NEVER declares a winner. The fight ends when the
     *  storyteller's fiction ends it (the referee's combat_ended detection
     *  and the manual controls still close it). */
    function outcomeOnly() { return getSettings().fightStyle === 'outcome'; }

    /** One-line plain meaning per verdict, for the log and toasts — so a
     *  bare tier name is never a mystery. Directives carry the full text. */
    const TIER_MEANING = {
        DECISIVE: 'clean success — better than intended',
        SUCCESS: 'succeeds as intended',
        SUCCESS_COST: 'succeeds, but with a proportionate cost',
        TRADE: 'both land real hits — mutual damage',
        STALEMATE: 'neither side gains — the exchange resolves nothing',
        SETBACK: 'fails, but forward — the loss opens a real next move',
        FAILURE: 'fails as attempted',
        DISASTER: 'fails badly — it backfires',
        ARMED: 'fight joined — nothing rolled yet',
    };

    /** A duel is FOUGHT in a combat domain. An opener the referee classified
     *  as talk (a taunt scored 'social') must never arm a social duel — the
     *  fight's weapons decide the domain, defaulting to melee. */
    function combatDomain(d) {
        const x = String(d || '').toLowerCase().trim();
        return (!x || x === 'social' || x === 'intellect' || x === 'craft' || x === 'stealth') ? 'melee' : x;
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
    /* Player identity — the STORY name vs the persona label               */
    /* ------------------------------------------------------------------ */
    /** The player's in-story name. SillyTavern's name1 is the PERSONA LABEL
     *  (who is typing); the fiction may call the character something entirely
     *  different (persona "LO" playing "Jovan Oda") — zero shared tokens, so
     *  no fuzzy matcher can bridge them. meta.mcName — set in Manual
     *  controls, by /mcname, or learned by the sheet seeder — is the story
     *  identity used for prompts, sheet lookups, fights, conditions, and
     *  logs; empty falls back to the label so single-name setups behave
     *  exactly as before. Chat-scoped: each chat is its own universe. */
    function mcName(meta) {
        const m = meta || getMeta();
        const v = m && typeof m.mcName === 'string' ? m.mcName.trim() : '';
        return v || ctx().name1 || 'Player';
    }

    /** Every name that means "the player": the story name plus, when it
     *  differs, the persona label (the transcript still tags the player's
     *  messages with the label, and the referee may echo either). */
    function mcAliases(meta) {
        const out = [mcName(meta)];
        const label = String(ctx().name1 || '').trim();
        if (label && label.toLowerCase() !== out[0].toLowerCase()) out.push(label);
        return out;
    }

    /** Same-person identity between two raw names: exact, or one name's
     *  tokens a subset of the other's ("Kaiser" ↔ "Kaiser von Adler").
     *  Token-based, never a substring, and a merely shared surname is NOT
     *  identity (a sibling carries a distinct given name). */
    function samePersonName(a, b) {
        const nrm = (x) => String(x || '').toLowerCase().trim();
        const toks = (x) => nrm(x).split(/[\s,]+/).filter(Boolean);
        const at = toks(a), bt = toks(b);
        if (!at.length || !bt.length) return false;
        return nrm(a) === nrm(b) || at.every(t => bt.includes(t)) || bt.every(t => at.includes(t));
    }

    /** Is `name` the player under ANY alias? Same token semantics as the
     *  opponent hardening: exact, a fragment of an alias (a bare surname or
     *  given name), or an alias extended ("Jovan" ↔ "Jovan Wessex"). */
    function isMcAlias(meta, name) {
        const n = String(name || '').trim();
        if (!n) return false;
        return mcAliases(meta).some(a => samePersonName(n, a));
    }

    /** Heal a split identity: when the story name is known and a SEPARATE
     *  sheet entry sits under the persona label (conditions the referee filed
     *  on "LO" while the ratings live on "Jovan Oda"), fold the label entry
     *  into the story entry. Existing story-entry values win; the label entry
     *  only fills missing domains and contributes its conditions. */
    function reconcilePlayerEntries(meta) {
        if (!meta || !meta.sheet || !meta.sheet.actors) return false;
        const story = mcName(meta);
        const label = String(ctx().name1 || '').trim();
        if (!label || label.toLowerCase() === story.toLowerCase()) return false;
        let labelKey = null;
        for (const k of Object.keys(meta.sheet.actors)) {
            if (k.toLowerCase().trim() === label.toLowerCase()) { labelKey = k; break; }
        }
        if (!labelKey || samePersonName(labelKey, story)) return false;
        const storyKey = findActorKeySamePerson(meta, story);
        const src = meta.sheet.actors[labelKey];
        if (!src || typeof src !== 'object') return false;
        let dst = storyKey ? meta.sheet.actors[storyKey] : null;
        if (!dst) {
            dst = { default: clamp(src.default ?? 5, 0, 10), domains: {}, _auto: src._auto === true };
            meta.sheet.actors[story] = dst;
        }
        dst.domains = dst.domains || {};
        for (const [d, v] of Object.entries(src.domains || {})) {
            if (dst.domains[d] === undefined) dst.domains[d] = v;
        }
        if (Array.isArray(src.conditions) && src.conditions.length) {
            dst.conditions = Array.isArray(dst.conditions) ? dst.conditions : [];
            const have = new Set(dst.conditions.map(cn => String(cn.name || '').toLowerCase()));
            for (const cn of src.conditions) {
                if (!have.has(String(cn.name || '').toLowerCase())) dst.conditions.push(cn);
            }
        }
        if (Number.isFinite(Number(src.poise)) && dst.poise === undefined) dst.poise = src.poise;
        delete meta.sheet.actors[labelKey];
        dlog('player identity reconciled:', labelKey, '→', storyKey || story);
        return true;
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
    /** A stored profileId whose profile still exists in Connection Manager.
     *  A DELETED profile's id lingers in settings; treating it as a live route
     *  silently killed every check (the profile branch captured the call and
     *  returned empty, never falling through to a working raw API). An empty
     *  profiles list means "can't verify" and trusts the id. */
    function liveProfileId(pid) {
        if (!pid) return '';
        const list = getProfiles();
        return (list.length === 0 || list.some(p => p && p.id === pid)) ? pid : '';
    }

    function hasWorkingRoute() {
        try {
            const c = ctx();
            const s = getSettings();
            if (liveProfileId(s.profileId) && c.ConnectionManagerRequestService?.sendRequest) return true;
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
            if (res && typeof res === 'object') {
                let v = res.content ?? res.text ?? '';
                // Chat-completion shapes can hand content back as an array of
                // parts; String() on that yields "[object Object]" garbage.
                if (Array.isArray(v)) v = v.map(p => typeof p === 'string' ? p : String((p && (p.text ?? p.content)) ?? '')).join('');
                return String(v).trim();
            }
            return '';
        };

        // Race a promise against the time budget WITHOUT leaking the budget
        // timer: a fast response used to leave a 45-60s setTimeout pending per
        // call — dozens of stale timers churning on a phone during heavy play.
        const raceBudget = async (p, ms) => {
            let t = null;
            const timeout = new Promise(res => { t = setTimeout(() => res(null), ms); });
            try { return await Promise.race([p, timeout]); }
            finally { if (t) clearTimeout(t); }
        };

        try {
            const pid = liveProfileId(profileOverride || s.profileId);
            if ((profileOverride || s.profileId) && !pid) dlog('adjudicator profile no longer exists; using raw fallback');
            const svc = c.ConnectionManagerRequestService;
            if (pid && svc && typeof svc.sendRequest === 'function') {
                const messages = [
                    { role: 'system', content: systemText },
                    { role: 'user', content: userText },
                ];
                const res = await raceBudget(
                    svc.sendRequest(pid, messages, maxTokens, { signal: controller.signal, extractData: true }),
                    budgetMs + 250);
                const out = extract(res);
                if (out) return out;
                dlog('profile call returned empty after', Date.now() - started, 'ms');
                return '';
            }

            // Fallback: raw generation on the current API (may be your slow
            // thinking model — the timeout still protects the turn).
            if (typeof c.generateRaw === 'function') {
                const attempt = async (fn) => {
                    const res = await raceBudget(fn(), budgetMs);
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
            i = end + 1;
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

    // Shared across ALL referee schemas (single checks AND fight rounds) so
    // the four prompts can never drift apart on this field's semantics.
    const COND_CHANGE_FIELD = '"condition_change": null | {"who": "<player or a named character>", "add": "<short lasting condition or piece of gear just established, e.g. broken left arm, poisoned, exhausted, OR a signature weapon/armor like masterwork blade, enchanted plate — or null>", "remove": "<a prior condition/gear the fiction just resolved (healed, lost, broken), or null>", "mod": <integer -4..3, effect while it lasts; afflictions negative (broken arm -2), good gear positive (fine sword +1, legendary weapon +2 or +3)>, "domain": "<optional: the ONE domain this affects, e.g. melee for a sword, ranged for a bow; omit for whole-body effects like a curse or exhaustion>", "gear": true|false}. Set the moment the story establishes/removes something PERSISTENT (lasts beyond this scene). Gear (weapons, armor, tools) sets gear:true so it is not stripped by healing. Leave null when nothing persistent changed.';

    // Shared across ALL referee schemas so ESTABLISHED DEFENSES are judged
    // identically in single checks, duels, battles, and wars — and so no brief
    // can drift on their semantics.
    const GUARD_FIELD = '"player_guard": null | "<an ACTIVE protection the player is MAINTAINING this beat, per the ESTABLISHED fiction — a total or partial defense the story has already defined (an untouchable barrier, a ward, intangibility, a shield-art, armor of the world\'s own rules). State it as a CONSTRAINT, e.g. Infinity holds: nothing physical reaches his body; only the sword\'s veil is lowered. Null when no such stated defense is up.>"';
    const COUNTER_FIELD = '"counter_path": null | "<set ONLY with player_guard: the ONE honest way the opponent can still harm or truly pressure the player THIS beat despite that guard, rooted in the established fiction — e.g. the exposed blade can be seized; the ground under him can be shattered; the veil must widen the instant he commits, and that instant can be struck; he can be forced off the ledge; his output can be outlasted. If the guard genuinely forecloses every path this beat, use null — do NOT invent one to seem fair.>"';
    const GUARD_RULE = '- player_guard / counter_path: read the ESTABLISHED fiction, not genre habit. When a maintained guard forecloses direct harm and you find NO honest counter_path, the opponent cannot land contact this beat — a bad result then means the player\'s OWN attempt failing (read, evaded, stopped), ground or tempo lost, or the guard strained, never an impossible touch. A real counter_path both licenses the opponent\'s side of the outcome AND is exactly what the narration must name. A guard the opponent has no answer to is also strong POSITIVE circumstance for the player\'s safety — though their own attack through or around it can still fail on its merits.';

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
        ' "duel_start": null | "<opponent name — set this when combat against ONE named person truly OPENS: an actual attempted strike, lunge, shot, grapple, or power unleashed AT them (even if you expect it to be quick or one-sided), OR when both sides have clearly squared up to fight — blades drawn, stances taken, the duel accepted — though nothing has been swung yet. In the squared-up case set duel_start together with check=false: the duel arms, NOTHING is rolled, and the first real attempt becomes round 1. When in doubt between a single check and a duel for an actual attack on a person, prefer the duel.>",',
        ' "opponent_rating": null | <integer 0-10 — set ONLY when you also set duel_start or battle_start AND the opponent is NOT already in the sheet. Estimate combat capability from the scene and description. Scale (by effective threat, NOT species): 2 untrained, 4 trained, 5 competent professional, 6 veteran, 7 elite, 8 master, 9 legendary, 10 apex. This applies to ANY combatant — a person, beast, dragon, alien, machine, or monster — rated by how dangerous it actually is: a feral dog 3, a trained warhound 5, a dire beast 7, an ancient dragon or apex monster 9-10. When a creature is so far beyond human scale that raw skill barely matters, rate it 10 AND set scale_mismatch below.>",',
        ' "scale_mismatch": null | <integer -4..4 — set ONLY in combat where the two sides are CATEGORICALLY mismatched in size, mass, or power (a human vs a dragon, a footsoldier vs a war-mech, a child vs a bear). This is an ADDITIONAL swing on top of ratings, representing that skill alone cannot close the gap. From the PLAYER\'s perspective: strongly negative when the player is hopelessly outmatched by something vast (a normal human attacking a dragon head-on: -3 or -4), strongly positive when the player is the vast one crushing something tiny. 0 or null when both sides are roughly the same scale (human vs human, dragon vs dragon), even if their skill differs. An equalizer in the fiction — a dragon-slaying spear, a mech of their own, a weak point exposed — reduces the magnitude.>",',
        ' ' + GUARD_FIELD + ',',
        ' ' + COUNTER_FIELD + ',',
        ' "composure_change": null | <integer -3..3 — the mental toll or relief of THIS moment on the player. Negative when the player faces horror, terror, gruesome death, existential dread, betrayal, or crushing loss (a mild shock -1, witnessing atrocity -2, mind-shattering cosmic horror -3). Positive when the player finds safety, rest, reassurance, or a grounding victory (+1 to +2). 0 for ordinary moments. This is the FICTION\'s emotional weight, independent of any dice outcome. Judge from what happens to the player, not whether an action succeeds.>",',
        ' ' + COND_CHANGE_FIELD,
        ' "battle_start": null | {"allies": ["<name>", ...], "enemies": ["<name or generic squad like Guard x3>", ...]} — set this when combat begins against MULTIPLE opponents at once, OR when the player attacks/affects a GROUP (e.g. "sweep through the guards", "hit all of them"). If the opponents are unnamed, invent a fitting generic squad with a count (e.g. "Guard x3", "Bandit x4"). List allies EXCLUDING the player. This is for skirmish-scale group combat (a handful per side), NOT army-scale warfare.},',
        ' "war_start": null | {"allies": ["<formation, e.g. Left Flank, 3rd Cavalry, Zero Squadron>", ...], "enemies": ["<enemy formation>", ...], "enemy_commander": "<name or null>"} — set when the player takes COMMAND of army-scale combat: leading forces, issuing orders to units/formations/squadrons. Invent sensible formation names from the fiction if unnamed (2-5 per side).,',
        ' "army_scale": null | "<short name for the larger conflict — set ONLY when the player is caught in mass warfare WITHOUT commanding it (a soldier or bystander in the melee); if they command, use war_start instead>"}',
        '',
        'Rules:',
        '- check=true ONLY when THIS message commits an attempt whose outcome is genuinely uncertain RIGHT NOW. A message that merely promises, prepares, discusses, or recalls an action attempts nothing — check=false.',
        '- check=false for: dialogue, taunts, boasts, threats, banter, or negotiation — talk is talk, even mid-standoff and even with a blade drawn; routine or trivial actions with no meaningful chance of interesting failure; pure narration; actions attempted by characters other than the player.',
        '- check=false for DECLARATIONS and INTENT: future tense and plans ("I will...", "I\'m going to...", "perhaps I\'ll be the third") and negations ("I\'m not going to use my full power") describe what MAY happen — nothing is attempted now.',
        '- check=false for PREPARATION and POSTURE: drawing or sheathing a weapon, taking position, assuming a stance, sizing an opponent up, or powering up/readying an ability WITHOUT releasing it at anyone. These can still OPEN a fight — see duel_start.',
        '- check=false for OUT-OF-CHARACTER or DIRECTORIAL text: bracketed notes, questions to the narrator, prompts like "what would <character> do", intervention windows, or instructions about the scene. These are never the player attempting anything.',
        '- check=false for actions ALREADY RESOLVED: restating or recapping what earlier narration settled is not a new attempt — never re-roll what has already happened.',
        '- circumstance is PHYSICAL tactical advantage ONLY: position, momentum, surprise, preparation, exposure of the target, terrain, impairment, haste. Reward concrete tactics and exploited PHYSICAL weaknesses (+); penalize bad position, impairment, or haste (-). Use 0 when nothing notable applies.',
        '- NEVER penalize an action for being illegal, dishonorable, a foul, against duel etiquette, unsporting, or immoral, and never mention rules, sanctions, penalties, or disqualification. You do not know this world\'s rules; whether a move is "allowed" is the storyteller\'s to narrate, not yours to score. A dirty tactic that gives a real physical edge (a groin kick, sand in the eyes, a low blow) is a POSITIVE circumstance, not a negative one. Judge only what works, not what is permitted.',
        '- The opponent is WHOEVER the fiction says the player is fighting in <recent>/<action>. Use that name. If they are also on the sheet, use the sheet spelling; if not, still name them from the fiction and set opposition_kind "actor" (they will be rated as trained). NEVER substitute a different sheet name just because it is familiar — the scene\'s named opponent always wins over a sheet entry.',
        '- The opponent is NEVER the player. Do NOT use the player\'s name, or ANY part of it (their given name OR their family name/surname), as the opponent (in "opposition" or "duel_start"). The <player> block names the player; EVERY part of that name is the player. For example, if the player is "Alex Vance", then BOTH "Alex" and "Vance" are the player — the opponent is never either. Name the opponent by the opponent\'s OWN name as the scene uses it (their given name is fine); if you cannot find a name distinct from the player\'s, the action is probably a single check, not a duel.',
        '- opposition must be a PERSON or creature the player fights. Never use a place, academy, house, faction, or organization name as the opposition.',
        GUARD_RULE,
    ].join('\n');

    // Arbiter's own injected directives can surface as messages in some setups;
    // never feed them back to the referee (it would be grading its own output).
    const isArbiterLine = (m) => typeof m.mes === 'string' && /^\s*\[ARBITER/i.test(m.mes);

    function compactRecent(chat, n, excludeMes, includeHidden) {
        const out = [];
        for (let i = chat.length - 1; i >= 0 && out.length < n; i--) {
            const m = chat[i];
            if (!m || !m.mes || m === excludeMes) continue;
            if (m.is_system && !includeHidden) continue;
            if (isArbiterLine(m)) continue;
            const name = m.name || (m.is_user ? 'Player' : 'AI');
            out.push(name + ': ' + String(m.mes).replace(/\s+/g, ' ').slice(0, 300));
        }
        return out.reverse().join('\n');
    }

    /** Rich-mode transcript: as much of the chat as fits a char budget, at fuller
     *  width than the lean 300-char clip. Skips hidden messages unless asked, and
     *  always skips Arbiter's own directives. */
    function budgetedTranscript(chat, budgetChars, excludeMes, includeHidden) {
        const parts = [];
        let chars = 0;
        for (let i = chat.length - 1; i >= 0 && chars < budgetChars; i--) {
            const m = chat[i];
            if (!m || !m.mes || m === excludeMes) continue;
            if (m.is_system && !includeHidden) continue;
            if (isArbiterLine(m)) continue;
            const line = (m.name || (m.is_user ? 'Player' : 'AI')) + ': ' + String(m.mes).replace(/\s+/g, ' ').slice(0, 2000);
            chars += line.length;
            parts.push(line);
        }
        return parts.reverse().join('\n');
    }

    function buildAdjUserPrompt(chat, lastUserMes, meta) {
        const s = getSettings();
        const playerName = mcName(meta);
        const playerLabel = ctx().name1 || '';
        const labelNote = (playerLabel && playerLabel.toLowerCase() !== playerName.toLowerCase())
            ? ' The player\'s own messages in <recent> are labeled "' + playerLabel + '" — that label is the SAME person as ' + playerName + ', never a separate character and never the opponent.'
            : '';
        const sheet = JSON.stringify(meta.sheet || { actors: {} });
        const recent = s.adjFullChat
            ? budgetedTranscript(chat, clamp(s.adjContextK, 4, 500) * 1000, lastUserMes, !!s.adjIncludeHidden)
            : compactRecent(chat, clamp(s.ctxMsgs, 1, 10), lastUserMes, !!s.adjIncludeHidden);
        const action = String(lastUserMes.mes).slice(0, 700);
        const memBlock = s.adjIncludeMemory ? collectMemoryBlock(clamp(s.adjContextK, 4, 500) * 1000).block : '';
        const cardBlock = s.adjIncludeCard ? collectStoryContext(clamp(s.adjContextK, 4, 500) * 1000) : '';
        return '<player>\nThe player character is "' + playerName + '". The text in <action> is written BY the player: "I" and second-person "you" in it both mean ' + playerName + ' acting.' + labelNote + ' The player may appear in <recent> under a FULLER name — a given name plus a family name/surname, a title, or a nickname (e.g. "' + playerName + ' Somesurname", or just "Somesurname"). EVERY part of the player\'s name refers to the player. Never treat the player\'s own surname, given name, or any part of their name as a separate person, and never let it become the opponent. The storyteller\'s messages in <recent> may be labeled with a card/narrator name that is NOT a combatant.\n</player>\n\n<sheet>\n' + sheet + '\n</sheet>\n\n' + (cardBlock ? cardBlock + '\n\n' : '') + (memBlock ? memBlock + '\n\n' : '') + '<recent>\n' + recent + '\n</recent>\n\n<action>\n' + action + '\n</action>';
    }

    function normalizeAdj(obj, meta) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.check === false) {
            // A fight can OPEN on a message that itself attempts nothing
            // contested (squaring up, a declaration, drawing steel): the
            // referee arms it with check=false and NOTHING is rolled — the
            // first committed attempt becomes round 1. Self-hardening still
            // applies: the player, under ANY alias, is never the foe.
            const out = { check: false };
            const ds = (typeof obj.duel_start === 'string' && obj.duel_start.trim()) ? obj.duel_start.trim().slice(0, 60) : null;
            if (ds && !isMcAlias(meta, ds)) out.duel_start = ds;
            let bs = normalizeRoster(obj.battle_start);
            if (bs) {
                bs.enemies = (bs.enemies || []).filter(nm => !isMcAlias(meta, nm));
                if (bs.enemies.length) out.battle_start = bs;
            }
            const ws = normalizeWarStart(obj.war_start);
            if (ws) out.war_start = ws;
            out.domain = String(obj.domain || 'melee').toLowerCase().trim() || 'melee';
            out.opponent_rating = (obj.opponent_rating === null || obj.opponent_rating === undefined) ? null : clamp(Math.round(Number(obj.opponent_rating)), 0, 10);
            out.scale_mismatch = (obj.scale_mismatch === null || obj.scale_mismatch === undefined) ? 0 : clamp(Math.round(Number(obj.scale_mismatch)), -4, 4);
            out.action = String(obj.action || 'squaring up').slice(0, 140);
            out.actor = mcName(meta);
            return out;
        }
        if (obj.check !== true) return null;
        const domain = String(obj.domain || 'general').toLowerCase().trim() || 'general';
        // The actor is ALWAYS the player. Model discretion here caused an
        // identity swap (narrator card scored as the actor vs the player's
        // own stats), so we enforce it: keep the model's claim only to
        // repair an inverted duel_start below.
        const playerName = mcName(meta);
        const playerLabel = ctx().name1 || '';
        const modelActor = String(obj.actor || '').trim();
        const actor = playerName;
        let kind = obj.opposition_kind === 'actor' ? 'actor' : 'tier';
        let opposition = String(obj.opposition || 'moderate').trim() || 'moderate';

        // ── Opponent-identity hardening (fool-proofing) ───────────────────
        // The opponent must be a REAL, DISTINCT entity: never the player, and
        // never a mere PIECE of the player's name (a referee that read "Jovan
        // Wessex" must not hand back "Wessex" as the foe). All matching is
        // TOKEN-based, never substring, so:
        //   - a genuine foe like "Anakin" is never mistaken for a player "Ana";
        //   - a sibling like "Claire Wessex" is NOT the player, even though it
        //     shares the surname, because it carries a distinct given name.
        const nrm = (x) => String(x || '').toLowerCase().trim();
        const toksOf = (x) => nrm(x).split(/[\s,]+/).filter(Boolean);
        const subsetOf = (a, b) => { const at = toksOf(a), bt = toksOf(b); return at.length > 0 && at.every(t => bt.includes(t)); };
        // A name is the player when it matches, is a FRAGMENT of the player's
        // name (a bare surname/given-name), OR is the player's name EXTENDED
        // (persona "Jovan" vs the story's "Jovan Wessex"). A name that carries a
        // distinct token in BOTH directions (a sibling "Claire Wessex", or an
        // unrelated "Anakin") is a different person.
        const selfNames = (playerLabel && nrm(playerLabel) !== nrm(playerName)) ? [playerName, playerLabel] : [playerName];
        const isPlayerish = (n) => !!n && selfNames.some(p => nrm(n) === nrm(p) || subsetOf(n, p) || subsetOf(p, n));
        // The model's OWN actor claim counts as the player when it carries the
        // player's name tokens (persona "Jovan" -> claim "Jovan Wessex"). A single
        // word of THAT claim handed back as the foe is the name-split misparse —
        // the surname the referee wrongly peeled off the player.
        const actorIsPlayer = !!modelActor && (selfNames.some(p => subsetOf(p, modelActor)) || isPlayerish(modelActor));
        const isNamePartOfActor = (n) => { if (!n || !actorIsPlayer) return false; const at = toksOf(modelActor); return at.length > 1 && at.includes(nrm(n)); };
        const isSelf = (n) => isPlayerish(n) || isNamePartOfActor(n);
        const TIER_WORDS = new Set(['trivial', 'easy', 'moderate', 'hard', 'extreme', 'mook', 'trained', 'competent', 'veteran', 'elite', 'formidable', 'master', 'legendary', 'apex', 'inferior', 'peer', 'superior']);
        // First candidate that is a clean, distinct foe name (not the player, not
        // a difficulty tier). Lets a mislabeled duel_start recover the real foe
        // from the referee's OTHER identifications before we give up.
        const cleanFoe = (...cands) => { for (const c of cands) { const t = String(c || '').trim(); if (t && !isSelf(t) && !TIER_WORDS.has(nrm(t))) return t.slice(0, 60); } return null; };
        const rawOppName = (kind === 'actor') ? opposition : '';

        let duelStart = (typeof obj.duel_start === 'string' && obj.duel_start.trim()) ? obj.duel_start.trim().slice(0, 60) : null;
        if (duelStart && isSelf(duelStart)) {
            // RECOVER the true foe from the referee's other fields (its opposition
            // naming, then an inverted actor slot). Only if none is a clean distinct
            // name do we drop to a plain check — the attack still resolves, and the
            // next turn re-opens the duel cleanly once the foe is named right.
            duelStart = cleanFoe(rawOppName, modelActor);
            dlog('self-named duel_start repaired →', duelStart || '(dropped to single check)');
        }
        if (kind === 'actor' && isSelf(opposition)) {
            const recovered = cleanFoe(duelStart, modelActor);
            opposition = recovered || 'hard';
            // No real foe recoverable → the fallback is a TASK TIER, and must
            // resolve as one ('hard' = 7), not as an unlisted actor (trained 5).
            if (!recovered) kind = 'tier';
            dlog('self-named opposition repaired →', opposition, '(' + kind + ')');
        }
        let battleStart = normalizeRoster(obj.battle_start);
        if (battleStart) {
            battleStart.enemies = (battleStart.enemies || []).filter(n => !isSelf(n));
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
            playerGuard: (typeof obj.player_guard === 'string' && obj.player_guard.trim()) ? obj.player_guard.trim().slice(0, 180) : null,
            counterPath: (typeof obj.counter_path === 'string' && obj.counter_path.trim() && !/^(none|null|no path|nothing|n\/a)$/i.test(obj.counter_path.trim())) ? obj.counter_path.trim().slice(0, 200) : null,
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

    /** The live fight combatant object for a name, if a duel/battle is active. */
    function liveCombatant(meta, name) {
        const nrm = (x) => String(x || '').toLowerCase().trim();
        const t = nrm(name);
        if (!t) return null;
        const playerish = isMcAlias(meta, name);
        const match = (u) => u && (nrm(u.name) === t || (playerish && (u.isPlayer === true || (meta.duel && u === meta.duel.player))));
        if (meta.duel) {
            if (match(meta.duel.player)) return meta.duel.player;
            if (match(meta.duel.opp)) return meta.duel.opp;
        }
        if (meta.battle) {
            for (const u of (meta.battle.allies || [])) if (match(u)) return u;
            for (const u of (meta.battle.enemies || [])) if (match(u)) return u;
        }
        return null;
    }

    /** A persistent condition must land on the LIVE fight too, not only on
     *  future ones: refresh the affected combatant's effective rating in
     *  place from the (just-updated) sheet. */
    function refreshLiveRating(meta, who) {
        const playerName = mcName(meta);
        const name = (/^(you|player|me|myself)$/i.test(String(who || '')) || isMcAlias(meta, who)) ? playerName : who;
        const u = liveCombatant(meta, name);
        if (!u) return;
        const entry = findActor(meta, name);
        if (!entry) return;
        const domain = (meta.duel && (u === meta.duel.player || u === meta.duel.opp)) ? meta.duel.domain
            : (meta.battle ? meta.battle.domain : 'melee');
        u.rating = ratingFor(entry, domain, clamp(getSettings().defaultRating, 0, 10));
        renderHud();
    }

    /** Apply a persistent condition change to the sheet, resolving "player"
     *  to the persona. Creates the actor entry if needed so the condition
     *  sticks even for someone not yet rated. Returns a note for narration. */
    function applyConditionChange(meta, cc) {
        if (!cc) return null;
        const playerName = mcName(meta);
        const name = (/^(you|player|me|myself)$/i.test(cc.who) || isMcAlias(meta, cc.who)) ? playerName : cc.who;
        meta.sheet = meta.sheet || { actors: {} };
        let entry = findActor(meta, name);
        if (!entry) {
            // Seed a created entry from the LIVE combatant's rating when one
            // exists: an estimated rating-9 dragon that picks up "torn wing"
            // must not be reborn on the sheet as a default-5 — that entry
            // would poison every future encounter with it.
            let base = clamp(getSettings().defaultRating, 0, 10);
            const live = liveCombatant(meta, name);
            if (live && Number.isFinite(live.rating)) base = clamp(live.rating, 0, 10);
            entry = { default: base, domains: {}, _auto: true, conditions: [] };
            meta.sheet.actors[name] = entry;
        }
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
        ' ' + GUARD_FIELD + ',',
        ' ' + COUNTER_FIELD + ',',
        ' "why": "<one short clause>",',
        ' ' + COND_CHANGE_FIELD,
        ' "combat_ended": true|false}',
        '',
        'Rules:',
        '- condition_change: also available MID-BATTLE — set it when this round establishes or resolves something persistent on the player or a NAMED combatant. Null when nothing persistent changed.',
        '- move_kind "fight": the player personally engages one enemy (use "target"). move_kind "command": the player directs the whole side — orders, tactics, formation, rallying.',
        '- In an active duel nearly every player turn IS an exchange — the enemy presses regardless. Passive or hesitant turns are exchanges with NEGATIVE circumstance.',
        '- circumstance is PHYSICAL advantage only (position, momentum, feints that create real openings, exposure). NEVER penalize a move for being a foul, dirty, illegal, dishonorable, or against duel rules, and never mention sanctions or penalties — a dirty move that works (a low blow, a groin kick) is a POSITIVE circumstance. You judge what is effective, not what is permitted; the fiction owns the rules.',
        '- exchange=false ONLY when no side fights this beat: a standoff or parley, talk or readying before contact, out-of-character/directorial text, or a recap of what already happened. While the enemy presses, a passive turn is still a round.',
        '- circumstance rewards concrete tactics, terrain, exploited weaknesses (+); penalizes impairment, bad position, chaos (-). 0 if nothing notable.',
        GUARD_RULE,
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
            playerGuard: (typeof obj.player_guard === 'string' && obj.player_guard.trim()) ? obj.player_guard.trim().slice(0, 180) : null,
            counterPath: (typeof obj.counter_path === 'string' && obj.counter_path.trim() && !/^(none|null|no path|nothing|n\/a)$/i.test(obj.counter_path.trim())) ? obj.counter_path.trim().slice(0, 200) : null,
            condition_change: normalizeConditionChange(obj.condition_change),
            why: String(obj.why || '').slice(0, 160),
        };
    }

    function battleActive(meta) {
        return !!(meta && meta.battle && meta.battle.active && !meta.battle.over);
    }

    /** Expand roster names ("Bandit x3") into unit objects with sheet lookups.
     *  oppEstimate: the referee's scene-derived threat rating for the headline
     *  foe (the first UNLISTED enemy name) — the same estimate a duel start
     *  gets. Without it a legendary dragon opening a BATTLE (with minions) was
     *  silently rated trained (4) while the identical dragon in a duel got its
     *  9. Applies only to units expanded from that one base name; other
     *  unlisted foes keep the trained fallback. */
    function buildUnits(meta, names, domain, isEnemySide, oppEstimate) {
        const s = getSettings();
        const fallback = clamp(s.defaultRating, 0, 10);
        const units = [];
        let estimateFor = null; // base name the estimate is bound to, once chosen
        for (const raw of names) {
            const m = raw.match(/^(.*?)(?:\s*[x×]\s*(\d{1,2}))\s*$/i);
            const base = (m ? m[1] : raw).trim();
            const count = m ? clamp(parseInt(m[2], 10), 1, 8) : 1;
            for (let i = 1; i <= count && units.length < 10; i++) {
                const name = count > 1 ? base + ' ' + i : base;
                // Generic xN squads use EXACT sheet lookup only: the loose
                // whole-word matcher exists so "Kaiser" finds "Kaiser von Adler",
                // but it also let a mook squad "Guard x3" inherit a named
                // "Guard Captain"'s elite rating — common-noun collision. A
                // squad the fiction spawned by count is never a named character.
                const entry = count > 1 ? findActorExact(meta, base)
                    : (findActor(meta, base) || findActor(meta, name));
                let rating;
                if (entry) rating = ratingFor(entry, domain, fallback);
                else if (isEnemySide && Number.isFinite(oppEstimate) && (estimateFor === null || estimateFor === base)) {
                    estimateFor = base;
                    rating = clamp(oppEstimate, 0, 10);
                } else rating = isEnemySide ? clamp(TIER_RATINGS.trained, 0, 10) : fallback;
                const poise = poiseFor(entry, s.duelPoise);
                const cMax = clamp(s.composureMax, 3, 12);
                units.push({ name, rating, poise, maxPoise: poise, injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: false, composure: cMax, composureMax: cMax });
            }
        }
        return units;
    }

    // Is `name` the player? True for the player's exact name, a fragment of it (a
    // bare surname/given-name), or the player's name extended — token-based, so a
    // distinct ally who merely shares a surname (a sibling) is NOT filtered out.
    function isPlayerName(name, playerName) {
        const n = String(name || '').toLowerCase().trim(), p = String(playerName || '').toLowerCase().trim();
        if (!n || !p) return false;
        if (n === p) return true;
        const nt = n.split(/[\s,]+/).filter(Boolean), pt = p.split(/[\s,]+/).filter(Boolean);
        if (!nt.length || !pt.length) return false;
        return nt.every(t => pt.includes(t)) || pt.every(t => nt.includes(t));
    }

    function startBattle(meta, allyNames, enemyNames, domain, scaleMismatch, oppEstimate) {
        const s = getSettings();
        const d = String(domain || 'melee').toLowerCase();
        const playerName = mcName(meta);
        const pEntry = findActor(meta, playerName);
        const mc = {
            name: playerName,
            rating: ratingFor(pEntry, d, clamp(s.defaultRating, 0, 10)),
            poise: poiseFor(pEntry, s.duelPoise), maxPoise: poiseFor(pEntry, s.duelPoise),
            injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: true,
        };
        const allies = buildUnits(meta, (allyNames || []).filter(n => !isMcAlias(meta, n)), d, false);
        const enemies = buildUnits(meta, enemyNames || [], d, true, oppEstimate);
        if (!enemies.length) return null;
        meta.duel = null; // mode exclusivity — see startDuel
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
        const r = applyExchangeEffects(a, e, tier, delta);
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

        if (outcomeOnly()) {
            // Outcome-only: adjudicate the MC's action alone. Casualties,
            // morale, the rest of the field, and the battle's end all belong
            // to the storyteller — nothing here ticks or concludes.
            if (mv.kind === 'command') {
                const oppLead = Math.max(3, ...standing(b.enemies).map(u => u.rating));
                const delta = clamp(mc.rating - mc.injuries - oppLead + mv.circumstance + preset.bonus + mAll + composurePenalty(meta) + (b.scaleMismatch || 0), -13, 13);
                const P = probFromDelta(delta); const u = rngFloat();
                mcRes = { delta, P, u, tier: sliceOutcome(P, u, preset.mods), command: true };
            } else {
                let target = standing(b.enemies).find(u => mv.target && u.name.toLowerCase() === mv.target.toLowerCase());
                if (!target) target = standing(b.enemies).slice().sort((x, y) => y.rating - x.rating)[0];
                if (target) {
                    const delta = clamp((mc.rating - mc.injuries + mc.momentum) - (target.rating - target.injuries + target.momentum) + mv.circumstance + preset.bonus + mAll + composurePenalty(meta) - combatantComposurePenalty(target) + (b.scaleMismatch || 0), -13, 13);
                    const P = probFromDelta(delta); const u = rngFloat();
                    mcRes = { delta, P, u, tier: tieCheck(sliceOutcome(P, u, preset.mods), P, u, getSettings().tieBand), command: false };
                }
            }
            b.round += 1;
            return { mcRes, reports: [], outcome: true };
        }

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
                const r = applyExchangeEffects(mc, target, tier, delta);
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
                lines.push(...guardLines(adj, mc.name, 'The enemy', out.mcRes.tier));
            }
            const fx = out.outcome ? {} : (EXCHANGE_EFFECTS[out.mcRes.tier] || {});
            if (fx.injureOpp && !out.mcRes.command) lines.push('Inflict a concrete lasting injury on their opponent and name it.');
            if (fx.injureSelf && !(adj.playerGuard && !adj.counterPath)) lines.push('Inflict a concrete lasting injury on ' + mc.name + ' and name it; it visibly weakens them.');
        }
        const rep = out.reports.slice(0, 4);
        if (rep.length) lines.push('Elsewhere on the field (weave these in as fact): ' + rep.join(' '));
        if (out.reports.length > 4) lines.push('The remaining clashes hold without decision.');
        if (out.outcome) {
            lines.push('Outcome-only battle: only ' + mc.name + '\'s action was scored. The wider field — who falls, who holds, how morale sways — follows the story, and the battle continues until the STORY ends it: narrate the rout, stand-down, or escape yourself when the fiction earns it. Arbiter will not call a side\'s victory.');
        } else if (b.over) {
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
        ' ' + GUARD_FIELD + ',',
        ' ' + COUNTER_FIELD + ',',
        ' "why": "<one short clause>",',
        ' ' + COND_CHANGE_FIELD,
        ' "combat_ended": true|false}',
        '',
        'Rules:',
        '- condition_change: also available MID-ENGAGEMENT — set it when this round establishes or resolves something persistent on the player commander or a NAMED character. Null when nothing persistent changed.',
        '- "maneuver": a formation is ordered against an enemy element (flank, charge, hold, envelop, pincer, screen, withdraw-and-counter). Fill acting_unit and target_unit from the roster.',
        '- "stratagem": the order reshapes the FIELD rather than one clash — burn the woods, feign retreat, poison the wells, cut supply, deception, weather/terrain exploitation. Leave units null.',
        '- "personal": the commander personally sorties into the fight (a duelist-commander, an ace in their machine). Fill target_unit.',
        '- circumstance is the tactical soundness of THIS order given terrain, intel, enemy posture, timing, and prior conditions: a flank against an exposed side +2; a frontal charge uphill into prepared lines -2; 0 when unremarkable.',
        '- While the engagement is being fought, nearly every commander turn IS an order; hesitation is a maneuver at negative circumstance. exchange=false only when no side presses this beat: a parley or truce, night camp, out-of-character/directorial text, or a recap of what already happened.',
        GUARD_RULE,
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
            playerGuard: (typeof obj.player_guard === 'string' && obj.player_guard.trim()) ? obj.player_guard.trim().slice(0, 180) : null,
            counterPath: (typeof obj.counter_path === 'string' && obj.counter_path.trim() && !/^(none|null|no path|nothing|n\/a)$/i.test(obj.counter_path.trim())) ? obj.counter_path.trim().slice(0, 200) : null,
            condition_change: normalizeConditionChange(obj.condition_change),
            why: String(obj.why || '').slice(0, 160),
        };
    }

    function warActive(meta) {
        return battleActive(meta) && meta.battle.kind === 'war';
    }

    function startWar(meta, allyNames, enemyNames, enemyCommander, scaleMismatch) {
        const s = getSettings();
        const d = 'war';
        const playerName = mcName(meta);
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
                    // xN-cloned formations: exact sheet match only (see buildUnits).
                    const entry = count > 1 ? findActorExact(meta, base)
                        : (findActor(meta, base) || findActor(meta, name));
                    const rating = entry ? ratingFor(entry, 'war', ratingFor(entry, 'melee', fallback)) : (isEnemy ? 4 : fallback);
                    const strength = poiseFor(entry, clamp(s.warStrength, 4, 40));
                    const cMax = clamp(s.composureMax, 3, 12);
                    units.push({ name, rating, poise: strength, maxPoise: strength, injuries: 0, momentum: 0, opening: false, standing: true, isPlayer: false, composure: cMax, composureMax: cMax });
                }
            }
            return units;
        };
        const allies = mkUnits((allyNames || []).filter(n => !isMcAlias(meta, n)), false);
        const enemies = mkUnits(enemyNames || [], true);
        if (!enemies.length) return null;
        meta.duel = null; // mode exclusivity — see startDuel
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

        if (outcomeOnly()) {
            // Outcome-only: score this order and nothing else. No strength
            // ticks, no conditions accrued, no collapse — the storyteller
            // commands the tide and the day's end.
            if (mv.kind === 'stratagem') {
                const delta = clamp(b.cmdA - b.cmdE + mv.circumstance + mAll + preset.bonus + composurePenalty(meta), -13, 13);
                const P = probFromDelta(delta); const u = rngFloat();
                focalRes = { delta, P, u, tier: sliceOutcome(P, u, preset.mods), stratagem: true };
            } else if (mv.kind === 'personal' && mc) {
                target = pickUnit(b.enemies, mv.target);
                if (target) {
                    const delta = clamp((mc.rating - mc.injuries + mc.momentum) - (target.rating - target.injuries + target.momentum) + mv.circumstance + F + mAll + preset.bonus + composurePenalty(meta) - combatantComposurePenalty(target) + (b.scaleMismatch || 0), -13, 13);
                    const P = probFromDelta(delta); const u = rngFloat();
                    focalRes = { delta, P, u, tier: tieCheck(sliceOutcome(P, u, preset.mods), P, u, getSettings().tieBand), personal: true };
                }
            } else {
                acting = pickUnit(nonPlayer(b.allies), mv.acting);
                target = pickUnit(b.enemies, mv.target);
                if (acting && target) {
                    const delta = clamp((acting.rating - acting.injuries + acting.momentum + cmdEdge) - (target.rating - target.injuries + target.momentum) + mv.circumstance + F + mAll + preset.bonus + combatantComposurePenalty(acting) - combatantComposurePenalty(target) + (b.scaleMismatch || 0), -13, 13);
                    const P = probFromDelta(delta); const u = rngFloat();
                    focalRes = { delta, P, u, tier: tieCheck(sliceOutcome(P, u, preset.mods), P, u, getSettings().tieBand) };
                }
            }
            b.round += 1;
            return { focalRes, reports: [], condNote: null, acting, target, outcome: true };
        }

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
                const r = applyExchangeEffects(mc, target, tier, delta);
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
                const r = applyExchangeEffects(acting, target, tier, delta);
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
                lines.push(...guardLines(adj, mc.name, out.target ? out.target.name : 'The enemy', out.focalRes.tier));
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
        if (out.outcome) {
            lines.push('Outcome-only war: only this order was scored. Casualties, the tide of the line, and the day\'s end follow the story — the engagement continues until the STORY ends it. Arbiter will not call the field.');
        } else if (b.over) {
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
            // Prefer a bespoke, story-seeded shift (consumed once); else generic.
            let shift;
            if (Array.isArray(meta.worldSeeds) && meta.worldSeeds.length) shift = meta.worldSeeds.shift();
            else shift = WORLD_WHO[Math.floor(rng() * WORLD_WHO.length)] + ' ' + WORLD_WHAT[Math.floor(rng() * WORLD_WHAT.length)] + ', ' + WORLD_WHERE[Math.floor(rng() * WORLD_WHERE.length)];
            queue.push({ prio: 4, text: '[ARBITER EVENT — seismic shift: ' + shift + '. Land it as news or rumor first unless the fiction puts it on top of the player; it must fit the setting\'s tone and scale.]' });
        }
        const e = rollTier(eng.encounter.dc, ENGINE_DEFAULTS.encounter.sides, ENGINE_DEFAULTS.encounter.decay, ENGINE_DEFAULTS.encounter.dc0, rng);
        eng.encounter.dc = e.nextDC;
        if (e.fired) {
            // Prefer a bespoke, story-seeded encounter (consumed once); else the table.
            let type;
            if (Array.isArray(meta.encounterSeeds) && meta.encounterSeeds.length) type = meta.encounterSeeds.shift();
            else { const table = getEncounterTypes(); type = table[Math.floor(rng() * table.length)]; }
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
        const cap = limitChars || 5000;
        const sources = [];
        const chunks = [];
        let used = 0;
        // Accumulate UP TO the cap instead of joining every injection into one
        // megastring and slicing after — Summaryception-scale contexts made that
        // a transient multi-hundred-KB allocation per check (GC churn on
        // Android). Sources still itemize FULL sizes for the inspector.
        const take = (text) => {
            if (used >= cap) return;
            const room = cap - used;
            const piece = text.length > room ? text.slice(0, room) : text;
            chunks.push(piece);
            used += piece.length + 5; // + separator
        };
        try {
            const c = ctx();
            const eps = c.extensionPrompts || c.extension_prompts || {};
            const memRe = /summar|ception|memory|qvink|notepad|ledger|lore|plot/i;
            for (const [k, v] of Object.entries(eps)) {
                const val = v && typeof v === 'object' ? v.value : v;
                if (memRe.test(k) && typeof val === 'string' && val.trim()) {
                    const t = val.trim();
                    sources.push({ key: k, chars: t.length });
                    take(t);
                }
            }
            const md = c.chatMetadata || c.chat_metadata || {};
            if (typeof md.note_prompt === 'string' && md.note_prompt.trim()) {
                const t = md.note_prompt.trim();
                sources.push({ key: "author's note", chars: t.length });
                take(t);
            }
        } catch (e) { dlog('memory gather failed', e); }
        const block = chunks.length ? '<memory>\n' + chunks.join('\n---\n') + '\n</memory>' : '';
        return { block, sources };
    }

    /** Descriptive fields from the active character card (name, description,
     *  personality, scenario) for the referee, when the user opts in. Best-effort
     *  and defensive: a missing field or a different context shape yields an empty
     *  block, never an error — the inspector lets the user confirm it actually
     *  pulled on their build. Instruction-type fields (main-prompt override,
     *  post-history instructions) are deliberately NOT included: like the system
     *  prompt they are bias vectors, not physical facts. Persona is never
     *  included by design. */
    function collectStoryContext(limitChars) {
        try {
            const c = ctx();
            const chid = (c.characterId !== undefined && c.characterId !== null) ? c.characterId
                : (c.this_chid !== undefined ? c.this_chid : null);
            const list = c.characters || [];
            const ch = (chid !== null && chid !== undefined && list[chid]) ? list[chid] : null;
            if (!ch) return '';
            const data = ch.data || {};
            const pick = (a, b) => {
                const v = (a !== undefined && a !== null && String(a).trim()) ? a : b;
                return (v !== undefined && v !== null) ? String(v).trim() : '';
            };
            const fields = [
                ['Name', pick(ch.name, data.name)],
                ['Description', pick(ch.description, data.description)],
                ['Personality', pick(ch.personality, data.personality)],
                ['Scenario', pick(ch.scenario, data.scenario)],
            ].filter(([, v]) => v);
            if (!fields.length) return '';
            const body = fields.map(([k, v]) => k + ': ' + v).join('\n').slice(0, limitChars || 5000);
            return '<character_card>\n' + body + '\n</character_card>';
        } catch (e) { dlog('story context gather failed', e); return ''; }
    }

    /* ── World Info / lorebook (read-only) — accessor mirrors the Copilot
     *    extension's verified pattern: resolve the active book(s), loadWorldInfo,
     *    then activate entries ourselves (constant always; keyword/selective on
     *    the action + recent story). Vector-only entries need the embedding
     *    engine and are not activated here — noted for the user. ── */
    function wiApiAvailable() { const c = ctx(); return typeof c.loadWorldInfo === 'function'; }

    function wiReadSelectDom() {
        const out = { all: [], active: [] };
        try {
            if (typeof document === 'undefined') return out;
            const el = document.getElementById('world_info');
            if (!el || !el.options) return out;
            for (const opt of el.options) {
                const name = String(opt.textContent || opt.text || '').trim();
                if (!name) continue;
                out.all.push(name);
                if (opt.selected) out.active.push(name);
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    /** Which lorebooks to read: a manual pin if given, else ST's active dropdown
     *  selection, else the globally-selected books, else the chat-bound book. */
    function wiResolveBooks() {
        const manual = String(getSettings().adjWorldBooks || '').split(',').map(x => x.trim()).filter(Boolean);
        if (manual.length) return manual;
        const out = [];
        try { const dom = wiReadSelectDom(); if (dom.active.length) out.push(...dom.active); } catch (e) { /* ignore */ }
        try {
            const c = ctx();
            const sel = c.selected_world_info;
            if (Array.isArray(sel)) for (const x of sel) if (typeof x === 'string' && x.trim()) out.push(x.trim());
            const md = c.chatMetadata || c.chat_metadata || {};
            const cw = md.world_info;
            if (typeof cw === 'string' && cw.trim()) out.push(cw.trim());
            else if (Array.isArray(cw)) for (const x of cw) if (typeof x === 'string' && x.trim()) out.push(x.trim());
            else if (cw && typeof cw.world === 'string' && cw.world.trim()) out.push(cw.world.trim());
        } catch (e) { /* ignore */ }
        return Array.from(new Set(out.filter(Boolean)));
    }

    async function wiLoad(book) {
        const c = ctx();
        try { const d = await c.loadWorldInfo(book); if (d && d.entries) return d; }
        catch (e) { dlog('wiLoad failed', book, e); }
        return null;
    }

    const wiKeyHit = (keys, scanLower) => {
        if (!Array.isArray(keys)) return false;
        for (const k of keys) { const kk = String(k || '').toLowerCase().trim(); if (kk && scanLower.includes(kk)) return true; }
        return false;
    };

    /** Pure activation: given raw entries and the scan text, return the entries
     *  that would fire. Constant entries always; keyword entries when a primary
     *  key appears in the scan text (selective entries also need a secondary
     *  hit). Disabled and empty entries are skipped; vector-only entries (no
     *  keys) do not fire here. */
    function wiActivateEntries(entries, scanText) {
        const scan = String(scanText || '').toLowerCase();
        const hits = [];
        for (const e of (entries || [])) {
            if (!e || e.disable) continue;
            const content = String(e.content || '').trim();
            if (!content) continue;
            const keys = e.key || e.keys || [];
            const sec = e.keysecondary || e.keySecondary || [];
            let active = false;
            if (e.constant) active = true;
            else if (wiKeyHit(keys, scan)) active = (e.selective && sec.length) ? wiKeyHit(sec, scan) : true;
            if (active) hits.push({ order: Number(e.order) || 100, title: String(e.comment || '').trim(), content });
        }
        hits.sort((a, b) => a.order - b.order);
        return hits;
    }

    /** Preferred path: ST's OWN activation engine. It handles constant, keyword
     *  AND vectorized entries (the latter via the Vector Storage extension), so
     *  this is the "perfect" route for vector search. dryRun=true → no state
     *  change. Returns the activated text, or '' if the API is absent/empty. */
    async function wiViaEngine(scanText, limitChars) {
        const c = ctx();
        if (typeof c.getWorldInfoPrompt !== 'function') return '';
        try {
            // Feed the action + recent story as the scan chat so keyword AND
            // vector activation key off what's actually happening now.
            const scanChat = String(scanText || '').split('\n').map(x => x.trim()).filter(Boolean);
            const res = await c.getWorldInfoPrompt(scanChat, 100000, true);
            let str = '';
            if (typeof res === 'string') str = res;
            else if (res && typeof res === 'object') str = [res.worldInfoString, res.worldInfoBefore, res.worldInfoAfter].filter(Boolean).join('\n');
            str = String(str || '').trim();
            return str ? str.slice(0, limitChars || 8000) : '';
        } catch (e) { dlog('getWorldInfoPrompt failed; using manual activation', e); return ''; }
    }

    async function collectWorldInfoBlock(scanText, limitChars) {
        if (!getSettings().adjIncludeWorld) return '';
        const cap = limitChars || 8000;
        // Try ST's engine first (covers vectorized entries).
        const viaEngine = await wiViaEngine(scanText, cap);
        if (viaEngine) return '<world_info>\n' + viaEngine + '\n</world_info>';
        // Fallback: manual constant + keyword/selective activation from loadWorldInfo.
        if (!wiApiAvailable()) return '';
        const books = wiResolveBooks();
        if (!books.length) return '';
        const all = [];
        for (const b of books) { const data = await wiLoad(b); if (data) for (const e of Object.values(data.entries)) all.push(e); }
        const hits = wiActivateEntries(all, scanText);
        if (!hits.length) return '';
        const parts = []; let used = 0;
        for (const h of hits) {
            const piece = (h.title ? h.title + ': ' : '') + h.content;
            if (used + piece.length > cap) break;
            parts.push(piece); used += piece.length;
        }
        return parts.length ? '<world_info>\n' + parts.join('\n---\n') + '\n</world_info>' : '';
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
        'You read a roleplay transcript plus its memory notes and propose three things: (1) BACKGROUND CURRENTS — off-screen storylines that advance on their own (a rival\'s scheme, an investigation closing in, a faction\'s move, an NPC\'s ambition); (2) ENCOUNTERS — specific, story-grounded people or hooks that could plausibly cross the player\'s path next, given WHERE they are and WHO/WHAT is around them right now; (3) WORLD EVENTS — larger shifts (news, rumor, a faction move, a disaster) that fit this world and could ripple in. Output STRICT JSON only, one object, no markdown.',
        '',
        'Schema: {"threads": [{"name": "<short name>", "desc": "<one line>", "maxRung": <5-12>, "bias": <-2..2, how strongly the world favors it>, "pace": <2-4, turns between heartbeats>}], "encounters": ["<a concrete, setting-fitting hook naming a plausible person or situation for THIS story and THIS location, e.g. \'a rain-soaked courier from the Vermillion house with an urgent summons\'>"], "world_events": ["<a concrete seismic beat grounded in this world, e.g. \'the northern front collapses and refugees begin flooding the capital\'>"]}',
        '',
        'Rules: 2-5 threads. 3-6 encounters and 2-4 world_events, each SPECIFIC to this story\'s setting, cast, tone, and the player\'s current situation — never generic filler, never forced combat. Encounters are people or hooks the player can engage or ignore. Do NOT include the player\'s own active goals — all of these are what moves WITHOUT the player.',
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
        // 1200 out-tokens: a full pool (5 threads + 6 encounters + 4 world events,
        // each up to 220 chars) can exceed the old 700 and truncate into
        // unparseable JSON — a silent total seeding failure. Terse outputs still
        // stop early, so the raise costs nothing when the model is brief.
        const seedEpoch = chatEpoch;
        const out = await callLLM(THREAD_SEED_SYSTEM, (mem.block ? mem.block + '\n\n' : '') + '<existing_threads>' + existing + '</existing_threads>\n\n<transcript>\n' + parts.reverse().join('\n') + '\n</transcript>', 1200, 45000, ts.seedProfileId || undefined);
        clearActivity();
        if (seedEpoch !== chatEpoch) { dlog('chat changed during thread seed; result discarded'); return; }
        if (activityCanceled()) { if (!o.auto) toast('warning', 'Thread seed canceled.'); return; }
        let obj = null;
        for (const cand of extractJsonCandidates(out, 5)) {
            if (cand && (Array.isArray(cand.threads) || Array.isArray(cand.encounters) || Array.isArray(cand.world_events))) { obj = cand; break; }
        }
        if (!obj) { if (o.auto) dlog('auto thread seed: nothing valid'); else toast('error', 'Thread seeding failed.'); return; }
        let added = 0;
        for (const t of (obj.threads || []).slice(0, 6)) {
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
        // Story-tailored pools for the encounter/world tiers — bespoke to this
        // scene, refreshed each seed, so the world fires CONTEXTUAL beats instead
        // of generic table draws. Only replace when the model supplied a pool.
        if (Array.isArray(obj.encounters)) {
            const pool = obj.encounters.map(x => String(x || '').trim().slice(0, 220)).filter(Boolean).slice(0, 8);
            if (pool.length) meta.encounterSeeds = pool;
        }
        if (Array.isArray(obj.world_events)) {
            const pool = obj.world_events.map(x => String(x || '').trim().slice(0, 220)).filter(Boolean).slice(0, 6);
            if (pool.length) meta.worldSeeds = pool;
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
        ' ' + GUARD_FIELD + ',',
        ' ' + COUNTER_FIELD + ',',
        ' "sequence": null | [{"strike": "<short label, 2-6 words>", "circumstance": <integer -3..3>}],',
        ' "why": "<one short clause>",',
        ' ' + COND_CHANGE_FIELD,
        ' "combat_ended": true|false}',
        '',
        'Rules:',
        '- condition_change: also available MID-FIGHT — set it when THIS exchange establishes or resolves something persistent on EITHER fighter (a lasting wound beyond the exchange, poison taking hold, a disarm, gear seized or broken). Null when nothing persistent changed.',
        '- move_kind "recover": the player DISENGAGES to restore themselves — healing magic on themselves, a water/life node, catching their breath, a defensive reset that regains composure, mending their own wounds. This regains poise but yields tempo (the opponent acts freely). Everything else is "attack" (including defensive counters that still contest the opponent).',
        '- For a "recover" move, circumstance reflects how SAFELY they can recover: unopposed with a reliable method +2; snatched under pressure with the enemy closing -2. Recovery never "fails into damage" — at worst it barely helps.',
        '- While the OPPONENT is actively attacking or pressing this beat, every player turn IS an exchange — words do not parry steel. A passive, hesitant, talking, or purely defensive turn UNDER ATTACK is an exchange with NEGATIVE circumstance, never exchange=false. The player cannot stall a pressing opponent by monologuing.',
        '- circumstance is PHYSICAL advantage ONLY: position, momentum, a feint that creates a real opening, an exposed target, terrain, impairment, haste. NEVER penalize a move for being a foul, dirty, illegal, dishonorable, unsporting, or against duel etiquette, and NEVER mention rules, sanctions, penalties, or disqualification — you do not know this world\'s rules, and legality is the storyteller\'s to narrate, not yours to score. A dirty move that gives a real physical edge (a groin kick, sand in the eyes, a sucker punch) is a POSITIVE circumstance. Judge only what is effective, never what is permitted.',
        '- exchange=false ONLY when NEITHER side commits an attack this beat: a mutual standoff or measuring-up, talk/taunts/terms while circling, stance or readying without contact, declarations of what the player WILL or WON\'T do, out-of-character or directorial text (bracketed notes, "what would <character> do", intervention prompts), or a recap of what earlier narration already resolved. An exchange is a contested attempt committed in THIS message — or an opponent\'s attack the player must weather.',
        '- circumstance rewards concrete tactics, exploited weaknesses and openings (+); penalizes recklessness noted in the fiction, bad footing, impairment (-). 0 if nothing notable.',
        '- circumstance is TWO-SIDED and impartial: weigh what the OPPONENT is doing as much as the player. If the opponent has the better position, has set a trap, is pressing an advantage, or is simply the more dangerous fighter seizing control of the exchange, that is NEGATIVE circumstance for the player even when the player\'s own move is sound. Do not grade only the player\'s cleverness upward; a good move into a worse position still nets negative. Judge the exchange as a neutral observer would, not from the player\'s hopes.',
        GUARD_RULE,
        '- combat_ended=true ONLY if the fiction has already clearly ended the fight (someone fled, yielded, was separated, or the scene left combat).',
        '- sequence: fill this ONLY when the player\'s single message is a genuine CHAIN of 2+ distinct offensive sub-actions meant to land in order (a combo — e.g. disrupt his spell, THEN a groin kick, THEN an elbow, THEN a neck punch). List each sub-action as its own strike with its own circumstance, judged on its OWN footing given what came before AND the opponent reacting between strikes. A combo is HIGH-RISK: do not assume every strike lands; a late strike is only as good as the setup that survived to it, and a bad strike hands the opponent the initiative. 2-5 strikes. Leave null for a single action — never invent a combo the player did not write, and still fill "action"/"circumstance" for the move as a whole.',
    ].join('\n');

    function normalizeDuelAdj(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.combat_ended === true) return { combat_ended: true };
        if (obj.exchange === false) return { exchange: false };
        if (obj.exchange !== true) return null;
        const rawSeq = Array.isArray(obj.sequence)
            ? obj.sequence.map(x => (x && typeof x === 'object' && (x.strike || x.step))
                ? { strike: String(x.strike || x.step).slice(0, 60), circumstance: clamp(Math.round(Number(x.circumstance) || 0), -3, 3) }
                : null).filter(Boolean).slice(0, 5)
            : null;
        const moveKind = obj.move_kind === 'recover' ? 'recover' : 'attack';
        return {
            exchange: true,
            moveKind,
            oppComposure: clamp(Math.round(Number(obj.opp_composure) || 0), -2, 2),
            selfComposure: clamp(Math.round(Number(obj.self_composure) || 0), -2, 2),
            action: String(obj.action || 'the exchange').slice(0, 140),
            circumstance: clamp(Math.round(Number(obj.circumstance) || 0), -3, 3),
            // Sequences are OFFENSIVE combos by definition. A model that emits
            // both move_kind:"recover" and a sequence must resolve as a recovery
            // — routing it into the combo resolver would make the heal DEAL poise
            // damage to the opponent on a good roll (the fast-mode heal-attack
            // bug, reborn through the adjudicated path).
            sequence: (moveKind === 'attack' && rawSeq && rawSeq.length >= 2) ? rawSeq : null,
            playerGuard: (typeof obj.player_guard === 'string' && obj.player_guard.trim()) ? obj.player_guard.trim().slice(0, 180) : null,
            counterPath: (typeof obj.counter_path === 'string' && obj.counter_path.trim() && !/^(none|null|no path|nothing|n\/a)$/i.test(obj.counter_path.trim())) ? obj.counter_path.trim().slice(0, 200) : null,
            condition_change: normalizeConditionChange(obj.condition_change),
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
        // Mode exclusivity: exactly ONE fight can be live. A manually-started
        // battle left a prior duel frozen underneath (the interceptor served
        // the duel while the HUD showed the battle — split-brain).
        meta.battle = null;
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
        // (Outcome-only has no poise to restore — a disengage is just another
        // action with a verdict, so it falls through to a plain exchange.)
        if (moveKind === 'recover' && !outcomeOnly()) {
            return resolveDuelRecovery(meta, circumstance);
        }

        const style = outcomeOnly();
        const openingBonus = (!style && duel.player.opening) ? 1 : 0;
        if (!style) duel.player.opening = false;
        const oppOpeningBonus = (!style && duel.opp.opening) ? 1 : 0;
        if (!style) duel.opp.opening = false;

        const effP = duel.player.rating - duel.player.injuries + duel.player.momentum + openingBonus;
        const effO = duel.opp.rating - duel.opp.injuries + duel.opp.momentum + oppOpeningBonus;
        const compPen = composurePenalty(meta);                    // player's strain (hurts player)
        const oppCompPen = combatantComposurePenalty(duel.opp);    // opponent's strain (negative → hurts opp)
        const delta = clamp(effP - effO + circumstance + (duel.scaleMismatch || 0) + compPen - oppCompPen + preset.bonus, -13, 13);
        const P = probFromDelta(delta);
        const u = rngFloat();
        const tier = tieCheck(sliceOutcome(P, u, preset.mods), P, u, getSettings().tieBand);

        if (style) {
            // Outcome-only: the verdict IS the whole result. No poise damage,
            // no forced injuries, no momentum, no engine-declared end.
            duel.round += 1;
            return { aR: effP, oR: effO, oppLabel: duel.opp.name, delta, P, u, tier, opening: false, outcome: true };
        }
        const applied = applyExchangeEffects(duel.player, duel.opp, tier, delta);
        duel.player = Object.assign({ name: duel.player.name, rating: duel.player.rating, maxPoise: duel.player.maxPoise }, applied.player);
        duel.opp = Object.assign({ name: duel.opp.name, rating: duel.opp.rating, maxPoise: duel.opp.maxPoise }, applied.opp);
        duel.round += 1;
        if (applied.over) {
            duel.over = true;
            duel.victor = applied.victor;
        }
        return { aR: effP, oR: effO, oppLabel: duel.opp.name, delta, P, u, tier, opening: openingBonus > 0 };
    }

    /** Resolve a described COMBO (2+ strikes) as ONE exchange with per-strike
     *  texture. Each strike rolls on its own footing; a landed strike opens the
     *  next, a missed or fumbled one leaves the player exposed so the chain can
     *  collapse. The whole chain maps to a SINGLE overall exchange outcome (one
     *  exchange's worth of poise, margin-scaled) — so a combo is HIGH-RISK
     *  (landing a full chain is harder than one roll, and a bad strike lets the
     *  opponent counter), never a free damage multiplier. */
    function resolveDuelSequence(meta, adj) {
        const duel = meta.duel;
        const preset = getPreset();
        const s = getSettings();
        const style = outcomeOnly();
        const openingBonus = (!style && duel.player.opening) ? 1 : 0; if (!style) duel.player.opening = false;
        const oppOpeningBonus = (!style && duel.opp.opening) ? 1 : 0; if (!style) duel.opp.opening = false;
        const compPen = composurePenalty(meta);
        const oppCompPen = combatantComposurePenalty(duel.opp);
        const effO = duel.opp.rating - duel.opp.injuries + duel.opp.momentum + oppOpeningBonus;
        const scoreOf = { DECISIVE: 2, SUCCESS: 1, SUCCESS_COST: 1, TRADE: 0, STALEMATE: 0, SETBACK: -1, FAILURE: -1, DISASTER: -2 };
        const seq = adj.sequence, n = seq.length;
        const steps = [];
        let carry = openingBonus, net = 0, lastU = 0;
        for (const st of seq) {
            const effP = duel.player.rating - duel.player.injuries + duel.player.momentum + carry;
            const delta = clamp(effP - effO + st.circumstance + (duel.scaleMismatch || 0) + compPen - oppCompPen + preset.bonus, -13, 13);
            const P = probFromDelta(delta), u = rngFloat(); lastU = u;
            const tier = tieCheck(sliceOutcome(P, u, preset.mods), P, u, s.tieBand);
            const sc = scoreOf[tier] ?? 0; net += sc;
            if (sc > 0) carry = Math.min(2, carry + 1);                 // a landed strike sets up the next
            else if (tier === 'DISASTER') carry = Math.max(-2, carry - 2); // a fumble leaves them wide open
            else if (sc < 0) carry = Math.max(-2, carry - 1);
            steps.push({ strike: st.strike, tier });
        }
        // Whole-chain outcome, SYMMETRIC in severity so a combo is high-variance
        // but NOT win-more: net +k maps to a win as severe as net -k maps to a
        // loss (DECISIVE↔DISASTER, SUCCESS↔FAILURE). Landing a full combo is
        // genuinely hard; a chain that fell apart flips to the opponent.
        const frac = net / (2 * n);
        const overall = frac >= 0.5 ? 'DECISIVE' : frac > 0 ? 'SUCCESS' : frac === 0 ? 'TRADE' : frac > -0.5 ? 'FAILURE' : 'DISASTER';
        const avgCirc = seq.reduce((t, x) => t + x.circumstance, 0) / n;
        const margin = clamp((duel.player.rating - duel.player.injuries + duel.player.momentum) - effO + avgCirc + (duel.scaleMismatch || 0) + compPen - oppCompPen + preset.bonus, -13, 13);
        if (style) {
            duel.round += 1;
            return { steps, overall, tier: overall, aR: duel.player.rating, oR: effO, delta: margin, P: probFromDelta(margin), u: lastU, combo: true, over: false, victor: null, outcome: true };
        }
        const applied = applyExchangeEffects(duel.player, duel.opp, overall, margin);
        duel.player = Object.assign({ name: duel.player.name, rating: duel.player.rating, maxPoise: duel.player.maxPoise }, applied.player);
        duel.opp = Object.assign({ name: duel.opp.name, rating: duel.opp.rating, maxPoise: duel.opp.maxPoise }, applied.opp);
        duel.round += 1;
        if (applied.over) { duel.over = true; duel.victor = applied.victor; }
        return { steps, overall, tier: overall, aR: duel.player.rating, oR: effO, delta: margin, P: probFromDelta(margin), u: lastU, combo: true, over: applied.over, victor: applied.victor };
    }

    function buildDuelSequenceDirective(meta, adj, res) {
        const duel = meta.duel;
        const strikeLines = res.steps.map(st => { const t = TIERS[st.tier] || TIERS.FAILURE; return '  • ' + st.strike + ' → ' + t.name; }).join('\n');
        const ov = TIERS[res.overall] || TIERS.FAILURE;
        const lines = [
            '[ARBITER — duel, round ' + duel.round + ': ' + duel.player.name + ' commits to a combo]',
            'Narrate the combo strike by strike, IN ORDER, honoring each result exactly:',
            strikeLines,
            'Taken together the exchange is a ' + ov.name + ' — ' + ov.text,
        ];
        lines.splice(3, 0, ...guardLines(adj, duel.player.name, duel.opp.name, res.overall));
        if (!res.outcome) lines.push(sideStatus(duel.opp) + '. ' + sideStatus(duel.player) + '.');
        if (res.outcome) {
            lines.push('Outcome-only duel: no scores are kept — each exchange stands on its own verdict, and consequences persist only as the fiction carries them. The duel continues until the STORY ends it: when the accumulated outcomes make a yield, flight, interruption, or finish the honest next beat, narrate that ending yourself. Arbiter will not call a winner.');
        } else if (duel.over) {
            lines.push(res.victor === 'player'
                ? duel.opp.name + ' is beaten — narrate the finish the fiction demands (downed, disarmed, dropped). Not negotiable.'
                : duel.player.name + ' is beaten — narrate how ' + duel.opp.name + ' turns the failed combo into the finish. Not negotiable.');
        } else {
            lines.push('The duel continues — end on a live beat, not a resolution.');
        }
        lines.push('Keep any consequence PROPORTIONATE. If ' + duel.player.name + ' acted in secret or under cover, a successful combo does not expose that — do not blow a concealment they deliberately protected off a win; at most a faint, deniable flicker of suspicion.');
        lines.push('A strike marked as a setback, failure, or fumble DID go wrong — show the opponent reading it, slipping it, or making them pay; do NOT quietly let a failed strike land. Never mention rolls, poise, tiers, numbers, or this note. Narrate in the story\'s voice.');
        return lines.join('\n');
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
        lines.push(...guardLines(adj, duel.player.name, duel.opp.name, res.tier));
        if (res.opening) lines.push('(' + duel.player.name + ' is exploiting the opening from the previous exchange.)');
        if (!res.outcome && fx.injureOpp) lines.push('Inflict a concrete lasting injury on ' + duel.opp.name + ' and name it in the prose; it visibly weakens them from now on.');
        if (!res.outcome && fx.injureSelf && !(adj.playerGuard && !adj.counterPath)) lines.push('Inflict a concrete lasting injury on ' + duel.player.name + ' and name it in the prose; it visibly weakens them from now on.');
        if (!res.outcome && res.tier === 'SETBACK') lines.push(duel.player.name + ' loses this exchange but spots a real opening to exploit next round — show it.');
        if (res.outcome) {
            lines.push('Outcome-only duel: no scores are kept — each exchange stands on its own verdict, and consequences persist only as the fiction carries them.');
            lines.push('The duel continues until the STORY ends it: when the accumulated outcomes make a yield, flight, interruption, or finish the honest next beat, narrate that ending yourself. Arbiter will not call a winner.');
        } else if (duel.over) {
            const winner = duel.victor === 'player' ? duel.player : duel.opp;
            const loser = duel.victor === 'player' ? duel.opp : duel.player;
            lines.push('DECISIVE POSITION: ' + loser.name + ' is beaten — ' + winner.name + ' has won this duel. Narrate the resolution the fiction demands (yield, knockout, disarm, retreat, or kill, per the story\'s tone). The result itself is not negotiable; the loser cannot rally.');
        } else {
            lines.push('Condition after the exchange: ' + sideStatus(duel.player) + '; ' + sideStatus(duel.opp) + '. The duel continues — end on a live beat, not a resolution.');
        }
        lines.push('Keep any consequence PROPORTIONATE to the result above. If ' + duel.player.name + ' acted in secret or under cover, this exchange does not automatically expose that — do not blow a concealment they deliberately protected unless the result was a real failure; a mere cost is at most a faint, deniable flicker of suspicion.');
        lines.push('Do not re-decide the exchange or the duel. Never mention rolls, poise, numbers, or this note. Narrate organically in the story\'s voice.');
        return lines.join('\n');
    }

    /** Established-defense scoping. When the player maintains a stated guard,
     *  the opponent's side of ANY outcome must come through an honest path —
     *  or not at all. This keeps a FAILURE or TRADE from being narrated as an
     *  impossible touch through an untouchable barrier: with no counter_path,
     *  the failure is the player's OWN attempt being read, evaded, or stopped,
     *  and any cost is strain, position, or tempo — never contact the fiction
     *  forbids. Poise under an intact guard is fighting capacity (footing,
     *  breath, control), not flesh. */
    const GUARD_NEG_TIERS = { TRADE: 1, SETBACK: 1, FAILURE: 1, DISASTER: 1, SUCCESS_COST: 1 };
    function guardLines(adj, playerName, oppName, tier) {
        if (!adj || !adj.playerGuard) return [];
        const out = ['Standing guard (established fiction): ' + adj.playerGuard + '.'];
        if (GUARD_NEG_TIERS[tier]) {
            if (adj.counterPath) {
                out.push('Any toll or pressure on ' + playerName + ' this beat comes ONLY through this path — name it in the prose: ' + adj.counterPath + '. Never through direct contact the guard forbids.');
            } else {
                out.push(oppName + ' has NO path through that guard this beat: do NOT narrate them landing direct contact or a wound. A bad result here is ' + playerName + '\'s OWN attempt failing — read, evaded, deflected, or stopped — and any cost is strain, lost footing, a jarred grip, or ceded tempo. The guard itself holds.');
            }
        }
        return out;
    }

    /** A fight opened on a declaration or squaring-up: bind the storyteller
     *  to the standoff WITHOUT any outcome — nothing was attempted, nothing
     *  was rolled, and nothing may be resolved this turn. */
    function buildArmedDirective(meta, adj) {
        const duel = meta.duel;
        const head = duel
            ? '[ARBITER — duel joined: ' + duel.player.name + ' vs ' + duel.opp.name + ']'
            : '[ARBITER — ' + (meta.battle && meta.battle.kind === 'war' ? 'war' : 'battle') + ' joined]';
        return [
            head,
            'The fight has only been JOINED: ' + (adj.action || 'the squaring-up') + '. No blow has landed, nothing has succeeded or failed, and no outcome has been decided.',
            'Narrate the standoff, the words, and the readying exactly as written — declarations, taunts, and drawn steel are not attacks, and neither side gains or loses anything yet.',
            'The first committed attempt will be adjudicated as round 1. End on the brink, not past it. Never mention rolls, numbers, or this note. Narrate organically in the story\'s voice.',
        ].join('\n');
    }

    /** Fast mode: zero-LLM pre-rolled pool, NE-P style (weaker: the model picks the footing). */
    function buildFastDirective(meta, lastUserMes) {
        const s = getSettings();
        const preset = getPreset();
        const attempt = String(lastUserMes.mes).replace(/\s+/g, ' ').slice(0, 90);
        const who = mcName(meta);
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

    /** Sheet key for a name, or null. Exact (case-insensitive) first, then a
     *  loose WHOLE-WORD match so "Kaiser" resolves to "Kaiser von Adler" —
     *  token-based, never a bare substring, so "Ana" never matches "Anakin"
     *  and a short name can't grab the wrong actor's rating. */
    function findActorKey(meta, name) {
        const actors = meta.sheet?.actors || {};
        const target = String(name || '').toLowerCase().trim();
        if (!target) return null;
        for (const key of Object.keys(actors)) {
            if (key.toLowerCase().trim() === target) return key;
        }
        const tt = target.split(/[\s,]+/).filter(Boolean);
        for (const key of Object.keys(actors)) {
            const kt = key.toLowerCase().trim().split(/[\s,]+/).filter(Boolean);
            if (kt.some(w => w.length > 1 && tt.includes(w))) return key;
        }
        return null;
    }

    function findActor(meta, name) {
        const key = findActorKey(meta, name);
        return key === null ? null : (meta.sheet?.actors || {})[key];
    }

    /** Exact-match-only lookup (case-insensitive) — for generic xN squads,
     *  where the loose token matcher must never hand a mook a named
     *  character's rating ("Guard x3" ← "Guard Captain"). */
    function findActorExact(meta, name) {
        const actors = meta.sheet?.actors || {};
        const target = String(name || '').toLowerCase().trim();
        if (!target) return null;
        for (const key of Object.keys(actors)) {
            if (key.toLowerCase().trim() === target) return actors[key];
        }
        return null;
    }

    /** Seeding-grade IDENTITY match: an existing sheet key counts as the same
     *  person only when one name's tokens are a subset of the other's
     *  ("Kaiser" ↔ "Kaiser von Adler"). A mere shared surname is NOT identity —
     *  siblings ("Claire Wessex" vs a seeded "Marcus Wessex") must never be
     *  merged into one entry or delete each other, which the loose any-shared-
     *  token matcher would allow. Returns the sheet key, or null. */
    function findActorKeySamePerson(meta, name) {
        const actors = meta.sheet?.actors || {};
        const nrm = (x) => String(x || '').toLowerCase().trim();
        const toks = (x) => nrm(x).split(/[\s,]+/).filter(Boolean);
        const target = nrm(name);
        if (!target) return null;
        for (const key of Object.keys(actors)) if (nrm(key) === target) return key;
        const tt = toks(name);
        if (!tt.length) return null;
        for (const key of Object.keys(actors)) {
            const kt = toks(key);
            if (!kt.length) continue;
            if (kt.every(w => tt.includes(w)) || tt.every(w => kt.includes(w))) return key;
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
        const isPlayerActor = isMcAlias(meta, adj.actor);
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
            ...guardLines(adj, adj.actor, adj.kind === 'actor' ? adj.opposition : 'The opposition', res.tier),
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
            guard: adj.playerGuard || undefined,
            path: adj.counterPath || undefined,
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

    // Chat identity epoch. Bumped on CHAT_CHANGED so any async work that began
    // in another chat (an adjudication awaiting its LLM, a 60s background seed)
    // can detect the switch and DISCARD itself instead of injecting a stale
    // directive into the new chat or writing to a detached metadata object.
    let chatEpoch = 0;

    // In-flight latch, epoch-scoped: a stale run from ANOTHER chat must never
    // block the current chat's first check (the old boolean latch did).
    let inFlightEpoch = null;
    // Last referee call, captured verbatim for the inspector (ephemeral, per session).
    let LAST_ADJ = null;

    /** Rewind the WORLD (fights, threads, engines, seeds, tick/turn counters,
     *  player composure) to a stored pre-turn snapshot. The single primitive
     *  behind edit re-rolls, /arb re-adjudication, and timeline pruning. The
     *  SHEET is deliberately not snapshotted: condition adds are name-deduped
     *  (idempotent on replay) and rating baselines are cross-timeline facts. */
    function restoreSnapshot(meta, snap) {
        if (!snap || typeof snap !== 'object') return;
        if ('d' in snap || 'b' in snap) {
            meta.duel = deepCopy(snap.d);
            meta.battle = deepCopy(snap.b);
            if (snap.t !== undefined) meta.threads = deepCopy(snap.t) || [];
            if (snap.e !== undefined && snap.e) meta.engines = deepCopy(snap.e);
            if (snap.tc !== undefined) meta.tickCount = snap.tc;
            if (snap.tn !== undefined) meta.turnCount = snap.tn;
            if (snap.es !== undefined) meta.encounterSeeds = snap.es ? snap.es.slice() : undefined;
            if (snap.ws !== undefined) meta.worldSeeds = snap.ws ? snap.ws.slice() : undefined;
            if (snap.c !== undefined) {
                if (snap.c === null) delete meta.composure;
                else meta.composure = snap.c;
            }
        } else {
            meta.duel = deepCopy(snap); // legacy v0.2 snapshot: duel-or-null
        }
    }

    async function interceptorBody(chat, contextSize, abort, type) {
        const s = getSettings();
        if (!s.enabled) return;
        // Everything below (meta, injections, cache commits) belongs to THIS
        // chat. If the user switches chats while we await the referee, this
        // run is stale: it must not inject, commit, or mutate anything.
        const epoch = chatEpoch;
        const stale = () => epoch !== chatEpoch;

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
        const sendDate = String(lastUser.send_date || '');

        // ── Committed-turn HISTORY: the timeline of resolved player turns ──
        // Each committed turn stores its binding directive, its ambient-event
        // text, and a snapshot of the world taken BEFORE that turn ran. This is
        // what lets deleting a few exchanges, or branching a chat from an
        // earlier point, REWIND fights/threads/engines/composure to exactly the
        // surviving timeline instead of desyncing (the single-slot cache only
        // ever covered the very last message).
        if (!Array.isArray(meta.history)) meta.history = [];

        // PRUNE: any suffix of committed turns whose user messages no longer
        // exist in this chat (deleted tail, or a branch carrying a longer
        // timeline's metadata) has vanished. Rewind the world to the moment
        // before the OLDEST vanished turn and drop those entries. Suffix-only
        // by design: fate-permanence for turns whose messages still stand.
        try {
            if (meta.history.length) {
                const hKeys = new Set(meta.history.map(h => h.key));
                const present = new Set();
                let anchors = 0;
                let scanned = 0;
                for (let i = chat.length - 1; i >= 0 && scanned < 60; i--) {
                    const m = chat[i];
                    if (!m || !m.is_user || m.is_system || !m.mes || !String(m.mes).trim()) continue;
                    scanned++;
                    const k = hashStr(String(m.mes) + '|' + String(m.send_date || ''));
                    present.add(k);
                    if (hKeys.has(k)) anchors++;
                }
                // ANCHOR RULE: prune only when at least one committed turn is
                // provably still in this chat. A view containing NONE of them
                // (a truncated window, a foreign branch) is unrecognizable —
                // acting on it would wipe live fights off mere invisibility.
                if (anchors > 0) {
                    let firstVanished = -1;
                    for (let i = meta.history.length - 1; i >= 0; i--) {
                        if (present.has(meta.history[i].key)) break; // this turn and everything older still stand
                        firstVanished = i;
                    }
                    if (firstVanished !== -1) {
                        const gone = meta.history.length - firstVanished;
                        restoreSnapshot(meta, meta.history[firstVanished].snap);
                        meta.history.length = firstVanished;
                        // Re-point the single-slot mirror at the new last turn so
                        // same-key replays and edit-rewinds keep working unchanged.
                        const last = meta.history[meta.history.length - 1] || null;
                        meta.cache = last ? { key: last.key, sendDate: last.sendDate, directive: last.directive, tier: last.tier, duelSnapshot: last.snap } : null;
                        if (meta.eventCache && !present.has(meta.eventCache.key)) delete meta.eventCache;
                        if (last && last.eventText) meta.eventCache = { key: last.key, text: last.eventText };
                        renderHud(); renderThreads();
                        saveMeta();
                        dlog('timeline pruned:', gone, 'deleted turn(s) — world rewound to the surviving timeline');
                    }
                }
            }
        } catch (e) {
            warn('history prune failed; clearing history to stay safe', e);
            meta.history = [];
        }

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
        if (meta.cache && meta.cache.sendDate === sendDate && meta.cache.duelSnapshot !== undefined) {
            restoreSnapshot(meta, meta.cache.duelSnapshot);
            if (meta.eventCache && meta.eventCache.key === key) delete meta.eventCache;
            // Keep the timeline consistent with the rewound world: this turn's
            // committed entry is void (a fresh roll below re-commits, or — if
            // the roll fails — the next attempt starts from this clean state).
            if (meta.history.length) {
                const last = meta.history[meta.history.length - 1];
                if (last && (last.key === key || last.sendDate === sendDate)) meta.history.pop();
            }
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

        // Snapshot the pre-turn world BEFORE any ticks, exchanges, or counters
        // mutate it (the turn counter increments AFTER, so snap.tn is truly
        // pre-turn — the prune must not resurrect a deleted turn's count).
        const duelSnapshot = {
            d: meta.duel ? deepCopy(meta.duel) : null,
            b: meta.battle ? deepCopy(meta.battle) : null,
            t: deepCopy(meta.threads || []),
            e: meta.engines ? deepCopy(meta.engines) : null,
            tc: meta.tickCount || 0,
            tn: meta.turnCount || 0,
            es: Array.isArray(meta.encounterSeeds) ? meta.encounterSeeds.slice() : null,
            ws: Array.isArray(meta.worldSeeds) ? meta.worldSeeds.slice() : null,
            // Player composure lives on meta, OUTSIDE duel/battle objects — without
            // this an edited re-send double-applies the turn's mental toll (a -3
            // horror beat re-rolled lands as -6): composure drift on every re-roll.
            c: (typeof meta.composure === 'number') ? meta.composure : null,
        };

        if (genType === 'normal') meta.turnCount = (meta.turnCount || 0) + 1;

        // Commit a resolved turn: the single-slot mirror (fast path, legacy
        // metas) AND the timeline history entry that makes it rewindable.
        const commitCache = (directive, tier) => {
            meta.cache = { key, sendDate, directive, tier, duelSnapshot };
            if (!Array.isArray(meta.history)) meta.history = [];
            const eventText = (meta.eventCache && meta.eventCache.key === key) ? meta.eventCache.text : null;
            const entry = { key, sendDate, directive, tier, eventText, snap: duelSnapshot };
            const last = meta.history[meta.history.length - 1];
            // A force re-roll (same key) or an edit that slipped past the prune
            // (same sendDate) REPLACES its turn; a fresh turn appends.
            if (last && (last.key === key || last.sendDate === sendDate)) meta.history[meta.history.length - 1] = entry;
            else meta.history.push(entry);
            if (meta.history.length > HISTORY_CAP) meta.history.splice(0, meta.history.length - HISTORY_CAP);
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
            commitCache('', null);
            saveMeta();
            return;
        }

        if (inFlightEpoch === chatEpoch) { dlog('adjudication already in flight; skipping'); return; }
        inFlightEpoch = chatEpoch;
        const t0 = Date.now();
        try {
            const budget = clamp(s.timeoutMs, 1500, 60000);
            const duelToast = (adjAction, res) => {
                if (!s.toastResults) return;
                const t = TIERS[res.tier] || {};
                const rnd = inBattle ? meta.battle.round : (meta.duel ? meta.duel.round : 0);
                toast('info', escHtml(adjAction) + '<br><small>' + escHtml(TIER_MEANING[res.tier] || t.text || '') + '</small>' + (s.showMath ? '<br><small>' + escHtml('Δ=' + (res.delta >= 0 ? '+' : '') + res.delta + ' → P ' + Math.round(res.P * 100) + '% → u ' + (Math.round(res.u * 1000) / 1000)) + '</small>' : ''), 'R' + rnd + ' · ' + t.name);
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
                    if (out.focalRes) pushLog(meta, { action, domain: 'war', actor: mcName(meta), circumstance: 0, why: 'fast' }, out.focalRes, meta.battle.round);
                    saveMeta(); renderHud(); renderLog();
                    if (out.focalRes) duelToast(action, out.focalRes);
                } else if (inBattle) {
                    const out = resolveBattleRound(meta, { kind: 'fight', target: null, action, circumstance: 0 });
                    const directive = buildBattleDirective(meta, { action }, out);
                    setInjection(directive);
                    commitCache(directive, out.mcRes ? out.mcRes.tier : null);
                    if (out.mcRes) pushLog(meta, { action, domain: meta.battle.domain, actor: mcName(meta), circumstance: 0, why: 'fast' }, out.mcRes, meta.battle.round);
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
            // World Info (opt-in, async): activate lorebook entries against the
            // action + recent story, then fold them in with the other context.
            if (s.adjIncludeWorld) {
                const scanText = compactRecent(chat, 12, null, !!s.adjIncludeHidden) + '\n' + String(lastUser.mes || '');
                const wi = await collectWorldInfoBlock(scanText, clamp(s.adjContextK, 4, 500) * 1000);
                if (stale()) { dlog('chat changed during WI activation; check discarded'); return; }
                if (wi) userPrompt = userPrompt.includes('<recent>') ? userPrompt.replace('<recent>', wi + '\n\n<recent>') : (userPrompt + '\n\n' + wi);
            }
            // Capture verbatim for the inspector so the user can read exactly what
            // the referee sees (mode, both halves of the prompt, size).
            LAST_ADJ = { when: Date.now(), mode: inDuel ? 'duel' : (inWar ? 'war' : (inBattle ? 'battle' : 'check')),
                rich: { memory: !!s.adjIncludeMemory, card: !!s.adjIncludeCard, world: !!s.adjIncludeWorld, fullChat: !!s.adjFullChat, hidden: !!s.adjIncludeHidden, ctxK: s.adjContextK, ctxMsgs: s.ctxMsgs },
                system: sysPrompt, user: userPrompt, chars: sysPrompt.length + userPrompt.length };

            // 600 tokens, not a tight 260: a terse model stops early anyway (no
            // latency cost), while a thinking model that reasons before the JSON,
            // or a full 5-strike sequence payload, no longer truncates into an
            // unparseable object and silently kills the check.
            let rawOut = await callLLM(sysPrompt, userPrompt, 600, budget);
            if (stale()) { dlog('chat changed mid-adjudication; stale check discarded'); return; }
            const normalize = (r) => {
                for (const cand of extractJsonCandidates(r, 5)) {
                    const n = inDuel ? normalizeDuelAdj(cand) : (inWar ? normalizeWarAdj(cand) : (inBattle ? normalizeBattleAdj(cand) : normalizeAdj(cand, meta)));
                    if (n) return n;
                }
                return null;
            };
            let adj = normalize(rawOut);

            // One fast retry if the model returned junk and time remains.
            // One fast retry if the model returned junk — OR nothing at all
            // (a transient network blip / 429 used to mean a silently lost
            // check; the empty case never retried) — and time remains.
            if (!adj && (Date.now() - t0) < budget - 1500) {
                dlog(rawOut ? 'invalid JSON, retrying once' : 'empty referee response, retrying once');
                rawOut = await callLLM(
                    sysPrompt + (rawOut ? '\n\nYour previous output was invalid. Output ONLY the JSON object.' : ''),
                    userPrompt, 600, budget - (Date.now() - t0));
                if (stale()) { dlog('chat changed mid-retry; stale check discarded'); return; }
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
                if (conditionNote) {
                    // The condition lands on the LIVE fight too, not only future
                    // ones — a mid-duel "broken arm" changes THIS duel's math.
                    try { refreshLiveRating(meta, adj.condition_change.who); } catch (e) { /* non-fatal */ }
                    saveMeta(); renderSheet(); dlog('condition:', conditionNote);
                }
            }
            // Mental strain from the fiction's emotional weight.
            let composureNote = null;
            if (adj.composure_change) {
                const cr = applyComposureChange(meta, adj.composure_change);
                if (cr) {
                    composureNote = cr.worsened
                        ? 'The strain shows — ' + mcName(meta) + ' is ' + cr.state + '.'
                        : mcName(meta) + ' steadies, now ' + cr.state + '.';
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
                if (out.focalRes) pushLog(meta, { action: adj.action, domain: 'war', actor: mcName(meta), circumstance: adj.circumstance, why: adj.why, playerGuard: adj.playerGuard, counterPath: adj.counterPath }, out.focalRes, meta.battle.round);
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
                if (out.mcRes) pushLog(meta, { action: adj.action, domain: meta.battle.domain, actor: mcName(meta), circumstance: adj.circumstance, why: adj.why, playerGuard: adj.playerGuard, counterPath: adj.counterPath }, out.mcRes, meta.battle.round);
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
                const res = (adj.sequence && adj.sequence.length >= 2)
                    ? resolveDuelSequence(meta, adj)
                    : resolveDuelExchange(meta, adj.circumstance, adj.moveKind);
                // Fear/steel from this exchange shifts each fighter's nerve.
                if (adj.oppComposure && meta.duel && meta.duel.opp) shiftCombatantComposure(meta.duel.opp, adj.oppComposure);
                if (adj.selfComposure) applyComposureChange(meta, adj.selfComposure);
                const directive = res.combo ? buildDuelSequenceDirective(meta, adj, res) : buildDuelDirective(meta, adj, res);
                setInjection(directive);
                commitCache(directive, res.tier);
                pushLog(meta, { action: adj.action, domain: meta.duel.domain, actor: meta.duel.player.name, circumstance: adj.circumstance, why: adj.why, playerGuard: adj.playerGuard, counterPath: adj.counterPath }, res, meta.duel.round);
                saveMeta(); renderHud(); renderLog();
                dlog('duel round', meta.duel.round, 'resolved in', Date.now() - t0, 'ms →', res.tier);
                duelToast(adj.action, res);
                return;
            }

            if (adj.check === false) {
                // Arm-only: combat opened on a declaration or squaring-up with
                // no contested attempt. The fight arms, NOTHING is rolled, no
                // log entry is written — the first real attempt is round 1.
                if (adj.duel_start && !adj.battle_start && s.autoDuel) {
                    if (s.autoSeed && !findActor(meta, adj.duel_start) && !autoSeedRunning) {
                        autoSeedRunning = true;
                        Promise.resolve(seedSheet({ auto: true })).finally(() => { autoSeedRunning = false; });
                    }
                    startDuel(meta, mcName(meta), adj.duel_start, combatDomain(adj.domain), adj.opponent_rating, adj.scale_mismatch);
                    const directive = buildArmedDirective(meta, adj);
                    setInjection(directive);
                    commitCache(directive, 'ARMED');
                    saveMeta(); renderHud();
                    toast('info', escHtml(meta.duel.player.name + ' vs ' + meta.duel.opp.name + ' — squared up, nothing rolled. The first real attempt is round 1.'), 'DUEL JOINED');
                    return;
                }
                if (adj.battle_start && s.autoBattle) {
                    const started = startBattle(meta, adj.battle_start.allies, adj.battle_start.enemies, combatDomain(adj.domain), adj.scale_mismatch, adj.opponent_rating);
                    if (started) {
                        const directive = buildArmedDirective(meta, adj);
                        setInjection(directive);
                        commitCache(directive, 'ARMED');
                        saveMeta(); renderHud();
                        toast('info', escHtml(standing(meta.battle.allies).length + ' vs ' + standing(meta.battle.enemies).length + ' — battle joined, nothing rolled.'), 'BATTLE JOINED');
                        return;
                    }
                }
                if (adj.war_start && s.autoWar) {
                    const started = startWar(meta, adj.war_start.allies, adj.war_start.enemies, adj.war_start.enemy_commander, adj.scale_mismatch);
                    if (started) {
                        const directive = buildArmedDirective(meta, adj);
                        setInjection(directive);
                        commitCache(directive, 'ARMED');
                        saveMeta(); renderHud();
                        toast('info', escHtml(standing(nonPlayer(meta.battle.allies)).length + ' formations vs ' + standing(meta.battle.enemies).length + ' — war joined, nothing rolled.'), 'WAR JOINED');
                        return;
                    }
                }
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
                startDuel(meta, adj.actor, adj.duel_start, combatDomain(adj.domain), adj.opponent_rating, adj.scale_mismatch);
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
                const started = startBattle(meta, adj.battle_start.allies, adj.battle_start.enemies, combatDomain(adj.domain), adj.scale_mismatch, adj.opponent_rating);
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
                toast('info', escHtml(adj.action) + '<br><small>' + escHtml(TIER_MEANING[res.tier] || t.text || '') + '</small>' + (s.showMath ? '<br><small>' + escHtml(mathLine(line)) + '</small>' : ''), t.name);
            }
            renderLog();
        } finally {
            // Release only OUR latch: if the chat changed and a new run took the
            // latch for the new epoch, this stale finally must not clobber it.
            if (inFlightEpoch === epoch) inFlightEpoch = null;
            clearActivity();
        }
    }

    // Assigned at load so ST can find it whenever generation starts.
    globalThis.arbiterInterceptor = async function (chat, contextSize, abort, type) {
        try {
            await interceptorBody(chat, contextSize, abort, type);
        } catch (e) {
            warn('interceptor error (generation proceeds):', e);
            inFlightEpoch = null;
        }
    };

    /* ------------------------------------------------------------------ */
    /* Sheet seeding                                                       */
    /* ------------------------------------------------------------------ */

    const SEED_SYSTEM = [
        'You read a roleplay transcript and produce a capability sheet for outcome adjudication. Output STRICT JSON only, one object, no markdown.',
        '',
        'Schema:',
        '{"player_story_name": "<the player character\'s full IN-STORY name, exactly as the fiction uses it>", "actors": {"<Name>": {"default": <0-10>, "domains": {"<domain>": <0-10>, ...}}, ...}}',
        '',
        'Rating guide (by effective threat, ANY kind of combatant — person, beast, monster, machine, alien): 2 untrained, 4 trained, 5 competent professional, 6 veteran, 7 elite, 8 master, 9 legendary, 10 apex. Rate creatures by how dangerous they are, not their species: a feral dog 3, a warhound 5, a dire beast or trained monster 7, an ancient dragon or apex predator 9-10. A domain like "melee" for a beast means its natural weapons (claws, fangs, breath).',
        'CALIBRATE TO THE STORY\'S OWN HIERARCHY: the labels above are a baseline, but if the setting has ranks, tiers, classes, or a clear pecking order (school rankings like A/B/C, tournament seeding, dueling classes, a military chain, a stated power-level system), place each character WITHIN it. Someone at or near the top of that structure — a top-ranked or high-tier student, a champion, an ace, a captain, a feared name — belongs at the HIGH end (7-9), even if words like "student" or "young" make them sound junior. Read the ranking, not the job title.',
        'Domains are lowercase single words (melee, ranged, stealth, social, athletics, intellect, willpower, pilot, craft — invent others only if the story clearly needs them).',
        'Include the player character AND every named CHARACTER in the story — allies, rivals, mentors, recurring NPCs, and people listed in <known_characters> — not only those active in the recent transcript. A large cast is expected; cover everyone named and do NOT silently drop characters to save space. 2-4 domains per actor is plenty. Rate from evidence in the transcript and memory. When unsure about an ordinary or background figure, prefer 4-6 — but a named rival, antagonist, boss, or anyone the player faces in a SERIOUS fight is a genuine challenge: rate them as a PEER of the player or stronger unless the fiction plainly shows they are outmatched. Never default a named threat to average. Merge obvious duplicates or aliases into a single entry.',
        'Rate each character at their CURRENT power level as of the latest events. If the story shows someone has trained, leveled up, unlocked new power, or grown stronger since earlier, reflect that higher rating now — a character who was trained (4) and has since become elite should be rated elite (7). The <existing_sheet> shows prior ratings; when the fiction clearly shows growth beyond them, rate the new, higher level.',
        'player_story_name: the name the STORY calls the player character — their actual in-fiction identity (a full given name + surname when the fiction uses one), which may be COMPLETELY different from the player_character label in <voices>. Read it from the transcript and memory. If the fiction only ever uses the label, return the label. Key the player\'s actors entry under this same name.',
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
        const playerName = mcName(meta);
        const playerLabel = c.name1 || '';
        const cardName = c.name2 || '';
        const labelLine = (playerLabel && playerLabel.toLowerCase() !== playerName.toLowerCase())
            ? 'player_message_label: ' + playerLabel + ' — this labels the player\'s own messages in the transcript; it is the SAME person as ' + playerName + '. Key the player\'s entry under "' + playerName + '" and never create a separate actor for the label.\n'
            : '';
        const voices = '<voices>\nplayer_character: ' + playerName + '\n' + labelLine +
            (cardName ? 'storyteller_label: ' + cardName + ' — this labels the narrator/storyteller\'s messages in the transcript. Do NOT create an actor entry for it unless the story clearly shows an individual PERSON by this exact name who acts and fights in scenes.\n' : '') +
            '</voices>\n\n';
        const userPrompt = '<existing_sheet>\n' + existing + '\n</existing_sheet>\n\n' + voices + rosterBlock + (mem.block ? mem.block + '\n\n' : '') + '<transcript>\n' +
            parts.reverse().join('\n') + '\n</transcript>';

        const seedEpoch = chatEpoch;
        const out = await callLLM(SEED_SYSTEM, userPrompt, clamp(s.seedOutTokens, 400, 8000), 60000, s.seedProfileId || undefined);
        clearActivity();
        if (seedEpoch !== chatEpoch) { dlog('chat changed during sheet seed; result discarded'); return; }
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
            // IDENTITY match, not the loose duel-time matcher: a seeded sibling
            // ("Marcus Wessex") must never merge into or replace "Claire Wessex"
            // just because they share a surname.
            const existingKey = findActorKeySamePerson(meta, key);
            const existing = existingKey ? meta.sheet.actors[existingKey] : null;
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
            // If the same person lived under an ALIAS key (seeder says "Kaiser von
            // Adler", sheet holds an estimated "Kaiser"), drop the old key —
            // otherwise both remain and the loose matcher's key order decides
            // which rating wins from then on.
            if (existingKey && existingKey !== key) delete meta.sheet.actors[existingKey];
            meta.sheet.actors[key] = clean;
            added++;
        }
        // Learn the player's in-story name (persona label ≠ story identity).
        // Only fills an EMPTY mcName — a user-set or previously learned name
        // is never overwritten by a later seed. The narrator card's label is
        // rejected unless it is also the player's own name.
        const learned = typeof obj.player_story_name === 'string'
            ? obj.player_story_name.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
        if (learned && !(typeof meta.mcName === 'string' && meta.mcName.trim())) {
            const cardish = !!cardName && samePersonName(learned, cardName)
                && !samePersonName(learned, playerLabel || playerName);
            if (!cardish) {
                meta.mcName = learned;
                try { $('#arb_mcname').val(learned); } catch (e) { /* headless */ }
                if (playerLabel && learned.toLowerCase() !== playerLabel.toLowerCase()) {
                    toast('info', 'Arbiter identified your character as "' + learned + '" — fights, ratings, and conditions now use that name. Override it in Manual controls if wrong.', 'Player identity');
                }
                dlog('player story name learned:', learned);
            } else dlog('player_story_name rejected (narrator card label):', learned);
        }
        // Heal any split created before the identity was known (a "label"
        // entry holding conditions beside the real story entry).
        reconcilePlayerEntries(meta);
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
            const passEpoch = chatEpoch;
            await seedSheet({ auto: true, firstRun });
            // The user's ✕ cancels the PASS, not just the current call — don't
            // immediately open a second 45s call they just tried to stop. A chat
            // switch mid-pass likewise ends it (the thread seed would target the
            // wrong chat's meta).
            if (passEpoch !== chatEpoch || activityCanceled()) return;
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
      <b>Arbiter Fight and Battle</b>&nbsp;<small class="arb_ver">v${VERSION}</small>
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
        <div class="arb_hint">Timeout: max wait for the referee — on expiry the turn proceeds with no check. Context msgs: how much recent story the referee reads to judge circumstance (lean mode).</div>
        <b>Referee context payload</b>
        <div class="arb_hint">By default the referee reads a lean slice (the sheet + the last few messages). These OPT-IN toggles widen what it sees. Its own neutral system prompt is always used, and SillyTavern's system prompt and your persona are NEVER included (they bias the judge). Wider context is slower and costs more tokens per check; raise the timeout if checks start expiring. Note: the character card is where "unbeatable protagonist" framing usually lives — the sheet already distils capability into neutral ratings, so enable the card only if you want the referee reading raw card text, and watch the effect with "View last check".</div>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_adjmem" type="checkbox"><span>Include full memory (Summaryception, ledger, notes)</span></label>
        </div>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_adjcard" type="checkbox"><span>Include character card (description, personality, scenario)</span></label>
        </div>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_adjworld" type="checkbox"><span>Include World Info (constant + keyword-triggered entries)</span></label>
        </div>
        <div class="arb_row">
          <label>Lorebook(s)</label><input id="arb_adjworldbooks" type="text" class="text_pole" placeholder="empty = active book(s) from ST's dropdown">
        </div>
        <div class="arb_hint">Uses SillyTavern's own activation when available — constant, keyword AND vectorized entries all fire exactly as ST decides. If that API isn't exposed, it falls back to reading your active book(s) directly (constant + keyword only). Leave Lorebook(s) empty to auto-use your active book(s), or pin specific ones by name (comma-separated). Tap "View last check" to confirm which entries fired.</div>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_adjfull" type="checkbox"><span>Feed the whole chat (budgeted) instead of last N</span></label>
        </div>
        <div class="arb_row">
          <label class="checkbox_label"><input id="arb_adjhidden" type="checkbox"><span>Include hidden ("ghosted") messages</span></label>
        </div>
        <div class="arb_row">
          <label>Context budget (K chars)</label><input id="arb_adjctxk" type="number" min="4" max="500" class="text_pole arb_num">
        </div>
        <div class="arb_hint">Budget applies to the whole-chat transcript and to the memory block. Arbiter's own injected directives are never fed back to the referee.</div>
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
          <label>Fights</label>
          <select id="arb_fightstyle" class="text_pole">
            <option value="tracked">tracked</option>
            <option value="outcome">outcome-only</option>
          </select>
        </div>
        <div class="arb_hint">Adjudicated = referee micro-call per check (accurate). Fast = zero-latency pre-rolled pool, storyteller picks the footing (weaker). Preset: gritty = harsher tails · realistic = neutral curve · heroic = +1 player edge, halved disasters. Fights: tracked = poise, forced injuries and a called winner · outcome-only = every exchange still gets its full verdict (DECISIVE…DISASTER at fair odds), but nothing is tallied — no health, no engine-declared end; the STORYTELLER decides when the fight concludes (the referee still closes it once the fiction clearly ends it, and /duelend, /battleend and the HUD ✕ always work).</div>
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
          <label>Your character</label><input id="arb_mcname" type="text" class="text_pole" placeholder="story name (blank = persona name)">
        </div>
        <div class="arb_hint">The name the STORY calls your character, when it differs from your persona label (persona "LO" playing "Jovan Oda"). It keys your sheet ratings, names you in fights, and tells the referee who you are. Auto-detected by seeding; per chat. /mcname &lt;name&gt; works too.</div>
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
        <b>Last check (exactly what the referee saw)</b>
        <div class="arb_hint">The full prompt sent to the referee on your most recent adjudicated turn — its system rules AND the context (sheet, memory if enabled, recent story, your action). Read-only; captured this session only. Tap View to refresh after a turn.</div>
        <textarea id="arb_lastprompt" rows="8" readonly placeholder="No check captured yet this session — send an action, then tap View."></textarea>
        <div class="arb_buttons">
          <div id="arb_lastprompt_view" class="menu_button">View last check</div>
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
                '<br><small>' + escHtml((TIER_MEANING[l.tier] ? TIER_MEANING[l.tier] + ' · ' : '') + l.domain + ' vs ' + l.opp + ' · ' + mathLine(l)) +
                (l.why ? ' · ' + escHtml(l.why) : '') +
                (l.guard ? '<br>' + escHtml('⛨ ' + l.guard + (l.path ? ' — path: ' + l.path : ' — no counter path: the guard held')) : '') + '</small></div>';
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

    function combatantCell(side, sideCls, bare) {
        const pct = Math.max(0, Math.min(100, Math.round((Math.max(0, side.poise) / side.maxPoise) * 100)));
        const initial = escHtml((side.name || '?').trim().charAt(0).toUpperCase() || '?');
        const glyphs = bare ? '' :
            (side.momentum > 0 ? '<span class="arb_g arb_g_mom" title="momentum">▲</span>' : '') +
            (side.injuries > 0 ? '<span class="arb_g arb_g_inj" title="' + side.injuries + ' injury">✚' + (side.injuries > 1 ? side.injuries : '') + '</span>' : '') +
            (side.opening ? '<span class="arb_g arb_g_open" title="opening">◹</span>' : '');
        const low = pct <= 30 && pct > 0 ? ' arb_low' : '';
        return '' +
            '<div class="arb_cell ' + sideCls + '">' +
              '<div class="arb_disc ' + sideCls + '">' + initial + '</div>' +
              '<div class="arb_cellmain">' +
                '<div class="arb_cellrow"><span class="arb_cname">' + escHtml(side.name) + '</span>' + glyphs +
                  (bare ? '' : '<span class="arb_cnum">' + (Math.round(Math.max(0, side.poise) * 10) / 10) + '<span class="arb_cmax">/' + side.maxPoise + '</span></span>') + '</div>' +
                (bare ? '' : '<div class="arb_track"><div class="arb_fill ' + poiseTone(pct) + low + '" style="width:' + pct + '%"></div></div>') +
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
            m.cache = null; // an ended fight can't be resurrected by a re-roll…
            m.history = []; // …nor by a timeline prune-restore
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
            const oStyle = s.fightStyle === 'outcome';
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
                const counts = '<div class="arb_counts">' + (oStyle ? 'outcome-only · ' : '') + A.up + '/' + A.total + ' vs ' + E.up + '/' + E.total + '</div>';
                setHudHtml(el,
                    '<div class="arb_hud_inner">' +
                      '<div class="arb_hud_top">' + badge + counts +
                        '<span class="arb_hud_x" title="End battle">✕</span></div>' +
                      '<div class="arb_hud_body">' +
                        combatantCell(aCell, 'pl', oStyle) +
                        '<div class="arb_vs">VS</div>' +
                        combatantCell(eCell, 'op', oStyle) +
                      '</div>' +
                      '<div class="arb_mc">' + escHtml(mc.name) + (oStyle ? '' : ' · ' + (Math.round(Math.max(0, mc.poise) * 10) / 10) + '/' + mc.maxPoise + (mc.injuries ? ' ✚' + mc.injuries : '') + ((battle.kind === 'war' && battle.conditions && battle.conditions.length) ? ' · ⚑' + battle.conditions.length : '')) + '</div>' +
                    '</div>');
                return;
            }
            const badge = duel.over
                ? '<div class="arb_badge_over">' + (duel.victor === 'draw' ? 'DRAW — BOTH DOWN' : escHtml((duel.victor === 'player' ? duel.player.name : duel.opp.name)) + ' WINS') + '</div>'
                : '<div class="arb_rbadge">R' + duel.round + '</div>' + (oStyle ? '<div class="arb_counts">outcome-only</div>' : '');
            setHudHtml(el,
                '<div class="arb_hud_inner">' +
                  '<div class="arb_hud_top">' + badge +
                    '<span class="arb_hud_x" title="End duel">✕</span></div>' +
                  '<div class="arb_hud_body">' +
                    combatantCell(duel.player, 'pl', oStyle) +
                    '<div class="arb_vs">VS</div>' +
                    combatantCell(duel.opp, 'op', oStyle) +
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
        $('#arb_adjmem').prop('checked', !!s.adjIncludeMemory);
        $('#arb_adjcard').prop('checked', !!s.adjIncludeCard);
        $('#arb_adjworld').prop('checked', !!s.adjIncludeWorld);
        $('#arb_adjworldbooks').val(s.adjWorldBooks || '');
        $('#arb_adjfull').prop('checked', !!s.adjFullChat);
        $('#arb_adjhidden').prop('checked', !!s.adjIncludeHidden);
        $('#arb_adjctxk').val(s.adjContextK);
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
        $('#arb_fightstyle').val(s.fightStyle || 'tracked');
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
        meta.history = [];
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
        delete meta.encounterSeeds;
        delete meta.worldSeeds;
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
        $('#arb_adjmem').prop('checked', !!s.adjIncludeMemory).on('change', function () { s.adjIncludeMemory = this.checked; saveSettings(); });
        $('#arb_adjcard').prop('checked', !!s.adjIncludeCard).on('change', function () { s.adjIncludeCard = this.checked; saveSettings(); });
        $('#arb_adjworld').prop('checked', !!s.adjIncludeWorld).on('change', function () { s.adjIncludeWorld = this.checked; saveSettings(); });
        $('#arb_adjworldbooks').val(s.adjWorldBooks || '').on('input', function () { s.adjWorldBooks = this.value; saveSettings(); });
        $('#arb_adjfull').prop('checked', !!s.adjFullChat).on('change', function () { s.adjFullChat = this.checked; saveSettings(); });
        $('#arb_adjhidden').prop('checked', !!s.adjIncludeHidden).on('change', function () { s.adjIncludeHidden = this.checked; saveSettings(); });
        $('#arb_adjctxk').val(s.adjContextK).on('input', function () { s.adjContextK = clamp(this.value, 4, 500); saveSettings(); });
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
        $('#arb_fightstyle').val(s.fightStyle || 'tracked').on('change', function () { s.fightStyle = this.value === 'outcome' ? 'outcome' : 'tracked'; saveSettings(); renderHud(); });
        $('#arb_autoduel').prop('checked', !!s.autoDuel).on('change', function () { s.autoDuel = this.checked; saveSettings(); });
        $('#arb_showhud').prop('checked', !!s.showHud).on('change', function () { s.showHud = this.checked; saveSettings(); renderHud(); });
        $('#arb_showact').prop('checked', !!s.showActivity).on('change', function () { s.showActivity = this.checked; saveSettings(); renderActivity(); });
        $('#arb_poise').val(s.duelPoise).on('input', function () { s.duelPoise = clamp(this.value, 1, 20); saveSettings(); });
        $('#arb_tieband').val(s.tieBand).on('input', function () { s.tieBand = clamp(this.value, 0, 0.2); saveSettings(); });
        $('#arb_duel_start').on('click', () => {
            const name = String($('#arb_duel_name').val() || '').trim();
            if (!name) { toast('warning', 'Give the opponent a name first.'); return; }
            const meta = getMeta(); if (!meta) return;
            startDuel(meta, mcName(meta), name, 'melee');
            saveMeta(); renderHud();
            toast('success', mcName(meta) + ' vs ' + name + ' — duel armed. Your next message is round 1.');
        });
        $('#arb_duel_end').on('click', () => { const m = getMeta(); if (m && m.duel) { endDuel(m); saveMeta(); } });
        $('#arb_mcname').val(((getMeta() || {}).mcName) || '').on('input', function () {
            const m = getMeta(); if (!m) return;
            const v = String(this.value || '').trim().slice(0, 60);
            if (v) m.mcName = v; else delete m.mcName;
            reconcilePlayerEntries(m);
            saveMeta(); renderHud();
        });

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
        $('#arb_lastprompt_view').on('click', () => {
            if (!LAST_ADJ) { toast('info', 'No check captured yet this session. Send an action that gets adjudicated, then tap View.'); return; }
            const L = LAST_ADJ;
            const when = new Date(L.when).toLocaleTimeString();
            const flags = 'memory:' + (L.rich.memory ? 'ON' : 'off')
                + ' · card:' + (L.rich.card ? 'ON' : 'off')
                + ' · world:' + (L.rich.world ? 'ON' : 'off')
                + ' · whole-chat:' + (L.rich.fullChat ? 'ON (' + L.rich.ctxK + 'K budget)' : 'off (last ' + L.rich.ctxMsgs + ' msgs)')
                + ' · hidden:' + (L.rich.hidden ? 'ON' : 'off');
            const text = '=== LAST CHECK · ' + L.mode + ' · ' + when + ' · ' + L.chars + ' chars total ===\n'
                + flags + '\n\n----- SYSTEM (the referee\'s neutral rules) -----\n' + L.system
                + '\n\n----- CONTEXT (exactly what the referee saw) -----\n' + L.user;
            $('#arb_lastprompt').val(text);
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
            ['mcname', (na, text) => {
                const m = getMeta(); if (!m) { toast('warning', 'No chat open.'); return ''; }
                const v = String(text || '').trim();
                if (!v) { toast('info', 'Player character: "' + mcName(m) + '"' + (m.mcName ? '' : ' (persona default)') + '. /mcname <name> to set, /mcname clear to unset.'); return ''; }
                if (/^clear$/i.test(v)) { delete m.mcName; reconcilePlayerEntries(m); saveMeta(); try { $('#arb_mcname').val(''); } catch (e) {} toast('success', 'Player story name cleared — using the persona name.'); return ''; }
                m.mcName = v.slice(0, 60);
                reconcilePlayerEntries(m);
                saveMeta(); renderHud();
                try { $('#arb_mcname').val(m.mcName); } catch (e) {}
                toast('success', 'Player character is now "' + m.mcName + '" for fights, ratings, conditions, and the referee.');
                return '';
            }, 'Set your character\'s STORY name when it differs from the persona label. /mcname clear resets.'],
            ['duel', (na, text) => {
                const name = String(text || '').trim();
                if (!name) { toast('warning', 'Usage: /duel <opponent name>'); return ''; }
                const m = getMeta(); if (!m) return '';
                startDuel(m, mcName(m), name, 'melee');
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
            chatEpoch++; // any in-flight check/seed from the previous chat is now stale
            clearInjection();
            $('#arb_mcname').val(((getMeta() || {}).mcName) || ''); // per-chat identity
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
            console.log(LOG, 'v' + VERSION + ' ready');
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
