# Open-source One-Skill Setup (Peer Ops)

> 目标：让一个子 Agent 只靠这个 skill，就能在**两台机器**上完成 bash-task-kit 的安全配置与验收。
>
> 约束：不依赖 SSH 自动化；不在仓库存放明文 token/chat id/私钥；默认 mTLS 为信任边界。

## 0) 先给主人的提示（必须）

开始前先提示主人准备：

- 两台机器可互通的地址方案（公网 / Tailscale / 隧道）
- 每个 agent 的 Telegram bot token
- 每个 agent 的 Telegram chat id（先和 bot 对话一次）
- 每台机器上的 Hermes Home 路径

并明确：

- token/chat id 只放本地 secret 文件，不进 git
- 证书私钥不进 git
- machine config 里的 `agent_telegram_map` 必须覆盖每个 `to_agent`（本项目已禁用 TG fallback）

---

## 1) 目录与 secret 文件规范（强制）

每台机器本地保存 secret：

```bash
${XDG_CONFIG_HOME:-$HOME/.config}/bash-task-kit/<machine_name>/telegram.env
```

示例：

- `~/.config/bash-task-kit/rice/telegram.env`
- `~/.config/bash-task-kit/kobune/telegram.env`

权限：

```bash
chmod 700 "${XDG_CONFIG_HOME:-$HOME/.config}/bash-task-kit"
chmod 700 "${XDG_CONFIG_HOME:-$HOME/.config}/bash-task-kit/<machine_name>"
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/bash-task-kit/<machine_name>/telegram.env"
```

---

## 2) Telegram token/chat-id 采集流程（给主人）

### 2.1 让主人输入 token（隐藏输入）

```bash
read -rsp "Telegram bot token: " TG_BOT_TOKEN; echo
[ -n "$TG_BOT_TOKEN" ] || { echo "empty token"; exit 2; }
```

### 2.2 引导主人先给 bot 发一条消息，然后抓 chat id

```bash
curl -fsS "https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
 const j=JSON.parse(s); const a=j.result||[];
 for(let i=a.length-1;i>=0;i--){
   const m=a[i].message||a[i].edited_message||a[i].channel_post;
   if(m&&m.chat&&m.chat.id){ console.log(String(m.chat.id)); return; }
 }
 process.exit(3);
});'
```

### 2.3 写入本地 secret 文件（示例）

```bash
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/bash-task-kit/<machine_name>/telegram.env" <<'EOF'
KOBUNE_TG_BOT_TOKEN=<fill>
KOBUNE_TG_CHAT_ID=<fill>
REZE_TG_BOT_TOKEN=<fill>
REZE_TG_CHAT_ID=<fill>
RICE_TG_BOT_TOKEN=<fill>
RICE_TG_CHAT_ID=<fill>
EOF
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/bash-task-kit/<machine_name>/telegram.env"
```

---

## 3) 证书生成与分发（安全版）

在可信机器生成证书：

```bash
./scripts/generate-certs.sh --ca-role init "$PWD" <machine_name_a> <machine_name_b>
chmod 700 ./certs ./certs/ca ./certs/<machine_name_a> ./certs/<machine_name_b>
chmod 600 ./certs/ca/ca.key ./certs/<machine_name_a>/peer.key ./certs/<machine_name_b>/peer.key
```

若是第二台机器加入已有 CA，则改用：

```bash
./scripts/generate-certs.sh --ca-role join --ca-pin <sha256fp> "$PWD" <machine_name_a> <machine_name_b>
```

运行机只需要：

- `certs/ca/ca.crt`
- `certs/<self>/peer.crt`
- `certs/<self>/peer.key`

`ca.key` 不应下发到运行机。

---

## 4) 双机（非 SSH）安装流程

每台机器各自执行：

```bash
git clone <repo-url> bash-task-kit
cd bash-task-kit
npm ci
```

准备 `config/topology.example.yaml`（只写 env 名，不写 token/chat id），再渲染：

```bash
node core/render-machine-config.js --topology ./config/topology.example.yaml --self <machine_name> --out ./config/machine.<machine_name>.json
```

启动 daemon：

```bash
node core/peer-daemon.js ./config/machine.<machine_name>.json
```

注册 MCP：

```bash
printf 'Y\n' | hermes mcp remove bash-task-peer || true
printf 'Y\n' | hermes mcp add bash-task-peer --command node --args "$PWD/core/mcp-server.js" "$PWD/config/machine.<machine_name>.json"
hermes mcp list
```

---

## 5) Telegram 路由硬要求（本项目当前实现）

- 必须在 machine config 中配置 `agent_telegram_map`
- 必须提供每个目标 agent 的 token/chat id
- **不允许依赖 `TG_BOT_TOKEN/TG_CHAT_ID` fallback**（已禁用，防串号）

---

## 6) 验收标准（给外部验收人）

### 6.1 基础

- `node --check core/peer-daemon.js core/mcp-server.js core/peer-lib.js core/render-machine-config.js`
- `python3 -m py_compile scripts/agent-dispatch-hook.py`

### 6.2 远程作业链路

- `remote_submit_job` 返回 `job_id`
- `remote_job_output` 能读到预期 stdout（默认工具调用应保留输出，必要时显式传 `persist_output: true`）

### 6.3 A2A 通知链路

- `notify_machine_agent` 可达目标 machine
- 目标端 `log/jobs/` 或配置的 `job_dir` 下有对应记录

### 6.4 Telegram 三 agent 路由

- kobune / reze / rice 各自 bot 身份分离（`getMe` username 不同或符合预期）
- 每个 agent 消息只从其指定 bot 发出
- 若任一 agent 缺失 route，任务应报错而不是 fallback 到别的 bot

---

## 7) 子 Agent 执行时的输出模板

建议固定输出：

- machine A machine_name / machine B machine_name
- topology 来源与渲染输出路径
- secret 文件路径（不显示内容）
- cert 安装路径（不显示私钥内容）
- daemon 状态
- MCP 注册状态
- 验收每一项通过/失败
- 剩余手动步骤
