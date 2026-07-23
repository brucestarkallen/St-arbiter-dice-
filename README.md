# Arbiter — Fight and Battle

A dice-driven **outcome referee** for SillyTavern roleplay. Your storyteller LLM
never gets to decide whether you succeed — Arbiter does, with real randomness on a
realistic probability curve, and hands the storyteller a binding verdict to narrate.
The point is simple: **your character can genuinely lose.** Arbiter never flatters
the player.

Everything is invisible and automatic. Works with any preset, any character card,
any model — no system-prompt changes. Toggle it off and SillyTavern behaves exactly
as before.

## What it does

- **Adjudicates any uncertain action** — a leap, a lie, a lockpick, a secret power —
  on a logistic (Elo-style) probability curve sampled with crypto RNG, resolved into
  six degrees of success from DECISIVE down to DISASTER (with fail-forward setbacks
  in between, so a miss opens a door rather than stonewalling).
- **Runs real fights at every scale**, escalating automatically from the fiction —
  in your choice of two styles: **tracked** (poise, injuries, and a called
  winner) or **outcome-only** (every exchange gets its verdict, but no health
  is kept and the engine never ends the fight — the storyteller does):
  - **Duels** — detailed one-on-one combat with poise, momentum, exploitable
    openings, multi-strike combos, and disengage-to-recover.
  - **Battles** — skirmish-scale group combat; you fight and/or command while the
    rest of the field resolves around you, with morale and rout.
  - **War** — army-scale combat you command: formations, stratagems, commander
    sorties, persistent battlefield conditions, and collapse.
- **Tracks lasting state** — persistent injuries and gear (a broken arm, a
  masterwork blade), plus **composure**: fear, horror, and trauma erode focus and
  can break a fighter's nerve — on the enemy as much as on you.
- **Keeps the world alive between the action** — an ambient pity-timer event engine
  and background "world threads" surface complications, encounters, and shifts in
  the wider setting, tone-guarded so they never force combat or derail your move.
- **Builds its own capability sheet** by reading your story and memory as you play —
  no manual stat entry — and calibrates ratings to the setting's *own* power
  hierarchy (a top-ranked "student" is rated elite, not average).
- **Survives your editing habits** — every resolved turn is a save-state. Swipes
  replay the committed fate, edits re-roll from the exact pre-turn world, and
  **deleting a few exchanges (or branching the chat) automatically rewinds**
  fights, composure, and the background world to the surviving timeline.

Under the hood it's rigorously fair: exchange damage is exactly symmetric (no hidden
tilt toward the player), the referee only ever sees a neutral prompt (never your
persona or the card's "unbeatable protagonist" framing), and the injected verdict is
purely qualitative — it never leaks a die, a probability, or a stat to the
storyteller. The whole engine is covered by 54 regression suites that freeze those
fairness, stability, and no-spoiler guarantees; see the audit notes further down.

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
- `/mcname <name>` — set your character's **story name** when it differs from
  your persona label (persona "LO" playing "Jovan Oda"); `/mcname clear` resets.
  Usually unnecessary — seeding auto-detects it (see *Player identity* below).
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

Inside a **fast-mode duel** the real duel maths still run — ratings, injuries,
momentum, openings, **scale mismatch, and composure all feed the delta** (they
are read off the fight state, not classified per turn). Since v0.15.1 fast mode
also handles **recovery**: a local, conservative detector (`looksLikeRecovery`)
spots an explicit disengage-to-heal (fall back, catch your breath, drink a
potion, bandage a wound, steady yourself) and routes it through the recovery
path — regain poise, cede tempo, eat the counter — instead of misreading it as
an attack. It is deliberately precision-biased: if the move also strikes the
foe it stays an attack, and an unrecognised phrasing simply resolves as an
attack (never a regression). Two things fast mode still *cannot* do, by nature
of having no LLM in the loop: read **new** conditions out of the prose (a
broken arm narrated this turn won't auto-apply — set it with `/condition`;
existing conditions are always honoured), and weigh **per-move circumstance**
(position, tool, terrain), which is fixed at 0. Use adjudicated mode when those
matter.

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

## Smarter seeding: event-driven, optional 2nd connection (v0.15)

The old fixed "every N turns" seed timer was dumb — it re-read the cast on an
arbitrary schedule disconnected from when characters actually change. Replaced
with event-driven seeding:

- **Post-fight is the primary trigger.** A duel or battle ending is exactly
  when combatants changed — wounded, revealed power, leveled, broke — so the
  sheet re-seeds right after a fight resolves, capturing all of it at the
  moment it matters instead of waiting for a counter.
- **First-appearance seeding** still fires when a fight opens against someone
  not yet rated (they get a live estimate immediately, refined by the seed).
- **The turn timer is now just a slow fallback** (default 100, up from 50) — a
  backstop so a long fightless stretch of pure dialogue-growth still refreshes
  eventually. It is no longer the main mechanism.
- **Optional separate seeding connection.** You can now point seeding at its own
  Connection Manager profile — a cheap, high-context model for the bulk
  background job — so building the sheet never competes with your fast live
  adjudicator. Empty = use the adjudicator profile as before.

## Anti-sycophancy audit (v0.14.1)

A deep fairness pass fixed real biases and proved the system cannot flatter
the player:

- **Symmetric fail-forward.** The player's near-miss "opening" (+1 next round)
  was being granted and used, but the opponent's was a dead variable — the MC
  quietly accrued openings the foe never could. Now the opponent earns and
  spends openings on the same terms.
- **Recovery is no longer a free heal.** Disengaging to recover now lets a
  pressing opponent land a real blow scaled to their threat — a low-poise
  fighter can be *killed* trying to catch their breath under fire. Verified:
  30/30 recoveries under a strong foe took a counter-hit, most were fatal.
- **Two-sided circumstance.** The referee is now told, explicitly, to weigh the
  opponent's position and skill against the player, not just grade the player's
  cleverness upward — a good move into a worse position still nets negative.

Proven by test: the curve is a perfect coin-flip at even odds (49.9/50.1 over
20k rolls, zero bonus in the realistic preset); a weak MC vs a master lost 40
of 40 duels. The MC genuinely loses at bad odds, and nothing anywhere tilts an
even fight toward the protagonist.

## Composure is universal too (v0.14)

Corrected: mental strain is NOT player-only — this is a simulation, and the
world's minds break like yours. A duel opponent now carries their own
composure pool that erodes when the player frightens, awes, or demoralizes
them (a horrifying display, a revealed power, an ally falling) and steadies
when they rally. A foe whose nerve breaks fights measurably worse — their
frayed composure penalizes them just as yours penalizes you — and the HUD
status describes them as rattled or breaking so you see it in the prose. The
referee reads fear on BOTH sides each exchange (opp_composure / self_composure).
So revealing your true power can rout a lesser enemy before a blow lands, and a
terrifying monster can unnerve you in the same fight. (Ambient, non-combatant
crowds are still narrated rather than individually simulated — but anyone you
actually fight has a real, breakable nerve.)

## The timeline is a save file — delete, edit, branch freely (v0.30)

Every resolved player turn now commits to a bounded **timeline history** (last 12
turns): the binding directive, the ambient event, and a snapshot of the world taken
*before* that turn ran. Each generation, Arbiter verifies its committed turns still
exist in the chat:

- **Swipe / regenerate the last message** → the committed fate replays verbatim.
  Re-rolling prose never re-rolls dice.
- **Edit a message** → that turn is void; the world rewinds to the moment before it
  and the edited action gets one fresh, fair roll.
- **Delete the last few exchanges** (the classic "let me redo this scene") → the
  vanished turns are pruned and the fight, your composure, the tick counters, and
  the world threads all rewind to the surviving timeline. Regenerating an older
  message replays *its* committed fate against the state it was actually rolled in.
- **Branch a chat** from an earlier point → the copied metadata self-corrects the
  same way on the first generation.

An **anchor rule** keeps this safe: pruning only happens when at least one committed
turn is *provably still present* in the chat — a truncated or unrecognizable view
can never wipe a live fight. Ending a fight by hand (HUD ✕) also clears the
timeline, so a dismissed fight can't be resurrected by a rewind. The sheet is
deliberately *not* rewound: ratings and conditions are cross-timeline facts, and
condition adds are name-deduped so replays stay idempotent.

Also in v0.30:

- **Persistent conditions land mid-fight now.** The referee can establish or
  resolve a lasting condition *during* duels, battles, and wars (a shattered sword
  arm, poison taking hold, a disarm, seized gear) — previously that channel only
  existed for standalone checks. The condition hits the **live** fight's math the
  same turn, not just future encounters.
- **Estimated combatants keep their measure.** A condition landing on an unlisted
  foe used to create its sheet entry at the default rating (your estimated
  rating-9 dragon reborn as a 5). The entry now seeds from the live fight's rating.
- **One fight at a time.** Starting a duel ends any battle and vice versa — no more
  split-brain where the HUD showed one fight and the interceptor served another.
- **A transient empty referee response retries once** instead of silently dropping
  the check.

## Armies can genuinely lose — war fairness fix (v0.28)

A deep fairness audit of mass combat found that duels, party battles, and the
event/thread engine were sound, but **army-scale war had a real "the player
always wins" flaw**. Winning a stratagem planted a *persistent* battlefield
condition in your favor, but losing one (short of an outright disaster) planted
nothing — so any use of stratagems ratcheted the whole war toward you. At equal
strength with neutral command, the player's army was winning ~95%+ of the time,
and still won when outnumbered two-to-one.

Battlefield conditions are now **symmetric**: a botched stratagem hands the enemy
the same kind of standing advantage a good one hands you (DECISIVE/DISASTER ±2,
SUCCESS/FAILURE ±1, SUCCESS_COST/SETBACK ±1), so a break-even stratagem record
nets zero. After the fix, an evenly-matched war with neutral command is genuinely
losable (~37% win), skilled command wins far more (~85% at a clear tactical
edge), blundering loses badly (~4%), and being outnumbered or outmatched drags
you down as it should. The player can lose — which is the whole point.

Party battles were already fair once you account for the player being an extra
combatant (an evenly-matched party fight is very much losable), so no change was
needed there. The world/thread engine was verified too: it stays gated out of
combat, its background beats never leak dice or mechanical values, every
disruptive beat carries a "fit the tone, no forced combat, engage or ignore"
guard, and threads reliably advance to resolution — an alive world, not a spammy
or intrusive one.

Also fixed: the same whole-word name matching now guards the **ally rosters** in
battles and wars, so an ally who merely shares your surname (a sibling fighting
at your side) is no longer mistaken for you and dropped from your own force.



The out-of-the-box defaults are tuned for accuracy over cost, so the referee is as
smart as possible with no setup: it now reads your **full memory stack**
(Summaryception, ledger, notepad, lore, Author's Note) **and your character card
on every check**, uses a **full ten-message immediate window**, and gets a
generous **12-second budget** so a rich-context check never gets cut off; the
seeder gets more token headroom for very large casts. All of it stays plug-and-
play — auto-seed, auto-duel/battle/war, and the ambient event engine are on, on
the fair `realistic` curve. (If your referee model is slow and you'd rather trade
some context for speed, turn off *Include memory* / *Include card* in the
referee-context settings — everything still works, just leaner. World Info stays
opt-in, since your memory already carries the established world.)

Also hardened: roster lookups (`findActor`) now match on **whole words**, never
bare substrings — so a short name still resolves to a full one ("Kaiser" →
"Kaiser von Adler"), but a distinct character can never grab the wrong entry's
rating ("Ana" is never mistaken for "Anakin"), in both fights and seeding.



The referee identifies the fighters, and occasionally it split a player's full
name and handed a *piece of it* back as the opponent — e.g. with the persona
named "Jovan" but the story calling them "Jovan Wessex", a duel could open as
*Jovan vs Wessex*, labelling the enemy with the player's own surname. The guard
is TOKEN-based (never crude substring matching) and fool-proofed both ways:

- The player, any fragment of their name (a bare surname), and any *extension*
  of it are all recognised as the player and can never be the opponent.
- It does **not** over-fire: a distinct foe that merely shares a surname (a
  sibling like "Claire Wessex"), or whose name happens to contain the player's
  short name as letters ("Anakin" vs a player "Ana"), stays a valid opponent.
- When the referee mislabels the foe, the real name is **recovered** from its
  other identifications (its opposition field, then an inverted actor slot)
  before the duel is ever dropped; only if no clean, distinct name exists
  anywhere does the attack fall back to a plain check (which still resolves, and
  the next turn re-opens the duel cleanly). An unseeded foe still opens a proper
  duel with an estimated rating.

Plus the referee is told the player may appear under a fuller name and that every
part of it is the player, with an explicit rule never to use any part of the
player's name as the opponent. Tip: setting your SillyTavern persona to your
character's **full** name (e.g. "Jovan Wessex") makes it airtight.



Every subsystem was put under a systematic correctness audit: the probability
core, exchange economy, single/combo/recovery duels, skirmish battles, army-scale
war, the composure system, the background event engine, state snapshot/restore,
and model-output parsing. Zero defects were found — the outcome slices partition
cleanly with no cross-boundary leaks, exchange damage is symmetric to machine
precision (no hidden tilt toward the player), tens of thousands of randomized
duels/battles/wars all terminate with valid victors and never produce NaN,
composure and all pity-timer dice stay inside their bounds, story-seed pools are
consumed exactly once, and every normalizer survives arbitrary malformed model
output without throwing. Those checks are now frozen as three standing regression
suites (four total): the invariant suites above, plus an end-to-end suite that
drives the *real* interceptor through every production flow — no-check turns,
single checks, duel start/exchange/finish, battle and war openings, fast mode,
swipe-stability (a swipe or regenerate re-rolls the prose, never the fate),
edit-rewind (editing an action rewinds cleanly instead of stacking a second
outcome), and re-seeding after a fight — while asserting that no injected
directive ever leaks a mechanical number (a delta, probability, or die) to the
storyteller. Forty-five suites in total, so no future change can silently break
the fairness, stability, or immersion the engine rests on.



A "success with a cost" is the mildest win tier — a small tax, not a reversal. But
storytellers were reading the "cost" as licence to spend the player's most valuable
hidden asset: on a *secretly* used power scored SUCCESS-WITH-COST, the narration
would decide the secret got noticed and expose it outright. That's a
disproportionate consequence — fully blowing a concealment the player deliberately
protected is a real-*failure* beat, not something a success should cost. Arbiter now
tells the storyteller to keep every consequence proportionate to the result, and
that a win (or a minor cost) must **not** expose a secret, cover, or concealment the
player took pains to protect — at most a faint, deniable flicker of suspicion they
can still manage. A genuine failure can still blow your cover; a success no longer
will. Applied across duel, combo, and general-check directives.



When your message chains several distinct attacks — *disrupt his spell, then a
groin kick, then an elbow, then a punch to the neck* — Arbiter no longer flattens
the whole thing into a single "success." Each strike is now scored on its **own
footing**, given what came before and the opponent reacting between blows, so you
get a real sequence of outcomes: the spell disruption lands clean, the groin kick
is slipped, the elbow connects hard, the neck punch is read and countered. The
storyteller is handed each strike's result in order and told to honour it — a
strike marked as fumbled *did* go wrong, and the opponent makes you pay for it,
instead of the whole flourish quietly succeeding.

Crucially, a combo is **high-variance, not win-more**. The chain still collapses to
a single exchange's worth of poise (never four free hits), the per-strike results
map to an overall outcome that is *symmetric in severity* (a chain that lands big
is as decisive as a chain that falls apart is disastrous), and a fumbled early
strike hands the opponent the initiative. Simulated over thousands of duels this
comes out fair: at even odds a combo wins the same ~50% a single action does, and
when you're **outmatched a combo actively backfires** — you lose more for
overcommitting than you would with a simple attack. Chaining presses a real
advantage; it never manufactures one.



Every exchange used to strip a flat amount of poise no matter how lopsided it
was. So a skilled brawler dismantling a squishy mage only won the roll *more
often* — each hit still did the same chip damage, which forced the fiction into
absurd narration (the mage shrugging off a groin kick, an elbow to the face, and
a punch to the neck as if nothing happened). Now the **damage scales with the
margin of victory**: the more one-sided the exchange, the more poise the
winner's blow strips (capped, so nothing is unbounded). A big physical advantage
over a fragile target now *wrecks* them in a hit or two, and a dominant decisive
blow can outright end it — while a superior foe hits *you* just as hard, so
there's no bias toward the player. Close fights (a margin of two or less) are
completely unchanged, so the even-odds attrition that lets you genuinely lose is
preserved. The net effect: the mechanics finally reflect what actually landed,
so the storyteller narrates a wrecked opponent instead of inventing a hulk.

## Smarter Background world: story-tailored events (v0.20)

The Background world already fires on pity timers (odds that climb the longer
nothing happens) and never during a fight. What changed is *what* it fires. The
encounter and world-event tiers used to draw from a generic built-in table.
Now the **seeder** — which already runs event-driven (post-fight, reading your
story and memory, the same smartness that builds the capability sheet) — also
produces a small pool of **bespoke, story-grounded hooks**: specific people who
could plausibly cross your path given where you are, and seismic shifts that fit
this exact world. When a tier fires it draws from that pool (consumed once each,
so no repeats), and only falls back to the generic table when the pool runs dry.
Each re-seed refreshes the pool against the current scene. The result: the world
throws beats that belong to *your* story, not filler — and it costs nothing
extra per turn, because the thinking happens at seed time. Fully automatic, no
commands.

## Referee context payload + inspector (v0.17)

By default the referee runs **lean**: it reads its own neutral system prompt, the
capability sheet, and the last few messages (Context msgs) — enough to judge the
physics of one action, cheap and fast. That default is unchanged.

But you can now **opt into a wider payload** per check, with granular toggles
(Combat → Referee context payload):

- **Include full memory** — feeds the whole memory stack (Summaryception, the
  Copilot ledger, notepads, lore, Author's Note) into *every* check, not just at
  seed time. Useful when a decisive fact lives in memory rather than the recent
  messages.
- **Include character card** (v0.18) — feeds the active card's *descriptive*
  fields (name, description, personality, scenario) into every check. Deliberately
  excludes the card's instruction-type fields (main-prompt override,
  post-history instructions) — like the system prompt, those are bias vectors,
  not physical facts.
- **Include World Info** (v0.19, vector in v0.20) — feeds activated lorebook
  entries into every check. It uses SillyTavern's OWN activation engine when
  available, so constant, keyword AND **vectorized** (semantic) entries all fire
  exactly as ST decides; if that API isn't exposed it falls back to reading your
  active book(s) directly (constant + keyword). Pin specific books by name or
  leave empty to use your active book(s).
- **Feed the whole chat (budgeted)** — replaces the last-N slice with as much of
  the transcript as fits a char budget, at fuller width than the lean clip.
- **Include hidden ("ghosted") messages** — surfaces messages you've hidden from
  the story so the referee sees the complete picture.
- **Context budget (K chars)** — the ceiling for the transcript, the memory
  block, the card, and the world-info block.

Two exclusions are permanent and deliberate: SillyTavern's **system prompt** and
your **user persona** are *never* sent to the referee. Both are where "make it
fun for the hero / I am the chosen one" framing lives, and keeping them out is
what makes the judge neutral. And **Arbiter's own injected directives are never
fed back** to the referee — it never grades its own past output.

A word of honesty on the trade-off: wider context is slower and costs more
tokens on every check, and dumping tens of thousands of tokens into a small
focused model can *dilute* its judgement (lost-in-the-middle) rather than sharpen
it. It's off by default for that reason. If you turn it on and checks start
expiring, raise the Timeout. Treat it as an experiment — the sheet already
distils memory into ratings, so the lean default is often enough.

**Inspector.** Data & tools now has a *Last check* view: tap "View last check"
to see the exact prompt sent to the referee on your most recent adjudicated turn
— its system rules *and* the full context (sheet, memory if enabled, recent
story, your action), plus which toggles were active and the total size. It's
captured for the current session so you can see precisely what the referee saw,
not just the memory-sources banner.

Every new knob is editable in settings and covered by Reset settings.

## Nerve at every scale: battle & war composure (v0.16)

Composure used to live only in duels. Now it runs through **battles and wars**
too — for the player-commander and for every individual unit and formation on
the field. Three things follow:

- **A rattled unit fights worse.** Each formation carries its own nerve, folded
  into every clash the same way your own strain is: a shaken squadron, a
  wavering flank, or a commander who has seen too much all take a real penalty
  until they steady. A mindless construct with no nerve is simply unaffected.
- **Morale shock is mechanical, and it cascades the way routs really do.**
  Watching same-side units fall this round frays the survivors' individual
  nerve — distinct from raw headcount morale, which only counts who's still
  standing. A clean round with the numerical edge lets a side steady instead.
  This is pure maths (no LLM), so it works in Fast mode too, and it never
  *breaks* a unit on its own — nerve is mental; only losing all poise fells
  anyone. Frayed nerve just makes the next clash harder, which is exactly how a
  line starts to buckle before it breaks.
- **Your nerve recovers between scenes.** On calm narrative turns — no fight, no
  action, just story — your composure settles back a little at a time. It's
  deliberately slow, so a single horror beat still erodes far faster than quiet
  time heals, and it never overshoots your steady baseline.

The roster the referee sees each turn now tags standing units as *(shaken)* or
*(nerve breaking)* when their nerve slips, so it shows up in the prose on both
sides.

Two things are intentionally left out for now, to keep this robust: per-unit
*atmospheric* fear from the fiction (e.g. a dragon's roar terrifying one
specific formation independent of losses) isn't wired to an LLM signal — the
mechanical loss-shock above covers the dominant real driver of formations
breaking. And passive recovery heals *nerve* only, never persistent conditions
(a broken arm or a curse stays until the fiction resolves it — those are meant
to be deliberate and lasting, not to quietly heal on a timer).

## Who each feature covers (v0.13.1)

- **Conditions & gear** apply to EVERYONE — the player, allies, enemies, and
  even army formations. A wounded rival, a cursed ally, an enchanted-blade
  enemy, or a demoralized legion are all modified correctly (they flow through
  the shared rating pipeline).
- **Scale mismatch** now applies to DUELS, BATTLES, and WARS alike — a lone
  hero, a squad, or a whole army facing a dragon or titan host all feel the
  size gap (previously duels only). An equalizer in the fiction still shrinks
  it.
- **Composure** (automatic mental strain) now covers the player AND every unit
  you fight — in duels, battles, and wars alike (v0.16). A named formation
  leader or squadron cracking under fire fights measurably worse, and watching
  comrades fall frays the survivors' nerve. Ambient non-combatants are still
  narrated rather than individually simulated.

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

## What is an attempt? — declarations arm, attempts roll

The referee only rolls what is actually **attempted right now**. A message
that taunts, boasts, negotiates, declares intent ("I will…", "perhaps I'll
be the third"), renounces an option ("I'm not going to use my bankai"),
draws or sheathes a weapon, takes a stance or position, powers up without
releasing anything, asks the narrator a directorial question ("what would
he do…", intervention windows, bracketed notes), or recaps what earlier
narration already settled — **attempts nothing**, and nothing is rolled.

When such a message clearly opens a fight (both sides squared up, steel
drawn, the duel accepted), the duel **arms without a roll**: the HUD shows
round 0, a *DUEL JOINED* directive binds the storyteller to the brink — no
blow has landed, nothing has succeeded or failed — and the **first
committed attempt becomes round 1**. An actual attack that opens combat (a
lunge, a shot, a power unleashed at someone) still arms and resolves round
1 in one turn, exactly as before. A duel always arms in a **combat**
domain: an opener the referee classified as talk can never create a
"social duel" — the fight's weapons decide, defaulting to melee.

Inside a fight the same line holds both ways: while the opponent presses,
a player who only talks or hesitates is still in an exchange at negative
circumstance — **words do not parry steel**, so you cannot stall a
pressing foe by monologuing. But a mutual standoff — both circling,
talking, measuring, nobody committing — is a lull: no roll, no round.

Every verdict also carries a plain meaning now, in the log and the result
toasts: SUCCESS WITH COST = "succeeds, but with a proportionate cost",
TRADE = "both land real hits — mutual damage", SETBACK = "fails, but
forward — the loss opens a real next move", and so on. A bare tier name is
never a mystery.

## Established defenses — guards and counter-paths

When your character maintains a stated defense — an untouchable barrier
(Infinity), a ward, intangibility, a shield-art — the referee now records
it as a **guard**, stated as a constraint ("Infinity holds: nothing
physical reaches his body; only the sword's veil is lowered"), and must
name the ONE honest **counter-path** the opponent has through it this beat
(the exposed blade can be seized; the ground can be shattered; the veil
must widen the instant he commits) — or record that there is **none**,
never inventing one "to seem fair".

Every verdict is then **scoped by the guard** in the directive the
storyteller receives:

- With a real counter-path, any toll on you comes **only through that
  named path** — the "how" is in the prose, never an unexplained touch.
- With no path, the opponent **cannot land contact**: a FAILURE or TRADE
  means *your own attempt* was read, evaded, or stopped, and any cost is
  strain, footing, or tempo — the guard itself holds. Forced-injury
  commands are suppressed; poise under an intact guard is fighting
  capacity, not flesh.
- An unanswered guard is also strong positive circumstance for your
  safety — while your own attack through the narrowed gap can still fail
  on its merits, which is the honest reading of a FAILURE there.

The adjudication log shows the guard on every entry (⛨ line, with the
path or "no counter path: the guard held"), so a bare verdict always
carries its in-fiction reasoning. Works identically in single checks,
duels, battles, and war personal engagements, for ANY power system.

## Fight styles — tracked vs outcome-only

**Outcome feel → Fights** picks how combat resolves:

- **tracked** (default) — the full engine: poise as each side's fighting
  capacity, forced lasting injuries on decisive results, momentum and
  openings, morale and rout at battle scale, and a **called winner** the
  storyteller must narrate. Unchanged from every prior version.
- **outcome-only** — every exchange (single strikes, combos, battle turns,
  war orders) still rolls the same fair curve and returns its full verdict,
  DECISIVE down to DISASTER, at odds set by the real ratings, conditions,
  scale, and composure. But **nothing is tallied**: no health, no forced
  injuries, no momentum, no side-strength ticking — and the engine **never
  declares an end**. Each verdict stands on its own; consequences persist
  only as the fiction carries them; the **storyteller decides when the fight
  concludes** and narrates the yield, flight, or finish when the accumulated
  outcomes earn it. The referee still closes the fight once the fiction
  clearly ends it, and `/duelend`, `/battleend`, and the HUD ✕ always work.
  The HUD drops its bars and shows names + round with an *outcome-only* tag.

Composure stays active in both styles — it is nerve, not health, and only
shapes the odds. Switching styles mid-chat is safe: the setting gates each
new exchange.

## Player identity — story name vs persona label

SillyTavern's persona name is *who is typing*; the fiction may call your
character something entirely different (persona "LO" playing "Jovan Oda" —
zero shared name tokens, so no fuzzy matching can bridge them). Arbiter keeps
a per-chat **story name** and uses it everywhere identity matters: the
referee is told the story name is the player (and that your message label is
the *same person*, never the opponent), duels/battles/wars name you by it,
sheet lookups resolve **your real ratings** instead of falling to default-5,
and injuries the referee files under either name land on the one true entry.

You almost never set it by hand: **sheet seeding reads the story and learns
it** (`player_story_name`), announces what it found, and never overwrites a
name you set yourself. Override any time in **Manual controls → Your
character** or with `/mcname`. When the story name is learned or set, any
split entry created earlier (conditions on the label beside ratings on the
story name) is folded into one automatically. Blank = persona name; chats
where the two match behave exactly as before.

## Tests

`tests/` contains 54 suites covering every invariant: the probability
curve, tier slicing per preset, exchange effects, full battles to
conclusion, snapshot rewinds, event tiers, thread ladders, memory-collector
coverage, gate behavior, player identity (story name vs persona label),
the outcome-only fight style (verdicts without health or an engine-called
end), fight-or-not intelligence (declarations arm, attempts roll), and
established-defense guards (verdicts scoped by the fiction's own rules).
Run them with Node (no dependencies):
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
