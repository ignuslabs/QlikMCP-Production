# Contributing to Qlik MCP

## Development

Use the pinned Node.js 22.23.2 and npm 10.9.8 toolchain.

```bash
nvm install
nvm use
npm ci --registry=https://registry.npmjs.org/
npm run demo:fixture
npm run check
```

All committed configuration is synthetic and default-deny. Use ignored private
configuration for actual routing and approved secret providers for credentials.
Never replace checked-in examples with tenant, account, identity, or secret values.

## Changes and review

Preserve strict schemas, bounded results, deterministic plans, current resource
scope checks, independent review where required, durable idempotency, and exact
resource cleanup. Document public contract changes in the MCP or management
guide and changelog. Add regression coverage for meaningful behavior changes;
do not weaken a failing assertion to pass the gate.

Pull requests should explain the concrete behavior change, relevant validation,
and remaining target-dependent risks. Security-sensitive and mutating changes
need independent review. No branch protection or remote CI status is implied by
local Git configuration; configure them when this repository is hosted.

## Verification and release

```bash
npm run release:check
git diff --check
```

The aggregate gate includes a packed-artifact startup smoke and local Markdown
link checks. The dependency advisory audit requires network access. Preserve
sanitized validation results with the exact commit and toolchain; rerun the gate
when the release content changes.

Cloud, Windows, browser, and hosted-service probes are separate opt-in exercises.
Use isolated synthetic resources in an explicitly scoped environment, preserve
the unrelated baseline, and verify cleanup. Fixture tests cannot certify live
permissions, rendered results, multi-instance behavior, or operational recovery.

Follow the [production operations runbook](docs/runbooks/production-operations.md)
and [release checklist](docs/deployment/release-security-rollback-checklist.md).
Release a reviewed commit and reproducible package/image, never a working-folder
archive containing ignored configuration or diagnostics.

The package remains private and `UNLICENSED`; no public distribution rights or
remote repository have been established by this import.

## Runtime pin maintenance

Update `.nvmrc`, the package engine constraint, container base, CI, and lockfile
validation together when adopting a Node security release. Validate package,
container, and protocol startup with the selected runtime. Node 22.23.2 is a
[security release](https://nodejs.org/en/blog/release/v22.23.2); retaining a major
version label alone does not keep the runtime patched.
