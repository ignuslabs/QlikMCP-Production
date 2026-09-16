# Production operations and release readiness

This runbook applies to Qlik Cloud hosted through Amazon Bedrock AgentCore.
A production-maintained repository is a release candidate until the exact
artifact, deployment, identities, target, and recovery procedure pass acceptance.
Use private operations records for live identifiers; commit only sanitized
outcomes, timestamps, version pins, and opaque evidence references.

## Release an identifiable artifact

1. Use the pinned toolchain from `.nvmrc` and `package.json`, install from the
   lockfile with `npm ci`, and run `npm run release:check` and `git diff --check`.
2. Build the ARM64 image and perform the fixture smoke in the
   [deployment runbook](../deployment/amazon-bedrock-agentcore.md). A successful
   image build alone does not establish startup, MCP, or native Qlik behavior.
3. Record the exact Git commit, clean/scoped diff, lockfile, package checksum,
   image digest, runtime versions, and check results. Run remote CI for that
   commit once a remote and protected review workflow exist.
4. Review all dependency audit findings and release changes. Keep the previous
   accepted image and configuration available for rollback. Do not reuse an
   earlier validation result after changing the release content.

## Accept the deployment and target

Follow the AgentCore runbook to provision the retained foundation, configure
least-privileged credentials privately, inspect the generated deployment diff,
deploy, verify MMDSv2, and test in increasing-risk order.

| Gate           | Evidence required before promotion                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infrastructure | Reviewed account/region, image digest and endpoint version, scoped IAM, encrypted durable state, recovery settings, log retention.                 |
| Authentication | Real requester/reviewer identities; expired, wrong-audience/client/scope, unauthorized-subject, and self-review rejection.                         |
| MCP            | Fresh-session discovery/initialization, expected tool/profile surface, strict-input errors, readiness, sanitized correlation.                      |
| Native Qlik    | Exact allowed resources, preview disposal, deterministic expected data/sort, saved properties, browser rendering under intended identities.        |
| Mutations      | Exact reviewed plans, no second mutation on same-key replay, competing-dispatch rejection, verified cleanup and unchanged unrelated baseline.      |
| Management     | All enabled action classes, staged artifacts/checksums, terminal reload failures, expiry, schedule state, sharing identity boundaries.             |
| Recovery       | Interrupted/partial workflow inspection, retained receipts, reconnect across sessions, uncertain-outcome handling, application rollback rehearsal. |
| Capacity       | Representative data sizes and concurrency, latency/error measures, provider/API limits, quota behavior, deployment capacity controls.              |
| Operations     | Named service/incident owner, alert delivery, credential rotation, access review, backup retention and tested state recovery.                      |

Enable only the actions whose applicable checks pass. A live test using local
provider code does not prove the hosted artifact includes that code. A historical
development run, fixture pass, or HTTP 200 does not establish present production
readiness. Parse tool outcomes and provider terminal state explicitly.

## Operate and monitor

- Check endpoint status, health, sanitized error rates, latency, capacity and
  throttling, OAuth/secret retrieval, and durable-state failures.
- Correlate workflow attempts, terminal results, verification and cleanup. Keep
  pending and uncertain operations visible; alert on unbounded age or missing
  durable results. Test alert delivery before relying on it.
- Review identity/policy changes and expiring readiness. Recheck the intended
  artifact after each deployment and credential rotation.
- Monitor artifact expiry and storage, log retention, state recovery settings,
  and provider quota consumption. In-process quotas do not limit aggregate
  concurrency across Runtime microVMs.
- Keep Qlik data, raw tool inputs, JWTs, and private routing out of logs and
  metric labels. See [provider operations](provider-operations.md).

## Incident and rollback

1. Restrict new writes to the affected scope while preserving read-only
   diagnosis, durable state, logs, receipts, and the unrelated resource baseline.
2. Identify the exact deployment, actor, workflow, step, and correlation ID in
   the restricted evidence system. Separate provider failure from audit-store,
   identity, capacity, verification, or cleanup failure.
3. Use `qlik_management_status` and `qlik_management_reconcile` for management;
   use `qlik_verify_sheet` for sheet readback. Follow
   [management recovery](../management-recovery.md) or
   [sheet recovery](sheet-generation.md). Do not infer no effect from a timeout,
   error code, or present resource state alone.
4. Do not release uncertain locks manually, erase receipts, switch idempotency
   keys, or create replacement plans to bypass reconciliation. A source fix
   cannot retroactively establish a historical write outcome.
5. Route to the last accepted image/runtime version and reviewed compatible
   configuration. Preserve the DynamoDB table and Secrets Manager secret.
   Application rollback does not reverse Qlik changes or restore deleted data.
6. Verify read-only behavior, inspect any persisted changes, and perform only
   scoped compensating actions supported by evidence and existing authorization.
   QVF export is not proof of a restore; this package has no QVF import action.
7. Reopen writes only after the incident's cause, exact-resource state, cleanup,
   and relevant release checks are documented. Rotate exposed credentials through
   the private secret process.

Do not restore a stale state snapshot over active workflows: that can remove
idempotency receipts while leaving Qlik effects in place. A state-recovery drill
must reconcile the restored records with actual provider state before writes
resume.

## Release record

Record pass/fail/not-run separately for source checks, package, container,
configuration validation, hosted identity/state, tenant/native browser,
capacity, and recovery. Include timestamps and an opaque reference for each.
A skipped or unavailable check remains explicit and cannot be relabeled passed.
The [release checklist](../deployment/release-security-rollback-checklist.md)
is a compact handoff; [readiness intake](target-readiness-intake.md) supplies the
administrator process for development rehearsals.
