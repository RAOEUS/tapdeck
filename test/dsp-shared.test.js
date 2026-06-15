"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./harness");

const SR = 48000;

test("shared FFT round-trips (ifft(fft(x)) == x)", () => {
  const { dsp } = loadShared();
  const N = 512, p = dsp.buildFFT(N);
  const re = new Float32Array(N), im = new Float32Array(N), orig = new Float32Array(N);
  for (let i = 0; i < N; i++) { const v = Math.sin((2 * Math.PI * 5 * i) / N) + 0.3 * Math.cos((2 * Math.PI * 17 * i) / N); re[i] = orig[i] = v; }
  dsp.fft(p, re, im);
  dsp.ifft(p, re, im);
  let maxErr = 0;
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]));
  assert.ok(maxErr < 1e-4, `round-trip error ${maxErr.toExponential(2)} should be ~0`);
});

test("shared FFT puts a pure tone in the right bin", () => {
  const { dsp } = loadShared();
  const N = 256, p = dsp.buildFFT(N), bin = 8;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / N);
  dsp.fft(p, re, im);
  const mag = (k) => Math.hypot(re[k], im[k]);
  let peakBin = 1, peakMag = 0;
  for (let k = 1; k < N / 2; k++) if (mag(k) > peakMag) { peakMag = mag(k); peakBin = k; }
  assert.equal(peakBin, bin, `tone at bin ${bin} should peak there, got ${peakBin}`);
});

test("K-weighting attenuates sub-bass and lifts presence (vs 1 kHz)", () => {
  const { dsp } = loadShared(SR);
  const [s1, s2] = dsp.kWeightCoeffs(SR);
  const gain = (f) => {
    const st1 = [0, 0, 0, 0], st2 = [0, 0, 0, 0];
    let acc = 0, count = 0;
    for (let i = 0; i < SR; i++) { // 1 s, measure after settling
      const x = Math.sin((2 * Math.PI * f * i) / SR);
      const y = dsp.kbiquad(s2, st2, dsp.kbiquad(s1, st1, x));
      if (i > SR / 2) { acc += y * y; count++; }
    }
    return Math.sqrt(acc / count) / Math.SQRT1_2; // RMS relative to unit-amplitude tone
  };
  const g30 = gain(30), g1k = gain(1000), g4k = gain(4000);
  assert.ok(g30 < 0.5, `30 Hz should be strongly cut by the RLB high-pass, got ${g30.toFixed(3)}`);
  assert.ok(g4k > g1k, `presence (4 kHz) should sit above 1 kHz from the +4 dB shelf, ${g4k.toFixed(3)} vs ${g1k.toFixed(3)}`);
});

// note: objects created inside the worklet vm have a different Object.prototype,
// so we compare fields individually rather than with deepEqual (which is strict
// about prototypes across realms).
test("BaseProcessor routes port messages to setParams()", () => {
  const { BaseProcessor } = loadShared();
  const p = new BaseProcessor();
  let got = null;
  p.setParams = (d) => { got = d; };
  p.port.onmessage({ data: { gain: -3, mode: "x" } });
  assert.equal(got.gain, -3); assert.equal(got.mode, "x");
  // a null/empty message must not throw and yields an empty object
  got = null;
  p.port.onmessage({});
  assert.ok(got && Object.keys(got).length === 0, "empty message -> {}");
});

test("BaseProcessor.meter() stamps type:'meter' and forwards the payload", () => {
  const { BaseProcessor } = loadShared();
  const p = new BaseProcessor();
  const sent = [];
  p.port.postMessage = (m) => sent.push(m);
  p.meter({ gr: 4.2, s: [1, 2] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "meter");
  assert.equal(sent[0].gr, 4.2);
  assert.deepEqual([...sent[0].s], [1, 2]);
});
