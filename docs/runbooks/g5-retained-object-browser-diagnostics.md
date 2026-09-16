# G5 retained-object and browser diagnostics

**Status:** Diagnostic procedure; live outcomes are target- and release-specific

**Audience:** Harness engineers, Qlik Cloud application owners, and independent reviewers

## Purpose

Use this runbook to diagnose a retained G5 visualization that exists on a sheet
but shows no data or behaves incorrectly in the Qlik Cloud client. It keeps
four separate claims independently visible:

1. the Engine created and saved the generic object;
2. the sheet owns the object and has one valid positioned cell for it;
3. the Engine evaluated a usable hypercube for the intended fields; and
4. the Qlik Cloud client recognized and rendered the intended native
   visualization under the test user's identity.

A pass in one layer is not evidence that the next layer passed. This is the
test flow, not the Qlik MCP flow.

## Evidence handling

Keep raw browser/QIX captures in restricted external storage; they can contain
session material and tenant data. Repository records must contain only sanitized
outcomes and opaque evidence references. Never restore historical raw captures
from a source checkout or Git history.

The diagnostic flow checks native properties, non-empty expected data, reopened
sheet/object relationships, bounded placement, rendering, and exact cleanup.
Run it for the current target and artifact. The
[readiness register](../deployment/readiness-register.md) does not inherit earlier
development-environment results.

## Correct Qlik object model

The expected relationship is:

```text
sheet properties.cells[]
  -> positioned child object ID and visualization type
     -> generic-object properties (design-time definition)
        -> qHyperCubeDef (dimensions, measures, sorting and fetch window)
     -> generic-object layout (runtime evaluated state)
        -> layout.visualization
        -> qHyperCube.qSize + info/error arrays + data pages
     -> Qlik Cloud renderer under the current browser user's permissions
```

Qlik's [sheet-object guide](https://qlik.dev/toolkits/qlik-api/guides/app-sheet-list-objects/)
documents `sheetProperties.cells[]` as the direct sheet membership and
`layout.visualization` as the evaluated visualization type. It also distinguishes
properties, which hold design-time configuration, from layout, which holds
runtime display and calculated state. QIX
[`CreateChild`](https://qlik.dev/apis/json-rpc/qix/genericobject/) accepts
`qPropForThis` so the child and updated parent properties can be created in the
same Engine operation.

Most native visualizations put a `qHyperCubeDef` at the root. Qlik defines a
[hypercube](https://help.qlik.com/en-US/sense-developer/May2026/Subsystems/Platform/Content/Sense_PlatformOverview/Concepts/Hypercubes.htm)
as dimensions followed by calculated measures: each result row represents a
dimension combination and its associated measure values. The evaluated
`qHyperCube` is evidence about calculation, not just object existence.

For a straight-mode cube, use
[`GetHyperCubeData`](https://help.qlik.com/en-US/sense-developer/May2026/Subsystems/EngineJSONAPI/Content/service-genericobject-gethypercubedata.htm)
with path `/qHyperCubeDef` and a bounded page. A non-empty `qDataPages` property
alone is insufficient; inspect `qSize`, dimension and measure metadata, and the
returned `qMatrix`. Keep the request below Qlik's documented 10,000-cell page
limit.

For current Qlik Cloud tables, Qlik says the native straight table is identified
as [`sn-table`](https://qlik.dev/changelog/156-straight-table-goes-native/).
Its [property specification](https://qlik.dev/specs/javascript/sn-table.json)
includes a schema `version`, `qHyperCubeDef`, `qColumnOrder`, and table component
configuration. The checked-in profiles now preserve the separate legacy Windows
`table` contract and require a host-validated property version for Windows
November 2025 or later. Do not override those profiles from a Nebula tutorial's
local registration name.

Qlik's sheet schema documents the normal grid as 24 columns by 12 rows and
warns that other values can make the client malfunction. Use a non-overlapping
cell within that grid, or adopt the documented responsive/extended-sheet
`layoutOptions` deliberately; do not silently grow the row count. See
[Sense client objects](https://qlik.dev/apis/javascript/sense-client-objects/).

## Required test target

Before running the retained probe, confirm all of the following outside the
repository:

- `cloud-dev` resolves to an approved non-production tenant.
- The app and sheet are synthetic and dedicated to this test.
- The chosen dimension has at least one non-null value visible to the probe
  identity.
- The chosen measure is known to evaluate to at least one finite, non-null value
  for that dimension. Prefer a simple field and an aggregation already proven
  in the Qlik UI.
- The requester and reviewer are distinct authorized actors.
- The browser user has the intended access, and a second read-reduced or
  unauthorized user is available for the negative cases.
- An app owner is ready to remove only the exact harness-owned retained object.

Create one known-good straight table manually in the same app using the same
dimension and measure. This is the control object. In Qlik developer mode,
capture its sanitized properties and layout for comparison. Qlik's
[custom dimensions and measures guide](https://qlik.dev/embed/qlik-embed/customize/qlik-embed-custom-dimensions-and-measures/)
documents how to inspect an existing chart and reuse its dimension and measure
definitions.

## Test matrix

| ID  | Test                          | Procedure                                                                                                    | Required evidence                                                                                                                                                          | Failure signal                                                                                                     |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| T1  | Known-good control            | Open the manually created `sn-table` with the approved browser user.                                         | Object renders; expected row and measure are visible; sanitized property/layout summary is captured.                                                                       | The control is empty or fails to render. Stop: the fixture, app data, or identity is not suitable.                 |
| T2  | Preview calculation           | Run the retained G5 command with the same known-good dimension and measure.                                  | Preview `qcx` equals dimension count plus measure count; `qcy > 0`; a bounded matrix page contains at least one full-width row.                                            | `returnedRows: 0`, missing matrix, wrong width, calculation message, or dimension/measure error.                   |
| T3  | Saved-object reopen           | Open a new QIX app session and reread the exact retained object.                                             | `qInfo.qId` matches; properties and layout are both available; expected dimension/measure counts and visualization identity match.                                         | The object exists but properties/layout are incomplete, type differs, or any info/error field indicates failure.   |
| T4  | Hypercube page                | Call `GetHyperCubeData` on `/qHyperCubeDef` for the retained object.                                         | At least one bounded, full-width matrix row; at least one usable measure cell; counts only are recorded.                                                                   | Empty matrix, short rows, invalid/NaN-only measures, calc error, or page failure.                                  |
| T5  | Sheet attachment and geometry | Reread sheet properties and child info.                                                                      | Exactly one `cells[]` entry names the object; type matches; bounds are positive, non-overlapping, and inside the supported grid or an explicitly approved extended layout. | Child without cell, cell without child, duplicate cell, overlap, out-of-bounds placement, or silent row growth.    |
| T6  | Native renderer schema        | Compare the retained object with the control object.                                                         | Platform-correct `layout.visualization`; required schema version and type-specific table defaults; documented hypercube sorting and column order.                          | Legacy or missing visualization discriminator, missing required properties, invented sorting, or schema mismatch.  |
| T7  | Authorized browser render     | Open the exact retained object in Qlik Cloud and run the companion observer.                                 | Visible non-zero element bounds; no uncaught render error; no persistent incomplete/empty/error state; expected rows visible.                                              | Blank frame, spinner timeout, incomplete visualization, renderer exception, detached/replaced element, or no data. |
| T8  | Read-reduced user             | Repeat with the approved read-reduced identity.                                                              | Only authorized rows/aggregates appear; observer records state/categories, never values.                                                                                   | Full-data exposure, stale data from the first identity, or unauthorized object access.                             |
| T9  | Unauthorized user             | Repeat without sheet/object access.                                                                          | Access is denied without leaking data or a workload credential.                                                                                                            | Object data renders or secrets appear in browser/network/console evidence.                                         |
| T10 | Field escaping                | Repeat with an approved fixture field containing a space or `]`.                                             | Generated inline references are correctly escaped and the cube evaluates.                                                                                                  | Expression error or zero rows caused by an unescaped field reference.                                              |
| T11 | Suppression isolation         | Run known-data variants with diagnostic suppression disabled, then enable one suppression setting at a time. | The first setting that changes `qcy` or the matrix is identified.                                                                                                          | All-suppression-on remains the only test and the empty result is misclassified as success.                         |
| T12 | Result limit                  | Use a dimension with more than ten values and `topN: 10`.                                                    | The chosen chart-specific dimension-limit and sort semantics yield the expected total `qSize.qcy`; initial page size is reported separately.                               | Only the first page is ten while total cube size remains unexpectedly large.                                       |
| T13 | Repeat retain/capacity        | From a clean dedicated sheet, run only the approved bounded repeat scenario.                                 | Each cell remains valid; no overlap or unintended `rows` mutation; every created ID is tracked and removed.                                                                | Timestamped objects accumulate, rows grow, or the Qlik client becomes unstable. Stop further writes.               |
| T14 | Scoped cleanup                | Delete the exact retained test object and reread the sheet.                                                  | Child and matching cell are both absent; the control and unrelated objects remain.                                                                                         | Orphan child/cell, broad deletion, or cleanup cannot be proven.                                                    |

Do not run T13 on a shared sheet. A single T2, T3, T4, T5, T6, or T7 failure is
enough to invalidate the retained run; repeated writes are not a diagnostic
substitute.

## Retained G5 procedure

### 1. Establish the baseline

1. Record an opaque evidence reference and UTC start time.
2. Record the approved aliases, expected dimension count, measure count, and
   minimum expected row count. Do not record field values.
3. Capture a sanitized inventory of the test sheet: object-count, cell-count,
   grid dimensions, and hashes or externally stored references for existing
   IDs.
4. Prove T1. If the manually created control table does not render the known
   data, stop before the harness writes anything.

### 2. Run exactly one retained probe

The probe settings are singular, exact, case-sensitive catalog references,
not CSV or JSON. Use a plain visible field or master-dimension label for the
dimension (maximum 120 characters). For the measure (maximum 200 characters),
use either a visible measure/master-measure label or exactly one
compiler-allowlisted aggregation over a visible measure field: `Sum`, `Avg`,
`Count`, `Min`, `Max`, or `Median`. Control characters and any other expression
form fail closed without echoing the supplied value. Shell quotes protect spaces
and parentheses and are not part of the value. For example:

```bash
export QLIK_CLOUD_PROBE_DIMENSION='Region'
export QLIK_CLOUD_PROBE_MEASURE='Master Revenue'
# Also valid when an explicit aggregation is required:
export QLIK_CLOUD_PROBE_MEASURE='Median(Revenue)'
```

Inject all secrets through the approved local secret mechanism; do not paste
them into the command, shell history, Markdown, or browser console. With the
non-secret settings described in [`.env.example`](../../.env.example), run:

```bash
npm run test:live:cloud:retain
```

Capture the single sanitized JSON result in the approved evidence store. Record
the emitted app, sheet, and object IDs externally and use the exact object ID in
every later step. Do not infer the object from its title or "latest" ordering.
If a failed result contains `cleanupRequired`, stop and use its exact app,
sheet, and object IDs for the scoped cleanup procedure before rerunning. The
result preserves the primary failure code while making the possible orphan
explicit.

The retained probe now fails closed unless its compiler proposal is the pinned
Cloud `sn-table` contract, the session layout reports `sn-table` with at least
one row and one usable measure cell, and the reopened retained object preserves
`qInfo.qType`, `version`, column order, inter-column sort order, and
`layout.visualization`. Its sanitized result reports only those schema values
and counts. The `inputContract` summary reports only the accepted format,
resolved source category (`field` or `master-item`), and role-match boolean;
the preview layout diagnostics report only fixed checks, normalized types, and
counts. Neither new diagnostic contains labels, expressions, titles, object
IDs, or matrix cells. It still reports `workflow-component-passed`, not a full G5 pass:
the independent browser smoke and the remaining control/comparison checks below
must still succeed.

Interpret a failed `layoutDiagnostics` block as follows:

- `objectIdMatchesSession` or `qInfoIdMatchesSession` false means the returned
  layout is not bound to the created session object.
- `objectTypeMatches`, `qInfoTypeMatches`, or `cubeModeMatches` false means Qlik
  evaluated a different visualization/type mode than the pinned `sn-table`
  contract.
- Column or dimension/measure-info count checks false mean the evaluated cube
  shape differs from the compiled one-dimension/one-measure plan.
- `rowCountPositive`, `returnedRowsPositive`, or `matrixRowsPositive` false
  means the cube/page is empty. Check the known-good control, current identity,
  app data, suppression settings, and measure evaluation.
- `fullWidthMatrixRowPresent` false means no returned row has the expected
  dimension-plus-measure width.
- `usableMeasureCellPresent` false means the bounded page contains no finite
  numeric or non-empty formatted measure cell; normalized or numeric `NaN`
  values never pass this check.

### 3. Inspect Engine state after reopen

Using a fresh approved QIX session, compare the control and retained objects.
Record only structural fields and counts:

- properties: `qInfo.qId`, `qInfo.qType`, `version`, title
  controls, `qHyperCubeDef.qMode`, dimension/measure counts,
  `qColumnOrder`, `qInterColumnSortOrder`, suppression flags, and initial-fetch
  page coordinates;
- layout: `qInfo`, `visualization`, `qHyperCube.qSize`, dimension/measure info
  counts, the presence and sanitized code/category of errors, data-page count,
  matrix row count, and row widths; and
- sheet: `columns`, `rows`, `layoutOptions`, matching child count, matching cell
  count, and the matching cell's row/column/span geometry.

Then request one bounded matrix page from `/qHyperCubeDef`. Assert the expected
width and at least one usable measure cell in code, but do not print cell values.

### 4. Observe the browser

Open the designated Qlik Cloud app and sheet with the approved user, then use
[`scripts/browser/qlik-g5-observer.js`](../../scripts/browser/qlik-g5-observer.js).
The observer is diagnostic only: it must not receive a tenant credential or
replace the Engine checks above.

For Chrome/Edge DevTools **Snippets**:

1. Open DevTools, select **Sources**, then **Snippets**, and create a new snippet.
2. Paste the script, save it, and run it before opening the target sheet through
   Qlik's in-page navigation when possible so early sheet-render errors and DOM
   changes are observed. A full page reload destroys the installed observer;
   rerun the snippet after any reload.
3. Follow the script's console instructions to target the retained object. Leave
   it running through the render interval, then export/copy only its sanitized
   summary.
4. Stop the observer before changing user identity or target; start a fresh run
   for each matrix case.

The default run is passive with respect to `fetch` and `XMLHttpRequest`. After
installing the snippet, target the retained object with:

```js
QlikG5Observer.stop();
QlikG5Observer.start({ objectId: 'RETAINED_OBJECT_ID' });
```

Only when an isolated second run needs HTTP status/timing correlation, enable
temporary network wrapping explicitly:

```js
QlikG5Observer.stop();
QlikG5Observer.start({
  objectId: 'RETAINED_OBJECT_ID',
  observeNetwork: true,
});
```

Stop that run immediately after reproduction so the original browser globals
are restored. Compare passive and network-enabled runs; if the symptom changes,
classify the observer itself as a possible contributor.

For a quick **Console** run, paste the complete script into DevTools Console and
execute it. Console injection after the sheet has already loaded cannot recover
earlier JavaScript, DOM, fetch, or XHR events, although the browser may supply
buffered resource-timing entries. Reloading removes the observer rather than
making it persistent, so rerun it after a reload or install it before navigating
to the sheet within the same Qlik single-page session. Browser paste-protection
warnings are a browser safeguard; do not disable them on an untrusted page or
paste a modified script you have not reviewed.

Record whether the target element appears, its non-zero geometry, renderer
state transitions, relevant uncaught JavaScript error or rejection categories,
and timeout. The observer does not intercept `console.error` or `console.warn`.
Do not use a DOM observation as proof of hypercube rows: T3 and T4 remain
mandatory.

### 5. Perform identity checks and cleanup

1. End the authorized observer run and sign out through the approved Qlik flow.
2. Repeat in clean browser profiles for the read-reduced and unauthorized users;
   do not reuse storage or an authenticated tab between identities.
3. After evidence review, delete only the exact retained object created by this
   run, following [`test-object-cleanup.md`](test-object-cleanup.md).
4. Reread the sheet and prove both the child and cell are absent. Record the
   cleanup outcome. If cleanup fails, stop further writes to the target.

## Evidence and redaction

Store full target identifiers and approvals only in the approved external
evidence system. The repository artifact should contain aliases, UTC times,
counts, booleans, sanitized error categories, hashes where correlation is
needed, and an opaque evidence reference.

Never capture or paste:

- OAuth client secrets, access or refresh tokens, API keys, cookies, session
  storage, authorization headers, certificate material, or proxy headers;
- tenant-specific WebSocket URLs or copied network requests that contain
  authentication/query material;
- raw `qMatrix` values, dimension values, measure values, selections, user
  names, space membership, or Section Access details; or
- screenshots showing unrelated charts, tenant/user chrome, browser storage,
  DevTools request headers, or raw response bodies.

Prefer structural summaries such as:

```json
{
  "evidenceRef": "external-ref",
  "objectIdHash": "sha256-prefix",
  "visualization": "sn-table",
  "expectedColumns": 2,
  "qcx": 2,
  "qcy": 10,
  "matrixRows": 10,
  "rowWidthsValid": true,
  "dimensionInfoCount": 1,
  "measureInfoCount": 1,
  "calculationErrorCategory": null,
  "matchingSheetCells": 1,
  "browserRendered": true,
  "cleanup": "cleanup-complete"
}
```

If a raw artifact is required for Qlik support, place it only in the approved
restricted system and reference it opaquely from the test record.

## Pass and fail criteria

The retained G5 test passes only when one independently reviewed evidence set
proves all of the following for the same object ID:

- the preview and reopened persistent cube have the expected column count and
  at least one row for the known-data fixture;
- dimension and measure info counts match the plan, with no calculation,
  expression, or validation errors;
- a bounded `GetHyperCubeData` request returns a non-empty, full-width matrix and
  at least one usable measure cell;
- the object is a child of the designated sheet and exactly one valid,
  non-overlapping cell refers to it;
- the renderer identity and required type-specific property schema match the
  approved Cloud visualization version;
- the exact object visibly renders under the authorized browser identity;
- read-reduced and unauthorized behavior matches the approved access model;
- idempotent replay returns the same operation/object identity; and
- exact-object cleanup removes both child and cell without changing unrelated
  objects.

Fail the run if any item is missing, zero/empty where known data is expected,
inconsistent across IDs, timed out, redaction-unsafe, or inferred only from a
fixture/mock. `created`, `attached`, `verified`, an HTTP success, a DOM element,
or `workflow-component-passed` is not independently sufficient.

## Current limits and next checks

- Authorized, unauthorized, and Section Access/data-reduced identity paths
  require current evidence for the target and artifact under review.
- The companion browser observer sees browser/DOM/console behavior. It cannot
  prove Engine data pages, Section Access correctness, or saved QIX properties
  by itself.
- Qlik visualization schemas and Cloud client behavior are version-sensitive.
  Reconfirm the control object's current properties after tenant upgrades.
- Normal product charts may legitimately be empty. The stricter `qcy > 0`
  criterion applies to this known-data G5 readiness fixture, not every chart.
- The current implementation includes fail-closed row/error/width checks,
  bounded hypercube paging, platform/version-specific native builders,
  Qlik-safe field escaping, bounded sheet-cell placement, and empty/error and
  repeated-placement coverage. Preserve those gates during future changes.
- Browser smoke remains a separate live evidence gate even after all offline
  tests pass.
