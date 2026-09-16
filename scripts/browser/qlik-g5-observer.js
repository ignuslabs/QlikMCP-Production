/*
 * Qlik G5 retained-object browser observer
 *
 * This dependency-free script is intended to be pasted into DevTools Console
 * while the retained object is open in Qlik Cloud. It records metadata only:
 * DOM/render signals, JavaScript error categories, HTTP status/timing, and
 * browser resource timing. It never reads DOM text, Qlik cell values, request
 * or response bodies, headers, cookies, storage, or WebSocket frames.
 *
 * Optional setup before pasting:
 *   window.QLIK_G5_OBSERVER_OPTIONS = {
 *     objectId: 'RETAINED_OBJECT_ID',
 *     // targetSelector: '[data-testid="sheet-object"]', // optional fallback
 *     maxEvents: 1000,
 *     observeNetwork: false,   // opt in to temporary fetch/XHR wrapping
 *     observeResources: true,  // passive PerformanceObserver entries
 *   };
 *
 * After pasting:
 *   QlikG5Observer.snapshot(); // inspect a sanitized snapshot
 *   QlikG5Observer.export();   // download a sanitized JSON report
 *   QlikG5Observer.stop();     // disconnect and restore fetch/XHR
 *   QlikG5Observer.start({ objectId: '...' }); // start again
 *
 * A shorter alias, window.__qlikG5Observer, exposes the same API.
 */

(() => {
  'use strict';

  const globalScope = globalThis;
  const API_NAME = 'QlikG5Observer';
  const API_ALIAS = '__qlikG5Observer';
  const OPTIONS_NAME = 'QLIK_G5_OBSERVER_OPTIONS';
  const INSTALLATION_MARKER = 'qlik-g5-observer-v2';
  const DEFAULT_MAX_EVENTS = 1000;
  const MIN_MAX_EVENTS = 100;
  const MAX_MAX_EVENTS = 5000;
  const MAX_METHOD_LENGTH = 16;

  const existingApi = globalScope[API_NAME] ?? globalScope[API_ALIAS];
  if (existingApi?.installationMarker === INSTALLATION_MARKER) {
    globalScope.console.warn(
      '[QlikG5Observer] Already installed. Use QlikG5Observer.snapshot(), .export(), .stop(), or .start().',
    );
    return;
  }
  if (
    typeof existingApi?.installationMarker === 'string' &&
    existingApi.installationMarker.startsWith('qlik-g5-observer-') &&
    typeof existingApi.stop === 'function'
  ) {
    existingApi.stop();
  }

  let events = [];
  let sequence = 0;
  let isRunning = false;
  let runGeneration = 0;
  let startedAtIso = null;
  let startedAtMonotonic = 0;
  let currentConfig = createConfig();
  let documentMutationObserver = null;
  let targetMutationObserver = null;
  let intersectionObserver = null;
  let resizeObserver = null;
  let performanceObserver = null;
  let currentTarget = null;
  let originalFetch = null;
  let patchedFetch = null;
  let originalXhrOpen = null;
  let originalXhrSend = null;
  let patchedXhrOpen = null;
  let patchedXhrSend = null;
  let windowEventHandlers = null;
  const xhrMetadata = new WeakMap();

  function createConfig(options = {}) {
    const requestedMaxEvents = Number(options.maxEvents);
    const maxEvents = Number.isFinite(requestedMaxEvents)
      ? Math.min(MAX_MAX_EVENTS, Math.max(MIN_MAX_EVENTS, Math.trunc(requestedMaxEvents)))
      : DEFAULT_MAX_EVENTS;
    const objectId = typeof options.objectId === 'string' ? options.objectId.trim() : '';
    const targetSelector =
      typeof options.targetSelector === 'string' ? options.targetSelector.trim().slice(0, 500) : '';

    return Object.freeze({
      objectId,
      targetSelector,
      maxEvents,
      observeNetwork: options.observeNetwork === true,
      observeResources: options.observeResources !== false,
    });
  }

  function monotonicNow() {
    return globalScope.performance?.now?.() ?? Date.now();
  }

  function elapsedMilliseconds() {
    return Math.max(0, monotonicNow() - startedAtMonotonic);
  }

  function roundMilliseconds(value) {
    return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  }

  function isCurrentGeneration(expectedGeneration) {
    return isRunning && expectedGeneration === runGeneration;
  }

  function appendEvent(type, details = {}, expectedGeneration = runGeneration) {
    if (!isCurrentGeneration(expectedGeneration)) return;

    const event = Object.freeze({
      sequence: (sequence += 1),
      generation: expectedGeneration,
      elapsedMs: roundMilliseconds(elapsedMilliseconds()),
      type,
      ...details,
    });

    events =
      events.length >= currentConfig.maxEvents
        ? [...events.slice(events.length - currentConfig.maxEvents + 1), event]
        : [...events, event];
  }

  function truncateMethod(method) {
    const normalized = typeof method === 'string' ? method.toUpperCase() : 'GET';
    return normalized.slice(0, MAX_METHOD_LENGTH);
  }

  function classifyRoute(url) {
    const pathname = url.pathname.toLowerCase();
    if (pathname.includes('/api/')) return 'api';
    if (pathname.includes('/qrs/')) return 'repository-api';
    if (pathname.includes('/resources/') || pathname.includes('/assets/')) return 'static-resource';
    if (/\.(?:js|mjs)$/.test(pathname)) return 'script';
    if (/\.css$/.test(pathname)) return 'stylesheet';
    if (/\.(?:png|jpe?g|gif|svg|webp|ico)$/.test(pathname)) return 'image';
    if (/\.(?:woff2?|ttf|otf)$/.test(pathname)) return 'font';
    if (/\.(?:json|map)$/.test(pathname)) return 'metadata';
    return 'application-route';
  }

  function sanitizeUrl(value) {
    try {
      const url = new globalScope.URL(String(value), globalScope.document?.baseURI);
      return {
        routeCategory: classifyRoute(url),
        pathDepth: url.pathname.split('/').filter(Boolean).length,
        queryPresent: url.search.length > 0,
        fragmentPresent: url.hash.length > 0,
        originScope:
          typeof globalScope.location?.origin === 'string'
            ? url.origin === globalScope.location.origin
              ? 'same-origin'
              : 'cross-origin'
            : null,
      };
    } catch {
      return {
        routeCategory: 'unparseable',
        pathDepth: null,
        queryPresent: false,
        fragmentPresent: false,
        originScope: null,
      };
    }
  }

  function classifyError(value) {
    const rawErrorName =
      value && typeof value === 'object' && typeof value.name === 'string'
        ? value.name.slice(0, 80)
        : typeof value;
    const message =
      value && typeof value === 'object' && typeof value.message === 'string'
        ? value.message
        : typeof value === 'string'
          ? value
          : '';
    const normalized = `${rawErrorName} ${message}`.toLowerCase();
    const knownErrorNames = new Set([
      'Error',
      'EvalError',
      'RangeError',
      'ReferenceError',
      'SyntaxError',
      'TypeError',
      'URIError',
      'AggregateError',
      'DOMException',
      'string',
      'object',
      'undefined',
      'number',
      'boolean',
    ]);
    const errorName = knownErrorNames.has(rawErrorName) ? rawErrorName : 'CustomError';

    let category = 'unknown';
    if (normalized.includes('network') || normalized.includes('fetch')) category = 'network';
    else if (normalized.includes('cors') || normalized.includes('origin')) category = 'origin';
    else if (normalized.includes('auth') || normalized.includes('unauthorized'))
      category = 'authorization';
    else if (normalized.includes('security')) category = 'security';
    else if (normalized.includes('syntax')) category = 'syntax';
    else if (normalized.includes('reference')) category = 'reference';
    else if (normalized.includes('typeerror') || normalized.includes('type error'))
      category = 'type';

    return {
      category,
      errorName,
      messageLength: message.length,
    };
  }

  function escapeAttributeValue(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\a ');
  }

  function findConfiguredTarget() {
    if (!globalScope.document) return null;

    if (currentConfig.targetSelector) {
      try {
        const selectedTarget = globalScope.document.querySelector(currentConfig.targetSelector);
        if (selectedTarget) return selectedTarget;
      } catch {
        // Invalid optional selectors are ignored without being retained in the report.
      }
    }

    if (!currentConfig.objectId) return null;

    const escaped = escapeAttributeValue(currentConfig.objectId);
    const selectors = [
      `[data-object-id="${escaped}"]`,
      `[data-qid="${escaped}"]`,
      `[data-objectid="${escaped}"]`,
      `[object-id="${escaped}"]`,
      `[data-tid="${escaped}"]`,
      `[tid="${escaped}"]`,
      `[id="${escaped}"]`,
    ];

    for (const selector of selectors) {
      try {
        const target = globalScope.document.querySelector(selector);
        if (target) return target;
      } catch {
        // Ignore a malformed selector and continue through safe attribute forms.
      }
    }

    return null;
  }

  function summarizeTarget(target = currentTarget) {
    if (!target) {
      return {
        found: false,
        connected: false,
      };
    }

    const rectangle = target.getBoundingClientRect();
    const style = globalScope.getComputedStyle?.(target);
    const hasRenderableDescendant = Boolean(target.querySelector?.('canvas, svg, iframe'));

    return {
      found: true,
      connected: target.isConnected,
      tagName: target.tagName?.toLowerCase() ?? null,
      width: Math.round(rectangle.width),
      height: Math.round(rectangle.height),
      hasArea: rectangle.width > 0 && rectangle.height > 0,
      hidden: Boolean(target.hidden),
      display: style?.display ?? null,
      visibility: style?.visibility ?? null,
      opacityZero: style?.opacity === '0',
      ariaBusy: target.getAttribute?.('aria-busy') === 'true',
      directChildCount: target.children?.length ?? 0,
      hasCanvas: Boolean(target.querySelector?.('canvas')),
      hasSvg: Boolean(target.querySelector?.('svg')),
      hasIframe: Boolean(target.querySelector?.('iframe')),
      hasRenderableDescendant,
      shadowRootPresent: Boolean(target.shadowRoot),
    };
  }

  function disconnectTargetObservers() {
    targetMutationObserver?.disconnect();
    intersectionObserver?.disconnect();
    resizeObserver?.disconnect();
    targetMutationObserver = null;
    intersectionObserver = null;
    resizeObserver = null;
  }

  function connectTargetObservers(target, expectedGeneration) {
    if (typeof globalScope.MutationObserver === 'function') {
      targetMutationObserver = new globalScope.MutationObserver((mutations) => {
        if (!isCurrentGeneration(expectedGeneration)) return;

        let addedNodeCount = 0;
        let removedNodeCount = 0;
        let attributeMutationCount = 0;
        for (const mutation of mutations) {
          addedNodeCount += mutation.addedNodes?.length ?? 0;
          removedNodeCount += mutation.removedNodes?.length ?? 0;
          if (mutation.type === 'attributes') attributeMutationCount += 1;
        }

        appendEvent(
          'target-mutation-batch',
          {
            mutationCount: mutations.length,
            addedNodeCount,
            removedNodeCount,
            attributeMutationCount,
            target: summarizeTarget(target),
          },
          expectedGeneration,
        );
      });
      targetMutationObserver.observe(target, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-busy'],
      });
    }

    if (typeof globalScope.IntersectionObserver === 'function') {
      intersectionObserver = new globalScope.IntersectionObserver((entries) => {
        if (!isCurrentGeneration(expectedGeneration)) return;
        for (const entry of entries) {
          appendEvent(
            'target-intersection',
            {
              isIntersecting: entry.isIntersecting,
              intersectionRatio: Math.round(entry.intersectionRatio * 1000) / 1000,
              width: Math.round(entry.boundingClientRect.width),
              height: Math.round(entry.boundingClientRect.height),
            },
            expectedGeneration,
          );
        }
      });
      intersectionObserver.observe(target);
    }

    if (typeof globalScope.ResizeObserver === 'function') {
      resizeObserver = new globalScope.ResizeObserver((entries) => {
        if (!isCurrentGeneration(expectedGeneration)) return;
        for (const entry of entries) {
          appendEvent(
            'target-resize',
            {
              width: Math.round(entry.contentRect.width),
              height: Math.round(entry.contentRect.height),
            },
            expectedGeneration,
          );
        }
      });
      resizeObserver.observe(target);
    }
  }

  function refreshTargetBinding(expectedGeneration) {
    if (!isCurrentGeneration(expectedGeneration)) return;
    const nextTarget = findConfiguredTarget();
    if (nextTarget === currentTarget) return;

    disconnectTargetObservers();
    currentTarget = nextTarget;
    appendEvent(
      nextTarget ? 'target-found' : 'target-lost',
      {
        target: summarizeTarget(nextTarget),
      },
      expectedGeneration,
    );

    if (nextTarget) connectTargetObservers(nextTarget, expectedGeneration);
  }

  function observeDom(expectedGeneration) {
    if (typeof globalScope.MutationObserver !== 'function' || !globalScope.document) return;

    documentMutationObserver = new globalScope.MutationObserver((mutations) => {
      if (!isCurrentGeneration(expectedGeneration)) return;
      let addedNodeCount = 0;
      let removedNodeCount = 0;

      for (const mutation of mutations) {
        addedNodeCount += mutation.addedNodes?.length ?? 0;
        removedNodeCount += mutation.removedNodes?.length ?? 0;
      }

      refreshTargetBinding(expectedGeneration);
      appendEvent(
        'document-child-list-batch',
        {
          mutationCount: mutations.length,
          addedNodeCount,
          removedNodeCount,
          targetFound: Boolean(currentTarget),
        },
        expectedGeneration,
      );
    });

    const root = globalScope.document.documentElement;
    if (root) {
      documentMutationObserver.observe(root, {
        subtree: true,
        childList: true,
      });
    }

    refreshTargetBinding(expectedGeneration);
  }

  function observeWindowEvents(expectedGeneration) {
    const handleWindowError = (event) => {
      appendEvent(
        'javascript-error',
        {
          error: classifyError(event.error ?? event.message),
          source: event.filename ? sanitizeUrl(event.filename) : null,
          line: Number.isFinite(event.lineno) ? event.lineno : null,
          column: Number.isFinite(event.colno) ? event.colno : null,
        },
        expectedGeneration,
      );
    };
    const handleUnhandledRejection = (event) => {
      appendEvent(
        'unhandled-rejection',
        {
          error: classifyError(event.reason),
        },
        expectedGeneration,
      );
    };
    const handleVisibilityChange = () => {
      appendEvent(
        'page-visibility',
        {
          state: globalScope.document?.visibilityState ?? 'unknown',
          target: summarizeTarget(),
        },
        expectedGeneration,
      );
    };

    windowEventHandlers = {
      handleWindowError,
      handleUnhandledRejection,
      handleVisibilityChange,
    };
    globalScope.addEventListener('error', handleWindowError, true);
    globalScope.addEventListener('unhandledrejection', handleUnhandledRejection);
    globalScope.document?.addEventListener('visibilitychange', handleVisibilityChange);
  }

  function stopObservingWindowEvents() {
    if (!windowEventHandlers) return;
    globalScope.removeEventListener('error', windowEventHandlers.handleWindowError, true);
    globalScope.removeEventListener(
      'unhandledrejection',
      windowEventHandlers.handleUnhandledRejection,
    );
    globalScope.document?.removeEventListener(
      'visibilitychange',
      windowEventHandlers.handleVisibilityChange,
    );
    windowEventHandlers = null;
  }

  function patchFetch() {
    if (typeof globalScope.fetch !== 'function') return;

    const patchGeneration = runGeneration;
    const fetchImplementation = globalScope.fetch;
    originalFetch = fetchImplementation;
    patchedFetch = async function qlikG5ObservedFetch(input, init) {
      const started = monotonicNow();
      const requestUrl = sanitizeUrl(
        typeof input === 'string' || input instanceof globalScope.URL ? input : input?.url,
      );
      const method = truncateMethod(init?.method ?? input?.method ?? 'GET');

      try {
        const response = await fetchImplementation.apply(this, arguments);
        appendEvent(
          'fetch-complete',
          {
            method,
            request: requestUrl,
            status: response.status,
            ok: response.ok,
            redirected: response.redirected,
            responseType: response.type,
            durationMs: roundMilliseconds(monotonicNow() - started),
          },
          patchGeneration,
        );
        return response;
      } catch (error) {
        appendEvent(
          'fetch-failed',
          {
            method,
            request: requestUrl,
            durationMs: roundMilliseconds(monotonicNow() - started),
            error: classifyError(error),
          },
          patchGeneration,
        );
        throw error;
      }
    };

    globalScope.fetch = patchedFetch;
  }

  function patchXmlHttpRequest() {
    const xhrPrototype = globalScope.XMLHttpRequest?.prototype;
    if (!xhrPrototype) return;

    const patchGeneration = runGeneration;
    const xhrOpenImplementation = xhrPrototype.open;
    const xhrSendImplementation = xhrPrototype.send;
    originalXhrOpen = xhrOpenImplementation;
    originalXhrSend = xhrSendImplementation;

    patchedXhrOpen = function qlikG5ObservedXhrOpen(method, url) {
      xhrMetadata.set(this, {
        generation: patchGeneration,
        method: truncateMethod(method),
        request: sanitizeUrl(url),
      });
      return xhrOpenImplementation.apply(this, arguments);
    };

    patchedXhrSend = function qlikG5ObservedXhrSend() {
      const baseMetadata = xhrMetadata.get(this) ?? {
        generation: patchGeneration,
        method: 'UNKNOWN',
        request: sanitizeUrl(''),
      };
      const requestGeneration = baseMetadata.generation;
      const started = monotonicNow();
      let outcome = 'load';

      const markError = () => {
        outcome = 'error';
      };
      const markAbort = () => {
        outcome = 'abort';
      };
      const markTimeout = () => {
        outcome = 'timeout';
      };
      const handleLoadEnd = () => {
        this.removeEventListener('error', markError);
        this.removeEventListener('abort', markAbort);
        this.removeEventListener('timeout', markTimeout);
        appendEvent(
          'xhr-complete',
          {
            method: baseMetadata.method,
            request: baseMetadata.request,
            status: Number.isFinite(this.status) ? this.status : null,
            outcome,
            durationMs: roundMilliseconds(monotonicNow() - started),
          },
          requestGeneration,
        );
      };

      this.addEventListener('error', markError, { once: true });
      this.addEventListener('abort', markAbort, { once: true });
      this.addEventListener('timeout', markTimeout, { once: true });
      this.addEventListener('loadend', handleLoadEnd, { once: true });
      try {
        return xhrSendImplementation.apply(this, arguments);
      } catch (error) {
        this.removeEventListener('error', markError);
        this.removeEventListener('abort', markAbort);
        this.removeEventListener('timeout', markTimeout);
        this.removeEventListener('loadend', handleLoadEnd);
        appendEvent(
          'xhr-send-failed',
          {
            method: baseMetadata.method,
            request: baseMetadata.request,
            durationMs: roundMilliseconds(monotonicNow() - started),
            error: classifyError(error),
          },
          requestGeneration,
        );
        throw error;
      }
    };

    xhrPrototype.open = patchedXhrOpen;
    xhrPrototype.send = patchedXhrSend;
  }

  function restoreNetworkGlobals() {
    if (patchedFetch && globalScope.fetch === patchedFetch && originalFetch) {
      globalScope.fetch = originalFetch;
    }

    const xhrPrototype = globalScope.XMLHttpRequest?.prototype;
    if (xhrPrototype && xhrPrototype.open === patchedXhrOpen && originalXhrOpen) {
      xhrPrototype.open = originalXhrOpen;
    }
    if (xhrPrototype && xhrPrototype.send === patchedXhrSend && originalXhrSend) {
      xhrPrototype.send = originalXhrSend;
    }

    originalFetch = null;
    patchedFetch = null;
    originalXhrOpen = null;
    originalXhrSend = null;
    patchedXhrOpen = null;
    patchedXhrSend = null;
  }

  function observeResourceTiming(expectedGeneration) {
    if (!currentConfig.observeResources || typeof globalScope.PerformanceObserver !== 'function') {
      return;
    }

    performanceObserver = new globalScope.PerformanceObserver((list) => {
      if (!isCurrentGeneration(expectedGeneration)) return;
      for (const entry of list.getEntries()) {
        appendEvent(
          'resource-timing',
          {
            resource: sanitizeUrl(entry.name),
            initiatorType: entry.initiatorType || 'unknown',
            durationMs: roundMilliseconds(entry.duration),
            transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
            encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
            decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
            protocol: entry.nextHopProtocol || null,
            responseStatus: Number.isFinite(entry.responseStatus) ? entry.responseStatus : null,
          },
          expectedGeneration,
        );
      }
    });

    try {
      performanceObserver.observe({ type: 'resource', buffered: true });
    } catch {
      performanceObserver.observe({ entryTypes: ['resource'] });
    }
  }

  function summarizeEventTypes() {
    return events.reduce(
      (summary, event) => ({
        ...summary,
        [event.type]: (summary[event.type] ?? 0) + 1,
      }),
      {},
    );
  }

  function createSnapshot() {
    const snapshot = {
      schemaVersion: 2,
      observer: API_NAME,
      running: isRunning,
      generation: runGeneration,
      startedAt: startedAtIso,
      capturedAt: new Date().toISOString(),
      elapsedMs: startedAtIso ? roundMilliseconds(elapsedMilliseconds()) : null,
      page: {
        visibilityState: globalScope.document?.visibilityState ?? null,
        embedded: globalScope.top !== globalScope,
      },
      configuration: {
        targetConfigured: Boolean(currentConfig.objectId || currentConfig.targetSelector),
        objectIdConfigured: Boolean(currentConfig.objectId),
        targetSelectorConfigured: Boolean(currentConfig.targetSelector),
        maxEvents: currentConfig.maxEvents,
        observeNetwork: currentConfig.observeNetwork,
        observeResources: currentConfig.observeResources,
      },
      target: summarizeTarget(),
      eventCount: events.length,
      eventTypes: summarizeEventTypes(),
      events,
      privacy: {
        domTextCaptured: false,
        qlikValuesCaptured: false,
        bodiesCaptured: false,
        headersCaptured: false,
        cookiesOrStorageCaptured: false,
        websocketFramesCaptured: false,
        rawPathnamesCaptured: false,
        urlQueriesCaptured: false,
        errorMessagesCaptured: false,
      },
    };

    return JSON.parse(JSON.stringify(snapshot));
  }

  function start(options = {}) {
    if (isRunning) {
      globalScope.console.warn(
        '[QlikG5Observer] Already running. Stop it before changing configuration.',
      );
      return createSnapshot();
    }

    currentConfig = createConfig(options);
    events = [];
    sequence = 0;
    currentTarget = null;
    startedAtIso = new Date().toISOString();
    startedAtMonotonic = monotonicNow();
    runGeneration += 1;
    const expectedGeneration = runGeneration;
    isRunning = true;

    appendEvent(
      'observer-started',
      {
        targetConfigured: Boolean(currentConfig.objectId || currentConfig.targetSelector),
        networkObservationEnabled: currentConfig.observeNetwork,
      },
      expectedGeneration,
    );
    observeWindowEvents(expectedGeneration);
    observeDom(expectedGeneration);
    if (currentConfig.observeNetwork) {
      patchFetch();
      patchXmlHttpRequest();
    }
    observeResourceTiming(expectedGeneration);

    globalScope.console.warn(
      '[QlikG5Observer] Recording metadata only. Reproduce the retained-object issue, then run QlikG5Observer.snapshot(), QlikG5Observer.export(), and QlikG5Observer.stop().',
    );
    if (!currentConfig.objectId && !currentConfig.targetSelector) {
      globalScope.console.warn(
        '[QlikG5Observer] No objectId configured. DOM activity is recorded, but target-specific visibility/render signals are unavailable. Stop and restart with { objectId: "..." } to enable them.',
      );
    }
    if (!currentConfig.observeNetwork) {
      globalScope.console.warn(
        '[QlikG5Observer] Active fetch/XHR wrapping is off by default. Restart with { observeNetwork: true } only when HTTP status/timing correlation is needed.',
      );
    }

    return createSnapshot();
  }

  function stop() {
    if (!isRunning) {
      globalScope.console.warn('[QlikG5Observer] Already stopped.');
      return createSnapshot();
    }

    appendEvent('observer-stopped', {
      target: summarizeTarget(),
    });
    documentMutationObserver?.disconnect();
    performanceObserver?.disconnect();
    disconnectTargetObservers();
    stopObservingWindowEvents();
    restoreNetworkGlobals();
    documentMutationObserver = null;
    performanceObserver = null;
    currentTarget = null;
    isRunning = false;

    globalScope.console.warn(
      '[QlikG5Observer] Stopped and restored patched browser globals. Events remain available through snapshot() or export().',
    );
    return createSnapshot();
  }

  function exportReport() {
    const report = createSnapshot();
    const json = JSON.stringify(report, null, 2);

    if (globalScope.document && typeof globalScope.Blob === 'function') {
      const blob = new globalScope.Blob([json], { type: 'application/json' });
      const objectUrl = globalScope.URL.createObjectURL(blob);
      const link = globalScope.document.createElement('a');
      const timestamp = new Date().toISOString().replaceAll(':', '-');
      link.href = objectUrl;
      link.download = `qlik-g5-observer-${timestamp}.json`;
      link.style.display = 'none';
      globalScope.document.body?.append(link);
      link.click();
      link.remove();
      globalScope.setTimeout(() => globalScope.URL.revokeObjectURL(objectUrl), 0);
    }

    globalScope.console.warn(
      '[QlikG5Observer] Sanitized JSON report downloaded. The JSON string is also the return value.',
    );
    return json;
  }

  const api = Object.freeze({
    installationMarker: INSTALLATION_MARKER,
    start,
    snapshot: createSnapshot,
    stop,
    export: exportReport,
  });

  Object.defineProperty(globalScope, API_NAME, {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(globalScope, API_ALIAS, {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });

  const initialOptions =
    globalScope[OPTIONS_NAME] && typeof globalScope[OPTIONS_NAME] === 'object'
      ? globalScope[OPTIONS_NAME]
      : {};
  start(initialOptions);
})();
