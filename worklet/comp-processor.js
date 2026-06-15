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

    this.envGain = 0;     // smoothed signed gain (dB; - cut, + boost)
    this.fbLevel = 0;     // last gain-element output peak (linear), for feedback
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
      this.recalc();
    };
  }

  recalc() {
    this.atkCoeff = Math.exp(-1 / (Math.max(0.1, this.attack) * 0.001 * sampleRate));
    this.relCoeff = Math.exp(-1 / (Math.max(1, this.release) * 0.001 * sampleRate));
    this.makeupLin = Math.pow(10, this.makeup / 20);
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
    const mixF = this.mix * 0.01; // 0 = dry, 1 = full wet

    for (let i = 0; i < n; i++) {
      // input peak (always, for the level meter)
      let inPeak = 0;
      for (let ch = 0; ch < chans; ch++) {
        const a = Math.abs(input[ch][i]);
        if (a > inPeak) inPeak = a;
      }
      // Detector source: input peak (feedforward) or previous output (feedback).
      const peak = feedback ? this.fbLevel : inPeak;
      const levelDb = 20 * Math.log10(peak + 1e-9);
      const targetGain = this.dyn(levelDb); // signed
      const coeff = Math.abs(targetGain) > Math.abs(this.envGain) ? this.atkCoeff : this.relCoeff;
      this.envGain = targetGain + (this.envGain - targetGain) * coeff;

      const g = Math.pow(10, this.envGain / 20); // gain-element gain (pre-makeup)
      const eff = (1 - mixF) + mixF * g * this.makeupLin; // dry/wet as one phase-coherent gain
      let outPeak = 0;
      for (let ch = 0; ch < chans; ch++) {
        const pre = input[ch][i] * g; // wet, pre-makeup (for feedback detection)
        output[ch][i] = input[ch][i] * eff;
        const a = Math.abs(pre);
        if (a > outPeak) outPeak = a;
      }
      this.fbLevel = outPeak; // detector source for the next sample in feedback

      const inDb = 20 * Math.log10(inPeak + 1e-9);
      if (inDb > qLevel) qLevel = inDb;
      if (Math.abs(this.envGain) > Math.abs(qGain)) qGain = this.envGain;
    }

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
