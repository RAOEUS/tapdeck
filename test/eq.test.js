"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms } = require("./harness");

const SR = 48000;
const bands = (...b) => ({ bands: b, preamp: 0, mix: 100 });

test("EQ solo of a flat (0 dB) band is silent (phase cancellation)", () => {
  const { Processor } = loadWorklet("eq-processor.js");
  const p = new Processor();
  send(p, bands(
    { id: "b1", type: "peaking", freq: 1000, gain: 0, q: 1, enabled: true },
    { id: "b2", type: "peaking", freq: 3000, gain: 6, q: 1, enabled: true },
  ));
  send(p, { soloId: "b1" });
  const blocks = render(p, (t) => 0.3 * Math.sin((2 * Math.PI * 1000 * t) / SR), { blocks: 120 });
  assert.ok(rms(blocks, 0, 40) < 1e-3, "a band doing nothing should solo to silence");
});

test("EQ solo of a boosting band is audible", () => {
  const { Processor } = loadWorklet("eq-processor.js");
  const p = new Processor();
  send(p, bands(
    { id: "b1", type: "peaking", freq: 1000, gain: 0, q: 1, enabled: true },
    { id: "b2", type: "peaking", freq: 3000, gain: 9, q: 1, enabled: true },
  ));
  send(p, { soloId: "b2" });
  const blocks = render(p, (t) => 0.3 * Math.sin((2 * Math.PI * 3000 * t) / SR), { blocks: 120 });
  assert.ok(rms(blocks, 0, 40) > 1e-2, "a boosting band should pass its contribution");
});

test("EQ peaking boost raises the level at its frequency", () => {
  const { Processor } = loadWorklet("eq-processor.js");
  const p = new Processor();
  send(p, bands({ id: "b1", type: "peaking", freq: 2000, gain: 12, q: 1, enabled: true }));
  const amp = 0.1;
  const blocks = render(p, (t) => amp * Math.sin((2 * Math.PI * 2000 * t) / SR), { blocks: 200 });
  // +12 dB ~= x3.98; allow for settling
  assert.ok(rms(blocks, 0, 120) > (amp / Math.SQRT2) * 3, "boosted band should amplify its frequency");
});
