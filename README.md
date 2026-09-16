# Qlik MCP

A governed MCP server for Qlik Cloud, designed for deployment to Amazon Bedrock
AgentCore Runtime. It supports native visualizations, complete sheets, and
optional app, dataset, reload, publishing, and export management through
explicit policy grants, durable workflow state, and independent verification.

This is an independent production-maintained release candidate. Repository
checks establish source and artifact quality; deployment to a production tenant
requires the target-specific acceptance in the
[production operations runbook](docs/runbooks/production-operations.md).
No credentials, tenant configuration, or deployed resources are inherited.
[Source provenance](docs/provenance.md) records the import and its evidence limits.

## Start locally

Use Node.js **22.23.2** and npm **10.9.8**, as pinned by the repository.

```bash
nvm install
nvm use
npm ci --registry=https://registry.npmjs.org/
npm run check
npm run dev:agentcore
```

The local server uses deterministic fixtures, listens on `127.0.0.1:8000`, and
makes no live Qlik calls. Its workflow stores last only for that process.
Management is disabled in the default fixture configuration; injected providers
exercise its behavior in the test suite. From another terminal:

```bash
curl --fail-with-body http://127.0.0.1:8000/ping
curl --fail-with-body http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Session-Id: local-contract-smoke-123456789' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}'
```

`npm run demo:fixture` exercises the governed chart workflow without starting a
server. For a local MCP host, use the
[requester/reviewer setup](docs/runbooks/codex-project-mcp.md).
The compatibility package name remains `qlik-ai-harness-bedrock-agentcore`;
the executable names remain `qlik-ai-harness` and `qlik-ai-harness-agentcore`.

## Capabilities and boundaries

| Area                | Behavior                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Chart workflow      | Discover, plan, preview, independently approve, apply, and verify native objects.                                       |
| Complete sheets     | Create 1–12 native charts under an exact actor/app/chart-count grant; verify layout and saved properties.               |
| Optional management | Inspect action schemas; plan immutable authorized changes; execute, observe, and reconcile.                             |
| Data and artifacts  | Bounded CSV/XLSX/QVD inspection, dataset staging, typed scripts, private checksum-verified transfers.                   |
| Runtime             | Stateless Streamable HTTP, JWT actor/client validation, DynamoDB workflow and audit state, Secrets Manager credentials. |

The default `all` profile exposes 16 visualization and sheet tools; enabling
management adds 11 tools. Profiles, target readiness, provider capabilities, and
policy determine what a caller can use. Start with `qlik_get_readiness` and,
when enabled, `qlik_management_catalog`. See the
[MCP contract](docs/08-mcp-server-contract.md) and [management guide](docs/management.md).

Qlik Cloud is the maintained AgentCore deployment target. Windows adapter code
and diagnostics are retained for development, but AgentCore deliberately
rejects Windows mode. Azure and other hosting approaches are reference material,
not validated deployment paths for this release candidate.

## Governance and recovery

- Authenticated identity comes from the runtime, never a tool argument.
- Default configuration denies mutations and supplies no management grants.
- Single-chart approval uses separate requester/reviewer subjects and a
  single-use token bound to the actor, plan, target, risk, and expiry.
- Sheet generation and management have explicit, separate grants; production
  use requires the relevant policy to permit production.
- Durable claims and receipts prevent duplicate dispatch. Unknown outcomes
  stop for readback and reconciliation; changing a key or plan is not recovery.
- Dataset/export artifacts are private and expire separately from sanitized
  audit records. QVD inspection is header-only; reload and model checks are
  required to establish data correctness.
- Credentials never belong in MCP inputs, tracked files, images, or logs.

Read [SECURITY.md](SECURITY.md), [management recovery](docs/management-recovery.md),
and [sheet recovery](docs/runbooks/sheet-generation.md) before connecting a target.

## Deploy to AgentCore

Follow the [AgentCore deployment runbook](docs/deployment/amazon-bedrock-agentcore.md)
in order. It covers the retained AWS foundation, private secret provisioning,
shape-only deployment configuration, ARM64 image, JWT restrictions, MMDSv2,
readiness, live acceptance, and rollback. The official AgentCore CLI is installed
separately from application dependencies at the runbook's pinned version.

Production runtime mode requires JWT authentication and DynamoDB state. Local
fixture mode does not establish AWS IAM, real identity-provider behavior, tenant
permissions, native browser rendering, capacity, or recovery readiness.

## Maintainer commands

| Command                              | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `npm run check`                      | Type, style, documentation, hygiene, package, shell, and offline tests. |
| `npm run release:check`              | Complete local gate plus public npm dependency advisory audit.          |
| `npm run dev:agentcore`              | Fixture-only local HTTP endpoint.                                       |
| `npm run mcp:doctor`                 | Diagnose local MCP host configuration without disclosing secrets.       |
| `npm run agentcore:config`           | Generate ignored deployment config from reviewed private settings.      |
| `npm run agentcore:validate`         | Validate the generated AgentCore CLI configuration.                     |
| `npm run agentcore:deploy:diff`      | Review planned infrastructure changes.                                  |
| `npm run agentcore:deploy`           | Deploy the reviewed target configuration.                               |
| `npm run agentcore:require-mmdsv2`   | Require and verify MMDSv2 after deployment.                             |
| `npm run dataset:transfer -- --help` | Inspect private upload/download helper options.                         |
| `npm run test:live:management`       | Opt-in acceptance that creates and cleans up live synthetic resources.  |

Live probes require explicit target configuration and are excluded from ordinary
checks. Keep their results separate from offline tests and from deployed-runtime
acceptance. See [CONTRIBUTING.md](CONTRIBUTING.md), the
[documentation index](docs/00-index.md), and [CHANGELOG.md](CHANGELOG.md).
