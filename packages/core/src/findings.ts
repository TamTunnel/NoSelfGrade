/**
 * Finding parsing and normalization.
 *
 * Providers return findings as JSON in a strict schema; this module is the
 * clerk that turns provider output into canonical `Finding` records. It
 * never re-judges finding correctness — it maps vocabularies, validates
 * cited line numbers against the actual diff (with ±3-line drift tolerance),
 * and dedupes near-identical findings across jury members.
 */

import type { Category, Finding, Severity } from "./types.js";
import { addedLineNumbers } from "./diff.js";

/** A finding exactly as parsed from a provider's JSON response. */
export interface RawFinding {
  severity: string;
  file: string;
  line: number | null;
  category: string;
  confidence: number;
  message: string;
  remediation?: string;
  snippet?: string;
}

/** Thrown when a reviewer's output cannot be understood as findings JSON. */
export class FindingParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingParseError";
  }
}

/** Severity synonyms providers commonly invent → canonical severity. */
const SEVERITY_SYNONYMS: Record<string, Severity> = {
  crit: "critical",
  severe: "critical",
  error: "high",
  major: "high",
  warn: "medium",
  warning: "medium",
  moderate: "medium",
  minor: "low",
  suggestion: "low",
  nit: "low",
  nitpick: "low",
  note: "info",
  informational: "info",
  info: "info",
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

/** Category synonyms → canonical category. Unknown categories default to correctness. */
const CATEGORY_SYNONYMS: Record<string, Category> = {
  bug: "correctness",
  correctness: "correctness",
  logic: "correctness",
  vulnerability: "security",
  security: "security",
  sec: "security",
  style: "style",
  readability: "style",
  performance: "perf",
  perf: "perf",
  efficiency: "perf",
};

/** Maximum line drift tolerated when resolving a cited line into the diff. */
const LINE_DRIFT_TOLERANCE = 3;
/** Jaccard similarity threshold for message near-duplicate detection. */
const JACCARD_THRESHOLD = 0.6;
/** Line distance within which two findings count as co-located for dedupe. */
const DEDUPE_LINE_WINDOW = 2;

/**
 * Extract the first JSON object from text.
 *
 * Strips markdown code fences first (```json ... ``` / ``` ... ```),
 * then finds the first `{` and matches braces while respecting string
 * literals. Throws FindingParseError when no valid JSON object is found.
 */
export function extractJson(text: string): unknown {
  // Strip fenced code blocks; prefer the inner content of the first fence.
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);
  const candidate = fenceMatch ? fenceMatch[1].trim() : text;

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new FindingParseError(
      "No JSON object found in reviewer output (no '{' present). " +
        "The reviewer must return a single JSON object with a \"findings\" array.",
    );
  }

  // Brace-match from the first '{', respecting string literals and escapes.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) {
    throw new FindingParseError(
      "Unbalanced braces in reviewer output: found '{' with no matching '}'. " +
        "The reviewer must return one complete JSON object.",
    );
  }

  const jsonText = candidate.slice(start, end);
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (err) {
    throw new FindingParseError(
      `Reviewer output is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        "The reviewer must return a single JSON object matching the findings schema.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a reviewer's raw text response into validated raw findings.
 * Throws FindingParseError with an actionable message when the response
 * cannot be understood.
 */
export function parseReviewResponse(text: string, reviewerModel: string): RawFinding[] {
  const parsed = extractJson(text);
  if (!isRecord(parsed)) {
    throw new FindingParseError(
      `Reviewer ${reviewerModel} returned a top-level ${Array.isArray(parsed) ? "array" : typeof parsed}, ` +
        `expected an object with a "findings" array.`,
    );
  }
  const findings = parsed["findings"];
  if (!Array.isArray(findings)) {
    throw new FindingParseError(
      `Reviewer ${reviewerModel} output is missing the "findings" array ` +
        `(got ${findings === undefined ? "no findings key" : typeof findings}). ` +
        `Expected {"findings": [...]}.`,
    );
  }

  return findings.map((item, index) => {
    const where = `findings[${index}] from ${reviewerModel}`;
    if (!isRecord(item)) {
      throw new FindingParseError(`Expected an object at ${where}, got ${typeof item}.`);
    }
    const requireString = (key: string): string => {
      const value = item[key];
      if (typeof value !== "string") {
        throw new FindingParseError(
          `Expected string for "${key}" at ${where}, got ${value === undefined ? "missing" : typeof value}.`,
        );
      }
      return value;
    };

    const line = item["line"];
    if (line !== undefined && line !== null && (typeof line !== "number" || !Number.isInteger(line))) {
      throw new FindingParseError(
        `Expected integer or null for "line" at ${where}, got ${JSON.stringify(line)}.`,
      );
    }

    const confidence = item["confidence"];
    if (confidence !== undefined && typeof confidence !== "number") {
      throw new FindingParseError(
        `Expected number for "confidence" at ${where}, got ${typeof confidence}.`,
      );
    }

    const remediation = item["remediation"];
    if (remediation !== undefined && typeof remediation !== "string") {
      throw new FindingParseError(
        `Expected string for "remediation" at ${where}, got ${typeof remediation}.`,
      );
    }
    const snippet = item["snippet"];
    if (snippet !== undefined && typeof snippet !== "string") {
      throw new FindingParseError(
        `Expected string for "snippet" at ${where}, got ${typeof snippet}.`,
      );
    }

    return {
      severity: requireString("severity"),
      file: requireString("file"),
      line: line === undefined ? null : (line as number | null),
      category: requireString("category"),
      confidence: typeof confidence === "number" ? confidence : 0.5,
      message: requireString("message"),
      remediation: typeof remediation === "string" ? remediation : undefined,
      snippet: typeof snippet === "string" ? snippet : undefined,
    } satisfies RawFinding;
  });
}

function normalizeSeverity(raw: string): Severity | null {
  return SEVERITY_SYNONYMS[raw.trim().toLowerCase()] ?? null;
}

function normalizeCategory(raw: string): Category {
  return CATEGORY_SYNONYMS[raw.trim().toLowerCase()] ?? "correctness";
}

function normalizeConfidence(raw: number): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return 0.5;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Resolve a cited line against the diff's added lines.
 * Returns the cited line when exact, the nearest line within ±3 when drifted,
 * or null when the location cannot be confirmed (never lies about location).
 */
function resolveLine(
  file: string,
  line: number | null,
  added: Map<string, Set<number>>,
): number | null {
  if (line === null || !Number.isInteger(line) || line <= 0) return null;
  const addedLines = added.get(file);
  if (!addedLines) return null; // File not in the diff at all.
  if (addedLines.has(line)) return line;
  for (let offset = 1; offset <= LINE_DRIFT_TOLERANCE; offset++) {
    if (addedLines.has(line + offset)) return line + offset;
    if (addedLines.has(line - offset)) return line - offset;
  }
  return null;
}

/**
 * Normalize raw findings into canonical Finding records.
 *
 * - Severity synonyms are mapped; unknown severities drop the finding
 *   (the finding fails, never the run).
 * - Unknown categories default to "correctness".
 * - Confidence is clamped to 0..1; non-numbers become 0.5.
 * - Cited lines are validated against the diff's added lines with ±3
 *   drift tolerance; unresolvable lines become null rather than lying.
 * - Findings with an empty message are dropped.
 */
export function normalizeFindings(
  raw: RawFinding[],
  reviewerModel: string,
  diff: string,
): Finding[] {
  const added = addedLineNumbers(diff);
  const findings: Finding[] = [];
  for (const r of raw) {
    const severity = normalizeSeverity(r.severity);
    if (!severity) continue; // Unknown severity: drop the finding, not the run.

    const message = r.message.trim();
    if (message === "") continue; // Empty message: nothing actionable.

    const line =
      typeof r.line === "number" && Number.isInteger(r.line) && r.line > 0
        ? resolveLine(r.file, r.line, added)
        : null;

    const finding: Finding = {
      severity,
      file: r.file,
      line,
      category: normalizeCategory(r.category),
      confidence: normalizeConfidence(r.confidence),
      message,
      reviewer: reviewerModel,
    };
    if (r.remediation !== undefined && r.remediation.trim() !== "") {
      finding.remediation = r.remediation.trim();
    }
    findings.push(finding);
  }
  return findings;
}

// --- Dedupe ---

function normalizeMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/g, " ").trim();
}

function wordSet(message: string): Set<string> {
  return new Set(normalizeMessage(message).split(" ").filter((w) => w.length > 0));
}

/** True when two messages are near-duplicates. */
function messagesSimilar(a: string, b: string): boolean {
  const na = normalizeMessage(a);
  const nb = normalizeMessage(b);
  if (na === "" || nb === "") return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const sa = wordSet(a);
  const sb = wordSet(b);
  let intersection = 0;
  for (const w of sa) {
    if (sb.has(w)) intersection += 1;
  }
  const union = sa.size + sb.size - intersection;
  if (union === 0) return false;
  return intersection / union >= JACCARD_THRESHOLD;
}

/** True when two line numbers are co-located (null lines only match null lines). */
function linesCoLocated(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === null && b === null;
  return Math.abs(a - b) <= DEDUPE_LINE_WINDOW;
}

function findingsDuplicate(a: Finding, b: Finding): boolean {
  return (
    a.file === b.file &&
    a.severity === b.severity &&
    linesCoLocated(a.line, b.line) &&
    messagesSimilar(a.message, b.message)
  );
}

/**
 * Dedupe near-identical findings within and across reviewers.
 *
 * Duplicates are findings in the same file with the same severity,
 * co-located lines (±2), and similar messages. The higher-confidence
 * finding wins and keeps its own reviewer field.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const candidate of findings) {
    let merged = false;
    for (let i = 0; i < kept.length; i++) {
      if (findingsDuplicate(kept[i], candidate)) {
        merged = true;
        // Higher confidence wins; ties keep the earlier finding.
        if (candidate.confidence > kept[i].confidence) {
          kept[i] = candidate;
        }
        break;
      }
    }
    if (!merged) kept.push(candidate);
  }
  return kept;
}

/**
 * Merge jury findings by union: concatenate all reviewers' findings and
 * dedupe. Majority/union voting rules are deferred to a later version.
 */
export function mergeJuryFindings(perReviewer: Finding[][]): Finding[] {
  return dedupeFindings(perReviewer.flat());
}
