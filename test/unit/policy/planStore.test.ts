import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureRepository } from '../../../src/adapters/fixture/fixtureRepository.js';
import { chartIntentSchema } from '../../../src/compiler/chartIntentSchema.js';
import { compileChartIntent } from '../../../src/compiler/compiler.js';
import {
  createDefaultPlanStore,
  FilePlanStore,
  type StoredPlan,
} from '../../../src/policy/planStore.js';

const temporaryDirectories: string[] = [];

function temporaryStateDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'qlik-plan-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

function storedPlan(
  rawIntent: unknown = {
    analysis: { dimensions: ['Region'], measures: ['Revenue'] },
    presentation: { preferredChartType: 'bar', title: 'Sales by region' },
  },
  presentationTarget: number | null = null,
): StoredPlan {
  const repository = new FixtureRepository();
  const target = {
    connection: 'cloud-dev',
    appId: 'app-sales-cloud-dev',
    sheetId: 'sheet-sales-overview-cloud-dev',
  } as const;
  const plan = compileChartIntent({
    catalog: repository.getCatalog(target.connection, target.appId, 'default'),
    target,
    platform: 'cloud',
    intent: chartIntentSchema.parse(rawIntent),
    now: new Date('2026-08-11T12:00:00.000Z'),
  });
  return {
    ownerActor: 'actor-plan-owner',
    plan,
    operationId: 'operation-plan-1',
    correlationId: 'correlation-plan-1',
    presentationTarget,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable plan store', () => {
  it('persists a hash-validated server-only plan across independent instances', () => {
    const directory = temporaryStateDirectory();
    const filePath = path.join(directory, 'plans.json');
    const stored = storedPlan();

    new FilePlanStore(filePath).save(stored);

    expect(new FilePlanStore(filePath).get(stored.ownerActor, stored.plan.planHash)).toEqual(
      stored,
    );
    if (process.platform !== 'win32') {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
    const body = readFileSync(filePath, 'utf8');
    expect(body).not.toContain('previewRows');
    expect(body).not.toContain('accessToken');
  });

  it('retains a gauge target so its canonical plan hash remains verifiable after restart', () => {
    const filePath = path.join(temporaryStateDirectory(), 'plans.json');
    const stored = storedPlan(
      {
        analysis: { dimensions: [], measures: ['Revenue'] },
        presentation: { preferredChartType: 'gauge', title: 'Revenue target', target: 100_000 },
      },
      100_000,
    );

    new FilePlanStore(filePath).save(stored);

    expect(new FilePlanStore(filePath).get(stored.ownerActor, stored.plan.planHash)).toEqual(
      stored,
    );
  });

  it('keeps identical canonical plan hashes isolated by validated owner actor', () => {
    const filePath = path.join(temporaryStateDirectory(), 'plans.json');
    const first = storedPlan();
    const second = {
      ...first,
      ownerActor: 'actor-plan-owner-2',
      operationId: 'operation-plan-2',
      correlationId: 'correlation-plan-2',
    };
    const store = new FilePlanStore(filePath);

    store.save(first);
    store.save(second);

    expect(store.get(first.ownerActor, first.plan.planHash)).toEqual(first);
    expect(store.get(second.ownerActor, second.plan.planHash)).toEqual(second);
    expect(store.get('actor-with-no-plan', first.plan.planHash)).toBeUndefined();
    expect(() => store.get(' actor-plan-owner ', first.plan.planHash)).toThrow(/ownerActor/u);
  });

  it('rejects canonical plan tampering instead of trusting the stored planHash', () => {
    const filePath = path.join(temporaryStateDirectory(), 'plans.json');
    const stored = storedPlan();
    new FilePlanStore(filePath).save(stored);
    const state = JSON.parse(readFileSync(filePath, 'utf8')) as {
      plans: Record<string, { plan: { title: string } }>;
    };
    const [record] = Object.values(state.plans);
    record!.plan.title = 'Tampered title';
    writeFileSync(filePath, JSON.stringify(state), 'utf8');

    expect(() => new FilePlanStore(filePath)).toThrow(/plan hash/i);
  });

  it('rejects native property proposal tampering covered by the record integrity hash', () => {
    const filePath = path.join(temporaryStateDirectory(), 'plans.json');
    const stored = storedPlan();
    new FilePlanStore(filePath).save(stored);
    const state = JSON.parse(readFileSync(filePath, 'utf8')) as {
      plans: Record<string, { plan: { propertyProposal: Record<string, unknown> } }>;
    };
    const [record] = Object.values(state.plans);
    record!.plan.propertyProposal.orientation = 'horizontal';
    writeFileSync(filePath, JSON.stringify(state), 'utf8');

    expect(() => new FilePlanStore(filePath)).toThrow(/integrity hash/i);
  });

  it('refuses to persist secret-like material embedded in a server-only proposal', () => {
    const filePath = path.join(temporaryStateDirectory(), 'plans.json');
    const stored = storedPlan();

    expect(() =>
      new FilePlanStore(filePath).save({
        ...stored,
        plan: {
          ...stored.plan,
          propertyProposal: {
            ...stored.plan.propertyProposal,
            accessToken: 'Bearer must-never-reach-disk',
          },
        },
      }),
    ).toThrow(/secret-like material/i);
    expect(existsSync(filePath)).toBe(false);
  });

  it('rejects impossible plan timestamp ordering before persistence', () => {
    const filePath = path.join(temporaryStateDirectory(), 'plans.json');
    const stored = storedPlan();

    expect(() =>
      new FilePlanStore(filePath).save({
        ...stored,
        plan: {
          ...stored.plan,
          expiresAt: '2026-08-11T11:59:59.000Z',
        },
      }),
    ).toThrow(/expiry precedes/i);
    expect(existsSync(filePath)).toBe(false);
  });

  it('fails closed on corrupt JSON and unexpected raw preview state', () => {
    const filePath = path.join(temporaryStateDirectory(), 'plans.json');
    writeFileSync(filePath, '{not-json', 'utf8');
    expect(() => new FilePlanStore(filePath)).toThrow(/corrupt durable state/i);

    const stored = storedPlan();
    const secondPath = path.join(temporaryStateDirectory(), 'plans.json');
    new FilePlanStore(secondPath).save(stored);
    const state = JSON.parse(readFileSync(secondPath, 'utf8')) as {
      plans: Record<string, Record<string, unknown>>;
    };
    const [record] = Object.values(state.plans);
    record!.preview = { rows: [['raw-value']] };
    writeFileSync(secondPath, JSON.stringify(state), 'utf8');
    expect(() => new FilePlanStore(secondPath)).toThrow(/unexpected field/i);
  });

  it('selects plans.json from the shared state directory and honors the explicit override', () => {
    const stateDirectory = temporaryStateDirectory();
    const overrideDirectory = temporaryStateDirectory();
    const overridePath = path.join(overrideDirectory, 'custom-plans.json');
    vi.stubEnv('QLIK_HARNESS_STATE_DIR', stateDirectory);
    vi.stubEnv('QLIK_HARNESS_PLAN_STORE_PATH', '');

    const shared = createDefaultPlanStore();
    expect(shared).toBeInstanceOf(FilePlanStore);
    shared.save(storedPlan());
    expect(existsSync(path.join(stateDirectory, 'plans.json'))).toBe(true);

    vi.stubEnv('QLIK_HARNESS_PLAN_STORE_PATH', overridePath);
    createDefaultPlanStore().save(storedPlan());
    expect(existsSync(overridePath)).toBe(true);
  });
});
