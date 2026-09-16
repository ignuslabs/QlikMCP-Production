# Qlik Cloud OAuth and browser readiness

This worksheet is for Qlik Cloud development targets. It does not authorize
production access and must not contain tenant hosts, account identifiers,
OAuth client identifiers or secrets, tokens, callback URLs, or user details.

## Platform-admin intake

The Qlik Cloud platform administrator verifies externally:

- the tenant/region alias and synthetic app/sheet aliases resolve only to
  non-production resources;
- the OAuth client, scopes, redirect/origin policy, and rotation owner are
  approved in the external identity and secret systems;
- the effective identity class has the expected space, app, section-access,
  and data-reduction boundary;
- REST discovery and QIX app-routing probes succeed without exposing raw
  payloads;
- an approved browser origin can establish a session and render the synthetic
  object;
- session previews are disposed on success, failure, timeout, and cancellation;
- when writes are separately authorized, persistence is limited to the
  designated sheet and verification and scoped cleanup succeed; and
- sanitized audit events can be correlated for the probes without tokens,
  headers, unrestricted data, or identity details.

## Repository handoff

Store the full results, approvals, configuration, and secret material only in
the approved external systems. In
[`readiness-register.md`](readiness-register.md), record only `cloud-dev`, the
probe outcomes, UTC review dates, role aliases, an opaque non-secret evidence
reference, and the resulting decision.

Keep the target `blocked` when the non-production boundary, OAuth policy,
origin policy, identity boundary, app routing, preview disposal, audit
redaction, or evidence ownership is unproven. Use `read-only` when those checks
pass but write/cleanup has not passed. Only an unexpired, independently reviewed
write/verify/cleanup result permits `approved-for-development`.

## Executable handoff

The delivery team has supplied a fail-closed probe at
[`test/live/cloudAdapterProbe.ts`](../../test/live/cloudAdapterProbe.ts). Run it
from an approved environment with secret injection and the exact non-secret
contract documented in [`.env.example`](../../.env.example):

```bash
QLIK_CLOUD_LIVE_PROBE=G4 npm run test:live:cloud
QLIK_CLOUD_LIVE_PROBE=G5 npm run test:live:cloud
```

G4 performs bounded app discovery, catalog/sheet inspection, compiled preview,
and exact-session disposal. G5 additionally creates, attaches, verifies, and
always attempts scoped cleanup. The process prints only a sanitized JSON
pass/fail envelope. After G5, separately execute the authorized, unauthorized,
and data-reduced browser paths in
[`examples/qlik-embed/`](../../examples/qlik-embed/). Record current results in the
[readiness register](readiness-register.md); no historical source-environment
pass is inherited by this repository or a new release artifact.
