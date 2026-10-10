import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BASE sets the public path for the static build (GitHub Pages serves the site under /<repo>/).
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 2000 },
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
} as never);
