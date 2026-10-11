// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pending state of a window (#450, FR-PERF-004, DS-PERF-005): while a workspace's view loads, the window shows the
// workspace's name and a quiet progress line instead of a blank or frozen surface, says when it retries, and offers
// Reload after a second failure.
//
// Two surfaces. When the window shows a live view (a switch, a create, a delete), that view draws the pending state
// over its panels (frontend/moltenterm-shell/view-pending.tsx): no new renderer, so it is on screen within the grace
// plus one frame, and the rail stays usable, so a click during a pending switch is queued and the pending state names
// the last workspace asked for. When there is no live view (the first tab at launch), a static page in its own small
// view (no JavaScript) is shown on top of the window instead, so the window is never shown empty.

import { WebContentsView } from "electron";

export const ViewPendingChannel = "moltenterm-view-pending";
export const ViewPendingActionChannel = "moltenterm-view-pending-action";
// A switch to a warm view takes 50 to 150 ms: shorter ones never show the pending state, longer ones show it within
// 100 ms.
export const ViewPendingGraceMs = 60;
// A launch shows its window when the first tab is ready (about 2 s); the pending page only shows a slower one.
export const StartupPendingGraceMs = 3000;
export const PendingPageReloadUrl = "moltenterm-pending://reload";

export type ViewPendingPhase = "loading" | "retrying" | "failed";

export type ViewPendingState = {
    phase: ViewPendingPhase;
    workspaceName: string;
};

export type PendingLiveView = {
    isDestroyed: boolean;
    webContents: { send(channel: string, ...args: any[]): void; isDestroyed(): boolean };
};

export type ViewPendingSurface = {
    // The view on screen that has rendered and can draw the pending state, or null.
    liveView(): PendingLiveView;
    showPage(state: ViewPendingState): void;
    hidePage(): void;
};

type PendingTarget = {
    workspaceName: string;
    onReload: () => void;
};

function isLive(view: PendingLiveView): boolean {
    return view != null && !view.isDestroyed && !view.webContents.isDestroyed();
}

export class ViewPendingController {
    target: PendingTarget = null;
    phase: ViewPendingPhase = null;
    shownOn: "view" | "page" = null;
    shownView: PendingLiveView = null;
    timer: ReturnType<typeof setTimeout> = null;
    token = 0;

    constructor(readonly surface: ViewPendingSurface) {}

    isShown(): boolean {
        return this.shownOn != null;
    }

    // A view starts loading for `workspaceName`. The pending state shows `graceMs` after `startedAt` unless `end` comes
    // first; when one is already shown (a newer click during a pending switch), it names the new workspace at once.
    begin(workspaceName: string, onReload: () => void, startedAt: number, graceMs = ViewPendingGraceMs): number {
        this.token++;
        this.clearTimer();
        this.target = { workspaceName, onReload };
        this.phase = "loading";
        if (this.shownOn != null) {
            this.render();
            return this.token;
        }
        const wait = Math.max(0, startedAt + graceMs - Date.now());
        this.timer = setTimeout(() => {
            this.timer = null;
            this.render();
        }, wait);
        return this.token;
    }

    // "retrying" and "failed" show at once, whatever is left of the grace.
    setPhase(token: number, phase: ViewPendingPhase) {
        if (token !== this.token || this.target == null) {
            return;
        }
        this.clearTimer();
        this.phase = phase;
        this.render();
    }

    // The view is on screen (or the action that began it is over): the pending state goes.
    end(token: number) {
        if (token !== this.token) {
            return;
        }
        this.hide();
    }

    // Nothing is left in the window's queue: a pending state that is not a failure has nothing left to wait for.
    settle() {
        if (this.phase === "failed") {
            return;
        }
        this.hide();
    }

    dismiss() {
        this.hide();
    }

    // The pending state stays (loading again) until the action Reload queues takes it over, so the window never goes
    // blank in between; if that action has nothing to load, the queue settles it.
    reload() {
        const onReload = this.target?.onReload;
        if (onReload == null) {
            this.hide();
            return;
        }
        this.clearTimer();
        this.phase = "loading";
        this.render();
        onReload();
    }

    hide() {
        this.clearTimer();
        this.target = null;
        this.phase = null;
        if (this.shownOn === "view" && isLive(this.shownView)) {
            this.shownView.webContents.send(ViewPendingChannel, null);
        }
        if (this.shownOn === "page") {
            this.surface.hidePage();
        }
        this.shownOn = null;
        this.shownView = null;
    }

    private clearTimer() {
        if (this.timer != null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private render() {
        if (this.target == null) {
            return;
        }
        const state: ViewPendingState = { phase: this.phase, workspaceName: this.target.workspaceName };
        const live = this.surface.liveView();
        if (this.shownOn === "view" && this.shownView !== live && isLive(this.shownView)) {
            this.shownView.webContents.send(ViewPendingChannel, null);
        }
        if (isLive(live)) {
            if (this.shownOn === "page") {
                this.surface.hidePage();
            }
            live.webContents.send(ViewPendingChannel, state);
            this.shownOn = "view";
            this.shownView = live;
            return;
        }
        this.surface.showPage(state);
        this.shownOn = "page";
        this.shownView = null;
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// The colours are DS-SHELL's neutral tokens with the default molten accent (frontend/moltenterm-shell/
// moltenterm-shell.css); the page has no access to the workspace's own accent.
export function makePendingPageHtml(state: ViewPendingState): string {
    const name = escapeHtml(state.workspaceName || "Workspace");
    const failed = state.phase === "failed";
    const caption = failed
        ? "Its view did not answer in time, even after a retry."
        : state.phase === "retrying"
          ? "Still opening. Your machine is busy."
          : "Opening…";
    const body = failed
        ? `<div class="name">${name} did not open</div><p class="caption">${caption}</p><a class="btn" href="${PendingPageReloadUrl}">Reload</a>`
        : `<div class="name">${name}</div><div class="line" role="progressbar" aria-label="Opening ${name}"><span></span></div><p class="caption">${caption}</p>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MoltenTerm</title><style>
:root{--accent:rgb(255,124,13);--bg:color-mix(in srgb,var(--accent) 4%,rgb(31,31,31));--text:color-mix(in srgb,var(--accent) 3%,rgb(247,247,247));--muted:color-mix(in srgb,var(--accent) 6%,rgb(146,146,146));--line:color-mix(in srgb,color-mix(in srgb,var(--accent) 6%,rgb(198,198,198)) 16%,transparent)}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-user-select:none;user-select:none;cursor:default}
body{display:flex;align-items:center;justify-content:center}
main{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:360px;text-align:center;animation:in .12s ease-out}
.name{font-weight:600;font-size:13px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.caption{margin:0;font-size:12px;color:var(--muted)}
.line{position:relative;width:160px;height:2px;border-radius:1px;background:var(--line);overflow:hidden}
.line span{position:absolute;inset:0 auto 0 0;width:40%;border-radius:1px;background:var(--accent);opacity:.7;animation:sweep 1.4s ease-in-out infinite}
.btn{margin-top:6px;padding:6px 12px;border-radius:6px;background:var(--accent);color:#1f1208;font-size:12px;font-weight:500;text-decoration:none;cursor:pointer}
.btn:hover{background:color-mix(in srgb,var(--accent) 80%,white)}
@keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@keyframes in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.line span{width:100%;animation:none;opacity:.5}main{animation:none}}
</style></head><body><main data-molten-view-pending="${state.phase}">${body}</main></body></html>`;
}

export type PendingPage = {
    view: WebContentsView;
    loaded: Promise<void>;
};

// A static page in a small sandboxed view, JavaScript off; its Reload link is caught as a navigation.
export function makePendingPage(state: ViewPendingState, onReload: () => void): PendingPage {
    const view = new WebContentsView({
        webPreferences: { javascript: false, sandbox: true, contextIsolation: true },
    });
    (view as any).moltenPendingView = true;
    (view as any).moltenPendingState = state.phase;
    view.setBackgroundColor("#00000000");
    view.webContents.on("will-navigate", (e: Electron.Event, url: string) => {
        e.preventDefault();
        if (url === PendingPageReloadUrl) {
            onReload();
        }
    });
    const loaded = loadPendingPage(view, state);
    return { view, loaded };
}

export function loadPendingPage(view: WebContentsView, state: ViewPendingState): Promise<void> {
    (view as any).moltenPendingState = state.phase;
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(makePendingPageHtml(state));
    return Promise.resolve(view.webContents.loadURL(url)).catch((): void => null);
}
