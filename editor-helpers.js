// editor-helpers.js - view-layer toolkit shared by the renderers, loaded BEFORE
// editor-renderers.js and editor.js (see editor.html). Pure declarations + data:
// shared constants, AutoEQ/headphone parsing + browser, colormaps, the canvas
// sizing helper, the knob/select/check control builders, and the 2D draw helpers.
// References to core state/functions resolve at call time (core loads last).
// Full-page rack UI. Owns the source-of-truth state; pushes structure + params
// to the offscreen engine and polls it for spectrum + GR meters every frame.

const FREQ_MIN = 20, FREQ_MAX = 20000;
const BAND_COLORS = ["#36a3ff", "#ffb454", "#3ad07a", "#e5564b", "#b78bff", "#46d6d6", "#ff7ab6", "#c2cf3a"];
const EQ_SHAPES = ["peaking", "lowshelf", "highshelf", "lowpass", "highpass", "bandpass", "notch", "allpass"];
const EQ_GMAX = 36; // max band gain (matches the largest graph range); drag is bounded by the visible range
// mirror of the worklet's section expansion so the drawn curve matches the audio:
// low/high-pass bands become an N/2-section Butterworth cascade for steeper slopes.
function eqButterQs(order) { const qs = []; for (let k = 0; k < order / 2; k++) qs.push(1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order)))); return qs; }
function eqSections(b) {
  if (b.type === "lowpass" || b.type === "highpass") {
    const order = clamp(Math.round((b.slope || 12) / 6), 2, 8);
    if (order <= 2) return [{ type: b.type, freq: b.freq, q: b.q, gain: 0 }];
    return eqButterQs(order).map((q) => ({ type: b.type, freq: b.freq, q, gain: 0 }));
  }
  return [{ type: b.type, freq: b.freq, q: b.q, gain: b.gain || 0 }];
}

// AutoEQ / Equalizer APO filter codes -> our biquad shapes
const AUTOEQ_TYPES = {
  PK: "peaking", PEQ: "peaking",
  LS: "lowshelf", LSC: "lowshelf", LOWSHELF: "lowshelf",
  HS: "highshelf", HSC: "highshelf", HIGHSHELF: "highshelf",
  LP: "lowpass", LPQ: "lowpass", HP: "highpass", HPQ: "highpass",
  BP: "bandpass", NO: "notch", NOTCH: "notch", AP: "allpass",
};
// Parse an AutoEQ "ParametricEQ.txt" (a.k.a. Equalizer APO) export into EQ bands.
// Format: "Preamp: -6.8 dB" + lines like "Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70".
function parseAutoEQ(text) {
  if (/^\s*GraphicEQ\s*:/im.test(text)) return null; // 127-band graphic export isn't parametric
  let preamp = null; const bands = [];
  for (const line of text.split(/\r?\n/)) {
    let mm = line.match(/^\s*Preamp\s*:\s*(-?[\d.]+)\s*dB/i);
    if (mm) { preamp = clamp(parseFloat(mm[1]), -24, 24); continue; }
    mm = line.match(/^\s*Filter\s+\d+\s*:\s*(ON|OFF)\s+([A-Za-z]+)\s+Fc\s+([\d.]+)\s*Hz(?:\s+Gain\s+(-?[\d.]+)\s*dB)?(?:\s+Q\s+([\d.]+))?/i);
    if (!mm) continue;
    const type = AUTOEQ_TYPES[mm[2].toUpperCase()];
    if (!type) continue;
    bands.push({
      id: nid(), type,
      freq: clamp(parseFloat(mm[3]), 20, 20000),
      gain: clamp(mm[4] != null ? parseFloat(mm[4]) : 0, -24, 24),
      q: clamp(mm[5] != null ? parseFloat(mm[5]) : 0.707, 0.1, 18),
      enabled: mm[1].toUpperCase() === "ON",
    });
  }
  return bands.length ? { bands, preamp } : null;
}

// ---------- AutoEq headphone browser (fetches from the AutoEq GitHub repo) ----------
const AUTOEQ_BASE = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/";
const AUTOEQ_INDEX = AUTOEQ_BASE + "results/INDEX.md";
// Parse the big INDEX.md into { n: display name, db: source, p: ParametricEQ.txt path }.
// Each headphone lives in results/<db>/<rig>/<name>/ with a "<name> ParametricEQ.txt".
function parseHpIndex(md) {
  const out = [], seen = new Set(), re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let mt;
  while ((mt = re.exec(md))) {
    let path = mt[2].trim().replace(/^\.?\//, "").replace(/^results\//i, "");
    try { path = decodeURI(path); } catch {} // index links may URL-encode spaces; store the real path
    const folder = /\.md$/i.test(path) ? path.replace(/\/[^/]+\.md$/i, "") : path.replace(/\/+$/, "");
    const segs = folder.split("/");
    if (segs.length < 3) continue; // database / rig / headphone
    const name = segs[segs.length - 1];
    const peq = "results/" + folder + "/" + name + " ParametricEQ.txt";
    if (seen.has(peq)) continue;
    seen.add(peq);
    out.push({ n: (mt[1] || name).trim(), db: segs[0], p: peq });
  }
  return out;
}
async function fetchHpIndex(force) {
  if (!force) {
    try { const d = await chrome.storage.local.get("hpIndex"); if (d.hpIndex && d.hpIndex.list && d.hpIndex.list.length) return d.hpIndex.list; } catch {}
  }
  const res = await fetch(AUTOEQ_INDEX, { cache: "no-cache" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const list = parseHpIndex(await res.text());
  if (!list.length) throw new Error("index empty");
  try { chrome.storage.local.set({ hpIndex: { ts: Date.now(), list } }); } catch {}
  return list;
}
let hpModalEl = null;
function closeHpBrowser() { if (hpModalEl) { hpModalEl.remove(); hpModalEl = null; } }
function openHpBrowser(m) {
  closeHpBrowser();
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  ov.innerHTML = `
    <div class="modal" role="dialog" aria-label="Headphone EQ">
      <div class="modal-head"><h2>Headphone EQ <span class="modal-hint" style="font-weight:400">AutoEq library</span></h2><button class="modal-x" title="Close">✕</button></div>
      <div style="padding:14px 20px 4px"><input id="hpSearch" type="search" placeholder="Search your headphones… (e.g. HD 650, Sundara, AirPods Pro)" autocomplete="off"></div>
      <div class="modal-body" id="hpBody"><p class="preset-none">Loading headphone list…</p></div>
      <div class="modal-foot"><button id="hpRefresh">↻ Refresh list</button><span class="modal-hint">Applies the headphone's correction to this EQ. Fetched on demand from the AutoEq repo - nothing is stored on disk.</span></div>
    </div>`;
  document.body.appendChild(ov);
  hpModalEl = ov;
  ov.querySelector(".modal-x").addEventListener("click", closeHpBrowser);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeHpBrowser(); });
  const body = ov.querySelector("#hpBody"), search = ov.querySelector("#hpSearch");
  let list = [];
  const draw = () => {
    if (!list.length) { body.innerHTML = `<p class="preset-none">List unavailable - try ↻ Refresh.</p>`; return; }
    const q = search.value.trim().toLowerCase();
    const all = q ? list.filter((h) => (h.n + " " + h.db).toLowerCase().includes(q)) : list;
    const shown = all.slice(0, 300);
    if (!shown.length) { body.innerHTML = `<p class="preset-none">No match for “${escapeHtml(search.value.trim())}”.</p>`; return; }
    body.innerHTML = `<div class="hp-list">${shown.map((h, i) => `<button class="hp-item" data-i="${i}"><span class="hp-name">${escapeHtml(h.n)}</span><span class="hp-db">${escapeHtml(h.db)}</span></button>`).join("")}</div>${all.length > shown.length ? `<p class="preset-none">Showing ${shown.length} of ${all.length} - keep typing to narrow.</p>` : ""}`;
    body.querySelectorAll(".hp-item").forEach((el) => el.addEventListener("click", () => applyHp(m, shown[+el.dataset.i])));
  };
  search.addEventListener("input", draw);
  ov.querySelector("#hpRefresh").addEventListener("click", async () => {
    body.innerHTML = `<p class="preset-none">Refreshing…</p>`;
    try { list = await fetchHpIndex(true); toast(`Loaded ${list.length} headphones`); draw(); }
    catch (e) { body.innerHTML = `<p class="preset-none">Couldn't fetch the list (${escapeHtml(String(e.message || e))}).</p>`; }
  });
  fetchHpIndex(false).then((l) => { list = l; draw(); search.focus(); })
    .catch((e) => { body.innerHTML = `<p class="preset-none">Couldn't load the list (${escapeHtml(String(e.message || e))}). Try ↻ Refresh.</p>`; });
}
async function applyHp(m, item) {
  try {
    const url = AUTOEQ_BASE + encodeURI(item.p).replace(/#/g, "%23").replace(/\?/g, "%3F");
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const parsed = parseAutoEQ(await res.text());
    if (!parsed) throw new Error("no parametric filters");
    pushUndo();
    m.bands = parsed.bands;
    if (parsed.preamp != null) m.preamp = parsed.preamp;
    commit();
    closeHpBrowser();
    toast(`Applied ${item.n} · ${parsed.bands.length} bands`);
  } catch (e) { toast("Couldn't apply: " + (e.message || e)); }
}

// Perceptual "magma" colormap -> 256-entry RGB LUT. Monotonic luminance means
// brightness reads directly as intensity (unlike a hue sweep, which reads messy).
function buildLut(stops) {
  const lut = new Uint8Array(256 * 3);
  const seg = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * seg;
    const a = Math.min(seg, Math.floor(p)), f = p - a;
    const c0 = stops[a], c1 = stops[Math.min(seg, a + 1)];
    lut[i * 3] = c0[0] + (c1[0] - c0[0]) * f;
    lut[i * 3 + 1] = c0[1] + (c1[1] - c0[1]) * f;
    lut[i * 3 + 2] = c0[2] + (c1[2] - c0[2]) * f;
  }
  return lut;
}
const COLORMAPS = {
  magma: [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 206, 122], [252, 253, 191]],
  inferno: [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]],
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  ice: [[0, 0, 0], [8, 20, 60], [10, 60, 120], [20, 120, 180], [80, 180, 220], [180, 230, 245], [255, 255, 255]],
  fire: [[0, 0, 0], [60, 0, 0], [140, 10, 0], [220, 70, 0], [255, 160, 20], [255, 235, 130], [255, 255, 255]],
  gray: [[0, 0, 0], [255, 255, 255]],
};
const LUTS = Object.fromEntries(Object.entries(COLORMAPS).map(([k, s]) => [k, buildLut(s)]));
const LOG_MIN = Math.log(FREQ_MIN), LOG_SPAN = Math.log(FREQ_MAX / FREQ_MIN);
// canvas sizing helper: keeps backing store in device pixels
function makeCanvas(canvas, aspect, onResize) {
  let dpr = 1, W = 0, H = 0;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    if (!cssW) return; // not laid out yet
    // when the container is fullscreen, fill it (both dimensions) instead of aspect
    const fs = document.fullscreenElement && document.fullscreenElement.contains(canvas);
    let cssH = fs ? canvas.parentElement.clientHeight : Math.round(cssW * aspect);
    // honour a CSS max-height (set via vertical media queries) so tall graphs can
    // be capped to fit the viewport; the drawing is parametric on W/H, so a shorter
    // canvas simply draws shorter rather than squashing.
    if (!fs) { const mh = parseFloat(getComputedStyle(canvas).maxHeight); if (mh > 0 && cssH > mh) cssH = Math.round(mh); }
    const newW = Math.round(cssW * dpr), newH = Math.round(cssH * dpr);
    if (newW === W && newH === H) return; // no real change -> breaks the ResizeObserver feedback loop
    canvas.style.height = cssH + "px";
    W = canvas.width = newW;
    H = canvas.height = newH;
    if (onResize) onResize(W, H, dpr);
  }
  // Defer to rAF so changing the canvas size inside the observer can't trigger a
  // synchronous re-notification - that's what produces the "ResizeObserver loop"
  // console warning.
  let scheduled = false;
  const ro = new ResizeObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; resize(); });
  });
  ro.observe(canvas);
  resize();
  return () => ({ W, H, dpr });
}

// Consistent module header: title + type tag, then a right-aligned controls
// group (module selects/toggles) always ending in Reset. `controls` is optional
// HTML for the module's own selects/toggles.
function edHead(title, tag, controls) {
  return `<div class="ed-head"><h1 id="edTitle" title="${escapeHtml(title)} - double-click to rename">${escapeHtml(title)}</h1><span class="tag">${tag}</span>` +
    `<div class="ed-controls">${controls || ""}<button class="ed-reset" id="resetMod" title="Reset to defaults">Reset</button></div></div>`;
}

function drawSpecAxis(ctx, W, H, dpr, fLo, fHi) {
  ctx.font = `${10 * dpr}px system-ui`;
  ctx.textBaseline = "bottom";
  const logLo = Math.log(fLo), logSpan = Math.log(fHi / fLo);
  [20, 30, 50, 80, 100, 150, 200, 300, 500, 800, 1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000].forEach((f) => {
    if (f < fLo || f > fHi) return;
    const y = (H - 1) * (1 - (Math.log(f) - logLo) / logSpan);
    ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    const label = f >= 1000 ? f / 1000 + "k" : f + "";
    ctx.fillStyle = "rgba(10,12,16,0.7)"; ctx.fillRect(3 * dpr, y - 13 * dpr, ctx.measureText(label).width + 6 * dpr, 13 * dpr);
    ctx.fillStyle = "rgba(220,228,240,0.85)"; ctx.fillText(label, 6 * dpr, y - 1);
  });
}

// ---------- knob helpers ----------
// trim a value for display: integers stay bare, everything else caps at 2 decimals
function fmtKnob(v) { return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100); }
function knob(key, label, val, min, max, step, unit) {
  return `<div class="knob"><label>${label}<span class="val" id="v_${key}" data-unit="${unit}">${fmtKnob(val)}${unit}</span></label>
    <input type="range" id="k_${key}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`;
}
function knobInline(key, label, val, min, max, step, unit) {
  return `<label class="inlineknob">${label} <input type="range" id="k_${key}" min="${min}" max="${max}" step="${step}" value="${val}">
    <span class="val" id="v_${key}" data-unit="${unit}">${fmtKnob(val)}${unit}</span></label>`;
}
function selectCtl(key, label, val, options) {
  return `<label class="inlineknob">${label} <select id="s_${key}">${options.map((o) => `<option ${o === val ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
}
function checkCtl(key, label, val) {
  return `<label class="inlineknob">${label} <input type="checkbox" id="c_${key}" ${val ? "checked" : ""}></label>`;
}
// partial=true pushes ONLY the changed key (avoids reposting structural arrays -
// e.g. the multiband Dry/Wet knob shouldn't resend bands[] and rebuild crossovers)
function wireKnobs(m, keys, partial) {
  keys.forEach((key) => {
    const input = document.getElementById("k_" + key);
    const out = document.getElementById("v_" + key);
    const unit = out.dataset.unit || "";
    input.addEventListener("input", () => {
      m[key] = Number(input.value);
      out.textContent = fmtKnob(m[key]) + unit;
      if (partial && selectedTab != null) send({ type: "set-param", tabId: selectedTab, id: m.id, params: { [key]: m[key] } });
      else pushParam(m);
      save();
    });
  });
}

// ---------- shared drawing ----------
function fmtFreq(f) {
  return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + " kHz" : Math.round(f) + " Hz";
}
// dashed crosshair at (px,py) + a small readout box that flips to stay on-canvas
function drawCursor(ctx, W, H, dpr, px, py, lines) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1 * dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = `${11 * dpr}px system-ui`;
  const padX = 6 * dpr, padY = 5 * dpr, lh = 14 * dpr;
  let tw = 0; for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
  const bw = tw + padX * 2, bh = lines.length * lh + padY * 2 - 2 * dpr;
  let bx = px + 12 * dpr, by = py + 12 * dpr;
  if (bx + bw > W) bx = px - 12 * dpr - bw;
  if (by + bh > H) by = py - 12 * dpr - bh;
  bx = Math.max(2 * dpr, bx); by = Math.max(2 * dpr, by);

  ctx.fillStyle = "rgba(8,10,14,0.88)";
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4 * dpr); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1 * dpr; ctx.stroke();
  ctx.fillStyle = "#e7eaef"; ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + i * lh));
  ctx.restore();
}

function drawGrid(ctx, W, H, range, fToX) {
  const dpr = window.devicePixelRatio || 1;
  ctx.lineWidth = 1; ctx.fillStyle = "#56606e"; ctx.font = `${10 * dpr}px system-ui`;
  [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach((f) => {
    const x = fToX(f);
    ctx.strokeStyle = "#1b222c"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(f >= 1000 ? f / 1000 + "k" : f, x + 3, H - 4);
  });
  for (let db = -range; db <= range; db += range / 2) {
    const y = H / 2 - (db / range) * (H / 2);
    ctx.strokeStyle = db === 0 ? "#2c3744" : "#161d26";
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText((db > 0 ? "+" : "") + db, 3, y - 2);
  }
}
// The spectrum FFT/resolution is a shared per-tab engine setting. The analyzer
// drives it from its own controls (up to 32768), but the EQ/MB background
// overlays want a stable, light setting - otherwise a heavy analyzer FFT bleeds
// in and the overlays get erratic. Each overlay view re-asserts these on draw.
const OVERLAY_FFT = 16384, OVERLAY_Q = 20;
function syncOverlaySpec() {
  if (!engine.running || selectedTab == null) return;
  if (engine.fft && engine.fft !== OVERLAY_FFT) send({ type: "set-fft", tabId: selectedTab, fft: OVERLAY_FFT });
  if (engine.q != null && engine.q !== OVERLAY_Q) send({ type: "set-q", tabId: selectedTab, q: OVERLAY_Q });
}

// per-view temporal smoother for the EQ/MB analyzer overlay: jump up to peaks
// instantly, ease back down - turns the raw, jittery column into a calm trace.
function makeSpecSmoother() {
  let sm = null;
  return (s) => {
    if (!s || s.length < 2) return s;
    if (!sm || sm.length !== s.length) { sm = Float32Array.from(s); return sm; }
    for (let i = 0; i < s.length; i++) { const v = s[i]; sm[i] = v > sm[i] ? v : sm[i] + (v - sm[i]) * 0.22; }
    return sm;
  };
}
function drawSpectrum(ctx, W, H, s) {
  // s is a log-spaced dB column over [FREQ_MIN, FREQ_MAX]; index maps linearly to x.
  const n = s.length;
  if (n < 2) return; // a degenerate single-point column has no x-axis to map
  const specY = (db) => H - ((clamp(db, -100, -10) + 100) / 90) * H;
  ctx.beginPath(); ctx.moveTo(0, H);
  for (let k = 0; k < n; k++) ctx.lineTo((k / (n - 1)) * W, specY(s[k]));
  ctx.lineTo(W, H); ctx.closePath();
  ctx.fillStyle = "rgba(54,163,255,0.12)"; ctx.fill();
  ctx.strokeStyle = "rgba(54,163,255,0.35)"; ctx.lineWidth = 1; ctx.stroke();
}
