// Utility: gain, stereo balance, width (mid/side), mono fold, phase invert per
// channel, and L/R swap. Also meters output stereo correlation + per-channel RMS
// for a width/balance display. Posts: { type:'meter', corr, rmsL, rmsR }.

class UtilityProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gain = 0; this.pan = 0; this.width = 1;
    this.mono = false; this.invL = false; this.invR = false; this.swap = false;
    this.crossfeed = 0; // headphone crossfeed amount (%)
    this.cfL = new Float32Array(64); this.cfR = new Float32Array(64); this.cfPos = 0; this.cfLpA = 0; this.cfLpB = 0;
    this.accLL = 0; this.accRR = 0; this.accLR = 0; this.frames = 0;
    this.scope = []; this.scopeStride = 0; // decimated L/R points for the goniometer
    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.gain === "number") this.gain = d.gain;
      if (typeof d.pan === "number") this.pan = d.pan;
      if (typeof d.width === "number") this.width = d.width;
      if (typeof d.mono === "boolean") this.mono = d.mono;
      if (typeof d.invL === "boolean") this.invL = d.invL;
      if (typeof d.invR === "boolean") this.invR = d.invR;
      if (typeof d.swap === "boolean") this.swap = d.swap;
      if (typeof d.crossfeed === "number") this.crossfeed = d.crossfeed;
      this.recalc();
    };
  }

  recalc() {
    this.gLin = Math.pow(10, this.gain / 20);
    // linear balance: the favoured side stays at unity
    this.bL = this.pan <= 0 ? 1 : 1 - this.pan;
    this.bR = this.pan >= 0 ? 1 : 1 + this.pan;
    this.cfLin = this.crossfeed * 0.01 * 0.7;             // 0..0.7 blend of the opposite ear
    this.cfDelay = Math.max(1, Math.round(0.0003 * sampleRate)); // ~0.3 ms inter-aural delay
    this.cfLpCoeff = 1 - Math.exp(-2 * Math.PI * 700 / sampleRate); // head-shadow low-pass ~700 Hz
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    const L = input[0], R = input[1] || input[0];
    const outL = output[0], outR = output[1] || output[0];
    const g = this.gLin, w = this.mono ? 0 : this.width;
    const sL = this.invL ? -1 : 1, sR = this.invR ? -1 : 1;
    const bL = this.bL * g, bR = this.bR * g;
    const cf = this.cfLin, cfd = this.cfDelay, cflp = this.cfLpCoeff;

    for (let i = 0; i < n; i++) {
      let l = L[i] * sL, r = R[i] * sR;
      if (this.swap) { const t = l; l = r; r = t; }
      const mid = (l + r) * 0.5, side = (l - r) * 0.5 * w;
      l = (mid + side) * bL;
      r = (mid - side) * bR;
      if (cf > 0) { // crossfeed: blend a delayed, low-passed bit of the opposite ear
        this.cfL[this.cfPos] = l; this.cfR[this.cfPos] = r;
        const rp = (this.cfPos - cfd + 64) % 64;
        this.cfLpA += (this.cfR[rp] - this.cfLpA) * cflp;
        this.cfLpB += (this.cfL[rp] - this.cfLpB) * cflp;
        l = (l + cf * this.cfLpA) / (1 + cf);
        r = (r + cf * this.cfLpB) / (1 + cf);
        this.cfPos = (this.cfPos + 1) % 64;
      }
      outL[i] = l; if (outR !== outL) outR[i] = r;

      this.accLL += l * l; this.accRR += r * r; this.accLR += l * r;
      if (++this.scopeStride >= 2) { this.scopeStride = 0; this.scope.push(l, r); } // decimate ~1/2
    }

    this.frames += n;
    if (this.frames >= 512) {
      const denom = Math.sqrt(this.accLL * this.accRR) + 1e-12;
      const corr = this.accLR / denom; // -1..+1
      const rmsL = Math.sqrt(this.accLL / this.frames), rmsR = Math.sqrt(this.accRR / this.frames);
      this.port.postMessage({ type: "meter", corr, rmsL, rmsR, scope: this.scope });
      this.accLL = this.accRR = this.accLR = 0; this.frames = 0; this.scope = [];
    }
    return true;
  }
}

registerProcessor("utility-processor", UtilityProcessor);
