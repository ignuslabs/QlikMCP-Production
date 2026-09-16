# Native Visualization Contract

**Related:** [Architecture](03-reference-architecture.md), [Cloud](04-qlik-cloud-integration.md), [Client-managed](05-client-managed-integration.md)

## Goal

Let an agent express an analytical request without allowing it to issue arbitrary native object properties. The harness owns compilation; Qlik owns object evaluation.

## Agent-Facing Chart Intent

```json
{
  "connection": "cloud-dev",
  "appId": "approved-app",
  "sheetId": "designated-sheet",
  "intent": {
    "analysis": {
      "dimensions": ["Region"],
      "measures": ["Sum(Sales)"],
      "filters": [{ "field": "Year", "values": ["2026"] }]
    },
    "presentation": {
      "preferredChartType": "bar",
      "title": "Sales by region",
      "sort": "measure-descending"
    },
    "mode": "preview"
  }
}
```

This is the strict `qlik_plan_visualization` input. Target identity is supplied
at the tool level; `intent` carries only the analytical request. The harness
resolves display names from an authorized semantic catalog and rejects
ambiguity. It does not let a model create an arbitrary engine expression by
providing a string.

## Compiler Requirements

1. Resolve fields, master dimensions/measures, variables, and sheet references against the target app.
2. Enforce target/version-specific allowlists of native chart types and property options.
3. Validate expressions, aggregations, filters, sorting, and cardinality against policy.
4. Build a native generic-object property proposal using supported schema/types/templates.
5. Assign a deterministic plan hash before preview; require a caller-generated
   idempotency key only for an approved apply.
6. Return resolved references, warnings, risk, and a compact diff before persistence.

The exact property tree is not portable. It varies by chart type, product version, installed capabilities, and behavior. SDK types, QIX schemas, Qlik-native templates, and integration tests are the implementation authority.

## Versioned visualization registry

The compiler maintains three distinct identifiers. The logical chart ID is the
stable harness request (`bar`, `table`, and so on). The Qlik in-app ID is used
for catalog support and `qInfo.qType`. The Nebula ID identifies an
`@nebula.js` visualization package and is metadata only; it is never a fallback
for `qInfo.qType`.

The following current Qlik.dev snapshot is pinned in
[`chartTypeRegistry.ts`](../src/compiler/chartTypeRegistry.ts). Versions are
property-specification versions captured on 2026-08-10, not a claim that each
package version is certified for every Qlik Sense Enterprise on Windows
release.

| Logical ID | Current Qlik in-app ID | Nebula ID         | Current Qlik.dev property spec                                      |
| ---------- | ---------------------- | ----------------- | ------------------------------------------------------------------- |
| `bar`      | `barchart`             | `sn-bar-chart`    | [`2.7.0`](https://qlik.dev/specs/javascript/sn-bar-chart.json)      |
| `line`     | `linechart`            | `sn-line-chart`   | [`2.7.0`](https://qlik.dev/specs/javascript/sn-line-chart.json)     |
| `scatter`  | `scatterplot`          | `sn-scatter-plot` | [`3.60.1`](https://qlik.dev/specs/javascript/sn-scatter-plot.json)  |
| `table`    | `sn-table`             | `sn-table`        | [`6.51.0`](https://qlik.dev/specs/javascript/sn-table.json)         |
| `kpi`      | `kpi`                  | `sn-kpi`          | [`2.4.0`](https://qlik.dev/specs/javascript/sn-kpi.json)            |
| `gauge`    | `gauge`                | `sn-gauge`        | [`0.10.0`](https://qlik.dev/specs/javascript/sn-gauge.json)         |
| `treemap`  | `treemap`              | `sn-treemap`      | [`1.8.0`](https://qlik.dev/specs/javascript/sn-treemap-events.json) |
| `pie`      | `piechart`             | `sn-pie-chart`    | [`2.8.0`](https://qlik.dev/specs/javascript/sn-pie-chart.json)      |
| `combo`    | `combochart`           | `sn-combo-chart`  | [`1.43.0`](https://qlik.dev/specs/javascript/sn-combo-chart.json)   |

Qlik's [visualization identifier matrix](https://qlik.dev/embed/foundational-knowledge/visualizations/)
also lists legacy `table` as a separate in-app visualization with no Nebula
implementation. A [Nebula `sn-table` tutorial](https://qlik.dev/embed/nebula/customize/visualizations/sn-table/)
registers that package under the arbitrary local name `table`; that tutorial
alias is not a persisted Qlik type and must not be used to translate legacy
`table` properties into `sn-table` properties.

## Target profiles and the table boundary

| Profile                               | Target boundary                 | Qlik type for logical `table` | Property version source                       |
| ------------------------------------- | ------------------------------- | ----------------------------- | --------------------------------------------- |
| `qlik-cloud-current`                  | Current Qlik Cloud              | `sn-table`                    | Pinned Qlik.dev `6.51.0`                      |
| `qlik-windows-pre-november-2025`      | Windows May 2025 and earlier    | legacy `table`                | Not applicable                                |
| `qlik-windows-november-2025-or-later` | Windows November 2025 and later | `sn-table`                    | Required same-host validated semantic version |

Qlik made the straight table native in
[Qlik Cloud on 2025-08-07](https://qlik.dev/changelog/156-straight-table-goes-native/).
In [Windows May 2025](https://help.qlik.com/en-US/sense/May2025/Subsystems/Hub/Content/Sense_Hub/Visualizations/VisualizationBundle/sn-straight-table.htm),
the `sn-table` straight table was still a Visualization Bundle object. The
[Windows November 2025 developer notes](https://help.qlik.com/en-US/sense-developer/November2025/Content/Sense_Helpsites/WhatsNew/What-is-new-developer-Nov2025.htm)
identify `sn-table` as the native in-app/embedding type.

Qlik does not publish a Windows-release-to-`sn-table`-property-version map.
Modern Windows connections therefore fail closed unless their policy includes
a semantic `visualizationSchemaVersion` observed from a known-good straight
table on that same host and release. The compiler includes the profile and
resolved version in the plan hash, so approval for one target contract cannot
be replayed after changing it.

For `sn-table`, the compiler emits the required root `version`, a table-specific
hypercube with `qColumnOrder` and `qInterColumnSortOrder`, and explicit table
defaults. The legacy Windows profile emits the legacy `table` template without
an `sn-table` version. Neither template invents root `sorting`; sorting lives in
the hypercube definition. Cloud-native proposals include the root
`visualization` discriminator used by the validated tenant contract; runtime
verification also checks `layout.visualization` after Qlik evaluates the
object.

## Chart Selection Policy

| Intent                     | Preferred native chart       | Guardrail                                                                  |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| Single value versus target | KPI or gauge                 | Require an explicit target for gauge use.                                  |
| Categorical comparison     | Bar                          | Limit cardinality or propose top-N.                                        |
| Trend                      | Line or combo                | Require a valid time dimension/grain.                                      |
| Part-to-whole              | Bar, treemap, or limited pie | Avoid high-cardinality pies.                                               |
| Distribution               | Deferred                     | Histogram and box plot are not accepted by the current nine-type contract. |
| Relationships              | Scatter                      | Require numeric measures and sufficient data.                              |
| Detail                     | Table                        | Bound row/page count and sensitive fields; pivot is deferred.              |
| Geography                  | Deferred                     | Map is not accepted until a separate geography policy is approved.         |

## Preview and Persistence

1. Create a session object and retrieve a bounded Qlik layout/data sample.
2. Use a session app only when its data/load implications are acceptable.
3. Bind approval to plan hash, actor, target, and expiry.
4. Recheck target state and write permission before creating a persistent object and attaching it to a sheet.
5. Return a render descriptor, not the harness's backend QIX session or credentials.

```json
{
  "objectId": "qlik-object-id",
  "appId": "qlik-app-id",
  "rendering": "qlik-embed",
  "operationId": "operation-id",
  "status": "previewed"
}
```

## Required Tests

- Valid intent creates/evaluates a session chart.
- Unknown/ambiguous fields, unsupported types, and disallowed expressions fail before mutation.
- A read-only actor cannot persist a chart.
- A replayed idempotency key does not create another chart.
- Approval for one plan hash cannot apply another plan or app.
- A Cloud table compiles to versioned `sn-table`; a legacy Windows table
  compiles to `table`; and modern Windows compilation refuses a missing or
  malformed host-validated schema version.
- Platform/profile mismatches fail before a session object or persistent object
  can be created.

## Sources

- [QIX JSON-RPC API](https://qlik.dev/apis/json-rpc/)
- [Qlik Engine JSON API introduction](https://help.qlik.com/en-US/sense-developer/May2026/Subsystems/EngineAPI/Content/Sense_EngineAPI/GettingStarted/using-visualization-API.htm)
- [Nebula.js API](https://qlik.dev/apis/javascript/nebula-js/)
- [Qlik visualization identifiers](https://qlik.dev/embed/foundational-knowledge/visualizations/)
- [Archived open-source `sn-table` v2.9.3](https://github.com/qlik-oss/sn-table/tree/v2.9.3)
- [Qlik open-source visualization changes](https://qlik.dev/changelog/79-open-source-viz-changes/)
