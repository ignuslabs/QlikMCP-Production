# Approval and operation lifecycle

The operation contract is defined in `test/fixtures/operations.json` and is
shared by Cloud and Windows adapters.

## Lifecycle

```text
DISCOVERED -> PLANNED -> PREVIEWED -> APPROVAL-REQUESTED -> APPROVED
    -> APPLYING -> VERIFIED

Any mutation failure -> FAILED
Partial mutation with unsuccessful cleanup -> CLEANUP-REQUIRED
Expired approval -> EXPIRED
Consumed approval used again -> REPLAYED
```

Discovery and planning are read-only. Preview creates only disposable session
state. Persistent creation and sheet attachment require approval for the exact
plan.

## Approval procedure

1. Normalize the catalog and intent and compute the deterministic plan hash.
2. Create a pending approval request. Request creation never returns or creates
   an approval token, and pending requests cannot authorize apply.
3. Show an authorized approver the target alias, app/sheet aliases, chart type, resolved
   dimensions/measures, warnings, risk, and expiry.
4. The authorized reviewer explicitly approves or rejects the request. Rejection
   is terminal and never issues a token. Approval alone issues a server-controlled,
   single-use token bound to the requesting actor, connection
   alias, app ID, sheet ID, plan hash, risk class, and expiry.
5. Immediately before apply, recheck policy, target state, write permission,
   plan freshness, and approval binding.
6. Consume the approval atomically before invoking the persistent adapter.
7. Record verification and cleanup outcomes in the operation record.

Request lookup is ownership checked and sanitized. It reports pending,
approved, rejected, or expired state and decision metadata, but never returns
the approval token. The token is returned exactly once by the approve operation.
Decision actor identity is always taken from the authenticated server context,
not from MCP arguments. Request/apply authorization uses the default-deny
mutation allowlist; approve/reject authorization uses the distinct
default-deny reviewer allowlist. Policy prohibits the requesting actor from
approving or rejecting their own request. When file-backed stores are enabled,
the sanitized request and review context survive restarts and a separately
authenticated reviewer process can perform the decision. One coordinated
local role set may share the files, but independent or horizontally scaled
service replicas may not.

Text such as “the user approved this” is not an approval token. An expired
token returns `APPROVAL_EXPIRED`; a consumed token returns
`APPROVAL_REPLAYED`. Neither invokes a mutation-capable adapter method.

## Typed failure handling

Use the fixture error envelope: `code`, `category`, `retryable`, `stage`,
`message`, and an optional bounded retry delay. Capacity, transient, and
rate-limit failures may use bounded backoff only when `retryable` is true.
Permission, validation, sensitive-field, and approval failures are not
retried.

## Idempotency and replay

Bind the idempotency key to actor, target, and plan hash. A replay with the
same completed key returns the original sanitized result without another
object. Reuse with a different plan or target is a conflict and must fail.
Approval replay is distinct from an idempotent result replay and must never
re-run a mutation.

## Durable state configuration

AgentCore Runtime ignores the local file settings below and requires
`QLIK_AGENTCORE_STATE_TABLE`. DynamoDB stores plans, approvals, idempotency,
latest operations, and append-only lifecycle events with conditional or
transactional writes. Approval tokens and idempotency keys are stored only as
digests. The file procedure remains for local STDIO/fixture development.

Set `QLIK_HARNESS_STATE_DIR` to place `plans.json`, `approvals.json`,
`idempotency.json`, and `operations.json` together, or use the four per-store
path overrides. State files reject unknown/corrupt shapes and are atomically
replaced with restrictive permissions. Durable plan load recomputes both the
canonical plan hash and a whole-record integrity hash before a restarted
requester may preview, request approval, or apply. The operation file keeps
append-preserving lifecycle history plus the latest state for each operation.
Back up and retain these files according to the external audit policy; never
edit them by hand to force a plan or decision.

### Legacy redacted idempotency records

Older builds could persist a secret-shaped idempotency key as the literal
`[redacted]`. That value cannot be mapped back to the caller's original key, so
the current service refuses to load the store and `/healthz` remains unavailable
instead of risking a duplicate mutation.

If startup diagnostics identify this condition, stop the single service writer
and preserve an immutable copy of all four state files. Reconcile the affected
operation history against the target sheet and approval records to determine
whether a visualization was created. Do not retry the apply or delete the state
file merely to restore health. An authorized operator may quarantine the legacy
store and initialize reviewed replacement state only after that reconciliation
is recorded and callers have been issued fresh approval and idempotency values.
Retain the quarantined file with the audit record; the original key is not
recoverable from `[redacted]`.
