# Agent Telegram Routing

Agent notification push mode can optionally send Telegram status messages before and after the hook runs. For open-source deployments, Telegram credentials must be explicit and should be passed through environment variables, not committed into config files.

## Why this exists

`notify_machine_agent` routes a message to a machine daemon. The payload contains `to_agent`, but that value does not automatically imply a Telegram bot or chat.

Without per-agent routing, messages can be misrouted across agents. For this reason `scripts/agent-dispatch-hook.py` now fails closed when `agent_telegram_map[to_agent]` is missing.

## Required variables

For each agent that must emit Telegram messages, configure both:

- bot token: the Telegram bot API token for that agent/sender
- chat id: the Telegram chat/user/group id to receive messages

Recommended naming:

```bash
export KOBUNE_TG_BOT_TOKEN='<kobune bot token>'
export KOBUNE_TG_CHAT_ID='<telegram chat id>'
export RICE_TG_BOT_TOKEN='<rice bot token>'
export RICE_TG_CHAT_ID='<telegram chat id>'
export REZE_TG_BOT_TOKEN='<reze bot token>'
export REZE_TG_CHAT_ID='<telegram chat id>'
```

Never commit real tokens. Commit only env-var names or redacted placeholders.

## Runtime config

Use `agent_telegram_map` in the rendered machine config:

```json
{
  "agent_telegram_map": {
    "kobune": {
      "bot_token_env": "KOBUNE_TG_BOT_TOKEN",
      "chat_id_env": "KOBUNE_TG_CHAT_ID"
    },
    "rice": {
      "bot_token_env": "RICE_TG_BOT_TOKEN",
      "chat_id_env": "RICE_TG_CHAT_ID"
    },
    "reze": {
      "bot_token_env": "REZE_TG_BOT_TOKEN",
      "chat_id_env": "REZE_TG_CHAT_ID"
    }
  }
}
```

The hook also supports `bot_token` and `chat_id` inline for private, non-committed local runtime configs, but env-var references are preferred for open-source repos. `core/render-machine-config.js` intentionally renders only env-var references from `topology.yaml` so generated configs do not accidentally bake in secrets.

## Topology source

When using a topology file, define Telegram routing under each machine's `agents` map:

```json
{
  "machines": {
    "kobune": {
      "agents": {
        "kobune": {
          "hermes_home": "/root/.hermes",
          "telegram": {
            "bot_token_env": "KOBUNE_TG_BOT_TOKEN",
            "chat_id_env": "KOBUNE_TG_CHAT_ID"
          }
        },
        "reze": {
          "hermes_home": "/root/.hermes/profiles/reze",
          "telegram": {
            "bot_token_env": "REZE_TG_BOT_TOKEN",
            "chat_id_env": "REZE_TG_CHAT_ID"
          }
        }
      }
    }
  }
}
```

`core/render-machine-config.js` renders this into:

- `agent_profile_map` for Hermes profile routing
- `agent_telegram_map` for Telegram sender/chat routing

For each local agent, both keys are emitted:

- `<agent>` (example: `reze`)
- `<machine>.<agent>` (example: `kobune.reze`)

## Fail-closed behavior (no fallback)

The hook no longer falls back to daemon-wide `TG_BOT_TOKEN` / `TG_CHAT_ID` for missing routes. If `agent_telegram_map[to_agent]` is absent or incomplete, the task fails with an explicit error to prevent cross-agent misrouting.

Operational requirement:

- Every expected `to_agent` must be declared in `agent_telegram_map`.
- Each route must provide both token and chat id (prefer env-var references).

## Acceptance checklist

For each expected route key (plain `agent` or scoped `machine.agent`) verify all of the following:

- [ ] each expected `to_agent` exists in `agent_telegram_map`
- [ ] every route has both token and chat id, preferably by env-var references
- [ ] the receiving daemon environment actually contains those env vars
- [ ] Telegram output proves distinct senders or distinct agent labels
- [ ] final summary includes message ids / hook job ids for every member

If all messages appear from the same bot, inspect `agent_telegram_map` and the runtime env map. In current fail-closed mode this should surface as an explicit missing/invalid-route error rather than silently falling back.
