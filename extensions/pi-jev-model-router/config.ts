import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/**
 * pi-jev-model-router config.
 *
 * Resolution order (later wins):
 *   1. DEFAULTS below
 *   2. ~/.pi/agent/pi-jev-model-router.json
 *   3. env: TYPESAFE_API_KEY / JEV_ROUTER_MODE / JEV_ROUTER_OFF
 */

/** Fixed spend-ledger path: single owner, not configurable, never a config key. */
export const STATE_FILE = join(homedir(), CONFIG_DIR_NAME, "agent", "pi-jev-model-router-state.json");
/** The only environment variable the router may read a key from. */
export const API_KEY_ENV = "TYPESAFE_API_KEY";

export type Tier = "quick" | "standard" | "high" | "premium";
export const TIERS: readonly Tier[] = ["quick", "standard", "high", "premium"] as const;

export type Mode = "auto" | "confirm" | "notify";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteTarget {
  provider: string;
  model: string;
  /** Optional thinking level pinned for this model. Clamped by pi per model. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Only used inside `kindModels`: this model may serve the kind when the
   * chosen tier is at or above `minTier`. Defaults to "quick".
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
  mode: "auto",
  useDefaultModels: true,
  jevModel: "jev-latest",
  timeoutMs: 3500,
  minPromptChars: 12,
  historyTurns: 4,
  confidenceThreshold: 0.34,
  stickiness: true,
  routes: {
    quick: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~openai/gpt-luna-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~z-ai/glm-flash-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~deepseek/deepseek-v4-flash-latest", thinkingLevel: "off" },
    ],
    standard: [
      { provider: "openrouter", model: "~deepseek/deepseek-pro-latest", thinkingLevel: "low" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", thinkingLevel: "low" },
      { provider: "openrouter", model: "~z-ai/glm-latest", thinkingLevel: "low" },
    ],
    high: [
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~x-ai/grok-latest", thinkingLevel: "medium" },
    ],
    premium: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", thinkingLevel: "high" },
      { provider: "openrouter", model: "openai/gpt-5.5", thinkingLevel: "high" },
      { provider: "openrouter", model: "~openai/gpt-astra-latest", thinkingLevel: "high" },
    ],
  },
  kindModels: {
    // Planning and design: strong long-horizon reasoners.
    plan: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", minTier: "premium" },
      { provider: "openrouter", model: "~openai/gpt-astra-latest", minTier: "premium" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "high" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
    ],
    // Implementation: coding specialists.
    implement: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k2.7-code", minTier: "standard" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    debug: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    refactor: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k2.7-code", minTier: "standard" },
    ],
    // Review and audit: strongest reviewers only.
    review: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", minTier: "high" },
      { provider: "openrouter", model: "openai/gpt-5.5", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    // Research: long-context readers.
    research: [
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k3", minTier: "standard" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "standard" },
    ],
    explain: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "quick" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
    ],
    operate: [
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "standard" },
      { provider: "openrouter", model: "~deepseek/deepseek-pro-latest", minTier: "standard" },
    ],
    chat: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "~openai/gpt-luna-latest", minTier: "quick" },
      { provider: "openrouter", model: "~z-ai/glm-flash-latest", minTier: "quick" },
    ],
    write: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "quick" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
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
    dailyUsd: undefined,
    monthlyUsd: undefined,
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
  const targets = list.filter(
    (item): item is RouteTarget =>
      Boolean(item) && typeof item === "object" && typeof (item as RouteTarget).provider === "string" && typeof (item as RouteTarget).model === "string",
  );
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

export function loadConfig(): JevRouterConfig {
  const globalPatch = readJson(join(homedir(), CONFIG_DIR_NAME, "agent", "pi-jev-model-router.json"));

  // `useDefaultModels: false` means "bring your own models": start from empty
  // chains so the built-ins are not available as a base or as fallback.
  const globalUseDefaultModels = asRecord(globalPatch).useDefaultModels;
  const useDefaults =
    typeof globalUseDefaultModels === "boolean" ? globalUseDefaultModels : DEFAULT_CONFIG.useDefaultModels;

  let config = useDefaults
    ? { ...DEFAULT_CONFIG }
    : { ...DEFAULT_CONFIG, routes: emptyChains(), kindModels: {} };

  if (globalPatch) config = merge(config, globalPatch);

  if (process.env.JEV_ROUTER_MODE) {
    const mode = process.env.JEV_ROUTER_MODE.toLowerCase();
    if (mode === "auto" || mode === "confirm" || mode === "notify") config.mode = mode;
  }
  if (process.env.JEV_ROUTER_OFF === "1" || process.env.JEV_ROUTER_OFF === "true") {
    config.enabled = false;
  }
  return config;
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