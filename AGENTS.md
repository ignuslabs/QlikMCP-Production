# Working on Qlik MCP

This is the independent production repository for the Qlik Cloud MCP server on
Amazon Bedrock AgentCore. Keep the package and executable names compatible with
existing clients. The sibling research workspace is a separate project.

## Development

- Use the Node version in `.nvmrc` and the npm version in `package.json`.
- Install from the committed lockfile with `npm ci`.
- Run focused regression tests for behavior changes, then `npm run release:check`.
- Run the container smoke test when changing the runtime, image, or dependencies.
- Keep examples disabled, scoped, and credential-free. Management requires explicit
  grants; do not enable production writes as an onboarding convenience.

## Safety and correctness

- Preserve independent approval, exact plan replay, current policy checks, and
  actor isolation. Unknown provider outcomes must remain blocked for reconciliation.
- Release a workflow lock only when a persisted, trusted outcome establishes that
  the owning step never dispatched or has completed safely. An error code alone
  is not proof that a write did not happen.
- Never commit `.env`, live deployment configuration, tokens, tenant exports,
  recordings, raw diagnostics, local state, or credentials. Security checks must
  identify file paths and rule names without printing matched values.
- Keep fixture tests, local container execution, hosted CI, deployed acceptance,
  and browser verification distinct in reports. Never promote old Trial evidence
  into current production acceptance.
- Update operational documentation when changing startup, configuration, packaging,
  recovery, or supported runtime versions. See `docs/00-index.md`.
