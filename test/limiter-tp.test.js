"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render } = require("./harness");

const SR = 48000;

// capture the meter messages the limiter posts and return the last reported true peak (dBTP)
function lastTP(os) {
  const { Processor } = loadWorklet("limiter-processor.js");
  const p = new Processor();
  const msgs = [];
  p.port.postMessage = (m) => msgs.push(m);
  send(p, { ceiling: -1, lookahead: 5, attack: 0, os });
  render(p, (t) => 0.99 * Math.sin((2 * Math.PI * 11000 * t) / SR), { blocks: 300 });
  const m = msgs.filter((x) => x && typeof x.tp === "number").pop();
  return m ? m.tp : NaN;
}

test("limiter reports a true-peak meter value", () => {
  assert.ok(Number.isFinite(lastTP(4)), "tp should be a finite dBTP value");
});

test("oversampled limiting keeps the reported true peak near the ceiling", () => {
  const tp4 = lastTP(4);
  assert.ok(tp4 <= -1 + 0.3, `4x true peak ${tp4.toFixed(2)} dBTP should be ~at/under the -1 ceiling`);
});
