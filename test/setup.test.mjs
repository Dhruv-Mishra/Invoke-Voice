import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createSetup } from '../src/setup.mjs';
import { ASSETS, assetReady, ensureAsset, stackPaths, trustedDownloadUrl, withSetupLock } from '../scripts/models.mjs';
import { createLocalSetup, isolatedEnvironment, runSetupCommand } from '../src/local-setup.mjs';
import { startSupervisor } from '../src/server.mjs';

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-setup-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, paths: stackPaths({ LOCALAPPDATA: directory }, path.join(directory, 'app')) };
}

function controller(options = {}) {
  return createSetup({ platform: 'win32', arch: 'x64', cacheDir: 'cache', runtimeDir: 'runtime', inspect: () => [{ id: 'fixture', label: 'Fixture', ready: false, sourceUrl: 'https://huggingface.co' }], install: async () => {}, activate: async () => {}, ...options });
}

function localFixture(context, options = {}) {
  const { env: envOverrides = {}, ...setupOptions } = options;
  const { directory } = fixture(context);
  const commands = [];
  const children = [];
  const env = { SUPERVISOR_CACHE_DIR: directory, ...envOverrides };
  const paths = stackPaths(env);
  const setup = createLocalSetup({
    env,
    provision: async (paths, asset) => {
      if (asset.id !== 'uv') paths[asset.id] = path.join(directory, asset.id);
      mkdirSync(path.dirname(paths[asset.id]), { recursive: true });
      writeFileSync(paths[asset.id], 'fixture');
    },
    run: async (executable, args, options) => {
      commands.push({ executable, args, options });
      if (args.includes('venv')) {
        mkdirSync(path.dirname(paths.python), { recursive: true });
        writeFileSync(paths.python, 'fixture Python');
      }
    },
    activateLLM: async () => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, killed: false, kill() { this.killed = true; } });
      children.push(child);
      return { llama: child };
    },
    warm: async () => true,
    ...setupOptions,
  });
  context.after(() => setup.close());
  return { setup, paths, commands, children, env };
}

const windowsSetup = { skip: process.platform !== 'win32' || process.arch !== 'x64' };

test('local setup uses the private pip recipe with only pinned docopt allowed from source', windowsSetup, async context => {
  const { setup, paths, commands } = localFixture(context);
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const installs = commands.filter(command => command.args[1] === 'pip' && command.args[2] === 'install');
  assert.equal(installs.length, 2);
  assert.deepEqual(installs[0].args, ['--no-config', 'pip', 'install', '--python', paths.python, '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.8.0']);
  assert.deepEqual(installs[1].args, ['--no-config', 'pip', 'install', '--python', paths.python, '--index-url', 'https://pypi.org/simple', '--only-binary', ':all:', '--no-binary', 'docopt', 'docopt==0.6.2', '-r', fileURLToPath(new URL('../requirements-local.txt', import.meta.url)), 'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl']);
  for (const command of installs) {
    assert.equal(command.executable, paths.uv);
    assert.equal(command.options.cwd, paths.home);
    assert.equal(command.options.env.PYTHONNOUSERSITE, '1');
  }
});

test('llama exit during speech warmup fails readiness and permits a cached retry', windowsSetup, async context => {
  let release;
  let entered;
  let warmups = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const warming = new Promise(resolve => { entered = resolve; });
  const { setup, commands, children } = localFixture(context, { warm: async () => {
    if (++warmups === 1) { entered(); await gate; }
    return true;
  } });
  setup.start({ consent: true });
  try {
    await warming;
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    assert.equal(setup.snapshot().status, 'error', 'runtime is monitored while warmup is pending');
  } finally { release(); }
  const failed = await setup.settled();
  assert.equal(failed.status, 'error');
  assert.match(failed.message, /llama\.cpp/);
  const installedCommands = commands.length;
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(children.length, 2);
  assert.equal(warmups, 2);
  assert.equal(commands.length, installedCommands, 'verified Python environment is not reinstalled');
  children[1].signalCode = 'SIGTERM';
  children[1].emit('exit', null, 'SIGTERM');
  assert.equal(setup.snapshot().status, 'error', 'ready is invalidated when the runtime dies');
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(children.length, 3);
});

test('llama exitCode and signalCode are checked even without an observed exit event', windowsSetup, async context => {
  for (const phase of ['before warmup', 'after warmup']) {
    for (const status of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }]) {
      await context.test(`${phase}: ${JSON.stringify(status)}`, async context => {
        let warmups = 0;
        const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} });
        if (phase === 'before warmup') Object.assign(child, status);
        const { setup } = localFixture(context, {
          activateLLM: async () => ({ llama: child }),
          warm: async () => { warmups += 1; Object.assign(child, status); return true; },
        });
        setup.start({ consent: true });
        const failed = await setup.settled();
        assert.equal(failed.status, 'error');
        assert.match(failed.message, /llama\.cpp/);
        assert.equal(warmups, phase === 'before warmup' ? 0 : 1);
      });
    }
  }
});

test('a speech warmup failure keeps the validated chat runtime alive and retry reuses it', windowsSetup, async context => {
  let warmups = 0;
  const { setup, children } = localFixture(context, { warm: async () => {
    if (++warmups === 1) throw new Error('Kokoro fixture failure');
    return true;
  } });
  setup.start({ consent: true });
  const failed = await setup.settled();
  assert.equal(failed.status, 'error');
  assert.equal(children[0].killed, false, 'validated owned llama runtime is kept alive');
  assert.equal(failed.capabilities.chat.ready, true, 'chat capability remains ready');
  assert.equal(failed.capabilities.voice.ready, false, 'voice capability is not ready');
  assert.ok(typeof failed.capabilities.chat.message === 'string' && failed.capabilities.chat.message.length > 0);
  assert.ok(typeof failed.capabilities.voice.message === 'string' && failed.capabilities.voice.message.length > 0);

  // Retry reuses downloaded and validated chat runtime without creating a new child:
  setup.start({ consent: true });
  const ready = await setup.settled();
  assert.equal(ready.status, 'ready');
  assert.equal(children.length, 1, 'reused the existing validated llama runtime');
  assert.equal(ready.capabilities.chat.ready, true);
  assert.equal(ready.capabilities.voice.ready, true);

  // If the active runtime later exits, ready is invalidated:
  children[0].signalCode = 'SIGTERM';
  children[0].emit('exit', null, 'SIGTERM');
  const stopped = setup.snapshot();
  assert.equal(stopped.status, 'error');
  assert.equal(stopped.capabilities.chat.ready, false);
  assert.equal(stopped.capabilities.voice.ready, false);
});

test('a replacement runtime is started after exit and late exit from dead runtime cannot invalidate it', windowsSetup, async context => {
  let warmups = 0;
  const { setup, children } = localFixture(context, { warm: async () => {
    if (++warmups === 1) throw new Error('Kokoro fixture failure');
    return true;
  } });
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'error');
  // Explicitly simulate dead first child:
  children[0].exitCode = 1;
  children[0].emit('exit', 1, null);
  assert.equal(setup.snapshot().capabilities.chat.ready, false);

  // Retry starts replacement child:
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(children.length, 2);
  // Late exit emitted on old dead child cannot invalidate active replacement runtime:
  children[0].emit('exit', null, 'SIGTERM');
  assert.equal(setup.snapshot().status, 'ready');
});

test('Kokoro install failure keeps validated chat runtime alive with chat ready and voice unready', windowsSetup, async context => {
  let attempts = 0;
  const { setup, paths, children } = localFixture(context, {
    run: async (executable, args, options) => {
      if (args.includes('venv')) {
        mkdirSync(path.dirname(paths.python), { recursive: true });
        writeFileSync(paths.python, 'fixture Python');
      }
      if (args.includes('pip') && args.includes('install') && ++attempts === 1) {
        throw new Error('pip installation failed: network error');
      }
    },
  });
  setup.start({ consent: true });
  const failed = await setup.settled();
  assert.equal(failed.status, 'error');
  assert.equal(children.length, 1, 'chat was activated before Kokoro install');
  assert.equal(children[0].killed, false, 'owned llama runtime kept alive');
  assert.equal(failed.capabilities.chat.ready, true, 'chat is ready');
  assert.equal(failed.capabilities.voice.ready, false, 'voice is not ready');
  assert.match(failed.capabilities.voice.message, /pip installation failed/);

  // Retry reuses validated chat runtime:
  setup.start({ consent: true });
  const ready = await setup.settled();
  assert.equal(ready.status, 'ready');
  assert.equal(children.length, 1, 'reused chat runtime on retry');
  assert.equal(ready.capabilities.chat.ready, true);
  assert.equal(ready.capabilities.voice.ready, true);
});

test('LOCAL_LLM_URL is only published after healthy startup and cleaned up on failure', windowsSetup, async context => {
  const { directory } = fixture(context);
  const env = { SUPERVISOR_CACHE_DIR: directory };

  // When startup fails, no stale URL is left:
  const failingSetup = createLocalSetup({
    env,
    provision: async () => {},
    activateLLM: async () => { throw new Error('startup failed'); },
  });
  failingSetup.start({ consent: true });
  const failed = await failingSetup.settled();
  assert.equal(failed.status, 'error');
  assert.equal(env.LOCAL_LLM_URL, undefined, 'no stale URL left after failed startup');

  // When external URL was pre-configured, it is preserved:
  env.LOCAL_LLM_URL = 'http://127.0.0.1:9999/v1';
  const externalSetup = createLocalSetup({
    env,
    provision: async () => {},
    activateLLM: async () => { throw new Error('startup failed'); },
  });
  externalSetup.start({ consent: true });
  await externalSetup.settled();
  assert.equal(env.LOCAL_LLM_URL, 'http://127.0.0.1:9999/v1', 'pre-existing external URL is preserved');
  delete env.LOCAL_LLM_URL;

  // When startup succeeds, URL is published:
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} });
  const succeedingSetup = createLocalSetup({
    env,
    provision: async () => {},
    run: async () => {},
    activateLLM: async () => ({ llama: child, url: 'http://127.0.0.1:4567/v1' }),
    warm: async () => true,
  });
  succeedingSetup.start({ consent: true });
  await succeedingSetup.settled();
  assert.equal(env.LOCAL_LLM_URL, 'http://127.0.0.1:4567/v1', 'URL is published after healthy startup');

  // When owned child exits, URL is removed:
  child.signalCode = 'SIGTERM';
  child.emit('exit', null, 'SIGTERM');
  assert.equal(env.LOCAL_LLM_URL, undefined, 'URL cleaned up when owned runtime dies');
});

test('setup command failures retain bounded sanitized stream tails only in the local log', async context => {
  const { directory } = fixture(context);
  const secret = 'fixture-env-secret-7391';
  const script = `
    process.stdout.write('old stdout\\n' + 'stdout progress\\n'.repeat(10000));
    process.stderr.write('old stderr\\n' + 'stderr progress\\n'.repeat(10000));
    process.stdout.write('OPENAI_API_KEY=' + 'fixture-oversized'.repeat(1000) + '\\n');
    process.stdout.write('stdout diagnostic: dependency resolution failed\\n');
    process.stdout.write('https://fixture-user:fixture-pass@example.test/packages?sig=fixture-query#fixture-fragment\\n');
    process.stdout.write('bare value: fixture-env-');
    setImmediate(() => {
      process.stdout.write('secret-7391\\n');
      process.stderr.write('OPENAI_API_KEY="fixture-assignment"\\nAuthorization: Bearer fixture-auth\\n');
      process.stderr.write('stderr diagnostic: docopt build failed\\n');
      process.exitCode = 7;
    });
  `;
  const setup = controller({ install: ({ report, signal }) => runSetupCommand(process.execPath, ['-e', script], {
    env: isolatedEnvironment(process.env, stackPaths({ SUPERVISOR_CACHE_DIR: directory })),
    redactEnv: { HF_TOKEN: secret }, cwd: directory, report, signal, stage: 'kokoro', message: 'Installing speech dependencies.',
  }) });
  setup.start({ consent: true });
  const failed = await setup.settled();
  assert.equal(failed.status, 'error');
  assert.match(failed.message, /code 7/);
  assert.match(failed.message, /logs\/local-setup\.log/);
  assert.doesNotMatch(JSON.stringify(failed), /stdout diagnostic|stderr diagnostic|fixture-|docopt build failed/);
  const logFile = path.join(directory, 'logs', 'local-setup.log');
  const output = readFileSync(logFile, 'utf8');
  assert.ok(Buffer.byteLength(output) <= 64 * 1024);
  assert.match(output, /stdout diagnostic: dependency resolution failed/);
  assert.match(output, /stderr diagnostic: docopt build failed/);
  assert.match(output, /https:\/\/example\.test\/packages/);
  assert.match(output, /\[REDACTED/);
  assert.doesNotMatch(output, /old stdout|old stderr|fixture-(?:user|pass|query|fragment|env|assignment|auth|oversized)/);
  await runSetupCommand(process.execPath, ['-e', 'process.stdout.write("retry completed\\n")'], { cwd: directory, stage: 'kokoro', message: 'Retrying speech dependencies.' });
  const retried = readFileSync(logFile, 'utf8');
  assert.match(retried, /retry completed/);
  assert.doesNotMatch(retried, /docopt build failed/);
});

test('setup launch failures and unwritable logs remain actionable without leaking subprocess details', async context => {
  const { directory } = fixture(context);
  const options = { cwd: directory, stage: 'python', message: 'Checking Python.' };
  await assert.rejects(runSetupCommand(path.join(directory, 'missing-runtime'), [], options), /Could not run.*logs\/local-setup\.log/);
  const logFile = path.join(directory, 'logs', 'local-setup.log');
  assert.match(readFileSync(logFile, 'utf8'), /Could not run/);
  rmSync(logFile);
  mkdirSync(logFile);
  await assert.rejects(runSetupCommand(process.execPath, ['-e', 'process.stderr.write("raw-private-output"); process.exitCode = 2;'], options), error => {
    assert.match(error.setupMessage, /code 2/);
    assert.match(error.setupMessage, /log could not be written/);
    assert.doesNotMatch(error.setupMessage, /raw-private-output/);
    return true;
  });
});

test('setup requires exact consent and serializes asynchronous starts', async () => {
  let installs = 0;
  let activations = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const setup = controller({ install: async () => { installs += 1; await gate; }, activate: async () => { activations += 1; } });
  assert.equal(setup.snapshot().status, 'idle');
  assert.equal(setup.snapshot().capabilities.chat.ready, false);
  assert.equal(setup.snapshot().capabilities.voice.ready, false);
  for (const input of [undefined, null, {}, { consent: false }, { consent: 'true' }, { consent: true, url: 'https://evil.test' }, { consent: true, command: 'anything' }, { consent: true, path: 'C:\\' }]) assert.throws(() => setup.start(input), /consent/);
  assert.equal(installs, 0);
  assert.equal(setup.start({ consent: true }).status, 'running');
  assert.equal(setup.start({ consent: true }).status, 'running');
  assert.equal(installs, 0, 'POST returns before installer starts');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installs, 1);
  release();
  const settled = await setup.settled();
  assert.equal(settled.status, 'ready');
  assert.equal(settled.capabilities.chat.ready, true);
  assert.equal(settled.capabilities.voice.ready, true);
  assert.equal(activations, 1);
  setup.start({ consent: true });
  assert.equal(installs, 1);
});

test('failed setup redacts raw errors and permits a real retry; offline resume never installs', async () => {
  let attempts = 0;
  const setup = controller({ install: async () => { if (++attempts === 1) throw new Error('secret-token and arbitrary subprocess output'); } });
  setup.start({ consent: true });
  const failure = await setup.settled();
  assert.equal(failure.status, 'error');
  assert.doesNotMatch(JSON.stringify(failure), /secret-token/);
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(attempts, 2);
  const offline = controller({ install: async () => assert.fail('resume must not install') });
  offline.resume();
  assert.equal((await offline.settled()).status, 'ready');
  const unsupported = controller({ platform: 'linux' });
  assert.equal(unsupported.snapshot().supported, false);
  assert.throws(() => unsupported.start({ consent: true }), /Windows x64/);
});

test('completed verified assets are reused offline; partial and corrupted downloads are never ready', async context => {
  const { paths } = fixture(context);
  const asset = ASSETS.find(candidate => candidate.id === 'tokenizer');
  const content = Buffer.from('local deterministic tokenizer fixture');
  const digest = createHash('sha256').update(content).digest('hex');
  const metadata = [{ path: asset.name, size: content.length, lfs: { oid: digest } }];
  let calls = 0;
  const fetchImpl = async url => { calls += 1; return url.includes('/api/models/') ? Response.json(metadata) : new Response(content); };
  mkdirSync(paths.modelDir, { recursive: true });
  writeFileSync(`${paths.tokenizer}.partial`, content);
  assert.equal(assetReady(paths, asset), false);
  const progress = [];
  await ensureAsset(paths, asset, { fetchImpl, report: event => progress.push(event) });
  assert.equal(calls, 2);
  assert.equal(assetReady(paths, asset), true);
  assert.ok(progress.some(event => event.progress?.received === content.length));
  await ensureAsset(paths, asset, { fetchImpl: async () => assert.fail('offline reuse must not perform even a HEAD request') });
  utimesSync(paths.tokenizer, new Date(0), new Date(0));
  assert.equal(assetReady(paths, asset), false);
  await ensureAsset(paths, asset, { fetchImpl: async () => assert.fail('a changed timestamp must be reverified offline using the recorded digest') });
  assert.equal(assetReady(paths, asset), true);
  writeFileSync(paths.tokenizer, 'truncated');
  assert.equal(assetReady(paths, asset), false);
  await assert.rejects(ensureAsset(paths, asset, { fetchImpl: async url => url.includes('/api/models/') ? Response.json(metadata) : new Response('bad') }), /integrity/);
  assert.equal(existsSync(`${paths.tokenizer}.partial`), false);
  assert.equal(assetReady(paths, asset), false);
  await ensureAsset(paths, asset, { fetchImpl });
  assert.equal(assetReady(paths, asset), true);
});

function runtimeArchive(context, entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const { name, body = '', mode = 0o100644, directory = false, size, compressed } of entries) {
    const filename = Buffer.from(name);
    const content = Buffer.from(body);
    const data = compressed ?? deflateRawSync(content);
    let checksum = 0xffffffff;
    for (const byte of content) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE((checksum ^ 0xffffffff) >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size ?? content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x314, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(((mode << 16) | (directory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localRecords.push(local, filename, data);
    centralRecords.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralRecords.reduce((total, record) => total + record.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  const content = Buffer.concat([...localRecords, ...centralRecords, end]);
  const asset = ASSETS.find(candidate => candidate.id === 'uv');
  const original = { size: asset.size, sha256: asset.sha256 };
  context.after(() => Object.assign(asset, original));
  Object.assign(asset, { size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  return { asset, content, fetchImpl: async url => { assert.equal(url, asset.sourceUrl); return new Response(content); } };
}

test('runtime archives extract root and nested executables with directories and verified offline reuse', async context => {
  for (const prefix of ['', 'release/']) {
    await context.test(prefix || 'root', async context => {
      const { paths } = fixture(context);
      const { asset, fetchImpl } = runtimeArchive(context, [
        { name: `${prefix}uv.exe`, body: 'fixture executable', mode: 0o100755 },
        { name: `${prefix}lib/helper.dll`, body: 'fixture library' },
        { name: `${prefix}lib/`, mode: 0o040755 },
        { name: `${prefix}empty/`, mode: 0o040755 },
        { name: `${prefix}windows/`, mode: 0, directory: true },
      ]);
      const destination = await ensureAsset(paths, asset, { fetchImpl });
      assert.equal(destination, path.join(paths.runtimeDir, 'uv', 'uv.exe'));
      assert.equal(readFileSync(destination, 'utf8'), 'fixture executable');
      assert.equal(readFileSync(path.join(path.dirname(destination), 'lib', 'helper.dll'), 'utf8'), 'fixture library');
      assert.deepEqual(readdirSync(path.join(path.dirname(destination), 'empty')), []);
      assert.deepEqual(readdirSync(path.join(path.dirname(destination), 'windows')), []);
      assert.equal(assetReady(paths, asset), true);
      const offline = { fetchImpl: async () => assert.fail('verified archive and receipts must be reused offline') };
      assert.equal(await ensureAsset(paths, asset, offline), destination);
      writeFileSync(destination, 'corrupted executable');
      assert.equal(assetReady(paths, asset), false);
      assert.equal(await ensureAsset(paths, asset, offline), destination);
      assert.equal(readFileSync(destination, 'utf8'), 'fixture executable');
      assert.equal(assetReady(paths, asset), true);
      assert.equal(readdirSync(paths.runtimeDir).some(name => name.startsWith('uv.partial-')), false);
    });
  }
});

test('runtime archives reject unsafe paths without changing the runtime or writing outside staging', async context => {
  const names = ['../outside/pwned.exe', 'safe/../../outside/pwned.exe', '..\\outside\\pwned.exe', 'C:relative.exe', 'uv.exe:payload', 'nested/uv.exe:payload', './uv.exe', 'nested/../uv.exe', 'trailing./uv.exe', 'NUL', 'bad\0name.exe', 'absolute', 'drive', 'unc'];
  for (const name of names) {
    await context.test(name.replace(/\0/g, '(NUL)'), async context => {
      const { paths } = fixture(context);
      const outside = path.join(paths.runtimeDir, 'outside');
      const escaped = path.join(outside, 'pwned.exe');
      const absolute = escaped.replace(/\\/g, '/');
      const filename = name === 'absolute' ? `/${absolute.replace(/^[A-Za-z]:\//, '')}` : name === 'drive' ? (path.win32.isAbsolute(escaped) ? escaped.replace(/\\/g, '/') : `C:${absolute}`) : name === 'unc' ? `//localhost/${absolute.replace(/^([A-Za-z]):\//, '$1$/')}` : name;
      const { asset, fetchImpl } = runtimeArchive(context, [{ name: 'uv.exe', body: 'replacement' }, { name: filename, body: 'escape' }]);
      mkdirSync(path.dirname(paths.uv), { recursive: true });
      mkdirSync(outside);
      writeFileSync(paths.uv, 'existing runtime');
      await assert.rejects(ensureAsset(paths, asset, { fetchImpl }), /unsafe path|invalid characters|invalid relative path|absolute path/i);
      assert.equal(readFileSync(paths.uv, 'utf8'), 'existing runtime');
      assert.deepEqual(readdirSync(outside), []);
      assert.equal(existsSync(escaped), false);
      assert.equal(assetReady(paths, asset), false);
      assert.equal(existsSync(paths.receiptDir), false);
      assert.equal(readdirSync(paths.runtimeDir).some(entry => entry.startsWith('uv.partial-')), false);
    });
  }
});

test('runtime archives reject symlinks and special types before a following entry can write through them', async context => {
  for (const mode of [0o120777, 0o010644, 0o020644, 0o060644, 0o140644]) {
    await context.test(mode.toString(8), async context => {
      const { paths } = fixture(context);
      const outside = path.join(paths.runtimeDir, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
      const { asset, fetchImpl } = runtimeArchive(context, [
        { name: 'escape', body: '../outside', mode },
        { name: 'escape/pwned.exe', body: 'escape' },
        { name: 'uv.exe', body: 'fixture executable' },
      ]);
      await assert.rejects(ensureAsset(paths, asset, { fetchImpl }), /symbolic links or special file types/);
      assert.deepEqual(readdirSync(outside), ['sentinel']);
      assert.equal(readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
      assert.equal(existsSync(paths.uv), false);
      assert.equal(existsSync(paths.receiptDir), false);
      assert.equal(readdirSync(paths.runtimeDir).some(name => name.startsWith('uv.partial-')), false);
    });
  }
});

test('runtime archives bound extraction and clean up parser, stream and write failures', async context => {
  const cases = [
    { name: 'expanded size', entries: [{ name: 'uv.exe', size: 1024 ** 3 + 1 }], error: /size limit/ },
    { name: 'entry count', entries: Array.from({ length: 10001 }, (_, index) => ({ name: `directory-${index}/`, mode: 0o040755 })), error: /too many entries/ },
    { name: 'invalid deflate stream', entries: [{ name: 'uv.exe', body: 'runtime', compressed: Buffer.from([0x07]) }], error: /invalid|inflate/i },
    { name: 'size mismatch', entries: [{ name: 'uv.exe', body: 'runtime', size: 1 }], error: /size|byte/i },
    { name: 'duplicate file', entries: [{ name: 'uv.exe', body: 'first' }, { name: 'uv.exe', body: 'second' }], error: /EEXIST/ },
    { name: 'missing executable', entries: [{ name: 'other.exe', body: 'runtime' }], error: /missing its executable/ },
    { name: 'invalid central directory', entries: [{ name: 'uv.exe', body: 'runtime' }], corrupt: true, error: /central directory/i },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async context => {
      const { paths } = fixture(context);
      const { asset, content, fetchImpl } = runtimeArchive(context, scenario.entries);
      if (scenario.corrupt) {
        const centralOffset = content.readUInt32LE(content.length - 6);
        content.writeUInt32LE(0, centralOffset);
        asset.sha256 = createHash('sha256').update(content).digest('hex');
      }
      await assert.rejects(ensureAsset(paths, asset, { fetchImpl }), scenario.error);
      assert.equal(existsSync(paths.uv), false);
      assert.equal(existsSync(paths.receiptDir), false);
      assert.equal(readdirSync(paths.runtimeDir).some(name => name.startsWith('uv.partial-')), false);
      const archive = path.join(paths.runtimeDir, 'archives', asset.name);
      rmSync(archive);
      assert.equal(existsSync(archive), false, 'archive handle must be closed after failure');
    });
  }
});

test('configured local models are verified in place, and Q8 uses sibling or cached canonical Q4', async context => {
  const { directory } = fixture(context);
  const existing = path.join(directory, 'LocalVoiceStack', 'LLMs', ASSETS[0].name);
  mkdirSync(path.dirname(existing), { recursive: true });
  const content = Buffer.from('existing local GGUF fixture');
  writeFileSync(existing, content);
  const paths = stackPaths({ LOCALAPPDATA: directory, LOCAL_LLM_PATH: existing }, path.join(directory, 'app'));
  assert.equal(paths.ling, existing);
  await ensureAsset(paths, ASSETS[0], { fetchImpl: async url => {
    assert.ok(url.includes('/api/models/'), 'must not download an existing valid model');
    return Response.json([{ path: ASSETS[0].name, size: content.length, lfs: { oid: createHash('sha256').update(content).digest('hex') } }]);
  } });
  assert.deepEqual(readFileSync(existing), content);
  assert.equal(existsSync(path.join(paths.modelDir, ASSETS[0].name)), false);
  const q4 = path.join(paths.modelDir, ASSETS[1].name);
  mkdirSync(path.dirname(q4), { recursive: true });
  writeFileSync(q4, 'canonical Q4 fixture');
  const configured = stackPaths({ LOCALAPPDATA: directory, MOONSHINE_MODEL: path.join(directory, 'moonshine-streaming-small-Q8_0.gguf') }, path.join(directory, 'app'));
  assert.equal(configured.moonshine, q4);
});

test('setup networking and Python environment reject untrusted overrides', () => {
  for (const url of ['http://huggingface.co/model', 'https://huggingface.co.evil.test/model', 'file:///C:/test', 'https://user:pass@github.com/file', 'https://github.com:444/file']) assert.equal(trustedDownloadUrl(url), false);
  const paths = stackPaths({ LOCALAPPDATA: os.tmpdir() });
  const env = isolatedEnvironment({ PATH: 'system', HF_TOKEN: 'secret', OPENAI_API_KEY: 'secret', PYTHONPATH: 'injection', UV_INDEX_URL: 'https://evil.test' }, paths);
  assert.equal(env.PATH, 'system');
  assert.equal(env.HF_HUB_OFFLINE, '1');
  for (const key of ['HF_TOKEN', 'OPENAI_API_KEY', 'PYTHONPATH', 'UV_INDEX_URL']) assert.equal(env[key], undefined);
});

test('shared cache provisioning locks reject overlapping jobs and release after failure', async context => {
  const { paths } = fixture(context);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const first = withSetupLock(paths, () => { acquired(); return gate; });
  await ready;
  try { await assert.rejects(withSetupLock(paths, async () => {}), /Another app/); }
  finally { release(); await first; }
  await assert.rejects(withSetupLock(paths, async () => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(await withSetupLock(paths, async () => 'retry succeeded'), 'retry succeeded');
});

test('setup API is same-origin, consent-gated and returns 202 without waiting for completion', async context => {
  const { directory } = fixture(context);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let installs = 0;
  const setup = controller({ install: async () => { installs += 1; await gate; } });
  const app = await startSupervisor({ dataDir: directory, port: 0, mode: 'release', prewarm: false, setup });
  try {
    const initial = await fetch(`${app.url}/api/setup`);
    assert.equal(initial.status, 200);
    const initialJson = await initial.json();
    assert.equal(initialJson.status, 'idle');
    assert.equal(initialJson.capabilities.chat.ready, false);
    assert.equal(initialJson.capabilities.voice.ready, false);
    assert.equal(installs, 0);
    const post = body => fetch(`${app.url}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ consent: false })).status, 400);
    const foreign = await fetch(`${app.url}/api/setup`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{"consent":true}' });
    assert.equal(foreign.status, 403);
    assert.equal((await post({ consent: true })).status, 202);
    assert.equal((await post({ consent: true })).status, 202);
    assert.equal(installs, 1);
    release();
    await setup.settled();
    const readyJson = await (await fetch(`${app.url}/api/setup`)).json();
    assert.equal(readyJson.status, 'ready');
    assert.equal(readyJson.capabilities.chat.ready, true);
    assert.equal(readyJson.capabilities.voice.ready, true);
  } finally { release(); await app.close(); }
});

test('local setup accepts explicit HTTPS package mirrors and rejects insecure indexes', windowsSetup, async context => {
  const mirrored = localFixture(context, { env: {
    LOCAL_PYPI_INDEX_URL: 'https://packages.contoso.test/pypi/',
    LOCAL_TORCH_INDEX_URL: 'https://packages.contoso.test/torch/',
  } });
  mirrored.setup.start({ consent: true });
  assert.equal((await mirrored.setup.settled()).status, 'ready');
  const installs = mirrored.commands.filter(command => command.args[1] === 'pip' && command.args[2] === 'install');
  assert.equal(installs[0].args[6], 'https://packages.contoso.test/torch');
  assert.equal(installs[1].args[6], 'https://packages.contoso.test/pypi');

  const insecure = localFixture(context, { env: { LOCAL_PYPI_INDEX_URL: 'http://packages.example.test/simple' } });
  insecure.setup.start({ consent: true });
  const failed = await insecure.setup.settled();
  assert.equal(failed.capabilities.chat.ready, true);
  assert.equal(failed.capabilities.voice.ready, false);
  assert.match(failed.error, /Python package index must use HTTPS/);
});

test('cached chat resumes after restart when Kokoro installation was incomplete', windowsSetup, async context => {
  const fixtureSetup = localFixture(context, {
    run: async (executable, args, options) => {
      if (args.includes('venv')) {
        mkdirSync(path.dirname(fixtureSetup.paths.python), { recursive: true });
        writeFileSync(fixtureSetup.paths.python, 'fixture Python');
      }
      if (args.includes('pip')) throw new Error('Kokoro mirror unavailable');
    },
  });
  fixtureSetup.setup.start({ consent: true });
  const failed = await fixtureSetup.setup.settled();
  assert.equal(failed.capabilities.chat.ready, true);
  const completionFile = path.join(fixtureSetup.paths.home, 'local-setup.json');
  assert.equal(existsSync(completionFile), true);
  const completed = JSON.parse(readFileSync(completionFile, 'utf8'));
  mkdirSync(fixtureSetup.paths.receiptDir, { recursive: true });
  for (const asset of ASSETS.filter(candidate => ['ling', 'llama'].includes(candidate.id))) {
    const destination = completed.paths[asset.id];
    const stat = statSync(destination);
    const receipt = path.join(fixtureSetup.paths.receiptDir, `${asset.id}-${createHash('sha256').update(destination).digest('hex').slice(0, 20)}.json`);
    writeFileSync(receipt, JSON.stringify({ sourceUrl: asset.sourceUrl, files: [{ path: destination, size: stat.size, mtimeMs: stat.mtimeMs }] }));
  }
  await fixtureSetup.setup.close();
  for (const key of ['LOCAL_LLM_PATH', 'MOONSHINE_MODEL', 'LLAMA_SERVER_BIN', 'CRISPASR_BIN', 'VAD_MODEL', 'PYTHON_BIN']) delete fixtureSetup.env[key];

  let activations = 0;
  const restarted = createLocalSetup({
    env: fixtureSetup.env,
    provision: async () => { throw new Error('Offline resume must not download'); },
    activateLLM: async () => {
      activations++;
      return { llama: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} }) };
    },
    warm: async () => false,
  });
  context.after(() => restarted.close());
  restarted.resume();
  const resumed = await restarted.settled();
  assert.equal(activations, 1);
  assert.equal(resumed.capabilities.chat.ready, true);
  assert.equal(resumed.capabilities.voice.ready, false);
});