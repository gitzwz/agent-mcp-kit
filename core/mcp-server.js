import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createConfigStore,
  ensureDirs,
  machineRequest,
  safeMachineName,
  safeRelativePath,
  contentText,
  readJson,
} from './peer-lib.js';

const cfgStore = createConfigStore(process.argv[2], { watch: true, component: 'mcp-server' });
await ensureDirs(cfgStore.snapshot());

const server = new McpServer({
  name: 'bash-task-kit-peer-mcp',
  version: '0.1.0',
}, {
  capabilities: { logging: {} },
});

function snapshotConfig() {
  return cfgStore.snapshot();
}

function mcpOption(cfg, name, defaultValue = false) {
  const value = cfg.mcp?.[name];
  return typeof value === 'boolean' ? value : defaultValue;
}

function assertMcpOption(cfg, name, defaultValue = false) {
  if (!mcpOption(cfg, name, defaultValue)) {
    throw new Error(`${name} is disabled in config`);
  }
}

function registerMachineRequestTool(name, description, endpoint, inputSchema, mapPayload = (payload) => payload) {
  server.registerTool(name, {
    description,
    inputSchema,
  }, async ({ machine_name, ...payload }) => {
    if (!machine_name) {
      throw new Error('machine_name is required');
    }
    safeMachineName(machine_name);
    const cfg = snapshotConfig();
    const result = await machineRequest(cfg, machine_name, endpoint, mapPayload(payload));
    return contentText(result);
  });
}

server.registerTool('send_machine_message', {
  description: 'Send a plain text message to a configured peer by name (e.g. rice, kobune, reze). Runtime-disabled unless mcp.show_mailbox_tools is true; prefer remote job tools unless you explicitly need the plain mailbox.',
  inputSchema: {
    machine_name: z.string().describe('Target machine name (e.g. rice, kobune)'),
    text: z.string().min(1).max(20000),
  },
}, async ({ machine_name, text }) => {
  if (!machine_name) throw new Error('machine_name is required');
  safeMachineName(machine_name);
  const cfg = snapshotConfig();
  assertMcpOption(cfg, 'show_mailbox_tools', false);
  const result = await machineRequest(cfg, machine_name, '/v1/send-message', { text });
  return contentText(result);
});

server.registerTool('list_machine_messages', {
  description: 'List recent inbound plain mailbox messages received by this peer. Runtime-disabled unless mcp.show_mailbox_tools is true.',
  inputSchema: {},
}, async () => {
  const cfg = snapshotConfig();
  assertMcpOption(cfg, 'show_mailbox_tools', false);
  const dir = path.join(cfg.state_dir, 'messages');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().slice(-50)
    : [];
  const items = [];
  for (const file of files) {
    const obj = await readJson(path.join(dir, file));
    if (obj) items.push(obj);
  }
  return contentText({ messages: items });
});

server.registerTool('remote_upload_and_run', {
  description: 'Upload a zip/tar/tar.gz/tgz archive to a remote peer by name (e.g. rice, kobune, reze), unpack it inside that peer\'s workspace, and run a relative entrypoint there. Execution is confined to that workspace. Optionally inline bounded stdout/stderr output for small jobs.',
  inputSchema: {
    machine_name: z.string().describe('Target machine name (e.g. rice, kobune)'),
    archive_path: z.string(),
    entrypoint: z.string(),
    args: z.array(z.string()).optional(),
    include_output: z.boolean().optional(),
    output_limit: z.number().int().min(0).max(1048576).optional(),
  },
}, async ({ machine_name, archive_path, entrypoint, args = [], include_output = false, output_limit }) => {
  if (!machine_name) throw new Error('machine_name is required');
  safeMachineName(machine_name);
  const cfg = snapshotConfig();
  const absArchive = path.resolve(archive_path);
  const archiveName = path.basename(absArchive);
  const data = fs.readFileSync(absArchive);
  const result = await machineRequest(cfg, machine_name, '/v1/upload-and-run', {
    archiveBase64: data.toString('base64'),
    archiveName,
    entrypoint: safeRelativePath(entrypoint),
    args,
    include_output,
    output_limit,
  });
  return contentText(result);
});

registerMachineRequestTool(
  'remote_read_file',
  'Read a file from a remote peer workspace by machine name (e.g. rice, kobune, reze). Paths must be relative to the peer workspace.',
  '/v1/read-file',
  {
    machine_name: z.string().describe('Target machine name (e.g. rice, kobune)'),
    relative_path: z.string(),
  },
  ({ relative_path }) => ({ relative_path }),
);

registerMachineRequestTool(
  'remote_job_status',
  'Get a job status from a remote peer by machine name and job ID.',
  '/v1/job-status',
  {
    machine_name: z.string().describe('Target machine name (e.g. rice, kobune)'),
    job_id: z.string(),
  },
);

registerMachineRequestTool(
  'remote_job_output',
  'Read stdout/stderr slices for a remote job by machine name and job ID. Uses safe offsets and a bounded byte limit; use next_offset values to continue.',
  '/v1/job-output',
  {
    machine_name: z.string().describe('Target machine name (e.g. rice, kobune)'),
    job_id: z.string(),
    stdout_offset: z.number().int().min(0).optional(),
    stderr_offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(0).max(1048576).optional(),
  },
);

registerMachineRequestTool(
  'notify_machine_agent',
  'Send an agent-to-agent notification to a remote peer by machine name (e.g. rice, kobune, reze) over the authenticated peer channel.',
  '/v1/notify-peer-agent',
  {
    machine_name: z.string().describe('Target machine name (e.g. rice, kobune)'),
    from_agent: z.string().min(1).max(200),
    to_agent: z.string().min(1).max(200),
    text: z.string().min(1).max(20000),
    thread_id: z.string().max(200).optional(),
  },
);

registerMachineRequestTool(
  'remote_submit_job',
  'Submit a job script to a remote peer by machine name (e.g. rice, kobune, reze) for immediate execution and return job_id/log paths.',
  '/v1/submit-peer-job',
  {
    machine_name: z.string().describe('Target machine name (e.g. rice, kobune)'),
    from_agent: z.string().min(1).max(200),
    to_agent: z.string().min(1).max(200),
    script: z.string().min(1).max(200000),
    args: z.array(z.string()).optional(),
    timeout_sec: z.number().int().min(1).max(7200).optional(),
  },
);

server.registerTool('local_workspace_read_file', {
  description: 'Read a file from the local workspace only. Path must be relative to the configured workspace directory.',
  inputSchema: {
    relative_path: z.string(),
  },
}, async ({ relative_path }) => {
  const cfg = snapshotConfig();
  const safe = safeRelativePath(relative_path);
  const full = path.resolve(cfg.workspace_dir, safe);
  if (!full.startsWith(`${cfg.workspace_dir}${path.sep}`) && full !== cfg.workspace_dir) {
    throw new Error('path escapes workspace');
  }
  const stat = fs.statSync(full);
  if (!stat.isFile()) {
    throw new Error('requested path is not a file');
  }
  const content = fs.readFileSync(full, 'utf8');
  return contentText({ path: safe, content });
});

const transport = new StdioServerTransport();
await server.connect(transport);
