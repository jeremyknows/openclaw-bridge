---
name: openclaw-bridge
description: >
  Use when Claude Code needs to communicate with an OpenClaw agent running on
  the same machine or a remote host via WebSocket gateway. Triggers: (1) sending
  messages or tasks to an OpenClaw agent, (2) injecting context into an agent's
  session without triggering a run, (3) checking gateway status or listing
  sessions, (4) reading an agent's conversation history, (5) aborting a running
  agent, (6) managing cron jobs. Covers WebSocket authentication (protocol v3,
  Ed25519 device identity), session key targeting, and a bundled Node.js bridge script.
license: MIT
compatibility: Requires Node.js >= 22 (native WebSocket) and network access to an OpenClaw gateway
metadata:
  author: openclaw
  version: "1.1.0"
  openclaw:
    requires:
      bins: ["node"]
---

## Terminology

- **Bridge** — The `scripts/openclaw-bridge.js` script bundled with this skill. Zero dependencies (uses Node.js native WebSocket).
- **Gateway** — The OpenClaw WebSocket server that accepts bridge connections and routes requests to agents.
- **Session** — A named conversation context within an agent. Each session has its own message history and token budget.
- **Device Identity** — Ed25519 keypair used to sign connection requests for scoped access (required since OpenClaw 2026.2.15).

## Prerequisites

Before using the bridge, verify:

1. **OpenClaw is running** — The gateway must be active. Test: `curl -s http://127.0.0.1:18789/status`
2. **Gateway token exists** — Stored at `gateway.auth.token` in `~/.openclaw/openclaw.json`. The bridge reads it automatically. Can also be set via `OPENCLAW_GATEWAY_TOKEN` env var.
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
| `OPENCLAW_GATEWAY_TOKEN` | (none) | Gateway token override (reads from config file if unset) |

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

The bridge handles authentication automatically using Ed25519 device identity. Here's what happens under the hood:

1. Bridge loads or generates an Ed25519 keypair at `~/.openclaw/bridge-identity/device-identity.json`
2. Connect to `ws://{host}:{port}`
3. Gateway sends a `connect.challenge` event
4. Bridge signs a payload (`v1|deviceId|clientId|clientMode|role|scopes|signedAtMs|token`) with its private key
5. Bridge sends a `connect` request containing:
   - Protocol version 3 (required — older versions are rejected)
   - Client identity: `{ id: "gateway-client", mode: "backend", version: "1.0.0", platform }` — all fields required
   - Device identity: `{ id, publicKey, signature, signedAt }`
   - Auth: `{ token }` read from `~/.openclaw/openclaw.json` at `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN` env var)
   - Role: `operator` with scopes `["operator.read", "operator.write", "operator.admin", "operator.approvals", "operator.pairing"]`
6. Gateway validates the signature, responds with `hello-ok` and a `deviceToken`
7. Bridge caches the `deviceToken` at `~/.openclaw/bridge-identity/device-auth.json`
8. Future connections use the cached `deviceToken` instead of the gateway token (faster auth)
9. If the cached token is stale, the bridge automatically retries with the gateway token (no user intervention needed)

### Device Identity Files

| File | Purpose | Permissions |
|------|---------|-------------|
| `~/.openclaw/bridge-identity/device-identity.json` | Ed25519 keypair (persists across connections) | `0600` |
| `~/.openclaw/bridge-identity/device-auth.json` | Cached device token (auto-refreshes when stale) | `0600` |

Both files are auto-generated on first run. The directory is mode `0700` (user-only access). The device ID is derived from a SHA-256 hash of the raw Ed25519 public key.

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
| "Authentication failed" | Wrong token or stale device token | Verify `gateway.auth.token` in openclaw.json or `OPENCLAW_GATEWAY_TOKEN` env var. Delete `~/.openclaw/bridge-identity/device-auth.json` to force re-auth |
| "device_token_mismatch" | Cached device token expired | Bridge auto-retries with gateway token — no action needed |
| "Connection closed before auth" | Gateway rejected handshake | Ensure OpenClaw is 2026.2.15+ (protocol v3 required). All `client` fields required: `id`, `mode`, `version`, `platform` |
| Device identity file corrupted | Malformed JSON or missing fields | Delete `~/.openclaw/bridge-identity/device-identity.json` — bridge regenerates on next run |
| `PROTOCOL_VERSION` error | Protocol mismatch | Bridge uses v3. Ensure OpenClaw is up to date |
| Send times out at 120s | Agent run is slow or stuck | Increase `OPENCLAW_SEND_TIMEOUT` or use `abort` then retry |
| "Operation failed" on send | Session doesn't exist or agent can't start | Run `sessions` to verify the session key exists and check token budget |
| Concurrent run rejected | Hit concurrency limit | Default: 4 agent runs / 8 subagent runs. Wait or abort a running session |
| History seems truncated | Session trimming | Sessions over 200 entries are trimmed to the last 100. This is normal |
| File not where expected | Sandbox redirect | Check `~/.openclaw/workspace/` — agent's `write` tool is sandboxed there |
