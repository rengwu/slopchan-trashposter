import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const expandPath = path => path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
export const agentPresets = {
  codex: { name: 'Codex', command: 'codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', '{output}', '-'], delivery: 'stdin', env: {}, output: 'file' },
  claude: { name: 'Claude', command: 'claude', args: ['-p', '--output-format', 'text', '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Glob,Grep'], delivery: 'stdin', env: {}, output: 'stdout' },
};
export function defaults() {
  return {
    version: 1, url: 'http://127.0.0.1:8080', token: '',
    prompt: 'Spend a little time exploring this workspace and the recent board conversation. Post one specific, interesting observation, tiny discovery, good question, or playful take. Be conversational, concise, and a little weird. Give the board something worth replying to. Do not repeat recent posts.',
    schedule: { mode: 'random', interval: 300, min: 180, max: 900, timeout: 300 },
    selection: { agent: 'random', space: 'random', personality: 'random' },
    posting: 'mixed', dryRun: true,
    agents: Object.entries(agentPresets).map(([id, a]) => ({ id, ...a, enabled: true })),
    spaces: [{ id: 'homebase', name: 'Home base', path: resolve(import.meta.dirname, '../..', 'slopchan'), enabled: true }],
    personalities: [
      { id: 'lurker', name: 'Internet cryptid', color: '#c5fa66', prompt: 'You are a friendly internet cryptid who has lived in a forum since 2003. Write lowercase, make oddly specific observations, and leave a little mystery. Stay grounded in actual context. No forced catchphrases.', enabled: true },
      { id: 'archivist', name: 'Diskette detective', color: '#78ddff', prompt: 'You are a curious digital archaeologist. Notice forgotten details, strange file names, design decisions and connections. Share a concrete find with a short explanation of why it is interesting. Never invent discoveries.', enabled: true },
      { id: 'goblin', name: 'Chaos goblin', color: '#ff90c8', prompt: 'You are a playful software goblin with surprisingly good taste. Have an opinion, ask a cheeky question, or propose a tiny absurd experiment. Be funny without being mean. Keep the post short and specific.', enabled: true },
      { id: 'aero', name: 'Aero optimist', color: '#b4a2ff', prompt: 'You believe the future looks like translucent blue plastic and a grassy hill. Be warmly enthusiastic about one real detail you notice. Share a small possibility or an inviting question. Avoid generic praise.', enabled: true },
    ],
  };
}
const fail = message => { throw new Error(message); };
export function validate(input) {
  const c = structuredClone(input);
  let url;
  try { url = new URL(c.url); } catch { fail('Enter a valid slopchan URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Use an HTTP(S) board URL without credentials, query, or fragment.');
  c.url = c.url.replace(/\/+$/, '');
  if (typeof c.token !== 'string' || c.token.length > 8192 || /[\r\n]/.test(c.token)) fail('Invalid token.');
  if (typeof c.prompt !== 'string' || c.prompt.length > 30000) fail('Core prompt must be at most 30,000 characters.');
  if (!['fixed', 'random'].includes(c.schedule?.mode)) fail('Choose a valid clock mode.');
  for (const key of ['interval', 'min', 'max', 'timeout']) if (!Number.isInteger(c.schedule[key]) || c.schedule[key] < (key === 'timeout' ? 5 : 10) || c.schedule[key] > 86400) fail(`${key}: use whole seconds between ${key === 'timeout' ? 5 : 10} and 86400.`);
  if (c.schedule.min > c.schedule.max) fail('Minimum interval cannot exceed maximum.');
  if (!['thread', 'reply', 'mixed'].includes(c.posting)) fail('Invalid posting mode.');
  if (typeof c.dryRun !== 'boolean') fail('Invalid preview mode.');
  for (const group of ['agents', 'spaces', 'personalities']) {
    if (!Array.isArray(c[group]) || c[group].length > 100) fail(`Maximum 100 ${group}.`);
    const ids = new Set();
    for (const item of c[group]) {
      if (typeof item.id !== 'string' || !/^[\w-]{1,80}$/.test(item.id) || ids.has(item.id)) fail(`Invalid or duplicate ${group} ID.`);
      ids.add(item.id);
      if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || typeof item.enabled !== 'boolean') fail(`Give each ${group} entry a name and enabled state.`);
      if (group === 'agents') {
        if (typeof item.command !== 'string' || !item.command.trim() || item.command.length > 4096) fail('Agent executable is required.');
        if (!Array.isArray(item.args) || item.args.length > 100 || item.args.some(a => typeof a !== 'string' || a.length > 30000 || a.includes('\0'))) fail('Arguments must be a JSON array of strings.');
        if (!['stdin', 'argv'].includes(item.delivery) || !['stdout', 'file'].includes(item.output)) fail('Invalid prompt delivery or output mode.');
        if (item.output === 'file' && !item.args.some(a => a.includes('{output}'))) fail('File output requires {output} in the arguments.');
        if (!item.env || Array.isArray(item.env) || typeof item.env !== 'object' || Object.entries(item.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0'))) fail('Environment must be a JSON object of string values.');
      }
      if (group === 'spaces' && (typeof item.path !== 'string' || !isAbsolute(expandPath(item.path)))) fail('Folder paths must be absolute (~/ is okay).');
      if (group === 'personalities' && (typeof item.prompt !== 'string' || item.prompt.length > 20000 || !/^#[\da-f]{6}$/i.test(item.color))) fail('Personality requires a prompt and hex color.');
    }
  }
  for (const [key, group] of Object.entries({ agent: 'agents', space: 'spaces', personality: 'personalities' })) {
    if (c.selection?.[key] !== 'random' && !c[group].some(x => x.id === c.selection?.[key] && x.enabled)) fail(`Select an enabled ${key}, or shuffle.`);
  }
  return c;
}
export function writePrivate(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function createStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = resolve(directory, 'config.json');
  let config = validate(readJson(path, defaults()));
  return { directory, get: () => structuredClone(config), save(value) { const next = validate(value); writePrivate(path, next); config = next; return this.get(); } };
}
