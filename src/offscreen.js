/**
 * Offscreen document: runs Parakeet (WebGPU) and decode/resample.
 * Connects to the service worker; receives { type: 'transcribe', audioBase64 },
 * posts progress updates, then replies with { transcript } or { error }.
 *
 * We set ONNX Runtime WASM paths to the extension base URL before Parakeet runs so the jsep script/WASM
 * are loaded from the extension (CSP allows 'self') instead of the CDN.
 */
import { fromHub } from 'parakeet.js';
import { SmartProgressiveStreamingHandler } from './progressive-streaming.js';

const TargetSampleRate = 16000;
/** Voice notes longer than this use progressive (chunked) transcription. */
const StreamingDurationThresholdSec = 60;

const Prefix = '[Parakeet-WA offscreen]';

function log(...args) {
  console.log(Prefix, ...args);
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
      decoded => {
        audioContext.close();
        const duration = decoded.duration;
        const length = Math.ceil(duration * TargetSampleRate);
        const offline = new OfflineAudioContext(1, length, TargetSampleRate);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start(0);
        offline.startRendering().then(rendered => {
          const ch = rendered.getChannelData(0);
          const pcm = new Float32Array(ch.length);
          pcm.set(ch);
          resolve({ pcm, duration });
        }, reject);
      },
      reject,
    );
  });
}

let model = null;
let loadPromise = null;

function postProgress(payload) {
  if (port) port.postMessage({ type: 'progress', ...payload });
}

/**
 * Aggregate per-file download progress into an overall percentage.
 * @param {Map<string, { loaded: number, total: number }>} fileProgress
 */
function overallDownloadPercent(fileProgress) {
  let loaded = 0;
  let total = 0;
  for (const p of fileProgress.values()) {
    loaded += p.loaded || 0;
    total += p.total || 0;
  }
  if (total <= 0) return 0;
  return Math.min(100, Math.round((loaded / total) * 100));
}

async function loadModel(
  modelVersion = 'parakeet-tdt-0.6b-v3',
  device = 'webgpu',
) {
  if (model) return model;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    log('Preparing ORT and fetching model manifest...', modelVersion, device);
    postProgress({ stage: 'download', percent: 0 });
    await ensureOrtPathsFromExtension();

    const backend = device === 'webgpu' ? 'webgpu-hybrid' : 'wasm';
    const quantization =
      backend === 'wasm'
        ? {
            encoderQuant: 'int8',
            decoderQuant: 'int8',
            preprocessor: 'nemo128',
          }
        : {
            encoderQuant: 'fp32',
            decoderQuant: 'int8',
            preprocessor: 'nemo128',
          };

    const fileProgress = new Map();

    model = await fromHub(modelVersion, {
      backend,
      ...quantization,
      progress: progressData => {
        const { loaded, total, file } = progressData;
        fileProgress.set(file, { loaded: loaded || 0, total: total || 0 });
        const percent = overallDownloadPercent(fileProgress);
        log(
          `Download progress :: file=${file} progress=${percent} loaded=${loaded} total=${total}`,
        );
        postProgress({ stage: 'download', percent, file });
      },
    });

    log('Model loaded and ready.');
    postProgress({ stage: 'download', percent: 100 });
    return model;
  })().catch(err => {
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

/**
 * Transcribe a single PCM window (used by one-shot and progressive handler).
 * @param {Float32Array} audio
 */
async function transcribeWindow(audio) {
  if (!model) throw new Error('Model not loaded. Call load() first.');

  const result = await model.transcribe(audio, TargetSampleRate, {
    returnTimestamps: true,
    returnConfidences: true,
    temperature: 1.0,
  });

  const sentences = groupWordsIntoSentences(result.words || []);

  return {
    text: result.utterance_text || '',
    sentences,
    words: result.words || [],
  };
}

/**
 * One-shot transcription of the full buffer.
 * @param {Float32Array} audio
 */
async function transcribeOneShot(audio) {
  const startTime = performance.now();
  const result = await transcribeWindow(audio);
  const latency = (performance.now() - startTime) / 1000;
  const audioDuration = audio.length / TargetSampleRate;
  log(
    `One-shot done: duration=${audioDuration.toFixed(1)}s latency=${latency.toFixed(2)}s rtf=${(audioDuration / latency).toFixed(2)}x`,
  );
  return result.text || '';
}

/**
 * Progressive / chunked transcription for long audio.
 * @param {Float32Array} audio
 */
async function transcribeStreaming(audio) {
  const handler = new SmartProgressiveStreamingHandler(
    { transcribe: pcm => transcribeWindow(pcm) },
    {
      maxWindowSize: 15.0,
      sentenceBuffer: 2.0,
      sampleRate: TargetSampleRate,
    },
  );

  const audioDuration = audio.length / TargetSampleRate;
  let lastText = '';

  for await (const partial of handler.transcribeBatch(audio)) {
    lastText = partial.text;
    postProgress({
      stage: 'transcribe',
      streaming: true,
      fixedText: partial.fixedText || '',
      activeText: partial.activeText || '',
      transcript: lastText,
      timestamp: partial.timestamp,
      audioDuration,
      isFinal: partial.isFinal,
    });
  }

  return lastText;
}

/**
 * Group words into sentences based on punctuation.
 * Used for sentence-aware window sliding in progressive transcription.
 */
function groupWordsIntoSentences(words) {
  if (!words || words.length === 0) {
    return [];
  }

  const sentences = [];
  let currentWords = [];
  let currentStart = words[0].start_time || 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    currentWords.push(word.text);

    const endsWithTerminalPunctuation = /[.!?]$/.test(word.text);

    if (endsWithTerminalPunctuation || i === words.length - 1) {
      sentences.push({
        text: currentWords.join(' ').trim(),
        start: currentStart,
        end: word.end_time || word.start_time || 0,
      });

      if (i < words.length - 1) {
        currentWords = [];
        currentStart = words[i + 1].start_time || word.end_time || 0;
      }
    }
  }

  return sentences;
}

let port = null;

function connect() {
  if (port) return;
  log('Connecting to service worker...');
  port = chrome.runtime.connect({ name: 'parakeet-offscreen' });

  port.onDisconnect.addListener(() => {
    log('port disconnected');
    port = null;
  });

  port.onMessage.addListener(async msg => {
    const { type, audioBase64 } = msg || {};
    if (
      type !== 'transcribe' ||
      !audioBase64 ||
      typeof audioBase64 !== 'string'
    )
      return;
    try {
      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const arrayBuffer = bytes.buffer;

      // Decode audio and load model in parallel (model download shows progress)
      const [{ pcm, duration }] = await Promise.all([
        decodeAndResample(arrayBuffer),
        loadModel(),
      ]);
      log(`Decoded audio duration=${duration.toFixed(2)}s`);

      postProgress({
        stage: 'transcribe',
        streaming: duration > StreamingDurationThresholdSec,
      });

      let transcript;
      if (duration > StreamingDurationThresholdSec) {
        log(
          `Using progressive streaming (duration ${duration.toFixed(1)}s > ${StreamingDurationThresholdSec}s)`,
        );
        transcript = await transcribeStreaming(pcm);
      } else {
        log(`Using one-shot transcription (duration ${duration.toFixed(1)}s)`);
        transcript = await transcribeOneShot(pcm);
      }

      port.postMessage({ type: 'result', transcript: transcript || '' });
    } catch (e) {
      port.postMessage({
        type: 'result',
        error: (e && e.message) || String(e),
      });
    }
  });
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'offscreen-reconnect') {
    connect();
  }
});

connect();
