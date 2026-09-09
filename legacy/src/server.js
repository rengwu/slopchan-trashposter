import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore, agentPresets } from './config.js';
import { Engine } from './engine.js';

export function createApp({ directory = resolve(import.meta.dirname, '../.data'), ...options } = {}) {
  const store = createStore(directory), engine = new Engine(store, options), session = randomUUID();
  const publicDir = resolve(import.meta.dirname, '../public');
  const configForUI = () => { const c = store.get(); c.hasToken = !!c.token; delete c.token; return c; };
  const server = http.createServer(async (req, res) => {
    const address = `127.0.0.1:${server.address().port}`;
    const allowed = [address, `localhost:${server.address().port}`];
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!allowed.includes(req.headers.host)) return send(403, { error: 'Local access only.' });
    if (req.headers.origin && !allowed.some(h => req.headers.origin === `http://${h}`)) return send(403, { error: 'Cross-origin access denied.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site access denied.' });
    const path = new URL(req.url, `http://${address}`).pathname;
    try {
      if (req.method === 'GET' && path === '/api/state') return send(200, { config: configForUI(), ...engine.state(), session, availability: engine.availability(), presets: agentPresets });
      if (req.method === 'POST' && path.startsWith('/api/')) {
        if (req.headers['x-trashposter-session'] !== session) return send(403, { error: 'Reload the app to reconnect to this server.' });
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 1000000) return send(413, { error: 'Request too large.' }); }
        const body = raw ? JSON.parse(raw) : {};
        if (path === '/api/config') {
          if (engine.active || engine.current) throw new Error('Stop the transport before changing the patch.');
          const next = { ...body, token: typeof body.token === 'string' ? body.token : store.get().token };
          delete next.hasToken;
          store.save(next); return send(200, { config: configForUI(), availability: engine.availability() });
        }
        if (path === '/api/start') { engine.start(); return send(200, engine.state()); }
        if (path === '/api/stop') { engine.stop(); return send(200, engine.state()); }
        if (path === '/api/launch') { engine.check(); if (engine.current) throw new Error('An agent is already running.'); void engine.launch(); return send(202, engine.state()); }
        if (path === '/api/test') {
          const c = store.get();
          const result = await engine.board(c, '/api/threads?page=1', new AbortController().signal);
          if (!Array.isArray(result.threads)) throw new Error('This URL did not return a slopchan board.');
          return send(200, { message: `Board online · ${result.threads.length} threads on page 1. Reads are public; token is checked when posting.` });
        }
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && files[path]) { const [file, type] = files[path]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(readFileSync(resolve(publicDir, file))); }
      send(404, { error: 'Not found.' });
    } catch (error) { send(400, { error: error.message }); }
  });
  return { server, engine, store };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { server, engine } = createApp({ directory: process.env.TRASHPOSTER_DATA_DIR || undefined });
  const port = Number(process.env.PORT || 3033);
  server.listen(port, '127.0.0.1', () => console.log(`\n  ✳ SLOPCHAN TRASHPOSTER\n  http://127.0.0.1:${server.address().port}\n  Transport stopped. Open the rack to start broadcasting.\n`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { engine.stop(); server.close(); setTimeout(() => process.exit(), 2000).unref(); });
}
