#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

// --- Constants ---
const CONNECTION_TIMEOUT = 5000;
const OPERATION_TIMEOUT = 10000;
const SEND_TIMEOUT = parseInt(process.env.OPENCLAW_SEND_TIMEOUT, 10) || 120000;

const EXIT = { CONN: 1, AUTH: 2, OP: 3, TIMEOUT: 4, USAGE: 5 };

const HOST = process.env.OPENCLAW_HOST || "127.0.0.1";
const PORT = process.env.OPENCLAW_PORT || "18789";
const PROTOCOL = HOST === "127.0.0.1" || HOST === "localhost" ? "ws" : "wss";

// --- CLI Definition ---
const COMMANDS = {
  status:      { args: [1, 1], usage: "status" },
  sessions:    { args: [1, 1], usage: "sessions" },
  send:        { args: [3, 3], usage: 'send <sessionKey> "message"' },
  inject:      { args: [3, 4], usage: 'inject <sessionKey> "text" ["Label"]' },
  history:     { args: [2, 3], usage: "history <sessionKey> [limit]" },
  abort:       { args: [2, 2], usage: "abort <sessionKey>" },
  "cron-list": { args: [1, 1], usage: "cron-list" },
  "cron-run":  { args: [2, 2], usage: "cron-run <jobId>" },
};

const SESSION_KEY_COMMANDS = new Set(["send", "inject", "history", "abort"]);

// --- CLI Parsing ---
const cliArgs = process.argv.slice(2);
const command = cliArgs[0];

function die(msg, code) {
  console.error(msg);
  process.exit(code);
}

function usage() {
  const lines = [
    "Usage: openclaw-bridge.js <command> [args]\n",
    "Commands:",
    ...Object.values(COMMANDS).map((s) => "  " + s.usage),
    "\nEnvironment:",
    "  OPENCLAW_HOST          Gateway host (default: 127.0.0.1)",
    "  OPENCLAW_PORT          Gateway port (default: 18789)",
    "  OPENCLAW_SEND_TIMEOUT  Send timeout in ms (default: 120000)",
  ];
  die(lines.join("\n"), EXIT.USAGE);
}

if (!command || !COMMANDS[command]) usage();
const spec = COMMANDS[command];
if (cliArgs.length < spec.args[0] || cliArgs.length > spec.args[1]) {
  die("Usage: openclaw-bridge.js " + spec.usage, EXIT.USAGE);
}

// Validate session key format for commands that require it
if (SESSION_KEY_COMMANDS.has(command)) {
  const key = cliArgs[1];
  if (!key.startsWith("agent:") || key.split(":").length < 3) {
    die("Error: Invalid session key format. Expected agent:{id}:{session}, got: " + key, EXIT.USAGE);
  }
}

// Validate history limit
if (command === "history" && cliArgs[2]) {
  const limit = parseInt(cliArgs[2], 10);
  if (isNaN(limit) || limit < 1) {
    die("Error: limit must be a positive integer", EXIT.USAGE);
  }
}

// --- Config ---
function readToken() {
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const token = config?.gateway?.auth?.token;
    if (!token) die("Error: No gateway.auth.token found in " + configPath, EXIT.AUTH);
    return token;
  } catch (e) {
    die("Error: Cannot read config at " + configPath + " — " + e.message, EXIT.AUTH);
  }
}

const TOKEN = readToken();
const url = `${PROTOCOL}://${HOST}:${PORT}`;

// --- WebSocket Request/Response Tracking ---
let msgId = 0;
const pending = new Map();
let authenticated = false;
let sendRunId = null;

function sendReq(method, params) {
  const id = String(++msgId);
  const timeout = OPERATION_TIMEOUT;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timeout waiting for response to " + method));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

function handleResponse(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.payload);
  else entry.reject(new Error(JSON.stringify(msg.error || "Unknown error")));
}

function cleanup(code) {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  if (ws && ws.readyState <= WebSocket.CLOSING) ws.close();
  process.exit(code);
}

process.on("SIGINT", () => cleanup(EXIT.OP));
process.on("SIGTERM", () => cleanup(EXIT.OP));

// --- Command Handlers ---
// Most commands follow the same pattern: call a method, print the result.
// Only "send" is special (it waits for an agent lifecycle event).

function buildRequest() {
  switch (command) {
    case "status":    return { method: "status", params: {} };
    case "sessions":  return { method: "sessions.list", params: {} };
    case "inject":    return { method: "chat.inject", params: { sessionKey: cliArgs[1], message: cliArgs[2], label: cliArgs[3] } };
    case "history":   return { method: "chat.history", params: { sessionKey: cliArgs[1], limit: cliArgs[2] ? parseInt(cliArgs[2], 10) : 20 } };
    case "abort":     return { method: "chat.abort", params: { sessionKey: cliArgs[1] } };
    case "cron-list": return { method: "cron.list", params: {} };
    case "cron-run":  return { method: "cron.run", params: { jobId: cliArgs[1] } };
    default:          return null;
  }
}

async function runSend() {
  const sendResult = await sendReq("chat.send", {
    sessionKey: cliArgs[1],
    message: cliArgs[2],
    idempotencyKey: crypto.randomUUID(),
  });
  sendRunId = sendResult?.runId;
  if (!sendRunId) return sendResult;

  // Wait for agent lifecycle "end" event or timeout
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete("send-wait");
      resolve({ runId: sendRunId, status: "timeout" });
    }, SEND_TIMEOUT);
    pending.set("send-wait", { resolve, reject: resolve, timer });
  });
}

async function runCommand() {
  try {
    let result;
    if (command === "send") {
      result = await runSend();
    } else {
      const { method, params } = buildRequest();
      result = await sendReq(method, params);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("Error: " + e.message);
    cleanup(EXIT.OP);
  }
}

// --- Connect & Authenticate ---
const connTimer = setTimeout(() => {
  die("Error: Connection to " + url + " timed out", EXIT.CONN);
}, CONNECTION_TIMEOUT);

const ws = new WebSocket(url);

ws.onerror = () => {
  clearTimeout(connTimer);
  die("Error: Cannot connect to gateway at " + url, EXIT.CONN);
};

ws.onclose = () => {
  if (!authenticated) {
    clearTimeout(connTimer);
    die("Error: Connection closed before authentication", EXIT.CONN);
  }
  // Reject all pending operations on unexpected close
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Connection closed unexpectedly"));
  }
  pending.clear();
};

ws.onmessage = async (event) => {
  let msg;
  try {
    msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
  } catch {
    console.error("Error: Received malformed message from gateway");
    return;
  }

  // Auth challenge
  if (msg.type === "event" && msg.event === "connect.challenge") {
    clearTimeout(connTimer);
    try {
      await sendReq("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "gateway-client", mode: "backend", version: "1.0.0", platform: process.platform },
        caps: [],
        commands: [],
        role: "operator",
        scopes: ["operator.admin"],
        auth: { token: TOKEN },
      });
      authenticated = true;
      await runCommand();
      cleanup(0);
    } catch (e) {
      die("Error: Authentication failed — " + e.message, EXIT.AUTH);
    }
    return;
  }

  // Response to a pending request
  if (msg.type === "res") {
    handleResponse(msg);
    return;
  }

  // Agent lifecycle events (for send wait-for-completion)
  // Match on runId to avoid false-positive from concurrent runs (cron jobs, other sessions)
  if (sendRunId && msg.type === "event" && msg.event === "agent"
      && msg.data?.stream === "lifecycle" && msg.data?.phase === "end"
      && msg.data?.runId === sendRunId) {
    const entry = pending.get("send-wait");
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete("send-wait");
      entry.resolve({ runId: sendRunId, status: "completed" });
    }
  }
};
