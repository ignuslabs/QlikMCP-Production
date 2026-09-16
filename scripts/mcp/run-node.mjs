#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import {
  LauncherError,
  ensureSecureDirectory,
  inspectNodeRuntime,
  loadRepositoryEnvironment,
  prepareLocalStorage,
  repositoryRoot,
  resolveNodeBinary,
  runNodeChild,
  writeLauncherError,
} from './launcher-lib.mjs';

function parseArguments(argv) {
  const options = { environmentOverrides: {}, command: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      options.command = argv.slice(index + 1);
      break;
    }
    if (argument === '--node' || argument === '--storage-dir') {
      const value = argv[index + 1];
      if (!value) throw new LauncherError(`${argument} requires a value.`);
      options[argument === '--node' ? 'node' : 'storageDirectory'] = value;
      index += 1;
      continue;
    }
    if (argument === '--env') {
      const assignment = argv[index + 1];
      const separator = assignment?.indexOf('=') ?? -1;
      if (!assignment || separator < 1) {
        throw new LauncherError('--env requires a NAME=value assignment.');
      }
      const name = assignment.slice(0, separator);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new LauncherError(`Invalid environment variable name: ${name}`);
      }
      options.environmentOverrides[name] = assignment.slice(separator + 1);
      index += 1;
      continue;
    }
    throw new LauncherError(`Unknown portable runner argument: ${argument}`);
  }
  if (options.command.length === 0) {
    throw new LauncherError('Usage: node scripts/mcp/run-node.mjs [options] -- script [args ...]');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const environment = {
    ...loadRepositoryEnvironment(),
    ...options.environmentOverrides,
  };
  const nodeBinary = resolveNodeBinary(environment, options.node);
  const nodeVersion = inspectNodeRuntime(nodeBinary);
  const configuredStorageDirectory =
    options.storageDirectory || environment.QLIK_HARNESS_NODE_STORAGE_DIR?.trim();
  const storageDirectory = ensureSecureDirectory(
    configuredStorageDirectory
      ? path.isAbsolute(configuredStorageDirectory)
        ? configuredStorageDirectory
        : path.resolve(repositoryRoot, configuredStorageDirectory)
      : path.join(repositoryRoot, '.qlik-ai-harness'),
  );
  const localStorageArguments = prepareLocalStorage(nodeVersion, storageDirectory);
  return await runNodeChild({
    args: [...localStorageArguments, ...options.command],
    environment,
    nodeBinary,
  });
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    writeLauncherError('Portable Node runner', error);
    process.exitCode = 1;
  });
