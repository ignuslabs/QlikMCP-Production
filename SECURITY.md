# Security policy

## Reporting

Report suspected vulnerabilities privately to the repository owners or the
organization's security-response channel. Do not open a public issue containing
AWS account details, tenant identifiers, credentials, JWTs, Qlik data, raw
QIX/browser payloads, approval tokens, or exploit instructions.

This repository is a private production release candidate. A passing local check
or successful AWS deployment does not establish production-target acceptance.
Before hosting or distribution, the repository owner must establish a private
security contact and response process; none is invented by the import.

## Trust boundaries

The deployed request path has two identity checks:

1. AgentCore Runtime custom JWT authorization validates the configured OIDC
   discovery provider, audience, client, and scopes.
2. The runtime receives only allowlisted headers and independently validates
   JWT signature, issuer, audience, client, scope, lifetime, and subject.

Before the MCP SDK parses a request, the runtime caps both declared and chunked
JSON bodies at 1 MiB. Oversize bodies are drained without being accumulated and
receive HTTP 413.

The validated `sub` becomes the immutable workflow actor. Tool input cannot
select an actor. Mutation and review subject allowlists are separate, and the
policy rejects self-review even if configuration is wrong.

Qlik authorization is independent. An inbound client JWT is never forwarded to
Qlik. The Qlik confidential OAuth client secret is stored in AWS Secrets
Manager and retrieved only by the scoped AgentCore execution role.

## Credential rules

- Never place OAuth secrets, bearer tokens, cookies, certificates, private
  keys, session JWTs, or authorization headers in MCP input, tracked files,
  AgentCore environment variables, CloudFormation parameters, Docker build
  arguments, screenshots, logs, or issue text.
- The deployment input may contain resource pointers such as a secret ID or
  execution-role ARN; it must never contain the secret value.
- Populate Secrets Manager from an approved private file or secret-management
  workflow, not a command-line literal.
- Treat anything exposed to Git as distributed: revoke it first, then
  coordinate history remediation rather than relying on tip deletion.
- Keep generated AgentCore config non-secret and gitignored anyway; it contains
  exact account, identity, and target routing metadata.

## Durable governance state

DynamoDB is authoritative for deployed plans, approvals, idempotency, and
sanitized audit history. The table uses conditional or transactional writes,
point-in-time recovery, encryption at rest, TTL for expiring workflow records,
and a retain policy.

Raw approval tokens and raw idempotency keys are never persisted. Their
SHA-256 digests are used as lookup/binding material. Do not edit table records
manually or delete state during an unresolved apply or cleanup incident.

AgentCore Memory is not an authorization or transaction store and is not used
for this state.

## Runtime and IAM

- The image runs as the unprivileged `node` user and exposes only port 8000.
- Production runtime mode binds to `0.0.0.0:8000`, accepts `POST /mcp`, and
  exposes `GET /ping` for health. `/invocations` is not implemented.
- Each Runtime process shares a bounded per-subject request quota across its
  stateless MCP requests. This is an in-process availability control, not a
  cross-microVM authorization boundary; deployment capacity controls and Qlik
  tenant limits must also be reviewed.
- The Runtime execution role can read/write only the foundation table, read the
  one Qlik secret, pull the AgentCore image, and write required Runtime logs. It
  has no Bedrock model-invocation permission.
- MMDSv2 must be enabled and verified after every deploy. Runtimes that fail the
  check must not be invoked.
- `PUBLIC` mode is for a public Qlik Cloud tenant. A private target requires a
  separately reviewed VPC design; do not broaden egress by assumption.
- The AgentCore Windows lane is fail-closed until private routing and
  certificate/proxy credential handling are implemented and reviewed.

## Diagnostic handling

Raw browser, WebSocket, HAR, packet, QIX, CloudTrail, and Runtime diagnostic
captures can contain routing, object identifiers, user metadata, or session
material. Store them only in the approved restricted evidence system.

Repository evidence must be bounded and sanitized: coarse outcomes, counts,
native kinds, version pins, correlation IDs, and opaque evidence references.
Never log MCP bodies, tool arguments, authorization headers, Qlik access
tokens, Secrets Manager values, raw property trees, or full layouts.

## Live mutation boundary

The core single-chart path is restricted to its explicitly allowed non-production
app and designated sheet. Sheet generation and optional management use separate
exact-scope grants; production requires their explicit production permission.
Current identity, policy, readiness, resource versions, and provider permissions
are rechecked before writes. Missing, false, expired, or ambiguous evidence fails
closed. Apply the unchanged reviewed plan, retain its idempotency key for replay,
and independently verify native resource state. Unknown outcomes require
reconciliation; never replace the key or plan to bypass an unresolved write.

See the
[AgentCore deployment runbook](docs/deployment/amazon-bedrock-agentcore.md) for
the ordered gates and evidence record.
