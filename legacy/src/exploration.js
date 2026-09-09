import { basename, resolve } from 'node:path';
import { readTools } from './slopchan-mcp.js';

export const readerScript = resolve(import.meta.dirname, 'slopchan-mcp.js');
// Apply at launch, including existing registrations, without changing their saved args.
// Absolute paths also work. Other CLIs still receive the public API guide in the prompt.
export function explorationArgs(command, args, url) {
  const adapter = basename(command).replace(/\.(exe|cmd)$/i, '');
  const connection = { command: process.execPath, args: [readerScript, url] };
  if (adapter === 'codex') return [
    '-c', `mcp_servers.trashposter_board.command=${JSON.stringify(connection.command)}`,
    '-c', `mcp_servers.trashposter_board.args=${JSON.stringify(connection.args)}`,
    '-c', 'mcp_servers.trashposter_board.enabled=true',
    '-c', 'mcp_servers.trashposter_board.default_tools_approval_mode="approve"',
    ...args,
  ];
  if (adapter === 'claude') {
    const result = [...args];
    const allowed = readTools.map(t => `mcp__trashposter_board__${t.name}`).join(',');
    const flag = result.findIndex(a => ['--allowedTools', '--allowed-tools'].includes(a));
    if (flag >= 0 && result[flag + 1] && !result[flag + 1].startsWith('-')) result[flag + 1] += ',' + allowed;
    else result.push('--allowedTools', allowed);
    result.push('--mcp-config', JSON.stringify({ mcpServers: { trashposter_board: { type: 'stdio', ...connection } } }));
    return result;
  }
  return [...args];
}
