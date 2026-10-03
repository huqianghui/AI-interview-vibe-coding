/**
 * AudioWorklet processor for capturing microphone audio (SPEC F9 avatar-video WS-proxy path).
 *
 * Feeds `useVoiceAudio`'s mic side, which base64-encodes each batch and sends it as the `audio`
 * field of a Voice Live `input_audio_buffer.append` event.
 *
 * WHY THIS BATCHES (perf review P0-1, measured). `process()` is called by the Web Audio spec every
 * 128 frames — always, whatever the sample rate — which at 16 kHz is every 8 ms. The first version
 * posted on every callback, so one render quantum became one postMessage became one `ws.send`:
 * measured on a live session, 125.0 frames/second at 391 bytes each = 391 kbps of payload for 256
 * kbps of audio. The extra 135 kbps is not audio at all. It is base64's +1/3 plus a ~45-byte JSON
 * envelope that is charged PER MESSAGE, so the more messages, the more waste.
 *
 * Batching to 40 ms cuts the message count 5x and with it most of the envelope overhead, and does
 * the same to the per-frame work on the main thread (a base64 encode and a `ws.send` each). The
 * cost is at most 32 ms of extra uplink buffering, against Azure's 800 ms end-of-utterance window —
 * two orders of magnitude apart, so turn detection cannot notice.
 *
 * It also converts to Int16 HERE and TRANSFERS the buffer. The conversion used to run on the main
 * thread, which is the thread decoding the avatar's video and rendering React; and the Float32Array
 * was posted by copy (structured clone) rather than transferred, so every 8 ms paid for a copy as
 * well.
 */

/** Uplink batch length. 40 ms is the sweet spot: long enough that the JSON envelope stops dominating,
 * short enough to be invisible next to the 800 ms silence window Azure uses to detect end of turn.
 * Expressed in milliseconds and converted with `sampleRate` (a global in the worklet scope) so this
 * stays correct if the capture rate ever changes again — it already went 24 kHz → 16 kHz once. */
const BATCH_MS = 40;

class AudioRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    // Round to whole render quanta: `process` only ever delivers 128 frames at a time, so a batch
    // size that is not a multiple of 128 would just split one quantum across two messages for
    // nothing.
    const quanta = Math.max(
      1,
      Math.round((sampleRate * BATCH_MS) / 1000 / 128),
    );
    this.batchSamples = quanta * 128;
    this.buffer = new Int16Array(this.batchSamples);
    this.filled = 0;
    this.port.onmessage = (e) => {
      if (e.data.command === "START_RECORDING") {
        this.isRecording = true;
      }
      if (e.data.command === "STOP_RECORDING") {
        this.isRecording = false;
        // Drop whatever is half-collected: it belongs to a turn that is over, and sending a partial
        // batch after the stop would append audio to the NEXT turn's buffer.
        this.filled = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!this.isRecording || !input) return true;

    for (let i = 0; i < input.length; i++) {
      // Clip then scale to Int16, asymmetrically: the negative range reaches -32768 but the
      // positive only +32767, so using 0x8000 for both would wrap the loudest positive sample to
      // silence.
      const s = input[i] < -1 ? -1 : input[i] > 1 ? 1 : input[i];
      this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.batchSamples) {
        // TRANSFER, not copy — the main thread becomes the owner and this worklet allocates a fresh
        // buffer. Posting the same buffer by copy is what the per-quantum version did 125 times a
        // second on the thread that also decodes the avatar's video.
        const full = this.buffer;
        this.buffer = new Int16Array(this.batchSamples);
        this.filled = 0;
        this.port.postMessage({ eventType: "audio", pcm: full.buffer }, [
          full.buffer,
        ]);
      }
    }
    return true;
  }
}

registerProcessor("audio-recorder-processor", AudioRecorderProcessor);
