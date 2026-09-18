import test from 'node:test';
import assert from 'node:assert/strict';
import { actionTools, toolLabel, createToolField, createToolCatalog } from '../public/tools/tool-catalog.js';

test('tool catalog formats labels and action tools are identified correctly', () => {
  assert.equal(toolLabel('start_work'), 'Start Work');
  assert.equal(toolLabel('areaId'), 'AreaId');
  assert.equal(toolLabel('coding_backend'), 'Coding Backend');
  assert.equal(toolLabel('long_context'), 'Long Context');
  assert.equal(actionTools.has('start_work'), true);
  assert.equal(actionTools.has('send_work_message'), true);
  assert.equal(actionTools.has('cancel_work'), true);
  assert.equal(actionTools.has('open_work'), true);
  assert.equal(actionTools.has('delete_work'), true);
  assert.equal(actionTools.has('invoke_vscode'), true);
  assert.equal(actionTools.has('list_work'), false);
  assert.equal(actionTools.has('get_work_status'), false);
});

test('createToolField builds schema-driven controls with options, textareas and config defaults', () => {
  function makeMockElement(tagName = 'div') {
    const children = [];
    const attributes = new Map();
    const element = {
      tagName: tagName.toUpperCase(),
      children,
      textContent: '',
      className: '',
      id: '',
      name: '',
      value: '',
      required: false,
      rows: 0,
      appendChild(child) {
        children.push(child);
        return child;
      },
      append(...nodes) {
        for (const n of nodes) this.appendChild(n);
      },
      setAttribute(k, v) { attributes.set(k, String(v)); },
      getAttribute(k) { return attributes.get(k); },
    };
    return element;
  }
  const mockDoc = { createElement: tag => makeMockElement(tag) };

  const appState = {
    areas: [{ id: 'area-12345678', name: 'Voice Area' }],
    tasks: [{ id: 'task-1', title: 'Task One', state: 'active' }],
    settings: { defaultBackend: 'agency' },
  };
  const appConfig = {
    defaults: { copilotModel: 'gpt-5.6-turbo', copilotContext: 'short_context' },
  };

  // 1. Textarea for objective
  const textareaResult = createToolField('objective', { description: 'Goal' }, true, {
    document: mockDoc,
    getAppState: () => appState,
    getAppConfig: () => appConfig,
  });
  assert.equal(textareaResult.control.tagName, 'TEXTAREA');
  assert.equal(textareaResult.control.rows, 4);
  assert.equal(textareaResult.control.required, true);
  assert.equal(textareaResult.control.getAttribute('aria-label'), 'Objective');

  // 2. Select for areaId
  const areaResult = createToolField('areaId', {}, false, {
    document: mockDoc,
    getAppState: () => appState,
    getAppConfig: () => appConfig,
  });
  assert.equal(areaResult.control.tagName, 'SELECT');
  assert.equal(areaResult.control.children.length, 2); // 'Not set' + area option
  assert.equal(areaResult.control.children[0].value, '');
  assert.equal(areaResult.control.children[1].value, 'area-12345678');

  // 3. Select for taskId
  const taskResult = createToolField('taskId', {}, false, {
    document: mockDoc,
    getAppState: () => appState,
    getAppConfig: () => appConfig,
  });
  assert.equal(taskResult.control.tagName, 'SELECT');
  assert.equal(taskResult.control.children.length, 2);
  assert.equal(taskResult.control.children[1].value, 'task-1');

  // 4. Input with model default
  const modelResult = createToolField('model', {}, false, {
    document: mockDoc,
    getAppState: () => appState,
    getAppConfig: () => appConfig,
  });
  assert.equal(modelResult.control.tagName, 'INPUT');
  assert.equal(modelResult.control.value, 'gpt-5.6-turbo');

  // 5. Enum select with backend default
  const backendResult = createToolField('backend', { enum: ['copilot', 'agency'] }, false, {
    document: mockDoc,
    getAppState: () => appState,
    getAppConfig: () => appConfig,
  });
  assert.equal(backendResult.control.tagName, 'SELECT');
  assert.equal(backendResult.control.value, 'agency');
});

test('createToolCatalog renders catalog, handles tool execution, and requires confirmation for action tools', async () => {
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
      required: false,
      rows: 0,
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
      querySelectorAll(selector) {
        const results = [];
        function collect(el) {
          if (selector === '.tool-list-item' && el.className?.includes('tool-list-item')) results.push(el);
          if (selector.includes('input') && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) results.push(el);
          for (const c of el.children || []) collect(c);
        }
        collect(element);
        return results;
      },
      querySelector(selector) {
        if (selector === 'button[type="submit"]') {
          return children.find(c => c.tagName === 'BUTTON' && c.type === 'submit')
            || children.flatMap(c => c.children || []).find(c => c.tagName === 'BUTTON' && c.type === 'submit')
            || null;
        }
        return this.querySelectorAll(selector)[0] || null;
      },
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      async dispatch(event, payload = {}) {
        for (const fn of listeners.get(event) || []) {
          await fn({ preventDefault: () => {}, ...payload });
        }
      },
    };
    return element;
  }

  const elements = {
    toolCount: makeMockElement('span'),
    toolList: makeMockElement('div'),
    toolName: makeMockElement('h2'),
    toolDescription: makeMockElement('p'),
    toolKindBadge: makeMockElement('span'),
    toolForm: makeMockElement('form'),
    toolRunStatus: makeMockElement('span'),
    toolResult: makeMockElement('pre'),
  };

  const sampleTools = [
    {
      type: 'function',
      function: {
        name: 'list_work',
        description: 'List current tasks',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'start_work',
        description: 'Start a new task',
        parameters: {
          type: 'object',
          properties: { objective: { type: 'string' } },
        },
      },
    },
  ];

  let confirmResult = true;
  let confirmCalls = 0;
  const toolCalls = [];
  let stateLoaded = 0;
  let iconsUpdated = 0;

  const catalog = createToolCatalog({
    document: {
      createElement: tag => makeMockElement(tag),
      getElementById: id => elements[id],
    },
    elements,
    fetch: async () => ({
      ok: true,
      json: async () => sampleTools,
    }),
    confirm: () => {
      confirmCalls++;
      return confirmResult;
    },
    callTool: async (name, args, requestId) => {
      toolCalls.push({ name, args, requestId });
      return { taskId: 'task-new', state: 'active' };
    },
    loadState: async () => {
      stateLoaded++;
    },
    updateIcons: () => {
      iconsUpdated++;
    },
  });

  await catalog.load();
  assert.equal(elements.toolCount.textContent, '2');
  assert.equal(elements.toolName.textContent, 'list_work');
  assert.equal(elements.toolKindBadge.textContent, 'Read only');
  assert.equal(elements.toolRunStatus.textContent, 'Idle');
  assert.equal(elements.toolResult.textContent, 'Ready');
  assert.ok(iconsUpdated > 0);

  // Switch to start_work action tool
  catalog.selectTool(sampleTools[1]);
  assert.equal(elements.toolName.textContent, 'start_work');
  assert.equal(elements.toolKindBadge.textContent, 'Action');
  assert.equal(elements.toolKindBadge.className, 'badge badge-warning');

  // Cancel action confirmation
  confirmResult = false;
  await elements.toolForm.dispatch('submit');
  assert.equal(confirmCalls, 1);
  assert.equal(toolCalls.length, 0);

  // Accept action confirmation and submit
  confirmResult = true;
  // Fill objective
  const objectiveInput = elements.toolForm.querySelectorAll('input').find(i => i.name === 'objective');
  if (objectiveInput) objectiveInput.value = 'Fix frontend';
  await elements.toolForm.dispatch('submit');
  assert.equal(confirmCalls, 2);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'start_work');
  assert.equal(toolCalls[0].args.objective, 'Fix frontend');
  assert.equal(stateLoaded, 1);
  assert.equal(elements.toolRunStatus.className, 'badge badge-success');
  assert.ok(elements.toolResult.textContent.includes('task-new'));
});
