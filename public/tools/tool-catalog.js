export const actionTools = new Set(['start_work', 'send_work_message', 'open_work', 'delete_work', 'invoke_vscode']);

export function toolLabel(name) {
  return name.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
}

export function addToolChoice(select, value, label, doc = globalThis.document) {
  const option = doc.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

export function createToolField(propertyName, schema = {}, required = false, {
  document: doc = globalThis.document,
  getAppState = () => ({}),
  getAppConfig = () => ({}),
} = {}) {
  const field = doc.createElement('div');
  field.className = 'tool-field';
  const id = `tool-arg-${propertyName}`;
  const label = doc.createElement('label');
  label.className = 'tool-field-label';
  label.htmlFor = id;
  label.textContent = toolLabel(propertyName);
  if (required) {
    const marker = doc.createElement('span');
    marker.className = 'tool-field-required';
    marker.textContent = ' *';
    label.appendChild(marker);
  }

  const appState = getAppState?.() || {};
  const appConfig = getAppConfig?.() || {};
  const areas = appState.areas || [];
  const tasks = appState.tasks || [];

  let control;
  if (propertyName === 'areaId' && areas.length) {
    control = doc.createElement('select');
    if (!required) addToolChoice(control, '', 'Not set', doc);
    for (const area of areas) addToolChoice(control, area.id, `${area.name} / ${area.id.slice(0, 8)}`, doc);
  } else if (propertyName === 'taskId' && tasks.length) {
    control = doc.createElement('select');
    if (!required) addToolChoice(control, '', 'Not set', doc);
    for (const task of [...tasks].reverse()) addToolChoice(control, task.id, `${task.title} / ${task.state}`, doc);
  } else if (schema?.enum) {
    control = doc.createElement('select');
    for (const value of schema.enum) addToolChoice(control, value, toolLabel(value), doc);
    if (propertyName === 'context') control.value = appConfig?.defaults?.copilotContext || 'long_context';
    if (propertyName === 'backend') control.value = appState?.settings?.defaultBackend || appConfig?.defaults?.codingBackend || 'copilot';
  } else if (['objective', 'prompt'].includes(propertyName)) {
    control = doc.createElement('textarea');
    control.rows = 4;
  } else {
    control = doc.createElement('input');
    control.type = 'text';
    if (propertyName === 'model') control.value = appConfig?.defaults?.copilotModel || 'gpt-5.6-sol';
  }
  control.id = id;
  control.name = propertyName;
  control.required = Boolean(required);
  control.setAttribute('aria-label', toolLabel(propertyName));

  const help = doc.createElement('p');
  help.className = 'tool-field-help';
  help.textContent = schema?.description || schema?.type || 'Argument';
  if (typeof field.append === 'function') {
    field.append(label, control, help);
  } else {
    field.appendChild(label);
    field.appendChild(control);
    field.appendChild(help);
  }
  return { field, control };
}

function getFormEntries(form) {
  if (typeof globalThis.FormData === 'function') {
    try {
      return Array.from(new globalThis.FormData(form));
    } catch {
      // Mocked form fallback in non-browser unit test environments
    }
  }
  const entries = [];
  const controls = typeof form.querySelectorAll === 'function' ? form.querySelectorAll('input, select, textarea') : (form.elements || []);
  for (const control of controls) {
    if (control?.name && !control?.disabled) {
      entries.push([control.name, control.value ?? '']);
    }
  }
  return entries;
}

export function createToolCatalog({
  document: doc = globalThis.document,
  elements = {},
  toolCount = elements.toolCount || doc?.getElementById('tool-count'),
  toolList = elements.toolList || doc?.getElementById('tool-list'),
  toolName = elements.toolName || doc?.getElementById('tool-name'),
  toolDescription = elements.toolDescription || doc?.getElementById('tool-description'),
  toolKindBadge = elements.toolKindBadge || doc?.getElementById('tool-kind-badge'),
  toolForm = elements.toolForm || doc?.getElementById('tool-form'),
  toolRunStatus = elements.toolRunStatus || doc?.getElementById('tool-run-status'),
  toolResult = elements.toolResult || doc?.getElementById('tool-result'),
  getAppState = () => ({}),
  getAppConfig = () => ({}),
  updateIcons = () => {},
  loadState = async () => {},
  callTool,
  fetch = (url, opts) => globalThis.fetch(url, opts),
  confirm = (typeof window !== 'undefined' && window.confirm ? window.confirm.bind(window) : () => true),
} = {}) {
  let availableTools = [];
  let selectedTool = null;

  const executeTool = callTool || (async (name, args = {}, requestId = (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `req-${Date.now()}`)) => {
    const response = await fetch('/api/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args, requestId }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  });

  function selectToolDefinition(definition) {
    selectedTool = definition;
    const { name, description, parameters = {} } = definition.function;
    if (toolName) toolName.textContent = name;
    if (toolDescription) toolDescription.textContent = description;
    if (toolKindBadge) {
      toolKindBadge.textContent = actionTools.has(name) ? 'Action' : 'Read only';
      toolKindBadge.className = actionTools.has(name) ? 'badge badge-warning' : 'badge badge-success';
    }
    if (toolRunStatus) {
      toolRunStatus.textContent = 'Idle';
      toolRunStatus.className = 'badge';
    }
    if (toolResult) toolResult.textContent = 'Ready';
    if (toolForm) {
      toolForm.replaceChildren();

      for (const [propertyName, schema] of Object.entries(parameters?.properties || {})) {
        const { field } = createToolField(propertyName, schema, parameters.required?.includes(propertyName), {
          document: doc,
          getAppState,
          getAppConfig,
        });
        toolForm.appendChild(field);
      }

      const actions = doc.createElement('div');
      actions.className = 'tool-actions';
      const run = doc.createElement('button');
      run.type = 'submit';
      run.className = 'btn btn-accent';
      run.innerHTML = '<i data-lucide="play"></i><span>Run Tool</span>';
      actions.appendChild(run);
      toolForm.appendChild(actions);
    }

    if (toolList) {
      for (const item of toolList.querySelectorAll('.tool-list-item')) {
        item.setAttribute('aria-selected', String(item.dataset.tool === name));
      }
    }
  }

  function renderToolCatalog() {
    if (toolList) toolList.replaceChildren();
    if (toolCount) toolCount.textContent = String(availableTools.length);
    for (const definition of availableTools) {
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'tool-list-item';
      item.dataset.tool = definition.function.name;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      const icon = doc.createElement('span');
      icon.className = 'tool-list-icon';
      icon.innerHTML = `<i data-lucide="${actionTools.has(definition.function.name) ? 'play' : 'scan-search'}"></i>`;
      const copy = doc.createElement('span');
      const name = doc.createElement('span');
      name.className = 'tool-list-name';
      name.textContent = definition.function.name;
      const description = doc.createElement('span');
      description.className = 'tool-list-description';
      description.textContent = definition.function.description;
      if (typeof copy.append === 'function') copy.append(name, description);
      else { copy.appendChild(name); copy.appendChild(description); }
      if (typeof item.append === 'function') item.append(icon, copy);
      else { item.appendChild(icon); item.appendChild(copy); }
      item.addEventListener('click', () => {
        selectToolDefinition(definition);
        updateIcons?.();
      });
      if (toolList) toolList.appendChild(item);
    }
    if (availableTools.length) selectToolDefinition(availableTools[0]);
  }

  async function load() {
    try {
      const response = await fetch('/api/tools');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      availableTools = result;
      renderToolCatalog();
      updateIcons?.();
      return availableTools;
    } catch (error) {
      if (toolName) toolName.textContent = 'Tools unavailable';
      if (toolDescription) toolDescription.textContent = error.message;
      if (toolRunStatus) {
        toolRunStatus.textContent = 'Error';
        toolRunStatus.className = 'badge badge-danger';
      }
    }
  }

  if (toolForm) {
    toolForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!selectedTool) return;
      const name = selectedTool.function.name;
      if (actionTools.has(name) && !await confirm(`Run ${name}? This tool can change local session state or open VS Code.`)) return;
      const args = {};
      for (const [key, value] of getFormEntries(toolForm)) {
        if (typeof value !== 'string' || value.trim()) args[key] = typeof value === 'string' ? value.trim() : value;
      }
      const requestId = (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `req-${Date.now()}`);
      const startedAt = (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
      const submit = toolForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      if (toolRunStatus) {
        toolRunStatus.textContent = 'Running';
        toolRunStatus.className = 'badge badge-warning';
      }
      if (toolResult) toolResult.textContent = `${name} running...`;
      try {
        const result = await executeTool(name, args, requestId);
        const elapsed = (globalThis.performance?.now ? globalThis.performance.now() : Date.now()) - startedAt;
        if (toolRunStatus) {
          toolRunStatus.textContent = `${Math.round(elapsed)} ms`;
          toolRunStatus.className = 'badge badge-success';
        }
        if (toolResult) toolResult.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        if (name === 'start_work' || name === 'send_work_message') await loadState();
      } catch (error) {
        if (toolRunStatus) {
          toolRunStatus.textContent = 'Failed';
          toolRunStatus.className = 'badge badge-danger';
        }
        if (toolResult) toolResult.textContent = error.message;
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  return {
    load,
    selectTool: selectToolDefinition,
    render: renderToolCatalog,
    getAvailableTools: () => availableTools,
    getSelectedTool: () => selectedTool,
  };
}
