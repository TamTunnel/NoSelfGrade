# NoSelfGrade — Architecture

**Status:** architect assessment (pre-build). This document is the build contract:
stack verdict, the independence mechanism with its honest limits, components,
deliberate deferrals, and the risks most likely to kill it.

---

## 1. Stack verdict

| Decision | Choice | One-line justification |
|---|---|---|
| Language / runtime | TypeScript on Node 20+ | Same org, same contributors, same npm distribution story as Redteam; reviewer agents are I/O-bound on LLM APIs, nothing here needs more. |
| Monorepo layout | `packages/core`, `packages/cli`, `action/` | Copy Redteam's proven shape; contributors already know it. |
| CLI framework | `citty` | Same as Redteam; zero learning curve, tiny footprint. |
| LLM provider abstraction | Hand-rolled `ReviewerProvider` interface over direct `fetch` (anthropic / openai / openai-compatible) | No SDK lock-in, no heavy deps; the "AI" is HTTPS calls, same as Redteam's attack-agent. Vercel AI SDK adds opinions we don't need. |
| Signing | Node built-in `crypto` (Ed25519) | Zero dependencies; keygen/verify are ~20 lines. |
| Test framework | Vitest | Same as Redteam; fast, ESM-native. |
| Package / binary | `@tamtunnel/noselfgrade`, binary `noselfgrade` | Org convention. |
| License | Apache-2.0 | P's standing rule. |

**Rust: OUT.** The case for Rust is sandboxing untrusted code, CPU-bound hot paths,
or binary distribution. NoSelfGrade does none of these: it never executes the
reviewed code (it diffs and ships text to APIs), its local work is diff parsing
and JSON normalization (microseconds), and npm distribution is already solved.
Adding Rust would buy contributor friction for zero measured gain. Revisit only
if profiling shows a real bottleneck — it won't; the bottleneck is LLM latency.

**Python: OUT.** Python earns its place for local model inference orchestration.
v0 does no local inference — reviewers are remote API calls, and routing them
through Python would add a runtime for nothing. If a future version adds
llama.cpp-style local reviewers, *that* is the concrete justification, and it
belongs in a sidecar, not the core.

---

## 2. How the independence guarantee actually works

Blunt version first: **you cannot cryptographically prove which model wrote a
piece of code.** There is no attestation primitive for "GPT-4 wrote this diff."
Any builder identity is self-reported, and a lying builder defeats any
scheme that trusts it. Anyone selling you "provable end-to-end independence"
is selling marketing. This section designs the strongest *honest* version.

### Threat model

| Threat | Can we defeat it? |
|---|---|
| Builder lies about its identity (declares model X, actually model Y) | **No.** Self-reported identity is unverifiable. We scope the guarantee around it instead of pretending. |
| Reviewer is secretly the same model as the builder | **Yes, on the reviewer side.** *We* choose and invoke the reviewer through the provider's authenticated API (your API key, their TLS endpoint). You know you called Anthropic's API, so the reviewer is whatever Anthropic serves at that model ID — up to provider honesty, which is the same trust you already place in them for everything else. |
| Correlated blind spots from shared training data | **Partially.** All frontier models train on overlapping internet-scale data. Provider diversity (different companies, different training runs, different RLHF) is the strongest practical decorrelator available. It reduces, not eliminates, the correlation. |
| Distilled models masquerading as independent | **Mostly.** The family table treats known distillations as same-family (e.g. a model distilled from GPT-4 is `gpt` family regardless of who serves it). |
| Prompt-lineage contamination (reviewer inherits builder's framing) | **Yes.** Review prompts are constructed by NoSelfGrade from the raw diff, never from the builder's self-description or chain-of-thought. The builder's declaration is used *only* for reviewer selection, never injected into review context. |

### The mechanism (concrete)

1. **Builder declaration** (untrusted input, treated as such). From
   `.noselfgrade.json`, CI env, or `--builder-model` / `--builder-provider`
   flags: `{ model: "gpt-4o", provider: "openai" }`. Parsed, validated against
   the family table, and recorded verbatim in the report as *declared*, never
   as *verified*.

2. **Family table** (`packages/core/src/families.ts`). A curated static map:
   `model id → { family, provider, notes }`. Examples:
   - `gpt-4o`, `o3` → `{ family: "gpt", provider: "openai" }`
   - `claude-opus-4-6`, `claude-sonnet-4-5` → `{ family: "claude", provider: "anthropic" }`
   - `gemini-2.5-pro` → `{ family: "gemini", provider: "google" }`
   - Llama-distilled vendor models → `{ family: "llama", provider: <vendor> }`,
     with distillation notes where known.
   
   Unknown models fail closed: review refuses until the table is updated
   (contributor PR) or the user passes `--allow-unknown-model` explicitly.

3. **Disjoint reviewer selection.** The dispatcher excludes every reviewer
   whose family **or** provider intersects the declared builder's. Belt and
   suspenders: family-disjointness is the semantic guarantee, provider-
   disjointness is the enforceable one. Default v0: **one** reviewer from the
   disjoint set (cheapest, fastest); `--jury` selects one reviewer per
   distinct disjoint provider (up to 3) and merges findings by majority /
   union rules.

4. **Reviewer-side authentication.** The review request goes out over the
   user's own API key to the provider's API. The report records
   `{ provider, model, apiKeyFingerprint (sha256 of key, truncated) }` —
   proving *which provider endpoint* was invoked, not just which model was
   named.

5. **Signed certification.** The report is canonical JSON over
   `{ diffHash (sha256 of the reviewed diff), declaredBuilder, reviewers[],
   findings[], verdict, timestamp }`, signed Ed25519 with the user's keypair
   (`noselfgrade keygen`). `noselfgrade verify` checks the signature and
   re-validates family-disjointness from the embedded data. The signature
   proves *the service ran this review with these reviewers on this diff* —
   it does not prove the builder's declaration was true, and the report
   says so in plain language.

### Honest limitations (printed in the README, not buried)

- Builder identity is **declared, not verified**. The guarantee is precisely:
  "the reviewer was selected from a provider/family disjoint from the
  *declared* builder, invoked through that provider's authenticated API,
  and the whole ceremony is signed." Nothing more.
- Shared pretraining data means some correlated blind spots survive any
  provider-diverse jury. The jury reduces the correlation; it does not
  reach zero.
- A sufficiently motivated adversary (builder deliberately evading review)
  is outside the threat model. This tool gates *accidental* correlated
  blindness in normal agent workflows, not adversarial evasion.

---

## 3. Component breakdown

**Builder-declaration parsing** (`packages/core/src/builder.ts`).
Reads `.noselfgrade.json` / flags / CI env into a normalized
`{ model, provider }` declaration and validates it against the family table.
Unknown model → fail closed with a actionable error naming the table file.
*Does not*: verify the claim, probe the model, or do stylometry — all
research-grade theater at v0.

**Reviewer dispatch** (`packages/core/src/dispatch.ts`).
Selects reviewer(s) from the disjoint set, renders the review prompt from the
diff (plus file context, never builder framing), calls provider APIs with
timeout/retry/backoff, and parses structured output. Providers return
findings as JSON under a strict schema; a repair pass (re-prompt with the
broken output + schema) handles the common malformed-JSON case before
giving up and failing loudly — never silently dropping a reviewer.
*Does not*: run reviewers concurrently across threads (plain
`Promise.all` is enough; the latency is the API), or stream partial results.

**Finding normalization** (`packages/core/src/findings.ts`).
Maps every provider's raw output to one `Finding` type:
`{ severity, file, line, category, confidence, message, remediation,
reviewer }`. Handles line-number drift (fuzzy-match the cited snippet
against the diff, ±3 lines, else mark `line: null` rather than lying),
dedupes near-identical findings across jury members, and normalizes
severity vocabularies ("critical/high/…" — providers that invent new
levels get mapped, unknown ones fail the finding, not the run).
*Does not*: re-judge finding correctness — that's the reviewer's job; the
normalizer is a clerk, not a second reviewer.

**Certification / signing** (`packages/core/src/certify.ts`).
Canonicalizes the report (sorted keys, no whitespace ambiguity), hashes the
reviewed diff (sha256), signs with Ed25519, emits `{ report, signature,
keyId }`. `verify` re-checks signature, diff hash, and family-disjointness
from first principles. Key management is user-owned (`keygen` writes to
`~/.noselfgrade`, mode 600); no KMS, no hosted PKI in v0.
*Does not*: timestamp via a third party (system clock + signature is
enough for merge-gating), or revoke keys (document rotation as
publish-new-key).

**Reporters** (`packages/core/src/reporters/`).
SARIF (first-class — must validate against the official schema in tests,
so GitHub code scanning ingests it), JSON (machine-readable, includes the
full certification envelope), Markdown (human-readable, embeds the
independence statement: who declared what, who reviewed, disjointness
proof). *Does not*: HTML in v0 — Redteam already proved the pattern;
add it when someone asks, not before.

**CI action** (`action/`).
Composite action: `builder-model`, `builder-provider`, `fail-on`,
`jury` inputs; runs the review, writes SARIF to the step summary, uploads
SARIF via `github/codeql-action/upload-sarif`, exits non-zero when
unresolved findings meet the threshold. *Does not*: post PR comments in
v0 (SARIF annotations already surface inline; comments are a v1 nicety).

---

## 4. What v0 deliberately defers

1. **Local model inference** (llama.cpp / Ollama reviewers). Tempting for
   "fully independent" story and cost, but local models are weaker reviewers
   *and* the ops surface (model downloads, GPU/CPU detection, quantization
   choices) would swallow the project. Remote APIs only until someone
   profiles a real need.
2. **Builder identity verification** (watermark detection, stylometric
   fingerprinting). Research-grade, unreliable, and claiming it works would
   be dishonest. The architecture is explicitly scoped to *declared*
   identity; verification is a research project, not a v0 feature.
3. **Multi-round reviewer↔builder debate.** Intellectually appealing,
   doubles cost and latency, and single-pass + jury voting captures most of
   the value. Revisit with data, not enthusiasm.
4. **Auto-fix / applied patches.** Report-only by design — same call as
   Redteam. A certification tool that rewrites code undermines the
   independence story (whose judgment shipped?).
5. **A quality-bar DSL.** v0 gates on two knobs: severity threshold
   (`--fail-on`) and unresolved-finding count. A rule language for "fail if
   auth findings in `src/auth/**`" is v1 after real usage shows the shape.

---

## 5. Biggest risks

**Risk 1 — The independence claim gets dismissed as theater.**
If the docs overclaim ("provably independent"), the first skeptical security
engineer kills adoption and the project is a joke. *Hedge:* the architecture
scopes the claim with surgical precision — disjoint-from-*declared*-builder,
reviewer-side API authentication, signed ceremony — and prints the
limitations in the README, not the fine print. Honest scoping *is* the
feature; "we tell you exactly what we guarantee" beats every competitor's
vague "AI-powered review."

**Risk 2 — LLM reviewers are flaky, slow, and expensive in CI.**
Non-deterministic output, malformed JSON, 30–90s latency per review,
$0.10–$1.00 per PR diff at frontier pricing. A tool that flakes CI gets
deleted. *Hedge:* strict-schema prompting + repair fallback + loud failure
(never silent); diff-scoped reviews (changed files + minimal context, not
whole repos); finding cache keyed by diff hash (re-review of an unchanged
diff is free); jury opt-in, single reviewer default; configurable timeouts.
The quality bar must be tuned so the *default* CI story is "blocks on
high-confidence findings," not "blocks on everything."

**Risk 3 — It's a thin wrapper, and everyone knows it.**
Calling two LLM APIs isn't a moat. If the pitch is "we call Claude to check
GPT's code," there's no there there. *Hedge:* the product is the
*certification ceremony*, not the API calls — the family table, disjoint
dispatch, normalization, signed tamper-evident report, SARIF/CI integration.
Make the ceremony excellent and the prompt packs + family table
contributor-extensible (that's the open-source moat: the curated table and
the review prompt corpus get better with contributors). Never pretend the
API calls are the IP.

---

## Appendix: data flow (v0)

```
builder declares (model, provider)          # untrusted, recorded as declared
        │
        ▼
family table lookup ──unknown──▶ fail closed
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
reporters: SARIF / JSON / Markdown  →  CI gate on --fail-on
```

## Appendix: repo layout

```
noselfgrade/
  packages/core/src/
    builder.ts        # declaration parsing + family-table validation
    families.ts       # curated model → { family, provider } table
    dispatch.ts       # reviewer selection + provider API calls
    providers/
      anthropic.ts openai.ts openai-compatible.ts
    findings.ts       # normalization, drift handling, jury merge
    certify.ts        # canonicalization, hashing, Ed25519 sign/verify
    reporters/        # sarif.ts json.ts markdown.ts
  packages/cli/src/   # citty: review, verify, keygen, families list
  action/             # GitHub Action (composite)
  testdata/           # per-scenario fixtures (diff in → findings out)
```
