// Auto-gain / loudness leveler (AGC). Measures K-weighted (ITU-R BS.1770)
// momentary loudness and slowly rides a broadband gain to hold a target LUFS -
// bringing quiet content up and loud content down. Boost is slow (no pumping
// between words); cut is faster (tames loud bursts). A gate freezes the gain
// when the signal drops below a floor so it never pumps up silence/noise, and a
// Range limits how far it will move. A built-in brick-wall peak limiter (-1 dBFS,
// zero overshoot) means even large boosts never clip.
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
    // built-in brick-wall: a zero-overshoot peak limiter at -1 dBFS so even large
    // boosts can never clip the output (no scary digital crunch).
    this.limG = 1; this.ceil = Math.pow(10, -1 / 20); this.limRel = Math.exp(-1 / (0.05 * sampleRate));
    // loudness follower: fast attack so a loud onset after silence registers quickly,
    // slower release so the level doesn't jitter (asymmetric momentary loudness).
    this.aAtk = 1 - Math.exp(-1 / (0.05 * sampleRate)); // ~50 ms
    this.aRel = 1 - Math.exp(-1 / (0.4 * sampleRate));  // ~400 ms
    [this.kw1, this.kw2] = kWeightCoeffs(sampleRate);
    this.kSt = [[[0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0]]];
    this.frames = 0; this.trace = [];
    this.anLeft = 0; this.aid = 0; this.anSum = 0; this.anCount = 0; // integrated-loudness measure
    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.target === "number") this.target = d.target;
      if (typeof d.speed === "number") this.speed = d.speed;
      if (typeof d.range === "number") this.range = d.range;
      if (typeof d.gate === "number") this.gate = d.gate;
      if (typeof d.analyze === "number") { this.anLeft = Math.round(d.analyze * sampleRate); this.anSum = 0; this.anCount = 0; }
      this.recalc();
    };
  }

  recalc() {
    const s = Math.min(1, Math.max(0, this.speed / 100));
    const riseT = 4.0 * (1 - s) + 0.4 * s;   // boost (up) time constant: slow album -> fast dialog
    const fallT = 0.25 * (1 - s) + 0.05 * s; // cut (down) is always fast so loud onsets are caught quickly
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
      this.kPow += (kp - this.kPow) * (kp > this.kPow ? this.aAtk : this.aRel);
      lufs = -0.691 + 10 * Math.log10(this.kPow + 1e-12);
      if (this.anLeft > 0 && lufs > -60) { this.anSum += kp; this.anCount++; } // gated integrated-loudness accumulation

      // desired gain toward the target, gated + range-limited; hold below the gate
      let desired = this.gainDb;
      if (lufs > gate) { desired = target - lufs; if (desired > range) desired = range; else if (desired < -range) desired = -range; }
      const co = desired < this.gainDb ? this.downCoeff : this.upCoeff;
      this.gainDb = desired + (this.gainDb - desired) * co;

      const g = Math.pow(10, this.gainDb / 20);
      let oL = input[0][i] * g, oR = chans > 1 ? input[1][i] * g : oL;
      // brick-wall peak limiter (stereo-linked): the gain that keeps this sample at/under
      // the ceiling, applied instantly (no overshoot) and released smoothly.
      const pk = Math.abs(oL) > Math.abs(oR) ? Math.abs(oL) : Math.abs(oR);
      const needed = pk > this.ceil ? this.ceil / pk : 1;
      this.limG = needed < this.limG ? needed : this.limG + (needed - this.limG) * this.limRel;
      oL *= this.limG; oR *= this.limG;
      output[0][i] = oL;
      if (output.length > 1) output[1][i] = oR;
    }

    this.frames += n;
    if (this.frames >= 256) {
      this.frames = 0;
      this.trace.push(lufs, this.gainDb);
      if (this.trace.length >= 16) { this.port.postMessage({ type: "meter", s: this.trace }); this.trace = []; }
    }

    if (this.anLeft > 0) { // finish a loudness measurement when its window elapses
      this.anLeft -= n;
      if (this.anLeft <= 0) {
        this.aid++;
        const il = this.anCount > 0 ? -0.691 + 10 * Math.log10(this.anSum / this.anCount + 1e-12) : -120;
        this.port.postMessage({ type: "meter", analysis: { lufs: il, aid: this.aid, n: this.anCount } });
        this.anSum = 0; this.anCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("autogain-processor", AutoGainProcessor);
