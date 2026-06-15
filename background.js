// Service worker: owns the offscreen document lifecycle and forwards the
// captured-stream handoff. It cannot host an AudioContext itself (no DOM/audio
// in a worker), so all real audio work happens in offscreen.html.

async function ensureOffscreen() {
  // getContexts is the MV3-correct way to check for an existing offscreen doc.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Host an AudioContext to apply real-time DSP to captured tab audio.",
  });
}

// createDocument resolves when the doc is created, not when offscreen.js has run
// and registered its onMessage listener - so the first send can race and be lost
// ("Receiving end does not exist"). Retry briefly until it lands.
async function sendToOffscreen(msg, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try { return await chrome.runtime.sendMessage(msg); }
    catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  throw new Error("offscreen unreachable");
}

// Swap the toolbar icon for a tab between idle (slate) and active (blue) so it's
// obvious at a glance which tabs Tapdeck is processing.
function setActionIcon(tabId, active) {
  const p = active ? "active" : "idle";
  const path = { 16: `icons/${p}-16.png`, 32: `icons/${p}-32.png`, 48: `icons/${p}-48.png`, 128: `icons/${p}-128.png` };
  chrome.action.setIcon({ tabId, path }).catch(() => {}); // tab may have closed
  chrome.action.setTitle({ tabId, title: active ? "Tapdeck - processing this tab" : "Tapdeck" }).catch(() => {});
}

// Keep the editor's tab switcher labels fresh as pages navigate / retitle.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title) {
    chrome.runtime.sendMessage({ target: "offscreen", type: "tab-title", tabId, title: changeInfo.title }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // offscreen broadcasts these on capture start/stop - toggle the per-tab icon.
  if (msg.type === "engine-ready" && typeof msg.tabId === "number") { setActionIcon(msg.tabId, true); return; }
  if (msg.type === "engine-stopped" && typeof msg.tabId === "number") { setActionIcon(msg.tabId, false); return; }
  // The popup already created the streamId (it holds the user gesture that
  // tabCapture requires). We just make sure offscreen exists, then hand it over.
  if (msg.type === "start") {
    (async () => {
      try {
        await ensureOffscreen();
        // chrome.storage isn't available in offscreen docs, so read the saved rack
        // here and hand it over to restore the chain on capture.
        let rack = null;
        try {
          const d = await chrome.storage.local.get("racks");
          rack = d && d.racks && msg.tab ? d.racks[msg.tab.id] : null;
        } catch {}
        await sendToOffscreen({
          target: "offscreen",
          type: "start-capture",
          streamId: msg.streamId,
          tab: msg.tab, // { id, title } of the captured tab, for display
          rack: rack || null,
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async response
  }
});
