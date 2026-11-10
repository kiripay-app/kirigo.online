import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// One build, three pages: the public landing page, the driver app (/driver) and admin (/admin).
// The Worker in apps/api serves dist/. In dev, API calls are proxied to `wrangler dev` on :8787.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        driver: resolve(__dirname, 'driver/index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
      },
    },
  },
  server: { proxy: { '/api': 'http://localhost:8787', '/auth': 'http://localhost:8787', '/p': 'http://localhost:8787', '/ws': { target: 'ws://localhost:8787', ws: true } } },
});
