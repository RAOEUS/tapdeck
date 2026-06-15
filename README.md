# Tapdeck

A modular real-time audio processor for Chrome that captures a tab's audio and
runs it through a rack you build — EQ, dynamics, saturation, stereo tools and a
brick-wall limiter, in any order — all inside the extension via `AudioWorklet`.
No native plugins, no system routing, no companion app.

The UI is a full-page app (FabFilter-ish): draggable EQ curves over a live
spectrum, compressor/gate transfer curves with metering, a scrolling limiter
display, and a reorderable module list with a categorized preset browser.

## Architecture

```
                 popup  ── Start (mints capture streamId, holds user gesture)
                   │
service worker ──ensure──▶ offscreen document  (owns the AudioContext)
                                   │
   tab audio ─tabCapture─▶ source ─▶ [ module, module, … ] ─▶ analyser ─▶ speakers
                                   ▲                    │
        editor tab ── sync structure/params ───────────┘
                   ◀── poll: spectrum + meters ─────────
```

- **Engine** (`offscreen.js`): one independent session per captured tab — its own
  `AudioContext`, capture stream, ordered rack, and analyser. Rebuilds the node
  graph on any structural change; runs the spectrogram STFT on its own thread.
- **Editor** (`editor.html` / `editor.js`): source of truth for all rack state.
  Pushes structure/params to the engine and polls it for visualization.
- **DSP** (`worklet/*.js`): one `AudioWorkletProcessor` per module, on the audio thread.
- **Shared math** (`dsp-math.js`): biquad design + magnitude response, reused by the
  editor so the **drawn curve matches the sound** (identical formulas; guarded by a test).

MV3 forces this split: service workers can't host an `AudioContext`, so audio lives
in an offscreen document; the popup mints the capture `streamId` because `tabCapture`
needs a live user gesture that doesn't survive the hop to the worker.

## Modules

| Module | What it does |
|---|---|
| **EQ** | Multi-band parametric (8 shapes), optional per-band **dynamics** (compress/expand/OTT), **Stereo / Mid / Side** processing, and **Solo** (phase-cancel audition of one band). |
| **Compressor** | Down / Up / Expand / OTT modes, soft knee, **feed-forward / feed-back** detection, parallel mix, **sidechain HPF**. |
| **Multiband** | Linkwitz-Riley split into N bands, a compressor per band, OTT-capable. |
| **Gate / Expander** | Threshold/ratio/range/attack/release/hold with a live open/closed + level display. |
| **Denoise** | Spectral noise suppressor (min-statistics + Wiener gate). 0% = transparent. |
| **De-reverb** | STFT decay-expander: pulls down reverb tails while passing transients and sustained notes, with a scrolling input-vs-output display. |
| **Transient** | Attack / sustain envelope shaping. |
| **Saturator** | Tube / tape / crunch / fold / hard waveshapers with **oversampling** (anti-aliased). |
| **Limiter** | Look-ahead brick-wall with attack/hold/channel-link, **oversampled true-peak detection**, per-**style** character, unity-gain match, DC filter, **LUFS + dBTP metering**. |
| **Utility** | Gain, balance, width, mono, channel invert/swap, headphone crossfeed, goniometer. |
| **Analyzer** | Multi-resolution (constant-Q) STFT spectrogram. |

## Install & use

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
2. Open a tab playing audio, click the **Tapdeck** toolbar icon → **Start on this tab**.
3. Open the rack/visualizer, **+ Add module** to build a chain (reorder by drag, bypass
   per module), or **Browse presets**.
4. Each captured tab gets its own independent rack; new tabs start from a saved template.

## Development

No build step — it's loaded as an unpacked extension. After editing source, reload the
extension card in `chrome://extensions`; **worklet/offscreen** changes also need the tab
re-captured (the `AudioContext` is built at capture time).

```
npm test          # browser-free DSP tests (node --test) — runs the worklets in a vm shim
npm run check     # syntax-check every shipped JS file
```

The DSP tests drive each `AudioWorkletProcessor`'s `process()` directly and assert real
properties (limiter holds the ceiling + true peak, denoise 0% is transparent, gate gates,
saturator oversampling reduces aliasing, EQ solo of a flat band is silent, EQ Side mode
preserves the Mid, the drawn EQ curve matches the worklet's filter, …).

## Known limitations

- **Chrome only** — Firefox has no `tabCapture`.
- Audio runs in an offscreen document because MV3 service workers can't host an `AudioContext`.
- DRM/EME audio (some Netflix/Spotify) may not be capturable.
- Browsers allow ~6 concurrent `AudioContext`s, so up to ~6 tabs can be processed at once.
- Latency is fine for playback (a few ms + limiter look-ahead), not for live monitoring.
