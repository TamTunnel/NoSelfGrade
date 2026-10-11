/**
 * Markdown reporter: human-readable review report with the required
 * independence statement.
 */
import type { Certificate, Finding, Severity } from "../types.js";
import { SEVERITIES } from "../types.js";

/** Longest run of consecutive backticks in a string. */
function longestBacktickRun(s: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of s) {
    if (ch === "`") {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Wrap content in a code fence whose length exceeds the longest backtick
 * run in the content by 3, so finding content can never break the report.
 */
export function fenced(content: string, lang = ""): string {
  const fence = "`".repeat(longestBacktickRun(content) + 3);
  return `${fence}${lang}\n${content}\n${fence}`;
}

function findingBlock(f: Finding): string {
  const location = f.line === null ? `${f.file}, line unknown` : `${f.file}:${f.line}`;
  const lines = [
    `### ${f.severity.toUpperCase()} — ${f.category} — ${location}`,
    "",
    `- **Confidence:** ${Math.round(f.confidence * 100)}%`,
    `- **Reviewer:** \`${f.reviewer}\``,
    "",
    "**Message**",
    "",
    fenced(f.message),
  ];
  if (f.remediation) {
    lines.push("", "**Remediation**", "", fenced(f.remediation));
  }
  return lines.join("\n");
}

export function renderMarkdown(cert: Certificate): string {
  const r = cert.report;
  const badge = r.verdict === "PASS" ? "✅ PASS" : "❌ FAIL";
  const unsigned = !cert.signature;
  const parts: string[] = [
    "# NoSelfGrade Review Report",
    "",
    ...(unsigned
      ? ["> ⚠️ **UNSIGNED** — generated with `--no-sign`; this is **not** a valid certification and carries no cryptographic proof.", ""]
      : []),
    `## Verdict: ${badge}`,
    "",
    `- **Reviewed at:** ${r.timestamp}`,
    `- **Diff hash (sha256):** \`${r.diffHash}\``,
    `- **Signature key id:** \`${cert.keyId || "(none — unsigned)"}\``,
    "",
    "## Independence statement",
    "",
    `- **Builder:** model \`${r.declaredBuilder.model}\`, provider \`${r.declaredBuilder.provider}\`` +
      (r.declaredBuilder.family
        ? `, family \`${r.declaredBuilder.family}\``
        : `, family *unknown* — only provider-disjointness was enforced`) +
      ` — *declared, not verified*.`,
  ];
  for (const rev of r.reviewers) {
    const famLine = r.declaredBuilder.family
      ? `  - Disjointness: reviewer provider ${rev.provider} ≠ builder provider ${r.declaredBuilder.provider}, reviewer family ≠ builder family \`${r.declaredBuilder.family}\` — disjoint ✓`
      : `  - Disjointness: reviewer provider ${rev.provider} ≠ builder provider ${r.declaredBuilder.provider} — disjoint ✓ (family unknown: degraded guarantee)`;
    parts.push(
      `- **Reviewer:** provider \`${rev.provider}\`, model \`${rev.model}\`, API-key fingerprint \`${rev.apiKeyFingerprint}\`.`,
      famLine
    );
  }
  parts.push(
    "",
    "> Builder identity is declared, not verified. The signature proves this review ran with these reviewers on this diff — nothing more."
  );

  const bySeverity = new Map<Severity, Finding[]>();
  for (const sev of SEVERITIES) bySeverity.set(sev, []);
  for (const f of r.findings) bySeverity.get(f.severity)!.push(f);

  parts.push("", "## Findings", "");
  let any = false;
  for (const sev of SEVERITIES) {
    const group = bySeverity.get(sev)!;
    if (group.length === 0) continue;
    any = true;
    parts.push(`### ${sev.toUpperCase()} (${group.length})`, "");
    for (const f of group) {
      parts.push(findingBlock(f), "");
    }
  }
  if (!any) parts.push("No findings.", "");

  parts.push("## Summary", "");
  for (const sev of SEVERITIES) {
    const n = bySeverity.get(sev)!.length;
    parts.push(`- **${sev}:** ${n}`);
  }
  parts.push(`- **Total:** ${r.findings.length}`, "");

  return parts.join("\n");
}
