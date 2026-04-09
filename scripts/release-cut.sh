#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <version> [--tag]"
  exit 1
fi

version="$1"
tag_flag="${2:-}"

if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must look like v0.2.0"
  exit 1
fi

if [[ -n "$(git status --short)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before a release cut."
  exit 1
fi

bun run check:no-pai-leaks
bun run build
bun run typecheck
bun run test

if [[ -n "$(git status --short)" ]]; then
  echo "Build/test steps changed the working tree. Review and commit release artifacts before tagging."
  git status --short
  exit 1
fi

if [[ "$tag_flag" == "--tag" ]]; then
  git tag "$version"
  echo "Created tag $version"
else
  echo "Release verification completed for $version. No tag created."
fi
