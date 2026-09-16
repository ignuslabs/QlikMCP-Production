# Configuration guide

The AgentCore edition separates local fixture configuration from deployable,
non-secret AWS configuration.

Deployment commands expect the official AgentCore CLI version used for this
repository's schema validation to be installed separately:
`npm install -g @aws/agentcore@0.29.0`. The deployment CLI is intentionally not
part of the Runtime application's dependency tree.

| File                                | Purpose                                                    | Secret material allowed? |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `connections.example.json`          | Safe fixture connection and target shapes                  | No                       |
| `.env.example`                      | Local fixture and optional local adapter variables         | No                       |
| `agentcore-deployment.example.json` | Shape for AWS, IdP, governance, and Qlik routing           | No                       |
| `agentcore-deployment.json`         | Gitignored reviewed deployment input                       | No                       |
| `management.example.json`           | Disabled shape for exact management action/resource grants | No                       |
| `management.json`                   | Gitignored reviewed local management policy                | No                       |
| `agentcore/agentcore.json`          | Gitignored generated AgentCore Runtime config              | No                       |
| `agentcore/aws-targets.json`        | Gitignored generated account/Region target                 | No                       |
| AWS Secrets Manager                 | Qlik confidential OAuth client secret                      | Yes                      |

## Local fixture

```bash
cp .env.example .env
npm run dev:agentcore
```

The committed environment selects `fixture`, has no mutation or reviewer
actors, contains no live secret, and keeps all provider readiness false.
Management is disabled; fixture startup does not contact Qlik Cloud. Its
management provider tests use injected mocks. Management runtime configuration
requires `QLIK_HARNESS_TARGET_MODE=cloud`, approved routing, and a credential
provider, even for local development.

## AgentCore deployment input

Copy the example to its gitignored path:

```bash
cp config/agentcore-deployment.example.json config/agentcore-deployment.json
```

Then replace every example value.

### AWS target

- `awsTarget.account`: exact 12-digit approved account.
- `awsTarget.region`: one Region supported by the pinned AgentCore CLI.
- `executionRoleArn`: `ExecutionRoleArn` from the foundation stack.
- `stateTableName`: `StateTableName` from the foundation stack.
- `qlikSecretId`: `QlikSecretId` or stable secret name from the foundation
  stack. This is a resource pointer, not the secret value.

### Inbound OIDC

- `discoveryUrl`: HTTPS discovery URL ending in
  `/.well-known/openid-configuration`.
- `audience`: exact API audience.
- `allowedClients`: exact MCP client IDs.
- `allowedScopes`: exactly one Runtime invocation scope. AgentCore's edge
  authorizer uses any-of semantics for this list, so the renderer deliberately
  accepts one value and the Runtime requires that same value.

AgentCore verifies these claims at the edge. The Runtime receives the
allowlisted Authorization header and independently verifies the signature,
issuer, audience, lifetime, client, scopes, and subject again before building
the per-request actor context.

### Governance identities

- `mutationActors`: subjects allowed to request approval and apply.
- `reviewerActors`: different subjects allowed to approve or reject.

The arrays must be non-empty and disjoint. Subjects come only from validated
JWTs; no MCP tool accepts an actor parameter.

### Qlik Cloud routing

- `connectionAlias`: harness-owned MCP alias, not a URL.
- `tenantHost`: credential-free HTTPS tenant origin.
- `tenantAlias` and `regionAlias`: non-secret audit labels.
- `oauthClientId`: public identifier for the confidential Qlik client.
- `environment`: `development`, `nonproduction`, or explicitly enabled `production`.
- `appId`: exact allowed Qlik app ID for the existing visualization interface.
- `sheetId`: exact designated sheet for the existing-sheet visualization workflow.

The renderer creates `QLIK_HARNESS_CONNECTIONS_JSON` from those exact values,
so adapter routing and mutation policy cannot silently diverge.
Optional management has its own action/app/space grants. An explicit space grant
can authorize a newly created app without adding its not-yet-known ID to this
designated visualization target.

### Readiness evidence

All readiness fields are false in the example. Turn them on only when current
administrator and live-probe evidence supports each claim:

- `approved`
- `canRead`
- `canPreview`
- `canWriteDesignatedSheet`
- `cleanupVerified`

If any field is true, `expiresAt` must be a future timestamp. Readiness never
comes from the existence of credentials.

### Optional management policy

The deployment input accepts an optional top-level `managementPolicy` object.
Use [management.example.json](management.example.json) as the shape, remove
unneeded actions, and replace every placeholder before enabling it. The example
is disabled, expires in the past, and grants no production authority.

| Field                         | Meaning                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `version`                     | `1`                                                                                            |
| `enabled`                     | Explicit management feature enablement; omitted policy keeps management disabled               |
| `environment`                 | Matches `qlikCloud.environment`; `nonproduction` maps to `test`                                |
| `allowProduction`             | Must be `true` for enabled production management                                               |
| `grants[].actor`              | Exact subject already in `governance.mutationActors`                                           |
| `grants[].clientId`           | Exact client already in `oidc.allowedClients`                                                  |
| `grants[].connection`         | Exact configured Qlik alias                                                                    |
| `grants[].actions`            | Exact current management action names; no wildcard dispatch                                    |
| `grants[].appIds`, `spaceIds` | Allowed resource IDs; destinations need an allowed space or explicit personal-space permission |
| `grants[].allowPersonalSpace` | Explicit opt-in, default `false`                                                               |
| `grants[].requireApproval`    | Separate reviewer approval for writes, default `true`                                          |
| `grants[].expiresAt`          | Future ISO timestamp for enabled grants                                                        |
| `reviewers[]`                 | Exact `{ "actor", "clientId" }` entries matching reviewer and OIDC allowlists                  |
| `maxUploadBytes`              | Dataset bound, up to 52,428,800 bytes (50 MiB), default 50 MiB                                 |
| `maxArtifactBytes`            | Private artifact bound, up to 209,715,200 bytes (200 MiB), default 200 MiB                     |

The renderer rejects duplicate or overlapping grants for the same
actor/client/connection/action, unknown actions, malformed scope values, stale
enabled grants, and required approval without a separately allowed reviewer.
Resource actions need an explicit scope; creation/move/upload need destination
permission; publishing and space access changes need exact space IDs. These
checks do not grant the Qlik OAuth identity permissions inside the tenant.

Deployment generation emits `QLIK_MANAGEMENT_POLICY_JSON`. For a local Cloud
runtime, use either `QLIK_MANAGEMENT_POLICY_PATH=./config/management.json` or
`QLIK_MANAGEMENT_POLICY_JSON`, never both. These are non-secret policy inputs.
Inject credentials separately. Do not enable management in the default fixture
template or put bearer tokens in deployment input.

Profiles use `QLIK_HARNESS_MCP_ROLE`: `requester` gets inspection, planning,
execution, status/reconciliation, and transfer tools; `reviewer` gets only the
management approval tool; `verifier` gets no management tools; `all` includes
both requester and reviewer tools. Identity validation and policy checks still
apply regardless of profile. See the complete
[management workflow and recovery guide](../docs/management.md).

## Secret document

Populate the foundation stack's empty secret out of band:

```json
{
  "connectionAlias": "cloud-dev",
  "clientSecret": "real-confidential-value"
}
```

The runtime requests this document by secret ID at Qlik token-exchange time,
checks its connection binding, and caches only the resolved value in memory for
one minute. It never persists or logs the secret.

## Generate config

```bash
npm run agentcore:config
npm run agentcore:validate -- --directory . --json
```

The renderer rejects malformed account/Region/role values, non-HTTPS identity
or tenant URLs, overlapping actors, stale enabled readiness, and secret-like
input fields. Production needs an explicit enabled management policy with
`allowProduction: true` or a valid production sheet-generation grant.

Validate the generated configuration and review the deployment diff before
deployment. Local schema validation does not establish deployed authorization,
successful reloads, live Qlik feature support, or a passed management acceptance
report.

See the full
[AgentCore deployment runbook](../docs/deployment/amazon-bedrock-agentcore.md).
