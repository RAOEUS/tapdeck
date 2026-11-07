// Auto-gain / loudness leveler (AGC). Measures K-weighted (ITU-R BS.1770)
// momentary loudness and slowly rides a broadband gain to hold a target LUFS -
// bringing quiet content up and loud content down. Boost is slow (no pumping
// between words); cut is faster (tames loud bursts). A gate freezes the gain
// when the signal drops below a floor so it never pumps up silence/noise, and a
// Range limits how far it will move. A built-in brick-wall peak limiter (-1 dBFS,
// zero overshoot) means even large boosts never clip.
// Params: { target(LUFS), speed(0..100), range(dB), gate(LUFS) }.
// Posts a scrolling [lufs, gainDb] trace for the display: { type:'meter', s }.

const { kbiquad, kWeightCoeffs } = TapdeckDSP; // shared K-weighting (worklet/dsp-shared.js)

class AutoGainProcessor extends BaseProcessor {
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
    // settle-in: for the first seconds after (re)start the boost side moves fast, so
    // starting on a quiet film doesn't mean waiting several seconds for the dialogue
    // to come up. Ends early once the gain is within 1 dB of where it wants to be.
    this.lockLeft = Math.round(3 * sampleRate); this.lockCoeff = Math.exp(-1 / (0.15 * sampleRate));
    this.frames = 0; this.trace = [];
    this.anLeft = 0; this.aid = 0; this.anSum = 0; this.anCount = 0; // integrated-loudness measure
    this.recalc();
  }

  setParams(d) {
    if (typeof d.target === "number") this.target = d.target;
    if (typeof d.speed === "number") this.speed = d.speed;
    if (typeof d.range === "number") this.range = d.range;
    if (typeof d.gate === "number") this.gate = d.gate;
    if (typeof d.analyze === "number") { this.anLeft = Math.round(d.analyze * sampleRate); this.anSum = 0; this.anCount = 0; }
    this.recalc();
  }

  recalc() {
    const s = Math.min(1, Math.max(0, this.speed / 100));
    // log-spaced so the upper half of the knob is genuinely fast (dialog/film) while
    // the lower half stays album-gentle: rise 4 s -> 1.3 s (50) -> 0.4 s; fall 0.25 -> 0.05 s
    const riseT = 4.0 * Math.pow(0.1, s);   // boost (up) time constant
    const fallT = 0.25 * Math.pow(0.2, s);  // cut (down) is always fast so loud onsets are caught quickly
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
      let co = desired < this.gainDb ? this.downCoeff : this.upCoeff;
      if (this.lockLeft > 0 && lufs > gate) { // settle-in (only while there's signal to judge by)
        if (Math.abs(desired - this.gainDb) < 1) this.lockLeft = 0; else { this.lockLeft--; if (co === this.upCoeff) co = this.lockCoeff; }
      }
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
      if (this.trace.length >= 16) { this.meter({ s: this.trace }); this.trace = []; }
    }

    if (this.anLeft > 0) { // finish a loudness measurement when its window elapses
      this.anLeft -= n;
      if (this.anLeft <= 0) {
        this.aid++;
        const il = this.anCount > 0 ? -0.691 + 10 * Math.log10(this.anSum / this.anCount + 1e-12) : -120;
        this.meter({ analysis: { lufs: il, aid: this.aid, n: this.anCount } });
        this.anSum = 0; this.anCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("autogain-processor", AutoGainProcessor);
