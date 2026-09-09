// Isolated UI smoke-test rack. No model calls and no network posting.
// Run with: node test/ui-fixture.js (http://127.0.0.1:3034)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStore } from '../src/config.js';
import { createApp } from '../src/server.js';

const directory = mkdtempSync(resolve(tmpdir(), 'trashposter-ui-'));
const store = createStore(directory), c = store.get();
const script = resolve(directory, 'tone.cjs');
writeFileSync(script, 'let p="";process.stdin.on("data",d=>p+=d);process.stdin.on("end",()=>setTimeout(()=>console.log("Test tone from "+process.cwd()+".\\n"+p.match(/PERSONALITY: (.*)/)[0]),2000));');
c.agents = [{ id: 'tone', name: 'Test tone', command: process.execPath, args: [script], env: {}, delivery: 'stdin', output: 'stdout', enabled: true }];
c.spaces = [{ id: 'fixture', name: 'Disposable studio', path: directory, enabled: true }];
c.url = 'http://fixture.invalid'; c.token = ''; store.save(c);
const { server, engine } = createApp({ directory, fetch: async (_url, opts) => {
  if (opts.method === 'POST') throw new Error('UI fixture cannot post.');
  return Response.json({ threads: [] });
} });
server.listen(3034, '127.0.0.1', () => console.log('Isolated UI test rack: http://127.0.0.1:3034'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { engine.stop(); server.close(() => { rmSync(directory, { recursive: true, force: true }); process.exit(); }); });
