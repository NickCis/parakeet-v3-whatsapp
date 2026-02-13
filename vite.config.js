import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Use patched ort.bundle.min.mjs so preload() returns URL instead of creating a blob (avoids CSP).
      'onnxruntime-web': resolve(__dirname, 'patched/ort.bundle.min.mjs'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen.js'),
      },
      output: {
        entryFileNames: 'offscreen.js',
        chunkFileNames: 'offscreen-[hash].js',
        assetFileNames: 'offscreen-[hash][extname]',
      },
    },
    minify: false,
    sourcemap: true,
  },
});
