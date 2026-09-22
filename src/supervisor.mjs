import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import path from 'node:path';
import MiniSearch from 'minisearch';
import { DEFAULT_WORK_AREA, defaultWorkspacePath } from './vscode-bridge.mjs';
import { supervisorTools, tools, supervisorInstructions } from './supervisor/contract.mjs';
import { createLocalTaskSearch } from './supervisor/semantic-search.mjs';

export { supervisorTools, tools, supervisorInstructions };

const CONTEXTS = ['default', 'long_context'];
const BACKENDS = ['copilot', 'agency'];
const TERMINAL_STATES = new Set(['result_ready', 'agent_failed', 'agent_stopped', 'completed', 'failed', 'cancelled']);
const RESUMABLE_STATES = new Set([...TERMINAL_STATES, 'needs_input']);
const SEARCH_STOP_WORDS = new Set('a an and are can could do for how i in is it me my of on please s status task tasks tell that the this to was what whats which work you'.split(' '));
const TRANSIENT_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function renameStateFile(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (attempt >= 4 || !TRANSIENT_RENAME_ERRORS.has(error.code)) throw error;
      Atomics.wait(RENAME_RETRY_SIGNAL, 0, 0, 20 * (attempt + 1));
    }
  }
}

function requiredText(value, label, limit = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${label}`);
  return value.trim();
}

export class Supervisor extends EventEmitter {
  constructor({ dataDir, bridge, now = () => Date.now(), env = process.env, semanticSearch }) {
    super();
    this.dataDir = dataDir;
    this.bridge = bridge;
    this.now = now;
    this.env = env;
    this.semanticSearch = semanticSearch ?? createLocalTaskSearch({ dataDir, env });
    this.activeTasks = new Map();
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'state.json');
    this.recoveryWarning = null;
    try {
      this.state = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!this.state || typeof this.state !== 'object' || Array.isArray(this.state)) throw new Error('State root must be an object');
    }
    catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${this.now()}`;
        renameStateFile(this.file, backup);
        this.recoveryWarning = `Invalid saved state was preserved at ${backup}.`;
        console.warn(`${this.recoveryWarning} ${error.message}`);
      }
      this.state = { areas: [], tasks: [], settings: {} };
    }
    if (!Array.isArray(this.state.areas)) this.state.areas = [];
    this.state.areas = this.state.areas
      .filter(area => area && typeof area === 'object' && typeof area.id === 'string' && area.id && typeof area.name === 'string' && area.name.trim() && typeof area.repoPath === 'string' && area.repoPath)
      .map(area => ({
        ...DEFAULT_WORK_AREA,
        ...area,
        aliases: Array.isArray(area.aliases) ? area.aliases.filter(alias => typeof alias === 'string') : [],
        agent: typeof area.agent === 'string' && area.agent ? area.agent : DEFAULT_WORK_AREA.agent,
        baseRef: typeof area.baseRef === 'string' && area.baseRef ? area.baseRef : DEFAULT_WORK_AREA.baseRef,
        instructions: typeof area.instructions === 'string' ? area.instructions : '',
        allowPublish: area.allowPublish === true,
      }));
    if (!Array.isArray(this.state.tasks)) this.state.tasks = [];
    this.state.notifications = (Array.isArray(this.state.notifications) ? this.state.notifications : []).filter(item => item && typeof item.id === 'string').slice(-100);
    this.state.tasks = this.state.tasks.filter(task => task && typeof task === 'object' && typeof task.id === 'string');
    for (const task of this.state.tasks) {
      if (!task.backend || task.backend === 'copilot-cli') task.backend = 'copilot';
      if (!Array.isArray(task.turns)) task.turns = [];
      if (!Array.isArray(task.observations)) task.observations = [];
      if (['dispatching', 'running', 'cancelling'].includes(task.state)) {
        task.state = 'agent_stopped';
        task.error = 'The app restarted before this task reported completion. Check the worktree, then continue or delete it.';
        for (const turn of task.turns) {
          if (['dispatching', 'running'].includes(turn.state)) turn.state = 'agent_stopped';
        }
      }
    }
    if (!this.state.settings || typeof this.state.settings !== 'object' || Array.isArray(this.state.settings)) this.state.settings = {};
    this.state.settings = {
      defaultAreaId: null,
      defaultBackend: 'agency',
      copilotModel: env.COPILOT_MODEL || 'gpt-5.6-sol',
      copilotContext: 'default',
      notifyCompleted: true,
      notifyNeedsInput: true,
      notifyFailed: true,
      voiceNotifications: true,
      browserNotifications: false,
      greetOnConnect: true,
      autoEndCall: true,
      idleEndSeconds: 60,
      localSetupPrompted: false,
      ...this.state.settings,
    };
    if (!BACKENDS.includes(this.state.settings.defaultBackend)) this.state.settings.defaultBackend = 'agency';
    if (!CONTEXTS.includes(this.state.settings.copilotContext)) this.state.settings.copilotContext = 'default';
    this.save();
  }

  save() {
    if (!this.state.areas.length) {
      const repoPath = defaultWorkspacePath(this.dataDir);
      mkdirSync(repoPath, { recursive: true });
      if (realpathSync.native(repoPath) !== repoPath) throw new Error('Default workspace must stay inside the application data directory');
      this.state.areas.push({ id: randomUUID(), ...DEFAULT_WORK_AREA, aliases: [], repoPath });
    }
    if (!this.state.areas.some(area => area.id === this.state.settings.defaultAreaId)) {
      this.state.settings.defaultAreaId = this.state.areas[0]?.id || null;
    }
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2));
    renameStateFile(`${this.file}.tmp`, this.file);
    this.emit('change', this.snapshot());
  }

  snapshot() {
    return { areas: this.state.areas, tasks: this.state.tasks.map(task => this.status(task.id)), notifications: this.state.notifications.map(item => ({ ...item })), settings: { ...this.state.settings }, ...(this.recoveryWarning ? { recoveryWarning: this.recoveryWarning } : {}) };
  }

  publishNotification(task, text) {
    const notification = { id: randomUUID(), taskId: task.id, title: task.title, state: task.state, text: String(text || task.state).slice(0, 1800), at: this.now(), read: false };
    this.state.notifications.push(notification);
    this.state.notifications = this.state.notifications.slice(-100);
    this.save();
    this.emit('notification', { ...notification });
  }

  readNotifications(input = {}) {
    if (!Array.isArray(input.ids) || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string')) throw new Error('Invalid notification IDs');
    const ids = new Set(input.ids);
    for (const notification of this.state.notifications) if (ids.has(notification.id)) notification.read = true;
    this.save();
    return { notifications: this.snapshot().notifications };
  }

  async registerArea(input) {
    const name = requiredText(input.name, 'work area name', 100);
    const repoPath = realpathSync(requiredText(input.repoPath, 'repo path', 2000));
    await this.bridge.verifyRepo(repoPath);
    const agent = requiredText(input.agent || DEFAULT_WORK_AREA.agent, 'agent', 100);
    const baseRef = requiredText(input.baseRef || DEFAULT_WORK_AREA.baseRef, 'base ref', 200);
    if (baseRef.startsWith('-') || !/^[\w ./-]+$/.test(agent)) throw new Error('Invalid ref or agent mode');
    const aliases = Array.isArray(input.aliases) ? input.aliases.map(alias => requiredText(alias, 'alias', 100)).slice(0, 20) : [];
    const existing = input.id && this.state.areas.find(area => area.id === input.id);
    if (input.id && !existing) throw new Error('Unknown work area');
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : '';
    if (instructions.length > 8000) throw new Error('Work area instructions are too long');
    const area = { id: existing?.id || randomUUID(), name, aliases, repoPath, agent, baseRef, instructions, allowPublish: input.allowPublish === true };
    const names = [name, ...aliases].map(value => value.toLowerCase());
    if (this.state.areas.some(other => other.id !== area.id && [other.name, ...other.aliases].some(value => names.includes(value.toLowerCase())))) throw new Error('Work area names and aliases must be unique');
    if (existing) Object.assign(existing, area); else this.state.areas.push(area);
    this.save();
    return area;
  }

  updateSettings(input = {}) {
    const next = { ...this.state.settings };
    if (Object.hasOwn(input, 'appearanceTheme')) {
      if (!['alpine', 'jarvis', 'baymax'].includes(input.appearanceTheme)) throw new Error('Invalid theme');
      next.appearanceTheme = input.appearanceTheme;
    }
    if (Object.hasOwn(input, 'defaultAreaId')) {
      if (input.defaultAreaId !== null && !this.state.areas.some(area => area.id === input.defaultAreaId)) throw new Error('Unknown default work area');
      next.defaultAreaId = input.defaultAreaId || null;
    }
    if (Object.hasOwn(input, 'copilotModel')) next.copilotModel = requiredText(input.copilotModel, 'Copilot model', 100);
    if (Object.hasOwn(input, 'defaultBackend')) {
      if (!BACKENDS.includes(input.defaultBackend)) throw new Error('Invalid coding backend');
      next.defaultBackend = input.defaultBackend;
    }
    if (Object.hasOwn(input, 'copilotContext')) {
      if (!CONTEXTS.includes(input.copilotContext)) throw new Error('Invalid context tier');
      next.copilotContext = input.copilotContext;
    }
    for (const key of ['notifyCompleted', 'notifyNeedsInput', 'notifyFailed', 'voiceNotifications', 'browserNotifications', 'localSetupPrompted', 'agencySetupPrompted', 'greetOnConnect', 'autoEndCall']) {
      if (Object.hasOwn(input, key)) next[key] = input[key] === true;
    }
    if (Object.hasOwn(input, 'idleEndSeconds')) {
      if (!Number.isInteger(input.idleEndSeconds) || input.idleEndSeconds < 5 || input.idleEndSeconds > 3600) throw new Error('Idle timeout must be whole seconds between 5 and 3600');
      next.idleEndSeconds = input.idleEndSeconds;
    }
    this.state.settings = next;
    this.save();
    return { ...next };
  }

  deleteTask(id) {
    const status = this.status(id);
    if (!status.deletable) throw new Error('Only finished or stale tasks can be deleted');
    this.state.tasks = this.state.tasks.filter(item => item.id !== id);
    this.save();
    return { deleted: 'task' };
  }

  deleteArea(id) {
    const area = this.state.areas.find(item => item.id === id);
    if (!area) throw new Error('Unknown work area');
    if (this.state.tasks.some(task => task.areaId === id)) throw new Error('Delete this area\'s tasks first');
    this.state.areas = this.state.areas.filter(item => item.id !== id);
    this.save();
    return { deleted: 'area' };
  }

  resolveArea(id) {
    const areaId = id || this.state.settings.defaultAreaId;
    const area = this.state.areas.find(item => item.id === areaId);
    if (!area) throw new Error('Choose a work area or configure a default');
    return area;
  }

  listAgents(areaId) {
    const area = this.resolveArea(areaId);
    const directory = path.join(area.repoPath, '.github', 'agents');
    const agents = [{ id: 'agent', name: 'Default agent', model: null }];
    if (!existsSync(directory)) return agents;
    for (const file of readdirSync(directory).filter(name => name.endsWith('.agent.md')).sort().slice(0, 100)) {
      const id = file.slice(0, -'.agent.md'.length);
      const source = readFileSync(path.join(directory, file), 'utf8').slice(0, 20000);
      const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
      const field = name => frontmatter.match(new RegExp(`^${name}:\\s*["']?([^"'\\r\\n]+)`, 'mi'))?.[1]?.trim();
      agents.push({ id, name: field('name') || id, model: field('model') || null });
    }
    return agents;
  }

  task(id) {
    const task = this.state.tasks.find(item => item.id === id);
    if (!task) throw new Error('Unknown task');
    return task;
  }

  status(id) {
    const task = this.task(id);
    const lastActivityAt = task.lastObservedAt ?? task.dispatchStartedAt ?? task.createdAt ?? 0;
    const stale = ['dispatching', 'running'].includes(task.state) && this.now() - lastActivityAt > 120000;
    const state = task.state === 'dispatching' && this.now() - (task.dispatchStartedAt || task.createdAt) > 30000 ? 'dispatch_unconfirmed' : stale && task.state === 'running' ? 'unknown' : task.state;
    const deletable = !this.activeTasks.has(id) && (TERMINAL_STATES.has(state) || stale);
    const canMessage = !this.closed && !this.activeTasks.get(id)?.signal.aborted && state !== 'cancelling' && (state !== 'cancelled' || Boolean(task.worktree || task.directory)) && (this.activeTasks.has(id) || RESUMABLE_STATES.has(state));
    const queued = task.turns.filter(turn => turn.state === 'queued').length;
    const canCancel = !this.closed && !['cancelling', 'cancelled'].includes(state) && (this.activeTasks.has(id) || queued > 0);
    return { ...task, state, lastObservedState: task.state, stale, deletable, canMessage, canCancel, ...(queued ? { queued, queuePaused: !this.activeTasks.has(id) } : {}), observations: task.observations.slice(-8) };
  }

  toolStatus(id) {
    const source = this.task(id);
    const task = this.status(id);
    const currentTurn = source.turns.find(turn => ['dispatching', 'running'].includes(turn.state)) ?? source.turns.findLast(turn => turn.state !== 'queued');
    const latest = currentTurn
      ? source.observations.filter(observation => observation.at >= (currentTurn.startedAt ?? currentTurn.createdAt)).at(-1)
      : source.observations.at(-1);
    const actions = [];
    if (task.canMessage) actions.push('send_work_message');
    if (task.canCancel) actions.push('cancel_work');
    if (task.worktree) actions.push('open_work');
    if (task.deletable || task.canCancel) actions.push('delete_work');
    const result = task.result && String(task.result);
    const error = task.error && String(task.error);
    const queued = task.queued;
    const update = latest?.summary && latest.summary !== result && latest.summary !== error ? String(latest.summary).slice(0, 600) : null;
    return {
      taskId: task.id,
      title: task.title,
      state: task.state,
      actions,
      ...(queued ? { queued, ...(!this.activeTasks.has(id) ? { queuePaused: true } : {}) } : {}),
      ...(task.stale ? { stale: true } : {}),
      ...(update ? { update } : {}),
      ...(result ? { result: result.slice(0, 1200), ...(result.length > 1200 ? { resultTruncated: true } : {}) } : {}),
      ...(error ? { error: error.slice(0, 600), ...(error.length > 600 ? { errorTruncated: true } : {}) } : {}),
    };
  }

  async searchWork(query) {
    const text = requiredText(query, 'task query', 200);
    const areas = new Map(this.state.areas.map(area => [area.id, [area.name, ...area.aliases].join(' ')]));
    const index = new MiniSearch({
      fields: ['title', 'objective', 'messages', 'area'],
      processTerm: term => {
        const normalized = term.toLowerCase();
        return SEARCH_STOP_WORDS.has(normalized) ? null : normalized;
      },
      searchOptions: { combineWith: 'AND', prefix: true, fuzzy: 0.2, boost: { title: 3, objective: 2 } },
    });
    index.addAll(this.state.tasks.map(task => ({
      id: task.id,
      title: task.title || '',
      objective: task.objective || '',
      messages: task.turns.map(turn => turn.message || '').join(' '),
      area: areas.get(task.areaId) || '',
    })));
    const keywords = MiniSearch.getDefault('tokenize')(text).map(term => term.toLowerCase()).filter(term => term && !SEARCH_STOP_WORDS.has(term)).join(' ');
    if (!keywords) return { tasks: [], hasMore: false };
    const lexical = index.search(text);
    const documents = this.state.tasks.map(task => ({
      id: task.id,
      text: [task.title, String(task.objective || '').slice(0, 1200), ...task.turns.slice(-2).map(turn => String(turn.message || '').slice(0, 300))].filter(Boolean).join('\n'),
    }));
    let matches = lexical;
    try { matches = await this.semanticSearch(keywords, documents, lexical); } catch {}
    matches = matches.filter(match => this.state.tasks.some(task => task.id === match.id));
    return {
      tasks: matches.slice(0, 3).map(match => {
        const task = this.task(match.id);
        const status = this.toolStatus(task.id);
        return {
          ...status,
          title: String(task.title || task.objective || 'Untitled task').slice(0, 90),
          area: this.state.areas.find(area => area.id === task.areaId)?.name,
          ...(status.update ? { update: status.update.slice(0, 240) } : {}),
          ...(status.result ? { result: status.result.slice(0, 360), ...(status.result.length > 360 ? { resultTruncated: true } : {}) } : {}),
          ...(status.error ? { error: status.error.slice(0, 240), ...(status.error.length > 240 ? { errorTruncated: true } : {}) } : {}),
        };
      }),
      hasMore: matches.length > 3,
    };
  }

  async callTool(name, args = {}, context = {}) {
    if (!tools.some(tool => tool.function.name === name)) throw new Error('Unknown tool');
    if (this.closed && ['start_work', 'send_work_message', 'invoke_vscode'].includes(name)) throw new Error('Application is shutting down');
    if (['send_work_message', 'get_work_status', 'cancel_work', 'open_work', 'delete_work'].includes(name)) {
      const selectors = ['taskId', 'query', ...(name === 'delete_work' ? ['areaId', 'all'] : [])].filter(key => args[key] !== undefined);
      if (selectors.length !== 1) throw new Error('Provide exactly one taskId or query, or areaId or all:true for deletion');
      if (args.query !== undefined) {
        const exactTask = this.state.tasks.find(task => task.id === args.query);
        const matches = exactTask ? { tasks: [this.toolStatus(exactTask.id)], hasMore: false } : await this.searchWork(args.query);
        if (matches.hasMore || matches.tasks.length !== 1) return { clarificationRequired: true, ...matches };
        args = { ...args, taskId: matches.tasks[0].taskId };
        delete args.query;
      }
    }
    if (name === 'control_app') {
      if (args.action === 'set_theme') {
        const appearanceTheme = { copilot: 'alpine', jarvis: 'jarvis', baymax: 'baymax' }[args.value];
        this.updateSettings({ appearanceTheme });
      } else if (args.action === 'set_spoken_updates') {
        if (!['on', 'off'].includes(args.value)) throw new Error('Expected on or off');
        this.updateSettings({ voiceNotifications: args.value === 'on' });
      } else if (args.action === 'clear_notifications' || args.action === 'read_notifications') {
        if (args.value !== undefined) throw new Error('Inbox actions do not accept a value');
        if (args.action === 'clear_notifications') this.state.notifications = [];
        else for (const notification of this.state.notifications) notification.read = true;
        this.save();
      } else throw new Error('Unknown app action');
      return { saved: true, action: args.action, ...(args.value === undefined ? {} : { value: args.value }) };
    }
    if (name === 'list_work' && args.query !== undefined) return this.searchWork(args.query);
    if (name === 'list_work') return { defaultAreaId: this.state.settings.defaultAreaId, areas: this.state.areas.map(({ id, name, aliases }) => ({ id, name, aliases })), tasks: this.state.tasks.slice(-25).map(task => ({ ...this.toolStatus(task.id), id: task.id, areaId: task.areaId, backend: task.backend })) };
    if (name === 'send_work_message') {
      const task = this.task(requiredText(args.taskId, 'task ID', 200));
      if (!this.status(task.id).canMessage) throw new Error('Task is not ready for a follow-up');
      const message = requiredText(args.message, 'follow-up message');
      const requestId = requiredText(context.requestId, 'follow-up request ID', 200);
      const duplicate = task.turns.find(turn => turn.requestId === requestId);
      if (duplicate) {
        if (duplicate.message !== message) throw new Error('Request ID already used for another message');
        return { taskId: task.id, state: duplicate.state === 'queued' ? 'queued' : this.status(task.id).state, duplicate: true };
      }
      const active = this.activeTasks.has(task.id);
      if (!active && !RESUMABLE_STATES.has(this.status(task.id).state)) throw new Error('Task is not ready for a follow-up');
      const area = this.resolveArea(task.areaId);
      if (active && task.turns.filter(turn => turn.state === 'queued').length >= 10) throw new Error('Task queue is full (10 messages)');
      const turn = { requestId, message, createdAt: this.now(), state: active ? 'queued' : 'dispatching' };
      task.turns.push(turn);
      if (active) this.save();
      else this.startTurn(task, { ...area }, turn);
      return { taskId: task.id, state: active ? 'queued' : 'dispatching' };
    }
    if (name === 'get_work_status') return this.toolStatus(requiredText(args.taskId, 'task ID', 200));
    if (name === 'cancel_work') {
      const task = this.task(requiredText(args.taskId, 'task ID', 200));
      if (['cancelling', 'cancelled'].includes(task.state)) return { taskId: task.id, state: task.state };
      if (!this.status(task.id).canCancel) throw new Error('Task is not running or queued');
      task.state = 'cancelling';
      for (const turn of task.turns.filter(turn => turn.state === 'queued')) {
        turn.state = 'cancelled';
        turn.completedAt = this.now();
      }
      const controller = this.activeTasks.get(task.id);
      if (controller) { controller.abort(); this.save(); }
      else this.finishCancellation(task);
      return { taskId: task.id, state: task.state };
    }
    if (name === 'delete_work') {
      if (args.all !== undefined) {
        if (args.all !== true) throw new Error('Use all:true to delete all task chats');
        const targets = this.state.tasks.map(task => ({ id: task.id, title: task.title }));
        let deletedCount = 0;
        const failed = [];
        for (const task of targets) {
          try { await this.callTool('delete_work', { taskId: task.id }, context); deletedCount += 1; }
          catch (error) { failed.push({ taskId: task.id, title: task.title, error: error.message }); }
        }
        return { deleted: 'tasks', deletedCount, failedCount: failed.length, failed: failed.slice(0, 5), remaining: this.state.tasks.length };
      }
      const taskId = typeof args.taskId === 'string' && args.taskId.trim();
      const areaId = typeof args.areaId === 'string' && args.areaId.trim();
      if (Boolean(taskId) === Boolean(areaId)) throw new Error('Provide exactly one taskId or areaId');
      const controller = taskId && this.activeTasks.get(taskId);
      if (controller?.completion) {
        await this.callTool('cancel_work', { taskId });
        await controller.completion;
      }
      return taskId ? this.deleteTask(taskId) : this.deleteArea(areaId);
    }
    if (name === 'open_work') {
      const task = this.task(requiredText(args.taskId, 'task ID', 200));
      if (!task.worktree) throw new Error('Worktree is not ready yet');
      await this.bridge.open(task.worktree);
      return { opened: true };
    }
    if (name === 'invoke_vscode') {
      const area = this.resolveArea(args.areaId);
      const prompt = requiredText(args.prompt, 'prompt');
      const model = requiredText((typeof args.model === 'string' && args.model.trim().toLowerCase() === 'default' ? '' : args.model) || this.state.settings.copilotModel, 'model', 100);
      const selectedContext = args.context || this.state.settings.copilotContext;
      if (!CONTEXTS.includes(selectedContext)) throw new Error('Invalid context tier');
      const requestId = requiredText(context.requestId, 'request ID', 200);
      await this.bridge.invokeVSCode({ prompt, model, context: selectedContext, directory: area.repoPath, requestId });
      return { invoked: true };
    }
    const area = this.resolveArea(args.areaId);
    const objective = requiredText(args.objective, 'objective');
    if (args.readOnly !== undefined && typeof args.readOnly !== 'boolean') throw new Error('Invalid read-only flag');
    const readOnly = args.readOnly === true;
    const backend = args.backend || (readOnly ? 'agency' : this.state.settings.defaultBackend);
    if (!BACKENDS.includes(backend)) throw new Error('Invalid coding backend');
    if (readOnly && backend !== 'agency') throw new Error('Read-only tasks require Agency');
    const model = requiredText((typeof args.model === 'string' && args.model.trim().toLowerCase() === 'default' ? '' : args.model) || this.state.settings.copilotModel, 'model', 100);
    const agent = requiredText(readOnly ? 'agent' : (args.agent || area.agent || DEFAULT_WORK_AREA.agent), 'agent', 100);
    if (!/^[\w ./-]+$/.test(agent)) throw new Error('Invalid agent');
    const selectedContext = args.context || this.state.settings.copilotContext;
    if (!CONTEXTS.includes(selectedContext)) throw new Error('Invalid context tier');
    const requestId = requiredText(context.requestId, 'dispatch request ID', 200);
    const duplicate = this.state.tasks.find(task => task.requestId === requestId);
    if (duplicate) {
      if (duplicate.areaId !== area.id || duplicate.objective !== objective || duplicate.backend !== backend || duplicate.model !== model || duplicate.agent !== agent || duplicate.context !== selectedContext || (duplicate.readOnly === true) !== readOnly) throw new Error('Request ID already used for another task');
      return { taskId: duplicate.id, state: this.status(duplicate.id).state, duplicate: true };
    }
    const task = { id: randomUUID(), requestId, areaId: area.id, title: objective.slice(0, 90), objective, backend, model, agent, readOnly, context: selectedContext, state: 'dispatching', createdAt: this.now(), dispatchStartedAt: this.now(), lastObservedAt: null, sessionId: randomUUID(), worktree: null, branch: null, observations: [], turnObservationStart: 0, turns: [] };
    this.state.tasks.push(task);
    this.activeTasks.set(task.id, new AbortController());
    this.save();
    this.activeTasks.get(task.id).completion = this.dispatch(task, { ...area });
    return { taskId: task.id, state: 'dispatching' };
  }

  startTurn(task, area, turn) {
    this.activeTasks.set(task.id, new AbortController());
    turn.state = 'dispatching';
    turn.startedAt = this.now();
    task.state = 'dispatching';
    task.dispatchStartedAt = this.now();
    task.turnObservationStart = task.observations.length;
    delete task.result;
    delete task.error;
    this.save();
    this.activeTasks.get(task.id).completion = this.continueTask(task, area, turn);
  }

  drainQueue(task, area) {
    if (this.closed) return;
    const turn = task.turns.find(item => item.state === 'queued');
    if (turn) this.startTurn(task, area, turn);
  }

  async close() {
    this.closed = true;
    await this.bridge?.close?.();
  }

  async dispatch(task, area) {
    const { signal } = this.activeTasks.get(task.id);
    let acceptingEvents = true;
    let completed = false;
    try {
      const prepared = await this.bridge.prepare(task, area, { signal });
      Object.assign(task, prepared);
      this.save();
      signal.throwIfAborted();
      const result = await this.bridge.dispatch(task, area, event => { if (acceptingEvents && !signal.aborted) this.recordAgentEvent(task, event); }, { signal });
      acceptingEvents = false;
      signal.throwIfAborted();
      if (result) {
        this.completeTask(task, result);
        completed = true;
      }
    } catch (error) {
      if (signal.aborted) this.finishCancellation(task);
      else this.failTask(task, error);
    } finally {
      acceptingEvents = false;
      this.activeTasks.delete(task.id);
      if (completed) this.drainQueue(task, area);
      this.emit('change', this.snapshot());
    }
  }

  async continueTask(task, area, turn) {
    const { signal } = this.activeTasks.get(task.id);
    let acceptingEvents = true;
    let completed = false;
    try {
      signal.throwIfAborted();
      const result = await this.bridge.continue(task, area, turn.message, event => { if (acceptingEvents && !signal.aborted) this.recordAgentEvent(task, event); }, { signal });
      acceptingEvents = false;
      signal.throwIfAborted();
      if (result) {
        this.completeTask(task, result, turn);
        completed = true;
      }
    } catch (error) {
      if (signal.aborted) this.finishCancellation(task, turn);
      else this.failTask(task, error, turn);
    } finally {
      acceptingEvents = false;
      this.activeTasks.delete(task.id);
      if (completed) this.drainQueue(task, area);
      this.emit('change', this.snapshot());
    }
  }

  finishCancellation(task, turn = null) {
    task.state = 'cancelled';
    task.result = 'Cancelled. Already completed changes were not undone.';
    delete task.error;
    if (turn) { turn.state = 'cancelled'; turn.completedAt = this.now(); }
    this.appendObservation(task, { id: randomUUID(), at: this.now(), kind: 'cancelled', summary: task.result, source: 'supervisor' });
    this.save();
  }

  completeTask(task, result, turn = null) {
    task.state = 'result_ready';
    task.result = String(result.result || `${task.backend === 'agency' ? 'Agency' : 'Copilot CLI'} completed.`).slice(0, 6000);
    task.sessionLog = result.sessionLog;
    task.usage = result.usage;
    if (turn) {
      turn.state = 'result_ready';
      turn.result = task.result;
      turn.completedAt = this.now();
    }
    this.recordAgentEvent(task, { kind: 'result_ready', summary: task.result });
    if (this.state.settings.notifyCompleted) this.publishNotification(task, task.result);
  }

  failTask(task, error, turn = null) {
    task.state = 'agent_failed';
    task.error = error.message;
    if (turn) {
      turn.state = 'agent_failed';
      turn.error = error.message;
      turn.completedAt = this.now();
    }
    this.appendObservation(task, { id: randomUUID(), at: this.now(), kind: 'error', summary: error.message.slice(0, 1800), source: `${task.backend}-cli` });
    this.save();
    if (this.state.settings.notifyFailed) this.publishNotification(task, task.error);
  }

  recordAgentEvent(task, event) {
    const observation = { id: randomUUID(), at: this.now(), kind: event.kind || 'progress', summary: String(event.summary || 'Agent progress').slice(0, 1800), source: `${task.backend}-cli` };
    this.appendObservation(task, observation);
    if (task.state !== 'result_ready') task.state = event.kind === 'result_ready' ? 'result_ready' : 'running';
    this.save();
  }

  appendObservation(task, observation) {
    task.observations.push(observation);
    task.observations = task.observations.slice(-100);
    task.lastObservedAt = observation.at;
  }

  observe(event) {
    const task = this.task(event.taskId);
    if (['cancelling', 'cancelled'].includes(task.state)) return false;
    if (!task.worktree || typeof event.cwd !== 'string') return false;
    let cwd;
    try { cwd = realpathSync(event.cwd); } catch { return false; }
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(cwd) !== normalize(realpathSync(task.worktree))) return false;
    if (task.observations.some(item => item.id === event.id)) return false;
    if (!task.sessionId) {
      if (event.kind !== 'UserPromptSubmit' || typeof event.sessionId !== 'string' || !event.sessionId || !event.prompt?.includes(`[voice-task:${task.id}]`)) return false;
      task.sessionId = event.sessionId;
    }
    if (event.sessionId !== task.sessionId) return false;
    const observation = { id: event.id || randomUUID(), at: this.now(), kind: event.kind, summary: String(event.summary || event.kind).slice(0, 1800), source: event.source || 'vscode-hook' };
    this.appendObservation(task, observation);
    if (event.kind === 'UserPromptSubmit' || !['needs_input', 'result_ready'].includes(task.state)) task.state = event.kind === 'Stop' ? 'agent_stopped' : 'running';
    if (['needs_input', 'result_ready'].includes(event.kind)) task.state = event.kind;
    if (event.kind === 'result_ready') task.result = observation.summary;
    this.save();
    const shouldNotify = event.kind === 'needs_input' ? this.state.settings.notifyNeedsInput : event.kind === 'result_ready' && this.state.settings.notifyCompleted;
    if (shouldNotify) this.publishNotification(task, observation.summary);
    return true;
  }
}