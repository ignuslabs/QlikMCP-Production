import { execFileSync, spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export const supportedNodeMessage =
  'Node.js 22.23.2 or a later Node.js 22 patch release is required.';

export const credentialEnvironmentNames = Object.freeze([
  'QLIK_CLOUD_OAUTH_CLIENT_SECRET',
  'QLIK_WINDOWS_PROXY_SESSION_JWT',
  'QLIK_WINDOWS_TRUSTED_BACKEND_PFX_BASE64',
  'QLIK_WINDOWS_TRUSTED_BACKEND_PFX_PASSPHRASE',
  'QLIK_WINDOWS_TRUSTED_BACKEND_USER_HEADER',
]);

const roleDefaults = Object.freeze({
  requester: Object.freeze({
    actor: 'local-dev-actor',
    hostClientId: 'codex-qlik-requester',
  }),
  reviewer: Object.freeze({
    actor: 'local-dev-reviewer',
    hostClientId: 'codex-qlik-reviewer',
  }),
  verifier: Object.freeze({
    // Verifiers are a read-only tool profile, not a third authorization class.
    // Reuse the requester identity so getApprovalRequest can read that actor's
    // request without granting approval authority to the verifier.
    actor: 'local-dev-actor',
    hostClientId: 'codex-qlik-verifier',
  }),
});

export class LauncherError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LauncherError';
  }
}

export function loadRepositoryEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  const dotenvPath = path.join(repositoryRoot, '.env');
  if (!existsSync(dotenvPath)) return environment;

  const parsed = parseDotenv(readFileSync(dotenvPath, 'utf8'));
  for (const [name, value] of Object.entries(parsed)) {
    if (environment[name] === undefined) environment[name] = value;
  }
  return environment;
}

export function parseNodeVersion(rawVersion) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(rawVersion.trim());
  if (!match) {
    throw new LauncherError('The configured Node.js executable reported an invalid version.');
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: rawVersion.trim(),
  };
}

export function isSupportedNodeVersion(version) {
  return (
    version.major === 22 &&
    (version.minor > 23 || (version.minor === 23 && version.patch >= 2)) &&
    !version.raw.includes('-')
  );
}

export function resolveNodeBinary(environment, configuredNodeBinary) {
  const nodeBinary = configuredNodeBinary?.trim() || environment.QLIK_CODEX_NODE_BIN?.trim();
  const resolved = nodeBinary || process.execPath;
  if (!path.isAbsolute(resolved)) {
    throw new LauncherError(
      'QLIK_CODEX_NODE_BIN and --node must identify an absolute Node.js executable path.',
    );
  }
  return path.normalize(resolved);
}

export function inspectNodeRuntime(nodeBinary) {
  let rawVersion;
  try {
    rawVersion = execFileSync(nodeBinary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (error) {
    throw new LauncherError('The configured Node.js executable did not report a version.', {
      cause: error,
    });
  }
  const version = parseNodeVersion(rawVersion);
  if (!isSupportedNodeVersion(version)) throw new LauncherError(supportedNodeMessage);
  return version;
}

export function normalizeRole(rawRole) {
  const role = rawRole?.trim().toLowerCase();
  if (role !== 'requester' && role !== 'reviewer' && role !== 'verifier') {
    throw new LauncherError('The MCP role must be requester, reviewer, or verifier.');
  }
  return role;
}

export function applyRoleEnvironment(environment, role) {
  const defaults = roleDefaults[role];
  const actor = environment.QLIK_CODEX_MCP_ACTOR?.trim() || defaults.actor;
  const hostClientId = environment.QLIK_CODEX_MCP_HOST_CLIENT_ID?.trim() || defaults.hostClientId;
  if (!actor || !hostClientId) {
    throw new LauncherError('The MCP actor and host client identities must not be empty.');
  }

  const configured = {
    ...environment,
    QLIK_HARNESS_ACTOR: actor,
    QLIK_HARNESS_HOST_CLIENT_ID: hostClientId,
    QLIK_HARNESS_MCP_ROLE: role,
  };
  if (role !== 'requester') {
    for (const name of credentialEnvironmentNames) configured[name] = '';
  }
  return configured;
}

function defaultStateDirectory(environment) {
  const profile = environment.QLIK_HARNESS_STATE_PROFILE?.trim() || 'codex-mcp-state';
  if (!/^[A-Za-z0-9._-]+$/u.test(profile) || profile === '.' || profile === '..') {
    throw new LauncherError(
      'QLIK_HARNESS_STATE_PROFILE must be a directory name using letters, digits, dot, underscore, or hyphen; dot and dot-dot alone are not permitted.',
    );
  }

  if (process.platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA?.trim();
    if (!localAppData || !path.isAbsolute(localAppData)) {
      throw new LauncherError(
        'LOCALAPPDATA must be an absolute path when QLIK_HARNESS_STATE_DIR is unset on Windows.',
      );
    }
    return path.join(localAppData, 'QlikMCP-Production', profile);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'QlikMCP-Production', profile);
  }
  const xdgStateHome = environment.XDG_STATE_HOME?.trim();
  const stateHome = xdgStateHome
    ? path.resolve(xdgStateHome)
    : path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'QlikMCP-Production', profile);
}

export function resolveStateDirectory(environment, override) {
  const configured = override?.trim() || environment.QLIK_HARNESS_STATE_DIR?.trim();
  return path.normalize(
    configured
      ? path.isAbsolute(configured)
        ? configured
        : path.resolve(repositoryRoot, configured)
      : defaultStateDirectory(environment),
  );
}

export function ensureSecureDirectory(directoryPath) {
  if (existsSync(directoryPath)) {
    const state = lstatSync(directoryPath);
    if (state.isSymbolicLink()) {
      throw new LauncherError('The MCP state directory must not be a symbolic link.');
    }
    if (!state.isDirectory()) {
      throw new LauncherError('The MCP state path must be a directory.');
    }
  } else {
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  }

  if (process.platform === 'win32') {
    const account = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
    if (!account) {
      throw new LauncherError('USERNAME is required to protect MCP state on Windows.');
    }
    try {
      const aclCommands = [
        [directoryPath, '/reset', '/T', '/L', '/Q'],
        [directoryPath, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '/T', '/L', '/Q'],
        [directoryPath, '/verify', '/T', '/L', '/Q'],
      ];
      for (const args of aclCommands) {
        execFileSync('icacls.exe', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
        });
      }
    } catch (error) {
      throw new LauncherError('Unable to apply a user-only ACL to MCP state on Windows.', {
        cause: error,
      });
    }
  } else {
    chmodSync(directoryPath, 0o700);
  }
  try {
    accessSync(directoryPath, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    throw new LauncherError('The MCP state directory is not readable and writable.', {
      cause: error,
    });
  }
  return directoryPath;
}

export function prepareLocalStorage(nodeVersion, storageDirectory) {
  if (nodeVersion.major < 22) return [];
  const storagePath = path.join(storageDirectory, '.node-localstorage.json');
  for (const candidate of [storagePath, `${storagePath}-wal`, `${storagePath}-shm`]) {
    if (!existsSync(candidate)) continue;
    const state = lstatSync(candidate);
    if (state.isSymbolicLink() || !state.isFile()) {
      throw new LauncherError('A local Node state file must be a regular, non-symlink file.');
    }
    if (process.platform !== 'win32') chmodSync(candidate, 0o600);
  }
  return [`--localstorage-file=${storagePath}`];
}

function readMacOsKeychainSecret(environment) {
  const account = environment.QLIK_CODEX_KEYCHAIN_ACCOUNT?.trim() || 'qlik-mcp-production-cloud';
  const service = environment.QLIK_CODEX_KEYCHAIN_SERVICE?.trim() || 'qlik-mcp-production.oauth';
  if (!account || !service) throw new LauncherError('The Keychain labels must not be empty.');
  try {
    const secret = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-a', account, '-s', service, '-w'],
      {
        encoding: 'utf8',
        env: environment,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim();
    if (!secret) throw new Error('empty secret');
    return secret;
  } catch (error) {
    throw new LauncherError(
      'The Qlik OAuth secret is missing from or inaccessible in macOS Keychain.',
      { cause: error },
    );
  }
}

function powershellCandidates(environment) {
  const configured = environment.QLIK_CODEX_POWERSHELL_BIN?.trim();
  return configured ? [configured] : ['pwsh.exe', 'powershell.exe'];
}

function runPowerShell(environment, script, output = 'pipe') {
  let lastError;
  for (const executable of powershellCandidates(environment)) {
    try {
      return execFileSync(
        executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          env: environment,
          stdio: ['ignore', output, 'ignore'],
          windowsHide: true,
        },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw new LauncherError(
    'PowerShell SecretManagement is unavailable or the configured secret could not be read.',
    { cause: lastError },
  );
}

function readPowerShellSecret(environment) {
  const secretName = environment.QLIK_CODEX_SECRET_NAME?.trim() || 'qlik-mcp-production-cloud';
  if (!secretName) throw new LauncherError('QLIK_CODEX_SECRET_NAME must not be empty.');
  const secretEnvironment = {
    ...environment,
    QLIK_CODEX_SECRET_NAME_EFFECTIVE: secretName,
    QLIK_CODEX_SECRET_VAULT_EFFECTIVE: environment.QLIK_CODEX_SECRET_VAULT?.trim() || '',
  };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$parameters = @{ Name = $env:QLIK_CODEX_SECRET_NAME_EFFECTIVE }',
    "if ($env:QLIK_CODEX_SECRET_VAULT_EFFECTIVE) { $parameters['Vault'] = $env:QLIK_CODEX_SECRET_VAULT_EFFECTIVE }",
    '$secret = Get-Secret @parameters -AsPlainText',
    "if ([String]::IsNullOrWhiteSpace($secret)) { throw 'Secret is empty.' }",
    '[Console]::Out.Write($secret)',
  ].join('; ');
  const secret = runPowerShell(secretEnvironment, script).trim();
  if (!secret) throw new LauncherError('PowerShell SecretManagement returned an empty secret.');
  return secret;
}

export function configureRequesterSecret(environment, requestedProvider) {
  const targetMode = environment.QLIK_HARNESS_TARGET_MODE?.trim().toLowerCase() || 'fixture';
  if (targetMode !== 'cloud') return { environment, provider: 'not-required' };

  const configuredProvider = requestedProvider?.trim().toLowerCase() || 'auto';
  const supportedProviders = new Set([
    'auto',
    'environment',
    'macos-keychain',
    'powershell-secretmanagement',
    'none',
  ]);
  if (!supportedProviders.has(configuredProvider)) {
    throw new LauncherError(
      'The secret provider must be auto, environment, macos-keychain, powershell-secretmanagement, or none.',
    );
  }

  const injected = environment.QLIK_CLOUD_OAUTH_CLIENT_SECRET?.trim();
  if (configuredProvider === 'environment') {
    if (!injected) {
      throw new LauncherError(
        'QLIK_CLOUD_OAUTH_CLIENT_SECRET must be pre-injected for the environment secret provider.',
      );
    }
    return { environment, provider: 'environment' };
  }
  if (configuredProvider === 'none') {
    throw new LauncherError('Cloud requester mode requires an approved OAuth secret provider.');
  }

  // An auto/keychain/vault launch must not leak an accidentally inherited or
  // dotenv-loaded secret into provider discovery. Only the explicit
  // environment provider may consume the pre-injected value.
  const providerEnvironment = { ...environment, QLIK_CLOUD_OAUTH_CLIENT_SECRET: '' };

  const effectiveProvider =
    configuredProvider === 'auto'
      ? process.platform === 'darwin'
        ? 'macos-keychain'
        : process.platform === 'win32'
          ? 'powershell-secretmanagement'
          : undefined
      : configuredProvider;
  if (!effectiveProvider) {
    throw new LauncherError(
      'No automatic secret provider exists on this platform; pre-inject QLIK_CLOUD_OAUTH_CLIENT_SECRET and select environment.',
    );
  }
  if (effectiveProvider === 'macos-keychain' && process.platform !== 'darwin') {
    throw new LauncherError('The macos-keychain secret provider is available only on macOS.');
  }
  if (effectiveProvider === 'powershell-secretmanagement' && process.platform !== 'win32') {
    throw new LauncherError(
      'The powershell-secretmanagement secret provider is available only on Windows.',
    );
  }

  const secret =
    effectiveProvider === 'macos-keychain'
      ? readMacOsKeychainSecret(providerEnvironment)
      : readPowerShellSecret(providerEnvironment);
  return {
    environment: { ...providerEnvironment, QLIK_CLOUD_OAUTH_CLIENT_SECRET: secret },
    provider: effectiveProvider,
  };
}

export function resolveEntrypoint(configuredEntrypoint) {
  const entrypoint = configuredEntrypoint
    ? path.isAbsolute(configuredEntrypoint)
      ? configuredEntrypoint
      : path.resolve(repositoryRoot, configuredEntrypoint)
    : path.join(repositoryRoot, 'dist', 'index.js');
  if (!existsSync(entrypoint)) {
    throw new LauncherError('dist/index.js is missing. Run npm run build before starting MCP.');
  }
  const state = lstatSync(entrypoint);
  if (!state.isFile() || state.isSymbolicLink()) {
    throw new LauncherError('The MCP entrypoint must be a regular, non-symlink file.');
  }
  return entrypoint;
}

export async function runNodeChild({ args, environment, nodeBinary }) {
  const child = spawn(nodeBinary, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);

  return await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      reject(
        new LauncherError('Unable to start the configured Node.js process.', { cause: error }),
      );
    });
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', forwardSignal);
      process.removeListener('SIGTERM', forwardSignal);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

export function commaSeparatedSet(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function writeLauncherError(prefix, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${prefix}: ${message}\n`);
}
