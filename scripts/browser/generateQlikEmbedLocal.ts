import 'dotenv/config';

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderLocalBrowserFixture,
  validateLocalBrowserFixtureConfig,
} from '../../src/embed/localBrowserFixture.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, '..', '..');
const exampleDirectory = join(repositoryRoot, 'examples', 'qlik-embed');
const outputDirectory = join(exampleDirectory, '.local');
const retainedManifestPath = join(
  repositoryRoot,
  '.qlik-ai-harness',
  'cloud-browser',
  'retained-object.json',
);

async function retainedObjectConfiguration(): Promise<Readonly<Record<string, unknown>>> {
  if (process.env.QLIK_BROWSER_OBJECT_ID?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(retainedManifestPath, 'utf8'));
  } catch {
    throw new Error(
      'QLIK_BROWSER_OBJECT_ID is missing and no retained-object manifest is available.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The retained-object manifest is invalid.');
  }
  const manifest = parsed as Readonly<Record<string, unknown>>;
  return {
    appId: manifest.appId,
    objectId: manifest.objectId,
    operationId: manifest.operationId,
    expectedNativeType: manifest.nativeType,
  };
}

async function generate(): Promise<void> {
  const retained = await retainedObjectConfiguration();
  const config = validateLocalBrowserFixtureConfig({
    tenantHost: process.env.QLIK_BROWSER_TENANT_HOST ?? process.env.QLIK_CLOUD_TENANT_HOST,
    spaClientId: process.env.QLIK_BROWSER_SPA_CLIENT_ID,
    redirectUri:
      process.env.QLIK_BROWSER_REDIRECT_URI ?? 'http://localhost:4173/oauth-callback.html',
    appId: process.env.QLIK_BROWSER_APP_ID ?? retained.appId,
    objectId: process.env.QLIK_BROWSER_OBJECT_ID ?? retained.objectId,
    operationId: process.env.QLIK_BROWSER_OPERATION_ID ?? retained.operationId,
    expectedNativeType:
      process.env.QLIK_BROWSER_EXPECTED_NATIVE_TYPE ?? retained.expectedNativeType,
  });
  const [page, callback, loader] = await Promise.all([
    readFile(join(exampleDirectory, 'render-example.html'), 'utf8'),
    readFile(join(exampleDirectory, 'oauth-callback.html'), 'utf8'),
    readFile(join(exampleDirectory, 'render-example.js'), 'utf8'),
  ]);
  const files = renderLocalBrowserFixture(config, { page, callback, loader });

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  await Promise.all([
    writeFile(join(outputDirectory, 'index.html'), files.indexHtml, { mode: 0o600 }),
    writeFile(join(outputDirectory, 'oauth-callback.html'), files.callbackHtml, { mode: 0o600 }),
    writeFile(join(outputDirectory, 'render-example.js'), files.loaderJavaScript, { mode: 0o600 }),
  ]);
  console.warn(
    '[qlik-browser-fixture] Prepared three local files with public routing identifiers only.',
  );
}

generate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown fixture generation failure.';
  console.error(`[qlik-browser-fixture] ${message}`);
  process.exitCode = 1;
});
