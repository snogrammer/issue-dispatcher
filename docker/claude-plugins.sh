#!/bin/sh
# Install Claude Code plugins at image build time, user scope, for the
# dispatcher's headless runs. Arguments are plugin ids; the marketplaces they
# come from are in CLAUDE_MARKETPLACES (space-separated GitHub repos, URLs or
# paths), e.g.
#   CLAUDE_MARKETPLACES=anthropics/claude-plugins-official \
#     claude-plugins context7@claude-plugins-official
# No arguments, or the single argument "none", installs nothing. An unknown
# plugin or marketplace fails the build. See docs/plugins.md.
set -eu

if [ "$#" -eq 0 ] || [ "$*" = none ]; then
  echo "No Claude Code plugins to install"
  exit 0
fi

for marketplace in ${CLAUDE_MARKETPLACES:-}; do
  claude plugin marketplace add "$marketplace"
done
for plugin in "$@"; do
  claude plugin install "$plugin" --scope user
done
claude plugin list
