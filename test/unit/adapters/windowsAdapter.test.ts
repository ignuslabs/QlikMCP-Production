import { describe, expect, it } from 'vitest';
import { mapWindowsError, WindowsAdapter } from '../../../src/adapters/windows/windowsAdapter.js';
import type {
  WindowsAdapterDependencies,
  WindowsEngineSession,
} from '../../../src/adapters/windows/windowsAdapter.js';
import { MUTATOR_ACTOR } from '../../helpers/testContext.js';

const target = {
  connection: 'windows-dev',
  appId: 'app-sales-windows-dev',
  sheetId: 'sheet-sales-overview-windows-dev',
};

const approvedReadiness = {
  approved: true,
  expiresAt: '2030-01-02T00:00:00.000Z',
  canRead: true,
  canPreview: true,
  canWriteDesignatedSheet: true,
  cleanupVerified: true,
};

function sessionFrom(partial: object): WindowsEngineSession {
  return partial as WindowsEngineSession;
}

function dependenciesFor(
  session: WindowsEngineSession,
  onOpen: () => void = () => undefined,
): WindowsAdapterDependencies {
  return {
    secrets: {
      get: async () => ({ authMode: 'proxy-session', accessToken: 'header.payload.signature' }),
    },
    sessions: {
      open: async () => {
        onOpen();
        return session;
      },
    },
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  };
}

function configuredAdapter(session: WindowsEngineSession, onOpen?: () => void): WindowsAdapter {
  return new WindowsAdapter(
    {
      connection: target.connection,
      serverAlias: 'windows.example.test',
      virtualProxyAlias: 'jwt',
      authMode: 'proxy-session',
      discoveryAppId: target.appId,
      writeTarget: target,
      readiness: approvedReadiness,
    },
    dependenciesFor(session, onOpen),
  );
}

describe('WindowsAdapter (never live in this repository)', () => {
  it('reports an unconfigured, non-writable capability probe', async () => {
    const adapter = new WindowsAdapter();
    const capabilities = await adapter.getEnvironmentCapabilities('windows-dev');
    expect(capabilities).toMatchObject({
      platform: 'windows',
      configured: false,
      canRead: false,
      canPreview: false,
      canWriteDesignatedSheet: false,
    });
  });

  it('throws NOT_CONFIGURED for every read/write method without opening an Engine JSON API connection', async () => {
    const adapter = new WindowsAdapter({
      serverAlias: 'example-server',
      virtualProxyAlias: 'example-proxy',
    });
    await expect(adapter.listAccessibleApps('windows-dev', MUTATOR_ACTOR)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await expect(
      adapter.getCompilationContext('windows-dev', 'app-1', MUTATOR_ACTOR),
    ).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await expect(
      adapter.getSemanticCatalog('windows-dev', 'app-1', MUTATOR_ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(
      adapter.listSheetObjects('windows-dev', 'app-1', 'sheet-1', MUTATOR_ACTOR),
    ).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await expect(
      adapter.persistChart({
        target,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plan: {} as any,
        actor: MUTATOR_ACTOR,
        idempotencyKey: 'key',
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(
      adapter.attachChartToSheet({ target, objectId: 'object-1' }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(adapter.verifyChart({ target, objectId: 'object-1' })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await expect(adapter.cleanupObject({ target, objectId: 'object-1' })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(() => adapter.renderDescriptor(target, 'object-1', 'operation-1', 'preview')).toThrow();
  });

  it('never accepts certificate/private-key material as configuration', () => {
    const adapter = new WindowsAdapter({ serverAlias: 'example-server' });
    // The config type itself has no certificate/private-key/X-Qlik-User fields; this is a structural guarantee.
    expect(Object.keys(adapter)).not.toContain('privateKey');
  });

  it('retains the creating Engine session until same-connection preview disposal', async () => {
    const disposed: string[] = [];
    let closes = 0;
    let opens = 0;
    const session = sessionFrom({
      createSessionChart: async () => ({
        sessionObjectId: 'session-object-1',
        layout: {
          objectId: 'session-object-1',
          objectType: 'barchart',
          title: 'Revenue by region',
          qInfo: { type: 'barchart', id: 'session-object-1' },
          qHyperCube: {
            qSize: { qcx: 2, qcy: 1 },
            qMode: 'S',
            qDimensionInfo: [{ qFallbackTitle: 'Region' }],
            qMeasureInfo: [{ qFallbackTitle: 'Revenue' }],
            qDataPages: [{ qMatrix: [[{ qText: 'North' }, { qText: '10', qNum: 10 }]] }],
          },
          bounded: { returnedRows: 1, maxRows: 1, truncated: false, rawDataIncluded: false },
        },
      }),
      disposeSessionChart: async (objectId: string) => {
        disposed.push(objectId);
      },
      close: async () => {
        closes += 1;
      },
    });
    const adapter = configuredAdapter(session, () => {
      opens += 1;
    });

    const preview = await adapter.createSessionChart({
      target,
      plan: {} as never,
      actor: MUTATOR_ACTOR,
      signal: new AbortController().signal,
    });

    expect(opens).toBe(1);
    expect(closes).toBe(0);
    await expect(
      adapter.disposeSessionChart('another-connection', preview.sessionObjectId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(disposed).toEqual([]);
    expect(closes).toBe(0);

    await adapter.disposeSessionChart(target.connection, preview.sessionObjectId);

    expect(disposed).toEqual([preview.sessionObjectId]);
    expect(closes).toBe(1);
    expect(opens).toBe(1);
  });

  it('closes a second Engine session that returns a duplicate preview id without displacing the owner', async () => {
    const closes = [0, 0];
    const disposed = [0, 0];
    const sessions = [0, 1].map((index) =>
      sessionFrom({
        createSessionChart: async () => ({
          sessionObjectId: 'duplicate-id',
          layout: {} as never,
        }),
        disposeSessionChart: async () => {
          disposed[index] = (disposed[index] ?? 0) + 1;
        },
        close: async () => {
          closes[index] = (closes[index] ?? 0) + 1;
        },
      }),
    );
    let openIndex = 0;
    const dependencies: WindowsAdapterDependencies = {
      secrets: {
        get: async () => ({ authMode: 'proxy-session', accessToken: 'header.payload.signature' }),
      },
      sessions: { open: async () => sessions[openIndex++]! },
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    };
    const adapter = new WindowsAdapter(
      {
        connection: target.connection,
        serverAlias: 'windows.example.test',
        virtualProxyAlias: 'jwt',
        authMode: 'proxy-session',
        writeTarget: target,
        readiness: approvedReadiness,
      },
      dependencies,
    );
    const request = {
      target,
      plan: {} as never,
      actor: MUTATOR_ACTOR,
      signal: new AbortController().signal,
    };

    await expect(adapter.createSessionChart(request)).resolves.toHaveProperty(
      'sessionObjectId',
      'duplicate-id',
    );
    await expect(adapter.createSessionChart(request)).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });

    expect(closes).toEqual([0, 1]);
    await adapter.disposeSessionChart(target.connection, 'duplicate-id');
    expect(disposed).toEqual([1, 0]);
    expect(closes).toEqual([1, 1]);
  });

  it('maps SDK authorization failures to a sanitized typed error and still closes the session', async () => {
    let closes = 0;
    const session = sessionFrom({
      listAccessibleApps: async () => {
        throw {
          code: 4203,
          reason: 'secret transport detail for windows.example.test',
        };
      },
      close: async () => {
        closes += 1;
      },
    });
    const adapter = configuredAdapter(session);

    const failure = adapter.listAccessibleApps(target.connection, MUTATOR_ACTOR);

    await expect(failure).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'The Windows target operation failed; sensitive transport details were removed.',
    });
    await expect(failure).rejects.not.toThrow('windows.example.test');
    expect(closes).toBe(1);
  });

  it.each([
    [2, 'NOT_FOUND'],
    [5, 'PERMISSION_DENIED'],
    [8, 'MALFORMED_REQUEST'],
    [19, 'CAPACITY_EXHAUSTED'],
    [429, 'RATE_LIMITED'],
    [22001, 'OPERATION_CANCELLED'],
    [22014, 'TRANSIENT_UNAVAILABLE'],
  ])('maps official QIX error code %i to %s without copying provider details', (code, expected) => {
    let failure: unknown;
    try {
      mapWindowsError({ code, message: 'provider secret and host detail' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: expected,
      message: 'The Windows target operation failed; sensitive transport details were removed.',
    });
    expect((failure as Error).message).not.toContain('provider secret');
  });

  it('enforces readiness capability flags and the designated write target before opening QIX', async () => {
    let opens = 0;
    const session = sessionFrom({ close: async () => undefined });
    const noPreview = new WindowsAdapter(
      {
        connection: target.connection,
        serverAlias: 'windows.example.test',
        virtualProxyAlias: 'jwt',
        authMode: 'proxy-session',
        writeTarget: target,
        readiness: { ...approvedReadiness, canPreview: false },
      },
      dependenciesFor(session, () => {
        opens += 1;
      }),
    );

    await expect(
      noPreview.createSessionChart({
        target,
        plan: {} as never,
        actor: MUTATOR_ACTOR,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const adapter = configuredAdapter(session, () => {
      opens += 1;
    });
    await expect(
      adapter.persistChart({
        target: { ...target, sheetId: 'sheet-not-approved' },
        plan: {} as never,
        actor: MUTATOR_ACTOR,
        idempotencyKey: 'key',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(opens).toBe(0);
  });

  it('requires an exact configured connection before readiness can authorize access', async () => {
    let opens = 0;
    const adapter = new WindowsAdapter(
      {
        serverAlias: 'windows.example.test',
        virtualProxyAlias: 'jwt',
        authMode: 'proxy-session',
        readiness: approvedReadiness,
      },
      dependenciesFor(sessionFrom({ close: async () => undefined }), () => {
        opens += 1;
      }),
    );

    await expect(
      adapter.listAccessibleApps(target.connection, MUTATOR_ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(adapter.getEnvironmentCapabilities(target.connection)).resolves.toMatchObject({
      configured: false,
      canRead: false,
    });
    expect(opens).toBe(0);
  });

  it('allows cleanup of the designated target after readiness expires', async () => {
    let cleanupCalls = 0;
    let opens = 0;
    const session = sessionFrom({
      cleanupObject: async () => {
        cleanupCalls += 1;
        return { attempted: true, outcome: 'cleanup-complete' as const };
      },
      close: async () => undefined,
    });
    const adapter = new WindowsAdapter(
      {
        connection: target.connection,
        serverAlias: 'windows.example.test',
        virtualProxyAlias: 'jwt',
        authMode: 'proxy-session',
        writeTarget: target,
        readiness: { ...approvedReadiness, expiresAt: '2029-12-31T23:59:59.000Z' },
      },
      dependenciesFor(session, () => {
        opens += 1;
      }),
    );

    await expect(
      adapter.cleanupObject({ target, objectId: 'partially-created-object' }),
    ).resolves.toEqual({ attempted: true, outcome: 'cleanup-complete' });
    await expect(
      adapter.listAccessibleApps(target.connection, MUTATOR_ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(cleanupCalls).toBe(1);
    expect(opens).toBe(1);
  });
});
