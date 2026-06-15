"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadDSP } = require("./harness");

const DSP = loadDSP();
const SR = 48000;

test("peaking filter reaches its gain at the center frequency", () => {
  assert.ok(Math.abs(DSP.biquadMagDb(DSP.designBiquad("peaking", 1000, 1, 6, SR), 1000, SR) - 6) < 0.2);
  assert.ok(Math.abs(DSP.biquadMagDb(DSP.designBiquad("peaking", 1000, 1, -6, SR), 1000, SR) + 6) < 0.2);
});

test("shelves approach their gain in the shelf band", () => {
  assert.ok(DSP.biquadMagDb(DSP.designBiquad("lowshelf", 100, 0.7, 6, SR), 30, SR) > 4.5);
  assert.ok(DSP.biquadMagDb(DSP.designBiquad("highshelf", 8000, 0.7, 6, SR), 18000, SR) > 4.5);
});

test("lowpass passes lows and attenuates highs", () => {
  const c = DSP.designBiquad("lowpass", 1000, 0.707, 0, SR);
  assert.ok(DSP.biquadMagDb(c, 100, SR) > -1);
  assert.ok(DSP.biquadMagDb(c, 10000, SR) < -20);
});

test("compStaticGR: zero below threshold, ratio slope above", () => {
  assert.equal(DSP.compStaticGR(-30, -20, 4, 0), 0);
  // 10 dB over at 4:1 -> 2.5 dB out -> 7.5 dB reduction
  assert.ok(Math.abs(DSP.compStaticGR(-10, -20, 4, 0) - 7.5) < 1e-6);
});

test("dynGain modes: down cuts above, up boosts below, expand cuts below", () => {
  assert.ok(DSP.dynGain(-30, "down", -20, 4, 0, 24, 4) === 0); // === so +0/-0 both pass
  assert.ok(DSP.dynGain(-10, "down", -20, 4, 0, 24, 4) < 0);
  assert.ok(DSP.dynGain(-30, "up", -20, 4, 0, 24, 4) > 0);
  assert.ok(DSP.dynGain(-30, "expand", -20, 4, 0, 24, 4) < 0);
});
