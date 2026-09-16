#!/bin/sh

set -eu
umask 077

fail() {
  printf '%s\n' "Secure Node storage launcher: $1" >&2
  exit 1
}

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) ||
  fail 'Unable to resolve the launcher directory.'
repository_root=$(CDPATH= cd -- "$script_directory/../.." && pwd -P) ||
  fail 'Unable to resolve the repository root.'

node_binary=
if [ "${1:-}" = '--node' ]; then
  [ "$#" -ge 3 ] || fail 'Usage: run-node-with-secure-storage.sh [--node /absolute/node] script [args ...].'
  node_binary=$2
  shift 2
else
  [ "$#" -ge 1 ] || fail 'Usage: run-node-with-secure-storage.sh [--node /absolute/node] script [args ...].'
  node_binary=$(command -v node 2>/dev/null || true)
fi

case "$node_binary" in
  /*) ;;
  *) fail 'The Node.js executable must resolve to an absolute path.' ;;
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

cd "$repository_root"
storage_directory="$repository_root/.qlik-ai-harness"
storage_file="$storage_directory/node-localstorage.json"

if [ -L "$storage_directory" ]; then
  fail 'The local Node state directory must not be a symbolic link.'
fi
if [ -e "$storage_directory" ]; then
  [ -d "$storage_directory" ] || fail 'The local Node state path must be a directory.'
else
  mkdir "$storage_directory" || fail 'Unable to create the local Node state directory.'
fi
chmod 700 "$storage_directory" || fail 'Unable to protect the local Node state directory.'

for state_file in "$storage_file" "$storage_file-wal" "$storage_file-shm"; do
  if [ -L "$state_file" ]; then
    fail 'A local Node state file must be a regular, non-symlink file.'
  fi
  if [ -e "$state_file" ]; then
    [ -f "$state_file" ] || fail 'A local Node state file must be a regular, non-symlink file.'
    chmod 600 "$state_file" || fail 'Unable to protect a local Node state file.'
  fi
done

# The repo-relative path avoids NODE_OPTIONS parsing and keeps all persistent
# Node state inside the protected repository-local directory.
exec "$node_binary" --localstorage-file=.qlik-ai-harness/node-localstorage.json "$@"
