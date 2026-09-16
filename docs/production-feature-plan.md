# Capability and acceptance matrix

The 0.4.0 source implements the following optional management capabilities.
Management is disabled by default; discover available schemas from
`qlik_management_catalog`. Catalog visibility does not grant permission; calls
enforce exact actor, client, action, and resource grants. The [management guide](management.md) is the operator contract.

| Area               | Implemented behavior                                            | Target-specific acceptance                                                      |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Apps               | Create, inspect, rename, duplicate, move, delete.               | Least privilege, concurrency rejection, provider readback, exact cleanup.       |
| Sheets and charts  | Generate, edit, duplicate, lay out, filter, reuse master items. | Saved native properties, sorted values, sheet visibility, browser rendering.    |
| Datasets           | CSV/XLSX/QVD upload, preview, replacement, deletion.            | Byte/checksum limits, metadata, reloaded rows, unrelated-data preservation.     |
| Data preparation   | Types, field cleanup, joins, generated and edited scripts.      | Intended schema, successful reload, exact expected values and row counts.       |
| Reloads            | Start, inspect, cancel, diagnose, schedule.                     | Terminal state, failure reporting, timezone and disabled-schedule readback.     |
| Quality            | Missing values, duplicates, expression and model concerns.      | Labeled sample bounds and independent checks against the real model.            |
| Sharing and export | Managed-space publishing, membership, exports, app backup.      | Effective-user access, publication readback, private artifact checksum.         |
| Workflow           | Immutable ordered steps, progress, durable claims and recovery. | Same-key replay, competing dispatch, reconnect, failure, and cleanup rehearsal. |

## Invariants

Runtime identity is authoritative. The server validates strict inputs and exact
current resource scope before dispatch. Plan hashes bind inputs and policy;
required separate review binds the unchanged steps. Conditional durable claims
prevent competing dispatch. Unknown outcomes require reconciliation and cannot
be retried under a replacement key or plan.

Dataset/export content is held separately from content-free audit records with
owner, checksum, byte, chunk, and expiry controls. Provider job submission is
not completion. Partial or failed workflows retain their completed changes and
report their actual state.

## Limits

- QVD inspection reads its header; it does not decode or certify binary rows.
- QVF export is available; QVF import/restore is not an implemented action.
- Scheduling targets Qlik reloads, not arbitrary complete workflows.
- Quality results are bounded by supplied samples and Engine metadata.
- Missing receipts and uncertain locks have no automatic takeover or release.
- Managed-space publishing and membership need live acceptance under the exact
  production identities; provider contract tests alone are insufficient.
- Correct saved properties and QIX values do not establish native browser quality.

The imported source includes repairs for the earlier feature-test defects; see
[provenance](provenance.md). No earlier development deployment or time-limited
personal grant establishes readiness for a new target. Track release acceptance
with the [operations runbook](runbooks/production-operations.md).
