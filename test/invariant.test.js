"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadDSP, loadWorklet } = require("./harness");

// The drawn EQ curve (dsp-math.js) MUST use the same biquad design as the EQ
// worklet, or the picture diverges from the sound. Guard that they're identical.
const DSP = loadDSP();
const { ctx: eq } = loadWorklet("eq-processor.js");
const SR = 48000;

test("EQ worklet designBiquad matches dsp-math designBiquad", () => {
  assert.equal(typeof eq.designBiquad, "function", "eq-processor must expose designBiquad at top level");
  const types = ["peaking", "lowshelf", "highshelf", "lowpass", "highpass", "bandpass", "notch", "allpass"];
  for (const type of types) {
    for (const f of [40, 200, 1000, 5000, 15000]) {
      for (const q of [0.5, 1.2, 6]) {
        for (const g of [-12, -3, 0, 6, 12]) {
          const a = DSP.designBiquad(type, f, q, g, SR);
          const b = eq.designBiquad(type, f, q, g, SR);
          for (const k of ["b0", "b1", "b2", "a1", "a2"]) {
            assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${type} f=${f} q=${q} g=${g} ${k}: ${a[k]} vs ${b[k]}`);
          }
        }
      }
    }
  }
});
