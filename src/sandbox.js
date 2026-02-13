/**
 * Sandbox: runs in sandboxed iframe. No chrome.* APIs.
 * Listens for parakeet-transcribe (requestId, arrayBuffer), decodes, resamples,
 * runs Parakeet, replies with parakeet-result (requestId, transcript | error).
 * Relays console.log/error to parent so they appear in offscreen's console.
 * ONNX Runtime WASM/.mjs are bundled in the extension; we set wasmPaths so they load from here instead of CDN.
 */
import { getParakeetModel, ParakeetModel } from 'parakeet.js';

/** Base URL for extension assets (sandbox origin). Set before first ORT use so WASM loads from extension, not CDN. */
const WasmBase_URL = new URL('.', typeof location !== 'undefined' ? location.href : 'https://example.com/').href;

function forwardToParent(level, args) {
  try {
    if (window.parent !== window && window.parent.postMessage) {
      const serialized = args.map((a) => {
        if (typeof a === 'object' && a !== null) try { return JSON.stringify(a); } catch (_) { return String(a); }
        return String(a);
      });
      window.parent.postMessage({ type: 'parakeet-sandbox-log', level, args: serialized }, '*');
    }
  } catch (_) {}
}
const _log = console.log;
const _error = console.error;
console.log = function (...args) { _log.apply(console, args); forwardToParent('log', args); };
console.error = function (...args) { _error.apply(console, args); forwardToParent('error', args); };

const TARGET_SAMPLE_RATE = 16000;
let model = null;
let loadPromise = null;

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

async function loadModel() {
  if (model) {
    console.log('sandbox: model already loaded');
    return model;
  }
  if (loadPromise) {
    console.log('sandbox: model load in progress, waiting...');
    return loadPromise;
  }
  console.log('sandbox: [MODEL] starting model download (parakeet-tdt-0.6b-v3)...');
  loadPromise = (async () => {
    try {
      // Load ONNX Runtime and point WASM to bundled assets (extension origin) so we don't fetch from CDN.
      const ortModule = await import('onnxruntime-web');
      const ort = ortModule.default || ortModule;
      if (ort?.env?.wasm) {
        ort.env.wasm.wasmPaths = WasmBase_URL;
        console.log('sandbox: [MODEL] ort.env.wasm.wasmPaths set to', WasmBase_URL);
      }
      console.log('sandbox: [MODEL] getParakeetModel() fetching file list from Hugging Face...');
      const { urls, filenames } = await getParakeetModel('parakeet-tdt-0.6b-v3', {
        backend: 'webgpu',
        progress: (p) => {
          if (!p) return;
          const file = p.file != null ? p.file : (p.fileName || '');
          const loaded = p.loaded != null ? p.loaded : 0;
          const total = p.total != null ? p.total : 0;
          const pct = total > 0 ? Math.round(100 * loaded / total) : 0;
          console.log('sandbox: [MODEL] download progress', file || '(file)', loaded, '/', total, pct + '%');
        },
      });
      console.log('sandbox: [MODEL] file list fetched, urls:', urls);
      console.log('sandbox: [MODEL] creating ParakeetModel (loading encoder/decoder, may take a while)...');
      model = await ParakeetModel.fromUrls({
        ...urls,
        filenames,
        backend: 'webgpu',
      });
      console.log('sandbox: [MODEL] ParakeetModel loaded and ready');
      return model;
    } catch (e) {
      console.error('sandbox: model load failed', e);
      loadPromise = null;
      throw e;
    }
  })();
  return loadPromise;
}

window.addEventListener('message', async (ev) => {
  const { type, requestId, audioBase64 } = ev.data || {};
  if (type !== 'parakeet-transcribe' || requestId == null || !audioBase64 || typeof audioBase64 !== 'string') return;
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const arrayBuffer = bytes.buffer;
  const source = ev.source;
  const send = (payload) => {
    if (source && source.postMessage) {
      source.postMessage({ type: 'parakeet-result', requestId, ...payload }, '*');
    }
  };
  console.log('sandbox: received audio', 'audioBase64.length=', audioBase64.length, 'arrayBuffer.byteLength=', arrayBuffer.byteLength);
  const u8 = new Uint8Array(arrayBuffer, 0, Math.min(4, arrayBuffer.byteLength));
  console.log('sandbox: first bytes (expect OggS = 79,103,103,83)', Array.from(u8));
  try {
    console.log('sandbox: decodeAndResample start');
    const pcm = await decodeAndResample(arrayBuffer);
    console.log('sandbox: decodeAndResample done, pcm.length=', pcm.length);
    console.log('sandbox: loadModel start');
    const m = await loadModel();
    console.log('sandbox: transcribe start');
    const result = await m.transcribe(pcm, TARGET_SAMPLE_RATE, {
      returnTimestamps: false,
      enableProfiling: false,
    });
    console.log('sandbox: transcribe done, text length=', (result.utterance_text || '').length);
    send({ transcript: result.utterance_text || '' });
  } catch (e) {
    console.error('sandbox: transcribe error', e);
    send({ error: (e && e.message) || String(e) });
  }
});

if (window.parent !== window) {
  window.parent.postMessage({ type: 'parakeet-sandbox-ready' }, '*');
}
