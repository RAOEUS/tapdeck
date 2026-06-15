// STFT front-end. To keep the AUDIO thread light (a big FFT here could blow the
// render-quantum budget and cause dropouts), this node does NO FFT. It only:
//   - passes audio straight through,
//   - keeps a ring buffer of the last N samples (mono mix),
//   - every fixed hop (~10 ms), ships the time-domain frame to the engine's main
//     thread, which runs the FFT off the audio thread.
//
// Emits (only while active): { type:'frame', n, frame: Float32Array }.

const TARGET_CPS = 100; // frames (spectrogram columns) per second -> time resolution

class SpectrumProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.active = false;
    this.setFft((opts && opts.processorOptions && opts.processorOptions.fftSize) || 16384);
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.active === "boolean") this.active = d.active;
      if (d.fftSize) this.setFft(d.fftSize);
    };
  }

  setFft(n) {
    n = Math.max(2048, Math.min(32768, n));
    n = 1 << Math.round(Math.log2(n)); // power of two
    this.N = n;
    this.hop = Math.max(128, Math.round(sampleRate / TARGET_CPS));
    this.ring = new Float32Array(n);
    this.ringPos = 0;
    this.since = 0;
    this.frame = new Float32Array(n); // reused; postMessage copies it each hop
  }

  emitFrame() {
    const n = this.N, frame = this.frame, ring = this.ring, pos = this.ringPos;
    for (let k = 0; k < n; k++) frame[k] = ring[(pos + k) % n]; // oldest..newest
    // No transfer: structured-clone copies the bytes (cheap memcpy, no GC in the
    // audio thread) so we can keep reusing `frame`.
    this.port.postMessage({ type: "frame", n, frame });
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (input && input.length) {
      const ch0 = input[0], ch1 = input[1] || input[0], len = ch0.length, n = this.N, ring = this.ring;
      for (let i = 0; i < len; i++) {
        ring[this.ringPos] = 0.5 * (ch0[i] + ch1[i]);
        this.ringPos = this.ringPos + 1 >= n ? 0 : this.ringPos + 1;
        if (++this.since >= this.hop) { this.since = 0; if (this.active) this.emitFrame(); }
      }
      if (output) for (let ch = 0; ch < output.length; ch++) { const inp = input[ch] || input[0]; if (inp) output[ch].set(inp); }
    }
    return true;
  }
}

registerProcessor("spectrum-processor", SpectrumProcessor);
