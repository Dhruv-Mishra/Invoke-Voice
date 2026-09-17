# Supervisor Contract

- `contract.mjs` is the canonical static tool and instruction contract shared by text and realtime providers.
- Keep task state, persistence, dispatch, and observations in the `Supervisor` facade until they have independent behavior tests.
- Preserve tool names, schemas, concise outputs, and backward-compatible facade exports.
- Validate with `node --test test/supervisor.test.mjs test/providers.test.mjs`.
