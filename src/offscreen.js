/**
 * Offscreen document: runs Parakeet (WebGPU) and decode/resample.
 * Connects to the service worker; receives { type: 'transcribe', audioBase64 }, replies with { transcript } or { error }.
 *
 * We set ONNX Runtime WASM paths to the extension base URL before Parakeet runs so the jsep script/WASM
 * are loaded from the extension (CSP allows 'self') instead of the CDN.
 */
import { getParakeetModel, ParakeetModel } from 'parakeet.js';

const TARGET_SAMPLE_RATE = 16000;

/** Install a fetch wrapper that logs download progress for model/assets. Call once before loading the model. */
function installFetchProgressLogging() {
  if (self._fetchProgressInstalled) return;
  self._fetchProgressInstalled = true;
  const originalFetch = self.fetch;
  self.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = (init?.method || 'GET').toUpperCase();
    if (method !== 'GET' || !url) return originalFetch.call(this, input, init);

    const label = url.split('/').pop()?.split('?')[0] || url.slice(-40);
    const isModelAsset = /\.(onnx|wasm|mjs|json|bin)$/i.test(label) || url.includes('huggingface') || url.includes('parakeet');

    return originalFetch.call(this, input, init).then((response) => {
      if (!response.body || !isModelAsset) return response;
      const total = response.headers.get('Content-Length');
      const totalNum = total ? parseInt(total, 10) : null;
      let loaded = 0;
      let lastLoggedPct = -1;
      let lastLoggedMb = 0;
      const start = Date.now();
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        start(controller) {
          function pump() {
            return reader.read().then(({ done, value }) => {
              if (done) {
                const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                console.log(`[Parakeet] Downloaded ${label}: ${formatBytes(loaded)}${totalNum ? ` (100%) in ${elapsed}s` : ` in ${elapsed}s`}`);
                controller.close();
                return;
              }
              loaded += value.length;
              if (totalNum) {
                const pct = Math.floor((loaded / totalNum) * 100);
                if (pct >= lastLoggedPct + 10 || pct >= 100) {
                  lastLoggedPct = pct;
                  console.log(`[Parakeet] Downloading ${label}: ${formatBytes(loaded)} / ${formatBytes(totalNum)} (${Math.min(pct, 100)}%)`);
                }
              } else {
                const mb = Math.floor(loaded / (1024 * 1024));
                if (mb >= lastLoggedMb + 5) {
                  lastLoggedMb = mb;
                  console.log(`[Parakeet] Downloading ${label}: ${formatBytes(loaded)}…`);
                }
              }
              controller.enqueue(value);
              return pump();
            });
          }
          return pump();
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  };
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** Ensure ORT loads script/WASM from extension; must run before any Parakeet/ORT use. */
async function ensureOrtPathsFromExtension() {
  const ortModule = await import('onnxruntime-web');
  const ort = ortModule.default || ortModule;
  if (ort?.env?.wasm) {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('');
  }
}

function decodeAndResample(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const audioContext = new AudioContext();
    audioContext.decodeAudioData(
      arrayBuffer,
      (decoded) => {
        audioContext.close();
        const duration = decoded.duration;
        const length = Math.ceil(duration * TARGET_SAMPLE_RATE);
        const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start(0);
        offline.startRendering().then((rendered) => {
          const ch = rendered.getChannelData(0);
          const pcm = new Float32Array(ch.length);
          pcm.set(ch);
          resolve(pcm);
        }, reject);
      },
      reject
    );
  });
}

let model = null;
let loadPromise = null;

async function loadModel() {
  if (model) return model;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    console.log('[Parakeet] Preparing ORT and fetching model manifest…');
    installFetchProgressLogging();
    await ensureOrtPathsFromExtension();
    const { urls, filenames } = await getParakeetModel('parakeet-tdt-0.6b-v3', {
      backend: 'webgpu-hybrid',
    });
    console.log('[Parakeet] Model manifest ready, downloading model files:', Object.keys(urls || {}).join(', '));
    model = await ParakeetModel.fromUrls({
      ...urls,
      filenames,
      backend: 'webgpu-hybrid',
    });
    console.log('[Parakeet] Model loaded and ready.');
    return model;
  })();
  return loadPromise;
}

const port = chrome.runtime.connect({ name: 'parakeet-offscreen' });

port.onMessage.addListener(async (msg) => {
  const { type, audioBase64 } = msg || {};
  if (type !== 'transcribe' || !audioBase64 || typeof audioBase64 !== 'string') return;
  try {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const arrayBuffer = bytes.buffer;
    const pcm = await decodeAndResample(arrayBuffer);
    const m = await loadModel();
    const result = await m.transcribe(pcm, TARGET_SAMPLE_RATE, {
      returnTimestamps: false,
      enableProfiling: false,
    });
    port.postMessage({ transcript: result.utterance_text || '' });
  } catch (e) {
    port.postMessage({ error: (e && e.message) || String(e) });
  }
});
