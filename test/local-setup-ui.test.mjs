import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSetupBytes, setupBytes, createLocalSetupController, SETUP_ELEMENT_NAMES } from '../public/setup/local-setup.js';

test('formatSetupBytes formats byte sizes into MB and GB units with boundary rounding', () => {
  assert.equal(formatSetupBytes(0), '0.0 MB');
  assert.equal(formatSetupBytes(500 * 1024 * 1024), '500.0 MB');
  assert.equal(formatSetupBytes(1024 ** 3), '1.0 GB');
  assert.equal(formatSetupBytes(5.5 * 1024 ** 3), '5.5 GB');
  assert.equal(setupBytes(-100), '0.0 MB');
  assert.equal(setupBytes('invalid'), '0.0 MB');
  assert.ok(SETUP_ELEMENT_NAMES.includes('status'));
  assert.ok(SETUP_ELEMENT_NAMES.includes('consent'));
  assert.ok(SETUP_ELEMENT_NAMES.includes('install-btn'));
});

test('recognizer changes clear consent and ignore stale setup responses', async () => {
  const consent = { checked: true };
  const status = {};
  let completeOld;
  let reads = 0;
  const snapshot = { supported: true, status: 'idle', components: [], message: 'Moonshine selected' };
  const controller = createLocalSetupController({
    document: { getElementById: () => null },
    elements: { consent, status },
    isSetupVisible: () => true,
    fetch: async () => {
      reads += 1;
      if (reads === 1) return { ok: true, json: () => new Promise(resolve => { completeOld = resolve; }) };
      return { ok: true, json: async () => snapshot };
    },
  });
  try {
    const pending = controller.requestSetup();
    await new Promise(setImmediate);
    await controller.recognitionChanged();
    assert.equal(consent.checked, false);
    assert.equal(status.textContent, 'idle');
    completeOld({ ...snapshot, status: 'ready' });
    await pending;
    assert.equal(status.textContent, 'idle');
    assert.equal(reads, 2);
  } finally { controller.destroy(); }
});

test('createLocalSetupController manages rendering, installation requests, and prompt navigation', async () => {
  function makeMockElement(tagName = 'div') {
    const children = [];
    const attributes = new Map();
    const listeners = new Map();
    const element = {
      tagName: tagName.toUpperCase(),
      children,
      textContent: '',
      className: '',
      id: '',
      name: '',
      value: '',
      disabled: false,
      checked: false,
      hidden: false,
      open: false,
      dataset: {},
      appendChild(child) {
        children.push(child);
        child.parentElement = element;
        return child;
      },
      append(...nodes) {
        for (const n of nodes) this.appendChild(n);
      },
      replaceChildren(...nodes) {
        children.length = 0;
        for (const n of nodes) this.appendChild(n);
      },
      setAttribute(k, v) { attributes.set(k, String(v)); },
      getAttribute(k) { return attributes.get(k); },
      removeAttribute(k) { attributes.delete(k); },
      hasAttribute(k) { return attributes.has(k); },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      removeEventListener(event, fn) {
        if (listeners.has(event)) {
          listeners.set(event, listeners.get(event).filter(f => f !== fn));
        }
      },
      async dispatch(event, payload = {}) {
        for (const fn of [...(listeners.get(event) || [])]) {
          await fn({ preventDefault: () => {}, ...payload });
        }
      },
      showModal() { element.open = true; },
      close() { element.open = false; },
      focus() { mockDoc.activeElement = element; },
      scrollIntoView() {},
      querySelector(selector) {
        if (selector === 'input, select') {
          return children.find(c => ['INPUT', 'SELECT'].includes(c.tagName)) || null;
        }
        return null;
      },
      contains(other) {
        if (other === element) return true;
        return children.some(c => c === other || (c.contains && c.contains(other)));
      },
      get firstChild() { return children[0] || null; },
      removeChild(child) {
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
        return child;
      },
    };
    return element;
  }

  const elements = {};
  for (const name of SETUP_ELEMENT_NAMES) {
    elements[name] = makeMockElement(name === 'progress' ? 'progress' : name === 'components' ? 'ul' : 'div');
    elements[name].id = `setup-${name}`;
  }
  const prompt = makeMockElement('dialog');
  prompt.id = 'local-setup-prompt';
  const promptStart = makeMockElement('button');
  promptStart.id = 'local-setup-start';
  const promptProvider = makeMockElement('button');
  promptProvider.id = 'local-setup-provider';
  const promptClose = makeMockElement('button');
  promptClose.id = 'local-setup-prompt-close';
  const localSection = makeMockElement('details');
  localSection.id = 'local-setup';
  const configSection = makeMockElement('details');
  configSection.id = 'config-section';
  const viewDialog = makeMockElement('dialog');
  viewDialog.open = true;

  const mockDoc = {
    activeElement: null,
    hidden: false,
    body: { dataset: { view: 'settings' } },
    createElement: tag => makeMockElement(tag),
    getElementById: id => {
      if (id === 'local-setup-prompt') return prompt;
      if (id === 'local-setup-start') return promptStart;
      if (id === 'local-setup-provider') return promptProvider;
      if (id === 'local-setup-prompt-close') return promptClose;
      if (id === 'local-setup') return localSection;
      if (id === 'config-section') return configSection;
      if (id === 'view-dialog') return viewDialog;
      if (id.startsWith('setup-')) return elements[id.replace('setup-', '')];
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const appState = {
    settings: { localSetupPrompted: false },
  };
  const appConfig = {
    providers: [{ id: 'local', configured: false }],
  };

  let activatedView = null;
  let refreshCalls = 0;
  const requests = [];
  let nextSetupResponse = {
    status: 'idle',
    supported: true,
    capabilities: {
      chat: { ready: false, message: 'Chat not ready' },
      voice: { ready: false, message: 'Voice not ready' },
    },
    components: [
      { id: 'ling', label: 'Ling Model', ready: false, sourceUrl: 'https://example.com/ling.gguf' },
      { id: 'kokoro', label: 'Kokoro TTS', ready: false, sourceUrl: 'https://example.com/kokoro' },
    ],
    progress: { received: 0, total: 0 },
    log: [],
  };

  const controller = createLocalSetupController({
    document: mockDoc,
    window: {
      requestAnimationFrame: cb => cb(),
      clearTimeout: id => clearTimeout(id),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/setup') {
        if (options.method === 'POST') {
          nextSetupResponse = {
            ...nextSetupResponse,
            status: 'running',
            progress: { received: 1024 ** 3, total: 5 * 1024 ** 3 },
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => nextSetupResponse,
        };
      }
      if (url === '/api/settings') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...appState.settings, localSetupPrompted: true }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    },
    elements: {
      ...elements,
      localSetupPrompt: prompt,
      localSetupStart: promptStart,
      localSetupProvider: promptProvider,
      localSetupPromptClose: promptClose,
      localSetupSection: localSection,
      configSection,
    },
    viewDialog,
    getAppState: () => appState,
    onSettingsUpdate: settings => { appState.settings = settings; },
    getAppConfig: () => appConfig,
    refreshConfig: async () => { refreshCalls++; return true; },
    activateView: view => { activatedView = view; },
  });

  // 1. Initial load shows prompt when localSetupPrompted is false and setup is not ready
  await controller.initialize();
  assert.equal(prompt.open, true);
  assert.equal(elements.status.textContent, 'idle');
  assert.equal(elements.components.children.length, 2);
  const [lingItem, kokoroItem] = elements.components.children;
  assert.equal(lingItem.children[0].textContent, 'Ling Model');
  assert.equal(lingItem.children[1].textContent, 'Required');
  assert.equal(lingItem.children[2].textContent, 'Source');
  assert.equal(kokoroItem.children[2].textContent, 'Release info');

  // 2. Close prompt with local destination acknowledges and focuses settings
  await promptStart.dispatch('click');
  assert.equal(prompt.open, false);
  assert.equal(appState.settings.localSetupPrompted, true);
  assert.equal(activatedView, 'settings');
  assert.equal(localSection.open, true);

  // 3. Consent enable and installation request
  assert.equal(elements['install-btn'].disabled, true);
  elements.consent.checked = true;
  await elements.consent.dispatch('change');
  assert.equal(elements['install-btn'].disabled, false);

  await elements['install-btn'].dispatch('click');
  assert.equal(requests.some(r => r.url === '/api/setup' && r.options.method === 'POST'), true);
  assert.equal(elements.status.textContent, 'running');
  assert.equal(elements['progress-region'].hidden, false);
  assert.ok(elements['progress-label'].textContent.includes('1.0 GB'));

  // 4. Successful completion resets consent and triggers refreshConfig
  nextSetupResponse = {
    ...nextSetupResponse,
    status: 'ready',
    capabilities: {
      chat: { ready: true, message: 'Chat ready' },
      voice: { ready: true, message: 'Voice ready' },
    },
    progress: { received: 5 * 1024 ** 3, total: 5 * 1024 ** 3 },
  };
  await elements['refresh-btn'].dispatch('click');
  assert.equal(elements.status.textContent, 'ready');
  assert.equal(elements.status.className, 'badge badge-success');
  assert.equal(elements.consent.checked, false);
  assert.equal(refreshCalls, 1);

  // 5. Cleanup
  controller.destroy();
});

test('createLocalSetupController renders error badges, retry labels, and handles HTTP failures gracefully', async () => {
  function makeMockElement(tagName = 'div') {
    const children = [];
    const attributes = new Map();
    const listeners = new Map();
    const element = {
      tagName: tagName.toUpperCase(),
      children,
      textContent: '',
      className: '',
      id: '',
      name: '',
      value: '',
      disabled: false,
      checked: false,
      hidden: false,
      open: false,
      dataset: {},
      appendChild(child) {
        children.push(child);
        child.parentElement = element;
        return child;
      },
      append(...nodes) {
        for (const n of nodes) this.appendChild(n);
      },
      replaceChildren(...nodes) {
        children.length = 0;
        for (const n of nodes) this.appendChild(n);
      },
      setAttribute(k, v) { attributes.set(k, String(v)); },
      getAttribute(k) { return attributes.get(k); },
      removeAttribute(k) { attributes.delete(k); },
      hasAttribute(k) { return attributes.has(k); },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      removeEventListener(event, fn) {
        if (listeners.has(event)) {
          listeners.set(event, listeners.get(event).filter(f => f !== fn));
        }
      },
      async dispatch(event, payload = {}) {
        for (const fn of [...(listeners.get(event) || [])]) {
          await fn({ preventDefault: () => {}, ...payload });
        }
      },
      showModal() { element.open = true; },
      close() { element.open = false; },
      focus() {},
      scrollIntoView() {},
      querySelector() { return null; },
      contains() { return false; },
      get firstChild() { return children[0] || null; },
      removeChild(child) {
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
        return child;
      },
    };
    return element;
  }

  const elements = {};
  for (const name of SETUP_ELEMENT_NAMES) {
    elements[name] = makeMockElement(name === 'progress' ? 'progress' : name === 'components' ? 'ul' : 'div');
    elements[name].id = `setup-${name}`;
  }
  const prompt = makeMockElement('dialog');
  const viewDialog = makeMockElement('dialog');
  viewDialog.open = true;

  const mockDoc = {
    activeElement: null,
    hidden: false,
    body: { dataset: { view: 'settings' } },
    createElement: tag => makeMockElement(tag),
    getElementById: id => elements[id?.replace('setup-', '')] || null,
    addEventListener() {},
    removeEventListener() {},
  };

  let shouldFail = false;
  let statusPayload = {
    status: 'error',
    error: 'Kokoro installation failed',
    supported: true,
    capabilities: {
      chat: { ready: true, message: 'Local chat is ready.' },
      voice: { ready: false, message: 'Kokoro installation failed.' },
    },
    components: [
      { id: 'custom', label: 'Local Custom', ready: false, sourceUrl: 'invalidscheme://test' },
    ],
    progress: { received: 0, total: 0 },
    log: ['Step 1: starting', 'Step 2: failed'],
  };

  const controller = createLocalSetupController({
    document: mockDoc,
    window: {
      requestAnimationFrame: cb => cb(),
      clearTimeout: () => {},
      setTimeout: () => {},
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async () => {
      if (shouldFail) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'Service Unavailable' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => statusPayload,
      };
    },
    elements: { ...elements, localSetupPrompt: prompt },
    viewDialog,
  });

  // 1. Partial success: chat ready but voice failed -> 'Chat ready' badge-warning
  await controller.requestSetup();
  assert.equal(elements.status.textContent, 'Chat ready');
  assert.equal(elements.status.className, 'badge badge-warning');
  assert.equal(elements['install-label'].textContent, 'Retry voice setup');
  assert.equal(elements.error.hidden, false);
  assert.ok(elements.error.textContent.includes('Local chat is ready. Voice setup needs attention: Kokoro installation failed'));
  // Component link with invalid URL is hidden
  assert.equal(elements.components.children[0].children[2].hidden, true);
  // Log details shown
  assert.equal(elements['log-details'].hidden, false);
  assert.ok(elements.log.textContent.includes('Step 2: failed'));

  // 2. HTTP error 503 renders status unavailable and disables install button
  shouldFail = true;
  elements.consent.checked = true;
  await controller.requestSetup();
  assert.equal(elements.status.textContent, 'Status unavailable');
  assert.equal(elements['install-btn'].disabled, true);
  assert.ok(elements.error.textContent.includes('Refresh status before retrying installation.'));

  // 3. Unsupported platform
  shouldFail = false;
  statusPayload = {
    status: 'idle',
    supported: false,
    capabilities: { chat: { ready: false }, voice: { ready: false } },
    components: [],
    progress: { received: 0, total: 0 },
    log: [],
  };
  await controller.requestSetup();
  assert.equal(elements.status.textContent, 'Unsupported platform');
  assert.equal(elements.consent.disabled, true);
  assert.equal(elements['install-btn'].disabled, true);

  controller.destroy();
});

test('createLocalSetupController displays hardware advisory in setup view and prompts on initialize when local route is selected', async () => {
  function makeMockElement(tagName = 'div') {
    const children = [];
    const attributes = new Map();
    const listeners = new Map();
    const element = {
      tagName: tagName.toUpperCase(),
      children,
      textContent: '',
      className: '',
      id: '',
      name: '',
      value: '',
      disabled: false,
      checked: false,
      hidden: false,
      open: false,
      dataset: {},
      appendChild(child) {
        children.push(child);
        child.parentElement = element;
        return child;
      },
      append(...nodes) {
        for (const n of nodes) this.appendChild(n);
      },
      replaceChildren(...nodes) {
        children.length = 0;
        for (const n of nodes) this.appendChild(n);
      },
      setAttribute(k, v) { attributes.set(k, String(v)); },
      getAttribute(k) { return attributes.get(k); },
      removeAttribute(k) { attributes.delete(k); },
      hasAttribute(k) { return attributes.has(k); },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      removeEventListener(event, fn) {
        if (listeners.has(event)) {
          listeners.set(event, listeners.get(event).filter(f => f !== fn));
        }
      },
      async dispatch(event, payload = {}) {
        for (const fn of [...(listeners.get(event) || [])]) {
          await fn({ preventDefault: () => {}, ...payload });
        }
      },
      showModal() { element.open = true; },
      close() { element.open = false; },
      focus() {},
      scrollIntoView() {},
      querySelector() { return null; },
      contains() { return false; },
      get firstChild() { return children[0] || null; },
      removeChild(child) {
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
        return child;
      },
    };
    return element;
  }

  const elements = {};
  for (const name of SETUP_ELEMENT_NAMES) {
    elements[name] = makeMockElement(name === 'progress' ? 'progress' : name === 'components' ? 'ul' : 'div');
    elements[name].id = `setup-${name}`;
  }
  const prompt = makeMockElement('dialog');
  prompt.id = 'local-setup-prompt';
  const promptStart = makeMockElement('button');
  promptStart.id = 'local-setup-start';
  const promptStartLabel = makeMockElement('span');
  promptStartLabel.id = 'local-setup-start-label';
  promptStart.appendChild(promptStartLabel);
  const promptWarning = makeMockElement('p');
  promptWarning.id = 'local-setup-prompt-warning';
  const providerSelect = makeMockElement('select');
  providerSelect.id = 'provider-select';
  providerSelect.value = 'local';
  const voiceModeSelect = makeMockElement('select');
  voiceModeSelect.id = 'voice-mode-select';
  voiceModeSelect.value = 'local';
  const viewDialog = makeMockElement('dialog');
  viewDialog.open = true;

  const mockDoc = {
    activeElement: null,
    hidden: false,
    body: { dataset: { view: 'settings' } },
    createElement: tag => makeMockElement(tag),
    getElementById: id => {
      if (id === 'local-setup-prompt') return prompt;
      if (id === 'local-setup-start') return promptStart;
      if (id === 'local-setup-start-label') return promptStartLabel;
      if (id === 'local-setup-prompt-warning') return promptWarning;
      if (id === 'provider-select') return providerSelect;
      if (id === 'voice-mode-select') return voiceModeSelect;
      if (id === 'view-dialog') return viewDialog;
      if (id.startsWith('setup-')) return elements[id.replace('setup-', '')];
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const appState = {
    settings: { localSetupPrompted: true },
  };
  const appConfig = {
    defaults: { provider: 'local', voiceMode: 'local' },
    providers: [{ id: 'local', configured: true }],
  };

  const lowSpecResponse = {
    status: 'ready',
    supported: true,
    capabilities: {
      chat: { ready: true, message: 'Chat ready' },
      voice: { ready: true, message: 'Voice ready' },
    },
    components: [],
    progress: { received: 0, total: 0 },
    hardware: {
      logicalCpus: 2,
      memoryGiB: 8,
      warning: 'Local AI models run best with at least 16 GB of system memory and 4 CPU cores.',
    },
    log: [],
  };

  const controller = createLocalSetupController({
    document: mockDoc,
    window: {
      requestAnimationFrame: cb => cb(),
      clearTimeout: () => {},
      setTimeout: () => {},
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async url => {
      if (url === '/api/setup') {
        return { ok: true, status: 200, json: async () => lowSpecResponse };
      }
      if (url === '/api/settings') {
        return { ok: true, status: 200, json: async () => appState.settings };
      }
      throw new Error(`Unexpected url: ${url}`);
    },
    elements: {
      ...elements,
      localSetupPrompt: prompt,
      localSetupStart: promptStart,
      localSetupStartLabel: promptStartLabel,
      localSetupPromptWarning: promptWarning,
      providerSelect,
      voiceModeSelect,
    },
    viewDialog,
    getAppState: () => appState,
    getAppConfig: () => appConfig,
  });

  // 1. On initialize, even though status is 'ready' and localSetupPrompted is true,
  // hardware warning shows modal dialog because local route is selected
  await controller.initialize();
  assert.equal(prompt.open, true);
  assert.equal(promptWarning.textContent, lowSpecResponse.hardware.warning);
  assert.equal(promptWarning.hidden, false);
  assert.equal(elements.warning.textContent, lowSpecResponse.hardware.warning);
  assert.equal(elements.warning.hidden, false);
  assert.equal(promptStartLabel.textContent, 'Continue local');

  // 2. User closes prompt; refresh request does NOT re-show modal dialog
  prompt.close();
  assert.equal(prompt.open, false);
  await elements['refresh-btn'].dispatch('click');
  assert.equal(prompt.open, false);

  // 3. Subsequent initialize in same session does NOT re-show modal dialog
  await controller.initialize();
  assert.equal(prompt.open, false);

  controller.destroy();

  // 4. Cloud route does NOT show hardware warning prompt on initialize
  prompt.open = false;
  providerSelect.value = 'openai';
  voiceModeSelect.value = 'openai-realtime';
  const cloudConfig = {
    defaults: { provider: 'openai', voiceMode: 'openai-realtime' },
    providers: [{ id: 'openai', configured: true }],
  };
  const cloudController = createLocalSetupController({
    document: mockDoc,
    window: {
      requestAnimationFrame: cb => cb(),
      clearTimeout: () => {},
      setTimeout: () => {},
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async url => {
      if (url === '/api/setup') {
        return { ok: true, status: 200, json: async () => lowSpecResponse };
      }
      throw new Error(`Unexpected url: ${url}`);
    },
    elements: {
      ...elements,
      localSetupPrompt: prompt,
      localSetupStart: promptStart,
      localSetupStartLabel: promptStartLabel,
      localSetupPromptWarning: promptWarning,
      providerSelect,
      voiceModeSelect,
    },
    viewDialog,
    getAppState: () => ({ settings: { localSetupPrompted: true } }),
    getAppConfig: () => cloudConfig,
  });

  await cloudController.initialize();
  assert.equal(prompt.open, false);
  // But setup view in settings still reflects the hardware warning when rendered
  assert.equal(elements.warning.textContent, lowSpecResponse.hardware.warning);
  assert.equal(elements.warning.hidden, false);

  cloudController.destroy();
});
