#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TOPOLOGY_PATH = path.resolve('config/topology.example.yaml');
const DEFAULT_OUTPUT_PATH = path.resolve('config/machine-config.rendered.json');
const FORBIDDEN_LEGACY_PEER_IDS = new Set(['local-peer', 'remote-peer']);
const VALID_STRATEGIES = new Set([
  'public',
  'reverse_tunnel',
  'tailscale',
  'cloudflare_tunnel',
  'manual',
]);

function normalizePrincipalName(value, fieldLabel = 'name') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldLabel} is required`);
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`invalid ${fieldLabel}: ${value}`);
  }
  return trimmed.toLowerCase();
}

function assertNoLegacyMachineName(machineName, contextLabel = 'machine_name') {
  const normalized = normalizePrincipalName(machineName, contextLabel);
  if (FORBIDDEN_LEGACY_PEER_IDS.has(normalized)) {
    throw new Error(`${contextLabel} uses forbidden legacy id: ${machineName}`);
  }
  return normalized;
}

function printHelp() {
  process.stdout.write(`Usage: render-machine-config --self <machine_name> [--topology <path>] [--out <path>]\n\n`);
  process.stdout.write('Render one machine runtime config from topology example.\n\n');
  process.stdout.write('Options:\n');
  process.stdout.write('  --self <machine_name>   Machine to render for\n');
  process.stdout.write('  --topology <path>    Topology file path (default: ./topology.yaml)\n');
  process.stdout.write('  --out <path>         Output JSON path (default: ./machine-config.rendered.json)\n');
  process.stdout.write('  --help               Show this help\n\n');
  process.stdout.write('Prototype note: topology.yaml currently uses JSON-compatible YAML for deterministic rendering.\n');
}

function parseArgs(argv) {
  const args = {
    topologyPath: DEFAULT_TOPOLOGY_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    selfMachineName: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--self') {
      args.selfMachineName = argv[++i] || null;
      continue;
    }
    if (arg === '--topology') {
      args.topologyPath = path.resolve(argv[++i] || '');
      continue;
    }
    if (arg === '--out') {
      args.outputPath = path.resolve(argv[++i] || '');
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function readTopology(topologyPath) {
  const raw = fs.readFileSync(topologyPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('topology root must be an object');
  }
  return data;
}

function requireObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function normalizeStrategy(strategy) {
  if (typeof strategy !== 'string' || !VALID_STRATEGIES.has(strategy)) {
    throw new Error(`unsupported endpoint strategy: ${strategy}`);
  }
  return strategy;
}

function resolveMachineEndpoint(machineName, machineRecord) {
  const normalizedMachineName = assertNoLegacyMachineName(machineName, `machines.${machineName}`);
  const endpoint = requireObject(`machines.${machineName}.endpoint`, machineRecord.endpoint);
  if (endpoint.aliases != null) {
    throw new Error(`machines.${machineName}.endpoint.aliases is forbidden`);
  }
  if (endpoint.certificate_common_name != null) {
    throw new Error(`machines.${machineName}.endpoint.certificate_common_name is forbidden`);
  }
  const strategy = normalizeStrategy(endpoint.strategy);
  const url = typeof endpoint.url === 'string' && endpoint.url ? endpoint.url : null;
  if (!url) {
    throw new Error(`machines.${machineName}.endpoint.url is required`);
  }
  const serverName = typeof endpoint.server_name === 'string' && endpoint.server_name
    ? normalizePrincipalName(endpoint.server_name, `machines.${machineName}.endpoint.server_name`)
    : normalizedMachineName;
  if (serverName !== normalizedMachineName) {
    throw new Error(`machines.${machineName}.endpoint.server_name must equal machine id (${machineName})`);
  }
  return {
    strategy,
    url,
    server_name: serverName,
    metadata: endpoint.metadata && typeof endpoint.metadata === 'object' && !Array.isArray(endpoint.metadata)
      ? endpoint.metadata
      : {},
  };
}

function renderMachineConfig(topology, selfMachineName) {
  const normalizedSelfMachineName = assertNoLegacyMachineName(selfMachineName, '--self');
  const machines = requireObject('machines', topology.machines);
  const normalizedMachines = Object.fromEntries(
    Object.entries(machines).map(([machineName, record]) => [normalizePrincipalName(machineName, `machines.${machineName}`), record]),
  );
  const self = requireObject(`machines.${selfMachineName}`, normalizedMachines[normalizedSelfMachineName]);
  const runtimeDefaults = requireObject('runtime_defaults', topology.runtime_defaults || {});
  const tlsDefaults = requireObject('tls_defaults', topology.tls_defaults || {});

  const selfListen = requireObject(`machines.${selfMachineName}.listen`, self.listen);
  const selfTls = requireObject(`machines.${selfMachineName}.tls`, self.tls || {});
  const selfWorkspace = typeof self.workspace_dir === 'string' ? self.workspace_dir : runtimeDefaults.workspace_dir;
  const selfState = typeof self.state_dir === 'string' ? self.state_dir : runtimeDefaults.state_dir;
  const selfJobDir = typeof self.job_dir === 'string' ? self.job_dir : (runtimeDefaults.job_dir || './log/jobs');
  const maxArchiveBytes = Number(self.max_archive_bytes ?? runtimeDefaults.max_archive_bytes);

  if (!selfWorkspace || !selfState || !selfJobDir || !Number.isFinite(maxArchiveBytes)) {
    throw new Error(`machine ${selfMachineName} is missing runtime settings`);
  }

  const renderedMachines = {};
  const allowedMachineNames = [];

  for (const [rawMachineName, machineRecord] of Object.entries(machines)) {
    const machineName = assertNoLegacyMachineName(rawMachineName, `machines.${rawMachineName}`);
    if (machineRecord?.aliases != null) {
      throw new Error(`machines.${rawMachineName}.aliases is forbidden`);
    }
    if (machineRecord?.certificate_common_name != null) {
      throw new Error(`machines.${rawMachineName}.certificate_common_name is forbidden`);
    }
    const resolved = resolveMachineEndpoint(rawMachineName, machineRecord);
    renderedMachines[machineName] = {
      url: resolved.url,
      server_name: resolved.server_name,
      endpoint_strategy: resolved.strategy,
      endpoint_metadata: resolved.metadata,
    };
    allowedMachineNames.push(machineName);
  }

  allowedMachineNames.sort();
  const uniqueAllowedMachineNames = [...new Set(allowedMachineNames)];

  const agentProfileMap = {};
  const agentTelegramMap = {};
  const selfAgents = self.agents && typeof self.agents === 'object' && !Array.isArray(self.agents)
    ? self.agents
    : {};

  const bindAgentRoute = (agentId, routeBuilder) => {
    const normalizedAgentId = normalizePrincipalName(agentId, 'agent_id');
    const scopedAgentId = `${normalizedSelfMachineName}.${normalizedAgentId}`;
    for (const key of [normalizedAgentId, scopedAgentId]) {
      routeBuilder(key);
    }
  };

  for (const [agentId, agentRecord] of Object.entries(selfAgents)) {
    if (!agentRecord || typeof agentRecord !== 'object') continue;
    if (typeof agentRecord.hermes_home === 'string' && agentRecord.hermes_home) {
      bindAgentRoute(agentId, (key) => {
        agentProfileMap[key] = agentRecord.hermes_home;
      });
    }
    if (agentRecord.telegram && typeof agentRecord.telegram === 'object' && !Array.isArray(agentRecord.telegram)) {
      const route = {};
      for (const key of ['bot_token_env', 'chat_id_env']) {
        if (typeof agentRecord.telegram[key] === 'string' && agentRecord.telegram[key]) {
          route[key] = agentRecord.telegram[key];
        }
      }
      if (Object.keys(route).length) {
        bindAgentRoute(agentId, (key) => {
          agentTelegramMap[key] = route;
        });
      }
    }
  }

  return {
    machine_name: normalizedSelfMachineName,
    listen_host: selfListen.host,
    listen_port: selfListen.port,
    workspace_dir: selfWorkspace,
    state_dir: selfState,
    job_dir: selfJobDir,
    job_partition_by_date: true,
    max_archive_bytes: maxArchiveBytes,
    tls: {
      ca_cert: selfTls.ca_cert || tlsDefaults.ca_cert,
      cert: selfTls.cert,
      key: selfTls.key,
    },
    allowed_machine_names: uniqueAllowedMachineNames,
    machines: renderedMachines,
    agent_profile_map: agentProfileMap,
    agent_telegram_map: agentTelegramMap,
  };
}

function validateRenderedConfig(config, selfMachineName) {
  const normalizedSelfMachineName = normalizePrincipalName(selfMachineName, '--self');
  if (!config.listen_host || !config.listen_port) {
    throw new Error(`machine ${selfMachineName} is missing listen settings`);
  }
  if (!config.tls?.ca_cert || !config.tls?.cert || !config.tls?.key) {
    throw new Error(`machine ${selfMachineName} is missing tls paths`);
  }
  if (!config.machines?.[normalizedSelfMachineName]) {
    throw new Error(`machine ${selfMachineName} is missing its own resolved machine endpoint`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.selfMachineName) {
    throw new Error('--self is required');
  }

  const topology = readTopology(args.topologyPath);
  const rendered = renderMachineConfig(topology, args.selfMachineName);
  validateRenderedConfig(rendered, args.selfMachineName);
  fs.writeFileSync(args.outputPath, `${JSON.stringify(rendered, null, 2)}\n`);
  process.stdout.write(`Wrote ${args.outputPath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
}
