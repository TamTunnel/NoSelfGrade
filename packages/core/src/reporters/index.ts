/**
 * Reporters barrel: JSON, Markdown, SARIF, HTML plus a format dispatcher.
 */
import type { Certificate } from "../types.js";
import { renderJson } from "./json.js";
import { renderMarkdown } from "./markdown.js";
import { renderSarif } from "./sarif.js";
import { renderHtml, escapeHtml } from "./html.js";

export { renderJson } from "./json.js";
export { renderMarkdown, fenced } from "./markdown.js";
export { renderSarif } from "./sarif.js";
export { renderHtml, escapeHtml } from "./html.js";

export type ReportFormat = "json" | "markdown" | "sarif" | "html";

const RENDERERS: Record<ReportFormat, (cert: Certificate) => string> = {
  json: renderJson,
  markdown: renderMarkdown,
  sarif: renderSarif,
  html: renderHtml,
};

/** Render a certificate in the requested format. Throws on unknown format. */
export function render(cert: Certificate, format: ReportFormat): string {
  const renderer = RENDERERS[format];
  if (!renderer) {
    throw new Error(
      `Unknown report format: ${String(format)}. Expected one of: json, markdown, sarif, html.`
    );
  }
  return renderer(cert);
}
