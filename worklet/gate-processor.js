// Noise gate / downward expander, stereo-linked. Below the threshold the signal
// is attenuated (gently for low ratios, slammed shut for high ones), with a hold
// time that keeps it open briefly after the level drops.
// Params: { threshold(dB), ratio, range(dB), attack(ms), release(ms), hold(ms) }.
// Posts attenuation for the meter: { type:'meter', gr: dB >= 0 }.

class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = -45; this.ratio = 4; this.range = 50;
    this.attack = 1; this.release = 120; this.hold = 12;
    this.envGain = 0;       // current gain (dB, <= 0)
    this.holdCount = 0;
    this.frames = 0; this.meterGR = 0;
    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.threshold === "number") this.threshold = d.threshold;
      if (typeof d.ratio === "number") this.ratio = d.ratio;
      if (typeof d.range === "number") this.range = d.range;
      if (typeof d.attack === "number") this.attack = d.attack;
      if (typeof d.release === "number") this.release = d.release;
      if (typeof d.hold === "number") this.hold = d.hold;
      this.recalc();
    };
  }

  recalc() {
    this.atk = Math.exp(-1 / (Math.max(0.05, this.attack) * 0.001 * sampleRate));
    this.rel = Math.exp(-1 / (Math.max(1, this.release) * 0.001 * sampleRate));
    this.holdSamples = Math.round(Math.max(0, this.hold) * 0.001 * sampleRate);
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length, chans = input.length;
    const L = input[0], R = input[1] || input[0];

    for (let i = 0; i < n; i++) {
      const peak = Math.max(Math.abs(L[i]), chans > 1 ? Math.abs(R[i]) : 0);
      const levelDb = 20 * Math.log10(peak + 1e-9);
      const over = levelDb - this.threshold;
      // target attenuation: 0 above threshold, expanding below it
      const target = over >= 0 ? 0 : -Math.min(this.range, -over * (this.ratio - 1));
      if (target >= this.envGain) {
        // opening (needs less attenuation) - fast, and refresh the hold timer
        this.envGain = target + (this.envGain - target) * this.atk;
        this.holdCount = this.holdSamples;
      } else if (this.holdCount > 0) {
        this.holdCount--; // hold the gate open before it starts to close
      } else {
        this.envGain = target + (this.envGain - target) * this.rel;
      }
      const g = Math.pow(10, this.envGain / 20);
      for (let ch = 0; ch < chans; ch++) output[ch][i] = input[ch][i] * g;
      const gr = -this.envGain;
      if (gr > this.meterGR) this.meterGR = gr;
    }

    this.frames += n;
    if (this.frames >= 256) {
      this.frames = 0;
      this.port.postMessage({ type: "meter", gr: this.meterGR });
      this.meterGR *= 0.6;
    }
    return true;
  }
}

registerProcessor("gate-processor", GateProcessor);
