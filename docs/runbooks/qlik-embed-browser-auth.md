# qlik-embed browser authentication

This runbook covers browser rendering only. The browser renders a native Qlik
object under the end user's Qlik identity; it does not receive a harness
workload credential.

## Required controls

- Use a documented interactive/OAuth browser flow for Cloud, or the approved
  authenticated/anonymous virtual-proxy flow for client-managed Windows.
- Configure redirect/callback and allowed UI origins in the platform
  administration plane. Record aliases and evidence, not secret values.
- Verify cookie, cross-origin, TLS, and WebSocket behavior in the target
  browser profile.
- Pass only a sanitized render descriptor (`connectionAlias`, app ID, object
  ID, operation ID, and rendering mode) to the UI.
- Keep OAuth secrets, API keys, certificate material, private keys, proxy
  headers, and backend session state out of browser code, MCP input, URLs,
  browser storage, screenshots, and logs.
- Confirm that the rendered object honors the user's selections, permissions,
  and Section Access/data reduction.

## Cloud checklist

1. Confirm the `cloud-dev` tenant alias and UI origin are approved by the
   platform administrator.
2. Confirm the browser flow obtains a user session without exposing a
   workload credential.
3. Render an existing designated test object, then the object created by the
   live G5 lifecycle.
4. Repeat as a read-reduced or unauthorized user and verify access is denied
   or data is reduced as expected.
5. Correlate browser failures to the operation ID using sanitized categories.

## Windows checklist

1. Confirm the `windows-dev` virtual-proxy alias, host whitelist, origin
   policy, and TLS chain with the platform administrator.
2. Verify the browser session is established through the approved proxy
   authentication mode.
3. Confirm the WebSocket route and app context are valid without exposing
   certificate or proxy header values.
4. Render a designated test object and repeat with a user lacking sheet access.

## Failure handling

Classify failures as browser-authentication, origin/TLS, authorization,
rendering, capacity, transient, or rate-limit errors. Redact response bodies
before audit. Do not fall back to a backend credential in the browser and do
not claim target readiness from a local render attempt alone.
