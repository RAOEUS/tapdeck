// Saturation / exciter: drives the signal into a waveshaper to add harmonics,
// with a tilt "tone" control, parallel dry/wet mix and output trim.
// Params: { drive(dB), type, tone(-100..100), mix(%), output(dB) }.
// Posts output peak for the meter: { type:'meter', level: dBFS }.

class SatProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.drive = 0; this.mode = "tube"; this.tone = 0; this.mix = 100; this.output = 0;
    this.lpL = 0; this.lpR = 0;          // tone tilt one-pole state
    this.frames = 0; this.peak = 0;
    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.drive === "number") this.drive = d.drive;
      if (typeof d.mode === "string") this.mode = d.mode;
      if (typeof d.tone === "number") this.tone = d.tone;
      if (typeof d.mix === "number") this.mix = d.mix;
      if (typeof d.output === "number") this.output = d.output;
      this.recalc();
    };
  }

  recalc() {
    this.driveLin = Math.pow(10, this.drive / 20);
    this.outLin = Math.pow(10, this.output / 20);
    this.toneCoeff = 1 - Math.exp(-2 * Math.PI * 900 / sampleRate); // tilt pivot ~900 Hz
  }

  // waveshapers - all roughly unity for small x, saturating past |x|≈1
  shape(x) {
    switch (this.mode) {
      case "hard": return x < -1 ? -1 : x > 1 ? 1 : x;
      case "tape": return Math.tanh(x);                          // symmetric, odd harmonics
      case "crunch": { const c = x < -1 ? -1 : x > 1 ? 1 : x; return 1.5 * c - 0.5 * c * c * c; }
      case "fold": { let y = x; for (let k = 0; k < 4 && (y > 1 || y < -1); k++) y = y > 1 ? 2 - y : -2 - y; return y; }
      case "tube": default: { const b = 0.18; return Math.tanh(x + b) - Math.tanh(b); } // asymmetric → even harmonics
    }
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length, chans = input.length;
    const dr = this.driveLin, mixF = this.mix * 0.01, og = this.outLin;
    const tone = this.tone * 0.01, tc = this.toneCoeff;
    const lo = 1 - Math.max(0, tone) * 0.6, hi = 1 + tone * 0.7; // tilt gains

    for (let ch = 0; ch < chans; ch++) {
      const inp = input[ch], out = output[ch];
      let lp = ch === 0 ? this.lpL : this.lpR;
      for (let i = 0; i < n; i++) {
        const x = inp[i];
        let w = this.shape(x * dr);
        lp += (w - lp) * tc;                 // tilt: split lo/hi around the pivot
        w = lp * lo + (w - lp) * hi;
        const o = (x * (1 - mixF) + w * mixF) * og;
        out[i] = o;
        const a = Math.abs(o); if (a > this.peak) this.peak = a;
      }
      if (ch === 0) this.lpL = lp; else this.lpR = lp;
    }

    this.frames += n;
    if (this.frames >= 1024) {
      this.frames = 0;
      this.port.postMessage({ type: "meter", level: 20 * Math.log10(this.peak + 1e-9) });
      this.peak *= 0.4;
    }
    return true;
  }
}

registerProcessor("sat-processor", SatProcessor);
