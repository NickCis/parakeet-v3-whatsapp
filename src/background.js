/**
 * Service worker: ensures offscreen document exists, relays transcribe requests
 * to offscreen via port and sends response back to content script.
 */

const PREFIX = '[Parakeet-WA background]';
console.log(PREFIX, 'service worker loaded');

const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_REASON = 'BLOBS';
const OFFSCREEN_JUSTIFICATION = 'Decode and process WhatsApp audio for local Parakeet transcription.';

let offscreenPort = null;
let pendingSendResponse = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  console.log(PREFIX, 'ensureOffscreenDocument', offscreenUrl);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (existing.length > 0) {
    console.log(PREFIX, 'offscreen already exists');
    return;
  }
  console.log(PREFIX, 'creating offscreen document');
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [OFFSCREEN_REASON],
    justification: OFFSCREEN_JUSTIFICATION,
  });
}

async function waitForPort(maxMs = 5000) {
  const step = 100;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    if (offscreenPort) {
      console.log(PREFIX, 'port ready after', elapsed, 'ms');
      return true;
    }
    await new Promise((r) => setTimeout(r, step));
  }
  console.warn(PREFIX, 'port not ready after', maxMs, 'ms');
  return false;
}

chrome.runtime.onConnect.addListener((port) => {
  console.log(PREFIX, 'onConnect', port.name);
  if (port.name !== 'parakeet-offscreen') return;
  offscreenPort = port;
  console.log(PREFIX, 'offscreen port connected');
  offscreenPort.onDisconnect.addListener(() => {
    console.log(PREFIX, 'offscreen port disconnected');
    offscreenPort = null;
    if (pendingSendResponse) {
      try {
        pendingSendResponse({ error: 'Offscreen closed.' });
      } catch (_) {}
      pendingSendResponse = null;
    }
  });
  offscreenPort.onMessage.addListener((msg) => {
    console.log(PREFIX, 'message from offscreen:', msg?.error ? 'error' : 'transcript');
    if (pendingSendResponse) {
      try {
        pendingSendResponse(msg);
      } catch (_) {}
      pendingSendResponse = null;
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'injectPageScript') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'No tab' });
      return false;
    }
    (async () => {
      try {
        const loadingUrl = chrome.runtime.getURL('loading.gif');
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (url) => {
            window.__PARAKEET_LOADING_URL = url;
          },
          args: [loadingUrl],
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['page-context.js'],
        });
        console.log(PREFIX, 'page-context injected via scripting API');
        sendResponse({ ok: true });
      } catch (e) {
        console.error(PREFIX, 'injectPageScript error:', e);
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }
  if (message.type !== 'transcribe') return false;
  const audioBase64 = message.audioBase64;
  const base64Len = typeof audioBase64 === 'string' ? audioBase64.length : 0;
  console.log(PREFIX, 'transcribe request, sender tab:', sender.tab?.id, 'audioBase64.length:', base64Len);
  (async () => {
    try {
      await ensureOffscreenDocument();
      const hasPort = await waitForPort();
      if (!hasPort || !offscreenPort) {
        console.warn(PREFIX, 'no port, sending error');
        sendResponse({ error: 'Transcription not ready. Try again in a moment.' });
        return;
      }
      pendingSendResponse = sendResponse;
      console.log(PREFIX, 'forwarding to offscreen, audioBase64.length:', base64Len);
      offscreenPort.postMessage({
        type: 'transcribe',
        audioBase64,
      });
    } catch (e) {
      console.error(PREFIX, 'error:', e);
      sendResponse({ error: (e && e.message) || 'Failed to start transcription.' });
    }
  })();
  return true;
});
