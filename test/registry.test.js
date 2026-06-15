"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadRegistry, loadWorklet, ROOT } = require("./harness");

const { modules, groups, byType } = loadRegistry();

test("registry is internally consistent", () => {
  assert.ok(Array.isArray(modules) && modules.length > 0);
  const types = modules.map((m) => m.type);
  assert.equal(new Set(types).size, types.length, "module types must be unique");
  for (const m of modules) {
    assert.ok(m.type && m.name && m.tag, `module needs type/name/tag: ${JSON.stringify(m)}`);
    assert.ok(groups.includes(m.group), `${m.type} group "${m.group}" must be in GROUPS`);
    assert.equal(byType[m.type], m, "byType index must match");
    assert.equal(typeof m.node, "boolean");
  }
});

test("every audio module points at a worklet file that registers its processor name", () => {
  for (const m of modules) {
    if (!m.node) { assert.equal(m.worklet, null, `${m.type} is nodeless so worklet must be null`); continue; }
    assert.ok(m.worklet && m.proc, `${m.type} needs worklet + proc`);
    assert.ok(fs.existsSync(path.join(ROOT, m.worklet)), `${m.worklet} must exist`);
    const { name } = loadWorklet(path.basename(m.worklet));
    assert.equal(name, m.proc, `${m.worklet} registers "${name}", registry says "${m.proc}"`);
  }
});

test("registry covers exactly the worklet processors in the repo (plus the spectrum tap)", () => {
  const onDisk = fs.readdirSync(path.join(ROOT, "worklet")).filter((f) => f.endsWith("-processor.js"));
  const registered = modules.filter((m) => m.node).map((m) => path.basename(m.worklet));
  for (const f of onDisk) {
    if (f === "spectrum-processor.js") continue; // the always-on analyzer tap, not a rack module
    assert.ok(registered.includes(f), `${f} exists but isn't in the registry`);
  }
});
