# WhatsApp Parakeet Transcription

**Disclaimer:** This project has no affiliation with WhatsApp, NVIDIA, or the Parakeet team. It is an independent, community-made Chrome extension.

## Description

A Chrome extension that transcribes WhatsApp Web voice messages **locally** in your browser using [Parakeet TDT 0.6B v3](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) via [parakeet.js](https://github.com/ysdede/parakeet.js). No API keys or cloud services—all processing runs on your machine with WebGPU. A "Transcribe" button appears next to each voice message; click it to get the transcript.

**Inspired by:**

- [parakeet-v3-streaming](https://huggingface.co/spaces/andito/parakeet-v3-streaming) (Hugging Face Space by andito)
- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) by pedroslopez

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
7. Click it; the first time the ~2.5 GB model will download (one-time, cached in IndexedDB)
8. The transcript appears below the button

## Requirements

- Chrome 113+ (WebGPU support)
- The extension uses the **offscreen** permission to decode audio and run the model
