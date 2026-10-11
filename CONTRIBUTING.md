# Contributing to NoSelfGrade

Thanks for contributing. The most valuable contributions here are the ones that
strengthen the independence mechanism itself: the family table, the review
prompts, and the reviewer providers. This guide covers the common workflows.

## Getting started

Requires Node 20+.

```bash
npm ci
npm test        # vitest run — the full suite
npx tsc -b      # typecheck; must be clean
```

## Adding a model to the family table

The family table is the semantic core of the product — it's what makes
"disjoint from the builder" a checkable claim. It lives in
`packages/core/src/families.ts`.

**Entry format:**

```ts
{ model: "model-id", family: "family", provider: "provider", notes: "..." }
```

**Rules:**

1. **Family is training lineage, NOT serving vendor.** A model distilled from
   GPT-4 is family `gpt` no matter who serves it. A third-party-served Llama
   is family `llama`. When in doubt, note the lineage in `notes`.
2. **Provider is who you call** — the authenticated API endpoint the reviewer
   request goes to. This is the enforceable half of the disjointness guarantee,
   so get it right.
3. **Notes are encouraged** for distillations, renames, and reasoning-model
   lineage (e.g. o-series → `gpt`).
4. **Model IDs are best-effort as of 2026.** Keep the table current as
   providers ship new models — a stale table is a failing-open risk, and
   unknown models fail closed by design.
5. Update `packages/core/test/families.test.ts` if you add a family, and run
   `npm test` + `npx tsc -b`.

**What counts as a good entry:** the exact model ID the provider's API
expects, the correct origin family, and a note whenever lineage is
non-obvious. **What doesn't belong here:** speculative future models,
vendor marketing names that don't map to an API model ID.

## Adding a reviewer provider

Providers are the `ReviewerProvider` interface in
`packages/core/src/providers/types.ts` — a transport that POSTs a review
prompt to an LLM API over direct `fetch` (no SDKs) and returns the raw text.

Steps:

1. Implement `ReviewerProvider` (`readonly name`, `review(req)` returning raw
   response text). No JSON parsing or schema repair here — that belongs in
   `dispatch.ts`.
2. Wire it into `getProvider()` with a new `ProviderTransport` value.
3. Add the env var to `REVIEW_ENV_VARS` in `packages/core/src/dispatch.ts`
   (e.g. `myprovider: "MYPROVIDER_API_KEY"`), and add a default reviewer
   candidate in `DEFAULT_REVIEWERS` if it has a strong code-review model.
4. Add the transport's base URL handling (the OpenAI-compatible path covers
   most new providers — check whether your provider speaks the OpenAI chat
   completions shape before writing a new transport).
5. Add tests in `packages/core/test/providers.test.ts`.

**Hard rules for providers:**

- The raw API key **never** appears in errors, logs, or returned data. Only
  `apiKeyFingerprint()` (truncated sha256) leaves the module.
- `ProviderError.bodySnippet` is capped at 200 chars and must never contain
  the key.
- Timeouts are mandatory (AbortController), not optional.

## Running tests

```bash
npm test        # vitest run: unit + property tests + fixture tests
npx tsc -b      # typecheck across workspaces; must be clean
```

### Fixture and property-test expectations

- **Per-scenario fixtures** (`packages/core/test/`, `testdata/`): diff-in →
  findings-out scenarios pin the normalization behavior — line-drift handling,
  severity vocabulary mapping, near-duplicate deduping. If you change
  normalization, expect to update fixtures; do it deliberately and explain why
  in the PR.
- **Property tests** (`dispatch-property.test.ts`): the disjoint-selection
  invariant is property-tested — *for every family-table entry, no selected
  reviewer shares family or provider with the declared builder*. If you touch
  dispatch or the table, these must stay green; a red property test here is a
  broken guarantee, not a flaky test.
- **SARIF validation** (`reporters.test.ts` + `sarif-schema.json`): the SARIF
  reporter is validated against the official schema. Keep it that way — GitHub
  code scanning ingests this output, and schema drift silently breaks the
  integration.
- **E2E**: a mocked end-to-end (sample diff → fake reviewer → signed
  certificate → offline `verify` VALID) guards the ceremony loop. Real-API
  calls are never part of the test suite; keys stay out of tests.

## PR guidance

- **One change per PR.** Family-table additions, prompt changes, and provider
  additions are separate PRs.
- **Prompt changes need justification.** The review prompts are a corpus, not
  decoration. Changing one requires: what failure mode it addresses, and a
  fixture or test demonstrating the improvement.
- **Never weaken the fail-closed defaults.** Unknown models refuse review,
  malformed reviewer output fails loudly, missing keys error out. A PR that
  softens any of these needs an explicit rationale and maintainer sign-off.
- **Docs travel with code.** Family-table additions update the README's
  supported-models answer if it names providers; new flags update the README
  quick-start section; new inputs update `action/` docs.
- **Conventional commit messages** (`feat:`, `fix:`, `docs:`, `chore:`).

## License

By contributing, you agree that your contributions will be licensed under the
Apache-2.0 license (see [LICENSE](LICENSE)).
