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
3. Open your RP chat and just play. **Auto seed** (on by default) builds the
   capability sheet by itself after a few messages — reading the transcript
   **and your memory extensions' injections** (snippets, notepads, Author's
   Note) — then quietly refreshes every N turns (default 50) to learn new
   faces and growth, never overwriting ratings you hand-edited. World Threads
   auto-seed too when the Event engine is on. `/arbseed` and `/arbthreads`
   remain as manual force-updates only. Edit it in the panel —
   it's plain JSON, per chat.

## Usage

Fully automatic. Manual controls:

- `/arb` (or **Force next**) — adjudicate the next action even if the gate
  wouldn't trigger.
- `/arbskip` (or **Skip next**) — skip the next check.
- `/arbseed` — rebuild the capability sheet from the story.
- `/duel <opponent>` / `/duelend` — open or close a duel manually.
- `/battle allies | enemies` / `/battleend` — open or close a group battle.
- `/arbthreads` — seed World Threads (background currents) from the story.
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

## Duel mode (v0.2)

Fights are sequences, not single rolls. A duel opens automatically when the
referee sees combat clearly begin (**Auto duel**), or manually via
`/duel <opponent>` / the panel buttons. Each of your turns is one **exchange**:
the referee scores your stated tactic into circumstance, one curve sample
resolves it, and the margin drives a tracked state machine —

- **Poise** — each side's pool (default 5; a `"poise"` key per actor in the
  sheet overrides it, e.g. 7–8 for mecha Frames). Exchange margins deal 0.5–2
  poise damage; poise 0 = beaten.
- **Injuries** — DECISIVE/DISASTER exchanges inflict a lasting injury: a
  persistent −1 to that side's effective rating, and the prose is instructed to
  name it.
- **Momentum** — the exchange winner carries +0.5 (capped at +1); the loser's
  resets. Fights snowball, comebacks stay possible.
- **Fail-forward** — a SETBACK loses the exchange but grants a real +1 opening
  next round, and the prose is told to show it.
- **The end is mechanical** — when a side hits 0, the storyteller is told who
  won and narrates the resolution the fiction demands (yield/KO/disarm/kill);
  it never chooses the winner.

During a duel the verb gate is bypassed (every turn goes to the referee — a
passive turn is an exchange at negative circumstance, because the opponent
presses regardless; `exchange:false` is reserved for genuine lulls). The
referee can also close the duel when the fiction clearly ends it (fled,
yielded, separated), or use `/duelend`. Editing your move and re-rolling
rewinds the duel state to before that exchange first, so damage never
double-applies. A floating **HUD** shows round, poise bars, momentum ▲ and
injuries ✚ while a duel runs (✕ ends it).

## Presets & Fast mode (v0.2)

**Preset** shifts the whole feel: `gritty` (harsher tails, costlier wins),
`realistic` (the neutral curve, default), `heroic` (+1 player edge, halved
disasters). **Mode: fast** trades accuracy for zero added latency: no referee
call at all — a pre-rolled three-row outcome pool (advantaged / even /
disadvantaged) is injected and the storyteller picks the footing. Honest
caveat: that hands footing discretion back to the model, so adjudicated mode
stays the default; fast also works inside duels (circumstance 0).

## Battles & commander mode (v0.3)

Group fights get the same treatment as duels, scaled up. A **battle** is two
rosters — you plus named allies vs enemies (`x3` clones a unit) — opened
automatically when the referee sees group combat begin (**Auto battle**), or
via `/battle Stella, Alexia | Bandit x3, Ogre` / the panel. Each of your turns
is one round:

- Your move is scored as a **fight** (personal exchange vs a chosen enemy) or
  a **command** (directing the whole side — a tactics roll whose tier buffs or
  debuffs every allied pairing this round). Locker-room scrap or battlefield
  general: same machinery, different move kind.
- **Everyone else auto-resolves**: standing allies pair against standing
  enemies by rating, the outnumbering side supports its pairs (+1), and each
  pairing rolls the same curve — all local RNG, zero extra LLM cost, so a 4v5
  round costs exactly one referee call.
- **Morale is emergent**: the side-strength gap shifts every pairing by up to
  ±1, so routs snowball and last stands are steep but real.
- Beaten means out of the fight (down/disarmed/routed as fiction demands),
  not dead — the prose decides the flavor, never the fact. If **you** go
  down, the field auto-resolves fairly and the directive narrates the
  aftermath: your side can still carry the day and drag you clear.
- The HUD shows side bars, standing counts, and your own poise chip.

## Three-tier event engines & World Threads (v0.4)

The event engine is now the full NE-P design, exact numbers: **Surprise**
d100 vs DC 95 (−3 per quiet turn, ambient color), **Encounter** d200 vs 198
(−2, real hooks the player can engage or ignore), **World** d500 vs 498 (−2,
seismic who/what/where shifts that land as news first). Pity-timer RNG: the
longer nothing happens, the likelier something fires; each tier resets on
firing; nothing fires during fights; at most ONE background hint injects per
turn (priority: thread completion > tangle > world > encounter > thread
progress > surprise), and the same beat replays across swipes.

**World Threads** are the background NPC/world sim, ported as dice rather
than data: off-screen storylines (a rival's training, an investigation
closing in, a faction's move) as 5-12 rung ladders that advance via
heartbeat rolls on your quiet turns — bias tilts the odds, pace sets turns
between beats, DECISIVE heartbeats jump two rungs, DISASTER ones regress.
Two threads advancing at once **tangle**: an opposed roll, the winner gains
a rung at the loser's expense, and the friction is surfaced. Progress
injects escalating hints (rumor → visible development → unmistakable); a
completed ladder "comes to a head" and must enter the open. Seed threads
from the story + your memory extensions (`/arbthreads` or the panel button),
or write the JSON by hand. Edited resends rewind background ticks along with
everything else — world momentum never double-applies.

Deliberate boundary: Arbiter owns the **dice** of the background world.
Character *state* (personalities, relationships, who knows what) belongs to
your character-ledger tooling — one source of truth each.

## Scale: skirmish vs war (v0.9.1)

Three tiers, matched to what each system models well:
- **Duel** — one-on-one. Opens on any attack against a named person.
- **Battle** — skirmish-scale group combat (a handful per side): you attack
  multiple foes, or command a party. Opens on multi-target attacks ("sweep
  through the guards") and spawns a generic squad if the enemies are unnamed.
  Everyone auto-resolves each round; the HUD shows aggregate side strength.
- **War (commander mode, v0.10)** — when YOU command armies (Code Geass
  style: "order Zero Squadron to flank their right"), a war engagement opens
  with FORMATIONS as units: each has a quality rating and a strength pool
  (default 10; rate formations in the sheet like characters — "3rd Cavalry":
  {"default": 7, "poise": 12}). Every turn is one order, scored for tactical
  soundness and resolved on the same curve with your commander tactics as a
  capped edge (skill matters every round, never dwarfs unit quality):
  · **Maneuver** — "X flanks B": the ordered formation's clash is the focal
    roll; the rest of the line auto-resolves; broken formations rout.
  · **Stratagem** — "burn the woods", "feign retreat": a commander roll that
    creates a persistent battlefield condition shifting every clash — and on
    a DISASTER it **backfires** (the wind turns; the ruse is seen through),
    now favoring the enemy. Up to 3 conditions stack, shown as ⚑ on the HUD.
  · **Personal** — the commander sorties into the fight; if you fall, command
    collapses and the day is lost.
  The engagement ends when a line shatters (all formations broken, or a side
  under 25% strength loses the focal clash — the rout). You can genuinely
  LOSE a war you commanded badly.
- **Mass combat you do NOT command** (a soldier in the melee) still routes to
  a **World Thread**: your personal action resolves, the war develops as a
  background current — one stroke doesn't decide it.

## Recovery: poise can go up (v0.11.1)

Fighters can heal mid-duel. When the referee reads a move as a **recover**
action — self-healing magic, a water/life node, catching breath, a defensive
reset — poise is RESTORED (capped at the starting pool) instead of spent. It's
balanced so it can't make fights unlosable: recovering cedes the exchange, so
the opponent presses freely, gains momentum, and takes the opening you gave
up. You trade tempo for staying power. Recovery can't backfire into damage,
but under heavy pressure it barely helps. This matches settings where healing
is canon (life-domains, regeneration) without turning combat into a stalemate
of mutual topping-off.

## Ties: trades & stalemates (v0.11)

Real fights aren't always decisive, so exchanges can now tie. When a clash
lands genuinely even (the roll sits near the win/lose boundary), it becomes a
**TRADE** — both fighters land, both lose poise, nobody gains the upper hand —
or a **STALEMATE** — neither lands cleanly, a tense reset with no advantage.
Extremes (decisive/disaster) never tie. A duel can even end in a DRAW if a
trade drops both fighters at once. Tune frequency with the **Tie window**
under Outcome feel (0 disables; 0.06 default; higher = more ties); it affects
only fighting exchanges, never single checks.

## Gear & mental strain (v0.13)

Two real-life dimensions beyond raw skill and body:

**Gear** — a signature weapon, armor, or tool is a persistent modifier tied to
ONE domain: a masterwork blade gives +2 to melee in every fight (not to
stealth), an enchanted bow +2 to ranged. Established when the fiction gives it
("you claim the legendary sword Frostfang"), removed when lost or broken, and
flagged as gear so healing never strips it. General afflictions (curse,
exhaustion) still apply to everything; gear applies only to its domain.

**Composure** — a mental-strain track modeling real stress psychology. It runs
from steady to shattered and erodes when the player faces horror, terror,
gruesome death, or dread; it recovers with safety and rest. Mild strain is
harmless (people function while nervous), but as it deepens past halfway it
penalizes actions requiring focus and steady nerves — a terrified character
fights and thinks worse — without ever being a "you go insane" game-over. The
referee reads the fiction's emotional weight each turn; toggle it off, or set
the pool size, in settings. Perfect for Delta Green / Call of Cthulhu-style
horror where fear is as dangerous as any blade.

## Any creature, any scale (v0.12.2)

Ratings aren't human-only. The referee rates ANY combatant — person, dragon,
alien, war-machine, monster — by its effective threat, not its species (a
feral dog 3, a dire beast 7, an ancient dragon 9-10; a beast's "melee" means
its claws and breath). And because a dragon isn't just a "legendary human,"
there's a separate **scale mismatch**: when combatants are categorically
mismatched in size or power, the referee applies a large swing on top of
ratings, so charging a dragon head-on as a normal human is near-hopeless
(but never truly impossible) — while an equalizer in the fiction (a
dragon-slaying spear, an exposed weak point, a mech of your own) shrinks the
gap back to a real fight. Same-scale fights (human vs human, dragon vs dragon)
ignore it and turn on skill alone. Works in both directions: when YOU are the
vast one, crushing something tiny is near-certain.

## Injuries & handicaps (v0.12.1)

Two layers of harm. WITHIN a fight, wounds already work — a DECISIVE/DISASTER
exchange inflicts an injury that subtracts from the fighter's effective rating
for the rest of that duel (the ✚ on the HUD). ACROSS scenes, characters can
now carry PERSISTENT conditions — a broken arm, a curse, poison, exhaustion,
blindness — stored on the sheet as conditions with a modifier that lowers
their effective rating in every future check until it's healed. The referee
records a lasting condition the moment the fiction establishes one and clears
it when the story heals it; you can also set or clear any handicap directly
with `/condition Name | broken arm | -2` (or `/condition Name | -remove |
broken arm`). Conditions are visible and editable in the sheet, floor a rating
at 0, and stack up to a capped total so no one is dragged infinitely negative.

## Growth-aware updates (v0.12)

The sheet now tracks power growth. No manual setup is needed to start — the
first auto-seed fires after your 2nd message and builds the cast itself. On
each refresh (every N turns, default 50), ratings Arbiter generated are RAISED
as the story shows characters training, leveling, or unlocking power (a foe
who was trained-4 and became elite is re-rated 7) — but never lowered, so a
temporary setback doesn't nerf anyone. Crucially, any rating YOU type into the
sheet by hand is LOCKED: growth refreshes never touch it, in either direction.
The panel shows a clean sheet without internal flags, so editing and saving
always yields a locked, authoritative entry. Priority: your hand-edit >
considered/grown auto rating > persisted estimate > fresh estimate > fallback.

## Estimate persistence (v0.11.3)

Round-1 estimates don't just vanish. When a duel ends against an
estimated-but-unrated opponent, their rating is saved to the sheet as a
baseline (flagged internally as estimated) so the same foe fights at a stable
number next time instead of being re-guessed from scratch — this matters when
auto-seed is off. A later considered seed still overwrites that estimated
baseline with a proper rating, and any rating YOU edit by hand is never
touched. Priority is always: your hand-edit > considered seed > persisted
estimate > fresh estimate > trained fallback.

## Round-1 opponent estimate (v0.11.2)

No more under-rated opening exchange. When a duel opens against someone not on
the sheet, the referee — in the SAME call that opens the duel, so no extra
latency — estimates their rating from the scene and any description in
context: a "legendary warlord who never lost" opens at 9, a "trembling
farmhand" at 2, instead of the flat trained-4. Round 1 is now a fair fight
immediately. A real sheet entry always overrides the estimate, and the
background seed still refines the number for round 2+ with a considered rating.

## Empty sheet at fight time (v0.11)

The first auto-seed now fires after just 2 messages (was 4), and if a duel
opens against someone not yet rated, a background seed kicks off immediately
so the following rounds use scene-derived stats instead of the flat default.
Combat never blocks on it — the opening exchange uses the default, subsequent
ones sharpen as the seed lands.

## Combat HUD (v0.9)

Duels and battles show a floating HUD with two combatant cells: a colored
initial disc, name, live glyphs (▲ momentum, ✚ injuries, ◹ opening), a
tabular poise readout, and a gradient bar that shifts green → amber → red
with health and pulses when a side is nearly broken. A gold round badge
counts exchanges; victory shows a glowing banner. Battles show aggregate
side strength with standing counts (3/3 vs 2/4) plus your own poise chip.
Bars animate smoothly between rounds. Any attack on a named person now opens
a duel — even a quick or lopsided one — so you always get the bars when
steel (or ice) crosses.

## Activity indicator (v0.8)

Whenever Arbiter is doing background work — seeding the sheet, building
threads, or resolving a check/exchange — a small floating pill appears
(bottom-right) with a spinner, the current task, elapsed seconds, and a ✕ to
cancel. Cancel aborts the in-flight model call and the operation backs out
cleanly (no partial writes). Toggle it off under Combat → Activity bar. So
you always know whether a seed or check is running vs. stalled.

## Panel layout (v0.7)

The settings drawer is grouped into collapsible sections — **Core** (switch,
profile, timeout, gate, auto-seed), **Outcome feel** (mode, preset),
**Combat**, **Background world** (engines, encounter table, threads),
**Data & tools** (seeds, memory sources, resets, sheet), **Advanced**
(injection, tags, verbs), and the **log** — with a live status bar on top
showing at a glance: active/disabled, which adjudicator profile is wired
(amber warning when falling back to the raw API), mode · preset, and this
chat's actor/thread counts.

## Tests

`tests/` contains nine suites covering every invariant: the probability
curve, tier slicing per preset, exchange effects, full battles to
conclusion, snapshot rewinds, event tiers, thread ladders, memory-collector
coverage, and gate behavior. Run them with Node (no dependencies):
`sh tests/run_all.sh`. Any future change should keep them green.

## Reset & inspection

**Reset settings** restores every knob to factory defaults (asks first).
**Reset chat data** wipes the current chat's sheet, threads, log, fights and
caches — auto-seed rebuilds the sheet on its own (asks first). **Memory
sources** shows exactly which memory injections the seeder reads right now
(Summaryception snippets and recall, the character ledger, notepads, and the
Author's Note), so coverage is verifiable, not assumed.

## Thinking models

The adjudicator profile works with thinking models — the JSON parser scans
past reasoning (even reasoning containing braces) to find the real object —
but per-turn checks on a thinking endpoint will regularly outlive the 6 s
timeout and silently skip, which defeats the purpose. Recommended: a fast
non-thinking model for the adjudicator profile; your MAIN storyteller can be
as think-y as you like (Arbiter never touches that connection), and seeding
calls (45 s budget) tolerate thinking models fine. If you insist on a
thinking adjudicator, raise the timeout to 30-60 s and accept the wait.

## Roadmap

- v0.4 — per-domain duel tactics (switching domains mid-fight), richer injury
  vocabulary, configurable event tables.
