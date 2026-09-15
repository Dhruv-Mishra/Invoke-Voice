# Runtime Scripts

- Scripts must be deterministic, non-interactive where practical, and safe to rerun.
- Reuse environment defaults from the app; do not overwrite `.env` or downloaded models.
- Fail with a concise actionable message and clean up owned child processes.