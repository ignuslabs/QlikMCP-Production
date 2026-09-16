# Deployment readiness register

This repository begins with **no inherited live-target acceptance**. Historical
source-environment evidence was excluded during import. Populate this template
only from current target-specific checks, following
[target readiness intake](../runbooks/target-readiness-intake.md).

The authoritative configuration, approvals, and detailed results stay in the
restricted operations system. Record only aliases, coarse identity classes,
pass/fail/not-run outcomes, UTC dates, role aliases, and opaque evidence
references here. Do not record hosts, tenant/account IDs, users, tokens, headers,
certificate details, raw responses, or screenshots.

## Development rehearsal template

| Alias                          | Platform   | Read    | Preview/disposal | Write/verify/cleanup | Audit/redaction | Evidence     | Review expiry | Decision |
| ------------------------------ | ---------- | ------- | ---------------- | -------------------- | --------------- | ------------ | ------------- | -------- |
| `cloud-dev` (example)          | Qlik Cloud | not-run | not-run          | not-run              | not-run         | not-supplied | not-set       | blocked  |
| `windows-dev` (reference only) | Windows    | not-run | not-run          | not-run              | not-run         | not-supplied | not-set       | blocked  |

These are synthetic aliases, not configured environments. Windows is not an
AgentCore deployment lane.

## Decision rules

- `blocked`: identity, routing, least privilege, read, redaction, or evidence
  ownership is absent, ambiguous, expired, or failing.
- `read-only`: read, preview/disposal, and audit checks pass; write/cleanup has
  not been authorized and proven.
- `approved-for-development`: all applicable development probes, including
  designated-resource write/verify/cleanup and intended browser identities,
  pass with unexpired independently reviewed evidence.

An administrator confirms the non-production boundary, effective identity,
least privilege, preview disposal, native readback, cleanup, and redaction in
the external evidence record. A sanitized row is a summary, not an authorization
mechanism. Runtime readiness remains explicit and default-deny.

Production acceptance is maintained in the restricted release record and follows
[production operations](../runbooks/production-operations.md). Do not silently
promote one of these example development aliases to production.
