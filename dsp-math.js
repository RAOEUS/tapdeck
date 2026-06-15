// Shared, dependency-free DSP math for drawing. The biquad design here is the
// SAME math the EQ worklet uses, so the drawn curve matches what you hear.
window.DSP = (function () {
  function designBiquad(type, freq, q, gainDb, sr) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * Math.max(10, Math.min(freq, sr / 2 - 10))) / sr;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const alpha = sin / (2 * Math.max(0.0001, q));
    const s = Math.sqrt(A);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case "lowpass":
        b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case "highpass":
        b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case "bandpass":
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case "notch":
        b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case "allpass":
        b0 = 1 - alpha; b1 = -2 * cos; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case "lowshelf":
        b0 = A * ((A + 1) - (A - 1) * cos + 2 * s * alpha);
        b1 = 2 * A * ((A - 1) - (A + 1) * cos);
        b2 = A * ((A + 1) - (A - 1) * cos - 2 * s * alpha);
        a0 = (A + 1) + (A - 1) * cos + 2 * s * alpha;
        a1 = -2 * ((A - 1) + (A + 1) * cos);
        a2 = (A + 1) + (A - 1) * cos - 2 * s * alpha; break;
      case "highshelf":
        b0 = A * ((A + 1) + (A - 1) * cos + 2 * s * alpha);
        b1 = -2 * A * ((A - 1) + (A + 1) * cos);
        b2 = A * ((A + 1) + (A - 1) * cos - 2 * s * alpha);
        a0 = (A + 1) - (A - 1) * cos + 2 * s * alpha;
        a1 = 2 * ((A - 1) - (A + 1) * cos);
        a2 = (A + 1) - (A - 1) * cos - 2 * s * alpha; break;
      default: // peaking
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  // |H(e^jw)| in dB for a normalized biquad at frequency f.
  function biquadMagDb(c, f, sr) {
    const w = (2 * Math.PI * f) / sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const numRe = c.b0 + c.b1 * cw + c.b2 * c2;
    const numIm = -(c.b1 * sw + c.b2 * s2);
    const denRe = 1 + c.a1 * cw + c.a2 * c2;
    const denIm = -(c.a1 * sw + c.a2 * s2);
    const num = numRe * numRe + numIm * numIm;
    const den = denRe * denRe + denIm * denIm;
    return 10 * Math.log10(num / den);
  }

  // Static compressor gain reduction (dB, >= 0) with soft knee.
  function compStaticGR(levelDb, threshold, ratio, knee) {
    const over = levelDb - threshold;
    if (knee > 0 && over > -knee / 2 && over < knee / 2) {
      const x = over + knee / 2;
      return ((1 - 1 / ratio) * x * x) / (2 * knee);
    }
    if (over <= 0) return 0;
    return over * (1 - 1 / ratio);
  }

  // Unified dynamics gain (signed dB: + boosts, - cuts). Modes:
  //   down   - downward compression (cut above threshold)
  //   up     - upward compression (boost below threshold, capped by range)
  //   expand - downward expansion (cut below threshold, capped by range)
  //   ott    - upward + downward compression (boost below AND cut above)
  function dynGain(level, mode, threshold, ratio, knee, range, ratioUp) {
    const over = level - threshold;
    if (mode === "up") return Math.min(range, softComp(-over, ratio, knee));
    // ott: independent upward (ratioUp) and downward (ratio) ratios
    if (mode === "ott") return Math.min(range, softComp(-over, ratioUp || ratio, knee)) - softComp(over, ratio, knee);
    if (mode === "expand") { if (over >= 0) return 0; return -Math.min(range, (-over) * (ratio - 1)); }
    return -softComp(over, ratio, knee);
  }
  function softComp(over, ratio, knee) {
    if (knee > 0 && over > -knee / 2 && over < knee / 2) { const x = over + knee / 2; return ((1 - 1 / ratio) * x * x) / (2 * knee); }
    if (over <= 0) return 0;
    return over * (1 - 1 / ratio);
  }

  const GAIN_TYPES = new Set(["peaking", "lowshelf", "highshelf"]);

  return { designBiquad, biquadMagDb, compStaticGR, dynGain, GAIN_TYPES };
})();
