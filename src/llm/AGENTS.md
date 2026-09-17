# LLM Providers

- `provider-config.mjs` owns provider availability, endpoint resolution, defaults, headers, and loopback validation.
- Keep streaming, message normalization, and tool roundtrips outside provider configuration.
- Never send local-provider traffic to a non-loopback host or expose credentials.
- Validate with `node --test test/providers.test.mjs`.
