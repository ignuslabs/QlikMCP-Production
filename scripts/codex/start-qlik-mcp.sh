#!/bin/sh

set -eu
umask 077

fail() {
  printf '%s\n' "Qlik Codex MCP launcher: $1" >&2
  exit 1
}

role=${QLIK_CODEX_MCP_ROLE:-}
case "$role" in
  requester | reviewer) ;;
  *) fail 'QLIK_CODEX_MCP_ROLE must be requester or reviewer.' ;;
esac

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) ||
  fail 'Unable to resolve the launcher directory.'
repository_root=$(CDPATH= cd -- "$script_directory/../.." && pwd -P) ||
  fail 'Unable to resolve the repository root.'
entrypoint="$repository_root/dist/index.js"
secure_storage_launcher="$script_directory/run-node-with-secure-storage.sh"

[ -f "$entrypoint" ] ||
  fail 'dist/index.js is missing. Run npm run build before starting the MCP server.'
[ -x "$secure_storage_launcher" ] ||
  fail 'The secure Node storage launcher is missing or is not executable.'

node_binary=${QLIK_CODEX_NODE_BIN:-}
if [ -z "$node_binary" ]; then
  node_binary=$(command -v node 2>/dev/null || true)
fi
case "$node_binary" in
  /*) ;;
  *) fail 'QLIK_CODEX_NODE_BIN must resolve to an absolute Node.js executable path.' ;;
esac
[ -x "$node_binary" ] || fail 'The configured Node.js executable is not executable.'

node_version=$("$node_binary" --version 2>/dev/null) ||
  fail 'The configured Node.js executable did not report a version.'
node_semver=${node_version#v}
node_major=${node_semver%%.*}
node_remainder=${node_semver#*.}
node_minor=${node_remainder%%.*}
node_patch=${node_remainder#*.}
case "$node_major:$node_minor:$node_patch" in
  *[!0-9:]* | :* | *: | *::* ) fail 'The configured Node.js executable reported an invalid version.' ;;
esac
[ "$node_major" -eq 22 ] || fail 'Node.js 22.23.2 or a later Node.js 22 patch release is required.'
if [ "$node_minor" -lt 23 ] || { [ "$node_minor" -eq 23 ] && [ "$node_patch" -lt 2 ]; }; then
  fail 'Node.js 22.23.2 or a later Node.js 22 patch release is required.'
fi

case "$role" in
  requester)
    actor=${QLIK_CODEX_MCP_ACTOR:-local-dev-actor}
    host_client_id=${QLIK_CODEX_MCP_HOST_CLIENT_ID:-codex-qlik-requester}
    keychain_account=${QLIK_CODEX_KEYCHAIN_ACCOUNT:-qlik-mcp-production-cloud}
    keychain_service=${QLIK_CODEX_KEYCHAIN_SERVICE:-qlik-mcp-production.oauth}

    [ -n "$keychain_account" ] || fail 'The Keychain account label is empty.'
    [ -n "$keychain_service" ] || fail 'The Keychain service label is empty.'

    # Never inherit shell tracing into the credential read. `security -w`
    # writes the password only to captured stdout; the launcher never echoes it.
    set +x
    qlik_oauth_secret=$(
      /usr/bin/security find-generic-password \
        -a "$keychain_account" \
        -s "$keychain_service" \
        -w
    ) || fail 'The Qlik OAuth secret is missing from or inaccessible in Keychain.'
    [ -n "$qlik_oauth_secret" ] || fail 'The Qlik OAuth secret in Keychain is empty.'
    export QLIK_CLOUD_OAUTH_CLIENT_SECRET="$qlik_oauth_secret"
    unset qlik_oauth_secret
    ;;
  reviewer)
    actor=${QLIK_CODEX_MCP_ACTOR:-local-dev-reviewer}
    host_client_id=${QLIK_CODEX_MCP_HOST_CLIENT_ID:-codex-qlik-reviewer}

    # Keep the reviewer process free of Qlik provider credentials even if a
    # future local .env accidentally contains one. dotenv does not override
    # variables that are already present in the process environment.
    export QLIK_CLOUD_OAUTH_CLIENT_SECRET=
    export QLIK_WINDOWS_PROXY_SESSION_JWT=
    export QLIK_WINDOWS_TRUSTED_BACKEND_PFX_BASE64=
    export QLIK_WINDOWS_TRUSTED_BACKEND_PFX_PASSPHRASE=
    export QLIK_WINDOWS_TRUSTED_BACKEND_USER_HEADER=
    ;;
esac

[ -n "$actor" ] || fail 'The MCP actor identity is empty.'
[ -n "$host_client_id" ] || fail 'The MCP host client identity is empty.'

export QLIK_HARNESS_ACTOR="$actor"
export QLIK_HARNESS_HOST_CLIENT_ID="$host_client_id"
export QLIK_HARNESS_MCP_ROLE="$role"

cd "$repository_root"
exec "$secure_storage_launcher" --node "$node_binary" "$entrypoint"
