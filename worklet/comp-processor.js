// Feed-forward / feed-back compressor, stereo-linked, soft knee, peak detector.
// Params via port: { threshold(dB), ratio, attack(ms), release(ms), knee(dB),
//                    makeup(dB), detector: 'feedforward' | 'feedback' }.
//
// Feedforward: the side-chain detector reads the INPUT (modern, precise).
// Feedback:    it reads the gain element's OUTPUT (pre-makeup) from the previous
//              sample (vintage; self-regulating, softer knee in practice).
//
// Posts gain reduction (throttled) for the meter: { type:'meter', gr: dB >= 0 }.

function softComp(over, ratio, knee) {
  if (knee > 0 && over > -knee / 2 && over < knee / 2) { const x = over + knee / 2; return ((1 - 1 / ratio) * x * x) / (2 * knee); }
  if (over <= 0) return 0;
  return over * (1 - 1 / ratio);
}
// RBJ high-pass (Q=0.707) for the side-chain filter, + a direct-form-I evaluator
function hpCoef(f, sr) {
  const w0 = (2 * Math.PI * Math.min(Math.max(f, 10), sr / 2 - 10)) / sr;
  const c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * 0.70710678), a0 = 1 + al;
  return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
}
function biq(co, st, x) { const y = co.b0 * x + co.b1 * st[0] + co.b2 * st[1] - co.a1 * st[2] - co.a2 * st[3]; st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y; return y; }

class CompProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = -18;
    this.ratio = 4;
    this.attack = 10;
    this.release = 120;
    this.knee = 6;
    this.makeup = 0;
    this.detector = "feedforward";
    this.mode = "down";   // down | up | expand | ott
    this.range = 24;      // max boost/cut for up/expand/ott (dB)
    this.ratioUp = 4;     // OTT upward ratio (independent of the downward ratio)
    this.mix = 100;       // dry/wet (%) - parallel compression
    this.scHpf = 20;      // side-chain high-pass (Hz); <=20 = off (detector reacts less to bass)

    this.envGain = 0;     // smoothed signed gain (dB; - cut, + boost)
    this.fbLevel = 0;     // last gain-element output peak (linear), for feedback
    this.fbMono = 0;      // last gain-element output (mono, signed) for filtered feedback detection
    this.scSt = [0, 0, 0, 0]; // side-chain HPF state
    this.autoMakeup = false;  // adaptive makeup: match output loudness to input (ignores the makeup knob)
    this.makeupG = 1; this.aMk = 1 - Math.exp(-128 / (0.4 * sampleRate)); // ~400 ms makeup smoothing
    this.batch = [];      // [level,gain, ...] one pair per render quantum

    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.threshold === "number") this.threshold = d.threshold;
      if (typeof d.ratio === "number") this.ratio = d.ratio;
      if (typeof d.attack === "number") this.attack = d.attack;
      if (typeof d.release === "number") this.release = d.release;
      if (typeof d.knee === "number") this.knee = d.knee;
      if (typeof d.makeup === "number") this.makeup = d.makeup;
      if (typeof d.detector === "string") this.detector = d.detector;
      if (typeof d.mode === "string") this.mode = d.mode;
      if (typeof d.range === "number") this.range = d.range;
      if (typeof d.ratioUp === "number") this.ratioUp = d.ratioUp;
      if (typeof d.mix === "number") this.mix = d.mix;
      if (typeof d.scHpf === "number") this.scHpf = d.scHpf;
      if (typeof d.autoMakeup === "boolean") this.autoMakeup = d.autoMakeup;
      this.recalc();
    };
  }

  recalc() {
    this.atkCoeff = Math.exp(-1 / (Math.max(0.1, this.attack) * 0.001 * sampleRate));
    this.relCoeff = Math.exp(-1 / (Math.max(1, this.release) * 0.001 * sampleRate));
    this.makeupLin = Math.pow(10, this.makeup / 20);
    this.scActive = this.scHpf > 20;
    this.scCoef = this.scActive ? hpCoef(this.scHpf, sampleRate) : null;
  }

  // signed gain in dB (+ boost, - cut)
  dyn(level) {
    const over = level - this.threshold, r = this.ratio, k = this.knee;
    if (this.mode === "up") return Math.min(this.range, softComp(-over, r, k));
    if (this.mode === "ott") return Math.min(this.range, softComp(-over, this.ratioUp || r, k)) - softComp(over, r, k);
    if (this.mode === "expand") { if (over >= 0) return 0; return -Math.min(this.range, (-over) * (r - 1)); }
    return -softComp(over, r, k);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    const chans = input.length;
    const feedback = this.detector === "feedback";

    let qLevel = -100, qGain = 0; // this quantum's peak input level + most-extreme gain
    let inSq = 0, outSq = 0;      // for adaptive auto-makeup level match
    const mixF = this.mix * 0.01; // 0 = dry, 1 = full wet

    for (let i = 0; i < n; i++) {
      // input peak (always, for the level meter)
      let inPeak = 0;
      for (let ch = 0; ch < chans; ch++) {
        const a = Math.abs(input[ch][i]);
        if (a > inPeak) inPeak = a;
      }
      // Detector source: input (feedforward) or previous gain-element output (feedback).
      // With the side-chain HPF active, detect on a high-passed mono sum so bass
      // doesn't drive the compression; otherwise keep the exact peak behavior.
      let detLevel;
      if (this.scActive) {
        const src = feedback ? this.fbMono : 0.5 * (input[0][i] + (chans > 1 ? input[1][i] : input[0][i]));
        detLevel = Math.abs(biq(this.scCoef, this.scSt, src));
      } else {
        detLevel = feedback ? this.fbLevel : inPeak;
      }
      const levelDb = 20 * Math.log10(detLevel + 1e-9);
      const targetGain = this.dyn(levelDb); // signed
      const coeff = Math.abs(targetGain) > Math.abs(this.envGain) ? this.atkCoeff : this.relCoeff;
      this.envGain = targetGain + (this.envGain - targetGain) * coeff;

      const g = Math.pow(10, this.envGain / 20); // gain-element gain (pre-makeup)
      // auto-makeup ignores the manual makeup knob and level-matches afterwards
      const eff = (1 - mixF) + mixF * g * (this.autoMakeup ? 1 : this.makeupLin);
      let outPeak = 0;
      for (let ch = 0; ch < chans; ch++) {
        const x = input[ch][i];
        const pre = x * g; // wet, pre-makeup (for feedback detection)
        const o = x * eff;
        output[ch][i] = o;
        inSq += x * x; outSq += o * o;
        const a = Math.abs(pre);
        if (a > outPeak) outPeak = a;
      }
      this.fbLevel = outPeak; // detector source for the next sample in feedback
      this.fbMono = 0.5 * (input[0][i] + (chans > 1 ? input[1][i] : input[0][i])) * g; // mono output for filtered feedback

      const inDb = 20 * Math.log10(inPeak + 1e-9);
      if (inDb > qLevel) qLevel = inDb;
      if (Math.abs(this.envGain) > Math.abs(qGain)) qGain = this.envGain;
    }

    // adaptive auto-makeup: smoothly match output loudness to input (±~18/-12 dB)
    if (this.autoMakeup) {
      const target = Math.min(8, Math.max(0.25, Math.sqrt(inSq / (outSq + 1e-12))));
      this.makeupG += (target - this.makeupG) * this.aMk;
      const mg = this.makeupG;
      for (let ch = 0; ch < chans; ch++) { const o = output[ch]; for (let i = 0; i < n; i++) o[i] *= mg; }
    } else this.makeupG = 1;

    // one (level, signed-gain) sample per quantum, sent in small bursts
    this.batch.push(qLevel, qGain);
    if (this.batch.length >= 8) {
      this.port.postMessage({ type: "meter", s: this.batch });
      this.batch = [];
    }
    return true;
  }
}

registerProcessor("comp-processor", CompProcessor);
