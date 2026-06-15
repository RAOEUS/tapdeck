// Shared worklet DSP, loaded into the AudioWorkletGlobalScope BEFORE any rack
// processor (offscreen.js adds this module first; the Node harness loads it into
// the same vm context first). Each addModule'd processor script has its own
// top-level lexical scope, so shared code can't be a plain top-level declaration -
// it must hang off the (shared) global object. Everything here is exposed on
// globalThis: TapdeckDSP (pure math) and BaseProcessor (the common base class).
(function (g) {
  // ---- FFT (radix-2, in-place) - used by the STFT modules (denoise, dereverb) ----
  // buildFFT(n) precomputes the bit-reversal table + twiddle factors for size n.
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

  // ---- K-weighting (ITU-R BS.1770) - used by the loudness modules (autogain, limiter) ----
  // direct form I biquad; st = [x1, x2, y1, y2].
  function kbiquad(c, st, x) {
    const y = c[0] * x + c[1] * st[0] + c[2] * st[1] - c[3] * st[2] - c[4] * st[3];
    st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y;
    return y;
  }
  // returns [stage1, stage2] coefficient arrays for the K-weighting prefilter at sr.
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

  // ---- common base class for every rack processor ----
  // Wires the port once: incoming messages route to setParams(d). Subclasses
  // override setParams() (the old `port.onmessage` body) and post displays with
  // meter(payload) (adds type:"meter"). Keeps DSP-thread plumbing in one place.
  class BaseProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.port.onmessage = (e) => this.handleMessage((e && e.data) || {});
    }
    handleMessage(d) { this.setParams(d); }
    setParams(_d) {}
    meter(payload) { this.port.postMessage(Object.assign({ type: "meter" }, payload)); }
  }

  g.TapdeckDSP = { buildFFT, fft, ifft, kbiquad, kWeightCoeffs };
  g.BaseProcessor = BaseProcessor;
})(typeof globalThis !== "undefined" ? globalThis : self);
