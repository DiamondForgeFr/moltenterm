#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A minimal MCP client for `molten mcp browser` (FR-BRW-008): starts the server over stdio and checks initialize,
// tools/list and the tab tools, the way an agent would call them. Run it from a terminal pane of a MoltenTerm build;
// outside MoltenTerm, use --offline to check that every call answers "Not running in a MoltenTerm terminal".
//
// Usage:
//   node scripts/moltenterm-mcp-browser-check.mjs [--server <cmd>] [--offline] [--hold <seconds>] [--keep]
//     --server  the server command (default: "molten mcp browser")
//     --offline expect the answers given outside MoltenTerm
//     --hold    after opening a tab, keep the session for this long and print the tab's state every second (to try
//               Stop, a click in the page and Give back), then close it
//     --keep    leave the tab open at the end (its bar goes when the server exits)
// Exit code 1 when a check fails.

/* global console, process, setTimeout, clearTimeout */

import { spawn } from "node:child_process";
import readline from "node:readline";

const NotInMoltenTerm = "Not running in a MoltenTerm terminal";
const NotYourTab = "Not your tab";

function parseArgs(argv) {
  const opts = { server: "molten mcp browser", offline: false, hold: 0, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--server") {
      opts.server = argv[++i];
    } else if (arg === "--offline") {
      opts.offline = true;
    } else if (arg === "--hold") {
      opts.hold = Number(argv[++i]) || 0;
    } else if (arg === "--keep") {
      opts.keep = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return opts;
}

class McpClient {
  constructor(command) {
    const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.nextId = 1;
    this.pending = new Map();
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`FAIL non-JSON line on stdout: ${line.slice(0, 200)}`);
        process.exitCode = 1;
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter(msg);
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      msg.params = params;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer`)), 20000);
      this.pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name, args) {
    const resp = await this.request("tools/call", { name, arguments: args ?? {} });
    if (resp.error) {
      throw new Error(`${name}: protocol error ${resp.error.code} ${resp.error.message}`);
    }
    const text = (resp.result.content ?? []).map((c) => c.text ?? "").join("\n");
    return { isError: resp.result.isError === true, text };
  }

  close() {
    this.proc.stdin.end();
    return new Promise((resolve) => this.proc.on("exit", (code) => resolve(code)));
  }
}

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) {
    failures++;
  }
}

function firstJson(text) {
  try {
    return JSON.parse(text.split("\n")[0]);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const client = new McpClient(opts.server);
  const init = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "moltenterm-mcp-check", version: "1.0.0" },
  });
  check(init.result?.protocolVersion === "2025-06-18", "initialize", JSON.stringify(init.result?.serverInfo));
  client.notify("notifications/initialized", {});
  const list = await client.request("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check(names.join(",") === "tabs_context,tabs_create,tabs_close", "tools/list", names.join(", "));

  if (opts.offline) {
    for (const name of names) {
      const r = await client.callTool(name, { tabId: 1 });
      check(r.isError && r.text === NotInMoltenTerm, `${name} outside MoltenTerm`, r.text);
    }
    await client.close();
    return;
  }

  const empty = await client.callTool("tabs_context", {});
  check(!empty.isError && firstJson(empty.text)?.tabs?.length === 0, "tabs_context before any tab", empty.text);
  const created = await client.callTool("tabs_create", {});
  const tabId = firstJson(created.text)?.tabId;
  check(!created.isError && Number.isInteger(tabId), "tabs_create", created.text.replace(/\n/g, " | "));
  const listed = await client.callTool("tabs_context", {});
  const listedIds = (firstJson(listed.text)?.tabs ?? []).map((t) => t.tabId);
  check(
    listedIds.length === 1 && listedIds[0] === tabId,
    "tabs_context lists only this session's tab",
    listedIds.join(",")
  );
  check(listed.text.includes("<untrusted-page-content"), "page values are wrapped as untrusted");
  const foreign = await client.callTool("tabs_close", { tabId: 999999 });
  check(foreign.isError && foreign.text === NotYourTab, "a foreign tab id is refused", foreign.text);

  if (opts.hold > 0) {
    console.log(`holding tab ${tabId} for ${opts.hold}s: try Stop, a click in the page, Give back`);
    let last = "";
    for (let i = 0; i < opts.hold; i++) {
      await sleep(1000);
      const r = await client.callTool("tabs_context", {});
      const entry = (firstJson(r.text)?.tabs ?? []).find((t) => t.tabId === tabId);
      const state = entry ? entry.state : "not listed (stopped or closed)";
      if (state !== last) {
        console.log(`  t+${i + 1}s tab ${tabId}: ${state}`);
        last = state;
      }
    }
  }

  if (!opts.keep) {
    const closed = await client.callTool("tabs_close", { tabId });
    console.log(`tabs_close ${tabId}: ${closed.isError ? "refused: " : ""}${closed.text}`);
    if (opts.hold === 0) {
      check(!closed.isError, "tabs_close own tab");
      const after = await client.callTool("tabs_context", {});
      check(firstJson(after.text)?.tabs?.length === 0, "tab gone after tabs_close", after.text.split("\n")[0]);
    }
  }
  const code = await client.close();
  check(code === 0, "server exits cleanly on EOF", `exit ${code}`);
}

main()
  .catch((e) => {
    console.error(`FAIL ${e.message}`);
    failures++;
  })
  .finally(() => {
    console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
