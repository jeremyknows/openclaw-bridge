---
name: openclaw-bridge
description: >
  Use when Claude Code needs to communicate with an OpenClaw agent running on
  the same machine or a remote host via WebSocket gateway. Triggers: (1) sending
  messages or tasks to an OpenClaw agent, (2) injecting context into an agent's
  session without triggering a run, (3) checking gateway status or listing
  sessions, (4) reading an agent's conversation history, (5) aborting a running
  agent, (6) managing cron jobs. Covers WebSocket authentication (protocol v3,
  token auth), session key targeting, and a bundled Node.js bridge script.
license: MIT
compatibility: Requires Node.js >= 22 (native WebSocket) and network access to an OpenClaw gateway
metadata:
  author: openclaw
  version: "1.0.0"
  openclaw:
    requires:
      bins: ["node"]
---

## Terminology

- **Bridge** — The `scripts/openclaw-bridge.js` script bundled with this skill. Zero dependencies (uses Node.js native WebSocket).
- **Gateway** — The OpenClaw WebSocket server that accepts bridge connections and routes requests to agents.
- **Session** — A named conversation context within an agent. Each session has its own message history and token budget.

## Prerequisites

Before using the bridge, verify:

1. **OpenClaw is running** — The gateway must be active. Test: `curl -s http://127.0.0.1:18789/status`
2. **Gateway token exists** — Stored at `gateway.auth.token` in `~/.openclaw/openclaw.json`. The bridge reads it automatically. Never pass the token as a CLI argument or env var.
3. **Node.js >= 22** — Required for native `WebSocket` support (no `npm install` needed).
4. **Network access** — For remote gateways, set `OPENCLAW_HOST` and `OPENCLAW_PORT` env vars. The bridge uses `wss://` for non-localhost hosts automatically. For firewalled hosts, use an SSH tunnel: `ssh -L 18789:localhost:18789 user@remote`.

## Quick Start

Check gateway connectivity:

```bash
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js status
```

Send a message to an agent (triggers an agent run, waits for completion):

```bash
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js send "agent:main:main" "What is your current status?"
```

Inject a note without triggering a run:

```bash
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js inject "agent:main:main" "Context: user requested a report" "Claude Code"
```

The bridge outputs JSON to stdout. Exit code 0 means success.

## Script Reference

The bridge script is at `~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js`.

| Command | Usage | Description |
|---------|-------|-------------|
| `status` | `status` | Full gateway status — channels, sessions, cron, heartbeat config |
| `sessions` | `sessions` | List all active sessions with keys, token usage, and model info |
| `send` | `send <sessionKey> "message"` | Send a message to an agent session. Triggers an agent run and waits for completion (120s default timeout). Returns `{ runId, status }` |
| `inject` | `inject <sessionKey> "text" ["Label"]` | Write to a session's transcript without triggering an agent run. Optional label prefixes the entry. Returns `{ ok, messageId }` |
| `history` | `history <sessionKey> [limit]` | Read conversation history. Default limit: 20 messages |
| `abort` | `abort <sessionKey>` | Cancel a currently running agent in the specified session |
| `cron-list` | `cron-list` | List all scheduled cron jobs with their schedules and last run status |
| `cron-run` | `cron-run <jobId>` | Manually trigger a cron job by its UUID |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_HOST` | `127.0.0.1` | Gateway host |
| `OPENCLAW_PORT` | `18789` | Gateway port |
| `OPENCLAW_SEND_TIMEOUT` | `120000` | Timeout in ms for `send` command (agent runs can take 2+ minutes) |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Connection failed — gateway not reachable |
| 2 | Authentication failed — bad or missing token |
| 3 | Operation failed — the gateway returned an error |
| 4 | Timeout — operation exceeded time limit |
| 5 | Usage error — wrong arguments |

## Authentication Protocol

The bridge handles authentication automatically. Here's what happens under the hood:

1. Connect to `ws://{host}:{port}`
2. Gateway sends a `connect.challenge` event
3. Bridge responds with a `connect` request containing:
   - Protocol version 3 (required — older versions are rejected)
   - Client identity: `{ id: "gateway-client", mode: "backend", version: "1.0.0", platform }` — all fields required
   - Auth: `{ token }` read from `~/.openclaw/openclaw.json` at `gateway.auth.token`
   - Role: `operator` with `operator.admin` scope
4. Gateway responds with `hello-ok` — authenticated

The nonce in the challenge is only used for device-identity auth. Token auth ignores it.

## Session Keys

Session keys identify which conversation context to target. Format: `agent:{agentId}:{sessionName}`.

### Key Format Taxonomy

| Pattern | Example | Description |
|---------|---------|-------------|
| `agent:{id}:main` | `agent:main:main` | Agent's primary session — general purpose, includes heartbeat context |
| `agent:{id}:cron:{uuid}` | `agent:main:cron:cc7a...` | Cron job-specific session (isolated per job) |
| `agent:{id}:discord:channel:{channelId}` | `agent:main:discord:channel:1024...` | Discord channel session |
| `agent:{id}:telegram:{chatId}` | `agent:main:telegram:12345` | Telegram chat session |
| `agent:{id}:imessage:{handle}` | `agent:main:imessage:+1234567890` | iMessage session |

### Which Session Should I Target?

- **Default**: Use `agent:main:main` — the agent's primary session with full context.
- **Discovery**: Run `sessions` to see all active sessions with their keys, token usage, and last activity time.
- **Channel-specific**: Use the channel pattern when interacting with a specific messaging context.

## Response Handling

### Fire-and-Forget

For commands like `inject`, `abort`, `cron-run` — the bridge sends the request, gets the gateway acknowledgment, prints the result, and exits. No waiting for agent processing.

### Wait-for-Completion

The `send` command waits for the agent run to finish by listening for lifecycle events on the WebSocket. When the agent's run completes, it prints `{ runId, status: "completed" }`. If the run exceeds the timeout, it prints `{ runId, status: "timeout" }`.

To get the agent's actual response text after a send, use `history`:

```bash
# Send a message and wait for completion
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js send "agent:main:main" "Summarize your current tasks"

# Then read the response
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js history "agent:main:main" 2
```

### Two-Way Communication

The bridge supports full two-way communication between Claude Code and an OpenClaw agent:

**Caller to Agent** (via bridge):
- `send` — triggers an agent run, agent processes and responds
- `inject` — writes context into the agent's session for later reference

**Agent to Caller** (via shared filesystem):
The recommended pattern is file-based handoff. Ask the agent to write its response to a known file path, then read it:

```bash
# Ask the agent to write a report
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js send "agent:main:main" "Write your findings to ~/bridge-response.md using a shell command"

# Read the response file
cat ~/bridge-response.md
```

For a persistent two-way channel, use a shared directory (e.g., `~/.claude-watson-bridge/`) where both sides read and write.

### Filesystem Sandbox (Important)

OpenClaw agents have two ways to write files, and they behave differently:

| Agent Tool | Writes To | Example |
|-----------|-----------|---------|
| `write` (built-in) | `~/.openclaw/workspace/` (sandboxed) | Agent writes `~/report.md` → file lands at `~/.openclaw/workspace/report.md` |
| `exec` (shell commands) | Real filesystem | Agent runs `echo "hello" > ~/report.md` → file lands at `~/report.md` |

**When asking an agent to write response files**, be explicit about which tool to use:
- Tell the agent to use shell commands (`exec`) if you want the file at the real path
- Or read from `~/.openclaw/workspace/` if the agent uses its `write` tool

This is the most common gotcha when setting up two-way communication. If a file isn't where you expect, check `~/.openclaw/workspace/` for it.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Connection timed out" | Gateway not running | Start with `openclaw gateway start` or check `launchctl list \| grep openclaw` |
| "Authentication failed" | Wrong token | Verify `gateway.auth.token` in `~/.openclaw/openclaw.json` matches the running gateway |
| `PROTOCOL_VERSION` error | Protocol mismatch | Bridge uses v3. Ensure OpenClaw is up to date |
| "Connection closed before auth" | Gateway rejected client fields | All `client` fields required: `id`, `mode`, `version`, `platform` |
| Send times out at 120s | Agent run is slow or stuck | Increase `OPENCLAW_SEND_TIMEOUT` or use `abort` then retry |
| "Operation failed" on send | Session doesn't exist or agent can't start | Run `sessions` to verify the session key exists and check token budget |
| Concurrent run rejected | Hit concurrency limit | Default: 4 agent runs / 8 subagent runs. Wait or abort a running session |
| History seems truncated | Session trimming | Sessions over 200 entries are trimmed to the last 100. This is normal |
