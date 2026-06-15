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

test("sidechain HPF makes the compressor pump less on bass", () => {
  const off = bassOutRms(20);    // HPF off
  const hp = bassOutRms(300);    // HPF at 300 Hz removes the 50 Hz from the detector
  assert.ok(hp > off * 1.2, `with the SC HPF the bass tone should be compressed far less: off=${off.toFixed(3)} hp=${hp.toFixed(3)}`);
});
