"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render, rms } = require("./harness");

const SR = 48000;

function bassOutRms(scHpf) {
  const { Processor } = loadWorklet("comp-processor.js");
  const p = new Processor();
  send(p, { threshold: -18, ratio: 8, attack: 5, release: 80, knee: 2, makeup: 0, detector: "feedforward", mode: "down", mix: 100, scHpf });
  const blocks = render(p, (t) => 0.5 * Math.sin((2 * Math.PI * 50 * t) / SR), { blocks: 150 }); // -6 dB, 50 Hz
  return rms(blocks, 0, 70);
}

test("compressor auto-makeup restores level lost to gain reduction", () => {
  const out = (autoMakeup) => {
    const { Processor } = loadWorklet("comp-processor.js");
    const p = new Processor();
    send(p, { threshold: -20, ratio: 4, attack: 5, release: 80, knee: 2, makeup: 0, detector: "feedforward", mode: "down", mix: 100, autoMakeup });
    return rms(render(p, (t) => 0.5 * Math.sin((2 * Math.PI * 300 * t) / SR), { blocks: 220 }), 0, 130);
  };
  const off = out(false), on = out(true);
  const inRms = 0.5 / Math.SQRT2;
  assert.ok(on > off * 1.5, `auto-makeup should raise the compressed level: off ${off.toFixed(3)} on ${on.toFixed(3)}`);
  assert.ok(Math.abs(on - inRms) / inRms < 0.25, `auto-makeup should land near the input level: ${on.toFixed(3)} vs ${inRms.toFixed(3)}`);
});

test("sidechain HPF makes the compressor pump less on bass", () => {
  const off = bassOutRms(20);    // HPF off
  const hp = bassOutRms(300);    // HPF at 300 Hz removes the 50 Hz from the detector
  assert.ok(hp > off * 1.2, `with the SC HPF the bass tone should be compressed far less: off=${off.toFixed(3)} hp=${hp.toFixed(3)}`);
});

test("expand mode opens at attack speed (gate convention), not release speed", () => {
  const { Processor } = loadWorklet("comp-processor.js");
  const p = new Processor();
  send(p, { threshold: -20, ratio: 4, attack: 1, release: 300, knee: 0, makeup: 0, detector: "feedforward", mode: "expand", range: 40, mix: 100 });
  // 100 quanta of near-silence (fully expanded down), then a -6 dB tone
  const blocks = render(p, (t) => (t < 100 * 128 ? 1e-4 : 0.5) * Math.sin((2 * Math.PI * 300 * t) / SR), { blocks: 110 });
  const soon = rms(blocks.slice(102, 106)); // ~5-16 ms after the onset
  assert.ok(soon > 0.25, `a 1 ms attack should have the expander open within a few ms, got rms ${soon.toFixed(4)}`);
});
