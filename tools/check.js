"use strict";
// Syntax-check every shipped JS file (used by `npm run check` and CI).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const files = ["editor.js", "editor-helpers.js", "editor-renderers.js", "dsp-math.js", "background.js", "popup.js", "offscreen.js", "module-registry.js"]
  .concat(fs.readdirSync(path.join(ROOT, "worklet")).filter((f) => f.endsWith(".js")).map((f) => "worklet/" + f));

let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" }); console.log("ok   " + f); }
  catch (e) { failed++; console.error("FAIL " + f + "\n" + (e.stderr ? e.stderr.toString() : e.message)); }
}
if (failed) { console.error(`\n${failed} file(s) failed syntax check`); process.exit(1); }
console.log(`\nAll ${files.length} files OK`);
