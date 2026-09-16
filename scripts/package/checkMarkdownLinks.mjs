#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const documentationRoots = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'config/README.md',
  'docs',
  'examples',
];

function markdownFiles(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!existsSync(absolutePath)) return [];
  if (statSync(absolutePath).isFile()) return absolutePath.endsWith('.md') ? [absolutePath] : [];
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) =>
    markdownFiles(path.join(relativePath, entry.name)),
  );
}

function localTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, '');
  if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const withoutFragment = target.split('#', 1)[0]?.split('?', 1)[0];
  if (!withoutFragment) return undefined;
  return decodeURIComponent(withoutFragment);
}

const failures = [];
const files = documentationRoots.flatMap(markdownFiles);
let checkedLinks = 0;

for (const filePath of files) {
  const source = readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    const rawTarget = match[1]?.split(/\s+['"]/u, 1)[0];
    if (!rawTarget) continue;
    const target = localTarget(rawTarget);
    if (!target) continue;
    checkedLinks += 1;
    if (path.isAbsolute(target)) {
      failures.push(`${path.relative(repositoryRoot, filePath)}: absolute local link ${target}`);
      continue;
    }
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!existsSync(resolved)) {
      failures.push(`${path.relative(repositoryRoot, filePath)}: missing ${rawTarget}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `Markdown link check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
  );
}

process.stderr.write(
  `[docs] checked ${checkedLinks} local links across ${files.length} Markdown files\n`,
);
