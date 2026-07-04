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
    const INJECT_KEY = 'ARBITER_OUTCOME';
    const LOG = '[Arbiter]';

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
    function sliceOutcome(P, u) {
        const F = 1 - P;
        const decisiveW = P * (0.05 + 0.15 * P);          // deepest success
        const costW = P * (0.15 + 0.35 * F);              // scraped-by success
        const setbackW = F * (0.30 + 0.20 * P);           // fail-forward
        const disasterW = F * (0.03 + 0.12 * F);          // far tail

        if (u < P) {
            if (u < decisiveW) return 'DECISIVE';
            if (u >= P - costW) return 'SUCCESS_COST';
            return 'SUCCESS';
        }
        if (u < P + setbackW) return 'SETBACK';
        if (u >= 1 - disasterW) return 'DISASTER';
        return 'FAILURE';
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
    };

    /** Difficulty / opposition tier presets (unopposed tasks + unnamed foes). */
    const TIER_RATINGS = {
        trivial: 1, easy: 3, moderate: 5, hard: 7, extreme: 9,
        mook: 2, trained: 4, elite: 6, formidable: 8,
        // relative tiers, resolved against the actor's own rating:
        inferior: 'A-2', peer: 'A', superior: 'A+2',
    };

    globalThis.ArbiterEngine = { probFromDelta, sliceOutcome, rngFloat, TIERS, TIER_RATINGS };

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
        'endure', 'brace',
    ].join(', ');

    const DEFAULTS = {
        enabled: true,
        profileId: '',            // Connection Manager profile for the adjudicator
        timeoutMs: 6000,          // hard budget for the micro-call; on expiry: skip
        ctxMsgs: 4,               // recent messages given to the adjudicator
        sensitivity: 'normal',    // conservative | normal | aggressive
        injectDepth: 0,
        injectRole: 'system',     // system | user | assistant
        defaultRating: 5,         // rating when an actor/domain is unknown
        toastResults: true,
        showMath: false,          // include the math line in the toast
        forceTag: '[roll]',
        skipTag: '[skip]',
        verbs: DEFAULT_VERBS,
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

    /**
     * One guarded LLM call. Returns a trimmed string ('' on any failure).
     * Never throws. Respects the hard time budget.
     */
    async function callLLM(systemText, userText, maxTokens, budgetMs) {
        const c = ctx();
        const s = getSettings();
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => { try { controller.abort(); } catch (e) { } }, budgetMs);

        const extract = (res) => {
            if (typeof res === 'string') return res.trim();
            if (res && typeof res === 'object') return String(res.content ?? res.text ?? '').trim();
            return '';
        };

        try {
            const pid = s.profileId;
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
        }
    }

    /** Extract the first balanced {...} object from model output and parse it. */
    function extractJson(text) {
        if (!text) return null;
        const cleaned = String(text).replace(/```(?:json)?/gi, '');
        const start = cleaned.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let inStr = false;
        let escNext = false;
        for (let i = start; i < cleaned.length; i++) {
            const ch = cleaned[i];
            if (escNext) { escNext = false; continue; }
            if (ch === '\\') { escNext = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try { return JSON.parse(cleaned.slice(start, i + 1)); }
                    catch (e) { return null; }
                }
            }
        }
        return null;
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
        ' "domain": "<one lowercase word, e.g. melee, ranged, stealth, social, athletics, intellect, willpower, pilot, craft>",',
        ' "actor": "<who attempts it — usually the player character\'s name>",',
        ' "opposition_kind": "actor" | "tier",',
        ' "opposition": "<a character name from the sheet if a known character opposes; otherwise a task tier: trivial|easy|moderate|hard|extreme, or an unnamed-opponent tier: mook|trained|elite|formidable|inferior|peer|superior>",',
        ' "circumstance": <integer -3..3>,',
        ' "why": "<one short clause justifying circumstance>",',
        ' "stakes": "<what success or failure means here, one short clause>"}',
        '',
        'Rules:',
        '- check=false for dialogue, routine or trivial actions with no meaningful chance of interesting failure, pure narration, OOC talk, or actions attempted by characters other than the player.',
        '- circumstance rewards concrete tactics, positioning, preparation, and exploited weaknesses (+), and penalizes impairment, bad position, or haste (-). Use 0 when nothing notable applies.',
        '- If the opposition is a character present in the sheet, use their name verbatim and opposition_kind "actor".',
    ].join('\n');

    function compactRecent(chat, n) {
        const out = [];
        for (let i = chat.length - 1; i >= 0 && out.length < n; i--) {
            const m = chat[i];
            if (!m || !m.mes || m.is_system) continue;
            const name = m.name || (m.is_user ? 'Player' : 'AI');
            out.push(name + ': ' + String(m.mes).replace(/\s+/g, ' ').slice(0, 300));
        }
        return out.reverse().join('\n');
    }

    function buildAdjUserPrompt(chat, lastUserMes, meta) {
        const s = getSettings();
        const sheet = JSON.stringify(meta.sheet || { actors: {} });
        const recent = compactRecent(chat, clamp(s.ctxMsgs, 1, 10));
        const action = String(lastUserMes.mes).slice(0, 700);
        return '<sheet>\n' + sheet + '\n</sheet>\n\n<recent>\n' + recent + '\n</recent>\n\n<action>\n' + action + '\n</action>';
    }

    function normalizeAdj(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.check === false) return { check: false };
        if (obj.check !== true) return null;
        const domain = String(obj.domain || 'general').toLowerCase().trim() || 'general';
        const actor = String(obj.actor || '').trim() || (ctx().name1 || 'Player');
        const kind = obj.opposition_kind === 'actor' ? 'actor' : 'tier';
        const opposition = String(obj.opposition || 'moderate').trim() || 'moderate';
        return {
            check: true,
            action: String(obj.action || 'the attempt').slice(0, 140),
            domain,
            actor,
            kind,
            opposition,
            circumstance: clamp(Math.round(Number(obj.circumstance) || 0), -3, 3),
            why: String(obj.why || '').slice(0, 160),
            stakes: String(obj.stakes || '').slice(0, 160),
        };
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

    function ratingFor(actorEntry, domain, fallback) {
        if (!actorEntry || typeof actorEntry !== 'object') return fallback;
        const domains = actorEntry.domains || {};
        const d = String(domain || '').toLowerCase();
        for (const key of Object.keys(domains)) {
            if (key.toLowerCase() === d) return clamp(domains[key], 0, 10);
        }
        if (actorEntry.default !== undefined) return clamp(actorEntry.default, 0, 10);
        return fallback;
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

        const delta = clamp(aR - oR + adj.circumstance, -13, 13);
        const P = probFromDelta(delta);
        const u = rngFloat();
        const tier = sliceOutcome(P, u);

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

    function clearInjection() {
        setInjection('');
    }

    /* ------------------------------------------------------------------ */
    /* Log                                                                 */
    /* ------------------------------------------------------------------ */

    function pushLog(meta, adj, res) {
        const line = {
            t: Date.now(),
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
            return;
        }

        // Reaching here on a swipe/regenerate means the player EDITED their
        // action (key mismatch) or nothing was ever committed for it. An
        // edited action is a NEW attempt and gets a fresh, fair roll.
        // Player-initiated retries are a save-point choice, not model
        // sycophancy — the odds never bend, only the dice recast.

        if (!force && !gatePasses(raw)) {
            dlog('gate: no check plausible');
            return;
        }

        if (inFlight) { dlog('adjudication already in flight; skipping'); return; }
        inFlight = true;
        const t0 = Date.now();
        try {
            const budget = clamp(s.timeoutMs, 1500, 60000);
            const userPrompt = buildAdjUserPrompt(chat, lastUser, meta);

            let rawOut = await callLLM(ADJ_SYSTEM, userPrompt, 260, budget);
            let adj = normalizeAdj(extractJson(rawOut));

            // One fast retry if the model returned junk and time remains.
            if (!adj && rawOut && (Date.now() - t0) < budget - 1500) {
                dlog('invalid JSON, retrying once');
                rawOut = await callLLM(
                    ADJ_SYSTEM + '\n\nYour previous output was invalid. Output ONLY the JSON object.',
                    userPrompt, 260, budget - (Date.now() - t0));
                adj = normalizeAdj(extractJson(rawOut));
            }

            if (!adj) {
                dlog('adjudicator unavailable or invalid — turn proceeds unmodified');
                return;
            }
            if (adj.check === false) {
                dlog('adjudicator: no check needed');
                meta.cache = { key, directive: '', tier: null }; // remember the "no check" verdict too
                saveMeta();
                return;
            }

            const res = resolveAdj(adj, meta);
            const directive = buildDirective(adj, res);
            setInjection(directive);

            meta.cache = { key, directive, tier: res.tier };
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
        'Rating guide: 2 untrained, 4 trained, 5 competent professional, 6 veteran, 7 elite, 8 master, 9 legendary, 10 apex-of-setting.',
        'Domains are lowercase single words (melee, ranged, stealth, social, athletics, intellect, willpower, pilot, craft — invent others only if the story clearly needs them).',
        'Include the player character and every named character likely to oppose or be tested. 2-5 domains per actor is plenty. Rate from evidence in the transcript; when unsure, prefer 4-6.',
    ].join('\n');

    async function seedSheet() {
        const c = ctx();
        const meta = getMeta();
        if (!meta) { toast('warning', 'No chat open.'); return; }
        const chat = c.chat || [];
        if (!chat.length) { toast('warning', 'Chat is empty.'); return; }

        toast('info', 'Reading the story and building the sheet…', 'Arbiter seed');
        const parts = [];
        let chars = 0;
        for (let i = chat.length - 1; i >= 0 && chars < 7000; i--) {
            const m = chat[i];
            if (!m || !m.mes || m.is_system) continue;
            const line = (m.name || (m.is_user ? 'Player' : 'AI')) + ': ' + String(m.mes).replace(/\s+/g, ' ').slice(0, 400);
            chars += line.length;
            parts.push(line);
        }
        const existing = JSON.stringify(meta.sheet || { actors: {} });
        const userPrompt = '<existing_sheet>\n' + existing + '\n</existing_sheet>\n\n<transcript>\n' +
            parts.reverse().join('\n') + '\n</transcript>';

        const out = await callLLM(SEED_SYSTEM, userPrompt, 800, 45000);
        const obj = extractJson(out);
        if (!obj || typeof obj.actors !== 'object' || obj.actors === null) {
            toast('error', 'Seeding failed — model returned no valid sheet.');
            return;
        }
        let added = 0;
        for (const [name, entry] of Object.entries(obj.actors)) {
            if (!name.trim() || !entry || typeof entry !== 'object') continue;
            const clean = { default: clamp(entry.default ?? 5, 0, 10), domains: {} };
            for (const [d, v] of Object.entries(entry.domains || {})) {
                const dk = String(d).toLowerCase().trim();
                if (dk) clean.domains[dk] = clamp(v, 0, 10);
            }
            meta.sheet.actors[name.trim()] = clean;
            added++;
        }
        saveMeta();
        renderSheet();
        toast('success', 'Sheet updated: ' + added + ' actor(s).', 'Arbiter seed');
    }

    /* ------------------------------------------------------------------ */
    /* Settings UI                                                         */
    /* ------------------------------------------------------------------ */

    function settingsHtml() {
        return `
<div id="arb_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Arbiter</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="arb_row">
        <label class="checkbox_label"><input id="arb_enabled" type="checkbox"><span>Enabled</span></label>
        <label class="checkbox_label"><input id="arb_toast" type="checkbox"><span>Toast results</span></label>
        <label class="checkbox_label"><input id="arb_showmath" type="checkbox"><span>Show math in toast</span></label>
        <label class="checkbox_label"><input id="arb_debug" type="checkbox"><span>Debug log</span></label>
      </div>

      <div class="arb_row">
        <label>Adjudicator profile</label>
        <select id="arb_profile" class="text_pole"></select>
        <div id="arb_profile_refresh" class="menu_button fa-solid fa-rotate" title="Refresh profiles"></div>
      </div>
      <div class="arb_hint">Point this at a fast, non-thinking endpoint. Empty = raw call on the current API (slow if your main model thinks).</div>

      <div class="arb_row">
        <label>Timeout (ms)</label><input id="arb_timeout" type="number" min="1500" max="60000" step="500" class="text_pole arb_num">
        <label>Context msgs</label><input id="arb_ctx" type="number" min="1" max="10" class="text_pole arb_num">
      </div>
      <div class="arb_row">
        <label>Gate sensitivity</label>
        <select id="arb_sens" class="text_pole">
          <option value="conservative">conservative</option>
          <option value="normal">normal</option>
          <option value="aggressive">aggressive</option>
        </select>
        <label>Default rating</label><input id="arb_defrating" type="number" min="0" max="10" class="text_pole arb_num">
      </div>
      <div class="arb_row">
        <label>Inject depth</label><input id="arb_depth" type="number" min="0" max="99" class="text_pole arb_num">
        <label>Inject role</label>
        <select id="arb_role" class="text_pole">
          <option value="system">system</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
        </select>
      </div>
      <div class="arb_row">
        <label>Force tag</label><input id="arb_forcetag" type="text" class="text_pole arb_num">
        <label>Skip tag</label><input id="arb_skiptag" type="text" class="text_pole arb_num">
      </div>

      <div class="arb_buttons">
        <div id="arb_btn_force" class="menu_button">Force next</div>
        <div id="arb_btn_skip" class="menu_button">Skip next</div>
        <div id="arb_btn_seed" class="menu_button">Seed sheet from story</div>
      </div>

      <hr>
      <b>Capability sheet (per chat)</b>
      <div class="arb_hint">JSON: {"actors": {"Name": {"default": 6, "domains": {"melee": 7}}}}. Ratings 0-10. Unknown actors use the default rating.</div>
      <textarea id="arb_sheet" rows="7"></textarea>
      <div class="arb_buttons">
        <div id="arb_sheet_save" class="menu_button">Save sheet</div>
        <div id="arb_sheet_reload" class="menu_button">Reload</div>
      </div>

      <hr>
      <b>Verb gate list</b> <span class="arb_hint">(comma-separated; word-boundary matched with s/es/ed/ing)</span>
      <textarea id="arb_verbs" rows="3"></textarea>

      <hr>
      <b>Recent adjudications</b>
      <div id="arb_log" class="arb_log"></div>
      <div class="arb_buttons"><div id="arb_log_clear" class="menu_button">Clear log</div></div>
    </div>
  </div>
</div>`;
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
    }

    function renderSheet() {
        const meta = getMeta();
        const el = $('#arb_sheet');
        if (!el.length) return;
        el.val(meta ? JSON.stringify(meta.sheet, null, 2) : '{}');
    }

    function renderLog() {
        const meta = getMeta();
        const el = $('#arb_log');
        if (!el.length) return;
        if (!meta || !meta.log.length) { el.html('<i>No adjudications yet.</i>'); return; }
        const rows = meta.log.map(l => {
            const t = TIERS[l.tier] || { name: l.tier };
            return '<div class="arb_log_entry"><span class="arb_badge arb_t_' + escHtml(l.tier) + '">' +
                escHtml(t.name) + '</span>' + escHtml(l.actor + ': ' + l.action) +
                '<br><small>' + escHtml(l.domain + ' vs ' + l.opp + ' · ' + mathLine(l)) +
                (l.why ? ' · ' + escHtml(l.why) : '') + '</small></div>';
        });
        el.html(rows.join(''));
    }

    function bindUI() {
        const s = getSettings();

        $('#arb_enabled').prop('checked', !!s.enabled).on('change', function () { s.enabled = this.checked; saveSettings(); });
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

        $('#arb_profile').on('change', function () { s.profileId = this.value; saveSettings(); });
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
        if (et.GENERATION_ENDED) es.on(et.GENERATION_ENDED, () => clearInjection());
        if (et.GENERATION_STOPPED) es.on(et.GENERATION_STOPPED, () => clearInjection());
        if (et.CHAT_CHANGED) es.on(et.CHAT_CHANGED, () => {
            clearInjection();
            renderSheet();
            renderLog();
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
