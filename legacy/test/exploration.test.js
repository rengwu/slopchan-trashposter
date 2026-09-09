import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createReader, readPath, readTools } from '../src/slopchan-mcp.js';
import { explorationArgs, readerScript } from '../src/exploration.js';
import { buildPrompt } from '../src/engine.js';
import { defaults } from '../src/config.js';

test('exploration paths support full reads, older pages and encoded site-wide searches', () => {
  assert.equal(readPath('list_threads', { page: 9 }), '/api/threads?page=9');
  assert.equal(readPath('read_thread', { id: 123 }), '/api/threads/123');
  assert.equal(readPath('read_post', { id: 456 }), '/api/posts/456');
  const path = new URL(readPath('search_posts', { query: 'a & b / unicode 雪', page: 2 }), 'https://board.test');
  assert.equal(path.searchParams.get('q'), 'a & b / unicode 雪'); assert.equal(path.searchParams.get('page'), '2');
  for (const [name, args] of [['post', {}], ['read_thread', { id: '../admin' }], ['read_post', { id: -1 }], ['list_threads', { page: 0 }], ['list_threads', { url: 'https://other.test' }], ['search_posts', { query: '' }]]) assert.throws(() => readPath(name, args));
});
test('reader sends only unauthenticated GETs to the configured board and keeps full text', async () => {
  const calls = [], longText = 'x'.repeat(10000);
  const read = createReader('https://board.test/prefix/', async (url, options) => { calls.push({ url, options }); return Response.json({ posts: [{ text: longText }] }); });
  assert.equal((await read('read_thread', { id: 20 })).posts[0].text.length, 10000);
  assert.equal(calls[0].url, 'https://board.test/prefix/api/threads/20');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.headers.Authorization, undefined); assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(read('read_thread', { id: 20, method: 'POST' })); assert.equal(calls.length, 1);
  assert.throws(() => createReader('https://user:password@board.test'));
});
test('existing Codex/Claude registrations get session-only reader tools; custom CLI args remain intact', () => {
  const c = defaults();
  const codex = explorationArgs('/usr/local/bin/codex', c.agents[0].args, c.url);
  assert.ok(codex.includes('read-only')); assert.ok(codex.some(a => a.includes(readerScript)));
  assert.ok(codex.some(a => a.includes('default_tools_approval_mode="approve"')));
  const claude = explorationArgs('/usr/local/bin/claude', c.agents[1].args, c.url);
  const allow = claude[claude.indexOf('--allowedTools') + 1];
  assert.match(allow, /Read,Glob,Grep/);
  for (const tool of readTools) assert.ok(allow.includes(`mcp__trashposter_board__${tool.name}`));
  const config = JSON.parse(claude[claude.indexOf('--mcp-config') + 1]);
  assert.deepEqual(config.mcpServers.trashposter_board.args, [readerScript, c.url]);
  assert.deepEqual(explorationArgs('custom-cli', ['--prompt', 'hello'], c.url), ['--prompt', 'hello']);
  assert.equal(c.agents[1].args[c.agents[1].args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep');
});
test('prompt explicitly permits exploration but keeps assigned destination and token private', () => {
  const c = defaults(); c.token = 'private-post-token';
  const prompt = buildPrompt(c, c.spaces[0], c.personalities[0], [], 7);
  for (const name of readTools.map(t => t.name)) assert.ok(prompt.includes(name));
  assert.match(prompt, /NOT the entire site/); assert.match(prompt, /No authentication is required/);
  assert.match(prompt, /does not change the assigned posting destination/); assert.match(prompt, /reply to thread #7/);
  assert.ok(!prompt.includes(c.token));
});
test('stdio MCP handshake, discovery and actual HTTP queries work without model calls', { timeout: 10000 }, async t => {
  const requests = [];
  const board = http.createServer((req, res) => { requests.push({ path: req.url, method: req.method, auth: req.headers.authorization }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url, posts: [{ id: 99, text: 'content beyond the initial snapshot' }] })); });
  await new Promise(r => board.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [readerScript, `http://127.0.0.1:${board.address().port}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => { child.kill('SIGTERM'); await exit; await new Promise(r => board.close(r)); });
  const lines = createInterface({ input: child.stdout }); let sequence = 0;
  const pending = new Map();
  lines.on('line', line => { const result = JSON.parse(line); pending.get(result.id)?.(result); pending.delete(result.id); });
  const rpc = (method, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.deepEqual(init.result.capabilities, { tools: {} });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await rpc('tools/list')).result.tools.length, 4);
  for (const [name, args] of [['list_threads', { page: 2 }], ['read_thread', { id: 99 }], ['read_post', { id: 99 }], ['search_posts', { query: 'older context', page: 3 }]]) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.result.isError, undefined); assert.match(response.result.content[0].text, /beyond the initial snapshot/);
  }
  assert.equal(requests.length, 4); assert.ok(requests.every(r => r.method === 'GET' && !r.auth));
  const rejected = await rpc('tools/call', { name: 'create_thread', arguments: { text: 'no' } });
  assert.equal(rejected.result.isError, true); assert.equal(requests.length, 4);
});
