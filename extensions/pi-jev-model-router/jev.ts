import type { JevRouterConfig, ThinkingLevel } from "./config";
import { TASK_KINDS, THINKING_LEVELS } from "./config";

/** The one URL any key or payload can ever reach. Hardcoded on purpose. */
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * Typed judgments asked of Jev for a single incoming request.
 *
 * Design note: Jev judges the *task* (what it is, how hard it is, how much
 * capability it deserves). Code judges *budget* (what we can afford right now).
 * Keeping those separate means the budget policy can change without invalidating
 * the judgment, and the judgment stays a pure semantic read of the request.
 */

export interface RouteAnalysis {
  kind: string;
  kindConfidence: number;
  kindProbabilities: Record<string, number>;
  /** Probability-weighted 0..3 position on the complexity rubric. */
  complexity: number;
  complexityConfidence: number;
  /** Probability-weighted 0..3 position on "capability this deserves". */
  budgetIntensity: number;
  budgetIntensityConfidence: number;
  /** Probability this request needs extended reasoning rather than recall/short edits. */
  deepReasoning: number;
  /**
   * Raw answer to the 5th question: how deep should this task think?
   * Undefined when the server omits or mangles it → the decision layer falls
   * back to the demand ladder, then to the tier static default.
   */
  thinkingLevel?: ThinkingLevel;
  /** Jev's confidence in the thinking-level choice, when provided. */
  thinkingConfidence?: number;
  latencyMs: number;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Only fields that ever leave this process. Model, context size and spend are
 * deliberately absent: buildState() is the payload whitelist (privacy: Jev
 * receives the request and an optional excerpt, nothing else).
 */
export interface ClassifyInput {
  prompt: string;
  history?: string;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

function buildState(input: ClassifyInput): Record<string, unknown> {
  return {
    request: input.prompt,
    conversation_excerpt: input.history?.slice(-4000) ?? null,
  };
}

/** The question set (5 questions, parallel server-side). Exported for the A/B latency probe. */
export function buildQuestions(): Record<string, unknown> {
  return {
    task_kind: {
      type: "choice",
      instructions:
        "Which single kind of work does `request` ask for? Judge the work the user wants done, not the topic they mention. Read `conversation_excerpt` when the request is a short follow-up that only makes sense in context. Pick the closest kind even when the request is ambiguous.",
      criteria: TASK_KINDS,
    },
    complexity: {
      type: "score",
      instructions:
        "How hard is `request` to do well, judged only on the work itself? Use the conversation excerpt to judge scope. Ignore how much any model costs.",
      criteria: [
        "Trivial: one obvious step, no design decisions, answer is known or mechanical",
        "Moderate: a few dependent steps using familiar patterns, little ambiguity",
        "Complex: multiple files or interacting constraints, real tradeoffs to weigh",
        "Architectural: cross-cutting design, high stakes, long horizon, easy to get subtly wrong",
      ],
    },
    capability_deserved: {
      type: "score",
      instructions:
        "Setting price aside entirely, how much model capability does this request deserve to get a good outcome? Judge by stakes, difficulty, and how much a stronger model would measurably improve the result.",
      criteria: [
        "Minimal: any fast small model answers this just as well",
        "Standard: a competent mid-tier model is enough",
        "High: a strong frontier model materially improves the outcome",
        "Maximum: correctness matters more than cost; use the best available",
      ],
    },
    needs_deep_reasoning: {
      type: "noul",
      instructions:
        "Does answering `request` well require extended multi-step reasoning (algorithm design, subtle debugging, proof, careful long-horizon planning) rather than recall, lookup, or a short direct edit?",
      criteria: {
        true: "The work hinges on reasoning through non-obvious steps or edge cases",
        false: "The work is recall, lookup, formatting, or a short direct change",
      },
    },
    thinking_level: {
      type: "choice",
      instructions:
        "Judging only the work `request` asks for: how much extended pre-answer thinking (reasoning before replying) does a good outcome genuinely deserve? Ignore which model will answer, what it costs, and how the reply will be delivered. Pick the deepest level the task actually needs, but never escalate for recall, lookup, formatting, or short direct edits.",
      criteria: {
        off: "No pre-answer reasoning needed: greetings, lookups, formatting, mechanical rewrites",
        minimal: "A quick sanity pass: short answers, simple one-step edits, routine commands",
        low: "Light reasoning: a few dependent steps, straightforward debugging or explanation",
        medium: "Real reasoning: multi-file changes, design tradeoffs, careful root-cause analysis",
        high: "Deep extended reasoning: architecture, subtle debugging, long-horizon planning",
        xhigh: "Exceptionally hard: novel algorithms, cross-cutting high-stakes design, proof-like work",
        max: "Maximum deliberation: correctness is critical and the task is genuinely frontier-hard",
      },
    },
  };
}

/**
 * Wash a remote-controlled string before it is echoed to the terminal, an
 * entry, or the LLM: printable ASCII only, capped at 300 characters.
 */
export function sanitizeRemote(s: string): string {
  return s.slice(0, 300).replace(/[^\x20-\x7e]/g, "?");
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseAnalysis(payload: unknown, latencyMs: number): RouteAnalysis {
  const root = payload as { answers?: Record<string, any>; usage?: { input_tokens?: number; output_tokens?: number } };
  const answers = root.answers ?? {};
  const kind = answers.task_kind ?? {};
  const complexity = answers.complexity ?? {};
  const capability = answers.capability_deserved ?? {};
  const reasoning = answers.needs_deep_reasoning ?? {};
  const thinking = answers.thinking_level ?? {};

  const chosenKind = typeof kind.choice === "string" ? kind.choice : "chat";
  if (!Object.hasOwn(TASK_KINDS, chosenKind)) {
    throw new JevError(`Jev returned an unknown task kind: ${sanitizeRemote(String(chosenKind))}`);
  }

  return {
    kind: chosenKind,
    kindConfidence: num(kind.confidence) ?? 0,
    kindProbabilities: (kind.probabilities ?? {}) as Record<string, number>,
    complexity: num(complexity.score) ?? 1,
    complexityConfidence: num(complexity.confidence) ?? 0,
    budgetIntensity: num(capability.score) ?? 1,
    budgetIntensityConfidence: num(capability.confidence) ?? 0,
    deepReasoning: num(reasoning.noul) ?? num(reasoning.noul_score) ?? 0,
    // A missing/unknown 5th answer is not an error: resolveThinking() falls
    // back to the demand ladder, then to the tier static default.
    thinkingLevel:
      typeof thinking.choice === "string" && (THINKING_LEVELS as readonly string[]).includes(thinking.choice)
        ? (thinking.choice as ThinkingLevel)
        : undefined,
    thinkingConfidence: num(thinking.confidence),
    latencyMs,
    usage:
      root.usage && num(root.usage.input_tokens) !== undefined
        ? { input_tokens: root.usage.input_tokens ?? 0, output_tokens: root.usage.output_tokens ?? 0 }
        : undefined,
  };
}

async function postWithRetry(
  config: JevRouterConfig,
  apiKey: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw new JevError("aborted");
    try {
      const res = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (res.status === 429 || res.status === 529) {
        throw new JevError(`TypeSafe overloaded (${res.status})`, res.status);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new JevError(`TypeSafe ${res.status}: ${sanitizeRemote(detail)}`, res.status);
      }
      return await res.json();
    } catch (error) {
      // fetch()/res.json() failures can carry response bytes in their message.
      // Wash only that text: error class, status, retry and fail-open handling below are untouched.
      if (error instanceof Error && !(error instanceof JevError)) {
        // DOMException (timeout/abort) has a readonly `message` accessor, so
        // assignment throws in strict mode. Wash is best-effort; keep the rest
        // of the retry/fail-open flow untouched either way.
        try {
          error.message = sanitizeRemote(error.message);
        } catch {
          // readonly message: leave the original text (fixed strings only for
          // abort/timeouts, which the /abort/i suppression already handles).
        }
      }
      lastError = error;
      if (error instanceof JevError && error.status !== 429 && error.status !== 529) throw error;
      if (signal.aborted) throw new JevError("aborted");
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new JevError("TypeSafe request failed");
}

/** Run one Jev evaluation (5 questions, parallel server-side) in one HTTP round trip. */
export async function classifyRequest(
  input: ClassifyInput,
  config: JevRouterConfig,
  apiKey: string,
  externalSignal?: AbortSignal,
): Promise<RouteAnalysis> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  const started = Date.now();
  const payload = await postWithRetry(
    config,
    apiKey,
    { state: buildState(input), model: config.jevModel, questions: buildQuestions() },
    signal,
  );
  return parseAnalysis(payload, Date.now() - started);
}