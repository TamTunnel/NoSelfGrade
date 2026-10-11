import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  apiKeyFingerprint,
  getProvider,
} from "../src/providers/types.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { openaiProvider } from "../src/providers/openai.js";
import { openaiCompatibleProvider } from "../src/providers/openai-compatible.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

describe("getProvider", () => {
  it("resolves all three transports", () => {
    expect(getProvider("anthropic")).toBe(anthropicProvider);
    expect(getProvider("openai")).toBe(openaiProvider);
    expect(getProvider("openai-compatible")).toBe(openaiCompatibleProvider);
  });

  it("rejects unknown transports", () => {
    expect(() => getProvider("cohere" as never)).toThrow(ProviderError);
  });
});

describe("apiKeyFingerprint", () => {
  it("is stable, prefixed, and never reveals the key", () => {
    const key = "sk-ant-test-key-12345";
    const fp = apiKeyFingerprint(key);
    expect(fp).toBe(apiKeyFingerprint(key));
    expect(fp).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(fp).not.toContain(key);
  });

  it("differs between keys", () => {
    expect(apiKeyFingerprint("a")).not.toBe(apiKeyFingerprint("b"));
  });
});

describe("anthropic provider", () => {
  it("sends x-api-key header and concatenates text blocks", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      expect(init.headers["x-api-key"]).toBe("sk-test");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("claude-sonnet-4-5");
      expect(body.max_tokens).toBe(4096);
      expect(body.messages).toEqual([{ role: "user", content: "review this" }]);
      expect(_url).toBe("https://api.anthropic.com/v1/messages");
      return jsonResponse({
        content: [
          { type: "text", text: "hello " },
          { type: "tool_use", name: "x" },
          { type: "text", text: "world" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = await anthropicProvider.review({
      model: "claude-sonnet-4-5",
      prompt: "review this",
      apiKey: "sk-test",
      timeoutMs: 5000,
    });
    expect(text).toBe("hello world");
  });

  it("honors a custom baseUrl", async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await anthropicProvider.review({
      model: "m",
      prompt: "p",
      apiKey: "k",
      timeoutMs: 5000,
      baseUrl: "https://proxy.example.com/",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example.com/v1/messages");
  });
});

describe("openai provider", () => {
  it("sends Bearer auth and returns message content", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      expect(init.headers["authorization"]).toBe("Bearer sk-test");
      expect(_url).toBe("https://api.openai.com/v1/chat/completions");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("gpt-5");
      expect(body.messages).toEqual([{ role: "user", content: "review this" }]);
      return jsonResponse({ choices: [{ message: { content: "looks fine" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = await openaiProvider.review({
      model: "gpt-5",
      prompt: "review this",
      apiKey: "sk-test",
      timeoutMs: 5000,
    });
    expect(text).toBe("looks fine");
  });
});

describe("openai-compatible provider", () => {
  it("throws when baseUrl is missing", async () => {
    await expect(
      openaiCompatibleProvider.review({ model: "m", prompt: "p", apiKey: "k", timeoutMs: 1000 }),
    ).rejects.toThrow(ProviderError);
  });

  it("posts to <baseUrl>/chat/completions", async () => {
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      expect(init.headers["authorization"]).toBe("Bearer sk-test");
      return jsonResponse({ choices: [{ message: { content: "deep review" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = await openaiCompatibleProvider.review({
      model: "deepseek-reasoner",
      prompt: "p",
      apiKey: "sk-test",
      timeoutMs: 5000,
      baseUrl: "https://api.deepseek.com/v1/",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(text).toBe("deep review");
  });
});

describe("timeout and error handling", () => {
  it("aborts a never-resolving fetch and throws ProviderError", async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      openaiProvider.review({ model: "m", prompt: "p", apiKey: "k", timeoutMs: 50 }),
    ).rejects.toThrow(ProviderError);
  });

  it("wraps network failures in ProviderError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const err = await openaiProvider
      .review({ model: "m", prompt: "p", apiKey: "k", timeoutMs: 5000 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.provider).toBe("openai");
  });

  it("ProviderError on 401 includes status but never the key", async () => {
    const secret = "sk-ant-SUPER-SECRET-KEY-999";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid key"}' })),
    );
    const err = await anthropicProvider
      .review({ model: "m", prompt: "p", apiKey: secret, timeoutMs: 5000 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(401);
    expect((err as ProviderError).provider).toBe("anthropic");
    expect(String(err)).not.toContain(secret);
    expect((err as ProviderError).bodySnippet).not.toContain(secret);
    expect((err as ProviderError).bodySnippet).toContain("invalid key");
  });
});
