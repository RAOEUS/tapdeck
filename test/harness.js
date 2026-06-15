"use strict";
// Browser-free harness for testing the DSP. The worklet files are plain scripts
// that reference the AudioWorklet globals (sampleRate, AudioWorkletProcessor,
// registerProcessor) and call registerProcessor() at load. We run each file in a
// vm context with those globals stubbed, capture the processor class, and drive
// its process() directly - no browser, fully deterministic.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function runFile(rel, extraGlobals) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const ctx = Object.assign({ console, Math, Date }, extraGlobals);
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: rel });
  return ctx;
}

// dsp-math.js assigns window.DSP
function loadDSP() {
  return runFile("dsp-math.js", { window: {} }).window.DSP;
}

// load a worklet processor; returns { Processor, ctx } (ctx exposes top-level fns too)
function loadWorklet(file, sampleRate = 48000) {
  let Processor = null;
  const ctx = runFile(path.join("worklet", file), {
    sampleRate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
    registerProcessor: (_name, cls) => { Processor = cls; },
  });
  return { Processor, ctx };
}

// push a params message into a processor (what the editor does over the port)
function send(proc, params) { if (proc.port && proc.port.onmessage) proc.port.onmessage({ data: params }); }

// render `blocks` quanta of `n` samples; signalFn(sampleIndex, channel) -> sample.
// returns an array (per block) of channel Float32Arrays.
function render(proc, signalFn, { n = 128, blocks = 200, chans = 2 } = {}) {
  const out = [];
  for (let b = 0, t = 0; b < blocks; b++, t += n) {
    const input = [];
    for (let c = 0; c < chans; c++) {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = signalFn(t + i, c);
      input.push(a);
    }
    const output = [];
    for (let c = 0; c < chans; c++) output.push(new Float32Array(n));
    proc.process([input], [output], {});
    out.push(output);
  }
  return out;
}

function rms(blocks, ch = 0, fromBlock = 0) {
  let s = 0, count = 0;
  for (let b = fromBlock; b < blocks.length; b++) { const a = blocks[b][ch]; for (let i = 0; i < a.length; i++) { s += a[i] * a[i]; count++; } }
  return Math.sqrt(s / Math.max(1, count));
}
function peak(blocks, ch = 0, fromBlock = 0) {
  let p = 0;
  for (let b = fromBlock; b < blocks.length; b++) { const a = blocks[b][ch]; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } }
  return p;
}
// magnitude (peak amplitude) of frequency `f` in the rendered output via a DFT bin
function toneMag(blocks, f, sr = 48000, ch = 0, fromBlock = 10) {
  let re = 0, im = 0, count = 0;
  const n = blocks[0][ch].length;
  for (let b = fromBlock; b < blocks.length; b++) {
    const a = blocks[b][ch];
    for (let i = 0; i < a.length; i++) {
      const t = b * n + i, ph = (2 * Math.PI * f * t) / sr;
      re += a[i] * Math.cos(ph); im -= a[i] * Math.sin(ph); count++;
    }
  }
  return (2 * Math.sqrt(re * re + im * im)) / Math.max(1, count);
}

module.exports = { ROOT, loadDSP, loadWorklet, send, render, rms, peak, toneMag };
