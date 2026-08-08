#!/bin/bash
# Block skill usage when gstack is not installed in this project.

_PROJ="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

if [ ! -d "$_PROJ/.claude/skills/gstack/bin" ]; then
  cat >&2 <<'MSG'
BLOCKED: gstack is not installed in this project.

gstack is required for AI-assisted work in this repo.

Install it (project-level):
  git clone --depth 1 https://github.com/garrytan/gstack.git .claude/skills/gstack
  cd .claude/skills/gstack && ./setup

Then restart your AI coding tool.
MSG
  echo '{"permissionDecision":"deny","message":"gstack is required but not installed. See stderr for install instructions."}'
  exit 0
fi

echo '{}'
