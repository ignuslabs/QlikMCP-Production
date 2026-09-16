# Windows certificate and proxy readiness

This runbook is for Qlik Sense Enterprise on Windows development targets. It
does not authorize production access and does not contain certificate,
private-key, host, or proxy-header values.

## Platform-admin intake

Obtain nonsecret evidence for the `windows-dev` alias:

- Qlik release and node/topology identifier.
- Approved server and virtual-proxy aliases.
- TLS certificate chain validation result and certificate expiry date (not
  certificate contents).
- Engine route and app-routing probe result.
- Virtual-proxy host whitelist and approved UI-origin result.
- Authentication mode (`proxy-session` or `trusted-backend`) and effective
  identity class.
- QRS security-rule boundary for the synthetic app/sheet.
- Read, preview, designated-sheet write, verification, and cleanup probe
  results.
- Evidence owner, timestamp, and review/expiry date.

Record the sanitized outcome and opaque evidence reference in
[`readiness-register.md`](readiness-register.md). Keep server/node names,
addresses, virtual-proxy details, identity names, certificate fingerprints and
serial numbers, and external-system locations out of the repository. Use only
their approved non-secret aliases here.

## Trusted backend route

The adapter retrieves certificate material from the approved secret provider
at runtime. It must never accept PEM content, private keys, or `X-Qlik-User`
header values as tool input, fixture data, config examples, logs, or audit
fields. Verify least privilege and rotation ownership before enabling writes.

## Proxy/browser route

Verify the approved virtual-proxy session, origin whitelist, TLS trust,
cookie behavior, WebSocket route, and app context from the browser test
profile. Do not substitute a backend certificate for a browser session.

## Blockers

Keep the target blocked or read-only when TLS validation, proxy routing,
origin policy, identity permissions, app routing, cleanup, or audit
correlation is unproven. A successful local socket or browser check is not
live readiness evidence unless it is supplied and owned by the platform
administrator.

## Executable handoff

The delivery team has supplied a fail-closed probe at
[`test/live/windowsG6.live.ts`](../../test/live/windowsG6.live.ts). After the
administrator injects exactly one approved secret mode and supplies every
non-secret readiness value from [`.env.example`](../../.env.example), run:

```bash
npm run test:live:windows
```

`QLIK_WINDOWS_LIVE_G6=1` and `QLIK_WINDOWS_TLS_TRUST_CONFIRMED=1` are mandatory.
The default probe performs bounded discovery/catalog/sheet-object reads and a
same-session preview/disposal. Persistent create/attach/verify/cleanup occurs
only when `QLIK_WINDOWS_LIVE_ALLOW_WRITE=1` and the write/cleanup readiness
values are explicitly true. The process prints only a sanitized JSON pass/fail
envelope. This retained development probe is not an AgentCore deployment lane
and has no inherited live acceptance in this repository.
