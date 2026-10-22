// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The hang watch (#849): Electron main records in waveapp.log when a window stops answering, when a renderer or a
// child process dies, when its own loop was blocked and when a sendSync round trip was slow; the window that stalled
// is told how long once it answers again, and the diagnostics copy the recent events. Lines start with "hang:".

import { app, clipboard, powerMonitor, WebContents } from "electron";
import { setBackendCallReporter } from "../frontend/moltenterm-shell/backend-call-retry";
import { getWaveVersion } from "./emain-wavesrv";
import { getAllWaveWindows } from "./emain-window";
import {
    HangCopyChannel,
    HangDiagnosticsChannel,
    HangPingChannel,
    HangPongChannel,
    SlowSyncIpcChannel,
    WindowHangChannel,
} from "./moltenterm-hang-ipc";
import { HangEventLog, HangPingMs, HangWatchModel, shouldNotifyStall } from "./moltenterm-hang-model";
import { handleAppIpc, onAppIpc } from "./moltenterm-privileged-ipc";
import { initRendererGoneRecovery, onRendererGone, trackRendererPid } from "./moltenterm-renderer-gone";

export type WindowHang = { ms: number; at: number };

export type HangDiagnostics = { version: string; buildtime: number; uptimesec: number; events: string[] };

const model = new HangWatchModel();
const events = new HangEventLog();

function stamp(now: number): string {
    return new Date(now).toISOString();
}

function record(line: string) {
    events.add(`${stamp(Date.now())} ${line}`);
    console.log(`hang: ${line}`);
}

function describe(wc: WebContents): string {
    if (wc == null) {
        return "unknown contents";
    }
    try {
        return `${wc.getType()} contents ${wc.id}`;
    } catch {
        return `contents ${wc.id}`;
    }
}

// The active tab view of each shown window: a hidden or minimised window's page may be throttled by the system, and a
// tab view still loading is not answering clicks yet anyway.
function watchedContents(): Map<number, WebContents> {
    const watched = new Map<number, WebContents>();
    for (const win of getAllWaveWindows()) {
        if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
            continue;
        }
        const tabView = win.activeTabView;
        const wc = tabView?.webContents;
        if (tabView == null || tabView.isDestroyed || !tabView.isWaveReady || wc == null || wc.isDestroyed()) {
            continue;
        }
        watched.set(wc.id, wc);
    }
    return watched;
}

function tick() {
    const now = Date.now();
    const watched = watchedContents();
    const result = model.tick(now, [...watched.keys()]);
    if (result.mainLagMs > 0) {
        record(`Electron main was blocked about ${result.mainLagMs} ms`);
    }
    for (const stall of result.stalled) {
        record(`${describe(watched.get(stall.id))} unresponsive: no answer for ${stall.ms} ms`);
    }
    for (const ping of result.ping) {
        watched.get(ping.id)?.send(HangPingChannel, ping.seq);
    }
}

function onPong(sender: WebContents, seq: number) {
    const { stalledMs } = model.pong(sender.id, seq, Date.now());
    if (stalledMs <= 0) {
        return;
    }
    record(`${describe(sender)} responsive again after ${stalledMs} ms`);
    if (!shouldNotifyStall(stalledMs) || sender.isDestroyed()) {
        return;
    }
    const hang: WindowHang = { ms: stalledMs, at: Date.now() - stalledMs };
    sender.send(WindowHangChannel, hang);
}

function watchContents(wc: WebContents) {
    wc.on("unresponsive", () => record(`${describe(wc)} reported unresponsive by Chromium`));
    wc.on("responsive", () => record(`${describe(wc)} reported responsive again by Chromium`));
}

export function hangDiagnostics(): HangDiagnostics {
    const version = getWaveVersion();
    return {
        version: version.version,
        buildtime: version.buildTime,
        uptimesec: Math.round(process.uptime()),
        events: events.recent(),
    };
}

export function initMoltentermHangWatch() {
    setBackendCallReporter(record);
    app.on("web-contents-created", (_event, wc) => watchContents(wc));
    app.on("web-contents-created", (_event, wc) => trackRendererPid(wc));
    app.on("render-process-gone", (_event, wc, details) => onRendererGone(wc, details, describe(wc), record));
    initRendererGoneRecovery(record);
    app.on("child-process-gone", (_event, details) => {
        const name = details?.name ? ` (${details.name})` : "";
        record(`child process ${details?.type}${name} gone: reason=${details?.reason} exitcode=${details?.exitCode}`);
    });
    onAppIpc(HangPongChannel, (event, seq: number) => onPong(event.sender, seq));
    onAppIpc(SlowSyncIpcChannel, (event, channel: string, ms: number) => {
        record(`sendSync "${String(channel).slice(0, 80)}" from ${describe(event.sender)} took ${Number(ms)} ms`);
    });
    handleAppIpc(HangDiagnosticsChannel, () => hangDiagnostics());
    handleAppIpc(HangCopyChannel, (_event, text: unknown) => {
        if (typeof text !== "string") {
            throw new Error("hang diagnostics: text expected");
        }
        clipboard.writeText(text.slice(0, 200000));
    });
    powerMonitor.on("suspend", () => model.pause());
    powerMonitor.on("resume", () => model.resume());
    setInterval(tick, HangPingMs);
}
