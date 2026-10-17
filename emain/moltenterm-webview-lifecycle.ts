// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Hidden browser pages frozen and discarded (#459, FR-PERF-013): the Electron side of
// emain/moltenterm-webview-lifecycle-policy.ts. The browser panel (frontend/moltenterm-shell/browser/browser-view.tsx)
// reports whether each of its webviews is shown; a page is frozen and read through the DevTools protocol, the
// debugger attached only for the call (a freeze outlives the detach), and never while an agent holds the debugger.

import { webContents, type WebContents } from "electron";
import { onAppIpc } from "./moltenterm-privileged-ipc";
import { isAgentControlledContents, onBrowserAgentControl } from "./moltenterm-browseragent";
import { CdpProtocolVersion } from "./moltenterm-browseragent-policy";
import {
    PageCheck,
    PageCheckExpression,
    WouldPromptExpression,
    PageProtection,
    PageScroll,
    readWebviewLifecycleConfig,
    WebviewLifecycleConfig,
    WebviewLifecycleTracker,
} from "./moltenterm-webview-lifecycle-policy";

// Sent by the panel: (blockId, browserTabId, webContentsId, shown, offCarpet).
export const WebviewShownChannel = "moltenterm-webview-shown";
// Sent to the panel: drop this tab's webview, keeping its tab (blockId, browserTabId, webContentsId, scroll).
export const WebviewDiscardChannel = "moltenterm-webview-discard";

const CdpCallTimeoutMs = 2000;

type Target = { blockId: string; browserTabId: string; hostId: number };

let config: WebviewLifecycleConfig = readWebviewLifecycleConfig(null);
const targets = new Map<number, Target>();
let tracker: WebviewLifecycleTracker = null;

function liveContents(id: number): WebContents {
    const wc = webContents.fromId(id);
    return wc == null || wc.isDestroyed() ? null : wc;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> = null;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// One DevTools session for the call: an agent's session (a controlled page) is never borrowed nor detached.
async function withDebugger<T>(wc: WebContents, fn: (send: (method: string, params?: any) => Promise<any>) => Promise<T>) {
    if (wc.debugger.isAttached() || wc.isDevToolsOpened()) {
        return null;
    }
    wc.debugger.attach(CdpProtocolVersion);
    const send = (method: string, params: any = {}) =>
        withTimeout(wc.debugger.sendCommand(method, params), CdpCallTimeoutMs);
    try {
        return await fn(send);
    } finally {
        try {
            if (!wc.isDestroyed() && wc.debugger.isAttached()) {
                wc.debugger.detach();
            }
        } catch {
            // already detached
        }
    }
}

async function readPage(send: (method: string, params?: any) => Promise<any>): Promise<PageCheck> {
    const group = "molten-lifecycle";
    try {
        const win = await send("Runtime.evaluate", { expression: "window", objectGroup: group });
        const listeners = await send("DOMDebugger.getEventListeners", { objectId: win.result.objectId });
        const beforeUnload = (listeners?.listeners ?? []).some((l: any) => l.type === "beforeunload");
        const page = await send("Runtime.evaluate", { expression: PageCheckExpression, returnByValue: true });
        const v = page?.result?.value;
        if (v == null || page.exceptionDetails != null) {
            return null;
        }
        const scroll: PageScroll = { x: Number(v.x) || 0, y: Number(v.y) || 0 };
        return { dirty: v.dirty === true, unloadListener: beforeUnload, scroll };
    } finally {
        await send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
}

async function wouldPromptOnUnload(wcId: number): Promise<boolean> {
    const wc = liveContents(wcId);
    if (wc == null) {
        return null;
    }
    try {
        return await withDebugger(wc, async (send) => {
            const r = await send("Runtime.evaluate", { expression: WouldPromptExpression, returnByValue: true });
            const v = r?.result?.value;
            return r?.exceptionDetails == null && typeof v === "boolean" ? v : null;
        });
    } catch (e) {
        console.log("[#459] trying a page's beforeunload failed", String(e));
        return null;
    }
}

async function checkPage(wcId: number): Promise<PageCheck> {
    const wc = liveContents(wcId);
    if (wc == null) {
        return null;
    }
    try {
        return await withDebugger(wc, readPage);
    } catch (e) {
        console.log("[#459] reading a hidden page failed", String(e));
        return null;
    }
}

async function freezePage(wcId: number): Promise<PageCheck> {
    const wc = liveContents(wcId);
    if (wc == null) {
        return null;
    }
    try {
        return await withDebugger(wc, async (send) => {
            const check = await readPage(send);
            if (check == null) {
                return null;
            }
            await send("Page.setWebLifecycleState", { state: "frozen" });
            return check;
        });
    } catch (e) {
        console.log("[#459] freezing a hidden page failed", String(e));
        return null;
    }
}

async function thawPage(wcId: number): Promise<void> {
    const wc = liveContents(wcId);
    if (wc == null) {
        return;
    }
    try {
        // An agent's session is already there when it takes a frozen page.
        if (wc.debugger.isAttached()) {
            await withTimeout(
                wc.debugger.sendCommand("Page.setWebLifecycleState", { state: "active" }),
                CdpCallTimeoutMs
            );
            return;
        }
        await withDebugger(wc, (send) => send("Page.setWebLifecycleState", { state: "active" }));
    } catch (e) {
        console.log("[#459] thawing a page failed", String(e));
    }
}

function protection(wcId: number): PageProtection {
    const wc = liveContents(wcId);
    if (wc == null) {
        return { gone: true, controlled: false, audible: false, devtools: false };
    }
    return {
        gone: false,
        controlled: isAgentControlledContents(wcId),
        audible: wc.isCurrentlyAudible(),
        devtools: wc.isDevToolsOpened(),
    };
}

function discardPage(wcId: number, scroll: PageScroll) {
    const target = targets.get(wcId);
    const host = target ? liveContents(target.hostId) : null;
    if (host == null) {
        return;
    }
    host.send(WebviewDiscardChannel, target.blockId, target.browserTabId, wcId, scroll);
}

function getTracker(): WebviewLifecycleTracker {
    tracker ??= new WebviewLifecycleTracker({
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle),
        config: () => config,
        protection,
        freeze: freezePage,
        thaw: thawPage,
        check: checkPage,
        wouldPromptOnUnload,
        discard: discardPage,
        log: (msg) => console.log(msg),
    });
    return tracker;
}

function onShown(
    event: Electron.IpcMainEvent,
    blockId: unknown,
    browserTabId: unknown,
    webContentsId: unknown,
    shown: unknown,
    offCarpet?: unknown
) {
    if (typeof blockId !== "string" || typeof browserTabId !== "string" || typeof webContentsId !== "number") {
        return;
    }
    const wc = liveContents(webContentsId);
    // Only a webview guest of the tab view that reports it.
    if (wc == null || wc.getType() !== "webview" || wc.hostWebContents?.id !== event.sender.id) {
        return;
    }
    if (!targets.has(wc.id)) {
        wc.once("destroyed", () => {
            targets.delete(webContentsId);
            tracker?.forget(webContentsId);
        });
    }
    targets.set(wc.id, { blockId, browserTabId, hostId: event.sender.id });
    getTracker().report(wc.id, shown === true, offCarpet === true);
}

export function noteWebviewLifecycleSettings(settings: Record<string, unknown>) {
    const next = readWebviewLifecycleConfig(settings);
    if (next.freeze === config.freeze && next.discardMs === config.discardMs) {
        return;
    }
    config = next;
    console.log("[#459] hidden pages", JSON.stringify(next));
    tracker?.noteConfigChanged();
}

// The tab view budget's unsaved-work check (#476): a view whose browser pages hold unsaved work is kept.
export async function hostedPagesHaveUnsavedWork(hostWebContentsId: number): Promise<boolean> {
    const guests = webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && wc.getType() === "webview" && wc.hostWebContents?.id === hostWebContentsId);
    for (const wc of guests) {
        if (await getTracker().hasUnsavedWork(wc.id)) {
            return true;
        }
    }
    return false;
}

let started = false;

export function initMoltentermWebviewLifecycle(settings: Record<string, unknown>) {
    noteWebviewLifecycleSettings(settings);
    if (started) {
        return;
    }
    started = true;
    onAppIpc(WebviewShownChannel, onShown);
    onBrowserAgentControl((wcId) => tracker?.noteControlled(wcId));
}
