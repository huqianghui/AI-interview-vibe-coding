#!/usr/bin/env bash
# Start every PostgreSQL flexible server in a resource group that is not running.
#
# Why: the subscription's administrators can stop the server (cost policy). While it is stopped
# every sign-in hangs and then fails, and /api/health still reports ok, so nothing else notices.
# The "DB keepalive" workflow runs this on a schedule; it is also safe to run by hand.
#
# Usage: ensure-db-running.sh <resource-group>     (or set AZURE_RESOURCE_GROUP)
# Needs: a logged-in az CLI with rights to start the server (Contributor on the group is enough).
# Exit:  0 = every server is Ready (already, or after starting it); 1 = a server could not be started.
set -euo pipefail

RG="${1:-${AZURE_RESOURCE_GROUP:-}}"
if [ -z "$RG" ]; then
  echo "usage: $0 <resource-group>" >&2
  exit 2
fi
# How long to wait for a server that is mid-stop before starting it.
STOPPING_WAIT_S="${STOPPING_WAIT_S:-600}"

# GitHub annotations when running in Actions, plain lines otherwise.
note() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::notice::$*"; else echo "$*"; fi; }
warn() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$*"; else echo "WARN: $*"; fi; }
fail() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::$*"; else echo "ERROR: $*" >&2; fi; }

state_of() { az postgres flexible-server show -g "$RG" -n "$1" --query state -o tsv; }

servers=$(az postgres flexible-server list -g "$RG" --query "[].name" -o tsv)
if [ -z "$servers" ]; then
  warn "no PostgreSQL flexible server in $RG"
  exit 0
fi

rc=0
for name in $servers; do
  state=$(state_of "$name")
  if [ "$state" = "Stopping" ]; then
    # A start is refused while the stop is still in progress, so wait for it to finish.
    note "$name is stopping; waiting up to ${STOPPING_WAIT_S}s before starting it"
    waited=0
    while [ "$state" = "Stopping" ] && [ "$waited" -lt "$STOPPING_WAIT_S" ]; do
      sleep 20
      waited=$((waited + 20))
      state=$(state_of "$name")
    done
  fi
  case "$state" in
    Ready)
      echo "$name: Ready"
      ;;
    Starting | Updating)
      note "$name: $state (already coming up, nothing to do)"
      ;;
    Stopped)
      warn "$name was Stopped; starting it"
      if az postgres flexible-server start -g "$RG" -n "$name" -o none; then
        note "$name started: $(state_of "$name")"
      else
        fail "could not start $name"
        rc=1
      fi
      ;;
    *)
      fail "$name is in state '$state'; not touching it"
      rc=1
      ;;
  esac
done
exit "$rc"
