// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Share with agent (FR-BRW-011, DS-BRW-017): a tab the user opened can be given to one of the agents running in the
// workspace's panes. The agents are the workspace's agent states (the companion's and the command panel's source),
// joined with the agents connected to MoltenTerm's browser server (wavesrv's sessions). Sharing, moving and the Share
// and tell line all happen in wavesrv (pkg/molten/browseragent/share.go); these rules only build the menu.

import type { AgentStateInfo } from "../agent-state-model";
import { agentName, AgentSession, AgentTab, OriginShared } from "./browser-agent";
import type { BrowserTab } from "./browser-model";

export type ShareSession = AgentSession;

// One agent of the workspace the tab can be shared with.
export type ShareAgent = {
    blockId: string;
    agentName: string;
    paneTitle: string;
    // The agent's browser session; absent when it has not connected MoltenTerm's browser server.
    sessionId?: string;
    state?: string;
};

export type ShareActions = {
    share: (agent: ShareAgent, tell: boolean) => void;
    stopSharing: () => void;
    openAgentSettings: () => void;
};

export const NoAgentReason = "No agent is running in this workspace";
export const ShareLabel = "Share with agent";
export const ShareTellLabel = "Share and tell";

export function setupReason(agent: string): string {
    return `Set up the MoltenTerm browser for ${agent}`;
}

export function isSharedTab(tab: AgentTab): boolean {
    return tab?.origin === OriginShared;
}

// The agents of the workspace: one per pane running an agent, then the connected panes MoltenTerm detected no agent
// in (an MCP client of its own), by name and pane.
export function shareAgents(
    states: AgentStateInfo[],
    sessions: ShareSession[],
    paneTitle: (blockId: string) => string
): ShareAgent[] {
    const byBlock = new Map<string, ShareSession>();
    for (const s of sessions ?? []) {
        if (s?.blockid && s.sessionid) {
            byBlock.set(s.blockid, s);
        }
    }
    const rtn: ShareAgent[] = [];
    const seen = new Set<string>();
    for (const info of states ?? []) {
        if (info?.blockid == null || seen.has(info.blockid) || !(info.agent || info.agentname)) {
            continue;
        }
        seen.add(info.blockid);
        rtn.push({
            blockId: info.blockid,
            agentName: info.agentname || info.agent,
            paneTitle: paneTitle(info.blockid),
            sessionId: byBlock.get(info.blockid)?.sessionid,
            state: info.state,
        });
    }
    for (const s of byBlock.values()) {
        if (seen.has(s.blockid)) {
            continue;
        }
        rtn.push({
            blockId: s.blockid,
            agentName: s.agentname || "An agent",
            paneTitle: paneTitle(s.blockid),
            sessionId: s.sessionid,
        });
    }
    return rtn.sort(
        (a, b) =>
            a.agentName.localeCompare(b.agentName) ||
            a.paneTitle.localeCompare(b.paneTitle) ||
            a.blockId.localeCompare(b.blockId)
    );
}

export function agentEntryLabel(agent: ShareAgent): string {
    return agent.paneTitle ? `${agent.agentName} — ${agent.paneTitle}` : agent.agentName;
}

// Why a tab cannot be shared at all, or "" when it can (AC8): a page handed off to an installed browser (or bridged
// from it) is not in MoltenTerm's engine, where the agents act.
export function unshareableReason(tab: BrowserTab, engineLabel: string): string {
    if (tab == null) {
        return "This tab is no longer in the panel";
    }
    if (tab.engine) {
        return `This page is open in ${engineLabel || "another browser"}: open it in MoltenTerm to share it`;
    }
    return "";
}

// Share and tell types into the agent's prompt: only while it waits for the user's next message, never while it works
// or waits for an answer to its own question (AC6).
export function tellReason(agent: ShareAgent): string {
    if (!agent.sessionId) {
        return setupReason(agent.agentName);
    }
    if (agent.state === "working") {
        return `${agent.agentName} is working`;
    }
    if (agent.state === "waiting") {
        return `${agent.agentName} is waiting for your answer`;
    }
    if (agent.state === "error") {
        return `${agent.agentName} stopped on an error`;
    }
    return "";
}

// The reason the whole control is unavailable, "" when it opens its list (AC2, AC8).
export function shareControlReason(tab: BrowserTab, engineLabel: string, agents: ShareAgent[]): string {
    return unshareableReason(tab, engineLabel) || ((agents ?? []).length === 0 ? NoAgentReason : "");
}

// The tab menu's and the toolbar button's items: Stop sharing on a shared tab, then Share with agent and Share and
// tell, one entry per agent named by agent and pane (AC1). Unavailable entries stay, disabled with their reason (AC2).
export function shareMenuItems(
    tab: BrowserTab,
    holder: AgentTab,
    agents: ShareAgent[],
    engineLabel: string,
    actions: ShareActions
): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [];
    if (isSharedTab(holder)) {
        menu.push({
            label: `Stop sharing with ${agentName(holder)}`,
            icon: "link-slash",
            click: () => actions.stopSharing(),
        });
    }
    const reason = shareControlReason(tab, engineLabel, agents);
    if (reason) {
        menu.push({ label: ShareLabel, icon: "share-nodes", enabled: false, sublabel: reason });
        return menu;
    }
    const holderName = holder != null ? agentName(holder) : null;
    const shareEntries: ContextMenuItem[] = agents.map((agent) => {
        if (!agent.sessionId) {
            return { label: agentEntryLabel(agent), enabled: false, sublabel: setupReason(agent.agentName) };
        }
        return { label: agentEntryLabel(agent), click: () => actions.share(agent, false) };
    });
    const tellEntries: ContextMenuItem[] = agents.map((agent) => {
        const why = tellReason(agent);
        if (why) {
            return { label: agentEntryLabel(agent), enabled: false, sublabel: why };
        }
        return { label: agentEntryLabel(agent), click: () => actions.share(agent, true) };
    });
    if (agents.some((a) => !a.sessionId)) {
        const settings: ContextMenuItem[] = [
            { type: "separator" },
            { label: "Agent integration settings…", icon: "gear", click: () => actions.openAgentSettings() },
        ];
        shareEntries.push(...settings);
        tellEntries.push(...settings);
    }
    menu.push(
        {
            label: holderName ? `${ShareLabel} (now ${holderName})` : ShareLabel,
            icon: "share-nodes",
            type: "submenu",
            submenu: shareEntries,
        },
        {
            label: ShareTellLabel,
            icon: "comment",
            type: "submenu",
            submenu: tellEntries,
        }
    );
    return menu;
}

// The question before a tab moves from the agent that holds it (AC5).
export function moveQuestion(holder: string, target: string): { title: string; message: string } {
    return {
        title: `Move this tab to ${target}?`,
        message: `It is shared with ${holder}, which loses it at once.`,
    };
}
