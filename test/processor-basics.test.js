"use strict";
// Basic coverage for processors that lacked a dedicated test, added alongside the
// BaseProcessor conversion so the new setParams() path is exercised for each.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms } = require("./harness");

const SR = 48000;
const tone = (amp, f = 300) => (t) => amp * Math.sin((2 * Math.PI * f * t) / SR);

test("utility applies gain in dB (via setParams)", () => {
  const { Processor } = loadWorklet("utility-processor.js");
  const p = new Processor();
  send(p, { gain: -6, pan: 0, width: 1, mono: false, invL: false, invR: false, swap: false, crossfeed: 0 });
  const blocks = render(p, tone(0.5), { blocks: 100 });
  const out = rms(blocks, 0, 80), expected = (0.5 / Math.SQRT2) * Math.pow(10, -6 / 20);
  assert.ok(Math.abs(out - expected) < expected * 0.03, `-6 dB should ~halve to ${expected.toFixed(4)}, got ${out.toFixed(4)}`);
});

test("utility mono collapse makes L == R", () => {
  const { Processor } = loadWorklet("utility-processor.js");
  const p = new Processor();
  send(p, { gain: 0, pan: 0, width: 1, mono: true, crossfeed: 0 });
  // hard-panned input: L = tone, R = silence
  const blocks = render(p, (t, c) => (c === 0 ? Math.sin((2 * Math.PI * 300 * t) / SR) : 0), { blocks: 40 });
  let maxDiff = 0;
  for (const b of blocks) for (let i = 0; i < b[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(b[0][i] - b[1][i]));
  assert.ok(maxDiff < 1e-6, `mono should give identical channels, max |L-R| = ${maxDiff.toExponential(2)}`);
});

test("transient is ~unity with no shaping and obeys output trim", () => {
  const flat = () => { const { Processor } = loadWorklet("trans-processor.js"); const p = new Processor(); send(p, { attack: 0, sustain: 0, output: 0 }); return rms(render(p, tone(0.3), { blocks: 120 }), 0, 40); };
  const trimmed = () => { const { Processor } = loadWorklet("trans-processor.js"); const p = new Processor(); send(p, { attack: 0, sustain: 0, output: 6 }); return rms(render(p, tone(0.3), { blocks: 120 }), 0, 40); };
  const base = flat();
  assert.ok(Math.abs(base - 0.3 / Math.SQRT2) < 0.03, `no shaping should pass ~unity, got ${base.toFixed(4)}`);
  assert.ok(trimmed() > base * 1.6, "+6 dB output trim should be clearly louder");
});

test("multiband passes a quiet signal through near-unity (no compression below threshold)", () => {
  const { Processor } = loadWorklet("mbcomp-processor.js");
  const p = new Processor();
  send(p, { mix: 100, xovers: [250, 2500], bands: [0, 1, 2].map(() => ({ threshold: -6, ratio: 1, attack: 10, release: 100, knee: 0, makeup: 0, bypass: false, detector: "feedforward", mode: "down", range: 24 })) });
  const amp = 0.05; // ~ -29 dBFS, well below every -6 dB threshold
  const blocks = render(p, tone(amp, 1000), { blocks: 200 });
  const out = rms(blocks, 0, 80), inRms = amp / Math.SQRT2;
  assert.ok(Math.abs(out - inRms) < inRms * 0.12, `quiet signal should pass ~unity through the crossover, got ${out.toFixed(4)} vs ${inRms.toFixed(4)}`);
});
