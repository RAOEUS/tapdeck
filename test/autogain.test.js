"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms } = require("./harness");

const SR = 48000;
const tone = (amp, f = 300) => (t) => amp * Math.sin((2 * Math.PI * f * t) / SR);

test("auto-gain boosts quiet content toward the target", () => {
  const { Processor } = loadWorklet("autogain-processor.js");
  const p = new Processor();
  send(p, { target: -16, speed: 100, range: 18, gate: -60 });
  const quiet = 0.02; // ~ -34 dBFS, well under target
  const blocks = render(p, tone(quiet), { blocks: 1200 }); // ~3.2 s to settle
  const outRms = rms(blocks, 0, 900);
  assert.ok(outRms > quiet / Math.SQRT2 * 2, `quiet input should be boosted up: ${outRms.toFixed(4)} vs ${(quiet / Math.SQRT2).toFixed(4)}`);
});

test("auto-gain attenuates loud content toward the target", () => {
  const { Processor } = loadWorklet("autogain-processor.js");
  const p = new Processor();
  send(p, { target: -20, speed: 100, range: 18, gate: -60 });
  const loud = 0.7; // ~ -3 dBFS, well over a -20 LUFS target
  const blocks = render(p, tone(loud), { blocks: 1200 });
  assert.ok(rms(blocks, 0, 900) < loud / Math.SQRT2, "loud input should be pulled down");
});

test("auto-gain holds (doesn't boost) below the gate", () => {
  const { Processor } = loadWorklet("autogain-processor.js");
  const p = new Processor();
  send(p, { target: -16, speed: 100, range: 24, gate: -40 });
  const noise = 0.0008; // ~ -62 dBFS, below the -40 gate
  const blocks = render(p, tone(noise), { blocks: 800 });
  const ratio = rms(blocks, 0, 500) / (noise / Math.SQRT2);
  assert.ok(ratio < 2, `below the gate the gain should stay put, not boost: ratio ${ratio.toFixed(2)}`);
});
