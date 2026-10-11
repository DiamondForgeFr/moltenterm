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
import { getCachedTabViews, isHotSpareTab, WaveTabView } from "./emain-tabview";
import { ElectronWshClient } from "./emain-wsh";
import { hostsBrowserPage, hostsControlledTab } from "./moltenterm-browseragent";
import {
    enforceTabViewBudget,
    noteTabViewBudgetSettings,
    TabViewBudgetDeps,
    tabViewWorkspace,
} from "./moltenterm-tabview-budget";

const SnapshotTimeoutMs = 5000;
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
export function makeHiddenTabViewBudget(windows: () => BudgetWindow[]): () => number {
    const deps = makeBudgetDeps(windows);
    return () => {
        try {
            return enforceTabViewBudget<WaveTabView>(deps);
        } catch (e) {
            console.log("[#454] tab view budget check failed", e);
            return 0;
        }
    };
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
