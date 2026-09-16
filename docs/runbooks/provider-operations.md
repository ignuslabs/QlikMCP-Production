# Remote provider operations

## Telemetry contract

The required contract is that every durable lifecycle record emits
`qlik.harness.operation`, an OpenTelemetry-compatible structured event.
Exporters may translate the event to an OTel LogRecord and derive counters, but
must preserve the event name, operation/correlation IDs, platform, status,
error category/code, policy and approval states, retry count, duration, cleanup
flag, and redaction invariant. The current service records discovery, planning,
preview, approval request/decision/denial, pre-apply denial, apply lifecycle,
verification, and cleanup through the sanitized operation/event path. This is
local implementation evidence only: inbound HTTP correlation is propagated in
local integration coverage, while external OTel export, backend retention and
access controls, live alert delivery, and target trace capture still require
deployment validation.
Do not export actor names, target IDs, object IDs, tokens, layouts, or values as
metric labels.

The sample rules in
[`config/alerts/otel-operation-alerts.yaml`](../../config/alerts/otel-operation-alerts.yaml)
assume an OTel Collector/backend derives `qlik_harness_operations_total` and
`qlik_harness_apply_requests_total`. Adapt query syntax to the selected backend
and test every rule before enabling paging.

## Capacity

1. Stop/reduce preview concurrency for the affected non-production alias.
2. Correlate `capacity` and `rate-limit` events; respect bounded retry delays.
3. Confirm sessions are disposed and no apply is automatically retried.
4. Escalate to the target owner before changing quotas; record the resolution.

## Security

1. Disable writes for the alias and preserve sanitized audit/telemetry evidence.
2. For authorization/policy spikes, verify audience, issuer, host identity, and
   allowlist changes. Do not inspect or copy raw tokens.
3. For a redaction invariant alert, stop all traffic, restrict evidence access,
   rotate potentially exposed credentials through the secret provider, and
   notify the security owner.
4. Reopen only after redaction tests and a sanitized evidence review pass.

## Missing audit

Disable mutations immediately. Reconcile apply ingress counts against terminal
`verified`, `failed`, or `cleanup-required` events by correlation ID. Restore
the audit sink before allowing writes; never treat provider logs as the audit
system of record.

## Rehearsal

The operation-service and fixture integration tests exercise partial apply,
verification failure, scoped cleanup, sanitized outcomes, and replay. Run
`npm test -- --run test/unit/server/operationService.test.ts` and
`npm test -- --run test/integration/e2eWorkflow.test.ts` for local regression
coverage. These are fixtures, not live-provider or incident-response evidence.

Exercise alert delivery, restricted diagnostics, write suspension, identity/secret
rotation, exact-state reconciliation, recovery, and read-only restart against the
reviewed deployed environment. Record each result independently; passing unit
tests cannot establish operational readiness.
