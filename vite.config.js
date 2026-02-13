import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen.js'),
        sandbox: resolve(__dirname, 'src/sandbox.js'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'offscreen' ? 'offscreen.js' : chunk.name === 'sandbox' ? 'sandbox.js' : '[name].js',
        chunkFileNames: (chunkInfo) =>
          chunkInfo.name === 'offscreen' ? 'offscreen-[hash].js' : 'sandbox-[hash].js',
        assetFileNames: 'sandbox-[hash][extname]',
      },
    },
    minify: false,
    sourcemap: true,
  },
});
