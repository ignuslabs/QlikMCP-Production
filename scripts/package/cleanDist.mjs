#!/usr/bin/env node

import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A clean build cannot accidentally ship code removed or renamed since the previous build.
rmSync(path.join(repositoryRoot, 'dist'), { recursive: true, force: true });
