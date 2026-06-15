"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms } = require("./harness");

const SR = 48000;

test("denoise at 0% Amount is transparent (no attenuation)", () => {
  const { Processor } = loadWorklet("denoise-processor.js");
  const p = new Processor();
  send(p, { amount: 0, floor: 0 });
  const amp = 0.3;
  const blocks = render(p, (t) => amp * Math.sin((2 * Math.PI * 440 * t) / SR), { blocks: 200 });
  const inRms = amp / Math.SQRT2;
  const outRms = rms(blocks, 0, 90); // after STFT latency settles
  assert.ok(Math.abs(outRms - inRms) / inRms < 0.05, `0% should pass through: out ${outRms} vs in ${inRms}`);
});

test("denoise at high Amount attenuates steady broadband noise", () => {
  const { Processor } = loadWorklet("denoise-processor.js");
  const p = new Processor();
  send(p, { amount: 90, floor: 0 });
  let s = 22222;
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x40000000 - 1; };
  const blocks = render(p, () => 0.2 * rnd(), { blocks: 300 });
  const inRms = 0.2 / Math.sqrt(3); // uniform noise
  assert.ok(rms(blocks, 0, 160) < inRms * 0.8, "noise should be reduced once the floor is learned");
});
