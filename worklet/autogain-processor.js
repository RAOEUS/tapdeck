// Auto-gain / loudness leveler (AGC). Measures K-weighted (ITU-R BS.1770)
// momentary loudness and slowly rides a broadband gain to hold a target LUFS —
// bringing quiet content up and loud content down. Boost is slow (no pumping
// between words); cut is faster (tames loud bursts). A gate freezes the gain
// when the signal drops below a floor so it never pumps up silence/noise, and a
// Range limits how far it will move. A final clamp prevents digital overs (add a
// Limiter after it for clean peak control).
// Params: { target(LUFS), speed(0..100), range(dB), gate(LUFS) }.
// Posts a scrolling [lufs, gainDb] trace for the display: { type:'meter', s }.

function kbiquad(c, st, x) {
  const y = c[0] * x + c[1] * st[0] + c[2] * st[1] - c[3] * st[2] - c[4] * st[3];
  st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y;
  return y;
}
function kWeightCoeffs(sr) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / sr); a0 = 1 + K / Q + K * K;
  const s2 = [1 / a0, -2 / a0, 1 / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return [s1, s2];
}

class AutoGainProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.target = -16; this.speed = 50; this.range = 12; this.gate = -45;
    this.gainDb = 0;
    this.kPow = 0;
    this.aPow = 1 - Math.exp(-1 / (0.4 * sampleRate)); // ~400 ms momentary loudness
    [this.kw1, this.kw2] = kWeightCoeffs(sampleRate);
    this.kSt = [[[0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0]]];
    this.frames = 0; this.trace = [];
    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.target === "number") this.target = d.target;
      if (typeof d.speed === "number") this.speed = d.speed;
      if (typeof d.range === "number") this.range = d.range;
      if (typeof d.gate === "number") this.gate = d.gate;
      this.recalc();
    };
  }

  recalc() {
    const s = Math.min(1, Math.max(0, this.speed / 100));
    const riseT = 4.0 * (1 - s) + 0.4 * s;   // boost (up) time constant, slow -> fast
    const fallT = riseT * 0.35;              // cut (down) faster, to catch loud bursts
    this.upCoeff = Math.exp(-1 / (riseT * sampleRate));
    this.downCoeff = Math.exp(-1 / (fallT * sampleRate));
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length, chans = Math.min(2, input.length);
    const target = this.target, range = this.range, gate = this.gate;
    let lufs = -120;

    for (let i = 0; i < n; i++) {
      // K-weighted summed-channel power -> momentary loudness
      let kp = 0;
      for (let ch = 0; ch < chans; ch++) {
        const k = kbiquad(this.kw2, this.kSt[ch][1], kbiquad(this.kw1, this.kSt[ch][0], input[ch][i]));
        kp += k * k;
      }
      this.kPow += (kp - this.kPow) * this.aPow;
      lufs = -0.691 + 10 * Math.log10(this.kPow + 1e-12);

      // desired gain toward the target, gated + range-limited; hold below the gate
      let desired = this.gainDb;
      if (lufs > gate) { desired = target - lufs; if (desired > range) desired = range; else if (desired < -range) desired = -range; }
      const co = desired < this.gainDb ? this.downCoeff : this.upCoeff;
      this.gainDb = desired + (this.gainDb - desired) * co;

      const g = Math.pow(10, this.gainDb / 20);
      for (let ch = 0; ch < chans; ch++) {
        let o = input[ch][i] * g;
        if (o > 1) o = 1; else if (o < -1) o = -1; // safety clamp (use a Limiter after for clean peaks)
        output[ch][i] = o;
      }
    }

    this.frames += n;
    if (this.frames >= 256) {
      this.frames = 0;
      this.trace.push(lufs, this.gainDb);
      if (this.trace.length >= 16) { this.port.postMessage({ type: "meter", s: this.trace }); this.trace = []; }
    }
    return true;
  }
}

registerProcessor("autogain-processor", AutoGainProcessor);
