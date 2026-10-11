/**
 * OpenAI-compatible chat-completions transport, for providers that expose
 * the /v1/chat/completions shape at their own base URL (DeepSeek, xAI,
 * Mistral, Google's OpenAI-compatibility endpoint, …).
 *
 * baseUrl is REQUIRED — there is no default, because guessing the wrong
 * endpoint would silently send the review (and the API key) elsewhere.
 */

import type { ReviewerProvider, ReviewRequest } from "./types.js";
import { ProviderError, postJson } from "./types.js";

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
}

export const openaiCompatibleProvider: ReviewerProvider = {
  name: "openai-compatible",

  async review(req: ReviewRequest): Promise<string> {
    if (!req.baseUrl || req.baseUrl.trim().length === 0) {
      throw new ProviderError(
        this.name,
        "openai-compatible provider requires an explicit baseUrl (e.g. https://api.deepseek.com/v1)",
      );
    }
    const base = req.baseUrl.replace(/\/+$/, "");
    const data = (await postJson(
      this.name,
      `${base}/chat/completions`,
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
