#!/usr/bin/env bash
# Per-turn speak-start latency in BOTH transports, on the built-in question bank.
#
#   frontend/e2e/scripts/turn-latency.sh
#
# Measures turn 1 / 2 / 3 twice: once with the avatar (WebRTC) and once with no avatar at all (reply audio
# as PCM over the WebSocket). Performance work runs on the bank, never the external brain persona, so a
# third-party gateway cannot sit inside the numbers (owner directive 2026-10-01).
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
  local mode="$1" char="$2" style="$3"
  sqlite3 "$DB" "update interviewer_personas set character='$char', style='$style' where is_default=1;"
  local applied
  applied=$(sqlite3 "$DB" "select coalesce(character,'') from interviewer_personas where is_default=1;")
  if [ "$applied" != "$char" ]; then
    echo "avatar column did not take (wanted '$char', got '$applied') — skipping MODE=$mode rather than mislabelling it"
    return 1
  fi
  echo ""
  echo "######## MODE=$mode  (avatar='${char:-none}') ########"
  ( cd frontend && MODE="$mode" TURNS="$TURNS" LIVE_VOICE=1 FAKE_AUDIO="$WAV" \
      E2E_API=http://127.0.0.1:8000/api E2E_ADMIN_USERNAME="$ADMIN_U" E2E_ADMIN_PASSWORD="$ADMIN_P" \
      npx playwright test turn-latency-live --config=e2e/live.config.ts ) 2>&1 \
    | grep -E 'turn [0-9]|PER-TURN|answer heard|errors:|passed|failed' || true
}

run_mode avatar "${AVATAR:-amira}" "" || true
# Azure rate-limits avatar session creation; leave room before the next session.
sleep 25
run_mode audio "" "" || true
