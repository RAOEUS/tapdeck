// Multi-band parametric EQ. A cascade of biquads, each independently typed.
// Bands are pushed from the UI via port messages: { bands: [{type,freq,q,gain,enabled}] }.
// Coefficient formulas are the RBJ Audio EQ Cookbook; the UI replicates the
// exact same math to draw the response curve so the picture matches the sound.

const TYPES = new Set([
  "peaking", "lowshelf", "highshelf",
  "lowpass", "highpass", "bandpass", "notch", "allpass",
]);
const GAIN_FILTERS = new Set(["peaking", "lowshelf", "highshelf"]); // dry/wet scales these

function designBiquad(type, freq, q, gainDb, sr) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.max(10, Math.min(freq, sr / 2 - 10))) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(0.0001, q));
  const sqrtA = Math.sqrt(A);
  let b0, b1, b2, a0, a1, a2;

  switch (type) {
    case "lowpass":
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case "highpass":
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case "bandpass": // constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case "notch":
      b0 = 1; b1 = -2 * cos; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case "allpass":
      b0 = 1 - alpha; b1 = -2 * cos; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case "lowshelf":
      b0 = A * ((A + 1) - (A - 1) * cos + 2 * sqrtA * alpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - 2 * sqrtA * alpha);
      a0 = (A + 1) + (A - 1) * cos + 2 * sqrtA * alpha;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - 2 * sqrtA * alpha; break;
    case "highshelf":
      b0 = A * ((A + 1) + (A - 1) * cos + 2 * sqrtA * alpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - 2 * sqrtA * alpha);
      a0 = (A + 1) - (A - 1) * cos + 2 * sqrtA * alpha;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - 2 * sqrtA * alpha; break;
    case "peaking":
    default:
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
  }

  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
    a1: a1 / a0, a2: a2 / a0,
  };
}

// Butterworth section Q values for an Nth-order (N even) low/high-pass, realized
// as N/2 cascaded biquads at the same cutoff. Higher order = steeper slope.
function butterQs(order) {
  const qs = [];
  for (let k = 0; k < order / 2; k++) qs.push(1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order))));
  return qs;
}
// expand a band into one-or-more biquad section specs
function sectionSpecs(b) {
  if (b.type === "lowpass" || b.type === "highpass") {
    const order = Math.max(2, Math.min(8, Math.round((b.slope || 12) / 6))); // 12/24/36/48 dB/oct -> 2/4/6/8
    if (order <= 2) return [{ type: b.type, freq: b.freq, q: b.q, gain: 0 }]; // 12 dB/oct keeps the resonant Q
    return butterQs(order).map((q) => ({ type: b.type, freq: b.freq, q, gain: 0 })); // flat Butterworth cascade
  }
  return [{ type: b.type, freq: b.freq, q: b.q, gain: b.gain || 0 }];
}

function biquadF(c, st, x) { // direct form I, st = [x1,x2,y1,y2] (for the dynamic detector)
  const y = c.b0 * x + c.b1 * st[0] + c.b2 * st[1] - c.a1 * st[2] - c.a2 * st[3];
  st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y;
  return y;
}

class EQProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // each band: { target, cur (smoothed coeffs), state: [[x1,x2,y1,y2], ...] }
    this.bands = [];
    this.preampLin = 1; this.preampDb = 0; // broadband output gain (AutoEQ "Preamp")
    this.mix = 100; this.mixF = 1; this.specs = []; // dry/wet: scales bell/shelf gains (phase-coherent, no comb filtering)
    // one-pole coefficient smoothing (~6 ms) - removes zipper noise while dragging
    this.smoothA = 1 - Math.exp(-1 / (0.006 * sampleRate));
    this.detAtk = Math.exp(-1 / (0.001 * sampleRate)); // dynamic detector envelope: 1 ms attack
    this.detRel = Math.exp(-1 / (0.05 * sampleRate));  // 50 ms release
    this.frames = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      let rebuild = false;
      if (typeof d.preamp === "number") { this.preampDb = d.preamp; rebuild = true; }
      if (typeof d.mix === "number") { this.mix = d.mix; this.mixF = d.mix * 0.01; rebuild = true; }
      if (Array.isArray(d.bands)) { this.specs = d.bands; rebuild = true; }
      if (rebuild) this.setBands(this.specs);
    };
  }

  setBands(specs) {
    this.preampLin = Math.pow(10, (this.preampDb * this.mixF) / 20); // preamp scales with dry/wet too
    const old = this.bands;
    const filtered = specs.filter((b) => b.enabled !== false && TYPES.has(b.type));
    this.bands = filtered.map((b, i) => {
      const prev = old[i]; // same index during a drag -> keep state + smooth from current
      const specsForBand = sectionSpecs(b);
      // dynamic bands (compression per band): only on single-section bell/shelf filters
      const dyn = b.dynMode && b.dynMode !== "off" && specsForBand.length === 1 && b.type !== "lowpass" && b.type !== "highpass";
      return {
        sections: specsForBand.map((sp, si) => {
          const g = GAIN_FILTERS.has(sp.type) ? sp.gain * this.mixF : sp.gain; // dry/wet = scale the bell/shelf gain
          const target = designBiquad(sp.type, sp.freq, sp.q, g, sampleRate);
          const ps = prev && prev.sections && prev.sections[si];
          return { target, cur: ps ? ps.cur : { ...target }, state: ps ? ps.state : [] };
        }),
        dynMode: dyn ? b.dynMode : "off",
        dynThr: typeof b.dynThr === "number" ? b.dynThr : -30,
        dynRange: Math.abs(typeof b.dynRange === "number" ? b.dynRange : 6),
        dynAtk: Math.exp(-1 / (Math.max(0.1, b.dynAtk || 5) * 0.001 * sampleRate)),
        dynRel: Math.exp(-1 / (Math.max(1, b.dynRel || 100) * 0.001 * sampleRate)),
        det: dyn ? designBiquad("bandpass", b.freq, Math.max(0.7, b.q), 0, sampleRate) : null,
        detState: prev ? prev.detState : [0, 0, 0, 0],
        env: prev ? prev.env : 0, dynDb: prev ? prev.dynDb : 0,
        sGain: b.gain || 0, sType: b.type, sFreq: b.freq, sQ: b.q,
      };
    });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const chans = input.length;
    const n = input[0].length;
    const a = this.smoothA;

    for (let ch = 0; ch < chans; ch++) output[ch].set(input[ch]); // cascade runs in place

    // dynamic bands: run each one's sidechain detector over the (original) input and
    // redesign its filter at static + dynamic gain before the cascade applies it.
    const L = input[0], R = input[1] || input[0];
    let anyDyn = false;
    for (let bi = 0; bi < this.bands.length; bi++) {
      const band = this.bands[bi];
      if (band.dynMode === "off" || !band.det) { band.dynDb = 0; continue; }
      anyDyn = true;
      const ds = band.detState;
      for (let i = 0; i < n; i++) {
        const x = Math.abs(biquadF(band.det, ds, 0.5 * (L[i] + R[i])));
        band.env = x > band.env ? x + (band.env - x) * this.detAtk : x + (band.env - x) * this.detRel;
        const over = 20 * Math.log10(band.env + 1e-9) - band.dynThr;
        let tgt;
        if (band.dynMode === "up") tgt = over > 0 ? Math.min(band.dynRange, over) : 0;
        else if (band.dynMode === "below") tgt = over < 0 ? Math.min(band.dynRange, -over) : 0;
        else if (band.dynMode === "ott") tgt = over > 0 ? -Math.min(band.dynRange, over) : Math.min(band.dynRange, -over); // cut loud + boost quiet
        else tgt = over > 0 ? -Math.min(band.dynRange, over) : 0;
        // attack = reacting to the trigger, release = returning to rest. For 'below'
        // (lift when quiet) the trigger is the band getting LOUD -> pull the boost off
        // fast, lift back slowly; for the loud-triggered modes it's the opposite.
        const engaging = band.dynMode === "below" ? Math.abs(tgt) < Math.abs(band.dynDb) : Math.abs(tgt) > Math.abs(band.dynDb);
        band.dynDb = tgt + (band.dynDb - tgt) * (engaging ? band.dynAtk : band.dynRel);
      }
      band.sections[0].target = designBiquad(band.sType, band.sFreq, band.sQ, (band.sGain + band.dynDb) * this.mixF, sampleRate);
    }

    for (let bi = 0; bi < this.bands.length; bi++) {
      const sections = this.bands[bi].sections;
      for (let si = 0; si < sections.length; si++) {
        const sec = sections[si], c = sec.cur, t = sec.target;
        for (let ch = 0; ch < chans; ch++) if (!sec.state[ch]) sec.state[ch] = [0, 0, 0, 0];

        for (let i = 0; i < n; i++) {
          // ramp coefficients toward target once per sample, shared across channels
          c.b0 += (t.b0 - c.b0) * a; c.b1 += (t.b1 - c.b1) * a; c.b2 += (t.b2 - c.b2) * a;
          c.a1 += (t.a1 - c.a1) * a; c.a2 += (t.a2 - c.a2) * a;

          for (let ch = 0; ch < chans; ch++) {
            const s = sec.state[ch];
            const xn = output[ch][i];
            const yn = c.b0 * xn + c.b1 * s[0] + c.b2 * s[1] - c.a1 * s[2] - c.a2 * s[3];
            s[1] = s[0]; s[0] = xn; s[3] = s[2]; s[2] = yn;
            output[ch][i] = yn;
          }
        }
      }
    }

    if (this.preampLin !== 1) {
      for (let ch = 0; ch < chans; ch++) { const o = output[ch]; for (let i = 0; i < n; i++) o[i] *= this.preampLin; }
    }

    this.frames += n; // ship live per-band dynamic gain so the UI can move the nodes
    if (this.frames >= 256) {
      this.frames = 0;
      if (anyDyn) this.port.postMessage({ type: "meter", mb: this.bands.map((b) => b.dynMode !== "off" ? b.dynDb : 0) });
    }
    return true;
  }
}

registerProcessor("eq-processor", EQProcessor);
