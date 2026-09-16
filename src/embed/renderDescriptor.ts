import type { RenderDescriptor } from '../domain/types.js';

/**
 * Maps a sanitized `RenderDescriptor` to the attributes a browser would pass
 * to Qlik's `qlik-embed` custom element (see docs/06-native-visualization-contract.md
 * and docs/runbooks/qlik-embed-browser-auth.md). This module never renders
 * anything itself, never touches browser storage/cookies, and never accepts
 * or emits a credential: the browser must independently establish its own
 * authenticated Qlik session (OAuth/interactive login for Cloud, or the
 * approved virtual-proxy session for client-managed Windows) before using
 * these attributes. See examples/qlik-embed for a fully commented example
 * page and README.md ("qlik-embed browser rendering") for the real-tenant
 * blocker this repository cannot resolve on its own.
 */
export interface QlikEmbedAttributes {
  readonly ui: 'analytics/chart';
  readonly 'app-id': string;
  readonly 'object-id': string;
  readonly theme: 'Sense Horizon';
  readonly iframe: 'true';
  readonly preview: 'true';
}

export function toQlikEmbedAttributes(descriptor: RenderDescriptor): QlikEmbedAttributes {
  if (descriptor.rendering !== 'qlik-embed') {
    throw new Error(`Unsupported rendering mode "${descriptor.rendering}".`);
  }
  return {
    ui: 'analytics/chart',
    'app-id': descriptor.appId,
    'object-id': descriptor.objectId,
    theme: 'Sense Horizon',
    iframe: 'true',
    preview: 'true',
  };
}
