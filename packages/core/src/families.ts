/**
 * Curated model → { family, provider } table. This is the semantic core of
 * the independence mechanism: the dispatcher excludes every reviewer whose
 * family OR provider intersects the declared builder's.
 *
 * Rules for this table:
 * - family is the training-lineage family, NOT the serving vendor. A model
 *   distilled from GPT-4 is "gpt" family no matter who serves it.
 * - provider is who you call — the authenticated API endpoint the reviewer
 *   request goes to. This is the enforceable half of the guarantee.
 * - Unknown models fail closed in builder.ts until added here (or the user
 *   passes --allow-unknown-model explicitly).
 *
 * Model IDs are best-effort as of 2026; keep this table current via
 * contributor PRs as providers ship new models.
 */

import type { FamilyEntry } from "./types.js";

export const FAMILY_TABLE: FamilyEntry[] = [
  // ---- Anthropic / Claude ----
  { model: "claude-opus-4-6", family: "claude", provider: "anthropic" },
  { model: "claude-sonnet-4-5", family: "claude", provider: "anthropic" },
  { model: "claude-haiku-4-5", family: "claude", provider: "anthropic" },
  { model: "claude-opus-4-1", family: "claude", provider: "anthropic" },
  { model: "claude-sonnet-4-0", family: "claude", provider: "anthropic" },

  // ---- OpenAI / GPT ----
  { model: "gpt-5", family: "gpt", provider: "openai" },
  { model: "gpt-5-mini", family: "gpt", provider: "openai" },
  { model: "gpt-5-nano", family: "gpt", provider: "openai" },
  { model: "gpt-4o", family: "gpt", provider: "openai" },
  { model: "gpt-4o-mini", family: "gpt", provider: "openai" },
  { model: "o3", family: "gpt", provider: "openai", notes: "Reasoning model; same training lineage as GPT." },
  { model: "o4-mini", family: "gpt", provider: "openai", notes: "Reasoning model; same training lineage as GPT." },

  // ---- xAI / Grok ----
  { model: "grok-4", family: "grok", provider: "xai" },
  { model: "grok-3", family: "grok", provider: "xai" },
  { model: "grok-code-fast-1", family: "grok", provider: "xai", notes: "Code-specialized Grok." },

  // ---- Google / Gemini ----
  { model: "gemini-2.5-pro", family: "gemini", provider: "google" },
  { model: "gemini-2.5-flash", family: "gemini", provider: "google" },
  { model: "gemini-2.5-flash-lite", family: "gemini", provider: "google" },

  // ---- Meta / Llama (family "llama" regardless of serving vendor) ----
  { model: "meta-llama/llama-4-maverick-17b-128e-instruct", family: "llama", provider: "meta" },
  { model: "meta-llama/llama-4-scout-17b-16e-instruct", family: "llama", provider: "meta" },
  {
    model: "meta-llama/llama-3.3-70b-instruct",
    family: "llama",
    provider: "together",
    notes: "Distilled from Llama 3.1 405B; llama family regardless of serving vendor.",
  },
  {
    model: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    family: "llama",
    provider: "together",
    notes: "Third-party serving of a Meta model; family stays llama.",
  },

  // ---- DeepSeek ----
  { model: "deepseek-chat", family: "deepseek", provider: "deepseek" },
  { model: "deepseek-reasoner", family: "deepseek", provider: "deepseek", notes: "R1-class reasoning model." },
  {
    model: "deepseek-ai/DeepSeek-V3",
    family: "deepseek",
    provider: "together",
    notes: "Third-party serving of DeepSeek V3; family stays deepseek.",
  },

  // ---- Mistral ----
  { model: "mistral-large-latest", family: "mistral", provider: "mistral" },
  { model: "mistral-small-latest", family: "mistral", provider: "mistral" },
  { model: "codestral-latest", family: "mistral", provider: "mistral", notes: "Code-specialized Mistral." },

  // ---- Alibaba / Qwen ----
  { model: "qwen-max", family: "qwen", provider: "alibaba" },
  { model: "qwen3-coder-plus", family: "qwen", provider: "alibaba", notes: "Code-specialized Qwen." },
  {
    model: "Qwen/Qwen3-235B-A22B",
    family: "qwen",
    provider: "together",
    notes: "Third-party serving of Qwen3; family stays qwen.",
  },
];

/**
 * Look up a model id: exact match first, then case-insensitive.
 * Returns undefined for unknown models (callers fail closed).
 */
export function lookupModel(modelId: string): FamilyEntry | undefined {
  const exact = FAMILY_TABLE.find((e) => e.model === modelId);
  if (exact) return exact;
  const lower = modelId.toLowerCase();
  return FAMILY_TABLE.find((e) => e.model.toLowerCase() === lower);
}

/** All table entries (a copy — the table itself is immutable). */
export function listModels(): FamilyEntry[] {
  return [...FAMILY_TABLE];
}
