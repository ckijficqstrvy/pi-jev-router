# pi-jev-model-router

A pi extension that routes every prompt to a model tier using **TypeSafe Jev**
(System One) typed judgments. You type normally; before the turn starts, Jev
reads the request and answers five narrow questions, code composes those into a
tier plus a thinking level, applies your budget policy, and pi switches to the
matching model.

```
you type a prompt
        │
        ▼
   Jev (one request, 5 parallel questions)
     • task_kind            choice: plan / implement / debug / refactor / review / research / explain / operate / write / chat
     • complexity           score:  trivial → architectural
     • capability_deserved  score:  minimal → maximum (price ignored)
     • needs_deep_reasoning noul:   yes/no probability
     • thinking_level       choice: off → max (how deep should this task think)
        │
        ▼
   code composes the decision
     demand = 0.55·complexity + 0.45·capability (+ reasoning nudge)
     demand = max(demand, kind floor)          # planning/review never go cheap
     thinking = pin > Jev judgment > demand ladder > tier default
     confidence guard → budget guard → availability guard → cache guard
        │
        ▼
   pi.setModel(...) + pi.setThinkingLevel(...)   → the turn runs on that model
```

The split is deliberate: **Jev judges the task, code owns the budget.** Changing
your spend caps never invalidates the judgment, and the judgment stays a pure
semantic read of the request.

## What you see

**In the transcript.** Every decision is written as a durable entry, so you can
always see which model the request went to and why:

```
jev-router → standard  openrouter/xiaomi/mimo-v2.6-pro
plan · complexity 1.70/3 · capability 1.55/3 · reasoning 0.82 → high (used standard)
· budget 74% of cap → one tier down
```

Expand the entry (same key as other collapsible content) to see the raw judgment:
kind and its confidence, complexity, capability deserved, deep-reasoning
probability, composed demand score, budget pressure, and the thinking level —
resolved, judged, and the value pi actually applied after per-model clamping.

The glyph encodes the action: `→` switched, `=` already active (stickiness),
`•` notify-only mode, `×` skipped (kept current / unavailable). Entries are stored
in the session but never sent to the LLM, so they cost no context.

**Not-routed prompts are shown too**, so routing is never silently absent:

```
jev-router · not routed
acknowledgement — staying on the current model
using openrouter/~anthropic/claude-opus-latest
```

A prompt is left on the current model for a clear reason: it is an
acknowledgement (`yes`, `continue`, …), a short continuation inside an ongoing
conversation, or no configured route is available. A short *first* message in a
fresh session (like `hi`) is a real request and **does** get routed. Duplicate
skip entries for the same reason and model are collapsed.

**In the status bar.** `jev-router:` followed by the active tier, session
spend, budget pressure, and mode, e.g. `jev-router:standard · $0.42 · 74% ·
notify`, `jev-router:on` before the first route, or `jev-router:off` when
disabled.

## Install / location

Install it as a pi package — `pi install` records the source in
`~/.pi/agent/settings.json` under `packages`, and pi resolves it on every
start:

```sh
pi install npm:pi-jev-model-router      # from npm
pi install /absolute/path/to/checkout   # from a local checkout
```

Or drop it into pi's auto-discovered global directory instead:

```sh
mkdir -p ~/.pi/agent/extensions
cp -R extensions/pi-jev-model-router ~/.pi/agent/extensions/
```

Either way, `/reload` re-imports the extension and re-reads the config: pi
clears its extension cache and re-resolves installed packages on reload.

It needs a TypeSafe API key:

```sh
export TYPESAFE_API_KEY=...
```

## Commands

| Command | What it does |
| --- | --- |
| `/jev-router` | Status: mode, spend, routes, kind specialists, last decision |
| `/jev-router on` / `off` | Enable/disable routing |
| `/jev-router mode auto\|confirm\|notify` | `auto` switches silently; `confirm` asks each turn; `notify` only tells you |
| `/jev-router budget daily 10` | Session-only daily cap (persist it in the config file) |
| `/jev-router budget monthly 150` | Session-only monthly cap |
| `/jev-router why` | Re-run Jev on the last prompt and show the full judgment + decision trace |
| `/jev-router revert` | Switch back to the model that was active before the last auto-switch |
| `/jev-route <text>` | Classify arbitrary text and show the recommendation without switching |

The LLM can also call the `jev_route` tool to ask for a tier recommendation for
a subtask.

`on`/`off`, `mode`, and `budget` changes are session-only: `/reload` or a
restart re-reads `enabled` and `mode` from the config file and the
`JEV_ROUTER_*` environment.

## Configuration

Optional. Create `~/.pi/agent/pi-jev-model-router/config.json`
(see `pi-jev-model-router.example.json`). Later sources win: defaults →
`~/.pi/agent/pi-jev-model-router/config.json` → `JEV_ROUTER_*` environment
variables. There is no project-level config:
project config files are no longer read, so a cloned repo cannot inject router
settings.

Every scalar setting is environment-reachable (`JEV_ROUTER_ENABLED`,
`JEV_ROUTER_MODE`, `JEV_ROUTER_USE_DEFAULT_MODELS`, `JEV_ROUTER_JEV_MODEL`,
`JEV_ROUTER_TIMEOUT_MS`, `JEV_ROUTER_MIN_PROMPT_CHARS`, `JEV_ROUTER_HISTORY_TURNS`,
`JEV_ROUTER_CONFIDENCE_THRESHOLD`, `JEV_ROUTER_STICKINESS`,
`JEV_ROUTER_BUDGET_DAILY_USD`, `JEV_ROUTER_BUDGET_MONTHLY_USD`,
`JEV_ROUTER_BUDGET_SOFT_RATIO`, `JEV_ROUTER_BUDGET_HARD_RATIO`,
`JEV_ROUTER_CACHE_AWARE`, `JEV_ROUTER_CACHE_DEADBAND`,
`JEV_ROUTER_CACHE_MAX_PENALTY_USD`, `JEV_ROUTER_CACHE_BYPASS_TIER_DELTA`,
`JEV_ROUTER_KIND_MIN_TIER` as `kind=tier` pairs). `JEV_ROUTER_OFF=1` remains as
a legacy kill switch. `routes` and `kindModels` are structured model specs and
stay config.json-only. `TYPESAFE_API_KEY` is read for authentication.

Every value is validated on load: a malformed or out-of-range value is dropped
with a warning (shown at session start and in `/jev-router` status) and the
config.json/default value stands. Booleans accept `1/0`, `true/false`,
`yes/no`, `on/off`; ratios must sit in 0–1 with `softRatio ≤ hardRatio`; caps
accept a USD amount ≥ 0 or `none` to remove the cap. The full table of accepted
forms lives in the repository README.

```json
{
  "enabled": true,
  "mode": "notify",
  "confidenceThreshold": 0.34,
  "stickiness": true,
  "budget": { "dailyUsd": 5, "monthlyUsd": 100, "softRatio": 0.7, "hardRatio": 0.9 },
  "routes": {
    "quick":    [{ "provider": "openrouter", "model": "xiaomi/mimo-v2.6-flash" }],
    "standard": [{ "provider": "openrouter", "model": "xiaomi/mimo-v2.6-pro" }],
    "high":     [{ "provider": "openrouter", "model": "~z-ai/glm-latest" }],
    "premium":  [{ "provider": "openrouter", "model": "openai/gpt-6-sol" }]
  },
  "kindModels": {
    "implement": [{ "provider": "openrouter", "model": "xiaomi/mimo-v2.6-pro", "minTier": "standard" }]
  },
  "kindMinimumTier": { "plan": "high", "review": "high", "implement": "standard" }
}
```

### Thinking levels

Jev's fifth question (`thinking_level`) judges how deep the *task* should think
(`off` → `max`); the model and its price are excluded from the rubric.
Resolution precedence, first hit wins:

1. **config pin** — `thinkingLevel` written on a route entry (explicit intent).
   With the default `kindModels`, a *switched* decision's target comes from the
   kind chain, so pin on the `kindModels` entry you actually route to; `routes`
   pins govern kept/held decisions and config-only setups.
2. **Jev judgment** — the fifth question's answer
3. **demand ladder** — pure-code fallback when the answer is missing: same rungs
   as the tier table, `xhigh` only at the very top of demand
4. **tier default** — `TIER_THINKING` (`quick: off`, `standard: low`,
   `high: medium`, `premium: high`)

The level is applied when the router keeps, holds, or switches to a model —
including after a manual model switch, so thinking no longer goes stale. pi
clamps per model, and the decision entry records what was **actually applied**
after clamping, beside the resolved and judged values. In `notify` mode a
suggested switch still mutates nothing: the entry and notification show the
resolved level annotated `not applied (notify mode)`.

### Budget profiles & model policy

Four layers, highest wins: explicit `routes`/`kindModels` (never filtered) →
policy (`profile`/`ceilings`/`deny`/`allowProviders`/`prefer`) →
`model-facts.json` (dated capability + price snapshot) → code. One line —
`"profile": "cheap"` — sets every tier's price band (`input+2×output` $/M:
cheap 1/3/10/25, balanced 1.5/5/15/44, quality 2/10/44/∞); bands are
disjoint, capability ranks inside a band, live registry prices re-check at
decision time. `deny: ["*opus*"]` strips flagships from derived chains; a
model you write yourself always survives its own deny. `autoRoutes: false`
keeps the authored default chains. See the repository README for the
four-layer table and the model-facts refresh procedure.

### Two axes of routing

1. **Tier** (`quick` → `standard` → `high` → `premium`) is the *budget axis*. Each
   tier is an ordered **candidate chain**; the first model that is available and
   authenticated wins, so you get automatic fallback when a model is down or
   your key can't afford it.
2. **`kindModels`** is the *task axis*. A kind-specialist chain is tried before
   the generic tier chain, filtered by `minTier`. Eligible specialists are ranked
   by how close their `minTier` is to the chosen tier, so a cheap specialist never
   wins a premium-quality turn. This is how planning can land on a strong reasoner
   while implementation lands on a coding specialist.

Rules of thumb baked into the defaults:

- planning / review → strong long-horizon models, floored at `high`
- implement / debug / refactor → Codex-style coding specialists, floored at `standard`
- explain / chat / write → cheap fast models
- research → long-context readers

### Budget behaviour

`spend pressure = max(today ÷ dailyUsd, month ÷ monthlyUsd)`.

- `pressure ≥ softRatio` → drop one tier
- `pressure ≥ hardRatio` → force `quick`, unless the demand score is ≥ 2.5
  (clearly architectural), which is allowed to stay at `standard`

Spend is accumulated from each assistant message's computed cost into
`~/.pi/agent/pi-jev-model-router/state.json`, alongside Jev request counts.

### Prompt-cache awareness

Caches are per-model, so any switch makes the next request re-read the whole
prefix at full input price — cache reads are only ~10% of input, so one switch
costs roughly the entire context once, on every provider. The router gates
switches instead of making them freely:

- `maxPenaltyUsd` — estimated miss (`contextTokens × (new input + cache-write
  rate − current cache-read rate)`) above this blocks the switch
- `deadband` — demand must clear the current tier's band (`tier ± 0.5`) by this
  much before a tier change happens, so boundary-hovering prompts stop flapping
- `bypassTierDelta` — a jump this large still switches (genuine capability change)
- same-tier specialist swaps are priced identically, since they are still model
  changes

Set `cache.aware: false` to switch unconditionally. The estimate is skipped when
pricing is unknown, so it never blocks on guesses.

### Confidence

If Jev's `task_kind` confidence is below `confidenceThreshold` and the suggested
tier is above `standard`, routing falls back to `standard` rather than spending
premium money on a guess. Low confidence on a harmless preference is not treated
as an error.

## Tuning notes

- `useDefaultModels: false` drops the built-in `routes`/`kindModels` entirely, so
  only the models in your config are used. Tiers or kinds you don't configure
  become empty and are skipped, never back-filled from the defaults.
- A model switch resets the provider prompt cache. `cache.aware` (default on)
  gates switches by their estimated cache penalty, so tune `cache.maxPenaltyUsd`
  down for more switching, or up for more stickiness. `cache.aware: false`
  restores unconditional switching.
- `stickiness: true` is the cheap version of the same idea: it avoids re-applying
  a decision when the chosen model is already active.
- Model IDs are provider-scoped; the defaults assume `openrouter`. Swap them for
  whatever providers you have configured. `/jev-router status` marks each route
  `✓`/`✗` based on what is actually available and authenticated.
- `minPromptChars` (default 12) governs when a short message counts as a
  continuation and is left alone; a short first message in a fresh session is
  still routed. `/` commands, `yes`/`continue` acknowledgements, and `!` bash
  lines are never routed.

## Files

| File | Role |
| --- | --- |
| `index.ts` | pi wiring: events, commands, `jev_route` tool, model switching |
| `config.ts` | config types, defaults, layered loading |
| `jev.ts` | TypeSafe HTTP client, question definitions, response parsing |
| `router.ts` | composition (`decide`), tier/kind chains, availability fallback |
| `budget.ts` | spend ledger, caps, pressure |

## Failure behaviour

Routing never blocks your turn. A missing key, network error, timeout (default
3.5 s, retried on 429/529), or unknown model means: warn in the status line and
run the prompt on the current model unchanged.

## Compatibility

Optional `ExtensionAPI` surfaces are feature-detected, so the extension loads on
older pi builds and downstream forks. If `registerEntryRenderer` or
`@earendil-works/pi-tui` is unavailable, the transcript card is skipped and
decisions still appear via the status bar and notifications. Missing
`appendEntry`, `ctx.ui.select`, or `modelRegistry.find` degrade to no persistence,
auto-switching, or "leave the model unchanged" respectively. `@earendil-works/pi-tui`
is an optional peer dependency.