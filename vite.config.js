import { defineConfig } from 'vite';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync.native(fileURLToPath(new URL('./public', import.meta.url)));

export default defineConfig({
  root,
  publicDir: false,
  build: {
    outDir: path.resolve(root, '../dist'),
    emptyOutDir: true,
    manifest: true,
    assetsInlineLimit: 0,
  },
  server: {
    port: 4318,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT || 4317}`,
      '/voice': { target: `ws://127.0.0.1:${process.env.PORT || 4317}`, ws: true, changeOrigin: true },
    },
  },
});