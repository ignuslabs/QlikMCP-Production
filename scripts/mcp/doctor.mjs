#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  LauncherError,
  applyRoleEnvironment,
  commaSeparatedSet,
  credentialEnvironmentNames,
  ensureSecureDirectory,
  inspectNodeRuntime,
  loadRepositoryEnvironment,
  normalizeRole,
  repositoryRoot,
  resolveEntrypoint,
  resolveNodeBinary,
  resolveStateDirectory,
  writeLauncherError,
} from './launcher-lib.mjs';

function usage() {
  return `Usage: node scripts/mcp/doctor.mjs --role requester|reviewer|verifier [options]

Options:
  --node PATH             Absolute Node.js executable (default: current runtime)
  --state-dir PATH        Shared durable workflow state directory
  --entrypoint PATH       MCP entrypoint (default: dist/index.js)
  --secret-provider NAME  auto, environment, macos-keychain,
                          powershell-secretmanagement, or none
  --json                  Emit machine-readable, secret-free JSON
  --print-vscode-config   Print a secret-free three-role VS Code MCP config
  --help                  Show this help

Doctor never prints credential values. It validates role isolation, runtime,
paths, policy configuration, readiness shape, state access, and secret-provider
availability without making a Qlik provider request.
`;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '--json' || argument === '--print-vscode-config') {
      options[
        argument.slice(2).replace('-vscode-config', 'VscodeConfig').replace('print-', 'print')
      ] = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      argument === '--role' ||
      argument === '--node' ||
      argument === '--state-dir' ||
      argument === '--entrypoint' ||
      argument === '--secret-provider'
    ) {
      if (!value) throw new LauncherError(`${argument} requires a value.`);
      options[argument.slice(2).replace('-dir', 'Directory').replace('-provider', 'Provider')] =
        value;
      index += 1;
      continue;
    }
    throw new LauncherError(`Unknown doctor argument: ${argument}`);
  }
  return options;
}

const vscodeRoleDefaults = Object.freeze({
  requester: Object.freeze({ actor: 'local-dev-actor', hostClientId: 'codex-qlik-requester' }),
  reviewer: Object.freeze({ actor: 'local-dev-reviewer', hostClientId: 'codex-qlik-reviewer' }),
  verifier: Object.freeze({ actor: 'local-dev-actor', hostClientId: 'codex-qlik-verifier' }),
});

function roleIdentityEnvironment(environment, role) {
  const actorPrefix = `QLIK_CODEX_${role === 'verifier' ? 'REQUESTER' : role.toUpperCase()}`;
  const hostPrefix = `QLIK_CODEX_${role.toUpperCase()}`;
  const defaults = vscodeRoleDefaults[role];
  return {
    QLIK_CODEX_MCP_ACTOR: environment[`${actorPrefix}_ACTOR`]?.trim() || defaults.actor,
    QLIK_CODEX_MCP_HOST_CLIENT_ID:
      environment[`${hostPrefix}_HOST_CLIENT_ID`]?.trim() || defaults.hostClientId,
  };
}

function requesterProviderEnvironment(environment) {
  const requestedProvider = environment.QLIK_CODEX_SECRET_PROVIDER?.trim().toLowerCase() || 'auto';
  const provider =
    requestedProvider === 'auto'
      ? process.platform === 'darwin'
        ? 'macos-keychain'
        : process.platform === 'win32'
          ? 'powershell-secretmanagement'
          : 'auto'
      : requestedProvider;
  const configured = { QLIK_CODEX_SECRET_PROVIDER: requestedProvider };

  if (provider === 'macos-keychain') {
    configured.QLIK_CODEX_KEYCHAIN_ACCOUNT =
      environment.QLIK_CODEX_KEYCHAIN_ACCOUNT?.trim() || 'qlik-mcp-production-cloud';
    configured.QLIK_CODEX_KEYCHAIN_SERVICE =
      environment.QLIK_CODEX_KEYCHAIN_SERVICE?.trim() || 'qlik-mcp-production.oauth';
  }
  if (provider === 'powershell-secretmanagement') {
    configured.QLIK_CODEX_SECRET_NAME =
      environment.QLIK_CODEX_SECRET_NAME?.trim() || 'qlik-mcp-production-cloud';
    const vault = environment.QLIK_CODEX_SECRET_VAULT?.trim();
    const powershellBinary = environment.QLIK_CODEX_POWERSHELL_BIN?.trim();
    if (vault) configured.QLIK_CODEX_SECRET_VAULT = vault;
    if (powershellBinary) configured.QLIK_CODEX_POWERSHELL_BIN = powershellBinary;
  }
  return configured;
}

function vscodeConfig(nodeBinary, stateDirectory, environment) {
  const startScript = path.join(repositoryRoot, 'scripts', 'mcp', 'start.mjs');
  const server = (role) => ({
    args: [startScript, '--role', role, '--state-dir', stateDirectory],
    command: nodeBinary,
    cwd: repositoryRoot,
    env: {
      ...roleIdentityEnvironment(environment, role),
      ...(role === 'requester' ? requesterProviderEnvironment(environment) : {}),
    },
    type: 'stdio',
  });
  return {
    servers: {
      'qlik-requester': server('requester'),
      'qlik-reviewer': server('reviewer'),
      'qlik-verifier': server('verifier'),
    },
  };
}

function check(name, status, detail) {
  return { detail, name, status };
}

function effectiveSecretProvider(environment, requestedProvider) {
  const requested = requestedProvider?.trim().toLowerCase() || 'auto';
  if (requested !== 'auto') return requested;
  if (process.platform === 'darwin') return 'macos-keychain';
  if (process.platform === 'win32') return 'powershell-secretmanagement';
  return 'none';
}

function inspectMacOsKeychain(environment) {
  const account = environment.QLIK_CODEX_KEYCHAIN_ACCOUNT?.trim() || 'qlik-mcp-production-cloud';
  const service = environment.QLIK_CODEX_KEYCHAIN_SERVICE?.trim() || 'qlik-mcp-production.oauth';
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service], {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function inspectPowerShellSecret(environment) {
  const executables = environment.QLIK_CODEX_POWERSHELL_BIN?.trim()
    ? [environment.QLIK_CODEX_POWERSHELL_BIN.trim()]
    : ['pwsh.exe', 'powershell.exe'];
  const secretEnvironment = {
    ...environment,
    QLIK_CODEX_SECRET_NAME_EFFECTIVE:
      environment.QLIK_CODEX_SECRET_NAME?.trim() || 'qlik-mcp-production-cloud',
    QLIK_CODEX_SECRET_VAULT_EFFECTIVE: environment.QLIK_CODEX_SECRET_VAULT?.trim() || '',
  };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$parameters = @{ Name = $env:QLIK_CODEX_SECRET_NAME_EFFECTIVE }',
    "if ($env:QLIK_CODEX_SECRET_VAULT_EFFECTIVE) { $parameters['Vault'] = $env:QLIK_CODEX_SECRET_VAULT_EFFECTIVE }",
    '$match = Get-SecretInfo @parameters',
    "if (-not $match) { throw 'Secret metadata was not found.' }",
  ].join('; ');
  for (const executable of executables) {
    try {
      execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        env: secretEnvironment,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      return true;
    } catch {
      // Try the other standard PowerShell executable without exposing its error output.
    }
  }
  return false;
}

function secretProviderCheck(environment, role, requestedProvider) {
  if (role !== 'requester') {
    const isolated = credentialEnvironmentNames.every((name) => environment[name] === '');
    return check(
      'credential isolation',
      isolated ? 'pass' : 'fail',
      isolated ? `${role} credentials are explicitly cleared` : 'credential clearing failed',
    );
  }
  const targetMode = environment.QLIK_HARNESS_TARGET_MODE?.trim().toLowerCase() || 'fixture';
  if (targetMode !== 'cloud') {
    return check('secret provider', 'pass', `not required for target mode ${targetMode}`);
  }

  const provider = effectiveSecretProvider(environment, requestedProvider);
  const providerEnvironment = { ...environment, QLIK_CLOUD_OAUTH_CLIENT_SECRET: '' };
  const available =
    provider === 'environment'
      ? Boolean(environment.QLIK_CLOUD_OAUTH_CLIENT_SECRET?.trim())
      : provider === 'macos-keychain'
        ? process.platform === 'darwin' && inspectMacOsKeychain(providerEnvironment)
        : provider === 'powershell-secretmanagement'
          ? process.platform === 'win32' && inspectPowerShellSecret(providerEnvironment)
          : false;
  return check(
    'secret provider',
    available ? 'pass' : 'fail',
    `${provider}: ${available ? 'available' : 'unavailable'}`,
  );
}

function policyCheck(environment) {
  const validatePolicy = (raw, source) => {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.connections)) {
        throw new Error('connections array is missing');
      }
      for (const [index, connection] of parsed.connections.entries()) {
        if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
          throw new Error(`connection ${index} is not an object`);
        }
        for (const field of ['alias', 'platform', 'visualizationSchemaProfile', 'environment']) {
          if (typeof connection[field] !== 'string' || !connection[field].trim()) {
            throw new Error(`connection ${index} is missing ${field}`);
          }
        }
      }
      return check('connection policy', 'pass', `${source} has a valid policy shape`);
    } catch {
      return check('connection policy', 'fail', `${source} is invalid`);
    }
  };
  if (environment.QLIK_HARNESS_CONNECTIONS_JSON?.trim()) {
    return validatePolicy(environment.QLIK_HARNESS_CONNECTIONS_JSON, 'inline JSON');
  }
  const configuredDirectory = environment.QLIK_HARNESS_CONFIG_DIR?.trim();
  const configDirectory = configuredDirectory
    ? path.isAbsolute(configuredDirectory)
      ? configuredDirectory
      : path.resolve(repositoryRoot, configuredDirectory)
    : path.join(repositoryRoot, 'config');
  const override = path.join(configDirectory, 'connections.json');
  const example = path.join(configDirectory, 'connections.example.json');
  const policyPath = existsSync(override) ? override : example;
  if (!existsSync(policyPath) || !lstatSync(policyPath).isFile()) {
    return check('connection policy', 'fail', 'no connections policy file was found');
  }
  try {
    return validatePolicy(readFileSync(policyPath, 'utf8'), policyPath);
  } catch {
    return check('connection policy', 'fail', `${policyPath} could not be read`);
  }
}

function readinessCheck(environment) {
  const mode = environment.QLIK_HARNESS_TARGET_MODE?.trim().toLowerCase() || 'fixture';
  if (mode === 'fixture') return check('readiness evidence', 'pass', 'fixture mode is offline');
  const prefix = mode === 'cloud' ? 'QLIK_CLOUD_READINESS_' : 'QLIK_WINDOWS_READINESS_';
  if (mode !== 'cloud' && mode !== 'windows') {
    return check('readiness evidence', 'fail', `unsupported target mode ${mode}`);
  }
  const booleanNames = [
    'APPROVED',
    'CAN_READ',
    'CAN_PREVIEW',
    'CAN_WRITE_DESIGNATED_SHEET',
    'CLEANUP_VERIFIED',
  ];
  const booleansAreValid = booleanNames.every((suffix) =>
    ['true', 'false'].includes(environment[`${prefix}${suffix}`]?.trim().toLowerCase()),
  );
  const allCapabilitiesApproved = booleanNames.every(
    (suffix) => environment[`${prefix}${suffix}`]?.trim().toLowerCase() === 'true',
  );
  const expiry = environment[`${prefix}EXPIRES_AT`]?.trim() || '';
  const expiresAt = Date.parse(expiry);
  const current =
    booleansAreValid &&
    allCapabilitiesApproved &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now();
  return check(
    'readiness evidence',
    current ? 'pass' : 'fail',
    current
      ? `approved through ${new Date(expiresAt).toISOString()}`
      : 'missing, invalid, or expired',
  );
}

function actorCheck(environment, role) {
  const actor = environment.QLIK_HARNESS_ACTOR;
  const mutationActors = commaSeparatedSet(environment.QLIK_HARNESS_MUTATION_ACTORS);
  const reviewerActors = commaSeparatedSet(environment.QLIK_HARNESS_REVIEWER_ACTORS);
  const overlap = [...mutationActors].filter((candidate) => reviewerActors.has(candidate));
  if (overlap.length > 0) {
    return check('actor separation', 'fail', 'mutation and reviewer allowlists overlap');
  }
  if (role === 'requester' && !mutationActors.has(actor)) {
    return check('actor separation', 'warn', 'requester actor is not in the mutation allowlist');
  }
  if (role === 'reviewer' && !reviewerActors.has(actor)) {
    return check('actor separation', 'warn', 'reviewer actor is not in the reviewer allowlist');
  }
  if (role === 'verifier' && !mutationActors.has(actor)) {
    return check(
      'actor separation',
      'fail',
      "verifier must reuse the requester actor to read that actor's approval request",
    );
  }
  return check('actor separation', 'pass', 'requester and reviewer identities are distinct');
}

function renderText(report) {
  const lines = [
    `Qlik MCP doctor: role=${report.role} target=${report.targetMode}`,
    ...report.checks.map(
      (entry) => `${entry.status.toUpperCase().padEnd(4)} ${entry.name}: ${entry.detail}`,
    ),
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  let environment = loadRepositoryEnvironment();
  if (options.printVscodeConfig) {
    const nodeBinary = resolveNodeBinary(environment, options.node);
    inspectNodeRuntime(nodeBinary);
    const sharedStateDirectory = resolveStateDirectory(environment, options.stateDirectory);
    process.stdout.write(
      `${JSON.stringify(vscodeConfig(nodeBinary, sharedStateDirectory, environment), undefined, 2)}\n`,
    );
    return 0;
  }
  const role = normalizeRole(options.role || environment.QLIK_CODEX_MCP_ROLE);
  environment = applyRoleEnvironment(environment, role);
  const nodeBinary = resolveNodeBinary(environment, options.node);
  const nodeVersion = inspectNodeRuntime(nodeBinary);
  const entrypoint = resolveEntrypoint(options.entrypoint);
  const configuredState = options.stateDirectory || environment.QLIK_HARNESS_STATE_DIR?.trim();
  const stateDirectory = ensureSecureDirectory(
    resolveStateDirectory(environment, options.stateDirectory),
  );
  environment = { ...environment, QLIK_HARNESS_STATE_DIR: stateDirectory };

  const checks = [
    check('Node runtime', 'pass', `${nodeVersion.raw} at ${nodeBinary}`),
    check('MCP entrypoint', 'pass', entrypoint),
    policyCheck(environment),
    check(
      'shared state',
      configuredState && !path.isAbsolute(configuredState) ? 'warn' : 'pass',
      configuredState && !path.isAbsolute(configuredState)
        ? `${stateDirectory} is repository-relative and will not be shared across worktrees`
        : stateDirectory,
    ),
    actorCheck(environment, role),
    readinessCheck(environment),
    secretProviderCheck(
      environment,
      role,
      options.secretProvider || environment.QLIK_CODEX_SECRET_PROVIDER,
    ),
  ];
  const summary = {
    fail: checks.filter((entry) => entry.status === 'fail').length,
    pass: checks.filter((entry) => entry.status === 'pass').length,
    warn: checks.filter((entry) => entry.status === 'warn').length,
  };
  const report = {
    checks,
    role,
    summary,
    targetMode: environment.QLIK_HARNESS_TARGET_MODE?.trim().toLowerCase() || 'fixture',
  };
  process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : renderText(report));
  return summary.fail === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  writeLauncherError('Qlik MCP doctor', error);
  process.exitCode = 1;
}
