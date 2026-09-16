import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { parseStartupArgs } from '../scripts/start.mjs';
import { startSupervisor } from '../src/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('parseStartupArgs supports intuitive debug, release, local, and port flags', () => {
  // Defaults
  const def = parseStartupArgs([], {});
  assert.equal(def.mode, 'release');
  assert.equal(def.isDebug, false);
  assert.equal(def.isRelease, true);
  assert.equal(def.isLocal, false);
  assert.equal(def.isCheck, false);
  assert.equal(def.port, 4317);

  // User's npm start -debug example (npm config environment variable)
  const npmDebug = parseStartupArgs([], { npm_config_debug: 'true' });
  assert.equal(npmDebug.mode, 'debug');
  assert.equal(npmDebug.isDebug, true);

  // Command-line debug flags
  for (const flag of ['-debug', '--debug', 'debug', '-d']) {
    const parsed = parseStartupArgs([flag], {});
    assert.equal(parsed.mode, 'debug', `flag ${flag} should trigger debug mode`);
    assert.equal(parsed.isDebug, true);
  }

  // Environment debug flags
  assert.equal(parseStartupArgs([], { DEBUG: '1' }).mode, 'debug');
  assert.equal(parseStartupArgs([], { SUPERVISOR_DEBUG: '1' }).mode, 'debug');
  assert.equal(parseStartupArgs([], { SUPERVISOR_MODE: 'debug' }).mode, 'debug');
  assert.equal(parseStartupArgs([], { NODE_ENV: 'development' }).mode, 'debug');

  // Command-line release flags
  for (const flag of ['-release', '--release', 'release', '-r']) {
    const parsed = parseStartupArgs([flag], {});
    assert.equal(parsed.mode, 'release', `flag ${flag} should trigger release mode`);
    assert.equal(parsed.isRelease, true);
  }

  // Explicit release flag overrides ambient debug env
  assert.equal(parseStartupArgs(['--release'], { DEBUG: '1' }).mode, 'release');
  assert.equal(parseStartupArgs(['-release'], { npm_config_debug: 'true' }).mode, 'release');

  // Local voice flags
  for (const flag of ['-local', '--local', 'local', '-l']) {
    const parsed = parseStartupArgs([flag], {});
    assert.equal(parsed.isLocal, true, `flag ${flag} should trigger local mode`);
  }
  assert.equal(parseStartupArgs([], { npm_config_local: 'true' }).isLocal, true);
  assert.equal(parseStartupArgs([], { SUPERVISOR_LOCAL: '1' }).isLocal, true);

  // Local check flags
  for (const flag of ['-check', '--check', 'check']) {
    const parsed = parseStartupArgs([flag], {});
    assert.equal(parsed.isCheck, true, `flag ${flag} should trigger check mode`);
  }
  assert.equal(parseStartupArgs([], { npm_config_check: 'true' }).isCheck, true);

  // Port parsing
  assert.equal(parseStartupArgs(['--port', '5050'], {}).port, 5050);
  assert.equal(parseStartupArgs(['-port', '5051'], {}).port, 5051);
  assert.equal(parseStartupArgs(['-p', '5052'], {}).port, 5052);
  assert.equal(parseStartupArgs(['--port=5053'], {}).port, 5053);
  assert.equal(parseStartupArgs([], { PORT: '5054' }).port, 5054);

  // Combined debug and local flags
  const combined = parseStartupArgs(['-debug', '-local', '--port', '4900'], {});
  assert.equal(combined.mode, 'debug');
  assert.equal(combined.isLocal, true);
  assert.equal(combined.port, 4900);
});

test('release mode serves built frontend assets with accurate MIME types and owns lifecycle', async () => {
  const supervisor = await startSupervisor({ port: 0, mode: 'release', prewarm: false });
  assert.ok(supervisor.port > 0);
  const baseUrl = supervisor.url;

  try {
    // Root HTML
    const indexRes = await fetch(`${baseUrl}/`);
    assert.equal(indexRes.status, 200);
    assert.ok(indexRes.headers.get('content-type')?.includes('text/html'));
    const indexHtml = await indexRes.text();
    assert.ok(indexHtml.includes('<title>Voice Work Supervisor</title>'));

    // Capture worklet from public dir
    const workletRes = await fetch(`${baseUrl}/capture-worklet.js`);
    assert.equal(workletRes.status, 200);
    assert.ok(workletRes.headers.get('content-type')?.includes('text/javascript'));

    // Discover built assets in dist/assets
    const assetsDir = path.join(root, 'dist', 'assets');
    const assetFiles = readdirSync(assetsDir);
    const cssFile = assetFiles.find(f => f.endsWith('.css'));
    const jsFile = assetFiles.find(f => f.endsWith('.js'));
    const webpFile = assetFiles.find(f => f.endsWith('.webp'));

    if (cssFile) {
      const cssRes = await fetch(`${baseUrl}/assets/${cssFile}`);
      assert.equal(cssRes.status, 200);
      assert.ok(cssRes.headers.get('content-type')?.includes('text/css'));
    }

    if (jsFile) {
      const jsRes = await fetch(`${baseUrl}/assets/${jsFile}`);
      assert.equal(jsRes.status, 200);
      assert.ok(jsRes.headers.get('content-type')?.includes('text/javascript'));
    }

    if (webpFile) {
      const webpRes = await fetch(`${baseUrl}/assets/${webpFile}`);
      assert.equal(webpRes.status, 200);
      assert.ok(webpRes.headers.get('content-type')?.includes('image/webp'));
    }

    // Backend API endpoints
    const configRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(configRes.status, 200);
    assert.ok(configRes.headers.get('content-type')?.includes('application/json'));
    const configData = await configRes.json();
    assert.ok(configData.providers);

    // Unmatched API endpoint returns 404 JSON
    const notFoundApi = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(notFoundApi.status, 404);
    assert.deepEqual(await notFoundApi.json(), { error: 'Not found' });

    // Path traversal is blocked
    const traversal = await fetch(`${baseUrl}/..%2fpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await supervisor.close();
  }
});

test('debug mode mounts Vite middleware on the exact backend server, preventing routing drift', async () => {
  const supervisor = await startSupervisor({ port: 0, mode: 'debug', prewarm: false });
  assert.ok(supervisor.port > 0);
  assert.ok(supervisor.viteDevServer, 'Vite dev server should be instantiated in debug mode');
  const baseUrl = supervisor.url;

  try {
    // In debug mode, GET / transforms index.html and injects Vite HMR client
    const indexRes = await fetch(`${baseUrl}/`);
    assert.equal(indexRes.status, 200);
    assert.ok(indexRes.headers.get('content-type')?.includes('text/html'));
    const indexHtml = await indexRes.text();
    assert.ok(indexHtml.includes('/@vite/client'), 'Debug HTML must include Vite client script');
    assert.ok(indexHtml.includes('<title>Voice Work Supervisor</title>'));

    // Direct module serving from source
    const mainRes = await fetch(`${baseUrl}/main.js`);
    assert.equal(mainRes.status, 200);
    assert.ok(mainRes.headers.get('content-type')?.includes('text/javascript'));

    // Static image serving through Vite
    const iconRes = await fetch(`${baseUrl}/copilot-icon.webp`);
    assert.equal(iconRes.status, 200);
    assert.ok(iconRes.headers.get('content-type')?.includes('image/webp'));

    // Backend API is served directly on the same origin/port without proxy drift
    const configRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(configRes.status, 200);
    const configData = await configRes.json();
    assert.ok(configData.providers);

    // WebSocket /voice connects directly to backend on the same server
    const ws = new WebSocket(`ws://127.0.0.1:${supervisor.port}/voice`);
    const connected = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 5000);
      ws.once('open', () => {
        clearTimeout(timeout);
        resolve(true);
      });
      ws.once('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    assert.equal(connected, true);
    ws.close();
  } finally {
    await supervisor.close();
  }
});
