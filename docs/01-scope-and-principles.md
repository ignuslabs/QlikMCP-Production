# Scope and Principles

**Related:** [Index](00-index.md), [Architecture](03-reference-architecture.md), [Visualization contract](06-native-visualization-contract.md)

## Problem Statement

Build a controlled integration that lets an AI agent discover, plan, preview, and, after approval, create **native Qlik visualizations** in Qlik Cloud and client-managed Qlik Sense. It exposes one intentional tool surface to MCP hosts and other AI runtimes while using each Qlik deployment's correct APIs.

"Native Qlik visualization" means a chart represented by a Qlik application object and evaluated by the Qlik Associative Engine. The harness is not a generic chart-image generator and must not replace Qlik's calculation engine with an extracted data copy.

## Goals

1. Discover only the app metadata authorized for the effective Qlik identity.
2. Translate a request into a constrained, reviewable chart intent.
3. Preview a native object before persistence whenever feasible.
4. Persist charts and sheet placement only after policy and user approval.
5. Render through supported Qlik tooling.
6. Use the same logical operations for MCP, Copilot, Foundry, Bedrock, and other hosts.
7. Audit the caller, effective Qlik identity, plan, approval, Qlik result, and correlation IDs.

## Scope boundaries

- App/dataset lifecycle, updates, deletes, exports, reloads, scripts, publishing,
  and sharing require the separately configured management policy; core chart
  permissions never imply those grants.
- Arbitrary QIX, tenant security rules, data-connection administration, and custom
  visualization/extension generation are outside the implemented contract.
- Bypassing space roles, Section Access/data reduction, proxy policy, or tenant policy.
- Automated production publishing without confirmation.
- Assuming Cloud and client-managed APIs are interchangeable.
- Sending full app data, secrets, or hidden metadata to a third-party model by default.

## Principles

### Qlik owns calculations and access

QIX is Qlik's direct WebSocket JSON-RPC API for Sense apps and the Associative Engine. The harness requests Qlik layouts/data pages rather than independently calculating charts. See [QIX JSON-RPC](https://qlik.dev/apis/json-rpc/).

### Intent is not a property tree

The model supplies a small `ChartIntent`, such as "monthly revenue by region as a bar chart." The harness resolves fields and measures against live metadata, validates the intent, and compiles target/version-specific properties. Model output is never authoritative for object IDs, handles, or raw QIX methods.

### Plan, preview, apply

```text
DRAFT -> VALIDATED -> PLANNED -> PREVIEWED -> APPROVED -> APPLIED -> VERIFIED
                                      |                       |
                                      +------ REJECTED -------+
```

Discovery and planning operate within explicit policy. Core chart persistence
requires an independently approved plan. Complete-sheet generation uses a
bounded actor/app grant. Optional management uses immutable ordered plans and
requires separate review when specified by the grant. Every path rechecks its
current authorization and verifies the provider result; one path cannot bypass
the restrictions of another.

### Identity stays end to end

The harness records the calling identity but independently obtains the appropriate Qlik credential. It must not forward an MCP bearer token to Qlik. Use an approved user-aware flow when Qlik must enforce a user's data rights and a least-privileged workload identity for service automation.

### Native first

Choose a standard Qlik chart whenever it can represent the requested analysis. nebula.js custom visualizations and Qlik extensions are deferred; they require an explicit scope expansion plus separate compatibility and security review.

## Terms

| Term                    | Meaning                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| Chart intent            | Provider-neutral description of the intended analysis.                     |
| Change plan             | Fully resolved proposed Qlik mutation with a readable diff and risk level. |
| Preview                 | Non-persisted or isolated native Qlik object and evaluated layout.         |
| Effective Qlik identity | Identity under which Qlik evaluates app access and data reduction.         |
| Control plane           | Discovery, policy, creation, lifecycle, and audit operations.              |
| Rendering plane         | Browser rendering and interaction with the native object.                  |

## Deployment boundary

The maintained deployment is Qlik Cloud through Amazon Bedrock AgentCore.
Provider-neutral and Windows adapter code is retained, but AgentCore rejects
Windows mode. Default examples use fixtures and deny live mutations. See the
[MCP contract](08-mcp-server-contract.md), [management guide](management.md), and
[production operations](runbooks/production-operations.md) for current scope
and target-specific acceptance.

## Sources

- [Qlik MCP server workflows](https://help.qlik.com/en-US/cloud-services/Subsystems/Hub/Content/Sense_Hub/QlikMCP/Qlik-MCP-server.htm)
- [Qlik REST APIs](https://qlik.dev/apis/rest/)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
