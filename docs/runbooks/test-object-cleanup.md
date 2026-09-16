# Cleanup for non-production test objects

Cleanup is mandatory for every fixture preview and persistent-create test,
including successful, failed, timed-out, cancelled, and partially applied
operations, except an explicitly requested retained-object visual-verification
run.

## Before the test

- Confirm the connection alias is `cloud-dev` or `windows-dev`.
- Confirm the app and sheet are synthetic development targets.
- Capture the operation ID, correlation ID, plan hash, and pre-test object IDs.
- Use an operation ownership marker in the test object's description or
  metadata; do not use a secret as an ownership marker.
- Define the exact object and attachment scope that the test may remove.

## During the test

1. Track every session object, persistent object, and sheet attachment created
   by the current operation.
2. Dispose session objects in a `finally`-equivalent path.
3. If persistence succeeds, verify the object before cleanup.
4. If attachment fails after object creation, delete only the object created by
   this operation and record the result.
5. Never delete pre-existing objects, a whole sheet, an app, or unrelated
   objects to repair a fixture failure.

## After the test

- Re-read the designated sheet and confirm the test object is absent.
- Confirm no session remains open and no orphan object remains.
- Store `cleanupAttempted`, `cleanupOutcome`, IDs, and the operator/evidence
  reference in sanitized audit data.
- If deletion or disposal fails, transition the operation to
  `cleanup-required`, page the development owner, and stop further writes to
  that target until the orphan is reviewed.

## Partial-apply expectation

For `PARTIAL_APPLY`, an object may exist while the sheet attachment does not.
Cleanup is scoped to the object created by that operation. A successful
cleanup leaves the operation failed but records `cleanup-complete`; an
unsuccessful cleanup leaves `cleanup-required` and requires operator action.
Cleanup must be retryable by operation ID without broadening its scope.

## Retained-object visual verification

`npm run test:live:cloud:retain` is the controlled exception for inspecting a
successful Cloud G5 object in the Qlik application. It runs the same
separate-requester/reviewer workflow against the designated development sheet,
but leaves an object attached only after create, attachment, verification, and
idempotent replay succeed. Failure paths still attempt scoped cleanup.

- Record the emitted app ID, sheet ID, object ID, and unique object title.
- Inspect the object in the designated Qlik Cloud sheet, then delete that
  exact object from the Qlik application when inspection is complete.
- Record the deletion outcome and visual-verification evidence in the
  applicable operation record; never retain an object on a production target.

## Native-matrix retained manifest

The all-native matrix normally creates and cleans one object at a time. Retain
exactly one object for browser inspection with:

```bash
npm run test:live:cloud:matrix:retain
```

The command refuses to mutate Qlik when
`.qlik-ai-harness/cloud-browser/retained-object.json` already exists. That
gitignored, owner-only manifest is the sole exact locator for the retained app,
sheet, object, operation, native type, structural checks, and baseline. Never
replace it by running another retain command, and never infer an object from a
title or creation time.

After browser inspection, run:

```bash
npm run test:live:cloud:matrix:cleanup
```

Cleanup uses the exact manifest target, removes only the recorded object, then
reopens the sheet and proves the child and cell are absent while unrelated
object/cell counts still match the recorded baseline. It removes the manifest
only after that proof succeeds. If cleanup reports ambiguous or inconsistent
state, stop all writes to the target.

Use reconciliation only when the exact object was already removed manually or
the preceding cleanup outcome is known and reviewed:

```bash
npm run test:live:cloud:matrix:reconcile
```

Reconciliation does not authorize broad deletion. It confirms the manifest's
exact object/cell absence and baseline preservation before retiring the local
locator. Preserve a failing manifest for investigation; do not edit it to make
the guard pass.
