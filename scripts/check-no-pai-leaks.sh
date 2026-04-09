#!/usr/bin/env bash

set -euo pipefail

if [[ ! -d packages ]]; then
  echo "packages/ directory not found"
  exit 1
fi

pattern='Infrastructure/|Hooks/|Skills/|PAI/'

if rg -n "$pattern" packages README.md CHANGELOG.md docs config.sample.yaml; then
  echo
  echo "PAI-specific paths leaked into the reusable graphiti-ts surface."
  exit 1
fi

echo "No PAI-specific path leaks detected."
