// Look-ahead brick-wall limiter with an attack/hold/release envelope, adjustable
// stereo channel-link, oversampled true-peak detection, per-style character, a
// DC filter, unity-gain matching, and ITU-R BS.1770 LUFS metering.
//
// Params via port: { inputGain(dB), ceiling(dB), attack(ms), release(ms),
//   hold(ms), lookahead(ms), link(%), os (1|2|4), style (string),
//   unity (bool), dc (bool) }.  Also accepts { lufsReset:true }.
// Posts: { type:'meter', s:[inDb,grDb,...] (scrolling trace), gr (peak),
//          lufsM, lufsS, lufsI, peak (output dBFS) }.
//
// The sliding-window maximum over the look-ahead lets the gain duck *before* a
// loud sample reaches the delayed output, so with attack=0 it's a true,
// overshoot-free brick wall. Oversampled detection (os>1) catches inter-sample
// peaks so the reconstructed signal also stays under the ceiling (true peak).
// Attack>0 and the non-transparent styles trade transparency for character; a
// final hard clip at the ceiling always holds the wall.

const MAX_LOOKAHEAD_MS = 10;

// per-style [release multiplier, soft-saturation amount]
const STYLES = {
  transparent: [1.0, 0.0],
  smooth: [1.7, 0.0],
  punchy: [0.55, 0.18],
  aggressive: [0.4, 0.42],
};

function kbiquad(c, st, x) { // direct form I; st = [x1,x2,y1,y2]
  const y = c[0] * x + c[1] * st[0] + c[2] * st[1] - c[3] * st[2] - c[4] * st[3];
  st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y;
  return y;
}
// K-weighting (BS.1770): high-shelf "pre-filter" then RLB high-pass.
function kWeightCoeffs(sr) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = [
    (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0,
    2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0,
  ];
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / sr);
  a0 = 1 + K / Q + K * K;
  const s2 = [1 / a0 * 1, 1 / a0 * -2, 1 / a0 * 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return [s1, s2];
}

// Fractional-delay windowed-sinc interpolators for inter-sample (true) peak
// detection: one set of taps per oversampling phase between two real samples.
function buildInterp(os) {
  const T = 8, c = 3; // taps, and the center sample within the tap window
  const phases = [];
  for (let p = 1; p < os; p++) {
    const f = p / os, h = new Float32Array(T);
    let sum = 0;
    for (let k = 0; k < T; k++) {
      const x = (k - c) - f;
      const s = Math.abs(x) < 1e-6 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / T); // Hann window
      h[k] = s * w; sum += h[k];
    }
    for (let k = 0; k < T; k++) h[k] /= sum; // unity DC gain
    phases.push(h);
  }
  return { T, phases };
}

class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ceiling = -1; this.attack = 0; this.release = 60; this.hold = 5;
    this.lookahead = 5; this.inputGain = 0; this.link = 100;
    this.os = 1; this.style = "transparent"; this.unity = false; this.dc = false;
    this.maxDelay = Math.ceil((MAX_LOOKAHEAD_MS / 1000) * sampleRate) + 1;
    this.delay = [new Float32Array(this.maxDelay), new Float32Array(this.maxDelay)];
    this.writePos = 0;
    this.peak = 0; this.meterGR = 0; this.frames = 0;
    this.t = 0; // absolute input-sample counter
    this.dcX = [0, 0]; this.dcY = [0, 0]; // DC blocker state

    // per-channel limiter state: a monotonic-max deque over the look-ahead window
    // (values strictly decreasing front->back) plus the gain envelope + hold timer.
    this.dqCap = this.maxDelay + 2;
    this.chan = [this.makeChan(), this.makeChan()];

    // scrolling display trace: one [inDb, grDb] pair every `traceDecim` samples,
    // each the max over that span so brief peaks aren't decimated away.
    this.traceDecim = 16; this.traceCtr = 0; this.trace = [];
    this.traceIn = 0; this.traceGR = 0;
    // smooth the displayed level: a raw per-window peak oscillates within each
    // audio cycle (looks "wiggly"); a peak envelope reads as clean mountains.
    this.dispEnv = 0; this.dispRel = Math.exp(-1 / (0.035 * sampleRate)); // ~35 ms release

    // True-peak meter: always 4x, independent of the limiting oversampling. Measures
    // the inter-sample peak of the OUTPUT, so it shows whether the reconstructed
    // signal actually stays under the ceiling (i.e. whether oversampling is needed).
    this.tpInterp = buildInterp(4);
    this.tpBuf = [new Float32Array(this.tpInterp.T), new Float32Array(this.tpInterp.T)];
    this.tpPos = 0; this.meterTP = 0;

    // LUFS state
    [this.kw1, this.kw2] = kWeightCoeffs(sampleRate);
    this.kSt = [[[0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, 0, 0, 0]]]; // [ch][stage]
    this.block = Math.round(0.1 * sampleRate); // 100 ms
    this.blkN = 0; this.blkL = 0; this.blkR = 0;
    this.ring = []; // recent blocks {eL,eR,ns}, up to 30 (3 s)
    this.integEL = 0; this.integER = 0; this.integNS = 0;

    this.recalc();
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.ceiling === "number") this.ceiling = d.ceiling;
      if (typeof d.attack === "number") this.attack = d.attack;
      if (typeof d.release === "number") this.release = d.release;
      if (typeof d.hold === "number") this.hold = d.hold;
      if (typeof d.lookahead === "number") this.lookahead = d.lookahead;
      if (typeof d.inputGain === "number") this.inputGain = d.inputGain;
      if (typeof d.link === "number") this.link = d.link;
      if (typeof d.os === "number") this.os = d.os;
      if (typeof d.style === "string") this.style = d.style;
      if (typeof d.unity === "boolean") this.unity = d.unity;
      if (typeof d.dc === "boolean") this.dc = d.dc;
      if (d.lufsReset) { this.integEL = this.integER = this.integNS = 0; }
      this.recalc();
    };
  }

  makeChan() {
    return { dqVal: new Float32Array(this.dqCap), dqIdx: new Float64Array(this.dqCap), dqHead: 0, dqCount: 0, gain: 1, holdCtr: 0 };
  }

  recalc() {
    this.inGainLin = Math.pow(10, this.inputGain / 20);
    this.ceilingLin = Math.pow(10, this.ceiling / 20);
    this.laSamples = Math.max(1, Math.round((this.lookahead / 1000) * sampleRate));
    const [relMul, sat] = STYLES[this.style] || STYLES.transparent;
    // attack = one-pole smoothing of the gain duck (0 -> instant brick wall)
    this.atkCoeff = this.attack > 0 ? Math.exp(-1 / (this.attack * 0.001 * sampleRate)) : 0;
    this.relCoeff = Math.exp(-1 / (Math.max(1, this.release * relMul) * 0.001 * sampleRate));
    this.holdSamples = Math.max(0, Math.round((this.hold / 1000) * sampleRate));
    this.linkF = Math.min(1, Math.max(0, this.link / 100));
    this.satAmt = sat; this.satK = 1 + sat * 4;
    this.unityComp = this.unity ? 1 / this.inGainLin : 1;
    this.interp = this.os > 1 ? buildInterp(this.os) : null;
  }

  // inter-sample (true) peak of channel `ch` around the newest written sample
  truePeak(ch) {
    const buf = this.delay[ch], md = this.maxDelay, wp = this.writePos;
    let mx = Math.abs(buf[wp]);
    const ip = this.interp;
    if (ip) {
      const T = ip.T, base = wp - (T - 1) + md;
      for (let pi = 0; pi < ip.phases.length; pi++) {
        const h = ip.phases[pi]; let acc = 0;
        for (let k = 0; k < T; k++) acc += h[k] * buf[(base + k) % md];
        const a = Math.abs(acc); if (a > mx) mx = a;
      }
    }
    return mx;
  }

  // inter-sample (true) peak of one output sample, written into its channel ring
  outTruePeak(ch, sample) {
    const ip = this.tpInterp, T = ip.T, buf = this.tpBuf[ch];
    buf[this.tpPos] = sample;
    let mx = Math.abs(sample);
    const base = this.tpPos - (T - 1) + T * 4; // keep index positive before %
    for (let pi = 0; pi < ip.phases.length; pi++) {
      const h = ip.phases[pi]; let acc = 0;
      for (let k = 0; k < T; k++) acc += h[k] * buf[(base + k) % T];
      const a = Math.abs(acc); if (a > mx) mx = a;
    }
    return mx;
  }

  // push one sample's peak into a channel's monotonic deque; return the window max
  pushPeak(C, a) {
    const cap = this.dqCap;
    while (C.dqCount > 0 && C.dqVal[(C.dqHead + C.dqCount - 1) % cap] <= a) C.dqCount--;
    const back = (C.dqHead + C.dqCount) % cap;
    C.dqVal[back] = a; C.dqIdx[back] = this.t; C.dqCount++;
    while (C.dqCount > 1 && C.dqIdx[C.dqHead] < this.t - this.laSamples) { C.dqHead = (C.dqHead + 1) % cap; C.dqCount--; }
    return C.dqVal[C.dqHead];
  }

  // advance one channel's gain envelope toward the gain its windowed peak demands
  stepGain(C, peak, linkedPeak) {
    const pk = this.linkF * linkedPeak + (1 - this.linkF) * peak; // 100% link = both channels share the loudest peak
    const desired = pk > this.ceilingLin ? this.ceilingLin / pk : 1;
    if (desired < C.gain) {                  // need more reduction: attack (or instant), then hold
      C.gain = this.atkCoeff > 0 ? desired + (C.gain - desired) * this.atkCoeff : desired;
      C.holdCtr = this.holdSamples;
    } else if (C.holdCtr > 0) {               // peak passed but still within hold: freeze
      C.holdCtr--;
    } else {                                  // release back toward unity
      C.gain = desired + (C.gain - desired) * this.relCoeff;
    }
    return C.gain;
  }

  // soft saturation toward the ceiling for the coloured styles (hard clip still follows)
  sat(x, ceil) {
    if (this.satAmt <= 0) return x;
    const k = this.satK;
    return ceil * Math.tanh((x / ceil) * k) / Math.tanh(k);
  }

  // window loudness (LUFS) from the last `nBlocks` blocks
  windowLufs(nBlocks) {
    const m = Math.min(nBlocks, this.ring.length);
    if (m === 0) return -120;
    let eL = 0, eR = 0, ns = 0;
    for (let i = this.ring.length - m; i < this.ring.length; i++) { eL += this.ring[i].eL; eR += this.ring[i].eR; ns += this.ring[i].ns; }
    if (ns === 0) return -120;
    return -0.691 + 10 * Math.log10(eL / ns + eR / ns + 1e-12);
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    const chans = Math.min(2, input.length);
    const g = this.inGainLin, ceil = this.ceilingLin, uc = this.unityComp;
    const C0 = this.chan[0], C1 = this.chan[1];
    const R = 0.9995; // DC blocker pole

    for (let i = 0; i < n; i++) {
      let vL = input[0][i] * g;
      let vR = chans > 1 ? input[1][i] * g : vL;
      if (this.dc) {
        const yL = vL - this.dcX[0] + R * this.dcY[0]; this.dcX[0] = vL; this.dcY[0] = yL; vL = yL;
        const yR = vR - this.dcX[1] + R * this.dcY[1]; this.dcX[1] = vR; this.dcY[1] = yR; vR = yR;
      }
      this.delay[0][this.writePos] = vL;
      this.delay[1][this.writePos] = vR;

      const pL = this.pushPeak(C0, this.truePeak(0));
      const pR = chans > 1 ? this.pushPeak(C1, this.truePeak(1)) : pL;
      const linked = pL > pR ? pL : pR;
      const gL = this.stepGain(C0, pL, linked);
      const gR = chans > 1 ? this.stepGain(C1, pR, linked) : gL;

      const readPos = (this.writePos - this.laSamples + this.maxDelay) % this.maxDelay;
      const dL = this.delay[0][readPos], dR = this.delay[1][readPos];
      let oL = this.sat(dL * gL, ceil) * uc, oR = this.sat(dR * gR, ceil) * uc;
      // brick-wall safety: hold the ceiling even if attack/saturation let a sliver through
      if (oL > ceil) oL = ceil; else if (oL < -ceil) oL = -ceil;
      if (oR > ceil) oR = ceil; else if (oR < -ceil) oR = -ceil;
      output[0][i] = oL;
      if (output.length > 1) output[1][i] = oR;

      const ap = Math.abs(oL) > Math.abs(oR) ? Math.abs(oL) : Math.abs(oR);
      if (ap > this.peak) this.peak = ap;
      const tpL = this.outTruePeak(0, oL), tpR = this.outTruePeak(1, oR); // inter-sample (true) peak of the output
      const tpMax = tpL > tpR ? tpL : tpR;
      if (tpMax > this.meterTP) this.meterTP = tpMax;
      this.tpPos = this.tpPos + 1 === this.tpInterp.T ? 0 : this.tpPos + 1;
      const gMin = gL < gR ? gL : gR;
      const grDb = -20 * Math.log10(gMin + 1e-9);
      if (grDb > this.meterGR) this.meterGR = grDb;

      // scrolling-trace accumulation (input level + GR, decimated)
      const inAbs = Math.abs(dL) > Math.abs(dR) ? Math.abs(dL) : Math.abs(dR);
      this.dispEnv = inAbs > this.dispEnv ? inAbs : inAbs + (this.dispEnv - inAbs) * this.dispRel;
      if (this.dispEnv > this.traceIn) this.traceIn = this.dispEnv;
      if (grDb > this.traceGR) this.traceGR = grDb;
      if (++this.traceCtr >= this.traceDecim) {
        this.traceCtr = 0;
        this.trace.push(20 * Math.log10(this.traceIn + 1e-9), this.traceGR);
        this.traceIn = 0; this.traceGR = 0;
      }

      // K-weighted loudness accumulation (on the output)
      const kL = kbiquad(this.kw2, this.kSt[0][1], kbiquad(this.kw1, this.kSt[0][0], oL));
      const kR = kbiquad(this.kw2, this.kSt[1][1], kbiquad(this.kw1, this.kSt[1][0], oR));
      this.blkL += kL * kL; this.blkR += kR * kR; this.blkN++;
      if (this.blkN >= this.block) {
        this.ring.push({ eL: this.blkL, eR: this.blkR, ns: this.blkN });
        if (this.ring.length > 30) this.ring.shift();
        // absolute-gated integrated: include the 400 ms momentary if above -70 LUFS
        if (this.windowLufs(4) > -70) { this.integEL += this.blkL; this.integER += this.blkR; this.integNS += this.blkN; }
        this.blkL = this.blkR = 0; this.blkN = 0;
      }

      this.writePos = (this.writePos + 1) % this.maxDelay;
      this.t++;
    }

    this.frames += n;
    if (this.frames >= 512) {
      this.frames = 0;
      const lufsI = this.integNS > 0 ? -0.691 + 10 * Math.log10(this.integEL / this.integNS + this.integER / this.integNS + 1e-12) : -120;
      this.port.postMessage({
        type: "meter", gr: this.meterGR, s: this.trace,
        lufsM: this.windowLufs(4), lufsS: this.windowLufs(30), lufsI,
        peak: 20 * Math.log10(this.peak + 1e-9),
        tp: 20 * Math.log10(this.meterTP + 1e-9),
      });
      this.trace = [];
      this.meterGR *= 0.6; this.peak *= 0.5; this.meterTP *= 0.5;
    }
    return true;
  }
}

registerProcessor("limiter-processor", LimiterProcessor);
