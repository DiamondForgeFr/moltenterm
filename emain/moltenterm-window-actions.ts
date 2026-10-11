// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A window's actions (#461): what Wave's processActionQueue did for each queued entry, with what #68, #222, #448,
// #449, #450 and #454 changed in it, out of emain-window.ts. Each action runs in the window's WindowActionQueue
// (emain/moltenterm-action-queue.ts) with one readiness deadline, does its backend side here and asks the tab view host
// (emain/moltenterm-tabview-host.ts) for the view to show.

import { WindowService, WorkspaceService } from "@/app/store/services";
import { fireAndForget } from "@/util/util";
import { getOrCreateWebViewForTab } from "./emain-tabview";
import type { WaveBrowserWindow } from "./emain-window";
import { getWaveWindowById } from "./emain-window";
import { ActionRun, isSuperseded } from "./moltenterm-action-queue";
import { noteTabViewWorkspace } from "./moltenterm-tabview-budget";
import {
    acquireWindowTabView,
    beginWindowPending,
    enforceHiddenTabViewBudget,
    hasTabView,
    isTabViewHostEnabled,
    ReadinessError,
    showTabViewInWindow,
    sweepDeletedTabViews,
    windowShowsLiveView,
    windowViewPending,
} from "./moltenterm-tabview-host";
import { beginTabViewWork, endTabViewWork } from "./moltenterm-tabview-priority";
import { StartupPendingGraceMs } from "./moltenterm-view-pending";
import { releaseTabViewFromOtherWindow, tabViewsToCloseOnLeave } from "./moltenterm-workspace-switch";

export type WindowAction =
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
          // the last workspace of a window is reset from the rail, never deleted (#222)
          op: "resetworkspace";
      }
    | {
          // a delete goes through the queue, so it cannot race a switch to the same workspace (#449)
          op: "deleteworkspace";
          workspaceId: string;
      };

// The backend's window can be ahead of the workspace on screen (workspaceId) while a switch is running or after one was
// superseded (#449). Until a switch moves it, it is on the workspace the window was made for.
const backendWorkspaces = new WeakMap<WaveBrowserWindow, string>();

function backendWorkspaceOf(win: WaveBrowserWindow): string {
    return backendWorkspaces.has(win) ? backendWorkspaces.get(win) : win.workspaceId;
}

function setBackendWorkspace(win: WaveBrowserWindow, workspaceId: string) {
    backendWorkspaces.set(win, workspaceId);
}

// The window shows the workspace, is switching to it, or its backend window is on it (#449).
export function isWindowOnWorkspace(win: WaveBrowserWindow, workspaceId: string): boolean {
    return (
        win.workspaceId == workspaceId ||
        backendWorkspaceOf(win) == workspaceId ||
        win.actionQueue.targetsWorkspace(workspaceId)
    );
}

// While an action runs the hot spare waits to be raised (it would compete with the view being shown); once the queue is
// empty a pending state that is not a failure goes (#450), and the hidden views past the budget are destroyed (#454).
export async function runWindowAction(win: WaveBrowserWindow, entry: WindowAction, run: ActionRun) {
    beginTabViewWork();
    try {
        await runAction(win, entry, run);
    } finally {
        endTabViewWork();
        if (win.actionQueue.length <= 1) {
            windowViewPending(win).settle();
        }
        enforceHiddenTabViewBudget();
    }
}

// A window that has never shown a tab (a launch) shows the pending page when its first tab is slow, and Reload when it
// fails (#450). A window already shown (Reload after a failure) has nothing else to show: no grace.
async function beginStartupPending(win: WaveBrowserWindow, tabId: string): Promise<number> {
    const startedAt = Date.now();
    const ws = await WorkspaceService.GetWorkspace(win.workspaceId).catch((): Workspace => null);
    const onReload = () => fireAndForget(() => win.setActiveTab(tabId, false));
    return beginWindowPending(win, ws?.name, onReload, startedAt, win.isVisible() ? 0 : StartupPendingGraceMs);
}

// A warm new tab renders in 100 to 200 ms: the window keeps its current tab until then, and a pending state flashing
// over it for that time would be noise. Only a slower tab shows it.
export const TabPendingGraceMs = 250;

function workspaceName(win: WaveBrowserWindow): Promise<string> {
    return WorkspaceService.GetWorkspace(win.workspaceId)
        .then((ws) => ws?.name)
        .catch((): string => null);
}

// A tab of the workspace on screen whose view is not loaded yet (a new tab, a reset, a closed tab's successor, a tab
// whose view was evicted) renders off-screen while the window keeps showing its current tab, as a workspace switch does
// (#68), and the current view draws the pending state over its panels if it is slow (#461, the plain background Wave's
// flow showed between loading and first render).
function beginTabPending(win: WaveBrowserWindow, tabId: string, name: string, startedAt: number): number {
    const onReload = () => fireAndForget(() => win.setActiveTab(tabId, true));
    return beginWindowPending(win, name, onReload, startedAt, TabPendingGraceMs);
}

// A new tab that did not open leaves the window on the tab it shows: the backend's active tab follows, so the tab bar
// and a later click agree with the screen.
async function rollBackActiveTab(win: WaveBrowserWindow, failedTabId: string) {
    const shownTabId = win.activeTabView?.waveTabId;
    if (shownTabId == null || shownTabId == failedTabId) {
        return;
    }
    try {
        await WorkspaceService.SetActiveTab(win.workspaceId, shownTabId);
        console.log("[#461] new tab did not open, backend back on the tab shown", shownTabId, win.waveWindowId);
    } catch (e) {
        console.log("[#461] new tab did not open, could not take the backend back to", shownTabId, e);
    }
}

function removeTabViewLater(win: WaveBrowserWindow, tabId: string, delayMs: number) {
    setTimeout(() => {
        win.removeTabView(tabId, false);
    }, delayMs);
}

// One action of the queue; a return or a throw anywhere here only ends this action (#449).
async function runAction(win: WaveBrowserWindow, entry: WindowAction, run: ActionRun) {
    const startedAt = Date.now();
    let tabId: string = null;
    let tabViewsToClose: string[] = [];
    // have to use "===" here to get the typechecker to work :/
    switch (entry.op) {
        case "createtab":
            tabId = await WorkspaceService.CreateTab(win.workspaceId, null, true);
            break;
        case "switchtab":
            tabId = entry.tabId;
            if (win.activeTabView?.waveTabId == tabId) {
                return;
            }
            if (entry.setInBackend) {
                await WorkspaceService.SetActiveTab(win.workspaceId, tabId);
            }
            break;
        case "closetab": {
            tabId = entry.tabId;
            const rtn = await WorkspaceService.CloseTab(win.workspaceId, tabId, true);
            if (rtn == null) {
                console.log("[error] closeTab: no return value", tabId, win.workspaceId, win.waveWindowId);
                return;
            }
            removeTabViewLater(win, tabId, 1000);
            if (rtn.closewindow) {
                win.close();
                return;
            }
            if (!rtn.newactivetabid) {
                return;
            }
            tabId = rtn.newactivetabid;
            break;
        }
        case "switchworkspace":
            await runSwitchWorkspace(win, entry.workspaceId, run);
            return;
        case "deleteworkspace":
            await runDeleteWorkspace(win, entry.workspaceId, run);
            return;
        case "resetworkspace": {
            // the old tabs' views close once the new tab is on screen (#222)
            const resetWs = await WorkspaceService.GetWorkspace(win.workspaceId);
            tabId = await WorkspaceService.ResetWorkspace(win.workspaceId);
            tabViewsToClose = resetWs?.tabids ?? [];
            break;
        }
    }
    if (tabId == null) {
        return;
    }
    const startupPending = win.activeTabView == null ? await beginStartupPending(win, tabId) : null;
    const showWhenReady =
        startupPending == null &&
        isTabViewHostEnabled() &&
        !hasTabView(tabId, win.waveWindowId) &&
        windowShowsLiveView(win);
    // The workspace's name (for the pending state) is read while the view is acquired, so the tab never waits on it.
    const pendingName = showWhenReady ? workspaceName(win) : null;
    const acquiring = getOrCreateWebViewForTab(win.waveWindowId, tabId, run.deadline);
    let tabPending: number = null;
    if (showWhenReady) {
        // a failed acquisition is handled below, once the name is in
        acquiring.catch((): void => null);
        tabPending = beginTabPending(win, tabId, await pendingName, startedAt);
    }
    try {
        const [tabView, tabInitialized] = await acquiring;
        noteTabViewWorkspace(tabView, win.workspaceId);
        const primaryStartupTabFlag = entry.op === "switchtab" ? (entry.primaryStartupTab ?? false) : false;
        const waitReady = showWhenReady && !tabInitialized;
        await showTabViewInWindow(win, tabView, tabInitialized, primaryStartupTabFlag, waitReady, run);
    } catch (e) {
        if (startupPending != null && e instanceof ReadinessError) {
            windowViewPending(win).setPhase(startupPending, "failed");
        }
        if (tabPending != null) {
            // the tab shown still exists after a new tab or a tab switch; a closed or reset one does not
            if (entry.op === "createtab" || entry.op === "switchtab") {
                await rollBackActiveTab(win, tabId);
            }
            if (e instanceof ReadinessError) {
                windowViewPending(win).setPhase(tabPending, "failed");
            } else {
                windowViewPending(win).end(tabPending);
            }
        }
        if (entry.op === "closetab" || entry.op === "resetworkspace") {
            sweepDeletedTabViews(entry.op === "closetab" ? "tab closed" : "workspace reset");
        }
        throw e;
    }
    if (startupPending != null) {
        windowViewPending(win).end(startupPending);
    }
    if (tabPending != null) {
        windowViewPending(win).end(tabPending);
    }
    for (const closeId of tabViewsToClose) {
        win.removeTabView(closeId, false);
    }
    // the closed tab's view, wherever it is cached, once its successor is on screen (#448)
    if (entry.op === "closetab") {
        sweepDeletedTabViews("tab closed");
    }
}

// The new view is shown only once it has rendered, and workspaceId follows the screen: it changes only once that view
// is on screen. A switch that fails takes the backend back to the workspace on screen; a superseded one leaves the
// backend to the action that superseded it (#68, #449).
async function runSwitchWorkspace(win: WaveBrowserWindow, workspaceId: string, run: ActionRun) {
    const startedAt = Date.now();
    // read before the switch, which deletes an unsaved workspace (#68)
    const leftIds = [win.workspaceId, backendWorkspaceOf(win)].filter(
        (id, idx, all) => id != null && id != workspaceId && all.indexOf(id) == idx
    );
    const leftWss = await Promise.all(
        leftIds.map((id) => WorkspaceService.GetWorkspace(id).catch((): Workspace => null))
    );
    run.check();
    let newWs = await WindowService.SwitchWorkspace(win.waveWindowId, workspaceId);
    if (newWs != null) {
        setBackendWorkspace(win, workspaceId);
    } else if (backendWorkspaceOf(win) == workspaceId && win.workspaceId != workspaceId) {
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
        win.workspaceId = workspaceId;
        return;
    }
    releaseTabViewFromOtherWindow(tabId, win.waveWindowId, getWaveWindowById);
    // the window on the workspace left shows the pending state of this one (#450)
    const pendingToken = beginWindowPending(
        win,
        newWs.name,
        () => fireAndForget(() => win.switchWorkspace(workspaceId)),
        startedAt
    );
    try {
        const [tabView, tabInitialized] = await acquireWindowTabView(win, tabId, run);
        noteTabViewWorkspace(tabView, workspaceId);
        await showTabViewInWindow(win, tabView, tabInitialized, false, true, run);
    } catch (e) {
        if (!isSuperseded(e)) {
            await rollBackBackendWorkspace(win, workspaceId);
            if (e instanceof ReadinessError) {
                windowViewPending(win).setPhase(pendingToken, "failed");
            } else {
                windowViewPending(win).end(pendingToken);
            }
        }
        throw e;
    }
    windowViewPending(win).end(pendingToken);
    // the views of the workspace left are kept (off-screen, in the tab cache) instead of destroyed, so switching back
    // is as instant as switching tabs (#68)
    win.workspaceId = workspaceId;
    for (const closeId of leftWss.flatMap((ws) => tabViewsToCloseOnLeave(ws))) {
        win.removeTabView(closeId, false);
    }
    // a workspace left that no longer exists (deleted while on screen) leaves views of deleted tabs that
    // tabViewsToCloseOnLeave cannot name (#448)
    if (leftWss.some((ws) => ws == null)) {
        sweepDeletedTabViews("left a deleted workspace");
    }
}

async function rollBackBackendWorkspace(win: WaveBrowserWindow, failedWorkspaceId: string) {
    if (win.workspaceId == failedWorkspaceId || backendWorkspaceOf(win) != failedWorkspaceId) {
        return;
    }
    try {
        const ws = await WindowService.SwitchWorkspace(win.waveWindowId, win.workspaceId);
        if (ws != null) {
            setBackendWorkspace(win, win.workspaceId);
        }
        console.log("[#449] switch failed, backend back on", win.workspaceId, win.waveWindowId);
    } catch (e) {
        console.log("[#449] switch failed, could not take the backend back to", win.workspaceId, e);
    }
}

// The delete runs in the queue, after any switch to the workspace has stopped and dropped its view, so no renderer
// initializes a tab being deleted. When the window was only switching to it, it stays on the workspace it shows (#449).
// Then the views of its tabs are destroyed in every window, once this window shows another workspace (the view on
// screen is never destroyed) (#448).
async function runDeleteWorkspace(win: WaveBrowserWindow, workspaceId: string, run: ActionRun) {
    try {
        await applyDeleteWorkspace(win, workspaceId, run);
    } finally {
        sweepDeletedTabViews("workspace deleted");
    }
}

async function applyDeleteWorkspace(win: WaveBrowserWindow, workspaceId: string, run: ActionRun) {
    const onThisWindow = win.workspaceId == workspaceId || backendWorkspaceOf(win) == workspaceId;
    const newWorkspaceId = await WorkspaceService.DeleteWorkspace(workspaceId);
    console.log("delete-workspace done", workspaceId, win.waveWindowId);
    if (!onThisWindow) {
        return;
    }
    if (backendWorkspaceOf(win) == workspaceId) {
        setBackendWorkspace(win, null);
    }
    if (!newWorkspaceId) {
        console.log("delete-workspace closing window", workspaceId, win.waveWindowId);
        win.destroy();
        return;
    }
    if (run.isSuperseded()) {
        return;
    }
    const stay = win.workspaceId != workspaceId && (await WorkspaceService.GetWorkspace(win.workspaceId)) != null;
    run.check();
    await runSwitchWorkspace(win, stay ? win.workspaceId : newWorkspaceId, run);
}
