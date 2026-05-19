import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { createConfigStore, ensureDirs, genJobId, safeRelativePath, resolveInside, rejectSymlinks, writeJson, readJson, canonicalMachineNameForIdentity, normalizePrincipalName } from './peer-lib.js';

const cfgStore = createConfigStore(process.argv[2], { watch: true, component: 'peer-daemon' });
await ensureDirs(cfgStore.snapshot());


function getPeerIdentity(req, cfg) {
  const cert = req.socket.getPeerCertificate(true);
  if (!req.client.authorized) {
    throw new Error(`TLS client not authorized: ${req.client.authorizationError || 'unknown error'}`);
  }
  const cn = cert?.subject?.CN;
  if (!cn) {
    throw new Error('peer certificate missing CN');
  }
  const canonicalMachineName = canonicalMachineNameForIdentity(cfg, cn);
  const claimed = req.headers['x-machine-id'] || req.headers['x-peer-id'];
  if (claimed) {
    const canonicalClaimedMachineName = canonicalMachineNameForIdentity(cfg, claimed);
    if (canonicalClaimedMachineName !== canonicalMachineName) {
      throw new Error(`peer header mismatch: ${claimed} != cert CN ${cn}`);
    }
  }
  return canonicalMachineName;
}

async function readBody(req, cfg) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  if (buf.length > cfg.max_archive_bytes * 2) {
    throw new Error('request body too large');
  }
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseHookEnvMap(rawValue, label) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    console.error(`[peer-daemon] ignoring invalid ${label}: ${error.message || error}`);
    return {};
  }
}

function mergedHookMap(configMap, envValue, label) {
  return {
    ...(configMap && typeof configMap === 'object' && !Array.isArray(configMap) ? configMap : {}),
    ...parseHookEnvMap(envValue, label),
  };
}

async function unpackArchive(archivePath, destDir) {
  await fsp.mkdir(destDir, { recursive: true, mode: 0o700 });
  const lower = archivePath.toLowerCase();
  let args;
  if (lower.endsWith('.zip')) {
    args = ['-q', archivePath, '-d', destDir];
    await new Promise((resolve, reject) => {
      const p = spawn('unzip', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`unzip failed (${code}): ${err}`)));
      p.on('error', reject);
    });
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    args = ['-xf', archivePath, '-C', destDir];
    await new Promise((resolve, reject) => {
      const p = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err}`)));
      p.on('error', reject);
    });
  } else {
    throw new Error('unsupported archive type');
  }
  await rejectSymlinks(destDir);
}

async function executeJob({ cfg, machineName, archiveBase64, archiveName, entrypoint, args = [] }) {
  if (!archiveBase64 || !entrypoint) {
    throw new Error('archiveBase64 and entrypoint are required');
  }
  const jobsDir = cfg.job_dir;
  const safeEntrypoint = safeRelativePath(entrypoint);
  const jobId = genJobId();
  const jobDir = path.join(jobsDir, jobId);
  const inputDir = path.join(jobDir, 'input');
  const metaDir = path.join(jobDir, 'meta');
  await fsp.mkdir(inputDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(metaDir, { recursive: true, mode: 0o700 });

  const archiveBuffer = Buffer.from(archiveBase64, 'base64');
  if (archiveBuffer.length > cfg.max_archive_bytes) {
    throw new Error(`archive exceeds max_archive_bytes (${cfg.max_archive_bytes})`);
  }

  const incomingName = archiveName || 'payload.tar.gz';
  const lowerName = incomingName.toLowerCase();
  let archiveSuffix = '.bin';
  if (lowerName.endsWith('.tar.gz')) archiveSuffix = '.tar.gz';
  else if (lowerName.endsWith('.tgz')) archiveSuffix = '.tgz';
  else if (lowerName.endsWith('.tar')) archiveSuffix = '.tar';
  else if (lowerName.endsWith('.zip')) archiveSuffix = '.zip';
  const archivePath = path.join(metaDir, `payload${archiveSuffix}`);
  await fsp.writeFile(archivePath, archiveBuffer, { mode: 0o600 });
  await unpackArchive(archivePath, inputDir);

  const scriptPath = await resolveInside(inputDir, safeEntrypoint);
  const relScript = path.relative(inputDir, scriptPath);
  if (relScript.startsWith('..')) {
    throw new Error('entrypoint escapes unpacked archive');
  }
  await fsp.chmod(scriptPath, 0o700).catch(() => {});

  const stdoutPath = path.join(jobDir, 'stdout.log');
  const stderrPath = path.join(jobDir, 'stderr.log');
  const statusPath = path.join(jobDir, 'status.json');
  const startedAt = new Date().toISOString();
  await writeJson(statusPath, {
    job_id: jobId,
    machine_name: machineName,
    state: 'running',
    archive_name: archiveName,
    entrypoint: safeEntrypoint,
    args,
    started_at: startedAt,
    cwd: inputDir,
  });

  const timeoutSec = Number(process.env.PEER_JOB_TIMEOUT_SEC || 1800);
  const child = spawn(scriptPath, args.map(String), {
    cwd: inputDir,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: inputDir,
      TMPDIR: path.join(jobDir, 'tmp'),
      PEER_JOB_DIR: jobDir,
      PEER_INPUT_DIR: inputDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await fsp.mkdir(path.join(jobDir, 'tmp'), { recursive: true, mode: 0o700 });
  const stdoutStream = fs.createWriteStream(stdoutPath, { mode: 0o600 });
  const stderrStream = fs.createWriteStream(stderrPath, { mode: 0o600 });
  child.stdout.pipe(stdoutStream, { end: false });
  child.stderr.pipe(stderrStream, { end: false });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, timeoutSec * 1000);

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  }).finally(() => clearTimeout(timer));

  await closeOutputStreams(stdoutStream, stderrStream);
  const finishedAt = new Date().toISOString();
  const state = timedOut ? 'timeout' : (exitCode === 0 ? 'ok' : 'failed');
  const status = {
    job_id: jobId,
    machine_name: machineName,
    state,
    archive_name: archiveName,
    entrypoint: safeEntrypoint,
    args,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: exitCode,
    cwd: inputDir,
    stdout_path: path.relative(cfg.job_dir, stdoutPath),
    stderr_path: path.relative(cfg.job_dir, stderrPath),
  };
  await writeJson(statusPath, status);
  return status;
}

async function readWorkspaceFile(cfg, relativePath) {
  const safe = safeRelativePath(relativePath);
  const resolved = await resolveInside(cfg.workspace_dir, safe);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) {
    throw new Error('requested path is not a file');
  }
  const content = await fsp.readFile(resolved, 'utf8');
  return {
    path: safe,
    size: stat.size,
    content,
  };
}

function safeJobId(jobId) {
  const value = String(jobId || '');
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error('invalid job_id');
  }
  return value;
}

async function closeOutputStreams(stdoutStream, stderrStream) {
  function endStream(stream) {
    if (stream.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        stream.off('error', onError);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      stream.once('error', onError);
      stream.end(() => {
        cleanup();
        resolve();
      });
    });
  }
  await Promise.all([endStream(stdoutStream), endStream(stderrStream)]);
}

function normalizeOutputLimit(value) {
  const fallback = 64 * 1024;
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.trunc(n), 1024 * 1024));
}

function normalizeOutputOffset(value) {
  const n = value == null ? 0 : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

async function readLogSlice(filePath, offset, limit) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { content: '', offset, next_offset: offset, size: 0, truncated: false, missing: true };
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error('job output path is not a file');
  const safeOffset = Math.min(offset, stat.size);
  const bytesToRead = Math.min(limit, Math.max(0, stat.size - safeOffset));
  if (bytesToRead === 0) {
    return { content: '', offset: safeOffset, next_offset: safeOffset, size: stat.size, truncated: safeOffset < stat.size };
  }
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, safeOffset);
    const nextOffset = safeOffset + bytesRead;
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      offset: safeOffset,
      next_offset: nextOffset,
      size: stat.size,
      truncated: nextOffset < stat.size,
    };
  } finally {
    await handle.close();
  }
}

async function readJobOutput(cfg, payload) {
  const jobId = safeJobId(payload?.job_id);
  const limit = normalizeOutputLimit(payload?.limit);
  const stdoutOffset = normalizeOutputOffset(payload?.stdout_offset);
  const stderrOffset = normalizeOutputOffset(payload?.stderr_offset);
  const jobsDir = cfg.job_dir;
  const jobDir = await resolveInside(jobsDir, jobId);
  const status = await readJson(path.join(jobDir, 'status.json'));
  if (!status) return null;
  return {
    job_id: jobId,
    state: status.state,
    exit_code: status.exit_code,
    stdout: await readLogSlice(path.join(jobDir, 'stdout.log'), stdoutOffset, limit),
    stderr: await readLogSlice(path.join(jobDir, 'stderr.log'), stderrOffset, limit),
  };
}

async function handleMessage(cfg, machineName, payload) {
  const text = typeof payload?.text === 'string' ? payload.text : '';
  if (!text) throw new Error('message text is required');
  const messagesDir = path.join(cfg.state_dir, 'messages');
  const messageId = genJobId();
  const record = {
    message_id: messageId,
    machine_name: machineName,
    text,
    received_at: new Date().toISOString(),
  };
  await writeJson(path.join(messagesDir, `${messageId}.json`), record);
  return record;
}

function safeMailboxField(name, value, maxLen = 200) {
  const trimmed = normalizePrincipalName(value, name);
  if (trimmed.length > maxLen) {
    throw new Error(`${name} too long`);
  }
  return trimmed;
}

function normalizeOptionalThreadId(value) {
  if (value == null || value === '') return null;
  return safeMailboxField('thread_id', value, 200);
}

async function listRecentPeerMessages(cfg, filterPeerId = null, limit = 50) {
  const messagesDir = path.join(cfg.state_dir, 'messages');
  const files = (await fsp.readdir(messagesDir)).filter((name) => name.endsWith('.json')).sort();
  const messages = [];
  for (const file of files.slice(-500)) {
    const data = await readJson(path.join(messagesDir, file));
    if (!data) continue;
    if (filterPeerId && data.peer_name !== filterPeerId) continue;
    messages.push(data);
  }
  return messages.slice(-Math.max(1, Math.min(limit, 200)));
}

async function handleAgentChatMessage(cfg, machineName, payload) {
  const fromAgent = safeMailboxField('from_agent', payload?.from_agent);
  const toAgent = safeMailboxField('to_agent', payload?.to_agent);
  const text = typeof payload?.text === 'string' ? payload.text : '';
  if (!text) throw new Error('text is required');
  if (text.length > 20000) throw new Error('text too long');
  const threadId = normalizeOptionalThreadId(payload?.thread_id);
  const agentChatDir = path.join(cfg.state_dir, 'agent-chat');
  const jobsDir = cfg.job_dir;
  const messageId = genJobId();
  const record = {
    message_id: messageId,
    machine_name: machineName,
    from_agent: fromAgent,
    to_agent: toAgent,
    text,
    thread_id: threadId,
    received_at: new Date().toISOString(),
  };
  await writeJson(path.join(agentChatDir, `${messageId}.json`), record);

  // Optional push mode: execute immediately on receive (no mailbox polling)
  const hook = process.env.PEER_AGENT_CHAT_HOOK || '';
  if (hook.trim()) {
    const mergedProfileMap = mergedHookMap(cfg.agent_profile_map, process.env.PEER_AGENT_PROFILE_MAP, 'PEER_AGENT_PROFILE_MAP');
    const mergedTelegramMap = mergedHookMap(cfg.agent_telegram_map, process.env.PEER_AGENT_TELEGRAM_MAP, 'PEER_AGENT_TELEGRAM_MAP');
    const hookTimeout = Math.max(1, Math.min(Number(process.env.PEER_AGENT_CHAT_HOOK_TIMEOUT_SEC || 1800), 7200));
    const jobId = genJobId();
    const jobDir = path.join(jobsDir, jobId);
    const inputDir = path.join(jobDir, 'input');
    await fsp.mkdir(inputDir, { recursive: true, mode: 0o700 });
    const payloadPath = path.join(inputDir, 'agent-message.json');
    await writeJson(payloadPath, record);

    const stdoutPath = path.join(jobDir, 'stdout.log');
    const stderrPath = path.join(jobDir, 'stderr.log');
    const statusPath = path.join(jobDir, 'status.json');
    const startedAt = new Date().toISOString();
    await writeJson(statusPath, {
      job_id: jobId,
      machine_name: machineName,
      state: 'running',
      mode: 'agent-chat-hook',
      started_at: startedAt,
      hook,
      message_id: messageId,
      cwd: inputDir,
    });

    const child = spawn(hook, [payloadPath], {
      cwd: inputDir,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: inputDir,
        TMPDIR: path.join(jobDir, 'tmp'),
        PEER_JOB_DIR: jobDir,
        PEER_INPUT_DIR: inputDir,
        PEER_AGENT_MESSAGE_PATH: payloadPath,
        PEER_AGENT_PROFILE_MAP: JSON.stringify(mergedProfileMap),
        PEER_AGENT_TELEGRAM_MAP: JSON.stringify(mergedTelegramMap),
        PEER_MACHINE_NAME: cfg.machine_name,
        PEER_LOCAL_AGENT_NAMES: JSON.stringify(Object.keys(cfg.agent_profile_map || {})),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await fsp.mkdir(path.join(jobDir, 'tmp'), { recursive: true, mode: 0o700 });
    const stdoutStream = fs.createWriteStream(stdoutPath, { mode: 0o600 });
    const stderrStream = fs.createWriteStream(stderrPath, { mode: 0o600 });
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, hookTimeout * 1000);

    child.on('close', async (code) => {
      clearTimeout(timer);
      await closeOutputStreams(stdoutStream, stderrStream);
      const finishedAt = new Date().toISOString();
      const state = timedOut ? 'timeout' : (code === 0 ? 'ok' : 'failed');
      await writeJson(statusPath, {
        job_id: jobId,
        machine_name: machineName,
        state,
        mode: 'agent-chat-hook',
        started_at: startedAt,
        finished_at: finishedAt,
        exit_code: code ?? -1,
        hook,
        message_id: messageId,
        cwd: inputDir,
        stdout_path: path.relative(cfg.job_dir, stdoutPath),
        stderr_path: path.relative(cfg.job_dir, stderrPath),
      });
    });
    child.unref();

    return {
      ...record,
      pushed: true,
      hook_job_id: jobId,
      hook_state: 'running',
      hook_stdout_path: path.relative(cfg.job_dir, stdoutPath),
      hook_stderr_path: path.relative(cfg.job_dir, stderrPath),
    };
  }

  return {
    ...record,
    pushed: false,
  };
}

async function pullAgentChatMessages(cfg, payload) {
  const agentId = safeMailboxField('agent_id', payload?.agent_id);
  const threadId = normalizeOptionalThreadId(payload?.thread_id);
  const limit = Math.max(1, Math.min(Number(payload?.limit ?? 50), 200));
  const deleteAfterRead = Boolean(payload?.delete_after_read);
  const agentChatDir = path.join(cfg.state_dir, 'agent-chat');
  const files = (await fsp.readdir(agentChatDir)).filter((name) => name.endsWith('.json')).sort();
  const matches = [];

  for (const file of files) {
    const full = path.join(agentChatDir, file);
    const data = await readJson(full);
    if (!data) continue;
    if (data.to_agent !== agentId) continue;
    if (threadId !== null && data.thread_id !== threadId) continue;
    matches.push({ file, data });
  }

  const selected = matches.slice(0, limit);
  if (deleteAfterRead) {
    for (const item of selected) {
      await fsp.rm(path.join(agentChatDir, item.file), { force: true });
    }
  }

  return {
    agent_id: agentId,
    thread_id: threadId,
    delete_after_read: deleteAfterRead,
    messages: selected.map((item) => item.data),
  };
}

async function dispatchAgentTask(cfg, machineName, payload) {
  const fromAgent = safeMailboxField('from_agent', payload?.from_agent);
  const toAgent = safeMailboxField('to_agent', payload?.to_agent);
  const script = typeof payload?.script === 'string' ? payload.script : '';
  if (!script.trim()) throw new Error('script is required');
  if (script.length > 200000) throw new Error('script too long');
  const args = Array.isArray(payload?.args) ? payload.args.map((x) => String(x)) : [];
  const timeoutSec = Math.max(1, Math.min(Number(payload?.timeout_sec ?? 1800), 7200));

  const jobsDir = cfg.job_dir;
  const jobId = genJobId();
  const jobDir = path.join(jobsDir, jobId);
  const inputDir = path.join(jobDir, 'input');
  await fsp.mkdir(inputDir, { recursive: true, mode: 0o700 });

  const scriptPath = path.join(inputDir, 'task.sh');
  await fsp.writeFile(scriptPath, script, { mode: 0o700 });
  await fsp.chmod(scriptPath, 0o700).catch(() => {});

  const stdoutPath = path.join(jobDir, 'stdout.log');
  const stderrPath = path.join(jobDir, 'stderr.log');
  const statusPath = path.join(jobDir, 'status.json');
  const startedAt = new Date().toISOString();

  await writeJson(statusPath, {
    job_id: jobId,
    machine_name: machineName,
    state: 'running',
    mode: 'agent-dispatch',
    from_agent: fromAgent,
    to_agent: toAgent,
    args,
    started_at: startedAt,
    cwd: inputDir,
  });

  const child = spawn(scriptPath, args, {
    cwd: inputDir,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: inputDir,
      TMPDIR: path.join(jobDir, 'tmp'),
      PEER_JOB_DIR: jobDir,
      PEER_INPUT_DIR: inputDir,
      PEER_FROM_AGENT: fromAgent,
      PEER_TO_AGENT: toAgent,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  await fsp.mkdir(path.join(jobDir, 'tmp'), { recursive: true, mode: 0o700 });

  const stdoutStream = fs.createWriteStream(stdoutPath, { mode: 0o600 });
  const stderrStream = fs.createWriteStream(stderrPath, { mode: 0o600 });
  child.stdout.pipe(stdoutStream, { end: false });
  child.stderr.pipe(stderrStream, { end: false });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, timeoutSec * 1000);

  child.on('close', async (code) => {
    clearTimeout(timer);
    await closeOutputStreams(stdoutStream, stderrStream);
    const finishedAt = new Date().toISOString();
    const state = timedOut ? 'timeout' : (code === 0 ? 'ok' : 'failed');
    await writeJson(statusPath, {
      job_id: jobId,
      machine_name: machineName,
      state,
      mode: 'agent-dispatch',
      from_agent: fromAgent,
      to_agent: toAgent,
      args,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: code ?? -1,
      cwd: inputDir,
      stdout_path: path.relative(cfg.workspace_dir, stdoutPath),
      stderr_path: path.relative(cfg.workspace_dir, stderrPath),
    });
  });

  child.unref();

  return {
    job_id: jobId,
    machine_name: machineName,
    state: 'running',
    mode: 'agent-dispatch',
    from_agent: fromAgent,
    to_agent: toAgent,
    stdout_path: path.relative(cfg.job_dir, stdoutPath),
    stderr_path: path.relative(cfg.job_dir, stderrPath),
  };
}

async function handleRequest(req, res) {
  let machineName;
  try {
    const cfg = cfgStore.snapshot();
    machineName = getPeerIdentity(req, cfg);
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    const body = await readBody(req, cfg);
    if (req.url === '/v1/upload-and-run') {
      const result = await executeJob({ cfg, machineName, ...body });
      if (body.include_output) {
        result.output = await readJobOutput(cfg, { job_id: result.job_id, limit: body.output_limit });
      }
      return sendJson(res, 200, result);
    }
    if (req.url === '/v1/read-file') {
      const result = await readWorkspaceFile(cfg, body.path ?? body.relative_path);
      return sendJson(res, 200, result);
    }
    if (req.url === '/v1/job-status') {
      const jobId = safeJobId(body.job_id);
      const jobsDir = cfg.job_dir;
      const result = await readJson(path.join(jobsDir, jobId, 'status.json'));
      if (!result) return sendJson(res, 404, { error: 'job_not_found' });
      return sendJson(res, 200, result);
    }
    if (req.url === '/v1/job-output') {
      const result = await readJobOutput(cfg, body);
      if (!result) return sendJson(res, 404, { error: 'job_not_found' });
      return sendJson(res, 200, result);
    }
    if (req.url === '/v1/send-message') {
      const result = await handleMessage(cfg, machineName, body);
      return sendJson(res, 200, result);
    }
    if (req.url === '/v1/list-messages') {
      const filterPeerId = (body.machine_name || body.peer_name || body.peer_id) ? safeMailboxField('machine_name', body.machine_name || body.peer_name || body.peer_id) : null;
      const limit = body.limit == null ? 50 : Math.max(1, Math.min(Number(body.limit), 200));
      const messages = await listRecentPeerMessages(cfg, filterPeerId, limit);
      return sendJson(res, 200, { messages });
    }
    if (req.url === '/v1/notify-peer-agent') {
      const result = await handleAgentChatMessage(cfg, machineName, body);
      return sendJson(res, 200, result);
    }
    if (req.url === '/v1/pull-agent-chat-messages') {
      const result = await pullAgentChatMessages(cfg, body);
      return sendJson(res, 200, result);
    }
    if (req.url === '/v1/submit-peer-job') {
      const result = await dispatchAgentTask(cfg, machineName, body);
      return sendJson(res, 200, result);
    }
    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    return sendJson(res, 400, { error: String(error.message || error), peer: machineName || null });
  }
}

const initialCfg = cfgStore.snapshot();
const httpsServerInstance = https.createServer({
  cert: fs.readFileSync(initialCfg.tls.cert),
  key: fs.readFileSync(initialCfg.tls.key),
  ca: fs.readFileSync(initialCfg.tls.ca_cert),
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2',
}, handleRequest);

httpsServerInstance.listen(initialCfg.listen_port, initialCfg.listen_host, () => {
  console.error(`peer daemon listening on https://${initialCfg.listen_host}:${initialCfg.listen_port} as ${initialCfg.machine_name || initialCfg.peer_name}`);
});
