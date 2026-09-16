const OBSERVER_API_NAME = 'QlikHarnessRenderObserver';
const OBSERVATION_TIMEOUT_MS = 45_000;
const MAX_ERROR_CATEGORIES = 20;

const descriptorElement = document.querySelector('#render-descriptor');
const descriptor = JSON.parse(descriptorElement?.textContent ?? '');
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? '';
const status = document.querySelector('#status');
const chart = document.querySelector('#chart');
const chartContainer = document.querySelector('#chart-container');

const values = {
  host: meta('qlik-host'),
  clientId: meta('qlik-oauth-client-id'),
  redirectUri: meta('qlik-redirect-uri'),
};

let state = 'waiting-for-configuration';
let loaderState = 'not-started';
let startedAt = null;
let mutationBatchCount = 0;
let resizeEventCount = 0;
let errorCategories = [];
let attestation = null;
let mutationObserver = null;
let resizeObserver = null;
let timeoutId = null;
let windowHandlers = null;

function configured(value) {
  return value && !value.includes('REPLACE_WITH_');
}

function targetSnapshot() {
  const rectangle = chartContainer.getBoundingClientRect();
  const style = globalThis.getComputedStyle(chartContainer);
  const queryRoot = chartContainer;
  return {
    connected: chart.isConnected,
    width: Math.round(rectangle.width),
    height: Math.round(rectangle.height),
    hasArea: rectangle.width > 0 && rectangle.height > 0,
    hidden: Boolean(chartContainer.hidden),
    displayNone: style.display === 'none',
    visibilityHidden: style.visibility === 'hidden',
    opacityZero: style.opacity === '0',
    ariaBusy:
      chartContainer.getAttribute('aria-busy') === 'true' ||
      chart.getAttribute('aria-busy') === 'true',
    directChildCount: chartContainer.children.length,
    shadowRootPresent: Boolean(chart.shadowRoot),
    renderSurfacePresent: Boolean(queryRoot.querySelector('canvas, svg, iframe')),
  };
}

function classifyError(value) {
  const name =
    value && typeof value === 'object' && typeof value.name === 'string' ? value.name : '';
  const message =
    value && typeof value === 'object' && typeof value.message === 'string'
      ? value.message
      : typeof value === 'string'
        ? value
        : '';
  const normalized = `${name} ${message}`.toLowerCase();
  if (normalized.includes('cors') || normalized.includes('origin')) return 'origin';
  if (normalized.includes('auth') || normalized.includes('forbidden')) return 'authorization';
  if (normalized.includes('network') || normalized.includes('fetch')) return 'network';
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('render')) return 'rendering';
  return 'unknown';
}

function appendErrorCategory(category) {
  if (errorCategories.length >= MAX_ERROR_CATEGORIES) return;
  errorCategories = [...errorCategories, category];
}

function createSnapshot() {
  return {
    schemaVersion: 1,
    state,
    loaderState,
    operationId: descriptor.operationId,
    expectedNativeType: descriptor.expectedNativeType,
    startedAt,
    capturedAt: new Date().toISOString(),
    target: targetSnapshot(),
    mutationBatchCount,
    resizeEventCount,
    errorCategories: [...errorCategories],
    attestation: attestation ? { ...attestation } : null,
    privacy: {
      domTextCaptured: false,
      qlikValuesCaptured: false,
      bodiesCaptured: false,
      headersCaptured: false,
      cookiesOrStorageCaptured: false,
      rawUrlsCaptured: false,
    },
  };
}

function setStatus(nextState, message) {
  state = nextState;
  status.textContent = message;
}

function updateSurfaceState() {
  if (attestation) return;
  const target = targetSnapshot();
  const componentDefined = Boolean(globalThis.customElements?.get('qlik-embed'));
  if (loaderState === 'loaded' && componentDefined && target.connected && target.hasArea) {
    setStatus(
      'component-surface-ready',
      `Qlik component surface is ready for operation ${descriptor.operationId}. Visually inspect the native object, then record the observed outcome.`,
    );
  }
}

function stopObservation() {
  mutationObserver?.disconnect();
  resizeObserver?.disconnect();
  mutationObserver = null;
  resizeObserver = null;
  if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
  timeoutId = null;
  if (windowHandlers) {
    globalThis.removeEventListener('error', windowHandlers.error, true);
    globalThis.removeEventListener('unhandledrejection', windowHandlers.rejection);
    windowHandlers = null;
  }
  return createSnapshot();
}

function startObservation() {
  startedAt = new Date().toISOString();
  setStatus(
    'observing-component-surface',
    `Observing privacy-safe render metadata for operation ${descriptor.operationId}.`,
  );

  if (typeof globalThis.MutationObserver === 'function') {
    mutationObserver = new globalThis.MutationObserver(() => {
      mutationBatchCount += 1;
      updateSurfaceState();
    });
    mutationObserver.observe(chartContainer, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-busy'],
    });
  }
  if (typeof globalThis.ResizeObserver === 'function') {
    resizeObserver = new globalThis.ResizeObserver(() => {
      resizeEventCount += 1;
      updateSurfaceState();
    });
    resizeObserver.observe(chartContainer);
  }

  const handleError = (event) => appendErrorCategory(classifyError(event.error ?? event.message));
  const handleRejection = (event) => appendErrorCategory(classifyError(event.reason));
  windowHandlers = { error: handleError, rejection: handleRejection };
  globalThis.addEventListener('error', handleError, true);
  globalThis.addEventListener('unhandledrejection', handleRejection);

  timeoutId = globalThis.setTimeout(() => {
    if (!attestation) {
      setStatus(
        'observation-timeout',
        `No observed outcome was recorded for operation ${descriptor.operationId} within the bounded interval.`,
      );
    }
  }, OBSERVATION_TIMEOUT_MS);
  updateSurfaceState();
}

function recordOutcome(outcome, identityPath) {
  const expectedOutcome = {
    authorized: 'rendered',
    unauthorized: 'access-denied',
    'data-reduced': 'rendered',
  }[identityPath];
  const allowedOutcomes = new Set(['rendered', 'access-denied', 'empty', 'error', 'timeout']);
  if (!expectedOutcome || !allowedOutcomes.has(outcome)) {
    throw new Error('Unsupported browser observation outcome.');
  }
  attestation = {
    identityPath,
    outcome,
    expectedOutcomeMatched: outcome === expectedOutcome,
    recordedAt: new Date().toISOString(),
  };
  setStatus(
    'operator-observation-recorded',
    `Recorded ${outcome} for ${identityPath}; correlation ${descriptor.operationId}. This observation contains no chart values and does not replace Engine validation.`,
  );
  return createSnapshot();
}

const observerApi = Object.freeze({
  snapshot: createSnapshot,
  recordOutcome,
  stop: stopObservation,
});
Object.defineProperty(globalThis, OBSERVER_API_NAME, {
  value: observerApi,
  configurable: false,
  enumerable: false,
  writable: false,
});

if (
  [
    values.host,
    values.clientId,
    values.redirectUri,
    descriptor.appId,
    descriptor.objectId,
    descriptor.operationId,
    descriptor.expectedNativeType,
  ].every(configured)
) {
  const loader = document.createElement('script');
  loader.type = 'application/javascript';
  loader.src = 'https://cdn.jsdelivr.net/npm/@qlik/embed-web-components@1/dist/index.min.js';
  loader.crossOrigin = 'anonymous';
  loader.dataset.host = values.host;
  loader.dataset.clientId = values.clientId;
  loader.dataset.redirectUri = values.redirectUri;
  loader.dataset.accessTokenStorage = 'session';
  loader.dataset.autoRedirect = 'false';
  loader.dataset.authType = 'Oauth2';
  loader.addEventListener('load', () => {
    loaderState = 'loaded';
    chart.setAttribute('app-id', descriptor.appId);
    chart.setAttribute('object-id', descriptor.objectId);
    startObservation();
    globalThis.customElements?.whenDefined('qlik-embed').then(updateSurfaceState);
  });
  loader.addEventListener('error', () => {
    loaderState = 'failed';
    appendErrorCategory('loader');
    setStatus(
      'library-load-failed',
      `Rendering library unavailable for operation ${descriptor.operationId}.`,
    );
  });
  loaderState = 'loading';
  document.head.append(loader);
} else {
  chart.hidden = true;
  setStatus(
    'configuration-missing',
    'Generate the gitignored local fixture with the approved public tenant routing and exact retained-object identifiers.',
  );
}

document.querySelector('#record-result').addEventListener('click', () => {
  const identityPath = document.querySelector('input[name="path"]:checked').value;
  const outcome = document.querySelector('#observed-outcome').value;
  recordOutcome(outcome, identityPath);
});
