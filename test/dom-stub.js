"use strict";
// A deliberately permissive DOM / chrome / window stub, enough to LOAD the editor
// page scripts and run their top-level wiring + every render function without a
// browser. It does not model layout or events - the goal is to catch load-order
// bugs, ReferenceErrors and TypeErrors (the failure modes of splitting editor.js),
// not to verify pixels. Every element is a callable Proxy so arbitrary DOM chains
// resolve to no-ops; a few props are special-cased so common patterns terminate
// (parentNode -> null stops walk-up loops; querySelectorAll -> [] so .forEach runs).
const RECT = { left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150, x: 0, y: 0 };

function makeEl() {
  const dataset = {};
  const fn = function () {};
  const el = new Proxy(fn, {
    apply() { return makeEl(); },
    set() { return true; },
    get(_t, prop) {
      switch (prop) {
        case "dataset": return dataset;
        case "style": case "classList": case "firstElementChild": return makeEl();
        case "parentNode": case "parentElement": case "nextSibling":
        case "previousSibling": case "firstChild": case "lastChild": case "offsetParent":
          return null;
        case "querySelectorAll": return () => [];
        case "getContext": return () => makeEl();
        case "getBoundingClientRect": return () => RECT;
        case "value": case "innerHTML": case "textContent": case "className":
        case "id": case "type": case "tagName": return "";
        case "checked": case "hidden": case "disabled": return false;
        case "children": case "childNodes": case "files": case "options":
        case "selectedOptions": return [];
        case "length": case "width": case "height": case "offsetWidth":
        case "offsetHeight": case "clientWidth": case "clientHeight":
        case "scrollWidth": case "scrollHeight": case "selectedIndex":
        case "naturalWidth": case "naturalHeight": return 0;
        case Symbol.iterator: return function* () {};
        case Symbol.toPrimitive: return () => "";
        case "then": return undefined; // never look like a thenable
        default: return makeEl();
      }
    },
  });
  return el;
}

function makeDocument() {
  const d = makeEl();
  return new Proxy(d, {
    get(_t, prop) {
      switch (prop) {
        case "getElementById": case "createElement": case "createElementNS":
        case "querySelector": case "createTextNode": case "importNode":
          return () => makeEl();
        case "querySelectorAll": return () => [];
        case "addEventListener": case "removeEventListener": return () => {};
        case "body": case "head": case "documentElement": return makeEl();
        case "hidden": return false;
        case "readyState": return "complete";
        default: return makeEl();
      }
    },
  });
}

// Build a vm-ready global object. `window` is the global itself (so dsp-math.js's
// `window.DSP = ...` lands as a real global the editor reads bare), mirroring the
// browser where window === globalThis.
function makeContext() {
  const storage = {};
  const ctx = {
    console, Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp,
    Set, Map, WeakMap, Symbol, Promise, parseInt, parseFloat, isNaN, isFinite,
    Float32Array, Uint8Array, Uint32Array, Int16Array, ArrayBuffer,
    setTimeout: (f) => { return 0; }, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    queueMicrotask: (f) => Promise.resolve().then(f),
    performance: { now: () => 0 },
    devicePixelRatio: 1,
    Event: class { constructor(t) { this.type = t; } },
    CustomEvent: class { constructor(t) { this.type = t; } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Image: class { constructor() { this.width = 0; this.height = 0; } },
    getComputedStyle: () => makeEl(),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    fetch: () => Promise.resolve({ ok: false, status: 0, text: () => Promise.resolve(""), json: () => Promise.resolve({}) }),
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
    location: { href: "", reload() {} },
    navigator: { userAgent: "node", clipboard: { writeText: () => Promise.resolve() } },
    addEventListener: () => {}, removeEventListener: () => {},
    alert: () => {}, confirm: () => true, prompt: () => "",
    document: makeDocument(),
    chrome: {
      runtime: { sendMessage: () => {}, onMessage: { addListener() {}, removeListener() {} }, lastError: null, getURL: (p) => p },
      storage: {
        local: {
          get: (keys, cb) => { const r = {}; if (typeof cb === "function") { cb(r); return; } return Promise.resolve(r); },
          set: (obj, cb) => { Object.assign(storage, obj); if (typeof cb === "function") cb(); return Promise.resolve(); },
          remove: (k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
        },
      },
      tabs: { query: (q, cb) => { if (typeof cb === "function") cb([]); return Promise.resolve([]); }, onRemoved: { addListener() {} } },
    },
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  return ctx;
}

module.exports = { makeContext, makeEl };
