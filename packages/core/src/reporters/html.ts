/**
 * HTML reporter: a single self-contained HTML certificate. Inline CSS,
 * zero external dependencies, no scripts. All interpolated content is
 * HTML-escaped.
 */
import type { Certificate, Finding, Severity } from "../types.js";
import { SEVERITIES } from "../types.js";

/** Escape all HTML-significant characters in interpolated content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; max-width: 72rem; margin-inline: auto; line-height: 1.5; color: #1a1a1a; background: #ffffff; }
.banner { border-radius: 0.5rem; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; font-size: 1.5rem; font-weight: 700; }
.banner.pass { background: #e6f4ea; color: #137333; border: 1px solid #a8dab5; }
.banner.fail { background: #fce8e6; color: #a50e0e; border: 1px solid #f5a5a1; }
section { margin-bottom: 2rem; }
h1 { font-size: 1.75rem; }
h2 { font-size: 1.25rem; border-bottom: 1px solid #ccc; padding-bottom: 0.25rem; }
.meta { color: #555; }
.finding { border: 1px solid #ccc; border-radius: 0.5rem; padding: 1rem 1.25rem; margin-bottom: 1rem; }
.finding h3 { margin-top: 0; font-size: 1.05rem; }
.badge { display: inline-block; border-radius: 0.25rem; padding: 0.1rem 0.5rem; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; }
.badge.critical { background: #fce8e6; color: #a50e0e; }
.badge.high { background: #fef7e0; color: #b06000; }
.badge.medium { background: #fef7e0; color: #7a5c00; }
.badge.low { background: #e8f0fe; color: #1a56db; }
.badge.info { background: #f1f3f4; color: #5f6368; }
.badge.category { background: #e8f0fe; color: #174ea6; }
pre { background: #f6f8fa; border: 1px solid #ddd; border-radius: 0.375rem; padding: 0.75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.disjoint { color: #137333; }
.unsigned { background: #fef7e0; border: 2px solid #f9ab00; border-radius: 0.375rem; padding: 0.75rem 1rem; margin: 1rem 0; font-weight: 500; }
.limitation { font-style: italic; color: #555; border-left: 3px solid #ccc; padding-left: 1rem; }
table.summary { border-collapse: collapse; }
table.summary td, table.summary th { border: 1px solid #ccc; padding: 0.4rem 0.9rem; text-align: left; }
@media (prefers-color-scheme: dark) {
  body { color: #e8eaed; background: #121212; }
  .banner.pass { background: #1e3a2a; color: #81c995; border-color: #2d5a3f; }
  .banner.fail { background: #3a1e1e; color: #f28b82; border-color: #5a2d2d; }
  h2 { border-bottom-color: #444; }
  .finding { border-color: #444; }
  .meta, .limitation { color: #9aa0a6; }
  pre { background: #1e1e1e; border-color: #444; }
  .badge.critical { background: #3a1e1e; color: #f28b82; }
  .badge.high, .badge.medium { background: #3a2f1e; color: #fdd663; }
  .badge.low, .badge.category { background: #1e2a3a; color: #8ab4f8; }
  .badge.info { background: #2a2a2a; color: #9aa0a6; }
  .disjoint { color: #81c995; }
  table.summary td, table.summary th { border-color: #444; }
}
`;

function findingHtml(f: Finding): string {
  const location = f.line === null ? `${f.file}, line unknown` : `${f.file}:${f.line}`;
  const remediation = f.remediation
    ? `<h4>Remediation</h4>\n<pre>${escapeHtml(f.remediation)}</pre>`
    : "";
  return `<article class="finding">
<h3><span class="badge ${f.severity}">${escapeHtml(f.severity)}</span>
<span class="badge category">${escapeHtml(f.category)}</span>
${escapeHtml(location)}</h3>
<p class="meta">Confidence: ${Math.round(f.confidence * 100)}% · Reviewer: ${escapeHtml(f.reviewer)}</p>
<pre>${escapeHtml(f.message)}</pre>
${remediation}
</article>`;
}

export function renderHtml(cert: Certificate): string {
  const r = cert.report;
  const verdictClass = r.verdict === "PASS" ? "pass" : "fail";
  const verdictText = r.verdict === "PASS" ? "✅ PASS" : "❌ FAIL";
  const unsignedBanner = !cert.signature
    ? `<div class="unsigned">⚠️ <strong>UNSIGNED</strong> — generated with <code>--no-sign</code>; this is <strong>not</strong> a valid certification and carries no cryptographic proof.</div>\n`
    : "";

  const reviewerLines = r.reviewers
    .map((rev) => {
      const disj = r.declaredBuilder.family
        ? `Disjointness: reviewer provider ${escapeHtml(rev.provider)} ≠ builder provider ${escapeHtml(r.declaredBuilder.provider)}, family ≠ ${escapeHtml(r.declaredBuilder.family)} — disjoint ✓`
        : `Disjointness: reviewer provider ${escapeHtml(rev.provider)} ≠ builder provider ${escapeHtml(r.declaredBuilder.provider)} — disjoint ✓ (builder family unknown: degraded guarantee)`;
      return `<li><strong>Reviewer:</strong> provider <code>${escapeHtml(rev.provider)}</code>, model <code>${escapeHtml(rev.model)}</code>, API-key fingerprint <code>${escapeHtml(rev.apiKeyFingerprint)}</code>.\n<br><span class="disjoint">${disj}</span></li>`;
    })
    .join("\n");

  const groups = new Map<Severity, Finding[]>();
  for (const sev of SEVERITIES) groups.set(sev, []);
  for (const f of r.findings) groups.get(f.severity)!.push(f);

  let findingsHtml = "";
  let any = false;
  for (const sev of SEVERITIES) {
    const group = groups.get(sev)!;
    if (group.length === 0) continue;
    any = true;
    findingsHtml += `<h3>${escapeHtml(sev)} (${group.length})</h3>\n`;
    findingsHtml += group.map(findingHtml).join("\n");
  }
  if (!any) findingsHtml = "<p>No findings.</p>";

  const summaryRows = SEVERITIES.map(
    (sev) => `<tr><td>${escapeHtml(sev)}</td><td>${groups.get(sev)!.length}</td></tr>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NoSelfGrade Review Report — ${escapeHtml(r.verdict)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="banner ${verdictClass}">NoSelfGrade — ${verdictText}</div>
${unsignedBanner}
<section>
<h2>Report metadata</h2>
<p class="meta">Reviewed at ${escapeHtml(r.timestamp)} · Diff hash (sha256) <code>${escapeHtml(r.diffHash)}</code> · Signature key id <code>${escapeHtml(cert.keyId)}</code></p>
</section>

<section>
<h2>Independence statement</h2>
<ul>
<li><strong>Builder:</strong> model <code>${escapeHtml(r.declaredBuilder.model)}</code>, provider <code>${escapeHtml(r.declaredBuilder.provider)}</code>${r.declaredBuilder.family ? `, family <code>${escapeHtml(r.declaredBuilder.family)}</code>` : `, family <em>unknown</em> — only provider-disjointness enforced`} — <em>declared, not verified</em>.</li>
${reviewerLines}
</ul>
<p class="limitation">Builder identity is declared, not verified. The signature proves this review ran with these reviewers on this diff — nothing more.</p>
</section>

<section>
<h2>Findings</h2>
${findingsHtml}
</section>

<section>
<h2>Summary</h2>
<table class="summary">
<tr><th>Severity</th><th>Count</th></tr>
${summaryRows}
<tr><td><strong>Total</strong></td><td><strong>${r.findings.length}</strong></td></tr>
</table>
</section>
</body>
</html>
`;
}
