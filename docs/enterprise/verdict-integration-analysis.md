# Verdict + OpenClaw Integration Analysis

## What Verdict Is

Verdict is an **Agent Policy Engine** — a deterministic gateway that evaluates AI agent tool calls against business, security, and compliance policies. Its key innovation is a three-outcome decision model:

- **ALLOW** — proceed
- **DENY** — blocked
- **REQUIRE_CHANGES** — proceed _if_ the agent applies structured repair hints (e.g., "add manager approval", "redact PII field", "obtain consent first")

Policies are authored in a YAML DSL (or raw Rego), compiled to OPA bundles, and evaluated locally in <5ms. Every decision carries audit evidence linked back to SOP section references.

### Core Architecture

```
Agent Tool Call
     |
PolicyMiddleware.evaluate()
     |
OPA/Rego bundle evaluation (local, <5ms)
     |
Decision: ALLOW / DENY / REQUIRE_CHANGES
     |
  +--+-- violations[] (policy_id, severity, message, sop_ref)
  +--+-- suggested_repairs[] (machine-actionable deltas)
  +--+-- obligations[] (logging, audit trail requirements)
  +--+-- audit{} (eval_id, bundle_digest, timestamp, sop_refs)
```

### Three Categories of Policy

| Category             | Examples                                                        | Owner                  |
| -------------------- | --------------------------------------------------------------- | ---------------------- |
| **Security**         | Tool allowlists, PII redaction, least-privilege access          | Security Engineering   |
| **Business Logic**   | Discount limits, refund thresholds, escalation rules, SLA terms | Product / Business Ops |
| **Legal/Regulatory** | Consent before marketing, required disclosures, data residency  | Compliance / Legal     |

### Why REQUIRE_CHANGES Matters

Most policy engines return allow/deny. Business and legal rules rarely mean "stop" — they mean "you can do this _if_ you first obtain consent / add a disclosure / get approval / follow the correct procedure." REQUIRE_CHANGES with structured repair hints lets agents self-correct rather than dead-end.

---

## What OpenClaw Already Has

OpenClaw implements multi-layer permission enforcement:

| Layer                    | Mechanism                                                         |
| ------------------------ | ----------------------------------------------------------------- |
| Gateway auth             | Token/password/tailscale roles (operator vs node)                 |
| Tool policy pipeline     | Profile > global allow/deny > provider > agent > group > subagent |
| `before_tool_call` hooks | Plugin-based tool call interception and modification              |
| Owner-only flags         | Restrict sensitive tools to owner senders                         |
| Tool loop detection      | Warn/block repetitive tool calls                                  |
| HTTP hard-deny list      | Extra restrictions for non-interactive surfaces                   |
| Exec approvals           | Operator confirmation for dangerous ops                           |
| Security audit CLI       | Detect misconfig and hardening gaps                               |

Key files:

- `src/agents/tool-policy.ts` — core tool policy system
- `src/agents/pi-tools.before-tool-call.ts` — hook-based tool call interception
- `src/gateway/tools-invoke-http.ts` — HTTP tool invocation with hard-deny list
- `src/gateway/auth.ts` — authentication and role authorization
- `src/security/audit.ts` — security audit system
- `SECURITY.md` — trust model and security boundaries

---

## The Gap Verdict Fills

OpenClaw's current system is **identity-and-permission-based** (who can use what tool). It lacks:

1. **Content-aware policy evaluation** — no inspection of tool call _arguments_ (e.g., "refund amount > $200 requires manager approval")
2. **Business/legal rule enforcement** — discount limits, consent requirements, SLA terms, regulatory obligations cannot be expressed
3. **Structured repair hints** — when a tool call is blocked, agents get a boolean deny, not actionable guidance on how to fix it
4. **Audit trail with SOP traceability** — no mapping from "agent did X" back to "because policy Y implements SOP section Z"
5. **Policy lifecycle tooling** — no replay/impact analysis, no backtesting before deploying new rules, no conflict detection
6. **Corporate policy compliance** — enterprises need to prove their AI agents follow internal SOPs and external regulations

---

## Integration Strategy

### Level 1: Sidecar Policy Gateway (minimal changes)

Run Verdict as a sidecar alongside the OpenClaw gateway. Wire it into the existing `before_tool_call` hook system.

```
Agent tool call -> before_tool_call hook -> HTTP POST to Verdict /evaluate
  -> ALLOW:           proceed
  -> DENY:            block with reason
  -> REQUIRE_CHANGES: feed repairs back to agent, retry
```

**What to build:**

- A `verdict` plugin (`extensions/verdict/`) that registers a `before_tool_call` hook
- The hook serializes the tool call as a Verdict `ActionRequest` and calls the local Verdict gateway
- On `REQUIRE_CHANGES`, apply `suggested_repairs` to the tool params and retry
- On `DENY`, return `{ block: true, blockReason: violation.message }`
- Expose Verdict config (gateway URL, bundle path) via `openclaw config`

**Effort:** Small. Leverages existing hook infrastructure. No core changes needed.

### Level 2: Native Policy Engine (embedded evaluation)

Embed OPA/Rego evaluation directly in the OpenClaw gateway process via Wasm to avoid the HTTP hop.

- Compile YAML policies to Rego to Wasm bundle
- Load bundle in-process (Node has Wasm support)
- Evaluate synchronously in the tool policy pipeline (after allow/deny, before execution)

**Benefit:** Sub-millisecond evaluation, no sidecar to manage, single binary deployment.

**Effort:** Medium. Requires Wasm OPA integration in Node.

### Level 3: Full Corporate Compliance Suite

Build enterprise-grade features on top of Verdict integration:

| Feature                    | Value                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| **Policy management UI**   | Web UI for compliance officers to author/review YAML policies without touching code |
| **Audit log export**       | Every tool call decision in a searchable audit store with SOP cross-references      |
| **Replay/backtesting**     | "What would happen if we deploy this new policy?" against historical agent sessions |
| **Policy-as-code in repo** | `.openclaw/policies/*.yaml` checked into corporate repos, versioned, PR-reviewed    |
| **Compliance dashboard**   | Real-time view of policy evaluations, violation rates, self-correction success      |
| **SOP-to-policy pipeline** | Feed corporate SOPs through LLM-assisted draft, review, and deploy                  |

---

## Concrete High-Value Scenarios

1. **Financial services** — "Agent can issue refunds up to $200; above that, require manager approval" — `REQUIRE_CHANGES` with `add_approval` repair
2. **Healthcare** — "Never access patient records without verifying identity first" — `DENY` until identity verification tool has been called in session
3. **Legal** — "Always include required disclosures before sending marketing messages" — `REQUIRE_CHANGES` with `add_disclosure` repair
4. **IT ops** — "No production restarts outside maintenance windows" — `DENY` with SOP reference
5. **Data governance** — "Redact PII from any tool output before logging" — obligation-based post-processing

---

## Architectural Fit

The integration is clean because:

1. **`before_tool_call` already returns `{ block, blockReason, params }`** — this maps directly to Verdict's ALLOW/DENY/REQUIRE_CHANGES
2. **OpenClaw's plugin system** supports exactly this kind of extension without core changes
3. **Verdict's sidecar deployment** model (localhost, <1ms) matches OpenClaw's single-machine trust model
4. **The YAML DSL** means corporate compliance teams can author policies without understanding OpenClaw internals or Rego

### Hook Mapping

```typescript
// before_tool_call hook return type (existing)
{
  block?: boolean;           // -> maps to DENY
  blockReason?: string;      // -> maps to violation.message
  params?: Record<string, unknown>; // -> maps to REQUIRE_CHANGES (repaired params)
}

// Verdict decision schema
{
  decision: "ALLOW" | "DENY" | "REQUIRE_CHANGES",
  violations: [{ policy_id, severity, message, sop_ref }],
  suggested_repairs: [{ op, fields }],
  obligations: [{ type, target, fields }],
  audit: { eval_id, bundle_digest, timestamp, sop_refs }
}
```

### Design Decision: Where the Self-Correction Loop Lives

| Option                                  | Pros                                                              | Cons                                                               |
| --------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| In the plugin's `before_tool_call` hook | Simpler, transparent to the agent, no core changes                | Limited to param modification, agent unaware of why params changed |
| In the agent's tool execution loop      | More flexible, agent-aware repairs, can ask user for missing info | Requires core changes to the agent loop, more complex              |

**Recommendation:** Start in the hook for simplicity. Move to the agent loop once adoption proves the model.

---

## Recommended Path

1. **Start with Level 1** — build a `verdict` extension plugin. Fastest path to value with zero core changes.
2. **Evolve to Level 2** (embedded Wasm) once adoption proves the model and latency requirements tighten.
3. **Build Level 3** (full compliance suite) for enterprise tier offering.
