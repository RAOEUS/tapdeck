// editor.js - core orchestrator, loaded LAST (after the registry, dsp-math,
// editor-helpers.js and editor-renderers.js). Owns the rack/session state, presets,
// persistence, the rack list + add menu, the render dispatch (RENDERERS), the tab
// switcher, the engine poll loop, and boot. All top-level wiring lives here.

let uid = 1;
const nid = () => `m${uid++}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let racks = {};            // tabId -> { modules:[], selected:id }
let template = null;       // default rack, cloned for each newly-captured tab
let userPresets = {};      // name -> modules[] (saved by the user, whole-rack)
let userModulePresets = {}; // type -> { name -> params } (per-module presets)
let sessions = [];         // active sessions [{tabId,title}] reported by the engine
let selectedTab = null;    // tabId currently being viewed/edited
let engine = { running: false };       // latest poll result for the selected tab
let currentDraw = null;                // draw fn for the selected module
let viewCleanup = null;                // tears down the previous view's global listeners
const rack = () => (selectedTab != null ? racks[selectedTab] : null);

// ---------- defaults ----------
function defaultModule(type) {
  const base = { id: nid(), type, bypass: false };
  if (type === "eq") return { ...base, name: "EQ", preamp: 0, mix: 100, chMode: "stereo", bands: [
    { id: nid(), type: "peaking", freq: 120, gain: 0, q: 1, enabled: true },
    { id: nid(), type: "peaking", freq: 1000, gain: 0, q: 1, enabled: true },
    { id: nid(), type: "peaking", freq: 6000, gain: 0, q: 1, enabled: true },
  ] };
  if (type === "comp") return { ...base, name: "Compressor", threshold: -18, ratio: 4, ratioUp: 4, attack: 10, release: 120, knee: 6, makeup: 0, detector: "feedforward", mode: "down", range: 24, mix: 100, scHpf: 20, autoMakeup: false };
  if (type === "limiter") return { ...base, name: "Limiter", inputGain: 0, ceiling: -1, attack: 0, release: 60, hold: 5, lookahead: 5, link: 100, os: 1, style: "transparent", unity: false, dc: false, zoom: 1000 };
  if (type === "utility") return { ...base, name: "Utility", gain: 0, pan: 0, width: 1, mono: false, invL: false, invR: false, swap: false, crossfeed: 0 };
  if (type === "sat") return { ...base, name: "Saturator", drive: 6, mode: "tube", tone: 0, mix: 100, output: 0, os: 2 };
  if (type === "trans") return { ...base, name: "Transient", attack: 0, sustain: 0, output: 0 };
  if (type === "gate") return { ...base, name: "Gate", threshold: -45, ratio: 4, range: 50, attack: 1, release: 120, hold: 12 };
  if (type === "denoise") return { ...base, name: "Denoise", amount: 60, floor: 6 };
  if (type === "dereverb") return { ...base, name: "De-reverb", amount: 50, tail: 300, residual: 12, mix: 100, autoMakeup: true };
  if (type === "autogain") return { ...base, name: "Auto Gain", target: -16, speed: 50, range: 12, gate: -45 };
  if (type === "mbcomp") return { ...base, name: "Multiband", selBand: 0, mix: 100, xovers: [250, 2500], bands: [
    { threshold: -24, ratio: 3, attack: 15, release: 150, knee: 6, makeup: 0, bypass: false, detector: "feedforward", mode: "down", range: 24 },
    { threshold: -22, ratio: 3, attack: 10, release: 120, knee: 6, makeup: 0, bypass: false, detector: "feedforward", mode: "down", range: 24 },
    { threshold: -20, ratio: 3, attack: 5, release: 80, knee: 6, makeup: 0, bypass: false, detector: "feedforward", mode: "down", range: 24 },
  ] };
  return { ...base, name: "Analyzer", speed: 2, smooth: 0.5, ceiling: -20, range: 75,
    contrast: 1.6, sharpen: 0.6, q: 20, fft: 16384, colormap: "magma", fMin: 20, fMax: 20000, grid: true }; // spectrogram (pass-through)
}

// ---------- messaging to engine ----------
function paramsFor(m) {
  if (m.type === "eq") return { bands: m.bands, preamp: m.preamp || 0, mix: m.mix ?? 100, chMode: m.chMode || "stereo" };
  if (m.type === "comp") return { threshold: m.threshold, ratio: m.ratio, ratioUp: m.ratioUp, attack: m.attack, release: m.release, knee: m.knee, makeup: m.makeup, detector: m.detector, mode: m.mode, range: m.range, mix: m.mix, scHpf: m.scHpf, autoMakeup: m.autoMakeup };
  if (m.type === "limiter") return { inputGain: m.inputGain, ceiling: m.ceiling, attack: m.attack, release: m.release, hold: m.hold, lookahead: m.lookahead, link: m.link, os: m.os, style: m.style, unity: m.unity, dc: m.dc };
  if (m.type === "utility") return { gain: m.gain, pan: m.pan, width: m.width, mono: m.mono, invL: m.invL, invR: m.invR, swap: m.swap, crossfeed: m.crossfeed || 0 };
  if (m.type === "mbcomp") return { xovers: m.xovers, bands: m.bands, mix: m.mix };
  if (m.type === "sat") return { drive: m.drive, mode: m.mode, tone: m.tone, mix: m.mix, output: m.output, os: m.os };
  if (m.type === "trans") return { attack: m.attack, sustain: m.sustain, output: m.output };
  if (m.type === "gate") return { threshold: m.threshold, ratio: m.ratio, range: m.range, attack: m.attack, release: m.release, hold: m.hold };
  if (m.type === "denoise") return { amount: m.amount, floor: m.floor };
  if (m.type === "dereverb") return { amount: m.amount, tail: m.tail, residual: m.residual, mix: m.mix, autoMakeup: m.autoMakeup };
  if (m.type === "autogain") return { target: m.target, speed: m.speed, range: m.range, gate: m.gate };
  return {}; // analyzer has nothing to send
}
function send(msg) { try { chrome.runtime.sendMessage({ target: "offscreen", ...msg }); } catch {} }
function pushStructure(tabId) {
  const r = racks[tabId];
  if (!r) return;
  const params = {};
  r.modules.forEach((m) => (params[m.id] = paramsFor(m)));
  send({ type: "sync", tabId, structure: r.modules.map((m) => ({ id: m.id, type: m.type, bypass: m.bypass })), params });
}
function pushParam(m) {
  if (selectedTab == null) return;
  send({ type: "set-param", tabId: selectedTab, id: m.id, params: paramsFor(m) });
}

// ---------- persistence ----------
function save() { chrome.storage.local.set({ racks, template }); }
function savePresets() { chrome.storage.local.set({ presets: userPresets }); }
function load() {
  return new Promise((res) => {
    chrome.storage.local.get(["racks", "template", "presets", "modulePresets"], (d) => {
      racks = d.racks || {};
      template = d.template || defaultRack();
      userPresets = d.presets || {};
      userModulePresets = d.modulePresets || {};
      bumpRack(template);
      Object.values(racks).forEach(bumpRack);
      res();
    });
  });
}
function bumpUid(id) { const n = parseInt(String(id).replace(/\D/g, ""), 10); if (n >= uid) uid = n + 1; }
function bumpRack(r) { if (!r) return; r.modules.forEach((m) => { bumpUid(m.id); (m.bands || []).forEach((b) => bumpUid(b.id)); }); }
function defaultRack() { const m = defaultModule("eq"); return { modules: [m], selected: m.id }; }
// deep-clone a rack with fresh ids (so a new tab starts from the template cleanly)
function cloneRack(src) {
  const modules = (src ? src.modules : []).map((m) => {
    const nm = { ...m, id: nid() };
    if (nm.bands) nm.bands = nm.bands.map((b) => ({ ...b, id: nid() }));
    return nm;
  });
  return { modules, selected: modules[0] ? modules[0].id : null };
}

// ---------- presets ----------
// module spec builders (every field a worklet reads, so presets are self-contained)
const eb = (type, freq, gain, q) => ({ type, freq, gain, q, enabled: true });
const mbBand = (threshold, ratio, attack, release, makeup) => ({ threshold, ratio, attack, release, knee: 6, makeup, bypass: false, detector: "feedforward", mode: "down", range: 24 });
const ottBand = (threshold, ratio, attack, release, makeup) => ({ threshold, ratio, attack, release, knee: 6, makeup, bypass: false, detector: "feedforward", mode: "ott", range: 30 });
// static EQ band (with optional dynamics): dynMode 'down'|'up'|'below'|'ott'
const eqd = (type, freq, q, gain, dynMode, dynThr, dynRange, dynAtk, dynRel) => ({ enabled: true, type, freq, q, gain, dynMode, dynThr, dynRange, dynAtk, dynRel });
const EQm = (bands, o) => ({ type: "eq", name: "EQ", preamp: 0, mix: 100, bands, ...o });
const Cm = (o) => ({ type: "comp", name: "Compressor", threshold: -20, ratio: 3, ratioUp: 3, attack: 10, release: 120, knee: 6, makeup: 0, detector: "feedforward", mode: "down", range: 24, mix: 100, ...o });
const MBm = (name, xovers, bands, o) => ({ type: "mbcomp", name, selBand: 0, xovers, bands, mix: 100, ...o });
const Lm = (o) => ({ type: "limiter", name: "Limiter", inputGain: 0, ceiling: -1, attack: 0, release: 60, hold: 5, lookahead: 5, link: 100, os: 2, style: "transparent", unity: false, dc: false, ...o });
const Sm = (o) => ({ type: "sat", name: "Saturator", drive: 6, mode: "tube", tone: 0, mix: 100, output: 0, os: 2, ...o });
const Gm = (o) => ({ type: "gate", name: "Gate", threshold: -45, ratio: 4, range: 50, attack: 1, release: 120, hold: 12, ...o });
const Dm = (o) => ({ type: "denoise", name: "Denoise", amount: 60, floor: 6, ...o });
const Tm = (o) => ({ type: "trans", name: "Transient", attack: 0, sustain: 0, output: 0, ...o });
const Um = (o) => ({ type: "utility", name: "Utility", gain: 0, pan: 0, width: 1, mono: false, invL: false, invR: false, swap: false, crossfeed: 0, ...o });
const Am = () => ({ type: "analyzer", name: "Analyzer" });
const AGm = (o) => ({ type: "autogain", name: "Auto Gain", target: -16, speed: 50, range: 12, gate: -45, ...o });

const PRESET_CATS = ["Listening", "Genre EQ", "Movies & Games", "Voice & Podcast", "Calls & Streaming", "Mastering", "Creative / FX"];
const BUILTIN_PRESETS = {
  // ---- Listening ----
  "Flat (reference)": { cat: "Listening", desc: "Unprocessed - a clean reference with the analyzer.", modules: [EQm([eb("peaking", 100, 0, 1), eb("peaking", 1000, 0, 1), eb("peaking", 8000, 0, 1)]), Am()] },
  "Bass Boost": { cat: "Listening", desc: "Deeper low end with a touch of air on top.", modules: [EQm([eb("lowshelf", 90, 6, 0.7), eb("peaking", 300, -1.5, 1), eb("highshelf", 10000, 2, 0.7)])] },
  "Loudness Smile": { cat: "Listening", desc: "Smiley curve - fuller lows and brighter highs.", modules: [EQm([eb("lowshelf", 80, 5, 0.7), eb("peaking", 1000, -2, 0.8), eb("highshelf", 8000, 4, 0.7)])] },
  "Vocal Clarity": { cat: "Listening", desc: "Lifts speech and vocals out of a busy mix.", modules: [EQm([eb("highpass", 90, 0, 0.7), eb("peaking", 350, -3, 1.2), eb("peaking", 3000, 4, 1.2), eb("highshelf", 9000, 2, 0.7)]), Cm({ threshold: -20, ratio: 3, attack: 8, autoMakeup: true })] },
  "Warm & Smooth": { cat: "Listening", desc: "Tube warmth that softens digital harshness.", modules: [Sm({ drive: 5, mode: "tube", tone: -15, mix: 60 }), EQm([eb("lowshelf", 120, 1.5, 0.7), eb("highshelf", 9000, -2, 0.7)])] },
  "Air & Clarity": { cat: "Listening", desc: "Cuts mud, adds presence and high-end sparkle.", modules: [EQm([eb("peaking", 300, -2, 1), eb("peaking", 4000, 2, 1.2), eb("highshelf", 11000, 3, 0.7)])] },
  "Night Mode": { cat: "Listening", desc: "Evens out loud and quiet so nothing startles late at night.", modules: [Cm({ threshold: -32, ratio: 4, attack: 15, release: 200, detector: "feedback", autoMakeup: true }), EQm([eb("lowshelf", 90, -2, 0.7), eb("highshelf", 9000, -1.5, 0.7)]), Lm({ ceiling: -1 })] },
  "Auto Level": { cat: "Listening", desc: "Evens out loudness across videos, ads and songs - quiet stays audible, loud stays in check.", modules: [AGm({ target: -16, speed: 45, range: 14, gate: -45 }), Lm({ ceiling: -1, os: 4 })] },

  // ---- Voice & Podcast ----
  "Podcast Voice": { cat: "Voice & Podcast", desc: "Full chain: denoise, gate, EQ, compression and a safety limiter.", modules: [Dm({ amount: 50, floor: 8 }), Gm({ threshold: -42, ratio: 6, range: 40, release: 150, hold: 20 }), EQm([eb("highpass", 80, 0, 0.7), eb("peaking", 250, -3, 1), eb("peaking", 3500, 3, 1.2), eb("highshelf", 10000, 2, 0.7)]), Cm({ threshold: -22, ratio: 3.5, attack: 6, makeup: 4 }), Lm({ ceiling: -1.5 })] },
  "Clean Voice": { cat: "Voice & Podcast", desc: "Denoise, shape and level for talking.", modules: [Dm({ amount: 45, floor: 8 }), EQm([eb("highpass", 85, 0, 0.7), eb("peaking", 300, -2.5, 1), eb("peaking", 3000, 3, 1.2)]), Cm({ threshold: -20, ratio: 3, attack: 8, makeup: 3 })] },
  "De-ess & Polish": { cat: "Voice & Podcast", desc: "A dynamic high band tames sibilance; gentle glue on top.", modules: [EQm([eb("highpass", 80, 0, 0.7), eqd("peaking", 7000, 3, 0, "down", -28, 8, 1, 80), eb("highshelf", 10000, 1.5, 0.7)]), Cm({ threshold: -20, ratio: 3, attack: 6, makeup: 2 })] },
  "Broadcast": { cat: "Voice & Podcast", desc: "Loud, consistent, auto-leveled radio-style voice.", modules: [Dm({ amount: 35, floor: 10 }), EQm([eb("highpass", 75, 0, 0.7), eb("peaking", 2500, 2.5, 1.2), eb("highshelf", 9000, 2, 0.7)]), Cm({ threshold: -24, ratio: 4, attack: 5, release: 100, makeup: 5 }), AGm({ target: -16, speed: 60, range: 12, gate: -42 }), Lm({ ceiling: -1, inputGain: 2, style: "punchy" })] },

  // ---- Calls & Streaming ----
  "Noise Kill": { cat: "Calls & Streaming", desc: "Aggressive denoise + gate for fans, hum and room tone.", modules: [Dm({ amount: 80, floor: 4 }), Gm({ threshold: -38, ratio: 8, range: 50, release: 120, hold: 15 })] },
  "Meeting Voice": { cat: "Calls & Streaming", desc: "Clear, consistently-leveled voice for calls.", modules: [Dm({ amount: 55, floor: 8 }), EQm([eb("highpass", 100, 0, 0.7), eb("peaking", 3000, 3, 1.2)]), Cm({ threshold: -22, ratio: 3, attack: 8, release: 110, makeup: 3 }), AGm({ target: -16, speed: 70, range: 15, gate: -42 }), Lm({ ceiling: -1 })] },
  "Stream Master": { cat: "Calls & Streaming", desc: "Auto-levels to a streaming target with glue + true-peak limit.", modules: [EQm([eb("highpass", 30, 0, 0.7), eb("highshelf", 12000, 1.5, 0.7)]), Cm({ threshold: -18, ratio: 2, attack: 30, release: 150, makeup: 2, detector: "feedback" }), AGm({ target: -14, speed: 40, range: 12, gate: -45 }), Lm({ ceiling: -1.5, os: 4 })] },

  // ---- Mastering ----
  "Master Bus": { cat: "Mastering", desc: "Gentle glue compression into a clean limiter.", modules: [EQm([eb("highpass", 28, 0, 0.7), eb("peaking", 200, -1, 1), eb("highshelf", 12000, 1.5, 0.7)]), Cm({ name: "Glue Comp", threshold: -18, ratio: 2, attack: 30, release: 150, detector: "feedback", autoMakeup: true }), Lm({ inputGain: 1, ceiling: -0.8, release: 80 }), Am()] },
  "Mastering (MB)": { cat: "Mastering", desc: "Multiband control into a true-peak limiter.", modules: [EQm([eb("highpass", 30, 0, 0.7), eb("highshelf", 12000, 1.5, 0.7)]), MBm("Multiband", [200, 3000], [mbBand(-22, 2, 30, 200, 2), mbBand(-22, 2, 20, 160, 1.5), mbBand(-22, 2, 12, 120, 1.5)]), Lm({ inputGain: 1, ceiling: -0.8, release: 80, os: 4 }), Am()] },
  "Loud Master": { cat: "Mastering", desc: "Pushed loudness with punch - for energetic music.", modules: [EQm([eb("highpass", 30, 0, 0.7), eb("lowshelf", 90, 1.5, 0.7), eb("highshelf", 11000, 2, 0.7)]), MBm("Multiband", [150, 2500], [mbBand(-24, 3, 20, 150, 3), mbBand(-22, 3, 15, 120, 2), mbBand(-20, 3, 8, 90, 2)]), Lm({ inputGain: 3, ceiling: -0.8, style: "punchy", os: 4 })] },
  "Transparent Master": { cat: "Mastering", desc: "Minimal - just a clean true-peak ceiling.", modules: [EQm([eb("highpass", 30, 0, 0.7), eb("highshelf", 13000, 1, 0.7)]), Lm({ inputGain: 1, ceiling: -1, style: "transparent", os: 4 })] },

  // ---- Creative / FX ----
  "OTT": { cat: "Creative / FX", desc: "Aggressive up+down multiband - that modern, in-your-face sound.", modules: [MBm("OTT", [120, 2000], [ottBand(-30, 3, 15, 120, 3), ottBand(-30, 3, 10, 100, 3), ottBand(-30, 3, 6, 80, 3)]), EQm([eb("lowshelf", 90, 1, 0.7), eb("highshelf", 10000, 2, 0.7)])] },
  "Lo-Fi": { cat: "Creative / FX", desc: "Band-limited and gritty - vintage/lo-fi character.", modules: [EQm([eb("highpass", 200, 0, 0.7), eb("peaking", 1000, 2, 1), eb("lowpass", 6000, 0, 0.7)]), Sm({ drive: 10, mode: "crunch", tone: -20, mix: 80, os: 4 })] },
  "Telephone": { cat: "Creative / FX", desc: "Narrowband 'phone call' effect.", modules: [EQm([eb("highpass", 300, 0, 0.9), eb("peaking", 1500, 4, 1.5), eb("lowpass", 3400, 0, 0.9)])] },
  "Saturated Drive": { cat: "Creative / FX", desc: "Heavy harmonic drive with output trim.", modules: [Sm({ drive: 14, mode: "tape", output: -3, os: 4 }), EQm([eb("lowshelf", 100, 1, 0.7), eb("highshelf", 10000, -1, 0.7)])] },
  "Wide & Big": { cat: "Creative / FX", desc: "Wider stereo image with a fuller tone.", modules: [Um({ width: 1.4 }), EQm([eb("lowshelf", 100, 1.5, 0.7), eb("highshelf", 10000, 2, 0.7)]), Cm({ threshold: -20, ratio: 2, attack: 20, release: 150, makeup: 1 })] },
  "Mono Check": { cat: "Creative / FX", desc: "Sum to mono to check mono compatibility and phase.", modules: [Um({ mono: true })] },

  // ---- Genre EQ (EQ-only voicings) ----
  "Rock": { cat: "Genre EQ", desc: "Punchy lows, present mids, crisp top.", modules: [EQm([eb("lowshelf", 90, 3, 0.7), eb("peaking", 500, -2, 1), eb("peaking", 3000, 2.5, 1.1), eb("highshelf", 9000, 2.5, 0.7)])] },
  "EDM / Bass": { cat: "Genre EQ", desc: "Big sub & lows with sparkly highs.", modules: [EQm([eb("lowshelf", 70, 6, 0.7), eb("peaking", 400, -2, 1), eb("highshelf", 10000, 4, 0.7)])] },
  "Hip-Hop": { cat: "Genre EQ", desc: "Deep bass, smooth mids, clear vocals.", modules: [EQm([eb("lowshelf", 80, 5, 0.7), eb("peaking", 300, -2, 1), eb("peaking", 2500, 2, 1.1), eb("highshelf", 11000, 2, 0.7)])] },
  "Classical": { cat: "Genre EQ", desc: "Natural and open - gentle air, rumble cut.", modules: [EQm([eb("highpass", 30, 0, 0.7), eb("peaking", 250, -1, 0.8), eb("highshelf", 12000, 2, 0.7)])] },
  "Jazz": { cat: "Genre EQ", desc: "Warm mids, smooth and relaxed.", modules: [EQm([eb("lowshelf", 120, 2, 0.7), eb("peaking", 800, 1, 1), eb("highshelf", 9000, 1.5, 0.7)])] },
  "Acoustic": { cat: "Genre EQ", desc: "Intimate body with clear, airy detail.", modules: [EQm([eb("highpass", 60, 0, 0.7), eb("peaking", 200, -1.5, 1), eb("peaking", 4000, 2, 1.1), eb("highshelf", 11000, 3, 0.7)])] },
  "Vocal Boost": { cat: "Genre EQ", desc: "Pushes voices forward in any mix.", modules: [EQm([eb("highpass", 90, 0, 0.7), eb("peaking", 350, -2.5, 1.1), eb("peaking", 3000, 4, 1.2), eb("highshelf", 9000, 2, 0.7)])] },

  // ---- Movies & Games ----
  "Movie / TV Night": { cat: "Movies & Games", desc: "Tames explosions, lifts dialogue, and auto-levels across scenes for late-night viewing.", modules: [EQm([eb("highpass", 45, 0, 0.7), eb("peaking", 300, -2, 1), eb("peaking", 2500, 3, 1.1), eb("highshelf", 9000, 1.5, 0.7)]), Cm({ threshold: -28, ratio: 3, attack: 20, release: 200, knee: 8, makeup: 4, detector: "feedback", scHpf: 80 }), AGm({ target: -17, speed: 50, range: 12, gate: -45 }), Lm({ ceiling: -1, os: 4 })] },
  "Dialogue Clarity": { cat: "Movies & Games", desc: "Maximum speech intelligibility - presence boost + leveling.", modules: [EQm([eb("highpass", 100, 0, 0.7), eb("peaking", 400, -3, 1.2), eb("peaking", 3000, 5, 1.3), eb("highshelf", 8000, 2, 0.7)]), AGm({ target: -15, speed: 70, range: 15, gate: -42 }), Lm({ ceiling: -1 })] },
  "Gaming": { cat: "Movies & Games", desc: "Brings up footsteps, cues and dialogue; tightens the lows.", modules: [EQm([eb("highpass", 60, 0, 0.7), eb("peaking", 250, -2, 1), eb("peaking", 4500, 4, 1.2), eb("highshelf", 8000, 3, 0.7)]), Cm({ threshold: -24, ratio: 3, attack: 10, release: 120, makeup: 3 })] },
  "Laptop Speakers": { cat: "Movies & Games", desc: "Adds body and tames harshness on small built-in speakers.", modules: [EQm([eb("highpass", 90, 0, 0.7), eb("peaking", 180, 3, 0.9), eb("peaking", 3000, -3, 1.2), eb("highshelf", 9000, 2, 0.7)]), Cm({ threshold: -22, ratio: 3, attack: 12, release: 140, makeup: 2 })] },
};

// transient non-blocking confirmation pill (bottom-center, fades after ~1.4s)
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1400);
}

// multi-level undo/redo: bounded stacks of whole-rack snapshots (tagged by tab)
const undoStack = [], redoStack = [], UNDO_MAX = 80;
function snapshot() { return selectedTab != null && racks[selectedTab] ? { tabId: selectedTab, json: JSON.stringify(racks[selectedTab]) } : null; }
function pushUndo() { const s = snapshot(); if (!s) return; undoStack.push(s); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack.length = 0; }
function restoreSnap(snap) { racks[snap.tabId] = JSON.parse(snap.json); selectedTab = snap.tabId; sigView = selectedTab; commit(); }
function doUndo() {
  if (!undoStack.length) { toast("Nothing to undo"); return; }
  const cur = snapshot(); if (cur) redoStack.push(cur);
  restoreSnap(undoStack.pop());
  toast("Undo");
}
function doRedo() {
  if (!redoStack.length) { toast("Nothing to redo"); return; }
  const cur = snapshot(); if (cur) undoStack.push(cur);
  restoreSnap(redoStack.pop());
  toast("Redo");
}

// deep-clone one module with fresh ids (module + any band ids)
function cloneModule(m) {
  const nm = JSON.parse(JSON.stringify(m));
  nm.id = nid();
  if (nm.bands) nm.bands = nm.bands.map((b) => ({ ...b, id: nid() }));
  return nm;
}
function duplicateModule(id) {
  const r = rack(); if (!r) return;
  const idx = r.modules.findIndex((x) => x.id === id); if (idx < 0) return;
  pushUndo();
  const clone = cloneModule(r.modules[idx]);
  r.modules.splice(idx + 1, 0, clone);
  r.selected = clone.id;
  commit();
  toast(`Duplicated ${clone.name}`);
}
// inline-rename a module by editing `el` in place (rack-list name or editor title)
function startRename(el, m) {
  const li = el.closest(".module-item"); if (li) li.draggable = false;
  const prev = m.name;
  el.contentEditable = "plaintext-only";
  el.classList.add("renaming");
  el.textContent = m.name;
  const range = document.createRange(); range.selectNodeContents(el);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  el.focus();
  let done = false;
  const finish = (keep) => {
    if (done) return; done = true;
    el.removeEventListener("keydown", onKey); el.removeEventListener("blur", onBlur);
    const v = el.textContent.replace(/\s+/g, " ").trim();
    m.name = (keep && v) ? v.slice(0, 40) : prev;
    commit({ structure: false }); // re-renders with the new name; no DSP resync needed
  };
  const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } };
  const onBlur = () => finish(true);
  el.addEventListener("keydown", onKey);
  el.addEventListener("blur", onBlur);
}
let moduleClipboard = null; // JSON of a copied module (paste clones it, even across tabs)
function copyModule(id) {
  const r = rack(); const m = r && r.modules.find((x) => x.id === id);
  if (!m) return;
  moduleClipboard = JSON.stringify(m);
  toast(`Copied ${m.name}`);
}
function pasteModule() {
  const r = rack();
  if (!r) return;
  if (!moduleClipboard) { toast("Nothing to paste"); return; }
  pushUndo();
  const clone = cloneModule(JSON.parse(moduleClipboard));
  const idx = r.modules.findIndex((x) => x.id === r.selected);
  r.modules.splice(idx >= 0 ? idx + 1 : r.modules.length, 0, clone);
  r.selected = clone.id;
  commit();
  toast(`Pasted ${clone.name}`);
}

// modules array for a preset name, from either source
function presetModules(name) {
  const b = BUILTIN_PRESETS[name];
  return b ? b.modules : (userPresets[name] || null);
}
function applyPreset(name) {
  if (selectedTab == null) { toast("Capture a tab first"); return; }
  const spec = presetModules(name);
  if (!spec) return;
  const r = rack(); // applyPreset replaces the WHOLE rack - guard a non-empty one
  if (r && Array.isArray(r.modules) && r.modules.length && !confirm(`Replace this tab's rack with "${name}"?`)) return;
  pushUndo();
  racks[selectedTab] = cloneRack({ modules: JSON.parse(JSON.stringify(spec)) });
  commit();
  toast(`Applied preset "${name}"`);
}
function savePreset() {
  const r = rack();
  if (!r) { alert("Capture a tab first."); return; }
  const name = (prompt("Save this rack as a preset named:") || "").trim();
  if (!name) return;
  if (BUILTIN_PRESETS[name]) { alert("That name is reserved by a built-in preset."); return; }
  userPresets[name] = JSON.parse(JSON.stringify(r.modules));
  savePresets();
  renderPresets();
  toast(`Saved preset "${name}"`);
}
function deletePresetByName(name) {
  if (!userPresets[name]) return;
  if (!confirm(`Delete preset "${name}"?`)) return;
  delete userPresets[name];
  savePresets();
  renderPresets();
  toast(`Deleted "${name}"`);
}
function renderPresets() { if (presetModalEl) buildPresetBody(); } // refresh the browser if it's open

// ---------- preset browser (modal) ----------
let presetModalEl = null;
const chainTags = (modules) => modules.map((mm) => `<span class="pc-tag">${escapeHtml(TAGS[mm.type] || mm.type)}</span>`).join("");
function presetCard(name, desc, modules, isUser) {
  return `<button class="preset-card" data-name="${escapeHtml(name)}">
      ${isUser ? `<span class="pc-del" title="Delete preset">✕</span>` : ""}
      <span class="pc-name">${escapeHtml(name)}</span>
      <span class="pc-desc">${escapeHtml(desc)}</span>
      <span class="pc-chain">${chainTags(modules)}</span>
    </button>`;
}
function buildPresetBody() {
  const body = presetModalEl && presetModalEl.querySelector("#presetBody");
  if (!body) return;
  let html = "";
  for (const cat of PRESET_CATS) {
    const names = Object.keys(BUILTIN_PRESETS).filter((n) => BUILTIN_PRESETS[n].cat === cat);
    if (!names.length) continue;
    html += `<div class="preset-cat">${escapeHtml(cat)}</div><div class="preset-grid">${names.map((n) => presetCard(n, BUILTIN_PRESETS[n].desc, BUILTIN_PRESETS[n].modules, false)).join("")}</div>`;
  }
  const un = Object.keys(userPresets);
  html += `<div class="preset-cat">My presets</div>`;
  html += un.length
    ? `<div class="preset-grid">${un.map((n) => presetCard(n, `${userPresets[n].length} module${userPresets[n].length === 1 ? "" : "s"}`, userPresets[n], true)).join("")}</div>`
    : `<p class="preset-none">Build a rack, then “Save current rack…” to keep it here.</p>`;
  body.innerHTML = html;
  body.querySelectorAll(".preset-card").forEach((c) => {
    c.addEventListener("click", (e) => {
      if (e.target.closest(".pc-del")) { e.stopPropagation(); deletePresetByName(c.dataset.name); return; }
      applyPreset(c.dataset.name); closePresetBrowser();
    });
  });
}
function openPresetBrowser() {
  closePresetBrowser();
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  ov.innerHTML = `
    <div class="modal" role="dialog" aria-label="Rack presets">
      <div class="modal-head"><h2>Rack presets</h2><button class="modal-x" title="Close">✕</button></div>
      <div class="modal-body" id="presetBody"></div>
      <div class="modal-foot">
        <button id="presetSaveCur" class="primary">Save current rack…</button>
        <span class="modal-hint">Choosing a preset replaces this tab's whole rack (one-step undo available).</span>
      </div>
    </div>`;
  document.body.appendChild(ov);
  presetModalEl = ov;
  buildPresetBody();
  ov.querySelector(".modal-x").addEventListener("click", closePresetBrowser);
  ov.querySelector("#presetSaveCur").addEventListener("click", savePreset);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closePresetBrowser(); });
}
function closePresetBrowser() { if (presetModalEl) { presetModalEl.remove(); presetModalEl = null; } }

// ---------- per-module presets ----------
const BUILTIN_MODULE_PRESETS = {
  eq: {
    "Flat": { bands: [eb("peaking", 100, 0, 1), eb("peaking", 1000, 0, 1), eb("peaking", 8000, 0, 1)] },
    "Air Lift": { bands: [eb("highshelf", 10000, 4, 0.7), eb("peaking", 3000, 1.5, 1)] },
    "Low Cut": { bands: [eb("highpass", 90, 0, 0.7)] },
    "Telephone": { bands: [eb("highpass", 400, 0, 0.7), eb("lowpass", 3000, 0, 0.7), eb("peaking", 1500, 4, 1)] },
    "Rock": { bands: [eb("lowshelf", 90, 3, 0.7), eb("peaking", 500, -2, 1), eb("peaking", 3000, 2.5, 1.1), eb("highshelf", 9000, 2.5, 0.7)] },
    "EDM / Bass": { bands: [eb("lowshelf", 70, 6, 0.7), eb("peaking", 400, -2, 1), eb("highshelf", 10000, 4, 0.7)] },
    "Hip-Hop": { bands: [eb("lowshelf", 80, 5, 0.7), eb("peaking", 300, -2, 1), eb("peaking", 2500, 2, 1.1), eb("highshelf", 11000, 2, 0.7)] },
    "Classical": { bands: [eb("highpass", 30, 0, 0.7), eb("peaking", 250, -1, 0.8), eb("highshelf", 12000, 2, 0.7)] },
    "Vocal Boost": { bands: [eb("highpass", 90, 0, 0.7), eb("peaking", 350, -2.5, 1.1), eb("peaking", 3000, 4, 1.2), eb("highshelf", 9000, 2, 0.7)] },
    // dynamic-EQ presets (per-band compression): gain 0, duck/lift only when triggered
    "De-Esser (soft)": { bands: [eqd("peaking", 7000, 5, 0, "down", -32, 6, 2, 70)] },
    "De-Esser (hard)": { bands: [eqd("peaking", 6500, 6.5, 0, "down", -34, 12, 1, 60)] },
    "De-Esser (high/airy)": { bands: [eqd("peaking", 9500, 5, 0, "down", -34, 8, 1.5, 65)] },
    "De-Esser (2-band)": { bands: [eqd("peaking", 6000, 6, 0, "down", -32, 9, 1, 60), eqd("peaking", 9000, 5, 0, "down", -34, 7, 1.5, 70)] },
    "De-Harsh (mids)": { bands: [eqd("peaking", 3000, 3, 0, "down", -26, 6, 4, 90)] },
    "Tame Boom": { bands: [eqd("peaking", 180, 1.6, 0, "down", -22, 8, 8, 140)] },
    "Tame Mud": { bands: [eqd("peaking", 350, 2, 0, "down", -24, 6, 10, 150)] },
    "Vocal Clarity (dyn)": { bands: [eqd("peaking", 300, 1.8, 0, "down", -24, 5, 10, 150), eqd("peaking", 4000, 2.5, 0, "up", -30, 4, 4, 90)] },
    "Dynamic Air": { bands: [eqd("highshelf", 12000, 0.7, 0, "below", -40, 5, 20, 200)] },
    "Loudness Lift (quiet)": { bands: [eqd("lowshelf", 120, 0.7, 0, "below", -34, 5, 30, 250), eqd("highshelf", 9000, 0.7, 0, "below", -36, 4, 30, 250)] },
    "Bright Glue (dyn)": { bands: [eqd("highshelf", 8000, 0.7, 0, "down", -26, 4, 6, 120)] },
    "Band OTT (presence)": { bands: [eqd("peaking", 3000, 1.4, 0, "ott", -28, 6, 8, 150)] },
    "Spectral OTT (3-band)": { bands: [eqd("lowshelf", 140, 0.7, 0, "ott", -30, 6, 12, 180), eqd("peaking", 1200, 1, 0, "ott", -30, 6, 8, 150), eqd("highshelf", 7000, 0.7, 0, "ott", -32, 6, 6, 130)] },
  },
  comp: {
    "Gentle Glue": { threshold: -20, ratio: 2, attack: 30, release: 200, knee: 8, makeup: 1.5, detector: "feedback", mode: "down", autoMakeup: true },
    "Vocal": { threshold: -22, ratio: 4, attack: 6, release: 90, knee: 5, makeup: 3, detector: "feedforward", mode: "down", autoMakeup: true },
    "Punch": { threshold: -18, ratio: 4, attack: 25, release: 120, knee: 3, makeup: 2, detector: "feedforward", mode: "down", autoMakeup: true },
    "Smash": { threshold: -28, ratio: 10, attack: 1, release: 60, knee: 2, makeup: 5, detector: "feedforward", mode: "down", autoMakeup: true },
    "Upward Lift": { threshold: -30, ratio: 2.5, attack: 20, release: 220, knee: 8, makeup: 0, detector: "feedforward", mode: "up", range: 12 },
    "OTT": { threshold: -28, ratio: 4, ratioUp: 4, attack: 8, release: 100, knee: 6, makeup: 3, detector: "feedforward", mode: "ott", range: 24, mix: 100 },
    "OTT (gentle)": { threshold: -24, ratio: 3, ratioUp: 3, attack: 16, release: 150, knee: 6, makeup: 2, detector: "feedforward", mode: "ott", range: 18, mix: 100 },
    "Bus Glue": { threshold: -16, ratio: 2, attack: 30, release: 250, knee: 8, makeup: 1.5, detector: "feedback", mode: "down", range: 24, mix: 100, autoMakeup: true },
    "Parallel Squeeze": { threshold: -32, ratio: 8, attack: 2, release: 80, knee: 4, makeup: 4, detector: "feedforward", mode: "down", range: 24, mix: 40 },
  },
  limiter: {
    "Transparent": { inputGain: 0, ceiling: -1, attack: 0, release: 120, hold: 5, lookahead: 5, link: 100, os: 4, style: "transparent", unity: false, dc: false },
    "Streaming (-1 dBTP)": { inputGain: 0, ceiling: -1, attack: 0, release: 100, hold: 5, lookahead: 5, link: 100, os: 4, style: "transparent", unity: false, dc: true },
    "Glue (gentle)": { inputGain: 0, ceiling: -1, attack: 3, release: 150, hold: 12, lookahead: 5, link: 100, os: 2, style: "smooth", unity: false, dc: false },
    "Loud": { inputGain: 4, ceiling: -0.3, attack: 0, release: 50, hold: 3, lookahead: 4, link: 100, os: 4, style: "punchy", unity: false, dc: false },
    "Punchy Master": { inputGain: 3, ceiling: -0.8, attack: 0, release: 60, hold: 5, lookahead: 5, link: 100, os: 4, style: "punchy", unity: false, dc: false },
    "Brickwall (max)": { inputGain: 2, ceiling: -0.1, attack: 0, release: 30, hold: 2, lookahead: 6, link: 100, os: 4, style: "aggressive", unity: false, dc: false },
  },
  utility: {
    "Default": { gain: 0, pan: 0, width: 1, mono: false, invL: false, invR: false, swap: false },
    "Wide": { gain: 0, pan: 0, width: 1.4, mono: false, invL: false, invR: false, swap: false },
    "Narrow": { gain: 0, pan: 0, width: 0.6, mono: false, invL: false, invR: false, swap: false },
    "Mono": { gain: 0, pan: 0, width: 1, mono: true, invL: false, invR: false, swap: false },
  },
  mbcomp: {
    "Master Glue": { xovers: [200, 3000], bands: [mbBand(-22, 2, 30, 200, 2), mbBand(-22, 2, 20, 160, 1.5), mbBand(-22, 2, 12, 120, 1.5)] },
    "Aggressive": { xovers: [250, 2500], bands: [mbBand(-26, 4, 10, 140, 3), mbBand(-24, 4, 6, 110, 3), mbBand(-22, 5, 3, 80, 3)] },
    "De-Harsh (4-band)": { xovers: [200, 2000, 6000], bands: [mbBand(-60, 1, 20, 150, 0), mbBand(-60, 1, 20, 150, 0), mbBand(-26, 4, 2, 80, 1.5), mbBand(-24, 3, 2, 90, 1)] },
    "OTT": { xovers: [120, 2500], bands: [ottBand(-30, 4, 10, 120, 4), ottBand(-30, 4, 6, 90, 3), ottBand(-30, 4, 2, 60, 3)] },
    "OTT (gentle)": { xovers: [150, 3000], bands: [ottBand(-24, 3, 20, 180, 2), ottBand(-24, 3, 12, 140, 1.5), ottBand(-24, 3, 6, 100, 1.5)] },
  },
  sat: {
    "Warm Tube": { drive: 8, mode: "tube", tone: 8, mix: 100, output: -1.5, os: 2 },
    "Tape": { drive: 6, mode: "tape", tone: -6, mix: 100, output: -1, os: 2 },
    "Console Drive": { drive: 10, mode: "tube", tone: -3, mix: 100, output: -2, os: 4 },
    "Crunch": { drive: 16, mode: "crunch", tone: 0, mix: 100, output: -3, os: 4 },
    "Hard Clip": { drive: 12, mode: "hard", tone: 0, mix: 100, output: -2, os: 4 },
    "Exciter (parallel)": { drive: 5, mode: "tube", tone: 60, mix: 35, output: 0, os: 2 },
    "Wavefolder": { drive: 12, mode: "fold", tone: 0, mix: 60, output: -4, os: 4 },
  },
  trans: {
    "Punch": { attack: 50, sustain: 0, output: 0 },
    "Snap": { attack: 80, sustain: -25, output: 0 },
    "Fatten": { attack: 0, sustain: 45, output: 0 },
    "Soften": { attack: -45, sustain: 20, output: 0 },
    "Drum Smack": { attack: 70, sustain: -10, output: 0 },
    "Room / Ambience": { attack: -20, sustain: 60, output: -1 },
  },
  gate: {
    "Gentle Expander": { threshold: -50, ratio: 2, range: 12, attack: 5, release: 200, hold: 30 },
    "Tight Gate": { threshold: -40, ratio: 10, range: 60, attack: 0.5, release: 80, hold: 5 },
    "Noise Gate": { threshold: -55, ratio: 20, range: 70, attack: 0.3, release: 90, hold: 8 },
    "Vocal Gate": { threshold: -45, ratio: 6, range: 35, attack: 1, release: 120, hold: 18 },
    "Drum Gate (tight)": { threshold: -36, ratio: 12, range: 60, attack: 0.3, release: 60, hold: 4 },
  },
  denoise: {
    "Voice (gentle)": { amount: 45, floor: 10 },
    "Stream / Podcast": { amount: 60, floor: 7 },
    "Voice (strong)": { amount: 78, floor: 5 },
    "Aggressive": { amount: 92, floor: 3 },
  },
  autogain: {
    "General Listening": { target: -16, speed: 45, range: 12, gate: -45 },
    "Dialog / Podcast": { target: -16, speed: 70, range: 15, gate: -42 },
    "Gentle (album)": { target: -18, speed: 20, range: 9, gate: -48 },
    "Aggressive Leveler": { target: -14, speed: 85, range: 18, gate: -40 },
    "Quiet Boost": { target: -14, speed: 50, range: 36, gate: -50 },
  },
  dereverb: {
    "Light": { amount: 35, tail: 250, residual: 18, mix: 100 },
    "Room": { amount: 55, tail: 350, residual: 12, mix: 100 },
    "Strong": { amount: 80, tail: 550, residual: 6, mix: 100 },
    "Vocal (parallel)": { amount: 70, tail: 300, residual: 10, mix: 70 },
  },
  analyzer: {
    "Default": { speed: 2, smooth: 0.5, ceiling: -20, range: 75, contrast: 1.6, sharpen: 0.6, q: 20, fft: 16384, colormap: "magma", fMin: 20, fMax: 20000, grid: true },
    "High-Res": { speed: 2, smooth: 0.6, ceiling: -15, range: 80, contrast: 2, sharpen: 1, q: 32, fft: 32768, colormap: "inferno", fMin: 20, fMax: 20000, grid: true },
    "Fast/Bright": { speed: 4, smooth: 0.2, ceiling: -18, range: 70, contrast: 1.4, sharpen: 0.8, q: 12, fft: 8192, colormap: "viridis", fMin: 20, fMax: 20000, grid: true },
  },
};
function saveModulePresets() { chrome.storage.local.set({ modulePresets: userModulePresets }); }
// the savable params for a module (analyzer's live-display fields aren't in paramsFor)
function presetParamsFor(m) {
  if (m.type === "analyzer") return { speed: m.speed, smooth: m.smooth, ceiling: m.ceiling, range: m.range, contrast: m.contrast, sharpen: m.sharpen, q: m.q, fft: m.fft, colormap: m.colormap, fMin: m.fMin, fMax: m.fMax, grid: m.grid };
  return paramsFor(m);
}
function getModulePreset(type, name) {
  return (userModulePresets[type] && userModulePresets[type][name]) || (BUILTIN_MODULE_PRESETS[type] && BUILTIN_MODULE_PRESETS[type][name]) || null;
}
function applyModulePreset(m, name) {
  const raw = getModulePreset(m.type, name);
  if (!raw) return;
  const spec = JSON.parse(JSON.stringify(raw)); // own copy (don't mutate built-ins)
  for (const k of Object.keys(spec)) {
    if (k === "bands" && m.type === "eq") m.bands = spec.bands.map((b) => ({ ...b, id: nid() }));
    else m[k] = spec[k];
  }
  if (m.type === "mbcomp") m.selBand = 0;
  commit();
  toast(`Applied "${name}" to ${m.name}`);
}
function saveModulePreset(m) {
  const tag = TAGS[m.type] || m.type;
  const name = (prompt(`Save ${tag} preset as:`) || "").trim();
  if (!name) return;
  if (BUILTIN_MODULE_PRESETS[m.type] && BUILTIN_MODULE_PRESETS[m.type][name]) { alert("That name is reserved by a built-in preset."); return; }
  userModulePresets[m.type] = userModulePresets[m.type] || {};
  userModulePresets[m.type][name] = JSON.parse(JSON.stringify(presetParamsFor(m)));
  saveModulePresets();
  injectModulePresetBar(m, name);
}
function deleteModulePreset(m, name) {
  if (!(userModulePresets[m.type] && userModulePresets[m.type][name])) { alert("Built-in presets can't be deleted."); return; }
  if (!confirm(`Delete ${m.type} preset "${name}"?`)) return;
  delete userModulePresets[m.type][name];
  saveModulePresets();
  injectModulePresetBar(m);
}
function injectModulePresetBar(m, selectName) {
  const old = edEl.querySelector(".mod-preset");
  if (old) old.remove();
  const head = edEl.querySelector(".ed-head");
  if (!head) return;
  const builtin = Object.keys(BUILTIN_MODULE_PRESETS[m.type] || {});
  const user = Object.keys(userModulePresets[m.type] || {});
  const opt = (n) => `<option>${escapeHtml(n)}</option>`;
  const bg = builtin.length ? `<optgroup label="Built-in">${builtin.map(opt).join("")}</optgroup>` : "";
  const ug = user.length ? `<optgroup label="My presets">${user.map(opt).join("")}</optgroup>` : "";
  const bar = document.createElement("div");
  bar.className = "mod-preset";
  bar.innerHTML = `<span class="mp-label">Preset</span>
    <select id="mpSel">${bg}${ug}</select>
    <button id="mpApply">Apply</button>
    <button id="mpSave" title="Save this module as a preset">Save</button>
    <button id="mpDel" title="Delete selected user preset">✕</button>`;
  head.insertAdjacentElement("afterend", bar);
  const sel = bar.querySelector("#mpSel");
  if (selectName) sel.value = selectName;
  bar.querySelector("#mpApply").addEventListener("click", () => applyModulePreset(m, sel.value));
  bar.querySelector("#mpSave").addEventListener("click", () => saveModulePreset(m));
  bar.querySelector("#mpDel").addEventListener("click", () => deleteModulePreset(m, sel.value));
}

// ---------- rack list (with drag-and-drop) ----------
const listEl = document.getElementById("moduleList");
// rack chip labels, derived from the shared module registry (module-registry.js)
const TAGS = Object.fromEntries(TAPDECK_MODULES.map((m) => [m.type, m.tag]));
let dragId = null;

function renderRack() {
  listEl.innerHTML = "";
  const r = rack();
  if (!r) { listEl.innerHTML = `<li class="rack-empty">No tab selected.<br>Start one from the popup.</li>`; return; }
  if (!r.modules.length) { listEl.innerHTML = `<li class="rack-empty">Empty rack.<br>Add a module above to get started.</li>`; return; }
  r.modules.forEach((m) => {
    const li = document.createElement("li");
    li.className = "module-item" + (m.id === r.selected ? " selected" : "") + (m.bypass ? " bypassed" : "");
    li.draggable = true;
    li.dataset.id = m.id;
    const canBypass = m.type !== "analyzer";
    li.innerHTML = `
      <span class="grip" title="Drag to reorder">⠿</span>
      ${canBypass ? `<button class="pwr ${m.bypass ? "" : "on"}" title="Bypass">${m.bypass ? "○" : "●"}</button>` : `<span class="pwr ghost">◍</span>`}
      <span class="name" title="${escapeHtml(m.name)} - double-click to rename">${escapeHtml(m.name)}</span>
      <span class="tag">${TAGS[m.type] || m.type}</span>
      <button class="dup" title="Duplicate">⧉</button>
      <button class="del" title="Remove">✕</button>`;

    li.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.isContentEditable) return;
      r.selected = m.id; commit({ structure: false });
    });
    if (canBypass) li.querySelector(".pwr").addEventListener("click", () => { m.bypass = !m.bypass; commit(); });
    li.querySelector(".dup").addEventListener("click", () => duplicateModule(m.id));
    li.querySelector(".del").addEventListener("click", () => removeModule(m.id));
    const nameEl = li.querySelector(".name");
    nameEl.addEventListener("dblclick", (e) => { e.stopPropagation(); startRename(nameEl, m); });

    // drag and drop
    li.addEventListener("dragstart", (e) => { dragId = m.id; e.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); });
    li.addEventListener("dragend", () => { dragId = null; renderRack(); });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      const after = (e.clientY - li.getBoundingClientRect().top) > li.offsetHeight / 2;
      li.classList.toggle("drop-after", after);
      li.classList.toggle("drop-before", !after);
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-after", "drop-before"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const after = (e.clientY - li.getBoundingClientRect().top) > li.offsetHeight / 2;
      reorder(dragId, m.id, after);
    });

    listEl.appendChild(li);
  });
}
function reorder(srcId, targetId, after) {
  const r = rack();
  if (!r || !srcId || srcId === targetId) { renderRack(); return; }
  const src = r.modules.find((x) => x.id === srcId);
  if (!src) return;
  r.modules = r.modules.filter((x) => x.id !== srcId);
  let ti = r.modules.findIndex((x) => x.id === targetId);
  if (ti < 0) ti = r.modules.length - 1;
  r.modules.splice(after ? ti + 1 : ti, 0, src);
  commit();
}
function removeModule(id) {
  const r = rack();
  if (!r) return;
  pushUndo();
  r.modules = r.modules.filter((m) => m.id !== id);
  if (r.selected === id) r.selected = r.modules[0]?.id || null;
  commit();
}
function addModule(type) {
  const r = rack();
  if (!r) return;
  const m = defaultModule(type);
  r.modules.push(m);
  r.selected = m.id;
  commit();
}

function commit({ structure = true } = {}) {
  renderRack();
  renderEditor();
  if (structure) pushStructure(selectedTab);
  save();
}

// reset one module's parameters to its type defaults (keeps id, position, bypass)
function resetModule(m) {
  pushUndo();
  const def = defaultModule(m.type);
  const id = m.id, bypass = m.bypass;
  Object.keys(m).forEach((k) => delete m[k]);
  Object.assign(m, def);
  m.id = id; m.bypass = bypass;
  commit();
  toast(`${m.name} reset to defaults`);
}

// add-module menu: one button opens a grouped picker with full names + descriptions,
// built from the shared module registry (groups in TAPDECK_MODULE_GROUPS order).
const addBtnEl = document.getElementById("addBtn"), addMenuEl = document.getElementById("addMenu");
function buildAddMenu() {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const order = (g) => { const i = TAPDECK_MODULE_GROUPS.indexOf(g); return i < 0 ? TAPDECK_MODULE_GROUPS.length : i; };
  const groups = [...new Set(TAPDECK_MODULES.map((m) => m.group))].sort((a, b) => order(a) - order(b));
  let html = "";
  for (const g of groups) {
    html += `<div class="addgroup">${esc(g)}</div>`;
    for (const m of TAPDECK_MODULES.filter((x) => x.group === g))
      html += `<button data-add="${m.type}"><b>${esc(m.name)}</b><span>${esc(m.desc)}</span></button>`;
  }
  addMenuEl.innerHTML = html;
  addMenuEl.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { setAddMenu(false); addModule(b.dataset.add); })
  );
}
function setAddMenu(open) { addMenuEl.hidden = !open; addBtnEl.setAttribute("aria-expanded", open ? "true" : "false"); addBtnEl.classList.toggle("on", open); }
addBtnEl.addEventListener("click", (e) => { e.stopPropagation(); setAddMenu(addMenuEl.hidden); });
buildAddMenu();
document.addEventListener("click", (e) => { if (!addMenuEl.hidden && !e.target.closest("#addWrap")) setAddMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setAddMenu(false); });

document.getElementById("presetBrowse").addEventListener("click", openPresetBrowser);
document.getElementById("presetSave").addEventListener("click", savePreset);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePresetBrowser(); closeHpBrowser(); closeAgForm(); } });

// ---------- editor panel ----------
const edEl = document.getElementById("moduleEditor");
// per-type editor renderers (function declarations below are hoisted). The
// registry is the source of truth for which types exist; this maps each to its
// render fn, and the guard below fails loudly if a registry entry has no UI.
const RENDERERS = {
  eq: renderEQ, comp: renderComp, limiter: renderLimiter, utility: renderUtility,
  mbcomp: renderMBComp, sat: renderSat, trans: renderTrans, gate: renderGate,
  denoise: renderDenoise, dereverb: renderDereverb, autogain: renderAutoGain,
  analyzer: renderAnalyzer,
};
for (const mod of TAPDECK_MODULES) {
  if (typeof RENDERERS[mod.type] !== "function") console.error(`Tapdeck: module "${mod.type}" has no renderer`);
}
function renderEditor() {
  if (viewCleanup) { viewCleanup(); viewCleanup = null; }
  currentDraw = null;
  const r = rack();
  if (!r) {
    edEl.innerHTML = `
      <div class="onboard"><div class="onboard-card">
        <h2>No tab captured yet</h2>
        <ol>
          <li>Open a tab that's playing audio</li>
          <li>Click the <b>Tapdeck</b> toolbar icon, then <b>Start on this tab</b></li>
          <li>Come back here to build and visualize your rack</li>
        </ol>
      </div></div>`;
    return;
  }
  let m = r.modules.find((x) => x.id === r.selected);
  if (!m && r.modules.length) { r.selected = r.modules[0].id; m = r.modules[0]; } // heal a stale selection
  if (!m) {
    edEl.innerHTML = `
      <div class="onboard"><div class="onboard-card">
        <h2>Empty rack</h2>
        <p>Add your first module with <b>+ Add module</b> at the top-left. It'll open here, ready to dial in.</p>
      </div></div>`;
    return;
  }
  (RENDERERS[m.type] || renderAnalyzer)(m);
  const rb = document.getElementById("resetMod");
  if (rb) rb.onclick = () => resetModule(m);
  const tt = document.getElementById("edTitle");
  if (tt) tt.addEventListener("dblclick", () => startRename(tt, m));
  injectModulePresetBar(m);
}


// ---------- engine sync + tab switcher + visibility-gated poll loop ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "engine-ready") {
    // a tab just started capturing - give it a rack (cloned from the template if
    // it has none yet) and push it into the fresh session.
    if (!racks[msg.tabId]) racks[msg.tabId] = cloneRack(template);
    pushStructure(msg.tabId);
    send({ type: "set-bypass", tabId: msg.tabId, bypass: !!racks[msg.tabId].masterBypass });
    syncedTabs.add(msg.tabId);
    save();
  }
  // engine-stopped is handled implicitly: the tab drops from the session list.
});

const statusEl = document.getElementById("engineStatus");
const statusText = document.getElementById("engineText");
const switcherEl = document.getElementById("tabSwitcher");
let looping = false;
const syncedTabs = new Set(); // sessions whose rack we've already pushed to the engine
let sigSwitcher = "", sigView;
let specTab = null, specOn = false; // which session's STFT is running, and whether

// Run the (CPU-heavy) STFT only when its output is on screen - i.e. the selected
// module is the EQ (spectrum overlay) or the Analyzer (spectrogram).
function specWanted() {
  const r = rack();
  const mod = r && r.modules.find((x) => x.id === r.selected);
  return !!(engine.running && mod && (mod.type === "eq" || mod.type === "analyzer" || mod.type === "mbcomp"));
}
function updateSpecActive() {
  if (specTab !== selectedTab) {
    if (specTab != null) send({ type: "spec-active", tabId: specTab, active: false });
    specTab = selectedTab; specOn = false;
  }
  const want = specWanted();
  if (want !== specOn) {
    if (selectedTab != null) send({ type: "spec-active", tabId: selectedTab, active: want });
    specOn = want;
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function renderSwitcher() {
  switcherEl.innerHTML = "";
  if (!sessions.length) {
    switcherEl.innerHTML = `<span class="sw-empty">No tabs captured - Start one from the popup</span>`;
    return;
  }
  sessions.forEach((se) => {
    const chip = document.createElement("button");
    chip.className = "tabchip" + (se.tabId === selectedTab ? " active" : "");
    chip.innerHTML = `<span class="dot"></span><span class="t">${escapeHtml(se.title)}</span><span class="x" title="Stop this tab">✕</span>`;
    chip.addEventListener("click", (e) => {
      if (e.target.closest(".x")) { send({ type: "stop-capture", tabId: se.tabId }); return; }
      if (selectedTab === se.tabId) return;
      selectedTab = se.tabId; sigView = selectedTab; // repaint now instead of waiting for the next poll
      renderSwitcher(); renderRack(); renderEditor(); updateSpecActive(); updateBypassBtn();
    });
    switcherEl.appendChild(chip);
  });
}

document.getElementById("setDefault").addEventListener("click", (e) => {
  const r = rack();
  if (!r) return;
  template = cloneRack(r);
  save();
  e.target.textContent = "Saved ✓";
  setTimeout(() => (e.target.textContent = "Set as default"), 1200);
});

// app-level keyboard shortcuts (ignored while typing in a field)
document.addEventListener("keydown", (e) => {
  const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
  if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
  if (typing) return;
  const r = rack(), sel = r && r.modules.find((x) => x.id === r.selected);
  if (mod && k === "d") { if (sel) { e.preventDefault(); duplicateModule(sel.id); } return; }
  // copy/paste a module across the rack/tabs - only when no text is selected, so it
  // doesn't steal a real text copy
  if (mod && k === "c" && !String(window.getSelection())) { if (sel) { e.preventDefault(); copyModule(sel.id); } return; }
  if (mod && k === "v" && !String(window.getSelection())) { if (r) { e.preventDefault(); pasteModule(); } return; }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (sel) { e.preventDefault(); removeModule(sel.id); toast(`Removed ${sel.name} - Ctrl+Z to undo`); }
  }
});

const masterBypassBtn = document.getElementById("masterBypass");
masterBypassBtn.addEventListener("click", () => {
  const r = rack();
  if (!r || selectedTab == null) return;
  r.masterBypass = !r.masterBypass;
  send({ type: "set-bypass", tabId: selectedTab, bypass: r.masterBypass });
  save(); updateBypassBtn();
});
// reflect current state; when running, the engine is source-of-truth so an
// external (popup) toggle is adopted back into the saved rack.
function updateBypassBtn() {
  const r = rack();
  let on;
  if (engine.running && typeof engine.bypassed === "boolean") {
    on = engine.bypassed;
    if (r && !!r.masterBypass !== on) { r.masterBypass = on; save(); }
  } else on = !!(r && r.masterBypass);
  masterBypassBtn.disabled = !r;
  masterBypassBtn.classList.toggle("on", !!on);
  masterBypassBtn.textContent = on ? "● DSP bypassed" : "Bypass tab";
}

function syncSessions(list) {
  sessions = list || [];
  for (const se of sessions) {
    if (!racks[se.tabId]) racks[se.tabId] = cloneRack(template);
    // The engine starts as a pass-through and only learns the rack when we push
    // it. engine-ready does that, but if it raced or fired before this editor
    // was open, per-param edits silently no-op engine-side (the module doesn't
    // exist there) until a structural change resends everything. Reconcile once
    // per session here so the chain is live as soon as we observe the session.
    if (!syncedTabs.has(se.tabId)) {
      syncedTabs.add(se.tabId);
      pushStructure(se.tabId);
      send({ type: "set-bypass", tabId: se.tabId, bypass: !!racks[se.tabId].masterBypass });
    }
  }
  const ids = sessions.map((s) => s.tabId);
  // forget sessions that ended, so a re-captured tab re-syncs from scratch
  for (const id of [...syncedTabs]) if (!ids.includes(id)) syncedTabs.delete(id);
  if (selectedTab == null || !ids.includes(selectedTab)) selectedTab = ids.length ? ids[0] : null;

  const sw = sessions.map((s) => s.tabId + ":" + s.title).join("|") + "#" + selectedTab;
  if (sw !== sigSwitcher) { sigSwitcher = sw; renderSwitcher(); }
  if (selectedTab !== sigView) { sigView = selectedTab; renderRack(); renderEditor(); }
}

function tick() {
  if (document.hidden) { looping = false; return; } // stop entirely when tab is hidden -> no CPU
  chrome.runtime.sendMessage({ target: "offscreen", type: "poll", tabId: selectedTab })
    .then((res) => { engine = res && res.running ? res : { running: false }; syncSessions(res ? res.sessions : []); })
    .catch(() => { engine = { running: false }; syncSessions([]); });
  statusEl.classList.toggle("live", engine.running);
  if (engine.running) {
    const r = rack();
    // look-ahead limiters are the only modules that add deliberate latency
    const la = r ? r.modules.reduce((a, mm) => a + (mm.type === "limiter" && !mm.bypass ? (mm.lookahead || 0) : 0), 0) : 0;
    let silent = false; // when the analyzer tap is live we can tell if there's actually audio
    if (specOn && Array.isArray(engine.last)) { let mx = -200; for (const v of engine.last) if (v > mx) mx = v; silent = mx < -88; }
    statusEl.classList.toggle("nosignal", silent);
    statusText.textContent = silent ? "Engine live · no signal - is audio playing?" : `Engine live · ~${((engine.latency || 0) + la).toFixed(1)} ms latency`;
  } else { statusEl.classList.remove("nosignal"); statusText.textContent = sessions.length ? "Select a tab above" : "Engine idle - Start from the popup"; }
  updateBypassBtn();
  updateSpecActive();
  // A throw here must NOT stop the loop, or one bad frame freezes everything.
  try { if (currentDraw) currentDraw(); } catch (e) { console.error("draw error", e); }
  requestAnimationFrame(tick);
}
function startLoop() { if (looping) return; looping = true; requestAnimationFrame(tick); }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (specTab != null) { send({ type: "spec-active", tabId: specTab, active: false }); specOn = false; }
  } else startLoop();
});

// ---------- boot ----------
(async function init() {
  await load();
  renderPresets();
  renderSwitcher();
  renderRack();
  renderEditor();
  startLoop();
})();
