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
#   sudo AVATAR=amira frontend/e2e/scripts/verify-restore.sh
#     Defaults to lisa (1080p) — the only avatar measured to stop decoding on a shaped link, and so the
#     only one that exercises the threshold-free primary trigger. amira is 512x512 and decodes fine at
#     3% loss, which is why five earlier runs never triggered it.
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
DB="$ROOT/backend/ai_coach.db"
SHAPER="$FE/e2e/scripts/netshape.sh"
RUN_AS="${SUDO_USER:-$(id -un)}"
SIGNAL="$FE/e2e/output/restore-signal"
PROFILE="${PROFILE:-office-bad}"
# Which avatar the run uses. THIS IS LOAD-BEARING, and not controlling it cost five inconclusive runs:
# the default persona happened to be `amira`, a 512x512 photo avatar, whose stream decodes perfectly well
# at 3% loss. So `framesDecoded` kept growing, the threshold-free primary trigger could never fire, and
# every downgrade came from the (now retired) concealment trigger instead. `lisa` is the 1080p video
# avatar, which is what v0.40.0.0 measured decoding ZERO frames while still consuming ~1 Mbps. Restored
# on exit either way, like weaknet-phase2.sh does.
AVATAR="${AVATAR:-lisa}"

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
# Fail fast on a FAKE_AUDIO path that does not exist. Chromium does NOT complain about an unreadable
# --use-file-for-fake-audio-capture file: it silently falls back to its default tone, so the run looks
# normal and only the `earned` line at the end hints that the audio you thought you supplied never
# played. Copy-pasting the placeholder path out of the docs did exactly that (2026-09-30).
if [[ -n "${FAKE_AUDIO:-}" && ! -r "$FAKE_AUDIO" ]]; then
  echo "FAKE_AUDIO='$FAKE_AUDIO' is not a readable file."
  echo "Build one (utterance + 3 s trailing silence, which Chromium then loops):"
  echo "  say -o /tmp/raw.aiff \"She sells sixth-floor thermostats, and the finance staff should specify these first, with thorough research.\""
  echo "  afconvert -f WAVE -d LEI16@48000 -c 1 /tmp/raw.aiff /tmp/speech.wav"
  echo "  python3 -c \"import wave;w=wave.open('/tmp/speech.wav');p=w.getparams();f=w.readframes(w.getnframes());o=wave.open('/tmp/answer.wav','wb');o.setparams(p);o.writeframes(f+b'\\0'*(p.framerate*p.sampwidth*p.nchannels*3));o.close()\""
  echo "Then rerun with FAKE_AUDIO=/tmp/answer.wav"
  exit 1
fi
curl -s -m 3 -o /dev/null http://127.0.0.1:8000/api/auth/login || { echo "backend :8000 not running"; exit 1; }
curl -s -m 3 -o /dev/null http://127.0.0.1:5173/ || { echo "frontend :5173 not running"; exit 1; }

# Remember the developer's default persona so the run can put it back. Escape apostrophes before they
# go back into SQL: the restore is this script's safety net, and an unescaped value would leave the DB
# pointing at whatever avatar this run chose (same guard as weaknet-phase2.sh).
ORIG=$(sqlite3 "$DB" "select character||'|'||coalesce(style,'') from interviewer_personas where is_default=1;")
ORIG_CHAR="${ORIG%%|*}"; ORIG_STYLE="${ORIG#*|}"
ORIG_CHAR_SQL=${ORIG_CHAR//\'/\'\'}
ORIG_STYLE_SQL=${ORIG_STYLE//\'/\'\'}

case "$AVATAR" in
  lisa)  sqlite3 "$DB" "update interviewer_personas set character='lisa', style='casual-sitting' where is_default=1;" ;;
  amira) sqlite3 "$DB" "update interviewer_personas set character='amira', style='' where is_default=1;" ;;
  *) echo "unknown AVATAR '$AVATAR' (lisa = 1080p video, amira = 512px photo)"; exit 1 ;;
esac
echo "avatar: $AVATAR (was $ORIG_CHAR/${ORIG_STYLE:-none})"

WATCHER=""
restore() {
  [[ -n "$WATCHER" ]] && kill "$WATCHER" 2>/dev/null
  "$SHAPER" off >/dev/null 2>&1 || true
  rm -f "$SIGNAL"
  sqlite3 "$DB" "update interviewer_personas set character='$ORIG_CHAR_SQL', style='$ORIG_STYLE_SQL' where is_default=1;"
  echo "restored: shaping off, default persona = $ORIG_CHAR/${ORIG_STYLE:-none}"
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
