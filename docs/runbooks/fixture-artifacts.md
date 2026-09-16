# Deterministic fixture artifact runbook

The fixture set is a provider-neutral contract test surface for the
`cloud-dev` and `windows-dev` aliases. It is synthetic and non-production; it
does not establish connectivity, authentication, authorization, rendering, or
live readiness.

## Artifact map

| Artifact                                 | Purpose                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `test/fixtures/catalog.json`             | Visible catalog, exclusions, targets, and the `empty` catalog variant. |
| `test/fixtures/operations.json`          | Lifecycle, typed failures, scenarios, and artifact manifest.           |
| `test/fixtures/qix/layouts.json`         | Bounded QIX layout responses for previews.                             |
| `test/fixtures/qix/properties.json`      | Deterministic native property proposal.                                |
| `test/fixtures/plans/chart-plans.json`   | Resolved chart plans and stable hashes.                                |
| `test/fixtures/rest/list-responses.json` | Sanitized REST app/sheet/catalog list payloads.                        |
| `test/fixtures/responses.json`           | Sanitized success and typed-error envelopes.                           |
| `test/fixtures/audit/*.json`             | Serialized redaction-safe audit review records.                        |

Load `operations.json.artifactRefs` rather than relying on directory
enumeration. Resolve JSON-pointer-like fragments against the referenced file
and fail the test if a path, plan hash, target alias, app ID, or sheet ID is
missing.

## Required contract checks

1. Resolve `catalogVariant: "empty"` through `catalog.json.variantAliases` and
   confirm it returns `empty-catalog-v1` with no visible fields, master items,
   or sheets.
2. Confirm normal plans point to deterministic QIX property and layout
   artifacts and retain the expected plan hash.
3. Confirm REST list responses contain only development aliases and stable
   synthetic IDs.
4. Confirm planner negatives, typed `NOT_FOUND`/`MALFORMED_REQUEST`, replay,
   idempotency conflict, and approval-binding mismatch scenarios do not invoke
   mutation.
5. Parse each serialized audit record and verify redaction-safe values,
   required fields, and no forbidden credential, header, handle, raw-payload,
   or unrestricted-data fields.

Never replace fixture aliases with production targets. A platform
administrator must provide separate nonsecret readiness evidence before any
live adapter or write test is enabled.
