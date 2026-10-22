// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Renderer loss recovery (#973, FR-PERF-004). A window whose renderer is gone (killed, crashed, out of memory) showed
// an empty window until the app was quit: Electron keeps the dead view in place and nothing loaded it again. Here the
// dead view leaves the tab view host, and the window loads its active tab again as at startup, under the pending state;
// durable terminals run in the backend and reattach. The reloads of a window are limited (moltenterm-renderer-gone-
// policy.ts); past the limit the pending state says the window stopped, with Reload. A browser panel page whose
// renderer is gone is reloaded in its panel under the same limit.
//
// For the diagnosis, each renderer's pid is kept while it lives (Chromium no longer knows it once the process is gone),
// the signals Electron main itself receives are noted, and renderers killed together are logged as an external kill.

import { fireAndForget } from "@/util/util";
import { RenderProcessGoneDetails, shell, WebContents } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import { getGlobalIsQuitting, getGlobalIsRelaunching } from "./emain-activity";
import { getWaveDataDir } from "./emain-platform";
import { getWaveTabViewByWebContentsId, WaveTabView } from "./emain-tabview";
import { getWaveWindowById, WaveBrowserWindow } from "./emain-window";
import { ShowLogChannel, WindowReloadedChannel } from "./moltenterm-hang-ipc";
import { handleAppIpc } from "./moltenterm-privileged-ipc";
import {
    isRecoverableLoss,
    KillBurstDetector,
    killBurstLine,
    KillBurstMs,
    RendererReloadLimit,
    RendererReloadPolicy,
    signalName,
} from "./moltenterm-renderer-gone-policy";
import { beginWindowPending, destroyTabView, windowViewPending } from "./moltenterm-tabview-host";

// The renderers of one kill are reported within a few milliseconds: the window waits for all of them (the hot spare
// may be among them) before it loads its tab again.
const ReloadSettleMs = 250;
// A signal Electron main received this recently is named in an external kill line.
const MainSignalRecentMs = 5000;

export type WindowReloaded = { reason: string; signal: string; at: number };

type Recorder = (line: string) => void;

const pids = new Map<number, number>();
const policy = new RendererReloadPolicy();
const bursts = new KillBurstDetector();
let mainSignal: { name: string; at: number } = null;

function notePid(wc: WebContents) {
    try {
        const pid = wc.getOSProcessId();
        if (pid > 0) {
            pids.set(wc.id, pid);
        }
    } catch {
        // a contents being destroyed has no process to ask
    }
}

// Called for every webContents once created (moltenterm-hang-watch.ts).
export function trackRendererPid(wc: WebContents) {
    const id = wc.id;
    wc.on("dom-ready", () => notePid(wc));
    wc.on("did-navigate", () => notePid(wc));
    wc.on("destroyed", () => pids.delete(id));
}

function rendererPid(wc: WebContents): number {
    if (wc == null) {
        return 0;
    }
    return pids.get(wc.id) ?? 0;
}

function recentMainSignal(now: number): string {
    if (mainSignal == null || now - mainSignal.at > MainSignalRecentMs) {
        return null;
    }
    return mainSignal.name;
}

function memoryMb(): { free: number; total: number } {
    return { free: Math.round(os.freemem() / 1048576), total: Math.round(os.totalmem() / 1048576) };
}

function closeBurst(record: Recorder) {
    const burst = bursts.close();
    if (burst == null) {
        return;
    }
    const mem = memoryMb();
    record(killBurstLine(burst, recentMainSignal(Date.now()), mem.free, mem.total));
}

function isLeaving(): boolean {
    return getGlobalIsQuitting() || getGlobalIsRelaunching();
}

function windowOf(tabView: WaveTabView): WaveBrowserWindow {
    if (tabView.waveWindowId == null) {
        return null;
    }
    const win = getWaveWindowById(tabView.waveWindowId);
    return win == null || win.isDestroyed() ? null : win;
}

function showStopped(win: WaveBrowserWindow, tabId: string) {
    const onReload = () => {
        policy.reset(win.waveWindowId);
        fireAndForget(() => win.setActiveTab(tabId, false));
    };
    const token = beginWindowPending(win, null, onReload, Date.now(), 0);
    windowViewPending(win).setPhase(token, "stopped");
}

async function reloadWindow(win: WaveBrowserWindow, tabId: string, notice: WindowReloaded, record: Recorder) {
    await new Promise((resolve) => setTimeout(resolve, ReloadSettleMs));
    if (win.isDestroyed() || isLeaving() || win.activeTabView != null) {
        return;
    }
    await win.setActiveTab(tabId, false);
    const view = win.activeTabView;
    if (view == null || view.isDestroyed || view.webContents.isDestroyed()) {
        record(`window ${win.waveWindowId} did not come back after its renderer was lost`);
        return;
    }
    record(`window ${win.waveWindowId} reloaded: tab ${tabId} is on screen again`);
    view.webContents.send(WindowReloadedChannel, notice);
}

function recoverTabView(tabView: WaveTabView, notice: WindowReloaded, record: Recorder) {
    const win = windowOf(tabView);
    const wasActive = win != null && win.activeTabView === tabView;
    const tabId = tabView.waveTabId;
    destroyTabView(tabView, `its renderer is gone (${notice.reason}, #973)`);
    if (!wasActive) {
        return;
    }
    const decision = policy.admit(win.waveWindowId, Date.now());
    if (!decision.reload) {
        record(
            `window ${win.waveWindowId} lost its renderer again: ${decision.count} reloads within a minute, ` +
                `not reloading (the window offers Reload)`
        );
        showStopped(win, tabId);
        return;
    }
    record(
        `reloading window ${win.waveWindowId} (tab ${tabId}), reload ${decision.count} of ${RendererReloadLimit} this minute`
    );
    fireAndForget(() => reloadWindow(win, tabId, notice, record));
}

// A browser panel page: its tab view may be gone too (then the page comes back with the view), so it is looked at once
// the other losses of the same kill have arrived.
function recoverWebview(wc: WebContents, record: Recorder) {
    const id = wc.id;
    setTimeout(() => {
        if (isLeaving() || wc.isDestroyed() || !wc.isCrashed()) {
            return;
        }
        const host = wc.hostWebContents;
        if (host == null || host.isDestroyed() || host.isCrashed()) {
            return;
        }
        const decision = policy.admit(`webview:${id}`, Date.now());
        if (!decision.reload) {
            record(
                `browser page of contents ${id} lost its renderer again: ${decision.count} reloads within a minute, not reloading`
            );
            return;
        }
        record(
            `reloading browser page of contents ${id}, reload ${decision.count} of ${RendererReloadLimit} this minute`
        );
        wc.reload();
    }, ReloadSettleMs);
}

export function onRendererGone(wc: WebContents, details: RenderProcessGoneDetails, describe: string, record: Recorder) {
    const now = Date.now();
    const reason = details?.reason;
    const signal = signalName(reason, details?.exitCode);
    const pid = rendererPid(wc);
    record(
        `renderer of ${describe} (pid ${pid || "unknown"}) gone: reason=${reason} exitcode=${details?.exitCode}` +
            (signal != null ? ` (${signal})` : "")
    );
    if (bursts.add({ pid, at: now, signal })) {
        setTimeout(() => closeBurst(record), KillBurstMs);
    }
    if (wc == null || isLeaving() || !isRecoverableLoss(reason)) {
        return;
    }
    const tabView = getWaveTabViewByWebContentsId(wc.id);
    if (tabView != null) {
        if (!tabView.isDestroyed) {
            recoverTabView(tabView, { reason, signal, at: now }, record);
        }
        return;
    }
    let type: string = null;
    try {
        type = wc.getType();
    } catch {
        return;
    }
    if (type === "webview") {
        recoverWebview(wc, record);
    }
}

// Wave's own handlers (emain.ts) quit on these; listening as well only notes when.
function watchMainSignals(record: Recorder) {
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        process.on(name, () => {
            mainSignal = { name, at: Date.now() };
            record(`Electron main received ${name}`);
        });
    }
}

export function initRendererGoneRecovery(record: Recorder) {
    watchMainSignals(record);
    handleAppIpc(ShowLogChannel, () => {
        shell.showItemInFolder(path.join(getWaveDataDir(), "waveapp.log"));
    });
}
