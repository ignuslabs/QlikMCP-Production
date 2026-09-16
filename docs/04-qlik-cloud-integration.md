# Qlik Cloud Integration

**Related:** [Platform matrix](02-platform-support-matrix.md), [Libraries](07-library-and-api-selection.md), [MCP](08-mcp-server-contract.md)

## Integration Paths

| Need                            | Preferred path                    | Why                                                                        |
| ------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| Supported LLM workflow in Cloud | Qlik MCP server                   | Qlik documents search, analysis, and dashboard/sheet/chart creation tools. |
| Uniform custom harness behavior | `@qlik/api` plus QIX/REST adapter | One JavaScript package with REST, QIX, and auth modules.                   |
| Low-level native object control | QIX JSON-RPC                      | Qlik's primary direct API for Sense apps and the Associative Engine.       |
| Tenant/app lifecycle            | Cloud REST APIs                   | Manage platform resources, pagination, and rate limits.                    |
| Browser rendering               | `qlik-embed`                      | Qlik's primary embedding framework.                                        |

## Qlik MCP Server

Qlik documents a Cloud MCP server that connects an LLM client to tenant resources. Workflows include exploring apps, querying chart data, applying selections, creating dashboards/sheets/visualizations, master items, and business glossaries.

**Harness decision:** Prefer Qlik MCP when its available tools, data-sharing model, and governance satisfy the request. Use the custom harness for a single Cloud/client-managed contract or custom policy/approval/audit behavior. Qlik warns that approving an MCP connection can share tenant content with a third-party AI system; treat this as a governance gate.

## REST and QIX Division

### Cloud REST

Tenant APIs use URLs such as `https://<tenant>.<region>.qlikcloud.com/api/...`. Qlik recommends OAuth 2.0 for most use cases, supports API keys and certain legacy JWT flows, requires CSRF handling for applicable browser calls, and documents pagination/rate limits. Use REST for resource lifecycle and discovery; generate/use current SDK/OpenAPI clients rather than embedding endpoint assumptions in prompts.

### QIX

QIX uses stateful WebSocket JSON-RPC:

```text
wss://<tenant>.<region>.qlikcloud.com/app/<APP_ID>
```

Global handle `-1` opens a document and yields an app handle. QIX sessions are based on tenant, user, identity, and app; shared sessions can share selections. Use QIX for app/object interaction, layout validation, and session objects. Map documented busy/capacity/permission/not-found close codes to typed errors.

## Preview Strategy

1. Prefer a session object in the target app for normal chart preview.
2. Use a session app only when isolation is required and its load/reload cost is acceptable.
3. Qlik documents session apps as non-persisted memory objects released when the engine session ends.
4. Persist only after the plan hash is approved and write access is rechecked.

## Implemented Adapter Path

The repository implements this path in `src/adapters/cloud/`:

- validate one HTTPS tenant origin and exchange an injected confidential-client
  secret at `/oauth/token` using `client_credentials`;
- cache only the short-lived bearer token with refresh skew and coalesce
  concurrent exchanges without storing the secret in adapter configuration;
- discover apps through `@qlik/api` items pagination;
- open app-scoped QIX sessions for fields, master items, sheets, sheet objects,
  evaluated session previews, persistent object creation/attachment,
  verification, and scoped cleanup; and
- retain each preview's exact owning app session until disposal, including
  timeout/error cleanup paths.

`src/adapters/cloud/cloudRuntime.ts` constructs the adapter only from explicit
routing, OAuth, designated-write-target, and readiness settings. Missing,
malformed, expired, or false readiness stays fail-closed. The standalone
`test/live/cloudAdapterProbe.ts` runs G4 discovery/catalog/preview or the G5
create/attach/verify/cleanup lifecycle only when `QLIK_CLOUD_LIVE_PROBE` is
explicitly `G4` or `G5`. It is not part of the offline `npm run check` gate.
Persistent attachment requires both QIX child membership and a matching,
positioned entry in the parent sheet's `cells[]`; cleanup removes both through
the same parent-property update boundary. The retained G5 variant reopens the
saved app and repeats those checks before emitting its object ID. The separate
visualization matrix validates all nine supported native kinds one at a time
and restores the exact unrelated baseline. Run these checks against the exact
release and intended target; historical source-environment results are not
current acceptance for this repository.

## Authentication Rules

| Scenario                     | Direction                                                             |
| ---------------------------- | --------------------------------------------------------------------- |
| Browser embed                | OAuth SPA, OAuth impersonation, or documented interactive-login path. |
| User-aware harness operation | Approved delegated/impersonation pattern with Qlik permission checks. |
| Service automation           | Dedicated least-privileged OAuth workload identity.                   |
| Public content               | Qlik anonymous embedding only after security review.                  |

Qlik warns against production API keys in browser applications and notes they do not support browser WebSocket connections. Never use an API key as a browser or LLM credential.

## Readiness

- Verify tenant alias, region, OAuth client, redirect URIs, scopes, web integration, and space/app roles with administrators.
- Query model-visible metadata under the effective identity, not a broad admin catalog.
- Limit preview concurrency, close QIX sessions promptly, and back off for capacity failures.
- Render object IDs with `qlik-embed` under the end user's Qlik identity when data reduction must be user-specific.
- The tracked `examples/qlik-embed/` files remain placeholder-only. Generate
  private target configuration and test authorized, unauthorized, and Section
  Access/data-reduced browser identities before claiming the full identity matrix.

## Sources

- [Qlik MCP server](https://help.qlik.com/en-US/cloud-services/Subsystems/Hub/Content/Sense_Hub/QlikMCP/Qlik-MCP-server.htm)
- [Cloud REST APIs](https://qlik.dev/apis/rest/)
- [QIX API](https://qlik.dev/apis/json-rpc/)
- [Qlik API package](https://qlik.dev/toolkits/qlik-api/)
- [Qlik-embed authentication](https://qlik.dev/embed/qlik-embed/authenticate/connect-qlik-embed/)
- [Qlik authentication](https://qlik.dev/authenticate/)
