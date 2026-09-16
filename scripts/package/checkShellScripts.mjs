#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function files(directory, suffix) {
  return readdirSync(path.join(repositoryRoot, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.join(directory, entry.name));
}

function validate(shell, paths) {
  const result = spawnSync(shell, ['-n', ...paths], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`${shell} syntax validation failed${detail ? `: ${detail}` : '.'}`);
  }
}

if (process.platform === 'win32') {
  process.stderr.write('[shell-check] skipped POSIX-only syntax validation on Windows\n');
} else {
  validate('sh', files('scripts/codex', '.sh'));
  process.stderr.write('[shell-check] validated local Codex sh scripts\n');
}
