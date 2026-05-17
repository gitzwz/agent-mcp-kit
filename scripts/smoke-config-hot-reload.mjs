#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from '../core/peer-lib.js';

function cfgText(dir, overrides = {}) {
  const cfg = {
    machine_name: 'peer-a',
    listen_host: '127.0.0.1',
    listen_port: 18443,
    workspace_dir: './workspace',
    state_dir: './state',
    job_dir: './jobs',
    max_archive_bytes: 1024,
    tls: {
      ca_cert: './certs/ca.crt',
      cert: './certs/peer.crt',
      key: './certs/peer.key',
    },
    allowed_server_names: ['peer-a'],
    peers: {
      'peer-a': {
        url: 'https://127.0.0.1:18443',
        server_name: 'peer-a',
      },
    },
    mcp: { show_mailbox_tools: false },
    agent_profile_map: {
      'agent-a': '/tmp/hermes-agent-a',
    },
    agent_telegram_map: {
      'agent-a': {
        bot_token_env: 'AGENT_A_TG_BOT_TOKEN',
        chat_id_env: 'AGENT_A_TG_CHAT_ID',
      },
    },
    ...overrides,
  };
  return JSON.stringify(cfg, null, 2) + '\n';
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bash-task-kit-config-'));
const configPath = path.join(tmp, 'machine.json');
await fsp.writeFile(configPath, cfgText(tmp));

const store = createConfigStore(configPath, { watch: true, debounceMs: 50, component: 'smoke-config-hot-reload' });
try {
  assert.equal(store.snapshot().machine_name, 'peer-a');
  assert.equal(store.snapshot().agent_telegram_map['agent-a'].bot_token_env, 'AGENT_A_TG_BOT_TOKEN');

  await fsp.writeFile(configPath, cfgText(tmp, { machine_name: 'peer-b', allowed_server_names: ['peer-b'] }));
  await wait(150);
  assert.equal(store.snapshot().machine_name, 'peer-b');
  assert.deepEqual(store.snapshot().allowed_server_names, ['peer-b']);

  await fsp.writeFile(configPath, '{ invalid json');
  await wait(150);
  assert.equal(store.snapshot().machine_name, 'peer-b');

  await fsp.writeFile(configPath, cfgText(tmp, { machine_name: 'peer-b', listen_port: 28443 }));
  await wait(150);
  assert.equal(store.snapshot().listen_port, 28443);

  console.log('smoke-config-hot-reload: ok');
} finally {
  store.stopWatching();
  fs.rmSync(tmp, { recursive: true, force: true });
}
