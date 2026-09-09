import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStore, defaults, validate } from '../src/config.js';
import { Engine, choose, intervalMs, buildPrompt } from '../src/engine.js';
import { createApp } from '../src/server.js';

function fixture(t, { code = 'process.stdin.resume(); process.stdin.on("end", () => console.log("a tiny useful observation"));', live = false, posting = 'thread', file = false } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'trashposter-test-'));
  const store = createStore(directory);
  const script = resolve(directory, 'fake-agent.cjs'); writeFileSync(script, code);
  const config = store.get();
  config.agents = [{ id: 'test', name: 'Test agent', command: process.execPath, args: [script, ...(file ? ['{output}'] : [])], env: {}, delivery: 'stdin', output: file ? 'file' : 'stdout', enabled: true }];
  config.spaces = [{ id: 'test', name: 'Test workspace', path: directory, enabled: true }];
  config.selection = { agent: 'test', space: 'test', personality: 'lurker' };
  config.dryRun = !live; config.token = 'test-secret-bearer'; config.posting = posting;
  store.save(config);
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, ...options });
    if (options.method === 'POST') return Response.json({ post: { id: 42 } }, { status: 201 });
    if (url.endsWith('/api/threads/7')) return Response.json({ id: 7, posts: [{ id: 7, text: 'the selected discussion' }] });
    return Response.json({ threads: [{ id: 7, full: false, posts: [{ id: 7, text: 'recent context' }] }] });
  };
  const engine = new Engine(store, { fetch: fakeFetch });
  t.after(() => { engine.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, engine, requests, config };
}
test('validates intervals, missing references and literal command arguments', () => {
  const c = defaults(); c.schedule.min = 0; assert.throws(() => validate(c), /min/);
  c.schedule.min = 1000; assert.throws(() => validate(c), /Minimum/);
  c.schedule.min = 100; c.selection.agent = 'missing'; assert.throws(() => validate(c), /enabled agent/);
  c.selection.agent = 'random'; c.agents[0].args = ['$(echo nope)', '`whoami`']; c.agents[0].output = 'stdout'; assert.deepEqual(validate(c).agents[0].args, c.agents[0].args);
});
test('clock and selector honor fixed, bounded random and enabled pools', () => {
  const s = { mode: 'random', min: 10, max: 20, interval: 42 };
  assert.equal(intervalMs(s, () => 0), 10000); assert.equal(intervalMs(s, () => .9999), 20000);
  assert.equal(intervalMs({ ...s, mode: 'fixed' }), 42000);
  const items = [{ id: 'off', enabled: false }, { id: 'a', enabled: true }, { id: 'b', enabled: true }];
  assert.equal(choose(items, 'random', () => 0).id, 'a'); assert.equal(choose(items, 'b').id, 'b'); assert.throws(() => choose(items, 'off'));
});
test('preview launches inside the chosen folder with core + personality + board context; never posts', async t => {
  const f = fixture(t, { code: 'let p="";process.stdin.on("data",d=>p+=d);process.stdin.on("end",()=>console.log(JSON.stringify({cwd:process.cwd(),prompt:p,token:process.env.SLOPCHAN_TOKEN||null})));' });
  const run = await f.engine.launch(); assert.equal(run.status, 'preview');
  const result = JSON.parse(run.text);
  assert.equal(result.cwd, realpathSync(f.directory)); assert.equal(result.token, null);
  assert.match(result.prompt, /CORE DIRECTION/); assert.match(result.prompt, /Internet cryptid/); assert.match(result.prompt, /recent context/);
  assert.ok(!result.prompt.includes(f.config.token)); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});
test('live run posts exactly one final response with bearer auth', async t => {
  const f = fixture(t, { live: true }); const run = await f.engine.launch();
  assert.equal(run.status, 'posted'); assert.equal(run.postId, 42);
  const posts = f.requests.filter(r => r.method === 'POST'); assert.equal(posts.length, 1);
  assert.equal(posts[0].headers.Authorization, `Bearer ${f.config.token}`); assert.equal(JSON.parse(posts[0].body).text, 'a tiny useful observation');
  assert.ok(posts[0].url.endsWith('/api/threads')); assert.ok(run.postUrl.endsWith('/posts/42'));
});
test('reply mode retrieves full thread and uses reply endpoint', async t => {
  const f = fixture(t, { live: true, posting: 'reply' }); const run = await f.engine.launch();
  assert.equal(run.thread, 7); assert.equal(run.status, 'posted');
  assert.ok(f.requests.some(r => r.method === 'GET' && r.url.endsWith('/api/threads/7')));
  assert.ok(f.requests.some(r => r.method === 'POST' && r.url.endsWith('/api/threads/7/posts')));
});
test('file adapter ignores stdout telemetry and publishes only response file', async t => {
  const f = fixture(t, { file: true, code: 'process.stdin.resume();process.stdin.on("end",()=>{console.log("telemetry, not a post");require("fs").writeFileSync(process.argv[2],"the actual post");});' });
  const run = await f.engine.launch(); assert.equal(run.status, 'preview'); assert.equal(run.text, 'the actual post'); assert.match(run.log, /telemetry/);
});
test('argv delivery treats prompt metacharacters literally', async t => {
  const f = fixture(t, { code: 'console.log(process.argv[2].includes("$(touch do-not-create)") ? "literal argument" : "bad argument");' });
  const c = f.store.get(); c.prompt = '$(touch do-not-create)'; c.agents[0].delivery = 'argv'; f.store.save(c);
  assert.equal((await f.engine.launch()).text, 'literal argument');
});
test('failed or empty agents never post', async t => {
  for (const code of ['process.exit(2)', 'process.stdin.resume()']) {
    const f = fixture(t, { live: true, code }); const run = await f.engine.launch(); assert.equal(run.status, 'failed'); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  }
});
test('stop cancels process and prohibits a subsequent post; concurrent launch rejected', async t => {
  const f = fixture(t, { live: true, code: 'setTimeout(()=>console.log("too late"),30000)' });
  const job = f.engine.launch();
  await assert.rejects(f.engine.launch(), /already running/);
  await new Promise(r => setTimeout(r, 150)); f.engine.stop();
  const run = await job; assert.equal(run.status, 'cancelled'); assert.equal(f.engine.active, false); assert.equal(f.engine.nextAt, null); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});
test('configured secrets are redacted from logs and blocked from posting', async t => {
  const f = fixture(t, { live: true, code: 'console.log("test-secret-bearer");' });
  const run = await f.engine.launch(); assert.equal(run.status, 'failed'); assert.match(run.error, /secret/); assert.ok(!run.log.includes(f.config.token)); assert.equal(run.text, '');
});
test('network write failure is recorded once, never retried', async t => {
  const f = fixture(t, { live: true }); const original = f.engine.fetch; let writes = 0;
  f.engine.fetch = async (url, opts) => { if (opts.method === 'POST') { writes++; throw new Error('Connection dropped'); } return original(url, opts); };
  const run = await f.engine.launch(); assert.equal(writes, 1); assert.equal(run.status, 'failed'); assert.match(run.error, /uncertain/);
});
test('session timeout terminates a stalled agent without publishing', async t => {
  const f = fixture(t, { live: true, code: 'setTimeout(()=>console.log("late"),30000)' });
  const c = f.store.get(); c.schedule.timeout = 5; f.store.save(c);
  const run = await f.engine.launch(); assert.equal(run.status, 'cancelled'); assert.match(run.error, /timed out/); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});
test('periodic transport launches on its clock and arms the next interval after completion', async t => {
  const f = fixture(t); const c = f.store.get(); c.schedule.mode = 'fixed'; c.schedule.interval = 10; f.store.save(c);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  f.engine.start(); assert.equal(f.engine.nextAt, 110000); assert.equal(f.engine.runs.length, 0);
  t.mock.timers.tick(9999); assert.equal(f.engine.runs.length, 0);
  t.mock.timers.tick(1); assert.equal(f.engine.runs.length, 1); assert.ok(f.engine.current); assert.equal(f.engine.nextAt, null);
  for (let tries = 0; f.engine.current && tries < 100000; tries++) await new Promise(r => setImmediate(r));
  assert.equal(f.engine.runs[0].status, 'preview'); assert.equal(f.engine.nextAt, 120000);
  f.engine.stop(); t.mock.timers.tick(20000); assert.equal(f.engine.runs.length, 1);
});
test('config and run history persist privately; restart never rearms', async t => {
  const f = fixture(t); await f.engine.launch(); f.engine.start(); assert.ok(f.engine.nextAt);
  const next = new Engine(createStore(f.directory)); assert.equal(next.active, false); assert.equal(next.runs[0].status, 'preview'); assert.equal(next.store.get().token, f.config.token);
  assert.equal(statSync(resolve(f.directory, 'config.json')).mode & 0o777, 0o600);
  assert.equal(statSync(resolve(f.directory, 'history.json')).mode & 0o777, 0o600);
});
test('HTTP API rejects cross-origin/host and missing session; hides token and preserves it on save', async t => {
  const f = fixture(t); const app = createApp({ directory: f.directory });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => app.server.close(r)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = await (await fetch(base + '/api/state')).json(); assert.equal(state.config.token, undefined); assert.equal(state.config.hasToken, true);
  assert.equal((await fetch(base + '/api/start', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => { http.get(base + '/api/state', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
  assert.equal(badHostStatus, 403);
  const response = await fetch(base + '/api/config', { method: 'POST', headers: { 'X-Trashposter-Session': state.session, 'Content-Type': 'application/json' }, body: JSON.stringify(state.config) });
  assert.equal(response.status, 200); assert.equal(app.store.get().token, f.config.token);
  app.engine.start(); const locked = await fetch(base + '/api/config', { method: 'POST', headers: { 'X-Trashposter-Session': state.session }, body: JSON.stringify(state.config) }); assert.equal(locked.status, 400); app.engine.stop();
});
