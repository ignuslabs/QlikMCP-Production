# Target readiness intake and blockers

## Non-production boundary

The example aliases `cloud-dev` and `windows-dev` are development-only. They
are example aliases for synthetic, non-production rehearsal resources. Fixture
IDs in `test/fixtures/catalog.json` are not live resource IDs. Map real isolated
resources only in ignored private configuration; keep fixture data and
`config/connections.example.json` synthetic. This runbook covers development
rehearsals; use [production operations](production-operations.md) for promotion.

**No live connection can be declared ready without platform-admin-supplied
nonsecret readiness evidence.** The repository fixtures do not prove
connectivity, authentication, authorization, rendering, or mutation. No live
validation is claimed here.

## Intake record

The platform administrator supplies a reviewable, secret-free record for each
alias:

| Evidence                                        | Cloud development                  | Windows development                          |
| ----------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| Alias and environment                           | `cloud-dev`, development           | `windows-dev`, development                   |
| Synthetic app alias and stable ID               | Required                           | Required                                     |
| Designated write-test sheet alias and stable ID | Required                           | Required                                     |
| Read-only sheet alias and stable ID             | Required                           | Required                                     |
| Effective identity class and owner              | Required; no credential value      | Required; no credential or certificate value |
| Read and preview probe result                   | Required                           | Required                                     |
| Designated-sheet write and cleanup probe result | Required before writes are enabled | Required before writes are enabled           |
| Audit/correlation evidence                      | Required                           | Required                                     |
| Expiry/review date                              | Required                           | Required                                     |

Record only aliases, IDs approved for non-production configuration, capability
results, timestamps, and the evidence owner. Keep tokens, secrets, private
keys, headers, and certificate contents in the approved secret/provider
systems.

## Administrator completion workflow

The delivery team sends one copy of the applicable platform worksheet to the
platform administrator. The administrator, rather than an application
developer, performs and attests to the target probes.

1. Confirm in the platform inventory that the target, app, and sheets are
   non-production and isolated from production data.
2. Put hosts, credentials, certificates, tokens, OAuth client details, proxy
   header values, and sensitive identifiers in the approved external
   secret/configuration systems. Do not paste them into an issue, pull request,
   log, screenshot, or this repository.
3. Run the read, preview, disposal, audit, and (when separately authorized)
   designated-sheet write and cleanup probes using the effective test identity.
   Use the supplied Cloud G4/G5 or Windows G6 probe linked from the relevant
   platform worksheet; do not substitute fixture tests.
4. Sanitize the results to the fields in the intake table. Use aliases in place
   of tenant, server, node, proxy, identity, and owner names. A repository
   evidence reference must be an opaque non-secret reference such as
   `OPS-EVIDENCE-CLOUD-DEV`; it must not be a URL, vault path, account ID, or
   ticket title containing a host or person.
5. Have a second platform administrator or security reviewer confirm the
   non-production boundary, least privilege, cleanup result, and redaction.
6. Update the corresponding row in
   [`../deployment/readiness-register.md`](../deployment/readiness-register.md).
   Check boxes only for probes actually observed, and set the decision and
   review date. An incomplete or expired row remains `blocked` or `read-only`.

The external evidence system remains the authoritative record. The repository
register is only a sanitized decision index and deliberately cannot be used to
connect to a target.

## Blockers

Keep the alias blocked and expose read-only behavior only when any of these
conditions applies:

- The environment, app, or sheet is production or cannot be proven
  non-production.
- The platform administrator has not supplied the nonsecret evidence above.
- The effective identity, role boundary, or data-reduction behavior is
  unknown.
- The designated sheet is not isolated for test writes and cleanup.
- Browser origin, TLS, proxy, OAuth, or certificate readiness is unproven.
- A preview can be created but cannot be disposed on success, failure, timeout,
  or cancellation.
- Audit correlation or redaction has not been demonstrated.

## Readiness decision

1. Compare the evidence record with the corresponding fixture alias and
   logical catalog contract.
2. Run read-only discovery under the effective identity.
3. Verify the bounded catalog excludes hidden, sensitive, load-script,
   connection, and security metadata.
4. Probe session preview and disposal.
5. Probe designated-sheet persistence and scoped cleanup only after write
   approval is enabled for that environment.
6. Store the evidence reference and decision (`blocked`, `read-only`, or
   `approved-for-development`) in the operational system.

Never promote a fixture alias or readiness decision to production by copying
configuration.
