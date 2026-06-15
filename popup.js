// Popup: owns the user gesture tabCapture needs, and acts as a quick control
// surface - start/stop, master bypass + output level for the active tab, and a
// list of every tab currently being processed.
const $ = (id) => document.getElementById(id);
const toggle = $("toggle"), openBtn = $("open"), status = $("status");
const controls = $("controls"), bypassBtn = $("bypass"), bypassHint = $("bypassHint");
const gain = $("gain"), gainv = $("gainv"), sessionsEl = $("sessions");

let running = false, curTab = null;

async function activeTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }
function send(msg) { return chrome.runtime.sendMessage(msg); }

async function refresh() {
  curTab = await activeTab();
  let res = null;
  try { res = await send({ target: "offscreen", type: "poll", tabId: curTab.id }); } catch {}
  running = !!(res && res.running);
  toggle.textContent = running ? "Stop this tab" : "Start on this tab";
  toggle.classList.toggle("danger", running);
  controls.hidden = !running;
  if (running) {
    const byp = !!res.bypassed;
    bypassBtn.textContent = byp ? "Bypassed" : "Active";
    bypassBtn.classList.toggle("on", byp);
    bypassHint.textContent = byp ? "hearing original" : "DSP on";
    if (document.activeElement !== gain) {
      const g = res.masterGain ?? 0; gain.value = g; gainv.textContent = g + " dB";
    }
  }
  renderSessions(res ? res.sessions : []);
}

function renderSessions(list) {
  sessionsEl.innerHTML = "";
  if (!list || !list.length) return;
  const h = document.createElement("div"); h.className = "shead"; h.textContent = "Active tabs"; sessionsEl.appendChild(h);
  list.forEach((s) => {
    const row = document.createElement("div"); row.className = "srow";
    row.innerHTML = `<span class="dot"></span><span class="t"></span><button class="x" title="Stop">✕</button>`;
    row.querySelector(".t").textContent = s.title || ("Tab " + s.tabId);
    row.querySelector(".x").addEventListener("click", async () => {
      try { await send({ target: "offscreen", type: "stop-capture", tabId: s.tabId }); } catch {}
      refresh();
    });
    sessionsEl.appendChild(row);
  });
}

toggle.addEventListener("click", async () => {
  try {
    if (running) {
      await send({ target: "offscreen", type: "stop-capture", tabId: curTab.id });
    } else {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: curTab.id });
      const r = await send({ type: "start", streamId, tab: { id: curTab.id, title: curTab.title } });
      if (!r || !r.ok) throw new Error((r && r.error) || "capture failed to start");
    }
    status.textContent = "";
    await refresh();
  } catch (e) { status.textContent = humanError(String(e.message || e)); }
});

bypassBtn.addEventListener("click", () => {
  if (!running || !curTab) return;
  const on = !bypassBtn.classList.contains("on");
  send({ target: "offscreen", type: "set-bypass", tabId: curTab.id, bypass: on }).catch(() => {});
  refresh();
});

gain.addEventListener("input", () => {
  gainv.textContent = gain.value + " dB";
  if (curTab) send({ target: "offscreen", type: "set-master-gain", tabId: curTab.id, gain: Number(gain.value) }).catch(() => {});
});

openBtn.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") }));

// turn raw tabCapture errors into something a person can act on
function humanError(msg) {
  if (/already.*captur|active stream|invalid stream/i.test(msg)) return "This tab is already being captured.";
  if (/chrome:\/\/|chrome-extension:|cannot capture|not.*allowed/i.test(msg)) return "This page's audio can't be captured.";
  return "Error: " + msg;
}

refresh();
setInterval(refresh, 1200); // keep the session list / state fresh while the popup is open
