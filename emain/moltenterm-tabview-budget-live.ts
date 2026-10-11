// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Electron side of the tab view budget (#454, emain/moltenterm-tabview-budget.ts): its settings, the agent states
// that pin a view, the renderers' memory, and the destruction of a view through its window.
//
// Pins (FR-PERF-008 AC4): a hidden view whose workspace has a working coding agent stays, so coming back to it is
// instant. Electron main follows wavesrv's agent states the way the windows do (frontend/moltenterm-shell/
// agent-state-store.ts): the molten:agentstate events, after a snapshot from the molten:agents route. A view hosting a
// browser tab an agent drives stays too (#301).

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import { app } from "electron";
import {
    AgentStateEvent,
    AgentStateInfo,
    AgentStatesCommand,
    AgentStatesData,
    AgentStatesRoute,
    applyAgentStates,
    EmptyAgentStates,
} from "../frontend/moltenterm-shell/agent-state-model";
import type { WaveTabView } from "./emain-tabview";
import { ElectronWshClient } from "./emain-wsh";
import { hostsBrowserPage, hostsControlledTab } from "./moltenterm-browseragent";
import {
    enforceTabViewBudget,
    makeSerialBudgetRunner,
    noteTabViewBudgetSettings,
    TabViewBudgetDeps,
    tabViewWorkspace,
} from "./moltenterm-tabview-budget";
import { getCachedTabViews, isHotSpareTab, noteTabViewHostSettings } from "./moltenterm-tabview-host";
import {
    hostedPagesHaveUnsavedWork,
    initMoltentermWebviewLifecycle,
    noteWebviewLifecycleSettings,
} from "./moltenterm-webview-lifecycle";

const SnapshotTimeoutMs = 5000;
const UnsavedWorkProbeTimeoutMs = 1500;
const PagesProbeTimeoutMs = 3000;
// must match UnsavedWorkProbeName in frontend/moltenterm-shell/unsaved-work.ts; a renderer without the probe (still
// loading) answers false only when it has no blocks to hold anything
const UnsavedWorkProbeScript = `typeof globalThis.moltentermHasUnsavedWork === "function" ? globalThis.moltentermHasUnsavedWork() : false`;
const SnapshotRetryMs = 2000;
const SnapshotMaxTries = 10;

let agentStates: AgentStatesData = EmptyAgentStates;
let started = false;

export function applyAgentPinStates(infos: AgentStateInfo[]) {
    agentStates = applyAgentStates(agentStates, infos);
}

export function hasWorkingAgent(tabId: string, workspaceId: string): boolean {
    for (const info of Object.values(agentStates.states)) {
        if (info.state !== "working") {
            continue;
        }
        if ((tabId != null && info.tabid === tabId) || (workspaceId != null && info.workspaceid === workspaceId)) {
            return true;
        }
    }
    return false;
}

function loadAgentSnapshot(tries: number) {
    fireAndForget(async () => {
        try {
            const snapshot = (await ElectronWshClient.wshRpcCall(
                AgentStatesCommand,
                {},
                { route: AgentStatesRoute, timeout: SnapshotTimeoutMs }
            )) as AgentStateInfo[];
            applyAgentPinStates(snapshot ?? []);
        } catch (e) {
            if (tries > 0) {
                setTimeout(() => loadAgentSnapshot(tries - 1), SnapshotRetryMs);
                return;
            }
            console.log("[#454] agent states snapshot failed", e);
        }
    });
}

// Subscribes first, so nothing published while the snapshot travels is lost (versions order the two).
export function initMoltentermTabViewBudget(fullConfig: FullConfigType) {
    noteTabViewBudgetSettings(fullConfig?.settings as Record<string, unknown>);
    // The tab view host's flag (#461) follows the same settings events.
    noteTabViewHostSettings(fullConfig?.settings as Record<string, unknown>);
    // The browser pages' lifecycle (#459) follows the same settings events.
    initMoltentermWebviewLifecycle(fullConfig?.settings as Record<string, unknown>);
    if (started) {
        return;
    }
    started = true;
    waveEventSubscribeSingle({
        eventType: "config",
        handler: (event) => {
            const settings = (event?.data as { fullconfig?: FullConfigType })?.fullconfig?.settings;
            if (settings != null) {
                noteTabViewBudgetSettings(settings as Record<string, unknown>);
                noteTabViewHostSettings(settings as Record<string, unknown>);
                noteWebviewLifecycleSettings(settings as Record<string, unknown>);
            }
        },
    });
    waveEventSubscribeSingle({
        eventType: AgentStateEvent as WaveEventName,
        handler: (event) => applyAgentPinStates([event.data as AgentStateInfo]),
    });
    loadAgentSnapshot(SnapshotMaxTries);
}

type BudgetWindow = {
    allLoadedTabViews: Map<string, WaveTabView>;
    removeTabView(tabId: string, force: boolean): void;
};

function liveContentsId(view: WaveTabView): number {
    return view.webContents.isDestroyed() ? null : view.webContents.id;
}

function rendererMemoryMb(views: WaveTabView[]): Map<WaveTabView, number> {
    const byPid = new Map<number, number>();
    for (const metric of app.getAppMetrics()) {
        byPid.set(metric.pid, (metric.memory?.workingSetSize ?? 0) / 1024);
    }
    const out = new Map<WaveTabView, number>();
    for (const view of views) {
        if (view.webContents.isDestroyed()) {
            continue;
        }
        out.set(view, byPid.get(view.webContents.getOSProcessId()) ?? 0);
    }
    return out;
}

// Returns the function a window calls once an action has run: destroys the hidden views past the budget, in every
// window, through the window's removeTabView (the one removal path, which logs "destroy tab").
export function makeHiddenTabViewBudget(windows: () => BudgetWindow[]): () => void {
    const deps = makeBudgetDeps(windows);
    const run = makeSerialBudgetRunner(async () => {
        try {
            return await enforceTabViewBudget<WaveTabView>(deps);
        } catch (e) {
            console.log("[#454] tab view budget check failed", e);
            return 0;
        }
    });
    return () => {
        fireAndForget(run);
    };
}

function withDeadline(answer: Promise<boolean>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> = null;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
    });
    return Promise.race([answer.catch(() => true), timeout]).finally(() => clearTimeout(timer));
}

// Asks the view's renderer (frontend/moltenterm-shell/unsaved-work.ts), then its browser pages (#459: a beforeunload
// listener or text typed in a form, emain/moltenterm-webview-lifecycle.ts). No answer in time keeps the view: losing
// an edit is worse than a view kept a little longer. A crashed renderer holds nothing.
async function viewHasUnsavedWork(view: WaveTabView): Promise<boolean> {
    const wc = view.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) {
        return false;
    }
    const answer = wc.executeJavaScript(UnsavedWorkProbeScript).then((v) => v !== false);
    if (await withDeadline(answer, UnsavedWorkProbeTimeoutMs)) {
        return true;
    }
    return withDeadline(hostedPagesHaveUnsavedWork(wc.id), PagesProbeTimeoutMs);
}

function makeBudgetDeps(windows: () => BudgetWindow[]): TabViewBudgetDeps<WaveTabView> {
    return {
        tabViews: () => {
            const views = new Set<WaveTabView>(getCachedTabViews());
            for (const win of windows()) {
                for (const view of win.allLoadedTabViews.values()) {
                    views.add(view);
                }
            }
            return Array.from(views);
        },
        isHotSpare: (view) => isHotSpareTab(view),
        isPinned: (view) => {
            const wcId = liveContentsId(view);
            return (
                (wcId != null && hostsControlledTab(wcId)) || hasWorkingAgent(view.waveTabId, tabViewWorkspace(view))
            );
        },
        keepsPage: (view) => {
            const wcId = liveContentsId(view);
            return wcId != null && hostsBrowserPage(wcId);
        },
        hasUnsavedWork: viewHasUnsavedWork,
        memoryMb: rendererMemoryMb,
        evict: (view) => {
            for (const win of windows()) {
                if (win.allLoadedTabViews.get(view.waveTabId) === view) {
                    win.removeTabView(view.waveTabId, false);
                }
            }
            if (!view.isDestroyed && !view.isActiveTab) {
                view.destroy();
            }
        },
        log: (msg, ...args) => console.log(msg, ...args),
        now: () => Date.now(),
    };
}

export function resetAgentPinsForTests() {
    agentStates = EmptyAgentStates;
}
