# NoSelfGrade

[![npm version](https://img.shields.io/npm/v/@tamtunnel/noselfgrade)](https://www.npmjs.com/package/@tamtunnel/noselfgrade)
[![CI](https://github.com/TamTunnel/noselfgrade/actions/workflows/ci.yml/badge.svg)](https://github.com/TamTunnel/noselfgrade/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Independent code review for agent-written code — with a signed certificate that says exactly what it guarantees, and exactly what it doesn't.

## 1. Problem statement

Agents now write production code. When an agent reviews its own diff — or the same
model family reviews it — the review inherits the builder's blind spots: the same
training data, the same RLHF, the same failure modes. Self-review is correlated
review, and correlated review is how subtle bugs ship with a clean bill of health.

Ad-hoc "ask another LLM to review" doesn't fix it either: nothing records *which*
model actually ran the review, nothing prevents the reviewer from being the same
family as the builder, and nothing stops a passing review from being claimed about
a different diff tomorrow. There's no artifact, no ceremony, no checkable claim.

NoSelfGrade makes independent review a checkable, signable property of the review
— and a gate in your CI.

## 2. Solution (in layman's terms)

When an AI agent (or a human using one) produces a diff, NoSelfGrade:

1. **Takes the builder's declaration** — which model wrote the code (e.g. `gpt-5`
   via `openai`). This is *declared*, not verified — more on that below.
2. **Picks a reviewer from a different family *and* a different provider.**
   If the builder declares GPT/OpenAI, the reviewer might be Claude via Anthropic's
   API — never another GPT, never another OpenAI-served model. Both conditions are
   checked; this is belt and suspenders on purpose.
3. **Calls the reviewer's real, authenticated API with your API key**, building
   the review prompt from the raw diff only. The builder's own description of the
   code is never injected — the reviewer sees the code, not the builder's framing.
4. **Normalizes the findings** into one schema (severity, file, line, category,
   confidence, remediation), so a jury of reviewers can be merged and compared.
5. **Signs a certificate**: canonical JSON over the diff hash, the declared
   builder, the reviewers used, every finding, and the verdict — signed with your
   Ed25519 key. Anyone can verify it offline with `noselfgrade verify`.

The certificate's Markdown form embeds an independence statement: who declared
what, who reviewed, and the proof of disjointness. Feed it to `git log`, to your
PR process, or to GitHub code scanning via the SARIF output.

### What the guarantee is — stated plainly, here, not in fine print

> The reviewer was selected from a model family **and** provider disjoint from
> the **declared** builder, invoked through that provider's authenticated API
> (your key, their endpoint), and the whole ceremony is signed.

### What it is not

- **Builder identity is declared, not verified.** There is no cryptographic way
  to prove which model wrote a diff — any builder identity is self-reported. If
  the builder lies about being GPT when it was actually Claude, the disjointness
  guarantee is computed against the wrong input. NoSelfGrade records the
  declaration verbatim as *declared*, never as *verified*, and the certificate
  says so.
- **Shared pretraining correlation survives.** All frontier models train on
  overlapping internet-scale data. Reviewer diversity across companies, training
  runs, and RLHF is the strongest practical decorrelator available — it reduces
  correlation, it does not reach zero. `--jury` (one reviewer per disjoint
  provider, up to 3) reduces it further.
- **Adversarial evasion is out of scope.** This tool gates *accidental*
  correlated blindness in normal agent workflows. A builder deliberately trying
  to evade review is a different threat model and is not covered.

Honest scoping is the product's core differentiator. "We tell you exactly what
we guarantee" beats every competitor's vague "AI-powered review."

## 3. Quick start

Requires Node 20+.

```bash
# 1. Generate your signing key (once; stored in ~/.noselfgrade, mode 600)
npx @tamtunnel/noselfgrade keygen

# 2. Review your staged changes, declaring which model built them
npx @tamtunnel/noselfgrade review --builder-model gpt-5 --staged
```

That's the core loop. What happens under the hood:

- `keygen` creates an Ed25519 keypair in `~/.noselfgrade` for signing certificates.
- `review` looks up `gpt-5` in the family table (family `gpt`, provider
  `openai`), excludes every reviewer whose family **or** provider matches,
  and picks from the disjoint set — e.g. `claude-sonnet-4-5` via Anthropic.
- It needs at least one API key for a **disjoint** provider:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`,
  `DEEPSEEK_API_KEY`, or `MISTRAL_API_KEY`.
- A successful run prints a stderr summary shaped like this (illustrative):
  `noselfgrade: reviewer(s) [claude-sonnet-4-5] · 2 finding(s) · verdict FAIL · signed (key keyid:cf7796af7a55ec62)`

### Commands

- `review [DIFF]` — review a diff. Diff source: a file path argument, `--staged`
  (git staged changes), or `--base=<ref>` (git diff against a ref). Flags:
  `-m/--builder-model`, `-p/--builder-provider`, `--allow-unknown-model`,
  `--jury`, `--fail-on=<critical|high|medium|low|info>` (default `high`),
  `--format=<json|markdown|sarif|html>` (default `markdown`), `-o/--output`,
  `--timeout` (seconds, default `120`), `--no-sign`, `--staged`, `--base=<ref>`.
- `verify <certificate>` — verify a signed certificate **offline**: checks the
  Ed25519 signature, the diff hash, and family-disjointness from first principles.
- `keygen` — generate the signing keypair used by `review`.
- `init` — write a `.noselfgrade.json` config file so CI and teammates share the
  same builder declaration and defaults.
- `families list` — print the curated model → family/provider table that drives
  reviewer selection.

### Exit codes

- `0` — PASS (no findings at or above `--fail-on`)
- `1` — FAIL (findings at or above `--fail-on`); also what fails the GitHub Action step
- `2` — config/usage error (unknown model, no API key for any disjoint reviewer, malformed input)

### GitHub Action

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # needed so `git diff <base-ref>` sees history
- uses: TamTunnel/noselfgrade/action@v0
  with:
    builder-model: gpt-5
    builder-provider: openai
    # fail-on: high      # default
    # jury: "true"       # one reviewer per disjoint provider (up to 3)
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action uploads SARIF to GitHub code scanning and fails the step on verdict FAIL.

## 4. Architecture

### Components

| Component | File | What it does |
|---|---|---|
| Builder declaration | `packages/core/src/builder.ts` | Parses `.noselfgrade.json` / flags / CI env into a normalized `{ model, provider }` declaration and validates it against the family table. Unknown model → fails closed with an actionable error, unless `--allow-unknown-model`. Records the declaration verbatim as *declared* — never verifies it. |
| Family table | `packages/core/src/families.ts` | Curated static map: model id → `{ family, provider }`. Family is training lineage, not serving vendor (a distilled model keeps its origin family no matter who serves it). |
| Reviewer dispatch | `packages/core/src/dispatch.ts` | Selects reviewer(s) from the set disjoint in family **and** provider from the declared builder, renders the review prompt from the diff, calls provider APIs with timeout/retry/backoff, and parses structured output. Malformed JSON gets a repair re-prompt, then a loud failure — never a silently dropped reviewer. |
| Provider adapters | `packages/core/src/providers/` | `ReviewerProvider` interface over direct `fetch` — `anthropic`, `openai`, and `openai-compatible` (Google, xAI, DeepSeek, Mistral endpoints). No SDK lock-in. |
| Finding normalization | `packages/core/src/findings.ts` | Maps every provider's raw output to one `Finding` type. Tolerates line-number drift (fuzzy-matches cited snippets against the diff, ±3 lines, else `line: null` rather than lying), dedupes near-identical findings across jury members, normalizes severity vocabularies. A clerk, not a second reviewer. |
| Certification | `packages/core/src/certify.ts` | Canonicalizes the report, hashes the reviewed diff (sha256), signs with Ed25519, emits `{ report, signature, keyId }`. `verify` re-checks signature, diff hash, and family-disjointness from first principles. Keys are user-owned (`~/.noselfgrade`, mode 600); no hosted PKI. |
| Reporters | `packages/core/src/reporters/` | SARIF (validated against the official schema in tests, so GitHub code scanning ingests it), JSON (full certification envelope), Markdown (human-readable, embeds the independence statement), HTML. |
| CLI | `packages/cli/` | `citty`-based: `review`, `verify`, `keygen`, `init`, `families list`. |
| Action | `action/` | Composite GitHub Action wrapping `review`. |

### Data flow

```
builder declares (model, provider)          # untrusted, recorded as declared
        │
        ▼
family table lookup ──unknown──▶ fail closed (unless --allow-unknown-model)
        │
        ▼
disjoint reviewer selection (family ∩ provider = ∅)
        │
        ▼
prompt built from raw diff only (no builder framing)
        │
        ▼
provider API call(s) ──malformed──▶ repair re-prompt ──fails──▶ loud error
        │
        ▼
finding normalization (drift-tolerant, deduped)
        │
        ▼
certify: canonical JSON + sha256(diff) + Ed25519 sign
        │
        ▼
reporters: SARIF / JSON / Markdown / HTML  →  CI gate on --fail-on
```

### The disjoint-selection mechanism, in plain language

Think of it as two filters stacked on top of each other:

1. **Family filter (semantic):** the reviewer must come from a different
   training-lineage family than the declared builder. GPT-5 declared → no
   reviewer from the `gpt` family, even if served by someone else.
2. **Provider filter (enforceable):** the reviewer must be served by a
   different company, called through that company's authenticated API with
   your key. The report records the provider endpoint invoked and a
   fingerprint of the key used — "we called Anthropic's API" is recorded
   with an audit trail the key owner can check, not independently verifiable
   by third parties.

Because you can't cryptographically prove which model wrote a diff, the whole
mechanism is scoped to the *declared* builder. The certificate is explicit
about this: it proves *the service ran this review with these reviewers on
this diff*. It does not prove the builder told the truth.

## 5. FAQs

**How is this different from just asking another LLM to review?**

Asking another LLM to review is fine ad hoc. NoSelfGrade turns it into a
*ceremony*: a curated family table decides which reviewers are even eligible,
dispatch excludes the builder's family and provider by construction, the
review goes through the provider's authenticated API (so which endpoint was
invoked is a recorded fact), findings are normalized into one schema, and
the result is a signed, tamper-evident certificate that CI can gate on.
The product is the ceremony and the checkable claim — not the API calls.

**Can the builder lie about its identity?**

Yes. Builder identity is **declared, not verified** — there is no attestation
primitive for "GPT-5 wrote this diff," and any scheme that trusts a
self-reported identity can be defeated by a lying builder. NoSelfGrade scopes
its guarantee around this instead of pretending otherwise. The exact guarantee:
*the reviewer was selected from a family and provider disjoint from the
declared builder, invoked through that provider's authenticated API, and the
whole ceremony is signed.* The certificate records the declaration verbatim
as *declared* and states the limitation in plain language.

**Which models/providers are supported?**

The curated family table (`packages/core/src/families.ts`) covers: Claude
(Anthropic), GPT and o-series (OpenAI), Grok (xAI), Gemini (Google), Llama
(Meta, plus third-party serving), DeepSeek, Mistral/Codestral, and Qwen
(Alibaba, plus third-party serving). Reviewers are invoked through
Anthropic, OpenAI, and OpenAI-compatible endpoints (Google, xAI, DeepSeek,
Mistral). Run `npx @tamtunnel/noselfgrade families list` for the current
table — new models are added by contributor PR (see [CONTRIBUTING.md](CONTRIBUTING.md)).

**Do I need API keys?**

Yes — reviewers are real LLM API calls; there is no offline mode. Set at
least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`XAI_API_KEY`, `DEEPSEEK_API_KEY`, or `MISTRAL_API_KEY` — for a provider
**disjoint** from your declared builder. More keys means more disjoint
reviewers available, which matters for `--jury`. Keys are never logged or
embedded in reports; only a truncated sha256 fingerprint is recorded.

**What does the signature prove?**

It proves that this exact review ran: the signed payload covers the sha256
of the reviewed diff, the declared builder, the reviewers used (with
provider and key fingerprints), every finding, and the verdict. Anyone with
the public key can check it offline with `noselfgrade verify`. It does **not**
prove the builder's declaration was true, and the certificate says so.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — especially if you're adding a model
to the family table or a new reviewer provider.

## Security

See [SECURITY.md](SECURITY.md) for scope, API-key handling, signing-key
management, and how to report vulnerabilities.

## License

Apache-2.0 — see [LICENSE](LICENSE). Copyright 2026 TamTunnel Contributors.
