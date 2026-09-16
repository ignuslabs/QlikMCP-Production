# Local Codex and VS Code MCP setup

This runbook connects Codex or VS Code Agent Host to three role-scoped STDIO
servers backed by one durable state directory:

- `qlik-requester` discovers, plans, previews, requests approval, applies, and
  verifies operations. It is the only role that may receive a Qlik credential.
- `qlik-reviewer` reads a request and approves or rejects it under a distinct
  allowlisted actor. It is always provider-credential-free.
- `qlik-verifier` can only read sanitized approval state. It cannot decide or
  apply anything and is always provider-credential-free.

The default MCP surface has 16 visualization/sheet tools; optional management
adds 11 tools in the full profile. Role profiles expose only
the subset needed by each local agent, which reduces tool-selection mistakes
without weakening server-side policy.

## What clears the Cloud readiness error

The message `No current platform-admin Cloud OAuth/QIX readiness evidence is
configured` comes from the six runtime readiness values, not from the
explanatory `readinessEvidence` field in `connections.json`. For the approved
non-production Cloud lane, `.env` must contain:

```dotenv
QLIK_HARNESS_TARGET_MODE=cloud
QLIK_CLOUD_CONNECTION_ALIAS=cloud-dev
QLIK_CLOUD_TENANT_HOST=https://<approved-tenant-origin>
QLIK_CLOUD_OAUTH_CLIENT_ID=<confidential-client-id>
QLIK_CLOUD_WRITE_APP_ID=<approved-stable-app-id>
QLIK_CLOUD_WRITE_SHEET_ID=<approved-stable-sheet-id>
QLIK_CLOUD_READINESS_APPROVED=true
QLIK_CLOUD_READINESS_EXPIRES_AT=<future-UTC-ISO-timestamp>
QLIK_CLOUD_READINESS_CAN_READ=true
QLIK_CLOUD_READINESS_CAN_PREVIEW=true
QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET=true
QLIK_CLOUD_READINESS_CLEANUP_VERIFIED=true
```

`config/connections.json` must separately allow the same alias, environment,
visualization schema profile, app ID, sheet ID, and chart types. Its app key and
nested sheet value are stable Qlik IDs, not display names. The runtime app and
sheet values must exactly match that allowlist. Credentials alone never satisfy
readiness, and an expired timestamp returns the adapter to not configured.

Keep the OAuth client secret out of both files. The requester obtains it from a
local secret provider only when it starts.

## Shared state directory

The launcher creates the directory recursively when it does not exist. Unless
`--state-dir` or `QLIK_HARNESS_STATE_DIR` supplies an absolute path, the host
defaults are:

| Host    | Default                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| Windows | `%LOCALAPPDATA%\QlikMCP-Production\codex-mcp-state`                                                          |
| macOS   | `~/Library/Application Support/QlikMCP-Production/codex-mcp-state`                                           |
| Linux   | `$XDG_STATE_HOME/QlikMCP-Production/codex-mcp-state`, or `~/.local/state/QlikMCP-Production/codex-mcp-state` |

The generated VS Code configuration pins the resolved absolute path so the
three roles share one state directory. For this independent repository, set an
explicit fresh `QLIK_HARNESS_STATE_DIR` or `--state-dir` path outside the checkout
and separate from other deployments. The new defaults above isolate this
repository from the source project's state; do not point an override at an
unrelated checkout's existing workflow records. The directory contains
`plans.json`, `approvals.json`, `idempotency.json`, and `operations.json`.
Compiled plans therefore survive a requester restart as well as the separate
reviewer process. Each plan is schema-validated and checked against its
canonical plan hash and a whole-record integrity hash before use.

On POSIX hosts the launcher enforces mode `0700` for the directory and `0600`
for files. On Windows it applies a user-only ACL with `icacls`. If an operator
must create the directory before the launcher, use one of these equivalents:

```sh
install -d -m 700 "$HOME/Library/Application Support/QlikMCP-Production/codex-mcp-state"
```

```powershell
$state = Join-Path $env:LOCALAPPDATA 'QlikMCP-Production\codex-mcp-state'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$account = "$env:USERDOMAIN\$env:USERNAME"
icacls $state /reset /T /L /Q
icacls $state /inheritance:r /grant:r "${account}:(OI)(CI)F" /T /L /Q
icacls $state /verify /T /L /Q
```

Do not edit state files by hand. One coordinated local requester, reviewer,
and verifier role set may share the directory; its per-file locks serialize
updates. Do not share it across independent deployments or horizontally scaled
service replicas. Preserve old state until its operation history has been
reconciled; changing the configured path does not migrate active records.

## Install and configure

1. Install, build, and run the local gate:

   ```sh
   npm ci --registry=https://registry.npmjs.org/
   npm run check
   ```

2. Create the gitignored runtime files if they do not already exist:

   ```sh
   cp .env.example .env
   cp config/connections.example.json config/connections.json
   chmod 600 .env config/connections.json
   ```

   On Windows, use `Copy-Item` instead of `cp`; the launcher applies the state
   ACL itself. Set `QLIK_HARNESS_STATE_DIR` to a new absolute private directory
   dedicated to this repository. Populate only reviewed non-production routing,
   policy, allowlists, and current readiness evidence.

3. Configure one secret provider for the requester:

   - macOS Keychain: set non-secret `QLIK_CODEX_KEYCHAIN_ACCOUNT` and
     `QLIK_CODEX_KEYCHAIN_SERVICE` labels in `.env`, then add or update the
     OAuth secret without putting it in shell history:

     ```sh
     security add-generic-password \
       -a <keychain-account-label> \
       -s <keychain-service-label> \
       -U -w
     ```

   - Windows: register an organization-approved PowerShell SecretManagement
     vault, store the OAuth secret there, and set the non-secret
     `QLIK_CODEX_SECRET_NAME` plus optional `QLIK_CODEX_SECRET_VAULT` in
     `.env`. The launcher checks `Get-SecretInfo` and reads with
     `Get-Secret -AsPlainText` only inside the requester child environment.

   - Managed shells: a pre-injected `QLIK_CLOUD_OAUTH_CLIENT_SECRET` is accepted
     only with `--secret-provider environment`. Never write that value to an
     MCP configuration or tracked file.

4. Keep the actor allowlists distinct:

   ```dotenv
   QLIK_HARNESS_MUTATION_ACTORS=local-dev-actor
   QLIK_HARNESS_REVIEWER_ACTORS=local-dev-reviewer
   ```

   The requester and verifier processes use the `local-dev-actor`
   authorization identity; the verifier still has a distinct host client ID
   and read-only tool surface. It is not a third authorization class. The
   reviewer uses `local-dev-reviewer`. `QLIK_CODEX_REQUESTER_ACTOR` and
   `QLIK_CODEX_REVIEWER_ACTOR` override the actor values when generating
   `.mcp.json`; change them consistently with the server-side allowlists.

## Doctor and VS Code Agent Host

Build first, then run the doctor for every role. It reports only sanitized
paths/status and makes no Qlik provider request:

```sh
npm run mcp:doctor -- --role requester
npm run mcp:doctor -- --role reviewer
npm run mcp:doctor -- --role verifier
```

Require zero failures. A repository-relative state warning means the roles may
not share plans across worktrees; pass the same absolute `--state-dir` or use
the generated configuration.

VS Code [Agent Host](https://code.visualstudio.com/docs/agents/concepts/agent-host)
natively reads workspace `.mcp.json`. Generate that
gitignored machine-local file with absolute Node, repository, launcher, and
state paths:

```sh
npm run --silent mcp:config > .mcp.json
```

```powershell
npm run --silent mcp:config | Set-Content -Encoding utf8 .mcp.json
```

Do not replace the generated absolute paths with `${input:...}` values: Agent
Host does not forward interactive MCP inputs. The tracked `.vscode/mcp.json`
is a portable PATH-based fallback for ordinary VS Code windows; `.mcp.json` is
the reliable Agent Host configuration. Restart the Agent Host/session after
changing MCP configuration because tools are discovered at initialization.

The workspace also supplies `Qlik Requester`, `Qlik Reviewer`, and `Qlik
Verifier` custom agents under `.github/agents/`. Each agent selects only its
matching MCP server. Human confirmation remains required before the reviewer
calls approve or reject; the verifier is evidence-only and is not a substitute
for an independent decision.

## Codex project configuration

Copy `.codex/config.example.toml` to the gitignored `.codex/config.toml` and
replace every placeholder. Use absolute Node, repository, and shared-state
paths. Fill the macOS labels or Windows SecretManagement selectors applicable
to the host; unused non-secret selectors may remain blank. Then run:

```sh
codex mcp list
```

The output must show enabled `qlik_requester`, `qlik_reviewer`, and
`qlik_verifier` entries and must not contain an OAuth secret. `Auth:
Unsupported` is expected for local STDIO: the child obtains its separate Qlik
credential from the selected provider rather than MCP transport auth.

## Governed workflow

1. Requester: require `qlik_get_readiness` to show the exact development lane
   ready for read, preview, designated-sheet write, and cleanup.
2. Requester: discover the app, catalog, and current sheet objects.
3. Requester: plan from returned catalog labels, preview, and require bounded
   non-empty layout/data evidence.
4. Requester: request approval and stop with the request ID and plan hash.
5. Reviewer: fetch the request and compare target, hash, type, title, resolved
   fields, risk, warnings, diff, and expiry.
6. After human confirmation, reviewer: approve or reject; on approval, return
   the one-time bound token to the requester.
7. Verifier: independently read the resulting request state without changing
   it.
8. Requester: apply the unchanged approved plan with a new idempotency key;
   replay it once and require the same object ID.
9. Requester: verify operation and sheet-object state. Browser rendering and
   exact manual cleanup remain separate evidence because the MCP surface has no
   general delete tool.

## Troubleshooting

| Symptom                                          | Check                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No current platform-admin...readiness evidence` | Set all six exact readiness values in `.env`; the expiry must be future. `connections.json.readinessEvidence` is descriptive only.                |
| Server missing in Agent Host                     | Generate root `.mcp.json`, confirm its absolute paths exist on the host beside the workspace, and restart the session.                            |
| `dist/index.js is missing`                       | Run `npm run build`.                                                                                                                              |
| Requester secret provider unavailable            | Check the configured Keychain labels or PowerShell secret name/vault with `npm run mcp:doctor -- --role requester`.                               |
| Reviewer cannot find a request                   | Confirm all roles use the same absolute state path and that `plans.json` plus `approvals.json` exist there.                                       |
| Reviewer is unauthorized                         | Ensure its explicit actor is in `QLIK_HARNESS_REVIEWER_ACTORS` and does not overlap the mutation allowlist.                                       |
| Plan disappeared after restart                   | Confirm `QLIK_HARNESS_PLAN_STORE_PATH` is not overriding the shared `plans.json` location and inspect doctor output for a relative-state warning. |
| Windows path with spaces fails                   | Use the emitted absolute config; do not wrap JSON arguments in extra shell quotes. The CI Windows job checks a workspace path containing spaces.  |
