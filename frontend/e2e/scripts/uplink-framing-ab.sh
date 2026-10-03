#!/usr/bin/env bash
# Does the P0-1 uplink reframing cost transcription accuracy? Measured on real Azure.
#
# The change batches mic audio to 40 ms in the worklet and sends it as a binary frame, instead of one
# base64 JSON message per 8 ms render quantum (391 -> 256 kbps of payload, 125 -> 25 messages/second).
# The theory says Azure cannot tell: it reassembles `input_audio_buffer.append` into one continuous
# stream, and 40 ms of extra buffering is nothing against the 800 ms silence window it uses to detect
# end of turn. This script measures it instead of trusting that.
#
# It runs the SAME word-error-rate spec as the mic-rate A/B, against the same synthesised utterance,
# once with the reframing and once without. Flipping "without" means reverting three files, so this
# stashes them and ALWAYS restores, even on failure.
#
#   cd frontend && ./e2e/scripts/uplink-framing-ab.sh
#
# Preconditions: backend on :8000 with real Azure credentials, vite frontend on :5173, macOS `say`.
set -uo pipefail

FE="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(cd "$FE/.." && pwd)"
WORK="$(mktemp -d)"
WAV="$WORK/answer.wav"
RESULTS="$WORK/results.tsv"
STASHED=0
# The three files the reframing touches. Reverting all three together is what makes "before" coherent:
# the worklet's message shape and the hook that reads it have to agree.
FILES=(
  "frontend/public/audio-processor.js"
  "frontend/src/hooks/useVoiceAudio.ts"
  "frontend/src/hooks/useInterviewVoice.ts"
)
# Same sentence as the mic-rate A/B, so the two experiments' error rates are comparable.
# (Long by necessity: it must match the spec's AB_REFERENCE default word for word.)
REFERENCE="She sells sixth-floor thermostats, and the finance staff should specify these first, with thorough research."

# Split in two on purpose: the results file lives in $WORK, so the trap that deletes $WORK must not
# be what puts the source tree back — otherwise restoring early (before printing) takes the results
# with it, which is exactly what happened the first time this ran.
restore_tree() {
  if [[ "$STASHED" == "1" ]]; then
    (cd "$ROOT" && git stash pop -q) && echo "restored the reframing (git stash pop)" \
      || echo "WARNING: could not pop the stash — run 'git stash list' and restore by hand"
    STASHED=0
  fi
}
cleanup() {
  restore_tree
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

command -v say >/dev/null || { echo "needs macOS 'say' to synthesise the reference utterance"; exit 1; }
curl -s -m 3 -o /dev/null "http://127.0.0.1:5173/" || { echo "frontend :5173 not running"; exit 1; }
curl -s -m 3 -o /dev/null "http://127.0.0.1:8000/health" || { echo "backend :8000 not running"; exit 1; }
[[ -z "$(cd "$ROOT" && git status --porcelain -- "${FILES[@]}")" ]] && {
  echo "none of the three files differ from HEAD — there is no 'before' to measure"; exit 1; }

# Utterance + 3 s trailing silence, looped by the fake mic. Both parts are load-bearing: without the
# silence Azure's VAD never closes the utterance and finalises nothing, and without the repeat the
# session comes up mid-sentence and only the tail is transcribed. (Recipe shared with mic-rate-ab.sh.)
say -o "$WORK/raw.aiff" "$REFERENCE"
afconvert -f WAVE -d LEI16@48000 -c 1 "$WORK/raw.aiff" "$WORK/speech.wav"
python3 - "$WORK/speech.wav" "$WAV" <<'PY'
import sys, wave
src, dst = sys.argv[1], sys.argv[2]
with wave.open(src, "rb") as w:
    params, frames = w.getparams(), w.readframes(w.getnframes())
silence = b"\x00" * (params.framerate * params.sampwidth * params.nchannels * 3)
with wave.open(dst, "wb") as out:
    out.setparams(params)
    out.writeframes(frames + silence)
PY
echo "reference wav: $WAV"

ADMIN_USER=$(grep '^SEED_ADMIN_USERNAME' "$ROOT/backend/.env" | cut -d= -f2-)
ADMIN_PW=$(grep '^SEED_ADMIN_PASSWORD' "$ROOT/backend/.env" | cut -d= -f2-)

measure() {
  local label="$1"
  echo
  echo "############ $label ############"
  # Assignment PREFIXES on `npx`, deliberately — bash passes those through execve into the child's
  # environment. `env VAR=secret npx ...` would put the password in argv, readable via `ps aux`.
  (cd "$FE" && LIVE_VOICE=1 FAKE_AUDIO="$WAV" \
    AB_REFERENCE="$REFERENCE" AB_RESULT_FILE="$RESULTS" AB_LABEL="$label" \
    E2E_API=http://127.0.0.1:8000 E2E_ADMIN_USERNAME="$ADMIN_USER" E2E_ADMIN_PASSWORD="$ADMIN_PW" \
    npx playwright test mic-rate-transcript-ab --config=e2e/live.config.ts 2>&1 \
    | grep -E "reference|transcript|word error rate|passed|failed|Error|MISMATCH")
}

measure "after-40ms-binary"

# "Before" = the three files as they are at HEAD. The backend is left alone on purpose: it accepts
# BOTH framings, so this run also exercises the rollout direction that actually worries us (a page
# older than the backend).
(cd "$ROOT" && git stash push -q -- "${FILES[@]}") && STASHED=1 || { echo "git stash failed"; exit 1; }
echo "reverted: ${FILES[*]}"
measure "before-8ms-base64"

# Put the tree back BEFORE printing, so a failure in the reporting below cannot leave it reverted —
# but leave $WORK alive for the trap, because the results file is in it.
restore_tree

echo
echo "================= RESULT ================="
cat "$RESULTS" 2>/dev/null || echo "(no results captured)"
echo "=========================================="
echo "A materially higher error rate for after-40ms-binary would mean the reframing costs accuracy."
