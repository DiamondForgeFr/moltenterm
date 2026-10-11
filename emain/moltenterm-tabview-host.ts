// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tab view host (#461, FR-PERF-015, DS-PERF-013): every tab view's lifecycle in one place, along the state machine
// of emain/moltenterm-tabview-machine.ts. It owns the hot spare and the tab view cache (Wave's, in emain-tabview.ts
// until #461), gives a view to a tab, shows it in its window (the init, readiness, retry, activation and positioning
// that lived in emain-window.ts), destroys it, and runs what concerns every view: the sweep of deleted tabs (#448), the
// hidden view budget (#454), the wake refresh (#199) and the paint check of a reused view (#223). A window asks it for
// a view; its allLoadedTabViews and activeTabView read it.
//
// One readiness deadline per window action (#449, extended once by #450's retry) bounds every wait on a view here: the
// spare, a fresh view, the init, wave-ready and the reinit of a reused view.

import { ClientService, ObjectService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import { fireAndForget } from "@/util/util";
import { ipcMain } from "electron";
import { isDev } from "./emain-platform";
import { getOrCreateWebViewForTab, WaveTabView } from "./emain-tabview";
import type { WaveBrowserWindow } from "./emain-window";
import { getAllWaveWindows, getWaveWindowById, getWaveWindowByWebContentsId } from "./emain-window";
import { ElectronWshClient } from "./emain-wsh";
import { ActionRun, isSuperseded, readinessDeadlineMs } from "./moltenterm-action-queue";
import { hostsBrowserPage, hostsControlledTab } from "./moltenterm-browseragent";
import { acquireReadyView, awaitViewInitialized } from "./moltenterm-spare-ready";
import {
    beginShowingTabView,
    endShowingTabView,
    hideParkedTabView,
    noteTabViewLeftScreenForBudget,
    revealTabView,
} from "./moltenterm-tabview-budget";
import { makeHiddenTabViewBudget } from "./moltenterm-tabview-budget-live";
import { TabViewRegistry, TabViewSnapshotEntry } from "./moltenterm-tabview-machine";
import {
    noteTabViewPrioritySetting,
    raiseSparePriority,
    raiseTabViewPriority,
    restoreTabViewPriority,
} from "./moltenterm-tabview-priority";
import { checkReusedTabViewPainted, noteTabViewLeftScreen } from "./moltenterm-tabview-repaint";
import { makeTabViewSweeper } from "./moltenterm-tabview-sweep";
import {
    loadPendingPage,
    makePendingPage,
    PendingPage,
    ViewPendingActionChannel,
    ViewPendingController,
    ViewPendingState,
} from "./moltenterm-view-pending";
import { MoltentermReinitTimeoutMs, nextWaveReady, withTimeout } from "./moltenterm-workspace-switch";

// Wave's default, changed by window:maxtabcachesize; #454's budget normally keeps far fewer.
const DefaultMaxCacheSize = 10;
// A view taken this recently is in the middle of a switch (Wave's tryEvictEntry).
const RecentlyUsedMs = 1000;

// A view that missed its readiness deadline twice (the action fails and offers Reload), as opposed to an action
// stopped for another reason (superseded, its tab deleted) (#450).
export class ReadinessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReadinessError";
    }
}

// Strict in dev builds (the unpackaged app, the harness) and in the unit tests, so every characterization test also
// checks that no invalid transition happens.
const registry = new TabViewRegistry<WaveTabView>({
    strict: () => isDev || process.env.VITEST === "true",
    log: (msg) => console.log(msg),
    now: () => Date.now(),
});

let maxCacheSize = DefaultMaxCacheSize;
let hotSpare: WaveTabView = null;
let cachedClientId: string = null;
const destroyReasons = new WeakMap<WaveTabView, string>();

// For DevTools and the harness: the state of every view.
export function tabViewHostSnapshot(): TabViewSnapshotEntry[] {
    return registry.snapshot();
}

export function invalidTabViewTransitions(): number {
    return registry.invalidCount;
}

function makeTabView(fullConfig: FullConfigType): WaveTabView {
    const view = new WaveTabView(fullConfig);
    registry.add(view);
    return view;
}

// --- hot spare

export function ensureHotSpareTab(fullConfig: FullConfigType) {
    console.log("ensureHotSpareTab");
    if (hotSpare != null) {
        return;
    }
    hotSpare = makeTabView(fullConfig);
    // The spare loads at the foreground priority, once no view is being shown (#450).
    noteTabViewPrioritySetting(fullConfig);
    raiseSparePriority(() => hotSpare);
}

export function getSpareTab(fullConfig: FullConfigType): WaveTabView {
    setTimeout(() => ensureHotSpareTab(fullConfig), 500);
    if (hotSpare != null) {
        const rtn = hotSpare;
        hotSpare = null;
        console.log("getSpareTab: returning hotspare");
        return rtn;
    }
    console.log("getSpareTab: creating new tab");
    return makeTabView(fullConfig);
}

export function isHotSpareTab(tabView: WaveTabView): boolean {
    return tabView != null && tabView === hotSpare;
}

// The spare is a hidden view too, stale after a long sleep (#199); the next ensureHotSpareTab makes a new one.
export function discardHotSpareTab() {
    if (hotSpare == null) {
        return;
    }
    const spare = hotSpare;
    hotSpare = null;
    destroyTabView(spare, "spare discarded");
}

// A view taken for a superseded switch was never given a tab; it becomes the spare again (rapid clicks then cost no new
// renderer), unless another spare was made meanwhile (#449).
function returnSpareTab(tabView: WaveTabView) {
    if (hotSpare == null && !tabView.isDestroyed) {
        console.log("returnSpareTab: unused view kept as the hot spare");
        hotSpare = tabView;
        return;
    }
    destroyTabView(tabView, "unused spare");
}

function withRaisedPriority(tabView: WaveTabView): WaveTabView {
    raiseTabViewPriority(tabView);
    return tabView;
}

// --- the tab view cache

export function setMaxTabCacheSize(size: number) {
    console.log("setMaxTabCacheSize", size);
    maxCacheSize = size;
}

export function getWaveTabView(waveTabId: string): WaveTabView | undefined {
    const rtn = registry.viewForTab(waveTabId);
    if (rtn == null) {
        return undefined;
    }
    rtn.lastUsedTs = Date.now();
    return rtn;
}

// Every live view given to a tab, in a window or still being acquired.
export function getCachedTabViews(): WaveTabView[] {
    return registry.tabViews();
}

function tryEvictEntry(tabView: WaveTabView): boolean {
    if (tabView == null || tabView.isActiveTab) {
        return false;
    }
    // A tab view holding a browser tab an agent drives stays, so its page keeps running and can be read and captured
    // while the tab is hidden (#301, FR-BRW-009); so does one showing a browser panel with a loaded page, driven or
    // not: its page (a sign-in, a form) survives the wake refresh and the cache eviction (#375).
    const wc = tabView.webContents;
    if (!wc.isDestroyed() && (hostsControlledTab(wc.id) || hostsBrowserPage(wc.id))) {
        return false;
    }
    if (Date.now() - tabView.lastUsedTs < RecentlyUsedMs) {
        return false;
    }
    const ww = getWaveWindowById(tabView.waveWindowId);
    if (ww == null) {
        console.log("[error] WaveWindow not found for WaveTabView", tabView.waveTabId);
        destroyTabView(tabView, "no window");
        return true;
    }
    removeWindowTabView(ww, tabView.waveTabId, false);
    return true;
}

// Views tryEvictEntry keeps do not use up the evictions, the next oldest go instead (#375).
function checkAndEvictCache() {
    if (registry.byTab.size <= maxCacheSize) {
        return;
    }
    const sorted = Array.from(registry.byTab.values()).sort((a, b) => {
        if (a.isActiveTab && !b.isActiveTab) {
            return -1;
        }
        return a.lastUsedTs - b.lastUsedTs;
    });
    for (let i = 0; i < sorted.length && registry.byTab.size > maxCacheSize; i++) {
        tryEvictEntry(sorted[i]);
    }
}

// Returns the views it had to keep, for the wake refresh to repaint them when shown (#375).
export function clearTabCache(): WaveTabView[] {
    const kept: WaveTabView[] = [];
    for (const tabView of Array.from(registry.byTab.values())) {
        if (!tryEvictEntry(tabView) && registry.viewForTab(tabView.waveTabId) === tabView) {
            kept.push(tabView);
        }
    }
    return kept;
}

export type AcquiredTabView = { view: WaveTabView; initialized: boolean; fullConfig: FullConfigType };

// The tab's view, or a spare given to the tab and to the window that asked, by the action's readiness deadline. A
// spare that stays silent is replaced instead of awaited forever (#283); the view taken loads at the foreground
// priority (#450). When `cancelled` resolves first (the action was superseded), the view taken goes back as the hot
// spare and null is returned (#449).
export async function acquireViewForTab(
    waveWindowId: string,
    tabId: string,
    deadline: number,
    cancelled: Promise<void>
): Promise<AcquiredTabView> {
    const cached = getWaveTabView(tabId);
    if (cached != null) {
        return { view: cached, initialized: true, fullConfig: null };
    }
    const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
    noteTabViewPrioritySetting(fullConfig);
    const acquired = await acquireReadyView(
        () => withRaisedPriority(getSpareTab(fullConfig)),
        () => withRaisedPriority(makeTabView(fullConfig)),
        (msg) => console.log("[#283]", msg),
        deadline,
        cancelled
    );
    if (acquired.cancelled) {
        returnSpareTab(acquired.view);
        return null;
    }
    const tabView = acquired.view;
    tabView.waveWindowId = waveWindowId;
    tabView.lastUsedTs = Date.now();
    registry.assign(tabView, tabId, waveWindowId, "given to a tab");
    tabView.waveTabId = tabId;
    checkAndEvictCache();
    return { view: tabView, initialized: false, fullConfig };
}

// A view still being acquired when its switch is superseded stops waiting at once and goes back as the hot spare; one
// acquired just then is destroyed, never left in the cache without a window that shows it (#449).
export async function acquireWindowTabView(
    win: WaveBrowserWindow,
    tabId: string,
    run: ActionRun
): Promise<[WaveTabView, boolean]> {
    const acquiring = getOrCreateWebViewForTab(win.waveWindowId, tabId, run.deadline, run.whenSuperseded);
    try {
        return await run.race(acquiring);
    } catch (e) {
        fireAndForget(async () => {
            const acquired = await acquiring;
            if (acquired == null) {
                return;
            }
            const [tabView, tabInitialized] = acquired;
            if (!tabInitialized && !registry.entries.get(tabView)?.adopted) {
                destroyTabView(tabView, "acquired for a superseded switch");
            }
        });
        throw e;
    }
}

// --- destruction

// The one way a view goes: it leaves the cache, its window's views and its window's screen, then its renderer closes.
export function destroyTabView(tabView: WaveTabView, reason: string) {
    if (tabView == null) {
        return;
    }
    destroyReasons.set(tabView, reason);
    tabView.destroy();
}

// WaveTabView.destroy, whoever calls it (the sweep, the budget, the spare's replacement call it directly).
export function noteTabViewDestroying(tabView: WaveTabView) {
    if (!registry.has(tabView)) {
        return;
    }
    const windowId = registry.windowOf(tabView);
    if (!registry.evict(tabView, destroyReasons.get(tabView) ?? "destroyed")) {
        return;
    }
    if (hotSpare === tabView) {
        hotSpare = null;
    }
    const win = windowId == null ? null : getWaveWindowById(windowId);
    if (win != null && !win.isDestroyed()) {
        win.contentView.removeChildView(tabView);
    }
}

// The renderer is gone: closed by destroy, or by itself (a crash, the app quitting).
export function noteTabViewDestroyed(tabView: WaveTabView) {
    if (hotSpare === tabView) {
        hotSpare = null;
    }
    const going = registry.stateOf(tabView) === "evicting";
    registry.destroyed(tabView, going ? "its renderer closed" : "its renderer went away");
}

// --- a window's views

export function windowTabViews(waveWindowId: string): Map<string, WaveTabView> {
    return registry.windowViews(waveWindowId);
}

export function activeWindowTabView(waveWindowId: string): WaveTabView {
    return registry.activeOf(waveWindowId);
}

export function removeWindowTabView(win: WaveBrowserWindow, tabId: string, force: boolean) {
    if (!force && win.activeTabView?.waveTabId == tabId) {
        console.log("cannot remove active tab", tabId, win.waveWindowId);
        return;
    }
    const tabView = windowTabViews(win.waveWindowId).get(tabId);
    if (tabView == null) {
        console.log("removeTabView -- tabView not found", tabId, win.waveWindowId);
        // the tab was never loaded, so just return
        return;
    }
    destroyTabView(tabView, force ? "removed from its window (forced)" : "removed from its window");
}

export function closeWindowTabViews(win: WaveBrowserWindow) {
    windowState(win).pending.hide();
    for (const tabView of windowTabViews(win.waveWindowId).values()) {
        destroyTabView(tabView, "window closed");
    }
}

export function positionWindowTabViews(win: WaveBrowserWindow) {
    if (win.isDestroyed()) {
        return;
    }
    const curBounds = win.getContentBounds();
    const active = win.activeTabView;
    if (active != null) {
        // A view hidden while the budget was on is shown even when the budget has been turned off since (#454).
        revealTabView(active);
        active.positionTabOnScreen(curBounds);
    }
    for (const tabView of windowTabViews(win.waveWindowId).values()) {
        if (tabView == active) {
            continue;
        }
        tabView?.positionTabOffScreen(curBounds);
        hideParkedTabView(tabView);
    }
}

// Makes a view the window's active one; a switch does it only once the view is ready (#449).
function activateTabView(win: WaveBrowserWindow, tabView: WaveTabView, oldActiveView: WaveTabView) {
    registry.activate(win.waveWindowId, tabView, "activated");
    tabView.isActiveTab = true;
    if (oldActiveView != null && oldActiveView !== tabView) {
        oldActiveView.isActiveTab = false;
    }
    noteTabViewLeftScreen(oldActiveView);
    noteTabViewLeftScreenForBudget(oldActiveView);
}

function restoreActiveTabView(win: WaveBrowserWindow, oldActiveView: WaveTabView) {
    registry.activate(win.waveWindowId, oldActiveView, "given back after a failed show");
    if (oldActiveView != null) {
        oldActiveView.isActiveTab = true;
    }
}

async function getClientId(): Promise<string> {
    if (cachedClientId != null) {
        return cachedClientId;
    }
    const clientData = await ClientService.GetClientData();
    cachedClientId = clientData?.oid;
    return cachedClientId;
}

// The view runs at the foreground priority until it is on screen, or dropped (#450), and is neither hidden nor
// evicted meanwhile (#454). waitReady shows it only once it has rendered (a workspace switch, #68): until then the
// window keeps showing its current view, and neither a resize nor a superseded switch brings the new one on screen.
export async function showTabViewInWindow(
    win: WaveBrowserWindow,
    tabView: WaveTabView,
    tabInitialized: boolean,
    primaryStartupTab: boolean,
    waitReady: boolean,
    run: ActionRun
) {
    raiseTabViewPriority(tabView);
    beginShowingTabView(tabView);
    try {
        await setTabViewIntoWindow(win, tabView, tabInitialized, primaryStartupTab, waitReady, run);
    } finally {
        endShowingTabView(tabView);
        restoreTabViewPriority(tabView);
    }
}

async function setTabViewIntoWindow(
    win: WaveBrowserWindow,
    tabView: WaveTabView,
    tabInitialized: boolean,
    primaryStartupTab: boolean,
    waitReady: boolean,
    run: ActionRun
) {
    if (win.activeTabView == tabView) {
        return;
    }
    const oldActiveView = win.activeTabView;
    if (!waitReady) {
        activateTabView(win, tabView, oldActiveView);
    }
    registry.adopt(tabView, win.waveWindowId);
    if (!tabInitialized) {
        console.log("initializing a new tab", primaryStartupTab ? "(primary startup)" : "");
        try {
            await initializeTab(win, tabView, primaryStartupTab, waitReady, run);
        } catch (e) {
            // A view that never initialized is dropped, so the next switch builds a new one (#283); so is a view whose
            // action was superseded, or whose tab no longer exists (#449).
            console.log("[#283] initializing a new tab failed, dropping its view", tabView.waveTabId, e);
            if (win.activeTabView == tabView) {
                restoreActiveTabView(win, oldActiveView);
            }
            if (!isSuperseded(e) && registry.stateOf(tabView) === "loading") {
                registry.fail(tabView, String(e?.message ?? e));
            }
            destroyTabView(tabView, isSuperseded(e) ? "its switch was superseded" : "it failed to load");
            throw e;
        }
        if (waitReady) {
            activateTabView(win, tabView, oldActiveView);
        }
        positionWindowTabViews(win);
    } else {
        console.log("reusing an existing tab, calling wave-init", tabView.waveTabId);
        // A view hidden off-screen is shown again before its reinit (#454).
        revealTabView(tabView);
        const reinitDone = waitReady ? nextWaveReady(tabView) : null;
        tabView.webContents.send("wave-init", tabView.savedInitOpts); // reinit
        if (reinitDone != null) {
            // A superseded switch leaves the reused view off-screen, in the cache (#68, #449).
            await run.race(withTimeout(reinitDone, Math.min(MoltentermReinitTimeoutMs, run.remainingMs())));
            activateTabView(win, tabView, oldActiveView);
        }
        positionWindowTabViews(win);
        // A long-hidden view can come back black (#223).
        checkReusedTabViewPainted(win, tabView);
    }

    // something is causing the new tab to lose focus so it requires manual refocusing
    tabView.webContents.focus();
    setTimeout(() => {
        if (tabView.webContents && win.activeTabView == tabView && !tabView.webContents.isFocused()) {
            tabView.webContents.focus();
        }
    }, 10);
    setTimeout(() => {
        if (tabView.webContents && win.activeTabView == tabView && !tabView.webContents.isFocused()) {
            tabView.webContents.focus();
        }
    }, 30);
}

// Every wait shares the action's single readiness deadline and stops as soon as a newer action takes over (#449).
async function initializeTab(
    win: WaveBrowserWindow,
    tabView: WaveTabView,
    primaryStartupTab: boolean,
    offScreen: boolean,
    run: ActionRun
) {
    const clientId = await run.race(getClientId());
    // The queue never waits indefinitely on one view's init (#283); a view still loading at the deadline is kept and
    // waited for once more (#450).
    let viewReady = await run.race(awaitViewInitialized(tabView, run.remainingMs()));
    if (!viewReady && retryAtReadinessDeadline(win, tabView, "init", run)) {
        viewReady = await run.race(awaitViewInitialized(tabView, run.remainingMs()));
    }
    if (!viewReady) {
        await onReadinessDeadline(win, tabView, "init");
        throw new ReadinessError(`tab view ${tabView.waveTabId} not initialized by the readiness deadline`);
    }
    const winBounds = win.getContentBounds();
    tabView.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height });
    // Rendered off-screen first, so the previous view stays visible until this one is ready (#68).
    if (offScreen) {
        tabView.positionTabOffScreen(winBounds);
    }
    win.contentView.addChildView(tabView);
    keepPendingPageOnTop(win);
    const initOpts: WaveInitOpts = {
        tabId: tabView.waveTabId,
        clientId: clientId,
        windowId: win.waveWindowId,
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
    // Never leave the window on the previous workspace when a renderer does not answer (#68, #449).
    await run.race(withTimeout(tabView.waveReadyPromise, run.remainingMs()));
    if (!tabView.isWaveReady && retryAtReadinessDeadline(win, tabView, "wave-ready", run)) {
        await run.race(withTimeout(tabView.waveReadyPromise, run.remainingMs()));
    }
    if (!tabView.isWaveReady && !(await onReadinessDeadline(win, tabView, "wave-ready"))) {
        throw new Error(`tab view ${tabView.waveTabId} not ready by the readiness deadline`);
    }
    console.log("wave-ready init time", Date.now() - startTime + "ms");
    registry.markReady(tabView, tabView.isWaveReady ? "rendered" : "shown at the readiness deadline (#68)");
}

// The first time an action's readiness deadline passes, a view still loading is kept and gets one more readiness
// period (its renderer is busy, not lost: a new one would start from zero), and the pending state says so. A view
// whose renderer is gone is not waited for (#450).
function retryAtReadinessDeadline(
    win: WaveBrowserWindow,
    tabView: WaveTabView,
    stage: "init" | "wave-ready",
    run: ActionRun
): boolean {
    if (tabView.isDestroyed || tabView.webContents.isDestroyed() || tabView.webContents.isCrashed()) {
        return false;
    }
    if (!run.extendOnce(readinessDeadlineMs(isDev))) {
        return false;
    }
    console.log(`[#450] readiness deadline passed (${stage}) for tab ${tabView.waveTabId}, kept, retrying once`);
    raiseTabViewPriority(tabView);
    const state = windowState(win);
    state.pending.setPhase(state.pendingToken, "retrying");
    return true;
}

// The one place a missed readiness deadline is decided (after the retry of #450). Returns whether the view is shown
// anyway: a renderer that initialized is (#68), unless its tab no longer exists (deleted meanwhile, its renderer
// failed on it); one that never initialized is dropped (#283) (#449).
async function onReadinessDeadline(
    win: WaveBrowserWindow,
    tabView: WaveTabView,
    stage: "init" | "wave-ready"
): Promise<boolean> {
    console.log(`[#449] readiness deadline passed (${stage}) for tab ${tabView.waveTabId}`);
    if (isDev) {
        console.log("[dev] showing window for devtools");
        if (!win.isDestroyed() && !win.isVisible()) {
            win.show();
        }
        if (win.activeTabView?.webContents && !win.activeTabView.webContents.isDevToolsOpened()) {
            win.activeTabView.webContents.openDevTools();
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

// --- a window's pending state (#450, emain/moltenterm-view-pending.ts)

type WindowViewsState = {
    pending: ViewPendingController;
    pendingPage: PendingPage;
    pendingToken: number;
};

const windowStates = new WeakMap<WaveBrowserWindow, WindowViewsState>();

function windowState(win: WaveBrowserWindow): WindowViewsState {
    let state = windowStates.get(win);
    if (state != null) {
        return state;
    }
    state = { pending: null, pendingPage: null, pendingToken: 0 };
    const s = state;
    s.pending = new ViewPendingController({
        liveView: () => pendingLiveView(win),
        showPage: (pendingState) => showPendingPage(win, s, pendingState),
        hidePage: () => hidePendingPage(win, s),
    });
    win.on("resize", () => {
        if (!win.isDestroyed()) {
            s.pendingPage?.view.setBounds(fullBounds(win));
        }
    });
    windowStates.set(win, s);
    return s;
}

export function windowViewPending(win: WaveBrowserWindow): ViewPendingController {
    return windowState(win).pending;
}

export function beginWindowPending(
    win: WaveBrowserWindow,
    workspaceName: string,
    onReload: () => void,
    startedAt: number,
    graceMs?: number
): number {
    const state = windowState(win);
    state.pendingToken = state.pending.begin(workspaceName, onReload, startedAt, graceMs);
    return state.pendingToken;
}

// The view that draws the pending state over its panels: on screen and rendered.
function pendingLiveView(win: WaveBrowserWindow): WaveTabView {
    const view = win.activeTabView;
    if (win.isDestroyed() || view == null || view.isDestroyed || !view.isWaveReady || !view.isOnScreen()) {
        return null;
    }
    return view;
}

function fullBounds(win: WaveBrowserWindow) {
    const b = win.getContentBounds();
    return { x: 0, y: 0, width: b.width, height: b.height };
}

// The page goes over the window, which is shown (if it was not yet) once the page has loaded, so it is never shown
// empty.
function showPendingPage(win: WaveBrowserWindow, state: WindowViewsState, pendingState: ViewPendingState) {
    if (win.isDestroyed()) {
        return;
    }
    if (state.pendingPage != null) {
        fireAndForget(() => loadPendingPage(state.pendingPage.view, pendingState));
        return;
    }
    const page = makePendingPage(pendingState, () => state.pending.reload());
    state.pendingPage = page;
    page.view.setBounds(fullBounds(win));
    win.contentView.addChildView(page.view);
    fireAndForget(async () => {
        await page.loaded;
        if (state.pendingPage !== page || win.isDestroyed() || win.isVisible()) {
            return;
        }
        console.log("[#450] showing the window with the pending page", win.waveWindowId);
        win.show();
    });
}

function hidePendingPage(win: WaveBrowserWindow, state: WindowViewsState) {
    const page = state.pendingPage;
    if (page == null) {
        return;
    }
    state.pendingPage = null;
    if (!win.isDestroyed()) {
        win.contentView.removeChildView(page.view);
    }
    if (!page.view.webContents.isDestroyed()) {
        page.view.webContents.close();
    }
}

// A tab view added while the page is shown goes under it until it has rendered.
function keepPendingPageOnTop(win: WaveBrowserWindow) {
    const page = windowStates.get(win)?.pendingPage;
    if (page == null || win.isDestroyed()) {
        return;
    }
    win.contentView.removeChildView(page.view);
    win.contentView.addChildView(page.view);
}

// The pending state's Reload and Dismiss (frontend/moltenterm-shell/view-pending.tsx).
ipcMain.on(ViewPendingActionChannel, (event, action: string) => {
    const ww = getWaveWindowByWebContentsId(event.sender.id);
    console.log("[#450] pending state action", action, ww?.waveWindowId);
    if (ww == null) {
        return;
    }
    if (action === "reload") {
        windowViewPending(ww).reload();
    } else {
        windowViewPending(ww).dismiss();
    }
});

// --- what concerns every view

let sweepTabViews: (reason: string) => Promise<number> = null;

// Destroys, in every window, the views of tabs that no longer exist (#448, emain/moltenterm-tabview-sweep.ts).
export function sweepDeletedTabViews(reason: string) {
    sweepTabViews ??= makeTabViewSweeper<WaveTabView>({
        cachedViews: () => getCachedTabViews(),
        windows: () => getAllWaveWindows().filter((ww) => !ww.isDestroyed()),
        isHotSpare: (view) => isHotSpareTab(view),
        existingTabIds: async (tabIds) => {
            const tabs = await ObjectService.GetObjects(tabIds.map((id) => "tab:" + id));
            return new Set((tabs ?? []).filter((tab) => tab != null).map((tab) => tab.oid));
        },
        log: (msg, ...args) => console.log(msg, ...args),
    });
    fireAndForget(async () => {
        const destroyed = await sweepTabViews(reason);
        if (destroyed > 0) {
            console.log(`[#448] ${destroyed} tab view(s) of deleted tabs destroyed (${reason})`);
        }
    });
}

let enforceBudget: () => void = null;

// Destroys the hidden views past the budget, least recently used first (#454).
export function enforceHiddenTabViewBudget() {
    enforceBudget ??= makeHiddenTabViewBudget(() => getAllWaveWindows().filter((ww) => !ww.isDestroyed()));
    enforceBudget();
}
