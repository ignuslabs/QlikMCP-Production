# Management workflow recovery

## Supported recovery and current limit

`qlik_management_execute` reuses the original plan and unchanged steps. It skips completed
steps, releases only locks still owned by those steps, and retries transiently failed or waiting read-only
steps after checking the current grant and execution deadline. A terminal failed reload remains
`failed` with `outcome: "terminal-failure"`; execute and reconcile return that outcome without
repeating the reload or polling a completed job. It never repeats an uncertain
mutation. `qlik_management_reconcile` performs fresh provider readback for an acknowledged or
uncertain attempt; it does not execute the original mutation.

Known no-effect outcomes are a definitive direct provider mutation rejection
(a trusted `MALFORMED_REQUEST` marker with `outcome: "rejected"` and HTTP status
400 or 422) or a trusted Engine rejection before write dispatch
(`outcome: "rejected"`, `dispatch: "not-started"`). Both require no earlier receipt
in memory or durable state. The workflow
conditionally persists `failed` and `outcome: "rejected"` before releasing the
still-owned lock. It never resends that failed mutation. A subsequent execute
or reconcile request for the identical plan can repair an interrupted owned-lock
release, then returns the same failed outcome. It cannot release a lock that now
belongs to another step or actor.

The REST marker applies to the schedule PATCH call's direct validation
response. The Engine marker requires that its guarded write callback never ran
and session shutdown completed successfully. A stale object hash can therefore
fail without stranding the app lock. Neither marker is inferred from an arbitrary error message, a generic HTTP
400/422, a later failed download/readback, a timeout, or an earlier acknowledged
operation. If the failure is unmarked, acknowledgement exists, or persisting
the definitive outcome cannot be confirmed, retain the uncertainty boundary.

Historical `uncertain` records without a trusted rejection marker remain unresolved.
In particular, the feature-test incident's stored `IDEMPOTENCY_CONFLICT` code and a
fresh read of a still-published sheet do not by themselves authorize releasing its
lock. The source fix prevents new occurrences; it does not retrospectively certify
an older attempt or clear its lock.

An attempt left `in-progress` after process loss requires manual operator recovery. There is
currently **no operator recovery CLI or MCP tool that can fence a worker or supply a missing
provider receipt**. The procedure below is a privileged maintenance operation, not an automatic
recovery guarantee. If its evidence requirements cannot be met, retain the lock and escalate.

The plan's execution deadline, the HTTP timeout, a disconnected client, and an expired OAuth
token do not establish that a dispatched Qlik operation stopped. Do not delete a lock, clear an
execution record, create a replacement plan, or reissue a creation request to get past it.

## Choose the next action

| Persisted step status                                     | Supported next action                                                                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`                                               | Execute the same plan again; the provider mutation is skipped and any still-owned lock release is retried.                                                                                   |
| `waiting`                                                 | Execute the same plan to poll the read-only step again within its original deadline.                                                                                                         |
| `failed` for a transient read-only error                  | Execute the same plan to retry with fresh authorization within its original deadline.                                                                                                        |
| `failed` with `outcome: "terminal-failure"`               | The provider job definitively failed. Execute or reconcile returns the same failure; diagnose and plan any corrected work separately.                                                        |
| `failed` with `outcome: "rejected"`                       | Execute or reconcile the identical plan to repair only a still-owned lock release. The failed mutation is never resent. Review corrected input in a new plan after the release is confirmed. |
| `acknowledged` or `uncertain`, with a sufficient receipt  | Reconcile the exact step, then resume the unchanged plan only after readback reports `completed`.                                                                                            |
| `uncertain`, deterministic destination ID, no receipt     | Reconcile can attempt readback from immutable IDs. Updates requiring a post-write hash may remain unprovable.                                                                                |
| `uncertain`, provider-assigned destination ID, no receipt | Use the manual procedure below. A matching name is not a receipt.                                                                                                                            |
| `in-progress`                                             | Establish worker and provider quiescence before the manual procedure below. Elapsed time alone is insufficient.                                                                              |

Capture `qlik_management_status` using the same owner and authenticated client that created
the plan. Keep the original steps in their approved private location: the audit store retains
hashes and control-plane outputs, not load scripts, dataset rows, or request bodies. Preserve
the plan ID, step index, attempt ID when present, correlation ID, and exact provider IDs.

## Reviewer configuration during recovery

The renderer permits an explicitly empty governance reviewer list only for an
enabled management policy with at least one valid grant, an empty policy
reviewer list, and `requireApproval: false` on every grant. Missing approval flags
default to `true`; a disabled or absent policy does not qualify. This exception
does not create a reviewer or authorize an operator maintenance action. Keep the
exact authenticated owner/client and current action/resource grant for recovery.
Where a grant requires review, use an actual independent reviewer; do not invent
an identity or edit an approved plan to work around it.

## Manual recovery procedure

This procedure requires an independently authorized operator, the original approved inputs,
and read/write access to the specific deployment's management table. Use the normal incident
review process. Do not grant the end-user MCP client direct table access.

1. **Stop new dispatch and fence the old worker.** Disable management mutation admission for
   the affected deployment and drain or stop every runtime/session that could still own the
   attempt using the deployment's approved AWS operations procedure. Establish that those
   workers cannot resume. Check Qlik activity as well: stopping a client does not cancel an
   already accepted reload or server operation. Wait for any known operation to reach a
   terminal state. Record the evidence and operator identity outside content-bearing logs.
   If an old worker or provider operation could still continue, stop here with the lock held.
2. **Read durable state consistently.** Through `DynamoManagementStore.get`, read the owner
   plan, execution `${planId}/step/${index}`, and the execution's `lockId` under owner
   `__management_locks__`. Preserve their current versions and immutable audit events.
   Verify the authenticated client, original plan hash, step action, resolved input hash,
   execution attempt identity, saved authorized target, lock owner actor, and lock step ID.
   For older records without an attempt ID, use the full execution record and version as
   the incident identity. A mismatched lock belongs to another operation and must not change.
3. **Recover an exact receipt.** Prefer the persisted receipt or the original authenticated
   provider response. For provider-assigned creations, require evidence linking the returned
   destination ID to this exact attempt, then independently inspect that destination and its
   current authorized scope. A listing match, same title, same schema, source app ID, or an
   operator's guessed ID is insufficient. If the destination ID is lost and cannot be tied to
   this attempt, leave the step unresolved. Some provider operations cannot be recovered
   automatically under that condition.
4. **Review the proposed state transition.** An operator may prepare an `in-progress` or
   unresolved execution for the existing verifier by changing only its status to `uncertain`,
   attaching the proven, sanitized scalar receipt if available, and recording an incident
   reference, operator identity, and fencing time. Retain all plan/action/input/target/attempt
   fields, expiry, and lock information. Increment the execution version exactly once.
   Never insert source rows, scripts, tokens, provider response bodies, or download URLs into
   the state or audit payload. The receipt is evidence, not permission to change the inputs.
5. **Apply a conditional audited write.** Use the repository's
   `DynamoManagementStore.put(updatedExecution, observedVersion)`, which atomically writes the
   state transition and immutable audit event. Do not issue an unconditional DynamoDB update
   or edit only the `STATE` item. A version conflict requires a new consistent read and review;
   do not force it through. Keep the target lock held. The runtime must remain fenced until
   the operator finishes this maintenance step.
6. **Restore admission and run readback.** The original owner/client calls
   `qlik_management_reconcile` with the original plan ID, unchanged steps, and exact index.
   Current policy must still authorize the operation. A successful verifier saves completion
   and releases only the still-owned lock. If verification fails, a post-write hash is missing,
   or a read cannot establish authoritative absence, keep the step unresolved. Do not set
   `completed` merely to make the plan continue.
7. **Resume and validate.** Repeat the original execute request. Completed mutations are
   skipped. If the original execution deadline has passed, it cannot start remaining steps;
   plan the remaining work only after this attempt is independently verified and its lock is
   resolved. Confirm exact native objects, dataset versions, terminal reload status, and
   expected chart values for the affected workflow. Keep the recovery incident evidence.

## Deployment checks

The IAM policy in [foundation.yaml](../infra/aws/foundation.yaml) grants table-scoped
`dynamodb:PutItem`, which authorizes the transaction's constituent `Put` actions. A separate
`dynamodb:TransactWriteItems` IAM action is not required. The store currently uses transactional
puts rather than separate `ConditionCheck` actions. See the
[AWS transaction IAM documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

The store caps a record at 350,000 serialized bytes and a transaction at 20 distinct records
and 3,500,000 bytes, including audit copies. A 192 KiB artifact chunk becomes 256 KiB in base64
before metadata, below the record cap. This bounds individual requests; it is not a total
artifact storage, concurrency, or tenant spending quota. Large exports assemble whole buffers
and perform many chunk reads/writes. Validate deployed memory, latency, admission limits,
table capacity, and expiry behavior before enabling maximum-size exports for concurrent users.

Node's `server.requestTimeout` limits time spent receiving the request; it is not a deadline
that aborts an asynchronous provider workflow. Provider deadlines and fencing evidence must
be evaluated separately. See the [Node HTTP documentation](https://nodejs.org/api/http.html#serverrequesttimeout).

### Storage protection and log retention

The [foundation template](../infra/aws/foundation.yaml) sets
`DeletionProtectionEnabled: true` on the governance table. This protects the
table from deletion in addition to its existing `DeletionPolicy: Retain`,
`UpdateReplacePolicy: Retain`, point-in-time recovery, and server-side encryption.
AWS supports updating this property without replacement. Disabling protection
for deliberate decommissioning requires a separately reviewed deployment change;
do not use table deletion to resolve a workflow lock. See the
[CloudFormation table property](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-dynamodb-table.html#cfn-dynamodb-table-deletionprotectionenabled).

After applying the foundation change, inspect the exact deployed table's
`DeletionProtectionEnabled` value. Local template validation does not establish
that a live table is protected. Deletion protection does not prevent individual
item updates or expiry and does not replace a tested backup/restore procedure.

Set **90-day retention** on the actual CloudWatch log group for each deployed
runtime endpoint, then read back `retentionInDays: 90`. AgentCore creates runtime
log destinations with deployment-specific identifiers, so the foundation does
not create or change these log groups. Discover the exact group through the
deployed runtime/CloudWatch configuration before updating it; distinguish its
log group from individual runtime log streams. Follow
[AWS's runtime observability guidance](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html).

For example, with the approved AWS account/profile and Region selected, replace
the example name with the exact discovered group:

```bash
aws logs put-retention-policy \
  --log-group-name '/aws/bedrock-agentcore/runtimes/REPLACE_WITH_VERIFIED_GROUP' \
  --retention-in-days 90

aws logs describe-log-groups \
  --log-group-name-prefix '/aws/bedrock-agentcore/runtimes/REPLACE_WITH_VERIFIED_GROUP' \
  --query 'logGroups[].{name:logGroupName,retentionInDays:retentionInDays}'
```

Confirm the exact returned group, not merely a prefix match. The operator needs
permission to set retention; the application execution role is not granted log
retention administration. AWS supports a 90-day retention setting and removes
expired events asynchronously; reducing an existing longer retention can expire
older events. Apply the approved retention before relying on log availability
for incident recovery. See
[PutRetentionPolicy](https://docs.aws.amazon.com/cli/latest/reference/logs/put-retention-policy.html).
This log retention is separate from the 90-day management-state expiry and the
one-day private artifact expiry. Do not log source rows, scripts, credentials,
or provider response bodies merely because retention is bounded.
