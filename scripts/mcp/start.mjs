#!/usr/bin/env node

import process from 'node:process';
import {
  LauncherError,
  applyRoleEnvironment,
  configureRequesterSecret,
  ensureSecureDirectory,
  inspectNodeRuntime,
  loadRepositoryEnvironment,
  normalizeRole,
  prepareLocalStorage,
  resolveEntrypoint,
  resolveNodeBinary,
  resolveStateDirectory,
  runNodeChild,
  writeLauncherError,
} from './launcher-lib.mjs';

function usage() {
  return `Usage: node scripts/mcp/start.mjs --role requester|reviewer|verifier [options]

Options:
  --node PATH             Absolute Node.js executable (default: current runtime)
  --state-dir PATH        Shared durable workflow state directory
  --entrypoint PATH       MCP entrypoint (default: dist/index.js)
  --secret-provider NAME  auto, environment, macos-keychain,
                          powershell-secretmanagement, or none
  --help                  Show this help

Requester Cloud secrets default to macOS Keychain on macOS and PowerShell
SecretManagement on Windows. A pre-injected QLIK_CLOUD_OAUTH_CLIENT_SECRET may
be selected with --secret-provider environment. Reviewer and verifier roles
always clear provider credentials before the MCP child starts.
`;
}

function parseArguments(argv) {
  const options = { passThrough: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      options.passThrough = argv.slice(index + 1);
      break;
    }
    if (argument === '--help') {
      options.help = true;
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
    throw new LauncherError(`Unknown launcher argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stderr.write(usage());
    return 0;
  }

  let environment = loadRepositoryEnvironment();
  const role = normalizeRole(options.role || environment.QLIK_CODEX_MCP_ROLE);
  environment = applyRoleEnvironment(environment, role);
  const stateDirectory = ensureSecureDirectory(
    resolveStateDirectory(environment, options.stateDirectory),
  );
  environment = { ...environment, QLIK_HARNESS_STATE_DIR: stateDirectory };

  let secretProvider = 'credential-free';
  if (role === 'requester') {
    const configured = configureRequesterSecret(
      environment,
      options.secretProvider || environment.QLIK_CODEX_SECRET_PROVIDER,
    );
    environment = configured.environment;
    secretProvider = configured.provider;
  }

  const nodeBinary = resolveNodeBinary(environment, options.node);
  const nodeVersion = inspectNodeRuntime(nodeBinary);
  const entrypoint = resolveEntrypoint(options.entrypoint);
  const localStorageArguments = prepareLocalStorage(nodeVersion, stateDirectory);
  const targetMode = environment.QLIK_HARNESS_TARGET_MODE?.trim() || 'fixture';
  process.stderr.write(
    `Qlik MCP launcher: role=${role} target=${targetMode} node=${nodeVersion.raw} secret=${secretProvider} state=${stateDirectory}\n`,
  );
  return await runNodeChild({
    args: [...localStorageArguments, entrypoint, ...options.passThrough],
    environment,
    nodeBinary,
  });
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    writeLauncherError('Qlik MCP launcher', error);
    process.exitCode = 1;
  });
