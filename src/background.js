/**
 * Service worker: ensures offscreen document exists, relays transcribe requests
 * to offscreen via port and sends response back to content script.
 */

const Prefix = '[Parakeet-WA background]';
function log(...args) {
  console.log(Prefix, ...args);
}
function warn(...args) {
  console.warn(Prefix, ...args);
}

log('service worker loaded');

const OffscreenPath = 'offscreen.html';
const OffscreenJustification =
  'Decode and process WhatsApp audio for local Parakeet transcription (WebGPU).';

let offscreenPort = null;
let portReadyPromise = null;
let portReadyResolve = null;
let pendingSendResponse = null;
/** Queue of { audioBase64, sendResponse } when parakeet is busy (one transcription at a time) */
const transcribeQueue = [];

async function ensureOffscreenConnection(timeoutMs = 5000) {
  try {
    const offscreenUrl = chrome.runtime.getURL(OffscreenPath);
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });

    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: OffscreenPath,
        reasons: ['BLOBS', 'WORKERS', 'LOCAL_STORAGE'],
        justification: OffscreenJustification,
      });
    }

    if (offscreenPort) return true;

    if (!portReadyPromise) {
      portReadyPromise = new Promise(resolve => {
        portReadyResolve = resolve;
      });
    }

    chrome.runtime.sendMessage({ type: 'offscreen-reconnect' });

    await Promise.race([
      portReadyPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]);

    return true;
  } catch (err) {
    warn('Offscreen connection failed, restarting…');

    portReadyPromise = null;
    portReadyResolve = null;
    offscreenPort = null;

    try {
      await chrome.offscreen.closeDocument();
    } catch (_) {}

    return false;
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'parakeet-offscreen') return;
  offscreenPort = port;

  if (portReadyResolve) {
    portReadyResolve();
    portReadyResolve = null;
    portReadyPromise = null;
  }

  offscreenPort.onDisconnect.addListener(() => {
    log('onDisconnect', port);
    offscreenPort = null;
    if (pendingSendResponse) {
      try {
        pendingSendResponse({ error: 'Offscreen closed.' });
      } catch (_) {}
      pendingSendResponse = null;
    }
    for (const { sendResponse } of transcribeQueue) {
      try {
        sendResponse({ error: 'Offscreen closed.' });
      } catch (_) {}
    }
    transcribeQueue.length = 0;
  });

  offscreenPort.onMessage.addListener(msg => {
    if (pendingSendResponse) {
      try {
        pendingSendResponse(msg);
      } catch (_) {}
      pendingSendResponse = null;
    }
    if (transcribeQueue.length > 0) {
      const next = transcribeQueue.shift();
      pendingSendResponse = next.sendResponse;
      offscreenPort.postMessage({
        type: 'transcribe',
        audioBase64: next.audioBase64,
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'transcribe') return false;
  const audioBase64 = message.audioBase64;
  (async () => {
    try {
      const hasPort = await ensureOffscreenConnection();
      if (!hasPort || !offscreenPort) {
        sendResponse({
          error: 'Transcription not ready. Try again in a moment.',
        });
        return;
      }
      if (pendingSendResponse !== null) {
        transcribeQueue.push({ audioBase64, sendResponse });
        return;
      }
      pendingSendResponse = sendResponse;
      offscreenPort.postMessage({ type: 'transcribe', audioBase64 });
    } catch (e) {
      sendResponse({
        error: (e && e.message) || 'Failed to start transcription.',
      });
    }
  })();
  return true;
});
