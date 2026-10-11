/**
 * Builder declaration parsing. The declaration is UNTRUSTED input — it is
 * self-reported by whoever built the code under review. We validate it
 * against the family table and record it verbatim as *declared*; we never
 * verify it (there is no attestation primitive for "model X wrote this").
 *
 * Unknown models fail closed: the review refuses until the table is updated
 * or the user explicitly passes --allow-unknown-model with a provider.
 */

import type { BuilderDeclaration } from "./types.js";
import { lookupModel } from "./families.js";

export class BuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderError";
  }
}

export interface BuilderOptions {
  model?: string;
  provider?: string;
  allowUnknownModel?: boolean;
}

/**
 * Normalize and validate a builder declaration.
 *
 * - model is required.
 * - provider is inferred from the family table when missing.
 * - unknown model + !allowUnknownModel → BuilderError (fail closed).
 * - unknown model + allowUnknownModel requires an explicit provider,
 *   otherwise there is nothing to dispatch against.
 */
export function parseBuilderDeclaration(opts: BuilderOptions): BuilderDeclaration {
  const model = opts.model?.trim();
  if (!model) {
    throw new BuilderError(
      'builder model is required: pass --builder-model (or set "model" in .noselfgrade.json)',
    );
  }

  const entry = lookupModel(model);
  if (entry) {
    const provider = opts.provider?.trim();
    return { model: entry.model, provider: provider || entry.provider, family: entry.family };
  }

  if (!opts.allowUnknownModel) {
    throw new BuilderError(
      `unknown builder model "${model}": not in packages/core/src/families.ts. ` +
        `Add it to the family table (contributor PR), or pass --allow-unknown-model ` +
        `together with an explicit --builder-provider.`,
    );
  }

  const provider = opts.provider?.trim();
  if (!provider) {
    throw new BuilderError(
      `--allow-unknown-model requires an explicit --builder-provider for model "${model}": ` +
        `without a provider we cannot select a disjoint reviewer.`,
    );
  }
  return { model, provider, family: null };
}
