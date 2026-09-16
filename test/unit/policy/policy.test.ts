import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../../src/policy/policy.js';
import {
  buildTestPolicyConfig,
  MUTATOR_ACTOR,
  READ_ONLY_ACTOR,
  REVIEWER_ACTOR,
} from '../../helpers/testContext.js';

describe('PolicyEngine', () => {
  it('allows a configured non-production connection', () => {
    const policy = new PolicyEngine(buildTestPolicyConfig());
    expect(policy.assertConnectionAllowed('cloud-dev')).toMatchObject({
      platform: 'cloud',
      environment: 'development',
    });
  });

  it('rejects an unknown connection alias as not-found', () => {
    const policy = new PolicyEngine(buildTestPolicyConfig());
    expect.assertions(1);
    try {
      policy.assertConnectionAllowed('unknown-alias');
    } catch (error) {
      expect((error as { code: string }).code).toBe('NOT_FOUND');
    }
  });

  it('rejects a connection whose environment is production', () => {
    const policy = new PolicyEngine({
      allowedEnvironments: ['development', 'nonproduction'],
      connections: {
        'prod-alias': {
          alias: 'prod-alias',
          platform: 'cloud',
          environment: 'production',
          allowedApps: {},
          allowedChartTypes: [],
        },
      },
      mutationActors: new Set(),
      reviewerActors: new Set(),
    });
    expect.assertions(1);
    try {
      policy.assertConnectionAllowed('prod-alias');
    } catch (error) {
      expect((error as { code: string }).code).toBe('PERMISSION_DENIED');
    }
  });

  it('defaults to deny mutation for an actor not on the allowlist', () => {
    const policy = new PolicyEngine(buildTestPolicyConfig(new Set([MUTATOR_ACTOR.actor])));
    expect(() => policy.assertMutationActorAllowed(READ_ONLY_ACTOR.actor)).toThrow();
    expect(() => policy.assertMutationActorAllowed(MUTATOR_ACTOR.actor)).not.toThrow();
  });

  it('denies mutation entirely when no actor is configured (default-deny)', () => {
    const policy = new PolicyEngine(buildTestPolicyConfig(new Set()));
    expect.assertions(1);
    try {
      policy.assertMutationActorAllowed(MUTATOR_ACTOR.actor);
    } catch (error) {
      expect((error as { code: string }).code).toBe('PERMISSION_DENIED');
    }
  });

  it('requires an allowlisted reviewer who is distinct from the requester', () => {
    const policy = new PolicyEngine(buildTestPolicyConfig());
    expect(() => policy.assertReviewerActorAllowed(REVIEWER_ACTOR.actor)).not.toThrow();
    expect(() => policy.assertReviewerActorAllowed(MUTATOR_ACTOR.actor)).toThrow();
    expect(() =>
      policy.assertReviewerSeparated(MUTATOR_ACTOR.actor, MUTATOR_ACTOR.actor),
    ).toThrow();
    expect(() =>
      policy.assertReviewerSeparated(MUTATOR_ACTOR.actor, REVIEWER_ACTOR.actor),
    ).not.toThrow();
  });

  it('rejects a write to a non-writable sheet', () => {
    const policy = new PolicyEngine(buildTestPolicyConfig());
    expect.assertions(1);
    try {
      policy.assertSheetWritable(false, 'sheet-sales-readonly-cloud-dev');
    } catch (error) {
      expect((error as { code: string }).code).toBe('PERMISSION_DENIED');
    }
  });

  it('rejects apps, sheets, and chart types outside the mutation allowlist', () => {
    const policy = new PolicyEngine(buildTestPolicyConfig());
    expect(() =>
      policy.assertMutationTargetAllowed('cloud-dev', 'other-app', 'sheet', 'bar'),
    ).toThrow();
    expect(() =>
      policy.assertMutationTargetAllowed('cloud-dev', 'app-sales-cloud-dev', 'other-sheet', 'bar'),
    ).toThrow();
    const entry = buildTestPolicyConfig().connections['cloud-dev']!;
    const restricted = new PolicyEngine({
      ...buildTestPolicyConfig(),
      connections: { 'cloud-dev': { ...entry, allowedChartTypes: ['line'] } },
    });
    expect(() =>
      restricted.assertMutationTargetAllowed(
        'cloud-dev',
        'app-sales-cloud-dev',
        'sheet-sales-overview-cloud-dev',
        'bar',
      ),
    ).toThrow();
  });

  it('lists the configured non-production connections', () => {
    const policy = new PolicyEngine(buildTestPolicyConfig());
    const connections = policy.listConnections();
    expect(connections.map((entry) => entry.alias).sort()).toEqual(['cloud-dev', 'windows-dev']);
  });
});
