# Voice Supervisor

- Node 22+, Vue 3/Vite browser UI, local-only server.
- Preserve HTTP, SSE, WebSocket, tool-schema, persisted-state, and audio contracts.
- Keep transport and audio state app-scoped; prefer direct data flow and shared helpers over wrappers, duplicate state, or per-case branches.
- Keep secrets in `.env`; never expose keys or serve arbitrary files.
- Use `npm run search:index` once and `npm run search -- "query"` for cross-file discovery.
- Validate with the narrow check, then `npm test`.

## Ownership Map

- `public/app.js`: browser composition, voice session state, tasks, and settings coordination.
- `public/captions/`: caption lifecycle and voice transcript presentation.
- `public/setup/`: local setup status, consent, progress, and prompt flow.
- `public/tools/`: schema-driven tool catalog UI and execution feedback.
- `src/llm/`: provider configuration; `src/llm.mjs` owns streaming and tool roundtrips.
- `src/supervisor/`: static tool contract; `src/supervisor.mjs` owns persisted work state and dispatch.