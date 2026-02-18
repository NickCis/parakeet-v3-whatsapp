import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Force all onnxruntime-web to be the same
      'onnxruntime-web': resolve(__dirname, 'node_modules/onnxruntime-web'),
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
