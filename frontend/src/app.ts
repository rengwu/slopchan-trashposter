import type {Config, State, Entry, Group} from './types';
import {api, getState, openPost} from './bridge';
type UIElement = HTMLInputElement & HTMLDialogElement & HTMLFormElement;
const $ = (selector: string, root: ParentNode = document): UIElement => root.querySelector(selector)!;
const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const routeGroups = {agent:'agents',space:'spaces',personality:'personalities'} as const;
const groupRoutes = {agents:'agent',spaces:'space',personalities:'personality'} as const;
const $$ = (selector: string, root: ParentNode = document): UIElement[] => [...root.querySelectorAll<UIElement>(selector)];
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
let config: Config, state: State, session: string, availability: State['availability'], presets: State['presets'];
let dirty = false, busy = false, tab: Group = 'personalities', editing: Entry, detailId: string | null, toastTimer: ReturnType<typeof setTimeout>, connected = false;
const groupInfo = { agents: { name: 'AGENT', icon: '⌘', color: '#c5fa66', singular: 'AGENT', caption: 'HEADLESS CLI AGENTS. YOUR EXISTING LOGINS. YOUR MACHINES.' }, spaces: { name: 'SPACE', icon: '▧', color: '#78ddff', singular: 'SPACE', caption: 'LAUNCH DIRECTLY INSIDE A FOLDER. LET THE CONTEXT SEEP IN.' }, personalities: { name: 'PERSONA', icon: '✳', color: '#ff90c8', singular: 'PRESET', caption: 'PROMPT PRESETS FOR YOUR MANY ALTER EGOS.' } };
const locked = () => !!(!connected || state?.active || state?.running || busy);
function toast(message: string, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 8000 : 4500); }
function markDirty() { dirty = true; document.body.classList.add('dirty'); $('#save-state').textContent = 'UNSAVED PATCH'; }

function formToConfig() {
  config.url = $('#url').value.trim(); config.prompt = $('#prompt').value; config.dryRun = $('#dryRun').checked; config.posting = $('#posting').value as Config['posting'];
  for (const key of ['interval', 'min', 'max', 'timeout'] as const) config.schedule[key] = Number($(`#${key}`).value);
  if ($('#token').value) config.token = $('#token').value;
}
async function save(show = true) {
  formToConfig();
  const data = await api('config', config); config = data.config!; availability = data.availability!; dirty = false;
  document.body.classList.remove('dirty'); $('#save-state').textContent = 'PATCH SAVED'; $('#token').value = ''; renderConfig();
  if (show) toast('Patch saved. Your beautiful nonsense is preserved.');
}
function renderConfig() {
  for (const key of ['url', 'prompt', 'posting'] as const) $(`#${key}`).value = config[key];
  for (const key of ['interval', 'min', 'max', 'timeout'] as const) $(`#${key}`).value = String(config.schedule[key]);
  $('#dryRun').checked = config.dryRun;
  $('#token-status').textContent = config.hasToken ? 'SAVED LOCALLY' : 'NOT SET';
  $('#token').placeholder = config.hasToken ? '•••••••• saved · type to replace' : 'Paste posting token';
  renderClock(); renderOutput(); renderLanes(); renderLibrary(); $('#prompt-length').textContent = `${config.prompt.length} CHARS`;
}
function renderClock() {
  const random = config.schedule.mode === 'random';
  $('#random-inputs').hidden = !random; $('#fixed-input').hidden = random;
  $$('[data-clock]').forEach(b => b.classList.toggle('selected', b.dataset.clock === config.schedule.mode));
  $('#interval-readout').textContent = random ? `${config.schedule.min}—${config.schedule.max}` : String(config.schedule.interval);
  $('#interval-description').textContent = `${random ? 'RANDOM RANGE' : 'FIXED INTERVAL'} / SECONDS`;
  $('#clock-mode').textContent = random ? 'RND CLOCK' : 'FIX CLOCK';
  const dial = $('#interval-dial'), value = random ? config.schedule.max : config.schedule.interval;
  const minimum = random ? Math.max(10, config.schedule.min) : 10;
  dial.setAttribute('aria-label', `${random ? 'Maximum random' : 'Fixed'} interval in seconds`);
  dial.setAttribute('aria-valuemin', String(minimum));
  dial.setAttribute('aria-valuenow', String(value));
  dial.setAttribute('aria-valuetext', `${value} seconds`);
  $('#dial-target').textContent = random ? 'MAX / SEC' : 'INTERVAL';
  const fraction = Math.max(0, Math.min(1, Math.log(Math.max(10, value) / 10) / Math.log(8640)));
  dial.style.setProperty('--dial-turn', `${-140 + fraction * 280}deg`);
  dial.style.setProperty('--dial-fill', `${fraction * 280}deg`);
}
function renderOutput() {
  $('#output-label').textContent = config.dryRun ? 'PREVIEW' : 'ON AIR';
  $('#output-label').style.color = config.dryRun ? 'var(--lime)' : 'var(--pink)';
  $('#output-note').textContent = config.dryRun ? 'AUDITION WITHOUT POSTING' : 'POSTS TO THE REAL BOARD';
}
function renderLanes() {
  $('#lanes').innerHTML = (Object.entries(routeGroups) as [keyof Config['selection'], Group][]).map(([key, group]) => {
    const info = groupInfo[group];
    const ready = (item: Entry) => item.enabled && (group === 'personalities' || availability?.[group]?.[item.id]);
    const selected = config.selection[key];
    const pad = (id: string, label: string, available = true, reason = '') => `<button class="route-pad ${selected === 'random' && id !== 'random' && available ? 'in-pool' : ''}" data-route="${key}" data-choice="${escape(id)}" data-unavailable="${!available}" aria-pressed="${selected === id}" title="${escape(reason || (id === 'random' ? `Randomly choose a ready ${info.name.toLowerCase()} each session` : `Use ${label} for every session`))}" ${!available ? 'disabled' : ''}>${id === 'random' ? '⚄ ' : ''}${escape(label)}</button>`;
    return `<div class="lane" style="--accent:${info.color}"><div class="lane-route"><span class="lane-icon">${info.icon}</span><span class="lane-name">${info.name}</span></div><div class="route-pads" role="group" aria-label="${info.name} routing">${pad('random', 'Shuffle')}${config[group].map(item => pad(item.id, item.name, ready(item), !item.enabled ? 'Bypassed. Enable this entry in the library first.' : !ready(item) ? 'Executable or folder unavailable. Save the patch after correcting its path.' : '')).join('')}</div><div class="pool-count">${String(config[group].filter(ready).length).padStart(2, '0')}<span>/${String(config[group].length).padStart(2, '0')}</span></div></div>`;
  }).join('');
  lockControls();
}
function renderLibrary() {
  const info = groupInfo[tab];
  $$('.library-tabs button').forEach(b => b.classList.toggle('selected', b.dataset.tab === tab));
  $('#add-entry').textContent = `+ NEW ${info.singular}`; $('#library-caption').textContent = info.caption;
  $('#library-count').textContent = `${String(config[tab].length).padStart(2, '0')} PATCHES`;
  $('#import-chartr').hidden = tab !== 'agents';
  $('#library').innerHTML = config[tab].length ? config[tab].map((item, i) => {
    const color = tab === 'personalities' ? item.color : info.color;
    const available = tab === 'personalities' || availability?.[tab]?.[item.id];
    const description = item.prompt || item.path || `${item.command} ${item.args?.join(' ') || ''}`;
    const badge = !item.enabled ? 'BYPASSED' : !available ? 'CHECK PATH' : tab === 'personalities' ? `PRESET ${String(i + 1).padStart(2, '0')}` : 'READY';
    return `<article class="preset-card ${item.enabled ? '' : 'disabled'}" style="--accent:${color}"><div class="preset-top"><span class="preset-art">${tab === 'personalities' ? ['✳', '▣', '♜', '❋', '⌘'][i % 5] : info.icon}</span><span class="preset-badge">${badge}</span></div><h3 title="${escape(item.name)}">${escape(item.name)}</h3><p>${escape(description)}</p><div class="preset-actions"><button data-toggle="${escape(item.id)}" title="Include or exclude from selection pool">${item.enabled ? '● ENABLED' : '○ BYPASSED'}</button><button data-edit="${escape(item.id)}">EDIT ↗</button><button class="remove" data-remove="${escape(item.id)}" aria-label="Remove ${escape(item.name)}">×</button></div></article>`;
  }).join('') : `<div class="empty-library">An empty slot is a beautiful possibility. Add a ${info.singular.toLowerCase()} ↗</div>`;
  lockControls();
}
function lockControls() {
  if (!state) return;
  const lock = locked();
  $$('input:not(#import-file), textarea, #posting, [data-clock], #shuffle-all, #add-entry, [data-toggle], [data-edit], [data-remove], #clear-token, #import-chartr, #save').forEach(el => { if (!el.closest('dialog')) el.disabled = lock; });
  $$('[data-route]').forEach(el => el.disabled = lock || el.dataset.unavailable === 'true');
  $('#interval-dial').setAttribute('aria-disabled', String(lock));
  $('#interval-dial').tabIndex = lock ? -1 : 0;
  $('#show-token').disabled = !$('#token').value;
  $('#play').disabled = lock || !connected; $('#launch').disabled = !!state.running || busy || !connected;
  $('#stop').disabled = !(state.active || state.running) || !connected; $('#test-board').disabled = busy || lock || !connected;
  $('.workspace').classList.toggle('patch-locked', lock);
}
function renderState() {
  document.body.classList.toggle('running', !!(state.active || state.running));
  $('#transport-status').textContent = state.running ? '● AGENT RUNNING' : state.active ? '● SEQUENCING' : '● STANDBY';
  $('#run-count').textContent = `${String(state.runs.length).padStart(3, '0')} SESSIONS`;
  $('#log-count').textContent = state.runs.length ? `${state.runs.filter(r => r.status === 'posted').length} POSTED / ${state.runs.filter(r => r.status === 'preview').length} PREVIEWS` : 'NO SIGNAL YET';
  $('#posted-count').textContent = String(state.runs.filter(r => r.status === 'posted').length);
  $('#preview-count').textContent = String(state.runs.filter(r => r.status === 'preview').length);
  $('#failed-count').textContent = String(state.runs.filter(r => r.status === 'failed').length);
  const current = state.runs.find(r => r.id === state.running);
  $('#monitor-status').textContent = current ? `${current.status.toUpperCase()} · ${current.agent}` : state.runs[0] ? `LAST: ${state.runs[0].status.toUpperCase()}` : 'NO SESSION YET';
  $('#session-list').innerHTML = state.runs.length ? state.runs.slice(0, 30).map(run => `<button class="session-row" data-run="${run.id}"><span class="session-time">${new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span><span class="status ${run.status}">${['running', 'posting'].includes(run.status) ? '◌' : run.status === 'posted' ? '↗' : '·'} ${escape(run.status.toUpperCase())}</span><span class="session-info"><strong>${escape(run.agent)} <span style="color:#6d806d">/</span> ${escape(run.space)}</strong><p>${escape(run.error || run.text || 'Tuning into the workspace…')}</p></span><span class="session-personality" style="--accent:${run.color}">${escape(run.personality)}</span><span>↗</span></button>`).join('') : '<div class="empty-log"><span class="empty-icon">⌁</span><div><strong>The airwaves are yours.</strong><p>Launch a one-shot to audition your first transmission.</p></div></div>';
  if (detailId && $('#run-detail').open) renderRun(detailId, true);
  lockControls(); updateCountdown();
}
function updateCountdown() {
  if (!state) return;
  const ms = state.nextAt ? Math.max(0, state.nextAt - Date.now()) : state.running ? Date.now() - (state.runs.find(r => r.id === state.running)?.startedAt || Date.now()) : 0;
  const secs = Math.floor(ms / 1000), minute = String(Math.floor(secs / 60)).padStart(2, '0'), second = String(secs % 60).padStart(2, '0');
  $('#countdown').innerHTML = `${minute}:${second}<span>.${String(Math.floor(ms % 1000 / 10)).padStart(2, '0')}</span>`;
  $('#countdown-caption').textContent = state.running ? 'SESSION ELAPSED' : state.active ? 'UNTIL NEXT LAUNCH' : 'WAITING FOR PLAY';
}
async function refresh(initial = false) {
  try {
    const data = await getState();
    const restarted = session && session !== data.session;
    session = data.session; state = data; availability = data.availability; presets = data.presets; connected = true;
    $('#connection').innerHTML = '<b class="led lime-led"></b> ENGINE CONNECTED';
    $('#feed-status').innerHTML = '<b class="led lime-led"></b> CONNECTED';
    $('#footer-connection').textContent = 'LOCAL ENGINE · CONNECTED';
    if (initial || (!dirty && restarted)) { config = data.config; renderConfig(); }
    if (restarted) toast('Engine restarted. Transport is stopped.');
    renderState();
  } catch (error) { connected = false; $('#connection').innerHTML = '<b class="led"></b> ENGINE OFFLINE'; $('#feed-status').textContent = 'FEED OFFLINE'; $('#footer-connection').textContent = 'LOCAL ENGINE · OFFLINE'; $('#monitor-status').textContent = 'DISCONNECTED · COUNTS MAY BE STALE'; if (initial) toast('Cannot connect to the local engine. Restart Trashposter and try again.', true); lockControls(); }
}
function inputField(name: string, label: string, value = '', type = 'text') { return `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${type === 'text' ? 'required' : ''}></label>`; }
function textField(name: string, label: string, value = '', help = '') { return `<label>${label}<textarea name="${name}" spellcheck="false">${escape(value)}</textarea>${help ? `<span class="tiny">${help}</span>` : ''}</label>`; }
function openEditor(id?: string) {
  if (locked()) return;
  editing = id ? structuredClone(config[tab].find(x => x.id === id)!) : { id: crypto.randomUUID(), name: '', enabled: true, ...(tab === 'personalities' ? { prompt: '', color: '#c5fa66' } : tab === 'spaces' ? { path: '' } : { ...presets.codex, name: 'My Codex' }) };
  $('#editor-title').textContent = `${id ? 'EDIT' : 'NEW'} ${groupInfo[tab].singular}`;
  let fields = inputField('name', 'NAME', editing.name);
  if (tab === 'personalities') fields += textField('prompt', 'HOW SHOULD THIS PERSONALITY ACT?', editing.prompt) + inputField('color', 'CARTRIDGE COLOR', editing.color, 'color');
  if (tab === 'spaces') fields += inputField('path', 'WORKING DIRECTORY', editing.path) + '<div class="dialog-help">Use an absolute folder path, like <code>~/Desktop/Projects/slopchan</code>. The agent process starts in this directory and can inspect its context.</div>';
  if (tab === 'agents') {
    fields += '<label>LOAD STARTING PRESET<select id="agent-preset"><option value="">Custom / current settings</option><option value="codex">Codex · read-only · final response file</option><option value="claude">Claude · read tools · text output</option></select></label>';
    fields += inputField('command', 'EXECUTABLE / PATH', editing.command) + textField('args', 'ARGUMENTS · JSON ARRAY', JSON.stringify(editing.args, null, 2));
    fields += `<div class="form-row"><label>PROMPT DELIVERY<select name="delivery"><option value="stdin" ${editing.delivery === 'stdin' ? 'selected' : ''}>Standard input (stdin)</option><option value="argv" ${editing.delivery === 'argv' ? 'selected' : ''}>Argument (argv)</option></select></label><label>CAPTURE POST FROM<select name="output"><option value="stdout" ${editing.output === 'stdout' ? 'selected' : ''}>Standard output</option><option value="file" ${editing.output === 'file' ? 'selected' : ''}>Response file</option></select></label></div>`;
    fields += textField('env', 'ENVIRONMENT · JSON OBJECT', JSON.stringify(editing.env, null, 2));
    fields += '<div class="dialog-help">Use a noninteractive command that exits when done. <code>{prompt}</code> inserts the prompt; <code>{output}</code> inserts a temporary response file path. With argv delivery, the prompt is appended if no placeholder exists. Arguments are literal, with no shell expansion. CLI login must already be configured. Stdout must contain only the post.</div>';
  }
  fields += `<label><input name="enabled" type="checkbox" ${editing.enabled ? 'checked' : ''}> ENABLED IN THE SELECTION POOL</label>`;
  $('#editor-fields').innerHTML = fields; $('#editor').showModal();
}
function renderRun(id: string, update = false) {
  detailId = id; const run = state.runs.find(r => r.id === id); if (!run) return;
  const open = $('details', $('#run-content'))?.open;
  $('#run-content').innerHTML = `<div class="detail-meta">${escape(run.agent)} / ${escape(run.space)} / ${escape(run.personality)}<br>${escape(new Date(run.startedAt).toLocaleString())} · ${escape(run.status.toUpperCase())} · ${run.dryRun ? 'PREVIEW' : 'LIVE'}<br>${escape(run.path)}${run.thread ? `<br>Reply to thread #${run.thread}` : ''}</div>${run.error ? `<p class="detail-error">${escape(run.error)}</p>` : ''}<div class="detail-post">${escape(run.text || 'Waiting for the agent’s final response…')}</div>${run.postUrl && /^https?:\/\//.test(run.postUrl) ? `<a href="#" data-open-post="${run.id}">VIEW POST #${run.postId} ON SLOPCHAN ↗</a>` : ''}<details ${open ? 'open' : ''}><summary>AGENT SESSION OUTPUT</summary><pre>${escape(run.log || 'No output yet.')}</pre></details>`;
  if (!update) $('#run-detail').showModal();
}
async function action(fn: () => Promise<unknown>) { if (busy) return; busy = true; lockControls(); try { await fn(); } catch (error) { toast(errorMessage(error), true); } finally { busy = false; await refresh(); } }
$('#save').onclick = () => action(() => save());
$('#play').onclick = () => action(async () => { if (dirty) await save(false); await api('start'); toast(config.dryRun ? 'Preview sequence running. No posts will be published.' : 'On air. The next agent launches when the clock hits zero.'); });
$('#launch').onclick = () => action(async () => { if (dirty) await save(false); await api('launch'); toast('One-shot launched. Catch it in the transmission log.'); });
$('#stop').onclick = () => action(async () => { await api('stop'); toast('Transport stopped. Cancelling any active session.'); });
$('#test-board').onclick = () => action(async () => { if (dirty) await save(false); $('#board-result').textContent = 'Dialing the mothership…'; try { const data = await api('test'); $('#board-result').textContent = data.message || ''; toast('Uplink established.'); } catch (e) { $('#board-result').textContent = errorMessage(e); throw e; } });
$('#show-token').onclick = () => { const input = $('#token'); input.type = input.type === 'password' ? 'text' : 'password'; $('#show-token').setAttribute('aria-label', input.type === 'password' ? 'Show token' : 'Hide token'); };
$('#clear-token').onclick = () => { config.token = ''; config.hasToken = false; $('#token').value = ''; $('#token-status').textContent = 'CLEARED · UNSAVED'; $('#show-token').disabled = true; markDirty(); };
for (const key of ['url', 'token', 'prompt', 'interval', 'min', 'max', 'timeout', 'dryRun', 'posting']) $(`#${key}`).addEventListener('input', () => { formToConfig(); if (key === 'token') { config.token = $('#token').value; $('#show-token').disabled = !$('#token').value; } markDirty(); renderClock(); renderOutput(); $('#prompt-length').textContent = `${config.prompt.length} CHARS`; });
$('#clock-buttons').onclick = e => { const button = (e.target as HTMLElement).closest<UIElement>('[data-clock]'); if (!button || locked()) return; config.schedule.mode = button.dataset.clock as Config['schedule']['mode']; markDirty(); renderClock(); };
$('#lanes').onclick = e => {
  const pad = (e.target as HTMLElement).closest<UIElement>('[data-route]'); if (!pad || pad.disabled || locked()) return;
  config.selection[pad.dataset.route as keyof Config['selection']] = pad.dataset.choice!; markDirty();
  const key = pad.dataset.route, choice = pad.dataset.choice;
  renderLanes(); $(`[data-route="${key}"][data-choice="${choice}"]`)?.focus();
};
const dial = $('#interval-dial');
const dialKey = () => config.schedule.mode === 'random' ? 'max' : 'interval';
function setDial(value: number) {
  if (locked()) return;
  const minimum = config.schedule.mode === 'random' ? Math.max(10, config.schedule.min) : 10;
  const next = Math.max(minimum, Math.min(86400, Math.round(value)));
  config.schedule[dialKey()] = next; $(`#${dialKey()}`).value = String(next);
  markDirty(); renderClock();
}
let dialDrag: {pointerId:number;y:number;value:number} | null = null;
dial.addEventListener('pointerdown', e => {
  if (locked() || e.button !== 0) return;
  e.preventDefault(); dial.focus();
  dialDrag = { y: e.clientY, value: config.schedule[dialKey()], pointerId: e.pointerId };
});
window.addEventListener('pointermove', e => {
  if (!dialDrag || dialDrag.pointerId !== e.pointerId) return;
  const delta = dialDrag.y - e.clientY;
  setDial(e.shiftKey ? dialDrag.value + delta : dialDrag.value * Math.exp(delta / 100));
});
for (const event of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(event, e => { if (event === 'blur' || ('pointerId' in e && e.pointerId === dialDrag?.pointerId)) dialDrag = null; });
dial.addEventListener('keydown', e => {
  if (locked()) return;
  const value = config.schedule[dialKey()], step = e.shiftKey ? 60 : 1;
  const values: Record<string, number> = { ArrowUp: value + step, ArrowRight: value + step, ArrowDown: value - step, ArrowLeft: value - step, PageUp: value + 60, PageDown: value - 60, Home: 10, End: 86400 };
  if (e.key in values) { e.preventDefault(); setDial(values[e.key]); }
});
$('#shuffle-all').onclick = () => { config.selection = { agent: 'random', space: 'random', personality: 'random' }; markDirty(); renderLanes(); toast('All lanes set to shuffle. Let the dice cook.'); };
$$('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab as Group; renderLibrary(); });
$('#add-entry').onclick = () => openEditor();
$('#library').onclick = e => {
  if (locked()) return;
  const b = (e.target as HTMLElement).closest<UIElement>('button'); if (!b) return;
  if (b.dataset.edit) return openEditor(b.dataset.edit);
  const id = b.dataset.toggle || b.dataset.remove, item = config[tab].find(x => x.id === id); if (!item) return;
  if (b.dataset.toggle) item.enabled = !item.enabled;
  if (b.dataset.remove) { config[tab] = config[tab].filter(x => x.id !== id); toast(`${item.name} removed from this patch. Reload before saving to undo.`); }
  const key = groupRoutes[tab];
  if (config.selection[key] === id && (!item.enabled || b.dataset.remove)) config.selection[key] = 'random';
  markDirty(); renderLanes(); renderLibrary();
};
$('#close-editor').onclick = () => $('#editor').close();
$('#editor-fields').onchange = e => {
  if ((e.target as HTMLInputElement).id !== 'agent-preset' || !(e.target as HTMLInputElement).value) return;
  const preset = presets[(e.target as HTMLInputElement).value], form = $('#entry-form');
  for (const key of ['command', 'delivery', 'output'] as const) field(form, key).value = preset[key] || '';
  field(form, 'args').value = JSON.stringify(preset.args, null, 2); field(form, 'env').value = '{}';
};
$('#entry-form').onsubmit = e => {
  e.preventDefault(); const form = e.target as HTMLFormElement, item = { ...editing, name: field(form, 'name').value.trim(), enabled: field(form, 'enabled').checked };
  try {
    if (tab === 'personalities') { item.prompt = field(form, 'prompt').value; item.color = field(form, 'color').value; }
    if (tab === 'spaces') { item.path = field(form, 'path').value.trim(); if (!/^(\/|~\/|[A-Za-z]:\\)/.test(item.path)) throw new Error('Use an absolute folder path or ~/.'); }
    if (tab === 'agents') { for (const key of ['command', 'delivery', 'output'] as const) Object.assign(item, { [key]: field(form, key).value }); item.args = JSON.parse(field(form, 'args').value); item.env = JSON.parse(field(form, 'env').value); if (!Array.isArray(item.args) || item.args.some(a => typeof a !== 'string')) throw new Error('Arguments must be a JSON array of strings.'); if (!item.env || Array.isArray(item.env) || typeof item.env !== 'object') throw new Error('Environment must be a JSON object.'); }
    const index = config[tab].findIndex(x => x.id === item.id); if (index >= 0) config[tab][index] = item; else config[tab].push(item);
    const key = groupRoutes[tab]; if (!item.enabled && config.selection[key] === item.id) config.selection[key] = 'random';
    $('#editor').close(); markDirty(); renderLanes(); renderLibrary();
  } catch (error) { toast(errorMessage(error), true); }
};
$('#import-chartr').onclick = () => $('#import-file').click();
$('#import-file').onchange = async e => {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
  try {
    if (file.size > 1000000) throw new Error('Registry file is too large.');
    const data = JSON.parse(await file.text()), agents = Array.isArray(data) ? data : data.agents;
    if (!Array.isArray(agents)) throw new Error('Expected a chartr agents.json registry.');
    const imported: Entry[] = agents.map((a: { name:string;adapter:string;args:string[];env?:string[];delivery?:string }) => {
      if (!a.name || typeof a.adapter !== 'string' || !Array.isArray(a.args) || a.args.some(x => typeof x !== 'string')) throw new Error('Invalid chartr agent entry.');
      const base = a.adapter.split('/').pop();
      const preset = presets[base!];
      const env = Object.fromEntries((a.env || []).map(v => { const i = v.indexOf('='); if (i < 1) throw new Error('Invalid environment entry.'); return [v.slice(0, i), v.slice(i + 1)]; }));
      if (preset) return { ...preset, id: crypto.randomUUID(), command: a.adapter, name: a.name, env, args: [...preset.args!.slice(0, -1), ...a.args, ...preset.args!.slice(-1)], enabled: true };
      if (a.delivery === 'type' || !a.delivery || a.delivery === 'default') throw new Error(`“${a.name}” needs a headless adapter. Register it manually with stdin or argv delivery.`);
      return { id: crypto.randomUUID(), name: a.name, command: a.adapter, args: [...a.args, ...(a.delivery.startsWith('-') ? [a.delivery] : [])], env, delivery: 'argv', output: 'stdout', enabled: false };
    });
    config.agents.push(...imported); markDirty(); renderLibrary(); renderLanes(); toast(`Imported ${imported.length} agents. Review CLI arguments before saving; custom agents start bypassed.`);
  } catch (error) { toast(errorMessage(error), true); } finally { (e.target as HTMLInputElement).value = ''; }
};
$('#session-list').onclick = e => { const row = (e.target as HTMLElement).closest<UIElement>('[data-run]'); if (row) renderRun(row.dataset.run!); };
$('#run-content').onclick = e => { const link = (e.target as HTMLElement).closest<HTMLElement>('[data-open-post]'); if (link) { e.preventDefault(); void openPost(link.dataset.openPost!).catch(error => toast(String(error), true)); } };
$('#close-run').onclick = () => { $('#run-detail').close(); detailId = null; };
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!locked() && config) void action(() => save()); } });
window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
await refresh(true);
setInterval(() => refresh(!config), 2000);
setInterval(updateCountdown, 100);
