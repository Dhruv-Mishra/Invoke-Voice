// Local setup UI controller module
// Encapsulates setup view rendering, state tracking, polling, installation requests, and prompt interactions

export function formatSetupBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export { formatSetupBytes as setupBytes };

export const SETUP_ELEMENT_NAMES = [
  'status', 'message', 'error', 'chat-status', 'voice-status',
  'progress-region', 'progress', 'progress-label', 'platform',
  'cache', 'runtime', 'components', 'consent', 'consent-label',
  'install-btn', 'install-label', 'refresh-btn', 'log-details', 'log',
];

export function createLocalSetupController({
  document: doc = globalThis.document,
  window: win = globalThis.window,
  fetch = (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined),
  viewDialog = doc?.getElementById?.('view-dialog'),
  elements = {},
  getAppState = () => ({}),
  onSettingsUpdate = () => {},
  getAppConfig = () => ({}),
  refreshConfig = async () => true,
  activateView = () => {},
  isSetupVisible,
} = {}) {
  const fetchFn = fetch;
  const clearTimeoutFn = win?.clearTimeout ? win.clearTimeout.bind(win) : globalThis.clearTimeout;
  const setTimeoutFn = win?.setTimeout ? win.setTimeout.bind(win) : globalThis.setTimeout;
  const Controller = win?.AbortController || globalThis.AbortController;

  const setupElements = Object.fromEntries(
    SETUP_ELEMENT_NAMES.map(name => [name, elements[name] || doc?.getElementById?.(`setup-${name}`)])
  );
  const localSetupPrompt = elements.localSetupPrompt || doc?.getElementById?.('local-setup-prompt');
  const localSetupStart = elements.localSetupStart || doc?.getElementById?.('local-setup-start');
  const localSetupProvider = elements.localSetupProvider || doc?.getElementById?.('local-setup-provider');
  const localSetupPromptClose = elements.localSetupPromptClose || doc?.getElementById?.('local-setup-prompt-close');
  const localSetupSection = elements.localSetupSection || doc?.getElementById?.('local-setup');
  const configSection = elements.configSection || doc?.getElementById?.('config-section');

  let setupSnapshot = null;
  let setupRequest = null;
  let setupPoll = null;
  let setupHttpError = '';
  let setupConsentFocusPending = false;

  function isVisible() {
    if (typeof isSetupVisible === 'function') return isSetupVisible();
    const dialog = viewDialog || doc?.getElementById?.('view-dialog');
    return Boolean(!doc?.hidden && doc?.body?.dataset?.view === 'settings' && dialog?.open);
  }

  function renderSetup() {
    const snapshot = setupSnapshot;
    const running = snapshot?.status === 'running';
    const ready = snapshot?.status === 'ready';
    const chatReady = snapshot?.capabilities?.chat?.ready === true;
    const voiceReady = snapshot?.capabilities?.voice?.ready === true;
    const supported = snapshot?.supported === true;
    const busy = Boolean(setupRequest);

    if (setupElements.status) {
      setupElements.status.textContent = setupHttpError
        ? 'Status unavailable'
        : snapshot
          ? (supported ? chatReady && !voiceReady ? 'Chat ready' : snapshot.status : 'Unsupported platform')
          : busy ? 'Checking' : 'Not checked';
      setupElements.status.className = `badge${setupHttpError || (snapshot?.status === 'error' && !chatReady) ? ' badge-danger' : ready ? ' badge-success' : chatReady ? ' badge-warning' : running ? ' badge-accent' : ''}`;
    }

    if (setupElements.message) {
      setupElements.message.textContent = snapshot
        ? [snapshot.stage, snapshot.message].filter(Boolean).join(': ') || (ready ? 'Local voice is installed.' : 'Local voice is not installed.')
        : busy ? 'Checking local voice setup...' : 'Local voice setup status is unavailable.';
    }

    if (setupElements.error) {
      setupElements.error.textContent = setupHttpError || (snapshot?.error ? `${chatReady ? 'Local chat is ready. Voice setup needs attention: ' : ''}${snapshot.error}` : '');
      setupElements.error.hidden = !setupElements.error.textContent;
    }

    for (const [name, capability] of [['chat-status', snapshot?.capabilities?.chat], ['voice-status', snapshot?.capabilities?.voice]]) {
      if (setupElements[name]) {
        setupElements[name].textContent = capability?.message || 'Not ready';
        if (setupElements[name].dataset) {
          setupElements[name].dataset.ready = String(capability?.ready === true);
        }
      }
    }

    if (setupElements.platform) setupElements.platform.textContent = snapshot?.platform || 'Not available';
    if (setupElements.cache) setupElements.cache.textContent = snapshot?.cacheDir || 'Not available';
    if (setupElements.runtime) setupElements.runtime.textContent = snapshot?.runtimeDir || 'Not available';

    if (setupElements['progress-region']) setupElements['progress-region'].hidden = !running;

    const received = Math.max(0, Number(snapshot?.progress?.received) || 0);
    const total = Math.max(0, Number(snapshot?.progress?.total) || 0);
    if (setupElements.progress) {
      if (total > 0) {
        setupElements.progress.max = total;
        setupElements.progress.value = Math.min(received, total);
      } else if (typeof setupElements.progress.removeAttribute === 'function') {
        setupElements.progress.removeAttribute('value');
      } else {
        delete setupElements.progress.value;
      }
    }

    if (setupElements['progress-label']) {
      setupElements['progress-label'].textContent = total > 0 ? `${formatSetupBytes(received)} of ${formatSetupBytes(total)}` : received > 0 ? `${formatSetupBytes(received)} downloaded` : 'Preparing local components';
    }

    if (setupElements.consent) setupElements.consent.disabled = busy || running || ready || !supported;
    if (setupElements['consent-label']) setupElements['consent-label'].hidden = running || ready;

    if (setupElements['install-btn']) {
      setupElements['install-btn'].disabled = busy || running || ready || !supported || Boolean(setupHttpError) || !setupElements.consent?.checked;
    }

    if (setupElements['install-label']) {
      setupElements['install-label'].textContent = ready
        ? 'Installed'
        : running
          ? 'Installing local AI'
          : snapshot?.status === 'error' && chatReady
            ? 'Retry voice setup'
            : snapshot?.status === 'error'
              ? 'Retry installation'
              : 'Install local AI';
    }

    if (setupElements['refresh-btn']) setupElements['refresh-btn'].disabled = busy;

    if (setupElements.components) {
      const components = Array.isArray(snapshot?.components) ? snapshot.components : [];
      const children = setupElements.components.children ? [...setupElements.components.children] : [];
      const existing = new Map(children.map(item => [item.dataset?.componentId, item]));
      const activeElement = doc?.activeElement;
      const focused = (setupElements.components.contains && activeElement && setupElements.components.contains(activeElement)) ? activeElement : null;
      const items = components.map(component => {
        const item = existing.get(String(component.id)) || doc.createElement('li');
        if (item.dataset) item.dataset.componentId = component.id;
        if (!item.children || !item.children.length) {
          const span1 = doc.createElement('span');
          const span2 = doc.createElement('span');
          const a = doc.createElement('a');
          if (typeof item.append === 'function') item.append(span1, span2, a);
          else { item.appendChild(span1); item.appendChild(span2); item.appendChild(a); }
        }
        const [label, status, link] = item.children;
        if (label) label.textContent = component.label || component.id;
        if (status) {
          status.className = component.ready ? 'setup-ready' : 'setup-pending';
          status.textContent = component.ready ? 'Installed' : 'Required';
        }
        if (link) {
          link.textContent = component.id === 'kokoro' ? 'Release info' : 'Source';
          link.setAttribute('aria-label', `Download source for ${component.label || component.id} (opens in a new tab)`);
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          if (typeof link.removeAttribute === 'function') link.removeAttribute('href');
          try {
            const source = new URL(component.sourceUrl);
            if (source.protocol === 'https:') link.href = source.href;
          } catch {}
          link.hidden = !link.hasAttribute('href');
        }
        return item;
      });

      if (typeof setupElements.components.replaceChildren === 'function') {
        setupElements.components.replaceChildren(...items);
      } else {
        while (setupElements.components.firstChild) setupElements.components.removeChild(setupElements.components.firstChild);
        for (const item of items) setupElements.components.appendChild(item);
      }

      if (focused?.isConnected && typeof focused.focus === 'function') {
        focused.focus({ preventScroll: true });
      }
    }

    const log = Array.isArray(snapshot?.log) ? snapshot.log.slice(-60) : [];
    if (setupElements['log-details']) setupElements['log-details'].hidden = !log.length;
    if (setupElements.log) setupElements.log.textContent = log.join('\n');
  }

  async function requestSetup(start = false) {
    if (setupRequest || !isVisible()) return;
    if (start && (setupElements['install-btn']?.disabled || !setupElements.consent?.checked)) return;
    if (setupPoll) clearTimeoutFn(setupPoll);
    const controller = new Controller();
    setupRequest = controller;
    setupHttpError = '';
    const timeout = setTimeoutFn(() => controller.abort(), 20000);
    renderSetup();
    try {
      const response = await fetchFn('/api/setup', {
        method: start ? 'POST' : 'GET',
        cache: 'no-store',
        signal: controller.signal,
        ...(start ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true }) } : {}),
      });
      const snapshot = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof snapshot?.error === 'string' ? snapshot.error : `Setup request failed (HTTP ${response.status}).`);
      if (!snapshot || typeof snapshot.supported !== 'boolean' || !['idle', 'running', 'ready', 'error'].includes(snapshot.status)) {
        throw new Error('The setup service returned an invalid status. Refresh to try again.');
      }
      setupSnapshot = snapshot;
      const appConfig = getAppConfig?.();
      if (snapshot.status === 'ready' || (snapshot.capabilities?.chat?.ready && !appConfig?.providers?.find(provider => provider.id === 'local')?.configured)) {
        if (setupElements.consent) setupElements.consent.checked = false;
        if (!await refreshConfig(true)) throw new Error('Local AI is installed, but its configuration could not be refreshed.');
      }
    } catch (error) {
      setupHttpError = `${error.name === 'AbortError' ? 'Setup status request timed out.' : error.message} Refresh status before retrying installation.`;
    } finally {
      clearTimeoutFn(timeout);
      setupRequest = null;
      renderSetup();
      if (setupConsentFocusPending && isVisible() && !setupElements.consent?.disabled) {
        setupConsentFocusPending = false;
        setupElements.consent?.focus?.({ preventScroll: true });
      }
      if (isVisible() && setupSnapshot?.status === 'running' && !setupHttpError) {
        setupPoll = setTimeoutFn(() => requestSetup(), 2000);
      }
    }
  }

  function syncVisibility() {
    if (setupPoll) clearTimeoutFn(setupPoll);
    if (isVisible()) void requestSetup();
  }

  async function acknowledgePrompt() {
    try {
      const response = await fetchFn('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localSetupPrompted: true }),
      });
      if (response?.ok) {
        const settings = await response.json();
        onSettingsUpdate(settings);
        return settings;
      }
    } catch {}
    return null;
  }

  function closePrompt(destination) {
    const ackPromise = acknowledgePrompt();
    localSetupPrompt?.close?.();
    if (!destination) return ackPromise;
    if (destination === 'local') setupConsentFocusPending = true;
    activateView('settings');
    const scheduleFrame = win?.requestAnimationFrame || (cb => setTimeout(cb, 0));
    scheduleFrame(() => {
      const target = destination === 'local'
        ? (localSetupSection || doc?.getElementById?.('local-setup'))
        : (configSection || doc?.getElementById?.('config-section'));
      if ((typeof HTMLDetailsElement !== 'undefined' && target instanceof HTMLDetailsElement) || target?.tagName === 'DETAILS' || target?.open !== undefined) {
        target.open = true;
      }
      target?.scrollIntoView?.({ block: 'start' });
      if (destination !== 'local') target?.querySelector?.('input, select')?.focus?.({ preventScroll: true });
    });
    return ackPromise;
  }

  async function initialize() {
    try {
      const response = await fetchFn('/api/setup', { cache: 'no-store' });
      if (response?.ok) {
        setupSnapshot = await response.json();
        renderSetup();
        const settings = getAppState?.()?.settings;
        if (settings?.localSetupPrompted !== true && setupSnapshot?.status !== 'ready') {
          localSetupPrompt?.showModal?.();
        }
        return setupSnapshot;
      }
    } catch {}
    return null;
  }

  const onConsentChange = () => renderSetup();
  const onInstallClick = () => requestSetup(true);
  const onRefreshClick = () => requestSetup();
  const onVisibilityChange = () => syncVisibility();
  const onLocalStartClick = () => closePrompt('local');
  const onLocalProviderClick = () => closePrompt('provider');
  const onPromptCloseClick = () => closePrompt();
  const onPromptCancel = event => { event?.preventDefault?.(); void closePrompt(); };
  const onPageHide = () => {
    if (setupPoll) clearTimeoutFn(setupPoll);
    setupRequest?.abort?.();
  };

  setupElements.consent?.addEventListener?.('change', onConsentChange);
  setupElements['install-btn']?.addEventListener?.('click', onInstallClick);
  setupElements['refresh-btn']?.addEventListener?.('click', onRefreshClick);
  doc?.addEventListener?.('visibilitychange', onVisibilityChange);

  localSetupStart?.addEventListener?.('click', onLocalStartClick);
  localSetupProvider?.addEventListener?.('click', onLocalProviderClick);
  localSetupPromptClose?.addEventListener?.('click', onPromptCloseClick);
  localSetupPrompt?.addEventListener?.('cancel', onPromptCancel);
  win?.addEventListener?.('pagehide', onPageHide);

  function destroy() {
    if (setupPoll) clearTimeoutFn(setupPoll);
    setupRequest?.abort?.();
    setupElements.consent?.removeEventListener?.('change', onConsentChange);
    setupElements['install-btn']?.removeEventListener?.('click', onInstallClick);
    setupElements['refresh-btn']?.removeEventListener?.('click', onRefreshClick);
    doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
    localSetupStart?.removeEventListener?.('click', onLocalStartClick);
    localSetupProvider?.removeEventListener?.('click', onLocalProviderClick);
    localSetupPromptClose?.removeEventListener?.('click', onPromptCloseClick);
    localSetupPrompt?.removeEventListener?.('cancel', onPromptCancel);
    win?.removeEventListener?.('pagehide', onPageHide);
  }

  return {
    initialize,
    render: renderSetup,
    requestSetup,
    syncVisibility,
    acknowledgePrompt,
    closePrompt,
    getSnapshot: () => setupSnapshot,
    setSnapshot: snapshot => {
      setupSnapshot = snapshot;
      renderSetup();
    },
    destroy,
  };
}
