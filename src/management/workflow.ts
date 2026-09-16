import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createError, toSafeUnexpectedError } from '../domain/errors.js';
import { computePlanHash } from '../domain/ids.js';
import type { ManagementPolicyEngine, ManagementActor, ManagementTarget } from './policy.js';
import type { ManagementRecord, ManagementStore } from './state.js';

export const workflowStepSchema = z
  .object({
    action: z
      .string()
      .regex(/^[a-z]+(?:\.[a-z]+)+$/)
      .max(80),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export const workflowStepsSchema = z.array(workflowStepSchema).min(1).max(40);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export interface ActionDefinition {
  readonly schema: z.ZodType;
  readonly readOnly: boolean;
  inspect(input: Record<string, unknown>): Promise<ManagementTarget>;
  execute(
    input: Record<string, unknown>,
    onReceipt?: (receipt: Record<string, unknown>) => Promise<void>,
  ): Promise<Record<string, unknown>>;
  verify?(
    input: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
export type ActionRegistry = Readonly<Record<string, ActionDefinition>>;

// Persist only explicit control-plane fields. Source rows, scripts, provider bodies and URLs never enter the audit store.
const CHECKPOINT_KEYS = new Set([
  'id',
  'appId',
  'spaceId',
  'targetSpaceId',
  'sheetId',
  'objectId',
  'itemId',
  'fileId',
  'dataFileId',
  'reloadId',
  'taskId',
  'scheduleId',
  'assignmentId',
  'shareId',
  'artifactId',
  'exportId',
  'expectedHash',
  'expectedSheetHash',
  'sourceVersion',
  'status',
  'verified',
  'deleted',
  'objectDeleted',
  'retainedAppObject',
  'retainedAppObjectCount',
  'created',
  'updated',
  'published',
  'sha256',
  'byteLength',
  'exists',
  'resourceId',
  'kind',
  'name',
  'title',
]);
function checkpoint(result: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).filter(
      ([name, value]) =>
        CHECKPOINT_KEYS.has(name) &&
        ((typeof value === 'string' && value.length <= 512) ||
          typeof value === 'boolean' ||
          typeof value === 'number'),
    ),
  );
}

function hasReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if ('$ref' in value) return true;
  return Object.values(value).some(hasReference);
}

function validateReferenceInput(
  definition: ActionDefinition,
  input: Record<string, unknown>,
): void {
  const paths: (string | number)[][] = [];
  const visit = (value: unknown, path: (string | number)[]) => {
    if (!value || typeof value !== 'object') return;
    if ('$ref' in value) {
      paths.push(path);
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, index]));
    else Object.entries(value).forEach(([name, item]) => visit(item, [...path, name]));
  };
  visit(input, []);
  const result = definition.schema.safeParse(input);
  if (
    !result.success &&
    result.error.issues.some(
      (issue) => !paths.some((path) => path.every((part, index) => issue.path[index] === part)),
    )
  ) {
    throw createError('MALFORMED_REQUEST', {
      message: 'Workflow input contains invalid fields outside its deferred references.',
    });
  }
}

/** References use prior durable control-plane outputs only; arbitrary source values cannot become execution state. */
function resolveReferences(
  value: unknown,
  results: readonly Record<string, unknown>[],
  index: number,
  depth = 0,
): unknown {
  if (depth > 20) throw createError('MALFORMED_REQUEST');
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => resolveReferences(item, results, index, depth + 1));
  const record = value as Record<string, unknown>;
  if ('$ref' in record) {
    const ref = z
      .object({
        $ref: z
          .object({
            step: z
              .number()
              .int()
              .min(0)
              .max(index - 1),
            field: z.string().refine((name) => CHECKPOINT_KEYS.has(name)),
          })
          .strict(),
      })
      .strict()
      .parse(record).$ref;
    const resolved = results[ref.step]?.[ref.field];
    if (resolved === undefined)
      throw createError('MALFORMED_REQUEST', {
        message: 'Workflow reference has no verified prior value.',
      });
    return resolved;
  }
  return Object.fromEntries(
    Object.entries(record).map(([name, item]) => [
      name,
      resolveReferences(item, results, index, depth + 1),
    ]),
  );
}

export class ManagementWorkflow {
  constructor(
    readonly actor: ManagementActor,
    readonly policy: ManagementPolicyEngine,
    private readonly store: ManagementStore,
    readonly actions: ActionRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  private definition(action: string): ActionDefinition {
    const definition = this.actions[action];
    if (!definition)
      throw createError('MALFORMED_REQUEST', { message: 'Unknown management action.' });
    return definition;
  }

  private async lock(
    connection: string,
    target: ManagementTarget,
    stepId: string,
  ): Promise<ManagementRecord> {
    const id = `lock-${computePlanHash({ connection, target: target.appId ?? target.spaceId ?? target.targetSpaceId ?? 'personal' })}`;
    const old = await this.store.get('__management_locks__', id);
    if (old && old.data.status !== 'released')
      throw createError('IDEMPOTENCY_CONFLICT', {
        message: 'Another operation owns this target; inspect its outcome before retrying.',
      });
    const record: ManagementRecord = {
      id,
      owner: '__management_locks__',
      kind: 'lock',
      version: (old?.version ?? 0) + 1,
      expiresAt: new Date(this.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      data: { status: 'held', stepId, actor: this.actor.actor },
    };
    return record;
  }

  private async release(lock: ManagementRecord): Promise<void> {
    await this.store.put(
      { ...lock, version: lock.version + 1, data: { ...lock.data, status: 'released' } },
      lock.version,
    );
  }

  private async releaseOwnedLock(execution: ManagementRecord): Promise<void> {
    if (typeof execution.data.lockId !== 'string') return;
    const lock = await this.store.get('__management_locks__', execution.data.lockId);
    if (
      lock?.data.stepId === execution.id &&
      lock.data.actor === this.actor.actor &&
      lock.data.status === 'held'
    )
      await this.release(lock);
  }

  private async authorize(
    action: string,
    input: Record<string, unknown>,
  ): Promise<{ input: Record<string, unknown>; approval: boolean; target: ManagementTarget }> {
    const definition = this.definition(action);
    const parsed = definition.schema.parse(input) as Record<string, unknown>;
    if (typeof parsed.connection !== 'string') throw createError('MALFORMED_REQUEST');
    const grant = this.policy.grant(this.actor, parsed.connection, action);
    const target = await definition.inspect(parsed);
    this.policy.authorizeTarget(grant, target);
    return { input: parsed, approval: !definition.readOnly && grant.requireApproval, target };
  }

  async read(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.definition(action).readOnly)
      throw createError('PERMISSION_DENIED', { message: 'Mutations require a planned workflow.' });
    const authorized = await this.authorize(action, input);
    return this.definition(action).execute(authorized.input);
  }

  async plan(rawSteps: WorkflowStep[]): Promise<Record<string, unknown>> {
    const steps = workflowStepsSchema.parse(rawSteps);
    if (Buffer.byteLength(JSON.stringify(steps)) > 700_000) throw createError('MALFORMED_REQUEST');
    let requiresApproval = false;
    const summary: Record<string, unknown>[] = [];
    for (const [index, step] of steps.entries()) {
      const definition = this.definition(step.action);
      if (typeof step.input.connection !== 'string') throw createError('MALFORMED_REQUEST');
      const grant = this.policy.grant(this.actor, step.input.connection, step.action);
      requiresApproval ||= !definition.readOnly && grant.requireApproval;
      if (!hasReference(step.input)) {
        const authorized = await this.authorize(step.action, step.input);
        summary.push({
          index,
          action: step.action,
          connection: step.input.connection,
          target: authorized.target,
          inputHash: computePlanHash(step.input),
          readOnly: definition.readOnly,
        });
      } else {
        // Validate reference structure and prohibit forward references without contacting an unresolved target.
        const placeholders = Array.from({ length: index }, () =>
          Object.fromEntries([...CHECKPOINT_KEYS].map((name) => [name, 'pending-reference'])),
        );
        resolveReferences(step.input, placeholders, index);
        validateReferenceInput(definition, step.input);
        summary.push({
          index,
          action: step.action,
          connection: step.input.connection,
          inputHash: computePlanHash(step.input),
          readOnly: definition.readOnly,
          targetPending: true,
        });
      }
    }
    const planId = `management-plan-${randomUUID()}`;
    const planHash = computePlanHash({ actor: this.actor, steps });
    const expiresAt = new Date(this.now() + 15 * 60 * 1000).toISOString();
    const record: ManagementRecord = {
      id: planId,
      owner: this.actor.actor,
      kind: 'plan',
      version: 1,
      expiresAt: new Date(this.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      data: {
        clientId: this.actor.hostClientId,
        planHash,
        status: requiresApproval ? 'awaiting-approval' : 'approved',
        steps: summary,
        requiresApproval,
        expiresAt,
      },
    };
    await this.store.put(record, null);
    return { planId, ...record.data };
  }

  async approve(
    owner: string,
    planId: string,
    steps: WorkflowStep[],
  ): Promise<Record<string, unknown>> {
    this.policy.reviewer(this.actor, owner);
    const record = await this.store.get(owner, planId);
    if (
      !record ||
      record.kind !== 'plan' ||
      record.data.status !== 'awaiting-approval' ||
      Date.parse(String(record.data.expiresAt)) <= this.now()
    )
      throw createError('PERMISSION_DENIED');
    const hash = computePlanHash({
      actor: { actor: owner, hostClientId: record.data.clientId },
      steps: workflowStepsSchema.parse(steps),
    });
    if (hash !== record.data.planHash) throw createError('PERMISSION_DENIED');
    await this.store.put(
      {
        ...record,
        version: record.version + 1,
        data: {
          ...record.data,
          status: 'approved',
          reviewer: this.actor.actor,
          approvedAt: new Date(this.now()).toISOString(),
        },
      },
      record.version,
    );
    return { planId, planHash: hash, status: 'approved' };
  }

  private async getPlan(planId: string): Promise<ManagementRecord> {
    const record = await this.store.get(this.actor.actor, planId);
    if (!record || record.kind !== 'plan' || record.data.clientId !== this.actor.hostClientId)
      throw createError('PERMISSION_DENIED');
    return record;
  }

  async status(planId: string): Promise<Record<string, unknown>> {
    const record = await this.getPlan(planId);
    const steps = record.data.steps as readonly Record<string, unknown>[];
    const executions = [];
    for (const [index, step] of steps.entries()) {
      const execution = await this.store.get(this.actor.actor, `${planId}/step/${index}`);
      executions.push({
        index,
        action: step.action,
        ...(execution?.data ?? { status: 'pending' }),
      });
    }
    return {
      planId,
      planHash: record.data.planHash,
      approval: record.data.status,
      expiresAt: record.data.expiresAt,
      executionDeadline: record.data.executionDeadline,
      steps: executions,
    };
  }

  /** Reconciliation only reads provider state. It never reissues the original mutation. */
  async reconcile(
    planId: string,
    rawSteps: WorkflowStep[],
    index: number,
  ): Promise<Record<string, unknown>> {
    const plan = await this.getPlan(planId);
    const steps = workflowStepsSchema.parse(rawSteps);
    if (
      plan.data.planHash !== computePlanHash({ actor: this.actor, steps }) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= steps.length
    )
      throw createError('PERMISSION_DENIED');
    const id = `${planId}/step/${index}`;
    const execution = await this.store.get(this.actor.actor, id);
    if (!execution || execution.kind !== 'execution') throw createError('MALFORMED_REQUEST');
    if (execution.data.status === 'completed') {
      await this.releaseOwnedLock(execution);
      return { planId, index, status: 'completed', result: execution.data.result };
    }
    if (execution.data.status === 'failed' && execution.data.outcome === 'rejected') {
      await this.releaseOwnedLock(execution);
      return {
        planId,
        index,
        status: 'failed',
        outcome: 'rejected',
        errorCode: execution.data.errorCode,
      };
    }
    if (execution.data.status === 'failed' && this.definition(steps[index]!.action).readOnly)
      return {
        planId,
        index,
        status: 'failed',
        errorCode: execution.data.errorCode,
        retryable: execution.data.retryable === true,
        ...(execution.data.outcome ? { outcome: execution.data.outcome } : {}),
        ...(execution.data.result ? { result: execution.data.result } : {}),
      };
    if (!['acknowledged', 'uncertain'].includes(String(execution.data.status)))
      return {
        planId,
        index,
        status: 'needs-reconciliation',
        reason:
          execution.data.status === 'in-progress'
            ? 'The attempt may still be running. Operator fencing and an audited recovery are required; elapsed time cannot release its lock.'
            : 'No completed provider attempt is available for readback.',
      };
    const outputs: Record<string, unknown>[] = [];
    for (let prior = 0; prior < index; prior++) {
      const record = await this.store.get(this.actor.actor, `${planId}/step/${prior}`);
      if (record?.data.status !== 'completed') throw createError('IDEMPOTENCY_CONFLICT');
      outputs.push(record.data.result as Record<string, unknown>);
    }
    const step = steps[index]!;
    const definition = this.definition(step.action);
    const input = resolveReferences(step.input, outputs, index) as Record<string, unknown>;
    let authorized: Awaited<ReturnType<ManagementWorkflow['authorize']>>;
    try {
      authorized = await this.authorize(step.action, input);
    } catch (error) {
      if (
        !step.action.endsWith('.delete') ||
        (error as { details?: { outcome?: string } }).details?.outcome !== 'absent' ||
        !execution.data.authorizedTarget
      )
        throw error;
      const parsed = definition.schema.parse(input) as Record<string, unknown>;
      const grant = this.policy.grant(this.actor, String(parsed.connection), step.action);
      const target = execution.data.authorizedTarget as ManagementTarget;
      this.policy.authorizeTarget(grant, target);
      authorized = { input: parsed, approval: grant.requireApproval, target };
    }
    if (!definition.verify)
      return {
        planId,
        index,
        status: 'needs-reconciliation',
        reason: 'This action has no independent recovery verifier.',
      };
    // Deterministic IDs can be recovered from the immutable request. Server-assigned IDs require a persisted receipt.
    const serverAssigned = new Set([
      'app.create',
      'app.duplicate',
      'app.publish',
      'space.create',
      'space.member.create',
      'space.share.create',
      'datafile.upload',
      'reload.create',
      'schedule.create',
      'app.export',
    ]);
    if (!execution.data.result && serverAssigned.has(step.action))
      return {
        planId,
        index,
        status: 'needs-reconciliation',
        reason:
          'The provider-assigned destination ID was not acknowledged; independent operator recovery is required.',
      };
    const receipt =
      (execution.data.result as Record<string, unknown> | undefined) ??
      Object.fromEntries(
        Object.entries(checkpoint(input)).filter(
          ([name]) => name.endsWith('Id') || name === 'kind',
        ),
      );
    const verification = await definition.verify(authorized.input, receipt);
    if (verification.verified !== true)
      return { planId, index, status: 'needs-reconciliation', verification };
    const recovered = verification.result;
    const result = {
      ...receipt,
      ...(recovered && typeof recovered === 'object' && !Array.isArray(recovered)
        ? checkpoint(recovered as Record<string, unknown>)
        : {}),
      verified: true,
    };
    await this.store.put(
      {
        ...execution,
        version: execution.version + 1,
        data: {
          ...execution.data,
          status: 'completed',
          result,
          reconciledAt: new Date(this.now()).toISOString(),
        },
      },
      execution.version,
    );
    await this.releaseOwnedLock(execution);
    return { planId, index, status: 'completed', result };
  }

  async execute(planId: string, rawSteps: WorkflowStep[]): Promise<Record<string, unknown>> {
    let plan = await this.getPlan(planId);
    const steps = workflowStepsSchema.parse(rawSteps);
    if (
      plan.data.planHash !== computePlanHash({ actor: this.actor, steps }) ||
      plan.data.status !== 'approved'
    )
      throw createError('PERMISSION_DENIED');
    if (!plan.data.executionDeadline) {
      if (Date.parse(String(plan.data.expiresAt)) <= this.now())
        return { planId, status: 'expired', stoppedAt: 0, steps: [] };
      const started = {
        ...plan,
        version: plan.version + 1,
        data: {
          ...plan.data,
          executionDeadline: new Date(this.now() + 60 * 60 * 1000).toISOString(),
        },
      };
      await this.store.put(started, plan.version);
      plan = started;
    }
    const outputs: Record<string, unknown>[] = [];
    for (const [index, step] of steps.entries()) {
      const id = `${planId}/step/${index}`;
      const previous = await this.store.get(this.actor.actor, id);
      if (previous) {
        if (previous.data.status === 'completed') {
          await this.releaseOwnedLock(previous);
          outputs.push(previous.data.result as Record<string, unknown>);
          continue;
        }
        if (previous.data.status === 'failed' && previous.data.outcome === 'rejected') {
          await this.releaseOwnedLock(previous);
          return {
            planId,
            status: 'failed',
            outcome: 'rejected',
            stoppedAt: index,
            steps: outputs,
            errorCode: previous.data.errorCode,
          };
        }
        if (
          this.definition(step.action).readOnly &&
          previous.data.status === 'failed' &&
          previous.data.outcome === 'terminal-failure'
        )
          return {
            planId,
            status: 'failed',
            outcome: 'terminal-failure',
            retryable: false,
            stoppedAt: index,
            steps: outputs,
            errorCode: previous.data.errorCode,
            result: previous.data.result,
          };
        if (
          !this.definition(step.action).readOnly ||
          !['waiting', 'failed'].includes(String(previous.data.status))
        )
          return {
            planId,
            status: 'needs-reconciliation',
            stoppedAt: index,
            steps: outputs,
            outcome: previous.data.status,
          };
      }
      if (Date.parse(String(plan.data.executionDeadline)) <= this.now())
        return { planId, status: 'expired', stoppedAt: index, steps: outputs };
      const resolved = resolveReferences(step.input, outputs, index) as Record<string, unknown>;
      const authorized = await this.authorize(step.action, resolved);
      if (authorized.approval && !plan.data.reviewer) throw createError('PERMISSION_DENIED');
      const lock = this.definition(step.action).readOnly
        ? undefined
        : await this.lock(String(resolved.connection), authorized.target, id);
      const claim: ManagementRecord = {
        id,
        owner: this.actor.actor,
        kind: 'execution',
        version: (previous?.version ?? 0) + 1,
        expiresAt: new Date(this.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        data: {
          action: step.action,
          status: 'in-progress',
          attemptId: randomUUID(),
          inputHash: computePlanHash(authorized.input),
          authorizedTarget: authorized.target,
          startedAt: new Date(this.now()).toISOString(),
          ...(lock ? { lockId: lock.id, lockVersion: lock.version } : {}),
        },
      };
      if (lock)
        await this.store.transact([
          { record: lock, expectedVersion: lock.version === 1 ? null : lock.version - 1 },
          { record: claim, expectedVersion: previous?.version ?? null },
        ]);
      else await this.store.put(claim, previous?.version ?? null);
      let savedReceipt: Record<string, unknown> | undefined;
      let progress = claim;
      try {
        const definition = this.definition(step.action);
        const result = await definition.execute(authorized.input, async (receipt) => {
          savedReceipt = { ...savedReceipt, ...checkpoint(receipt) };
          const acknowledgedProgress = {
            ...progress,
            version: progress.version + 1,
            data: { ...progress.data, result: savedReceipt },
          };
          await this.store.put(acknowledgedProgress, progress.version);
          progress = acknowledgedProgress;
        });
        const saved = checkpoint(result);
        savedReceipt = saved;
        const acknowledged = {
          ...progress,
          version: progress.version + 1,
          data: {
            ...progress.data,
            status: result.workflowPending
              ? 'waiting'
              : definition.verify
                ? 'acknowledged'
                : 'completed',
            result: saved,
          },
        };
        await this.store.put(acknowledged, progress.version);
        if (result.workflowPending)
          return { planId, status: 'waiting', stoppedAt: index, steps: outputs, pending: saved };
        if (definition.verify) {
          const verification = await definition.verify(authorized.input, result);
          if (verification.verified !== true)
            return {
              planId,
              status: 'needs-reconciliation',
              stoppedAt: index,
              steps: outputs,
              acknowledged: saved,
            };
          const completed = {
            ...acknowledged,
            version: acknowledged.version + 1,
            data: {
              ...acknowledged.data,
              status: 'completed',
              verified: true,
              completedAt: new Date(this.now()).toISOString(),
            },
          };
          await this.store.put(completed, acknowledged.version);
        }
        if (lock) await this.release(lock);
        outputs.push(saved);
      } catch (error) {
        const safe = toSafeUnexpectedError(error);
        const readOnly = this.definition(step.action).readOnly;
        // Only explicit no-dispatch evidence or a direct provider rejection proves no effect. A failed follow-up
        // download or readback after an acknowledgement must retain its receipt and lock.
        const rejected =
          !readOnly &&
          !savedReceipt &&
          safe.details?.outcome === 'rejected' &&
          (safe.details.dispatch === 'not-started' ||
            (safe.code === 'MALFORMED_REQUEST' &&
              [400, 422].includes(Number(safe.details.providerStatus))));
        const terminalRead = readOnly && safe.details?.outcome === 'terminal-failure';
        // A rejected storage response may follow a committed write. Re-read the current attempt
        // before saving its known receipt, and never downgrade completion or overwrite another attempt.
        try {
          const current = await this.store.get(this.actor.actor, id);
          if (
            current?.kind === 'execution' &&
            current.data.attemptId === claim.data.attemptId &&
            current.data.status !== 'completed' &&
            current.data.status !== 'waiting'
          ) {
            const failed: ManagementRecord = {
              ...current,
              version: current.version + 1,
              data: {
                ...current.data,
                status: readOnly || (rejected && !current.data.result) ? 'failed' : 'uncertain',
                ...(rejected && !current.data.result
                  ? {
                      outcome: 'rejected',
                      ...(safe.details?.dispatch === 'not-started'
                        ? { dispatch: 'not-started' }
                        : { providerStatus: safe.details!.providerStatus }),
                    }
                  : {}),
                ...(readOnly ? { retryable: !terminalRead && safe.retryable } : {}),
                ...(terminalRead
                  ? { outcome: 'terminal-failure', result: checkpoint(safe.details!) }
                  : {}),
                ...(savedReceipt ? { result: savedReceipt } : {}),
                errorCode: safe.code,
              },
            };
            await this.store.put(failed, current.version);
            if (failed.data.outcome === 'rejected') {
              await this.releaseOwnedLock(failed);
              return {
                planId,
                status: 'failed',
                outcome: 'rejected',
                stoppedAt: index,
                errorCode: safe.code,
                steps: outputs,
              };
            }
            if (readOnly)
              return {
                planId,
                status: 'failed',
                stoppedAt: index,
                errorCode: safe.code,
                retryable: failed.data.retryable,
                steps: outputs,
                ...(terminalRead
                  ? { outcome: 'terminal-failure', result: failed.data.result }
                  : {}),
              };
          }
        } catch {
          /* Existing claim remains non-replayable if persistence is unavailable. */
        }
        return {
          planId,
          status: 'needs-reconciliation',
          stoppedAt: index,
          errorCode: safe.code,
          steps: outputs,
        };
      }
    }
    return { planId, status: 'completed', steps: outputs };
  }
}
