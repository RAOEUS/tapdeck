"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms } = require("./harness");

const SR = 48000;

test("de-reverb at 0% Amount is transparent", () => {
  const { Processor } = loadWorklet("dereverb-processor.js");
  const p = new Processor();
  send(p, { amount: 0, tail: 300, residual: 0, mix: 100 });
  const amp = 0.3;
  const blocks = render(p, (t) => amp * Math.sin((2 * Math.PI * 440 * t) / SR), { blocks: 200 });
  const inRms = amp / Math.SQRT2;
  assert.ok(Math.abs(rms(blocks, 0, 90) - inRms) / inRms < 0.05, "0% should pass through");
});

test("de-reverb passes a steady (sustained) tone — doesn't kill direct sound", () => {
  const { Processor } = loadWorklet("dereverb-processor.js");
  const p = new Processor();
  send(p, { amount: 100, tail: 400, residual: 0, mix: 100 });
  const amp = 0.3;
  const blocks = render(p, (t) => amp * Math.sin((2 * Math.PI * 440 * t) / SR), { blocks: 250 });
  const inRms = amp / Math.SQRT2;
  // a steady tone is "direct", not a decaying tail -> should pass largely intact
  assert.ok(rms(blocks, 0, 150) > inRms * 0.7, "sustained tone should mostly survive");
});

test("auto-makeup raises the de-reverbed level back up", () => {
  let s = 99;
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x40000000 - 1; };
  const run = (autoMakeup) => {
    const { Processor } = loadWorklet("dereverb-processor.js");
    const p = new Processor();
    send(p, { amount: 90, tail: 400, residual: 0, mix: 100, autoMakeup });
    let st = 99; const r = () => { st = (1103515245 * st + 12345) & 0x7fffffff; return st / 0x40000000 - 1; };
    return rms(render(p, () => 0.25 * r(), { blocks: 250 }), 0, 120);
  };
  assert.ok(run(true) > run(false) * 1.15, "makeup should bring the level back up");
});

test("de-reverb attenuates a decaying tail", () => {
  const { Processor } = loadWorklet("dereverb-processor.js");
  const p = new Processor();
  send(p, { amount: 100, tail: 500, residual: 0, mix: 100 });
  // an exponentially-decaying tone = a reverb-like tail; the envelope stays above the
  // falling magnitude, so it should be pulled down hard.
  const tau = 0.12; // s
  const blocks = render(p, (t) => 0.6 * Math.exp(-(t / SR) / tau) * Math.sin((2 * Math.PI * 700 * t) / SR), { blocks: 200 });
  // compare output energy in the tail region to a bypassed reference
  const ref = (() => {
    const q = new (loadWorklet("dereverb-processor.js").Processor)();
    send(q, { amount: 0, tail: 500, residual: 0, mix: 100 });
    return render(q, (t) => 0.6 * Math.exp(-(t / SR) / tau) * Math.sin((2 * Math.PI * 700 * t) / SR), { blocks: 200 });
  })();
  assert.ok(rms(blocks, 0, 40) < rms(ref, 0, 40) * 0.7, "decaying tail should be reduced vs bypass");
});
