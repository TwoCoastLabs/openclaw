/** Verdict policy engine request/response types. */

// --- Request types ---

export type ActionContext = {
  principal: string;
  agent_role: string;
  session_id: string;
  identity_verified: boolean;
  customer_consent?: Record<string, boolean>;
  customer_tier?: string;
  extra?: Record<string, unknown>;
};

export type EntityState = {
  stateName?: string;
  fields?: Record<string, unknown>;
};

export type ActionRequest = {
  action_id: string;
  agent_id: string;
  tool: string;
  args: Record<string, unknown>;
  context: ActionContext;
  timestamp: string;
  entity_state?: EntityState;
};

// --- Response types ---

export type Decision = "ALLOW" | "DENY" | "REQUIRE_CHANGES";

export type Violation = {
  policy_id: string;
  severity: string;
  message: string;
  failed_constraints?: string[];
  sop_ref?: string;
};

export type RepairAction = {
  op: string;
  role?: string;
  reason?: string;
  threshold?: number;
  requested_amount?: number;
  fields?: string[];
  consent_type?: string;
  fallback?: string;
  from?: string;
  to?: string;
  disclosure_id?: string;
  target?: string;
  source?: string;
  customer_tier?: string;
  max_value?: number;
};

export type Obligation = {
  type: string;
  target?: string;
  fields?: string[];
  disclosure_id?: string;
};

export type AuditInfo = {
  eval_id: string;
  bundle_digest: string;
  input_hash: string;
  timestamp: string;
  sop_refs?: string[];
  shadow_mode: boolean;
};

export type PolicyDecision = {
  decision: Decision;
  eval_duration_ms: number;
  violations?: Violation[];
  suggested_repairs?: RepairAction[];
  obligations?: Obligation[];
  audit: AuditInfo;
};

// --- Discovery types ---

export type PolicyRule = {
  id: string;
  decision: Decision;
  severity?: string;
  sop_ref?: string;
};

export type PolicyInfo = {
  name: string;
  description?: string;
  source: "yaml" | "rego";
  sop_ref?: string;
  tools?: string[];
  rules?: PolicyRule[];
  obligations?: string[];
  arg_refs?: string[];
};

export type DiscoveryResponse = {
  bundle_digest: string;
  policy_count: number;
  policies: PolicyInfo[];
  coverage?: {
    tools_with_policies: string[];
    tools_without_policies: string[];
    coverage_percent: number;
  };
};

export type PolicyExplanation = {
  name: string;
  description?: string;
  source: "yaml" | "rego";
  sop_ref?: string;
  summary?: string;
  trigger?: {
    tools?: string[];
    conditions?: Array<{
      field: string;
      op: string;
      value: string;
      description?: string;
    }>;
  };
  rules?: Array<{
    id: string;
    decision: Decision;
    severity?: string;
    sop_ref?: string;
    conditions?: Array<{ field: string; op: string; value: string; description?: string }>;
    repairs?: Array<{ op: string; description?: string; fields?: Record<string, string> }>;
  }>;
  obligations?: Array<{ type: string; target?: string; fields?: string[] }>;
};

export type HealthResponse = {
  status: string;
  bundle_digest: string;
  eval_count: number;
  p50_ms: number;
  p99_ms: number;
  shadow_mode: boolean;
};

export type TraceSummaryResponse = {
  time_range: { from: string; to: string };
  total_evaluations: number;
  decisions: Record<Decision, { count: number; pct: number }>;
  top_violated_policies: Array<{ policy_id: string; count: number }>;
  top_tools_by_denial_rate: Array<{
    tool: string;
    total: number;
    denied: number;
    denial_rate_pct: number;
  }>;
};
