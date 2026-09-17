# Tool Catalog UI

- Keep schema-to-form rendering, catalog selection, confirmation, and execution status in `tool-catalog.js`.
- Read app state and config through injected getters so controls use current values.
- Preserve tool names and schemas; action tools require confirmation.
- Validate with `node --test test/tool-catalog.test.mjs`.
