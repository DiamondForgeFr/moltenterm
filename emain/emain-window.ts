// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ClientService, ObjectService, WindowService, WorkspaceService } from "@/app/store/services";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { fireAndForget } from "@/util/util";
import { BaseWindow, BaseWindowConstructorOptions, dialog, globalShortcut, ipcMain, screen } from "electron";
import { globalEvents } from "emain/emain-events";
import path from "path";
import { debounce } from "throttle-debounce";
import {
    getGlobalIsQuitting,
    getGlobalIsRelaunching,
    setGlobalIsRelaunching,
    setWasActive,
    setWasInFg,
} from "./emain-activity";
import { log } from "./emain-log";
import { getElectronAppBasePath, isDev, unamePlatform } from "./emain-platform";
import {
    getCachedTabViews,
    getOrCreateWebViewForTab,
    getWaveTabViewByWebContentsId,
    isHotSpareTab,
    WaveTabView,
} from "./emain-tabview"; // MOLTENTERM-PATCH (#448)
import { delay, ensureBoundsAreVisible, waveKeyToElectronKey } from "./emain-util";
import { ElectronWshClient } from "./emain-wsh";
import { ActionRun, isSuperseded, readinessDeadlineMs, WindowActionQueue } from "./moltenterm-action-queue"; // MOLTENTERM-PATCH (#449)
import { awaitViewInitialized } from "./moltenterm-spare-ready"; // MOLTENTERM-PATCH (#283)
import {
    beginTabViewWork,
    endTabViewWork,
    raiseTabViewPriority,
    restoreTabViewPriority,
} from "./moltenterm-tabview-priority"; // MOLTENTERM-PATCH (#450)
import { checkReusedTabViewPainted, noteTabViewLeftScreen } from "./moltenterm-tabview-repaint"; // MOLTENTERM-PATCH (#223)
import { makeTabViewSweeper } from "./moltenterm-tabview-sweep"; // MOLTENTERM-PATCH (#448)
import {
    loadPendingPage,
    makePendingPage,
    PendingPage,
    StartupPendingGraceMs,
    ViewPendingActionChannel,
    ViewPendingController,
    ViewPendingState,
} from "./moltenterm-view-pending"; // MOLTENTERM-PATCH (#450)
import {
    MoltentermReinitTimeoutMs,
    nextWaveReady,
    releaseTabViewFromOtherWindow,
    tabViewsToCloseOnLeave,
    withTimeout,
} from "./moltenterm-workspace-switch"; // MOLTENTERM-PATCH (#68)
import { updater } from "./updater";

export type WindowOpts = {
    unamePlatform: NodeJS.Platform;
    isPrimaryStartupWindow?: boolean;
    foregroundWindow?: boolean;
};

export const MinWindowWidth = 800;
export const MinWindowHeight = 500;

export function calculateWindowBounds(
    winSize?: { width?: number; height?: number },
    pos?: { x?: number; y?: number },
    settings?: any
): { x: number; y: number; width: number; height: number } {
    let winWidth = winSize?.width;
    let winHeight = winSize?.height;
    const winPosX = pos?.x ?? 100;
    const winPosY = pos?.y ?? 100;

    if (
        (winWidth == null || winWidth === 0 || winHeight == null || winHeight === 0) &&
        settings?.["window:dimensions"]
    ) {
        const dimensions = settings["window:dimensions"];
        const match = dimensions.match(/^(\d+)[xX](\d+)$/);

        if (match) {
            const [, dimensionWidth, dimensionHeight] = match;
            const parsedWidth = parseInt(dimensionWidth, 10);
            const parsedHeight = parseInt(dimensionHeight, 10);

            if ((!winWidth || winWidth === 0) && Number.isFinite(parsedWidth) && parsedWidth > 0) {
                winWidth = parsedWidth;
            }
            if ((!winHeight || winHeight === 0) && Number.isFinite(parsedHeight) && parsedHeight > 0) {
                winHeight = parsedHeight;
            }
        } else {
            console.warn('Invalid window:dimensions format. Expected "widthxheight".');
        }
    }

    if (winWidth == null || winWidth == 0) {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width } = primaryDisplay.workAreaSize;
        winWidth = width - winPosX - 100;
        if (winWidth > 2000) {
            winWidth = 2000;
        }
    }
    if (winHeight == null || winHeight == 0) {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { height } = primaryDisplay.workAreaSize;
        winHeight = height - winPosY - 100;
        if (winHeight > 1200) {
            winHeight = 1200;
        }
    }

    winWidth = Math.max(winWidth, MinWindowWidth);
    winHeight = Math.max(winHeight, MinWindowHeight);

    const winBounds = {
        x: winPosX,
        y: winPosY,
        width: winWidth,
        height: winHeight,
    };
    return ensureBoundsAreVisible(winBounds);
}

export const waveWindowMap = new Map<string, WaveBrowserWindow>(); // waveWindowId -> WaveBrowserWindow

// MOLTENTERM-PATCH (#448): destroys, in every window, the views of tabs that no longer exist
const sweepTabViews = makeTabViewSweeper<WaveTabView>({
    cachedViews: () => getCachedTabViews(),
    windows: () => Array.from(waveWindowMap.values()).filter((ww) => !ww.isDestroyed()),
    isHotSpare: (view) => isHotSpareTab(view),
    existingTabIds: async (tabIds) => {
        const tabs = await ObjectService.GetObjects(tabIds.map((id) => "tab:" + id));
        return new Set((tabs ?? []).filter((tab) => tab != null).map((tab) => tab.oid));
    },
    log: (msg, ...args) => console.log(msg, ...args),
});

// MOLTENTERM-PATCH (#448)
export function sweepDeletedTabViews(reason: string) {
    fireAndForget(async () => {
        const destroyed = await sweepTabViews(reason);
        if (destroyed > 0) {
            console.log(`[#448] ${destroyed} tab view(s) of deleted tabs destroyed (${reason})`);
        }
    });
}

// on blur we do not set this to null (but on destroy we do), so this tracks the *last* focused window
// e.g. it persists when the app itself is not focused
export let focusedWaveWindow: WaveBrowserWindow = null;

// quake window for toggle hotkey (show/hide behavior)
let quakeWindow: WaveBrowserWindow | null = null;

export function getQuakeWindow(): WaveBrowserWindow | null {
    return quakeWindow;
}

let cachedClientId: string = null;
let hasCompletedFirstRelaunch = false;

async function getClientId() {
    if (cachedClientId != null) {
        return cachedClientId;
    }
    const clientData = await ClientService.GetClientData();
    cachedClientId = clientData?.oid;
    return cachedClientId;
}

type WindowActionQueueEntry =
    | {
          op: "switchtab";
          tabId: string;
          setInBackend: boolean;
          primaryStartupTab?: boolean;
      }
    | {
          op: "createtab";
      }
    | {
          op: "closetab";
          tabId: string;
      }
    | {
          op: "switchworkspace";
          workspaceId: string;
      }
    | {
          op: "resetworkspace"; // MOLTENTERM-PATCH (#222)
      }
    | {
          op: "deleteworkspace"; // MOLTENTERM-PATCH (#449)
          workspaceId: string;
      };

// MOLTENTERM-PATCH (#450): a view that missed its readiness deadline twice (the switch fails and offers Reload), as
// opposed to a switch stopped for another reason (superseded, its tab deleted)
class ReadinessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReadinessError";
    }
}

function isNonEmptyUnsavedWorkspace(workspace: Workspace): boolean {
    return !workspace.name && !workspace.icon && workspace.tabids?.length > 1;
}

export class WaveBrowserWindow extends BaseWindow {
    waveWindowId: string;
    workspaceId: string;
    allLoadedTabViews: Map<string, WaveTabView>;
    activeTabView: WaveTabView;
    private canClose: boolean;
    private deleteAllowed: boolean;
    // MOLTENTERM-PATCH (#449): workspaceId is the workspace on screen; the backend's window can be ahead of it while a
    // switch is running or after one was superseded
    private actionQueue: WindowActionQueue<WindowActionQueueEntry>;
    private backendWorkspaceId: string;
    // MOLTENTERM-PATCH (#450): the pending state while a view loads (emain/moltenterm-view-pending.ts)
    viewPending: ViewPendingController;
    pendingPage: PendingPage;
    pendingToken: number;

    constructor(waveWindow: WaveWindow, fullConfig: FullConfigType, opts: WindowOpts) {
        const settings = fullConfig?.settings;

        console.log("create win", waveWindow.oid);
        const winBounds = calculateWindowBounds(waveWindow.winsize, waveWindow.pos, settings);
        const winOpts: BaseWindowConstructorOptions = {
            x: winBounds.x,
            y: winBounds.y,
            width: winBounds.width,
            height: winBounds.height,
            minWidth: MinWindowWidth,
            minHeight: MinWindowHeight,
            show: false,
        };

        const isTransparent = settings?.["window:transparent"] ?? false;
        const isBlur = !isTransparent && (settings?.["window:blur"] ?? false);

        if (opts.unamePlatform === "darwin") {
            winOpts.titleBarStyle = "hiddenInset";
            winOpts.titleBarOverlay = false;
            winOpts.autoHideMenuBar = !settings?.["window:showmenubar"];
            winOpts.acceptFirstMouse = true;
            if (isTransparent) {
                winOpts.transparent = true;
            } else if (isBlur) {
                winOpts.vibrancy = "fullscreen-ui";
            } else {
                winOpts.backgroundColor = "#222222";
            }
        } else if (opts.unamePlatform === "linux") {
            winOpts.titleBarStyle = settings["window:nativetitlebar"] ? "default" : "hidden";
            winOpts.titleBarOverlay = {
                symbolColor: "white",
                color: "#00000000",
            };
            winOpts.icon = path.join(getElectronAppBasePath(), "public/logos/moltenterm-logo.png"); // MOLTENTERM-PATCH (#4)
            winOpts.autoHideMenuBar = !settings?.["window:showmenubar"];
            if (isTransparent) {
                winOpts.transparent = true;
            } else {
                winOpts.backgroundColor = "#222222";
            }
        } else if (opts.unamePlatform === "win32") {
            winOpts.titleBarStyle = "hidden";
            winOpts.titleBarOverlay = {
                color: "#222222",
                symbolColor: "#c3c8c2",
                height: 32,
            };
            if (isTransparent) {
                winOpts.transparent = true;
            } else if (isBlur) {
                winOpts.backgroundMaterial = "acrylic";
            } else {
                winOpts.backgroundColor = "#222222";
            }
        }

        super(winOpts);

        if (opts.unamePlatform === "win32") {
            this.setMenu(null);
        }

        const fullscreenOnLaunch = fullConfig?.settings["window:fullscreenonlaunch"];
        if (fullscreenOnLaunch && opts.foregroundWindow) {
            this.once("show", () => {
                this.setFullScreen(true);
            });
        }
        // MOLTENTERM-PATCH (#449)
        this.actionQueue = new WindowActionQueue<WindowActionQueueEntry>(
            (entry, run) => this.runQueuedAction(entry, run), // MOLTENTERM-PATCH (#450)
            () => this.isDestroyed(),
            () => readinessDeadlineMs(isDev),
            (msg, ...args) => console.log(msg, ...args)
        );
        this.waveWindowId = waveWindow.oid;
        this.workspaceId = waveWindow.workspaceid;
        this.backendWorkspaceId = waveWindow.workspaceid; // MOLTENTERM-PATCH (#449)
        // MOLTENTERM-PATCH (#450)
        this.viewPending = new ViewPendingController({
            liveView: () => this.pendingLiveView(),
            showPage: (state) => this.showPendingPage(state),
            hidePage: () => this.hidePendingPage(),
        });
        this.allLoadedTabViews = new Map<string, WaveTabView>();
        const winBoundsPoller = setInterval(() => {
            if (this.isDestroyed()) {
                clearInterval(winBoundsPoller);
                return;
            }
            if (this.actionQueue.length > 0) {
                return;
            }
            this.finalizePositioning();
        }, 1000);
        this.on(
            // @ts-expect-error -- "resize" event with debounce handler not in Electron type definitions
            "resize",
            debounce(400, (e) => this.mainResizeHandler(e))
        );
        this.on("resize", () => {
            if (this.isDestroyed()) {
                return;
            }
            this.activeTabView?.positionTabOnScreen(this.getContentBounds());
            this.pendingPage?.view.setBounds(this.fullBounds()); // MOLTENTERM-PATCH (#450)
        });
        this.on(
            // @ts-expect-error -- "move" event with debounce handler not in Electron type definitions
            "move",
            debounce(400, (e) => this.mainResizeHandler(e))
        );
        this.on("enter-full-screen", async () => {
            if (this.isDestroyed()) {
                return;
            }
            console.log("enter-full-screen event", this.getContentBounds());
            const tabView = this.activeTabView;
            if (tabView) {
                tabView.webContents.send("fullscreen-change", true);
            }
            this.activeTabView?.positionTabOnScreen(this.getContentBounds());
        });
        this.on("leave-full-screen", async () => {
            if (this.isDestroyed()) {
                return;
            }
            const tabView = this.activeTabView;
            if (tabView) {
                tabView.webContents.send("fullscreen-change", false);
            }
            this.activeTabView?.positionTabOnScreen(this.getContentBounds());
        });
        this.on("focus", () => {
            if (this.isDestroyed()) {
                return;
            }
            if (getGlobalIsRelaunching()) {
                return;
            }
            focusedWaveWindow = this; // eslint-disable-line @typescript-eslint/no-this-alias
            console.log("focus win", this.waveWindowId);
            fireAndForget(() => ClientService.FocusWindow(this.waveWindowId));
            setWasInFg(true);
            setWasActive(true);
            setTimeout(() => globalEvents.emit("windows-updated"), 50);
        });
        this.on("blur", () => {
            setTimeout(() => globalEvents.emit("windows-updated"), 50);
        });
        this.on("close", (e) => {
            if (this.canClose) {
                return;
            }
            if (this.isDestroyed()) {
                return;
            }
            console.log("win 'close' handler fired", this.waveWindowId);
            if (getGlobalIsQuitting() || updater?.status == "installing" || getGlobalIsRelaunching()) {
                return;
            }
            e.preventDefault();
            fireAndForget(async () => {
                const numWindows = waveWindowMap.size;
                const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
                if (numWindows > 1 || !fullConfig.settings["window:savelastwindow"]) {
                    if (fullConfig.settings["window:confirmclose"]) {
                        const workspace = await WorkspaceService.GetWorkspace(this.workspaceId);
                        if (isNonEmptyUnsavedWorkspace(workspace)) {
                            const choice = dialog.showMessageBoxSync(this, {
                                type: "question",
                                buttons: ["Cancel", "Close Window"],
                                title: "Confirm",
                                message:
                                    "Window has unsaved tabs, closing window will delete existing tabs.\n\nContinue?",
                            });
                            if (choice === 0) {
                                return;
                            }
                        }
                    }
                    this.deleteAllowed = true;
                }
                this.canClose = true;
                this.close();
            });
        });
        this.on("closed", () => {
            console.log("win 'closed' handler fired", this.waveWindowId);
            if (getGlobalIsQuitting() || updater?.status == "installing") {
                console.log("win quitting or updating", this.waveWindowId);
                return;
            }
            setTimeout(() => globalEvents.emit("windows-updated"), 50);
            waveWindowMap.delete(this.waveWindowId);
            if (focusedWaveWindow == this) {
                focusedWaveWindow = null;
            }
            if (quakeWindow == this) {
                quakeWindow = null;
            }
            this.removeAllChildViews();
            if (getGlobalIsRelaunching()) {
                console.log("win relaunching", this.waveWindowId);
                this.destroy();
                return;
            }
            if (this.deleteAllowed) {
                console.log("win removing window from backend DB", this.waveWindowId);
                fireAndForget(() => WindowService.CloseWindow(this.waveWindowId, true));
            }
        });
        waveWindowMap.set(waveWindow.oid, this);
        setTimeout(() => globalEvents.emit("windows-updated"), 50);
    }

    private removeAllChildViews() {
        this.viewPending.hide(); // MOLTENTERM-PATCH (#450)
        for (const tabView of this.allLoadedTabViews.values()) {
            if (!this.isDestroyed()) {
                this.contentView.removeChildView(tabView);
            }
            tabView?.destroy();
        }
    }

    async switchWorkspace(workspaceId: string) {
        console.log("switchWorkspace", workspaceId, this.waveWindowId);
        // MOLTENTERM-PATCH (#449): coming back to the workspace on screen while a switch is under way cancels that switch
        if (workspaceId == this.workspaceId && !this.actionQueue.hasWorkspaceChange()) {
            console.log("switchWorkspace already on this workspace", this.waveWindowId);
            return;
        }

        // If the workspace is already owned by a window, then we can just call SwitchWorkspace without first prompting the user, since it'll just focus to the other window.
        const workspaceList = await WorkspaceService.ListWorkspaces();
        if (!workspaceList?.find((wse) => wse.workspaceid === workspaceId)?.windowid) {
            const curWorkspace = await WorkspaceService.GetWorkspace(this.workspaceId);

            if (curWorkspace && isNonEmptyUnsavedWorkspace(curWorkspace)) {
                console.log(
                    `existing unsaved workspace ${this.workspaceId} has content, opening workspace ${workspaceId} in new window`
                );
                await createWindowForWorkspace(workspaceId);
                return;
            }
        }
        await this._queueActionInternal({ op: "switchworkspace", workspaceId });
    }

    async setActiveTab(tabId: string, setInBackend: boolean, primaryStartupTab = false) {
        console.log(
            "setActiveTab",
            tabId,
            this.waveWindowId,
            this.workspaceId,
            setInBackend,
            primaryStartupTab ? "(primary startup)" : ""
        );
        await this._queueActionInternal({ op: "switchtab", tabId, setInBackend, primaryStartupTab });
    }

    // MOLTENTERM-PATCH (#449): every wait shares the action's single readiness deadline and stops as soon as a newer
    // action takes over (was 15 s for the init, then 5 s or 15 s for wave-ready, plus the dev 5 s timers)
    private async initializeTab(tabView: WaveTabView, primaryStartupTab: boolean, offScreen: boolean, run: ActionRun) {
        const clientId = await run.race(getClientId());
        // MOLTENTERM-PATCH (#283): the queue never waits indefinitely on one view's init
        let viewReady = await run.race(awaitViewInitialized(tabView, run.remainingMs()));
        // MOLTENTERM-PATCH (#450): a view still loading at the deadline is kept and waited for once more
        if (!viewReady && this.retryAtReadinessDeadline(tabView, "init", run)) {
            viewReady = await run.race(awaitViewInitialized(tabView, run.remainingMs()));
        }
        if (!viewReady) {
            await this.onReadinessDeadline(tabView, "init");
            // MOLTENTERM-PATCH (#450)
            throw new ReadinessError(`tab view ${tabView.waveTabId} not initialized by the readiness deadline`);
        }
        const winBounds = this.getContentBounds();
        tabView.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height });
        // MOLTENTERM-PATCH (#68): rendered off-screen first, so the previous workspace stays visible until it is ready
        if (offScreen) {
            tabView.positionTabOffScreen(winBounds);
        }
        this.contentView.addChildView(tabView);
        this.keepPendingPageOnTop(); // MOLTENTERM-PATCH (#450)
        const initOpts: WaveInitOpts = {
            tabId: tabView.waveTabId,
            clientId: clientId,
            windowId: this.waveWindowId,
            activate: true,
        };
        if (primaryStartupTab) {
            initOpts.primaryTabStartup = true;
        }
        tabView.savedInitOpts = { ...initOpts };
        tabView.savedInitOpts.activate = false;
        delete tabView.savedInitOpts.primaryTabStartup;
        const startTime = Date.now();
        console.log(
            "before wave ready, init tab, sending wave-init",
            tabView.waveTabId,
            primaryStartupTab ? "(primary startup)" : ""
        );
        tabView.webContents.send("wave-init", initOpts);
        // MOLTENTERM-PATCH (#68, #449): never leave the window on the previous workspace when a renderer does not answer
        await run.race(withTimeout(tabView.waveReadyPromise, run.remainingMs()));
        // MOLTENTERM-PATCH (#450)
        if (!tabView.isWaveReady && this.retryAtReadinessDeadline(tabView, "wave-ready", run)) {
            await run.race(withTimeout(tabView.waveReadyPromise, run.remainingMs()));
        }
        if (!tabView.isWaveReady && !(await this.onReadinessDeadline(tabView, "wave-ready"))) {
            throw new Error(`tab view ${tabView.waveTabId} not ready by the readiness deadline`);
        }
        console.log("wave-ready init time", Date.now() - startTime + "ms");
    }

    // MOLTENTERM-PATCH (#450): the first time an action's readiness deadline passes, a view still loading is kept and
    // gets one more readiness period (its renderer is busy, not lost: a new one would start from zero), and the pending
    // state says so. A view whose renderer is gone is not waited for.
    private retryAtReadinessDeadline(tabView: WaveTabView, stage: "init" | "wave-ready", run: ActionRun): boolean {
        if (tabView.isDestroyed || tabView.webContents.isDestroyed() || tabView.webContents.isCrashed()) {
            return false;
        }
        if (!run.extendOnce(readinessDeadlineMs(isDev))) {
            return false;
        }
        console.log(`[#450] readiness deadline passed (${stage}) for tab ${tabView.waveTabId}, kept, retrying once`);
        raiseTabViewPriority(tabView);
        this.viewPending.setPhase(this.pendingToken, "retrying");
        return true;
    }

    // MOLTENTERM-PATCH (#449): the one place a missed readiness deadline is decided (after the retry of #450). Returns
    // whether the view is shown anyway: a renderer that initialized is (#68), unless its tab no longer exists (deleted
    // meanwhile, its renderer failed on it); one that never initialized is dropped (#283).
    private async onReadinessDeadline(tabView: WaveTabView, stage: "init" | "wave-ready"): Promise<boolean> {
        console.log(`[#449] readiness deadline passed (${stage}) for tab ${tabView.waveTabId}`);
        if (isDev) {
            console.log("[dev] showing window for devtools");
            if (!this.isDestroyed() && !this.isVisible()) {
                this.show();
            }
            if (this.activeTabView?.webContents && !this.activeTabView.webContents.isDevToolsOpened()) {
                this.activeTabView.webContents.openDevTools();
            }
        }
        if (stage === "init") {
            return false;
        }
        const tab = await ObjectService.GetObject("tab:" + tabView.waveTabId).catch((): WaveObj => null);
        if (tab == null) {
            console.log("[#449] its tab no longer exists, dropping the view", tabView.waveTabId);
            return false;
        }
        return true;
    }

    // MOLTENTERM-PATCH (#449): makes a view the active one; a switch does it only once the view is ready
    private activateTabView(tabView: WaveTabView, oldActiveView: WaveTabView) {
        tabView.isActiveTab = true;
        if (oldActiveView != null) {
            oldActiveView.isActiveTab = false;
        }
        noteTabViewLeftScreen(oldActiveView); // MOLTENTERM-PATCH (#223)
        this.activeTabView = tabView;
    }

    // MOLTENTERM-PATCH (#450): the view runs at the foreground priority until it is on screen, or dropped
    private async showTabView(
        tabView: WaveTabView,
        tabInitialized: boolean,
        primaryStartupTab: boolean,
        waitReady: boolean,
        run: ActionRun
    ) {
        raiseTabViewPriority(tabView);
        try {
            await this.setTabViewIntoWindow(tabView, tabInitialized, primaryStartupTab, waitReady, run);
        } finally {
            restoreTabViewPriority(tabView);
        }
    }

    // MOLTENTERM-PATCH (#68): waitReady shows the view only once it has rendered (workspace switch)
    // MOLTENTERM-PATCH (#449): with waitReady the view becomes active only then, so neither a resize nor a superseded
    // switch brings it on screen early
    private async setTabViewIntoWindow(
        tabView: WaveTabView,
        tabInitialized: boolean,
        primaryStartupTab: boolean,
        waitReady: boolean,
        run: ActionRun
    ) {
        if (this.activeTabView == tabView) {
            return;
        }
        const oldActiveView = this.activeTabView;
        if (!waitReady) {
            this.activateTabView(tabView, oldActiveView);
        }
        this.allLoadedTabViews.set(tabView.waveTabId, tabView);
        if (!tabInitialized) {
            console.log("initializing a new tab", primaryStartupTab ? "(primary startup)" : "");
            try {
                await this.initializeTab(tabView, primaryStartupTab, waitReady, run);
            } catch (e) {
                // MOLTENTERM-PATCH (#283): a view that never initialized is dropped, so the next switch builds a new one
                // MOLTENTERM-PATCH (#449): so is a view whose action was superseded, or whose tab no longer exists
                console.log("[#283] initializing a new tab failed, dropping its view", tabView.waveTabId, e);
                if (this.activeTabView == tabView) {
                    this.activeTabView = oldActiveView;
                    if (oldActiveView != null) {
                        oldActiveView.isActiveTab = true;
                    }
                }
                this.allLoadedTabViews.delete(tabView.waveTabId);
                if (!this.isDestroyed()) {
                    this.contentView.removeChildView(tabView);
                }
                tabView.destroy();
                throw e;
            }
            if (waitReady) {
                this.activateTabView(tabView, oldActiveView);
            }
            this.finalizePositioning();
        } else {
            console.log("reusing an existing tab, calling wave-init", tabView.waveTabId);
            const reinitDone = waitReady ? nextWaveReady(tabView) : null; // MOLTENTERM-PATCH (#68)
            tabView.webContents.send("wave-init", tabView.savedInitOpts); // reinit
            if (reinitDone != null) {
                // MOLTENTERM-PATCH (#68, #449): a superseded switch leaves the reused view off-screen, in the cache
                await run.race(withTimeout(reinitDone, Math.min(MoltentermReinitTimeoutMs, run.remainingMs())));
                this.activateTabView(tabView, oldActiveView);
            }
            this.finalizePositioning();
            checkReusedTabViewPainted(this, tabView); // MOLTENTERM-PATCH (#223): a long-hidden view can come back black
        }

        // something is causing the new tab to lose focus so it requires manual refocusing
        tabView.webContents.focus();
        setTimeout(() => {
            if (tabView.webContents && this.activeTabView == tabView && !tabView.webContents.isFocused()) {
                tabView.webContents.focus();
            }
        }, 10);
        setTimeout(() => {
            if (tabView.webContents && this.activeTabView == tabView && !tabView.webContents.isFocused()) {
                tabView.webContents.focus();
            }
        }, 30);
    }

    private finalizePositioning() {
        if (this.isDestroyed()) {
            return;
        }
        const curBounds = this.getContentBounds();
        this.activeTabView?.positionTabOnScreen(curBounds);
        for (const tabView of this.allLoadedTabViews.values()) {
            if (tabView == this.activeTabView) {
                continue;
            }
            tabView?.positionTabOffScreen(curBounds);
        }
    }

    async queueCreateTab() {
        await this._queueActionInternal({ op: "createtab" });
    }

    async queueCloseTab(tabId: string) {
        await this._queueActionInternal({ op: "closetab", tabId });
    }

    // MOLTENTERM-PATCH (#222)
    async queueResetWorkspace() {
        await this._queueActionInternal({ op: "resetworkspace" });
    }

    // MOLTENTERM-PATCH (#449): a delete goes through the queue, so it cannot race a switch to the same workspace
    async queueDeleteWorkspace(workspaceId: string) {
        await this._queueActionInternal({ op: "deleteworkspace", workspaceId });
    }

    // MOLTENTERM-PATCH (#449): the window shows the workspace, is switching to it, or its backend window is on it
    isOnWorkspace(workspaceId: string): boolean {
        return (
            this.workspaceId == workspaceId ||
            this.backendWorkspaceId == workspaceId ||
            this.actionQueue.targetsWorkspace(workspaceId)
        );
    }

    // MOLTENTERM-PATCH (#283, #449): coalescing, superseding and the drain live in emain/moltenterm-action-queue.ts
    private async _queueActionInternal(entry: WindowActionQueueEntry) {
        await this.actionQueue.enqueue(entry);
    }

    private removeTabViewLater(tabId: string, delayMs: number) {
        setTimeout(() => {
            this.removeTabView(tabId, false);
        }, delayMs);
    }

    // MOLTENTERM-PATCH (#450): while an action runs the hot spare waits to be raised (it would compete with the view
    // being shown); once the queue is empty a pending state that is not a failure goes
    private async runQueuedAction(entry: WindowActionQueueEntry, run: ActionRun) {
        beginTabViewWork();
        try {
            await this.runAction(entry, run);
        } finally {
            endTabViewWork();
            if (this.actionQueue.length <= 1) {
                this.viewPending.settle();
            }
        }
    }

    // MOLTENTERM-PATCH (#450)
    private beginPending(workspaceName: string, onReload: () => void, startedAt: number, graceMs?: number): number {
        this.pendingToken = this.viewPending.begin(workspaceName, onReload, startedAt, graceMs);
        return this.pendingToken;
    }

    // MOLTENTERM-PATCH (#450)
    private async beginStartupPending(tabId: string): Promise<number> {
        const startedAt = Date.now();
        const ws = await WorkspaceService.GetWorkspace(this.workspaceId).catch((): Workspace => null);
        const onReload = () => fireAndForget(() => this.setActiveTab(tabId, false));
        // A window already shown (Reload after a failure) has nothing else to show: no grace.
        return this.beginPending(ws?.name, onReload, startedAt, this.isVisible() ? 0 : StartupPendingGraceMs);
    }

    // MOLTENTERM-PATCH (#450): the view that draws the pending state over its panels: on screen and rendered
    private pendingLiveView(): WaveTabView {
        const view = this.activeTabView;
        if (this.isDestroyed() || view == null || view.isDestroyed || !view.isWaveReady || !view.isOnScreen()) {
            return null;
        }
        return view;
    }

    // MOLTENTERM-PATCH (#450)
    private fullBounds() {
        const b = this.getContentBounds();
        return { x: 0, y: 0, width: b.width, height: b.height };
    }

    // MOLTENTERM-PATCH (#450): the page goes over the window, which is shown (if it was not yet) once the page has loaded,
    // so it is never shown empty
    private showPendingPage(state: ViewPendingState) {
        if (this.isDestroyed()) {
            return;
        }
        if (this.pendingPage != null) {
            fireAndForget(() => loadPendingPage(this.pendingPage.view, state));
            return;
        }
        const page = makePendingPage(state, () => this.viewPending.reload());
        this.pendingPage = page;
        page.view.setBounds(this.fullBounds());
        this.contentView.addChildView(page.view);
        fireAndForget(async () => {
            await page.loaded;
            if (this.pendingPage !== page || this.isDestroyed() || this.isVisible()) {
                return;
            }
            console.log("[#450] showing the window with the pending page", this.waveWindowId);
            this.show();
        });
    }

    // MOLTENTERM-PATCH (#450)
    private hidePendingPage() {
        const page = this.pendingPage;
        if (page == null) {
            return;
        }
        this.pendingPage = null;
        if (!this.isDestroyed()) {
            this.contentView.removeChildView(page.view);
        }
        if (!page.view.webContents.isDestroyed()) {
            page.view.webContents.close();
        }
    }

    // MOLTENTERM-PATCH (#450): a tab view added while the page is shown goes under it until it has rendered
    private keepPendingPageOnTop() {
        if (this.pendingPage == null || this.isDestroyed()) {
            return;
        }
        this.contentView.removeChildView(this.pendingPage.view);
        this.contentView.addChildView(this.pendingPage.view);
    }

    // the queue and this function are used to serialize operations that update the window contents view
    // processActionQueue will replace [1] if it is already set
    // we don't mess with [0] because it is "in process"
    // we replace [1] because there is no point to run an action that is going to be overwritten
    // MOLTENTERM-PATCH (#449): one action of the queue; a return or a throw anywhere here only ends this action
    private async runAction(entry: WindowActionQueueEntry, run: ActionRun) {
        let tabId: string = null;
        let tabViewsToClose: string[] = []; // MOLTENTERM-PATCH (#68)
        // have to use "===" here to get the typechecker to work :/
        switch (entry.op) {
            case "createtab":
                tabId = await WorkspaceService.CreateTab(this.workspaceId, null, true);
                break;
            case "switchtab":
                tabId = entry.tabId;
                if (this.activeTabView?.waveTabId == tabId) {
                    return;
                }
                if (entry.setInBackend) {
                    await WorkspaceService.SetActiveTab(this.workspaceId, tabId);
                }
                break;
            case "closetab": {
                tabId = entry.tabId;
                const rtn = await WorkspaceService.CloseTab(this.workspaceId, tabId, true);
                if (rtn == null) {
                    console.log("[error] closeTab: no return value", tabId, this.workspaceId, this.waveWindowId);
                    return;
                }
                this.removeTabViewLater(tabId, 1000);
                if (rtn.closewindow) {
                    this.close();
                    return;
                }
                if (!rtn.newactivetabid) {
                    return;
                }
                tabId = rtn.newactivetabid;
                break;
            }
            case "switchworkspace":
                await this.runSwitchWorkspace(entry.workspaceId, run);
                return;
            case "deleteworkspace":
                await this.runDeleteWorkspace(entry.workspaceId, run);
                return;
            case "resetworkspace": {
                // MOLTENTERM-PATCH (#222): the old tabs' views close once the new tab is on screen
                const resetWs = await WorkspaceService.GetWorkspace(this.workspaceId);
                tabId = await WorkspaceService.ResetWorkspace(this.workspaceId);
                tabViewsToClose = resetWs?.tabids ?? [];
                break;
            }
        }
        if (tabId == null) {
            return;
        }
        // MOLTENTERM-PATCH (#450): a window that has never shown a tab (a launch) shows the pending page when its first
        // tab is slow, and Reload when it fails
        const startupPending = this.activeTabView == null ? await this.beginStartupPending(tabId) : null;
        try {
            const [tabView, tabInitialized] = await getOrCreateWebViewForTab(this.waveWindowId, tabId, run.deadline);
            const primaryStartupTabFlag = entry.op === "switchtab" ? (entry.primaryStartupTab ?? false) : false;
            await this.showTabView(tabView, tabInitialized, primaryStartupTabFlag, false, run); // MOLTENTERM-PATCH (#450)
        } catch (e) {
            if (startupPending != null && e instanceof ReadinessError) {
                this.viewPending.setPhase(startupPending, "failed");
            }
            throw e;
        }
        if (startupPending != null) {
            this.viewPending.end(startupPending);
        }
        for (const closeId of tabViewsToClose) {
            this.removeTabView(closeId, false); // MOLTENTERM-PATCH (#68)
        }
        // MOLTENTERM-PATCH (#448): the closed tab's view, wherever it is cached, once its successor is on screen
        if (entry.op === "closetab") {
            sweepDeletedTabViews("tab closed");
        }
    }

    // MOLTENTERM-PATCH (#68, #449): the new view is shown only once it has rendered, and workspaceId follows the screen:
    // it changes only once that view is on screen. A switch that fails takes the backend back to the workspace on
    // screen; a superseded one leaves the backend to the action that superseded it.
    private async runSwitchWorkspace(workspaceId: string, run: ActionRun) {
        const startedAt = Date.now(); // MOLTENTERM-PATCH (#450)
        // MOLTENTERM-PATCH (#68): read before the switch, which deletes an unsaved workspace
        const leftIds = [this.workspaceId, this.backendWorkspaceId].filter(
            (id, idx, all) => id != null && id != workspaceId && all.indexOf(id) == idx
        );
        const leftWss = await Promise.all(
            leftIds.map((id) => WorkspaceService.GetWorkspace(id).catch((): Workspace => null))
        );
        run.check();
        let newWs = await WindowService.SwitchWorkspace(this.waveWindowId, workspaceId);
        if (newWs != null) {
            this.backendWorkspaceId = workspaceId;
        } else if (this.backendWorkspaceId == workspaceId && this.workspaceId != workspaceId) {
            // The backend is already there: an earlier switch to it was superseded, or could not be rolled back.
            newWs = await WorkspaceService.GetWorkspace(workspaceId);
        }
        if (!newWs) {
            return;
        }
        run.check();
        console.log("processActionQueue switchworkspace newWs", newWs);
        const tabId = newWs.activetabid;
        if (tabId == null) {
            this.workspaceId = workspaceId;
            return;
        }
        releaseTabViewFromOtherWindow(tabId, this.waveWindowId, getWaveWindowById);
        // MOLTENTERM-PATCH (#450): the window on the workspace left shows the pending state of this one
        const pendingToken = this.beginPending(
            newWs.name,
            () => fireAndForget(() => this.switchWorkspace(workspaceId)),
            startedAt
        );
        try {
            const [tabView, tabInitialized] = await this.acquireTabView(tabId, run);
            await this.showTabView(tabView, tabInitialized, false, true, run); // MOLTENTERM-PATCH (#450)
        } catch (e) {
            if (!isSuperseded(e)) {
                await this.rollBackBackendWorkspace(workspaceId);
                // MOLTENTERM-PATCH (#450)
                if (e instanceof ReadinessError) {
                    this.viewPending.setPhase(pendingToken, "failed");
                } else {
                    this.viewPending.end(pendingToken);
                }
            }
            throw e;
        }
        this.viewPending.end(pendingToken); // MOLTENTERM-PATCH (#450)
        // MOLTENTERM-PATCH (#68): the views of the workspace left are kept (off-screen, in the tab
        // cache) instead of destroyed, so switching back is as instant as switching tabs
        this.workspaceId = workspaceId;
        for (const closeId of leftWss.flatMap((ws) => tabViewsToCloseOnLeave(ws))) {
            this.removeTabView(closeId, false); // MOLTENTERM-PATCH (#68)
        }
        // MOLTENTERM-PATCH (#448): a workspace left that no longer exists (deleted while on screen) leaves views of
        // deleted tabs that tabViewsToCloseOnLeave cannot name
        if (leftWss.some((ws) => ws == null)) {
            sweepDeletedTabViews("left a deleted workspace");
        }
    }

    // MOLTENTERM-PATCH (#449): a view still being acquired when its switch is superseded stops waiting at once and goes
    // back as the hot spare (getOrCreateWebViewForTab); one acquired just then is destroyed, never left in the tab cache
    // without a window that shows it
    private async acquireTabView(tabId: string, run: ActionRun): Promise<[WaveTabView, boolean]> {
        const acquiring = getOrCreateWebViewForTab(this.waveWindowId, tabId, run.deadline, run.whenSuperseded);
        try {
            return await run.race(acquiring);
        } catch (e) {
            fireAndForget(async () => {
                const acquired = await acquiring;
                if (acquired == null) {
                    return;
                }
                const [tabView, tabInitialized] = acquired;
                if (!tabInitialized && this.allLoadedTabViews.get(tabId) !== tabView) {
                    tabView.destroy();
                }
            });
            throw e;
        }
    }

    // MOLTENTERM-PATCH (#449)
    private async rollBackBackendWorkspace(failedWorkspaceId: string) {
        if (this.workspaceId == failedWorkspaceId || this.backendWorkspaceId != failedWorkspaceId) {
            return;
        }
        try {
            const ws = await WindowService.SwitchWorkspace(this.waveWindowId, this.workspaceId);
            if (ws != null) {
                this.backendWorkspaceId = this.workspaceId;
            }
            console.log("[#449] switch failed, backend back on", this.workspaceId, this.waveWindowId);
        } catch (e) {
            console.log("[#449] switch failed, could not take the backend back to", this.workspaceId, e);
        }
    }

    // MOLTENTERM-PATCH (#449): the delete runs in the queue, after any switch to the workspace has stopped and dropped its
    // view, so no renderer initializes a tab being deleted. When the window was only switching to it, it stays on the
    // workspace it shows.
    // MOLTENTERM-PATCH (#448): then the views of its tabs are destroyed in every window, once this window shows another
    // workspace (the view on screen is never destroyed)
    private async runDeleteWorkspace(workspaceId: string, run: ActionRun) {
        try {
            await this.applyDeleteWorkspace(workspaceId, run);
        } finally {
            sweepDeletedTabViews("workspace deleted");
        }
    }

    private async applyDeleteWorkspace(workspaceId: string, run: ActionRun) {
        const onThisWindow = this.workspaceId == workspaceId || this.backendWorkspaceId == workspaceId;
        const newWorkspaceId = await WorkspaceService.DeleteWorkspace(workspaceId);
        console.log("delete-workspace done", workspaceId, this.waveWindowId);
        if (!onThisWindow) {
            return;
        }
        if (this.backendWorkspaceId == workspaceId) {
            this.backendWorkspaceId = null;
        }
        if (!newWorkspaceId) {
            console.log("delete-workspace closing window", workspaceId, this.waveWindowId);
            this.destroy();
            return;
        }
        if (run.isSuperseded()) {
            return;
        }
        const stay = this.workspaceId != workspaceId && (await WorkspaceService.GetWorkspace(this.workspaceId)) != null;
        run.check();
        await this.runSwitchWorkspace(stay ? this.workspaceId : newWorkspaceId, run);
    }

    private async mainResizeHandler(_: any) {
        if (this == null || this.isDestroyed() || this.fullScreen) {
            return;
        }
        const bounds = this.getBounds();
        try {
            await WindowService.SetWindowPosAndSize(
                this.waveWindowId,
                { x: bounds.x, y: bounds.y },
                { width: bounds.width, height: bounds.height }
            );
        } catch (e) {
            console.log("error sending new window bounds to backend", e);
        }
    }

    removeTabView(tabId: string, force: boolean) {
        if (!force && this.activeTabView?.waveTabId == tabId) {
            console.log("cannot remove active tab", tabId, this.waveWindowId);
            return;
        }
        const tabView = this.allLoadedTabViews.get(tabId);
        if (tabView == null) {
            console.log("removeTabView -- tabView not found", tabId, this.waveWindowId);
            // the tab was never loaded, so just return
            return;
        }
        this.contentView.removeChildView(tabView);
        this.allLoadedTabViews.delete(tabId);
        tabView.destroy();
    }

    destroy() {
        console.log("destroy win", this.waveWindowId);
        this.deleteAllowed = true;
        super.destroy();
    }
}

export function getWaveWindowByTabId(tabId: string): WaveBrowserWindow {
    for (const ww of waveWindowMap.values()) {
        if (ww.allLoadedTabViews.has(tabId)) {
            return ww;
        }
    }
}

export function getWaveWindowByWebContentsId(webContentsId: number): WaveBrowserWindow {
    if (webContentsId == null) {
        return null;
    }
    const tabView = getWaveTabViewByWebContentsId(webContentsId);
    if (tabView == null) {
        return null;
    }
    return getWaveWindowByTabId(tabView.waveTabId);
}

export function getWaveWindowById(windowId: string): WaveBrowserWindow {
    return waveWindowMap.get(windowId);
}

export function getWaveWindowByWorkspaceId(workspaceId: string): WaveBrowserWindow {
    for (const waveWindow of waveWindowMap.values()) {
        if (waveWindow.workspaceId === workspaceId) {
            return waveWindow;
        }
    }
}

export function getAllWaveWindows(): WaveBrowserWindow[] {
    return Array.from(waveWindowMap.values());
}

export async function createWindowForWorkspace(workspaceId: string) {
    const newWin = await WindowService.CreateWindow(null, workspaceId);
    if (!newWin) {
        console.log("error creating new window", this.waveWindowId);
    }
    const newBwin = await createBrowserWindow(newWin, await RpcApi.GetFullConfigCommand(ElectronWshClient), {
        unamePlatform,
        isPrimaryStartupWindow: false,
    });
    newBwin.show();
}

// note, this does not *show* the window.
// to show, await win.readyPromise and then win.show()
export async function createBrowserWindow(
    waveWindow: WaveWindow,
    fullConfig: FullConfigType,
    opts: WindowOpts
): Promise<WaveBrowserWindow> {
    if (!waveWindow) {
        console.log("createBrowserWindow: no waveWindow");
        waveWindow = await WindowService.CreateWindow(null, "");
    }
    let workspace = await WorkspaceService.GetWorkspace(waveWindow.workspaceid);
    if (!workspace) {
        console.log("createBrowserWindow: no workspace, creating new window");
        await WindowService.CloseWindow(waveWindow.oid, true);
        waveWindow = await WindowService.CreateWindow(null, "");
        workspace = await WorkspaceService.GetWorkspace(waveWindow.workspaceid);
    }
    console.log("createBrowserWindow", waveWindow.oid, workspace.oid, workspace);
    const bwin = new WaveBrowserWindow(waveWindow, fullConfig, opts);

    if (workspace.activetabid) {
        await bwin.setActiveTab(workspace.activetabid, false, opts.isPrimaryStartupWindow ?? false);
    }
    return bwin;
}

// MOLTENTERM-PATCH (#450): the pending state's Reload and Dismiss (frontend/moltenterm-shell/view-pending.tsx)
ipcMain.on(ViewPendingActionChannel, (event, action: string) => {
    const ww = getWaveWindowByWebContentsId(event.sender.id);
    console.log("[#450] pending state action", action, ww?.waveWindowId);
    if (action === "reload") {
        ww?.viewPending.reload();
    } else {
        ww?.viewPending.dismiss();
    }
});

ipcMain.on("set-active-tab", async (event, tabId) => {
    const ww = getWaveWindowByWebContentsId(event.sender.id);
    console.log("set-active-tab", tabId, ww?.waveWindowId);
    await ww?.setActiveTab(tabId, true);
});

ipcMain.on("create-tab", async (event, _opts) => {
    const senderWc = event.sender;
    const ww = getWaveWindowByWebContentsId(senderWc.id);
    if (ww != null) {
        await ww.queueCreateTab();
    }
    event.returnValue = true;
    return null;
});

ipcMain.on("set-waveai-open", (event, isOpen: boolean) => {
    const tabView = getWaveTabViewByWebContentsId(event.sender.id);
    if (tabView) {
        tabView.isWaveAIOpen = isOpen;
    }
});

ipcMain.handle("close-tab", async (event, workspaceId: string, tabId: string, confirmClose: boolean) => {
    const ww = getWaveWindowByWorkspaceId(workspaceId);
    if (ww == null) {
        console.log(`close-tab: no window found for workspace ws=${workspaceId} tab=${tabId}`);
        return false;
    }
    if (confirmClose) {
        const choice = dialog.showMessageBoxSync(ww, {
            type: "question",
            defaultId: 1, // Enter activates "Close Tab"
            cancelId: 0, // Esc activates "Cancel"
            buttons: ["Cancel", "Close Tab"],
            title: "Confirm",
            message: "Are you sure you want to close this tab?",
        });
        if (choice === 0) {
            return false;
        }
    }
    await ww.queueCloseTab(tabId);
    return true;
});

ipcMain.on("switch-workspace", (event, workspaceId) => {
    fireAndForget(async () => {
        const ww = getWaveWindowByWebContentsId(event.sender.id);
        console.log("switch-workspace", workspaceId, ww?.waveWindowId);
        await ww?.switchWorkspace(workspaceId);
    });
});

export async function createWorkspace(window: WaveBrowserWindow) {
    const newWsId = await WorkspaceService.CreateWorkspace("", "", "", true);
    if (newWsId) {
        if (window) {
            await window.switchWorkspace(newWsId);
        } else {
            await createWindowForWorkspace(newWsId);
        }
    }
}

ipcMain.on("create-workspace", (event) => {
    fireAndForget(async () => {
        const ww = getWaveWindowByWebContentsId(event.sender.id);
        console.log("create-workspace", ww?.waveWindowId);
        await createWorkspace(ww);
    });
});

ipcMain.on("delete-workspace", (event, workspaceId) => {
    fireAndForget(async () => {
        const ww = getWaveWindowByWebContentsId(event.sender.id);
        console.log("delete-workspace", workspaceId, ww?.waveWindowId);

        const workspaceList = await WorkspaceService.ListWorkspaces();

        const _workspaceHasWindow = !!workspaceList.find((wse) => wse.workspaceid === workspaceId)?.windowid;

        // MOLTENTERM-PATCH (#222): the last workspace of a window is reset from the rail, never deleted
        if (!(await WorkspaceService.CanCloseWorkspace(workspaceId))) {
            console.log("delete-workspace refused: last workspace of its window", workspaceId, ww?.waveWindowId);
            return;
        }

        const choice = dialog.showMessageBoxSync(this, {
            type: "question",
            buttons: ["Cancel", "Delete Workspace"],
            title: "Confirm",
            message: `Deleting workspace will also delete its contents.\n\nContinue?`,
        });
        if (choice === 0) {
            console.log("user cancelled workspace delete", workspaceId, ww?.waveWindowId);
            return;
        }

        // MOLTENTERM-PATCH (#449): applied by the action queue of the window that shows the workspace or is switching to
        // it (runDeleteWorkspace), so it cannot race that switch
        const owner = getAllWaveWindows().find((w) => w.isOnWorkspace(workspaceId)) ?? ww;
        if (owner == null) {
            await WorkspaceService.DeleteWorkspace(workspaceId);
            console.log("delete-workspace done", workspaceId);
            sweepDeletedTabViews("workspace deleted"); // MOLTENTERM-PATCH (#448)
            return;
        }
        await owner.queueDeleteWorkspace(workspaceId);
    });
});

// MOLTENTERM-PATCH (#222): the renderer has already confirmed (its own dialog); the window that shows the workspace
// resets it through its action queue
ipcMain.on("reset-workspace", (event, workspaceId: string) => {
    fireAndForget(async () => {
        const ww = getWaveWindowByWorkspaceId(workspaceId) ?? getWaveWindowByWebContentsId(event.sender.id);
        console.log("reset-workspace", workspaceId, ww?.waveWindowId);
        if (ww == null || ww.workspaceId != workspaceId) {
            // Not on screen: the views a window kept for it (#68) belong to tabs that no longer exist.
            const oldWs = await WorkspaceService.GetWorkspace(workspaceId);
            await WorkspaceService.ResetWorkspace(workspaceId);
            for (const tabId of oldWs?.tabids ?? []) {
                getWaveWindowByTabId(tabId)?.removeTabView(tabId, false);
            }
            return;
        }
        await ww.queueResetWorkspace();
    });
});

export async function createNewWaveWindow() {
    log("createNewWaveWindow");
    const clientData = await ClientService.GetClientData();
    const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
    let recreatedWindow = false;
    const allWindows = getAllWaveWindows();
    if (allWindows.length === 0 && clientData?.windowids?.length >= 1) {
        console.log("no windows, but clientData has windowids, recreating first window");
        // reopen the first window
        const existingWindowId = clientData.windowids[0];
        const existingWindowData = (await ObjectService.GetObject("window:" + existingWindowId)) as WaveWindow;
        if (existingWindowData != null) {
            const win = await createBrowserWindow(existingWindowData, fullConfig, {
                unamePlatform,
                isPrimaryStartupWindow: false,
            });
            if (quakeWindow == null) {
                quakeWindow = win;
            }
            win.show();
            recreatedWindow = true;
        }
    }
    if (recreatedWindow) {
        console.log("recreated window, returning");
        return;
    }
    console.log("creating new window");
    const newBrowserWindow = await createBrowserWindow(null, fullConfig, {
        unamePlatform,
        isPrimaryStartupWindow: false,
    });
    if (quakeWindow == null) {
        quakeWindow = newBrowserWindow;
    }
    newBrowserWindow.show();
}

export async function relaunchBrowserWindows() {
    console.log("relaunchBrowserWindows");
    setGlobalIsRelaunching(true);
    const windows = getAllWaveWindows();
    if (windows.length > 0) {
        for (const window of windows) {
            console.log("relaunch -- closing window", window.waveWindowId);
            window.close();
        }
        await delay(1200);
    }
    setGlobalIsRelaunching(false);

    const clientData = await ClientService.GetClientData();
    const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
    const windowIds = clientData.windowids ?? [];
    const wins: WaveBrowserWindow[] = [];
    const isFirstRelaunch = !hasCompletedFirstRelaunch;
    const primaryWindowId = windowIds.length > 0 ? windowIds[0] : null;
    for (const windowId of windowIds.slice().reverse()) {
        const windowData: WaveWindow = await WindowService.GetWindow(windowId);
        if (windowData == null) {
            console.log("relaunch -- window data not found, closing window", windowId);
            await WindowService.CloseWindow(windowId, true);
            continue;
        }
        const isPrimaryStartupWindow = isFirstRelaunch && windowId === primaryWindowId;
        console.log(
            "relaunch -- creating window",
            windowId,
            windowData,
            isPrimaryStartupWindow ? "(primary startup)" : ""
        );
        const win = await createBrowserWindow(windowData, fullConfig, {
            unamePlatform,
            isPrimaryStartupWindow,
            foregroundWindow: windowId === primaryWindowId,
        });
        wins.push(win);
        if (windowId === primaryWindowId) {
            quakeWindow = win;
            console.log("designated quake window", win.waveWindowId);
        }
    }
    hasCompletedFirstRelaunch = true;
    for (const win of wins) {
        console.log("show window", win.waveWindowId);
        win.show();
    }
}

function getDisplayForQuakeToggle() {
    // We cannot reliably query the OS-wide active window in Electron.
    // Cursor position is the best cross-platform proxy for the user's active display.
    const cursorPoint = screen.getCursorScreenPoint();
    const displayAtCursor = screen
        .getAllDisplays()
        .find(
            (display) =>
                cursorPoint.x >= display.bounds.x &&
                cursorPoint.x < display.bounds.x + display.bounds.width &&
                cursorPoint.y >= display.bounds.y &&
                cursorPoint.y < display.bounds.y + display.bounds.height
        );
    return displayAtCursor ?? screen.getDisplayNearestPoint(cursorPoint);
}

function moveWindowToDisplay(win: WaveBrowserWindow, targetDisplay: Electron.Display) {
    if (!win || !targetDisplay || win.isDestroyed()) {
        return;
    }
    const curBounds = win.getBounds();
    const sourceDisplay = screen.getDisplayMatching(curBounds);
    if (sourceDisplay.id === targetDisplay.id) {
        return;
    }

    const sourceArea = sourceDisplay.workArea;
    const targetArea = targetDisplay.workArea;
    const nextHeight = Math.min(curBounds.height, targetArea.height);
    const nextWidth = Math.min(curBounds.width, targetArea.width);
    const maxXOffset = Math.max(0, targetArea.width - nextWidth);
    const maxYOffset = Math.max(0, targetArea.height - nextHeight);
    const sourceXOffset = curBounds.x - sourceArea.x;
    const sourceYOffset = curBounds.y - sourceArea.y;
    const nextX = targetArea.x + Math.min(Math.max(sourceXOffset, 0), maxXOffset);
    const nextY = targetArea.y + Math.min(Math.max(sourceYOffset, 0), maxYOffset);

    win.setBounds({ ...curBounds, x: nextX, y: nextY, width: nextWidth, height: nextHeight });
}

const FullscreenTransitionTimeoutMs = 2000;

// handles a theoretical race condition where the user spams the hotkey before the toggle finishes
let quakeToggleInProgress = false;
let quakeRestoreFullscreenOnShow = false;

function waitForFullscreenLeave(window: WaveBrowserWindow): Promise<void> {
    if (!window.isFullScreen()) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        // eslint-disable-next-line prefer-const
        let timeout: ReturnType<typeof setTimeout>;
        const onLeave = () => {
            clearTimeout(timeout);
            resolve();
        };
        timeout = setTimeout(() => {
            window.removeListener("leave-full-screen", onLeave);
            reject(new Error("fullscreen transition timeout"));
        }, FullscreenTransitionTimeoutMs);
        window.once("leave-full-screen", onLeave);
    });
}

function waitForFullscreenEnter(window: WaveBrowserWindow): Promise<void> {
    if (window.isFullScreen()) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        // eslint-disable-next-line prefer-const
        let timeout: ReturnType<typeof setTimeout>;
        const onEnter = () => {
            clearTimeout(timeout);
            resolve();
        };
        timeout = setTimeout(() => {
            window.removeListener("enter-full-screen", onEnter);
            reject(new Error("fullscreen transition timeout"));
        }, FullscreenTransitionTimeoutMs);
        window.once("enter-full-screen", onEnter);
    });
}

async function quakeToggle() {
    if (quakeToggleInProgress) {
        return;
    }
    quakeToggleInProgress = true;
    try {
        let window = quakeWindow;
        if (window?.isDestroyed()) {
            quakeWindow = null;
            window = null;
        }
        if (window == null) {
            await createNewWaveWindow();
            return;
        }
        // Some environments don't hide or move the window if it's fullscreen (even when hidden), so leave fullscreen first
        if (window.isFullScreen()) {
            // macos has a really long fullscreen animation and can have issues restoring from fullscreen, so we skip on macos
            quakeRestoreFullscreenOnShow = process.platform !== "darwin";
            const leavePromise = waitForFullscreenLeave(window);
            window.setFullScreen(false);
            try {
                await leavePromise;
            } catch {
                // timeout — proceed anyway
            }
            if (window.isDestroyed()) {
                return;
            }
        }
        if (window.isVisible()) {
            window.hide();
        } else {
            const targetDisplay = getDisplayForQuakeToggle();
            moveWindowToDisplay(window, targetDisplay);
            window.show();
            if (quakeRestoreFullscreenOnShow) {
                const enterPromise = waitForFullscreenEnter(window);
                window.setFullScreen(true);
                try {
                    await enterPromise;
                } catch {
                    // timeout — proceed anyway
                }
            }
            quakeRestoreFullscreenOnShow = false;
            window.focus();
            if (window.activeTabView?.webContents) {
                window.activeTabView.webContents.focus();
            }
        }
    } finally {
        quakeToggleInProgress = false;
    }
}

let currentRawGlobalHotKey: string = null;
let currentGlobalHotKey: string = null;

export function registerGlobalHotkey(rawGlobalHotKey: string) {
    if (rawGlobalHotKey === currentRawGlobalHotKey) {
        return;
    }
    if (currentGlobalHotKey != null) {
        globalShortcut.unregister(currentGlobalHotKey);
        currentGlobalHotKey = null;
        currentRawGlobalHotKey = null;
    }
    if (!rawGlobalHotKey) {
        return;
    }
    try {
        const electronHotKey = waveKeyToElectronKey(rawGlobalHotKey);
        const ok = globalShortcut.register(electronHotKey, () => {
            fireAndForget(quakeToggle);
        });
        currentRawGlobalHotKey = rawGlobalHotKey;
        currentGlobalHotKey = electronHotKey;
        console.log("registered globalhotkey", rawGlobalHotKey, "=>", electronHotKey, "ok=", ok);
    } catch (e) {
        console.log("error registering global hotkey", rawGlobalHotKey, ":", e);
    }
}

export function initGlobalHotkeyEventSubscription() {
    waveEventSubscribeSingle({
        eventType: "config",
        handler: (event) => {
            try {
                const hotkey = event?.data?.fullconfig?.settings?.["app:globalhotkey"];
                registerGlobalHotkey(hotkey ?? null);
            } catch (e) {
                console.log("error handling config event for globalhotkey", e);
            }
        },
    });
}
