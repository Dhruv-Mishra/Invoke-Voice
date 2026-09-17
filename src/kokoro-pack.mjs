import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REQUIRED_PACKAGES = new Map([
  ['torch', version => version === '2.8.0+cpu'],
  ['kokoro', version => version === '0.9.4'],
  ['spacy', version => /^3\.8\./.test(version)],
  ['en-core-web-sm', version => version === '3.8.0'],
  ['soundfile', version => version === '0.13.1'],
]);

function normalizedName(value) {
  return value.toLowerCase().replace(/[_.]+/g, '-');
}

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyKokoroPack(packDir) {
  if (!packDir || !existsSync(packDir)) return null;
  try {
    packDir = path.resolve(packDir);
    const manifestPath = path.join(packDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.python !== '3.12' || manifest.abi !== 'cp312') return null;
    if (!manifest.lock || !Array.isArray(manifest.wheels) || manifest.wheels.length === 0) return null;

    const wheelhouse = path.join(packDir, 'wheelhouse');
    const lockFile = path.join(packDir, manifest.lock.filename);
    if (path.dirname(lockFile) !== path.resolve(packDir) || !statSync(lockFile).isFile()) return null;
    const lockStat = statSync(lockFile);
    if (lockStat.size !== manifest.lock.size || await fileHash(lockFile) !== manifest.lock.sha256) return null;
    const locked = new Map();
    for (const line of readFileSync(lockFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const match = /^([a-z\d_.-]+)==([^\s]+) --hash=sha256:([a-f\d]{64})$/i.exec(line);
      if (!match) return null;
      const name = normalizedName(match[1]);
      if (locked.has(name)) return null;
      locked.set(name, { version: match[2], sha256: match[3].toLowerCase() });
    }

    const entries = readdirSync(wheelhouse, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || !entry.name.toLowerCase().endsWith('.whl'))) return null;
    const actualFiles = entries.map(entry => entry.name).sort();
    const declaredFiles = manifest.wheels.map(wheel => wheel.filename).sort();
    if (locked.size !== manifest.wheels.length || JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) return null;

    const found = new Map();
    for (const wheel of manifest.wheels) {
      if (!wheel || typeof wheel.name !== 'string' || typeof wheel.version !== 'string' || path.basename(wheel.filename) !== wheel.filename || !wheel.filename.toLowerCase().endsWith('.whl')) return null;
      const file = path.join(wheelhouse, wheel.filename);
      const stat = statSync(file);
      if (!stat.isFile() || stat.size !== wheel.size || await fileHash(file) !== wheel.sha256) return null;
      const name = normalizedName(wheel.name);
      const lock = locked.get(name);
      if (!lock || lock.version !== wheel.version || lock.sha256 !== wheel.sha256.toLowerCase()) return null;
      found.set(name, wheel.version);
    }
    for (const [name, accepts] of REQUIRED_PACKAGES) {
      if (!accepts(found.get(name) || '')) return null;
    }
    return { packDir, wheelhouse, lockFile, manifest };
  } catch {
    return null;
  }
}
