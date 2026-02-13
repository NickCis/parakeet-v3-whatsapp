/**
 * Service worker: ensures offscreen document exists, relays transcribe requests
 * to offscreen via port and sends response back to content script.
 */

const PREFIX = '[Parakeet-WA background]';
console.log(PREFIX, 'service worker loaded');

const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_REASON = 'BLOBS';
const OFFSCREEN_JUSTIFICATION = 'Decode and process WhatsApp audio for local Parakeet transcription (WebGPU).';

let offscreenPort = null;
let pendingSendResponse = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [OFFSCREEN_REASON],
    justification: OFFSCREEN_JUSTIFICATION,
  });
}

async function waitForPort(maxMs = 5000) {
  const step = 100;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    if (offscreenPort) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'parakeet-offscreen') return;
  offscreenPort = port;
  offscreenPort.onDisconnect.addListener(() => {
    offscreenPort = null;
    if (pendingSendResponse) {
      try { pendingSendResponse({ error: 'Offscreen closed.' }); } catch (_) {}
      pendingSendResponse = null;
    }
  });
  offscreenPort.onMessage.addListener((msg) => {
    if (pendingSendResponse) {
      try { pendingSendResponse(msg); } catch (_) {}
      pendingSendResponse = null;
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'transcribe') return false;
  const audioBase64 = message.audioBase64;
  (async () => {
    try {
      await ensureOffscreenDocument();
      const hasPort = await waitForPort();
      if (!hasPort || !offscreenPort) {
        sendResponse({ error: 'Transcription not ready. Try again in a moment.' });
        return;
      }
      pendingSendResponse = sendResponse;
      offscreenPort.postMessage({ type: 'transcribe', audioBase64 });
    } catch (e) {
      sendResponse({ error: (e && e.message) || 'Failed to start transcription.' });
    }
  })();
  return true;
});
