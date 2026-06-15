"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms, peak } = require("./harness");

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

test("auto-gain measures program loudness (louder reads higher)", () => {
  const measure = (amp, sec = 0.4) => {
    const { Processor } = loadWorklet("autogain-processor.js");
    const p = new Processor();
    const msgs = [];
    p.port.postMessage = (m) => msgs.push(m);
    send(p, { analyze: sec });
    render(p, tone(amp, 1000), { blocks: Math.ceil((sec * SR) / 128) + 10 });
    const a = msgs.filter((x) => x && x.analysis).pop();
    return a ? a.analysis : null;
  };
  const loud = measure(0.5), quiet = measure(0.05);
  assert.ok(loud && quiet && loud.n > 50 && quiet.n > 50, "should accumulate samples");
  assert.ok(loud.lufs > quiet.lufs + 5, `louder content should read higher LUFS: ${loud.lufs.toFixed(1)} vs ${quiet.lufs.toFixed(1)}`);
  assert.ok(loud.lufs < 0 && loud.lufs > -40, `plausible LUFS, got ${loud.lufs.toFixed(1)}`);
});

test("auto-gain has a built-in brick-wall (big boosts never clip)", () => {
  const { Processor } = loadWorklet("autogain-processor.js");
  const p = new Processor();
  send(p, { target: -6, speed: 100, range: 36, gate: -60 }); // push a quiet input hard toward a loud target
  const blocks = render(p, tone(0.05, 220), { blocks: 1400 }); // ~ -26 dBFS in
  const ceil = Math.pow(10, -1 / 20);
  assert.ok(peak(blocks, 0, 500) <= ceil + 2e-3, `output must stay under the -1 dBFS brick wall, got ${peak(blocks, 0, 500).toFixed(3)}`);
  assert.ok(rms(blocks, 0, 500) > (0.05 / Math.SQRT2) * 3, "and the quiet input is strongly boosted");
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
