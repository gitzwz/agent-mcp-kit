# Symmetric mTLS MCP Machine Kit

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

---

### Step 5: render per-machine config

On each machine, render its own runtime config.

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

Your first success condition is simple:
- use an MCP tool such as `remote_submit_job`
- target the other machine
- get back a `job_id`
- read output with `remote_job_output`

If that works, your machine-to-machine trust and execution path is alive.

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
