# Library and API Selection

**Related:** [Visualization contract](06-native-visualization-contract.md), [Cloud](04-qlik-cloud-integration.md), [Client-managed](05-client-managed-integration.md)

## Decision Summary

Use `qlik-embed` for standard browser rendering and `@qlik/api` for the implemented Cloud REST/QIX and client-managed Engine session paths. Keep enigma.js as a separately evaluated lower-level option rather than a current dependency. nebula.js is documented only as a future custom-visualization option; custom visualization work remains deferred unless scope is explicitly expanded. Raw QIX remains an adapter escape hatch, never a model-facing API.

## Selection Matrix

| Technology                      | Primary role                           | Use in harness                                                                  | Do not use as                                           |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `qlik-embed`                    | Qlik's primary embedding framework     | Render native objects in Cloud and client-managed UI.                           | Backend compiler or secret transport.                   |
| `@qlik/api`                     | REST, QIX, and auth JavaScript modules | Implement Cloud items/QIX and Windows Engine session paths.                     | Substitute for policy or authorization design.          |
| enigma.js                       | QIX/Engine session library             | Deferred lower-level transport alternative if target compatibility requires it. | Browser credential workaround or raw agent tool.        |
| nebula.js                       | Visualization integration              | Deferred future evaluation after explicit scope expansion.                      | Current tool or default native-chart persistence route. |
| Raw QIX JSON-RPC                | Underlying protocol                    | Adapter implementation and diagnostics.                                         | MCP schema.                                             |
| Capability APIs / `qlik-visual` | Existing browser/client-managed APIs   | Compatibility cases dictated by target.                                         | Default new embedding choice where qlik-embed works.    |
| Qlik MCP server                 | Qlik-hosted Cloud MCP                  | Direct Cloud workflows supported by Qlik.                                       | Guaranteed client-managed/custom-policy replacement.    |

## `qlik-embed`

Qlik describes `qlik-embed` as its primary embedding framework for Cloud and client-managed Sense. It preserves native selections, themes, and access enforcement in the user's session. Use documented OAuth/interactive patterns in Cloud and virtual-proxy/cookie patterns in client-managed deployments; never use a production API key in browser code.

## `@qlik/api`

Qlik documents `@qlik/api` as JavaScript modules for REST APIs, QIX, and authentication in browser and Node.js contexts. Its REST modules come from Cloud OpenAPI specifications and its QIX module supports Sense application interaction.

**Harness decision:** Use `@qlik/api` behind narrow Cloud and Windows adapter
boundaries. The concrete implementations are unit-tested, while live target
compatibility remains independently gated by G4/G5 and G6.

## enigma.js and nebula.js

enigma.js creates QIX sessions from a schema, WebSocket URL, and Node socket factory, with session lifecycle and interceptor support. Keep it behind an adapter that owns authentication, schema versioning, connection lifetime, retries, and handle cleanup.

nebula.js can render existing generic objects by ID or create/render registered types. Qlik recommends considering qlik-embed for easier embedding. The current implementation exposes no nebula/custom-visualization feature. If scope is expanded later, register types at build time and never let a model dynamically load arbitrary plugins.

## Pattern

```text
MCP tool -> ChartIntent -> compiler -> QIX adapter -> native generic object -> GetLayout
Browser UI -> qlik-embed -> native object rendering
Future scoped custom visual -> registered nebula.js type (not currently available)
```

## Sources

- [Qlik-embed overview](https://qlik.dev/embed/qlik-embed/)
- [Qlik API package](https://qlik.dev/toolkits/qlik-api/)
- [enigma.js API](https://qlik.dev/apis/javascript/enigma-js/)
- [nebula.js API](https://qlik.dev/apis/javascript/nebula-js/)
- [Windows API reference](https://help.qlik.com/en-US/sense-developer/May2026/Content/Sense_Helpsites/APIs-and-SDKs.htm)
