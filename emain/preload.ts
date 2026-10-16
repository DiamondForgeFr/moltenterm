// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { contextBridge, ipcRenderer, Rectangle, webUtils, WebviewTag } from "electron";
// MOLTENTERM-PATCH (#849): every sendSync is timed, and the page answers Electron main's heartbeat
import {
    HangCopyChannel,
    HangDiagnosticsChannel,
    HangPingChannel,
    HangPongChannel,
    timedSendSync,
    WindowHangChannel,
} from "./moltenterm-hang-ipc";
import { SlowSyncIpcMs } from "./moltenterm-hang-model";

function sendSync(channel: string, ...args: any[]): any {
    return timedSendSync(ipcRenderer, SlowSyncIpcMs, () => performance.now(), channel, ...args);
}

// Answered on the page's own thread: a page stuck in a long task answers late, which is what Electron main measures.
ipcRenderer.on(HangPingChannel, (_event, seq: number) => ipcRenderer.send(HangPongChannel, seq));

// update type in custom.d.ts (ElectronApi type)
contextBridge.exposeInMainWorld("api", {
    getAuthKey: () => sendSync("get-auth-key"),
    // MOLTENTERM-PATCH (#808): revisioned read-only accessibility state.
    getAccessibilitySupport: () => sendSync("moltenterm:get-accessibility-support"),
    onAccessibilitySupportChange: (callback) => {
        const listener = (_event, snapshot) => callback(snapshot);
        ipcRenderer.on("moltenterm:accessibility-support-changed", listener);
        return () => ipcRenderer.removeListener("moltenterm:accessibility-support-changed", listener);
    },
    getIsDev: () => sendSync("get-is-dev"),
    getPlatform: () => sendSync("get-platform"),
    getCursorPoint: () => sendSync("get-cursor-point"),
    getUserName: () => sendSync("get-user-name"),
    getHostName: () => sendSync("get-host-name"),
    getDataDir: () => sendSync("get-data-dir"),
    getConfigDir: () => sendSync("get-config-dir"),
    getHomeDir: () => sendSync("get-home-dir"),
    getAboutModalDetails: () => sendSync("get-about-modal-details"),
    getWebviewPreload: () => sendSync("get-webview-preload"),
    getZoomFactor: () => sendSync("get-zoom-factor"),
    openNewWindow: () => ipcRenderer.send("open-new-window"),
    showWorkspaceAppMenu: (workspaceId) => ipcRenderer.send("workspace-appmenu-show", workspaceId),
    showBuilderAppMenu: (builderId) => ipcRenderer.send("builder-appmenu-show", builderId),
    // MOLTENTERM-PATCH (#371): correlate native dismissal and capture owned edit targets before focus moves.
    showContextMenu: (workspaceId, menu, token, target) =>
        ipcRenderer.send("contextmenu-show", workspaceId, menu, token, target),
    revokeContextMenuTarget: (token) => ipcRenderer.send("moltenterm-contextmenu-revoke", token),
    captureContextMenuTarget: (guestId) => sendSync("moltenterm-contextmenu-capture", guestId),
    executeContextMenuRole: (token, role) => ipcRenderer.send("moltenterm-contextmenu-role", token, role),
    saveContextMenuImage: (token) => ipcRenderer.send("moltenterm-contextmenu-save-image", token),
    setContextMenuGuest: (guestId, active) => ipcRenderer.send("moltenterm-contextmenu-guest", guestId, active),
    onGuestContextMenu: (callback) => {
        const listener = (_event, menu) => callback(menu);
        ipcRenderer.on("moltenterm-contextmenu-guest-show", listener);
        return () => ipcRenderer.removeListener("moltenterm-contextmenu-guest-show", listener);
    },
    onContextMenuClick: (callback: (id: string | null, token?: string) => void) =>
        ipcRenderer.on("contextmenu-click", (_event, id: string | null, token?: string) => callback(id, token)),
    downloadFile: (filePath) => ipcRenderer.send("download", { filePath }),
    openExternal: (url) => {
        if (url && typeof url === "string") {
            ipcRenderer.send("open-external", url);
        } else {
            console.error("Invalid URL passed to openExternal:", url);
        }
    },
    getEnv: (varName) => sendSync("get-env", varName),
    onFullScreenChange: (callback) =>
        ipcRenderer.on("fullscreen-change", (_event, isFullScreen) => callback(isFullScreen)),
    onZoomFactorChange: (callback) =>
        ipcRenderer.on("zoom-factor-change", (_event, zoomFactor) => callback(zoomFactor)),
    onUpdaterStatusChange: (callback) => ipcRenderer.on("app-update-status", (_event, status) => callback(status)),
    getUpdaterStatus: () => sendSync("get-app-update-status"),
    getUpdaterChannel: () => sendSync("get-updater-channel"),
    installAppUpdate: () => ipcRenderer.send("install-app-update"),
    onMenuItemAbout: (callback) => ipcRenderer.on("menu-item-about", callback),
    updateWindowControlsOverlay: (rect) => ipcRenderer.send("update-window-controls-overlay", rect),
    onReinjectKey: (callback) => ipcRenderer.on("reinject-key", (_event, waveEvent) => callback(waveEvent)),
    setWebviewFocus: (focused: number) => ipcRenderer.send("webview-focus", focused),
    registerGlobalWebviewKeys: (keys) => ipcRenderer.send("register-global-webview-keys", keys),
    onControlShiftStateUpdate: (callback) =>
        ipcRenderer.on("control-shift-state-update", (_event, state) => callback(state)),
    createWorkspace: () => ipcRenderer.send("create-workspace"),
    switchWorkspace: (workspaceId) => ipcRenderer.send("switch-workspace", workspaceId),
    deleteWorkspace: (workspaceId) => ipcRenderer.send("delete-workspace", workspaceId),
    resetWorkspace: (workspaceId) => ipcRenderer.send("reset-workspace", workspaceId), // MOLTENTERM-PATCH (#222)
    setActiveTab: (tabId) => ipcRenderer.send("set-active-tab", tabId),
    createTab: () => ipcRenderer.send("create-tab"),
    closeTab: (workspaceId, tabId, confirmClose) => ipcRenderer.invoke("close-tab", workspaceId, tabId, confirmClose),
    setWindowInitStatus: (status) => ipcRenderer.send("set-window-init-status", status),
    onWaveInit: (callback) => ipcRenderer.on("wave-init", (_event, initOpts) => callback(initOpts)),
    onBuilderInit: (callback) => ipcRenderer.on("builder-init", (_event, initOpts) => callback(initOpts)),
    sendLog: (log) => ipcRenderer.send("fe-log", log),
    onQuicklook: (filePath: string) => ipcRenderer.send("quicklook", filePath),
    openNativePath: (filePath: string) => ipcRenderer.send("open-native-path", filePath),
    captureScreenshot: (rect: Rectangle) => ipcRenderer.invoke("capture-screenshot", rect),
    setKeyboardChordMode: () => ipcRenderer.send("set-keyboard-chord-mode"),
    clearWebviewStorage: (webContentsId: number) => ipcRenderer.invoke("clear-webview-storage", webContentsId),
    setWaveAIOpen: (isOpen: boolean) => ipcRenderer.send("set-waveai-open", isOpen),
    closeBuilderWindow: () => ipcRenderer.send("close-builder-window"),
    incrementTermCommands: (opts?: { isRemote?: boolean; isWsl?: boolean; isDurable?: boolean }) =>
        ipcRenderer.send("increment-term-commands", opts),
    nativePaste: () => ipcRenderer.send("native-paste"),
    openBuilder: (appId?: string) => ipcRenderer.send("open-builder", appId),
    setBuilderWindowAppId: (appId: string) => ipcRenderer.send("set-builder-window-appid", appId),
    doRefresh: () => ipcRenderer.send("do-refresh"),
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
    saveTextFile: (fileName: string, content: string) => ipcRenderer.invoke("save-text-file", fileName, content),
    setIsActive: () => ipcRenderer.invoke("set-is-active"),
    // MOLTENTERM-PATCH (#30): native pickers of the Moltenterm shell (emain/moltenterm-dialogs.ts)
    moltentermChoosePath: (opts: any) => ipcRenderer.invoke("moltenterm-choose-path", opts),
    // MOLTENTERM-PATCH (#64): gold updates (emain/moltenterm-update.ts)
    moltentermUpdateCheck: (ownBuildId: number) => ipcRenderer.invoke("moltenterm-update-check", ownBuildId),
    moltentermUpdateApply: (buildId: number, when: string) =>
        ipcRenderer.invoke("moltenterm-update-apply", buildId, when),
    moltentermUpdateLast: () => ipcRenderer.invoke("moltenterm-update-last"),
    // MOLTENTERM-PATCH (#188): newer releases on GitHub (emain/moltenterm-release-feed.ts)
    moltentermReleaseCheck: () => ipcRenderer.invoke("moltenterm-release-check"),
    // MOLTENTERM-PATCH (#300): a browser panel tab's webview, for the agents' DevTools controller (emain/moltenterm-browseragent.ts)
    moltentermRegisterWebview: (blockId: string, browserTabId: string, webContentsId: number) =>
        ipcRenderer.send("moltenterm-webview-registered", blockId, browserTabId, webContentsId),
    // MOLTENTERM-PATCH (#663): the user's answer to a page's permission question (emain/moltenterm-site-permissions.ts)
    moltentermSitePermissionAnswer: (requestId: string, decision: string) =>
        ipcRenderer.send("moltenterm-site-permission-answer", requestId, decision),
    // MOLTENTERM-PATCH (#161): the app menu's Getting Started (emain/moltenterm-onboarding.ts)
    onMoltentermGettingStarted: (callback: () => void) =>
        ipcRenderer.on("moltenterm-getting-started", () => callback()),
    // MOLTENTERM-PATCH (#294, #743): the app menu's Edit Workspace…, or a workspace just created (emain/moltenterm-workspace-menu.ts)
    onMoltentermEditWorkspace: (callback: (workspaceId?: string) => void) =>
        ipcRenderer.on("moltenterm-edit-workspace", (_event, workspaceId) => callback(workspaceId)),
    // MOLTENTERM-PATCH (#490): Electron main asks what a window close, a quit or a workspace delete would stop
    // (emain/moltenterm-busy-close.ts, frontend/moltenterm-shell/busy-close-main.ts)
    onMoltentermBusyAsk: (callback: (request: any) => void) =>
        ipcRenderer.on("moltenterm-busy-ask", (_event, request) => callback(request)),
    moltentermBusyReply: (reply: any) => ipcRenderer.send("moltenterm-busy-reply", reply),
    // MOLTENTERM-PATCH (#450): the window's pending state, drawn by the view on screen (emain/moltenterm-view-pending.ts)
    onMoltentermViewPending: (callback: (state: any) => void) =>
        ipcRenderer.on("moltenterm-view-pending", (_event, state) => callback(state)),
    moltentermViewPendingAction: (action: string) => ipcRenderer.send("moltenterm-view-pending-action", action),
    // MOLTENTERM-PATCH (#455): the window's focus, minimised and shown state for the tab activity model
    // (emain/moltenterm-tab-activity.ts)
    moltentermGetWindowActivity: () => sendSync("moltenterm-window-activity-get"),
    onMoltentermWindowActivity: (callback) =>
        ipcRenderer.on("moltenterm-window-activity", (_event, activity) => callback(activity)),
    // MOLTENTERM-PATCH (#459, #618): hidden browser pages frozen and discarded (emain/moltenterm-webview-lifecycle.ts)
    moltentermWebviewShown: (
        blockId: string,
        browserTabId: string,
        webContentsId: number,
        shown: boolean,
        offCarpet?: boolean
    ) => ipcRenderer.send("moltenterm-webview-shown", blockId, browserTabId, webContentsId, shown, offCarpet === true),
    onMoltentermWebviewDiscard: (
        callback: (blockId: string, browserTabId: string, webContentsId: number, scroll: any) => void
    ) => {
        const listener = (_event, blockId, browserTabId, webContentsId, scroll) =>
            callback(blockId, browserTabId, webContentsId, scroll);
        ipcRenderer.on("moltenterm-webview-discard", listener);
        return () => ipcRenderer.removeListener("moltenterm-webview-discard", listener);
    },
    // MOLTENTERM-PATCH (#623): the OS preferred languages (app.getPreferredSystemLanguages) and the renderer's resolved
    // interface language, for the app menu and dialogs (emain/moltenterm-i18n.ts)
    moltentermSystemLanguages: () => sendSync("moltenterm-system-languages"),
    moltentermSetLocale: (locale: string) => ipcRenderer.send("moltenterm-set-locale", locale),
    // MOLTENTERM-PATCH (#624): the language packs' dictionaries, so the app menu and dialogs speak a pack's language
    moltentermSetLanguagePacks: (packs: any[]) => ipcRenderer.send("moltenterm-set-language-packs", packs),
    // MOLTENTERM-PATCH (#605): a system notification while no window is in front (emain/moltenterm-system-notify.ts)
    moltentermSystemNotify: (req: any) => ipcRenderer.invoke("moltenterm-system-notify", req),
    moltentermSystemNotifyClose: (id: string) => ipcRenderer.send("moltenterm-system-notify-close", id),
    onMoltentermSystemNotifyClick: (callback: (id: string) => void) => {
        const listener = (_event, id) => callback(id);
        ipcRenderer.on("moltenterm-system-notify-click", listener);
        return () => ipcRenderer.removeListener("moltenterm-system-notify-click", listener);
    },
    // MOLTENTERM-PATCH (#849): the window did not answer for a while, and what Electron main recorded about it
    // (emain/moltenterm-hang-watch.ts)
    onMoltentermWindowHang: (callback: (hang: any) => void) => {
        const listener = (_event, hang) => callback(hang);
        ipcRenderer.on(WindowHangChannel, listener);
        return () => ipcRenderer.removeListener(WindowHangChannel, listener);
    },
    moltentermHangDiagnostics: () => ipcRenderer.invoke(HangDiagnosticsChannel),
    moltentermHangCopy: (text: string) => ipcRenderer.invoke(HangCopyChannel, text),
});

// Custom event for "new-window"
ipcRenderer.on("webview-new-window", (e, webContentsId, details) => {
    const event = new CustomEvent("new-window", { detail: details });
    // MOLTENTERM-PATCH (#50): the webview the window comes from, not the page's first one (browser tabs, two web panels)
    const source = document.querySelector(`webview[data-webcontentsid="${webContentsId}"]`) as HTMLElement;
    const target = source ?? document.getElementById("webview");
    target?.dispatchEvent(event);
});

// MOLTENTERM-PATCH (#207): a sign-in popup hit a provider refusal (emain/moltenterm-popups.ts); the webview that opened
// it shows the refusal bar.
ipcRenderer.on("moltenterm-signin-refused", (e, webContentsId, refusal) => {
    const source = document.querySelector(`webview[data-webcontentsid="${webContentsId}"]`) as HTMLElement;
    source?.dispatchEvent(new CustomEvent("moltenterm-signin-refused", { detail: refusal }));
});

// MOLTENTERM-PATCH (#663): a page of the browser panel asks for the camera, the microphone, the location or
// notifications (emain/moltenterm-site-permissions.ts). The panel tab's webview shows the question; a webview no panel
// handles (a Wave web block) refuses at once.
function webviewByContentsId(webContentsId: number): HTMLElement {
    const tagged = document.querySelector(`webview[data-webcontentsid="${webContentsId}"]`) as HTMLElement;
    if (tagged != null) {
        return tagged;
    }
    for (const el of Array.from(document.querySelectorAll("webview"))) {
        try {
            if ((el as WebviewTag).getWebContentsId() === webContentsId) {
                return el as HTMLElement;
            }
        } catch {
            // not attached yet
        }
    }
    return null;
}
ipcRenderer.on("moltenterm-site-permission-ask", (e, requestId, webContentsId, site, kinds) => {
    const source = webviewByContentsId(webContentsId);
    const event = new CustomEvent("moltenterm-site-permission", {
        detail: { requestid: requestId, site, kinds },
        cancelable: true,
    });
    const handled = source != null && !source.dispatchEvent(event);
    if (!handled) {
        ipcRenderer.send("moltenterm-site-permission-answer", requestId, "dismiss");
    }
});
ipcRenderer.on("moltenterm-site-permission-done", (e, requestId) => {
    window.dispatchEvent(new CustomEvent("moltenterm-site-permission-done", { detail: { requestid: requestId } }));
});

ipcRenderer.on("webcontentsid-from-blockid", (e, blockId, responseCh) => {
    const webviewElem: WebviewTag = document.querySelector("div[data-blockid='" + blockId + "'] webview");
    const wcId = webviewElem?.dataset?.webcontentsid;
    ipcRenderer.send(responseCh, wcId);
});
