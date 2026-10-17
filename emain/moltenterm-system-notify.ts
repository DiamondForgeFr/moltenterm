// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// System notifications for what cannot wait for the developer to come back (#605): an agent handoff question expires
// after 50 seconds, and while no MoltenTerm window is in front it would only land in the notification center. The
// renderer asks; this side decides, because only the main process knows whether any window has the focus. Every tab
// view of every window watches the same notification center, so one notification id is shown once. Clicking it brings
// the window that asked to the front and tells its active tab view, which shows the question again.

import * as electron from "electron";
import { handleAppIpc, onAppIpc } from "./moltenterm-privileged-ipc";
import { getAllWaveWindows, getWaveWindowByWebContentsId, WaveBrowserWindow } from "./emain-window";

export const SystemNotifyChannel = "moltenterm-system-notify";
export const SystemNotifyCloseChannel = "moltenterm-system-notify-close";
export const SystemNotifyClickChannel = "moltenterm-system-notify-click";

// must match SystemNotifyRequest in frontend/types/custom.d.ts
export type SystemNotifyRequest = { id: string; title: string; body: string };

export type SystemNotifyOutcome = "shown" | "focused" | "duplicate" | "invalid" | "unsupported";

// What a notification needs from Electron, so the decisions can be tested without it.
export type ShownNotification = {
    show(): void;
    close(): void;
    on(event: "click" | "close", listener: () => void): void;
};

export type SystemNotifyDeps = {
    anyWindowFocused(): boolean;
    supported(): boolean;
    make(title: string, body: string): ShownNotification;
    onClick(id: string, senderId: number): void;
};

// Shown ids are remembered for this long, so a renderer that asks again (a reload, a late tab view) is not heard twice.
const RememberShownMs = 10 * 60 * 1000;

export class SystemNotifier {
    deps: SystemNotifyDeps;
    // Electron drops the click handler of a notification that was garbage collected: keep each one until it closes.
    live = new Map<string, ShownNotification>();
    shown = new Map<string, number>();

    constructor(deps: SystemNotifyDeps) {
        this.deps = deps;
    }

    notify(req: SystemNotifyRequest, senderId: number, now = Date.now()): SystemNotifyOutcome {
        const id = typeof req?.id === "string" ? req.id.trim() : "";
        const title = typeof req?.title === "string" ? req.title.trim() : "";
        if (!id || !title) {
            return "invalid";
        }
        this.forgetOld(now);
        if (this.shown.has(id)) {
            return "duplicate";
        }
        if (this.deps.anyWindowFocused()) {
            return "focused";
        }
        if (!this.deps.supported()) {
            return "unsupported";
        }
        this.shown.set(id, now);
        const n = this.deps.make(title, typeof req.body === "string" ? req.body : "");
        this.live.set(id, n);
        n.on("click", () => this.deps.onClick(id, senderId));
        n.on("close", () => this.live.delete(id));
        n.show();
        return "shown";
    }

    close(id: string) {
        const n = this.live.get(id);
        if (n == null) {
            return;
        }
        this.live.delete(id);
        n.close();
    }

    forgetOld(now: number) {
        for (const [id, at] of this.shown) {
            if (now - at > RememberShownMs) {
                this.shown.delete(id);
            }
        }
    }
}

function anyWindowFocused(): boolean {
    return getAllWaveWindows().some((w) => !w.isDestroyed() && w.isFocused());
}

function bringToFront(win: WaveBrowserWindow) {
    if (win.isMinimized()) {
        win.restore();
    }
    win.show();
    win.focus();
}

function windowOfClick(senderId: number): WaveBrowserWindow {
    const sender = getWaveWindowByWebContentsId(senderId);
    if (sender != null && !sender.isDestroyed()) {
        return sender;
    }
    return getAllWaveWindows().find((w) => !w.isDestroyed()) ?? null;
}

function openOnClick(id: string, senderId: number) {
    const win = windowOfClick(senderId);
    if (win == null) {
        return;
    }
    bringToFront(win);
    const target = win.activeTabView?.webContents;
    if (target == null || target.isDestroyed()) {
        return;
    }
    target.send(SystemNotifyClickChannel, id);
}

export function initMoltentermSystemNotify() {
    const notifier = new SystemNotifier({
        anyWindowFocused,
        supported: () => electron.Notification.isSupported(),
        make: (title, body) => new electron.Notification({ title, body }),
        onClick: openOnClick,
    });
    handleAppIpc(SystemNotifyChannel, (event, req: SystemNotifyRequest) =>
        notifier.notify(req, event.sender.id)
    );
    onAppIpc(SystemNotifyCloseChannel, (_event, id: string) => notifier.close(id));
}
