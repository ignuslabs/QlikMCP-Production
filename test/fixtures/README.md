# Deterministic Qlik fixtures

These fixtures are synthetic, deterministic, non-secret, and non-production.
They define one logical catalog and operation contract for both `cloud-dev` and
`windows-dev`. The target entries differ only in platform-specific target and
app/sheet IDs; the catalog and scenario expectations are shared.

## Files

- `catalog.json` contains visible fields, master items, chart capabilities,
  explicit examples of metadata excluded for sensitivity or hidden status, and
  the resolvable `empty` variant (`empty-catalog-v1`).
- `operations.json` contains the shared lifecycle, typed error envelope,
  planner negatives, idempotency/approval mismatch cases, and references to
  every deterministic artifact.
- `qix/layouts.json` contains bounded synthetic `GetLayout`-style preview
  payloads for normal and high-cardinality charts.
- `qix/properties.json` contains the versioned native property proposal used by
  the normal chart plan.
- `plans/chart-plans.json` contains normalized intents, resolved catalog IDs,
  plan hashes, warnings, and links to QIX property/layout fixtures.
- `rest/list-responses.json` contains deterministic app, sheet, and empty
  catalog list responses for both target aliases.
- `responses.json` contains sanitized success and typed-error response
  envelopes.
- `audit/*.json` contains serialized redaction-safe success, permission,
  transient, idempotent replay, and partial-apply records.

The corresponding placeholder connection aliases are in
`config/connections.example.json`. No fixture declares a live endpoint or
credential. Any target marked ready must have non-secret readiness evidence
supplied by a platform administrator; these fixtures do not constitute live
validation. Live readiness remains explicitly blocked until that evidence is
provided.

## Fixture resolution and operations

Resolve `catalogVariant` through `catalog.json.variantAliases`, then use the
target's `catalogVariants` map. The `empty` scenario therefore resolves to
`empty-catalog-v1` and fails with `EMPTY_CATALOG` without invoking mutation.
The `artifactRefs` object in `operations.json` is the source of truth for
loading the QIX, REST, plan, response, and audit artifacts.

Use the operation scenarios as contract tests, not as evidence of connectivity.
In particular, replay returns the original sanitized result, a conflicting
idempotency key fails before mutation, and each approval-binding mismatch
fails before an adapter mutation method is called.
