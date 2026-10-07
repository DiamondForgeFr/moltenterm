// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// emain's side of the agents in the browser panel (FR-BRW-008, DS-BRW-010/011/012). It keeps a registry of the panel
// tabs' webviews, fed by the panels themselves (the existing lookup by block id only finds a panel's first webview),
// runs the allow-listed DevTools methods wavesrv sends through webContents.debugger, and watches a controlled tab for
// the user's own clicks and keys, which take over from the agent.

import { ipcMain, webContents, type WebContents } from "electron";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthKey } from "./authkey";
import {
    cdpMethodAllowed,
    CdpProtocolVersion,
    isSyntheticInputMethod,
    isTakeoverKey,
    isTakeoverMouse,
    validRegistration,
    webviewKey,
} from "./moltenterm-browseragent-policy";

// Sent by frontend/moltenterm-shell/browser/browser-view.tsx when a tab's webview is ready.
export const WebviewRegisteredChannel = "moltenterm-webview-registered";
// Sent by a panel page's preload (emain/preload-webview.ts) on the user's trusted mousedown or keydown.
export const WebviewInputChannel = "moltenterm-webview-input";

// must match emainTokenLabel in pkg/molten/browseragent/waveenv.go: wavesrv proves it sent a command with a token
// derived from the auth key emain gave it, since any route can address emain.
const EmainTokenLabel = "molten:browseragent";
const ExpectedToken = createHmac("sha256", AuthKey).update(EmainTokenLabel).digest();

// After the agent's own input, the guest's events for it may still arrive.
const SyntheticInputGraceMs = 150;
const TakeoverReportEveryMs = 250;

export type CdpCallData = { blockid: string; browsertabid: string; method: string; params?: any; token: string };
export type ControlData = { blockid: string; browsertabid: string; controlled: boolean; token: string };
export type TakeoverReport = (blockId: string, browserTabId: string) => void;

type Registration = { blockId: string; browserTabId: string; webContentsId: number };

const registry = new Map<string, Registration>();
const controlled = new Set<string>();
// Tabs the user took over: refused here at once, before wavesrv hears of it, until control is granted again.
const paused = new Set<string>();
const watchers = new Map<number, () => void>();
const syntheticDepth = new Map<number, number>();
const syntheticUntil = new Map<number, number>();
const lastReport = new Map<string, number>();
let reportTakeover: TakeoverReport = () => {};

function fromWavesrv(token: unknown): boolean {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        return false;
    }
    return timingSafeEqual(Buffer.from(token, "hex"), ExpectedToken);
}

function liveContents(id: number): WebContents {
    const wc = webContents.fromId(id);
    return wc == null || wc.isDestroyed() ? null : wc;
}

function isSynthetic(wcId: number): boolean {
    return (syntheticDepth.get(wcId) ?? 0) > 0 || Date.now() < (syntheticUntil.get(wcId) ?? 0);
}

function noteUserInput(reg: Registration): void {
    if (isSynthetic(reg.webContentsId)) {
        return;
    }
    const key = webviewKey(reg.blockId, reg.browserTabId);
    const now = Date.now();
    if (now - (lastReport.get(key) ?? 0) < TakeoverReportEveryMs) {
        return;
    }
    lastReport.set(key, now);
    paused.add(key);
    reportTakeover(reg.blockId, reg.browserTabId);
}

function startWatching(reg: Registration, wc: WebContents): void {
    if (watchers.has(wc.id)) {
        return;
    }
    const onKey = (_e: Electron.Event, input: Electron.Input) => {
        if (isTakeoverKey(input)) {
            noteUserInput(reg);
        }
    };
    const onMouse = (_e: Electron.Event, mouse: Electron.MouseInputEvent) => {
        if (isTakeoverMouse(mouse)) {
            noteUserInput(reg);
        }
    };
    wc.on("before-input-event", onKey);
    wc.on("before-mouse-event", onMouse);
    // A page under control keeps running while its Wave tab or panel tab is hidden.
    wc.setBackgroundThrottling(false);
    watchers.set(wc.id, () => {
        wc.off("before-input-event", onKey);
        wc.off("before-mouse-event", onMouse);
        wc.setBackgroundThrottling(true);
    });
}

function stopWatching(wc: WebContents): void {
    const stop = watchers.get(wc.id);
    watchers.delete(wc.id);
    stop?.();
    if (wc.debugger.isAttached()) {
        try {
            wc.debugger.detach();
        } catch (e) {
            console.log("molten browser agent: detach failed", e);
        }
    }
}

function applyControl(key: string): void {
    const reg = registry.get(key);
    const wc = reg ? liveContents(reg.webContentsId) : null;
    if (wc == null) {
        return;
    }
    if (controlled.has(key)) {
        startWatching(reg, wc);
        return;
    }
    stopWatching(wc);
}

function register(event: Electron.IpcMainEvent, blockId: unknown, browserTabId: unknown, webContentsId: unknown): void {
    if (!validRegistration(blockId, browserTabId, webContentsId)) {
        return;
    }
    const wc = liveContents(webContentsId as number);
    // Only a webview guest of the window that reports it: a page cannot register itself or another window's tab.
    if (wc == null || wc.getType() !== "webview" || wc.hostWebContents?.id !== event.sender.id) {
        return;
    }
    const key = webviewKey(blockId as string, browserTabId as string);
    const previous = registry.get(key);
    // dom-ready comes again with each page load of the same webview.
    if (previous?.webContentsId === wc.id) {
        applyControl(key);
        return;
    }
    if (previous != null) {
        const old = liveContents(previous.webContentsId);
        if (old != null) {
            stopWatching(old);
        }
    }
    const reg: Registration = {
        blockId: blockId as string,
        browserTabId: browserTabId as string,
        webContentsId: wc.id,
    };
    registry.set(key, reg);
    wc.once("destroyed", () => {
        watchers.delete(reg.webContentsId);
        syntheticDepth.delete(reg.webContentsId);
        syntheticUntil.delete(reg.webContentsId);
        if (registry.get(key)?.webContentsId === reg.webContentsId) {
            registry.delete(key);
        }
    });
    applyControl(key);
}

// moltenbrowsercontrol: wavesrv marks a tab as driven by an agent, or releases it (Stop, the agent left).
export function setBrowserAgentControl(data: ControlData): void {
    if (!fromWavesrv(data?.token) || !validRegistration(data?.blockid, data?.browsertabid, 1)) {
        return;
    }
    const key = webviewKey(data.blockid, data.browsertabid);
    paused.delete(key);
    if (data.controlled) {
        controlled.add(key);
    } else {
        controlled.delete(key);
        lastReport.delete(key);
    }
    applyControl(key);
}

// moltenbrowsercdp: one allow-listed DevTools method on a controlled, registered tab. The debugger attaches on first
// use and detaches when control ends.
export async function runBrowserAgentCdp(data: CdpCallData): Promise<any> {
    if (!fromWavesrv(data?.token)) {
        throw new Error("only MoltenTerm's agent sessions can drive a browser tab");
    }
    if (!cdpMethodAllowed(data?.method)) {
        throw new Error(`DevTools method not allowed: ${String(data?.method).slice(0, 80)}`);
    }
    if (!validRegistration(data.blockid, data.browsertabid, 1)) {
        throw new Error("no such tab");
    }
    const key = webviewKey(data.blockid, data.browsertabid);
    if (!controlled.has(key)) {
        throw new Error("This tab is not under agent control");
    }
    if (paused.has(key)) {
        throw new Error("The user has taken over");
    }
    const reg = registry.get(key);
    const wc = reg ? liveContents(reg.webContentsId) : null;
    if (wc == null) {
        throw new Error("The tab's page is not loaded: show its MoltenTerm tab");
    }
    if (wc.isDevToolsOpened()) {
        throw new Error("Close DevTools on this tab to let the agent use it");
    }
    if (!wc.debugger.isAttached()) {
        wc.debugger.attach(CdpProtocolVersion);
    }
    const synthetic = isSyntheticInputMethod(data.method);
    if (synthetic) {
        syntheticDepth.set(wc.id, (syntheticDepth.get(wc.id) ?? 0) + 1);
    }
    try {
        return await wc.debugger.sendCommand(data.method, data.params ?? {});
    } finally {
        if (synthetic) {
            syntheticDepth.set(wc.id, Math.max(0, (syntheticDepth.get(wc.id) ?? 1) - 1));
            syntheticUntil.set(wc.id, Date.now() + SyntheticInputGraceMs);
        }
    }
}

// The preload sees input in the page's main frame, synthetic or not; before-input-event and before-mouse-event also
// catch native input the page's frames get.
function pageInput(event: Electron.IpcMainEvent): void {
    for (const [key, reg] of registry) {
        if (reg.webContentsId === event.sender.id && controlled.has(key)) {
            noteUserInput(reg);
            return;
        }
    }
}

export function initMoltentermBrowserAgent(report: TakeoverReport): void {
    reportTakeover = report;
    ipcMain.on(WebviewRegisteredChannel, register);
    ipcMain.on(WebviewInputChannel, pageInput);
}
