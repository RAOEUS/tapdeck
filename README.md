# Tab DSP Rack

A modular real-time audio processor for Chrome that captures a tab's audio and
runs it through a rack you build — **multi-band parametric EQ, compressor, and
limiter**, in any order — all inside the extension via `AudioWorklet`. No native
plugins, no system routing, no companion app.

The UI is a full-page app (FabFilter-ish): a draggable EQ response curve over a
live spectrum, a compressor transfer curve with gain-reduction metering, and a
reorderable module list.

## Architecture

```
                 popup  ── Start (mints capture streamId, holds user gesture)
                   │
service worker ──ensure──▶ offscreen document  (owns the AudioContext)
                                   │
   tab audio ─tabCapture─▶ source ─▶ [ module, module, … ] ─▶ analyser ─▶ speakers
                                   ▲                    │
        editor tab ── sync structure/params ───────────┘
                   ◀── poll: spectrum + GR meters ──────
```

- **Engine** (`offscreen.js`): holds the rack as an ordered list, rebuilds the
  graph on any structural change, exposes an analyser + per-module GR meters.
- **Editor** (`editor.html` / `editor.js`): source of truth for state. Pushes
  structure/params to the engine and polls it ~60 fps for visualization.
- **DSP** (`worklet/*.js`): three `AudioWorkletProcessor`s on the audio thread.
- **Shared math** (`dsp-math.js`): biquad design + magnitude response, reused by
  the editor so the **drawn curve matches the sound** (identical formulas).

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3. Perms: `tabCapture`, `offscreen`, `activeTab`, `storage`. |
| `popup.html/.js` | Start/Stop capture + "Open Rack". Mints the capture stream. |
| `background.js` | Service worker — owns the offscreen document lifecycle. |
| `offscreen.html/.js` | Hosts `AudioContext`; the reorderable rack engine. |
| `editor.html/.css/.js` | Full-page UI: rack list + EQ/Comp/Limiter editors + viz. |
| `dsp-math.js` | Biquad/compressor math shared with the UI for drawing. |
| `worklet/eq-processor.js` | Multi-band parametric EQ (8 filter shapes). |
| `worklet/comp-processor.js` | Soft-knee compressor with GR metering. |
| `worklet/limiter-processor.js` | Look-ahead brick-wall limiter with GR metering. |

## Use it

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
2. Open a tab playing audio, click the toolbar icon, **Start on this tab**.
3. Click **Open Rack & Visualizer** (or the card's *Details → Extension options*).
4. Build your chain: **+ EQ / + Comp / + Limit**, reorder with ↑/↓, bypass with ●.

### EQ
- 8 shapes per band: peaking, low/high shelf, low/high-pass, band-pass, notch, all-pass.
- Drag nodes (x = freq, y = gain). Wheel over a node = Q. Double-click = add band.
  Right-click a node = remove. Live spectrum behind the curve; dB range selectable.

### Compressor
- Threshold / ratio / attack / release / knee / makeup, live transfer curve, GR meter.
- **Feed-forward / feed-back detection** toggle. Feed-forward detects on the
  input (precise, modern); feed-back detects on the gain element's output from
  the previous sample (self-regulating, vintage character).

### Limiter
- Ceiling / release / look-ahead, with a GR meter.

### Analyzer (Scope)
- Scrolling **spectrogram** fed by a real **hopped STFT** (Hann-windowed, one
  column per ~10 ms hop). FFT size controls *frequency* sharpness and the hop
  controls *time* resolution independently — so a bigger FFT sharpens without the
  time-smear you get from an AnalyserNode. The FFT runs on the engine's main
  thread (off the audio thread) to avoid dropouts; the worklet only buffers and
  ships frames. It's active only while the EQ or Analyzer panel is on screen.
- Controls: **Speed**, **Smooth** (temporal averaging), **Sharpen** (unsharp mask
  that thins tonal lines), **FFT** (4k–32k; frequency-vs-time sharpness tradeoff),
  **Top** + **Range** (dB window), **Contrast** (gamma), **Min f / Max f**
  (frequency zoom), **Color** (magma / inferno / viridis / ice / fire / gray),
  and a **Grid** toggle.
- Renders **only while its panel is visible**, and the whole poll/draw loop
  **pauses when the editor tab is hidden** (Page Visibility API) — zero CPU in
  the background.

### Rack
- **Drag and drop** to reorder modules (or grab the ⠿ handle). Bypass per module,
  remove with ✕. Each module editor has a **Reset** button (restores type defaults).
- **Presets**: built-ins (Flat, Bass Boost, Vocal Clarity, Loudness Smile, Master
  Bus) plus **Save** your own and **✕** to delete user presets. Applying a preset
  replaces the selected tab's whole rack.
- EQ coefficient changes are **smoothed** (and filter state preserved) so dragging
  nodes is click-free.

### Multiple tabs
- Each captured tab gets its **own independent engine and rack**, running
  simultaneously. The editor's top bar is a **tab switcher** — click a chip to
  edit/visualize that tab, or ✕ to stop it.
- New tabs start from a **template** rack; **Set as default** saves the current
  rack as that template. All state persists via `chrome.storage.local`.
- Practical cap: browsers allow ~6 concurrent `AudioContext`s per page, so up to
  ~6 tabs can be processed at once.

## Roadmap / where to extend

- **Multiband compression:** split with Linkwitz-Riley crossovers into N bands,
  one `comp-processor` per band, sum. The rack/reorder plumbing already supports
  adding it as a new module type.
- **WASM/Faust DSP:** swap any worklet's JS for an instantiated WASM module
  (load bytes on the main thread, `postMessage` into the node — the worklet
  scope has no `fetch`). Faust ships ready EQ/comp/limiter and compiles straight
  to an AudioWorklet.
- **Better metering:** input/output LUFS, true-peak, correlation.

## Known limitations

- **Chrome only.** Firefox has no `tabCapture`; the DSP/UI port, the capture tap
  does not.
- **MV3 plumbing:** audio lives in an offscreen document because service workers
  can't host an `AudioContext`. The popup mints the capture `streamId` because
  `tabCapture` needs a live user gesture that doesn't survive a hop to the worker.
- DRM/EME audio (some Netflix/Spotify) may not be capturable.
- Spectrum/meter data is ferried over `runtime` messaging at frame rate — fine
  for a control UI; not a sample-accurate scope.
- Latency is fine for playback (a few ms + limiter look-ahead); not for live
  instrument monitoring.
