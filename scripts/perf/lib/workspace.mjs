// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Workspace operations driven like a user would (the preload API of the visible tab), timed from the call to the
// moment the expected tab view is on screen, which the Electron main process reports through a 4 ms poll.

/* global setTimeout */

import {
  connectMain,
  evaluate,
  InventoryExpr,
  isContextLost,
  neverRan,
  OnScreenTabIdExpr,
  visiblePage,
} from "./cdp.mjs";

// How many times an operation meets a lost page context before the scenario fails, and the pause between attempts.
const ContextAttempts = 5;
const ContextRetryMs = 250;
// How long the main process may take to log a preload call it received (emain-window.ts) on a loaded machine.
const ReceiptTimeoutMs = 30000;
const CreateReceivedRe = /^create-workspace\b/;

// The main process logs "<op>-workspace <id> <window id>" when the call reaches it.
function receivedRe(op, wsId) {
  return new RegExp(`^${op}-workspace ${wsId}\\b`);
}

// The poll keeps a log of what is on screen; dialogs are answered "yes" (delete confirmations) and recorded.
const InstallExpr = `(() => { const { BaseWindow, dialog } = require("electron");
    dialog.showMessageBoxSync = (...a) => { (globalThis.__mtperfDialogs ??= []).push([Date.now(), a.find((x) => x && x.message)?.message]); return 1; };
    if (globalThis.__mtperf) return "already";
    globalThis.__mtperf = { log: [] }; let last = null;
    __mtperf.start = () => { if (__mtperf.timer) return; __mtperf.timer = setInterval(() => {
        const w = BaseWindow.getAllWindows().find((x) => !x.isDestroyed()); if (!w) return;
        const on = w.contentView.children.filter((c) => { const b = c.getBounds(); return b.x === 0 && b.y === 0 && b.width > 0; }).map((c) => c.waveTabId).join(",");
        if (on !== last) { __mtperf.log.push([Date.now(), on]); last = on; if (__mtperf.log.length > 2000) __mtperf.log.splice(0, 1000); } }, 4); };
    __mtperf.stop = () => { clearInterval(__mtperf.timer); __mtperf.timer = null; };
    return "installed"; })()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Driver {
  inst;
  main = null;

  constructor(inst) {
    this.inst = inst;
  }

  async attach() {
    this.main = await connectMain(this.inst.inspectPort);
    await evaluate(this.main, InstallExpr);
  }

  detach() {
    this.main?.close();
    this.main = null;
  }

  mainEval(expr) {
    return evaluate(this.main, expr);
  }

  // The visible tab's page. Right after a switch the on-screen view and its page can briefly disagree, so it retries.
  async page(timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await visiblePage(this.inst.port, this.main);
      } catch (e) {
        if (Date.now() > end) {
          throw e;
        }
        await sleep(250);
      }
    }
  }

  // A page's context can be replaced under the scenario (#895). `fn` runs again on the page now on screen when CDP
  // refused it before running anything, and after any lost context when it only reads (`reads`).
  async withPage(fn, reads = false) {
    for (let attempt = 1; ; attempt++) {
      const page = await this.page();
      try {
        return await fn(page);
      } catch (e) {
        if (attempt >= ContextAttempts || !(neverRan(e) || (reads && isContextLost(e)))) {
          throw e;
        }
      } finally {
        page.close();
      }
      await sleep(ContextRetryMs);
    }
  }

  pageEval(expr, reads = false) {
    return this.withPage((page) => evaluate(page, expr), reads);
  }

  // Makes a preload call from the visible page and returns its time with the page, still open: the caller closes it.
  // A call whose context is lost is made again on the page now on screen unless it reached the app, which the main
  // process logs (`receivedRe`), so an operation is never applied twice (#895).
  async call(expr, receivedRe) {
    for (let attempt = 1; ; attempt++) {
      const page = await this.page();
      const t0 = Date.now();
      try {
        await evaluate(page, expr);
        return { t0, page };
      } catch (e) {
        page.close();
        if (attempt >= ContextAttempts || !isContextLost(e)) {
          throw e;
        }
        if (!neverRan(e) && (await this.inst.waitLog(receivedRe, t0, ReceiptTimeoutMs))) {
          return { t0, page: await this.page() };
        }
      }
      await sleep(ContextRetryMs);
    }
  }

  async send(expr, receivedRe) {
    const { t0, page } = await this.call(expr, receivedRe);
    page.close();
    return t0;
  }

  startPoll() {
    return this.mainEval("__mtperf.start(); 1");
  }

  // The poll costs CPU in the main process: it is off while idle CPU is sampled.
  stopPoll() {
    return this.mainEval("__mtperf.stop(); 1");
  }

  onScreen() {
    return this.mainEval(OnScreenTabIdExpr);
  }

  inventory() {
    return this.mainEval(InventoryExpr);
  }

  listWorkspaces(page) {
    const expr = `(async () => { const l = await WOS.callBackendService("workspace", "ListWorkspaces", []); const out = [];
            for (const e of l) { const w = await WOS.callBackendService("workspace", "GetWorkspace", [e.workspaceid]);
                out.push({ id: e.workspaceid, tabs: w?.tabids ?? [], active: w?.activetabid }); }
            return out; })()`;
    return page ? evaluate(page, expr) : this.pageEval(expr, true);
  }

  currentWorkspace() {
    return this.pageEval("globalStore.get(globalAtoms.workspace)?.oid", true);
  }

  async waitOnScreen(t0, pred, timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const log = await this.mainEval(`__mtperf.log.filter((e) => e[0] >= ${t0})`);
      const hit = log.find((e) => pred(e[1]));
      if (hit) {
        return hit;
      }
      await sleep(20);
    }
    return null;
  }

  // The hot spare is refilled after a create or a never-visited switch: its "tabview init" follows an
  // "ensureHotSpareTab" logged after `sinceMs`.
  async waitSpare(sinceMs, timeoutMs = 20000) {
    const ensure = await this.inst.waitLog(/^ensureHotSpareTab/, sinceMs, timeoutMs);
    if (!ensure) {
      return false;
    }
    const ready = await this.inst.waitLog(/^tabview init/, ensure.t, timeoutMs);
    await sleep(300);
    return ready != null;
  }

  // Each operation is timed from the preload call, made on a page connection opened beforehand, so that finding the
  // page is not part of the latency.
  async create() {
    await this.startPoll();
    const before = new Set((await this.listWorkspaces()).flatMap((w) => w.tabs));
    const t0 = await this.send("window.api.createWorkspace(); 1", CreateReceivedRe);
    const hit = await this.waitOnScreen(t0, (on) => on && on.split(",").length === 1 && !before.has(on));
    const after = await this.listWorkspaces();
    const ws = after.find((w) => w.tabs.includes(hit?.[1]));
    return { ms: hit ? hit[0] - t0 : null, t0, workspace: ws?.id, tab: hit?.[1], count: after.length };
  }

  async switchTo(wsId) {
    await this.startPoll();
    const ws = (await this.listWorkspaces()).find((w) => w.id === wsId);
    const t0 = await this.send(`window.api.switchWorkspace(${JSON.stringify(wsId)}); 1`, receivedRe("switch", wsId));
    const hit = await this.waitOnScreen(t0, (on) => on === ws.active);
    return { ms: hit ? hit[0] - t0 : null, t0, workspace: wsId };
  }

  // Timed until the workspace is gone from ListWorkspaces, polled with one RPC on an open page. Deleting the current
  // workspace can take its page away: the poll then moves to the page now on screen.
  async remove(wsId) {
    const sent = await this.call(`window.api.deleteWorkspace(${JSON.stringify(wsId)}); 1`, receivedRe("delete", wsId));
    let page = sent.page;
    const t0 = sent.t0;
    try {
      const end = t0 + 30000;
      while (Date.now() < end) {
        try {
          const l = await evaluate(page, `WOS.callBackendService("workspace", "ListWorkspaces", [])`);
          if (!l.find((w) => w.workspaceid === wsId)) {
            return { ms: Date.now() - t0, t0, workspace: wsId, count: l.length };
          }
        } catch {
          page.close();
          page = await this.page();
        }
        await sleep(10);
      }
      return { ms: null, t0, workspace: wsId };
    } finally {
      page.close();
    }
  }

  // Creates a workspace and deletes it as soon as it exists, while its switch is still pending (FR-PERF-003).
  async race(settleMs = 8000) {
    await this.startPoll();
    const before = new Set((await this.listWorkspaces()).map((w) => w.id));
    const t0 = Date.now();
    await this.send("window.api.createWorkspace(); 1", CreateReceivedRe);
    let created = null;
    for (let i = 0; i < 2000 && !created; i++) {
      const l = await this.pageEval(`WOS.callBackendService("workspace", "ListWorkspaces", [])`, true);
      created = l.find((w) => !before.has(w.workspaceid))?.workspaceid;
    }
    const foundMs = Date.now() - t0;
    if (created) {
      await this.send(`window.api.deleteWorkspace(${JSON.stringify(created)}); 1`, receivedRe("delete", created));
    }
    await sleep(settleMs);
    const screen = await this.mainEval(`__mtperf.log.filter((e) => e[0] >= ${t0}).map((e) => [e[0] - ${t0}, e[1]])`);
    const waveReady = this.inst.log(t0).filter((l) => /^wave-ready init time/.test(l.s));
    // How long the window's action queue stayed blocked: the last wave-ready logged after the race, measured from
    // the create (5000 ms when it waited for a view that never became ready).
    const blockedMs = waveReady.length
      ? Math.max(...waveReady.map((l) => Number(l.s.match(/(\d+)ms/)?.[1] ?? 0)))
      : null;
    return { created, foundMs, blockedMs, screen };
  }

  async minimize() {
    await this.mainEval(`require("electron").BaseWindow.getAllWindows().forEach((w) => w.minimize()); 1`);
  }

  async restore() {
    await this.mainEval(
      `require("electron").BaseWindow.getAllWindows().forEach((w) => { w.restore(); w.showInactive(); }); 1`
    );
  }

  windowState() {
    return this.mainEval(
      `require("electron").BaseWindow.getAllWindows().map((w) => ({ focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized() }))`
    );
  }
}
