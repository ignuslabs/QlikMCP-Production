#!/usr/bin/env node

import {
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateMaterialReason } from './privateMaterial.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINARY_PREFIX_BYTES = 8192;
const MAX_TEXT_FILE_BYTES = 32 * 1024 * 1024;
const sensitivePatterns = [
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/u },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  {
    name: 'GitHub token',
    pattern: /\b(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/u,
  },
  { name: 'OpenAI token', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u },
  {
    name: 'live-looking Qlik Cloud tenant host',
    pattern: /https?:\/\/[a-z0-9]{12,}\.[a-z0-9-]+\.qlikcloud\.com\b/iu,
  },
  { name: 'personal macOS path', pattern: /\/Users\/(?!example\/|fixture\/|user\/)[^/\s]+\//u },
  { name: 'personal Windows path', pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/u },
];

const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});

const excludedDirectories = new Set(['.git', '.omc', 'coverage', 'dist', 'node_modules']);
const excludedFiles = new Set();

function snapshotFiles(relativeDirectory = '') {
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    const normalizedPath = relativePath.split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) {
        return [];
      }
      return snapshotFiles(relativePath);
    }
    return excludedFiles.has(normalizedPath) ? [] : [normalizedPath];
  });
}

function hasBinaryPrefix(absolutePath) {
  const descriptor = openSync(absolutePath, 'r');
  try {
    const prefix = Buffer.alloc(BINARY_PREFIX_BYTES);
    const bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0);
    return prefix.subarray(0, bytesRead).includes(0);
  } finally {
    closeSync(descriptor);
  }
}

const candidateFiles =
  listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : snapshotFiles();

const failures = [];
let scannedFiles = 0;
const allowedSyntheticClientIdentifiers = new Set([
  '00000000000000000000000000000000',
  '0123456789abcdef0123456789abcdef',
]);
for (const relativePath of candidateFiles) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const metadata = lstatSync(absolutePath, { throwIfNoEntry: false });
  if (!metadata) continue;
  if (metadata.isSymbolicLink()) {
    failures.push(`${relativePath}: symbolic links are not permitted in release sources`);
    continue;
  }
  if (!statSync(absolutePath).isFile()) continue;

  const normalizedPath = relativePath.split(path.sep).join('/');
  const privateReason = privateMaterialReason(normalizedPath);
  if (privateReason) {
    failures.push(`${normalizedPath}: ${privateReason}`);
    continue;
  }

  if (hasBinaryPrefix(absolutePath)) continue;
  if (statSync(absolutePath).size > MAX_TEXT_FILE_BYTES) {
    failures.push(
      `${normalizedPath}: text candidate exceeds the bounded scan size (${MAX_TEXT_FILE_BYTES} bytes); scan cannot be completed`,
    );
    continue;
  }
  const data = readFileSync(absolutePath);
  if (data.includes(0)) continue;
  scannedFiles += 1;
  const source = data.toString('utf8');
  const clientIdentifiers = source.match(/\b[0-9a-f]{32}\b/giu) ?? [];
  if (
    clientIdentifiers.some(
      (identifier) => !allowedSyntheticClientIdentifiers.has(identifier.toLowerCase()),
    )
  ) {
    failures.push(`${normalizedPath}: 32-character OAuth client identifier`);
  }
  for (const rule of sensitivePatterns) {
    if (rule.pattern.test(source)) failures.push(`${normalizedPath}: ${rule.name}`);
  }
}

if (failures.length > 0) {
  throw new Error(
    `Repository hygiene check failed without printing matched values:\n${failures
      .map((failure) => `- ${failure}`)
      .join('\n')}`,
  );
}

process.stderr.write(
  `[security] scanned ${scannedFiles} repository text files; no blocked material\n`,
);
