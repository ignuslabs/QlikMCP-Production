# Amazon Bedrock AgentCore deployment runbook

This runbook deploys the Cloud-only AgentCore edition. The example uses a
non-production target with writes disabled until readiness evidence is supplied.
Production sheet automation requires an explicit bounded policy grant.

Current AWS contracts used here:

- [MCP Runtime protocol](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html)
- [Deploy an MCP server](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html)
- [Inbound JWT authorizer](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/inbound-jwt-authorizer.html)
- [Custom header allowlist](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html)
- [Runtime security best practices](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html)
- [Runtime execution-role permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html)
- [Runtime lifecycle and session updates](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)

## 1. Prerequisites

- Pinned Node.js 22.23.2 and npm 10.9.8; use `.nvmrc` and `package.json`.
- The official AgentCore CLI version used to validate this repository,
  installed separately with `npm install -g @aws/agentcore@0.29.0`. Confirm
  `agentcore --version` before generating or deploying configuration.
- AWS CLI credentials for the approved deployment account and
  AgentCore-supported Region.
- Docker Buildx with ARM64 build support.
- An OIDC provider whose discovery URL, API audience, client IDs, scopes, and
  human subject IDs have been reviewed.
- A Qlik Cloud confidential OAuth client restricted to the approved
  tenant and exact app scope.
- One exact Qlik app ID and designated writable sheet ID.
- Separate requester and reviewer token subjects.

Check identity before any write:

```bash
aws sts get-caller-identity
node --version
npm --version
agentcore --version
docker buildx version
```

Stop if the account or Region is not the approved target.

## 2. Verify the source artifact

```bash
npm ci --registry=https://registry.npmjs.org/
npm run check
docker buildx build --platform linux/arm64 --load \
  --tag qlik-ai-harness-agentcore:local .
```

The Docker build must finish for `linux/arm64`. The final image must expose
port 8000, run as the `node` user, and start
`dist/agentcore/runtime.js`.

An optional container-only fixture smoke test is safe and makes no AWS or Qlik
calls:

```bash
docker run --detach --name qlik-agentcore-fixture --platform linux/arm64 \
  -e QLIK_AGENTCORE_LOCAL_DEV=true \
  -e QLIK_HARNESS_TARGET_MODE=fixture \
  qlik-ai-harness-agentcore:local
docker exec qlik-agentcore-fixture node --input-type=module -e \
  'const r = await fetch("http://127.0.0.1:8000/ping"); if (!r.ok) process.exit(1); console.log(await r.text());'
docker stop qlik-agentcore-fixture
docker rm qlik-agentcore-fixture
```

The container-internal health request must return `{ "status": "Healthy" }`.
Local development binds only loopback and refuses `0.0.0.0`; deployed mode
binds `0.0.0.0:8000` with JWT and durable-state requirements.

## 3. Provision the durable foundation

The stack creates no secret value. It creates an empty secret container,
DynamoDB governance state, and the runtime execution role.

The execution role follows AWS's direct-deploy logging resource shapes:
log-group discovery/creation is separated from writes to the matching
`log-stream:*` resources. It intentionally grants no table scan, CloudWatch
Logs resource-policy management, trace, metric, workload-token, or Bedrock
model permission.

```bash
aws cloudformation deploy \
  --stack-name qlik-ai-harness-agentcore-dev \
  --template-file infra/aws/foundation.yaml \
  --parameter-overrides Stage=dev \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation describe-stacks \
  --stack-name qlik-ai-harness-agentcore-dev \
  --query 'Stacks[0].Outputs' \
  --output table
```

Record the exact `ExecutionRoleArn`, `StateTableName`, `QlikSecretId`, account,
and Region in the gitignored deployment configuration. The DynamoDB table and
secret both use retain policies; stack deletion does not silently erase them.

## 4. Populate the secret out of band

Create a mode-0600 JSON file outside this repository and any synced workspace:

```json
{
  "connectionAlias": "cloud-dev",
  "clientSecret": "the-real-confidential-client-secret"
}
```

Pass its path to Secrets Manager rather than placing the value on the command
line:

```bash
aws secretsmanager put-secret-value \
  --secret-id /qlik-ai-harness/agentcore/dev/qlik-cloud-oauth \
  --secret-string file:///approved/private/path/qlik-cloud-oauth.json
```

Remove the temporary local file through the organization's approved secret
handling process. Do not paste its contents into chat, issue trackers, build
arguments, AgentCore config, CloudFormation parameters, or logs.

## 5. Create the non-secret deployment config

```bash
cp config/agentcore-deployment.example.json config/agentcore-deployment.json
```

Replace every example value. Required review points:

- `awsTarget.account` and `awsTarget.region` match step 1;
- `executionRoleArn`, `stateTableName`, and `qlikSecretId` match stack outputs;
- OIDC discovery uses HTTPS and ends in
  `/.well-known/openid-configuration`;
- audience, allowed clients, and the single invocation scope match the IdP
  application;
- requester and reviewer subject arrays are non-empty and disjoint;
- the tenant origin has no path, credentials, query, or fragment;
- Qlik environment is `development`, `nonproduction`, or explicitly scoped `production`;
- app and sheet IDs match the administrator-approved target;
- readiness stays entirely false unless its external evidence is current and
  has a future expiry.

The renderer rejects secret material, unscoped production, overlapping actor
lists, unsupported Regions, malformed ARNs, and incomplete readiness.

To enable new-sheet automation, add `qlikCloud.sheetGeneration` with exact
`actors`, `appIds`, `chartTypes`, `maxCharts` (1–12), and boolean
`allowProduction`. Actors must already be mutation actors; the grant must name
only the configured app. The renderer forwards both the policy and
`QLIK_CLOUD_SHEET_CREATION_APP_IDS` to the runtime. Existing-sheet mutations
retain the independent reviewer workflow. Production requires this grant's
`allowProduction` to be true. The server never accepts a grant from tool input.

Example grant shape, using your reviewed IDs:

```json
{
  "actors": ["reviewed-requester-subject"],
  "appIds": ["reviewed-app-id"],
  "chartTypes": ["bar", "kpi", "table"],
  "maxCharts": 6,
  "allowProduction": false
}
```

## 6. Generate, validate, and review

```bash
npm run build
npm run agentcore:config
npm run agentcore:validate -- --directory . --json
npm run agentcore:deploy:diff -- --target dev
```

Generated files are mode 0600 and gitignored:

- `agentcore/agentcore.json`
- `agentcore/aws-targets.json`

Review the generated environment array. It must contain only non-secret
routing, policy, identity-validation, state-resource, and readiness values.
It must not contain `QLIK_CLOUD_OAUTH_CLIENT_SECRET` or any bearer token.

The Runtime config uses:

- `Container`, `NODE_22`, and `MCP`;
- `PUBLIC` egress for the public Qlik Cloud tenant;
- custom JWT inbound authorization;
- `Authorization`, `X-Correlation-Id`, `Mcp-Protocol-Version`, `Mcp-Method`,
  and `Mcp-Name` forwarded;
- a 60-request-per-minute authenticated-subject quota within each Runtime
  process; configure reviewed AgentCore capacity limits separately because the
  in-process counter is not shared across microVMs;
- the foundation stack's execution role;
- no AgentCore Gateway, Memory, Knowledge Base, model, or autonomous agent.

Review unexpected model access, Gateway resources, environment variables, and
Qlik scope changes before deploying the exact generated diff.

## 7. Deploy and prove current state

After explicit approval of the diff:

```bash
npm run agentcore:deploy -- --target dev
npm run agentcore:status -- --target dev --json
```

Keep the deployment output. Archive IDs, image digest, runtime version,
endpoint state, account, Region, and pushed source revision as evidence. A
successful image upload or CDK deployment is not yet a successful MCP or Qlik
workflow.

## 8. Require MMDSv2

AWS requires MMDSv2 for invocable runtimes as of June 30, 2026. The current
AgentCore CLI schema does not expose that field, so this repository performs a
post-deploy read/update/read verification while preserving the current runtime
artifact, role, network, authorizer, protocol, headers, lifecycle, environment,
filesystem, and capacity configuration.

Obtain the exact runtime ID from `agentcore status`, then run:

```bash
export AWS_REGION=us-east-1
export QLIK_AGENTCORE_RUNTIME_ID=replace-with-exact-runtime-id
npm run agentcore:require-mmdsv2
npm run agentcore:require-mmdsv2 -- --check-only
```

The check-only command must pass after every deploy. Do not invoke a Runtime
that fails this gate.

## 9. Invoke in increasing-risk order

Use an approved client that keeps short-lived JWTs out of shell history and
process listings. AgentCore must validate the token at the edge, forward the
allowlisted Authorization header, and the runtime must independently derive
the same subject, client, audience, scope, issuer, and validity.

The deployed client URL is the AWS invocation endpoint, with the exact Runtime
ARN URL-encoded as one path segment:

```text
https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<encodeURIComponent(runtimeArn)>/invocations?qualifier=<reviewed-endpoint-name>
```

The qualifier is commonly `DEFAULT`; use the endpoint whose version was
reviewed. AWS forwards each JSON-RPC body to the container's `/mcp` route.
Container `/ping` is a local/platform health check, not a separate public AWS
invocation URL. Use a reviewed MCP client with securely supplied short-lived
credentials; this repository does not require a parent checkout or a private
client installation to define the protocol.

Begin release acceptance with a **fresh session** and check the reported server
version against `package.json`, the reviewed Runtime version, and image digest.
Existing sessions can keep the previous code until their instance terminates.
For OAuth client
discovery, a request without credentials must receive AWS's `401` challenge
with `resource_metadata`; verify the resulting protected-resource metadata
matches the reviewed authorizer before obtaining the short-lived token.

Run these gates in order:

1. Runtime and endpoint status are ready, and the platform health check succeeds.
2. Modern `server/discover` succeeds with protocol `2026-07-28`, or legacy
   initialization succeeds with Streamable HTTP. Modern requests include the
   protocol header and `_meta` protocol version/client capabilities; tool calls
   include matching `Mcp-Method` and `Mcp-Name` headers.
3. `tools/list` returns the expected profile: 16 tools for `all` with management
   disabled, or 27 with management enabled. Confirm the exact names against the
   [MCP contract](../08-mcp-server-contract.md) and management guide.
4. `qlik_get_readiness` returns the reviewed connection and expected flags.
5. Read-only app, catalog, and sheet-object discovery match the allowlist.
6. Plan and preview create no persistent object.
7. A requester creates an approval request.
8. A different reviewer subject reads the complete sanitized request and,
   only after explicit human confirmation, approves or rejects it.
9. The requester applies the unchanged plan once with a fresh idempotency key.
10. Reopen and verify the native object and exact sheet attachment.
11. Repeat the apply with the same key and prove replay returns the original
    result without another Qlik mutation.
12. Perform only the separately approved exact-object cleanup procedure and
    prove the baseline is restored.

For a deployment with a sheet grant, also run `qlik_plan_sheet` →
`qlik_preview_sheet` → `qlik_apply_sheet` → `qlik_verify_sheet`, then reopen the
native sheet and compare every chart, placement, and binding. Test same-key
replay and an interrupted/partial apply using the documented continuation.
Keep partial results distinct from completion.

Preserve the result and correlation ID from every call. Capture AgentCore's
response `Mcp-Session-Id` and send it on subsequent calls for microVM affinity;
it never grants authorization. See the [AWS protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html).

Inspect the JSON-RPC body even on HTTP 200. AWS reports a retryable session
conflict as code `-32005` with message `Session operation in progress, please
retry`; retry that exact condition with bounded exponential backoff. The same
code with a different message is not automatically retryable. Preserve the
session ID and any mutation idempotency key when retrying. A new key or a new
plan is not recovery for an uncertain mutation.

To prove durable state, reopen the same actor's completed workflow from a fresh
session and verify its audit record, native object readback, and same-key
replay. A different actor must still be denied access. This hosted check
exercises DynamoDB permissions and cross-instance persistence that local
in-memory tests cannot establish.

Workflow plan artifacts remain in DynamoDB for 30 days after logical expiry
(default; `QLIK_AGENTCORE_PLAN_RETENTION_DAYS` accepts 30–3650). Plan and approval
write authority still expire normally. Read-only verification after retention
requires separately retained evidence and cannot assume the plan still exists.

## 10. Logs and failure handling

```bash
agentcore logs --runtime QlikHarnessMcp --since 30m --limit 200 --json
```

Expected logs contain correlation, AgentCore session identifier, actor subject,
host client ID, and sanitized operation phase. They must not contain JWTs,
Qlik secrets, OAuth access tokens, raw QIX payloads, certificates, or approval
tokens.

If deployment or invocation fails:

- preserve the exact failed runtime version, endpoint state, error code, and
  sanitized logs;
- distinguish build, deploy, MMDS, JWT, state, Qlik readiness, Qlik provider,
  apply, verify, and cleanup failures;
- do not turn readiness flags on to bypass a failure;
- do not create a second target or object as a substitute for repairing the
  exact failed workflow;
- route traffic back to the last independently verified Runtime version using
  the reviewed AgentCore endpoint/version procedure before deleting anything;
- retain the DynamoDB table and secret during rollback.

## Verification record

Before calling a deployment ready, record these separately:

| Gate           | Required evidence                                                      |
| -------------- | ---------------------------------------------------------------------- |
| Source         | Exact revision and clean/scoped diff                                   |
| Local          | `npm run check` and ARM64 container smoke                              |
| Config         | Renderer output review and `agentcore validate`                        |
| AWS foundation | Stack outputs and retained-resource settings                           |
| Runtime        | Deploy status, version, endpoint, image digest                         |
| MMDS           | Update result and successful check-only result                         |
| Identity       | Two distinct subjects, expected client/audience/scope, negative tests  |
| State          | DynamoDB plan/approval/idempotency/audit transitions                   |
| Qlik read      | Readiness and bounded discovery                                        |
| Qlik write     | Exact target, persistent object, sheet attachment, reopen verification |
| Replay         | Same-key no-second-mutation proof                                      |
| Cleanup        | Exact created object removed and baseline restored                     |
| Observability  | Correlated sanitized logs with no credential material                  |

Until every applicable row has current evidence, report the deployment as
implemented or partially verified—not live-ready.

## Validation boundary

Use the current repository release record and the exact artifact being deployed.
The automated suite exercises local protocol, identity, body/host/origin limits,
quotas, store semantics, provider contracts, and workflow recovery. The fixture
container smoke establishes packaging and runtime behavior without a live Qlik
connection. Neither proves deployed IAM, real identity-provider behavior,
production tenant correctness, live storage recovery, or capacity.

The import includes local source repairs that were not deployed in the source
environment; see [provenance](../provenance.md). Historical image IDs, test counts,
and acceptance reports are not deployment evidence for this repository.
Record each current gate separately in the restricted release evidence system.
