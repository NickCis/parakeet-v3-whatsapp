# WhatsApp Parakeet Transcription

Chrome extension that transcribes WhatsApp Web voice messages locally using [Parakeet TDT 0.6B v3](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) via [parakeet.js](https://github.com/ysdede/parakeet.js). No API key; all processing runs in your browser (WebGPU).

## Build

```bash
npm install
npm run build
```

## Load in Chrome

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the **`dist`** folder (not the repo root)

## Usage

1. Open [web.whatsapp.com](https://web.whatsapp.com)
2. A "Transcribe" button appears next to each voice message
3. Click it; the first time the ~2.5 GB model will download (one-time, cached in IndexedDB)
4. The transcript appears below the button

## Requirements

- Chrome 113+ (WebGPU)
- The extension needs the **offscreen** permission to decode audio and run the model
