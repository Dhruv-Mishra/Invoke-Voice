import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./public', import.meta.url));

export default defineConfig({
  root,
  publicDir: false,
  build: {
    outDir: path.resolve(root, '../dist'),
    emptyOutDir: true,
    manifest: true,
  },
  server: {
    port: 4318,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/voice': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
});