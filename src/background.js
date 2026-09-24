/**
 * Service worker: ensures offscreen document exists, relays transcribe requests
 * to offscreen via port and sends response / progress back to content script.
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
/** @type {{ sendResponse: Function, tabId: number|undefined, dataId: string|number|undefined } | null} */
let pending = null;
/** Queue of { audioBase64, dataId, tabId, sendResponse } when parakeet is busy */
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

function forwardProgress(msg) {
  if (!pending?.tabId) return;
  chrome.tabs
    .sendMessage(pending.tabId, {
      type: 'transcribe-progress',
      dataId: pending.dataId,
      stage: msg.stage,
      percent: msg.percent,
      streaming: msg.streaming,
      fixedText: msg.fixedText,
      activeText: msg.activeText,
      transcript: msg.transcript,
      timestamp: msg.timestamp,
      audioDuration: msg.audioDuration,
      isFinal: msg.isFinal,
    })
    .catch(() => {});
}

function startNextQueued() {
  if (!offscreenPort || pending || transcribeQueue.length === 0) return;
  const next = transcribeQueue.shift();
  pending = {
    sendResponse: next.sendResponse,
    tabId: next.tabId,
    dataId: next.dataId,
  };
  offscreenPort.postMessage({
    type: 'transcribe',
    audioBase64: next.audioBase64,
  });
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
    if (pending) {
      try {
        pending.sendResponse({ error: 'Offscreen closed.' });
      } catch (_) {}
      pending = null;
    }
    for (const item of transcribeQueue) {
      try {
        item.sendResponse({ error: 'Offscreen closed.' });
      } catch (_) {}
    }
    transcribeQueue.length = 0;
  });

  offscreenPort.onMessage.addListener(msg => {
    if (!msg) return;

    if (msg.type === 'progress') {
      forwardProgress(msg);
      return;
    }

    // Final result (or legacy shape without type)
    if (pending) {
      const { sendResponse } = pending;
      pending = null;
      try {
        sendResponse({
          transcript: msg.transcript,
          error: msg.error,
        });
      } catch (_) {}
    }
    startNextQueued();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'transcribe') return false;
  const audioBase64 = message.audioBase64;
  const dataId = message.dataId;
  const tabId = sender.tab?.id;
  (async () => {
    try {
      const hasPort = await ensureOffscreenConnection();
      if (!hasPort || !offscreenPort) {
        sendResponse({
          error: 'Transcription not ready. Try again in a moment.',
        });
        return;
      }
      if (pending !== null) {
        transcribeQueue.push({ audioBase64, dataId, tabId, sendResponse });
        return;
      }
      pending = { sendResponse, tabId, dataId };
      offscreenPort.postMessage({ type: 'transcribe', audioBase64 });
    } catch (e) {
      sendResponse({
        error: (e && e.message) || 'Failed to start transcription.',
      });
    }
  })();
  return true;
});
