"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, peak } = require("./harness");

const SR = 48000;
const lin = (db) => Math.pow(10, db / 20);

test("limiter holds the ceiling (instant attack)", () => {
  const { Processor } = loadWorklet("limiter-processor.js");
  const p = new Processor();
  send(p, { ceiling: -6, lookahead: 5, attack: 0, release: 60, inputGain: 0, os: 1 });
  const blocks = render(p, (t) => Math.sin((2 * Math.PI * 220 * t) / SR), { blocks: 300 });
  assert.ok(peak(blocks, 0, 60) <= lin(-6) + 1e-3, "output must not exceed ceiling");
});

test("limiter with attack>0 still never exceeds the ceiling (safety clip)", () => {
  const { Processor } = loadWorklet("limiter-processor.js");
  const p = new Processor();
  send(p, { ceiling: -3, lookahead: 5, attack: 5, release: 80, os: 1 });
  const blocks = render(p, (t) => Math.sin((2 * Math.PI * 100 * t) / SR), { blocks: 300 });
  assert.ok(peak(blocks, 0, 60) <= lin(-3) + 1e-3);
});

test("4x oversampled detection keeps inter-sample peaks under the ceiling", () => {
  const { Processor } = loadWorklet("limiter-processor.js");
  const p = new Processor();
  send(p, { ceiling: -1, lookahead: 5, attack: 0, os: 4 });
  // a high tone near Nyquist at near-full scale generates strong inter-sample peaks
  const blocks = render(p, (t) => 0.99 * Math.sin((2 * Math.PI * 11000 * t) / SR), { blocks: 300 });
  assert.ok(peak(blocks, 0, 80) <= lin(-1) + 5e-3, "true-peak should stay near/under ceiling");
});

test("limiter passes quiet signal through unchanged", () => {
  const { Processor } = loadWorklet("limiter-processor.js");
  const p = new Processor();
  send(p, { ceiling: -1, lookahead: 5, attack: 0, os: 1 });
  const amp = 0.1; // well under the ceiling
  const blocks = render(p, (t) => amp * Math.sin((2 * Math.PI * 440 * t) / SR), { blocks: 200 });
  assert.ok(peak(blocks, 0, 60) <= amp + 1e-3 && peak(blocks, 0, 60) > amp - 0.02);
});

test("integrated LUFS applies the relative gate (quiet passages don't drag it down)", () => {
  const lufsOf = (sig, blocks) => {
    const { Processor } = loadWorklet("limiter-processor.js");
    const p = new Processor();
    let last = null; p.port.postMessage = (m) => { if (typeof m.lufsI === "number") last = m.lufsI; };
    send(p, { ceiling: 0, lookahead: 1, inputGain: 0, os: 1 });
    render(p, sig, { blocks });
    return last;
  };
  const tone = (amp) => (t) => amp * Math.sin((2 * Math.PI * 1000 * t) / SR);
  const loudOnly = lufsOf(tone(0.3), 1500);                                        // ~4 s of one level
  const withQuiet = lufsOf((t) => (t < 1500 * 128 ? 0.3 : 0.003) * Math.sin((2 * Math.PI * 1000 * t) / SR), 3000); // then ~4 s at -40 dB
  assert.ok(loudOnly > -40 && loudOnly < 0, `plausible integrated LUFS, got ${loudOnly}`);
  assert.ok(Math.abs(withQuiet - loudOnly) < 1, `a -40 dB tail is below the relative gate and must not count: ${withQuiet.toFixed(1)} vs ${loudOnly.toFixed(1)}`);
});
