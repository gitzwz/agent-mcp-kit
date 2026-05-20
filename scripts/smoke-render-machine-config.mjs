#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-task-kit-render-'));

try {
    const out = path.join(tmp, 'machine.rice.json');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'core/render-machine-config.js'),
    '--topology', path.join(repoRoot, 'config/topology.example.yaml'),
    '--self', 'rice',
    '--out', out,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const rendered = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(rendered.machine_name, 'rice');
  assert.equal(rendered.job_dir, '../log/jobs');
  assert.equal(rendered.job_partition_by_date, true);
  assert.ok(!Object.hasOwn(rendered, 'job_output_max_bytes'));
  assert.deepEqual(rendered.allowed_machine_names, ['kobune', 'rice']);
  assert.equal(rendered.machines.rice.server_name, 'rice');
  assert.equal(rendered.machines.kobune.server_name, 'kobune');
  assert.ok(!rendered.allowed_machine_names.includes('local-peer'));
  assert.ok(!rendered.allowed_machine_names.includes('remote-peer'));
  assert.ok(!('aliases' in rendered.machines.rice));
  assert.ok(!('certificate_common_name' in rendered.machines.rice));
  assert.ok(!('aliases' in rendered.machines.kobune));
  assert.ok(!('certificate_common_name' in rendered.machines.kobune));

  // rice self.agents emits agent_profile_map and agent_telegram_map
  assert.equal(rendered.agent_profile_map['rice'], '/absolute/path/to/hermes-home');
  assert.equal(rendered.agent_profile_map['rice.rice'], '/absolute/path/to/hermes-home');
  assert.equal(rendered.agent_telegram_map['rice'].bot_token_env, 'RICE_TG_BOT_TOKEN');
  assert.equal(rendered.agent_telegram_map['rice'].chat_id_env, 'RICE_TG_CHAT_ID');
  assert.equal(rendered.agent_telegram_map['rice.rice'].bot_token_env, 'RICE_TG_BOT_TOKEN');

  const outKobune = path.join(tmp, 'machine.kobune.json');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'core/render-machine-config.js'),
    '--topology', path.join(repoRoot, 'config/topology.example.yaml'),
    '--self', 'kobune',
    '--out', outKobune,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const renderedKobune = JSON.parse(fs.readFileSync(outKobune, 'utf8'));
  assert.equal(renderedKobune.machine_name, 'kobune');
  assert.equal(renderedKobune.job_dir, '../log/jobs');
  assert.equal(renderedKobune.job_partition_by_date, true);
  assert.ok(!Object.hasOwn(renderedKobune, 'job_output_max_bytes'));
  assert.deepEqual(renderedKobune.allowed_machine_names, ['kobune', 'rice']);
  assert.equal(renderedKobune.agent_profile_map['kobune'], '/absolute/path/to/hermes-home');
  assert.equal(renderedKobune.agent_profile_map['kobune.kobune'], '/absolute/path/to/hermes-home');
  assert.equal(renderedKobune.agent_profile_map['reze'], '/absolute/path/to/hermes-profiles/reze');
  assert.equal(renderedKobune.agent_profile_map['kobune.reze'], '/absolute/path/to/hermes-profiles/reze');
  assert.equal(renderedKobune.agent_telegram_map['kobune'].bot_token_env, 'KOBUNE_TG_BOT_TOKEN');
  assert.equal(renderedKobune.agent_telegram_map['reze'].bot_token_env, 'REZE_TG_BOT_TOKEN');
  assert.equal(renderedKobune.agent_telegram_map['kobune.reze'].bot_token_env, 'REZE_TG_BOT_TOKEN');

  const mixedCaseTopology = path.join(tmp, 'mixed-topology.json');
  fs.writeFileSync(mixedCaseTopology, JSON.stringify({
    runtime_defaults: { workspace_dir: './workspace', state_dir: './state', job_dir: './jobs', max_archive_bytes: 1024 },
    tls_defaults: { ca_cert: './certs/ca/ca.crt' },
    machines: {
      VPS: {
        listen: { host: '127.0.0.1', port: 8443 },
        tls: { cert: './certs/vps/peer.crt', key: './certs/vps/peer.key' },
        endpoint: { strategy: 'manual', url: 'https://vps.example.test:8443', server_name: 'VPS' },
        agents: {
          Reze: {
            hermes_home: '/root/.hermes/profiles/reze',
            telegram: { bot_token_env: 'REZE_TG_BOT_TOKEN', chat_id_env: 'REZE_TG_CHAT_ID' },
          },
        },
      },
      Mac: {
        listen: { host: '127.0.0.1', port: 9443 },
        tls: { cert: './certs/mac/peer.crt', key: './certs/mac/peer.key' },
        endpoint: { strategy: 'manual', url: 'https://mac.example.test:9443', server_name: 'Mac' },
      },
    },
  }, null, 2));

  const outMixed = path.join(tmp, 'machine.vps.json');
  execFileSync(process.execPath, [
    path.join(repoRoot, 'core/render-machine-config.js'),
    '--topology', mixedCaseTopology,
    '--self', 'VPS',
    '--out', outMixed,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const renderedMixed = JSON.parse(fs.readFileSync(outMixed, 'utf8'));
  assert.equal(renderedMixed.machine_name, 'vps');
  assert.deepEqual(renderedMixed.allowed_machine_names, ['mac', 'vps']);
  assert.equal(renderedMixed.machines.vps.server_name, 'vps');
  assert.equal(renderedMixed.machines.mac.server_name, 'mac');
  assert.equal(renderedMixed.agent_profile_map['reze'], '/root/.hermes/profiles/reze');
  assert.equal(renderedMixed.agent_telegram_map['reze'].bot_token_env, 'REZE_TG_BOT_TOKEN');

  const badTopology = path.join(tmp, 'bad-topology.json');
  fs.writeFileSync(badTopology, JSON.stringify({
    runtime_defaults: { workspace_dir: './workspace', state_dir: './state', job_dir: './jobs', max_archive_bytes: 1024 },
    tls_defaults: { ca_cert: './certs/ca/ca.crt' },
    machines: {
      rice: {
        listen: { host: '127.0.0.1', port: 8443 },
        tls: { cert: './certs/rice/peer.crt', key: './certs/rice/peer.key' },
        endpoint: { strategy: 'manual', url: 'https://rice.example.test:8443', server_name: 'kobune' },
      },
    },
  }, null, 2));

  const legacyTopology = path.join(tmp, 'legacy-topology.json');
  fs.writeFileSync(legacyTopology, JSON.stringify({
    runtime_defaults: { workspace_dir: './workspace', state_dir: './state', job_dir: './jobs', max_archive_bytes: 1024 },
    tls_defaults: { ca_cert: './certs/ca/ca.crt' },
    machines: {
      'local-peer': {
        listen: { host: '127.0.0.1', port: 8443 },
        tls: { cert: './certs/local-peer/peer.crt', key: './certs/local-peer/peer.key' },
        endpoint: { strategy: 'manual', url: 'https://legacy.example.test:8443', server_name: 'local-peer' },
      },
    },
  }, null, 2));

  const legacy = spawnSync(process.execPath, [
    path.join(repoRoot, 'core/render-machine-config.js'),
    '--topology', legacyTopology,
    '--self', 'local-peer',
    '--out', path.join(tmp, 'legacy-render.json'),
  ], { encoding: 'utf8' });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /forbidden legacy id/);

  console.log('smoke-render-machine: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
