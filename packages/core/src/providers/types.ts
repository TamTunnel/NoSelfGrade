/**
 * Reviewer provider abstraction. The "AI" is HTTPS calls: each provider
 * POSTs a review prompt to an LLM API and returns the raw text.
 *
 * No SDKs, no heavy deps — direct fetch with timeout via AbortController.
 * The raw API key never appears in errors, logs, or returned data; only
 * its fingerprint (see apiKeyFingerprint) leaves this module.
 */

import { createHash } from "node:crypto";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { openaiCompatibleProvider } from "./openai-compatible.js";

/** One review invocation. */
export interface ReviewRequest {
  model: string;
  prompt: string;
  apiKey: string;
  timeoutMs: number;
  /** Override the provider's default API base URL (required for openai-compatible). */
  baseUrl?: string;
}

/** A transport that can run a review prompt against an LLM API. */
export interface ReviewerProvider {
  readonly name: string;
  /** Returns the raw response text. No JSON parsing or repair here. */
  review(req: ReviewRequest): Promise<string>;
}

/** Thrown for transport-level failures: network errors, timeouts, non-2xx. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  /** First 200 chars of the response body — never contains the API key. */
  readonly bodySnippet: string;

  constructor(provider: string, message: string, status?: number, body?: string) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.bodySnippet = body ? body.slice(0, 200) : "";
  }
}

export type ProviderTransport = "anthropic" | "openai" | "openai-compatible";

export function getProvider(name: ProviderTransport): ReviewerProvider {
  switch (name) {
    case "anthropic":
      return anthropicProvider;
    case "openai":
      return openaiProvider;
    case "openai-compatible":
      return openaiCompatibleProvider;
    default:
      throw new ProviderError(name, `unknown provider transport: ${name}`);
  }
}

/**
 * "sha256:" + first 16 hex chars of sha256(key). Recorded in the report to
 * prove which key/endpoint ran the review, without exposing the key.
 */
export function apiKeyFingerprint(key: string): string {
  return "sha256:" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/**
 * Shared POST helper: JSON body, AbortController timeout, JSON response.
 * Throws ProviderError on network failure, timeout, non-2xx, or non-JSON.
 * Never includes the API key in the error.
 */
export async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProviderError(provider, `network error calling ${provider}: ${detail}`);
  }
  clearTimeout(timer);
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new ProviderError(provider, `${provider} returned HTTP ${res.status}`, res.status, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(provider, `${provider} returned a non-JSON response`, res.status, text);
  }
}
