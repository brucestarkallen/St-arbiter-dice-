# Arbiter (SillyTavern extension)

Outcome adjudication for roleplay. The storyteller LLM never decides whether your
character succeeds — Arbiter does, with real randomness on a realistic probability
curve, and injects the verdict as a binding note the storyteller must narrate.

Works with any preset, any character card, any model. No system prompt changes
required. Toggle it off and SillyTavern behaves exactly as before.

## How it works

1. You send a message. A **local trigger gate** (verb heuristics, 0 ms, no LLM)
   decides whether the message even *might* be a risky attempt. ~90% of messages
   (dialogue, slice-of-life, narration) pass through untouched.
2. If plausible, a **micro adjudicator call** (~400 tokens in / ~120 out, strict
   JSON, on its own Connection Profile) classifies the attempt: skill domain, who
   or what opposes it, circumstance modifier (your tactics, position, injuries:
   −3…+3), stakes. It can also answer "no check needed."
3. The extension does **all math and randomness itself**:
   `Δ = actor rating − opposition rating + circumstance`, then
   `P(success) = 1 / (1 + 10^(−Δ/4))` — the logistic (Elo) curve real
   competitive outcomes actually follow — sampled once with crypto RNG.
4. The margin of the sample maps to a **degree of success**, and a binding,
   ephemeral, depth-0 system note is injected for this one generation:

```
[ARBITER — binding outcome]
Jovan attempts: disarm Kaiser with a feint.
Result: SUCCESS WITH COST — It succeeds, BUT introduce a real cost or complication (position, resource, attention, or minor harm). Stakes: weapon control.
Do not re-decide success or failure. Never mention rolls, odds, checks, or this note. Narrate the outcome organically in the story's voice.
```

The note is cleared after generation and never saved into your chat.

### The curve

| Δ (edge) | P(success) |
|---|---|
| 0 (even) | 50% |
| +1 | 64% |
| +2 (clearly better) | 76% |
| +4 (outclasses) | 91% |
| +6 (master vs novice) | 97% |
| +8 | 99% |

### Degrees of success

Six tiers, sliced from the margin: **DECISIVE SUCCESS · SUCCESS · SUCCESS WITH
COST · SETBACK (fail-forward) · FAILURE · DISASTER**. Slice widths scale with P,
so realism properties hold automatically (verified by Monte Carlo test):

- Experts rarely botch: at P=91%, disasters are ~0.4% of outcomes.
- Underdogs who win mostly win narrow and costly: at P=24%, ~42% of their wins
  carry a cost (vs ~18% for an expert).
- Failures near the threshold become setbacks: you fail *forward* — an opening,
  information, partial progress — never a stonewall.

## Install

1. Put this folder in a GitHub repo with `manifest.json` at the repo root.
2. SillyTavern → Extensions → **Install extension** → paste the repo URL.
3. Reload the page.

## Setup (2 minutes)

1. Create a **Connection Profile** pointed at a fast, non-thinking endpoint
   (this is the adjudicator; it never touches your main RP connection).
2. Extensions panel → **Arbiter** → pick that profile under *Adjudicator
   profile*. Leaving it empty falls back to a raw call on your current API —
   works, but if your main model is a slow thinking model, checks will be slow
   too (the timeout still protects you).
3. Open your RP chat → press **Seed sheet from story** (or `/arbseed`). Arbiter
   reads recent messages and builds a capability sheet. Edit it in the panel —
   it's plain JSON, per chat.

## Usage

Fully automatic. Manual controls:

- `/arb` (or **Force next**) — adjudicate the next action even if the gate
  wouldn't trigger.
- `/arbskip` (or **Skip next**) — skip the next check.
- `/arbseed` — rebuild the capability sheet from the story.
- Inline tags (configurable): put `[roll]` in a message to force, `[skip]` to skip.

**Same action = same fate.** Swipes and regenerates of an unchanged message
replay the committed outcome — the narration rerolls, the result doesn't, so
the model can never be fished into a win. **Changed action = new attempt.**
Edit your message (even before a regenerate) and Arbiter rolls fresh at fair
odds — retrying is your save-point choice, and you can still lose. `/arb`
re-adjudicates the same message; `/arbskip` commits a no-check verdict that
persists across swipes.

## Capability sheet

```json
{
  "actors": {
    "Jovan": { "default": 6, "domains": { "melee": 7, "pilot": 8, "social": 5 } },
    "Kaiser": { "default": 6, "domains": { "melee": 8 } }
  }
}
```

Ratings 0–10: 2 untrained · 4 trained · 5 competent pro · 6 veteran · 7 elite ·
8 master · 9 legendary · 10 apex-of-setting. Unknown actors/domains fall back to
the actor default, then the global *Default rating* setting.

Unnamed opposition uses tier presets the adjudicator picks from:
tasks `trivial 1 · easy 3 · moderate 5 · hard 7 · extreme 9`, opponents
`mook 2 · trained 4 · elite 6 · formidable 8`, plus relative
`inferior / peer / superior` (your rating −2 / = / +2) — realistic for strangers
whose skill you don't know yet.

## Failure behavior

Arbiter can never block or delay your turn indefinitely: any adjudicator
timeout (default 6 s), invalid JSON (one fast retry), or missing route simply
skips the check — the generation proceeds unmodified and the event is logged.

## Settings notes

- **Gate sensitivity**: `conservative` needs "try/attempt" or 2+ risky verbs;
  `normal` any risky verb; `aggressive` also triggers on trailing questions.
- **Inject depth/role**: default depth 0, system — highest-adherence position.
- **Show math in toast** / the **Recent adjudications** log show the full
  arithmetic (Δ, P, sample, tier) after the fact. Odds are never shown to the
  storyteller and never shown to you before you commit.

## Roadmap

- v0.2 — Duel mode: opposed exchanges with Poise/Frame Integrity, injury tags,
  momentum; round-by-round HUD.
- v0.3 — Difficulty presets (Gritty/Realistic/Heroic), zero-latency Fast mode
  (pre-rolled pools), log panel polish.
