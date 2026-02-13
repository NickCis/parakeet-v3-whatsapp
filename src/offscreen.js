/**
 * Offscreen document: relay only. Creates sandbox iframe, forwards transcribe
 * to sandbox via postMessage and results back to service worker via port.
 */
const Prefix = '[Parakeet-WA offscreen]';
console.log(Prefix, 'script loaded');

let iframe = null;
let sandboxReady = false;
const pendingByRequestId = {};
let requestIdCounter = 0;

const port = chrome.runtime.connect({ name: 'parakeet-offscreen' });
port.onDisconnect.addListener(() => console.log(Prefix, 'port disconnected'));
console.log(Prefix, 'port connected');

function ensureSandbox() {
  if (iframe) return Promise.resolve();
  return new Promise((resolve) => {
    iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sandbox.html');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    const onReady = (ev) => {
      if (ev.data && ev.data.type === 'parakeet-sandbox-ready') {
        window.removeEventListener('message', onReady);
        sandboxReady = true;
        console.log(Prefix, 'sandbox ready');
        resolve();
      }
    };
    window.addEventListener('message', onReady);
    iframe.onload = () => {
      if (sandboxReady) resolve();
    };
  });
}

window.addEventListener('message', (ev) => {
  const d = ev.data || {};
  if (d.type === 'parakeet-sandbox-log') {
    const fn = d.level === 'error' ? console.error : console.log;
    fn(Prefix, '[sandbox]', ...(d.args || []));
    return;
  }
  const { type, requestId, transcript, error } = d;
  if (type !== 'parakeet-result' || requestId == null) return;
  const pending = pendingByRequestId[requestId];
  if (!pending) return;
  delete pendingByRequestId[requestId];
  try {
    if (error != null) {
      pending.portSend({ error });
    } else {
      pending.portSend({ transcript: transcript || '' });
    }
  } catch (e) {
    pending.portSend({ error: (e && e.message) || String(e) });
  }
});

port.onMessage.addListener(async (msg) => {
  const audioBase64 = msg?.audioBase64;
  console.log(Prefix, 'port message received', 'type=', msg?.type, 'audioBase64.length=', typeof audioBase64 === 'string' ? audioBase64.length : 'n/a');
  if (msg.type !== 'transcribe' || !audioBase64 || typeof audioBase64 !== 'string') {
    if (msg.type === 'transcribe' && !audioBase64) console.warn(Prefix, 'transcribe message has no audioBase64');
    return;
  }
  await ensureSandbox();
  if (!iframe || !iframe.contentWindow) {
    console.warn(Prefix, 'sandbox iframe not ready');
    try {
      port.postMessage({ error: 'Sandbox not ready.' });
    } catch (_) {}
    return;
  }
  const requestId = ++requestIdCounter;
  const portSend = (payload) => {
    try {
      port.postMessage(payload);
    } catch (_) {}
  };
  pendingByRequestId[requestId] = { portSend };
  console.log(Prefix, 'posting to sandbox', 'requestId=', requestId, 'audioBase64.length=', audioBase64.length);
  iframe.contentWindow.postMessage(
    { type: 'parakeet-transcribe', requestId, audioBase64 },
    '*'
  );
});
