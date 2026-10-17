// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { webContents, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { WaveBrowserWindow } from "./emain-window";
import { isAppIpcSender, onAppIpc } from "./moltenterm-privileged-ipc";

// MOLTENTERM-PATCH (#806): replies belong to the original live application frame and its own guest.

export function getWebContentsByBlockId(ww: WaveBrowserWindow, tabId: string, blockId: string): Promise<WebContents> {
    return new Promise<WebContents>((resolve, reject) => {
        const view = ww?.activeTabView;
        const host = view?.webContents;
        const frame = host && !host.isDestroyed() ? host.mainFrame : null;
        if (view?.waveTabId !== tabId || !isAppIpcSender({ sender: host, senderFrame: frame })) {
            reject(new Error("Application frame unavailable"));
            return;
        }
        const respCh = `getWebContentsByBlockId-${randomUUID()}`;
        let timer: ReturnType<typeof setTimeout>;
        let dispose: () => void;
        const cleanup = () => {
            clearTimeout(timer);
            dispose?.();
            host.removeListener("destroyed", unavailable);
            host.removeListener("did-start-navigation", navigation);
        };
        const unavailable = () => {
            cleanup();
            reject(new Error("Application frame unavailable"));
        };
        const navigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
            if (isMainFrame && !isInPlace) unavailable();
        };
        // A foreign sender must not consume the reply slot. Install before send, and bind both object and frame.
        dispose = onAppIpc(respCh, (event, webContentsId) => {
            if (event.sender !== host || event.senderFrame !== frame) return;
            cleanup();
            // The existing preload replies with the webview's dataset value, hence a decimal string.
            const id = typeof webContentsId === "string" && /^\d+$/.test(webContentsId) ? Number(webContentsId) : webContentsId;
            const wc = Number.isSafeInteger(id) ? webContents.fromId(id) : null;
            resolve(wc && !wc.isDestroyed() && wc.getType() === "webview" && wc.hostWebContents === host ? wc : null);
        });
        host.once("destroyed", unavailable);
        host.on("did-start-navigation", navigation);
        timer = setTimeout(() => {
            cleanup();
            reject(new Error("timeout waiting for response"));
        }, 2000);
        try {
            host.send("webcontentsid-from-blockid", blockId, respCh);
        } catch {
            unavailable();
        }
    });
}

function escapeSelector(selector: string): string {
    return selector
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/'/g, "\\'")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
}

export type WebGetOpts = {
    all?: boolean;
    inner?: boolean;
};

export async function webGetSelector(wc: WebContents, selector: string, opts?: WebGetOpts): Promise<string[]> {
    if (!wc || !selector) {
        return null;
    }
    const escapedSelector = escapeSelector(selector);
    const queryMethod = opts?.all ? "querySelectorAll" : "querySelector";
    const prop = opts?.inner ? "innerHTML" : "outerHTML";
    const execExpr = `
    (() => {
        const toArr = x => (x instanceof NodeList) ? Array.from(x) : (x ? [x] : []);
        try {
            const result = document.${queryMethod}("${escapedSelector}");
            const value = toArr(result).map(el => el.${prop});
            return { value };
        } catch (error) {
            return { error: error.message };
        }
    })()`;
    const results = await wc.executeJavaScript(execExpr);
    if (results.error) {
        throw new Error(results.error);
    }
    return results.value;
}
