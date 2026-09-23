import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/**
 * pi-jev-model-router config.
 *
 * Resolution order (later wins):
 *   1. DEFAULTS below
 *   2. ~/.pi/agent/pi-jev-model-router/config.json
 *   3. the JEV_ROUTER_* environment overrides (see ENV_VARS below)
 *
 * Every env value is validated when the config loads: a malformed or
 * out-of-range value never reaches the resolved config — the variable is
 * dropped, a warning naming it and the accepted form is collected in
 * `ConfigLoadResult.warnings` (surfaced at session start and in
 * `/jev-router` status), and the previous layer's value stands. TYPESAFE_API_KEY
 * is read separately by resolveApiKey().
 */

/**
 * Fixed spend-ledger path: single owner, not configurable, never a config key.
 * Both runtime files live namespaced under ~/.pi/agent/pi-jev-model-router/
 * (same convention as pi-typesafe/ and pi-warden/), outside any git checkout.
 */
export const STATE_FILE = join(homedir(), CONFIG_DIR_NAME, "agent", "pi-jev-model-router", "state.json");
/** The only environment variable the router may read a key from. */
export const API_KEY_ENV = "TYPESAFE_API_KEY";

export type Tier = "quick" | "standard" | "high" | "premium";
export const TIERS: readonly Tier[] = ["quick", "standard", "high", "premium"] as const;

export type Mode = "auto" | "confirm" | "notify";
export const MODES: readonly Mode[] = ["auto", "confirm", "notify"] as const;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Static thinking level per tier — the last-resort fallback in the resolution
 * chain (config pin > Jev's 5th-question judgment > demand ladder > this).
 * These used to sit as `thinkingLevel` on the default route entries; they moved
 * here so the per-task judgment can win by default. Adding `thinkingLevel` to a
 * route in config.json still pins it and beats the judgment.
 */
export const TIER_THINKING: Record<Tier, ThinkingLevel> = {
  quick: "off",
  standard: "low",
  high: "medium",
  premium: "high",
};

export interface RouteTarget {
  provider: string;
  model: string;
  /**
   * Config pin, set only when config.json writes it explicitly: it wins over
   * Jev's per-task thinking judgment (precedence: pin > Jev > ladder > tier
   * default). Clamped by pi per model.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Only used inside `kindModels`: this model may serve the kind when the
   * chosen tier is at or above `minTier`. Omitted → treated as "standard".
   */
  minTier?: Tier;
}

/** A tier maps to an ordered candidate chain; the first available model wins. */
export type RouteChain = RouteTarget[];

export interface BudgetConfig {
  /** Rolling UTC-day spend cap in USD. Omit for no daily cap. */
  dailyUsd?: number;
  /** Calendar-month spend cap in USD. Omit for no monthly cap. */
  monthlyUsd?: number;
  /** Above this fraction of the cap, downgrade one tier. */
  softRatio: number;
  /** Above this fraction of the cap, force the cheapest tier. */
  hardRatio: number;
}

/**
 * Model switches invalidate the provider's prompt cache, so the next request
 * re-reads the whole prefix at full input price. These knobs keep the router
 * from paying that penalty for a marginal tier change.
 */
export interface CacheConfig {
  /** Master switch for cache/cost-aware hold decisions. */
  aware: boolean;
  /**
   * Demand must clear the current tier's band (tier ± 0.5) by this much before a
   * switch is considered. Damps flapping between adjacent tiers.
   */
  deadband: number;
  /**
   * Skip a switch whose estimated cache penalty exceeds this many USD, unless it
   * is a large upgrade. Set to 0 to allow any switch regardless of penalty.
   */
  maxPenaltyUsd: number;
  /** Tier jumps this large always switch, since they are quality-critical. */
  bypassTierDelta: number;
}

export interface JevRouterConfig {
  enabled: boolean;
  mode: Mode;
  /**
   * When false, the built-in model chains (`routes`, `kindModels`) are dropped
   * entirely, so routing uses only the models your config provides. Other
   * defaults (timeouts, budget, kind floors) still apply.
   */
  useDefaultModels: boolean;
  jevModel: string;
  timeoutMs: number;
  minPromptChars: number;
  /** How many recent conversation turns to include as Jev state. */
  historyTurns: number;
  /** Below this choice confidence, fall back to the safe tier. */
  confidenceThreshold: number;
  /** Don't switch models when the current model already sits on the chosen tier. */
  stickiness: boolean;
  routes: Record<Tier, RouteChain>;
  /**
   * Kind-specific model preferences. When a kind has a chain here, models are
   * tried before the generic tier chain (subject to `minTier`). This is how
   * "planning" and "implementation" can land on different specialists.
   */
  kindModels: Record<string, RouteChain>;
  /** Floor tier per task kind, so e.g. planning never lands on the quick model. */
  kindMinimumTier: Record<string, Tier>;
  budget: BudgetConfig;
  cache: CacheConfig;
}

export const DEFAULT_CONFIG: JevRouterConfig = {
  enabled: true,
  mode: "notify",
  useDefaultModels: true,
  jevModel: "jev-latest",
  timeoutMs: 3500,
  minPromptChars: 12,
  historyTurns: 0,
  confidenceThreshold: 0.34,
  stickiness: true,
  // No `thinkingLevel` here on purpose: the default is "let Jev's 5th-question
  // judgment decide" (with TIER_THINKING as fallback). Write thinkingLevel in
  // config.json to pin a route.
  routes: {
    // Refreshed 2026-09 against the Artificial Analysis intelligence index:
    // glm-flash ~42 vs mimo-flash ~22–25 → mimo-flash demoted to fallback.
    quick: [
      { provider: "openrouter", model: "~z-ai/glm-flash-latest" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash" },
    ],
    standard: [{ provider: "openrouter", model: "xiaomi/mimo-v2.6-pro" }],
    // Budget pick (2026-09): no first-tier flagships at high/premium.
    // GLM-5.3 ≈45 with strong agentic-terminal reputation; K3 (1M ctx,
    // Frontend Arena #1) as vendor-diverse fallback.
    high: [
      { provider: "openrouter", model: "~z-ai/glm-latest" },
      { provider: "openrouter", model: "moonshotai/kimi-k3" },
    ],
    // gpt-6-sol: strongest non-flagship agentic coder (Terminal-Bench 4.0
    // 43%, $2/$10 — a fifth of gpt-6-astra); GLM as fallback.
    premium: [
      { provider: "openrouter", model: "openai/gpt-6-sol" },
      { provider: "openrouter", model: "~z-ai/glm-latest" },
    ],
  },
  kindModels: {
    // Planning and design: strongest long-horizon reasoners.
    plan: [
      { provider: "openrouter", model: "openai/gpt-6-sol", minTier: "premium" },
      { provider: "openrouter", model: "~z-ai/glm-latest", minTier: "high" },
    ],
    // Implementation: coding specialists.
    implement: [
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
      // Escalation rung: decide() ranks eligible specialists by minTier, so
      // high-demand implementation climbs to sol — which also serves premium
      // (no separate premium rung: same model would be a duplicate entry).
      { provider: "openrouter", model: "openai/gpt-6-sol", minTier: "high" },
    ],
    debug: [
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
      { provider: "openrouter", model: "openai/gpt-6-sol", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "high" },
    ],
    refactor: [{ provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" }],
    // Review and audit: strongest reviewers (non-flagship ceiling = sol).
    review: [
      { provider: "openrouter", model: "openai/gpt-6-sol", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    // Research: long-context readers.
    research: [
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
    ],
    explain: [
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash", minTier: "quick" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
    ],
    operate: [{ provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" }],
    chat: [{ provider: "openrouter", model: "xiaomi/mimo-v2.6-flash", minTier: "quick" }],
    write: [
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
    ],
  },
  kindMinimumTier: {
    chat: "quick",
    explain: "quick",
    write: "quick",
    operate: "standard",
    implement: "standard",
    debug: "standard",
    refactor: "standard",
    research: "standard",
    plan: "high",
    review: "high",
  },
  budget: {
    dailyUsd: 5,
    monthlyUsd: 100,
    softRatio: 0.7,
    hardRatio: 0.9,
  },
  cache: {
    aware: true,
    deadband: 0.25,
    maxPenaltyUsd: 0.05,
    bypassTierDelta: 2,
  },
};

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeChain(value: unknown): RouteChain | undefined {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  // Whitelist rebuild: drop the incoming object and copy only the declared
  // fields with validated types, so unknown keys cannot ride into config.
  const targets: RouteTarget[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.provider !== "string" || typeof raw.model !== "string") continue;
    const target: RouteTarget = { provider: raw.provider, model: raw.model };
    if (typeof raw.thinkingLevel === "string" && THINKING_LEVELS.includes(raw.thinkingLevel)) {
      target.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
    }
    if (typeof raw.minTier === "string" && (TIERS as readonly string[]).includes(raw.minTier)) {
      target.minTier = raw.minTier as Tier;
    }
    targets.push(target);
  }
  return targets.length > 0 ? targets : undefined;
}

function merge(base: JevRouterConfig, patch: unknown): JevRouterConfig {
  const p = asRecord(patch);
  // Explicit whitelist copy: keys the interface does not declare are dropped
  // on the floor, never spread back in.
  const next: JevRouterConfig = { ...base };

  if (typeof p.enabled === "boolean") next.enabled = p.enabled;
  const mode = p.mode;
  if (mode === "auto" || mode === "confirm" || mode === "notify") next.mode = mode;
  if (typeof p.useDefaultModels === "boolean") next.useDefaultModels = p.useDefaultModels;
  if (typeof p.jevModel === "string") next.jevModel = p.jevModel;
  if (typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)) next.timeoutMs = p.timeoutMs;
  if (typeof p.minPromptChars === "number" && Number.isFinite(p.minPromptChars)) {
    next.minPromptChars = p.minPromptChars;
  }
  if (typeof p.historyTurns === "number" && Number.isFinite(p.historyTurns)) next.historyTurns = p.historyTurns;
  if (typeof p.confidenceThreshold === "number" && Number.isFinite(p.confidenceThreshold)) {
    next.confidenceThreshold = p.confidenceThreshold;
  }
  if (typeof p.stickiness === "boolean") next.stickiness = p.stickiness;

  const routes = { ...base.routes };
  const rawRoutes = asRecord(p.routes);
  for (const tier of TIERS) {
    const chain = normalizeChain(rawRoutes[tier]);
    if (chain) routes[tier] = chain;
  }
  next.routes = routes;

  const kindModels = { ...base.kindModels };
  for (const [kind, value] of Object.entries(asRecord(p.kindModels))) {
    const chain = normalizeChain(value);
    if (chain) kindModels[kind] = chain;
  }
  next.kindModels = kindModels;

  const kindMinimumTier = { ...base.kindMinimumTier };
  for (const [kind, value] of Object.entries(asRecord(p.kindMinimumTier))) {
    if (typeof value === "string" && (TIERS as readonly string[]).includes(value)) {
      kindMinimumTier[kind] = value as Tier;
    }
  }
  next.kindMinimumTier = kindMinimumTier;

  const budgetRaw = asRecord(p.budget);
  const budget = { ...base.budget };
  if (typeof budgetRaw.dailyUsd === "number" && Number.isFinite(budgetRaw.dailyUsd)) {
    budget.dailyUsd = budgetRaw.dailyUsd;
  }
  if (typeof budgetRaw.monthlyUsd === "number" && Number.isFinite(budgetRaw.monthlyUsd)) {
    budget.monthlyUsd = budgetRaw.monthlyUsd;
  }
  if (typeof budgetRaw.softRatio === "number" && Number.isFinite(budgetRaw.softRatio)) {
    budget.softRatio = budgetRaw.softRatio;
  }
  if (typeof budgetRaw.hardRatio === "number" && Number.isFinite(budgetRaw.hardRatio)) {
    budget.hardRatio = budgetRaw.hardRatio;
  }
  next.budget = budget;

  const cacheRaw = asRecord(p.cache);
  const cache = { ...base.cache };
  if (typeof cacheRaw.aware === "boolean") cache.aware = cacheRaw.aware;
  if (typeof cacheRaw.deadband === "number" && Number.isFinite(cacheRaw.deadband)) {
    cache.deadband = cacheRaw.deadband;
  }
  if (typeof cacheRaw.maxPenaltyUsd === "number" && Number.isFinite(cacheRaw.maxPenaltyUsd)) {
    cache.maxPenaltyUsd = cacheRaw.maxPenaltyUsd;
  }
  if (typeof cacheRaw.bypassTierDelta === "number" && Number.isFinite(cacheRaw.bypassTierDelta)) {
    cache.bypassTierDelta = cacheRaw.bypassTierDelta;
  }
  next.cache = cache;

  return next;
}

// ---------------------------------------------------------------------------
// Environment-variable overrides
// ---------------------------------------------------------------------------

/** Minimal env surface the loader reads from (process.env satisfies it). */
export type EnvSource = Record<string, string | undefined>;

/**
 * Deployment-time overrides for every scalar knob in JevRouterConfig.
 *
 * Deliberate boundary: `routes` and `kindModels` are lists of model specs —
 * structured data belongs in config.json, not in shell strings. Scalars are
 * environment-reachable; structured settings are not.
 *
 * Validation is strict and fail-safe: `parse` returns INVALID for anything
 * malformed or out of range, such a variable is dropped with a warning and the
 * config.json/default value stands. A raw value is only echoed in a warning
 * when it is short printable ASCII, so a secret pasted into the wrong variable
 * cannot leak into logs.
 */
interface EnvVarSpec {
  /** Variable name, also the key read from the env source. */
  name: string;
  /** Accepted form, human-readable; used verbatim in validation warnings. */
  expected: string;
  /** Validate one non-empty raw value: a typed value, CLEAR, or INVALID. */
  parse(raw: string): unknown;
  /** Write the parsed value into the config; return true when it changed. */
  apply(config: JevRouterConfig, value: unknown): boolean;
}

/** `parse` result: the raw value is malformed or out of range. */
const INVALID = Symbol("invalid");
/** `parse` result: clear an optional setting (e.g. "no daily cap"). */
const CLEAR = Symbol("clear");

const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOL_FALSE = new Set(["0", "false", "no", "off"]);
const BOOL_EXPECTED = "1/0, true/false, yes/no, or on/off";
const CAP_CLEAR = new Set(["none", "off", "unlimited"]);

/** Accept the usual truthy/falsy spellings, case-insensitively. */
function parseBool(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (BOOL_TRUE.has(value)) return true;
  if (BOOL_FALSE.has(value)) return false;
  return undefined;
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Strict numeric parse: rejects hex/exponents-only garbage, NaN, Infinity, and range violations. */
function parseNumber(raw: string, opts: { integer?: boolean; min?: number; max?: number } = {}): number | undefined {
  const text = raw.trim();
  if (!NUMBER_RE.test(text)) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  if (opts.integer && !Number.isInteger(value)) return undefined;
  if (opts.min !== undefined && value < opts.min) return undefined;
  if (opts.max !== undefined && value > opts.max) return undefined;
  return value;
}

/** Echo the offending value only when it is short printable ASCII. */
function describeRaw(raw: string): string {
  return /^[\x20-\x7e]{1,40}$/.test(raw) ? JSON.stringify(raw) : "(unprintable value not shown)";
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): boolean {
  if (target[key] === value) return false;
  target[key] = value;
  return true;
}

/** Optional numeric cap: a value, or CLEAR to remove the cap entirely. */
function assignCap(key: "dailyUsd" | "monthlyUsd") {
  return (config: JevRouterConfig, value: unknown): boolean => {
    if (value === CLEAR) {
      if (config.budget[key] === undefined) return false;
      delete config.budget[key];
      return true;
    }
    return assign(config.budget, key, value as number);
  };
}

function parseCap(raw: string): number | typeof CLEAR | typeof INVALID {
  const text = raw.trim().toLowerCase();
  if (CAP_CLEAR.has(text)) return CLEAR;
  return parseNumber(raw, { min: 0 }) ?? INVALID;
}

function parseRatio(raw: string): number | typeof INVALID {
  return parseNumber(raw, { min: 0, max: 1 }) ?? INVALID;
}

const ENV_KIND_MIN_TIER = "JEV_ROUTER_KIND_MIN_TIER";
const ENV_BUDGET_SOFT_RATIO = "JEV_ROUTER_BUDGET_SOFT_RATIO";
const ENV_BUDGET_HARD_RATIO = "JEV_ROUTER_BUDGET_HARD_RATIO";

const ENV_VARS: readonly EnvVarSpec[] = [
  {
    // Legacy kill switch (pre-dates JEV_ROUTER_ENABLED). Only a truthy value
    // acts; JEV_ROUTER_ENABLED is listed later and wins when both are set.
    name: "JEV_ROUTER_OFF",
    expected: `${BOOL_EXPECTED} (legacy kill switch)`,
    parse: (raw) => parseBool(raw) ?? INVALID,
    apply: (config, value) => {
      if (value !== true || !config.enabled) return false;
      config.enabled = false;
      return true;
    },
  },
  {
    name: "JEV_ROUTER_ENABLED",
    expected: BOOL_EXPECTED,
    parse: (raw) => parseBool(raw) ?? INVALID,
    apply: (config, value) => assign(config, "enabled", value as boolean),
  },
  {
    name: "JEV_ROUTER_MODE",
    expected: "auto, confirm, or notify",
    parse: (raw) => {
      const value = raw.trim().toLowerCase();
      return (MODES as readonly string[]).includes(value) ? value : INVALID;
    },
    apply: (config, value) => assign(config, "mode", value as Mode),
  },
  {
    name: "JEV_ROUTER_USE_DEFAULT_MODELS",
    expected: BOOL_EXPECTED,
    parse: (raw) => parseBool(raw) ?? INVALID,
    apply: (config, value) => assign(config, "useDefaultModels", value as boolean),
  },
  {
    name: "JEV_ROUTER_JEV_MODEL",
    expected: "a printable ASCII model id",
    parse: (raw) => {
      const value = raw.trim();
      return /^[\x21-\x7e]+$/.test(value) ? value : INVALID;
    },
    apply: (config, value) => assign(config, "jevModel", value as string),
  },
  {
    name: "JEV_ROUTER_TIMEOUT_MS",
    expected: "an integer ≥ 0 (milliseconds)",
    parse: (raw) => parseNumber(raw, { integer: true, min: 0 }) ?? INVALID,
    apply: (config, value) => assign(config, "timeoutMs", value as number),
  },
  {
    name: "JEV_ROUTER_MIN_PROMPT_CHARS",
    expected: "an integer ≥ 0",
    parse: (raw) => parseNumber(raw, { integer: true, min: 0 }) ?? INVALID,
    apply: (config, value) => assign(config, "minPromptChars", value as number),
  },
  {
    name: "JEV_ROUTER_HISTORY_TURNS",
    expected: "an integer ≥ 0",
    parse: (raw) => parseNumber(raw, { integer: true, min: 0 }) ?? INVALID,
    apply: (config, value) => assign(config, "historyTurns", value as number),
  },
  {
    name: "JEV_ROUTER_CONFIDENCE_THRESHOLD",
    expected: "a number between 0 and 1",
    parse: (raw) => parseRatio(raw),
    apply: (config, value) => assign(config, "confidenceThreshold", value as number),
  },
  {
    name: "JEV_ROUTER_STICKINESS",
    expected: BOOL_EXPECTED,
    parse: (raw) => parseBool(raw) ?? INVALID,
    apply: (config, value) => assign(config, "stickiness", value as boolean),
  },
  {
    name: "JEV_ROUTER_BUDGET_DAILY_USD",
    expected: 'a USD amount ≥ 0, or "none" to remove the cap',
    parse: parseCap,
    apply: assignCap("dailyUsd"),
  },
  {
    name: "JEV_ROUTER_BUDGET_MONTHLY_USD",
    expected: 'a USD amount ≥ 0, or "none" to remove the cap',
    parse: parseCap,
    apply: assignCap("monthlyUsd"),
  },
  {
    name: ENV_BUDGET_SOFT_RATIO,
    expected: "a number between 0 and 1, ≤ budget.hardRatio",
    parse: (raw) => parseRatio(raw),
    apply: (config, value) => assign(config.budget, "softRatio", value as number),
  },
  {
    name: ENV_BUDGET_HARD_RATIO,
    expected: "a number between 0 and 1, ≥ budget.softRatio",
    parse: (raw) => parseRatio(raw),
    apply: (config, value) => assign(config.budget, "hardRatio", value as number),
  },
  {
    name: "JEV_ROUTER_CACHE_AWARE",
    expected: BOOL_EXPECTED,
    parse: (raw) => parseBool(raw) ?? INVALID,
    apply: (config, value) => assign(config.cache, "aware", value as boolean),
  },
  {
    name: "JEV_ROUTER_CACHE_DEADBAND",
    expected: "a number ≥ 0",
    parse: (raw) => parseNumber(raw, { min: 0 }) ?? INVALID,
    apply: (config, value) => assign(config.cache, "deadband", value as number),
  },
  {
    name: "JEV_ROUTER_CACHE_MAX_PENALTY_USD",
    expected: "a USD amount ≥ 0",
    parse: (raw) => parseNumber(raw, { min: 0 }) ?? INVALID,
    apply: (config, value) => assign(config.cache, "maxPenaltyUsd", value as number),
  },
  {
    name: "JEV_ROUTER_CACHE_BYPASS_TIER_DELTA",
    expected: "an integer ≥ 0",
    parse: (raw) => parseNumber(raw, { integer: true, min: 0 }) ?? INVALID,
    apply: (config, value) => assign(config.cache, "bypassTierDelta", value as number),
  },
  {
    name: ENV_KIND_MIN_TIER,
    expected:
      "comma-separated kind=tier pairs (kinds: plan/implement/write/debug/refactor/review/research/explain/operate/chat; tiers: quick/standard/high/premium)",
    parse: (raw) => {
      const pairs: Array<[string, Tier]> = [];
      for (const segment of raw.split(",")) {
        if (!segment.trim()) continue;
        const eq = segment.indexOf("=");
        if (eq < 0) return INVALID;
        const kind = segment.slice(0, eq).trim().toLowerCase();
        const tier = segment.slice(eq + 1).trim().toLowerCase();
        if (!(kind in TASK_KINDS)) return INVALID;
        if (!(TIERS as readonly string[]).includes(tier)) return INVALID;
        pairs.push([kind, tier as Tier]);
      }
      return pairs.length > 0 ? pairs : INVALID;
    },
    apply: (config, value) => {
      let changed = false;
      for (const [kind, tier] of value as Array<[string, Tier]>) {
        if (config.kindMinimumTier[kind] === tier) continue;
        config.kindMinimumTier[kind] = tier;
        changed = true;
      }
      return changed;
    },
  },
];

export interface EnvOverrideResult {
  /** The config with validated env overrides applied. */
  config: JevRouterConfig;
  /** Variables that actually changed a value, in application order. */
  applied: string[];
  /** Validation problems; each names the variable and its accepted form. */
  warnings: string[];
}

/**
 * Apply validated env overrides on top of a config. Pure: the input is never
 * mutated. Invalid values are dropped with a warning and leave the incoming
 * value in place; an empty or whitespace-only value counts as unset.
 */
export function applyEnvOverrides(base: JevRouterConfig, env: EnvSource): EnvOverrideResult {
  const config: JevRouterConfig = {
    ...base,
    kindMinimumTier: { ...base.kindMinimumTier },
    budget: { ...base.budget },
    cache: { ...base.cache },
  };
  const applied: string[] = [];
  const warnings: string[] = [];
  for (const spec of ENV_VARS) {
    const raw = env[spec.name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = spec.parse(raw);
    if (value === INVALID) {
      warnings.push(`${spec.name}: expected ${spec.expected}, got ${describeRaw(raw)} — override ignored`);
      continue;
    }
    if (spec.apply(config, value)) applied.push(spec.name);
  }

  // Cross-field coherence: soft > hard makes the downgrade and force thresholds
  // fire in the wrong order. Drop the env-side ratio overrides rather than ship
  // an incoherent pair; the config-file values stand and invariantWarnings()
  // still reports a file-side violation.
  if (config.budget.softRatio > config.budget.hardRatio) {
    const ratioVars = [ENV_BUDGET_SOFT_RATIO, ENV_BUDGET_HARD_RATIO].filter((name) => applied.includes(name));
    if (ratioVars.length > 0) {
      for (const name of ratioVars) {
        if (name === ENV_BUDGET_SOFT_RATIO) config.budget.softRatio = base.budget.softRatio;
        else config.budget.hardRatio = base.budget.hardRatio;
        applied.splice(applied.indexOf(name), 1);
      }
      warnings.push(
        `${ratioVars.join(" + ")}: budget.softRatio must be ≤ budget.hardRatio — override${ratioVars.length > 1 ? "s" : ""} dropped`,
      );
    }
  }
  return { config, applied, warnings };
}

/**
 * Source-agnostic sanity report on a resolved config. Env values are already
 * validated, so warnings here usually trace back to config.json (whose merge
 * is whitelist-lenient by design). Reporting only — values are never mutated.
 */
function invariantWarnings(config: JevRouterConfig): string[] {
  const warnings: string[] = [];
  const bounded = (label: string, value: number): void => {
    if (!(value >= 0 && value <= 1)) warnings.push(`${label} (${value}) should be within 0–1`);
  };
  const nonNegative = (label: string, value: number): void => {
    if (!(value >= 0)) warnings.push(`${label} (${value}) should be ≥ 0`);
  };
  bounded("confidenceThreshold", config.confidenceThreshold);
  bounded("budget.softRatio", config.budget.softRatio);
  bounded("budget.hardRatio", config.budget.hardRatio);
  if (config.budget.softRatio > config.budget.hardRatio) {
    warnings.push(
      `budget.softRatio (${config.budget.softRatio}) exceeds budget.hardRatio (${config.budget.hardRatio}) — downgrade and force thresholds fire in the wrong order`,
    );
  }
  nonNegative("timeoutMs", config.timeoutMs);
  nonNegative("minPromptChars", config.minPromptChars);
  nonNegative("historyTurns", config.historyTurns);
  if (config.budget.dailyUsd !== undefined) nonNegative("budget.dailyUsd", config.budget.dailyUsd);
  if (config.budget.monthlyUsd !== undefined) nonNegative("budget.monthlyUsd", config.budget.monthlyUsd);
  nonNegative("cache.deadband", config.cache.deadband);
  nonNegative("cache.maxPenaltyUsd", config.cache.maxPenaltyUsd);
  nonNegative("cache.bypassTierDelta", config.cache.bypassTierDelta);
  return warnings;
}

export interface ConfigLoadResult {
  config: JevRouterConfig;
  /** Validation problems found while loading; empty when clean. */
  warnings: string[];
  /** Env variables that overrode a value, in application order. */
  envOverrides: string[];
}

/**
 * Pure resolution core: defaults → config patch → env, with validation.
 * `patch` is the already-parsed config.json content (or undefined for none).
 */
export function resolveConfig(patch: unknown, env: EnvSource = process.env): ConfigLoadResult {
  // `useDefaultModels: false` (file or env) means "bring your own models":
  // start from empty chains so the built-ins are not available as a base or as
  // fallback. The env value is consulted early because it selects the base;
  // applyEnvOverrides re-applies (and re-validates) it later.
  const envUseDefaultRaw = env.JEV_ROUTER_USE_DEFAULT_MODELS;
  const envUseDefault =
    envUseDefaultRaw === undefined || envUseDefaultRaw.trim() === "" ? undefined : parseBool(envUseDefaultRaw);
  const patchUseDefault = asRecord(patch).useDefaultModels;
  const useDefaults =
    envUseDefault ?? (typeof patchUseDefault === "boolean" ? patchUseDefault : DEFAULT_CONFIG.useDefaultModels);

  let config = useDefaults
    ? { ...DEFAULT_CONFIG }
    : { ...DEFAULT_CONFIG, routes: emptyChains(), kindModels: {} };

  if (patch) config = merge(config, patch);

  const envResult = applyEnvOverrides(config, env);
  return {
    config: envResult.config,
    warnings: [...envResult.warnings, ...invariantWarnings(envResult.config)],
    envOverrides: envResult.applied,
  };
}

/** resolveConfig against the real config file and process.env. */
export function loadConfigDetailed(): ConfigLoadResult {
  const patch = readJson(join(homedir(), CONFIG_DIR_NAME, "agent", "pi-jev-model-router", "config.json"));
  return resolveConfig(patch, process.env);
}

/** Convenience: the resolved config only (warnings in loadConfigDetailed). */
export function loadConfig(): JevRouterConfig {
  return loadConfigDetailed().config;
}

function emptyChains(): Record<Tier, RouteChain> {
  return { quick: [], standard: [], high: [], premium: [] };
}

export interface ApiKeyResolution {
  key: string;
  source: "environment" | "stored";
}

/**
 * Read the key pi-typesafe stored at `<agentDir>/pi-typesafe/auth.json`
 * (`agentDir` = `PI_CODING_AGENT_DIR` or `~/.pi/agent`). Rejected unless the
 * file is private (mode `& 0o077 === 0` off Windows) and the token is 16–512
 * visible ASCII characters with no whitespace — pi-typesafe's own rules.
 * Never logged; failure yields "no key", never a fallback value.
 */
function readStoredApiKey(): string | undefined {
  const configuredDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir =
    typeof configuredDir === "string" && configuredDir.trim()
      ? configuredDir
      : join(homedir(), CONFIG_DIR_NAME, "agent");
  try {
    const file = join(agentDir, "pi-typesafe", "auth.json");
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) return undefined;
    const token = asRecord(JSON.parse(readFileSync(file, "utf8"))).apiKey;
    if (typeof token !== "string" || token.length < 16 || token.length > 512) return undefined;
    if (!/^[\x21-\x7e]+$/.test(token)) return undefined;
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Key resolution (env-first, stored file as fallback — the same order
 * pi-typesafe uses). Returns undefined when neither source yields a key.
 */
export function resolveApiKey(): ApiKeyResolution | undefined {
  const env = process.env[API_KEY_ENV]?.trim();
  if (env) return { key: env, source: "environment" };
  const stored = readStoredApiKey();
  if (stored) return { key: stored, source: "stored" };
  return undefined;
}

/** Human-readable key-source label for status output. Never returns a key value. */
export function apiKeySourceLabel(source: "environment" | "stored"): string {
  return source === "environment" ? API_KEY_ENV : "/typesafe login";
}

export const TASK_KINDS: Record<string, string> = {
  plan: "Deciding what to build, sequencing work, or designing an approach before editing",
  implement: "Writing or changing code, scripts, or configuration to produce a concrete result",
  write: "Producing prose, documentation, comments, or other non-code content from scratch",
  debug: "Diagnosing a failure, error, or unexpected behavior and finding its root cause",
  refactor: "Restructuring existing code without changing intended behavior",
  review: "Auditing code, a diff, a document, or a plan for problems and risks",
  research: "Searching, reading, and synthesizing external information or unfamiliar APIs",
  explain: "Answering a question or explaining how something works",
  operate: "Running commands, tooling, git, deploys, or environment setup",
  chat: "Small talk, acknowledgements, or a request with no real work attached",
};