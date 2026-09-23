import { agencyReadPolicy } from './agency-read.mjs';

const sources = Object.freeze({
  workiq: 'workiq',
  teams: 'teams',
  calendar: 'calendar',
  people: 'm365-user',
  learn: 'msft-learn',
});
const DISCOVERY_BYTES = 5000;
const searchCapabilities = { all: null, email: 'Email', teams: 'TeamsMessages', calendar: 'Meetings', files: 'OneDriveAndSharePoint', people: 'People' };

export function createDirectWorkTools(agencyMcp, env = process.env) {
  const access = () => env.VOICE_DIRECT_MCP_ACCESS === 'read-only' && env.AGENCY_WORK_DATA_ACCESS === 'read-only';
  const allowed = source => {
    if (!access()) throw new Error('Direct work tools are disabled. Enable Private work sources and Direct work tools in Settings.');
    const server = sources[source];
    const names = server && agencyReadPolicy(env).tools[`voice-${server}`];
    if (!server || !names) throw new Error('Unknown direct work source.');
    return { server, names };
  };
  return {
    async call(name, args = {}) {
      if (name === 'search_work') {
        allowed('workiq');
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000 || !Object.hasOwn(searchCapabilities, args.source) || Object.keys(args).some(key => !['query', 'source'].includes(key))) throw new Error('Work search requires only a query of 1 to 1000 characters and an approved source.');
        const capability = searchCapabilities[args.source];
        const result = await agencyMcp.callTool('workiq', 'retrieve', { query: [args.query.trim()], strategy: 'grounding', ...(capability ? { capabilities: [{ name: capability }] } : {}) });
        return { source: 'workiq', data: result.structuredContent ?? result.content, ...(result.isError ? { error: 'WorkIQ could not complete the read.' } : {}) };
      }
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