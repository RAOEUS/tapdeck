// Spectral noise suppressor. Overlap-add STFT (512-pt frame, 128 hop = 75%
// overlap, Hann window) with an automatic per-bin noise-floor estimate
// (minimum-statistics) and a Wiener-style soft gate. Effective on steady
// broadband noise (hiss/hum/fans/AC). Each channel runs independently.
// Params: { amount(0..100), floor(0..100) }. Posts mean reduction: { type:'meter', gr }.

const N = 512, HOP = 128, NH = N / 2;
const POWA = 1 - Math.exp(-HOP / (0.06 * sampleRate)); // ~60 ms power smoothing
const MINRISE = 1.004, BIAS = 1.7;                     // noise-floor min-tracker rise + bias compensation

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
function ifft(p, re, im) { // inverse via conjugation, scaled by 1/n
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
    this.psm = new Float32Array(NH + 1).fill(1e-5);  // smoothed per-bin power
    this.pmin = new Float32Array(NH + 1).fill(1e-5); // tracked minimum (noise floor)
    this.gainSm = new Float32Array(NH + 1).fill(1);
    this.warm = 0;
  }
  // process one HOP of input -> one HOP of output; returns mean gain reduction (dB)
  block(inBlk, outBlk, reduction, floorG) {
    const { inHist, ola, re, im, win, fftp, psm, pmin, gainSm } = this;
    inHist.copyWithin(0, HOP);          // slide history left by one hop
    inHist.set(inBlk, N - HOP);         // append newest hop
    for (let i = 0; i < N; i++) { re[i] = inHist[i] * win[i]; im[i] = 0; }
    fft(fftp, re, im);
    this.warm++;
    let grAccum = 0;
    for (let k = 0; k <= NH; k++) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      psm[k] += (mag2 - psm[k]) * POWA;                                  // smoothed power
      if (this.warm < 40) pmin[k] = psm[k];                              // fast seed of the floor
      else pmin[k] = psm[k] < pmin[k] ? psm[k] : pmin[k] * MINRISE;       // track minima, creep up slowly
      const noiseP = pmin[k] * BIAS;
      const snr = Math.max(psm[k] / (noiseP + 1e-12) - 1, 0);            // a-priori SNR estimate
      let g = snr / (snr + reduction);                                   // Wiener-style gain
      if (g < floorG) g = floorG;
      gainSm[k] += (g - gainSm[k]) * 0.6;                                // temporal smoothing -> less musical noise
      g = gainSm[k];
      grAccum += g;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < NH) { const m = N - k; re[m] = re[k]; im[m] = -im[k]; } // hermitian mirror
    }
    ifft(fftp, re, im);
    for (let i = 0; i < N; i++) ola[i] += re[i] * win[i] * this.winNorm; // synthesis window + OLA
    for (let i = 0; i < HOP; i++) outBlk[i] = ola[i];
    ola.copyWithin(0, HOP); ola.fill(0, N - HOP);
    return -20 * Math.log10(grAccum / (NH + 1) + 1e-9);
  }
}

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.amount = 60; this.floor = 6;
    const win = new Float32Array(N); let ss = 0;
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); win[i] = w; ss += w * w; }
    const winNorm = HOP / ss; // COLA normalisation for analysis+synthesis windowing
    const fftp = buildFFT(N);
    this.chans = [new Chan(win, winNorm, fftp), new Chan(win, winNorm, fftp)];
    this.frames = 0; this.meterGR = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.amount === "number") this.amount = d.amount;
      if (typeof d.floor === "number") this.floor = d.floor;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length, chans = Math.min(2, input.length);
    const reduction = 0.3 + (this.amount / 100) * 3;   // Wiener aggressiveness
    const floorG = Math.max(0.0, this.floor / 100);     // residual floor (0..1)
    for (let i = 0; i < n; i += HOP) {
      for (let ch = 0; ch < chans; ch++) {
        const gr = this.chans[ch].block(input[ch].subarray(i, i + HOP), output[ch].subarray(i, i + HOP), reduction, floorG);
        if (ch === 0 && gr > this.meterGR) this.meterGR = gr;
      }
      if (output.length > 1 && chans === 1) output[1].set(output[0].subarray(i, i + HOP), i);
    }
    this.frames += n;
    if (this.frames >= 512) { this.frames = 0; this.port.postMessage({ type: "meter", gr: this.meterGR }); this.meterGR *= 0.6; }
    return true;
  }
}

registerProcessor("denoise-processor", DenoiseProcessor);
