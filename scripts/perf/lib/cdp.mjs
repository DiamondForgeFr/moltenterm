// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Minimal Chrome DevTools Protocol client over Node's global WebSocket (Node 22), for the renderers
// (--remote-debugging-port) and the Electron main process (--inspect).

/* global fetch, WebSocket, setTimeout, clearTimeout */

const CallTimeoutMs = 30000;

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

export function connect(wsUrl, { timeoutMs = CallTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id != null && pending.has(d.id)) {
        const { done, timer } = pending.get(d.id);
        pending.delete(d.id);
        clearTimeout(timer);
        done(d);
        return;
      }
      for (const l of listeners) {
        l(d);
      }
    };
    ws.onerror = (e) => reject(new Error(`CDP connection to ${wsUrl} failed: ${e.message ?? e.type}`));
    ws.onclose = () => {
      for (const { done, timer } of pending.values()) {
        clearTimeout(timer);
        done({ error: { message: "connection closed" } });
      }
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((done) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              done({ error: { message: `${method} timed out` } });
            }, timeoutMs);
            pending.set(id, { done, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(fn) {
          listeners.push(fn);
        },
        close() {
          ws.close();
        },
      });
  });
}

// Evaluates an expression and returns its value; throws on an exception or a protocol error.
export async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    includeCommandLineAPI: true,
  });
  if (r.error) {
    throw new Error(r.error.message);
  }
  if (r.result?.exceptionDetails) {
    const ex = r.result.exceptionDetails;
    throw new Error(ex.exception?.description ?? ex.text);
  }
  return r.result?.result?.value;
}

// The Electron main process, through its Node inspector. `require` comes from the command-line API.
export async function connectMain(inspectPort) {
  const targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
  if (!targets.length) {
    throw new Error("no main-process inspector target");
  }
  return connect(targets[0].webSocketDebuggerUrl);
}

// Tab id shown on screen: the tab view at the window's origin with a non-zero width.
export const OnScreenTabIdExpr = `(() => { const { BaseWindow } = require("electron");
    return BaseWindow.getAllWindows().filter((w) => !w.isDestroyed()).flatMap((w) => w.contentView.children)
        .filter((c) => { const b = c.getBounds(); return b.x === 0 && b.y === 0 && b.width > 0; })
        .map((c) => c.waveTabId).filter(Boolean); })()`;

// Every web contents with its OS process, and the tab id of each tab view (asked to the page itself).
export const InventoryExpr = `(async () => { const { webContents, BaseWindow } = require("electron");
    const onScreen = new Set(BaseWindow.getAllWindows().filter((w) => !w.isDestroyed()).flatMap((w) => w.contentView.children)
        .filter((c) => { const b = c.getBounds(); return b.x === 0 && b.y === 0 && b.width > 0; }).map((c) => c.waveTabId));
    const out = [];
    for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        const type = wc.getType(); const url = wc.getURL();
        const isTabView = type !== "webview" && /\\/frontend\\/index\\.html/.test(url);
        let tabId = null;
        if (isTabView) {
            tabId = await Promise.race([
                wc.executeJavaScript("globalThis.globalAtoms ? globalStore.get(globalAtoms.staticTabId) ?? null : null").catch(() => "__error"),
                new Promise((r) => setTimeout(() => r("__timeout"), 3000)),
            ]);
        }
        out.push({ id: wc.id, pid: wc.getOSProcessId(), type, isTabView, tabId, onScreen: tabId != null && onScreen.has(tabId), url: url.slice(0, 100) });
    }
    return out; })()`;

export async function pageForTab(port, tabId) {
  for (const t of (await listTargets(port)).filter((x) => x.type === "page")) {
    let c;
    try {
      c = await connect(t.webSocketDebuggerUrl, { timeoutMs: 5000 });
      const v = await evaluate(c, "globalThis.globalAtoms ? globalStore.get(globalAtoms.staticTabId) : null");
      if (v === tabId) {
        return c;
      }
    } catch {
      // a page that does not answer is not the one we want
    }
    c?.close();
  }
  throw new Error(`no page for tab ${tabId}`);
}

export async function visiblePage(port, main) {
  const ids = await evaluate(main, OnScreenTabIdExpr);
  if (!ids?.length) {
    throw new Error("no tab view on screen");
  }
  return pageForTab(port, ids[0]);
}
