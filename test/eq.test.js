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

test("EQ dynamic-gain meter is keyed by band id (survives a disabled earlier band)", () => {
  const { Processor } = loadWorklet("eq-processor.js");
  const p = new Processor();
  const msgs = [];
  p.port.postMessage = (m) => msgs.push(m);
  // first band disabled (dropped from the worklet's filtered list), second is dynamic
  send(p, bands(
    { id: "b1", type: "peaking", freq: 500, gain: 3, q: 1, enabled: false },
    { id: "b2", type: "peaking", freq: 3000, gain: 0, q: 2, enabled: true, dynMode: "down", dynThr: -50, dynRange: 12, dynAtk: 1, dynRel: 80 },
  ));
  render(p, (t) => 0.5 * Math.sin((2 * Math.PI * 3000 * t) / SR), { blocks: 120 });
  const mb = msgs.filter((x) => x && x.mb).pop().mb;
  assert.ok(mb && typeof mb === "object" && !Array.isArray(mb), "mb should be an id-keyed object");
  assert.ok("b2" in mb, "the dynamic band must be reported under its id, not a filtered index");
});

test("EQ in Side mode leaves the Mid (mono sum) unchanged but alters the Side", () => {
  const { Processor } = loadWorklet("eq-processor.js");
  const p = new Processor();
  send(p, bands({ id: "b1", type: "peaking", freq: 2000, gain: 12, q: 1, enabled: true }));
  send(p, { chMode: "side" });
  // distinct L/R so there's a real Side component (L tone at 2k, R tone at 500)
  const sig = (t, c) => 0.2 * Math.sin((2 * Math.PI * (c === 0 ? 2000 : 500) * t) / SR);
  const blocks = render(p, sig, { blocks: 200, chans: 2 });
  let midErr = 0, sideDelta = 0, count = 0;
  const n = blocks[0][0].length;
  for (let b = 120; b < blocks.length; b++) {
    const L = blocks[b][0], R = blocks[b][1];
    for (let i = 0; i < n; i++) {
      const t = b * n + i;
      const inL = 0.2 * Math.sin((2 * Math.PI * 2000 * t) / SR), inR = 0.2 * Math.sin((2 * Math.PI * 500 * t) / SR);
      midErr += Math.abs((L[i] + R[i]) - (inL + inR));   // mid should be untouched
      sideDelta += Math.abs((L[i] - R[i]) - (inL - inR)); // side should change (2k boosted)
      count++;
    }
  }
  assert.ok(midErr / count < 1e-3, `Side mode must not change the Mid: err ${midErr / count}`);
  assert.ok(sideDelta / count > 1e-2, "Side mode should change the Side signal");
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
