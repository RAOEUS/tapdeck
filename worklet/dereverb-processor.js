// Spectral de-reverb. Overlap-add STFT (512-pt frame, 128 hop = 75% overlap,
// Hann) with a per-bin "decay expander": each bin tracks a peak envelope whose
// release time = the reverb tail you want to remove. When the live magnitude is
// at/above that envelope (an onset or a sustained note) the bin passes; when it
// sits BELOW a still-high envelope - i.e. it's a decaying tail - the bin is
// attenuated. So it pulls down reverb decays between/after sounds while leaving
// transients and steady direct sound intact. Each channel runs independently.
// Params: { amount(0..100), tail(ms), residual(0..100), mix(0..100) }.
// Posts a scrolling [inDb, reductionDb] trace for the display: { type:'meter', s }.

const N = 512, HOP = 128, NH = N / 2;

function buildFFT(n) {
  const levels = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let x = i, r = 0; for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r >>> 0; }
  const cos = new Float32Array(n >> 1), sin = new Float32Array(n >> 1);
  for (let i = 0; i < (n >> 1); i++) { const a = (-2 * Math.PI * i) / n; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  return { n, rev, cos, sin };
}
function fft(p, re, im) {
  const { n, rev, cos, sin } = p;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) for (let k = 0, j = 0; k < half; k++, j += step) {
      const l = i + k, r = l + half, c = cos[j], s = sin[j];
      const tre = re[r] * c - im[r] * s, tim = re[r] * s + im[r] * c;
      re[r] = re[l] - tre; im[r] = im[l] - tim; re[l] += tre; im[l] += tim;
    }
  }
}
function ifft(p, re, im) {
  const n = p.n;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(p, re, im);
  const s = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= s; im[i] = -im[i] * s; }
}

class Chan {
  constructor(win, winNorm, fftp) {
    this.win = win; this.winNorm = winNorm; this.fftp = fftp;
    this.inHist = new Float32Array(N);
    this.ola = new Float32Array(N);
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.env = new Float32Array(NH + 1);   // per-bin peak envelope (the reverb-aware reference)
    this.gsm = new Float32Array(NH + 1).fill(1); // smoothed gain (temporal)
    this.gt = new Float32Array(NH + 1);    // per-bin target gain (before smoothing)
    this.mg = new Float32Array(NH + 1);    // per-bin magnitude (smoothing weights)
  }
  // process one HOP; returns mean gain reduction (dB)
  block(inBlk, outBlk, sub, decay, floorG, wet) {
    const { inHist, ola, re, im, win, fftp, env, gsm, gt, mg } = this;
    inHist.copyWithin(0, HOP);
    inHist.set(inBlk, N - HOP);
    for (let i = 0; i < N; i++) { re[i] = inHist[i] * win[i]; im[i] = 0; }
    fft(fftp, re, im);
    // pass 1: per-bin target gain. 1 when rising/steady, <1 inside a decaying tail.
    for (let k = 0; k <= NH; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mg[k] = mag;
      env[k] = mag > env[k] ? mag : mag + (env[k] - mag) * decay; // instant attack, tail-time release
      let g = env[k] > 1e-9 ? Math.pow(mag / env[k], sub) : 1;
      if (g < floorG) g = floorG;
      gt[k] = 1 + (g - 1) * wet;             // dry/wet (0% mix or 0 amount = transparent)
    }
    // pass 2: magnitude-WEIGHTED smoothing of the gain across frequency + time, then
    // apply. Weighting by magnitude is what kills the "underwater"/musical-noise
    // artefact (isolated nulls in quiet bins are smeared out) WITHOUT letting those
    // quiet bins drag down strong tonal peaks - the peak dominates its own smoothing.
    let gAccum = 0;
    for (let k = 0; k <= NH; k++) {
      const lo = k > 2 ? k - 2 : 0, hi = k < NH - 2 ? k + 2 : NH;
      let num = 0, den = 0;
      for (let j = lo; j <= hi; j++) { const w = mg[j] + 1e-7; num += gt[j] * w; den += w; }
      const gs = num / den;
      gsm[k] += (gs - gsm[k]) * 0.3;
      const g = gsm[k];
      gAccum += g;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < NH) { const mm = N - k; re[mm] = re[k]; im[mm] = -im[k]; }
    }
    ifft(fftp, re, im);
    for (let i = 0; i < N; i++) ola[i] += re[i] * win[i] * this.winNorm;
    for (let i = 0; i < HOP; i++) outBlk[i] = ola[i];
    ola.copyWithin(0, HOP); ola.fill(0, N - HOP);
    return -20 * Math.log10(gAccum / (NH + 1) + 1e-9);
  }
}

class DereverbProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.amount = 50; this.tail = 300; this.residual = 12; this.mix = 100; this.autoMakeup = true;
    this.makeupG = 1; this.aMk = 1 - Math.exp(-128 / (0.3 * sampleRate)); // ~300 ms makeup smoothing
    const win = new Float32Array(N); let ss = 0;
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); win[i] = w; ss += w * w; }
    const winNorm = HOP / ss;
    const fftp = buildFFT(N);
    this.chans = [new Chan(win, winNorm, fftp), new Chan(win, winNorm, fftp)];
    this.dispEnv = 0; this.dispRel = Math.exp(-1 / (0.03 * sampleRate)); // ~30 ms display envelope
    this.trace = [];
    // auto-analysis: estimate the room's reverb decay from falling-envelope slopes
    this.anLeft = 0; this.aid = 0; this.slopes = []; this.peakHold = -120; this.prevDb = -120;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.amount === "number") this.amount = d.amount;
      if (typeof d.tail === "number") this.tail = d.tail;
      if (typeof d.residual === "number") this.residual = d.residual;
      if (typeof d.mix === "number") this.mix = d.mix;
      if (typeof d.autoMakeup === "boolean") this.autoMakeup = d.autoMakeup;
      if (typeof d.analyze === "number") { this.anLeft = Math.round(d.analyze * sampleRate); this.slopes = []; this.peakHold = -120; this.prevDb = -120; }
    };
  }

  // collect the decay rate (dB/s) of falling tails this quantum; when the window
  // ends, derive a reverb time and post suggested { tail, amount }.
  analyze(input, n, chans) {
    let sq = 0;
    for (let ch = 0; ch < chans; ch++) { const a = input[ch]; for (let i = 0; i < n; i++) sq += a[i] * a[i]; }
    const curDb = 10 * Math.log10(sq / (n * chans) + 1e-12);
    const dt = n / sampleRate;
    this.peakHold = Math.max(curDb, this.peakHold - 3 * dt); // recent peak; decays slower than any reverb so tails stay "below peak"
    // a falling level, in the tail region below the peak and above the floor, = reverb decay
    if (curDb < this.prevDb - 0.01 && curDb < this.peakHold - 3 && curDb > -65) {
      const slope = (this.prevDb - curDb) / dt;
      if (slope > 2 && slope < 300) this.slopes.push(slope);
    }
    this.prevDb = curDb;
    this.anLeft -= n;
    if (this.anLeft <= 0) {
      this.aid++;
      let tail = 300, amount = 45, residual = 16, nslopes = this.slopes.length;
      if (nslopes >= 20) {
        const s = this.slopes.slice().sort((a, b) => a - b);
        const med = s[s.length >> 1];
        const rt60 = Math.min(2.5, Math.max(0.1, 60 / med)); // seconds
        tail = Math.round(Math.min(1200, Math.max(80, rt60 * 1000 * 0.45)));
        // deliberately conservative - over-reduction is what causes the "underwater" sound
        amount = Math.round(Math.min(60, Math.max(30, 28 + rt60 * 20)));
        residual = Math.round(Math.min(20, Math.max(10, 19 - rt60 * 3)));
      }
      this.port.postMessage({ type: "meter", analysis: { tail, amount, residual, aid: this.aid, n: nslopes } });
      this.slopes = [];
    }
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length, chans = Math.min(2, input.length);
    const sub = (this.amount / 100) * 3;                          // expansion exponent (0 = bypass)
    const decay = Math.exp(-HOP / (Math.max(0.02, this.tail / 1000) * sampleRate)); // envelope release
    const floorG = Math.max(0, this.residual / 100);
    const wet = Math.max(0, Math.min(1, this.mix / 100));

    let redDb = 0;
    for (let i = 0; i < n; i += HOP) {
      for (let ch = 0; ch < chans; ch++) {
        const gr = this.chans[ch].block(input[ch].subarray(i, i + HOP), output[ch].subarray(i, i + HOP), sub, decay, floorG, wet);
        if (ch === 0) redDb = gr;
      }
      if (output.length > 1 && chans === 1) output[1].set(output[0].subarray(i, i + HOP), i);
    }

    // input peak (display) + in/out energy (auto-makeup), in one pass
    let inPeak = 0, inSq = 0, outSq = 0;
    for (let ch = 0; ch < chans; ch++) {
      const a = input[ch], o = output[ch];
      for (let i = 0; i < n; i++) { const x = a[i], v = x < 0 ? -x : x; if (v > inPeak) inPeak = v; inSq += x * x; outSq += o[i] * o[i]; }
    }
    // auto makeup: restore the level the de-reverb removed, smoothed, capped at +12 dB
    if (this.autoMakeup) {
      const target = Math.min(4, Math.max(1, Math.sqrt(inSq / (outSq + 1e-9))));
      this.makeupG += (target - this.makeupG) * this.aMk;
      const g = this.makeupG;
      for (let ch = 0; ch < chans; ch++) { const o = output[ch]; for (let i = 0; i < n; i++) { let v = o[i] * g; if (v > 1) v = 1; else if (v < -1) v = -1; o[i] = v; } }
    } else { this.makeupG = 1; }

    this.dispEnv = inPeak > this.dispEnv ? inPeak : inPeak + (this.dispEnv - inPeak) * this.dispRel;
    this.trace.push(20 * Math.log10(this.dispEnv + 1e-9), Math.max(0, redDb));
    if (this.trace.length >= 16) { this.port.postMessage({ type: "meter", s: this.trace }); this.trace = []; }

    if (this.anLeft > 0) this.analyze(input, n, chans);
    return true;
  }
}

registerProcessor("dereverb-processor", DereverbProcessor);
