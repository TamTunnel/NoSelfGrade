/**
 * JSON reporter: pretty-printed JSON of the full certificate envelope
 * (report + signature + keyId + formatVersion).
 */
import type { Certificate } from "../types.js";

export function renderJson(cert: Certificate): string {
  return JSON.stringify(cert, null, 2) + "\n";
}
