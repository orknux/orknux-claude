#!/usr/bin/env bash
# Runs channel-check.ts in Bun's image: the plugin spawned over stdio, as Claude Code does, against a stub Orknux.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
docker run --rm -v "$HERE:/plugin:ro" oven/bun:1 sh -c 'cp -r /plugin /work && cd /work && bun install --no-summary >/dev/null 2>&1 && bun test/channel-check.ts'
