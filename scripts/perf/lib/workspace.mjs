// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Workspace operations driven like a user would (the preload API of the visible tab), timed from the call to the
// moment the expected tab view is on screen, which the Electron main process reports through a 4 ms poll.

/* global setTimeout */

import { connectMain, evaluate, InventoryExpr, OnScreenTabIdExpr, visiblePage } from "./cdp.mjs";

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

  async pageEval(expr) {
    const page = await visiblePage(this.inst.port, this.main);
    try {
      return await evaluate(page, expr);
    } finally {
      page.close();
    }
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

  listWorkspaces() {
    return this
      .pageEval(`(async () => { const l = await WOS.callBackendService("workspace", "ListWorkspaces", []); const out = [];
            for (const e of l) { const w = await WOS.callBackendService("workspace", "GetWorkspace", [e.workspaceid]);
                out.push({ id: e.workspaceid, tabs: w?.tabids ?? [], active: w?.activetabid }); }
            return out; })()`);
  }

  currentWorkspace() {
    return this.pageEval("globalStore.get(globalAtoms.workspace)?.oid");
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

  async create() {
    await this.startPoll();
    const before = new Set((await this.listWorkspaces()).flatMap((w) => w.tabs));
    const t0 = Date.now();
    await this.pageEval("window.api.createWorkspace(); 1");
    const hit = await this.waitOnScreen(t0, (on) => on && on.split(",").length === 1 && !before.has(on));
    const after = await this.listWorkspaces();
    const ws = after.find((w) => w.tabs.includes(hit?.[1]));
    return { ms: hit ? hit[0] - t0 : null, t0, workspace: ws?.id, tab: hit?.[1], count: after.length };
  }

  async switchTo(wsId) {
    await this.startPoll();
    const ws = (await this.listWorkspaces()).find((w) => w.id === wsId);
    const t0 = Date.now();
    await this.pageEval(`window.api.switchWorkspace(${JSON.stringify(wsId)}); 1`);
    const hit = await this.waitOnScreen(t0, (on) => on === ws.active);
    return { ms: hit ? hit[0] - t0 : null, t0, workspace: wsId };
  }

  async remove(wsId) {
    const t0 = Date.now();
    await this.pageEval(`window.api.deleteWorkspace(${JSON.stringify(wsId)}); 1`);
    for (let i = 0; i < 1500; i++) {
      const l = await this.listWorkspaces().catch(() => null);
      if (l && !l.find((w) => w.id === wsId)) {
        return { ms: Date.now() - t0, t0, workspace: wsId, count: l.length };
      }
      await sleep(20);
    }
    return { ms: null, t0, workspace: wsId };
  }

  // Creates a workspace and deletes it as soon as it exists, while its switch is still pending (FR-PERF-003).
  async race(settleMs = 8000) {
    await this.startPoll();
    const before = new Set((await this.listWorkspaces()).map((w) => w.id));
    const t0 = Date.now();
    await this.pageEval("window.api.createWorkspace(); 1");
    let created = null;
    for (let i = 0; i < 2000 && !created; i++) {
      const l = await this.pageEval(`WOS.callBackendService("workspace", "ListWorkspaces", [])`);
      created = l.find((w) => !before.has(w.workspaceid))?.workspaceid;
    }
    const foundMs = Date.now() - t0;
    if (created) {
      await this.pageEval(`window.api.deleteWorkspace(${JSON.stringify(created)}); 1`);
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
