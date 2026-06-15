// Saturation / exciter: drives the signal into a waveshaper to add harmonics,
// with a tilt "tone" control, parallel dry/wet mix and output trim. Optional
// oversampling runs the (aliasing-prone) waveshaper at 2x/4x and band-limits on
// the way back down, so the generated harmonics above Nyquist don't fold back as
// harshness.
// Params: { drive(dB), type, tone(-100..100), mix(%), output(dB), os(1|2|4) }.
// Posts output peak for the meter: { type:'meter', level: dBFS }.

// Blackman-windowed-sinc low-pass split into `os` polyphase up-subfilters plus the
// full kernel for decimation. Cutoff sits just under the original Nyquist.
function buildOS(os) {
  if (os <= 1) return null;
  const taps = 16 * os, M = taps - 1, cutoff = 0.5 / os * 0.9;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - M / 2;
    const sinc = Math.abs(x) < 1e-9 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / M) + 0.08 * Math.cos((4 * Math.PI * i) / M);
    h[i] = sinc * w; sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum; // unity DC gain
  const subLen = taps / os, up = [];
  for (let p = 0; p < os; p++) {
    const sf = new Float32Array(subLen);
    for (let k = 0; k < subLen; k++) sf[k] = h[k * os + p] * os; // ×os compensates the zero-stuffing
    up.push(sf);
  }
  return { os, taps, subLen, h, up };
}

class SatProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.drive = 0; this.mode = "tube"; this.tone = 0; this.mix = 100; this.output = 0; this.os = 1;
    this.lpL = 0; this.lpR = 0;          // tone tilt one-pole state
    this.frames = 0; this.peak = 0;
    this.osF = null; this.osState = [null, null]; this._osN = 1;
    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.drive === "number") this.drive = d.drive;
      if (typeof d.mode === "string") this.mode = d.mode;
      if (typeof d.tone === "number") this.tone = d.tone;
      if (typeof d.mix === "number") this.mix = d.mix;
      if (typeof d.output === "number") this.output = d.output;
      if (typeof d.os === "number") this.os = d.os;
      this.recalc();
    };
  }

  makeOSState() {
    const F = this.osF;
    return { up: new Float32Array(F.subLen), upPos: 0, dn: new Float32Array(F.taps), dnPos: 0 };
  }

  recalc() {
    this.driveLin = Math.pow(10, this.drive / 20);
    this.outLin = Math.pow(10, this.output / 20);
    this.toneCoeff = 1 - Math.exp(-2 * Math.PI * 900 / sampleRate); // tilt pivot ~900 Hz
    if (this._osN !== this.os) {                 // (re)build filters only when the factor changes
      this.osF = buildOS(this.os);
      this.osState = [this.osF ? this.makeOSState() : null, this.osF ? this.makeOSState() : null];
      this._osN = this.os;
    }
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

  // upsample x by os, waveshape each subsample, band-limit and decimate back down
  osShape(st, x, dr) {
    const F = this.osF, subLen = F.subLen, taps = F.taps;
    st.up[st.upPos] = x;
    let out = 0;
    for (let p = 0; p < F.os; p++) {
      const sf = F.up[p]; let u = 0;
      for (let k = 0; k < subLen; k++) { let idx = st.upPos - k; if (idx < 0) idx += subLen; u += sf[k] * st.up[idx]; }
      st.dn[st.dnPos] = this.shape(u * dr);      // nonlinearity at the oversampled rate
      st.dnPos = st.dnPos + 1 === taps ? 0 : st.dnPos + 1;
      if (p === F.os - 1) {                       // one band-limited output per input sample
        let acc = 0;
        for (let k = 0; k < taps; k++) { let idx = st.dnPos - 1 - k; if (idx < 0) idx += taps; acc += F.h[k] * st.dn[idx]; }
        out = acc;
      }
    }
    st.upPos = st.upPos + 1 === subLen ? 0 : st.upPos + 1;
    return out;
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length, chans = input.length;
    const dr = this.driveLin, mixF = this.mix * 0.01, og = this.outLin;
    const tone = this.tone * 0.01, tc = this.toneCoeff;
    const lo = 1 - Math.max(0, tone) * 0.6, hi = 1 + tone * 0.7; // tilt gains
    const F = this.osF;

    for (let ch = 0; ch < chans; ch++) {
      const inp = input[ch], out = output[ch];
      let lp = ch === 0 ? this.lpL : this.lpR;
      const st = F ? this.osState[ch] : null;
      for (let i = 0; i < n; i++) {
        const x = inp[i];
        let w = st ? this.osShape(st, x, dr) : this.shape(x * dr);
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
