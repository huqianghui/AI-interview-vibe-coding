#!/usr/bin/env bash
# Measure whether the 24 kHz → 16 kHz mic-uplink cut costs transcription accuracy, on real Azure.
#
# Runs `mic-rate-transcript-ab` twice against the same synthesised utterance — once at 16 kHz (what we
# ship) and once at 24 kHz (Voice Live's inherited default) — and prints both word error rates.
# Flipping the rate needs BOTH sides (browser capture + the session's input_audio_sampling_rate), so
# this temporarily edits the frontend constant and always restores it, even on failure.
#
#   cd frontend && ./e2e/scripts/mic-rate-ab.sh
#
# Preconditions: backend on :8000 with real Azure credentials, vite frontend on :5173, macOS `say`.
set -uo pipefail

FE="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(cd "$FE/.." && pwd)"
AUDIO_HOOK="$FE/src/hooks/useVoiceAudio.ts"
WORK="$(mktemp -d)"
WAV="$WORK/answer.wav"
RESULTS="$WORK/results.tsv"
# Sibilant- and fricative-heavy on purpose: 16 kHz discards everything above 8 kHz, so if that band
# carried anything the recogniser needed, these are the words that would break.
REFERENCE="She sells sixth-floor thermostats, and the finance staff should specify these first, with thorough research."

cleanup() {
  # Always put the shipped constant back.
  if [[ -f "$WORK/useVoiceAudio.ts.bak" ]]; then
    cp "$WORK/useVoiceAudio.ts.bak" "$AUDIO_HOOK"
    echo "restored $AUDIO_HOOK"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

cp "$AUDIO_HOOK" "$WORK/useVoiceAudio.ts.bak"

command -v say >/dev/null || { echo "needs macOS 'say' to synthesise the reference utterance"; exit 1; }
curl -s -m 3 -o /dev/null "http://127.0.0.1:5173/" || { echo "frontend :5173 not running"; exit 1; }

# Chromium's fake mic wants 16-bit PCM mono; it resamples into whatever rate the page's AudioContext
# uses, so ONE master file serves both runs — the FILE's rate is unrelated to the session's
# input_audio_sampling_rate (which is the thing under test and only accepts 16000/24000).
say -o "$WORK/raw.aiff" "$REFERENCE"
afconvert -f WAVE -d LEI16@48000 -c 1 "$WORK/raw.aiff" "$WORK/speech.wav"
# Two measured constraints shape this file, and getting either wrong yields ZERO transcripts:
#   1. The utterance must be followed by SILENCE, or Azure's VAD never reaches end-of-utterance and
#      never finalises a transcription (observed: speech_started=1, speech_stopped=0, no transcripts).
#   2. It must REPEAT, because the fake mic starts at page load while the Voice Live session only comes
#      up ~5 s later — a single pass gets half-eaten and only its tail is transcribed (observed: just
#      "Specify these first, with thorough research.").
# So: sentence + trailing silence, looped. Each pass then ends with a silence the VAD can close on.
# (The repo's other live specs solve the same pair of constraints the other way round —
# `bank-linear-restart-live.spec.ts` uses `wav%noloop` with ~45 s of LEADING silence. Either shape
# works; pick whichever is easier to author for the material you have.)
python3 - "$WORK/speech.wav" "$WAV" <<'PY'
import sys, wave
src, dst = sys.argv[1], sys.argv[2]
with wave.open(src, "rb") as w:
    params, frames = w.getparams(), w.readframes(w.getnframes())
silence = b"\x00" * (params.framerate * params.sampwidth * params.nchannels * 3)  # 3 s
with wave.open(dst, "wb") as out:
    out.setparams(params)
    out.writeframes(frames + silence)
PY
echo "reference wav (utterance + 3s silence, looped): $WAV"
FAKE_ARG="$WAV"

ADMIN_USER=$(grep '^SEED_ADMIN_USERNAME' "$ROOT/backend/.env" | cut -d= -f2-)
ADMIN_PW=$(grep '^SEED_ADMIN_PASSWORD' "$ROOT/backend/.env" | cut -d= -f2-)

run_at_rate() {
  local rate="$1" label="$2"
  echo
  echo "############ capturing at ${rate} Hz (${label}) ############"
  # Both sides must agree or Azure decodes the byte stream at the wrong rate (the page's own drift guard
  # would fail the spec, which is itself a useful check that the guard works).
  # python3, not sed: BSD sed wants `-i ''` and GNU sed refuses it, and this box has GNU sed as `sed`.
  python3 - "$AUDIO_HOOK" "$rate" <<'PY'
import re, sys
path, rate = sys.argv[1], sys.argv[2]
src = open(path).read()
out, n = re.subn(r"^export const MIC_SAMPLE_RATE = .*$", f"export const MIC_SAMPLE_RATE = {rate};", src, count=1, flags=re.M)
assert n == 1, "MIC_SAMPLE_RATE declaration not found"
open(path, "w").write(out)
PY
  grep -n "^export const MIC_SAMPLE_RATE" "$AUDIO_HOOK"

  (cd "$ROOT/backend" && kill "$(lsof -t -nP -iTCP:8000 -sTCP:LISTEN)" 2>/dev/null; sleep 1)
  (cd "$ROOT/backend" && VOICE_LIVE_INPUT_SAMPLING_RATE="$rate" nohup .venv/bin/uvicorn app.main:app --port 8000 \
    > "/tmp/ai-interview-backend-ab-${rate}.log" 2>&1 &)
  sleep 6

  (cd "$FE" && LIVE_VOICE=1 FAKE_AUDIO="$FAKE_ARG" \
    AB_REFERENCE="$REFERENCE" AB_RESULT_FILE="$RESULTS" AB_LABEL="${rate}Hz" \
    E2E_API=http://127.0.0.1:8000/api E2E_ADMIN_USERNAME="$ADMIN_USER" E2E_ADMIN_PASSWORD="$ADMIN_PW" \
    npx playwright test mic-rate-transcript-ab --config=e2e/live.config.ts 2>&1 \
    | grep -E "reference|transcript|word error rate|passed|failed|Error|MISMATCH")
}

run_at_rate 16000 "what we ship"
run_at_rate 24000 "Voice Live's inherited default"

echo
echo "================= RESULT ================="
cat "$RESULTS" 2>/dev/null || echo "(no results captured)"
echo "=========================================="
echo "A higher error rate at 16000 than at 24000 would mean the uplink cut costs accuracy."
