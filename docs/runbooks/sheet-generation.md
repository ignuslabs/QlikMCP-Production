# Create and verify a complete Qlik sheet

The sheet workflow creates a **new** sheet with 1–12 native charts. Its separate server policy explicitly names the actor, app, chart types and maximum chart count. The existing single-chart reviewer workflow remains available.

## Configure a narrow grant

Add `sheetGeneration` to the relevant connection in `config/connections.json` or the deployment's non-secret `QLIK_HARNESS_CONNECTIONS_JSON`:

```json
{
  "sheetGeneration": {
    "actors": ["your-authenticated-workload-actor"],
    "appIds": ["your-app-id"],
    "chartTypes": ["bar", "line", "table", "kpi"],
    "maxCharts": 8,
    "allowProduction": false
  }
}
```

There is no default grant. An MCP argument cannot enable autonomy or change this policy. The compiler also restricts autonomous generation to standard-risk chart plans and bounded result samples. Readiness, provider permissions and the provider's independent app grant must all pass.

For Qlik Cloud, set `QLIK_CLOUD_SHEET_CREATION_APP_IDS` to the exact comma-separated app IDs. A configured Cloud client must implement new-sheet creation and verification. The deterministic fixture adapter supports the same contract for offline checks. Adapters without this capability reject planning before reading the catalog.

Production requires an explicit connection with `environment: "production"`, a sheet grant with `allowProduction: true`, and the corresponding permitted deployment environment. Production discovery is restricted to that grant's actor and apps. This grant authorizes new sheets; it does not enable the existing single-chart mutation path against production sheets.

Keep credentials in the deployment secret mechanism. The connection policy and app IDs are non-secret configuration.

## Follow the four tools

1. **Discover.** Call `qlik_get_readiness`, `qlik_list_apps` and `qlik_get_app_catalog`. Use returned field labels and app IDs. The app must contain a readable source sheet for temporary previews.
2. **Plan.** Call `qlik_plan_sheet` with `connection`, `appId`, `title` and `charts` (1–12 existing constrained ChartIntent objects). Planning reads the catalog once and returns a hash-bound manifest, native object IDs, chart titles and a non-overlapping 24-column × 12-row layout. It creates no Qlik objects.
3. **Preview.** Call `qlik_preview_sheet` with the returned `planHash`. Every chart gets a temporary native session, a bounded data/shape check and cleanup. A whole-sheet deadline and shared process actor/connection admission limits bound resource use. Preview evidence contains counts, not raw QIX properties or full data.
4. **Apply.** Call `qlik_apply_sheet` with `planHash`, a stable `idempotencyKey` and `attempt: 0` (the default). The server requires fresh preview evidence, checks the current catalog against the planned catalog, rechecks policy and readiness, creates the owned sheet, writes deterministic chart IDs, attaches the exact positions and verifies persisted properties and membership.
5. **Verify again.** Call `qlik_verify_sheet` with `planHash` to obtain fresh readback evidence. Verification checks sheet title, exact membership, chart properties and positions. A successful apply replay is historical evidence with its original `verifiedAt`; this tool performs a fresh check.

For a drill-down inspection, use `qlik_list_sheet_objects` on the returned sheet ID and `qlik_get_operation` on the plan, preview or apply operation ID. Operation output includes the audit phase and policy result; internal manifest storage fields stay private.

## Resume partial work safely

An apply result has `status: "verified"` only when the sheet and every chart passed verification. A reported failure returns `status: "partial"`, its sanitized `errorCode`, chart evidence and (while the attempt budget remains) `nextAttempt`.

Reuse **the same plan hash and idempotency key** with the returned `nextAttempt`. The adapter verifies deterministic existing object IDs before resuming. It rejects unrelated objects or changed properties; it does not create replacement duplicates or delete an existing user's sheet. The workflow stops at the first failed chart and retains owned progress for reconciliation.

Each attempt has a conditional durable claim. Simultaneous attempts conflict. Attempt N requires a completed partial receipt from N−1; skipping attempts or changing the original key is rejected. A completed attempt replay returns its original receipt without new native writes.

If a process dies while an attempt is in progress, its outcome is uncertain. The server deliberately blocks automatic takeover. Run `qlik_verify_sheet` and inspect the audit/native state before operator reconciliation; a timeout is not proof that the native write failed. This workflow does not silently expire locks and replay unknown writes.

Plans expire after 15 minutes by default. Replanning and a new preview are required after expiry or catalog/compiler changes. Verification can use retained child plans after logical expiry; the AgentCore edition retains plan artifacts for at least 30 days. Readback after artifact retention ends needs a new reconciliation plan.

## State and performance

The workflow uses the existing plan repository for private compiled chart definitions, the operation repository for actor-bound manifests and preview evidence, and the idempotency repository for request binding and attempt receipts. Local file repositories survive process recreation; AgentCore uses the corresponding DynamoDB repositories and conditional claims. Fresh per-request MCP server instances share these repositories and the configured provider adapters.

Planning performs one catalog read. Cloud apply opens a session for its catalog recheck, one caller/app/sheet-bound session for the ordered creation steps, and a fresh session for final sheet readback. Each chart is still saved and verified before the next one. The mutation session is never shared between requests or callers; escaped writers are revoked when its callback finishes. A later `qlik_verify_sheet` performs fresh provider reads. Other adapters retain their ordinary per-operation behavior.

The Cloud mutation session has a two-minute deadline and a two-second close bound. Cancellation, a pending native call or an unconfirmed close can leave the write outcome uncertain. In that case the durable attempt remains reserved, no `nextAttempt` is issued, and verification plus operator reconciliation is required. Fixture timings measure local orchestration only and do not predict tenant latency, chart-rendering quality or production throughput.

## Verification coverage

`test/integration/sheetWorkflow.test.ts` exercises deterministic layouts; default-deny and production read scope; preview gating; actor ownership; file-store recreation; partial resume without duplicates; conflicting keys; concurrent attempts; manifest corruption; changed native objects; and the complete four-tool workflow over MCP 2026 with a fresh service per request. Adapter tests separately validate native properties, layout, ownership and sheet membership.

These checks establish offline behavior. A real tenant rehearsal must still verify provider permissions, rendered sheet quality, failures under actual load and the intended authentication/AgentCore deployment before claiming live readiness.
