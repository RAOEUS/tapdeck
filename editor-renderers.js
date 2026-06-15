// editor-renderers.js - one render<Module>() per module type, loaded AFTER
// editor-helpers.js and BEFORE editor.js. These are pure function declarations
// dispatched by RENDERERS (in editor.js); they call helpers + core state/functions
// at run time, so load order only requires them to exist before renderEditor runs.

// ===================== EQ =====================
function renderEQ(m) {
  m.sel = (m.sel != null && m.sel < m.bands.length) ? m.sel : 0;
  m.mix = m.mix ?? 100;
  m.chMode = m.chMode || "stereo";
  const chModeSel = `<label class="detsel" title="Apply the EQ to the whole stereo image, the Mid (centre / mono) only, or the Side (stereo difference) only.">Process <select id="eqChMode">${[["stereo", "Stereo"], ["mid", "Mid"], ["side", "Side"]].map(([v, l]) => `<option value="${v}" ${m.chMode === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
  edEl.innerHTML = `
    ${edHead(m.name, "Parametric EQ", `${chModeSel}<button id="eqSolo" class="ed-toggle" title="Solo the selected band - hear exactly the change it makes (the band, phase-cancelled against the dry signal)">Solo band</button>`)}
    <div class="graphwrap"><canvas id="eqCanvas"></canvas></div>
    <div class="toolbar">
      <label>Range <select id="eqRange"><option>12</option><option selected>24</option><option>36</option></select> dB</label>
      <label>Preamp <input type="number" id="eqPreamp" value="${(m.preamp || 0).toFixed(1)}" step="0.5" min="-24" max="24" style="width:62px"> dB</label>
      <label title="Dry/Wet: scales every bell/shelf band's gain toward flat - phase-coherent, no comb filtering">Dry/Wet <input type="number" id="eqMix" value="${m.mix ?? 100}" step="1" min="0" max="100" style="width:58px"> %</label>
      <button class="primary" id="addBand">+ Add band</button>
      <button id="eqHeadphone" title="Search AutoEq for your headphones and apply their correction curve">🎧 Headphone EQ</button>
      <button id="eqImport" title="Import a ParametricEQ .txt file from disk (AutoEq export format). Use 🎧 Headphone EQ to fetch one automatically.">Import .txt</button>
      <input type="file" id="eqFile" accept=".txt,text/plain" style="display:none">
      <span class="hint">drag = freq/gain · alt-drag/wheel = Q · ctrl+alt-drag = dyn range · dbl-click = add · right-click = menu</span>
    </div>
    <table class="bands"><thead><tr>
      <th></th><th>On</th><th>Shape</th><th>Freq (Hz)</th><th>Gain (dB)</th><th>Q</th><th>Dyn</th><th></th>
    </tr></thead><tbody id="bandRows"></tbody></table>
    <div id="eqDyn" class="eq-dyn"></div>`;

  let range = 24;
  const canvas = document.getElementById("eqCanvas");
  const dims = makeCanvas(canvas, 0.42);
  const ctx = canvas.getContext("2d");
  document.getElementById("eqRange").addEventListener("change", (e) => { range = Number(e.target.value); });
  document.getElementById("addBand").addEventListener("click", () => {
    m.bands.push({ id: nid(), type: "peaking", freq: 1000, gain: 0, q: 1, enabled: true }); commit();
  });
  // Solo (momentary, not persisted): the worklet plays only the selected band's
  // change, captured live from the cascade (so it includes dynamic-EQ movement).
  // We just send the band id; ongoing freq/gain/dyn edits flow via the normal
  // bands sync, so no extra resync is needed.
  let soloOn = false;
  function pushSolo() {
    const b = m.bands[m.sel];
    send({ type: "set-param", tabId: selectedTab, id: m.id, params: { soloId: (soloOn && b) ? b.id : null } });
  }
  const soloBtn = document.getElementById("eqSolo");
  soloBtn.addEventListener("click", () => { soloOn = !soloOn; soloBtn.classList.toggle("on", soloOn); pushSolo(); });
  pushSolo(); // clear any stale solo in the worklet on (re)entry
  document.getElementById("eqChMode").addEventListener("change", (e) => { m.chMode = e.target.value; pushParam(m); save(); });
  const preampEl = document.getElementById("eqPreamp");
  preampEl.addEventListener("input", () => { if (preampEl.value === "") return; m.preamp = clamp(+preampEl.value, -24, 24); pushParam(m); save(); });
  const mixEl = document.getElementById("eqMix");
  mixEl.addEventListener("input", () => { if (mixEl.value === "") return; m.mix = clamp(+mixEl.value, 0, 100); pushParam(m); save(); });
  document.getElementById("eqHeadphone").addEventListener("click", () => openHpBrowser(m));
  const fileEl = document.getElementById("eqFile");
  document.getElementById("eqImport").addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    let parsed = null;
    try { parsed = parseAutoEQ(await f.text()); } catch {}
    fileEl.value = "";
    if (!parsed) { alert("Couldn't read any filters. Use AutoEQ's \"ParametricEQ.txt\" export (the GraphicEQ format isn't supported)."); return; }
    pushUndo();
    m.bands = parsed.bands;
    if (parsed.preamp != null) m.preamp = parsed.preamp;
    commit();
    toast(`Imported ${parsed.bands.length} bands${parsed.preamp != null ? ` · preamp ${parsed.preamp} dB` : ""}`);
  });

  const rows = document.getElementById("bandRows");
  function renderRows() {
    if (m.sel >= m.bands.length) m.sel = m.bands.length - 1;
    if (m.sel < 0) m.sel = 0;
    rows.innerHTML = "";
    m.bands.forEach((b, i) => {
      const isPass = b.type === "lowpass" || b.type === "highpass";
      const slope = b.slope || 12;
      const dynOn = b.dynMode && b.dynMode !== "off";
      const tr = document.createElement("tr");
      tr.className = i === m.sel ? "sel" : "";
      tr.innerHTML = `
        <td><span class="swatch" style="background:${BAND_COLORS[i % BAND_COLORS.length]}"></span></td>
        <td><input type="checkbox" class="en" ${b.enabled ? "checked" : ""}></td>
        <td><select class="sh">${EQ_SHAPES.map((s) => `<option ${s === b.type ? "selected" : ""}>${s}</option>`).join("")}</select></td>
        <td><input type="number" class="f" value="${Math.round(b.freq)}" min="20" max="20000"></td>
        <td>${isPass
          ? `<select class="slope" title="Filter steepness">${[12, 24, 36, 48].map((s) => `<option value="${s}" ${slope === s ? "selected" : ""}>${s} dB/oct</option>`).join("")}</select>`
          : `<input type="number" class="g" value="${b.gain.toFixed(1)}" step="0.5" min="-${EQ_GMAX}" max="${EQ_GMAX}" ${DSP.GAIN_TYPES.has(b.type) ? "" : "disabled"}>`}</td>
        <td><input type="number" class="q" value="${b.q.toFixed(2)}" step="0.1" min="0.1" max="18" ${isPass && slope > 12 ? "disabled title='Butterworth slope - flat, no resonance'" : ""}></td>
        <td><button class="dynbtn ${dynOn ? "on" : ""}" title="Edit this band's dynamics">${dynOn ? "⚡" : "·"}</button></td>
        <td><button class="del">✕</button></td>`;
      tr.querySelector(".en").addEventListener("change", (e) => { b.enabled = e.target.checked; pushParam(m); save(); });
      tr.querySelector(".sh").addEventListener("change", (e) => { b.type = e.target.value; pushParam(m); renderRows(); save(); });
      tr.querySelector(".f").addEventListener("input", (e) => { if (e.target.value === "") return; b.freq = clamp(+e.target.value, 20, 20000); pushParam(m); save(); });
      const gEl = tr.querySelector(".g");
      if (gEl) gEl.addEventListener("input", (e) => { if (e.target.value === "") return; b.gain = clamp(+e.target.value, -EQ_GMAX, EQ_GMAX); pushParam(m); save(); });
      const slEl = tr.querySelector(".slope");
      if (slEl) slEl.addEventListener("change", (e) => { b.slope = Number(e.target.value); pushParam(m); renderRows(); save(); }); // re-render to toggle Q's disabled state
      tr.querySelector(".q").addEventListener("input", (e) => { if (e.target.value === "") return; b.q = clamp(+e.target.value, 0.1, 18); pushParam(m); save(); });
      tr.querySelector(".dynbtn").addEventListener("click", () => selectBand(i));
      tr.querySelector(".del").addEventListener("click", () => { pushUndo(); m.bands.splice(i, 1); commit(); });
      tr.addEventListener("click", (e) => { if (e.target.closest("input,select,button")) return; selectBand(i); });
      rows.appendChild(tr);
    });
    renderDynPanel();
  }
  function selectBand(i) {
    m.sel = i;
    [...rows.children].forEach((tr, j) => tr.classList.toggle("sel", j === i));
    renderDynPanel();
    if (soloOn) pushSolo(); // solo follows the selected band
  }
  // per-band dynamics (compression) editor for the selected band
  function renderDynPanel() {
    const el = document.getElementById("eqDyn");
    const b = m.bands[m.sel];
    if (!b) { el.innerHTML = ""; return; }
    const mode = b.dynMode || "off";
    if (!DSP.GAIN_TYPES.has(b.type)) {
      el.innerHTML = `<div class="eq-dyn-head"><b>Dynamics</b> · Band ${m.sel + 1}</div><div class="eq-dyn-note">Dynamics work on bell &amp; shelf bands (this one is <b>${b.type}</b>).</div>`;
      return;
    }
    el.innerHTML = `
      <div class="eq-dyn-head"><span class="sw" style="background:${BAND_COLORS[m.sel % BAND_COLORS.length]}"></span><b>Dynamics</b> · Band ${m.sel + 1} <span class="eq-dyn-sub">${fmtFreq(b.freq)}</span>
        <label class="detsel" style="margin-left:auto">Mode <select id="dynMode">
          <option value="off" ${mode === "off" ? "selected" : ""}>Off (static)</option>
          <option value="down" ${mode === "down" ? "selected" : ""}>Cut when loud</option>
          <option value="up" ${mode === "up" ? "selected" : ""}>Boost when loud</option>
          <option value="below" ${mode === "below" ? "selected" : ""}>Lift when quiet</option>
          <option value="ott" ${mode === "ott" ? "selected" : ""}>OTT (cut loud + lift quiet)</option>
        </select></label></div>
      ${mode === "off"
        ? `<div class="eq-dyn-note">Pick a mode to make this band compress - it ducks or lifts only when triggered, and its node rides up/down on the graph.</div>`
        : `<div class="knobs" style="grid-template-columns:repeat(4,1fr)">
            ${knob("dynThr", "Threshold", b.dynThr ?? -30, -80, 0, 1, "dB")}
            ${knob("dynRange", "Range", b.dynRange ?? 6, 0, 24, 0.5, "dB")}
            ${knob("dynAtk", "Attack", b.dynAtk ?? 5, 0.1, 200, 0.5, "ms")}
            ${knob("dynRel", "Release", b.dynRel ?? 100, 5, 1000, 1, "ms")}
          </div>`}`;
    document.getElementById("dynMode").addEventListener("change", (e) => {
      b.dynMode = e.target.value;
      if (b.dynMode !== "off") { b.dynThr = b.dynThr ?? -30; b.dynRange = b.dynRange ?? 6; b.dynAtk = b.dynAtk ?? 5; b.dynRel = b.dynRel ?? 100; }
      pushParam(m); save(); renderRows();
    });
    if (mode !== "off") {
      [["dynThr", -80, 0], ["dynRange", 0, 24], ["dynAtk", 0.1, 200], ["dynRel", 5, 1000]].forEach(([key, lo, hi]) => {
        const input = document.getElementById("k_" + key), out = document.getElementById("v_" + key); if (!input) return;
        const unit = out.dataset.unit || "";
        input.addEventListener("input", () => { b[key] = clamp(Number(input.value), lo, hi); out.textContent = fmtKnob(b[key]) + unit; pushParam(m); save(); });
      });
    }
  }
  renderRows();

  const fToX = (f, W) => (Math.log(f / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN)) * W;
  const xToF = (x, W) => FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, x / W);
  const gToY = (g, H) => H / 2 - (g / range) * (H / 2);
  const yToG = (y, H) => ((H / 2 - y) / (H / 2)) * range;

  // interaction
  let drag = null, dragQ = false, dragRange = false, qStartY = 0, qStartVal = 1, rStartVal = 6, nodeMenuEl = null;
  function bandAt(px, py, W, H, dpr) {
    for (let i = m.bands.length - 1; i >= 0; i--) {
      const b = m.bands[i];
      const hx = fToX(b.freq, W), hy = DSP.GAIN_TYPES.has(b.type) ? gToY(b.gain, H) : H / 2;
      if (Math.hypot(px - hx, py - hy) < 14 * dpr) return i;
    }
    return -1;
  }
  function evtPos(e) {
    const { dpr } = dims();
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
  }
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const { W, H, dpr } = dims();
    const [px, py] = evtPos(e);
    const i = bandAt(px, py, W, H, dpr);
    if (i >= 0) {
      drag = i; const bb = m.bands[i]; const dyn = bb.dynMode && bb.dynMode !== "off";
      dragRange = e.altKey && e.ctrlKey && dyn; // ctrl+alt = dynamic range
      dragQ = e.altKey && !e.ctrlKey;           // alt = Q
      qStartY = py; qStartVal = bb.q; rStartVal = bb.dynRange ?? 6; selectBand(i);
    }
  });
  const onMove = (e) => {
    if (drag == null) return;
    const { W, H } = dims();
    const b = m.bands[drag];
    const [px, py] = evtPos(e);
    if (dragRange) { // ctrl+alt-drag: vertical movement sets the dynamic range (up = more)
      b.dynRange = clamp(rStartVal + (qStartY - py) / (H * 0.5) * 24, 0, 24);
      const rk = document.getElementById("k_dynRange"), rv = document.getElementById("v_dynRange");
      if (rk) { rk.value = b.dynRange; if (rv) rv.textContent = fmtKnob(b.dynRange) + "dB"; }
    } else if (dragQ) { // alt-drag: vertical movement sets Q (drag up = narrower)
      b.q = clamp(qStartVal * Math.exp(-(py - qStartY) / (H * 0.5)), 0.1, 18);
    } else {
      b.freq = clamp(xToF(px, W), 20, 20000);
      // pass filters have no gain axis: vertical drag adjusts Q *relative* to the grab
      // point (same as alt-drag) instead of an absolute map, which jumped on any click.
      if (DSP.GAIN_TYPES.has(b.type)) b.gain = clamp(yToG(py, H), -EQ_GMAX, EQ_GMAX);
      else b.q = clamp(qStartVal * Math.exp(-(py - qStartY) / (H * 0.5)), 0.1, 18);
    }
    pushParam(m);
    // update just the dragged row's fields in place (rebuilding the table here
    // dropped focus/caret and churned the DOM every frame)
    const tr = rows.children[drag];
    if (tr) {
      const f = tr.querySelector(".f"), g = tr.querySelector(".g"), q = tr.querySelector(".q");
      if (f) f.value = Math.round(b.freq);
      if (g) g.value = b.gain.toFixed(1);
      if (q) q.value = b.q.toFixed(2);
    }
  };
  const onUp = () => { if (drag != null) { drag = null; save(); } };
  // hover affordance: show the node is grabbable
  canvas.addEventListener("mousemove", (e) => {
    if (drag != null) { canvas.style.cursor = "grabbing"; return; }
    const { W, H, dpr } = dims(); const [px, py] = evtPos(e);
    canvas.style.cursor = bandAt(px, py, W, H, dpr) >= 0 ? "grab" : "crosshair";
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  viewCleanup = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); closeNodeMenu(); };

  canvas.addEventListener("wheel", (e) => {
    const { W, H, dpr } = dims();
    const [px, py] = evtPos(e);
    const i = bandAt(px, py, W, H, dpr);
    if (i < 0) return;
    e.preventDefault();
    m.bands[i].q = clamp(m.bands[i].q * (e.deltaY < 0 ? 1.1 : 0.9), 0.1, 18);
    pushParam(m); renderRows(); save();
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => {
    const { W, H } = dims();
    const [px, py] = evtPos(e);
    m.bands.push({ id: nid(), type: "peaking", freq: clamp(xToF(px, W), 20, 20000), gain: clamp(yToG(py, H), -EQ_GMAX, EQ_GMAX), q: 1, enabled: true });
    commit();
  });
  canvas.addEventListener("contextmenu", (e) => {
    const { W, H, dpr } = dims();
    const [px, py] = evtPos(e);
    const i = bandAt(px, py, W, H, dpr);
    if (i >= 0) { e.preventDefault(); selectBand(i); showNodeMenu(e.clientX, e.clientY, i); }
  });
  function closeNodeMenu() { if (nodeMenuEl) { nodeMenuEl.remove(); nodeMenuEl = null; } document.removeEventListener("mousedown", onDocDown, true); }
  function onDocDown(e) { if (nodeMenuEl && !nodeMenuEl.contains(e.target)) closeNodeMenu(); }
  function makeMenu(items) {
    const menu = document.createElement("div"); menu.className = "ctxmenu";
    items.forEach((it) => {
      if (it.sep) { const d = document.createElement("div"); d.className = "ctxsep"; menu.appendChild(d); return; }
      const row = document.createElement("div");
      row.className = "ctxitem" + (it.header ? " ctxhead" : "") + (it.danger ? " ctxdanger" : "") + (it.submenu ? " ctxhassub" : "");
      row.appendChild(document.createTextNode(it.label));
      if (it.submenu) {
        const sub = makeMenu(it.submenu); sub.classList.add("ctxsub"); row.appendChild(sub);
        row.addEventListener("mouseenter", () => { // open the flyout toward whichever side has room
          sub.classList.remove("flip", "flipup");
          const r = row.getBoundingClientRect();
          if (r.right + sub.offsetWidth > window.innerWidth - 4) sub.classList.add("flip");
          if (r.top + sub.offsetHeight > window.innerHeight - 4) sub.classList.add("flipup");
        });
      } else if (!it.header) row.addEventListener("click", (ev) => { ev.stopPropagation(); closeNodeMenu(); it.action(); });
      menu.appendChild(row);
    });
    return menu;
  }
  function showNodeMenu(cx, cy, i) {
    closeNodeMenu();
    const b = m.bands[i];
    const reRows = () => { selectBand(i); pushParam(m); save(); renderRows(); };
    const dynItem = (v, l) => ({ label: ((b.dynMode || "off") === v ? "● " : "") + l, action: () => { b.dynMode = v; if (v !== "off") { b.dynThr = b.dynThr ?? -30; b.dynRange = b.dynRange ?? 6; b.dynAtk = b.dynAtk ?? 5; b.dynRel = b.dynRel ?? 100; } reRows(); } });
    const items = [
      { label: `Band ${i + 1} · ${b.type} · ${fmtFreq(b.freq)}`, header: true },
      { label: (b.enabled ? "✓ " : "") + "Enabled", action: () => { b.enabled = !b.enabled; reRows(); } },
      { label: "Shape", submenu: EQ_SHAPES.map((s) => ({ label: (s === b.type ? "● " : "") + s, action: () => { b.type = s; reRows(); } })) },
      { label: "Dynamics", submenu: [dynItem("off", "Off (static)"), dynItem("down", "Cut when loud"), dynItem("up", "Boost when loud"), dynItem("below", "Lift when quiet"), dynItem("ott", "OTT")] },
      { label: "Q width", submenu: [["Wide", 0.4], ["Medium", 1], ["Narrow", 4], ["Surgical", 10]].map(([l, q]) => ({ label: `${l} · Q ${q}`, action: () => { b.q = q; reRows(); } })) },
      { sep: true },
      { label: "Reset gain → 0 dB", action: () => { b.gain = 0; reRows(); } },
      { label: "Flip gain (±)", action: () => { b.gain = -(b.gain || 0); reRows(); } },
      { label: "Duplicate band", action: () => { m.bands.splice(i + 1, 0, { ...b, id: nid() }); commit(); } },
      { sep: true },
      { label: "Delete band", danger: true, action: () => { pushUndo(); m.bands.splice(i, 1); commit(); } },
    ];
    const menu = makeMenu(items);
    menu.style.left = "-9999px"; document.body.appendChild(menu); nodeMenuEl = menu;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(cx, window.innerWidth - mw - 6)) + "px";
    menu.style.top = Math.max(4, Math.min(cy, window.innerHeight - mh - 6)) + "px";
    setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
  }

  let hover = null;
  canvas.addEventListener("mousemove", (e) => { hover = evtPos(e); });
  canvas.addEventListener("mouseleave", () => { hover = null; });

  const smoothSpec = makeSpecSmoother();
  currentDraw = function () {
    syncOverlaySpec(); // keep the overlay on its own light FFT/resolution
    const { W, H, dpr } = dims();
    ctx.clearRect(0, 0, W, H);
    drawGrid(ctx, W, H, range, (f) => fToX(f, W));
    if (engine.running && engine.last) drawSpectrum(ctx, W, H, smoothSpec(engine.last));

    const sr = engine.sampleRate || 48000;
    const meter = (engine.meters && engine.meters[m.id]) || {};
    const mb = engine.running ? (meter.mb || {}) : {}; // keyed by band id (survives disabled bands)
    const dynOf = (i) => { const b = m.bands[i]; return (b.dynMode && b.dynMode !== "off") ? (mb[b.id] || 0) : 0; };
    const mixF = (m.mix ?? 100) * 0.01; // dry/wet scales bell/shelf gains
    // dynamic-EQ regions: a filled bell per dynamic band showing the WIDTH (Q) and
    // depth of its move, coloured by direction (red = cut, green = boost; OTT = both).
    const drawRegion = (b, ext, fill) => {
      const baseC = DSP.designBiquad(b.type, b.freq, b.q, (b.gain || 0) * mixF, sr);
      const extC = DSP.designBiquad(b.type, b.freq, b.q, ((b.gain || 0) + ext) * mixF, sr);
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) { const y = gToY(clamp(DSP.biquadMagDb(extC, xToF(x, W), sr), -range, range), H); x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      for (let x = W; x >= 0; x -= 2) ctx.lineTo(x, gToY(clamp(DSP.biquadMagDb(baseC, xToF(x, W), sr), -range, range), H));
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    };
    const REDF = "rgba(229,86,75,0.16)", GREENF = "rgba(58,208,122,0.16)";
    m.bands.forEach((b) => {
      if (!b.enabled || !DSP.GAIN_TYPES.has(b.type) || !b.dynMode || b.dynMode === "off") return;
      const r = b.dynRange ?? 6;
      if (b.dynMode === "down") drawRegion(b, -r, REDF);
      else if (b.dynMode === "ott") { drawRegion(b, -r, REDF); drawRegion(b, r, GREENF); }
      else drawRegion(b, r, GREENF); // up / below = boost
    });

    // the displayed curve uses static + live dynamic gain, so it animates with the audio
    const coeffs = [];
    m.bands.forEach((b, i) => {
      if (!b.enabled) return;
      if (DSP.GAIN_TYPES.has(b.type)) coeffs.push(DSP.designBiquad(b.type, b.freq, b.q, ((b.gain || 0) + dynOf(i)) * mixF, sr));
      else eqSections(b).forEach((sp) => coeffs.push(DSP.designBiquad(sp.type, sp.freq, sp.q, sp.gain, sr)));
    });
    ctx.beginPath();
    for (let x = 0; x <= W; x++) {
      let dB = 0; const f = xToF(x, W);
      for (const c of coeffs) dB += DSP.biquadMagDb(c, f, sr);
      const y = gToY(dB, H);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#dfe6f0"; ctx.lineWidth = 2 * dpr; ctx.stroke();

    m.bands.forEach((b, i) => {
      const isGain = DSP.GAIN_TYPES.has(b.type);
      const col = b.enabled ? BAND_COLORS[i % BAND_COLORS.length] : "#555";
      const hx = fToX(b.freq, W), hy = isGain ? gToY(b.gain, H) : H / 2;
      if (b.dynMode && b.dynMode !== "off" && isGain) {
        // live dot rides the band's gain with the audio, coloured by direction
        const d = dynOf(i);
        const ly = gToY(clamp((b.gain || 0) + d, -range, range), H);
        ctx.beginPath(); ctx.arc(hx, ly, 4.5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = d < -0.1 ? "#ff7a6e" : d > 0.1 ? "#6ee29a" : "rgba(255,255,255,0.75)"; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(hx, hy, 6 * dpr, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = "#0a0c10"; ctx.lineWidth = 2 * dpr; ctx.stroke();
      if (i === m.sel) { ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.arc(hx, hy, 9.5 * dpr, 0, Math.PI * 2); ctx.stroke(); }
    });

    if (hover) {
      const f = clamp(xToF(hover[0], W), 20, 20000), gdb = yToG(hover[1], H);
      drawCursor(ctx, W, H, dpr, hover[0], hover[1], [fmtFreq(f), (gdb >= 0 ? "+" : "") + gdb.toFixed(1) + " dB"]);
    }
  };
}

// ===================== Compressor =====================
function renderComp(m) {
  m.mode = m.mode || "down"; m.range = m.range ?? 24; m.mix = m.mix ?? 100; m.ratioUp = m.ratioUp ?? m.ratio; m.scHpf = m.scHpf ?? 20; m.autoMakeup = m.autoMakeup ?? false;
  // OTT exposes independent down/up ratios; "Range" becomes the upward depth limit
  const isOtt = m.mode === "ott", upMode = isOtt || m.mode === "up";
  const cKnobs = [
    ["threshold", knob("threshold", "Threshold", m.threshold, -60, 0, 0.5, "dB")],
    ["ratio", knob("ratio", isOtt ? "Down ratio" : "Ratio", m.ratio, 1, 20, 0.1, ":1")],
    ...(isOtt ? [["ratioUp", knob("ratioUp", "Up ratio", m.ratioUp, 1, 20, 0.1, ":1")]] : []),
    ["attack", knob("attack", "Attack", m.attack, 0.1, 200, 0.1, "ms")],
    ["release", knob("release", "Release", m.release, 5, 1000, 1, "ms")],
    ["knee", knob("knee", "Knee", m.knee, 0, 24, 0.5, "dB")],
    ["makeup", knob("makeup", "Makeup", m.makeup, 0, 24, 0.5, "dB")],
    ["range", knob("range", upMode ? "Up depth" : "Range", m.range, 0, 48, 1, "dB")],
    ["mix", knob("mix", "Dry/Wet", m.mix, 0, 100, 1, "%")],
    ["scHpf", knob("scHpf", "SC HPF", m.scHpf, 20, 500, 1, "Hz")],
  ];
  edEl.innerHTML = `
    ${edHead(m.name, "Compressor", `
      <label class="detsel">Mode
        <select id="cmode">
          <option value="down" ${m.mode === "down" ? "selected" : ""}>Downward</option>
          <option value="up" ${m.mode === "up" ? "selected" : ""}>Upward</option>
          <option value="expand" ${m.mode === "expand" ? "selected" : ""}>Expand</option>
          <option value="ott" ${m.mode === "ott" ? "selected" : ""}>OTT (up+down)</option>
        </select>
      </label>
      <label class="detsel">Detect
        <select id="det">
          <option value="feedforward" ${m.detector === "feedforward" ? "selected" : ""}>Feed-forward</option>
          <option value="feedback" ${m.detector === "feedback" ? "selected" : ""}>Feed-back</option>
        </select>
      </label>
      <button id="cAutoMk" class="ed-toggle ${m.autoMakeup ? "on" : ""}" title="Automatically match the output loudness to the input, so toggling/bypassing isn't just 'louder vs quieter'. Overrides the manual Makeup knob.">Auto makeup</button>`)}
    <div class="dyn">
      <div class="graphwrap" title="Transfer curve: input level (x) maps to output level (y). The dot rides the curve at the live level; hover anywhere for a readout. Top strip = gain change over time."><canvas id="compCanvas"></canvas></div>
      <div>
        <div class="meterbox" style="margin-bottom:16px">
          ${m.mode !== "up" ? `<div><div class="meter" style="height:150px"><div class="fill" id="grFill"></div></div><div class="meter-label">GR <span id="grVal">0.0</span></div></div>` : ""}
          ${m.mode === "up" || m.mode === "ott" ? `<div><div class="meter meter-up" style="height:150px"><div class="fill" id="upFill"></div></div><div class="meter-label">Boost <span id="upVal">0.0</span></div></div>` : ""}
        </div>
        <div class="knobs">${cKnobs.map((k) => k[1]).join("")}</div>
      </div>
    </div>
    <div class="det-flow">
      <svg viewBox="0 0 280 106" class="det-svg" aria-hidden="true">
        <defs>
          <marker id="dfFlow" markerWidth="8" markerHeight="8" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#6b7280"/></marker>
          <marker id="dfCtrl" markerWidth="8" markerHeight="8" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#ffb454"/></marker>
          <marker id="dfSense" markerWidth="8" markerHeight="8" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#36a3ff"/></marker>
        </defs>
        <!-- signal path, left to right -->
        <circle cx="20" cy="34" r="3" class="node" /><text x="20" y="19">in</text>
        <line x1="24" y1="34" x2="112" y2="34" class="sigwire" marker-end="url(#dfFlow)" />
        <rect x="116" y="22" width="48" height="24" rx="5" class="box" /><text x="140" y="38" class="boxtxt">GAIN</text>
        <line x1="164" y1="34" x2="258" y2="34" class="sigwire" marker-end="url(#dfFlow)" />
        <circle cx="262" cy="34" r="3" class="node" /><text x="262" y="19">out</text>
        <!-- detector controls the gain stage -->
        <rect x="100" y="82" width="80" height="20" rx="5" class="box" /><text x="140" y="96" class="boxtxt">DETECTOR</text>
        <path d="M140,82 L140,48" class="ctrl" marker-end="url(#dfCtrl)" />
        <!-- single sense tap: moves to input (feed-forward) or output (feed-back) -->
        <circle id="senseDot" cx="72" cy="34" r="2.8" class="sense-dot" />
        <path id="senseTap" class="sense" marker-end="url(#dfSense)" d="M72,34 L72,92 L100,92" />
      </svg>
      <div class="det-text" id="detText"></div>
    </div>`;
  wireKnobs(m, cKnobs.map((k) => k[0]));
  function updateDetFlow() {
    const ff = m.detector !== "feedback";
    const tap = document.getElementById("senseTap"), dot = document.getElementById("senseDot"), txt = document.getElementById("detText");
    if (!tap) return;
    // the sense tap listens before the gain stage (feed-forward) or after it (feed-back)
    if (ff) { tap.setAttribute("d", "M72,34 L72,92 L100,92"); dot.setAttribute("cx", "72"); }
    else { tap.setAttribute("d", "M208,34 L208,92 L180,92"); dot.setAttribute("cx", "208"); }
    txt.innerHTML = ff
      ? `<b>Feed-forward</b> - the detector listens to the signal <b>before</b> the gain stage (the input), then sets the gain. Precise and predictable; the modern default.`
      : `<b>Feed-back</b> - the detector listens <b>after</b> the gain stage (the output) and loops back to set the gain, so it self-regulates into a softer, rounder knee. The classic, vintage character.`;
  }
  updateDetFlow();
  document.getElementById("det").addEventListener("change", (e) => { m.detector = e.target.value; pushParam(m); save(); updateDetFlow(); });
  document.getElementById("cmode").addEventListener("change", (e) => { m.mode = e.target.value; pushParam(m); save(); renderEditor(); }); // full re-render so the preset bar + reset stay wired
  const mkKnob = () => { const k = document.getElementById("k_makeup"); if (!k) return; k.disabled = !!m.autoMakeup; const kn = k.closest(".knob"); if (kn) { kn.classList.toggle("knob-off", !!m.autoMakeup); kn.title = m.autoMakeup ? "Auto makeup is on - the manual Makeup knob is bypassed." : ""; } };
  const amBtn = document.getElementById("cAutoMk");
  amBtn.addEventListener("click", () => { m.autoMakeup = !m.autoMakeup; amBtn.classList.toggle("on", m.autoMakeup); pushParam(m); save(); mkKnob(); });
  mkKnob();

  const canvas = document.getElementById("compCanvas");
  const dims = makeCanvas(canvas, 1);
  const ctx = canvas.getContext("2d");
  const grFill = document.getElementById("grFill");
  const grVal = document.getElementById("grVal");
  const upFill = document.getElementById("upFill");
  const upVal = document.getElementById("upVal");
  let grHold = 0, upHold = 0; // meter ballistics: instant rise, smooth fall (no jitter)

  let hover = null;
  const inHist = new Float32Array(120), outHist = new Float32Array(120), outGR = new Float32Array(120);
  let trail = [];      // recent [inDb, gr] -> fading on-curve dot trail
  let grHist = [];     // recent gr values -> scrolling top strip
  const TRAIL_MAX = 90, GRHIST_MAX = 260;
  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect(); const { dpr } = dims();
    hover = [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
  });
  canvas.addEventListener("mouseleave", () => { hover = null; });
  const grColor = (g) => { const t = clamp(g / 18, 0, 1); return `rgb(255,${Math.round(180 - 120 * t)},${Math.round(84 - 40 * t)})`; };
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  // signed gain (dB) -> colour: slate (untouched) → red (cut) / green (boost)
  const attnColor = (gDb, alpha) => {
    if (gDb < -0.1) { const t = clamp(-gDb / 18, 0, 1); return `rgba(${lerp(96, 229, t)},${lerp(124, 86, t)},${lerp(152, 75, t)},${alpha})`; }
    if (gDb > 0.1) { const t = clamp(gDb / 18, 0, 1); return `rgba(${lerp(96, 58, t)},${lerp(124, 208, t)},${lerp(152, 122, t)},${alpha})`; }
    return `rgba(96,124,152,${alpha})`;
  };

  currentDraw = function () {
    const { W, H, dpr } = dims();
    const map = (db) => (db + 60) / 60; // dB[-60,0] -> 0..1
    const topH = Math.round(H * 0.2), gh = H - topH;       // top strip = GR-over-time
    const X = (db) => map(clamp(db, -60, 0)) * W;
    const Y = (db) => topH + (1 - map(clamp(db, -60, 6))) * gh; // out dB -> y in transfer area
    // dry/wet folds the wet gain toward unity: effective dB for a wet gain of gdb.
    const mixF = (m.mix ?? 100) * 0.01;
    const effDb = (gdb) => 20 * Math.log10(Math.max(1e-6, (1 - mixF) + mixF * Math.pow(10, gdb / 20)));
    const mk = m.autoMakeup ? 0 : m.makeup; // auto-makeup is a dynamic level-match, not part of the static curve
    const curveOut = (inDb) => inDb + effDb(DSP.dynGain(inDb, m.mode, m.threshold, m.ratio, m.knee, m.range, m.ratioUp) + mk);
    const meter = (engine.meters && engine.meters[m.id]) || {};
    const lastGain = meter.gr || 0, egDb = effDb(lastGain), red = Math.max(0, -egDb), boost = Math.max(0, egDb), level = meter.level; // effective cut / boost

    // ingest the fine per-quantum (level, signed-gain) samples since last frame
    if (engine.running && meter.trace) {
      for (const pr of meter.trace) {
        const l = pr[0], g = pr[1]; // g = raw wet signed gain (dB): <0 cut, >0 boost
        trail.push([l, g]); grHist.push(effDb(g)); // signed effective gain (+boost / -cut)
        if (l > -60) inHist[clamp(Math.floor(map(l) * 120), 0, 119)] += 1;
        const ob = clamp(Math.floor(map(clamp(l + effDb(g + mk), -60, 0)) * 120), 0, 119);
        outHist[ob] += 1; outGR[ob] += g; // track the gain that produced each output level
      }
    }
    while (trail.length > TRAIL_MAX) trail.shift();
    while (grHist.length > GRHIST_MAX) grHist.shift();
    for (let i = 0; i < 120; i++) { inHist[i] *= 0.99; outHist[i] *= 0.99; outGR[i] *= 0.99; }

    ctx.clearRect(0, 0, W, H);

    // transfer-area grid
    ctx.strokeStyle = "#1c2430"; ctx.lineWidth = 1 * dpr;
    for (let db = -60; db <= 0; db += 12) {
      const x = X(db); ctx.beginPath(); ctx.moveTo(x, topH); ctx.lineTo(x, H); ctx.stroke();
      const y = Y(db); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // input (bottom) & output (left) level distributions, tinted by the gain applied
    // at each level: slate = untouched, red = cut, green = boost.
    let im = 1e-6, om = 1e-6;
    for (let i = 0; i < 120; i++) { if (inHist[i] > im) im = inHist[i]; if (outHist[i] > om) om = outHist[i]; }

    // input: smooth filled area along the bottom; horizontal gradient = attenuation vs level
    const inGrad = ctx.createLinearGradient(0, 0, W, 0);
    for (let s = 0; s <= 12; s++) {
      const db = -60 + (s / 12) * 60;
      inGrad.addColorStop(s / 12, attnColor(effDb(DSP.dynGain(db, m.mode, m.threshold, m.ratio, m.knee, m.range, m.ratioUp)), 0.5));
    }
    // real input-level distribution (no artificial floor, so it's empty where there's
    // no signal); a thin colour-map strip at the very bottom keeps the attenuation
    // colours visible immediately, before the histogram fills in.
    const inH = (i) => clamp(inHist[Math.min(i, 119)] / im, 0, 1) * gh * 0.5;
    ctx.fillStyle = inGrad; ctx.fillRect(0, H - 3 * dpr, W, 3 * dpr);
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let i = 0; i <= 120; i++) ctx.lineTo((i / 120) * W, H - inH(i));
    ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = inGrad; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) { const x = (i / 120) * W, y = H - inH(i); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.strokeStyle = "rgba(150,185,230,0.55)"; ctx.lineWidth = 1.2 * dpr; ctx.stroke();

    // output: smooth filled area along the left; vertical gradient = attenuation that produced it
    const outW = W * 0.2;
    const outGrad = ctx.createLinearGradient(0, Y(0), 0, Y(-60));
    for (let i = 120; i >= 0; i -= 10) {
      const bi = Math.min(i, 119), db = -60 + (i / 120) * 60;
      const f = clamp((Y(db) - Y(0)) / (Y(-60) - Y(0)), 0, 1);
      outGrad.addColorStop(f, attnColor(outHist[bi] > 1e-6 ? outGR[bi] / outHist[bi] : 0, 0.46));
    }
    ctx.beginPath(); ctx.moveTo(0, Y(0));
    for (let i = 120; i >= 0; i--) ctx.lineTo(clamp(outHist[Math.min(i, 119)] / om, 0, 1) * outW, Y(-60 + (i / 120) * 60));
    ctx.lineTo(0, Y(-60)); ctx.closePath(); ctx.fillStyle = outGrad; ctx.fill();
    ctx.beginPath();
    for (let i = 120; i >= 0; i--) { const x = clamp(outHist[Math.min(i, 119)] / om, 0, 1) * outW, y = Y(-60 + (i / 120) * 60); i === 120 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.strokeStyle = "rgba(150,205,175,0.5)"; ctx.lineWidth = 1.1 * dpr; ctx.stroke();

    // unity + threshold
    ctx.strokeStyle = "#3a4452"; ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(X(-60), Y(-60)); ctx.lineTo(X(0), Y(0)); ctx.stroke();
    const tx = X(m.threshold);
    ctx.strokeStyle = "rgba(255,180,84,0.35)"; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(tx, topH); ctx.lineTo(tx, H); ctx.stroke(); ctx.setLineDash([]);

    // transfer curve (glowing)
    ctx.save(); ctx.shadowColor = "rgba(255,180,84,0.7)"; ctx.shadowBlur = 7 * dpr;
    ctx.beginPath();
    for (let inDb = -60; inDb <= 0; inDb += 0.5) { const x = X(inDb), y = Y(curveOut(inDb)); inDb === -60 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 2.2 * dpr; ctx.stroke();
    ctx.restore();

    // fading trail of recent operating points, riding the curve, tinted by GR
    for (let i = 0; i < trail.length; i++) {
      const l = clamp(trail[i][0], -60, 0), g = trail[i][1], a = i / trail.length;
      ctx.globalAlpha = 0.04 + a * 0.45; ctx.fillStyle = grColor(-effDb(g));
      ctx.beginPath(); ctx.arc(X(l), Y(clamp(curveOut(l), -60, 6)), (1.2 + a * 2) * dpr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // current operating dot - sits ON the curve (aligned at any makeup), with guides
    if (engine.running && typeof level === "number" && level > -60) {
      const inDb = clamp(level, -60, 0), x = X(inDb), y = Y(clamp(curveOut(inDb), -60, 6));
      ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, y); ctx.lineTo(0, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.save(); ctx.shadowColor = "#fff"; ctx.shadowBlur = 10 * dpr;
      ctx.beginPath(); ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.restore();
      ctx.lineWidth = 2 * dpr; ctx.strokeStyle = "#0a0c10"; ctx.beginPath(); ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2); ctx.stroke();
    }

    // gain-over-time strip (top), scrolling right -> left. Centre = unity: cut dips
    // down (red), upward-compression / OTT boost rises up (green).
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, 0, W, topH);
    const cy = topH * 0.5, half = topH * 0.5 - 3 * dpr;
    if (grHist.length > 1) {
      const n = grHist.length, step = W / (GRHIST_MAX - 1);
      const gy = (i) => cy - clamp(grHist[i] / 24, -1, 1) * half; // +boost up, -cut down
      const grad = ctx.createLinearGradient(0, 0, 0, topH);
      grad.addColorStop(0, "rgba(58,208,122,0.34)");
      grad.addColorStop(0.5, "rgba(120,130,150,0.04)");
      grad.addColorStop(1, "rgba(229,86,75,0.34)");
      ctx.beginPath(); ctx.moveTo(W, cy);
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(W - (n - 1 - i) * step, gy(i));
      ctx.lineTo(W - (n - 1) * step, cy); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath();
      for (let i = n - 1; i >= 0; i--) { const x = W - (n - 1 - i) * step; i === n - 1 ? ctx.moveTo(x, gy(i)) : ctx.lineTo(x, gy(i)); }
      ctx.strokeStyle = "rgba(230,236,246,0.7)"; ctx.lineWidth = 1.3 * dpr; ctx.stroke();
    }
    ctx.strokeStyle = "#2a323d"; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
    ctx.font = `${10 * dpr}px system-ui`; ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(120,210,150,0.85)"; ctx.fillText("BOOST " + boost.toFixed(1), 6 * dpr, 3 * dpr);
    ctx.fillStyle = "rgba(255,140,130,0.9)"; ctx.fillText("GR " + red.toFixed(1), 6 * dpr, topH - 14 * dpr);

    // sidebar meters (ballistic: rise instantly, fall smoothly) + hover readout
    grHold = red > grHold ? red : grHold * 0.86 + red * 0.14;
    upHold = boost > upHold ? boost : upHold * 0.86 + boost * 0.14;
    if (grFill) { grFill.style.height = clamp(grHold / 24, 0, 1) * 100 + "%"; grVal.textContent = grHold.toFixed(1); }
    if (upFill) { upFill.style.height = clamp(upHold / 24, 0, 1) * 100 + "%"; upVal.textContent = upHold.toFixed(1); }
    if (hover) {
      const inDb = (hover[0] / W) * 60 - 60, outDb = (1 - (hover[1] - topH) / gh) * 60 - 60;
      drawCursor(ctx, W, H, dpr, hover[0], hover[1], ["in " + inDb.toFixed(1) + " dB", "out " + clamp(outDb, -60, 6).toFixed(1) + " dB"]);
    }
  };
}

// ===================== Limiter =====================
function renderLimiter(m) {
  // backfill older racks/presets
  m.attack = m.attack ?? 0; m.hold = m.hold ?? 5; m.link = m.link ?? 100;
  m.os = m.os ?? 1; m.style = m.style || "transparent"; m.unity = !!m.unity; m.dc = !!m.dc; m.zoom = m.zoom ?? 1000;
  const GRSPAN = 18; // GR meter / display range in dB
  const lKnobs = [
    ["inputGain", knob("inputGain", "Gain", m.inputGain, 0, 24, 0.5, "dB")],
    ["ceiling", knob("ceiling", "Ceiling", m.ceiling, -24, 0, 0.1, "dB")],
    ["attack", knob("attack", "Attack", m.attack, 0, 10, 0.1, "ms")],
    ["release", knob("release", "Release", m.release, 5, 500, 1, "ms")],
    ["hold", knob("hold", "Hold", m.hold, 0, 100, 1, "ms")],
    ["lookahead", knob("lookahead", "Look-ahead", m.lookahead, 0.5, 10, 0.5, "ms")],
    ["link", knob("link", "Link", m.link, 0, 100, 1, "%")],
  ];
  const styleOpts = [["transparent", "Transparent"], ["punchy", "Punchy"], ["smooth", "Smooth"], ["aggressive", "Aggressive"]]
    .map(([v, l]) => `<option value="${v}" ${m.style === v ? "selected" : ""}>${l}</option>`).join("");
  const osOpts = [[1, "Off"], [2, "2×"], [4, "4× (true peak)"]]
    .map(([v, l]) => `<option value="${v}" ${m.os == v ? "selected" : ""}>${l}</option>`).join("");
  edEl.innerHTML = `
    ${edHead(m.name, "Brick-wall limiter", `
      <label class="detsel">Style <select id="limStyle">${styleOpts}</select></label>
      <label class="detsel" title="Oversampled detection catches inter-sample (true) peaks so the reconstructed signal also stays under the ceiling.">Oversampling <select id="limOS">${osOpts}</select></label>`)}
    <div class="dyn">
      <div class="lim-graph" style="flex:1; min-width:0; display:flex; flex-direction:column; gap:8px">
        <div class="graphwrap"><canvas id="limCanvas"></canvas></div>
        <div class="lim-ctl" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap">
          <label class="hint" style="display:flex; align-items:center; gap:8px; flex:1; min-width:160px" title="Time shown across the graph. You can also scroll the wheel over the graph to zoom.">Zoom
            <input type="range" id="limZoom" min="50" max="8000" step="10" value="${m.zoom}" style="flex:1">
            <span id="limZoomV" style="min-width:52px; text-align:right">${m.zoom >= 1000 ? (m.zoom % 1000 ? (m.zoom / 1000).toFixed(1) : m.zoom / 1000) + " s" : m.zoom + " ms"}</span>
          </label>
          <button class="util-tog ${m.unity ? "on" : ""}" id="limUnity" title="Compensate the input Gain at the output so you can A/B the limiting at matched loudness.">Unity gain</button>
          <button class="util-tog ${m.dc ? "on" : ""}" id="limDC" title="High-pass at a few Hz to strip any DC offset / sub-sonic rumble before limiting.">DC filter</button>
        </div>
      </div>
      <div>
        <div class="meterbox" style="margin-bottom:16px">
          <div><div class="meter" style="height:150px"><div class="fill" id="grFill"></div></div><div class="meter-label">GR <span id="grVal">0.0</span><br><span id="grPk" style="opacity:.55;font-size:10px">pk 0.0</span></div></div>
        </div>
        <div class="knobs">${lKnobs.map((k) => k[1]).join("")}</div>
      </div>
    </div>
    <div class="lufs">
      <div class="lufs-title">Loudness <span class="lufs-std">LUFS · ITU-R BS.1770</span> <button id="lufsReset" title="Reset integrated">⟳ reset</button></div>
      <div class="lufs-grid">
        <div class="lufs-cell"><div class="lufs-k">Momentary</div><div class="lufs-v" id="lufsM">-</div></div>
        <div class="lufs-cell"><div class="lufs-k">Short-term</div><div class="lufs-v" id="lufsS">-</div></div>
        <div class="lufs-cell"><div class="lufs-k">Integrated</div><div class="lufs-v" id="lufsI">-</div></div>
        <div class="lufs-cell"><div class="lufs-k">Peak (dBFS)</div><div class="lufs-v" id="lufsPk">-</div></div>
        <div class="lufs-cell"><div class="lufs-k">True peak (dBTP)</div><div class="lufs-v" id="lufsTP">-</div></div>
      </div>
    </div>`;
  wireKnobs(m, lKnobs.map((k) => k[0]));
  const atkKnob = document.getElementById("k_attack");
  if (atkKnob) atkKnob.closest(".knob").title = "0 ms = transparent, overshoot-free brick wall. Higher values let transients breathe (a final clip still holds the ceiling).";
  const lnkKnob = document.getElementById("k_link");
  if (lnkKnob) lnkKnob.closest(".knob").title = "100% = stereo-linked (both channels duck together, image stays put). 0% = independent per-channel limiting (louder, can pull the image).";
  document.getElementById("limStyle").addEventListener("change", (e) => { m.style = e.target.value; pushParam(m); save(); });
  document.getElementById("limOS").addEventListener("change", (e) => { m.os = Number(e.target.value); pushParam(m); save(); });
  const unityBtn = document.getElementById("limUnity");
  unityBtn.addEventListener("click", () => { m.unity = !m.unity; unityBtn.classList.toggle("on", m.unity); pushParam(m); save(); });
  const dcBtn = document.getElementById("limDC");
  dcBtn.addEventListener("click", () => { m.dc = !m.dc; dcBtn.classList.toggle("on", m.dc); pushParam(m); save(); });
  document.getElementById("lufsReset").addEventListener("click", () => send({ type: "set-param", tabId: selectedTab, id: m.id, params: { lufsReset: true } }));

  const canvas = document.getElementById("limCanvas");
  const dims = makeCanvas(canvas, 0.5);
  const ctx = canvas.getContext("2d");
  const grFill = document.getElementById("grFill"), grVal = document.getElementById("grVal"), grPk = document.getElementById("grPk");
  const elM = document.getElementById("lufsM"), elS = document.getElementById("lufsS"), elI = document.getElementById("lufsI"), elPk = document.getElementById("lufsPk"), elTP = document.getElementById("lufsTP");
  const fmtL = (v) => (typeof v === "number" && v > -120 ? v.toFixed(1) : "-");

  // zoom = visible time window (ms) across the canvas width, set by the slider or
  // the scroll wheel. A long rolling buffer lets zoom-out reveal retained history.
  const zoomEl = document.getElementById("limZoom"), zoomV = document.getElementById("limZoomV");
  let zoomMs = m.zoom;
  function setZoom(v) { zoomMs = clamp(Math.round(v), 50, 8000); m.zoom = zoomMs; zoomEl.value = zoomMs; zoomV.textContent = zoomMs >= 1000 ? (zoomMs / 1000).toFixed(zoomMs % 1000 ? 1 : 0) + " s" : zoomMs + " ms"; save(); }
  zoomEl.addEventListener("input", () => setZoom(+zoomEl.value));
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoomMs * (e.deltaY > 0 ? 1.15 : 1 / 1.15)); }, { passive: false });

  const DBMIN = -60, DBMAX = 0, MAXHIST = 26000, MAXDRAW = 1400;
  const histIn = [], histGR = [], histLoud = []; // scrolling input level, gain reduction, pre-smoothed loudness (newest at the right)
  let grHold = 0, loudEnv = 0, loudInit = false;

  currentDraw = function () {
    const { W, H, dpr } = dims();
    const me = (engine.meters && engine.meters[m.id]) || {};
    const colsPerSec = (engine.sampleRate || 48000) / 16; // trace columns produced per second
    const loudA = 1 - Math.exp(-1 / (0.2 * colsPerSec)); // ~200 ms loudness smoothing, in absolute time
    if (engine.running && me.trace) for (const pr of me.trace) {
      histIn.push(pr[0]); histGR.push(pr[1]);
      // accumulate the loudness trend once per column (persistent), so the line
      // is stable and never re-seeds at the scrolling left edge
      const lv = pr[0] < -60 ? -60 : pr[0];
      if (!loudInit) { loudEnv = lv; loudInit = true; } else { loudEnv += (lv - loudEnv) * loudA; }
      histLoud.push(loudEnv);
    }
    if (histIn.length > MAXHIST) { const ex = histIn.length - MAXHIST; histIn.splice(0, ex); histGR.splice(0, ex); histLoud.splice(0, ex); }

    const Y = (db) => (1 - (clamp(db, DBMIN, DBMAX) - DBMIN) / (DBMAX - DBMIN)) * H;
    ctx.clearRect(0, 0, W, H);

    // dB grid + right-edge labels
    ctx.strokeStyle = "#1c2430"; ctx.lineWidth = 1 * dpr;
    ctx.fillStyle = "#3a4452"; ctx.font = `${10 * dpr}px system-ui`; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (let db = 0; db >= -60; db -= 6) { const y = Y(db); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(db, W - 3 * dpr, y); }
    ctx.textAlign = "left";

    // ceiling line
    const cy = Y(m.ceiling);
    ctx.strokeStyle = "rgba(255,180,84,0.5)"; ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke(); ctx.setLineDash([]);

    const len = histIn.length;
    const vc = clamp(Math.round((zoomMs / 1000) * colsPerSec), 8, Math.max(8, len)); // visible columns
    if (len > 1) {
      // peak-preserving decimation: one draw point per bucket holds that bucket's
      // loudest level + deepest GR, so transients survive even zoomed way out
      const start = len - vc, drawN = Math.min(vc, MAXDRAW);
      const inV = new Float32Array(drawN), grV = new Float32Array(drawN), trend = new Float32Array(drawN);
      for (let k = 0; k < drawN; k++) {
        const lo = start + Math.floor((k * vc) / drawN);
        let hi = start + Math.floor(((k + 1) * vc) / drawN);
        if (hi <= lo) hi = lo + 1;
        let im = -200, gm = 0;
        for (let i = lo; i < hi && i < len; i++) { if (histIn[i] > im) im = histIn[i]; if (histGR[i] > gm) gm = histGR[i]; }
        inV[k] = im; grV[k] = gm;
        trend[k] = histLoud[Math.min(hi - 1, len - 1)]; // pre-smoothed loudness - stable, no per-frame re-seed
      }
      const xAt = (k) => (drawN <= 1 ? W : (k / (drawN - 1)) * W);

      // signal level: one soft filled "mountain", lighter near the top
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "rgba(120,170,225,0.42)");
      grad.addColorStop(1, "rgba(70,110,165,0.08)");
      ctx.beginPath(); ctx.moveTo(xAt(0), H);
      for (let k = 0; k < drawN; k++) ctx.lineTo(xAt(k), Y(inV[k]));
      ctx.lineTo(xAt(drawN - 1), H); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();

      // gain reduction: red hanging from the top (0 dB) - deeper = more reduction
      ctx.beginPath(); ctx.moveTo(xAt(0), 0);
      for (let k = 0; k < drawN; k++) ctx.lineTo(xAt(k), Y(-grV[k]));
      ctx.lineTo(xAt(drawN - 1), 0); ctx.closePath();
      ctx.fillStyle = "rgba(232,70,60,0.55)"; ctx.fill();

      // loudness trend line (orange), like Pro-L
      ctx.beginPath();
      for (let k = 0; k < drawN; k++) { const x = xAt(k), y = Y(trend[k]); k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.strokeStyle = "rgba(255,176,84,0.9)"; ctx.lineWidth = 1.4 * dpr; ctx.stroke();
    }

    // legend + visible-window readout
    ctx.textBaseline = "top"; ctx.font = `${10 * dpr}px system-ui`;
    ctx.fillStyle = "rgba(255,140,130,0.95)"; ctx.fillText("gain reduction", 6 * dpr, 4 * dpr);
    ctx.fillStyle = "rgba(255,176,84,0.95)"; ctx.fillText("loudness", 98 * dpr, 4 * dpr);
    ctx.textAlign = "right"; ctx.fillStyle = "#5a6472";
    ctx.fillText(zoomMs >= 1000 ? (zoomMs / 1000).toFixed(zoomMs % 1000 ? 1 : 0) + " s" : zoomMs + " ms", W - 3 * dpr, 4 * dpr);
    ctx.textAlign = "left";

    // GR sidebar meter + peak hold
    const gr = me.gr || 0;
    grHold = gr > grHold ? gr : grHold * 0.92 + gr * 0.08;
    grFill.style.height = clamp(gr / GRSPAN, 0, 1) * 100 + "%";
    grVal.textContent = gr.toFixed(1);
    grPk.textContent = "pk " + grHold.toFixed(1);
    elM.textContent = fmtL(me.lufsM); elS.textContent = fmtL(me.lufsS); elI.textContent = fmtL(me.lufsI);
    elPk.textContent = typeof me.peak === "number" && me.peak > -120 ? me.peak.toFixed(1) : "-";
    if (elTP) { elTP.textContent = typeof me.tp === "number" && me.tp > -120 ? me.tp.toFixed(1) : "-"; elTP.style.color = (typeof me.tp === "number" && me.tp > m.ceiling + 0.05) ? "var(--danger)" : ""; }
  };
}

// ===================== Utility =====================
function renderUtility(m) {
  m.crossfeed = m.crossfeed ?? 0;
  const tog = (key, label) => `<button class="util-tog ${m[key] ? "on" : ""}" data-key="${key}">${label}</button>`;
  edEl.innerHTML = `
    ${edHead(m.name, "Utility")}
    <div class="util-top">
      <div class="knobs" style="grid-template-columns:repeat(4,minmax(110px,1fr)); flex:1">
        ${knob("gain", "Gain", m.gain, -24, 24, 0.5, "dB")}
        ${knob("pan", "Balance", m.pan, -1, 1, 0.02, "")}
        ${knob("width", "Width", m.width, 0, 2, 0.05, "")}
        ${knob("crossfeed", "Crossfeed", m.crossfeed, 0, 100, 1, "%")}
      </div>
      <div class="util-togs">
        ${tog("mono", "Mono")} ${tog("swap", "Swap L/R")} ${tog("invL", "Ø Left")} ${tog("invR", "Ø Right")}
      </div>
    </div>
    <div class="graphwrap util-gonio" title="Goniometer: the stereo field (vertical = mono / in-phase, spread = stereo width). The bar below is L/R correlation (+1 mono, 0 wide, −1 out of phase)."><canvas id="corrCanvas"></canvas></div>
    <div class="xfeed-panel">
      <svg viewBox="0 0 240 120" class="xfeed-svg" aria-hidden="true">
        <circle cx="42" cy="26" r="6" fill="#36a3ff"></circle><text x="42" y="13">L</text>
        <circle cx="198" cy="26" r="6" fill="#ffb454"></circle><text x="198" y="13">R</text>
        <circle cx="120" cy="86" r="28" fill="none" stroke="#6b7280" stroke-width="2"></circle>
        <circle cx="94" cy="84" r="4" fill="#9aa3b0"></circle><circle cx="146" cy="84" r="4" fill="#9aa3b0"></circle>
        <line x1="42" y1="32" x2="94" y2="80" stroke="#36a3ff" stroke-width="2"></line>
        <line x1="198" y1="32" x2="146" y2="80" stroke="#ffb454" stroke-width="2"></line>
        <path id="xfL" d="M42,32 Q128,66 146,80" fill="none" stroke="#36a3ff" stroke-width="2" stroke-dasharray="4 3" opacity="0.1"></path>
        <path id="xfR" d="M198,32 Q112,66 94,80" fill="none" stroke="#ffb454" stroke-width="2" stroke-dasharray="4 3" opacity="0.1"></path>
      </svg>
      <div class="xfeed-text">
        <b>Crossfeed</b> bleeds a little of each channel into the <i>other</i> ear, slightly delayed and low-passed - the way sound naturally wraps around your head from speakers.
        <br><b>Why:</b> hard-panned mixes on headphones sound split "inside your head"; crossfeed makes them feel like speakers in a room, easing listening fatigue.
        <br><b>When:</b> on headphones (especially older / hard-panned recordings). Leave it at 0 on speakers.
      </div>
    </div>`;
  wireKnobs(m, ["gain", "pan", "width", "crossfeed"]);
  const xfKnob = document.getElementById("k_crossfeed");
  if (xfKnob) xfKnob.closest(".knob").title = "Headphone crossfeed: feeds a delayed, low-passed bit of each channel into the opposite ear so hard-panned mixes feel like speakers rather than split inside your head. Use on headphones; 0 on speakers.";
  const setXf = () => { const a = clamp((m.crossfeed || 0) / 100, 0, 1); const o = (0.1 + a * 0.9).toFixed(2); const l = document.getElementById("xfL"), r = document.getElementById("xfR"); if (l) l.style.opacity = o; if (r) r.style.opacity = o; };
  setXf();
  if (xfKnob) xfKnob.addEventListener("input", setXf);
  edEl.querySelectorAll(".util-tog").forEach((btn) => btn.addEventListener("click", () => {
    const k = btn.dataset.key; m[k] = !m[k]; btn.classList.toggle("on", m[k]); pushParam(m); save();
  }));

  const canvas = document.getElementById("corrCanvas");
  const ctx = canvas.getContext("2d");
  let buf = null, bctx = null;
  const dims = makeCanvas(canvas, 1, (W, H) => {
    buf = document.createElement("canvas"); buf.width = W; buf.height = H;
    bctx = buf.getContext("2d"); bctx.fillStyle = "#06080b"; bctx.fillRect(0, 0, W, H);
  });
  currentDraw = function () {
    const { W, H, dpr } = dims();
    if (!buf) return;
    const me = (engine.meters && engine.meters[m.id]) || {};
    const corr = typeof me.corr === "number" ? me.corr : 0;
    const cx = W / 2, cy = H * 0.46, rad = Math.min(W, H * 0.9) * 0.42, sc = rad * 0.72;

    // phosphor-style persistence: fade the buffer, plot the new points
    bctx.fillStyle = "rgba(6,8,11,0.30)"; bctx.fillRect(0, 0, W, H);
    const pts = engine.running ? me.scope : null;
    if (pts) {
      bctx.fillStyle = "rgba(90,232,140,0.85)";
      for (let i = 0; i < pts.length; i += 2) {
        const x = (pts[i] - pts[i + 1]) * 0.7071, y = (pts[i] + pts[i + 1]) * 0.7071; // rotate 45° (mono = vertical)
        bctx.fillRect(cx + x * sc, cy - y * sc, dpr, dpr);
      }
    }

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(buf, 0, 0);
    // guides
    ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - rad * 0.71, cy + rad * 0.71); ctx.lineTo(cx + rad * 0.71, cy - rad * 0.71);
    ctx.moveTo(cx - rad * 0.71, cy - rad * 0.71); ctx.lineTo(cx + rad * 0.71, cy + rad * 0.71);
    ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad); ctx.stroke();
    ctx.fillStyle = "#6b7280"; ctx.font = `${10 * dpr}px system-ui`; ctx.textBaseline = "alphabetic";
    ctx.fillText("L", cx - rad * 0.82, cy - rad * 0.64); ctx.fillText("R", cx + rad * 0.72, cy - rad * 0.64);
    ctx.fillText("M", cx + 4 * dpr, cy - rad + 2 * dpr); ctx.fillText("+S", cx + rad - 14 * dpr, cy - 4 * dpr);

    // correlation bar
    const by = H * 0.96, bx = W * 0.1, bw = W * 0.8, mid = bx + bw / 2;
    ctx.fillStyle = "#0a0c10"; ctx.fillRect(bx, by - 5 * dpr, bw, 10 * dpr);
    const cxp = bx + ((corr + 1) / 2) * bw;
    ctx.fillStyle = corr < 0 ? "#e5564b" : "#3ad07a";
    ctx.fillRect(Math.min(cxp, mid), by - 5 * dpr, Math.abs(cxp - mid), 10 * dpr);
    ctx.fillStyle = "#fff"; ctx.fillRect(cxp - 1 * dpr, by - 8 * dpr, 2 * dpr, 16 * dpr);
    ctx.fillStyle = "#8b929e"; ctx.font = `${9 * dpr}px system-ui`;
    ctx.fillText("correlation " + corr.toFixed(2), bx, by - 9 * dpr);
  };
}

// ===================== Multiband compressor (EQ-style graph) =====================
const MB_BAND_COLORS = BAND_COLORS; // one palette: band N is the same color in EQ and multiband
const MB_DBMIN = -60, MB_DBMAX = 6, MB_MAXBANDS = 8;
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

function renderMBComp(m) {
  if (!Array.isArray(m.xovers)) m.xovers = [250, 2500];
  if (!Array.isArray(m.bands)) m.bands = defaultModule("mbcomp").bands;
  if (m.selBand == null || m.selBand >= m.bands.length) m.selBand = 0;
  m.mix = m.mix ?? 100;
  m.bands.forEach((b) => { if (b.ratioUp == null) b.ratioUp = b.ratio; }); // independent OTT upward ratio

  edEl.innerHTML = `
    ${edHead(m.name, "Multiband comp", knobInline("mix", "Dry/Wet", m.mix, 0, 100, 1, "%"))}
    <div class="graphwrap"><canvas id="mbCanvas"></canvas></div>
    <div class="mb-notice">
      <span class="mb-notice-ico">✦</span>
      <span><b>Double-click</b> anywhere to add a band &middot; <b>Click &amp; drag</b> the dividers to adjust boundaries &middot; <b>Drag</b> a band's line for its threshold &middot; <b>Right-click</b> a divider to remove it</span>
    </div>
    <div id="mbBandCtl"></div>`;
  wireKnobs(m, ["mix"], true);

  const canvas = document.getElementById("mbCanvas");
  const ctx = canvas.getContext("2d");
  const dims = makeCanvas(canvas, 0.42);
  const fToX = (f, W) => (Math.log(f / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN)) * W;
  const xToF = (x, W) => FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, x / W);
  const dbToY = (db, H) => ((MB_DBMAX - db) / (MB_DBMAX - MB_DBMIN)) * H;
  const yToDb = (y, H) => MB_DBMAX - (y / H) * (MB_DBMAX - MB_DBMIN);
  const bandRange = (i) => [i === 0 ? FREQ_MIN : m.xovers[i - 1], i === m.bands.length - 1 ? FREQ_MAX : m.xovers[i]];

  function renderBandCtl() {
    const i = m.selBand, b = m.bands[i];
    const det = b.detector || "feedforward", mode = b.mode || "down";
    if (b.range == null) b.range = 24;
    if (b.ratioUp == null) b.ratioUp = b.ratio;
    // OTT exposes independent down/up ratios; "Range" becomes the upward depth limit
    const isOtt = mode === "ott", upMode = isOtt || mode === "up";
    const ks = [
      ["mb_threshold", "threshold", knob("mb_threshold", "Threshold", b.threshold, -60, 0, 0.5, "dB")],
      ["mb_ratio", "ratio", knob("mb_ratio", isOtt ? "Down ratio" : "Ratio", b.ratio, 1, 20, 0.1, ":1")],
      ...(isOtt ? [["mb_ratioUp", "ratioUp", knob("mb_ratioUp", "Up ratio", b.ratioUp, 1, 20, 0.1, ":1")]] : []),
      ["mb_attack", "attack", knob("mb_attack", "Attack", b.attack, 0.1, 200, 0.1, "ms")],
      ["mb_release", "release", knob("mb_release", "Release", b.release, 5, 1000, 1, "ms")],
      ["mb_knee", "knee", knob("mb_knee", "Knee", b.knee, 0, 24, 0.5, "dB")],
      ["mb_makeup", "makeup", knob("mb_makeup", "Makeup", b.makeup, 0, 24, 0.5, "dB")],
      ["mb_range", "range", knob("mb_range", upMode ? "Up depth" : "Range", b.range, 0, 48, 1, "dB")],
    ];
    const mbKnobs = `<div class="knobs" style="grid-template-columns:repeat(${ks.length},1fr)">${ks.map((k) => k[2]).join("")}</div>`;
    const ctl = document.getElementById("mbBandCtl");
    ctl.innerHTML = `
      <div class="mb-ctl-head">
        <span class="sw" style="background:${MB_BAND_COLORS[i % MB_BAND_COLORS.length]}"></span>
        <span class="mb-title">Band ${i + 1} / ${m.bands.length}</span>
        <span class="mb-xrange">
          ${i > 0 ? `<label>from <input type="number" id="mbXlo" value="${Math.round(m.xovers[i - 1])}" min="25" max="19000" step="1"></label>` : `<span class="mb-edge">20 Hz</span>`}
          <span class="mb-edge">–</span>
          ${i < m.bands.length - 1 ? `<label><input type="number" id="mbXhi" value="${Math.round(m.xovers[i])}" min="25" max="19000" step="1"> Hz</label>` : `<span class="mb-edge">20 kHz</span>`}
        </span>
        <button class="mb-act mb-del" id="mbDel" ${m.bands.length <= 1 ? "disabled" : ""}>− Remove band</button>
        <label class="mb-det">Mode <select id="mbMode">
          <option value="down" ${mode === "down" ? "selected" : ""}>Down</option>
          <option value="up" ${mode === "up" ? "selected" : ""}>Up</option>
          <option value="expand" ${mode === "expand" ? "selected" : ""}>Expand</option>
          <option value="ott" ${mode === "ott" ? "selected" : ""}>OTT</option>
        </select></label>
        <label class="mb-det">Detect <select id="mbDet">
          <option value="feedforward" ${det === "feedforward" ? "selected" : ""}>Feed-forward</option>
          <option value="feedback" ${det === "feedback" ? "selected" : ""}>Feed-back</option>
        </select></label>
        <button class="mb-byp ${b.bypass ? "" : "on"}" id="mbByp">${b.bypass ? "○ bypassed" : "● active"}</button>
      </div>
      ${mbKnobs}`;
    ks.forEach(([id, key]) => {
      const input = document.getElementById("k_" + id), out = document.getElementById("v_" + id), unit = out.dataset.unit || "";
      input.addEventListener("input", () => { b[key] = Number(input.value); out.textContent = fmtKnob(b[key]) + unit; pushParam(m); save(); });
    });
    const xlo = document.getElementById("mbXlo");
    if (xlo) xlo.addEventListener("change", () => setXover(i - 1, Number(xlo.value)));
    const xhi = document.getElementById("mbXhi");
    if (xhi) xhi.addEventListener("change", () => setXover(i, Number(xhi.value)));
    document.getElementById("mbDel").addEventListener("click", () => removeBand(i));
    document.getElementById("mbMode").addEventListener("change", (e) => { b.mode = e.target.value; pushParam(m); save(); renderBandCtl(); });
    document.getElementById("mbDet").addEventListener("change", (e) => { b.detector = e.target.value; pushParam(m); save(); });
    document.getElementById("mbByp").addEventListener("click", () => { b.bypass = !b.bypass; pushParam(m); save(); renderBandCtl(); });
  }
  renderBandCtl();

  const restructure = () => { pushParam(m); save(); renderEditor(); };
  function addXover(f) {
    if (m.bands.length >= MB_MAXBANDS) return;
    f = clamp(f, 30, 18000);
    // require ~1/10-octave spacing from existing crossovers, else we'd create a
    // zero-width band with two stacked dividers that can't be dragged apart
    for (const xo of m.xovers) if (Math.abs(Math.log2(f / xo)) < 0.1) return;
    let bi = 0; while (bi < m.xovers.length && f > m.xovers[bi]) bi++;
    m.xovers.push(f); m.xovers.sort((a, b) => a - b);
    m.bands.splice(bi + 1, 0, { ...m.bands[bi] });
    m.selBand = bi + 1; restructure();
  }
  function removeXover(i) {
    if (m.xovers.length === 0) return;
    pushUndo();
    m.xovers.splice(i, 1); m.bands.splice(i + 1, 1);
    if (m.selBand >= m.bands.length) m.selBand = m.bands.length - 1;
    restructure();
  }
  // explicit (button/number-input) equivalents
  function setXover(xi, f) {
    if (xi < 0 || xi >= m.xovers.length || !isFinite(f)) return;
    const lo = (xi === 0 ? 25 : m.xovers[xi - 1]) * 1.02, hi = (xi === m.xovers.length - 1 ? 19500 : m.xovers[xi + 1]) * 0.98;
    m.xovers[xi] = clamp(f, lo, hi);
    pushParam(m); save(); renderBandCtl();
  }
  function removeBand(i) {
    if (m.bands.length <= 1) return;
    pushUndo();
    if (i > 0) { m.xovers.splice(i - 1, 1); m.bands.splice(i, 1); }
    else { m.xovers.splice(0, 1); m.bands.splice(0, 1); }
    if (m.selBand >= m.bands.length) m.selBand = m.bands.length - 1;
    restructure();
  }

  const evtPos = (e) => { const { dpr } = dims(); const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  let drag = null;
  const xoverAt = (px, W, dpr) => { for (let i = 0; i < m.xovers.length; i++) if (Math.abs(px - fToX(m.xovers[i], W)) < 8 * dpr) return i; return -1; };
  const bandAtX = (px, W) => { const f = xToF(px, W); let i = 0; while (i < m.xovers.length && f > m.xovers[i]) i++; return i; };

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const { W, H, dpr } = dims(); const [px, py] = evtPos(e);
    const xi = xoverAt(px, W, dpr);
    if (xi >= 0) { drag = { type: "xover", i: xi }; return; }
    const bi = bandAtX(px, W);
    if (Math.abs(py - dbToY(m.bands[bi].threshold, H)) < 9 * dpr) { drag = { type: "thr", band: bi }; }
    m.selBand = bi; renderBandCtl();
  });
  const onMove = (e) => {
    if (!drag) return;
    const { W, H } = dims(); const [px, py] = evtPos(e);
    if (drag.type === "xover") {
      const i = drag.i;
      const lo = (i === 0 ? 25 : m.xovers[i - 1]) * 1.02, hi = (i === m.xovers.length - 1 ? 19500 : m.xovers[i + 1]) * 0.98;
      m.xovers[i] = clamp(xToF(px, W), lo, hi);
    } else { m.bands[drag.band].threshold = clamp(Math.round(yToDb(py, H) * 10) / 10, -60, 0); } // tenths, not raw float
    pushParam(m);
  };
  const onUp = () => { if (drag) { drag = null; save(); renderBandCtl(); } };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  viewCleanup = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };

  canvas.addEventListener("dblclick", (e) => { const { W } = dims(); const [px] = evtPos(e); addXover(xToF(px, W)); });
  canvas.addEventListener("contextmenu", (e) => {
    const { W, dpr } = dims(); const [px] = evtPos(e); const xi = xoverAt(px, W, dpr);
    if (xi >= 0) { e.preventDefault(); removeXover(xi); }
  });

  const smoothSpec = makeSpecSmoother();
  currentDraw = function () {
    syncOverlaySpec(); // keep the overlay on its own light FFT/resolution
    const { W, H, dpr } = dims();
    const mb = ((engine.meters && engine.meters[m.id]) || {}).mb || [];
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "#56606e"; ctx.font = `${10 * dpr}px system-ui`;
    [30, 100, 300, 1000, 3000, 10000].forEach((f) => {
      const x = fToX(f, W); ctx.strokeStyle = "#161d26"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillText(f >= 1000 ? f / 1000 + "k" : f, x + 3, H - 4);
    });
    for (let db = 0; db >= -48; db -= 12) { const y = dbToY(db, H); ctx.strokeStyle = "#161d26"; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(db + "", 3, y - 2); }

    if (engine.running && engine.last && engine.last.length > 1) {
      const s = smoothSpec(engine.last), nn = s.length;
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let k = 0; k < nn; k++) ctx.lineTo((k / (nn - 1)) * W, dbToY(clamp(s[k], MB_DBMIN, MB_DBMAX), H));
      ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = "rgba(120,130,150,0.14)"; ctx.fill();
    }

    const MODE_SHORT = { down: "DN", up: "UP", ott: "OTT", expand: "EXP" };
    const VIS_REF = 24; // dB of gain change that fills half the band height
    for (let i = 0; i < m.bands.length; i++) {
      const b = m.bands[i];
      const [lo, hi] = bandRange(i), x0 = fToX(lo, W), x1 = fToX(hi, W), bw = x1 - x0, col = MB_BAND_COLORS[i % MB_BAND_COLORS.length];
      const sel = i === m.selBand;
      ctx.fillStyle = hexA(col, sel ? 0.12 : 0.05); ctx.fillRect(x0, 0, bw, H);
      const pair = mb[i] || [0, 0], down = pair[0] || 0, up = pair[1] || 0;
      // downward compression (cut) = red descending from the top;
      // upward compression (boost) = green rising from the bottom. Both show at once for OTT.
      if (down > 0.05) { ctx.fillStyle = "rgba(229,86,75,0.34)"; ctx.fillRect(x0, 0, bw, clamp(down / VIS_REF, 0, 1) * H * 0.5); }
      if (up > 0.05) { const uh = clamp(up / VIS_REF, 0, 1) * H * 0.5; ctx.fillStyle = "rgba(58,208,122,0.32)"; ctx.fillRect(x0, H - uh, bw, uh); }
      const ty = dbToY(b.threshold, H);
      ctx.strokeStyle = col; ctx.lineWidth = (sel ? 2.4 : 1.4) * dpr;
      ctx.beginPath(); ctx.moveTo(x0, ty); ctx.lineTo(x1, ty); ctx.stroke();
      // label: band number + mode badge + live cut/boost so direction is always apparent
      ctx.fillStyle = col; ctx.font = `${10 * dpr}px system-ui`;
      let lab = "B" + (i + 1) + " " + (MODE_SHORT[b.mode] || "DN");
      if (down > 0.1) lab += "  ↓" + down.toFixed(1);
      if (up > 0.1) lab += "  ↑" + up.toFixed(1);
      ctx.fillText(lab, x0 + 5 * dpr, 13 * dpr);
    }

    for (let i = 0; i < m.xovers.length; i++) {
      const x = fToX(m.xovers[i], W);
      ctx.strokeStyle = "rgba(231,234,239,0.55)"; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      const lab = fmtFreq(m.xovers[i]), tw = ctx.measureText(lab).width;
      ctx.fillStyle = "rgba(10,12,16,0.7)"; ctx.fillRect(x - tw / 2 - 3 * dpr, H - 16 * dpr, tw + 6 * dpr, 13 * dpr);
      ctx.fillStyle = "#dfe6f0"; ctx.fillText(lab, x - tw / 2, H - 5 * dpr);
    }
  };
}

// ===================== Saturation / Exciter =====================
const SAT_MODES = ["tube", "tape", "crunch", "fold", "hard"];
function satShape(mode, x) {
  switch (mode) {
    case "hard": return x < -1 ? -1 : x > 1 ? 1 : x;
    case "tape": return Math.tanh(x);
    case "crunch": { const c = x < -1 ? -1 : x > 1 ? 1 : x; return 1.5 * c - 0.5 * c * c * c; }
    case "fold": { let y = x; for (let k = 0; k < 4 && (y > 1 || y < -1); k++) y = y > 1 ? 2 - y : -2 - y; return y; }
    default: { const b = 0.18; return Math.tanh(x + b) - Math.tanh(b); }
  }
}
function renderSat(m) {
  m.mode = m.mode || "tube"; m.drive = m.drive ?? 6; m.tone = m.tone ?? 0; m.mix = m.mix ?? 100; m.output = m.output ?? 0; m.os = m.os ?? 2;
  const osOpts = [[1, "Off"], [2, "2×"], [4, "4×"]].map(([v, l]) => `<option value="${v}" ${m.os == v ? "selected" : ""}>${l}</option>`).join("");
  edEl.innerHTML = `
    ${edHead(m.name, "Saturation", `
      <label class="detsel">Character <select id="satMode">${SAT_MODES.map((s) => `<option ${s === m.mode ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="detsel" title="Run the waveshaper oversampled so its harmonics above Nyquist don't alias back as harshness. Higher = cleaner, more CPU.">Oversampling <select id="satOS">${osOpts}</select></label>`)}
    <div class="dyn">
      <div class="graphwrap" title="Waveshaper curve: how the input (x) is reshaped into the output (y) at the current Drive. The diagonal is unity (no change)."><canvas id="satCanvas"></canvas></div>
      <div>
        <div class="meterbox" style="margin-bottom:16px"><div><div class="meter meter-up" style="height:120px"><div class="fill" id="satFill"></div></div><div class="meter-label">OUT <span id="satVal">-∞</span></div></div></div>
        <div class="knobs">
          ${knob("drive", "Drive", m.drive, 0, 36, 0.5, "dB")}
          ${knob("tone", "Tone", m.tone, -100, 100, 1, "")}
          ${knob("mix", "Dry/Wet", m.mix, 0, 100, 1, "%")}
          ${knob("output", "Output", m.output, -24, 24, 0.5, "dB")}
        </div>
      </div>
    </div>`;
  wireKnobs(m, ["drive", "tone", "mix", "output"]);
  document.getElementById("satMode").addEventListener("change", (e) => { m.mode = e.target.value; pushParam(m); save(); });
  document.getElementById("satOS").addEventListener("change", (e) => { m.os = Number(e.target.value); pushParam(m); save(); });
  const canvas = document.getElementById("satCanvas"); const dims = makeCanvas(canvas, 0.72); const ctx = canvas.getContext("2d");
  const satFill = document.getElementById("satFill"), satVal = document.getElementById("satVal");
  currentDraw = function () {
    const { W, H, dpr } = dims(); ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "#1c2430"; ctx.lineWidth = 1 * dpr;
    for (let k = 0; k <= 4; k++) { const x = k / 4 * W, y = k / 4 * H; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.strokeStyle = "#3a4452"; ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke(); // unity
    const drv = Math.pow(10, m.drive / 20), og = Math.pow(10, m.output / 20);
    ctx.save(); ctx.shadowColor = "rgba(255,180,84,0.6)"; ctx.shadowBlur = 7 * dpr; ctx.beginPath();
    for (let px = 0; px <= W; px++) { const xin = (px / W) * 2 - 1; const o = clamp(satShape(m.mode, xin * drv) * og, -1.2, 1.2); const py = H / 2 - o * (H / 2 / 1.2); px === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
    ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 2.2 * dpr; ctx.stroke(); ctx.restore();
    const meter = (engine.meters && engine.meters[m.id]) || {}; const lv = typeof meter.level === "number" ? meter.level : -100;
    satFill.style.height = clamp((lv + 60) / 60, 0, 1) * 100 + "%";
    satVal.textContent = lv <= -99 ? "-∞" : lv.toFixed(1);
  };
}

// ===================== Transient shaper =====================
function renderTrans(m) {
  m.attack = m.attack ?? 0; m.sustain = m.sustain ?? 0; m.output = m.output ?? 0;
  edEl.innerHTML = `
    ${edHead(m.name, "Transient shaper")}
    <div class="graphwrap" title="Live waveform: brighter overlay shows how Attack/Sustain reshape each transient's envelope versus the original."><canvas id="transCanvas"></canvas></div>
    <div class="knobs" style="max-width:540px;margin-top:16px">
      ${knob("attack", "Attack", m.attack, -100, 100, 1, "%")}
      ${knob("sustain", "Sustain", m.sustain, -100, 100, 1, "%")}
      ${knob("output", "Output", m.output, -24, 24, 0.5, "dB")}
    </div>`;
  wireKnobs(m, ["attack", "sustain", "output"]);
  const canvas = document.getElementById("transCanvas"); const dims = makeCanvas(canvas, 0.32); const ctx = canvas.getContext("2d");
  let hist = []; const HMAX = 240;
  currentDraw = function () {
    const { W, H, dpr } = dims(); ctx.clearRect(0, 0, W, H);
    const meter = (engine.meters && engine.meters[m.id]) || {}; const g = meter.gr || 0; // signed gain dB
    hist.push(g); while (hist.length > HMAX) hist.shift();
    const cy = H / 2;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(58,208,122,0.34)"); grad.addColorStop(0.5, "rgba(120,130,150,0.05)"); grad.addColorStop(1, "rgba(229,86,75,0.34)");
    const n = hist.length, step = W / (HMAX - 1), gy = (i) => cy - clamp(hist[i] / 15, -1, 1) * (H / 2 - 4 * dpr);
    if (n > 1) {
      ctx.beginPath(); ctx.moveTo(W, cy);
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(W - (n - 1 - i) * step, gy(i));
      ctx.lineTo(W - (n - 1) * step, cy); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); for (let i = n - 1; i >= 0; i--) { const x = W - (n - 1 - i) * step; i === n - 1 ? ctx.moveTo(x, gy(i)) : ctx.lineTo(x, gy(i)); }
      ctx.strokeStyle = "rgba(230,236,246,0.7)"; ctx.lineWidth = 1.3 * dpr; ctx.stroke();
    }
    ctx.strokeStyle = "#2a323d"; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
    ctx.font = `${11 * dpr}px system-ui`; ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(120,210,150,0.85)"; ctx.fillText("punch  +" + Math.max(0, g).toFixed(1), 8 * dpr, 5 * dpr);
    ctx.fillStyle = "rgba(255,140,130,0.9)"; ctx.fillText("soften  " + Math.min(0, g).toFixed(1), 8 * dpr, H - 16 * dpr);
  };
}

// ===================== Gate / Expander =====================
function renderGate(m) {
  m.threshold = m.threshold ?? -45; m.ratio = m.ratio ?? 4; m.range = m.range ?? 50; m.attack = m.attack ?? 1; m.release = m.release ?? 120; m.hold = m.hold ?? 12;
  edEl.innerHTML = `
    ${edHead(m.name, "Gate / Expander")}
    <div class="dyn">
      <div class="graphwrap" title="Top strip: input level vs threshold over time (green = gate open, red = gated). Below: transfer curve with the live operating dot. The GR meter shows reduction."><canvas id="gateCanvas"></canvas></div>
      <div>
        <div class="meterbox" style="margin-bottom:16px"><div><div class="meter" style="height:130px"><div class="fill" id="grFill"></div></div><div class="meter-label">GR <span id="grVal">0.0</span></div></div></div>
        <div class="knobs">
          ${knob("threshold", "Threshold", m.threshold, -80, 0, 0.5, "dB")}
          ${knob("ratio", "Ratio", m.ratio, 1, 20, 0.1, ":1")}
          ${knob("range", "Range", m.range, 0, 80, 1, "dB")}
          ${knob("attack", "Attack", m.attack, 0.05, 50, 0.05, "ms")}
          ${knob("release", "Release", m.release, 5, 1000, 1, "ms")}
          ${knob("hold", "Hold", m.hold, 0, 250, 1, "ms")}
        </div>
      </div>
    </div>`;
  wireKnobs(m, ["threshold", "ratio", "range", "attack", "release", "hold"]);
  const canvas = document.getElementById("gateCanvas"); const dims = makeCanvas(canvas, 1); const ctx = canvas.getContext("2d");
  const grFill = document.getElementById("grFill"), grVal = document.getElementById("grVal");
  const lvlHist = []; const HISTMAX = 300; // input level over time, newest at the right
  currentDraw = function () {
    const { W, H, dpr } = dims(); ctx.clearRect(0, 0, W, H);
    const meter = (engine.meters && engine.meters[m.id]) || {};
    const gr = Math.max(0, meter.gr || 0);
    const level = typeof meter.level === "number" ? meter.level : -120;
    lvlHist.push(engine.running ? level : -120);
    while (lvlHist.length > HISTMAX) lvlHist.shift();
    // gate state: open (passing), closing (partial), or shut
    const open = gr < 0.5, shut = gr > Math.max(1, m.range) * 0.6;
    const stCol = open ? "#3ad07a" : shut ? "#e5564b" : "#ffb454";

    const topH = Math.round(H * 0.26), gh = H - topH;
    const sY = (db) => topH - ((clamp(db, -80, 0) + 80) / 80) * (topH - 4 * dpr); // level → y in the top strip
    const X = (db) => ((db + 80) / 80) * W;
    const Y = (db) => topH + (1 - (db + 80) / 80) * gh; // transfer area below the strip

    // ---------- top strip: live input level vs threshold (green open / red gated) ----------
    ctx.fillStyle = open ? "rgba(58,208,122,0.06)" : "rgba(229,86,75,0.06)"; ctx.fillRect(0, 0, W, topH);
    const sTh = sY(m.threshold);
    ctx.fillStyle = "rgba(229,86,75,0.10)"; ctx.fillRect(0, sTh, W, topH - sTh); // below-threshold (gated) zone
    ctx.strokeStyle = "rgba(255,180,84,0.55)"; ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(0, sTh); ctx.lineTo(W, sTh); ctx.stroke(); ctx.setLineDash([]);
    const nH = lvlHist.length;
    if (nH > 1) {
      const step = W / (HISTMAX - 1);
      ctx.beginPath(); ctx.moveTo(W - (nH - 1) * step, topH);
      for (let i = 0; i < nH; i++) ctx.lineTo(W - (nH - 1 - i) * step, sY(lvlHist[i]));
      ctx.lineTo(W, topH); ctx.closePath();
      ctx.fillStyle = "rgba(54,163,255,0.14)"; ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < nH; i++) { const x = W - (nH - 1 - i) * step, y = sY(lvlHist[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.strokeStyle = "rgba(150,200,255,0.85)"; ctx.lineWidth = 1.3 * dpr; ctx.stroke();
    }
    // status pill
    ctx.textBaseline = "top"; ctx.font = `${11 * dpr}px system-ui`;
    ctx.fillStyle = stCol; ctx.fillText(open ? "OPEN" : shut ? "GATED" : "CLOSING", 7 * dpr, 5 * dpr);
    ctx.fillStyle = "#8b929e"; ctx.fillText("thr " + m.threshold.toFixed(0) + " dB", 64 * dpr, 5 * dpr);

    // ---------- transfer curve (below) ----------
    ctx.strokeStyle = "#1c2430"; ctx.lineWidth = 1 * dpr; ctx.fillStyle = "#56606e"; ctx.font = `${9 * dpr}px system-ui`; ctx.textBaseline = "alphabetic";
    for (let db = -80; db <= 0; db += 20) { const x = X(db); ctx.beginPath(); ctx.moveTo(x, topH); ctx.lineTo(x, H); ctx.stroke(); const y = Y(db); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(db + "", 2, y - 2); }
    const tx = X(m.threshold);
    ctx.fillStyle = "rgba(229,86,75,0.08)"; ctx.fillRect(0, topH, tx, gh); // gated region (input below threshold)
    ctx.strokeStyle = "rgba(255,180,84,0.45)"; ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.beginPath(); ctx.moveTo(tx, topH); ctx.lineTo(tx, H); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = "#3a4452"; ctx.beginPath(); ctx.moveTo(X(-80), Y(-80)); ctx.lineTo(X(0), Y(0)); ctx.stroke();
    const curveOut = (inDb) => { const over = inDb - m.threshold; return inDb + (over >= 0 ? 0 : -Math.min(m.range, -over * (m.ratio - 1))); };
    ctx.save(); ctx.shadowColor = "rgba(54,163,255,0.6)"; ctx.shadowBlur = 6 * dpr; ctx.beginPath();
    for (let inDb = -80; inDb <= 0; inDb += 0.5) { const x = X(inDb), y = Y(clamp(curveOut(inDb), -80, 0)); inDb === -80 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.strokeStyle = "#36a3ff"; ctx.lineWidth = 2.2 * dpr; ctx.stroke(); ctx.restore();

    // live operating dot on the curve, coloured by gate state
    if (engine.running && level > -100) {
      const inDb = clamp(level, -80, 0), x = X(inDb), y = Y(clamp(curveOut(inDb), -80, 0));
      ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, y); ctx.lineTo(0, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.save(); ctx.shadowColor = stCol; ctx.shadowBlur = 10 * dpr; ctx.beginPath(); ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2); ctx.fillStyle = stCol; ctx.fill(); ctx.restore();
    }

    grFill.style.height = clamp(gr / Math.max(1, m.range), 0, 1) * 100 + "%"; grVal.textContent = gr.toFixed(1);
  };
}

// ===================== Noise suppressor =====================
function renderDenoise(m) {
  m.amount = m.amount ?? 60; m.floor = m.floor ?? 6;
  edEl.innerHTML = `
    ${edHead(m.name, "Noise suppressor")}
    <div class="dyn">
      <div class="meterbox"><div><div class="meter" style="height:150px"><div class="fill" id="grFill"></div></div><div class="meter-label">Reduce <span id="grVal">0.0</span></div></div></div>
      <div>
        <div class="knobs">
          ${knob("amount", "Amount", m.amount, 0, 100, 1, "%")}
          ${knob("floor", "Residual", m.floor, 0, 30, 1, "%")}
        </div>
        <p class="hint" style="max-width:380px; margin-top:16px; font-style:normal">Auto-learns the steady background noise and gates it out per frequency band - great for fans, hiss, hum and room tone on streams, calls and podcasts. <b>Amount</b> = how aggressive; raise <b>Residual</b> if it starts to sound "underwater". (Latency ~8 ms.)</p>
      </div>
    </div>`;
  wireKnobs(m, ["amount", "floor"]);
  const grFill = document.getElementById("grFill"), grVal = document.getElementById("grVal");
  currentDraw = function () {
    const meter = (engine.meters && engine.meters[m.id]) || {};
    const gr = Math.max(0, meter.gr || 0);
    grFill.style.height = clamp(gr / 24, 0, 1) * 100 + "%";
    grVal.textContent = gr.toFixed(1);
  };
}

// ===================== De-reverb =====================
const drvAnAid = {}; // module id -> last applied analysis id (apply each result once)
function renderDereverb(m) {
  m.amount = m.amount ?? 50; m.tail = m.tail ?? 300; m.residual = m.residual ?? 12; m.mix = m.mix ?? 100; m.autoMakeup = m.autoMakeup ?? true;
  m.zoom = m.zoom ?? 2500;
  edEl.innerHTML = `
    ${edHead(m.name, "De-reverb", `<button id="drvMakeup" class="ed-toggle ${m.autoMakeup ? "on" : ""}" title="Automatically restore the level the de-reverb removes, so toggling it isn't just 'quieter vs louder' (capped at +12 dB).">Auto makeup</button><button id="drvAnalyze" class="ed-toggle" title="Listen to a few seconds of the playing audio and auto-set Tail &amp; Amount from the room's reverb decay. Works best on speech or music with natural pauses.">✨ Analyze room</button>`)}
    <div class="dyn">
      <div class="lim-graph" style="flex:1; min-width:0; display:flex; flex-direction:column; gap:8px">
        <div class="graphwrap" title="Input level (blue) vs the de-reverbed output (green). The red is the reverb tail being removed - watch it shrink between words/notes as you raise Amount."><canvas id="drvCanvas"></canvas></div>
        <label class="hint" style="display:flex; align-items:center; gap:8px" title="How much history is shown across the graph.">Zoom
          <input type="range" id="drvZoom" min="500" max="8000" step="100" value="${m.zoom}" style="flex:1">
          <span id="drvZoomV" style="min-width:48px; text-align:right">${(m.zoom / 1000).toFixed(1)} s</span>
        </label>
      </div>
      <div>
        <div class="meterbox" style="margin-bottom:16px"><div><div class="meter" style="height:150px"><div class="fill" id="grFill"></div></div><div class="meter-label">Removed <span id="grVal">0.0</span></div></div></div>
        <div class="knobs" style="grid-template-columns:1fr 1fr">
          ${knob("amount", "Amount", m.amount, 0, 100, 1, "%")}
          ${knob("tail", "Tail", m.tail, 50, 1500, 10, "ms")}
          ${knob("residual", "Residual", m.residual, 0, 50, 1, "%")}
          ${knob("mix", "Dry/Wet", m.mix, 0, 100, 1, "%")}
        </div>
      </div>
    </div>
    <p class="hint" style="margin-top:14px; font-style:normal"><b>Amount</b> = how hard the decaying tails are pulled down · <b>Tail</b> = how long a reverb to chase (set near the room's decay) · <b>Residual</b> leaves a little tail so it stays natural · onsets and steady notes pass through untouched. (Latency ~8 ms.)</p>`;
  wireKnobs(m, ["amount", "tail", "residual", "mix"]);
  const atkTip = document.getElementById("k_amount"); if (atkTip) atkTip.closest(".knob").title = "0% = bypass. Higher pulls reverb decays down harder.";
  const resTip = document.getElementById("k_residual"); if (resTip) resTip.closest(".knob").title = "How much reverb tail to leave behind. 0% = maximum removal (can sound gated/unnatural); raise it to keep some natural room ambience and avoid artefacts.";
  const tailTip = document.getElementById("k_tail"); if (tailTip) tailTip.closest(".knob").title = "Roughly the reverb decay time to chase - match it to the room. Longer removes longer tails (but can start thinning sustained notes).";
  const mkBtn = document.getElementById("drvMakeup");
  mkBtn.addEventListener("click", () => { m.autoMakeup = !m.autoMakeup; mkBtn.classList.toggle("on", m.autoMakeup); pushParam(m); save(); });
  const anBtn = document.getElementById("drvAnalyze");
  anBtn.addEventListener("click", () => {
    if (selectedTab == null) { toast("Capture a tab first"); return; }
    send({ type: "set-param", tabId: selectedTab, id: m.id, params: { analyze: 4 } });
    anBtn.disabled = true; let left = 4; anBtn.textContent = `Listening ${left}s…`;
    const iv = setInterval(() => { left--; anBtn.textContent = left > 0 ? `Listening ${left}s…` : "Analyzing…"; if (left <= 0) clearInterval(iv); }, 1000);
    setTimeout(() => { anBtn.disabled = false; anBtn.textContent = "✨ Analyze room"; }, 5400); // fallback re-enable
  });

  const canvas = document.getElementById("drvCanvas");
  const dims = makeCanvas(canvas, 0.42);
  const ctx = canvas.getContext("2d");
  const grFill = document.getElementById("grFill"), grVal = document.getElementById("grVal");
  const zoomEl = document.getElementById("drvZoom"), zoomV = document.getElementById("drvZoomV");
  let zoomMs = m.zoom;
  function setZoom(v) { zoomMs = clamp(Math.round(v), 500, 8000); m.zoom = zoomMs; zoomEl.value = zoomMs; zoomV.textContent = (zoomMs / 1000).toFixed(1) + " s"; save(); }
  zoomEl.addEventListener("input", () => setZoom(+zoomEl.value));
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoomMs * (e.deltaY > 0 ? 1.15 : 1 / 1.15)); }, { passive: false });

  const DBMIN = -70, DBMAX = 0, MAXHIST = 26000, MAXDRAW = 1200;
  const histIn = [], histRed = []; // input level + reduction (dB), newest at the right
  let grHold = 0;
  currentDraw = function () {
    const { W, H, dpr } = dims();
    const me = (engine.meters && engine.meters[m.id]) || {};
    // apply an auto-analysis result once (when its id changes)
    const an = me.analysis;
    if (an && drvAnAid[m.id] !== an.aid) {
      drvAnAid[m.id] = an.aid;
      if (an.n >= 20) {
        const setK = (key, val) => { const inp = document.getElementById("k_" + key); if (inp) { inp.value = val; inp.dispatchEvent(new Event("input")); } };
        setK("tail", an.tail); setK("amount", an.amount); if (an.residual != null) setK("residual", an.residual);
        toast(`Analyzed room · Tail ${an.tail} ms · Amount ${an.amount}%`);
      } else {
        toast("Couldn't read the reverb - play audio with pauses, then Analyze again");
      }
      anBtn.disabled = false; anBtn.textContent = "✨ Analyze room";
    }
    if (engine.running && me.trace) for (const pr of me.trace) { histIn.push(pr[0]); histRed.push(pr[1]); }
    if (histIn.length > MAXHIST) { const ex = histIn.length - MAXHIST; histIn.splice(0, ex); histRed.splice(0, ex); }

    const Y = (db) => (1 - (clamp(db, DBMIN, DBMAX) - DBMIN) / (DBMAX - DBMIN)) * H;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "#1c2430"; ctx.lineWidth = 1 * dpr; ctx.fillStyle = "#3a4452"; ctx.font = `${10 * dpr}px system-ui`; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (let db = 0; db >= -70; db -= 10) { const y = Y(db); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(db, W - 3 * dpr, y); }
    ctx.textAlign = "left";

    const len = histIn.length;
    const colsPerSec = (engine.sampleRate || 48000) / 128; // one trace pair per 128-sample quantum
    const vc = clamp(Math.round((zoomMs / 1000) * colsPerSec), 8, Math.max(8, len));
    if (len > 1) {
      const start = len - vc, drawN = Math.min(vc, MAXDRAW);
      const inV = new Float32Array(drawN), redV = new Float32Array(drawN);
      for (let k = 0; k < drawN; k++) {
        const lo = start + Math.floor((k * vc) / drawN); let hi = start + Math.floor(((k + 1) * vc) / drawN); if (hi <= lo) hi = lo + 1;
        let im = -200, rm = 0;
        for (let i = lo; i < hi && i < len; i++) { if (histIn[i] > im) im = histIn[i]; if (histRed[i] > rm) rm = histRed[i]; }
        inV[k] = im; redV[k] = rm;
      }
      const xAt = (k) => (drawN <= 1 ? W : (k / (drawN - 1)) * W);
      const outAt = (k) => inV[k] - redV[k]; // de-reverbed level
      // input level mountain
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "rgba(120,170,225,0.40)"); grad.addColorStop(1, "rgba(70,110,165,0.07)");
      ctx.beginPath(); ctx.moveTo(xAt(0), H);
      for (let k = 0; k < drawN; k++) ctx.lineTo(xAt(k), Y(inV[k]));
      ctx.lineTo(xAt(drawN - 1), H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      // removed reverb (red) = between output and input
      ctx.beginPath();
      for (let k = 0; k < drawN; k++) ctx.lineTo(xAt(k), Y(inV[k]));
      for (let k = drawN - 1; k >= 0; k--) ctx.lineTo(xAt(k), Y(outAt(k)));
      ctx.closePath(); ctx.fillStyle = "rgba(229,86,75,0.5)"; ctx.fill();
      // output (de-reverbed) line
      ctx.beginPath();
      for (let k = 0; k < drawN; k++) { const x = xAt(k), y = Y(outAt(k)); k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.strokeStyle = "rgba(150,205,175,0.85)"; ctx.lineWidth = 1.3 * dpr; ctx.stroke();
    }
    ctx.textBaseline = "top"; ctx.font = `${10 * dpr}px system-ui`;
    ctx.fillStyle = "rgba(150,200,255,0.85)"; ctx.fillText("input", 6 * dpr, 4 * dpr);
    ctx.fillStyle = "rgba(255,140,130,0.95)"; ctx.fillText("reverb removed", 46 * dpr, 4 * dpr);
    ctx.fillStyle = "rgba(150,205,175,0.95)"; ctx.fillText("output", 150 * dpr, 4 * dpr);

    const gr = Math.max(0, me.gr || 0);
    grHold = gr > grHold ? gr : grHold * 0.9 + gr * 0.1;
    grFill.style.height = clamp(gr / 24, 0, 1) * 100 + "%";
    grVal.textContent = gr.toFixed(1);
  };
}

// ===================== Auto Gain (loudness leveler) =====================
// Auto-Gain setup form: pick a standard target + measure the program loudness.
let agModalEl = null;
const agAnAid = {}; // module id -> last applied measurement id
function closeAgForm() { if (agModalEl) { agModalEl.remove(); agModalEl = null; } }
function setAgTarget(m, v) { const inp = document.getElementById("k_target"); if (inp) { inp.value = v; inp.dispatchEvent(new Event("input")); } if (agModalEl) markAgTargets(m); }
function markAgTargets(m) { if (agModalEl) agModalEl.querySelectorAll(".ag-target").forEach((b) => b.classList.toggle("on", Math.abs(parseFloat(b.dataset.t) - m.target) < 0.01)); }
function showAgMeasured(m, an) {
  if (!agModalEl) return;
  const out = agModalEl.querySelector("#agMeasured"), meas = agModalEl.querySelector("#agMeasure");
  if (meas) { meas.disabled = false; meas.textContent = "▶ Measure (5s)"; }
  if (!out) return;
  if (an.n > 50 && an.lufs > -120) {
    const gap = m.target - an.lufs; // + = the content needs a boost to reach the target
    const need = Math.min(36, Math.max(3, Math.ceil(Math.abs(gap)) + 3)); // Max gain that covers it, with headroom
    const dir = Math.abs(gap) < 0.5 ? "right at your target" : `${Math.abs(gap).toFixed(1)} dB ${gap > 0 ? "under" : "over"} your ${m.target} LUFS target`;
    const reach = Math.abs(gap) <= m.range;
    out.innerHTML = `
      <div class="ag-result">
        <div class="ag-meas">Measured <b>${an.lufs.toFixed(1)} LUFS</b> - ${dir}.</div>
        <div class="ag-reach">${reach ? "Your current Max gain can already reach it ✓" : `It needs about ${Math.abs(gap).toFixed(0)} dB to get there, but Max gain is only ±${m.range} dB.`}</div>
        <button class="ag-apply" id="agApply">Set Max gain to reach target (±${need} dB)</button>
      </div>`;
    const ab = agModalEl.querySelector("#agApply");
    if (ab) ab.addEventListener("click", () => {
      const inp = document.getElementById("k_range");
      if (inp) { inp.value = need; inp.dispatchEvent(new Event("input")); }
      ab.textContent = `Max gain set to ±${need} dB ✓`; ab.classList.add("done"); ab.disabled = true;
    });
  } else out.textContent = "Couldn't measure - is audio playing? Play a few seconds and measure again.";
}
function openAgForm(m) {
  closeAgForm();
  const T = [["-14", "Streaming", "Spotify · YouTube · Apple Music"], ["-16", "Podcast / Voice", "spoken-word standard"], ["-23", "Broadcast", "EBU R128 / TV"], ["-12", "Loud", "punchy, club-style"]];
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  ov.innerHTML = `
    <div class="modal" style="width:min(560px,100%)">
      <div class="modal-head"><h2>Auto-Gain setup</h2><button class="modal-x" title="Close">✕</button></div>
      <div class="modal-body">
        <div class="form-step">1 &middot; Target loudness</div>
        <div class="ag-targets">${T.map(([v, l, d]) => `<button class="ag-target" data-t="${v}"><b>${l}</b><span>${v} LUFS</span><small>${d}</small></button>`).join("")}</div>
        <div class="form-step">2 &middot; Measure &amp; reach it</div>
        <p class="hint" style="font-style:normal; margin:0 0 10px">Play a representative few seconds and measure the program loudness - we'll show how far it is from your target and set enough Max gain to get there.</p>
        <button id="agMeasure" class="ed-toggle">▶ Measure (5s)</button>
        <div id="agMeasured" class="hint" style="font-style:normal; margin-top:12px">Not measured yet.</div>
      </div>
      <div class="modal-foot"><button id="agDone" class="primary">Done</button><span class="modal-hint">Target also lives on the knob - this is a quick chooser.</span></div>
    </div>`;
  document.body.appendChild(ov);
  agModalEl = ov;
  ov.querySelectorAll(".ag-target").forEach((b) => b.addEventListener("click", () => setAgTarget(m, parseFloat(b.dataset.t))));
  markAgTargets(m);
  ov.querySelector(".modal-x").addEventListener("click", closeAgForm);
  ov.querySelector("#agDone").addEventListener("click", closeAgForm);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeAgForm(); });
  const meas = ov.querySelector("#agMeasure"), out = ov.querySelector("#agMeasured");
  meas.addEventListener("click", () => {
    if (selectedTab == null) { out.textContent = "Capture a tab first."; return; }
    send({ type: "set-param", tabId: selectedTab, id: m.id, params: { analyze: 5 } });
    meas.disabled = true; out.textContent = "Listening…";
    let left = 5; meas.textContent = `Listening ${left}s…`;
    const iv = setInterval(() => { left--; meas.textContent = left > 0 ? `Listening ${left}s…` : "Measuring…"; if (left <= 0) clearInterval(iv); }, 1000);
    setTimeout(() => { if (meas.disabled) { meas.disabled = false; meas.textContent = "▶ Measure (5s)"; } }, 6500);
  });
}

function renderAutoGain(m) {
  m.target = m.target ?? -16; m.speed = m.speed ?? 50; m.range = m.range ?? 12; m.gate = m.gate ?? -45; m.zoom = m.zoom ?? 8000;
  edEl.innerHTML = `
    ${edHead(m.name, "Loudness leveler", `<button id="agSetup" class="ed-toggle" title="Pick a standard target and measure your content's loudness">⚙ Target &amp; analyze</button>`)}
    <div class="lim-graph" style="display:flex; flex-direction:column; gap:8px">
      <div class="graphwrap" title="Input loudness (blue) vs the leveled output (green) over time, with the target (dashed). The output rides toward the target; the shaded gap is the gain being applied."><canvas id="agCanvas"></canvas></div>
      <label class="hint" style="display:flex; align-items:center; gap:8px">Zoom
        <input type="range" id="agZoom" min="2000" max="30000" step="500" value="${m.zoom}" style="flex:1">
        <span id="agZoomV" style="min-width:44px; text-align:right">${Math.round(m.zoom / 1000)} s</span>
      </label>
    </div>
    <div class="knobs" style="max-width:640px; margin-top:14px; grid-template-columns:repeat(4,1fr)">
      ${knob("target", "Target", m.target, -30, -6, 0.5, " LUFS")}
      ${knob("speed", "Speed", m.speed, 0, 100, 1, "")}
      ${knob("range", "Max gain", m.range, 0, 36, 1, " dB")}
      ${knob("gate", "Gate", m.gate, -70, -20, 1, " LUFS")}
    </div>
    <p class="hint" id="agReadout" style="margin-top:12px; font-style:normal">Listening…</p>`;
  wireKnobs(m, ["target", "speed", "range", "gate"]);
  document.getElementById("agSetup").addEventListener("click", () => openAgForm(m));
  const tip = (key, t) => { const e = document.getElementById("k_" + key); if (e) e.closest(".knob").title = t; };
  tip("target", "The loudness to aim for (LUFS). Around -16 suits general listening; lower targets are louder. Matches the Limiter's LUFS meter.");
  tip("speed", "How quickly it adapts. Lower = album-style (rides slowly, preserves dynamics); higher = dialog-style (levels fast). Boosting is always slower than cutting.");
  tip("range", "The maximum the gain will move, up or down (± dB). Big boosts are safe - a built-in brick-wall limiter at -1 dBFS keeps the output from ever clipping.");
  tip("gate", "Below this loudness the gain freezes, so it never pumps up silence or background noise between sounds.");

  const canvas = document.getElementById("agCanvas");
  const dims = makeCanvas(canvas, 0.42);
  const ctx = canvas.getContext("2d");
  const readout = document.getElementById("agReadout");
  const zoomEl = document.getElementById("agZoom"), zoomV = document.getElementById("agZoomV");
  let zoomMs = m.zoom;
  function setZoom(v) { zoomMs = clamp(Math.round(v), 2000, 30000); m.zoom = zoomMs; zoomEl.value = zoomMs; zoomV.textContent = Math.round(zoomMs / 1000) + " s"; save(); }
  zoomEl.addEventListener("input", () => setZoom(+zoomEl.value));
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoomMs * (e.deltaY > 0 ? 1.15 : 1 / 1.15)); }, { passive: false });

  const DBMIN = -50, DBMAX = 0, MAXHIST = 6500, MAXDRAW = 1200;
  const histL = [], histG = []; // input loudness (LUFS) + applied gain (dB)
  currentDraw = function () {
    const { W, H, dpr } = dims();
    const me = (engine.meters && engine.meters[m.id]) || {};
    if (agModalEl && me.analysis && agAnAid[m.id] !== me.analysis.aid) { agAnAid[m.id] = me.analysis.aid; showAgMeasured(m, me.analysis); }
    if (engine.running && me.trace) for (const pr of me.trace) { histL.push(pr[0]); histG.push(pr[1]); }
    if (histL.length > MAXHIST) { const ex = histL.length - MAXHIST; histL.splice(0, ex); histG.splice(0, ex); }

    const Y = (db) => (1 - (clamp(db, DBMIN, DBMAX) - DBMIN) / (DBMAX - DBMIN)) * H;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "#1c2430"; ctx.lineWidth = 1 * dpr; ctx.fillStyle = "#3a4452"; ctx.font = `${10 * dpr}px system-ui`; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (let db = 0; db >= -50; db -= 10) { const y = Y(db); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(db, W - 3 * dpr, y); }
    ctx.textAlign = "left";
    // target line
    const ty = Y(m.target);
    ctx.strokeStyle = "rgba(255,180,84,0.6)"; ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(W, ty); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,180,84,0.85)"; ctx.textBaseline = "top"; ctx.fillText("target " + m.target.toFixed(0) + " LUFS", 6 * dpr, ty + 3 * dpr);

    const len = histL.length;
    const colsPerSec = (engine.sampleRate || 48000) / 256; // one trace pair per 256-sample step
    const vc = clamp(Math.round((zoomMs / 1000) * colsPerSec), 8, Math.max(8, len));
    let lastL = -120, lastG = 0;
    if (len > 1) {
      const start = len - vc, drawN = Math.min(vc, MAXDRAW);
      const inV = new Float32Array(drawN), gV = new Float32Array(drawN);
      for (let k = 0; k < drawN; k++) {
        const idx = Math.min(len - 1, start + Math.floor(((k + 0.5) * vc) / drawN));
        inV[k] = histL[idx]; gV[k] = histG[idx];
      }
      const xAt = (k) => (drawN <= 1 ? W : (k / (drawN - 1)) * W);
      const outAt = (k) => inV[k] + gV[k];
      // gap between input and output = the gain applied
      ctx.beginPath();
      for (let k = 0; k < drawN; k++) ctx.lineTo(xAt(k), Y(inV[k]));
      for (let k = drawN - 1; k >= 0; k--) ctx.lineTo(xAt(k), Y(outAt(k)));
      ctx.closePath(); ctx.fillStyle = "rgba(54,163,255,0.12)"; ctx.fill();
      // input loudness line
      ctx.beginPath();
      for (let k = 0; k < drawN; k++) { const x = xAt(k), y = Y(inV[k]); k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.strokeStyle = "rgba(120,180,235,0.7)"; ctx.lineWidth = 1.1 * dpr; ctx.stroke();
      // leveled output line
      ctx.beginPath();
      for (let k = 0; k < drawN; k++) { const x = xAt(k), y = Y(outAt(k)); k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.strokeStyle = "rgba(120,232,160,0.95)"; ctx.lineWidth = 1.6 * dpr; ctx.stroke();
      lastL = histL[len - 1]; lastG = histG[len - 1];
    }
    ctx.textBaseline = "top"; ctx.font = `${10 * dpr}px system-ui`;
    ctx.fillStyle = "rgba(150,200,255,0.85)"; ctx.fillText("input", 6 * dpr, 4 * dpr);
    ctx.fillStyle = "rgba(120,232,160,0.95)"; ctx.fillText("leveled output", 46 * dpr, 4 * dpr);

    if (engine.running && lastL > -100) {
      readout.innerHTML = `Gain <b>${lastG >= 0 ? "+" : ""}${lastG.toFixed(1)} dB</b> &nbsp;·&nbsp; In <b>${lastL.toFixed(1)} LUFS</b> → <b>${(lastL + lastG).toFixed(1)}</b> (target ${m.target.toFixed(0)})`;
    } else readout.textContent = engine.running ? "Listening for signal…" : "Engine idle";
  };
}

// ===================== Analyzer (spectrogram) =====================
function renderAnalyzer(m) {
  // back-fill defaults for racks saved before these controls existed
  m.speed = m.speed ?? 2; m.smooth = m.smooth ?? 0.5; m.ceiling = m.ceiling ?? -20;
  m.range = m.range ?? 75; m.contrast = m.contrast ?? 1.6; m.colormap = m.colormap ?? "magma";
  m.fMin = m.fMin ?? 20; m.fMax = m.fMax ?? 20000; m.grid = m.grid ?? true;
  m.sharpen = m.sharpen ?? 0.6; m.view = m.view ?? "spectro"; m.wfTilt = m.wfTilt ?? 0.6; m.wfSpeed = m.wfSpeed ?? 1.5; m.q = m.q ?? 20; m.fft = m.fft ?? 16384;

  edEl.innerHTML = `
    ${edHead(m.name, "Spectrogram")}
    <div class="graphwrap"><canvas id="sgCanvas"></canvas><button id="sgFull" class="sg-icon-btn" title="Fullscreen visualizer">⛶</button><button id="wfReset" class="wf-reset" title="Reset 3D angle">⟳ angle</button></div>
    <div class="toolbar sg-tools">
      <div class="tb-group"><span class="tb-gl">Display</span>
        <label class="inlineknob">View <select id="s_view">
          <option value="spectro" ${m.view !== "waterfall" ? "selected" : ""}>Spectrogram</option>
          <option value="waterfall" ${m.view === "waterfall" ? "selected" : ""}>3D Waterfall</option>
        </select></label>
        ${selectCtl("colormap", "Color", m.colormap, Object.keys(COLORMAPS))}
        ${checkCtl("grid", "Grid", m.grid)}
      </div>
      <div class="tb-group"><span class="tb-gl">Time</span>
        <span id="spdSpectro">${knobInline("speed", "Speed", m.speed, 1, 12, 1, " px")}</span>
        <span id="spdWf">${knobInline("wfSpeed", "Flow", m.wfSpeed, 0.1, 6, 0.1, " ×")}</span>
        ${knobInline("smooth", "Smooth", m.smooth, 0, 0.95, 0.05, "")}
      </div>
      <div class="tb-group"><span class="tb-gl">Frequency</span>
        ${selectCtl("fft", "FFT", String(m.fft), ["2048", "4096", "8192", "16384", "32768"])}
        ${knobInline("q", "Resolution", m.q, 6, 40, 1, "")}
        ${knobInline("fMin", "Min f", m.fMin, 20, 2000, 5, " Hz")}
        ${knobInline("fMax", "Max f", m.fMax, 1000, 20000, 100, " Hz")}
      </div>
      <div class="tb-group"><span class="tb-gl">Level</span>
        ${knobInline("ceiling", "Top", m.ceiling, -60, 0, 1, " dB")}
        ${knobInline("range", "Range", m.range, 30, 130, 5, " dB")}
        ${knobInline("contrast", "Contrast", m.contrast, 0.5, 4, 0.1, "")}
        <span id="ctlSharpen">${knobInline("sharpen", "Sharpen", m.sharpen, 0, 2, 0.1, "")}</span>
      </div>
    </div>`;
  wireKnobs(m, ["speed", "wfSpeed", "smooth", "sharpen", "q", "ceiling", "range", "contrast", "fMin", "fMax"]);
  const wfResetBtn = document.getElementById("wfReset");
  const spdSpectro = document.getElementById("spdSpectro"), spdWf = document.getElementById("spdWf");
  const ctlSharpen = document.getElementById("ctlSharpen");
  const applyViewUI = () => {
    const wfm = m.view === "waterfall";
    wfResetBtn.style.display = wfm ? "block" : "none";
    spdSpectro.style.display = wfm ? "none" : "";
    spdWf.style.display = wfm ? "" : "none";
    ctlSharpen.style.display = wfm ? "none" : ""; // unsharp is a 2D-spectrogram cleanup; subtle in 3D
  };
  document.getElementById("s_view").addEventListener("change", (e) => { m.view = e.target.value; save(); applyViewUI(); });
  document.getElementById("s_fft").addEventListener("change", (e) => { m.fft = Number(e.target.value); save(); });
  document.getElementById("s_colormap").addEventListener("change", (e) => { m.colormap = e.target.value; save(); });
  document.getElementById("c_grid").addEventListener("change", (e) => { m.grid = e.target.checked; save(); });
  wfResetBtn.addEventListener("click", () => { m.wfTilt = 0.6; save(); });
  document.getElementById("sgFull").addEventListener("click", () => {
    const gw = document.getElementById("sgCanvas").parentElement;
    if (document.fullscreenElement) document.exitFullscreen(); else gw.requestFullscreen();
  });
  applyViewUI();

  const canvas = document.getElementById("sgCanvas");
  const ctx = canvas.getContext("2d");

  // History lives in an offscreen buffer so the frequency axis can be drawn on
  // top each frame without smearing.
  let buf = null, bctx = null;
  let ema = null, sharpBuf = null; // temporal average + unsharp scratch
  let hover = null;
  const WF_DEPTH = 46; let wf = [], pending = [], wfAcc = 0; // 3D-waterfall history + inflow queue + fractional advance
  const dims = makeCanvas(canvas, 0.5, (W, H) => {
    buf = document.createElement("canvas"); buf.width = W; buf.height = H;
    bctx = buf.getContext("2d");
    bctx.fillStyle = "#05070a"; bctx.fillRect(0, 0, W, H);
  });
  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect(); const { dpr } = dims();
    hover = [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
  });
  canvas.addEventListener("mouseleave", () => { hover = null; });
  // drag to tilt the 3D waterfall (vertical drag = angle)
  let angleDrag = null;
  canvas.addEventListener("mousedown", (e) => { if (m.view === "waterfall") angleDrag = e.clientY; });
  const onAngleMove = (e) => {
    if (angleDrag == null) return;
    m.wfTilt = clamp((m.wfTilt ?? 0.6) - (e.clientY - angleDrag) * 0.004, 0.15, 1.1);
    angleDrag = e.clientY;
  };
  const onAngleUp = () => { if (angleDrag != null) { angleDrag = null; save(); } };
  window.addEventListener("mousemove", onAngleMove);
  window.addEventListener("mouseup", onAngleUp);
  viewCleanup = () => { window.removeEventListener("mousemove", onAngleMove); window.removeEventListener("mouseup", onAngleUp); };

  currentDraw = function () {
    const { W, H, dpr } = dims();
    if (!buf) return;
    const lut = LUTS[m.colormap] || LUTS.magma;
    // display frequency window (guarded so min stays below max)
    const fLo = clamp(Math.min(m.fMin, m.fMax - 50), 20, 19950);
    const fHi = clamp(Math.max(m.fMax, fLo + 50), 70, 20000);

    // keep the session's FFT size in sync with this analyzer's setting (once per change)
    // keep the engine's analysis window (FFT) + Q in sync (cheap; re-sends a frame or two until matched)
    if (engine.running && engine.fft && engine.fft !== m.fft) send({ type: "set-fft", tabId: selectedTab, fft: m.fft });
    if (engine.running && engine.q != null && engine.q !== m.q) send({ type: "set-q", tabId: selectedTab, q: m.q });

    if (m.view === "waterfall") { drawWaterfall(W, H, dpr, lut, fLo, fHi); return; }

    // Draw EVERY STFT column produced since the last frame -> a real time axis,
    // independent of the 60 fps render rate. Each column scrolls the history by
    // `speed` px, so bigger FFT sharpens frequency without smearing time.
    const cols = engine.running ? engine.cols : null;
    if (cols && cols.length) {
      const speed = Math.max(1, Math.round(m.speed * dpr));
      const top = m.ceiling, floor = top - m.range, invSpan = 1 / (top - floor);
      const gamma = m.contrast, sh = m.sharpen, a = m.smooth;

      for (let c = 0; c < cols.length; c++) {
        const s = cols[c], n = s.length;
        // temporal EMA across columns -> tames flicker grain
        if (!ema || ema.length !== n) { ema = new Float32Array(n); for (let k = 0; k < n; k++) ema[k] = s[k]; }
        if (a > 0) for (let k = 0; k < n; k++) ema[k] += (s[k] - ema[k]) * (1 - a);
        else for (let k = 0; k < n; k++) ema[k] = s[k];

        // unsharp mask in the log-frequency domain -> thins fuzzy tonal lines
        let src = ema;
        if (sh > 0) {
          if (!sharpBuf || sharpBuf.length !== n) sharpBuf = new Float32Array(n);
          for (let k = 0; k < n; k++) {
            const lo = ema[k > 0 ? k - 1 : 0], hi = ema[k < n - 1 ? k + 1 : n - 1];
            sharpBuf[k] = ema[k] + sh * (ema[k] - (lo + ema[k] + hi) / 3);
          }
          src = sharpBuf;
        }

        const A = ((Math.log(fLo) - LOG_MIN) / LOG_SPAN) * (n - 1);
        const B = (Math.log(fHi / fLo) / LOG_SPAN) * (n - 1);

        bctx.drawImage(buf, speed, 0, W - speed, H, 0, 0, W - speed, H); // scroll left
        const colImg = bctx.createImageData(speed, H);
        const data = colImg.data;
        for (let y = 0; y < H; y++) {
          const p = (H - 1 - y) / (H - 1);
          let fk = A + B * p; if (fk < 0) fk = 0; else if (fk > n - 1) fk = n - 1;
          const k0 = fk | 0, fr = fk - k0;
          const dB = src[k0] + (src[Math.min(n - 1, k0 + 1)] - src[k0]) * fr;
          let t = (dB - floor) * invSpan; t = t < 0 ? 0 : t > 1 ? 1 : t;
          t = Math.pow(t, gamma);
          const idx = (t * 255) | 0;
          const r = lut[idx * 3], g = lut[idx * 3 + 1], b = lut[idx * 3 + 2];
          for (let x = 0; x < speed; x++) { const o = (y * speed + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; }
        }
        bctx.putImageData(colImg, W - speed, 0);
      }
    }

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(buf, 0, 0);
    if (m.grid) drawSpecAxis(ctx, W, H, dpr, fLo, fHi);

    if (hover) {
      const p = clamp((H - 1 - hover[1]) / (H - 1), 0, 1);
      const f = fLo * Math.pow(fHi / fLo, p); // frequency at the cursor's Y
      const lines = [fmtFreq(f)];
      if (ema && ema.length) {
        const n = ema.length;
        const idx = clamp(((Math.log(f) - LOG_MIN) / LOG_SPAN) * (n - 1), 0, n - 1);
        lines.push(Math.round(ema[idx | 0]) + " dB");
      }
      drawCursor(ctx, W, H, dpr, hover[0], hover[1], lines);
    }
  };

  // 3D waterfall: a perspective stack of recent spectrum rows, newest at front
  // (aligned to the bottom of the window). Speed = rows/frame; drag = tilt angle.
  function drawWaterfall(W, H, dpr, lut, fLo, fHi) {
    // ingest + process incoming columns (Smooth + Sharpen apply here too)
    if (engine.running && engine.cols && engine.cols.length) {
      for (const col of engine.cols) {
        const n = col.length;
        if (!ema || ema.length !== n) { ema = new Float32Array(n); for (let k = 0; k < n; k++) ema[k] = col[k]; }
        const a = m.smooth;
        if (a > 0) for (let k = 0; k < n; k++) ema[k] += (col[k] - ema[k]) * (1 - a);
        else for (let k = 0; k < n; k++) ema[k] = col[k];
        let srcA = ema;
        if (m.sharpen > 0) {
          if (!sharpBuf || sharpBuf.length !== n) sharpBuf = new Float32Array(n);
          for (let k = 0; k < n; k++) { const lo = ema[k > 0 ? k - 1 : 0], hi = ema[k < n - 1 ? k + 1 : n - 1]; sharpBuf[k] = ema[k] + m.sharpen * (ema[k] - (lo + ema[k] + hi) / 3); }
          srcA = sharpBuf;
        }
        pending.push(Float32Array.from(srcA));
      }
      if (pending.length > 240) pending.splice(0, pending.length - 240); // bound lag
    }
    // fractional flow: advance `wfSpeed` rows per frame (supports < 1 = slow motion)
    wfAcc += m.wfSpeed;
    while (wfAcc >= 1 && pending.length) { wf.push(pending.shift()); if (wf.length > WF_DEPTH) wf.shift(); wfAcc -= 1; }
    if (wfAcc > 4) wfAcc = 4; // don't bank a huge backlog when the queue runs dry

    const tilt = m.wfTilt ?? 0.6;
    const top = m.ceiling, floor = top - m.range, invSpan = 1 / (top - floor), gamma = m.contrast;
    const logLoF = Math.log(fLo), logSpanF = Math.log(fHi / fLo), step = Math.max(2, Math.round(2 * dpr));
    const frontBase = H * 0.98, backBase = H * 0.98 - H * 0.7 * tilt; // newest aligns to bottom
    const FREQS = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const xAt = (fp, t) => { const persp = 0.40 + 0.60 * t; return (W * (1 - persp)) / 2 + fp * W * persp; };

    // background: subtle vertical gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#05070b"); bg.addColorStop(0.55, "#080b12"); bg.addColorStop(1, "#0e1320");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // perspective frequency grid (floor lines that converge into the distance) - behind the rows
    if (m.grid) {
      ctx.strokeStyle = "rgba(120,140,170,0.12)"; ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(xAt(0, 0), backBase); ctx.lineTo(xAt(1, 0), backBase); // horizon
      FREQS.forEach((f) => {
        if (f < fLo || f > fHi) return;
        const fp = (Math.log(f) - logLoF) / logSpanF;
        ctx.moveTo(xAt(fp, 0), backBase); ctx.lineTo(xAt(fp, 1), frontBase);
      });
      ctx.stroke();
    }

    // rows: back (oldest) first for painter occlusion. One gradient fill per row
    // (height fraction == magnitude, so the colour matches the spectrogram) - fast.
    const N = wf.length;
    for (let j = 0; j < N; j++) {
      const col = wf[j], n = col.length;
      let t = (WF_DEPTH - N + j) / (WF_DEPTH - 1); if (t < 0) t = 0; // newest -> ~1 (front)
      const persp = 0.40 + 0.60 * t, xOff = (W * (1 - persp)) / 2, wpx = W * persp;
      const baseY = backBase + (frontBase - backBase) * t, ampH = H * 0.42 * persp * (0.5 + 0.7 * tilt);
      const dim = 0.5 + 0.5 * t; // distance only dims (atmosphere); colour = magnitude

      ctx.beginPath(); ctx.moveTo(xOff, baseY);
      for (let sx = 0; sx <= wpx; sx += step) {
        const fk = ((logLoF + logSpanF * (sx / wpx)) - LOG_MIN) / LOG_SPAN * (n - 1);
        const k = fk < 0 ? 0 : fk > n - 1 ? n - 1 : fk | 0;
        let v = (col[k] - floor) * invSpan; v = v < 0 ? 0 : v > 1 ? 1 : v; v = Math.pow(v, gamma);
        ctx.lineTo(xOff + sx, baseY - v * ampH);
      }
      ctx.lineTo(xOff + wpx, baseY); ctx.closePath();

      const grd = ctx.createLinearGradient(0, baseY, 0, baseY - ampH);
      for (let s = 0; s <= 8; s++) {
        const f = s / 8, ci = (f * 255) | 0;
        grd.addColorStop(f, `rgb(${(lut[ci * 3] * dim) | 0},${(lut[ci * 3 + 1] * dim) | 0},${(lut[ci * 3 + 2] * dim) | 0})`);
      }
      ctx.fillStyle = grd; ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${0.10 * dim})`; ctx.lineWidth = 1 * dpr; ctx.stroke();
    }

    // frequency labels along the bottom, aligned with the grid's front edge
    if (m.grid) {
      ctx.fillStyle = "rgba(190,200,215,0.7)"; ctx.font = `${10 * dpr}px system-ui`; ctx.textBaseline = "bottom";
      ctx.textAlign = "center";
      FREQS.forEach((f) => {
        if (f < fLo || f > fHi) return;
        const x = xAt((Math.log(f) - logLoF) / logSpanF, 1);
        ctx.fillText(f >= 1000 ? f / 1000 + "k" : f, x, H - 1);
      });
      ctx.textAlign = "left";
    }
  }
}
