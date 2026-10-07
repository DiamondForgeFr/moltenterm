// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Agents in the browser panel (FR-BRW-008, DS-BRW-011): which tabs of this panel an agent controls, as wavesrv's
// sessions publish it (pkg/molten/browseragent), and what the control bar shows. Stop, takeover and Give back go to
// wavesrv, which cancels the agent's call in flight; the bar changes at once, without waiting for the answer.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";

// must match pkg/molten/mcpbrowser/wire.go
export const BrowserAgentRouteId = "molten:browseragent";
export const BrowserAgentControlCommand = "moltenbrowseragentcontrol";
export const BrowserAgentStateCommand = "moltenbrowseragentstate";
export const BrowserAgentStateEvent = "molten:browseragent";

// must match TabStateActive, TabStateTakenOver and the Control* actions in pkg/molten/browseragent/env.go
export const AgentStateActive = "active";
export const AgentStateTakenOver = "takenover";
export type AgentControlAction = "stop" | "takeover" | "giveback";

const ControlTimeoutMs = 5000;
const SnapshotTimeoutMs = 5000;
// A cue shows where the agent just acted, then fades out.
export const ActionCueMs = 1500;

// Where an action happens, in the page's CSS pixels (FR-BRW-010's input tools fill it).
export type AgentActionCue = { kind: string; x?: number; y?: number; width?: number; height?: number };

// must match PanelAgentTab in pkg/molten/browseragent/env.go
export type AgentTab = {
    browsertabid: string;
    sessionid: string;
    agentname: string;
    origin: string;
    state: string;
    action?: string;
    actionts?: number;
    cue?: AgentActionCue;
};

export type PanelAgentState = { blockid: string; tabs: AgentTab[] };

export type AgentTabs = Record<string, AgentTab>;

export type ControlBarButton = { label: string; action: AgentControlAction; primary: boolean };

export type ControlBarView = {
    takenOver: boolean;
    title: string;
    detail: string;
    buttons: ControlBarButton[];
};

export function readPanelAgentState(state: PanelAgentState): AgentTabs {
    const rtn: AgentTabs = {};
    for (const tab of state?.tabs ?? []) {
        if (tab?.browsertabid && (tab.state === AgentStateActive || tab.state === AgentStateTakenOver)) {
            rtn[tab.browsertabid] = tab;
        }
    }
    return rtn;
}

export function agentName(tab: AgentTab): string {
    return tab?.agentname?.trim() || "An agent";
}

// The bar of a controlled tab, or null when no agent controls it (DS-BRW-011).
export function controlBarView(tab: AgentTab): ControlBarView {
    if (tab == null) {
        return null;
    }
    const name = agentName(tab);
    if (tab.state === AgentStateTakenOver) {
        return {
            takenOver: true,
            title: "You took over",
            detail: `${name} waits until you give the tab back.`,
            buttons: [
                { label: "Give back", action: "giveback", primary: true },
                { label: "Stop", action: "stop", primary: false },
            ],
        };
    }
    if (tab.state !== AgentStateActive) {
        return null;
    }
    return {
        takenOver: false,
        title: `${name} is controlling this tab`,
        detail: tab.action ?? "",
        buttons: [{ label: "Stop", action: "stop", primary: false }],
    };
}

// What the bar shows right after a click, before wavesrv's event confirms it.
export function applyControl(tabs: AgentTabs, browserTabId: string, action: AgentControlAction): AgentTabs {
    const tab = tabs?.[browserTabId];
    if (tab == null) {
        return tabs;
    }
    if (action === "stop") {
        const { [browserTabId]: _gone, ...rest } = tabs;
        return rest;
    }
    const state = action === "giveback" ? AgentStateActive : AgentStateTakenOver;
    return tab.state === state ? tabs : { ...tabs, [browserTabId]: { ...tab, state } };
}

// The cue to draw now, or null once it is old.
export function activeCue(tab: AgentTab, now: number): AgentActionCue {
    if (tab?.cue == null || tab.state !== AgentStateActive || tab.actionts == null) {
        return null;
    }
    return now - tab.actionts <= ActionCueMs ? tab.cue : null;
}

// The agent state of one browser panel: a snapshot at mount, then the panel's events.
export class BrowserAgentModel {
    blockId: string;
    tabsAtom = atom({}) as PrimitiveAtom<AgentTabs>;
    unsubscribe: () => void = null;

    constructor(blockId: string) {
        this.blockId = blockId;
    }

    tabs(): AgentTabs {
        return globalStore.get(this.tabsAtom);
    }

    start(): void {
        if (this.unsubscribe != null) {
            return;
        }
        try {
            this.unsubscribe = waveEventSubscribeSingle({
                eventType: BrowserAgentStateEvent as WaveEventName,
                scope: `block:${this.blockId}`,
                handler: (event) => this.apply(event.data as PanelAgentState),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("browser agents: no event bus", e);
            return;
        }
        fireAndForget(async () => {
            try {
                const state: PanelAgentState = await TabRpcClient.wshRpcCall(
                    BrowserAgentStateCommand,
                    { blockid: this.blockId },
                    { route: BrowserAgentRouteId, timeout: SnapshotTimeoutMs }
                );
                this.apply(state);
            } catch {
                // wavesrv still starting: the events bring the state.
            }
        });
    }

    apply(state: PanelAgentState): void {
        if (state?.blockid !== this.blockId) {
            return;
        }
        globalStore.set(this.tabsAtom, readPanelAgentState(state));
    }

    control(browserTabId: string, action: AgentControlAction): void {
        globalStore.set(this.tabsAtom, applyControl(this.tabs(), browserTabId, action));
        fireAndForget(async () => {
            try {
                await TabRpcClient.wshRpcCall(
                    BrowserAgentControlCommand,
                    { blockid: this.blockId, browsertabid: browserTabId, action },
                    { route: BrowserAgentRouteId, timeout: ControlTimeoutMs }
                );
            } catch (e) {
                console.log("browser agents: control failed", action, e);
            }
        });
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}
