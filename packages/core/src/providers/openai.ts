/**
 * OpenAI Chat Completions API transport.
 */

import type { ReviewerProvider, ReviewRequest } from "./types.js";
import { ProviderError, postJson } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com";

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
}

export const openaiProvider: ReviewerProvider = {
  name: "openai",

  async review(req: ReviewRequest): Promise<string> {
    const base = (req.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const data = (await postJson(
      this.name,
      `${base}/v1/chat/completions`,
      {
        authorization: `Bearer ${req.apiKey}`,
        "content-type": "application/json",
      },
      {
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        max_tokens: 4096,
      },
      req.timeoutMs,
    )) as ChatCompletionsResponse;

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new ProviderError(this.name, `${this.name} returned no message content`);
    }
    return content;
  },
};
