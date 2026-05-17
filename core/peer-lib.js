import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const FORBIDDEN_LEGACY_MACHINE_NAMES = new Set(['local-peer', 'remote-peer']);

const execFileAsync = promisify(execFile);

// Reused HTTPS agents keyed by TLS material fingerprint.
// This enables real keep-alive connection reuse across repeated machineRequest calls.
const _httpsAgentCache = new Map();

function _tlsFingerprint(cfg) {
  const parts = [cfg.tls.ca_cert, cfg.tls.cert, cfg.tls.key];
  const meta = [];
  for (const p of parts) {
    const st = fs.statSync(p);
    meta.push(`${p}:${st.size}:${st.mtimeMs}:${st.ino ?? 'na'}`);
  }
  return meta.join('|');
}

function _safeTlsFingerprint(cfg) {
  try {
    return _tlsFingerprint(cfg);
  } catch {
    return null;
  }
}

export function clearHttpsAgentCache(reason = 'manual') {
  let closed = 0;
  for (const agent of _httpsAgentCache.values()) {
    try {
      agent.destroy();
      closed += 1;
    } catch {
      // best effort
    }
  }
  _httpsAgentCache.clear();
  if (reason) {
    console.error(`[peer-lib] cleared HTTPS agent cache (${reason}), closed=${closed}`);
  }
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    deepFreeze(value);
  }
  return obj;
}

export function loadConfig(configPathArg) {
  const configPathInput = configPathArg || process.env.MACHINE_CONFIG || process.env.PEER_CONFIG;
  if (!configPathInput) {
    throw new Error('machine config path is required: pass a config path or set MACHINE_CONFIG');
  }
  const configPath = path.resolve(configPathInput);
  const projectRoot = path.resolve(path.dirname(configPath), '..');
  const repoLogDir = path.join(projectRoot, 'log');
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.__configPath = configPath;
  if (!cfg.machine_name && cfg.peer_name) cfg.machine_name = cfg.peer_name;
  if (!cfg.machines && cfg.peers) cfg.machines = cfg.peers;
  if (!cfg.allowed_machine_names && cfg.allowed_server_names) cfg.allowed_machine_names = cfg.allowed_server_names;
  validateConfigNoLegacy(cfg);
  cfg.workspace_dir = path.resolve(path.dirname(configPath), cfg.workspace_dir);
  cfg.state_dir = path.resolve(path.dirname(configPath), cfg.state_dir);
  cfg.job_dir = path.resolve(path.dirname(configPath), cfg.job_dir || './log/jobs');
  cfg.tls.ca_cert = path.resolve(path.dirname(configPath), cfg.tls.ca_cert);
  cfg.tls.cert = path.resolve(path.dirname(configPath), cfg.tls.cert);
  cfg.tls.key = path.resolve(path.dirname(configPath), cfg.tls.key);

  const repoLogPrefix = repoLogDir.endsWith(path.sep) ? repoLogDir : `${repoLogDir}${path.sep}`;
  if (cfg.workspace_dir === repoLogDir || cfg.workspace_dir.startsWith(repoLogPrefix)) {
    throw new Error(`workspace_dir must not live under repo log/: ${cfg.workspace_dir}`);
  }
  if (cfg.workspace_dir === cfg.state_dir || cfg.workspace_dir.startsWith(`${cfg.state_dir}${path.sep}`)) {
    throw new Error(`workspace_dir must not overlap state_dir: ${cfg.workspace_dir}`);
  }
  if (cfg.job_dir === cfg.state_dir || cfg.job_dir.startsWith(`${cfg.state_dir}${path.sep}`) || cfg.state_dir.startsWith(`${cfg.job_dir}${path.sep}`)) {
    throw new Error(`job_dir must not overlap state_dir: ${cfg.job_dir}`);
  }

  return deepFreeze(cfg);
}

export async function ensureDirs(cfg) {
  await fsp.mkdir(cfg.workspace_dir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(cfg.state_dir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(cfg.job_dir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(cfg.state_dir, 'messages'), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(cfg.state_dir, 'agent-chat'), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.dirname(cfg.tls.ca_cert), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.dirname(cfg.tls.cert), { recursive: true, mode: 0o700 });
}

export function genJobId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${ts}-${crypto.randomBytes(4).toString('hex')}`;
}

export function safeMachineName(peerName) {
  if (!/^[A-Za-z0-9._-]+$/.test(peerName || '')) {
    throw new Error(`invalid peer name: ${peerName}`);
  }
  return peerName;
}

export function assertNoLegacyMachineName(peerName, contextLabel = 'machine_name') {
  const safe = safeMachineName(peerName);
  if (FORBIDDEN_LEGACY_MACHINE_NAMES.has(safe)) {
    throw new Error(`${contextLabel} uses forbidden legacy id: ${safe}`);
  }
  return safe;
}

export function validateConfigNoLegacy(cfg) {
  assertNoLegacyMachineName(cfg.machine_name, 'machine_name');

  const allowed = Array.isArray(cfg.allowed_machine_names) ? cfg.allowed_machine_names : [];
  for (const peerId of allowed) {
    assertNoLegacyMachineName(peerId, 'allowed_machine_names');
  }

  for (const [peerId, peer] of Object.entries(cfg.machines || {})) {
    assertNoLegacyMachineName(peerId, `machines.${peerId}`);
    if (peer?.aliases != null) {
      throw new Error(`machines.${peerId}.aliases is forbidden`);
    }
    if (peer?.certificate_common_name != null) {
      throw new Error(`machines.${peerId}.certificate_common_name is forbidden`);
    }
    if (typeof peer?.server_name === 'string') {
      assertNoLegacyMachineName(peer.server_name, `machines.${peerId}.server_name`);
    }
  }
}

export function canonicalMachineName(cfg, peerId) {
  const safe = assertNoLegacyMachineName(peerId, 'machine_name');
  if (cfg.machines?.[safe]) return safe;
  throw new Error(`machine not configured: ${peerId}`);
}

export function identityAllowedForConfiguredPeer(cfg, configuredPeerId, identity) {
  const safeIdentity = assertNoLegacyMachineName(identity, 'machine identity');
  return configuredPeerId === safeIdentity && cfg.allowed_machine_names?.includes(safeIdentity);
}

export function canonicalMachineNameForIdentity(cfg, identity) {
  const safeIdentity = assertNoLegacyMachineName(identity, 'machine identity');
  if (cfg.machines?.[safeIdentity] && cfg.allowed_machine_names?.includes(safeIdentity)) return safeIdentity;
  throw new Error(`machine identity not allowed: ${identity}`);
}

export function safeRelativePath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('path is required');
  }
  if (path.isAbsolute(input)) {
    throw new Error('absolute paths are not allowed');
  }
  const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error('path escapes workspace');
  }
  return normalized;
}

export async function resolveInside(baseDir, relativeOrAbsolute) {
  const candidate = path.resolve(baseDir, relativeOrAbsolute);
  const realBase = await fsp.realpath(baseDir);
  let realCandidate;
  try {
    realCandidate = await fsp.realpath(candidate);
  } catch {
    realCandidate = path.resolve(candidate);
  }
  const baseWithSep = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`;
  if (realCandidate !== realBase && !realCandidate.startsWith(baseWithSep)) {
    throw new Error('resolved path escapes workspace');
  }
  return realCandidate;
}

export async function rejectSymlinks(rootDir) {
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`symlink not allowed in archive: ${path.relative(rootDir, full)}`);
      }
      if (entry.isDirectory()) {
        await walk(full);
      }
    }
  }
  await walk(rootDir);
}

export async function writeJson(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export async function readJson(filePath, fallback = null) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function getHttpsAgent(cfg, options = {}) {
  const { servername = '', forceNew = false } = options;
  const fp = _safeTlsFingerprint(cfg);
  const cacheKey = fp ? `${fp}|${servername}` : null;
  if (!forceNew && cacheKey) {
    const cached = _httpsAgentCache.get(cacheKey);
    if (cached) return cached;
  }

  const agent = new https.Agent({
    ca: fs.readFileSync(cfg.tls.ca_cert),
    cert: fs.readFileSync(cfg.tls.cert),
    key: fs.readFileSync(cfg.tls.key),
    keepAlive: true,
    maxSockets: 32,
    maxFreeSockets: 8,
    rejectUnauthorized: true,
  });

  if (cacheKey) {
    if (forceNew) {
      const old = _httpsAgentCache.get(cacheKey);
      if (old) {
        try { old.destroy(); } catch {}
      }
    }
    _httpsAgentCache.set(cacheKey, agent);
  }

  return agent;
}

export async function machineRequest(cfg, peerId, endpoint, payload) {
  const resolvedPeerId = canonicalMachineName(cfg, peerId);
  const peer = cfg.machines?.[resolvedPeerId];
  if (!peer) {
    throw new Error(`machine not configured: ${peerId}`);
  }
  const body = JSON.stringify(payload || {});
  const url = new URL(endpoint, peer.url.endsWith('/') ? peer.url : `${peer.url}/`);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-machine-id': cfg.machine_name,
  };
  return await new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers,
      agent: getHttpsAgent(cfg, { servername: peer.server_name }),
      servername: peer.server_name,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`peer request failed: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function runCommand(command, args, options = {}) {
  const { cwd, timeoutMs, env, maxBuffer = 10 * 1024 * 1024 } = options;
  return await execFileAsync(command, args, {
    cwd,
    timeout: timeoutMs,
    env,
    maxBuffer,
  });
}

export function contentText(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

const RESTART_REQUIRED_FIELDS = ['listen_host', 'listen_port', 'tls.ca_cert', 'tls.cert', 'tls.key'];

function getNestedField(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj);
}

export class ConfigStore {
  constructor(configPathArg, options = {}) {
    this._configPathArg = configPathArg;
    this._debounceMs = options.debounceMs ?? 300;
    this._component = options.component ?? 'config-store';
    this._current = loadConfig(configPathArg);
    this._rawHash = this._hashFile();
    this._watcher = null;
    this._debounceTimer = null;
  }

  get current() { return this._current; }
  snapshot() { return this._current; }

  _hashFile() {
    try {
      const raw = fs.readFileSync(this._current.__configPath, 'utf8');
      return crypto.createHash('sha256').update(raw).digest('hex');
    } catch {
      return null;
    }
  }

  reload(reason = 'manual') {
    const newHash = this._hashFile();
    if (newHash && newHash === this._rawHash) return;

    let newCfg;
    try {
      newCfg = loadConfig(this._configPathArg);
    } catch (err) {
      console.error(`[${this._component}] config reload failed (keeping last-known-good): ${err.message}`);
      return;
    }

    const oldCfg = this._current;
    const oldTlsFp = _safeTlsFingerprint(oldCfg);
    for (const field of RESTART_REQUIRED_FIELDS) {
      const oldVal = getNestedField(oldCfg, field);
      const newVal = getNestedField(newCfg, field);
      if (oldVal !== newVal) {
        console.error(`[${this._component}] changed ${field}; restart required for inbound listener/TLS changes`);
      }
    }

    const newTlsFp = _safeTlsFingerprint(newCfg);
    if (!oldTlsFp || !newTlsFp || newTlsFp !== oldTlsFp) {
      clearHttpsAgentCache('tls-config-changed');
    }

    this._current = newCfg;
    this._rawHash = newHash;
    ensureDirs(newCfg).catch((err) => {
      console.error(`[${this._component}] ensureDirs after reload failed: ${err.message}`);
    });
    console.error(`[${this._component}] config reloaded (${reason})`);
  }

  startWatching() {
    if (this._watcher) return;
    const configPath = this._current.__configPath;
    this._watcher = fs.watch(path.dirname(configPath), (_eventType, filename) => {
      if (filename && path.resolve(path.dirname(configPath), filename.toString()) !== configPath) return;
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this.reload('file-change'), this._debounceMs);
    });
    this._watcher.on('error', () => {});
  }

  stopWatching() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    clearTimeout(this._debounceTimer);
  }
}

export function createConfigStore(configPathArg, options = {}) {
  const store = new ConfigStore(configPathArg, options);
  if (options.watch !== false) store.startWatching();
  return store;
}
