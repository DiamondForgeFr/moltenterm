// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Agents in the browser panel (FR-BRW-008, DS-BRW-011): which tabs of this panel an agent controls, as wavesrv's
// sessions publish it (pkg/molten/browseragent), and what the control bar shows. Stop, takeover and Give back go to
// wavesrv, which cancels the agent's call in flight; the bar changes at once, without waiting for the answer. The site
// permission bar (FR-BRW-009, DS-BRW-013) asks before an agent uses a site; its answer goes to wavesrv the same way.

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
export const BrowserAgentAnswerCommand = "moltenbrowseragentanswer";
export const BrowserAgentSiteCommand = "moltenbrowseragentsite";

// must match TabStateActive, TabStateTakenOver and the Control* actions in pkg/molten/browseragent/env.go
export const AgentStateActive = "active";
export const AgentStateTakenOver = "takenover";
export type AgentControlAction = "stop" | "takeover" | "giveback";
// must match the Decision* constants in pkg/molten/browseragent/env.go
export type PermissionDecision = "once" | "always" | "block" | "dismiss";
// must match SiteAllow and SiteBlock in pkg/molten/browseragent/sites.go
export type AgentSiteDecision = "allow" | "block";

const ControlTimeoutMs = 5000;
const SnapshotTimeoutMs = 5000;
// A cue shows where the agent just acted, then fades out.
export const ActionCueMs = 1500;

// A site permission request waiting on a tab (must match PermissionPrompt in pkg/molten/browseragent/env.go).
export type AgentPermission = { requestid: string; site: string };

// Where an action happens, in the page's CSS pixels (FR-BRW-010's input tools fill it).
export type AgentActionCue = { kind: string; x?: number; y?: number; width?: number; height?: number };

// must match PanelAgentTab in pkg/molten/browseragent/env.go
export type AgentTab = {
    browsertabid: string;
    agentname: string;
    origin: string;
    state: string;
    action?: string;
    actionts?: number;
    cue?: AgentActionCue;
    permission?: AgentPermission;
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

export type PermissionBarButton = { label: string; decision: PermissionDecision; primary: boolean };

export type PermissionBarView = {
    requestId: string;
    site: string;
    title: string;
    detail: string;
    buttons: PermissionBarButton[];
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

// The permission bar of a tab whose agent waits for the user's decision on a site, or null (DS-BRW-013). Allow once is
// first so it is the first tab stop; Always for this site is the primary action.
export function permissionBarView(tab: AgentTab): PermissionBarView {
    if (tab?.permission?.requestid == null || !tab.permission.site || tab.state !== AgentStateActive) {
        return null;
    }
    const site = tab.permission.site;
    return {
        requestId: tab.permission.requestid,
        site,
        title: `Let ${agentName(tab)} use ${site}?`,
        detail: "It can read and act on this site's pages, with your sign-ins.",
        buttons: [
            { label: "Allow once", decision: "once", primary: false },
            { label: "Always for this site", decision: "always", primary: true },
            { label: "Block", decision: "block", primary: false },
        ],
    };
}

// The bar after the user answers, before wavesrv's event confirms it.
export function applyAnswer(tabs: AgentTabs, browserTabId: string, requestId: string): AgentTabs {
    const tab = tabs?.[browserTabId];
    if (tab?.permission?.requestid !== requestId) {
        return tabs;
    }
    const { permission: _answered, ...rest } = tab;
    return { ...tabs, [browserTabId]: rest };
}

function hostOf(url: string): { host: string; hostname: string } {
    try {
        const u = new URL(url);
        if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) {
            return null;
        }
        return { host: u.host.toLowerCase(), hostname: u.hostname.toLowerCase().replace(/\.$/, "") };
    } catch {
        return null;
    }
}

// The stored agent decision that applies to a page, and the entry it comes from: the host with its port, the host,
// then each parent domain; Block wins. Must match storedDecision in pkg/molten/browseragent/sites.go.
export function agentSiteDecision(
    sites: Record<string, string>,
    url: string
): { site: string; decision: AgentSiteDecision } {
    const parsed = hostOf(url);
    if (parsed == null || sites == null) {
        return null;
    }
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(sites)) {
        if (typeof v === "string") {
            lower[k.trim().toLowerCase()] = v.trim().toLowerCase();
        }
    }
    const candidates: string[] = [];
    if (parsed.host !== parsed.hostname) {
        candidates.push(parsed.host);
    }
    candidates.push(parsed.hostname);
    // localhost, IP addresses and single-label hosts are sites of their own; other hosts walk up their parent domains,
    // never to a bare top-level domain (wavesrv stops at the registrable domain).
    const ownSite =
        parsed.hostname === "localhost" ||
        parsed.hostname.endsWith(".localhost") ||
        /^[0-9.]+$/.test(parsed.hostname) ||
        parsed.hostname.startsWith("[") ||
        !parsed.hostname.includes(".");
    for (let host = parsed.hostname; !ownSite; ) {
        const dot = host.indexOf(".");
        host = host.slice(dot + 1);
        if (!host.includes(".")) {
            break;
        }
        candidates.push(host);
    }
    let allowed: string = null;
    for (const candidate of candidates) {
        if (lower[candidate] === "block") {
            return { site: candidate, decision: "block" };
        }
        if (lower[candidate] === "allow" && allowed == null) {
            allowed = candidate;
        }
    }
    return allowed == null ? null : { site: allowed, decision: "allow" };
}

// Forget (or set) the agents' decision for a site, from the panel's site menu.
export async function setAgentSite(site: string, decision: AgentSiteDecision | ""): Promise<void> {
    await TabRpcClient.wshRpcCall(
        BrowserAgentSiteCommand,
        { site, decision },
        { route: BrowserAgentRouteId, timeout: ControlTimeoutMs }
    );
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
    // A snapshot must not overwrite an event or a user action that arrived while it was in flight.
    stateVersion = 0;

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
                handler: (event) => {
                    this.apply(event.data as PanelAgentState);
                },
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("browser agents: no event bus", e);
            return;
        }
        fireAndForget(() => this.loadSnapshot(false));
    }

    // force: after a failed Stop or Give back, the bar shows wavesrv's state again, not what the click assumed.
    async loadSnapshot(force: boolean): Promise<void> {
        const version = this.stateVersion;
        try {
            const state: PanelAgentState = await TabRpcClient.wshRpcCall(
                BrowserAgentStateCommand,
                { blockid: this.blockId },
                { route: BrowserAgentRouteId, timeout: SnapshotTimeoutMs }
            );
            if (this.stateVersion === version && (force || version === 0)) {
                this.apply(state);
            }
        } catch {
            // wavesrv still starting: the events bring the state.
        }
    }

    apply(state: PanelAgentState): void {
        if (state?.blockid !== this.blockId) {
            return;
        }
        this.stateVersion++;
        globalStore.set(this.tabsAtom, readPanelAgentState(state));
    }

    control(browserTabId: string, action: AgentControlAction): void {
        this.stateVersion++;
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
                await this.loadSnapshot(true);
            }
        });
    }

    answer(browserTabId: string, requestId: string, decision: PermissionDecision): void {
        this.stateVersion++;
        globalStore.set(this.tabsAtom, applyAnswer(this.tabs(), browserTabId, requestId));
        fireAndForget(async () => {
            try {
                await TabRpcClient.wshRpcCall(
                    BrowserAgentAnswerCommand,
                    { blockid: this.blockId, browsertabid: browserTabId, requestid: requestId, decision },
                    { route: BrowserAgentRouteId, timeout: ControlTimeoutMs }
                );
            } catch (e) {
                console.log("browser agents: answer failed", decision, e);
                await this.loadSnapshot(true);
            }
        });
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}
