# WhatsApp Parakeet Transcription

**Disclaimer:** This project has no affiliation with WhatsApp, NVIDIA, or the Parakeet team. It is an independent, community-made Chrome extension.

## Download

The extension can be downloaded from the **Chrome Web Store**:

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/jclpnlbgonmnhfocgmhjbaoeglooegjj.svg)](https://chromewebstore.google.com/detail/whatsapp-parakeet-transcr/jclpnlbgonmnhfocgmhjbaoeglooegjj)

**[Install from Chrome Web Store](https://chromewebstore.google.com/detail/whatsapp-parakeet-transcr/jclpnlbgonmnhfocgmhjbaoeglooegjj)**

## Description

A Chrome extension that transcribes WhatsApp Web voice messages **locally** in your browser using [Parakeet TDT 0.6B v3](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) via [parakeet.js](https://github.com/ysdede/parakeet.js). No API keys or cloud services—all processing runs on your machine with WebGPU. A "Transcribe" button appears next to each voice message; click it to get the transcript.

**Inspired by:**

- [parakeet-v3-streaming](https://huggingface.co/spaces/andito/parakeet-v3-streaming) (Hugging Face Space by andito)
- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) by pedroslopez

## How transcription works

After you click **Transcribe**, the extension downloads the voice note, decodes it to 16 kHz PCM, and runs Parakeet in an offscreen document.

### Model download

The first time you transcribe, the ~2.5 GB model is downloaded and cached in IndexedDB. While that happens, the UI shows a **Downloading model…** status with an overall percentage (aggregated across model files). Once the model is cached, later messages skip this step and go straight to transcription.

### One-shot vs progressive streaming

| Audio length | Mode | Behavior |
|--------------|------|----------|
| **≤ 60 seconds** | One-shot | The full clip is transcribed in a single model call. Best accuracy and speed when the clip fits in GPU memory. |
| **> 60 seconds** | Progressive (chunked) | The clip is processed in overlapping ~15 s windows so long notes do not OOM or hang WebGPU. |

### Progressive streaming (long voice notes)

For notes longer than 60 seconds we use the same **smart progressive** idea as the [andito HF Space](https://huggingface.co/spaces/andito/parakeet-v3-streaming) / [speech-to-speech](https://github.com/huggingface/speech-to-speech) algorithm, adapted for **offline** files (not live microphone):

1. Take the next window of audio (up to **15 seconds** from the current position).
2. Run Parakeet on that window and get word-level timestamps.
3. Split words into sentences (on `.` `!` `?`).
4. **Lock** sentences that end before the end of the window minus a **2 second** buffer—these become “fixed” text and will not be re-decoded.
5. Slide the window forward to the end of the last fixed sentence and repeat until the whole note is covered.
6. After each window, the UI updates: spinner stays visible, **fixed** text is shown in normal color, and the still-active tail is shown dimmed.

Because voice notes are already complete, we do **not** re-transcribe every 500 ms like the live demo. We walk the file once, as fast as the GPU allows, which keeps peak memory bounded without paying a large recompute tax on shorter long-notes.

## Build

```bash
npm install
npm run build
```

The built extension files are in the **`dist`** folder.

### Zip for store upload

To create a zip file for uploading to the Chrome Web Store (or other stores):

```bash
npm run dist
```

This runs `clean` → `build` → `package` and produces **`parakeet-v3-whatsapp-<version>.zip`** in the project root. You can also run `npm run package` after a build to create the zip without rebuilding.

## Usage

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`dist`** folder (not the repo root)
5. Open [web.whatsapp.com](https://web.whatsapp.com)
6. A **Transcribe** button appears next to each voice message
7. Click it; the first time the ~2.5 GB model will download (one-time, cached in IndexedDB)—progress is shown in the UI
8. Short notes finish in one pass; longer notes (>60s) stream partial text while processing
9. The final transcript appears below the button

## Requirements

- Chrome 113+ (WebGPU support)
- The extension uses the **offscreen** permission to decode audio and run the model
