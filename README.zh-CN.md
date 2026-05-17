# Symmetric mTLS MCP Machine Kit

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-555555)
![Security](https://img.shields.io/badge/Security-mTLS-blue)
![Network](https://img.shields.io/badge/Reachability-Tailscale%20%7C%20Public%20%7C%20Tunnel-7B61FF)
[![Docs: EN](https://img.shields.io/badge/Docs-English-blue)](./README.md)

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个面向新手的工具包：用 **mTLS** 把**你自己的机器**连接起来，并把它们暴露给支持 MCP 的 agent；机器之间的可达性可以通过 **Tailscale、公网地址或反向隧道**来提供。

有了这个项目，agent 可以：
- 给另一台机器上的 agent 发送通知
- 提交远程任务并读取输出
- 读取目标机器允许工作区内的文件
- 用 **mTLS 证书**维持机器之间的信任边界

这个项目刻意保持小而清晰。它**不是** VPN、CI 系统，也不是完整编排平台。

---

## 为什么会有这个项目

很多 agent 栈都能调用 MCP 工具，但它们仍然缺少一层安全能力，用来：
- 到达另一台机器
- 证明那台机器可信
- 在受限工作区里执行任务
- 把消息路由到该机器上的特定 worker / profile

这个仓库补上的，就是这一层。

安装时可以这样理解：
- `README.md` / `README.zh-CN.md` 负责讲清概念
- `docs/skill/peer-ops-setup.md` 才是实际安装与落地指南

---

## 先读这 4 个核心概念

如果你是第一次接触，先理解这四件事，再开始跑命令。

## 架构一览

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

这张图的意思是：
- 每个 **Machine** 是外层大盒子
- 每台机器里同时有 **Agent** 和 **Daemon**，二者双向配合
- 机器与机器之间通过你选择的网络路径通信
- daemon 是网络 / 信任边界，agent 是后面的逻辑 worker

### 1）什么是 CA？

**CA** 是 **Certificate Authority（证书颁发机构）**。

在这个项目里，CA 是你的私有信任根。你创建一次，然后用它给每台机器签发证书。

当机器 A 连机器 B 时：
- A 出示自己的证书
- B 出示自己的证书
- 双方都验证对方证书是不是由同一个 CA 签出来的

这就是 **mutual TLS（mTLS）**。

你可以把 CA 理解成你自己掌控的一枚私章。只要机器拿着这枚私章签出的证书，它就属于你的可信网络。

重要：
- `ca.crt` = CA 公钥证书，可以分发给其他机器
- `ca.key` = CA 私钥，**绝不能提交、绝不能公开**

---

### 2）什么是 machine name？

**machine name** 是你网络里某个 daemon 实例的身份名。

例子：
- `laptop`
- `vps-tokyo`
- `home-mini`

规则：
- 只用字母、数字、`.`、`_`、`-`
- 保证全局唯一
- 尽量短，日志里好认

machine name 会被用于：
- 证书身份（CN）
- 配置里的路由 key
- daemon 校验的机器身份

它**不必**和你的操作系统 hostname 完全一致。

---

### 3）什么是 agent name？

**agent** 是某台机器后面的一个逻辑 worker。

一台机器可以挂多个 agent。

例子：
- `laptop` 这台机器上有 `writer`、`ops`
- `vps` 这台机器上有 `worker`、`reze`

agent name 主要用于：
- 用 `to_agent` 路由通知
- 做 Telegram 路由映射
- 把某个名字映射到 Hermes profile / home

好的 agent name 应该短、职责清楚，比如：
- `ops`
- `reviewer`
- `worker`
- `reze`

---

### 4）机器之间怎么互通？

这个项目**不会自己创建网络**。你必须自己决定机器之间如何可达。

常见方式：

| 可达方式 | 适合场景 | 示例 URL |
|---|---|---|
| 公网 IP / DNS | VPS 或有公网入口的服务器 | `https://your-vps.example.com:8443` |
| Tailscale | 多台机器放在同一个私有 mesh 里 | `https://100.x.y.z:8443` |
| Reverse SSH tunnel | 机器在 NAT 后面，无法直接入站 | `https://relay.example.com:18443` |

重要：
- **网络方式**只负责“能到达”
- **证书 / mTLS**才负责“能信任”

所以即使你用了 Tailscale 或反向隧道，真正的信任边界仍然是机器证书。

---

## 开始前你需要准备什么

先准备这些：

- 2 台能以某种方式互通的机器
- 两边都装好 Node.js
- 如果你想用 `hermes mcp add` 注册 MCP，就装好 Hermes
- 先想好 machine names
- 先想好 agent names
- 有一个本地存放 secret 的位置（不要进 git）

可选：
- Telegram bot token / chat ID，用于按 agent 通知

---

## 第一次搭建时推荐怎么命名

如果你现在还没思路，先用最简单的。

### machine names 示例
- `laptop`
- `vps`

### agent names 示例
- 在 `laptop` 上：`laptop`
- 在 `vps` 上：`worker`

以后随时可以继续加 agent。

---

## 首次跑通：连接两台机器

这是给新手的最短路径。

### Step 1：克隆并安装

在两台机器上都执行：

```bash
git clone <repo-url> bash-task-kit
cd bash-task-kit
npm ci
```

---

### Step 2：生成 CA 和机器证书

先在**一台可信机器**上做这一步。

```bash
./scripts/generate-certs.sh --ca-role init "$PWD" laptop vps
```

会生成：
- `certs/ca/ca.crt`
- `certs/ca/ca.key`
- `certs/laptop/peer.crt`
- `certs/laptop/peer.key`
- `certs/vps/peer.crt`
- `certs/vps/peer.key`

然后按需分发：

### 每台运行机器需要的文件
- `certs/ca/ca.crt`
- `certs/<self>/peer.crt`
- `certs/<self>/peer.key`

### 必须只留在 CA 机器上的文件
- `certs/ca/ca.key`

`certs/` 绝不能提交进仓库。

---

### Step 3：选择你的可达方式

三选一即可：

#### Option A — 公网 VPS
如果有一台机器有公网地址，就在 topology 里填它的公网 URL。

#### Option B — Tailscale
如果两台机器都在同一个 Tailscale 网络里，就填 Tailscale IP 或 MagicDNS 名称。

#### Option C — 反向隧道
如果一台机器在 NAT 后面，无法直接被入站访问，就通过 relay 端口暴露出来，并在 topology 里使用那个 relay URL。

你只需要一条能工作的路径。这个仓库**不强制**某一种传输方式。

---

### Step 4：编辑 topology

从这个文件开始：

- `config/topology.example.yaml`

这个文件定义：
- machine names
- 监听端口
- peer URLs
- 本地 agents
- 可选的 Telegram 环境变量引用

示例思路：
- `laptop` 的 endpoint 是 `https://100.64.0.10:8443`
- `vps` 的 endpoint 是 `https://100.64.0.20:8443`
- `vps` 还挂了一个 agent：`worker`

---

### Step 5：渲染每台机器自己的配置

每台机器都要各自生成自己的 runtime config。

在 laptop 上：

```bash
node core/render-machine-config.js \
  --topology ./config/topology.example.yaml \
  --self laptop \
  --out ./config/machine.laptop.json
```

在 VPS 上：

```bash
node core/render-machine-config.js \
  --topology ./config/topology.example.yaml \
  --self vps \
  --out ./config/machine.vps.json
```

`config/machine.*.json` **不要提交**。

---

### Step 6：启动 daemon

每台机器执行：

```bash
node core/peer-daemon.js ./config/machine.<your-machine>.json
```

示例：

```bash
node core/peer-daemon.js ./config/machine.laptop.json
node core/peer-daemon.js ./config/machine.vps.json
```

---

### Step 7：注册 MCP

如果你用 Hermes：

```bash
hermes mcp add bash-task-peer \
  --command node \
  --args "$PWD/core/mcp-server.js" "$PWD/config/machine.<your-machine>.json"
```

这样会把你的 machine network 暴露成 MCP 工具。

---

### Step 8：验证是否成功

第一条成功标准很简单：
- 用一个 MCP 工具，比如 `remote_submit_job`
- 目标设为另一台机器
- 能拿到 `job_id`
- 再用 `remote_job_output` 读输出

如果这一步通了，就说明你的机器互信和执行链路已经活了。

---

## 可选：Telegram 路由

Telegram 路由是可选的。

如果你要按 agent 做 Telegram 通知：
- token 不要进 git
- secret 只本地存
- 在配置里用环境变量引用

参考：
- `docs/AGENT_TELEGRAM_ROUTING.md`
- `docs/skill/peer-ops-setup.md`

---

## 这个仓库里提供的 MCP 工具

### 远程机器操作
- `remote_submit_job`
- `remote_upload_and_run`
- `remote_read_file`
- `remote_job_status`
- `remote_job_output`

### Agent 通知
- `notify_machine_agent`

### 本地辅助
- `local_workspace_read_file`

---

## 仓库结构

- `core/peer-daemon.js` — 基于 HTTPS + mTLS 的 machine daemon
- `core/mcp-server.js` — stdio MCP server
- `core/peer-lib.js` — 公共 helper
- `core/render-machine-config.js` — 从 topology 渲染 runtime config
- `config/machine.example.json` — 单机配置示例
- `config/topology.example.yaml` — topology 示例
- `scripts/generate-certs.sh` — 生成 CA + machine certs
- `scripts/bootstrap-two-machine.sh` — 两机引导脚本
- `scripts/agent-dispatch-hook.py` — 可选的 push hook
- `launch/` — 通用 launchd / systemd / tunnel 模板
- `docs/AGENT_TELEGRAM_ROUTING.md` — Telegram 路由说明
- `docs/skill/peer-ops-setup.md` — 面向新手的主安装 runbook

---

## 安全模型

### 身份认证
- machine daemon 强制要求 mTLS
- machine certificate CN 必须在 `allowed_machine_names` 里
- 请求身份必须和证书 CN 一致

### 工作区约束
- 读取路径必须是相对路径
- 拒绝绝对路径
- 拒绝 `..` 越界
- realpath 解析后必须仍在 `workspace_dir` 里面
- 上传 archive 内部的 symlink 会被拒绝

### 执行范围
- 上传 archive 会解包到 `job_dir/<job_id>/input/`
- 只执行你提供的相对 `entrypoint`
- stdout / stderr / status 都留在该 job 目录中

---

## 这个公开仓库里故意不包含什么

这个开源树刻意排除了：
- 私有证书 / CA 材料
- 真实机器配置
- 运行日志和 state
- 机器专属的 launchd / systemd 实例
- 内联 Telegram secret

只用模板，真实 secret 一律本地保存。

---

## 开发检查

```bash
npm run lint
npm test
python3 -m py_compile scripts/agent-dispatch-hook.py
```

---

## 建议继续阅读

- `docs/skill/peer-ops-setup.md` — 大多数用户真正需要的唯一安装指南
- `SECURITY.md`
