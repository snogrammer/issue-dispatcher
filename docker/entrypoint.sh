#!/bin/sh
# Container entrypoint (runs under tini). Bind mounts that Docker created on
# first deploy are owned by root, which uid 10001 can't write to. Started as
# root, this takes ownership of the data and workspace directories, then drops
# to the unprivileged user before running the dispatcher. Started as any other
# user (e.g. `user: 10001` in compose), it just runs the command.
set -eu

# Repos that pin no version use the default in ~/.tool-versions. An image
# built without preloaded toolchains (ASDF_PRELOAD=none, the published
# default) has none, so default to the newest Python and Ruby already in the
# toolchains volume.
default_toolchains() {
  file="$HOME/.tool-versions"
  for tool in python ruby; do
    if grep -q "^$tool " "$file" 2>/dev/null; then continue; fi
    latest=$(ls "${ASDF_DATA_DIR:-/toolchains}/installs/$tool" 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$latest" ]; then printf '%s %s\n' "$tool" "$latest" >>"$file"; fi
  done
}

if [ "$(id -u)" = 0 ]; then
  for dir in "${DATA_DIR:-/data}" "${WORKSPACE_DIR:-/workspaces}" "${ASDF_DATA_DIR:-/toolchains}"; do
    mkdir -p "$dir"
    # Only the top level is checked, so restarts with large workspaces stay fast.
    if [ "$(stat -c %u "$dir")" != 10001 ]; then
      echo "Taking ownership of $dir for uid 10001" >&2
      chown -R 10001:10001 "$dir"
    fi
  done
  # Docker set HOME for root; Claude Code and git keep their state under it.
  export HOME=/home/dispatcher USER=dispatcher LOGNAME=dispatcher
  default_toolchains
  if [ -f "$HOME/.tool-versions" ]; then chown 10001:10001 "$HOME/.tool-versions"; fi
  exec setpriv --reuid=10001 --regid=10001 --init-groups -- "$@"
fi

if [ -n "${HOME:-}" ] && [ -w "$HOME" ]; then default_toolchains; fi
exec "$@"
