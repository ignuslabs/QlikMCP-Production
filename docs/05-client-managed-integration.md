# Client-Managed Qlik Sense Integration

**Related:** [Platform matrix](02-platform-support-matrix.md), [Security](09-security-operations-and-provider-adapters.md)

## Target Definition

This document applies to Qlik Sense Enterprise on Windows, described by Qlik as client-managed. It does not describe Qlik Cloud behavior. The target adapter must know the Qlik release, topology, virtual proxy, authentication scheme, and policy before enabling writes.

## Engine JSON API Connectivity

Qlik documents default Enterprise connection forms:

```text
wss://<server>:4747/app/
wss://<server>[/<virtual-proxy>]/app/
```

Direct engine access requires certificates. The proxy form authenticates through Qlik Sense Proxy Service. Defaults can differ by installation. One engine WebSocket has one user and one app context; use separate connections for multiple apps. In multi-node deployments, Qlik recommends appending the app GUID to the WebSocket URI for routing.

## Authentication Patterns

### Trusted backend

Qlik documents direct engine access using PEM certificates exported from QMC and an `X-Qlik-User` header. Put certificate material in a secret manager mounted only into the adapter process. Never expose a private key, CA, or header value in MCP input, LLM context, browser code, logs, or audit data.

### Browser or untrusted network

Browser connections authenticate through Qlik Sense Proxy Service. Qlik checks WebSocket origin against the virtual-proxy Host whitelist; configure the UI origin and, where required, a CORS response header. The browser must already have or obtain a valid proxy-authenticated session.

### Browser rendering

Qlik documents `qlik-embed` client-managed interactive login and anonymous virtual-proxy options. Its `windowscookie` configuration expects an authenticated user session. Cross-domain setups need browser cookie support and correctly configured virtual proxies.

## Administrative APIs

| Service                      | Harness role                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| Repository Service API (QRS) | Administrative resource/app lifecycle operations where permitted.        |
| Proxy Service API (QPS)      | Proxy/session diagnostic or configuration workflows.                     |
| Engine JSON API              | App, generic object, session object, and associative-engine interaction. |
| About Service API            | Product/component information.                                           |

**Harness decision:** Exclude QRS/QPS mutations from first-release agent tools. Initial chart writes are limited to a designated test app through Engine APIs; operators configure security and proxy infrastructure.

## Native Chart Workflow

1. Acquire a target connection for the intended Qlik identity.
2. Connect and wait for a valid engine session.
3. Open the target document; handles stay local to this connection.
4. Read the authorized catalog and resolve an intent.
5. Create/evaluate a session object for preview.
6. Require approval before creating a persistent object or adding it to a sheet.
7. Close the WebSocket and dispose of session state.

## Implemented Adapter Path

The repository implements a concrete Engine path in `src/adapters/windows/`.
`EnvironmentWindowsSecretProvider` reads only the configured connection's
secret-injected environment values, validates a short-lived proxy JWT or parses
an injected PKCS#12/PFX identity plus `X-Qlik-User`, and fails closed without
falling back to files or interactive/default credentials. The supplied Azure
template obtains those values through Key Vault references.
`QlikWindowsEngineSessionFactory` uses `@qlik/api` for discovery, app-scoped
catalog and sheet-object reads, evaluated session previews, designated-target
create/attach/verify, and scoped cleanup. The adapter retains the creating
app/user session for each preview object and disposes the object before closing
that same session.

`src/adapters/windows/windowsRuntime.ts` validates the exact non-secret routing,
authentication mode, designated write target, and six readiness settings,
constructs the concrete provider/factory lazily, and is wired by
`QLIK_HARNESS_TARGET_MODE=windows` in the default service context. Missing or
unsafe routing, incomplete readiness, an expired approval window, or absent
secret injection leaves the target unconfigured.

The explicit `test/live/windowsG6.live.ts` probe requires administrator
evidence, current readiness flags, TLS confirmation, target routing, actor
identity, and one approved secret mode. Its write/cleanup lifecycle requires a
second explicit opt-in. It is excluded from ordinary offline tests and has not
run because `windows-dev` remains `not-run`, `not-supplied`, and `blocked` in
the readiness register. A concrete implementation is not live parity evidence.

## Readiness Checklist

- Record target release and supported APIs.
- Create/review a least-privileged harness identity and QRS security rules.
- Export, rotate, and safely store backend certificates.
- Configure virtual-proxy host whitelist for the UI origin.
- Test TLS, proxy path, ports, and a non-production app/sheet.
- Document object rollback and sheet cleanup.
- Configure `NODE_EXTRA_CA_CERTS` at Node startup when the private Qlik CA is
  not already trusted; never accept a CA path through MCP input. The Azure
  template's optional `windowsCaCertificateSecretName` mounts the PEM bundle
  from Key Vault at `/var/run/qlik-ca/ca.pem` and configures that process value;
  the route still needs live TLS validation.

## Sources

- [Connecting to Engine JSON API](https://help.qlik.com/en-US/sense-developer/May2026/Subsystems/EngineAPI/Content/Sense_EngineAPI/GettingStarted/connecting-to-engine-api.htm)
- [Windows API reference](https://help.qlik.com/en-US/sense-developer/May2026/Content/Sense_Helpsites/APIs-and-SDKs.htm)
- [Qlik-embed authentication](https://qlik.dev/embed/qlik-embed/authenticate/connect-qlik-embed/)
