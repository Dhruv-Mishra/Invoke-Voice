export function assertLoopback(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid local URL: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!isLoopback) {
    throw new Error(`Local LLM URL must loopback to localhost or 127.0.0.1, got: ${host}`);
  }
}

export function providerProfiles(env = process.env) {
  return [
    {
      id: 'gemini',
      label: 'Gemini',
      model: env.GEMINI_MODEL || 'gemini-3.8-flash',
      configured: Boolean(env.GEMINI_API_KEY),
    },
    {
      id: 'openai',
      label: 'OpenAI',
      model: env.OPENAI_MODEL || 'gpt-4.1-mini',
      configured: Boolean(env.OPENAI_API_KEY),
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      configured: Boolean(env.ANTHROPIC_API_KEY),
    },
    {
      id: 'azure',
      label: 'Azure OpenAI',
      model: env.AZURE_OPENAI_DEPLOYMENT || env.AZURE_OPENAI_MODEL || 'gpt-4o-mini',
      configured: Boolean(env.AZURE_OPENAI_ENDPOINT && (env.AZURE_OPENAI_KEY || env.AZURE_OPENAI_API_KEY)),
    },
    {
      id: 'local',
      label: 'Local',
      model: env.LOCAL_LLM_MODEL || 'ling-local',
      configured: Boolean(env.LOCAL_LLM_URL),
    },
    {
      id: 'custom',
      label: 'Custom',
      model: env.CUSTOM_MODEL || 'custom-model',
      configured: Boolean(env.CUSTOM_BASE_URL),
    },
  ];
}

export function resolveEndpoint(provider, model, env = process.env) {
  switch (provider) {
    case 'gemini': {
      if (!env.GEMINI_API_KEY) throw new Error('Add a Gemini API key in Settings > Config');
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GEMINI_API_KEY}` },
        model: model || env.GEMINI_MODEL || 'gemini-3.8-flash',
      };
    }
    case 'openai': {
      if (!env.OPENAI_API_KEY) throw new Error('Add an OpenAI API key in Settings > Config');
      const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
      return {
        url: `${base}/chat/completions`,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        model: model || env.OPENAI_MODEL || 'gpt-4.1-mini',
      };
    }
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) throw new Error('Add an Anthropic API key in Settings > Config');
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        model: model || env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      };
    }
    case 'azure': {
      const endpoint = env.AZURE_OPENAI_ENDPOINT;
      const key = env.AZURE_OPENAI_KEY || env.AZURE_OPENAI_API_KEY;
      if (!endpoint || !key) throw new Error('Add an Azure OpenAI endpoint and key in Settings > Config');
      const deployment = model || env.AZURE_OPENAI_DEPLOYMENT || env.AZURE_OPENAI_MODEL || 'gpt-4o-mini';
      const clean = endpoint.trim().replace(/\/+$/, '');
      const url = clean.includes('/chat/completions')
        ? clean
        : `${clean}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION || '2024-06-01'}`;
      return {
        url,
        headers: { 'Content-Type': 'application/json', 'api-key': key },
        model: deployment,
      };
    }
    case 'local': {
      const localUrl = env.LOCAL_LLM_URL;
      if (!localUrl) throw new Error('Missing LOCAL_LLM_URL for local provider');
      assertLoopback(localUrl);
      const clean = localUrl.trim().replace(/\/+$/, '');
      const url = clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
      return {
        url,
        headers: { 'Content-Type': 'application/json' },
        model: model || env.LOCAL_LLM_MODEL || 'ling-local',
      };
    }
    case 'custom': {
      const baseUrl = env.CUSTOM_BASE_URL;
      if (!baseUrl) throw new Error('Add a custom endpoint URL in Settings > Config');
      const clean = baseUrl.trim().replace(/\/+$/, '');
      const url = clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (env.CUSTOM_API_KEY) headers.Authorization = `Bearer ${env.CUSTOM_API_KEY}`;
      return { url, headers, model: model || env.CUSTOM_MODEL || 'custom-model' };
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
