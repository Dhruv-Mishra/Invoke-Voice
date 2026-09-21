import { refreshPillbars } from '../pillbar.js';

export function createSettingsRenderer({
  getConfig,
  getState,
  getCodingBackends,
  defaultArea,
  defaultBackend,
  copilotModel,
  copilotContext,
  notifyCompleted,
  notifyNeedsInput,
  notifyFailed,
  voiceNotifications,
  browserNotifications,
  greetOnConnect,
  idleEnd,
  integrationsTableBody,
  configFields,
  privateWorkFields,
  configFeedback,
}) {
  function populateOptions() {
    const config = getConfig();
    if (!config) return;
    if (defaultBackend) {
      defaultBackend.replaceChildren();
      getCodingBackends().forEach(backend => {
        const option = document.createElement('option');
        option.value = backend.id;
        option.textContent = backend.label || backend.id;
        defaultBackend.appendChild(option);
      });
    }

    if (copilotModel) {
      copilotModel.replaceChildren();
      (config.copilotModels || []).forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.label || model.id;
        copilotModel.appendChild(option);
      });
    }

    if (copilotContext) {
      copilotContext.replaceChildren();
      (config.copilotContexts || []).forEach(context => {
        const option = document.createElement('option');
        option.value = context.id;
        option.textContent = context.label || context.id;
        copilotContext.appendChild(option);
      });
    }
  }

  function populateIntegrations() {
    const config = getConfig();
    if (!config || !integrationsTableBody) return;
    integrationsTableBody.replaceChildren();
    const integrations = config.integrations || [];
    if (integrations.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 2;
      cell.className = 'empty-detail';
      cell.textContent = 'No integrations reported.';
      row.appendChild(cell);
      integrationsTableBody.appendChild(row);
      return;
    }
    integrations.forEach(item => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = item.label || item.id;

      const status = document.createElement('td');
      const statusBadge = document.createElement('span');
      const configured = ['configured', 'workspace_configured', 'ready'].includes(item.status);
      statusBadge.className = `badge ${configured ? 'badge-success' : 'badge-warning'}`;
      statusBadge.textContent = (item.status || 'unknown').replaceAll('_', ' ');
      status.appendChild(statusBadge);
      if (item.message) {
        const message = document.createElement('p');
        message.className = 'field-hint';
        message.textContent = item.message;
        status.appendChild(message);
      }

      row.append(name, status);
      integrationsTableBody.appendChild(row);
    });
  }

  function populateView() {
    if (!defaultArea) return;
    const state = getState();
    const config = getConfig();
    if (!defaultBackend?.options.length || !copilotModel?.options.length) populateOptions();
    defaultArea.replaceChildren();
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '(No default area)';
    defaultArea.appendChild(emptyOption);

    (state.areas || []).forEach(area => {
      const option = document.createElement('option');
      option.value = area.id;
      option.textContent = area.name;
      defaultArea.appendChild(option);
    });
    defaultArea.value = state.settings?.defaultAreaId || '';

    if (defaultBackend) {
      defaultBackend.value = state.settings?.defaultBackend || config?.defaults?.codingBackend || 'agency';
    }

    if (config) {
      if (state.settings?.copilotModel) copilotModel.value = state.settings.copilotModel;
      else if (config.defaults?.copilotModel) copilotModel.value = config.defaults.copilotModel;
      if (state.settings?.copilotContext) copilotContext.value = state.settings.copilotContext;
      else if (config.defaults?.copilotContext) copilotContext.value = config.defaults.copilotContext;
    }

    const settings = state.settings || {};
    if (notifyCompleted) notifyCompleted.checked = settings.notifyCompleted !== false;
    if (notifyNeedsInput) notifyNeedsInput.checked = settings.notifyNeedsInput !== false;
    if (notifyFailed) notifyFailed.checked = settings.notifyFailed !== false;
    if (voiceNotifications) voiceNotifications.checked = settings.voiceNotifications !== false;
    if (browserNotifications) browserNotifications.checked = settings.browserNotifications !== false;
    if (greetOnConnect) greetOnConnect.checked = settings.greetOnConnect !== false;
    if (idleEnd) {
      const seconds = String(settings.idleEndSeconds ?? 60);
      idleEnd.querySelector('[data-custom]')?.remove();
      if (!['30', '60'].includes(seconds)) {
        const option = new Option(`${seconds}s`, seconds);
        option.dataset.custom = '';
        idleEnd.appendChild(option);
      }
      idleEnd.value = settings.autoEndCall === false ? '0' : seconds;
    }
    populateIntegrations();
    refreshPillbars();
  }

  function renderApplicationConfig() {
    if (!configFields) return;
    const config = getConfig();
    const drafts = new Map([configFields, privateWorkFields].filter(Boolean).flatMap(container => [...container.querySelectorAll('[data-config-key]')])
      .filter(control => control.value !== control.dataset.savedValue).map(control => [control.dataset.configKey, control.value]));
    const focusedField = configFields.contains(document.activeElement) || privateWorkFields?.contains(document.activeElement)
      ? document.activeElement.closest('.config-field')?.querySelector('[data-config-key]')?.id : null;
    configFields.replaceChildren();
    privateWorkFields?.replaceChildren();
    const warnings = Array.isArray(config?.configuration?.warnings) ? config.configuration.warnings : [];
    if (warnings.length && configFeedback && !configFeedback.textContent) {
      configFeedback.textContent = warnings.join(' ');
      configFeedback.className = 'settings-feedback error';
    }
    const fields = Array.isArray(config?.configuration?.fields) ? config.configuration.fields : [];
    if (!fields.length) {
      const unavailable = document.createElement('p');
      unavailable.className = 'field-hint';
      unavailable.textContent = 'Application configuration is unavailable.';
      configFields.appendChild(unavailable);
      return;
    }

    const groups = new Map();
    for (const field of fields) {
      if (!groups.has(field.group)) groups.set(field.group, []);
      groups.get(field.group).push(field);
    }
    for (const [groupName, groupFields] of groups) {
      const group = document.createElement('fieldset');
      group.className = 'config-group';
      const legend = document.createElement('legend');
      legend.textContent = groupName;
      const grid = document.createElement('div');
      grid.className = 'config-grid';
      for (const field of groupFields) {
        const secret = field.secret === true || field.type === 'password';
        const wrapper = document.createElement('div');
        wrapper.className = 'config-field';
        const id = `config-${field.key.toLowerCase().replaceAll('_', '-')}`;
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = field.label;
        wrapper.appendChild(label);

        let control;
        if (field.type === 'select') {
          control = document.createElement('select');
          if (field.options?.length <= 4) control.dataset.pillbar = '';
          if (['DEFAULT_PROVIDER', 'DEFAULT_VOICE_MODE', 'LOCAL_STT_PROVIDER'].includes(field.key)) control.dataset.providerIcons = '';
          for (const fieldOption of field.options || []) {
            const option = document.createElement('option');
            option.value = fieldOption.value;
            option.textContent = fieldOption.label;
            control.appendChild(option);
          }
        } else {
          control = document.createElement('input');
          control.type = secret ? 'password' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text';
          if (field.min !== undefined) control.min = String(field.min);
          if (field.max !== undefined) control.max = String(field.max);
          if (secret) {
            control.autocomplete = 'new-password';
            control.spellcheck = false;
            control.placeholder = field.configured ? 'Saved - enter a replacement' : 'Enter API key';
          }
        }
        control.id = id;
        control.dataset.configKey = field.key;
        control.dataset.configSecret = String(secret);
        if (!secret) control.value = field.value || '';
        control.dataset.savedValue = control.value;
        if (drafts.has(field.key)) control.value = drafts.get(field.key);
        wrapper.appendChild(control);
        if (field.pendingRestart) {
          const restart = document.createElement('span');
          restart.className = 'config-restart';
          restart.textContent = 'Restart to apply';
          wrapper.appendChild(restart);
        }
        if (field.description) {
          const hint = document.createElement('p');
          hint.id = `${id}-hint`;
          hint.className = 'field-hint';
          hint.textContent = field.description;
          control.setAttribute('aria-describedby', hint.id);
          wrapper.appendChild(hint);
        }
        if (secret && field.configured) {
          const saved = document.createElement('span');
          saved.className = 'config-saved';
          saved.textContent = 'Saved on this device';
          wrapper.appendChild(saved);
        }
        if (['AGENCY_WORK_DATA_ACCESS', 'VOICE_DIRECT_MCP_ACCESS'].includes(field.key) && privateWorkFields) privateWorkFields.appendChild(wrapper);
        else grid.appendChild(wrapper);
      }
      group.append(legend, grid);
      if (grid.childElementCount) configFields.appendChild(group);
    }
    refreshPillbars();
    if (focusedField) {
      const control = document.getElementById(focusedField);
      const target = control?.hidden ? control.nextElementSibling?.querySelector('[aria-checked="true"]') : control;
      target?.focus({ preventScroll: true });
    }
  }

  return Object.freeze({ populateOptions, populateIntegrations, populateView, renderApplicationConfig });
}