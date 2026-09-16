import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { toQlikEmbedAttributes } from '../../../src/embed/renderDescriptor.js';
import {
  renderLocalBrowserFixture,
  validateLocalBrowserFixtureConfig,
} from '../../../src/embed/localBrowserFixture.js';
import type { RenderDescriptor } from '../../../src/domain/types.js';

async function sampleFile(name: string): Promise<string> {
  return readFile(new URL(`../../../examples/qlik-embed/${name}`, import.meta.url), 'utf8');
}

const validLocalConfig = {
  tenantHost: 'https://tenant-name.us.qlikcloud.com',
  spaClientId: '0123456789abcdef0123456789abcdef',
  redirectUri: 'http://localhost:4173/oauth-callback.html',
  appId: '11111111-2222-4333-8444-555555555555',
  objectId: 'object_1',
  operationId: 'operation-1',
  expectedNativeType: 'sn-table',
} as const;

describe('qlik-embed OAuth SPA sample', () => {
  it('reads the JSON render descriptor from script text content', async () => {
    const loader = await sampleFile('render-example.js');

    expect(loader).toContain("descriptorElement?.textContent ?? ''");
    expect(loader).not.toContain('querySelector(selector)?.content');
  });

  it('keeps tracked browser files as credential-free local templates', async () => {
    const [page, loader, callback, gitignore] = await Promise.all([
      sampleFile('render-example.html'),
      sampleFile('render-example.js'),
      sampleFile('oauth-callback.html'),
      readFile(new URL('../../../.gitignore', import.meta.url), 'utf8'),
    ]);

    expect(page).toContain('ui="analytics/chart"');
    expect(page).toContain('theme="Sense Horizon"');
    expect(page).toContain('iframe="true"');
    expect(page).toContain('preview="true"');
    expect(page).toContain('id="chart-container"');
    expect(page).toContain('REPLACE_WITH_QLIK_HOST');
    expect(page).toContain('REPLACE_WITH_SPA_CLIENT_ID');
    expect(callback).toContain('data-host="REPLACE_WITH_QLIK_HOST"');
    expect(loader).toContain('@qlik/embed-web-components@1/dist/index.min.js');
    expect(loader).toContain("loader.dataset.authType = 'Oauth2'");
    expect(loader).toContain("loader.dataset.accessTokenStorage = 'session'");
    expect(callback).toContain('@qlik/embed-web-components@1/dist/oauth-callback.min.js');
    expect(gitignore).toContain('examples/qlik-embed/.local/');

    const browserSources = `${page}\n${loader}\n${callback}`.toLowerCase();
    expect(browserSources).not.toMatch(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.qlikcloud\.com/);
    expect(browserSources).not.toContain('data-api-key');
    expect(browserSources).not.toContain('data-access-code');
    expect(browserSources).not.toContain('client-secret');
  });

  it('maps a retained-object descriptor to the analytics chart UI', () => {
    const descriptor: RenderDescriptor = {
      rendering: 'qlik-embed',
      connectionAlias: 'cloud-dev',
      appId: 'app-1',
      objectId: 'object-1',
      operationId: 'operation-1',
      mode: 'persisted',
    };

    expect(toQlikEmbedAttributes(descriptor)).toEqual({
      ui: 'analytics/chart',
      'app-id': 'app-1',
      'object-id': 'object-1',
      theme: 'Sense Horizon',
      iframe: 'true',
      preview: 'true',
    });
  });

  it('renders a validated fixture with the exact public routing and retained-object IDs', async () => {
    const [page, callback, loader] = await Promise.all([
      sampleFile('render-example.html'),
      sampleFile('oauth-callback.html'),
      sampleFile('render-example.js'),
    ]);
    const config = validateLocalBrowserFixtureConfig(validLocalConfig);
    const fixture = renderLocalBrowserFixture(config, { page, callback, loader });

    expect(fixture.indexHtml).toContain(validLocalConfig.tenantHost);
    expect(fixture.indexHtml).toContain(validLocalConfig.spaClientId);
    expect(fixture.indexHtml).toContain(validLocalConfig.appId);
    expect(fixture.indexHtml).toContain(validLocalConfig.objectId);
    expect(fixture.indexHtml).toContain(validLocalConfig.operationId);
    expect(fixture.indexHtml).toContain(validLocalConfig.expectedNativeType);
    expect(fixture.callbackHtml).toContain(`data-host="${validLocalConfig.tenantHost}"`);
    expect(`${fixture.indexHtml}\n${fixture.callbackHtml}`).not.toContain('REPLACE_WITH_');
    expect(fixture.loaderJavaScript).toBe(loader);
  });

  it('rejects credential-shaped settings and unsafe routing', () => {
    expect(() =>
      validateLocalBrowserFixtureConfig({ ...validLocalConfig, clientSecret: 'do-not-store' }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      validateLocalBrowserFixtureConfig({
        ...validLocalConfig,
        tenantHost: 'https://example.invalid',
      }),
    ).toThrow(/bare Qlik Cloud HTTPS origin/);
    expect(() =>
      validateLocalBrowserFixtureConfig({
        ...validLocalConfig,
        redirectUri: 'http://localhost:4173/other-callback.html',
      }),
    ).toThrow(/must equal http:\/\/localhost:4173\/oauth-callback.html/);
  });

  it('exposes only privacy-safe component metadata and explicit observed outcomes', async () => {
    const loader = await sampleFile('render-example.js');

    expect(loader).toContain("const OBSERVER_API_NAME = 'QlikHarnessRenderObserver'");
    expect(loader).toContain('domTextCaptured: false');
    expect(loader).toContain('qlikValuesCaptured: false');
    expect(loader).toContain('cookiesOrStorageCaptured: false');
    expect(loader).toContain('recordOutcome');
    expect(loader).toContain("'component-surface-ready'");
    expect(loader).not.toContain('.innerText');
    expect(loader).not.toContain('document.cookie');
    expect(loader).not.toContain('localStorage');
    expect(loader).not.toContain('sessionStorage');
  });
});
