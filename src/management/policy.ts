import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createError } from '../domain/errors.js';

const exactId = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => value !== '*', 'Wildcard grants are not supported.');
const grantSchema = z
  .object({
    actor: exactId,
    clientId: exactId,
    connection: exactId,
    actions: z.array(exactId).min(1).max(100),
    appIds: z.array(exactId).max(1000).default([]),
    spaceIds: z.array(exactId).max(1000).default([]),
    allowPersonalSpace: z.boolean().default(false),
    requireApproval: z.boolean().default(true),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const managementPolicySchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    environment: z.enum(['development', 'test', 'production']),
    allowProduction: z.boolean().default(false),
    grants: z.array(grantSchema).max(100),
    reviewers: z.array(z.object({ actor: exactId, clientId: exactId }).strict()).max(100),
    maxUploadBytes: z
      .number()
      .int()
      .min(1)
      .max(50 * 1024 * 1024)
      .default(50 * 1024 * 1024),
    maxArtifactBytes: z
      .number()
      .int()
      .min(1)
      .max(200 * 1024 * 1024)
      .default(200 * 1024 * 1024),
  })
  .strict();
export type ManagementPolicy = z.infer<typeof managementPolicySchema>;
export type ManagementGrant = z.infer<typeof grantSchema>;
export interface ManagementActor {
  readonly actor: string;
  readonly hostClientId: string;
}
export interface ManagementTarget {
  readonly appId?: string;
  readonly spaceId?: string;
  readonly targetSpaceId?: string;
  readonly personalSpace?: boolean;
  readonly targetPersonalSpace?: boolean;
}

export function loadManagementPolicy(
  environment: Readonly<Record<string, string | undefined>>,
): ManagementPolicy {
  const path = environment.QLIK_MANAGEMENT_POLICY_PATH?.trim();
  const inline = environment.QLIK_MANAGEMENT_POLICY_JSON?.trim();
  if (path && inline) throw new Error('Configure exactly one management policy source.');
  if (inline) return managementPolicySchema.parse(JSON.parse(inline));
  if (!path)
    return managementPolicySchema.parse({
      version: 1,
      enabled: false,
      environment: 'development',
      grants: [],
      reviewers: [],
    });
  return managementPolicySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export class ManagementPolicyEngine {
  constructor(
    readonly policy: ManagementPolicy,
    private readonly now: () => number = Date.now,
  ) {}
  grant(actor: ManagementActor, connection: string, action: string): ManagementGrant {
    if (
      !this.policy.enabled ||
      (this.policy.environment === 'production' && !this.policy.allowProduction)
    )
      throw createError('PERMISSION_DENIED');
    const grants = this.policy.grants.filter(
      (grant) =>
        grant.actor === actor.actor &&
        grant.clientId === actor.hostClientId &&
        grant.connection === connection &&
        grant.actions.includes(action) &&
        Date.parse(grant.expiresAt) > this.now(),
    );
    // Avoid combining unrelated grants into a broader permission than an administrator specified.
    if (grants.length !== 1)
      throw createError('PERMISSION_DENIED', {
        message: 'Exactly one current management grant must authorize this action.',
      });
    return grants[0]!;
  }
  authorizeTarget(grant: ManagementGrant, target: ManagementTarget): void {
    const sourceAllowed =
      (target.appId && grant.appIds.includes(target.appId)) ||
      (target.spaceId && grant.spaceIds.includes(target.spaceId)) ||
      (target.personalSpace && grant.allowPersonalSpace);
    if ((target.appId || target.spaceId || target.personalSpace) && !sourceAllowed)
      throw createError('PERMISSION_DENIED');
    if (target.targetSpaceId && !grant.spaceIds.includes(target.targetSpaceId))
      throw createError('PERMISSION_DENIED');
    if (target.targetPersonalSpace && !grant.allowPersonalSpace)
      throw createError('PERMISSION_DENIED');
  }
  reviewer(actor: ManagementActor, owner: string): void {
    if (
      !this.policy.enabled ||
      actor.actor === owner ||
      !this.policy.reviewers.some(
        (reviewer) => reviewer.actor === actor.actor && reviewer.clientId === actor.hostClientId,
      )
    )
      throw createError('PERMISSION_DENIED');
  }
}
