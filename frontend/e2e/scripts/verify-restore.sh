#!/usr/bin/env bash
# Calibrate the RESTORE half of the weak-network policy: shape the link, let the app drop the picture
# by itself, then REMOVE the shaping and measure whether (and how fast) the picture comes back.
#
# This is the run that finally exercises `CONCEAL_GOOD` (TODOS.md). The spec cannot un-shape the link
# itself — that needs root — so the two cooperate through a signal file: the spec touches it the instant
# it sees the downgrade, this script notices and un-shapes. Handshaking beats a fixed timer, because the
# link then recovers at a known point in the policy's life and the measured delay means something.
#
# Run from the REPO ROOT in your own terminal (sudo prompts for your password there):
#   sudo frontend/e2e/scripts/verify-restore.sh
#
# Optional:
#   sudo PROFILE="office-tight" frontend/e2e/scripts/verify-restore.sh
#   sudo FAKE_AUDIO=/path/to/answer.wav frontend/e2e/scripts/verify-restore.sh
#     Without FAKE_AUDIO the interviewer is silent for most of the healthy hold, and a silent stream
#     reports concealment 0 — which the policy reads as healthy. The run still proves the picture comes
#     back, but it does NOT exercise CONCEAL_GOOD; the spec prints `earned: false` when that happens.
#     Use the WAV recipe from mic-rate-ab.sh (utterance + ~3 s trailing silence, looped) to keep a turn
#     alive so the interviewer actually speaks during the hold.
#
# Preconditions (checked): backend on :8000 with the real .env, vite frontend on :5173.
# Always restores shaping on exit, including on Ctrl-C.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FE="$ROOT/frontend"
SHAPER="$FE/e2e/scripts/netshape.sh"
RUN_AS="${SUDO_USER:-$(id -un)}"
SIGNAL="$FE/e2e/output/restore-signal"
PROFILE="${PROFILE:-office-bad}"

# Same profile table as weaknet-phase2.sh (macOS bash 3.2 has no associative arrays). udp scope only:
# shaping TCP as well kills the backend's TLS handshake to Azure and no session is created at all.
profile_spec() {
  case "$1" in
    office-tight) echo "1500 800 1 80 udp" ;;
    office-bad)   echo "800 400 3 120 udp" ;;
    *) echo "" ;;
  esac
}
SPEC_ARGS="$(profile_spec "$PROFILE")"
[[ -n "$SPEC_ARGS" ]] || { echo "unknown PROFILE '$PROFILE' (office-tight | office-bad)"; exit 1; }

[[ $EUID -eq 0 ]] || { echo "run with sudo (network shaping needs root)"; exit 1; }
curl -s -m 3 -o /dev/null http://127.0.0.1:8000/api/auth/login || { echo "backend :8000 not running"; exit 1; }
curl -s -m 3 -o /dev/null http://127.0.0.1:5173/ || { echo "frontend :5173 not running"; exit 1; }

WATCHER=""
restore() {
  [[ -n "$WATCHER" ]] && kill "$WATCHER" 2>/dev/null
  "$SHAPER" off >/dev/null 2>&1 || true
  rm -f "$SIGNAL"
  echo "restored: shaping off"
}
trap restore EXIT INT TERM

rm -f "$SIGNAL"
mkdir -p "$(dirname "$SIGNAL")"
# The spec runs as $RUN_AS, so it must be able to create the signal file in this directory.
chown "$RUN_AS" "$(dirname "$SIGNAL")" 2>/dev/null || true

echo "shaping: $PROFILE ($SPEC_ARGS)"
"$SHAPER" on $SPEC_ARGS
sleep 2

# Un-shape the moment the spec reports the downgrade. Backgrounded so the spec runs in the foreground
# and its output stays attached to this terminal.
(
  while :; do
    if [[ -f "$SIGNAL" ]]; then
      echo
      echo ">>> downgrade observed — removing shaping now, the link is clean from here <<<"
      echo
      "$SHAPER" off >/dev/null 2>&1 || true
      break
    fi
    sleep 1
  done
) &
WATCHER=$!

# Deliberately NOT read here. The child runs as $RUN_AS (who owns the repo) and greps backend/.env
# itself, so the admin password never lands in this root process nor in an argv that `ps aux` can read.
# Assignment prefixes rather than `env NAME=secret`: `env` is a real binary, so its argv is world-readable.
# `set -o pipefail` inside the child is load-bearing: without it the exit status is sed's, which is
# always 0, so a FAILING spec would report success — the one thing a verification script must not do.
sudo -u "$RUN_AS" env \
  LIVE_VOICE=1 RESTORE_SIGNAL_FILE="$SIGNAL" \
  ${FAKE_AUDIO:+FAKE_AUDIO="$FAKE_AUDIO"} \
  E2E_API=http://127.0.0.1:8000/api \
  PATH="$PATH" HOME="$(eval echo "~$RUN_AS")" \
  bash -c "set -o pipefail; set -a; cd '$FE' && \
    E2E_ADMIN_USERNAME=\$(grep '^SEED_ADMIN_USERNAME' '$ROOT/backend/.env' | cut -d= -f2-); \
    E2E_ADMIN_PASSWORD=\$(grep '^SEED_ADMIN_PASSWORD' '$ROOT/backend/.env' | cut -d= -f2-); \
    set +a; npx playwright test avatar-restore-live --config=e2e/live.config.ts 2>&1 \
    | sed -E 's/\"username\":\"[^\"]*\",\"credential\":\"[^\"]*\"/<creds>/g'"
STATUS=$?

echo
echo "spec exit: $STATUS"
echo "Hand me the block between '===== picture restore' and '====='. The numbers I need are"
echo "'restored', 'observed concealment ratio' and 'earned' — they decide whether CONCEAL_GOOD stays at"
echo "$(grep -oE 'CONCEAL_GOOD: [0-9.]+' "$FE/src/hooks/avatarHealth.ts" 2>/dev/null || echo '0.03')."
exit $STATUS
