# openclaw-bridge

WebSocket bridge between [Claude Code](https://code.claude.com) / [OpenClaw](https://openclaw.ai) agents. Send messages, inject context, read history, manage cron jobs — all from the terminal.

## What it does

Lets your AI agent (or you) talk to an OpenClaw agent over its WebSocket gateway without writing any WebSocket code.

- **Send messages** that trigger agent runs and wait for completion
- **Inject context** into an agent's session without triggering a run
- **Read history** to see what the agent said
- **Manage cron jobs** — list schedules, trigger runs manually
- **Monitor sessions** — see all active sessions with token usage
- **Abort runs** — cancel a stuck or runaway agent
- **Zero dependencies** — uses Node.js native WebSocket, no `npm install`

## Install

### Claude Code

```bash
# From your project
mkdir -p .claude/skills
cd .claude/skills
git clone https://github.com/jeremyknows/openclaw-bridge.git
```

### OpenClaw

```bash
# From your workspace
mkdir -p skills
cd skills
git clone https://github.com/jeremyknows/openclaw-bridge.git
```

### Manual

```bash
# Copy the folder directly
cp -r openclaw-bridge ~/.claude/skills/
```

Claude Code automatically detects the skill via `SKILL.md` frontmatter.

## Setup

1. **OpenClaw running** with gateway enabled — verify with:
   ```bash
   curl -s http://127.0.0.1:18789/status
   ```

2. **Node.js >= 22** — required for native `WebSocket` support:
   ```bash
   node --version  # must be v22.0.0 or higher
   ```

3. **Gateway token** — already configured if OpenClaw is set up. Lives at `gateway.auth.token` in `~/.openclaw/openclaw.json`. The bridge reads it automatically — you never pass it as an argument.

## Usage

### Natural language (just talk to Claude)

Once installed, Claude Code activates the skill automatically when you say things like:

- "Send Watson a message asking for a status update"
- "Check what sessions are running on OpenClaw"
- "Inject a note into the agent's main session"
- "What did the agent say in its last 5 messages?"
- "Abort the agent — it's been running too long"
- "Trigger the morning report cron job"

### CLI commands

```bash
# Check gateway connectivity
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js status

# Send a message (triggers agent run, waits for completion)
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js send "agent:main:main" "Summarize your current tasks"

# Inject context without triggering a run
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js inject "agent:main:main" "Context: user is debugging auth" "Claude Code"

# Read the agent's last 5 messages
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js history "agent:main:main" 5

# List all active sessions
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js sessions

# Cancel a running agent
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js abort "agent:main:main"

# List cron jobs
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js cron-list

# Trigger a cron job manually
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js cron-run "job-uuid-here"
```

## Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `status` | `status` | Full gateway status — channels, sessions, cron, heartbeat |
| `sessions` | `sessions` | List all active sessions with keys, token usage, model info |
| `send` | `send <session> "message"` | Send message, trigger agent run, wait for completion (120s timeout) |
| `inject` | `inject <session> "text" ["Label"]` | Write to transcript without triggering a run |
| `history` | `history <session> [limit]` | Read conversation history (default: 20 messages) |
| `abort` | `abort <session>` | Cancel a currently running agent |
| `cron-list` | `cron-list` | List all scheduled cron jobs with schedules and status |
| `cron-run` | `cron-run <jobId>` | Manually trigger a cron job by UUID |

## Device Identity

The bridge uses Ed25519 cryptographic signatures for authentication (required since OpenClaw 2026.2.15):

**How it works:**
1. On first run, the bridge generates an Ed25519 keypair and saves it to `~/.openclaw/bridge-identity/device-identity.json`
2. Each connection, the bridge signs a payload with its private key and sends the signature + public key to the gateway
3. The gateway validates the signature and returns a `deviceToken`
4. The bridge caches the `deviceToken` at `~/.openclaw/bridge-identity/device-auth.json` for faster future connections
5. If the cached token expires, the bridge automatically retries with the gateway token (no user intervention needed)

**Security:**
- Device identity files have `chmod 600` permissions (owner read/write only)
- The device ID is a SHA-256 hash of the public key
- Private keys never leave your machine
- Device tokens expire and auto-refresh

**Troubleshooting:**
- If you see "device_token_mismatch", the bridge auto-clears the cache and retries — no action needed
- If device identity files are corrupted, delete `~/.openclaw/bridge-identity/` — the bridge regenerates on next run

## Session Keys

Session keys tell the bridge which conversation to target. Format: `agent:{agentId}:{sessionName}`.

| Pattern | Example | What it is |
|---------|---------|------------|
| `agent:{id}:main` | `agent:main:main` | Primary session (most common) |
| `agent:{id}:cron:{uuid}` | `agent:main:cron:cc7a...` | Cron job session |
| `agent:{id}:discord:channel:{id}` | `agent:main:discord:channel:1024...` | Discord channel |
| `agent:{id}:telegram:{chatId}` | `agent:main:telegram:12345` | Telegram chat |
| `agent:{id}:imessage:{handle}` | `agent:main:imessage:+1234567890` | iMessage session |

**Not sure which session?** Use `agent:main:main` — it's the agent's primary session. Run `sessions` to discover all active ones.

## Two-Way Communication

**You to the agent:**
- `send` — triggers an agent run, agent processes and responds
- `inject` — writes context into the session for later reference (no run triggered)

**Agent back to you:**
- `history` — read what the agent said after a `send`
- File handoff — ask the agent to write output to a file path you can read

**Typical flow:**
```bash
# 1. Send a task
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js send "agent:main:main" "Write a summary of today's events"

# 2. Read the response
node ~/.claude/skills/openclaw-bridge/scripts/openclaw-bridge.js history "agent:main:main" 2
```

### Filesystem Sandbox

OpenClaw agents have two ways to write files, and they behave differently:

| Agent Tool | Writes To | Example |
|-----------|-----------|---------|
| `write` (built-in) | `~/.openclaw/workspace/` (sandboxed) | Agent writes `~/report.md` → lands at `~/.openclaw/workspace/report.md` |
| `exec` (shell) | Real filesystem | Agent runs `echo "hello" > ~/report.md` → lands at `~/report.md` |

If a file isn't where you expect it, check `~/.openclaw/workspace/`. This is the most common gotcha with two-way communication.

## Configuration

The bridge reads its gateway token from `~/.openclaw/openclaw.json` at `gateway.auth.token`. It can also read from the `OPENCLAW_GATEWAY_TOKEN` environment variable (useful when the config uses `${VAR_NAME}` substitution).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_HOST` | `127.0.0.1` | Gateway host |
| `OPENCLAW_PORT` | `18789` | Gateway port |
| `OPENCLAW_SEND_TIMEOUT` | `120000` | Send timeout in ms (agent runs can take 2+ min) |
| `OPENCLAW_GATEWAY_TOKEN` | (none) | Gateway token override (reads from config file if unset) |

### Remote Gateways

For non-localhost hosts, the bridge automatically uses `wss://` (encrypted). For firewalled hosts, use an SSH tunnel:

```bash
ssh -L 18789:localhost:18789 user@remote-host
# Then connect normally — bridge sees localhost
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Connection failed — gateway not reachable |
| 2 | Authentication failed — bad or missing token |
| 3 | Operation failed — gateway returned an error |
| 4 | Timeout — operation exceeded time limit |
| 5 | Usage error — wrong arguments |

## Security

**Token handling:** The bridge reads the gateway token from `~/.openclaw/openclaw.json` or the `OPENCLAW_GATEWAY_TOKEN` environment variable. The token is:

- **Never** accepted as a CLI argument (visible in `ps` output)
- **Never** printed to stdout

**Device identity:** The bridge generates and persists an Ed25519 keypair for cryptographic authentication. All identity files have `chmod 600` permissions (owner read/write only). Private keys never leave your machine.

**Be aware:** AI coding agents (Claude Code, Codex, etc.) log tool calls in session transcripts. The bridge sends the token over the WebSocket connection, which is local (`ws://127.0.0.1`), but the token value exists in the config file that the script reads. Recommendations:

- Keep `~/.openclaw/openclaw.json` permissions at `600`
- For remote gateways, always use `wss://` (the bridge does this automatically)
- Rotate your gateway token if you suspect exposure
- Review your agent's session logs if sharing transcripts

## How It Works

1. Bridge loads or generates an Ed25519 keypair (first-time setup)
2. Bridge opens a WebSocket to the gateway (`ws://host:port`)
3. Gateway sends an auth challenge with a nonce
4. Bridge signs a payload with its private key and sends a protocol v3 handshake + device signature + token
5. Gateway validates the signature and responds with `hello-ok` + `deviceToken`
6. Bridge caches the `deviceToken` for future connections (faster auth)
7. Bridge sends the requested command, prints the result, disconnects

For `send`, the bridge stays connected after step 7 to listen for the agent's lifecycle completion event before exiting. It matches on the specific `runId` to avoid false-positives from concurrent agent runs (cron jobs, Discord messages, etc.).

Zero dependencies — uses Node.js native `WebSocket` (available since Node 22). No `npm install`, no `node_modules`, no package.json.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Connection timed out" | Gateway not running | Start with `openclaw gateway start` or check `launchctl list \| grep openclaw` |
| "Authentication failed" | Wrong token | Verify `gateway.auth.token` in `~/.openclaw/openclaw.json` or `OPENCLAW_GATEWAY_TOKEN` env var |
| "device_token_mismatch" | Cached token expired | Bridge auto-retries — no action needed |
| "Connection closed before auth" | Missing client fields | Update to latest bridge — all handshake fields required |
| Send times out at 120s | Agent run is slow | Increase `OPENCLAW_SEND_TIMEOUT` or `abort` then retry |
| "Operation failed" on send | Session doesn't exist | Run `sessions` to verify the key; check token budget |
| History seems truncated | Session trimming | Sessions over 200 entries trim to last 100 — this is normal |
| File not where expected | Sandbox redirect | Check `~/.openclaw/workspace/` — agent's `write` tool is sandboxed there |
| Device identity corrupted | Malformed JSON | Delete `~/.openclaw/bridge-identity/` — bridge regenerates |

## Limitations

- **One-shot commands only** — the bridge connects, runs one command, and disconnects. No persistent connection or streaming.
- **No output streaming** — for `send`, you get `{ runId, status }` on completion. Use `history` to read the actual response text.
- **Local gateway assumed** — defaults to `127.0.0.1:18789`. Remote gateways work but need env vars or SSH tunnel.
- **Node.js 22+ required** — older versions don't have native `WebSocket`. No fallback to the `ws` npm package.
- **Concurrency limits** — OpenClaw enforces 4 concurrent agent runs / 8 subagent runs. The bridge can't bypass this.

## File Structure

```
openclaw-bridge/
├── SKILL.md                      # Skill instructions (Claude reads this)
├── LICENSE.txt                   # MIT license
├── README.md                     # This file
└── scripts/
    └── openclaw-bridge.js        # Bridge script (zero dependencies, ~410 lines)
```

## License

MIT — see [LICENSE.txt](LICENSE.txt) for details.
