# qlik-embed Cloud verification sample

This page consumes the existing harness `RenderDescriptor` and renders the
native object with Qlik's web component. It is designed for an
administrator-approved **public OAuth SPA authorization-code flow**: the
browser configuration contains a tenant host, public client ID, and exact
callback URI, but never a client secret, workload token, API key, or harness
credential. No such tenant/client approval is supplied in this repository.

## Configure and run

1. Register `http://localhost:4173` as the allowed origin and
   `http://localhost:4173/oauth-callback.html` as the exact callback in the
   approved `cloud-dev` tenant's public OAuth SPA client. Do not use a
   confidential/backend client.
2. Put only the following non-secret settings in the gitignored local `.env`.
   Use the exact app, object, and operation IDs emitted by one retained probe;
   never infer an object by title or creation time.

   ```dotenv
   QLIK_BROWSER_TENANT_HOST=https://tenant.region.qlikcloud.com
   QLIK_BROWSER_SPA_CLIENT_ID=00000000000000000000000000000000
   QLIK_BROWSER_REDIRECT_URI=http://localhost:4173/oauth-callback.html
   QLIK_BROWSER_APP_ID=RETAINED_APP_ID
   QLIK_BROWSER_OBJECT_ID=RETAINED_OBJECT_ID
   QLIK_BROWSER_OPERATION_ID=RETAINED_OPERATION_ID
   QLIK_BROWSER_EXPECTED_NATIVE_TYPE=sn-table
   ```

3. Run `npm run browser:prepare`. The generator validates these public values,
   rejects credential-shaped input, and creates mode-`0600` files under the
   gitignored `examples/qlik-embed/.local/` directory. It never copies the
   backend OAuth secret into browser files.
4. Run `npm run browser:serve` rather than opening the generated files as a
   `file:` URL. The purpose-built server binds only to `127.0.0.1:4173`, serves
   only the generated `.local` files, disables caching and directory listings,
   and derives request diagnostics only from the method and pathname (plus the
   locally generated status). It never logs OAuth callback query parameters,
   headers, cookies, or request bodies.
5. Open `http://localhost:4173/` and authenticate interactively. The loader sets
   `data-auth-type="Oauth2"` and `data-access-token-storage="session"`; its
   redirect URI must exactly match the tenant registration. The callback uses
   Qlik's documented OAuth callback handler and contains no client secret.

The tracked HTML files remain unconfigured templates. Do not put tenant, client,
app, object, or operation identifiers in them.

`test/unit/embed/qlikEmbedSample.test.ts` checks the versioned loader,
`analytics/chart` UI type, OAuth2 session storage, placeholder-only tracked
templates, local generator validation, and dedicated callback handler without
contacting Qlik. That static check is not a browser smoke test or G5 evidence.

## Exercise the three required browser paths

Repeat the page in separate clean browser profiles and use the matching radio
button to record the expected observation:

| Path         | Identity                                          | Required observation                                                              |
| ------------ | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Authorized   | User allowed to read the app and new sheet object | Native visualization renders and remains interactive.                             |
| Unauthorized | User denied app or sheet/object access            | Qlik denies access; the sample does not retry with a backend identity.            |
| Data-reduced | User with a known Section Access reduction        | Native visualization renders, but only identity-permitted rows/categories appear. |

Capture only the operation ID and a sanitized outcome category. Never capture
tokens, response bodies, tenant configuration, or restricted chart data in a
screenshot or log. The radio controls document the test path; they do not
impersonate a user or simulate authorization. A real tenant and three approved
identity states remain necessary for browser evidence.

The page exposes `QlikHarnessRenderObserver.snapshot()` for automation and
`QlikHarnessRenderObserver.recordOutcome(outcome, identityPath)` for an explicit
operator/browser assertion. Its snapshot contains only component geometry,
bounded mutation/resize counts, coarse error categories, the operation ID, and
the expected native type. It does not read DOM text, chart values, bodies,
headers, cookies, storage, or raw URLs. A component surface becoming ready is
not automatically classified as a successful visualization render; the visible
chart must still be inspected and its outcome explicitly recorded.

See Qlik's [OAuth SPA authentication guidance](https://qlik.dev/embed/qlik-embed/authenticate/connect-qlik-embed/)
for the versioned loader and callback contract used by this sample.
