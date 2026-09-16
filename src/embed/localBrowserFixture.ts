const EXACT_REDIRECT_URI = 'http://localhost:4173/oauth-callback.html';
const QLIK_CLOUD_HOST_SUFFIX = '.qlikcloud.com';
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9_-]{1,160}$/;
const SPA_CLIENT_ID = /^[a-f0-9]{32}$/i;

const SUPPORTED_NATIVE_TYPES = new Set([
  'barchart',
  'linechart',
  'scatterplot',
  'sn-table',
  'kpi',
  'gauge',
  'treemap',
  'piechart',
  'combochart',
]);

const CONFIG_KEYS = new Set([
  'tenantHost',
  'spaClientId',
  'redirectUri',
  'appId',
  'objectId',
  'operationId',
  'expectedNativeType',
]);

const FORBIDDEN_KEY = /(secret|token|password|cookie|authorization|api.?key|header)/i;

export interface LocalBrowserFixtureConfig {
  readonly tenantHost: string;
  readonly spaClientId: string;
  readonly redirectUri: typeof EXACT_REDIRECT_URI;
  readonly appId: string;
  readonly objectId: string;
  readonly operationId: string;
  readonly expectedNativeType: string;
}

export interface LocalBrowserFixtureTemplates {
  readonly page: string;
  readonly callback: string;
  readonly loader: string;
}

export interface LocalBrowserFixtureFiles {
  readonly indexHtml: string;
  readonly callbackHtml: string;
  readonly loaderJavaScript: string;
}

function requiredString(value: unknown, setting: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${setting} is required.`);
  }
  return value.trim();
}

function boundedIdentifier(value: unknown, setting: string): string {
  const normalized = requiredString(value, setting);
  if (!BOUNDED_IDENTIFIER.test(normalized)) {
    throw new Error(`${setting} must be a bounded Qlik identifier.`);
  }
  return normalized;
}

function normalizedTenantHost(value: unknown): string {
  const normalized = requiredString(value, 'QLIK_BROWSER_TENANT_HOST');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('QLIK_BROWSER_TENANT_HOST must be an absolute HTTPS URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith(QLIK_CLOUD_HOST_SUFFIX) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('QLIK_BROWSER_TENANT_HOST must be a bare Qlik Cloud HTTPS origin.');
  }
  return parsed.origin;
}

/** Validates only public routing and retained-object identifiers; credentials are rejected. */
export function validateLocalBrowserFixtureConfig(
  input: Readonly<Record<string, unknown>>,
): LocalBrowserFixtureConfig {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error('Browser fixture configuration must not contain credentials.');
    }
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`Unknown browser fixture setting "${key}".`);
    }
  }

  const spaClientId = requiredString(input.spaClientId, 'QLIK_BROWSER_SPA_CLIENT_ID');
  if (!SPA_CLIENT_ID.test(spaClientId)) {
    throw new Error('QLIK_BROWSER_SPA_CLIENT_ID must be a 32-character public client ID.');
  }

  const redirectUri = requiredString(input.redirectUri, 'QLIK_BROWSER_REDIRECT_URI');
  if (redirectUri !== EXACT_REDIRECT_URI) {
    throw new Error(`QLIK_BROWSER_REDIRECT_URI must equal ${EXACT_REDIRECT_URI}.`);
  }

  const expectedNativeType = requiredString(
    input.expectedNativeType,
    'QLIK_BROWSER_EXPECTED_NATIVE_TYPE',
  );
  if (!SUPPORTED_NATIVE_TYPES.has(expectedNativeType)) {
    throw new Error('QLIK_BROWSER_EXPECTED_NATIVE_TYPE is not supported by the Cloud registry.');
  }

  return {
    tenantHost: normalizedTenantHost(input.tenantHost),
    spaClientId,
    redirectUri: EXACT_REDIRECT_URI,
    appId: boundedIdentifier(input.appId, 'QLIK_BROWSER_APP_ID'),
    objectId: boundedIdentifier(input.objectId, 'QLIK_BROWSER_OBJECT_ID'),
    operationId: boundedIdentifier(input.operationId, 'QLIK_BROWSER_OPERATION_ID'),
    expectedNativeType,
  };
}

function replaceExactlyOnce(source: string, token: string, value: string): string {
  const parts = source.split(token);
  if (parts.length !== 2) {
    throw new Error(`Browser fixture template must contain exactly one ${token} token.`);
  }
  return `${parts[0]}${value}${parts[1]}`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Produces a stable localhost fixture without persisting a backend credential. */
export function renderLocalBrowserFixture(
  config: LocalBrowserFixtureConfig,
  templates: LocalBrowserFixtureTemplates,
): LocalBrowserFixtureFiles {
  let page = templates.page;
  const pageReplacements: readonly (readonly [string, string])[] = [
    ['REPLACE_WITH_QLIK_HOST', escapeHtmlAttribute(config.tenantHost)],
    ['REPLACE_WITH_SPA_CLIENT_ID', escapeHtmlAttribute(config.spaClientId)],
    ['REPLACE_WITH_REDIRECT_URI', escapeHtmlAttribute(config.redirectUri)],
    ['REPLACE_WITH_REAL_APP_ID', config.appId],
    ['REPLACE_WITH_REAL_OBJECT_ID', config.objectId],
    ['REPLACE_WITH_REAL_OPERATION_ID', config.operationId],
    ['REPLACE_WITH_EXPECTED_NATIVE_TYPE', config.expectedNativeType],
  ];
  for (const [token, value] of pageReplacements) {
    page = replaceExactlyOnce(page, token, value);
  }

  const callback = replaceExactlyOnce(
    templates.callback,
    'REPLACE_WITH_QLIK_HOST',
    escapeHtmlAttribute(config.tenantHost),
  );
  return { indexHtml: page, callbackHtml: callback, loaderJavaScript: templates.loader };
}
