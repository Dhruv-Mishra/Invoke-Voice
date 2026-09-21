import { agencyReadPolicy } from './agency-read.mjs';

const sources = Object.freeze({
  workiq: 'workiq',
  teams: 'teams',
  calendar: 'calendar',
  people: 'm365-user',
  learn: 'msft-learn',
});
const DISCOVERY_BYTES = 5000;

export function createDirectWorkTools(agencyMcp, env = process.env) {
  const access = () => env.VOICE_DIRECT_MCP_ACCESS === 'read-only' && env.AGENCY_WORK_DATA_ACCESS === 'read-only';
  const allowed = source => {
    if (!access()) throw new Error('Direct voice work tools are disabled. Enable Private work sources and Direct voice work tools in Settings.');
    const server = sources[source];
    const names = server && agencyReadPolicy(env).tools[`voice-${server}`];
    if (!server || !names) throw new Error('Unknown direct work source.');
    return { server, names };
  };
  return {
    async call(name, args = {}) {
      const { server, names } = allowed(args.source);
      if (name === 'find_work_tools') {
        const query = String(args.query || '').trim().toLowerCase();
        const catalog = await agencyMcp.listTools(server);
        const matches = catalog.filter(tool => names.includes(tool.name))
          .filter(tool => !query || `${tool.name} ${tool.description || ''}`.toLowerCase().includes(query))
          .map(tool => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema }));
        const tools = [];
        let bytes = JSON.stringify({ source: args.source, tools, hasMore: true }).length;
        for (const tool of matches) {
          const size = JSON.stringify(tool).length + 1;
          if (tools.length >= 12 || bytes + size > DISCOVERY_BYTES) continue;
          tools.push(tool);
          bytes += size;
        }
        return { source: args.source, tools, hasMore: tools.length < matches.length };
      }
      if (name !== 'call_work_tool' || !names.includes(args.name)) throw new Error('Tool is not approved for direct read-only access.');
      if (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) throw new Error('Tool arguments must be a JSON object.');
      return agencyMcp.callTool(server, args.name, args.arguments);
    },
  };
}