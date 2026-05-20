# Symmetric mTLS MCP Machine Kit

> 部署在每台机器上的 Daemon（MCP Server），把多台机器统一暴露给支持 MCP 的 Agent 管理；同时暴露各机器上的 Agent 名单，让 Agent 与 Agent 之间也能直接通信。

## 这个项目提供什么能力

它面向 Agent 暴露三类核心 MCP 能力：

- **读取目标机器文件**：仅允许工作区内的相对路径，避免越界读取。
- **提交远程任务并读取输出**：把任务发到指定机器执行，再拉回状态、stdout、stderr。
- **给另一台机器上的 Agent 发通知**：让 Agent 之间同步事项，而不是让人重复通知每个 Agent。

## 有了它，你可以做什么

- **只通过一个 Agent 管多台机器**  
  例如：在 Claude Code 或 Hermes 的对话里，直接说“诊断一下 xx 机器，把 xx 服务拉起”。
- **让 Agent 去通知 Agent**  
  例如：在 Agent1 的窗口里，让它通过 MCP 通知其他 Agent 安装某个 skill。
- **让 Agent Gateway 和 Daemon 双活**  
  某台机器上的 Agent Gateway 挂掉时，其他 Agent 仍可通过该机器的 Daemon 把它拉起；反过来也成立。

## 设计思想

- **一个 Agent 负责一个垂直事项**。如果资源不够，就跨 laptop、VPS、Android 等设备调度资源；而不是在多台机器上跑一堆做同一件事的 Agent。
- **一件事只需要和一个 Agent 同步一次**。后续通知其他 Agent、分发执行、跨机器协同，都交给 Agent 自己处理。

## 使用方式

把 [`docs/skill/peer-ops-setup.md`](./docs/skill/peer-ops-setup.md) 交给你的 Agent，并告诉它：

- 你是要 **init**（新建 CA），还是 **join**（加入已有 Daemon 集群）
- 如果你使用的是 **Hermes Agent**，是否还要安装 Optional 内容：
  - `chat hook`
  - `telegram` 显示

## 注意事项

- 机器之间的可达性可以通过这些方式提供：
  - **公网地址 / 局域网地址**
  - **反向隧道**（典型场景：VPS + 局域网机器）
  - **Tailscale**（更广泛、更省心的场景）
- 日志按 `YYYYMMDD` 目录存放在 `log/` 下，每条日志默认 **10 MB** 上限。
- 对 Hermes 而言，`chat hook` / Telegram 路由属于 **Optional**：
  - 默认情况下，Agent 通信只会把内容放进对方机器上的 MCP Mailbox。
  - 如果你想“收到后立刻消费”，就需要自己针对 Agent 类型实现 chat hook / notify。
  - 本项目已经为 **Hermes** 提供了一个测试过的 `hermes chat -q` 简单 hook，以及 Telegram 配置说明，因此可以直接在 Telegram 里看到对方 Agent 收到命令的情况。

## 已测试

- **两台本地局域网 Mac** 上的 Claude / Hermes Agent：
  - 能注册 MCP
  - 能把命令发送到对方电脑
- **四 Agent 混合拓扑**：
  - VPS 上两个 Hermes Agent
  - Mac 上两个 Hermes Agent
  - 可互相进行机器控制、互发 notify 信息，并显示在 Telegram 上

## TODO

- Android

## 为什么会有这个项目

很多时候，真正缺的不是另一个“大而全的平台”，而是一个足够轻、足够直接的运行层：

- 让 Agent 能安全地跨机器读文件、跑任务、取输出
- 让 Agent 能把事项继续分发给其他 Agent
- 让机器控制与 Agent 通信放在同一套最小闭环里

**A lightweight machine ops runtime for MCP agents.** It securely connects your own machines so agents can notify machine agents, submit direct jobs, and collect logs/artifacts without adopting a heavy ops platform.

## Concepts

Two user-facing concepts:

- **Machine**: a physical or virtual host (laptop, VPS, home server). Runs one or more machine daemons.
- **Machine name**: a named identity with its own certificate, config, workspace, and daemon process. Canonical machine names in this project: `rice`, `kobune`, `reze`.

A single machine can host multiple machine names. For example, a VPS might run both `kobune` and `reze` on different ports with separate certs and workspaces.

This is not trying to be a new A2A protocol, MCP message broker, SaltStack/Rundeck replacement, CI runner, or VPN. It is the small runtime layer between those worlds:

- A2A-style systems define how agents communicate.
- MCP defines how agents call tools.
- Teleport/Tailscale/tunnels make machines reachable.
- This kit gives MCP agents a machine topology, mTLS identity, agent notification lane, direct machine job lane, and auditable job logs.

See [`docs/POSITIONING.md`](docs/POSITIONING.md) for the competitive/complement map.

## Security model

### Authentication
- machine daemon requires mTLS
- machine certificate CN must be in `allowed_machine_names`
- request header `x-peer-id` must match certificate CN

### Workspace confinement
- read paths must be relative
- absolute paths are rejected
- `..` escapes are rejected
- resolved realpaths must stay inside `workspace_dir`
- symlinks inside uploaded archives are rejected

### Execution scope
- uploaded archive is unpacked to `job_dir/<job_id>/input/`
- only the provided relative `entrypoint` inside that extracted tree is executed
- stdout/stderr/status are written under that job directory

## Files
- `core/peer-daemon.js` — HTTPS machine daemon with mTLS
- `core/mcp-server.js` — stdio MCP server
- `core/peer-lib.js` — shared helpers (config loading, path safety, TLS request, JSON)
- `core/render-machine-config.js` — render per-machine runtime config from topology
- `scripts/generate-certs.sh` — generate CA + machine certs
- `config/machine.example.json` — example runtime config schema
- `docs/AGENT_TELEGRAM_ROUTING.md` — per-agent Telegram bot/chat routing for push-mode notifications
- `docs/skill/peer-ops-setup.md` — one-skill operator runbook (token/chat-id prompts, secure secret file layout, cert workflow, dual-machine non-SSH setup)

## Quick start

### 1. Generate certs

```bash
./scripts/generate-certs.sh --ca-role init "$PWD" <machine_name_a> <machine_name_b>
```

If a second machine is joining an existing CA, use `--ca-role join --ca-pin <sha256fp>` instead.

### 2. Write machine config

Create a `config/machine.<machine_name>.json` for each machine. See `config/machine.example.json` for the schema. Required fields:

- `machine_name` — this machine's identity (must match cert CN)
- `listen_host` / `listen_port`
- `tls.ca_cert`, `tls.cert`, `tls.key` — paths to cert material
- `workspace_dir` / `state_dir` / `job_dir` — `workspace_dir` is the remotely accessible workspace root, so keep it separate from `log/`; `job_dir` stores job stdout/stderr/status/input/tmp under `log/jobs`
- `allowed_machine_names` — explicit machine IDs allowed to connect; each value must match a configured `machines` key and the connecting certificate CN
- `machines` — map of machine IDs (for example `rice`, `kobune`) to `{ url, server_name }`; `server_name` must equal the machine ID so TLS hostname validation checks the same identity the daemon authorizes
- `agent_profile_map` — optional map from `to_agent` to Hermes home for push-mode routing, for example `{ "reze": "/root/.hermes/profiles/reze" }`
- `agent_telegram_map` — optional map from `to_agent` to Telegram token/chat env vars for push-mode status messages. Use env-var references such as `{ "reze": { "bot_token_env": "REZE_TG_BOT_TOKEN", "chat_id_env": "REZE_TG_CHAT_ID" } }`; do not commit real bot tokens.

Or use `config/topology.example.yaml` + `core/render-machine-config.js`.
The renderer currently expects JSON-compatible YAML (the provided
`config/topology.example.yaml` is intentionally valid JSON):

```bash
node core/render-machine-config.js --topology ./config/topology.example.yaml --self <machine_name> --out ./config/machine.<machine_name>.json
```

Rendered agent maps include both key forms for each local agent:

- plain: `<agent>` (for example `reze`)
- scoped: `<machine_name>.<agent>` (for example `kobune.reze`)

So operators can expose agent-centric naming to customers while keeping an explicit machine scope when needed.

### 3. Start daemon

```bash
node core/peer-daemon.js ./config/machine.<machine_name>.json
```

### 4. Register MCP

```bash
hermes mcp add bash-task-peer \
  --command node \
  --args "$PWD/core/mcp-server.js" "$PWD/config/machine.<machine_name>.json"
```

The MCP server requires an explicit config path argument.

## MCP tools (always visible)

### Remote tools

These tools submit jobs and read files/outputs on remote peers. They do not interact with any LLM or agent — they are pure remote-execution primitives.

- `remote_submit_job` — submit a shell script for immediate remote execution and receive `job_id`, state, and log paths.
- `remote_upload_and_run` — upload an archive, run a relative entrypoint in an isolated job workspace. Set `include_output: true` to inline small stdout/stderr slices.
- `remote_read_file` — read a UTF-8 file by relative path from the remote machine workspace.
- `remote_job_status` — read `status.json` for a remote job by `job_id`.
- `remote_job_output` — read bounded stdout/stderr slices; supports `stdout_offset`, `stderr_offset`, and `limit`.

All remote MCP tools require `machine_name` to identify the target machine.

### Machine / A2A tools

These tools handle agent-to-agent messaging over the machine network.

- `notify_machine_agent` — send an agent-to-agent notification to a remote peer, optionally triggering the daemon hook.

### Local tools

- `local_workspace_read_file` — read a local workspace file by relative path.

## MCP tools (optional, config-gated)

Enable with `mcp.show_mailbox_tools: true`:
- `send_machine_message` — store a plain text message on a remote machine.
- `list_machine_messages` — list this machine's inbound plain mailbox messages.

## Daemon routes

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/upload-and-run` | POST | Upload archive + run entrypoint |
| `/v1/read-file` | POST | Read workspace file |
| `/v1/job-status` | POST | Get job status |
| `/v1/job-output` | POST | Read job stdout/stderr slices |
| `/v1/send-message` | POST | Store plain machine message |
| `/v1/list-messages` | POST | List plain machine messages |
| `/v1/notify-peer-agent` | POST | Agent notification |
| `/v1/pull-agent-chat-messages` | POST | Pull agent mailbox |
| `/v1/submit-peer-job` | POST | Submit job script |

## Push mode for agent notifications

Set `PEER_AGENT_CHAT_HOOK` on the receiving daemon to trigger immediate execution on notification receive:

```bash
export PEER_AGENT_CHAT_HOOK=/path/to/hook-script
export PEER_AGENT_CHAT_HOOK_TIMEOUT_SEC=1800
export PEER_AGENT_EXEC_MODE=hermes
export KOBUNE_TG_BOT_TOKEN='<kobune bot token>'
export KOBUNE_TG_CHAT_ID='<telegram chat id>'
export REZE_TG_BOT_TOKEN='<reze bot token>'
export REZE_TG_CHAT_ID='<telegram chat id>'
```

The daemon spawns the hook with one arg (path to message JSON) and records job logs under `job_dir/<job_id>/`. When using `scripts/agent-dispatch-hook.py` in `hermes` mode, configure `agent_profile_map` in the machine config to route `notify_machine_agent(to_agent=...)` to the matching `HERMES_HOME`. The daemon injects that config into the hook environment as `PEER_AGENT_PROFILE_MAP`; for uniformly named profiles you can instead rely on `PEER_AGENT_HERMES_HOME_TEMPLATE`, for example `/root/.hermes/profiles/{to_agent}`.

`to_agent` can be either plain agent name (for example `reze`) or scoped `machine.agent` form (for example `kobune.reze`). Renderer now emits both forms so customer-facing naming can stay agent-centric while still supporting explicit machine scoping.

Telegram status delivery is separate from Hermes profile routing. Configure `agent_telegram_map` in the machine config so the daemon can inject it into the hook environment as `PEER_AGENT_TELEGRAM_MAP`. Each route must provide both a token and a chat id, preferably via env-var references (`bot_token_env` / `chat_id_env`). The hook now fails closed when a per-agent route is missing (daemon-wide `TG_BOT_TOKEN` / `TG_CHAT_ID` fallback is disabled) to prevent cross-agent misrouting. See [`docs/AGENT_TELEGRAM_ROUTING.md`](docs/AGENT_TELEGRAM_ROUTING.md).

## Reverse tunnel strategy

Use `reverse_tunnel` when a machine is behind NAT. The local daemon still listens on its bind address; the remote machine config uses the tunnel endpoint as the URL. mTLS remains the trust boundary; the tunnel only provides reachability.

Example:
```bash
ssh -N -R 127.0.0.1:18443:127.0.0.1:8443 user@relay.example.com
```

## Acceptance testing

Verify a machine deployment by exercising `remote_submit_job` and `remote_job_output`:

```bash
# Submit a trivial job
node -e '
import { loadConfig, machineRequest } from "./core/peer-lib.js";
const cfg = loadConfig("./config/machine.<local>.json");
const r = await machineRequest(cfg, "<target-machine>", "/v1/submit-peer-job", {
  from_agent: "test",
  to_agent: "test",
  persist_output: true,
  script: "#!/usr/bin/env bash\necho ok\n"
});
console.log(r);
'
```

Then poll `remote_job_output` with the returned `job_id` until `state` is terminal.
