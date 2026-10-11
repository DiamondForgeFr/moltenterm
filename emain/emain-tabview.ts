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
import { attachWebviewWindowOpen } from "./moltenterm-popups"; // MOLTENTERM-PATCH (#207)
import { acquireViewForTab, noteTabViewDestroyed, noteTabViewDestroying } from "./moltenterm-tabview-host"; // MOLTENTERM-PATCH (#461)

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
            noteTabViewDestroyed(this); // MOLTENTERM-PATCH (#448, #461): the tab view host forgets it
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
        noteTabViewDestroying(this); // MOLTENTERM-PATCH (#448, #461): it leaves the cache, its window and its window's screen
        if (!this.isDestroyed) {
            this.webContents?.close();
        }
        this.isDestroyed = true;
    }
}

// MOLTENTERM-PATCH (#461): the tab view cache, its evictions and the hot spare are the tab view host's, with every
// view's state (emain/moltenterm-tabview-host.ts)
export {
    clearTabCache,
    discardHotSpareTab,
    ensureHotSpareTab,
    getSpareTab,
    getWaveTabView,
    setMaxTabCacheSize,
} from "./moltenterm-tabview-host";

// returns [tabview, initialized]
// MOLTENTERM-PATCH (#449, #461): the host hands out the tab's view, or a spare it gives to the tab, by the action's
// readiness deadline; null when `cancelled` resolves first (the action was superseded)
export async function getOrCreateWebViewForTab(
    waveWindowId: string,
    tabId: string,
    deadline: number,
    cancelled: Promise<void> = null
): Promise<[WaveTabView, boolean]> {
    const acquired = await acquireViewForTab(waveWindowId, tabId, deadline, cancelled);
    if (acquired == null) {
        return null;
    }
    if (acquired.initialized) {
        return [acquired.view, true];
    }
    const tabView = acquired.view;
    const fullConfig = acquired.fullConfig;
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
