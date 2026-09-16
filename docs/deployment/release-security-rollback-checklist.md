# Release, security, and rollback checklist

Apply this checklist to an exact release artifact and deployment target. Blank
items are pending. An offline check can complete the repository gate without
completing live acceptance. Detailed procedures are in
[production operations](../runbooks/production-operations.md).

## Repository and artifact

- [ ] Reviewed source commit and scoped diff; no private configuration or raw diagnostics.
- [ ] Pinned toolchain and lockfile installation; `npm run release:check` passes.
- [ ] Reproducible package/startup smoke and ARM64 container smoke pass.
- [ ] Dependency findings reviewed; exact package checksum and image digest recorded.
- [ ] Exact commit passes remote CI after repository hosting is configured.
- [ ] Change notes, configuration guidance, and recovery compatibility reviewed.

## Deployment and live target

- [ ] Exact AWS/Qlik target and least-privileged identities configured privately.
- [ ] Generated configuration/diff reviewed; no secrets in environment or artifacts.
- [ ] Endpoint/image version, MMDSv2, scoped IAM, state retention/recovery, and logs verified.
- [ ] JWT negative cases, actor isolation, separate review, and profile boundaries pass.
- [ ] Fresh-session MCP/readiness checks and durable cross-session state checks pass.
- [ ] Native read/preview/write/verify and browser identity checks pass for enabled actions.
- [ ] Same-key replay, competing dispatch, failure handling, and uncertain outcomes checked.
- [ ] Exact-resource cleanup is proven and the unrelated baseline is preserved.
- [ ] Representative capacity, provider limits, expiry, and storage behavior checked.

## Operations and recovery

- [ ] Service/incident owners, alert delivery, and restricted evidence retention established.
- [ ] Secret rotation and access-review procedures exercised.
- [ ] Previous accepted image/configuration retained and application rollback rehearsed.
- [ ] Durable-state recovery reconciles actual Qlik effects before writes resume.
- [ ] Known limitations and skipped/failed checks are explicit in the release record.

Keep live environment identifiers, credentials, raw data, and detailed incident
records in the restricted operations system. The
[readiness register](readiness-register.md) contains only sanitized rehearsal
summaries and does not authorize production access by itself.
