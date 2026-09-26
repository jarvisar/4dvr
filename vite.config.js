import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR needs a secure context. `npm run dev` serves over HTTPS with a
// self-signed certificate, so a Quest on the same network can open
// https://<your-pc-ip>:5173 (accept the certificate warning once).
// `npm run dev:http` (or NO_SSL=1) serves plain http for desktop-only work.
export default defineConfig(({ mode }) => ({
  base: './', // relative asset URLs: works at any GitHub Pages sub-path
  plugins: mode === 'http' || process.env.NO_SSL ? [] : [basicSsl()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
}));
