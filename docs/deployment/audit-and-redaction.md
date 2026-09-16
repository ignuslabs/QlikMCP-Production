# Audit and redaction

Audit is required for discovery, preview, approval, apply, verification,
retry, failure, and cleanup. Audit data is evidence, not a copy of Qlik
content.

## Required sanitized fields

Record the operation ID, timestamp, correlation ID, requesting principal,
host/client ID, connection alias, platform, target app/sheet IDs, effective
Qlik identity class, intent/compiler version, plan hash, policy result,
approval state, typed outcome, retry count, duration, and cleanup outcome.

## Always redact

Before persistence or MCP response serialization, remove tokens, OAuth
secrets, API keys, certificate and private-key contents, authorization or
proxy headers, QIX handles, raw property trees, load scripts, data
connections, security rules, full layouts, unrestricted data, and sensitive
field values. Keep only bounded counts, classifications, stable synthetic
fixture IDs, and approved aliases.

## Review procedure

1. Inspect a success, permission failure, transient failure, approval replay,
   and partial-apply record.
2. Search the serialized records for the forbidden fields listed in the
   fixture error envelope and connection example.
3. Verify that an unauthorized caller cannot read another operation's details.
4. Verify that correlation IDs remain usable without revealing provider
   credentials or raw Qlik payloads.

Any redaction failure blocks release and requires the target to remain
read-only until corrected and re-tested.

## Implemented persistence and event path

AgentCore uses DynamoDB for compiled plans, approvals, idempotency, latest
operation state, and append-preserving operation history. Plans carry a
whole-record integrity hash; opaque approval and idempotency values are stored
only as SHA-256 digests; transitions use conditional or transactional writes.
Local development can still select validated file persistence through
`QLIK_HARNESS_STATE_DIR` or individual paths. Every saved operation state emits
a sanitized `qlik.harness.operation` event covering
discovery, planning, preview, approval request/decision/denial, apply
denial/lifecycle, verification, and cleanup.

DynamoDB state is shared across AgentCore microVMs and independent requester and
reviewer calls. Inbound AgentCore correlation propagation is covered locally.
CloudWatch retention/access policy and real-target trace capture still require
deployment evidence.

## Deterministic serialized records

The review set is stored in `test/fixtures/audit/`:

- `success.json` covers a verified create and cleanup.
- `permission.json` covers a read-only apply denial.
- `transient.json` covers a retryable preview failure and session disposal.
- `replay.json` covers an idempotent completed-operation replay with no
  adapter mutation.
- `partial-apply.json` covers object creation followed by scoped cleanup.

Each record uses synthetic IDs and aliases only. The fixture manifest in
`test/fixtures/operations.json` lists these files alongside the deterministic
QIX, REST, plan, and response artifacts. These records are contract-test
evidence only; they do not prove live target readiness.

For a local review, parse every JSON file under `test/fixtures/`, assert that
all `artifactRefs` resolve, and scan serialized audit records for the
forbidden names in the error envelope and connection example. Keep the
readiness status blocked until platform-admin-supplied nonsecret evidence is
recorded.
