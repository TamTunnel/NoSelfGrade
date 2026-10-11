import { describe, expect, it } from "vitest";
import { BuilderError, parseBuilderDeclaration } from "../src/builder.js";

describe("parseBuilderDeclaration", () => {
  it("infers the provider from the family table when omitted", () => {
    expect(parseBuilderDeclaration({ model: "gpt-4o" })).toEqual({
      model: "gpt-4o",
      provider: "openai",
      family: "gpt",
    });
    expect(parseBuilderDeclaration({ model: "Claude-Sonnet-4-5" })).toEqual({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      family: "claude",
    });
  });

  it("accepts an explicit provider override for a known model", () => {
    expect(parseBuilderDeclaration({ model: "gpt-4o", provider: "azure" })).toEqual({
      model: "gpt-4o",
      provider: "azure",
      family: "gpt",
    });
  });

  it("fails closed on unknown models with an actionable message", () => {
    const err = (() => {
      try {
        parseBuilderDeclaration({ model: "gpt-99-ultra" });
      } catch (e) {
        return e;
      }
      throw new Error("did not throw");
    })();
    expect(err).toBeInstanceOf(BuilderError);
    const msg = (err as Error).message;
    expect(msg).toContain("gpt-99-ultra");
    expect(msg).toContain("families.ts");
    expect(msg).toContain("--allow-unknown-model");
  });

  it("allowUnknownModel works with an explicit provider", () => {
    expect(
      parseBuilderDeclaration({
        model: "some-future-model",
        provider: "openrouter",
        allowUnknownModel: true,
      }),
        ).toEqual({ model: "some-future-model", provider: "openrouter", family: null });
  });

  it("allowUnknownModel without a provider is an error", () => {
    expect(() =>
      parseBuilderDeclaration({ model: "some-future-model", allowUnknownModel: true }),
    ).toThrow(BuilderError);
  });

  it("missing model is an error", () => {
    expect(() => parseBuilderDeclaration({})).toThrow(BuilderError);
    expect(() => parseBuilderDeclaration({ model: "   " })).toThrow(BuilderError);
    expect(() => parseBuilderDeclaration({ provider: "openai" })).toThrow(BuilderError);
  });
});
