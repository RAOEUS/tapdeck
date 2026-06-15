"use strict";
// Loads the editor page scripts into a DOM stub and drives every module's render
// function. This is the only Node coverage for editor.js: it catches load-order
// bugs (a symbol used before the script that defines it ran), ReferenceErrors, and
// any render path that throws against a default module. It does NOT check layout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { makeContext } = require("./dom-stub");
const { ROOT } = require("./harness");

// The editor's page scripts, in the exact order editor.html loads them. Keep this
// in sync with editor.html (the registry + dsp-math first, then the editor parts).
const SCRIPTS = ["module-registry.js", "dsp-math.js", "editor-helpers.js", "editor-renderers.js", "editor.js"];

// A test-only shim appended to the last script: it exposes the lexically-scoped
// state/dispatch so the test can drive renderEditor for each module type.
const SHIM = `
;globalThis.__T = {
  types: TAPDECK_MODULES.map((m) => m.type),
  RENDERERS,
  driveEditor(type) {
    const m = defaultModule(type);
    racks = { t: { modules: [m], selected: m.id } };
    selectedTab = "t";
    engine = { running: true, meters: {}, analysis: {}, tp: {}, lufs: {}, sessions: [] };
    renderEditor();
    return m;
  },
};`;

function loadEditor() {
  const ctx = makeContext();
  vm.createContext(ctx);
  SCRIPTS.forEach((rel, i) => {
    let code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (i === SCRIPTS.length - 1) code += SHIM;
    vm.runInContext(code, ctx, { filename: rel });
  });
  return ctx;
}

test("all editor scripts load (top-level wiring runs without throwing)", () => {
  assert.doesNotThrow(loadEditor, "loading the editor page scripts must not throw");
});

test("every registry module has a renderer and renders without throwing", () => {
  const ctx = loadEditor();
  const T = ctx.__T;
  assert.ok(T && Array.isArray(T.types) && T.types.length > 0, "shim should expose module types");
  for (const type of T.types) {
    assert.equal(typeof T.RENDERERS[type], "function", `module "${type}" must have a renderer fn`);
    assert.doesNotThrow(() => T.driveEditor(type), `renderEditor("${type}") threw`);
  }
});
