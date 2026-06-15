"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms } = require("./harness");

const SR = 48000;
const tone = (amp, f) => (t) => amp * Math.sin((2 * Math.PI * f * t) / SR);

test("gate passes signal above threshold", () => {
  const { Processor } = loadWorklet("gate-processor.js");
  const p = new Processor();
  send(p, { threshold: -40, ratio: 8, range: 60, attack: 1, release: 50, hold: 5 });
  const blocks = render(p, tone(0.5, 200), { blocks: 120 }); // ~ -6 dB, well above
  assert.ok(rms(blocks, 0, 40) > 0.3, "loud signal should pass");
});

test("gate attenuates signal below threshold", () => {
  const { Processor } = loadWorklet("gate-processor.js");
  const p = new Processor();
  send(p, { threshold: -40, ratio: 8, range: 60, attack: 1, release: 50, hold: 5 });
  const blocks = render(p, tone(0.002, 200), { blocks: 160 }); // ~ -54 dB, below
  assert.ok(rms(blocks, 0, 90) < 5e-4, "quiet signal should be gated down");
});
