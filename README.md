# Symmetric mTLS MCP Machine Kit

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-555555)
![Security](https://img.shields.io/badge/Security-mTLS-blue)
![Network](https://img.shields.io/badge/Reachability-Tailscale%20%7C%20Public%20%7C%20Tunnel-7B61FF)
[![Docs: 中文](https://img.shields.io/badge/Docs-%E4%B8%AD%E6%96%87-red)](./README.zh-CN.md)

[English](./README.md) | [简体中文](./README.zh-CN.md)

> 部署在每台机器上的 Daemon（MCP Server），把多台机器统一暴露给支持 MCP 的 Agent 管理；同时暴露各机器上的 Agent 名单，让 Agent 与 Agent 之间也能直接通信。

## Agent 侧能力

- **读取目标机器文件**：仅允许工作区内的相对路径。
- **提交远程任务并读取输出**：把任务发到指定机器执行，再拉回状态、stdout、stderr。
- **给另一台机器上的 Agent 发通知**：让 Agent 去通知 Agent，而不是让人重复同步每个窗口。

## 你可以用它做什么

- **只通过一个 Agent 管多台机器**  
  例如：在 Claude Code 或 Hermes 的对话里，直接说“诊断一下 xx 机器，把 xx 服务拉起”。
- **让 Agent 去通知 Agent**  
  例如：在 Agent1 的窗口里，让它通过 MCP 通知其他 Agent 安装某个 skill。
- **让 Agent Gateway 和 Daemon 双活**  
  某台机器上的 Agent Gateway 挂掉时，其他 Agent 仍可通过该机器上的 Daemon 把它拉起；反过来也成立。

## 设计思想

- **一个 Agent 负责一个垂直事项**。如果资源不够，就跨 laptop、VPS、Android 等设备调度资源；而不是在多台机器上跑一堆做同一件事的 Agent。
- **一件事只需要和一个 Agent 同步一次**。后续通知其他 Agent、分发执行、跨机器协同，都交给 Agent 自己处理。

## 使用方式

把 [`docs/skill/peer-ops-setup.md`](./docs/skill/peer-ops-setup.md) 交给你的 Agent，并告诉它：

- 你要 **init**（新建 CA），还是 **join**（加入已有 Daemon 集群）
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

## 为什么会有这个项目

很多时候，真正缺的不是另一个“大而全的平台”，而是一个足够轻、足够直接的运行层：

- 让 Agent 能安全地跨机器读文件、跑任务、取输出
- 让 Agent 能把事项继续分发给其他 Agent
- 让机器控制与 Agent 通信放在同一套最小闭环里

A beginner-friendly toolkit for connecting **your own machines** and exposing them to MCP-capable agents over **mTLS**, with reachability provided by **Tailscale, public endpoints, or reverse tunnels**.

With this project, an agent can:
- send a notification to an agent on another machine
- submit a remote job and read its output
- read files inside a machine's allowed workspace
- keep machine-to-machine trust anchored in **mTLS certificates**

This project is small on purpose. It is **not** a VPN, CI system, or full orchestration platform.

---

## Why this exists

Many agent stacks can call MCP tools, but they still need a safe way to:
- reach another machine
- prove that machine is trusted
- run a job in a constrained workspace
- route a message to a specific worker/profile on that machine

This repo provides that missing layer.

For installation, treat this README as the concept page, and treat `docs/skill/peer-ops-setup.md` as the real setup guide.

Operational default worth knowing:
- rendered configs opt into `job_partition_by_date: true`
- `job_output_max_bytes` is optional in config; if omitted, runtime falls back to **10 MiB (10485760 bytes)**

---

## Read this first: 4 ideas you need

If you're new, understand these four ideas before running commands.

## Architecture at a glance

```text
+----------------------------------------------------+
| Machine: laptop                                    |
|                                                    |
|   /-------------------\    <-->   /-------------\  |
|  | Agent: writer      |          | Daemon      |  |
|   \-------------------/          \-------------/  |
|                                                    |
+----------------------------------------------------+
               <========== machine-to-machine ==========>
+----------------------------------------------------+
| Machine: vps                                       |
|                                                    |
|   /-------------------\    <-->   /-------------\  |
|  | Agent: worker      |          | Daemon      |  |
|   \-------------------/          \-------------/  |
|                                                    |
+----------------------------------------------------+
               <========== machine-to-machine ==========>
+----------------------------------------------------+
| Machine: mini                                      |
|                                                    |
|   /-------------------\    <-->   /-------------\  |
|  | Agent: reviewer    |          | Daemon      |  |
|   \-------------------/          \-------------/  |
|                                                    |
+----------------------------------------------------+
```

What this picture means:
- each **Machine** is the big outer box
- inside each machine, an **Agent** and a **Daemon** are both active and talk both ways
- machines then talk to other machines over your chosen network path
- the daemon is the network/trust boundary, the agent is the logical worker behind it

### 1) What is a CA?

**CA** means **Certificate Authority**.

In this project, the CA is your private trust root. You create it once, and it signs certificates for each machine.

When machine A connects to machine B:
- A shows its certificate
- B shows its certificate
- both sides verify that the certificate was signed by the same CA

That is what gives you **mutual TLS (mTLS)**.

Think of the CA like a private stamp that only you control. Any machine with a certificate signed by that stamp is part of your trusted network.

Important:
- `ca.crt` = public CA certificate, safe to copy to other machines
- `ca.key` = CA private key, **never commit it, never publish it**

---

### 2) What is a machine name?

A **machine name** is the identity of one daemon instance on your network.

Examples:
- `laptop`
- `vps-tokyo`
- `home-mini`

Rules:
- use letters, digits, `.`, `_`, `-`
- keep it unique
- keep it short and recognizable in logs

The machine name becomes:
- the certificate identity (CN)
- the routing key inside config
- the identity checked by the daemon

A machine name does **not** have to match your OS hostname.

---

### 3) What is an agent name?

An **agent** is a logical worker behind a machine.

One machine can host multiple agents.

Examples:
- machine `laptop` hosts agents `writer` and `ops`
- machine `vps` hosts agents `worker` and `reze`

Use agent names when:
- routing notifications with `to_agent`
- mapping Telegram routes
- mapping a name to a Hermes profile/home

Good agent names are short and job-based:
- `ops`
- `reviewer`
- `worker`
- `reze`

---

### 4) How do machines reach each other?

This project does **not** create the network by itself. You must choose how machines reach each other.

Common choices:

| Reachability method | Best for | Example URL |
|---|---|---|
| Public IP / DNS | VPS or public server | `https://your-vps.example.com:8443` |
| Tailscale | Two or more machines in one private mesh | `https://100.x.y.z:8443` |
| Reverse SSH tunnel | A machine behind NAT that cannot accept inbound traffic directly | `https://relay.example.com:18443` |

Important:
- the **network method** only provides reachability
- the **certificates / mTLS** provide trust

So even if you use Tailscale or a tunnel, the trust boundary is still the machine certificate.

---

## What you need before you start

Prepare these first:

- 2 machines that can reach each other somehow
- Node.js installed on both
- Hermes installed if you want MCP registration via `hermes mcp add`
- a decision on machine names
- a decision on agent names
- a place to store secrets locally (not in git)

Optional:
- Telegram bot tokens / chat IDs for per-agent notifications

---

## Recommended naming for a first setup

If you know nothing yet, use something simple.

### Example machine names
- `laptop`
- `vps`

### Example agent names
- on `laptop`: `laptop`
- on `vps`: `worker`

You can always add more agents later.

---

## First run: connect two machines

This is the shortest path for beginners.

### Step 1: clone and install

On both machines:

```bash
git clone <repo-url> bash-task-kit
cd bash-task-kit
npm ci
```

---

### Step 2: create your CA and certificates

Do this on **one trusted machine** first.

```bash
./scripts/generate-certs.sh --ca-role init "$PWD" laptop vps
```

This creates:
- `certs/ca/ca.crt`
- `certs/ca/ca.key`
- `certs/laptop/peer.crt`
- `certs/laptop/peer.key`
- `certs/vps/peer.crt`
- `certs/vps/peer.key`

Copy only what each machine needs:

### What every runtime machine needs
- `certs/ca/ca.crt`
- `certs/<self>/peer.crt`
- `certs/<self>/peer.key`

### What should stay private on the CA machine
- `certs/ca/ca.key`

Never commit `certs/`.

---

### Step 3: choose your reachability

Pick one:

#### Option A — public VPS
If one machine has a public address, use its public URL in topology.

#### Option B — Tailscale
If both machines are in the same Tailscale network, use the Tailscale IP or MagicDNS name.

#### Option C — reverse tunnel
If one machine is behind NAT and cannot accept inbound traffic, expose it through a relay port and use that relay URL.

You only need one working path. This repo does not force one transport.

---

### Step 4: edit topology

Start from:

- `config/topology.example.yaml`

This file defines:
- machine names
- listen ports
- peer URLs
- local agents
- optional Telegram env-var references

Example idea:
- machine `laptop` has endpoint `https://100.64.0.10:8443`
- machine `vps` has endpoint `https://100.64.0.20:8443`
- machine `vps` also hosts agent `worker`

**Important path rule:** relative paths in the topology are written as if the rendered file will live under `config/`.
So use:
- `../certs/...`
- `../workspace`
- `../state`
- `../jobs`

Do **not** use `./certs/...` unless you really mean `config/certs/...`.

The renderer resolves these to **absolute paths** in `config/machine.<name>.json`, so each machine should render its own file locally.

---

### Step 5: render per-machine config

On each machine, render its own runtime config.
The rendered file contains **absolute paths**, so do not render once and scp that same file to a machine with a different filesystem layout.

On the laptop:

```bash
node core/render-machine-config.js \
  --topology ./config/topology.example.yaml \
  --self laptop \
  --out ./config/machine.laptop.json
```

On the VPS:

```bash
node core/render-machine-config.js \
  --topology ./config/topology.example.yaml \
  --self vps \
  --out ./config/machine.vps.json
```

Do **not** commit `config/machine.*.json`.

---

### Step 6: start the daemon

On each machine:

```bash
node core/peer-daemon.js ./config/machine.<your-machine>.json
```

Examples:

```bash
node core/peer-daemon.js ./config/machine.laptop.json
node core/peer-daemon.js ./config/machine.vps.json
```

---

### Step 7: register MCP

If you use Hermes:

```bash
hermes mcp add bash-task-peer \
  --command node \
  --args "$PWD/core/mcp-server.js" "$PWD/config/machine.<your-machine>.json"
```

This exposes the machine network as MCP tools.

---

### Step 8: verify it works

Start with **reachability and listening**, then test real work.

#### Minimal listen checks
On the target machine:

```bash
lsof -iTCP:8443 -sTCP:LISTEN -nP
```

From the peer machine:

```bash
nc -vz <peer-ip-or-host> 8443
```

If these fail, do **not** jump straight to MCP debugging yet — the daemon may simply not be listening.

#### Real acceptance
Your first success condition is simple:
- use an MCP tool such as `remote_submit_job`
- target the other machine
- get back a `job_id`
- read output with `remote_job_output`

If that works, your machine-to-machine trust and execution path is alive.

#### About `/v1/health`
Do **not** treat `GET /v1/health` as the acceptance standard here.
This repo's operator flow is built around real tool paths like `remote_submit_job` / `notify_machine_agent`, not a guaranteed health endpoint contract.

---

## Optional: Telegram routing

Telegram routing is optional.

If you want per-agent Telegram notifications:
- keep tokens out of git
- store secrets locally
- use environment-variable references in config

See:
- `docs/AGENT_TELEGRAM_ROUTING.md`
- `docs/skill/peer-ops-setup.md`

---

## Optional: push notify directly into Hermes

There are **two different modes** for agent notify delivery:

### 1) Mailbox only
If `PEER_AGENT_CHAT_HOOK` is **not** set:
- `notify_machine_agent` still writes a JSON record into `state/agent-chat/`
- the API returns `pushed=false`
- nothing is executed immediately

This is useful if another worker will poll the mailbox later.

### 2) Push to Hermes
If `PEER_AGENT_CHAT_HOOK` is set and points at `scripts/agent-dispatch-hook.py`:
- the message is still written into `state/agent-chat/`
- the hook is executed immediately
- the API returns `pushed=true`

For Hermes-backed delivery, set these environment variables on the **daemon service**, not just in your shell:

```text
PEER_AGENT_CHAT_HOOK=/absolute/path/to/scripts/agent-dispatch-hook.py
PEER_AGENT_EXEC_MODE=hermes
PEER_AGENT_HERMES_BIN=/absolute/path/to/hermes
PEER_AGENT_PROFILE_MAP={"to-agent":"/absolute/path/to/.hermes/profile"}
```

If you do not need per-agent profile routing, you may use a shared fallback instead:

```text
PEER_AGENT_HERMES_HOME=/absolute/path/to/default/.hermes/home
```

### macOS launchd example
Put these under `EnvironmentVariables` in your plist:

```xml
<key>PEER_AGENT_CHAT_HOOK</key><string>/absolute/path/to/scripts/agent-dispatch-hook.py</string>
<key>PEER_AGENT_EXEC_MODE</key><string>hermes</string>
<key>PEER_AGENT_HERMES_BIN</key><string>/usr/local/bin/hermes</string>
<key>PEER_AGENT_PROFILE_MAP</key><string>{"to-agent":"/Users/you/.hermes/profiles/to-agent"}</string>
```

After editing the plist, reload it with `launchctl bootout ... && launchctl bootstrap ...`.

### Why `pushed=false` matters
Interpret the API result like this:
- `pushed=false` = message stored, but no hook executed
- `pushed=true` = hook triggered

### MCP visibility note
Sometimes the parent session and a sub-agent / sub-Claude do **not** see the exact same MCP setup or permissions.
If direct MCP calls in one session fail but a child Claude run succeeds, verify MCP visibility **inside the actual target session too**, not only in the parent shell.

---

## MCP tools in this repo

### Remote machine operations
- `remote_submit_job`
- `remote_upload_and_run`
- `remote_read_file`
- `remote_job_status`
- `remote_job_output`

### Agent notification
- `notify_machine_agent`

### Local helper
- `local_workspace_read_file`

---

## Repository layout

- `core/peer-daemon.js` — HTTPS machine daemon with mTLS
- `core/mcp-server.js` — stdio MCP server
- `core/peer-lib.js` — shared helpers
- `core/render-machine-config.js` — render runtime config from topology
- `config/machine.example.json` — single-machine config example
- `config/topology.example.yaml` — topology example
- `scripts/generate-certs.sh` — generate CA + machine certs
- `scripts/bootstrap-two-machine.sh` — bootstrap helper
- `scripts/agent-dispatch-hook.py` — optional push hook
- `launch/` — generic launchd/systemd/tunnel templates
- `docs/AGENT_TELEGRAM_ROUTING.md` — Telegram routing guide
- `docs/skill/peer-ops-setup.md` — beginner setup skill / runbook

---

## Security model

### Authentication
- machine daemon requires mTLS
- machine certificate CN must be in `allowed_machine_names`
- request identity must match certificate CN

### Workspace confinement
- read paths must be relative
- absolute paths are rejected
- `..` escapes are rejected
- resolved realpaths must stay inside `workspace_dir`
- symlinks inside uploaded archives are rejected

### Execution scope
- uploaded archives are unpacked under `job_dir/<job_id>/input/`
- only the provided relative `entrypoint` is executed
- stdout / stderr / status remain under that job directory

---

## What is intentionally not in this public repo

This open-source tree excludes:
- private certificates / CA material
- live machine configs
- runtime logs and state
- machine-specific launchd/systemd instances
- inline Telegram secrets

Use templates only. Keep real secrets local.

---

## Development checks

```bash
npm run lint
npm test
python3 -m py_compile scripts/agent-dispatch-hook.py
```

---

## Suggested next reading

- `docs/skill/peer-ops-setup.md` — the only setup guide most users should need
- `SECURITY.md`
