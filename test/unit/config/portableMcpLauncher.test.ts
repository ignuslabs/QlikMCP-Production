import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const launcher = path.join(repoRoot, 'scripts', 'mcp', 'start.mjs');
const doctor = path.join(repoRoot, 'scripts', 'mcp', 'doctor.mjs');
const launcherLibrarySource = readFileSync(
  path.join(repoRoot, 'scripts', 'mcp', 'launcher-lib.mjs'),
  'utf8',
);
const doctorSource = readFileSync(doctor, 'utf8');
const secretValue = 'test-secret-that-must-not-be-logged';

interface Fixture {
  entrypoint: string;
  root: string;
  stateDirectory: string;
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'Qlik MCP path with spaces '));
  const entrypoint = path.join(root, 'fixture entrypoint.mjs');
  const stateDirectory = path.join(root, 'shared state with spaces');
  writeFileSync(
    entrypoint,
    `import process from 'node:process';
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  role: process.env.QLIK_HARNESS_MCP_ROLE,
  actor: process.env.QLIK_HARNESS_ACTOR,
  stateDirectory: process.env.QLIK_HARNESS_STATE_DIR,
  cloudSecretPresent: Boolean(process.env.QLIK_CLOUD_OAUTH_CLIENT_SECRET),
  windowsSecretPresent: Boolean(process.env.QLIK_WINDOWS_PROXY_SESSION_JWT),
}) + '\\n');
`,
    { mode: 0o600 },
  );
  return { entrypoint, root, stateDirectory };
}

function baseEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('QLIK_')) delete environment[name];
  }
  return {
    ...environment,
    QLIK_HARNESS_TARGET_MODE: 'fixture',
  };
}

describe('portable MCP launcher and doctor', () => {
  const fixtures: Fixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  function trackedFixture(): Fixture {
    const fixture = createFixture();
    fixtures.push(fixture);
    return fixture;
  }

  it('accepts only the supported patched Node 22 runtime line', () => {
    const program = `
      import { isSupportedNodeVersion, parseNodeVersion } from './scripts/mcp/launcher-lib.mjs';
      const versions = ['20.19.0', '22.12.0', '22.23.1', '22.23.2', '22.24.0', '23.0.0', '24.0.0', '22.24.0-rc.1'];
      process.stdout.write(JSON.stringify(versions.map((version) => isSupportedNodeVersion(parseNodeVersion(version)))));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: baseEnvironment(),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('isolates default workflow state from the original project and rejects parent-directory profiles', () => {
    const program = `
      import os from 'node:os';
      import path from 'node:path';
      import { resolveStateDirectory } from './scripts/mcp/launcher-lib.mjs';
      const environment = { LOCALAPPDATA: os.tmpdir(), XDG_STATE_HOME: os.tmpdir() };
      const defaultDirectory = resolveStateDirectory(environment);
      const invalidProfiles = ['.', '..'].map((profile) => {
        try { resolveStateDirectory({ ...environment, QLIK_HARNESS_STATE_PROFILE: profile }); return false; }
        catch { return true; }
      });
      process.stdout.write(JSON.stringify({
        product: path.basename(path.dirname(defaultDirectory)),
        profile: path.basename(defaultDirectory),
        invalidProfiles,
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: baseEnvironment(),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      product: 'QlikMCP-Production',
      profile: 'codex-mcp-state',
      invalidProfiles: [true, true],
    });
  });

  it('launches from the repository root with paths containing spaces', () => {
    const fixture = trackedFixture();
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        '--role',
        'requester',
        '--secret-provider',
        'none',
        '--state-dir',
        fixture.stateDirectory,
        '--entrypoint',
        fixture.entrypoint,
      ],
      { cwd: tmpdir(), encoding: 'utf8', env: baseEnvironment() },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      actor: 'local-dev-actor',
      cloudSecretPresent: false,
      cwd: repoRoot,
      role: 'requester',
      stateDirectory: fixture.stateDirectory,
      windowsSecretPresent: false,
    });
    expect(result.stderr).not.toContain(secretValue);
    expect(readFileSync(fixture.entrypoint, 'utf8')).not.toContain(secretValue);
  });

  it.each(['reviewer', 'verifier'] as const)(
    'clears every provider credential for the %s role',
    (role) => {
      const fixture = trackedFixture();
      const result = spawnSync(
        process.execPath,
        [
          launcher,
          '--role',
          role,
          '--state-dir',
          fixture.stateDirectory,
          '--entrypoint',
          fixture.entrypoint,
        ],
        {
          encoding: 'utf8',
          env: {
            ...baseEnvironment(),
            QLIK_CLOUD_OAUTH_CLIENT_SECRET: secretValue,
            QLIK_WINDOWS_PROXY_SESSION_JWT: secretValue,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        actor: role === 'reviewer' ? 'local-dev-reviewer' : 'local-dev-actor',
        cloudSecretPresent: false,
        role,
        windowsSecretPresent: false,
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(secretValue);
    },
  );

  it('accepts a pre-injected requester secret without printing it', () => {
    const fixture = trackedFixture();
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        '--role',
        'requester',
        '--state-dir',
        fixture.stateDirectory,
        '--entrypoint',
        fixture.entrypoint,
      ],
      {
        encoding: 'utf8',
        env: {
          ...baseEnvironment(),
          QLIK_CLOUD_OAUTH_CLIENT_SECRET: secretValue,
          QLIK_CODEX_SECRET_PROVIDER: 'environment',
          QLIK_HARNESS_TARGET_MODE: 'cloud',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ cloudSecretPresent: true });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretValue);
  });

  it('emits a sanitized machine-readable doctor report', () => {
    const fixture = trackedFixture();
    mkdirSync(fixture.stateDirectory);
    const result = spawnSync(
      process.execPath,
      [
        doctor,
        '--json',
        '--role',
        'reviewer',
        '--state-dir',
        fixture.stateDirectory,
        '--entrypoint',
        fixture.entrypoint,
      ],
      {
        encoding: 'utf8',
        env: {
          ...baseEnvironment(),
          QLIK_CLOUD_OAUTH_CLIENT_SECRET: secretValue,
          QLIK_HARNESS_MUTATION_ACTORS: 'requester-a',
          QLIK_HARNESS_REVIEWER_ACTORS: 'local-dev-reviewer',
        },
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      checks: { detail: string; name: string; status: string }[];
      role: string;
      summary: { fail: number };
    };
    expect(report.role).toBe('reviewer');
    expect(report.summary.fail).toBe(0);
    expect(report.checks).toContainEqual({
      detail: 'reviewer credentials are explicitly cleared',
      name: 'credential isolation',
      status: 'pass',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretValue);
  });

  it('renders a secret-free VS Code Agent Host config with absolute paths', () => {
    const fixture = trackedFixture();
    const result = spawnSync(
      process.execPath,
      [doctor, '--print-vscode-config', '--state-dir', fixture.stateDirectory],
      {
        encoding: 'utf8',
        env: {
          ...baseEnvironment(),
          QLIK_CLOUD_OAUTH_CLIENT_SECRET: secretValue,
          QLIK_CODEX_KEYCHAIN_ACCOUNT: 'configured-keychain-account',
          QLIK_CODEX_KEYCHAIN_SERVICE: 'configured-keychain-service',
          QLIK_CODEX_REQUESTER_ACTOR: 'configured-requester',
          QLIK_CODEX_REQUESTER_HOST_CLIENT_ID: 'configured-requester-host',
          QLIK_CODEX_REVIEWER_ACTOR: 'configured-reviewer',
          QLIK_CODEX_REVIEWER_HOST_CLIENT_ID: 'configured-reviewer-host',
          QLIK_CODEX_SECRET_NAME: 'configured-secret-name',
          QLIK_CODEX_SECRET_VAULT: 'configured-secret-vault',
          QLIK_CODEX_VERIFIER_HOST_CLIENT_ID: 'configured-verifier-host',
        },
      },
    );

    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout) as {
      servers: Record<
        string,
        { args: string[]; command: string; cwd: string; env: Record<string, string>; type: string }
      >;
    };
    expect(Object.keys(config.servers)).toEqual([
      'qlik-requester',
      'qlik-reviewer',
      'qlik-verifier',
    ]);
    for (const [name, server] of Object.entries(config.servers)) {
      expect(server.type).toBe('stdio');
      expect(path.isAbsolute(server.command)).toBe(true);
      expect(path.isAbsolute(server.args[0] ?? '')).toBe(true);
      expect(server.args).toEqual([
        launcher,
        '--role',
        name.replace('qlik-', ''),
        '--state-dir',
        fixture.stateDirectory,
      ]);
      expect(server.cwd).toBe(repoRoot);
    }
    expect(config.servers['qlik-requester']?.env).toMatchObject({
      QLIK_CODEX_MCP_ACTOR: 'configured-requester',
      QLIK_CODEX_MCP_HOST_CLIENT_ID: 'configured-requester-host',
      QLIK_CODEX_SECRET_PROVIDER: 'auto',
    });
    expect(config.servers['qlik-reviewer']?.env).toEqual({
      QLIK_CODEX_MCP_ACTOR: 'configured-reviewer',
      QLIK_CODEX_MCP_HOST_CLIENT_ID: 'configured-reviewer-host',
    });
    expect(config.servers['qlik-verifier']?.env).toEqual({
      QLIK_CODEX_MCP_ACTOR: 'configured-requester',
      QLIK_CODEX_MCP_HOST_CLIENT_ID: 'configured-verifier-host',
    });
    const requesterEnvironment = config.servers['qlik-requester']?.env ?? {};
    if (process.platform === 'darwin') {
      expect(requesterEnvironment).toMatchObject({
        QLIK_CODEX_KEYCHAIN_ACCOUNT: 'configured-keychain-account',
        QLIK_CODEX_KEYCHAIN_SERVICE: 'configured-keychain-service',
      });
      expect(requesterEnvironment).not.toHaveProperty('QLIK_CODEX_SECRET_NAME');
    } else if (process.platform === 'win32') {
      expect(requesterEnvironment).toMatchObject({
        QLIK_CODEX_SECRET_NAME: 'configured-secret-name',
        QLIK_CODEX_SECRET_VAULT: 'configured-secret-vault',
      });
      expect(requesterEnvironment).not.toHaveProperty('QLIK_CODEX_KEYCHAIN_ACCOUNT');
    }
    expect(config.servers['qlik-reviewer']?.env).not.toHaveProperty('QLIK_CODEX_SECRET_PROVIDER');
    expect(config.servers['qlik-verifier']?.env).not.toHaveProperty('QLIK_CODEX_SECRET_PROVIDER');
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretValue);
  });

  it('fails closed for a Cloud requester without a secret provider', () => {
    const fixture = trackedFixture();
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        '--role',
        'requester',
        '--secret-provider',
        'none',
        '--state-dir',
        fixture.stateDirectory,
        '--entrypoint',
        fixture.entrypoint,
      ],
      {
        encoding: 'utf8',
        env: { ...baseEnvironment(), QLIK_HARNESS_TARGET_MODE: 'cloud' },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('requires an approved OAuth secret provider');
  });

  it('repairs and verifies the complete Windows state ACL', () => {
    expect(launcherLibrarySource).toContain("[directoryPath, '/reset', '/T', '/L', '/Q']");
    expect(launcherLibrarySource).toContain("[directoryPath, '/verify', '/T', '/L', '/Q']");
    expect(launcherLibrarySource).toContain('`${account}:(OI)(CI)F`');
    expect(launcherLibrarySource).toContain("'/inheritance:r'");
    expect(launcherLibrarySource).not.toContain("'/C'");
  });

  it('passes the scrubbed environment to macOS Keychain inspection', () => {
    expect(launcherLibrarySource).toMatch(/find-generic-password[\s\S]{0,350}env: environment/u);
    expect(doctorSource).toMatch(/find-generic-password[\s\S]{0,350}env: environment/u);
  });

  it('does not promote an inherited Cloud secret when provider selection is automatic', () => {
    const fixture = trackedFixture();
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        '--role',
        'requester',
        '--state-dir',
        fixture.stateDirectory,
        '--entrypoint',
        fixture.entrypoint,
      ],
      {
        encoding: 'utf8',
        env: {
          ...baseEnvironment(),
          QLIK_CLOUD_OAUTH_CLIENT_SECRET: secretValue,
          QLIK_CODEX_KEYCHAIN_ACCOUNT: `missing-${process.pid}`,
          QLIK_CODEX_KEYCHAIN_SERVICE: `missing-${process.pid}`,
          QLIK_CODEX_SECRET_NAME: `missing-${process.pid}`,
          QLIK_CODEX_SECRET_PROVIDER: 'auto',
          QLIK_HARNESS_TARGET_MODE: 'cloud',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretValue);
  });

  it('fails the doctor when a file-backed connections policy is corrupt', () => {
    const fixture = trackedFixture();
    const configDirectory = path.join(fixture.root, 'config');
    mkdirSync(configDirectory);
    writeFileSync(path.join(configDirectory, 'connections.json'), '{invalid-json', {
      mode: 0o600,
    });
    const result = spawnSync(
      process.execPath,
      [
        doctor,
        '--json',
        '--role',
        'reviewer',
        '--state-dir',
        fixture.stateDirectory,
        '--entrypoint',
        fixture.entrypoint,
      ],
      {
        encoding: 'utf8',
        env: {
          ...baseEnvironment(),
          QLIK_HARNESS_CONFIG_DIR: configDirectory,
          QLIK_HARNESS_MUTATION_ACTORS: 'local-dev-actor',
          QLIK_HARNESS_REVIEWER_ACTORS: 'local-dev-reviewer',
        },
      },
    );

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      checks: { name: string; status: string }[];
    };
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'connection policy', status: 'fail' }),
    );
  });
});
