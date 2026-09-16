import { describe, expect, it, vi } from 'vitest';

// The deployment helper is executable JavaScript and intentionally outside src/.
// @ts-expect-error No declaration file is shipped for this command-line helper.
const { requireMmdsV2 } = (await import('../../../scripts/agentcore/require-mmdsv2.mjs')) as {
  requireMmdsV2: (
    client: { send(command: unknown): Promise<unknown> },
    runtimeId: string,
    options?: { checkOnly?: boolean; pollIntervalMs?: number; timeoutMs?: number },
  ) => Promise<{ changed: boolean; runtimeId: string; status?: string }>;
};

describe('post-deploy MMDSv2 enforcement', () => {
  it('preserves runtime settings while enabling and verifying MMDSv2', async () => {
    const before = {
      agentRuntimeArtifact: { containerConfiguration: { containerUri: 'example.invalid/image' } },
      roleArn: 'arn:aws:iam::123456789012:role/runtime',
      status: 'READY',
      metadataConfiguration: { requireMMDSV2: false },
      protocolConfiguration: { serverProtocol: 'MCP' },
      environmentVariables: { QLIK_AGENTCORE_STATE_TABLE: 'state-table' },
    };
    const after = {
      ...before,
      metadataConfiguration: { requireMMDSV2: true },
      status: 'READY',
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({ status: 'UPDATING' })
      .mockResolvedValueOnce(after);
    await expect(
      requireMmdsV2({ send }, 'runtime-123', { pollIntervalMs: 0, timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ changed: true, runtimeId: 'runtime-123', status: 'READY' });
    const update = send.mock.calls[1]?.[0] as { input: Record<string, unknown> };
    expect(update.input).toMatchObject({
      agentRuntimeId: 'runtime-123',
      roleArn: before.roleArn,
      agentRuntimeArtifact: before.agentRuntimeArtifact,
      protocolConfiguration: before.protocolConfiguration,
      environmentVariables: before.environmentVariables,
      metadataConfiguration: { requireMMDSV2: true },
    });
  });

  it('fails a read-only check when the deployed runtime is not compliant', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 'READY',
      metadataConfiguration: { requireMMDSV2: false },
    });
    await expect(requireMmdsV2({ send }, 'runtime-123', { checkOnly: true })).rejects.toThrow(
      'does not require MMDSv2',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails a read-only check when MMDSv2 is configured but the runtime is not ready', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 'UPDATING',
      metadataConfiguration: { requireMMDSV2: true },
    });
    await expect(requireMmdsV2({ send }, 'runtime-123', { checkOnly: true })).rejects.toThrow(
      'requires MMDSv2 but is not READY',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed runtime even when its stored MMDSv2 flag is true', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 'UPDATE_FAILED',
      failureReason: 'image rejected',
      metadataConfiguration: { requireMMDSV2: true },
    });
    await expect(requireMmdsV2({ send }, 'runtime-123', { checkOnly: true })).rejects.toThrow(
      'UPDATE_FAILED: image rejected',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('waits for an already-compliant transitional runtime without issuing an update', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'UPDATING',
        metadataConfiguration: { requireMMDSV2: true },
      })
      .mockResolvedValueOnce({
        status: 'READY',
        metadataConfiguration: { requireMMDSV2: true },
      });
    await expect(
      requireMmdsV2({ send }, 'runtime-123', { pollIntervalMs: 0, timeoutMs: 1_000 }),
    ).resolves.toEqual({ changed: false, runtimeId: 'runtime-123', status: 'READY' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(([command]) => command.constructor.name === 'GetAgentRuntimeCommand'),
    ).toBe(true);
  });
});
