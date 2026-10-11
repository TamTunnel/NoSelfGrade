import { describe, expect, it, vi } from "vitest";
import type { ReviewerProvider } from "../src/providers/types.js";
import { DispatchError, dispatchReview } from "../src/dispatch.js";
import { parseBuilderDeclaration } from "../src/builder.js";

function fakeProvider(name: string, text: string): ReviewerProvider {
  return {
    name,
    review: vi.fn(async (req) => `${text} [model=${req.model} base=${req.baseUrl ?? "default"}]`),
  };
}

describe("dispatchReview", () => {
  it("runs the disjoint reviewer and returns raw text with fingerprinted key", async () => {
    const provider = fakeProvider("anthropic", "raw review");
    const result = await dispatchReview({
      builder: parseBuilderDeclaration({ model: "gpt-4o" }),
      bindings: new Map([
        ["anthropic", { provider, apiKey: "sk-ant-abc", model: "claude-sonnet-4-5" }],
      ]),
      prompt: "review this diff",
      timeoutMs: 5000,
    });
    expect(result.reviewers).toHaveLength(1);
    const [info] = result.reviewers;
    expect(info.provider).toBe("anthropic");
    expect(info.model).toBe("claude-sonnet-4-5");
    expect(info.apiKeyFingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(info.apiKeyFingerprint).not.toContain("sk-ant-abc");
    expect(result.rawResponses).toHaveLength(1);
    expect(result.rawResponses[0].text).toContain("raw review");
    expect(provider.review).toHaveBeenCalledTimes(1);
    const req = (provider.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.prompt).toBe("review this diff");
    expect(req.apiKey).toBe("sk-ant-abc");
    expect(req.timeoutMs).toBe(5000);
  });

  it("fails naming the env var when the selected reviewer has no bound key", async () => {
    const provider = fakeProvider("deepseek", "ok");
    const err = await dispatchReview({
      builder: parseBuilderDeclaration({ model: "claude-sonnet-4-5" }),
      bindings: new Map([
        // single mode selects openai (first disjoint candidate); it has no binding
        ["deepseek", { provider, apiKey: "sk-deepseek-x", model: "deepseek-reasoner" }],
      ]),
      prompt: "p",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as Error).message).toContain("OPENAI_API_KEY");
  });

  it("jury mode runs up to 3 distinct providers concurrently", async () => {
    const a = fakeProvider("anthropic", "A");
    const o = fakeProvider("openai", "B");
    const x = fakeProvider("xai", "C");
    const d = fakeProvider("deepseek", "D");
    const result = await dispatchReview({
      builder: parseBuilderDeclaration({ model: "gemini-2.5-pro" }),
      jury: true,
      bindings: new Map([
        ["anthropic", { provider: a, apiKey: "k1", model: "claude-sonnet-4-5" }],
        ["openai", { provider: o, apiKey: "k2", model: "gpt-5" }],
        ["xai", { provider: x, apiKey: "k3", model: "grok-4", baseUrl: "https://api.x.ai/v1" }],
        ["deepseek", { provider: d, apiKey: "k4", model: "deepseek-reasoner" }],
      ]),
      prompt: "p",
    });
    expect(result.reviewers).toHaveLength(3);
    const providers = result.reviewers.map((r) => r.provider);
    expect(new Set(providers).size).toBe(3);
    expect(a.review).toHaveBeenCalledTimes(1);
    expect(o.review).toHaveBeenCalledTimes(1);
  });

  it("throws DispatchError when no disjoint reviewer exists at all", async () => {
    const err = await dispatchReview({
      builder: { model: "gpt-4o", provider: "openai" },
      candidates: [{ provider: "openai", model: "gpt-5", family: "gpt" }],
      bindings: new Map(),
      prompt: "p",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DispatchError);
  });
});
