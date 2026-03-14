# Lessons from OpenClaw & IronClaw for Regulated AI Agents

Building AI agents for hospitals, banks, and other regulated environments requires security and compliance patterns that go beyond typical developer tooling. This document distills practical lessons from analyzing two agent frameworks — [OpenClaw](https://github.com/openclaw/openclaw) (TypeScript, plugin-based) and [IronClaw](https://github.com/nicholasgasior/ironclaw) (Rust reimplementation with WASM sandbox) — into actionable guidance for regulated deployments.

---

## 1. Policy-as-Code Is Non-Negotiable

Both repos treat tool authorization as a programmable pipeline, not a hardcoded allowlist. In regulated environments, this matters because:

- **Auditors need to read your rules.** Verdict's YAML DSL and OPA/Rego bundles are version-controlled, diffable, and reviewable — exactly what a compliance officer expects. Hardcoded `if` statements buried in application code won't pass muster.
- **Policies change faster than code ships.** Verdict's bundle model lets you update rules without redeploying the agent. A hospital might need to restrict a tool within hours of a new HIPAA guidance — you can't wait for a release cycle.
- **SOP traceability.** Verdict ties every rule to an SOP reference (e.g., `sop_ref: "HIPAA-164.508"`). When a regulator asks "why was this action blocked?", you point to the policy, the SOP, and the audit trail. This is a pattern worth copying verbatim.

## 2. Default-Deny, Not Default-Allow

IronClaw's `fail_open: true` default and OpenClaw's similar pattern are fine for developer tooling. **In a hospital or bank, invert this.** If the policy engine is unreachable, the agent must stop — not proceed unchecked.

Design principle: **every tool call must have an affirmative authorization.** Unevaluated = denied.

## 3. Dual-Sandbox Architecture

IronClaw's WASM + Docker approach is the right model for regulated environments:

| Layer                | Purpose                                                  | Regulated-environment example                                                           |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **WASM sandbox**     | Prevents tool code from accessing host memory/filesystem | A billing tool can't read patient records in memory                                     |
| **Docker container** | Network and filesystem isolation per job                 | A lab-results tool can't make outbound calls to unknown hosts                           |
| **Policy engine**    | Business-rule enforcement                                | "Deny any tool call touching PHI unless the requesting clinician has an active session" |

No single layer is sufficient. A compromised tool that escapes WASM still hits Docker's network restrictions. A policy bypass still can't read encrypted credentials.

## 4. Encrypted Credentials at Rest — Always

IronClaw's AES-256-GCM encrypted credential store is the minimum bar. In regulated environments:

- **Never store secrets in environment variables or plaintext files.** Use a vault (1Password, HashiCorp Vault, AWS Secrets Manager) with short-lived, scoped tokens.
- **Encrypt at rest and in transit.** Even internal service-to-service calls.
- **Rotate aggressively.** IronClaw's per-job ephemeral tokens are a good pattern — each agent invocation gets a fresh token that expires when the job ends.

For a bank: the agent should never hold a persistent OAuth token to the core banking system. It gets a scoped, time-limited token per transaction.

## 5. Human-in-the-Loop Is a First-Class Primitive

Both repos support approval flows, but in regulated environments this needs to be richer:

- **Tiered approvals.** A nurse can approve a medication lookup; only a physician can approve a prescription action. Map your tool permissions to your organization's existing role hierarchy.
- **Verdict's REQUIRE_CHANGES decision** is powerful here — the policy can say "this is allowed, but only if you redact the SSN first" or "this is allowed, but cap the transfer amount at $10,000." Auto-remediation for safe fixes, human escalation for judgment calls.
- **Time-bounded approvals.** An approval should expire. "Dr. Smith approved this 3 hours ago" shouldn't still be valid if the context has changed.

## 6. Audit Everything, Persist It, Make It Queryable

This is the biggest gap in both repos, and the most critical requirement for regulated environments:

- **Every tool call, every policy decision, every approval** must be written to a tamper-evident audit log.
- **Structured, not just text.** You need to query "show me all tool calls that accessed patient records in the last 30 days" — not grep through log files.
- **Retention policies.** HIPAA requires 6 years. SOX requires 7. Your audit store must outlive your agent framework.
- **Separation of duties.** The agent that generates audit events should not be able to delete or modify them.

Neither OpenClaw nor IronClaw ships this. Build it as a dedicated service, not a plugin.

## 7. Secret Leak Detection at the Output Boundary

IronClaw's Aho-Corasick scanner is a good start, but regulated environments need more:

- **PII detection** — scan tool outputs for SSNs, medical record numbers, account numbers before they reach the LLM or the user.
- **DLP integration** — connect to your organization's existing Data Loss Prevention system.
- **PHI/PCI patterns** — regex isn't enough; you need entity-aware detection for medical terms, diagnosis codes, credit card numbers.

This is an **output-side** concern. Even if the tool is authorized to access the data, the agent's response to the user may need redaction.

## 8. Network Segmentation Matters More Than Code

Both repos assume you'll deploy behind a reverse proxy or VPN. In regulated environments, formalize this:

- **Agent to internal services:** Allowlisted endpoints only. The agent should not be able to reach arbitrary internal hosts.
- **Agent to internet:** Blocked or proxied through a DLP-aware gateway.
- **Users to agent:** Authenticated, rate-limited, logged.
- **Policy engine to agent:** Mutual TLS or Tailscale. If an attacker can MITM this connection, they can forge ALLOW decisions.

## 9. Session Isolation Prevents Cross-Contamination

IronClaw's per-job isolation is critical in multi-tenant regulated environments:

- **Patient A's data must never leak into Patient B's agent session.** This means separate memory spaces, separate credential scopes, and separate audit contexts per session.
- **Agent state must not persist between sessions** unless explicitly designed to (and audited).
- OpenClaw's session model is single-tenant. For a hospital with multiple clinicians, you need per-user session isolation with credential scoping.

## 10. What Neither Repo Solves (Your Hardest Problems)

| Gap                          | Why it matters                                                      | What to build                                                                           |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Prompt injection defense** | A malicious lab report could instruct the agent to exfiltrate data  | Input sanitization layer before tool results enter the LLM context                      |
| **Explainability**           | "Why did the agent recommend this treatment?" — regulators will ask | Decision trace that captures the LLM's reasoning chain alongside tool call history      |
| **Model governance**         | Which model version made this decision? Can you reproduce it?       | Model versioning, deterministic sampling (temperature=0), input/output logging          |
| **Consent management**       | Patient must consent to AI-assisted care in many jurisdictions      | Consent verification as a policy precondition, not an afterthought                      |
| **Graceful degradation**     | What happens when the agent is wrong?                               | Circuit breakers, confidence thresholds, mandatory human review for high-stakes actions |

---

## Pragmatic Starting Architecture

```
+---------------+     +----------------+     +-------------------+
|  User (CLI/   |---->|  Agent Core    |---->|  Policy Engine    |
|  Web/Mobile)  |     |  (OpenClaw)    |     |   (Verdict)       |
+---------------+     +-------+--------+     +--------+----------+
                              |                       |
                       +------v--------+        +-----v-----------+
                       |  Tool Runner  |        |  OPA Bundles    |
                       | (WASM/Docker) |        |  (Git-versioned |
                       +------+--------+        |   policies)     |
                              |                 +-----------------+
                       +------v--------+
                       |  Output       |     +-------------------+
                       |  Scanner      |---->|  Audit Store      |
                       |  (PII/DLP)    |     |  (immutable,      |
                       +---------------+     |   queryable)      |
                                             +-------------------+
```

Use OpenClaw as the agent framework (maturity, plugin ecosystem, operational tooling). Borrow IronClaw's sandbox and credential patterns. Deploy Verdict for policy enforcement with `failOpen: false`. Build the audit store and output scanner as separate services — they're your compliance backbone.

---

## Reference: OpenClaw vs IronClaw Security Comparison

| Dimension                | OpenClaw                                                    | IronClaw                                                               | Edge     |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| Language / Memory safety | TypeScript (GC, no buffer overflows)                        | Rust (no GC, no buffer overflows, no data races)                       | IronClaw |
| Sandbox model            | External only (Docker, system hooks)                        | Dual: WASM (Wasmtime) + Docker with all caps dropped                   | IronClaw |
| Credential storage       | SecretRef delegates to vault; plaintext at rest if env/file | AES-256-GCM encrypted at rest; Argon2id key derivation                 | IronClaw |
| Secret leak detection    | None built-in                                               | Aho-Corasick scanner on tool outputs                                   | IronClaw |
| Network security         | Gateway binds loopback by default                           | SSRF protection + DNS rebinding prevention; but binds 0.0.0.0 on Linux | Mixed    |
| Policy engine            | Plugin-based (Verdict extension, composable hooks)          | Built-in Verdict integration (hardcoded)                               | OpenClaw |
| Audit logging            | Structured logs with trace context                          | Decision logging but no persistent store                               | OpenClaw |
| Auth primitives          | Gateway auth tokens, owner-only flags                       | Constant-time comparison, per-job ephemeral tokens                     | IronClaw |
| TLS                      | Not at app layer                                            | Not at app layer                                                       | Tie      |
| Supply chain surface     | npm (large)                                                 | Cargo (smaller)                                                        | IronClaw |
| Maturity                 | Production-deployed, active community                       | Early-stage, limited testing                                           | OpenClaw |
