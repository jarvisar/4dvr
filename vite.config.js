import http from 'node:http';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR needs a secure context: https, or http on localhost. `npm run dev` serves
// both on one port, so http://localhost:5173 works on this PC, and a Quest on the
// same network can open https://<your-pc-ip>:5173 (accept the certificate warning
// once). Plain http from another device is redirected to https.
// NO_SSL=1 serves plain http only.
export default defineConfig({
  base: './', // relative asset URLs: works at any GitHub Pages sub-path
  plugins: process.env.NO_SSL ? [] : [basicSsl(), httpAndHttps()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      // the IWER DevUI chunk (?iwer only) bundles React components marked "use client"
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
    },
  },
});

// Accept plain http on the https port: look at the first byte of each connection
// (22 starts a TLS handshake) and pass plain http to a second server.
function httpAndHttps() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const setup = (server) => {
    const tlsServer = server.httpServer;
    if (!tlsServer?.setSecureContext) return;
    const plain = http.createServer((req, res) => {
      const host = req.headers.host || '';
      if (local.test(host)) return server.middlewares(req, res);
      res.writeHead(307, { Location: `https://${host}${req.url}` });
      res.end();
    });
    plain.on('upgrade', (req, socket, head) => tlsServer.emit('upgrade', req, socket, head)); // HMR websocket
    const onTls = tlsServer.listeners('connection');
    tlsServer.removeAllListeners('connection');
    tlsServer.on('connection', (socket) => {
      socket.once('readable', () => {
        const first = socket.read(1);
        if (!first) return;
        socket.unshift(first);
        if (first[0] === 22) for (const fn of onTls) fn.call(tlsServer, socket);
        else plain.emit('connection', socket);
      });
    });
  };
  return { name: 'http-and-https', configureServer: setup, configurePreviewServer: setup };
}
