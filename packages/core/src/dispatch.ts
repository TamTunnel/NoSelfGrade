/**
 * Reviewer selection + invocation.
 *
 * Selection enforces the independence mechanism: every chosen reviewer is
 * disjoint from the DECLARED builder in BOTH family and provider.
 * Family-disjointness is the semantic guarantee; provider-disjointness is
 * the enforceable one (we call the provider's authenticated API ourselves).
 *
 * Invocation is deliberately thin: providers return raw text, and JSON
 * parsing / repair happens in the caller (findings.ts), never here.
 */

import type { BuilderDeclaration, ReviewerInfo } from "./types.js";
import type { ProviderTransport, ReviewerProvider } from "./providers/types.js";
import { apiKeyFingerprint } from "./providers/types.js";
import { lookupModel } from "./families.js";

/** A reviewer's identity: who serves it and which model lineage it is. */
export interface ReviewerCandidate {
  /** Provider identity, e.g. "anthropic", "google" — used for disjointness checks. */
  provider: string;
  /** Reviewer model id, e.g. "claude-sonnet-4-5". */
  model: string;
  /** Model family — must differ from the builder's. */
  family: string;
  /** Which transport to call; inferred from provider identity when omitted. */
  transport?: ProviderTransport;
  /** Required for openai-compatible transports. */
  baseUrl?: string;
}

/** How to actually invoke a selected reviewer. */
export interface ProviderBinding {
  provider: ReviewerProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

/**
 * Provider identity → env var holding its API key. The CLI builds bindings
 * from these; the "no keys" error below points at exactly the vars that
 * would unblock the run.
 */
export const REVIEW_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

/**
 * Default reviewer pool: one strong reviewer per provider. Transports and
 * base URLs are explicit — google/xai/deepseek/mistral are reached through
 * their OpenAI-compatible endpoints:
 * - google: https://generativelanguage.googleapis.com/v1beta/openai/
 * - xai: https://api.x.ai/v1
 * - deepseek: https://api.deepseek.com/v1
 * - mistral: https://api.mistral.ai/v1
 */
export const DEFAULT_REVIEWERS: ReviewerCandidate[] = [
  { provider: "anthropic", model: "claude-sonnet-4-5", family: "claude", transport: "anthropic" },
  { provider: "openai", model: "gpt-5", family: "gpt", transport: "openai" },
  {
    provider: "google",
    model: "gemini-2.5-pro",
    family: "gemini",
    transport: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  },
  {
    provider: "xai",
    model: "grok-4",
    family: "grok",
    transport: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
  },
  {
    provider: "deepseek",
    model: "deepseek-reasoner",
    family: "deepseek",
    transport: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    provider: "mistral",
    model: "mistral-large-latest",
    family: "mistral",
    transport: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
  },
];

// Fail fast if the default pool drifts out of sync with the family table.
for (const c of DEFAULT_REVIEWERS) {
  const entry = lookupModel(c.model);
  if (!entry || entry.family !== c.family) {
    throw new Error(
      `DEFAULT_REVIEWERS out of sync with families.ts: "${c.model}" ` +
        `is not tabled as family "${c.family}"`,
    );
  }
}

/** Infer the transport from provider identity when the candidate omits it. */
export function resolveTransport(candidate: ReviewerCandidate): ProviderTransport {
  if (candidate.transport) return candidate.transport;
  if (candidate.provider === "anthropic") return "anthropic";
  if (candidate.provider === "openai") return "openai";
  return "openai-compatible";
}

function builderFamilyOf(builder: BuilderDeclaration): string | undefined {
  return lookupModel(builder.model)?.family;
}

function isEligible(
  candidate: ReviewerCandidate,
  builder: BuilderDeclaration,
  builderFamily: string | undefined,
): boolean {
  if (candidate.provider === builder.provider) return false;
  if (builderFamily !== undefined && candidate.family === builderFamily) return false;
  return true;
}

function describeBuilder(builder: BuilderDeclaration, family: string | undefined): string {
  return `"${builder.model}" (provider "${builder.provider}"${family ? `, family "${family}"` : ", family unknown"})`;
}

/**
 * Select disjoint reviewer(s) for a declared builder.
 *
 * - single (jury=false): the first candidate disjoint in family AND
 *   provider, in candidate-array priority order (deterministic).
 * - jury: one candidate per distinct provider, all disjoint, up to 3.
 *
 * Throws DispatchError when nothing is eligible.
 */
export function selectReviewers(
  builder: BuilderDeclaration,
  candidates: ReviewerCandidate[],
  jury: boolean,
): ReviewerCandidate[] {
  const family = builderFamilyOf(builder);
  const eligible = candidates.filter((c) => isEligible(c, builder, family));
  if (eligible.length === 0) {
    throw new DispatchError(
      `no disjoint reviewer available for declared builder ${describeBuilder(builder, family)}: ` +
        `every candidate shares its family or provider`,
    );
  }
  if (!jury) {
    return [eligible[0]];
  }
  const seen = new Set<string>();
  const picked: ReviewerCandidate[] = [];
  for (const c of eligible) {
    if (seen.has(c.provider)) continue;
    seen.add(c.provider);
    picked.push(c);
    if (picked.length >= 3) break;
  }
  return picked;
}

export interface DispatchOptions {
  builder: BuilderDeclaration;
  jury?: boolean;
  /** Keyed by candidate provider identity (e.g. "anthropic"). */
  bindings: Map<string, ProviderBinding>;
  prompt: string;
  timeoutMs?: number;
  candidates?: ReviewerCandidate[];
}

export interface DispatchResult {
  reviewers: ReviewerInfo[];
  rawResponses: { reviewer: string; text: string }[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Select disjoint reviewers, keep only those with a bound API key, and run
 * them concurrently (Promise.all). Returns raw response text per reviewer —
 * no JSON repair here; the caller handles parsing.
 *
 * Throws DispatchError if no disjoint reviewer is selectable, or if none of
 * the selected reviewers has an API key bound (the message names the env
 * vars that would unblock the run).
 */
export async function dispatchReview(opts: DispatchOptions): Promise<DispatchResult> {
  const candidates = opts.candidates ?? DEFAULT_REVIEWERS;
  const selected = selectReviewers(opts.builder, candidates, opts.jury ?? false);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const bound = selected.flatMap((candidate) => {
    const binding = opts.bindings.get(candidate.provider);
    if (!binding || !binding.apiKey) return [];
    return [{ candidate, binding }];
  });

  if (bound.length === 0) {
    const tried = selected.map((c) => c.provider).join(", ");
    const wanted = selected
      .map((c) => REVIEW_ENV_VARS[c.provider] ?? `<API key for provider "${c.provider}">`)
      .join(", ");
    throw new DispatchError(
      `no API keys available for any disjoint reviewer (disjoint candidates: ${tried}). ` +
        `Set one of: ${wanted}.`,
    );
  }

  const results = await Promise.all(
    bound.map(async ({ candidate, binding }) => {
      const text = await binding.provider.review({
        model: binding.model,
        prompt: opts.prompt,
        apiKey: binding.apiKey,
        timeoutMs,
        baseUrl: binding.baseUrl ?? candidate.baseUrl,
      });
      return { candidate, binding, text };
    }),
  );

  return {
    reviewers: results.map(({ candidate, binding }) => ({
      provider: candidate.provider,
      model: binding.model,
      apiKeyFingerprint: apiKeyFingerprint(binding.apiKey),
    })),
    rawResponses: results.map(({ candidate, binding, text }) => ({
      reviewer: `${candidate.provider}:${binding.model}`,
      text,
    })),
  };
}
