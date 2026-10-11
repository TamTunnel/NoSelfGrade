/**
 * Anthropic Messages API transport.
 */

import type { ReviewerProvider, ReviewRequest } from "./types.js";
import { ProviderError, postJson } from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

interface TextBlock {
  type: string;
  text?: string;
}

interface MessagesResponse {
  content?: TextBlock[];
}

export const anthropicProvider: ReviewerProvider = {
  name: "anthropic",

  async review(req: ReviewRequest): Promise<string> {
    const base = (req.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const data = (await postJson(
      this.name,
      `${base}/v1/messages`,
      {
        "x-api-key": req.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      {
        model: req.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: req.prompt }],
      },
      req.timeoutMs,
    )) as MessagesResponse;

    const blocks = Array.isArray(data.content) ? data.content : [];
    const texts = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length === 0 && blocks.length > 0) {
      throw new ProviderError(this.name, `${this.name} returned no text blocks`);
    }
    return texts.join("");
  },
};
