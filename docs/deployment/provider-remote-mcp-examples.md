# Provider deployments over the shared remote MCP contract

These examples are **post-deployment inputs**. A local remote transport exists,
but these templates are not evidence that a provider environment is live.
Deployment must first publish an approved HTTPS Streamable HTTP URL, OAuth/OIDC
audience, issuer, and secret-provider-backed Qlik identity. Provider tokens
authenticate only to the harness and must never be forwarded to Qlik.

## Selected provider environments

| Provider environment             | Example                                                                                                          | Identity boundary                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| VS Code/Copilot                  | [`examples/providers/vscode/mcp.remote.example.json`](../../examples/providers/vscode/mcp.remote.example.json)   | VS Code obtains a harness-scoped token; no token or endpoint secret is committed. |
| Microsoft Foundry Agent Service  | [`examples/providers/foundry/remote-mcp.example.yaml`](../../examples/providers/foundry/remote-mcp.example.yaml) | A managed identity receives only the harness audience.                            |
| Amazon Bedrock AgentCore Runtime | [`config/agentcore-deployment.example.json`](../../config/agentcore-deployment.example.json)                     | Custom JWT authorizes the Runtime; Qlik authorization stays independent.          |

The templates contain substitutions rather than credentials. Provider console
field names can change; validate the rendered configuration against the
provider's current deployment schema during target onboarding.

## Compatibility exercise

Run the following sequence separately from each selected environment. Capture
the provider request/trace ID, harness correlation ID, sanitized operation ID,
timestamp, tester, result, and evidence location. Never capture approval tokens
or raw Qlik layouts.

1. Discover tools and assert the expected profile: 16 for `all` with management
   disabled, 27 with management enabled; check the documented names.
2. Call `qlik_list_apps`, then `qlik_get_app_catalog` against the approved
   non-production connection and app.
3. Call `qlik_plan_visualization`; retain its `planHash` only in the controlled
   test session.
4. Call `qlik_preview_visualization` and verify the bounded result and session
   disposal.
5. Call `qlik_request_visualization_approval`; verify it returns a pending
   request and no token.
6. Through a genuinely separate reviewer identity, call
   `qlik_approve_visualization_request` or
   `qlik_reject_visualization_request`, and verify sanitized state with
   `qlik_get_visualization_approval`. Only approval may return a token.
7. On the approved branch only, call `qlik_apply_visualization` once with a
   fresh idempotency key, then repeat it to prove replay does not duplicate the
   object. On the rejected branch, prove apply cannot proceed.
8. Call `qlik_get_operation` and reconcile its terminal status and correlation
   ID with the audit and telemetry event.

| Environment            | Discovery          | Plan               | Preview            | Approval           | Apply/replay       | Lookup/audit       | Status    |
| ---------------------- | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ | --------- |
| VS Code/Copilot remote | pending deployment | pending deployment | pending deployment | pending deployment | pending deployment | pending deployment | `BLOCKED` |
| Microsoft Foundry      | pending deployment | pending deployment | pending deployment | pending deployment | pending deployment | pending deployment | `BLOCKED` |
| Bedrock AgentCore      | pending deployment | pending deployment | pending deployment | pending deployment | pending deployment | pending deployment | `BLOCKED` |

The AgentCore-compatible offline suite exercises `/ping`, stateless `/mcp`, all
documented profile tools, an injected platform session header, shared-store contracts, and
requester self-decision denial. It does not prove that AWS or a live identity
provider supplied two correctly separated identities and is not a substitute
for live provider-environment evidence.
