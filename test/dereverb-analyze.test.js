"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorklet, send, render } = require("./harness");

const SR = 48000;

// run the auto-analyzer over an exponentially-decaying tone (a reverb-like tail)
function analyze(tau, sec) {
  const { Processor } = loadWorklet("dereverb-processor.js");
  const p = new Processor();
  const msgs = [];
  p.port.postMessage = (m) => msgs.push(m);
  send(p, { analyze: sec });
  render(p, (t) => 0.6 * Math.exp(-(t / SR) / tau) * Math.sin((2 * Math.PI * 600 * t) / SR), { blocks: Math.ceil((sec * SR) / 128) + 12 });
  const m = msgs.filter((x) => x && x.analysis).pop();
  return m ? m.analysis : null;
}

test("auto-analysis posts a Tail/Amount suggestion in range", () => {
  const a = analyze(0.25, 0.4);
  assert.ok(a && a.n >= 20, "should collect decay slopes");
  assert.ok(a.tail >= 60 && a.tail <= 1500, `tail in range, got ${a.tail}`);
  assert.ok(a.amount >= 35 && a.amount <= 85, `amount in range, got ${a.amount}`);
});

test("auto-analysis suggests a longer Tail for a slower decay", () => {
  const slow = analyze(0.45, 0.45), fast = analyze(0.04, 0.45);
  assert.ok(slow && fast && slow.n >= 20 && fast.n >= 20);
  assert.ok(slow.tail > fast.tail, `slow decay tail ${slow.tail} should exceed fast ${fast.tail}`);
});
