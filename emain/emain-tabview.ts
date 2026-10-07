// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { adaptFromElectronKeyEvent, checkKeyPressed } from "@/util/keyutil";
import { CHORD_TIMEOUT } from "@/util/sharedconst";
import { Rectangle, shell, WebContentsView } from "electron";
import { createNewWaveWindow, getWaveWindowById } from "emain/emain-window";
import path from "path";
import { configureAuthKeyRequestInjection } from "./authkey";
import { setWasActive } from "./emain-activity";
import { getElectronAppBasePath, isDevVite, unamePlatform } from "./emain-platform";
import {
    decreaseZoomLevel,
    handleCtrlShiftFocus,
    handleCtrlShiftState,
    increaseZoomLevel,
    resetZoomLevel,
    shFrameNavHandler,
    shNavHandler,
} from "./emain-util";
import { ElectronWshClient } from "./emain-wsh";
import { hostsControlledTab } from "./moltenterm-browseragent"; // MOLTENTERM-PATCH (#301)
import { attachWebviewWindowOpen } from "./moltenterm-popups"; // MOLTENTERM-PATCH (#207)
import { acquireReadyView } from "./moltenterm-spare-ready"; // MOLTENTERM-PATCH (#283)

function handleWindowsMenuAccelerators(
    waveEvent: WaveKeyboardEvent,
    tabView: WaveTabView,
    fullConfig: FullConfigType
): boolean {
    const waveWindow = getWaveWindowById(tabView.waveWindowId);

    if (checkKeyPressed(waveEvent, "Ctrl:Shift:n")) {
        createNewWaveWindow();
        return true;
    }

    if (checkKeyPressed(waveEvent, "Ctrl:Shift:r")) {
        tabView.webContents.reloadIgnoringCache();
        return true;
    }

    if (checkKeyPressed(waveEvent, "Ctrl:v")) {
        const ctrlVPaste = fullConfig?.settings?.["app:ctrlvpaste"];
        const shouldPaste = ctrlVPaste ?? true;
        if (!shouldPaste) {
            return false;
        }
        tabView.webContents.paste();
        return true;
    }

    if (checkKeyPressed(waveEvent, "Ctrl:0")) {
        resetZoomLevel(tabView.webContents);
        return true;
    }

    if (checkKeyPressed(waveEvent, "Ctrl:=") || checkKeyPressed(waveEvent, "Ctrl:Shift:=")) {
        increaseZoomLevel(tabView.webContents);
        return true;
    }

    if (checkKeyPressed(waveEvent, "Ctrl:-") || checkKeyPressed(waveEvent, "Ctrl:Shift:-")) {
        decreaseZoomLevel(tabView.webContents);
        return true;
    }

    if (checkKeyPressed(waveEvent, "F11")) {
        if (waveWindow) {
            waveWindow.setFullScreen(!waveWindow.isFullScreen());
        }
        return true;
    }

    for (let i = 1; i <= 9; i++) {
        if (checkKeyPressed(waveEvent, `Alt:Ctrl:${i}`)) {
            const workspaceNum = i - 1;
            RpcApi.WorkspaceListCommand(ElectronWshClient).then((workspaceList) => {
                if (workspaceList && workspaceNum < workspaceList.length) {
                    const workspace = workspaceList[workspaceNum];
                    if (waveWindow) {
                        waveWindow.switchWorkspace(workspace.workspacedata.oid);
                    }
                }
            });
            return true;
        }
    }

    if (checkKeyPressed(waveEvent, "Alt:Shift:i")) {
        tabView.webContents.toggleDevTools();
        return true;
    }

    return false;
}

function computeBgColor(fullConfig: FullConfigType): string {
    const settings = fullConfig?.settings;
    const isTransparent = settings?.["window:transparent"] ?? false;
    const isBlur = !isTransparent && (settings?.["window:blur"] ?? false);
    if (isTransparent) {
        return "#00000000";
    } else if (isBlur) {
        return "#00000000";
    } else {
        return "#222222";
    }
}

const wcIdToWaveTabMap = new Map<number, WaveTabView>();

export function getWaveTabViewByWebContentsId(webContentsId: number): WaveTabView {
    if (webContentsId == null) {
        return null;
    }
    return wcIdToWaveTabMap.get(webContentsId);
}

export class WaveTabView extends WebContentsView {
    waveWindowId: string; // this will be set for any tabviews that are initialized. (unset for the hot spare)
    isActiveTab: boolean;
    isWaveAIOpen: boolean;
    private _waveTabId: string; // always set, WaveTabViews are unique per tab
    lastUsedTs: number; // ts milliseconds
    createdTs: number; // ts milliseconds
    initPromise: Promise<void>;
    initResolve: () => void;
    savedInitOpts: WaveInitOpts;
    waveReadyPromise: Promise<void>;
    waveReadyResolve: () => void;
    isInitialized: boolean = false;
    isWaveReady: boolean = false;
    isDestroyed: boolean = false;
    keyboardChordMode: boolean = false;
    resetChordModeTimeout: NodeJS.Timeout = null;

    constructor(fullConfig: FullConfigType) {
        console.log("createBareTabView");
        super({
            webPreferences: {
                preload: path.join(getElectronAppBasePath(), "preload", "index.cjs"),
                webviewTag: true,
            },
        });
        this.createdTs = Date.now();
        this.isWaveAIOpen = false;
        this.savedInitOpts = null;
        this.initPromise = new Promise((resolve, _) => {
            this.initResolve = resolve;
        });
        this.initPromise.then(() => {
            this.isInitialized = true;
            console.log("tabview init", Date.now() - this.createdTs + "ms");
        });
        this.waveReadyPromise = new Promise((resolve, _) => {
            this.waveReadyResolve = resolve;
        });
        this.waveReadyPromise.then(() => {
            this.isWaveReady = true;
        });
        const wcId = this.webContents.id;
        wcIdToWaveTabMap.set(wcId, this);
        if (isDevVite) {
            this.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html`);
        } else {
            this.webContents.loadFile(path.join(getElectronAppBasePath(), "frontend", "index.html"));
        }
        this.webContents.on("destroyed", () => {
            wcIdToWaveTabMap.delete(wcId);
            removeWaveTabView(this.waveTabId);
            this.isDestroyed = true;
        });
        this.setBackgroundColor(computeBgColor(fullConfig));
    }

    get waveTabId(): string {
        return this._waveTabId;
    }

    set waveTabId(waveTabId: string) {
        this._waveTabId = waveTabId;
    }

    setKeyboardChordMode(mode: boolean) {
        this.keyboardChordMode = mode;
        if (mode) {
            if (this.resetChordModeTimeout) {
                clearTimeout(this.resetChordModeTimeout);
            }
            this.resetChordModeTimeout = setTimeout(() => {
                this.keyboardChordMode = false;
            }, CHORD_TIMEOUT);
        } else {
            if (this.resetChordModeTimeout) {
                clearTimeout(this.resetChordModeTimeout);
                this.resetChordModeTimeout = null;
            }
        }
    }

    positionTabOnScreen(winBounds: Rectangle) {
        const curBounds = this.getBounds();
        if (
            curBounds.width == winBounds.width &&
            curBounds.height == winBounds.height &&
            curBounds.x == 0 &&
            curBounds.y == 0
        ) {
            return;
        }
        this.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height });
    }

    positionTabOffScreen(winBounds: Rectangle) {
        this.setBounds({
            x: -15000,
            y: -15000,
            width: winBounds.width,
            height: winBounds.height,
        });
    }

    isOnScreen() {
        const bounds = this.getBounds();
        return bounds.x == 0 && bounds.y == 0;
    }

    destroy() {
        console.log("destroy tab", this.waveTabId);
        removeWaveTabView(this.waveTabId);
        if (!this.isDestroyed) {
            this.webContents?.close();
        }
        this.isDestroyed = true;
    }
}

let MaxCacheSize = 10;
const wcvCache = new Map<string, WaveTabView>();

export function setMaxTabCacheSize(size: number) {
    console.log("setMaxTabCacheSize", size);
    MaxCacheSize = size;
}

export function getWaveTabView(waveTabId: string): WaveTabView | undefined {
    const rtn = wcvCache.get(waveTabId);
    if (rtn) {
        rtn.lastUsedTs = Date.now();
    }
    return rtn;
}

function tryEvictEntry(waveTabId: string): boolean {
    const tabView = wcvCache.get(waveTabId);
    if (!tabView) {
        return false;
    }
    if (tabView.isActiveTab) {
        return false;
    }
    // MOLTENTERM-PATCH (#301): a tab view holding a browser tab an agent drives stays, so its page keeps running and can
    // be read and captured while the tab is hidden (FR-BRW-009, emain/moltenterm-browseragent.ts)
    if (!tabView.webContents.isDestroyed() && hostsControlledTab(tabView.webContents.id)) {
        return false;
    }
    const lastUsedDiff = Date.now() - tabView.lastUsedTs;
    if (lastUsedDiff < 1000) {
        return false;
    }
    const ww = getWaveWindowById(tabView.waveWindowId);
    if (!ww) {
        // this shouldn't happen, but if it does, just destroy the tabview
        console.log("[error] WaveWindow not found for WaveTabView", tabView.waveTabId);
        tabView.destroy();
        return true;
    } else {
        // will trigger a destroy on the tabview
        ww.removeTabView(tabView.waveTabId, false);
        return true;
    }
}

function checkAndEvictCache(): void {
    if (wcvCache.size <= MaxCacheSize) {
        return;
    }
    const sorted = Array.from(wcvCache.values()).sort((a, b) => {
        // Prioritize entries which are active
        if (a.isActiveTab && !b.isActiveTab) {
            return -1;
        }
        // Otherwise, sort by lastUsedTs
        return a.lastUsedTs - b.lastUsedTs;
    });
    for (let i = 0; i < sorted.length - MaxCacheSize; i++) {
        tryEvictEntry(sorted[i].waveTabId);
    }
}

export function clearTabCache() {
    const wcVals = Array.from(wcvCache.values());
    for (let i = 0; i < wcVals.length; i++) {
        const tabView = wcVals[i];
        tryEvictEntry(tabView.waveTabId);
    }
}

// returns [tabview, initialized]
export async function getOrCreateWebViewForTab(waveWindowId: string, tabId: string): Promise<[WaveTabView, boolean]> {
    let tabView = getWaveTabView(tabId);
    if (tabView) {
        return [tabView, true];
    }
    const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
    // MOLTENTERM-PATCH (#283): a spare that stays silent is replaced instead of awaited forever
    const acquired = await acquireReadyView(
        () => getSpareTab(fullConfig),
        () => new WaveTabView(fullConfig),
        (msg) => console.log("[#283]", msg)
    );
    tabView = acquired.view;
    tabView.waveWindowId = waveWindowId;
    tabView.lastUsedTs = Date.now();
    setWaveTabView(tabId, tabView);
    tabView.waveTabId = tabId;
    tabView.webContents.on("will-navigate", shNavHandler);
    tabView.webContents.on("will-frame-navigate", shFrameNavHandler);
    // MOLTENTERM-PATCH (#207): sign-in popups open as real child windows; other new windows still become panel tabs
    // (Wave's deny-and-forward moved to emain/moltenterm-popups.ts).
    tabView.webContents.on("did-attach-webview", (event, wc) => {
        attachWebviewWindowOpen(tabView, wc);
    });
    tabView.webContents.on("before-input-event", (e, input) => {
        const waveEvent = adaptFromElectronKeyEvent(input);
        // console.log("WIN bie", tabView.waveTabId.substring(0, 8), waveEvent.type, waveEvent.code);
        handleCtrlShiftState(tabView.webContents, waveEvent);
        setWasActive(true);
        if (input.type == "keyDown" && tabView.keyboardChordMode) {
            e.preventDefault();
            tabView.setKeyboardChordMode(false);
            tabView.webContents.send("reinject-key", waveEvent);
            return;
        }

        if (unamePlatform === "win32" && input.type == "keyDown") {
            if (handleWindowsMenuAccelerators(waveEvent, tabView, fullConfig)) {
                e.preventDefault();
                return;
            }
        }
    });
    tabView.webContents.setWindowOpenHandler(({ url, frameName }) => {
        if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")) {
            console.log("openExternal fallback", url);
            shell.openExternal(url);
        }
        console.log("window-open denied", url);
        return { action: "deny" };
    });
    tabView.webContents.on("blur", () => {
        handleCtrlShiftFocus(tabView.webContents, false);
    });
    configureAuthKeyRequestInjection(tabView.webContents.session);
    return [tabView, false];
}

export function setWaveTabView(waveTabId: string, wcv: WaveTabView): void {
    if (waveTabId == null) {
        return;
    }
    wcvCache.set(waveTabId, wcv);
    checkAndEvictCache();
}

function removeWaveTabView(waveTabId: string): void {
    if (waveTabId == null) {
        return;
    }
    wcvCache.delete(waveTabId);
}

let HotSpareTab: WaveTabView = null;

export function ensureHotSpareTab(fullConfig: FullConfigType) {
    console.log("ensureHotSpareTab");
    if (HotSpareTab == null) {
        HotSpareTab = new WaveTabView(fullConfig);
    }
}

// MOLTENTERM-PATCH (#199): the spare is a hidden view too, stale after a long sleep; the next ensureHotSpareTab makes
// a new one
export function discardHotSpareTab() {
    if (HotSpareTab == null) {
        return;
    }
    const spare = HotSpareTab;
    HotSpareTab = null;
    spare.destroy();
}

export function getSpareTab(fullConfig: FullConfigType): WaveTabView {
    setTimeout(() => ensureHotSpareTab(fullConfig), 500);
    if (HotSpareTab != null) {
        const rtn = HotSpareTab;
        HotSpareTab = null;
        console.log("getSpareTab: returning hotspare");
        return rtn;
    } else {
        console.log("getSpareTab: creating new tab");
        return new WaveTabView(fullConfig);
    }
}
