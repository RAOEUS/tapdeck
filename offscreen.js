// Audio engine. Runs ONE independent session per captured tab - each with its
// own AudioContext, capture stream, rack, and analyser:
//
//   tab A:  source -> [A's modules] -> analyser -> destination
//   tab B:  source -> [B's modules] -> analyser -> destination
//
// The editor is the source of truth for each tab's rack; messages carry a tabId
// so they reach the right session. poll(tabId) returns that session's data plus
// the list of all active sessions (for the tab switcher).

const WORKLETS = {
  eq: "worklet/eq-processor.js",
  comp: "worklet/comp-processor.js",
  limiter: "worklet/limiter-processor.js",
  utility: "worklet/utility-processor.js",
  mbcomp: "worklet/mbcomp-processor.js",
  sat: "worklet/sat-processor.js",
  trans: "worklet/trans-processor.js",
  gate: "worklet/gate-processor.js",
  denoise: "worklet/denoise-processor.js",
  spectrum: "worklet/spectrum-processor.js",
};
const PROCESSOR = {
  eq: "eq-processor", comp: "comp-processor", limiter: "limiter-processor",
  utility: "utility-processor", mbcomp: "mbcomp-processor",
  sat: "sat-processor", trans: "trans-processor", gate: "gate-processor", denoise: "denoise-processor",
};

const FREQ_MIN = 20, FREQ_MAX = 20000, LOGN = 2048;
const VALID_FFT = new Set([2048, 4096, 8192, 16384, 32768]);

// ---- FFT runs here, on the offscreen main thread (NOT the audio thread) ----
function buildFFT(n) {
  const levels = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let x = i, r = 0; for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r >>> 0; }
  const cos = new Float32Array(n >> 1), sin = new Float32Array(n >> 1);
  for (let i = 0; i < (n >> 1); i++) { const a = (-2 * Math.PI * i) / n; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  return { n, rev, cos, sin };
}
function fftInplace(p, re, im) {
  const { n, rev, cos, sin } = p;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0, j = 0; k < half; k++, j += step) {
        const l = i + k, r = l + half, c = cos[j], s = sin[j];
        const tre = re[r] * c - im[r] * s, tim = re[r] * s + im[r] * c;
        re[r] = re[l] - tre; im[r] = im[l] - tim; re[l] += tre; im[l] += tim;
      }
    }
  }
}
// Constant-Q multi-resolution STFT: the time/frequency tradeoff is set by WINDOW
// length, so we choose a window PER FREQUENCY such that each holds ~MR_CYCLES
// cycles - long windows for lows (sharp harmonics), short for highs (tight
// transients), smoothly across the whole range (no hard tier seams). Available
// windows are powers of two from 256 up to the FFT control (L0); raising L0
// extends how low you can resolve. `frame` holds the newest L0 samples; smaller
// windows read its newest tail.
const MR_CYCLES = 20; // target cycles per window (the "Q")

// bin-read recipe for one window size at a log point (peak over a range, or interp)
function binRecipe(L, sr, f, fLo, fHi) {
  const N = L / 2, binLo = (fLo * L) / sr, binHi = (fHi * L) / sr;
  if (binHi - binLo >= 1) return { peak: true, lo: Math.max(1, Math.floor(binLo)), hi: Math.min(N - 1, Math.ceil(binHi)) };
  const fb = (f * L) / sr, b0 = Math.max(1, Math.min(N - 2, Math.floor(fb)));
  return { peak: false, b0, frac: fb - b0 };
}
function evalRecipe(rec, re, im, norm) {
  if (rec.peak) {
    let mx = 0;
    for (let b = rec.lo; b <= rec.hi; b++) { const m = re[b] * re[b] + im[b] * im[b]; if (m > mx) mx = m; }
    return 10 * Math.log10(mx * norm * norm + 1e-12);
  }
  const b0 = rec.b0;
  const m0 = Math.sqrt(re[b0] * re[b0] + im[b0] * im[b0]);
  const m1 = Math.sqrt(re[b0 + 1] * re[b0 + 1] + im[b0 + 1] * im[b0 + 1]);
  return 20 * Math.log10((m0 + (m1 - m0) * rec.frac) * norm + 1e-12);
}

function makeMRCtx(L0, sr, q) {
  const sizes = [];
  for (let L = 256; L <= L0; L <<= 1) sizes.push(L);
  if (!sizes.length) sizes.push(L0);
  const bySize = new Map();
  for (const L of sizes) {
    const win = new Float32Array(L); let ws = 0;
    for (let i = 0; i < L; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1)); win[i] = w; ws += w; }
    bySize.set(L, { L, win, norm: 2 / ws, re: new Float32Array(L), im: new Float32Array(L), fftp: buildFFT(L) });
  }
  const logMin = Math.log(FREQ_MIN), logSpan = Math.log(FREQ_MAX / FREQ_MIN);
  const minL = sizes[0], maxL = sizes[sizes.length - 1];
  const points = new Array(LOGN);
  for (let k = 0; k < LOGN; k++) {
    const f = Math.exp(logMin + (logSpan * k) / (LOGN - 1));
    const fLo = Math.exp(logMin + (logSpan * (k - 0.5)) / (LOGN - 1));
    const fHi = Math.exp(logMin + (logSpan * (k + 0.5)) / (LOGN - 1));
    let ideal = (q * sr) / f;
    if (ideal < minL) ideal = minL; if (ideal > maxL) ideal = maxL;
    // BLEND between the two bracketing window sizes -> no hard seams between bands
    let aSize = sizes[0], bSize = sizes[0];
    for (let i = 0; i < sizes.length; i++) if (sizes[i] <= ideal) aSize = sizes[i];
    for (let i = sizes.length - 1; i >= 0; i--) if (sizes[i] >= ideal) bSize = sizes[i];
    const w = aSize === bSize ? 0 : (Math.log(ideal) - Math.log(aSize)) / (Math.log(bSize) - Math.log(aSize));
    points[k] = { aSize, bSize, w, aRec: binRecipe(aSize, sr, f, fLo, fHi), bRec: binRecipe(bSize, sr, f, fLo, fHi) };
  }
  return { L0, q, sizes, bySize, points, col: new Float32Array(LOGN) };
}

function computeColumn(s, n, frame) {
  const q = s.mrQ || MR_CYCLES;
  if (!s.mr || s.mr.L0 !== n || s.mr.q !== q) s.mr = makeMRCtx(n, s.ctx.sampleRate, q);
  const mr = s.mr;

  // one FFT per distinct window size, taken from the newest tail of the frame.
  // Subtract the segment mean first: an untreated DC offset / sub-sonic rumble
  // leaks through the Hann window into the lowest bins and shows as phantom bass.
  for (const fd of mr.bySize.values()) {
    const L = fd.L, off = n - L, re = fd.re, im = fd.im, win = fd.win;
    let mean = 0;
    for (let i = 0; i < L; i++) mean += frame[off + i];
    mean /= L;
    for (let i = 0; i < L; i++) { re[i] = (frame[off + i] - mean) * win[i]; im[i] = 0; }
    fftInplace(fd.fftp, re, im);
  }

  // assemble the log column, blending the two bracketing resolutions
  const col = mr.col, pts = mr.points;
  for (let k = 0; k < LOGN; k++) {
    const p = pts[k], fa = mr.bySize.get(p.aSize);
    const va = evalRecipe(p.aRec, fa.re, fa.im, fa.norm);
    if (p.w === 0) { col[k] = va; continue; }
    const fb = mr.bySize.get(p.bSize);
    col[k] = va + (evalRecipe(p.bRec, fb.re, fb.im, fb.norm) - va) * p.w;
  }
  const out = Array.from(col);
  s.lastCol = out; s.cols.push(out);
  if (s.cols.length > 64) s.cols.shift();
}

const sessions = new Map(); // tabId -> session object

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  switch (msg.type) {
    case "start-capture":
      startCapture(msg.streamId, msg.tab, msg.rack).catch((e) => console.error("[offscreen]", e));
      break;
    case "stop-capture":
      stopCapture(msg.tabId);
      break;
    case "sync": {
      const s = sessions.get(msg.tabId);
      if (s) {
        applyStructure(s, msg.structure || []);
        for (const [id, p] of Object.entries(msg.params || {})) setParam(s, id, p);
      }
      break;
    }
    case "set-param": {
      const s = sessions.get(msg.tabId);
      if (s) setParam(s, msg.id, msg.params);
      break;
    }
    case "set-bypass": {
      const s = sessions.get(msg.tabId);
      if (s) { s.masterBypass = !!msg.bypass; rebuild(s); }
      break;
    }
    case "set-master-gain": {
      const s = sessions.get(msg.tabId);
      if (s && s.master && typeof msg.gain === "number") s.master.gain.value = Math.pow(10, Math.max(-60, Math.min(12, msg.gain)) / 20);
      break;
    }
    case "set-fft": {
      const s = sessions.get(msg.tabId);
      if (s && s.spec && VALID_FFT.has(msg.fft)) {
        s.fft = msg.fft;
        s.spec.port.postMessage({ fftSize: msg.fft });
      }
      break;
    }
    case "set-q": {
      const s = sessions.get(msg.tabId);
      if (s && typeof msg.q === "number") s.mrQ = Math.max(4, Math.min(60, msg.q)); // mr rebuilds next column
      break;
    }
    case "spec-active": {
      const s = sessions.get(msg.tabId);
      if (s && s.spec) s.spec.port.postMessage({ active: !!msg.active });
      break;
    }
    case "tab-title": {
      const s = sessions.get(msg.tabId);
      if (s && s.tab) s.tab.title = msg.title; // keep the switcher label fresh
      break;
    }
    case "poll":
      sendResponse(poll(msg.tabId));
      return true;
  }
});

async function startCapture(streamId, tab, rack) {
  const tabId = tab && tab.id;
  if (tabId == null) return;
  teardown(tabId); // restart cleanly if this tab was already captured

  const s = {
    tabId, tab, ctx: null, stream: null, source: null, master: null,
    spec: null, cols: [], lastCol: null, fft: 16384, modules: new Map(), order: [],
  };
  sessions.set(tabId, s);

  try {
    s.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    // If the tab closes or stops sharing, the track ends - clean the session up.
    const track = s.stream.getAudioTracks()[0];
    if (track) track.onended = () => stopCapture(tabId);

    // "interactive" = smallest output buffer Chrome will give us (lowest latency)
    s.ctx = new AudioContext({ latencyHint: "interactive" }); // may throw if too many tabs captured at once
    await Promise.all(Object.values(WORKLETS).map((p) => s.ctx.audioWorklet.addModule(p)));
    s.source = s.ctx.createMediaStreamSource(s.stream);
    // STFT analyzer node (pass-through). Streams log-spectrum columns when active.
    s.spec = new AudioWorkletNode(s.ctx, "spectrum-processor", {
      channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers",
      processorOptions: { fftSize: s.fft },
    });
    s.mr = null; s.mrQ = 20;
    s.spec.port.onmessage = (e) => {
      if (e.data && e.data.type === "frame") computeColumn(s, e.data.n, e.data.frame);
    };
    s.master = s.ctx.createGain(); // master output level (popup safety control)
    s.master.connect(s.ctx.destination);

    rebuild(s);
    if (s.ctx.state === "suspended") await s.ctx.resume();
    applyRack(s, rack); // restore the saved chain even if no editor is open to push it
  } catch (e) {
    stopCapture(tabId); // don't leave a half-built session in the list
    throw e;
  }

  // editor page listens for this; no receiver when it's closed -> swallow the reject
  chrome.runtime.sendMessage({ type: "engine-ready", tabId }).catch(() => {});
}

function teardown(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  try { if (s.stream) s.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (s.ctx) s.ctx.close(); } catch {}
  sessions.delete(tabId);
}
function stopCapture(tabId) {
  if (!sessions.has(tabId)) return;
  teardown(tabId);
  chrome.runtime.sendMessage({ type: "engine-stopped", tabId }).catch(() => {});
}

function makeNode(s, type) {
  const node = new AudioWorkletNode(s.ctx, PROCESSOR[type], {
    channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers",
  });
  node.port.onmessage = (e) => {
    const d = e.data;
    if (!d || d.type !== "meter") return;
    const m = [...s.modules.values()].find((mm) => mm.node === node);
    if (!m) return;
    if (d.s) {
      // a burst of per-step pairs: compressor [level, gr], limiter [inDb, grDb]
      if (!m.traceQ) m.traceQ = [];
      for (let i = 0; i < d.s.length; i += 2) m.traceQ.push([d.s[i], d.s[i + 1]]);
      if (m.traceQ.length > 800) m.traceQ.splice(0, m.traceQ.length - 800);
      m.level = d.s[d.s.length - 2]; m.gr = d.s[d.s.length - 1];
      // the limiter ships its LUFS alongside the trace, so read it here too
      if (typeof d.lufsM === "number") { m.lufsM = d.lufsM; m.lufsS = d.lufsS; m.lufsI = d.lufsI; m.peak = d.peak; }
    } else {
      if (typeof d.gr === "number") m.gr = d.gr;
      if (typeof d.level === "number") m.level = d.level;
      if (d.mb) m.mb = d.mb;                       // multiband per-band GR
      if (typeof d.corr === "number") m.corr = d.corr; // utility stereo correlation
      if (typeof d.rmsL === "number") m.rmsL = d.rmsL;
      if (typeof d.rmsR === "number") m.rmsR = d.rmsR;
      if (d.scope) {                               // utility goniometer L/R points (flat L,R,L,R…)
        if (!m.scopeQ) m.scopeQ = [];
        for (let i = 0; i < d.scope.length; i++) m.scopeQ.push(d.scope[i]);
        if (m.scopeQ.length > 4000) m.scopeQ.splice(0, m.scopeQ.length - 4000);
      }
      if (typeof d.lufsM === "number") { m.lufsM = d.lufsM; m.lufsS = d.lufsS; m.lufsI = d.lufsI; m.peak = d.peak; }
    }
  };
  return node;
}

function applyStructure(s, structure) {
  if (!s.ctx) return;
  const wanted = new Set(structure.map((x) => x.id));
  for (const [id, m] of s.modules) {
    if (!wanted.has(id)) { try { m.node && m.node.disconnect(); } catch {} s.modules.delete(id); }
  }
  for (const st of structure) {
    let m = s.modules.get(st.id);
    if (!m) {
      const node = PROCESSOR[st.type] ? makeNode(s, st.type) : null; // 'analyzer' has no node
      m = { type: st.type, node, bypass: !!st.bypass, gr: 0 };
      s.modules.set(st.id, m);
    }
    m.bypass = !!st.bypass;
  }
  s.order = structure.map((x) => x.id);
  rebuild(s);
}

function rebuild(s) {
  if (!s.ctx) return;
  try { s.source.disconnect(); } catch {}
  try { s.spec.disconnect(); } catch {}
  for (const m of s.modules.values()) { try { m.node && m.node.disconnect(); } catch {} }
  let prev = s.source;
  if (!s.masterBypass) { // master bypass routes the source straight to output (clean A/B)
    for (const id of s.order) {
      const m = s.modules.get(id);
      if (!m || m.bypass || !m.node) continue;
      prev.connect(m.node);
      prev = m.node;
    }
  }
  prev.connect(s.spec); // STFT tap (pass-through) sits at the end
  s.spec.connect(s.master); // master gain → output (master persists across rebuilds)
}

function setParam(s, id, params) {
  const m = s.modules.get(id);
  if (m && m.node) m.node.port.postMessage(params);
}

// Apply a saved rack (passed in by the service worker, which read it from
// storage - chrome.storage isn't available in offscreen documents). Each stored
// module object carries all its params; the worklets pick the fields they use.
function applyRack(s, rack) {
  if (!rack || !Array.isArray(rack.modules)) return;
  s.masterBypass = !!rack.masterBypass; // restore the saved tab-bypass state
  applyStructure(s, rack.modules.map((m) => ({ id: m.id, type: m.type, bypass: m.bypass })));
  for (const m of rack.modules) setParam(s, m.id, m);
}

function poll(tabId) {
  const list = [...sessions.values()].map((s) => ({ tabId: s.tabId, title: (s.tab && s.tab.title) || ("Tab " + s.tabId) }));
  const s = sessions.get(tabId);
  if (!s || !s.spec) return { running: false, sessions: list };
  const cols = s.cols; s.cols = []; // hand over (and clear) the columns produced since last poll
  const meters = {};
  for (const [id, m] of s.modules) {
    meters[id] = {
      gr: m.gr || 0, level: m.level, trace: m.traceQ && m.traceQ.length ? m.traceQ : null,
      mb: m.mb, corr: m.corr, rmsL: m.rmsL, rmsR: m.rmsR,
      scope: m.scopeQ && m.scopeQ.length ? m.scopeQ : null,
      lufsM: m.lufsM, lufsS: m.lufsS, lufsI: m.lufsI, peak: m.peak,
    };
    if (m.traceQ) m.traceQ = []; // hand over and clear, like the spectrogram columns
    if (m.scopeQ) m.scopeQ = [];
  }
  return {
    running: true, tabId: s.tabId, tab: s.tab, fft: s.fft, q: s.mrQ, bypassed: !!s.masterBypass,
    masterGain: s.master ? Math.round(20 * Math.log10(s.master.gain.value + 1e-9) * 10) / 10 : 0,
    sampleRate: s.ctx.sampleRate, logN: LOGN, cols, last: s.lastCol, meters, sessions: list,
    // round-trip audio I/O latency (buffering); module look-ahead is added in the UI
    latency: ((s.ctx.baseLatency || 0) + (s.ctx.outputLatency || 0)) * 1000,
  };
}
