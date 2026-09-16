# Changelog

Changes to this independently maintained Qlik MCP repository are recorded here.
The package remains private and `UNLICENSED`. Capability versions describe
source behavior and do not certify a deployment.

## 0.4.1-rc.1 — Production repository candidate — 2026-09-16

- Import the standalone AgentCore working tree into an independent Git repository,
  preserving package and executable compatibility names.
- Exclude private configuration, credentials, diagnostic captures, generated
  artifacts, deployment state, and historical environment-specific evidence.
- Consolidate onboarding, capability documentation, operations, release checks,
  and source provenance for independent maintenance.
- Pin Node.js 22.23.2 and its npm 10.9.8 toolchain across local development,
  release metadata, CI, and the ARM64 container; use public-registry lockfile URLs.
- Harden private-package contents and validate installation, startup, and relative
  documentation links from the packed artifact.
- Isolate default local workflow state under `QlikMCP-Production` on every host,
  retaining explicit path overrides and rejecting unsafe profile path segments.
- Fix `script.apply` dataset-version rejection before and during preparation:
  durably record proven `dispatch: not-started` before releasing the owned app
  lock. Exact replay preserves the failed result without another dispatch.
  Regression coverage distinguishes this safe rejection from uncertain writes.
- Include the source repairs listed below; deployment and full live acceptance of
  those repairs remain target-specific release gates.

### Imported repairs

- Bind table-preview headers to the same Engine data response as the rows,
  including joined-table results.
- Preserve native chart sort precedence and master-dimension criteria;
  compiler v4 gives changed proposals distinct plan hashes.
- Record terminal reload failure without requiring impossible reconciliation.
- Release an owned workflow lock only after a durable, proven pre-dispatch
  rejection; preserve uncertain historical attempts and acknowledged writes.
- Strengthen acceptance assertions for header/value alignment, exact bar order,
  duplicate rows, and definitive workflow failures.

These repairs were present in the imported working tree. Original local and
limited live-read checks are historical source evidence, not acceptance of this
repository's future deployment. See [provenance](docs/provenance.md).

## Imported 0.4.0 — Management — 2026-09-15

- Optional exact-scope app, sheet, chart, filter, master-item, dataset, script,
  reload, schedule, space membership, publishing, and export actions.
- Owner-bound checksum-verified transfer, bounded dataset inspection, typed
  load-script generation, and sample-labeled quality checks.
- Immutable workflow plans, separate review when required, durable claims,
  receipts, status, and reconciliation without replaying uncertain writes.
- Explicit sheet publishing and recovery of acknowledged export downloads.

## Imported 0.2.0 — AgentCore runtime — 2026-08-14

- Stateless `/mcp` and `/ping`, JWT identity validation, DynamoDB workflow/audit
  state, Secrets Manager integration, and an unprivileged ARM64 Node container.
- Retained AWS foundation, scoped execution role, configuration renderer,
  deployment runbook, and post-deployment MMDSv2 verification.

## Imported 0.1.0 — Governed visualization foundation — 2026-08-10

- Strict discovery, deterministic planning, bounded preview, independent
  approval, idempotent apply, operation lookup, and readiness tools.
- Fixture, Cloud, and Windows adapter code; nine native chart kinds.
- Local MCP launchers, isolated state and secret providers, native-browser
  diagnostics, and reproducible package checks.

Historical version entries summarize imported capabilities; they are not release
tags in this new Git history. Target-specific records stay with their originating
environment and are not carried forward as current readiness.
