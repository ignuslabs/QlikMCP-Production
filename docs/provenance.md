# Source provenance

This repository was created on 2026-09-16 from the `amazon-bedrock-agentcore`
working directory in the local QlikAIHarness project. It is a separate repository
for maintaining the Qlik MCP production release candidate.

The source project's parent Git HEAD was `78014f2`. The standalone directory was
untracked there and included local uncommitted work, including the feature-test
repairs described in the [changelog](../CHANGELOG.md). The parent commit alone
cannot reproduce this import and must not be presented as the imported source
revision. The first commit in this repository records the sanitized imported
content together with its production-maintenance cleanup.

The import preserves the application package name, CLI names, environment
variable names, tool contracts, and compatible source structure. It starts a
fresh Git history; the original project and its deployment are independent.
No Git remote, repository owner identity, public distribution license, or
production target is inferred from this copy.

## Excluded environment material

The copy excludes credentials, local environment files, live connection and
deployment configuration, generated AgentCore/AWS state, caches, dependencies,
build output, browser recordings, artifacts, and historical evidence files.
Synthetic configuration examples, deterministic fixtures, implementation, and
maintainable runbooks remain.

Historical personal deployment instructions and development backlog snapshots
were removed. They contained environment-specific routing or time-limited
status and would not be valid operating instructions for an independent repo.

## Evidence boundary

The imported repairs address table-preview header alignment, native chart sort
order, terminal reload handling, and proven pre-dispatch lock release. The
original repair record reports local release checks plus limited live provider
read checks. It explicitly says those source repairs had not been deployed and
the full mutation acceptance had not been rerun.

An uncertain historical workflow and lock in the originating test environment
remain an incident owned by that environment. Copying code neither resolves
that incident nor authorizes a state change. The implementation intentionally
preserves uncertain records without a trusted receipt or rejection marker.

Validation of this repository must identify its own exact source/artifact.
Passing local checks, a container fixture smoke, hosted AWS acceptance, native
Qlik browser acceptance, and production promotion are distinct results. Use the
[production operations runbook](runbooks/production-operations.md) to record them.
