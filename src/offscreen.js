/**
 * Offscreen document: runs Parakeet (WebGPU) and decode/resample.
 * Connects to the service worker; receives { type: 'transcribe', audioBase64 }, replies with { transcript } or { error }.
 *
 * We set ONNX Runtime WASM paths to the extension base URL before Parakeet runs so the jsep script/WASM
 * are loaded from the extension (CSP allows 'self') instead of the CDN.
 */
import { fromHub } from 'parakeet.js';

const TargetSampleRate = 16000;

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
        const length = Math.ceil(duration * TargetSampleRate);
        const offline = new OfflineAudioContext(1, length, TargetSampleRate);
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

async function loadModel(modelVersion = 'parakeet-tdt-0.6b-v3', device = 'webgpu') {
  if (model) return model;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    console.log('[Parakeet] Preparing ORT and fetching model manifest...', modelVersion, device);
    await ensureOrtPathsFromExtension();

    const backend = device === 'webgpu' ? 'webgpu-hybrid' : 'wasm';
    const quantization = backend === 'wasm'
      ? { encoderQuant: 'int8', decoderQuant: 'int8', preprocessor: 'nemo128' }
      : { encoderQuant: 'fp32', decoderQuant: 'int8', preprocessor: 'nemo128' };

    // Track which files we've already sent 'initiate' for
    model = await fromHub(modelVersion, {
      backend,
      ...quantization,
      progress: (progressData) => {
        const { loaded, total, file } = progressData;
        const progress = total > 0 ? Math.round((loaded / total) * 100) : 0;
        console.log(`[Parakeet] Download progress :: file=${file} progress=${progress} loaded=${loaded} total=${total}`);
      },
    });

    console.log('[Parakeet] Model loaded and ready.');
    return model;
  })();
  return loadPromise;
}

/**
 * Transcribe audio chunk using Parakeet
 */
async function transcribe(audio) {
  if (!model)
    throw new Error('Model not loaded. Call load() first.');

  try {
    const startTime = performance.now();

    // Transcribe with parakeet.js
    const result = await model.transcribe(audio, TargetSampleRate, {
      returnTimestamps: true,  // Get word-level timestamps
      returnConfidences: true,  // Get confidence scores
      temperature: 1.0,  // Greedy decoding
    });

    const endTime = performance.now();
    const latency = (endTime - startTime) / 1000;  // seconds
    const audioDuration = audio.length / 16000;
    const rtf = audioDuration / latency;  // Speed factor (inverse of traditional RTF)

    // Convert parakeet.js word format to our sentence format
    const sentences = groupWordsIntoSentences(result.words || []);

    return {
      text: result.utterance_text || '',
      sentences,
      words: result.words || [],
      chunks: result.words || [],  // For compatibility
      metadata: {
        latency,
        audioDuration,
        rtf,
        confidence: result.confidence_scores,
        metrics: result.metrics,
      },
    };
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
}

/**
 * Group words into sentences based on punctuation
 *
 * Note: This is a simplified implementation since parakeet.js provides word-level
 * alignments but not sentence-level. The Python implementation uses model-provided
 * sentence boundaries. We split on sentence-ending punctuation (.!?) to approximate
 * sentence boundaries for the progressive streaming window management.
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

    // Check if this word ends a sentence (only period, question mark, exclamation)
    // Note: We explicitly ignore commas - they don't end sentences
    const endsWithTerminalPunctuation = /[.!?]$/.test(word.text);

    if (endsWithTerminalPunctuation || i === words.length - 1) {
      // Create sentence
      sentences.push({
        text: currentWords.join(' ').trim(),
        start: currentStart,
        end: word.end_time || (word.start_time || 0),
      });

      // Start new sentence if there are more words
      if (i < words.length - 1) {
        currentWords = [];
        currentStart = words[i + 1].start_time || (word.end_time || 0);
      }
    }
  }

  return sentences;
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
    await loadModel();
    const result = await transcribe(pcm);
    port.postMessage({ transcript: result.text || '' });
  } catch (e) {
    port.postMessage({ error: (e && e.message) || String(e) });
  }
});
