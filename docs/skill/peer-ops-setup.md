# One Skill to Install Everything: Peer Ops Setup

This is the **main setup skill** for this project.

If a user says:
- "install this"
- "set this up on two machines"
- "help me configure Tailscale / reverse tunnel / CA"
- "I know nothing, just guide me"

then this is the one file they should follow.

Goal:
- a beginner can use **this one skill** to finish setup
- the skill explains naming, CA, networking, config, daemonization, MCP registration, and optional reverse tunnel
- the skill tells the user **which directories and files must exist**
- the skill does **not** require the user to already understand CA / mTLS / Tailscale / agent naming

This is the canonical operator guide.

---

## 0. The simple mental model

This project has 4 layers:

1. **Machine name**
   - the network-visible daemon identity
   - examples: `laptop`, `vps`, `mini`

2. **Agent name**
   - a logical worker behind a machine
   - examples: `worker`, `ops`, `reviewer`

3. **CA + certificates**
   - how machines trust each other

4. **Reachability**
   - how machines find each other
   - examples: public IP, Tailscale, reverse SSH tunnel

If the user forgets everything else, remind them:

- **machine** = which daemon is this?
- **agent** = which worker behind the machine?
- **CA** = who signs trusted machine certificates?
- **Tailscale / tunnel / public IP** = how do the machines find each other?

---

## 1. What to ask the user first

Before touching files, collect these answers.

### Required
1. How many machines?
   - for beginners, default to **2 machines**
2. What should the machine names be?
   - suggest `laptop` and `vps` if the user does not care
3. How will the machines reach each other?
   - **public IP / DNS**
   - **Tailscale**
   - **reverse SSH tunnel**
4. Does each machine need only one agent, or multiple?
   - if unsure, suggest **one agent per machine**
5. What are the agent names?
   - if unsure, suggest same as machine on laptop, and `worker` on the server

### Optional
6. Does the user want Telegram notifications?
7. Does the user want background services immediately?
   - if yes, install launchd on macOS and systemd on Linux

---

## 2. How to help the user choose names

### Machine names
Rules:
- only letters, digits, `.`, `_`, `-`
- unique across the setup
- short and log-friendly

Good examples:
- `laptop`
- `vps`
- `home-mini`
- `tokyo-vps`

Bad examples:
- `my machine`
- `机器一`
- `../../etc`

### Agent names
Rules:
- short
- role-based
- easy to type in `to_agent`

Good examples:
- `worker`
- `ops`
- `reviewer`
- `writer`
- `reze`

Default beginner suggestion:
- machine `laptop` hosts agent `laptop`
- machine `vps` hosts agent `worker`

---

## 3. How to explain CA to a beginner

Say this plainly:

> A CA is your private trust root. You create it once. It signs certificates for each machine. If two machines both have certificates signed by the same CA, they can trust each other.

Then make the distinction explicit:

- `ca.crt` = public CA certificate, safe to copy
- `ca.key` = private CA key, never commit, never publish

What each runtime machine needs:
- `certs/ca/ca.crt`
- `certs/<self>/peer.crt`
- `certs/<self>/peer.key`

What should stay private on the CA machine:
- `certs/ca/ca.key`

---

## 4. Required directory layout

Before the user starts, show them this exact directory idea:

```text
bash-task-kit/
├── certs/
│   ├── ca/
│   │   ├── ca.crt
│   │   └── ca.key              # keep private; do not commit
│   ├── laptop/
│   │   ├── peer.crt
│   │   └── peer.key            # private; do not commit
│   └── vps/
│       ├── peer.crt
│       └── peer.key            # private; do not commit
├── config/
│   ├── topology.example.yaml
│   ├── topology.yaml           # user-created live topology
│   ├── machine.laptop.json     # rendered; do not commit
│   └── machine.vps.json        # rendered; do not commit
├── core/
├── scripts/
├── launch/
├── log/                        # runtime output; do not commit
└── state/                      # runtime state; do not commit
```

Key rule:
- **all certificate material lives under `certs/`**
- **the CA lives under `certs/ca/`**
- **each machine gets its own subdirectory under `certs/<machine-name>/`**

---

## 5. Reachability decision tree

Use this exact decision tree.

### Case A — both machines can directly reach each other
Use:
- public IP / DNS
- or Tailscale

No reverse tunnel needed.

### Case B — one machine is behind NAT and cannot accept inbound traffic
Use:
- reverse SSH tunnel
- the reachable relay endpoint becomes that machine's external URL in topology

### Case C — user has multiple Macs / VPS / mobile devices and wants the easiest long-term network
Use:
- Tailscale

Preferred beginner recommendation:
- **Tailscale first** if available
- **reverse tunnel second** if one machine is hidden behind NAT and no Tailscale is used

---

## 6. Install steps: the one-line plan

For two machines, the correct order is:

1. clone repo on both machines
2. install dependencies
3. choose machine names
4. choose agent names
5. choose reachability method
6. create CA and machine certs once
7. copy only required cert files to each runtime machine
8. edit `config/topology.example.yaml` into a real topology file
9. render per-machine config
10. start daemons
11. install background services if desired
12. register MCP
13. test one remote job
14. only then add Telegram routing if needed

Do not start with Telegram, ring tests, or complex multi-agent routing.

---

## 7. Actual commands to run

### 7.1 Clone and install
On both machines:

```bash
git clone <repo-url> bash-task-kit
cd bash-task-kit
npm ci
```

### 7.2 Create required directories
If they do not already exist:

```bash
mkdir -p certs/ca certs/laptop certs/vps config log state
```

Replace `laptop` / `vps` with the real machine names if different.

### 7.3 Generate CA and certs
Run on one trusted machine:

```bash
./scripts/generate-certs.sh --ca-role init "$PWD" laptop vps
```

If adding another machine later using an existing CA, use join mode with CA pin checking.

### 7.4 Copy cert files to each runtime machine
For each runtime machine, copy:
- `certs/ca/ca.crt`
- `certs/<self>/peer.crt`
- `certs/<self>/peer.key`

Do **not** copy `certs/ca/ca.key` to every runtime machine.

### 7.5 Edit topology
Start from:

- `config/topology.example.yaml`

Create a live file such as:

- `config/topology.yaml`

Change:
- machine names
- URLs
- local Hermes paths
- optional agent names
- optional Telegram env-var names

### 7.6 Render config
On each machine:

```bash
node core/render-machine-config.js \
  --topology ./config/topology.yaml \
  --self <machine-name> \
  --out ./config/machine.<machine-name>.json
```

### 7.7 Start daemon

```bash
node core/peer-daemon.js ./config/machine.<machine-name>.json
```

### 7.8 Register MCP
If using Hermes:

```bash
hermes mcp add bash-task-peer \
  --command node \
  --args "$PWD/core/mcp-server.js" "$PWD/config/machine.<machine-name>.json"
```

---

## 8. Background services: what to do by OS

### macOS
Use:
- `launch/install-launchd.sh`
- `launch/launchd/com.example.machine-daemon.plist`

Recommended beginner path:
- first verify the daemon works in foreground
- then install launchd

### Linux
Use:
- `launch/systemd/machine-daemon.service`

Recommended beginner path:
- first verify foreground works
- then install systemd service

---

## 9. Reverse SSH tunnel: when and how

Use a reverse tunnel only if a machine cannot accept inbound traffic directly.

Then:
- local daemon may still listen on `127.0.0.1:8443` or the chosen local port
- the relay exposes a remote bind port
- the topology URL for that machine should point at the relay endpoint, not the hidden local address

Use the generic template:
- `launch/tunnels/ssh-reverse-tunnel.service`

Important beginner warning:
- reverse tunnel gives **reachability only**
- certificates still give **trust**

If the user already uses Tailscale, usually skip reverse tunnel entirely.

---

## 10. Tailscale: how to explain it here

Say this:

> Tailscale is a network underlay. It helps machines find each other. This project still uses mTLS certificates for trust and MCP tools for machine actions.

If both machines are in one Tailscale network:
- use Tailscale IP or MagicDNS in topology URLs
- do not add reverse tunnel unless you have a special reason

---

## 11. Telegram routing: only after base path works

Do not start with Telegram.

Only add Telegram after:
- both daemons start
- one remote job works
- MCP registration is confirmed

If Telegram is needed:
- keep secrets local
- never commit bot tokens or chat IDs
- use env-var references in config

Recommended secret file:

```bash
~/.config/bash-task-kit/<machine-name>/telegram.env
```

---

## 12. First validation target

The first success test is:
- machine A calls `remote_submit_job` on machine B
- gets back a `job_id`
- machine A calls `remote_job_output`
- sees expected stdout

This proves:
- network path works
- CA trust works
- certificates are correct
- daemon is running
- MCP registration is correct

This is the correct beginner milestone.

---

## 13. What this skill should tell the user not to do

Warn clearly:

- do not commit `certs/`
- do not commit `ca.key`
- do not commit `peer.key`
- do not commit live `config/machine.*.json`
- do not start with Telegram before base connectivity works
- do not add reverse tunnel if Tailscale already solves the path
- do not overcomplicate names at the beginning

---

## 14. If the user says “just do it for me”

This skill should drive the implementation in this order:

1. ask for machine count
2. ask for machine names
3. ask for agent names
4. ask for reachability method
5. choose Tailscale / public / reverse tunnel path
6. generate CA and certs
7. prepare topology
8. render configs
9. start daemons
10. install launchd/systemd if requested
11. install reverse tunnel if chosen
12. register MCP
13. run first validation
14. only then add Telegram

This is the one-skill path.

---

## 15. The shortest beginner recommendation

If the user truly has no preferences, recommend this:

- machine names: `laptop`, `vps`
- agent names: `laptop`, `worker`
- reachability: **Tailscale**
- one CA for both machines
- foreground daemon test first
- background services second
- Telegram last

That is the simplest reliable setup.
