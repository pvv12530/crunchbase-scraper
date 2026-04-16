import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  plugins: [
    tailwindcss(),
    react(),
    viteStaticCopy({
      targets: [{ src: 'manifest.json', dest: '.' }],
    }),
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: path.resolve(root, 'src/background/index.ts'),
        index: path.resolve(root, 'index.html'),
        'content/crunchbase': path.resolve(root, 'src/content/crunchbase/index.ts'),
        'content/pageHook': path.resolve(root, 'src/content/crunchbase/pageHookMain.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'content/crunchbase') {
            return 'content/crunchbase.js';
          }
          if (chunkInfo.name === 'content/pageHook') {
            return 'content/pageHook.js';
          }
          return '[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
