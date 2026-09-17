# Local Setup UI

- Keep setup status, consent, progress, polling, and prompt navigation in `local-setup.js`.
- Treat `/api/setup` snapshots as the source of truth; do not mirror setup state in `app.js`.
- Preserve consent gating, request timeouts, partial chat readiness, and restart messaging.
- Validate with `node --test test/local-setup-ui.test.mjs test/frontend.test.mjs`.
