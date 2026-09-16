# MCP Server Contract

**Related:** [Architecture](03-reference-architecture.md), [Visualization contract](06-native-visualization-contract.md), [Security](09-security-operations-and-provider-adapters.md)

## MCP Position

MCP is the protocol boundary between the AI host and harness, not the Qlik connection protocol. The harness exposes tools for actions, resources for bounded read-only context, and prompts for approved workflows. Qlik REST/QIX/Engine connectivity stays inside the target adapter.

MCP core server primitives are tools, resources, and prompts. Local development normally uses STDIO; remote multi-client deployment uses Streamable HTTP. A STDIO server must reserve stdout for JSON-RPC and log to stderr.

## Tool Rules

1. Separate read-only from side-effecting tools.
2. Accept discovery-derived IDs, not arbitrary tenant URLs or raw QIX payloads.
3. Use JSON Schema input/output contracts.
4. Make side effects idempotent where possible.
5. Require the applicable server-side policy: bound review for core charts,
   explicit grants for sheet generation, and exact management workflow review
   when required by the configured grant.
6. Return structured output plus concise text for broad host compatibility.
7. Treat all model input and tool metadata as untrusted.

## Core visualization tools

| Tool                                  | Effect              | Purpose                                                   |
| ------------------------------------- | ------------------- | --------------------------------------------------------- |
| `qlik_list_apps`                      | No                  | List accessible policy-allowed apps.                      |
| `qlik_get_app_catalog`                | No                  | Bounded fields, master items, sheets, chart types.        |
| `qlik_list_sheet_objects`             | No                  | Existing native objects on an authorized sheet.           |
| `qlik_plan_visualization`             | No                  | Resolve `ChartIntent` into deterministic plan/hash.       |
| `qlik_preview_visualization`          | Session-only        | Create/evaluate disposable native preview.                |
| `qlik_request_visualization_approval` | Workflow state only | Create a pending request without issuing a token.         |
| `qlik_approve_visualization_request`  | Workflow state only | Approve a pending request and issue its bound token once. |
| `qlik_reject_visualization_request`   | Workflow state only | Terminally reject a pending request without a token.      |
| `qlik_get_visualization_approval`     | No                  | Return sanitized request state without a token.           |
| `qlik_apply_visualization`            | Yes                 | Persist approved plan to permitted app/sheet.             |
| `qlik_get_operation`                  | No                  | Return sanitized operation/audit status.                  |
| `qlik_get_readiness`                  | No                  | Return sanitized service and adapter readiness.           |

These 12 core schemas are shared across STDIO and Streamable HTTP. Four sheet
workflow tools extend the default surface to 16. Optional management adds 11
more tools, for 27 in the `all` profile. The profile limits discovery; current
identity, policy, readiness, and resource checks enforce authorization at call
time. Tool discovery is never proof that a target is approved.

| Profile     | Management disabled                   | Management enabled        |
| ----------- | ------------------------------------- | ------------------------- |
| `all`       | 16 core and sheet tools               | 27 tools                  |
| `requester` | 14 non-decision tools                 | 24 tools                  |
| `reviewer`  | Core approval lookup, approve, reject | Also management approval  |
| `verifier`  | Core approval lookup only             | Core approval lookup only |

Direct STDIO defaults to `all`; the local launcher selects a narrower profile.
AgentCore uses request-authenticated identity and policy with the full surface.
Unknown profiles fail startup. Initialization describes the fail-closed workflow
so clients cannot treat planning, preview, or submitted reloads as completion.

Core capability mapping separates discovery, planning, preview, approval, create,
and service-level inspection. Service-level decision, lookup, and readiness
remain inspectable when a target degrades. See the
[management contract](management.md) for action schemas and policy restrictions;
updates, deletion, scripts, reloads, schedules, publishing, sharing, and exports
are optional management operations, not implicit core-chart privileges.

## Example Schemas

```json
{
  "name": "qlik_plan_visualization",
  "inputSchema": {
    "type": "object",
    "properties": {
      "connection": { "type": "string" },
      "appId": { "type": "string" },
      "sheetId": { "type": "string" },
      "intent": { "type": "object" }
    },
    "required": ["connection", "appId", "intent"],
    "additionalProperties": false
  }
}
```

The plan result includes a `planHash`, resolved references, risk, warnings, preview eligibility, and compact diff. It excludes Qlik credentials, unrestricted raw data, and QIX handles.

```json
{
  "name": "qlik_apply_visualization",
  "inputSchema": {
    "type": "object",
    "properties": {
      "planHash": { "type": "string" },
      "approvalToken": { "type": "string" },
      "idempotencyKey": { "type": "string" }
    },
    "required": ["planHash", "approvalToken", "idempotencyKey"],
    "additionalProperties": false
  }
}
```

Request creation returns no token. A later approve or reject call performs the
decision, and only approval returns a token bound to the requesting actor,
target, plan hash, expiry, and risk class. Apply rechecks state and authorization.
Decision identity comes from a separate default-deny reviewer allowlist, and
policy rejects a requester deciding their own request. In the AgentCore
deployment, the compiled plan, sanitized request/review context, decision,
idempotency binding, and audit history live in DynamoDB and survive replicas and
microVM replacement. Conditional and transactional writes enforce competing
transitions. Durable plans are schema-, canonical-hash-, and
whole-record-integrity-checked before use. File-backed stores remain available
only for single-process local development.

## Resources and Prompts

Suggested bounded resource URIs:

```text
qlik://connections
qlik://connection/{connection}/apps
qlik://connection/{connection}/app/{appId}/catalog
qlik://operations/{operationId}
```

Do not expose full hypercube data, load scripts, connection secrets, security rules, or arbitrary files as default resources. Suggested prompts are `create_verified_sheet`, `design_native_chart`, `review_chart_plan`, and `explain_chart_result`; prompts can guide users but cannot authorize mutations. The sheet prompt walks through discovery, planning, preview, creation, fresh verification and bounded partial-result recovery under an existing server-side grant.

## Transport Policy

| Deployment               | Transport                 | Required behavior                                            |
| ------------------------ | ------------------------- | ------------------------------------------------------------ |
| Developer workstation    | STDIO                     | JSON-RPC only on stdout; no secrets in config.               |
| Shared internal service  | Streamable HTTP           | HTTPS, host authentication, rate limits, audit correlation.  |
| Amazon AgentCore Runtime | Stateless Streamable HTTP | Port 8000, `/mcp`, JWT actor context, shared DynamoDB state. |

The selected hosted implementation is recorded in the
[AgentCore deployment runbook](deployment/amazon-bedrock-agentcore.md). The
Runtime boundary changes transport, identity, state, and secret adapters; it
does not add, remove, or specialize any provider-neutral tool. AgentCore
terminates the public boundary, applies custom JWT authorization, and forwards
only the allowlisted Authorization and correlation headers to the container.

Declare the MCP version/capabilities supported by the chosen SDK at build time and integration-test each host. Do not pin implementation behavior to an old documentation snapshot.

## Sources

- [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [Build an MCP server](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server)

## Scoped sheet-generation tools

With management disabled, the facade exposes 16 tools (14 in the requester
profile), including four tools for new sheets:

| Tool                 | Input                                                     | Evidence/result                                                                                     |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `qlik_plan_sheet`    | Connection, app ID, title, 1–12 constrained chart intents | Canonical plan hash, compiler/catalog binding, native IDs and deterministic layout; no native write |
| `qlik_preview_sheet` | Plan hash                                                 | Per-chart bounded preview counts after temporary-session cleanup                                    |
| `qlik_apply_sheet`   | Plan hash, stable idempotency key, attempt (default 0)    | `verified` or `partial`, per-chart evidence, original verification time, optional next attempt      |
| `qlik_verify_sheet`  | Plan hash                                                 | Fresh persisted sheet/chart/property/placement readback                                             |

All inputs and outputs are strict schemas. The server supplies authenticated actor identity and checks an explicit actor/app/chart/count grant. No tool argument authorizes autonomy. Production grants enable scoped discovery and new-sheet creation; the existing independent-review single-chart mutation policy remains separate.

Sheet manifests, preview evidence and attempt receipts use durable repositories in the AgentCore deployment. Conditional attempt claims prevent concurrent reapplication; unknown in-progress outcomes require readback and operator reconciliation. See [Sheet generation](runbooks/sheet-generation.md) for configuration, safe resume rules, expiry and evidence limits.

## Optional management tools

Management is disabled unless configured. When enabled, the `all` profile adds
`qlik_management_catalog`, `qlik_management_read`, `qlik_management_plan`,
`qlik_management_approve`, `qlik_management_execute`, `qlik_management_status`,
`qlik_management_reconcile`, `qlik_upload_begin`, `qlik_upload_chunk`,
`qlik_upload_finish`, and `qlik_artifact_chunk`.

The catalog describes available schemas; listing an action does not grant access
to it. Read/plan/execute and transfer calls enforce the current exact policy.
The immutable workflow has up to 40 steps and preserves receipts and claims
across requests. Management review requires a different authenticated subject
when the grant requires approval. Recovery inspects durable state and performs
independent readback; it does not replay unknown writes. See
[management](management.md) and [recovery](management-recovery.md).
