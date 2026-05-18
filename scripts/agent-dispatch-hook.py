#!/usr/bin/env python3
import json
import os
import shlex
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request


FALLBACK_HERMES_PATHS = [
    '/opt/homebrew/bin/hermes',
    '/usr/local/bin/hermes',
    os.path.expanduser('~/.local/bin/hermes'),
]


def sh_quote(text: str) -> str:
    return shlex.quote(text)


def parse_agent_telegram_map() -> dict:
    raw = os.environ.get('PEER_AGENT_TELEGRAM_MAP', '').strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f'PEER_AGENT_TELEGRAM_MAP must be a JSON object: {exc}') from exc
    if not isinstance(data, dict):
        raise ValueError('PEER_AGENT_TELEGRAM_MAP must be a JSON object')
    return data


def resolve_agent_telegram(to_agent: str) -> tuple[str, str]:
    route = parse_agent_telegram_map().get(to_agent)
    if route is None:
        raise ValueError(
            f'Telegram route for agent {to_agent} is missing in PEER_AGENT_TELEGRAM_MAP; '
            'fallback TG_BOT_TOKEN/TG_CHAT_ID is disabled to prevent cross-agent misrouting'
        )
    if not isinstance(route, dict):
        raise ValueError(f'PEER_AGENT_TELEGRAM_MAP.{to_agent} must be an object')
    token_env = str(route.get('bot_token_env') or '').strip()
    chat_env = str(route.get('chat_id_env') or '').strip()
    bot_token = str(route.get('bot_token') or '').strip()
    chat_id = str(route.get('chat_id') or '').strip()
    if token_env:
        # Env refs are preferred, but an inline value may be present as a runtime
        # overlay when a service manager cannot be updated in-place. Do not
        # clobber a valid inline value with an unset environment variable.
        bot_token = os.environ.get(token_env, '').strip() or bot_token
    if chat_env:
        chat_id = os.environ.get(chat_env, '').strip() or chat_id
    if not bot_token or not chat_id:
        raise ValueError(
            f'Telegram route for agent {to_agent} requires bot token and chat id '
            '(use bot_token_env/chat_id_env or bot_token/chat_id)'
        )
    return bot_token, chat_id


def send_telegram(text: str, to_agent: str = ''):
    try:
        bot_token, chat_id = resolve_agent_telegram(to_agent)
    except ValueError as exc:
        print(f'[agent-dispatch-hook] telegram skipped: {exc}', file=sys.stderr)
        return
    if not bot_token or not chat_id:
        return
    base = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    data = urllib.parse.urlencode({
        'chat_id': chat_id,
        'text': text,
        'disable_web_page_preview': 'true',
    }).encode('utf-8')
    req = urllib.request.Request(base, data=data, method='POST')
    with urllib.request.urlopen(req, timeout=20) as resp:
        resp.read()


def decode_stream(value) -> str:
    if value is None:
        return ''
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    return str(value)


def trim_block(text: str, limit: int) -> str:
    text = text.strip()
    if not text:
        return ''
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n...[truncated]"


def resolve_hermes_bin() -> str:
    configured = os.environ.get('PEER_AGENT_HERMES_BIN', '').strip()
    if configured:
        if os.path.sep in configured:
            expanded = os.path.expanduser(configured)
            if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
                return expanded
            raise FileNotFoundError(f'Hermes binary not executable: {expanded}')
        resolved = shutil.which(configured)
        if resolved:
            return resolved
        raise FileNotFoundError(f'Hermes binary not found on PATH: {configured}')

    resolved = shutil.which('hermes')
    if resolved:
        return resolved

    for candidate in FALLBACK_HERMES_PATHS:
        expanded = os.path.expanduser(candidate)
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded

    searched = ', '.join(FALLBACK_HERMES_PATHS)
    raise FileNotFoundError(
        'Hermes binary not found. Set PEER_AGENT_HERMES_BIN or install hermes on PATH. '
        f'Searched PATH plus fallback paths: {searched}'
    )


def parse_agent_profile_map() -> dict:
    raw = os.environ.get('PEER_AGENT_PROFILE_MAP', '').strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f'PEER_AGENT_PROFILE_MAP must be a JSON object: {exc}') from exc
    if not isinstance(data, dict):
        raise ValueError('PEER_AGENT_PROFILE_MAP must be a JSON object')
    return {str(k): str(v) for k, v in data.items() if str(k)}


def resolve_hermes_home_for_agent(to_agent: str) -> str:
    profile_map = parse_agent_profile_map()
    mapped = profile_map.get(to_agent, '').strip()
    if mapped:
        return os.path.expanduser(mapped)

    template = os.environ.get('PEER_AGENT_HERMES_HOME_TEMPLATE', '').strip()
    if template:
        safe_to_agent = ''.join(ch for ch in to_agent if ch.isalnum() or ch in '._-')
        if not safe_to_agent or safe_to_agent != to_agent:
            raise ValueError(f'unsafe to_agent for PEER_AGENT_HERMES_HOME_TEMPLATE: {to_agent}')
        return os.path.expanduser(template.format(to_agent=safe_to_agent))

    hermes_home = os.environ.get('PEER_AGENT_HERMES_HOME', '').strip()
    if hermes_home:
        return os.path.expanduser(hermes_home)
    return ''


def build_run_env(to_agent: str) -> dict:
    env = dict(os.environ)
    env['HOME'] = os.environ.get('PEER_AGENT_HOME', os.path.expanduser('~'))
    hermes_home = resolve_hermes_home_for_agent(to_agent)
    if hermes_home:
        env['HERMES_HOME'] = hermes_home
    return env


def run_command(argv, timeout_sec: int, env: dict) -> tuple[int, str, str, bool]:
    try:
        proc = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_sec,
            check=False,
            env=env,
        )
        return proc.returncode, proc.stdout or '', proc.stderr or '', False
    except subprocess.TimeoutExpired as exc:
        return (
            124,
            decode_stream(exc.stdout),
            decode_stream(exc.stderr),
            True,
        )


def format_completion_message(status: str, from_agent: str, to_agent: str, thread_id: str, message_id: str, stdout_text: str, stderr_text: str) -> str:
    sections = []
    trimmed_stdout = trim_block(stdout_text, 3000)
    trimmed_stderr = trim_block(stderr_text, 1500)

    if trimmed_stdout:
        sections.append(trimmed_stdout)
    else:
        sections.append('(no stdout)')

    if trimmed_stderr:
        sections.append(f'[stderr]\n{trimmed_stderr}')

    body = '\n\n'.join(sections)
    return (
        f"[peer-agent] 任务完成 {status}\n"
        f"from={from_agent} to={to_agent}\n"
        f"thread={thread_id}\n"
        f"msg={message_id}\n"
        f"---\n{body}"
    )


def main():
    if len(sys.argv) < 2:
        print('usage: agent-dispatch-hook.py <agent-message.json>', file=sys.stderr)
        return 2

    msg_path = sys.argv[1]
    with open(msg_path, 'r', encoding='utf-8') as f:
        msg = json.load(f)

    from_agent = msg.get('from_agent', 'unknown')
    to_agent = msg.get('to_agent', 'unknown')
    thread_id = msg.get('thread_id') or '-'
    text = msg.get('text', '').strip()
    message_id = msg.get('message_id', '-')

    if not text:
        send_telegram(f"[peer-agent] empty task ignored\nmsg={message_id}", to_agent)
        return 1

    send_telegram(
        f"[peer-agent] 收到任务\nfrom={from_agent} to={to_agent}\nthread={thread_id}\nmsg={message_id}\n---\n{text}",
        to_agent,
    )

    timeout_sec = int(os.environ.get('PEER_AGENT_EXEC_TIMEOUT_SEC', '1800'))
    mode = os.environ.get('PEER_AGENT_EXEC_MODE', 'direct').strip().lower()
    try:
        env = build_run_env(to_agent)
    except ValueError as exc:
        send_telegram(
            f"[peer-agent] 任务完成 FAILED(2)\nfrom={from_agent} to={to_agent}\nthread={thread_id}\nmsg={message_id}\n---\n{exc}",
            to_agent,
        )
        print(str(exc), file=sys.stderr)
        return 2

    if mode == 'hermes':
        try:
            hermes_bin = resolve_hermes_bin()
        except FileNotFoundError as exc:
            send_telegram(
                f"[peer-agent] 任务完成 FAILED(127)\nfrom={from_agent} to={to_agent}\nthread={thread_id}\nmsg={message_id}\n---\n{exc}",
                to_agent,
            )
            print(str(exc), file=sys.stderr)
            return 127

        hermes_args = shlex.split(os.environ.get('PEER_AGENT_HERMES_ARGS', '--quiet'))
        argv = [hermes_bin, 'chat', '-q', text, *hermes_args]
    elif mode == 'notify':
        argv = ['/bin/bash', '-lc', f"printf '%s\\n' {sh_quote(text)}"]
    else:
        argv = ['/bin/bash', '-lc', text]

    returncode, stdout_text, stderr_text, timed_out = run_command(argv, timeout_sec, env)

    if timed_out:
        status = f'TIMEOUT({timeout_sec}s)'
    else:
        status = 'OK' if returncode == 0 else f'FAILED({returncode})'

    send_telegram(
        format_completion_message(
            status,
            from_agent,
            to_agent,
            thread_id,
            message_id,
            stdout_text,
            stderr_text,
        ),
        to_agent,
    )

    return returncode


if __name__ == '__main__':
    raise SystemExit(main())
