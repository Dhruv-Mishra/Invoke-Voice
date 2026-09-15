# Voice Supervisor

- Node 22+, zero-build vanilla browser UI, local-only server.
- Preserve HTTP, SSE, WebSocket, tool-schema, persisted-state, and audio contracts.
- Prefer direct data flow and shared helpers over wrappers, duplicate state, or per-case branches.
- Keep secrets in `.env`; never expose keys or serve arbitrary files.
- Use `npm run search:index` once and `npm run search -- "query"` for cross-file discovery.
- Validate with the narrow check, then `npm test`.