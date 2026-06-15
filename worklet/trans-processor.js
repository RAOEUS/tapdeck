// Transient shaper. Two envelope followers (a fast one that tracks onsets and a
// slower one that tracks the body): their difference says whether we're in an
// attack (fast > slow) or sustain (fast < slow), and we apply gain accordingly.
// Params: { attack(-100..100), sustain(-100..100), output(dB) }.
// Posts the signed gain (dB) for a bidirectional meter: { type:'meter', gr }.

class TransProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.attack = 0; this.sustain = 0; this.output = 0;
    this.envFast = 0; this.envSlow = 0; this.gainDb = 0;
    this.frames = 0; this.meterGain = 0;
    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.attack === "number") this.attack = d.attack;
      if (typeof d.sustain === "number") this.sustain = d.sustain;
      if (typeof d.output === "number") this.output = d.output;
      this.recalc();
    };
  }

  recalc() {
    const tc = (ms) => Math.exp(-1 / (Math.max(0.05, ms) * 0.001 * sampleRate));
    this.aFast = tc(0.5); this.rFast = tc(40);    // onset detector
    this.aSlow = tc(20); this.rSlow = tc(220);    // body detector
    this.gSmooth = tc(3);
    this.outLin = Math.pow(10, this.output / 20);
    this.attDb = (this.attack / 100) * 15;        // ±15 dB at the extremes
    this.susDb = (this.sustain / 100) * 15;
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length, chans = input.length;
    const L = input[0], R = input[1] || input[0];
    const og = this.outLin;

    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), chans > 1 ? Math.abs(R[i]) : 0);
      this.envFast = a > this.envFast ? a + (this.envFast - a) * this.aFast : a + (this.envFast - a) * this.rFast;
      this.envSlow = a > this.envSlow ? a + (this.envSlow - a) * this.aSlow : a + (this.envSlow - a) * this.rSlow;
      const d = this.envFast - this.envSlow;
      let target;
      if (d > 0) target = this.attDb * Math.min(1, d / (this.envFast + 1e-9)); // attack region
      else target = this.susDb * Math.min(1, -d / (this.envSlow + 1e-9));      // sustain region
      this.gainDb = target + (this.gainDb - target) * this.gSmooth;
      const g = Math.pow(10, this.gainDb / 20) * og;
      for (let ch = 0; ch < chans; ch++) output[ch][i] = input[ch][i] * g;
      if (Math.abs(this.gainDb) > Math.abs(this.meterGain)) this.meterGain = this.gainDb;
    }

    this.frames += n;
    if (this.frames >= 256) {
      this.frames = 0;
      this.port.postMessage({ type: "meter", gr: this.meterGain });
      this.meterGain *= 0.6;
    }
    return true;
  }
}

registerProcessor("trans-processor", TransProcessor);
