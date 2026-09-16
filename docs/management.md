# App, sheet, and dataset management

The AgentCore runtime includes governed Qlik Cloud management through MCP: apps,
native sheets and charts, dataset uploads, load scripts, reloads, schedules,
access management, and exports. These features are disabled by default. The
existing 16-tool visualization interface remains available when no management
policy is enabled.

With management enabled, the `all` profile exposes 27 MCP tools: the existing 16
plus 11 management/workflow/transfer tools. Discover the active management
catalog for the exact action set in the deployed version. `artifact.read` is an
additional policy permission for artifact downloads, separate from catalog
execution actions.

This is an MCP service used by an authenticated client. Its tools operate on
Qlik Cloud resources; this package does not supply a separate app-builder web UI.

For creator-private sheets and explicit publication to permitted app members, see
[sheet visibility](management-sheet-visibility.md).

## Enable an exact scope

1. Copy [config/management.example.json](../config/management.example.json) to
   the ignored `config/management.json`, or add its object as `managementPolicy`
   in the ignored AgentCore deployment input.
2. Select only the actions needed for the intended workflow. Replace the
   placeholder requester subject, client ID, connection alias, space IDs, and
   reviewer identity. Set a future grant expiry and enable the policy.
3. For deployment, generate and validate the configuration using the
   [configuration guide](../config/README.md). The renderer validates the policy
   against the deployed identity lists, routing, and current action schemas.
4. Start the AgentCore runtime with Qlik Cloud routing and securely supplied
   credentials. Discover the management catalog from the requester client.

`QLIK_MANAGEMENT_POLICY_PATH` and `QLIK_MANAGEMENT_POLICY_JSON` are mutually
exclusive. Neither configured means disabled. Deployment generation embeds
non-secret policy JSON; credentials remain in Secrets Manager. The management
context is wired into `src/agentcore/runtime.ts`, not the inherited STDIO or
generic HTTP entrypoints.

The deployment renderer permits `governance.reviewerActors: []` only when the
management policy is explicitly enabled, contains at least one valid grant,
has `reviewers: []`, and every grant explicitly sets `requireApproval: false`.
An omitted approval flag defaults to `true`, including on a read-only grant.
Absent or disabled management policies keep the existing non-empty reviewer
requirement. This exception creates no reviewer identity or approval authority;
all exact requester/client/action/scope and expiry checks still apply. If a
grant requires review, configure a real separately authenticated reviewer.

Every action requires exactly one current grant matching the authenticated
subject, client ID, connection, and action. Grants do not combine. An inspected
source must match an allowed app or space; moves, copies, uploads, and publishing
also require the exact destination. Personal-space access requires
`allowPersonalSpace: true`. New apps can inherit authorization from an explicitly
allowed space. Existing app-backed resources use their current parent app scope,
so forged input metadata cannot authorize a resource.

Production policy requires `environment: "production"` and
`allowProduction: true`. Readiness, Qlik permissions, catalog access, and policy
authorization remain separate checks. Enabling a policy does not establish that
the tenant supports every operation or that its chart catalog is ready.

## Tools and profiles

Call `qlik_management_catalog` to obtain the exact action input schemas, read-only
flags, and effective upload limit. Catalog visibility is not permission to run an
action. The runtime validates the action payload again.

| Tool                        | Purpose                                                                    | Profile   |
| --------------------------- | -------------------------------------------------------------------------- | --------- |
| `qlik_management_catalog`   | Discover action contracts and upload limits                                | Requester |
| `qlik_management_read`      | Inspect resources, preview data, prepare scripts, or profile supplied rows | Requester |
| `qlik_management_plan`      | Validate and bind an ordered workflow without writing to Qlik              | Requester |
| `qlik_management_execute`   | Execute or resume the identical approved workflow                          | Requester |
| `qlik_management_status`    | Inspect persisted progress and receipts                                    | Requester |
| `qlik_management_reconcile` | Independently read back an uncertain attempt without repeating it          | Requester |
| `qlik_management_approve`   | Approve exact steps as a different, authorized reviewer                    | Reviewer  |
| `qlik_upload_begin`         | Allocate a private dataset upload                                          | Requester |
| `qlik_upload_chunk`         | Transfer one checked chunk                                                 | Requester |
| `qlik_upload_finish`        | Validate and seal the upload, returning a bounded preview                  | Requester |
| `qlik_artifact_chunk`       | Download an owner-authorized artifact chunk                                | Requester |

The `all` profile includes both sets. The verifier profile receives no management
tools. Reviewer profile isolation complements the independently authenticated
reviewer requirement; switching a tool profile does not change an actor's grants.

## Implemented actions

| Area                    | Actions                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Apps                    | `app.list`, `app.create`, `app.get`, `app.update`, `app.duplicate`, `app.move`, `app.delete`, `app.publish`, `app.export`           |
| Sheets                  | `sheet.get`, `sheet.create`, `sheet.update`, `sheet.delete`, `sheet.duplicate`, `sheet.publish`, `sheet.unpublish`                  |
| Charts and filters      | `chart.get`, `chart.create`, `chart.update`, `chart.delete`, `chart.reorder`, `chart.export`, `filter.create`                       |
| Master items            | `master.list`, `master.get`, `master.create`, `master.update`, `master.delete` for dimensions and measures                          |
| Dataset files           | `datafile.list`, `datafile.get`, `datafile.upload`, `datafile.replace`, `datafile.delete`, `datafile.quotas`                        |
| Preparation and quality | `data.prepare`, `data.profile`, `script.get`, `script.apply`, `script.set`, `model.inspect`, `table.preview`, `expression.validate` |
| Reloads                 | `reload.list`, `reload.create`, `reload.get`, `reload.wait`, `reload.cancel`, `reload.log`                                          |
| Reload schedules        | `schedule.list`, `schedule.get`, `schedule.create`, `schedule.update`, `schedule.delete`                                            |
| Spaces                  | `space.list`, `space.get`, `space.create`, `space.update`, `space.delete`                                                           |
| Memberships             | `space.member.list`, `space.member.get`, `space.member.create`, `space.member.update`, `space.member.delete`                        |
| Sharing                 | `space.share.list`, `space.share.get`, `space.share.create`, `space.share.update`, `space.share.delete`                             |

`artifact.read` is a policy action used by `qlik_artifact_chunk`, not a separate
catalog execution action. Staging upload chunks requires `datafile.upload`
permission, including when the sealed artifact will later replace a file.

Charts use supported native chart intents and validated sheet placement.
`chart.export` returns bounded tabular values in an isolated engine session's
default selection state, not an image, PDF, or another browser's selections.
`app.export` creates a private QVF artifact. `reload.log` creates a private log
artifact. Schedules are Qlik reload tasks with exactly one recurrence, cron, or
interval definition and a validated time zone.

Creating a sheet does not publish it. A sheet owned by the service identity can
remain private even when an API read confirms that it exists. Read `sheet.get`
for publication metadata, then use separately granted `sheet.publish` or
`sheet.unpublish` with the current `expectedHash`. Publication is independently
read back; approved base content cannot be made private through this action.
Confirm visibility in the intended human user's browser before claiming the
dashboard is available to that user. Sheet publication and app publication are
separate operations.

## Plan, review, execute, verify

Read current resource versions before editing. REST changes use the returned
`sourceVersion` as `expectedSourceVersion` (64 lowercase hexadecimal characters).
Engine changes use returned `expectedHash` or `expectedSheetHash`
(`sha256:` followed by 64 hexadecimal characters). A mismatch requires a fresh
read and a new review of the intended edit.

Submit up to 40 ordered steps to `qlik_management_plan`. Keep the exact original
steps in the client: the service stores their hash and sanitized progress, not
the full scripts or source rows. Where a grant requires approval, a separate
reviewer submits `owner`, `planId`, and the identical steps to
`qlik_management_approve` after reviewing the concrete changes. The requester
then submits `planId` and those steps to `qlik_management_execute`.

An output reference uses a prior step's persisted control value. For example,
this plan creates an app and a sheet in that app; replace the example scope with
the exact approved scope before submitting it:

```json
{
  "steps": [
    {
      "action": "app.create",
      "input": {
        "connection": "cloud-dev",
        "name": "Sales workspace",
        "spaceId": "approved-space-id"
      }
    },
    {
      "action": "sheet.create",
      "input": {
        "connection": "cloud-dev",
        "appId": { "$ref": { "step": 0, "field": "appId" } },
        "sheetId": "sales-overview",
        "title": "Sales overview"
      }
    }
  ]
}
```

References may only select allowed fields from earlier completed steps. Resolved
inputs and current target scope are checked before each action. Per-step claims
and per-target locks prevent concurrent replays. A successful write needs an
independent readback before its step is complete. A workflow is not an atomic
transaction across Qlik resources: earlier completed changes remain if a later
step stops, and no automatic rollback runs.

## Upload and load a dataset

### Transfer a local file

Install dependencies and inject `QLIK_MANAGEMENT_BEARER_TOKEN` through the
approved credential mechanism. Do not place a token in command arguments,
tracked files, or terminal history. The transfer helper supports HTTPS endpoints
and loopback HTTP, and refuses redirects.

```bash
npm run dataset:transfer -- \
  --endpoint https://mcp.example.com/mcp \
  --connection cloud-dev \
  --space-id approved-space-id \
  --file /absolute/path/sales.csv
```

The direct entrypoint is `node scripts/mcp/uploadDataset.mjs`. The optional
`QLIK_MANAGEMENT_MCP_URL` supplies the endpoint if `--endpoint` is omitted.
For CSV use `--delimiter comma`, `semicolon`, `tab`, or `pipe`; comma is the
default. Omitting `--space-id` stages for an explicitly allowed personal space.

The helper reads the file once, sends 192 KiB chunks, checks the final byte count
and SHA-256 digest, and prints metadata without source content. A sealed artifact
is private staging, not a Qlik dataset. Use its `artifactId` in an approved
`datafile.upload` action with `connection`, `spaceId` (string or `null`), and
optional `appId` and `folderId`. Replacement uses `datafile.replace` with
`connection`, `artifactId`, `fileId`, and the current `expectedSourceVersion`.
Raw base64 and arbitrary Qlik temporary content IDs are not accepted by these
management actions.

### Prepare and apply the load script

After upload readback, call `data.prepare` with the target `appId`, `connection`,
and a manifest. The service resolves the file IDs, live app and space, verified
space name and folder path, and current file versions. A source outside the
target app's data scope, an unresolved folder, or inconsistent file metadata
stops compilation.

Example manifest:

```json
{
  "version": 1,
  "tables": [
    {
      "name": "Sales",
      "source": { "format": "csv", "dataFileId": "uploaded-file-id", "delimiter": "," },
      "fields": [
        { "source": "Customer", "as": "CustomerName", "trim": true, "emptyAsNull": true },
        {
          "source": "Amount",
          "type": {
            "kind": "number",
            "format": "0.##############",
            "decimalSeparator": ".",
            "thousandSeparator": ""
          }
        }
      ]
    }
  ]
}
```

Fields support rename, trim, upper/lower case, empty or selected values as null,
text, explicit numeric interpretation, and explicit date interpretation/display.
XLSX sources require a `sheetName`; QVD sources require `format: "qvd"`.
Joins specify `left`, `inner`, `right`, or `outer`, a previously defined
`targetTable`, and explicit keys using the final field names. The compiler
rejects extra common field names because Qlik joins on every common field.
Review join cardinality against data: successful compilation does not prove
unique keys or prevent row multiplication.

Generated scripts use `[lib://Space Name:DataFiles/folder/file.csv]` for verified
named spaces and `[lib://DataFiles/file.csv]` for personal space. The path follows
[Qlik's documented space and folder syntax](https://help.qlik.com/en-US/cloud-services/Subsystems/Hub/Content/Sense_Hub/Spaces/manage-data-files-spaces.htm).
The compiler escapes field/literal delimiters and rejects Qlik dollar expansion.
It does not accept caller-provided connection URLs or free-form transform code.

Review the returned script and `fileVersions`, read `script.get`, then plan
`script.apply` with the same manifest, returned file versions, and current
script `expectedHash`. File versions are checked again around preparation and
the script is read back after saving. `script.set` is a separately grantable
full-script editor; its reviewed script is not constrained to the manifest
compiler's operations. Saving either script replaces the app's load script and
does not load data by itself.

### Reload and inspect

Create a reload with `reload.create`. Follow it with `reload.wait` referencing
the returned `reloadId`. A pending reload returns workflow `waiting`; resume the
same plan and identical steps to check that same reload. Only `SUCCEEDED` allows
downstream steps to proceed. Inspect `model.inspect` and `table.preview` after
success, then use the refreshed catalog to build charts.

`data.profile` checks only the supplied positional rows and column declarations.
It reports missing values, duplicate rows/keys, inferred types, and declared-type
mismatches. It does not scan an entire remote dataset. It preserves leading-zero
identifiers as text and never returns source values in its aggregate summary.

## Bounds and inspection depth

| Resource                                | Bound or meaning                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dataset upload                          | 50 MiB maximum; policy may lower it                                                                                                              |
| Private artifact, including QVF exports | 200 MiB maximum; policy may lower it                                                                                                             |
| Transport chunk                         | 192 KiB decoded bytes, canonical base64                                                                                                          |
| MCP request body                        | 1 MiB at the AgentCore runtime; aggregate requests must also fit                                                                                 |
| Upload preview                          | Up to 50 rows per table and 256 KiB of retained preview characters                                                                               |
| CSV                                     | UTF-8, header row, consistent column counts; full structural scan, bounded retained preview                                                      |
| XLSX                                    | Real cell parsing; up to 20 sheets, 200 columns, 100,000 data rows per sheet, and 500,000 rectangular allocated cells across the workbook        |
| XLSX ZIP envelope                       | 500 entries, 32 MiB total expanded bytes, 16 MiB per entry, maximum 200:1 compression ratio                                                      |
| XLSX content                            | Rejects encrypted, macro-bearing, external-reference, unsafe XML, and inconsistent ZIP content; formulas use cached values without recalculation |
| QVD                                     | XML header inspection only; binary records are not locally validated and require a Qlik reload for row preview                                   |
| Data manifest                           | 20 tables, 200 fields per table, up to 10 explicit join keys                                                                                     |
| Quality request                         | 5,000 rows, 200 columns, 100,000 cells, 2 MiB aggregate text, 16,384 characters per cell                                                         |
| Paged remote reads                      | Usually at most 100 rows/items per request; follow the action's schema and returned bounds                                                       |
| Upload/artifact access                  | Expires after one day, even if physical storage expiry runs later                                                                                |
| Plan authorization                      | 15 minutes to approve/start; once started, one hour to continue execution                                                                        |
| Management state retention              | 90-day expiry on plans, executions, locks, and audit records                                                                                     |

These are service bounds, not statements of Qlik subscription limits. For
example, an XLSX below 50 MiB can still exceed the independent expanded-data
limits. Full CSV parsing validates structure, not business rules. Upload previews
can contain sensitive rows and should only be shown to an authorized recipient.

## Recovery and downloads

| Observed state                                         | Next action                                                                                                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `awaiting-approval`                                    | Have the separate reviewer inspect and approve the identical steps before expiry                                                                                                                          |
| `waiting`                                              | Inspect the existing reload, then resume the same plan; do not submit another reload                                                                                                                      |
| `completed`                                            | Read persisted results; executing identical steps reuses completed checkpoints                                                                                                                            |
| `failed` with `outcome: "rejected"`                    | The provider definitively rejected the mutation; the original plan cannot resend it. Execute or reconcile can repair only a still-owned lock release. Review corrected input in a new plan after release. |
| Version conflict                                       | Inspect the changed resource and plan the newly reviewed edit                                                                                                                                             |
| `needs-reconciliation`, `acknowledged`, or `uncertain` | Read status, then call `qlik_management_reconcile` with the original steps and affected index                                                                                                             |
| `in-progress` without a completed receipt              | Inspect provider and runtime state; reconciliation cannot assume that the attempt finished                                                                                                                |
| Expired plan or execution deadline                     | Read what already completed and plan only the remaining reviewed work                                                                                                                                     |
| Invalid upload content                                 | Finish rejects it and leaves it unsealed; correct the local file and begin a new upload                                                                                                                   |

A version conflict alone does not release an existing execution lock. If the
step has a retained claim, resolve that claim before executing a new plan.

For acknowledged or uncertain attempts, reconciliation performs provider reads
and only releases a target lock after independent confirmation. If creation
returned no acknowledged provider-assigned ID, the service cannot discover a
safe destination automatically. An operator
must inspect the exact provider scope and the retained receipts before any new
write. Do not bypass an unresolved lock or blindly repeat a creation/deletion.
Reconciliation does not replay mutations or implement rollback.

A definitive rejection requires a trusted marker from the direct provider
mutation response with HTTP 400 or 422 and no earlier acknowledged receipt in
memory or durable state. The service first saves `failed` / `outcome: "rejected"`
and only then releases the still-owned lock. A generic validation error, failed
readback, transport failure, or failure after a saved receipt does not establish
this outcome. Those uncertain attempts retain their locks. The current provider
marks direct rejected schedule patches; the rule does not classify every HTTP
400/422 response or every action as safely rejected. See the
[recovery guide](management-recovery.md) for interrupted-release handling.

There is no automatic worker-fencing or missing-receipt recovery tool. An
`in-progress` attempt after process loss needs the privileged
[management recovery procedure](management-recovery.md): establish that the old
worker and any provider operation cannot continue, recover an exact receipt,
and make only a reviewed, conditional, audited state transition before readback.
Elapsed time and a disconnected client do not prove that a mutation stopped.
Keep the lock if that evidence is unavailable.

Exact upload chunk replay is safe; conflicting bytes are rejected. The helper
retries eligible requests only on an explicit retryable server response, at most
three attempts and with a delay of at most ten seconds. An ambiguous transport
failure is not automatically retried. Keep the returned artifact ID for bounded
manual chunk recovery. The helper has no automatic cross-process upload resume;
an abandoned artifact expires after one day. Large transfers can encounter the
configured request quota, whose default is 60 requests per minute.

Download a returned app-export or reload-log artifact with:

```bash
npm run dataset:transfer -- \
  --endpoint https://mcp.example.com/mcp \
  --connection cloud-dev \
  --download artifact-00000000-0000-4000-8000-000000000000 \
  --output /absolute/path/backup.qvf
```

The helper verifies every chunk and the full artifact checksum before creating
the exact output path with private file permissions. It never overwrites an
existing output. Artifact access is owner-bound and rechecks current app scope;
moving or deleting an app can make an older export inaccessible. Download a
required backup before an authorized move or deletion. Source bytes use private
artifact records, separate from sanitized governance audit events.

## Verification and release evidence

The foundation template enables DynamoDB deletion protection in addition to
retention-on-removal and point-in-time recovery. Deployment operators must
separately set and verify 90-day retention on the actual runtime log groups;
the foundation cannot pre-name AgentCore's generated runtime groups. See
[storage protection and log retention](management-recovery.md#storage-protection-and-log-retention).
Template changes and runbook instructions are not evidence that a deployed
table or log group has already been updated.

`npm run check` covers local contracts, fixture behavior, mocked REST/QIX
providers, authorization and profile isolation, upload parsing, script
generation, immutable workflow execution, recovery, state serialization, and
the transfer client. These checks do not establish live Qlik behavior, AWS
cross-replica durability, browser rendering, or permission coverage for a tenant.

`npm run test:live:management` is an explicit, separate sandbox acceptance command.
It creates an app and CSV dataset, saves a version-bound script, waits for reload
success, checks the loaded model, creates a native sheet/chart, verifies exact
chart values, downloads a checksummed QVF, and optionally deletes the exact
created resources. It is excluded from ordinary tests and requires:

- `QLIK_MANAGEMENT_ACCEPTANCE=CREATE_SANDBOX_RESOURCES`
- `QLIK_MANAGEMENT_ACCEPTANCE_ENDPOINT`, `QLIK_MANAGEMENT_ACCEPTANCE_CONNECTION`,
  and `QLIK_MANAGEMENT_ACCEPTANCE_SPACE_ID` for the exact authorized target
- Securely injected `QLIK_MANAGEMENT_ACCEPTANCE_BEARER`
- If approval is required, `QLIK_MANAGEMENT_ACCEPTANCE_ACTOR`, a separately
  authenticated `QLIK_MANAGEMENT_ACCEPTANCE_REVIEWER_BEARER`, and
  `QLIK_MANAGEMENT_ACCEPTANCE_REVIEW=APPROVE_THIS_FIXTURE_RUN`

Cleanup is off unless
`QLIK_MANAGEMENT_ACCEPTANCE_CLEANUP=DELETE_CREATED_RESOURCES` is explicitly set.
Failure leaves resources for inspection. Reports default to the ignored
`.qlik-ai-harness/management-acceptance/` directory and contain sanitized resource
receipts, not tokens or dataset bytes. `QLIK_MANAGEMENT_ACCEPTANCE_REPORT` can
select the report path. Review the report's status, checks, retained resources,
and evidence type; a submitted reload or partial report is not a passed run.

A passed run proves only its recorded identity, target, and operations. Retain
the tested build revision alongside the report so the result can be tied to the
deployed code.
XLSX/QVD ingestion, replacement, publishing, membership/sharing changes, reload
schedules, destructive lifecycle combinations, browser rendering, restart
recovery, concurrency, and capacity still need their own applicable live
acceptance. Existing read-only deployment evidence does not establish those
management capabilities. Use the
[deployment runbook](deployment/amazon-bedrock-agentcore.md) and
[security boundary](../SECURITY.md) when promoting a configured target.

### Additional REST lifecycle acceptance

The optional [REST lifecycle runner](../test/live/managementRestLifecycle.ts)
adds a separate fixture workflow for app rename, duplicate/readback/delete,
dataset replacement, and disabled reload-schedule create/update/readback/delete.
It creates a fresh uniquely named app and CSV in the exact approved shared space.
It accepts no existing app or file ID as a replacement target. Replacement
verification covers file identity, space, byte count, and a changed source
version; it does not prove newly loaded row values without a separate reload.

Run it only after reviewing these exact lifecycle operations and injecting the
existing `QLIK_MANAGEMENT_ACCEPTANCE_*` endpoint, connection, space, and identity
variables. Its additional opt-in is
`QLIK_MANAGEMENT_REST_ACCEPTANCE=CREATE_AND_DELETE_REST_FIXTURES`:

```bash
node scripts/mcp/run-node.mjs -- \
  node_modules/tsx/dist/cli.mjs test/live/managementRestLifecycle.ts
```

The runner always deletes its temporary duplicate and its disabled schedule as
part of a successful lifecycle check. It retains the original fixture app and
dataset unless `QLIK_MANAGEMENT_ACCEPTANCE_CLEANUP=DELETE_CREATED_RESOURCES` is
set. It never enables a schedule or dispatches a reload. A failure preserves
acknowledged IDs for inspection and does not start automatic cleanup.

Reports default to `.qlik-ai-harness/management-rest-lifecycle/`, with the same
optional report-path and independent-reviewer controls as the main acceptance
runner. Each mutation is dispatched once; at most three reconciliation reads
can confirm the same attempt. Unconfirmed writes stop the fixture. Its local
injected-client tests are not evidence of a live REST acceptance run.
