/**
 * Review prompt construction.
 *
 * CRITICAL independence rule: prompts are built from the raw diff ONLY.
 * Builder identity, builder framing, and chain-of-thought are NEVER
 * included — the builder declaration is used for reviewer selection only
 * and must not appear in review context.
 */

const SCHEMA_DESCRIPTION = `{
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "file": "<path exactly as it appears in the diff>",
      "line": <new-file line number, or null if it applies to no single line>,
      "category": "correctness" | "security" | "style" | "perf",
      "confidence": <0.0 to 1.0>,
      "message": "<what is wrong and why it matters>",
      "remediation": "<how to fix it>",
      "snippet": "<exact lines quoted from the diff>"
    }
  ]
}`;

const SEVERITY_GUIDANCE = [
  "critical: an exploitable security hole or something that causes data loss or corruption.",
  "high: a likely bug — code that is wrong or will break under plausible conditions.",
  "medium: suspicious code — probably a bug or a latent issue worth investigating.",
  "low: minor issues, style nits, or small improvements.",
  "info: observations that are not problems but worth knowing about.",
].join("\n");

/**
 * Build the single-shot review prompt from the raw diff.
 * Contains no builder identity or framing — diff only.
 */
export function buildReviewPrompt(diff: string): string {
  return [
    "You are an independent code reviewer. You did not write the code below and",
    "you have no relationship with its author. Review the following unified diff",
    "on its own merits, as if you encountered it in a pull request with no",
    "other context.",
    "",
    "Report every issue you find as findings in a single JSON object with",
    "exactly this schema:",
    "",
    SCHEMA_DESCRIPTION,
    "",
    "Severity guidance:",
    SEVERITY_GUIDANCE,
    "",
    "Rules:",
    "- line must be a line number in the NEW version of the file (the '+' side",
    "  of the diff). Use null when the finding does not belong to a single line.",
    "- file must be the path exactly as it appears in the diff header.",
    "- snippet must quote the exact lines from the diff that the finding",
    "  concerns.",
    "- confidence is your estimate that the finding is a real issue, 0.0 to 1.0.",
    "- Do not report issues in unchanged (context) lines unless the change",
    "  interacts with them.",
    '- If there are no findings, return {"findings": []}.',
    "- Return ONLY the JSON object. No markdown fences, no prose, no",
    "  explanation before or after.",
    "",
    "===== BEGIN DIFF =====",
    diff,
    "===== END DIFF =====",
  ].join("\n");
}

/**
 * Build the repair prompt for a malformed reviewer response. Gives the
 * model its broken output plus the parse error and asks for corrected JSON
 * in the same schema — nothing else.
 */
export function buildRepairPrompt(brokenOutput: string, error: string): string {
  return [
    "Your previous output was not valid JSON. The parse error was:",
    "",
    error,
    "",
    "Here is the output you produced:",
    "",
    "===== BEGIN BROKEN OUTPUT =====",
    brokenOutput,
    "===== END BROKEN OUTPUT =====",
    "",
    "Return ONLY the corrected JSON in the same schema:",
    "",
    SCHEMA_DESCRIPTION,
    "",
    "No markdown fences, no prose, no explanation before or after.",
  ].join("\n");
}
