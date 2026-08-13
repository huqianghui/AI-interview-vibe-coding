/**
 * AudioWorklet processor for capturing microphone audio (SPEC F9 avatar-video WS-proxy path).
 * Captures raw Float32 audio data and posts it to the main thread. Ported near-verbatim from the
 * reference Avatar layer's `public/audio-processor.js` — used by `useVoiceAudio`'s mic-capture
 * side to feed PCM frames into the Voice Live `input_audio_buffer.append` stream.
 */
class AudioRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    this.port.onmessage = (e) => {
      if (e.data.command === "START_RECORDING") {
        this.isRecording = true;
      }
      if (e.data.command === "STOP_RECORDING") {
        this.isRecording = false;
      }
    };
  }

  process(inputs) {
    if (this.isRecording && inputs[0] && inputs[0][0]) {
      // Clone the Float32Array data before posting (transferable)
      const audioData = new Float32Array(inputs[0][0]);
      this.port.postMessage({
        eventType: "audio",
        audioData: audioData,
      });
    }
    return true;
  }
}

registerProcessor("audio-recorder-processor", AudioRecorderProcessor);
