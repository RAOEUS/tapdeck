// Single source of truth for the module list. PURE DATA (no DOM, no editor deps)
// so it can be loaded by the offscreen document, the editor page, and the Node
// test harness alike. Adding a module = one entry here + one worklet file + a
// defaults()/params()/render() (in editor.js). Everything else - the engine's
// worklet table, the rack tags, the add-module menu, the editor dispatch - is
// derived from this list.
//
// Fields: type (unique id), name (default display name), tag (rack chip),
//   worklet (path, null = no audio node), proc (registerProcessor name),
//   node (has an AudioWorkletNode in the graph), group + desc (add-menu).
(function (root) {
  const MODULES = [
    { type: "eq",       name: "EQ",         tag: "EQ",       worklet: "worklet/eq-processor.js",       proc: "eq-processor",       node: true,  group: "Tone",             desc: "shape the frequency balance" },
    { type: "sat",      name: "Saturator",  tag: "Sat",      worklet: "worklet/sat-processor.js",      proc: "sat-processor",      node: true,  group: "Tone",             desc: "add harmonics & warmth" },
    { type: "trans",    name: "Transient",  tag: "Trans",    worklet: "worklet/trans-processor.js",    proc: "trans-processor",    node: true,  group: "Tone",             desc: "shape punch & sustain" },
    { type: "comp",     name: "Compressor", tag: "Comp",     worklet: "worklet/comp-processor.js",     proc: "comp-processor",     node: true,  group: "Dynamics",         desc: "even out the level" },
    { type: "mbcomp",   name: "Multiband",  tag: "MBand",    worklet: "worklet/mbcomp-processor.js",   proc: "mbcomp-processor",   node: true,  group: "Dynamics",         desc: "compress per frequency band" },
    { type: "gate",     name: "Gate",       tag: "Gate",     worklet: "worklet/gate-processor.js",     proc: "gate-processor",     node: true,  group: "Dynamics",         desc: "cut noise & bleed below a threshold" },
    { type: "autogain", name: "Auto Gain",  tag: "AutoGain", worklet: "worklet/autogain-processor.js", proc: "autogain-processor", node: true,  group: "Dynamics",         desc: "even out loudness across content" },
    { type: "limiter",  name: "Limiter",    tag: "Limiter",  worklet: "worklet/limiter-processor.js",  proc: "limiter-processor",  node: true,  group: "Dynamics",         desc: "brick-wall the peaks / ceiling" },
    { type: "utility",  name: "Utility",    tag: "Util",     worklet: "worklet/utility-processor.js",  proc: "utility-processor",  node: true,  group: "Stereo & cleanup", desc: "gain, pan, width, mono, crossfeed" },
    { type: "denoise",  name: "Denoise",    tag: "Denoise",  worklet: "worklet/denoise-processor.js",  proc: "denoise-processor",  node: true,  group: "Stereo & cleanup", desc: "reduce steady hiss & hum" },
    { type: "dereverb", name: "De-reverb",  tag: "Dereverb", worklet: "worklet/dereverb-processor.js", proc: "dereverb-processor", node: true,  group: "Stereo & cleanup", desc: "tame room reverb & tails" },
    { type: "analyzer", name: "Analyzer",   tag: "Scope",    worklet: null,                            proc: null,                 node: false, group: "Analysis",         desc: "multi-resolution spectrogram" },
  ];
  // add-menu group order (groups not listed fall to the end)
  const GROUPS = ["Tone", "Dynamics", "Stereo & cleanup", "Analysis"];
  const byType = Object.fromEntries(MODULES.map((m) => [m.type, m]));

  root.TAPDECK_MODULES = MODULES;
  root.TAPDECK_MODULE_GROUPS = GROUPS;
  root.TAPDECK_MODULE_BY_TYPE = byType;
})(typeof globalThis !== "undefined" ? globalThis : self);
