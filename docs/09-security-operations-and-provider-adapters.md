# Security, Operations, and Provider Adapters

**Related:** [MCP contract](08-mcp-server-contract.md), [Cloud](04-qlik-cloud-integration.md), [Client-managed](05-client-managed-integration.md)

## Security Boundary

The AI host calls the harness but is not a trusted Qlik administrator. The harness validates the caller, evaluates policy, and independently uses an approved Qlik identity. Qlik credentials never cross the MCP boundary.

```text
AI host token -> authenticate to harness
Harness credential -> authenticate to Qlik

Never: AI host token -> pass through to Qlik
Never: Qlik API key/certificate -> return to AI host
```

MCP authorization guidance warns against token passthrough and requires a server to validate tokens intended for that server. Treat the harness as its own resource server, not a transparent credential proxy.

## Threats and Controls

| Threat                           | Required control                                                          |
| -------------------------------- | ------------------------------------------------------------------------- |
| Prompt injection broadens action | Typed intent schemas, allowlists, policy, independent approval.           |
| Invented field/expression        | Resolve only an authorized catalog and reject ambiguity.                  |
| Data exfiltration                | Bounded results/resources, sensitive-field policy, egress audit.          |
| Credential disclosure            | Secret manager, short-lived credentials, redacted logs/results, rotation. |
| Confused deputy/replay           | Validate audience/issuer; bind approval to actor/target/plan hash.        |
| Duplicate chart                  | Idempotency key, plan hash, ownership tag, operation store.               |
| Production mutation              | Environment allowlist, test sheets, confirmation, final revalidation.     |
| Client-managed exposure          | Proxy host whitelist, TLS, private network, certificate isolation.        |

## Identity Model

### Cloud

Use an approved documented OAuth pattern for browser users, user-aware work, or service automation. API keys inherit the creating user's permissions and Qlik warns against using them as browser credentials.

### Client-managed

Use a Qlik proxy session for user-facing browser connectivity or a certificate-authenticated trusted backend connection where QMC policy permits. The adapter owns exported certificates and `X-Qlik-User` usage.

### Harness

- **Local STDIO:** Get credentials from local environment/secret provider, never a tool parameter.
- **Remote HTTP:** Validate OAuth/OIDC callers as a resource server; use an independent Qlik credential flow.
- **Audit:** Record human principal, host/client ID, harness identity, and effective Qlik identity separately.

## Approval and Audit

Discovery and planning do not persist native Qlik changes. Session preview uses
limited resources and exact cleanup. Core chart creation requires an approved
plan; sheet generation requires its explicit actor/app grant. Optional
management provides lifecycle, dataset, script, reload, sharing, and export
actions through exact scope and immutable plans, with separate review when the
grant requires it. It does not grant arbitrary QIX or tenant administration.

An approval response names app, sheet, type, resolved dimensions/measures, change summary, data warning, and expiry. Agent prose that a user approved is insufficient.

Each operation records: operation ID, timestamp, requestor, host, connection alias, platform, target IDs, intent version, plan hash, policy result, approval, Qlik trace/correlation ID where available, result, retry count, duration, and sanitized error category.

The implementation separates request/apply actors from reviewer actors with
two default-deny allowlists and rejects requester self-approval or
self-rejection. Compiled-plan, approval, idempotency, and append-preserving
operation state can be file-backed so restarted requesters and a distinct
authenticated reviewer process can complete a workflow without sharing one
service instance. State is redacted, validated on load, integrity-checked, and
written through atomic same-directory replacement.
This is local coordinated-process storage, not a distributed transaction
boundary. The AgentCore deployment uses DynamoDB conditional and transactional
repositories for shared state across replicas.

Discovery, planning, preview, approval request/decision/denial, apply denial,
apply lifecycle, verification, and cleanup state use the sanitized operation
record/event path. Each saved lifecycle entry emits the vendor-neutral
`qlik.harness.operation` envelope. Validated inbound HTTP correlation is
propagated locally into the operation/event path. External OTel export,
retention/access validation, and target-issued trace evidence remain
release-validation work rather than implemented-live evidence.

## Provider Adapters

### GitHub Copilot and VS Code

VS Code supports MCP configuration in `.vscode/mcp.json`, while Agent Host can
read a portable workspace `.mcp.json` directly. This repository's doctor emits
a machine-local, secret-free `.mcp.json` with absolute Node and launcher paths,
avoiding interactive input variables that Agent Host cannot forward. Three
role-scoped servers keep requester, reviewer, and verifier tools separate.
Windows currently lacks VS Code MCP sandboxing, so local process permissions
and the generated command paths still require explicit review.

**Harness decision:** Ship STDIO for developer testing and remote HTTPS for shared use. Never commit production secrets in `mcp.json`.

### Microsoft Foundry

Microsoft Foundry Agent Service supports remote MCP servers, custom tools, Entra/managed identity, and OAuth On-Behalf-Of when configured. It can expose an MCP-compatible toolbox endpoint and publish agents to Microsoft 365 Copilot/Teams.

**Harness decision:** Treat Foundry as an MCP client/host. Configure its identity at deployment, then call the same remote harness endpoint rather than duplicating chart logic in Foundry-only functions.

### Amazon Bedrock AgentCore

Amazon Bedrock AgentCore Runtime hosts this standards-compliant MCP server
directly. The container implements stateless Streamable HTTP at `/mcp`, health
at `/ping`, port 8000, non-root execution, and the ARM64 deployment contract.
Custom JWT authorization is enforced at the AgentCore edge and repeated inside
the runtime so requester/reviewer identity comes from a verified token subject.

Deployed plan, approval, idempotency, and sanitized audit state uses DynamoDB
conditional/transactional writes. The Qlik confidential OAuth client secret is
resolved from Secrets Manager by a resource-scoped execution role. AgentCore
Memory is not used for authorization or transactional workflow state.

**Harness decision:** Use Runtime directly for this one purpose-built MCP
server. Gateway is optional and requires a separate reviewed policy design plus
restriction of direct Runtime invocation. AgentCore authorization controls
access to the harness; Qlik authorization remains independent. See the
[AgentCore runbook](deployment/amazon-bedrock-agentcore.md).

### Other Providers

Any MCP-capable provider can call the same contract. A provider without MCP uses a thin function-calling adapter that maps to the same internal service; it must not become a duplicate chart compiler or credential store.

## Deployment Progression

1. Local: deterministic fixture adapter and shared fixture catalog, exact
   core/sheet/management STDIO/HTTP contracts, schema and governance tests.
2. Integration: administrator-approved Qlik development target, real adapter,
   live discovery/preview tests, and designated-sheet mutation only after the
   applicable readiness and approval gates pass.
3. Pilot: deployed AgentCore custom-JWT boundary, secret rotation, provider
   compatibility, durable DynamoDB audit, MMDSv2 proof, alerts, and rehearsed rollback.
4. Production: independently reviewed target and
   identity evidence, retention/access controls, capacity, and rehearsed recovery
   under the [production operations runbook](runbooks/production-operations.md).

## Sources

- [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/chat/mcp-servers)
- [Microsoft Foundry Agent Service](https://learn.microsoft.com/en-us/azure/foundry/agents/overview)
- [Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)
- [Qlik authentication](https://qlik.dev/authenticate/)
- [Qlik-embed authentication](https://qlik.dev/embed/qlik-embed/authenticate/connect-qlik-embed/)
