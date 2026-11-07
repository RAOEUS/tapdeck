// Multiband compressor with a DYNAMIC number of bands. Splits with a serial
// Linkwitz-Riley 4th-order crossover bank (peel off one band per crossover) and
// compresses each band independently (stereo-linked), then sums. Params:
//   { xovers: [f1, f2, ...] (ascending), bands: [ {threshold,ratio,attack,
//     release,knee,makeup,bypass} ]  (length = xovers.length + 1) }
// Posts per-band gain reduction: { type:'meter', mb:[gr0, gr1, ...] }.

const z4 = () => [0, 0, 0, 0];

function softComp(over, ratio, knee) {
  if (knee > 0 && over > -knee / 2 && over < knee / 2) { const x = over + knee / 2; return ((1 - 1 / ratio) * x * x) / (2 * knee); }
  if (over <= 0) return 0;
  return over * (1 - 1 / ratio);
}
// signed gain in dB (+ boost, - cut)
function bandDyn(b, level) {
  const over = level - b.threshold, r = b.ratio, k = b.knee;
  if (b.mode === "up") return Math.min(b.range, softComp(-over, r, k));
  // OTT = simultaneous upward (below threshold) + downward (above) with independent ratios
  if (b.mode === "ott") return Math.min(b.range, softComp(-over, b.ratioUp || r, k)) - softComp(over, r, k);
  if (b.mode === "expand") { if (over >= 0) return 0; return -Math.min(b.range, (-over) * (r - 1)); }
  return -softComp(over, r, k);
}

function biquad(c, st, x) {
  const y = c.b0 * x + c.b1 * st[0] + c.b2 * st[1] - c.a1 * st[2] - c.a2 * st[3];
  st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y;
  return y;
}
function butterworth(type, fc, sr) {
  const w0 = (2 * Math.PI * Math.max(10, Math.min(fc, sr / 2 - 10))) / sr;
  const cos = Math.cos(w0), sin = Math.sin(w0), alpha = sin / Math.SQRT2;
  let b0, b1, b2;
  if (type === "lp") { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
  else { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

class MBCompProcessor extends BaseProcessor {
  constructor() {
    super();
    this.xovers = [250, 2500];
    this.bandParams = [0, 1, 2].map(() => ({ threshold: -24, ratio: 3, attack: 15, release: 150, knee: 6, makeup: 0, bypass: false }));
    this.mix = 100; // dry/wet (%) - parallel multiband
    this.frames = 0;
    this.build();
  }

  setParams(d) {
    if (typeof d.mix === "number") this.mix = d.mix; // mix is not structural - no rebuild
    let structural = false;
    if (Array.isArray(d.xovers)) { this.xovers = d.xovers.slice(); structural = true; }
    if (Array.isArray(d.bands)) { this.bandParams = d.bands.map((b) => ({ ...b })); structural = true; }
    if (structural) this.build();
  }

  build() {
    // LR4 crossover = two Butterworth biquads; keep state per stage per channel
    this.xo = this.xovers.map((f, i) => {
      const prev = this.xo && this.xo[i];
      return {
        lp: butterworth("lp", f, sampleRate), hp: butterworth("hp", f, sampleRate),
        lpS: prev ? prev.lpS : [[z4(), z4()], [z4(), z4()]],
        hpS: prev ? prev.hpS : [[z4(), z4()], [z4(), z4()]],
      };
    });
    this.bands = this.bandParams.map((p, i) => {
      const prev = this.bands && this.bands[i];
      return {
        ...p,
        mode: p.mode || "down", range: typeof p.range === "number" ? p.range : 24,
        ratioUp: typeof p.ratioUp === "number" ? p.ratioUp : p.ratio,
        feedback: p.detector === "feedback",
        envGain: prev ? prev.envGain : 0, fbLevel: prev ? prev.fbLevel : 0,
        meterUp: prev ? prev.meterUp : 0, meterDown: prev ? prev.meterDown : 0,
        atk: Math.exp(-1 / (Math.max(0.1, p.attack) * 0.001 * sampleRate)),
        rel: Math.exp(-1 / (Math.max(1, p.release) * 0.001 * sampleRate)),
        makeupLin: Math.pow(10, p.makeup / 20),
      };
    });
    // Phase-alignment: a band split off at crossover j must still pass through the
    // all-pass (LP4+HP4) of every LATER crossover, or the summed bands ripple at the
    // crossovers (serial LR4 reconstruction is otherwise LP0 + A1·HP0, not flat).
    // comp[x][j] holds the all-pass state applied to band j (< x) at crossover x.
    const prevComp = this.comp;
    this.comp = this.xo.map((_, x) => {
      const row = [];
      for (let j = 0; j < x; j++) {
        const p = prevComp && prevComp[x] && prevComp[x][j];
        row.push(p || { lpS: [[z4(), z4()], [z4(), z4()]], hpS: [[z4(), z4()], [z4(), z4()]] });
      }
      return row;
    });
    this.bL = new Float64Array(this.bands.length);
    this.bR = new Float64Array(this.bands.length);
  }

  lr(coeff, S, ch, x) { return biquad(coeff, S[1][ch], biquad(coeff, S[0][ch], x)); }
  // LR4 all-pass (= LP4 + HP4) at one crossover, applied to an earlier band's signal
  apAllpass(xo, c, ch, d) { return this.lr(xo.lp, c.lpS, ch, d) + this.lr(xo.hp, c.hpS, ch, d); }

  staticGR(b, levelDb) {
    const over = levelDb - b.threshold, k = b.knee;
    if (k > 0 && over > -k / 2 && over < k / 2) { const x = over + k / 2; return ((1 - 1 / b.ratio) * x * x) / (2 * k); }
    if (over <= 0) return 0;
    return over * (1 - 1 / b.ratio);
  }
  bandGain(b, l, r, stereo) {
    if (b.bypass) return 1;
    // feedforward detects the band input; feedback detects its previous output
    const peak = b.feedback ? b.fbLevel : (stereo ? Math.max(Math.abs(l), Math.abs(r)) : Math.abs(l));
    const levelDb = 20 * Math.log10(peak + 1e-9);
    const target = bandDyn(b, levelDb); // signed
    const more = Math.abs(target) > Math.abs(b.envGain); // expander: attack opens, release closes
    const coeff = (more !== (b.mode === "expand")) ? b.atk : b.rel;
    b.envGain = target + (b.envGain - target) * coeff;
    // track cut and boost separately so the UI can show both directions at once (OTT)
    if (b.envGain < 0) { const d = -b.envGain; if (d > b.meterDown) b.meterDown = d; }
    else if (b.envGain > b.meterUp) b.meterUp = b.envGain;
    const g = Math.pow(10, b.envGain / 20);
    const o0 = l * g, o1 = stereo ? r * g : 0;
    b.fbLevel = stereo ? Math.max(Math.abs(o0), Math.abs(o1)) : Math.abs(o0); // pre-makeup output
    return g * b.makeupLin;
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length, chans = input.length;
    const L = input[0], R = input[1] || input[0];
    const outL = output[0], outR = output[1] || output[0];
    const stereo = chans > 1 && outR !== outL;
    const nx = this.xo.length, nb = this.bands.length, bL = this.bL, bR = this.bR;
    const mixF = this.mix * 0.01; // 0 = dry (flat reconstruction), 1 = full wet

    for (let i = 0; i < n; i++) {
      // serial LR split: peel off a low band at each crossover, keep the remainder
      let remL = L[i], remR = stereo ? R[i] : 0;
      for (let x = 0; x < nx; x++) {
        const xo = this.xo[x];
        bL[x] = this.lr(xo.lp, xo.lpS, 0, remL); remL = this.lr(xo.hp, xo.hpS, 0, remL);
        if (stereo) { bR[x] = this.lr(xo.lp, xo.lpS, 1, remR); remR = this.lr(xo.hp, xo.hpS, 1, remR); }
      }
      bL[nx] = remL; if (stereo) bR[nx] = remR;

      // pass each earlier band through later crossovers' all-pass so the bands stay
      // mutually phase-aligned (flat reconstruction at unity gain / full-dry mix)
      for (let x = 1; x < nx; x++) {
        const comp = this.comp[x], xo = this.xo[x];
        for (let j = 0; j < x; j++) {
          const c = comp[j];
          bL[j] = this.apAllpass(xo, c, 0, bL[j]);
          if (stereo) bR[j] = this.apAllpass(xo, c, 1, bR[j]);
        }
      }

      let sumL = 0, sumR = 0;
      for (let b = 0; b < nb; b++) {
        const g = this.bandGain(this.bands[b], bL[b], stereo ? bR[b] : 0, stereo);
        const eff = (1 - mixF) + mixF * g; // blend each band toward unity (dry) -> phase-coherent
        sumL += bL[b] * eff; if (stereo) sumR += bR[b] * eff;
      }
      outL[i] = sumL; if (stereo) outR[i] = sumR;
    }

    this.frames += n;
    if (this.frames >= 256) {
      this.frames = 0;
      this.meter({ mb: this.bands.map((b) => [b.meterDown, b.meterUp]) });
      for (const b of this.bands) { b.meterDown *= 0.6; b.meterUp *= 0.6; }
    }
    return true;
  }
}

registerProcessor("mbcomp-processor", MBCompProcessor);
