"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms, peak, toneMag } = require("./harness");

const SR = 48000;

test("saturator is ~unity for small signals (tanh region)", () => {
  const { Processor } = loadWorklet("sat-processor.js");
  const p = new Processor();
  send(p, { drive: 0, mode: "tape", tone: 0, mix: 100, output: 0, os: 1 });
  const amp = 0.001;
  const blocks = render(p, (t) => amp * Math.sin((2 * Math.PI * 1000 * t) / SR), { blocks: 60 });
  const expect = amp / Math.SQRT2;
  assert.ok(Math.abs(rms(blocks, 0, 15) - expect) / expect < 0.05);
});

test("hard-clip saturator output is bounded", () => {
  // No oversampling: a true hard clip never exceeds full scale.
  let p = new (loadWorklet("sat-processor.js").Processor)();
  send(p, { drive: 24, mode: "hard", tone: 0, mix: 100, output: 0, os: 1 });
  let blocks = render(p, (t) => Math.sin((2 * Math.PI * 1000 * t) / SR), { blocks: 60 });
  assert.ok(peak(blocks, 0, 15) <= 1.001, "1x hard clip must stay at/under full scale");
  // 4x: band-limited reconstruction of the clipped (near-square) wave rings a little
  // past full scale - that's expected, just stays finite and contained.
  p = new (loadWorklet("sat-processor.js").Processor)();
  send(p, { drive: 24, mode: "hard", tone: 0, mix: 100, output: 0, os: 4 });
  blocks = render(p, (t) => Math.sin((2 * Math.PI * 1000 * t) / SR), { blocks: 60 });
  const pk = peak(blocks, 0, 15);
  assert.ok(Number.isFinite(pk) && pk < 1.25, `4x reconstruction should stay contained, got ${pk}`);
});

test("oversampling reduces aliasing from hard clipping", () => {
  // 7 kHz hard-clipped -> 5th harmonic at 35 kHz aliases to 48000-35000 = 13 kHz.
  // Oversampling should suppress that alias relative to no oversampling.
  const run = (os) => {
    const { Processor } = loadWorklet("sat-processor.js");
    const p = new Processor();
    send(p, { drive: 24, mode: "hard", tone: 0, mix: 100, output: 0, os });
    return render(p, (t) => 0.9 * Math.sin((2 * Math.PI * 7000 * t) / SR), { blocks: 160 });
  };
  const aliasNone = toneMag(run(1), 13000, SR);
  const alias4x = toneMag(run(4), 13000, SR);
  assert.ok(alias4x < aliasNone * 0.7, `4x alias ${alias4x.toFixed(5)} should be well under 1x ${aliasNone.toFixed(5)}`);
});
