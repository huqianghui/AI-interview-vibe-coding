#!/usr/bin/env bash
# Per-turn speak-start latency in BOTH transports, on the built-in question bank.
#
#   frontend/e2e/scripts/turn-latency.sh
#
# Measures three answer turns twice, both with the reply audio on WebRTC:
#   MODE=avatar  avatar video + audio on one WebRTC connection
#   MODE=audio   the audio-only downgrade — same connection, video m-line a=inactive
# Performance work runs on the built-in bank, never the external brain persona, so a third-party gateway
# cannot sit inside the numbers (owner directive 2026-10-01).
#
# Both modes use the SAME persona: audio-only is reached by dropping the picture at runtime, not by
# unconfiguring the avatar. An earlier revision cleared interviewer_personas.character for the audio run,
# which measured a different transport entirely (PCM over the WebSocket) and read as silence.
#
# Mutates two rows in the LOCAL dev DB and restores them. The restore trap is armed BEFORE the first
# mutation: arming it afterwards is how an earlier run left a temporary avatar pinned with no cleanup.
set -euo pipefail

cd "$(dirname "$0")/../../.."
DB="backend/ai_coach.db"
TURNS="${TURNS:-3}"
WAV="${FAKE_AUDIO:-$HOME/ai-interview-answer-loop.wav}"

[ -f "$DB" ] || { echo "no dev DB at $DB"; exit 1; }
# Chromium accepts an unreadable --use-file-for-fake-audio-capture path in silence, and then every answer
# is empty with nothing in the log to say why. Checked up front, for that reason.
[ -r "$WAV" ] || { echo "FAKE_AUDIO not readable: $WAV"; exit 1; }

# A bank with at least as many questions as turns, or turn 3 has nothing to ask.
BANK_ID=$(sqlite3 "$DB" "select b.id from question_banks b join questions q on q.bank_id=b.id group by b.id having count(q.id) >= $TURNS order by count(q.id) desc limit 1;")
[ -n "$BANK_ID" ] || { echo "no bank with >= $TURNS questions"; exit 1; }

PREV_BANK=$(sqlite3 "$DB" "select id from question_banks where is_default=1;")
PREV_CHAR=$(sqlite3 "$DB" "select coalesce(character,'') from interviewer_personas where is_default=1;")
PREV_STYLE=$(sqlite3 "$DB" "select coalesce(style,'') from interviewer_personas where is_default=1;")
echo "saved: bank=$PREV_BANK avatar=${PREV_CHAR:-<none>}/${PREV_STYLE:-<none>}"

restore() {
  sqlite3 "$DB" "update interviewer_personas set character='$PREV_CHAR', style='$PREV_STYLE' where is_default=1;" || true
  if [ -n "$PREV_BANK" ]; then
    sqlite3 "$DB" "update question_banks set is_default=0; update question_banks set is_default=1 where id='$PREV_BANK';" || true
  fi
  NOW=$(sqlite3 "$DB" "select coalesce(character,'<none>') from interviewer_personas where is_default=1;")
  if [ "$NOW" != "${PREV_CHAR:-<none>}" ] && [ -n "$PREV_CHAR" ]; then
    echo "WARNING: avatar column did not restore (now '$NOW', was '$PREV_CHAR') — fix before the next run"
  else
    echo "restored: bank=$PREV_BANK avatar=${PREV_CHAR:-<none>}"
  fi
}
trap restore EXIT INT TERM   # armed BEFORE any mutation below

sqlite3 "$DB" "update question_banks set is_default=0; update question_banks set is_default=1 where id='$BANK_ID';"
QN=$(sqlite3 "$DB" "select count(*) from questions where bank_id='$BANK_ID';")
echo "using bank $BANK_ID ($QN questions) for $TURNS turns"

ADMIN_U=$(grep '^SEED_ADMIN_USERNAME' backend/.env | cut -d= -f2-)
ADMIN_P=$(grep '^SEED_ADMIN_PASSWORD' backend/.env | cut -d= -f2-)

run_mode() {
  local mode="$1"
  echo ""
  echo "######## MODE=$mode  (avatar='$AVATAR_PIN') ########"
  ( cd frontend && MODE="$mode" TURNS="$TURNS" LIVE_VOICE=1 FAKE_AUDIO="$WAV" \
      E2E_API=http://127.0.0.1:8000/api E2E_ADMIN_USERNAME="$ADMIN_U" E2E_ADMIN_PASSWORD="$ADMIN_P" \
      npx playwright test turn-latency-live --config=e2e/live.config.ts ) 2>&1 \
    | grep -E 'turn [0-9]|cold start|PER-TURN|answer heard|downgrade|errors:|passed|failed' || true
}

# Pin the avatar once, for both runs. Which avatar is load-bearing — lisa streams 1080p video, amira a
# 512x512 photo — and leaving it to whatever the persona happens to hold is what made five weak-network
# runs inconclusive. Verified by read-back, because a silent failure here mislabels every number below.
AVATAR_PIN="${AVATAR:-amira}"
case "$AVATAR_PIN" in
  lisa)  sqlite3 "$DB" "update interviewer_personas set character='lisa', style='casual-sitting' where is_default=1;" ;;
  amira) sqlite3 "$DB" "update interviewer_personas set character='amira', style='' where is_default=1;" ;;
  *) echo "unknown AVATAR '$AVATAR_PIN' (use lisa or amira)"; exit 1 ;;
esac
APPLIED=$(sqlite3 "$DB" "select coalesce(character,'') from interviewer_personas where is_default=1;")
[ "$APPLIED" = "$AVATAR_PIN" ] || { echo "avatar pin failed: wanted '$AVATAR_PIN', got '$APPLIED'"; exit 1; }
echo "avatar pinned to $AVATAR_PIN"

run_mode avatar || true
# Azure rate-limits avatar session creation, and the audio run rebuilds a session of its own on top of
# the one it starts with. Leave room, or the downgrade is refused and the run measures nothing.
sleep 30
run_mode audio || true
