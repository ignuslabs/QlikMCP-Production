# Qlik MCP documentation

Qlik MCP is an independent production-maintained release candidate for the
Qlik Cloud and Amazon Bedrock AgentCore deployment path. Local quality checks,
container checks, hosted service acceptance, tenant acceptance, and production
promotion are separate evidence stages.

## Start and operate

| Document                                                               | Purpose                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [README](../README.md)                                                 | Local fixture start, capabilities, commands, and deployment entry point. |
| [Contributing](../CONTRIBUTING.md)                                     | Toolchain, change review, and reproducible verification.                 |
| [Security](../SECURITY.md)                                             | Trust, credentials, audit, and private reporting boundaries.             |
| [Source provenance](provenance.md)                                     | Import origin, compatibility, and historical evidence limits.            |
| [Configuration](../config/README.md)                                   | Synthetic examples, settings, and private configuration.                 |
| [Production operations](runbooks/production-operations.md)             | Release acceptance, monitoring, incidents, and rollback.                 |
| [AgentCore deployment](deployment/amazon-bedrock-agentcore.md)         | Foundation, runtime, MMDSv2, identity, and live acceptance.              |
| [Release checklist](deployment/release-security-rollback-checklist.md) | Source/artifact and target-specific release gates.                       |
| [Readiness register](deployment/readiness-register.md)                 | Template for sanitized target evidence.                                  |

## Contracts and workflows

| Document                                                                  | Purpose                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [MCP contract](08-mcp-server-contract.md)                                 | Core, sheet, and optional management tools.                  |
| [Management](management.md)                                               | Actions, exact policy, transfer, plans, and verification.    |
| [Management recovery](management-recovery.md)                             | Claims, receipts, uncertain writes, and safe reconciliation. |
| [Sheet visibility](management-sheet-visibility.md)                        | Private/shared/published sheet behavior.                     |
| [Capability and acceptance matrix](production-feature-plan.md)            | Implemented scope and required live evidence.                |
| [Sheet generation](runbooks/sheet-generation.md)                          | Bounded creation, native verification, and partial recovery. |
| [Approval lifecycle](runbooks/approval-operation-lifecycle.md)            | Single-chart independent review and apply.                   |
| [Local MCP hosts](runbooks/codex-project-mcp.md)                          | Requester/reviewer launch and local state.                   |
| [Target readiness intake](runbooks/target-readiness-intake.md)            | Administrator evidence and sanitized handoff.                |
| [Browser diagnostics](runbooks/g5-retained-object-browser-diagnostics.md) | Native rendering and exact-resource cleanup procedure.       |

## Architecture references

[Scope](01-scope-and-principles.md), [platform matrix](02-platform-support-matrix.md),
[architecture](03-reference-architecture.md), [Cloud adapter](04-qlik-cloud-integration.md),
[Windows adapter](05-client-managed-integration.md),
[native visualization contract](06-native-visualization-contract.md),
[Qlik libraries](07-library-and-api-selection.md), and
[security/provider adapters](09-security-operations-and-provider-adapters.md)
explain the implementation. Windows and non-AgentCore hosting references do not
establish a supported production deployment lane.

Product documentation links describe vendor interfaces. Repository code and
versioned tests define the implemented behavior. Every real target still needs
current identity, permissions, API compatibility, capacity, and recovery evidence.
