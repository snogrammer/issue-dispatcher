#!/bin/sh
# Install language versions with asdf at image build time and make them the
# defaults (in ~/.tool-versions). Arguments are "tool version" pairs, e.g.
#   asdf-preload python latest:3.12 ruby latest:3.3
# Node stays on the image's own (system) Node unless a pair names nodejs.
set -eu

asdf plugin add nodejs
asdf plugin add python
asdf plugin add ruby

defaults="nodejs system"
while [ "$#" -ge 2 ]; do
  tool=$1 version=$2
  shift 2
  asdf plugin add "$tool" 2>/dev/null || true
  asdf install "$tool" "$version"
  case "$version" in
    latest:*) version=$(asdf latest "$tool" "${version#latest:}") ;;
  esac
  case "$tool" in
    nodejs) defaults=$(printf '%s\n' "$defaults" | grep -v '^nodejs ' || true) ;;
  esac
  defaults=$(printf '%s\n%s %s' "$defaults" "$tool" "$version")
done
printf '%s\n' "$defaults" | sed '/^$/d' >"$HOME/.tool-versions"
asdf reshim
echo "asdf defaults:" && cat "$HOME/.tool-versions"
