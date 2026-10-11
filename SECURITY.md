# Security Policy

## Scope: what this tool guarantees — and what it doesn't

NoSelfGrade is a certification ceremony for independent code review. Its
security-relevant guarantees are deliberately narrow:

- **Guaranteed:** the reviewer was selected from a model family *and* provider
  disjoint from the *declared* builder, invoked through that provider's
  authenticated API, and the resulting report (diff hash, declared builder,
  reviewers, findings, verdict) is signed with the user's Ed25519 key and
  verifiable offline.
- **Not guaranteed:** the builder's declared identity (declared, never
  verified — a lying builder defeats any scheme that trusts it); freedom from
  correlated blind spots due to shared pretraining data; resistance to a
  builder deliberately evading review (adversarial evasion is out of scope).

Do not rely on NoSelfGrade for threat models outside this scope — it is a gate
against *accidental* correlated blindness in normal agent workflows, not a
defense against a motivated adversary.

## API key handling

- Reviewers are real LLM API calls; keys are required (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`,
  `MISTRAL_API_KEY`).
- Keys are read from the environment at invocation time. They are **never**
  written to disk, **never** logged, and **never** embedded in reports or
  certificates.
- The only key-derived value that leaves the process is a fingerprint —
  `"sha256:"` + the first 16 hex chars of sha256(key) — recorded in the report
  to prove *which* key/endpoint ran the review, without exposing the key.
- Provider errors truncate response bodies (200 chars) and never include the
  API key.
- In CI, pass keys via secrets (e.g. `${{ secrets.ANTHROPIC_API_KEY }}`), never
  as action inputs or inline values. The GitHub Action takes keys via `env:`
  only.

## Signing key management

- `noselfgrade keygen` writes an Ed25519 keypair to `~/.noselfgrade` with mode
  600. Treat the private key like any other credential: it is the root of
  trust for every certificate you sign.
- There is no hosted PKI and no key revocation in v0. If a private key is
  compromised: stop signing with it, generate a new keypair, and re-issue
  certificates for any diffs you still need to gate on.
- `verify` checks the Ed25519 signature against the public key you supply —
  make sure you're verifying against *your* (or your team's) public key, not
  one bundled with an artifact you didn't produce.
- Anyone who can run `review` with your signing key and your API keys can
  mint certificates in your name. Keep the same access controls on both.

## Diff and prompt hygiene

- The reviewed diff is hashed (sha256) and the hash is part of the signed
  payload — a certificate is only valid for the exact diff it was issued
  against. Reviewing diff A and shipping diff B is detectable by re-verifying.
- Review prompts are constructed from the raw diff only. The builder's
  self-description, chain-of-thought, or framing is never injected into review
  context, specifically to prevent prompt-lineage contamination.
- NoSelfGrade never executes the reviewed code — it diffs and ships text to
  APIs. It cannot sandbox, run, or test your code; it doesn't try.

## Reporting vulnerabilities

If you find a vulnerability — especially anything that weakens the
independence guarantee (e.g. a way to get a same-family reviewer selected,
a signature bypass, or key material leaking into reports) — please report it
privately rather than opening a public issue:

- Email the maintainers via the contact listed on the repository, or open a
  private security advisory on GitHub if available.
- Include: what you did, what you expected, what happened, and the minimal
  reproduction (redact all API keys and private key material).

We aim to acknowledge reports within 72 hours and will credit reporters
unless they ask not to be named.

## Out of scope

- Flaky or low-quality reviewer *judgments* (a reviewer missing a bug is a
  model-quality issue, not a vulnerability in this tool — though reproducible
  prompt failures are welcome as bug reports).
- Provider-side issues: model serving integrity, API outages, billing.
- Social engineering of whoever holds the signing key.
