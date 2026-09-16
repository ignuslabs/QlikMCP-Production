import path from 'node:path';

// Used by both repository and tarball checks, including force-added ignored files.
export function privateMaterialReason(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const segments = normalized.split('/');
  const basename = segments.at(-1);
  if (
    segments.some((segment) =>
      ['.qlik-ai-harness', '.aws', '.ssh', '.local', 'artifacts', 'reports'].includes(segment),
    ) ||
    normalized.startsWith('agentcore/') ||
    normalized.startsWith('docs/evidence/') ||
    (normalized.startsWith('docs/logs/') && normalized !== 'docs/logs/README.md')
  ) {
    return 'local runtime state, deployment output, or historical evidence';
  }
  if (
    (basename.startsWith('.env') && basename !== '.env.example') ||
    normalized === '.mcp.json' ||
    normalized === '.codex/config.toml' ||
    /^config\/(?:connections|management|agentcore-deployment)\.json$/u.test(normalized) ||
    (/^infra\/aws\/.*\.parameters\.json$/u.test(normalized) &&
      !normalized.endsWith('.parameters.example.json'))
  ) {
    return 'private machine or deployment configuration';
  }
  if (/\.(?:har|key|netlog|p12|pcap|pcapng|pem|pfx|saz|txtog|websocket)$/iu.test(normalized)) {
    return 'raw diagnostic or credential artifact extension';
  }
  return undefined;
}
