# Platform Support Matrix

**Related:** [Cloud](04-qlik-cloud-integration.md), [Client-managed](05-client-managed-integration.md)

## Rule of Separation

Qlik Cloud and Qlik Sense Enterprise on Windows expose related concepts but different operational APIs, authentication models, deployment controls, and documentation. The harness has one logical contract and separate target adapters. A successful Cloud behavior must not be presumed available in a client-managed target, or the reverse.

## Capability Matrix

| Concern           | Qlik Cloud                                                                                                             | Qlik Sense Enterprise on Windows                                                                               | Harness position                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Vendor MCP        | Qlik documents an MCP server that can search content, analyze apps, and create dashboards, sheets, and visualizations. | Qlik's referenced MCP documentation applies to Cloud.                                                          | Use Qlik MCP when adequate; offer a custom cross-platform adapter.      |
| Operational APIs  | Tenant REST APIs for apps, spaces, items, reloads, web integrations, and more.                                         | QRS, QPS, Engine, and other service APIs.                                                                      | Keep management behind target-specific adapters.                        |
| Engine API        | QIX WebSocket: `wss://<tenant>/app/<APP_ID>`.                                                                          | Engine JSON API via direct certificate or proxy connection.                                                    | Share a QIX-facing abstraction, not a connection implementation.        |
| Browser rendering | `qlik-embed` supported.                                                                                                | `qlik-embed` supports client-managed use.                                                                      | Default to native Qlik rendering.                                       |
| Browser auth      | OAuth SPA/impersonation/interactive login; anonymous where available.                                                  | Authenticated virtual-proxy session, anonymous proxy, or authorization proxy.                                  | Never give browser code a workload credential.                          |
| Backend auth      | OAuth recommended for most use cases; API keys have limitations.                                                       | Trusted backend may use exported certs and `X-Qlik-User`.                                                      | Use vault-managed, least-privileged identities.                         |
| Session scope     | Stateful session based on tenant, user, identity, and app.                                                             | One WebSocket has one user and app context.                                                                    | Reuse only when isolation rules allow it.                               |
| Preview           | Session apps are non-persisted in-memory apps.                                                                         | Session objects available through Engine API.                                                                  | Prefer session objects; use session apps only after cost/data review.   |
| Table properties  | Current native straight table is `sn-table`; the harness pins the current Qlik.dev property version.                   | Legacy `table` through May 2025; native `sn-table` from November 2025, with a host-validated property version. | Resolve from connection policy; never use a Nebula alias as a fallback. |
| Environment setup | Tenant host, OAuth, web-integration/CORS, spaces.                                                                      | QMC proxy, host whitelist, TLS, QRS security rules.                                                            | Require a readiness preflight before write tools.                       |

## Target Adapter Interface

```text
TargetAdapter
  getEnvironmentCapabilities()
  listAccessibleApps(actor)
  getCompilationContext(app, effectiveIdentity)
  getSemanticCatalog(app, effectiveIdentity)
  listSheetObjects(app, sheet)
  createSessionChart(target, compiledProperties, abortSignal)
  disposeSessionChart(connection, sessionObject)
  persistChart(target, compiledProperties, idempotencyKey)
  attachChartToSheet(target, chartRef)
  verifyChart(target, chartRef)
  cleanupObject(target, chartRef)
  renderDescriptor(target, chartRef)
```

This interface deliberately hides REST URLs, QRS types, certificates, QIX handles, and virtual-proxy specifics from agent-visible tools.

## Required Runtime Probe

Before mutation calls are enabled for a target, prove that authentication succeeds, app metadata is available to the effective identity, a session object can be evaluated and cleaned up, persistent creation is allowed only in a designated test area, and audit correlation is possible. Tool discovery alone never proves readiness.

## Compatibility Policy

- Keep the provider-neutral core, sheet, and management schemas consistent across transports. Report
  target capabilities through readiness and enforce them at call time.
- Call a chart type "supported" only when target version, app, permissions, and rendering library support it.
- Default to read-only until a named write policy and preflight have passed.
- Treat extension charts, maps, and product-gated chart types as explicit capabilities, not optimistic defaults.
- Bind every compiled plan to an explicit visualization schema profile. Use
  `qlik-cloud-current`, `qlik-windows-pre-november-2025`, or
  `qlik-windows-november-2025-or-later`; the modern Windows profile additionally
  requires a semantic version validated against that host.

The complete nine-visual identifier/version snapshot and table property
templates are documented in the
[native visualization contract](06-native-visualization-contract.md). Qlik's
[visualization matrix](https://qlik.dev/embed/foundational-knowledge/visualizations/)
distinguishes legacy `table` from `sn-table`, and the
[Windows November 2025 notes](https://help.qlik.com/en-US/sense-developer/November2025/Content/Sense_Helpsites/WhatsNew/What-is-new-developer-Nov2025.htm)
define the native Windows boundary.

## Accepted Contract Differences

The shared discovery, preview, approval, create, cleanup, and rendering contract is
provider-neutral, but the following transport differences are intentional:

| Contract stage    | Cloud target                                                          | Windows target                                                                                                               |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Authentication    | OAuth material is retrieved externally for Cloud REST/QIX.            | Certificate/key/user-header or proxy-session material is retrieved externally for every Engine session.                      |
| Routing           | Tenant REST and QIX routes.                                           | Direct Engine certificate route or an approved virtual-proxy WebSocket route.                                                |
| Preview lifecycle | QIX session object/session-app behavior depends on tenant capability. | A session object belongs to one app/user WebSocket and is disposed before that session closes.                               |
| Rendering         | Browser establishes Cloud OAuth/interactive auth.                     | Browser independently establishes the approved virtual-proxy session; backend certificates are never sent to it.             |
| Errors            | Cloud status/QIX failures map to the shared error taxonomy.           | HTTP/QIX/socket failures map to the same taxonomy and raw messages, routes, headers, handles, and credentials are discarded. |

Both real adapter implementations now have concrete connection paths: Cloud uses
client-credentials OAuth plus `@qlik/api` REST/QIX, and Windows uses either an
injected proxy-session JWT or trusted-backend PFX/user header plus an
`@qlik/api` Engine session factory. This describes retained adapter code, not
current live acceptance. The AgentCore deployment lane permits Qlik Cloud only;
Windows requires separate routing and credential integration. Fixture parity
is not evidence that either live target is approved.

Runtime capability mapping is exact and centralized in
[`src/adapters/capabilityProbe.ts`](../src/adapters/capabilityProbe.ts):

| Capability  | MCP tools                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service`   | `qlik_approve_visualization_request`, `qlik_reject_visualization_request`, `qlik_get_visualization_approval`, `qlik_get_operation`, `qlik_get_readiness` |
| `discovery` | `qlik_list_apps`, `qlik_get_app_catalog`, `qlik_list_sheet_objects`                                                                                      |
| `planning`  | `qlik_plan_visualization`                                                                                                                                |
| `preview`   | `qlik_preview_visualization`                                                                                                                             |
| `approval`  | `qlik_request_visualization_approval`                                                                                                                    |
| `create`    | `qlik_apply_visualization`                                                                                                                               |

Read enables discovery/planning, preview enables preview, and request/apply
requires a configured target with designated-sheet write plus verified cleanup.
Service-level decision, lookup, and readiness tools remain available when target
readiness degrades so pending state can be inspected or closed safely. Tool
availability is enforcement metadata, not proof of an approved live target.

## Sources

- [Qlik REST APIs](https://qlik.dev/apis/rest/)
- [QIX API](https://qlik.dev/apis/json-rpc/)
- [Qlik-embed authentication](https://qlik.dev/embed/qlik-embed/authenticate/connect-qlik-embed/)
- [Windows API reference](https://help.qlik.com/en-US/sense-developer/May2026/Content/Sense_Helpsites/APIs-and-SDKs.htm)
- [Connecting to Engine JSON API](https://help.qlik.com/en-US/sense-developer/May2026/Subsystems/EngineAPI/Content/Sense_EngineAPI/GettingStarted/connecting-to-engine-api.htm)
