#!/usr/bin/env node

import { chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoints = ['dist/index.js', 'dist/agentcore/runtime.js'];

for (const relativePath of entrypoints) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  if (!source.startsWith('#!/usr/bin/env node\n')) {
    throw new Error(`${relativePath} is missing the Node.js executable shebang.`);
  }
  chmodSync(absolutePath, 0o755);
}

process.stderr.write(`[package] prepared ${entrypoints.length} executable entrypoints\n`);
