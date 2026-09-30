#!/usr/bin/env bash
# Phase-2 driver for the avatar weak-network probe: OS-level shaping (needs sudo) × avatar type.
#
# Run from the REPO ROOT in your own terminal (sudo prompts for your password there):
#   sudo frontend/e2e/scripts/weaknet-phase2.sh            # all profiles, amira + lisa
#   sudo PROFILES="office-tight office-bad" AVATARS="lisa" frontend/e2e/scripts/weaknet-phase2.sh
#
# Preconditions (checked): backend on :8000 with the real .env, vite frontend on :5173.
# What it does per (profile, avatar): shape the network → point the default persona at the avatar →
# run avatar-weaknet-probe as your normal user (not root) → collect e2e/output/weaknet-<label>.json.
# Always restores: shaping off, default persona back to what it was.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FE="$ROOT/frontend"
DB="$ROOT/backend/ai_coach.db"
SHAPER="$FE/e2e/scripts/netshape.sh"
RUN_AS="${SUDO_USER:-$(id -un)}"
PROBE_MS="${PROBE_MS:-40000}"

# profile name → "down_kbps up_kbps loss_pct delay_ms scope" (bash 3.2 on macOS: no associative arrays)
# scope udp = shape only the avatar WebRTC media (what a candidate's office network sees in production).
# scope all = also shape the backend→Azure TCP; loss MUST be 0 there or the TLS handshake times out.
profile_spec() {
  case "$1" in
    baseline)       echo "off" ;;
    office-ok)      echo "4000 2000 0.5 50 udp" ;;
    office-tight)   echo "1500 800 1 80 udp" ;;
    office-bad)     echo "800 400 3 120 udp" ;;
    uplink-starved) echo "4000 300 0 20 all" ;;   # mic WS uplink (~600 kbps) vs a 300 kbps pipe, no loss
    *) echo "" ;;
  esac
}
PROFILES="${PROFILES:-baseline office-ok office-tight office-bad uplink-starved}"
# amira = photo 512², lisa = video 1080p. Suffix "-audio" runs the SAME avatar with the video track
# offered as a=inactive (verified 2026-09-30: Azure answers, only the audio track flows, ~100 kbps) —
# the "picture off, voice on" degradation candidate. e.g. AVATARS="lisa lisa-audio"
AVATARS="${AVATARS:-amira lisa}"
# Which spec to run under each shaped profile. The default samples and reports; set
# SPEC=avatar-auto-downgrade-live to ASSERT that the automatic downgrade actually fires.
SPEC="${SPEC:-avatar-weaknet-probe}"
GREP_KEEP="${GREP_KEEP:-kbpsAvg|kbpsMin|kbpsMax|fpsAvg|\"frame\"|packetsLost|freezeCount|freezeDurS|bweKbps|rttMsAvg|\"path\"|wsUpKbps|iceStates|connectedAt|passed|failed|Error|media (health|mode)|decision log|audio bytes|video painted|\[probe\]}"

[[ $EUID -eq 0 ]] || { echo "run with sudo (network shaping needs root)"; exit 1; }
curl -s -m 3 -o /dev/null http://127.0.0.1:8000/api/auth/login || { echo "backend :8000 not running"; exit 1; }
curl -s -m 3 -o /dev/null http://127.0.0.1:5173/ || { echo "frontend :5173 not running"; exit 1; }

# Deliberately NOT read here. The child runs as $RUN_AS (who owns the repo) and greps backend/.env
# itself, so the admin password never lands in this root process, in any argv that `ps aux` can read,
# or in a temp file a root-owned 700 directory would then stop the child from traversing.
ORIG=$(sqlite3 "$DB" "select character||'|'||coalesce(style,'') from interviewer_personas where is_default=1;")
ORIG_CHAR="${ORIG%%|*}"; ORIG_STYLE="${ORIG#*|}"
# Escape single quotes before they go back into SQL. The restore is this script's safety net — if a
# persona value ever contains an apostrophe, an unescaped restore fails and leaves the developer's DB
# pointing at whatever avatar the last profile used.
ORIG_CHAR_SQL=${ORIG_CHAR//\'/\'\'}
ORIG_STYLE_SQL=${ORIG_STYLE//\'/\'\'}

restore() {
  "$SHAPER" off >/dev/null 2>&1 || true
  sqlite3 "$DB" "update interviewer_personas set character='$ORIG_CHAR_SQL', style='$ORIG_STYLE_SQL' where is_default=1;"
  echo "restored: shaping off, default persona = $ORIG_CHAR/$ORIG_STYLE"
}
trap restore EXIT INT TERM

set_avatar() {
  case "${1%-audio}" in
    amira) sqlite3 "$DB" "update interviewer_personas set character='amira', style='' where is_default=1;" ;;
    lisa)  sqlite3 "$DB" "update interviewer_personas set character='lisa', style='casual-sitting' where is_default=1;" ;;
    *) echo "unknown avatar $1"; exit 1 ;;
  esac
}
# "-audio" suffix → offer the video m-line as a=inactive (audio-only avatar stream).
audio_only_flag() { case "$1" in *-audio) echo "inactive" ;; *) echo "" ;; esac; }

for prof in $PROFILES; do
  spec="$(profile_spec "$prof")"
  [[ -n "$spec" ]] || { echo "unknown profile $prof"; continue; }
  if [[ "$spec" == "off" ]]; then "$SHAPER" off; else "$SHAPER" on $spec; fi
  sleep 2
  for av in $AVATARS; do
    set_avatar "$av"
    label="p2-${prof}-${av}"
    echo; echo "############ $label ############"
    sudo -u "$RUN_AS" env \
      LIVE_VOICE=1 PROFILE="$label" PROBE_MS="$PROBE_MS" AUDIO_ONLY_OFFER="$(audio_only_flag "$av")" \
      E2E_API=http://127.0.0.1:8000/api \
      PATH="$PATH" HOME="$(eval echo "~$RUN_AS")" \
      bash -c "set -a; cd '$FE' && \
        E2E_ADMIN_USERNAME=\$(grep '^SEED_ADMIN_USERNAME' '$ROOT/backend/.env' | cut -d= -f2-); \
        E2E_ADMIN_PASSWORD=\$(grep '^SEED_ADMIN_PASSWORD' '$ROOT/backend/.env' | cut -d= -f2-); \
        set +a; npx playwright test '$SPEC' --config=e2e/live.config.ts 2>&1 \
        | grep -E '$GREP_KEEP' \
        | sed -E 's/\"username\":\"[^\"]*\",\"credential\":\"[^\"]*\"/<creds>/g' | cut -c1-700"
  done
done
echo; echo "done. JSON per run in $FE/e2e/output/weaknet-p2-*.json"
