// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Share with agent (FR-BRW-011, DS-BRW-017): a tab the user opened can be given to one of the agents running in the
// panes of the browser panel's own tab (#594). The agents are the tab's agent states (the companion's and the command
// panel's source), joined with the agents connected to MoltenTerm's browser server (wavesrv's sessions). Sharing,
// moving and the Share and tell line all happen in wavesrv (pkg/molten/browseragent/share.go); these rules only build
// the menu.

import { agentCallName, agentLabel, type AgentStateInfo } from "../agent-state-model";
import { t } from "../i18n/i18n";
import { agentName, AgentSession, AgentTab, OriginShared } from "./browser-agent";
import type { BrowserTab } from "./browser-model";

export type ShareSession = AgentSession;

// One agent of the workspace the tab can be shared with.
export type ShareAgent = {
    blockId: string;
    // agentName: how a sentence names the agent, its first name when it has one (FR-CONT-014); label: how the menu lists
    // it ("Jérôme · Claude Code").
    agentName: string;
    label?: string;
    // agentKind: the agent itself ("Claude Code"), for what concerns the agent rather than the session.
    agentKind?: string;
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

export function noAgentReason(): string {
    return t("browser.share.noAgent");
}
export function shareLabel(): string {
    return t("browser.share.share");
}
export function shareTellLabel(): string {
    return t("browser.share.shareTell");
}

export function setupReason(agent: string): string {
    return t("browser.share.setup", { agent });
}

export function isSharedTab(tab: AgentTab): boolean {
    return tab?.origin === OriginShared;
}

// Only the agents beside the browser panel, in the panes of its tab, are offered the page (#594): an agent of another
// tab is out of sight. Used for the agent states and the browser sessions alike; wavesrv refuses the rest anyway.
export function ofTab<T extends { blockid?: string }>(items: T[], tabBlockIds: string[]): T[] {
    const inTab = new Set(tabBlockIds ?? []);
    return (items ?? []).filter((item) => item?.blockid != null && inTab.has(item.blockid));
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
            agentName: agentCallName(info),
            label: agentLabel(info),
            agentKind: info.agentname || info.agent,
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
            agentName: s.agentname || t("browser.agent.anAgent"),
            paneTitle: paneTitle(s.blockid),
            sessionId: s.sessionid,
        });
    }
    return rtn.sort(
        (a, b) =>
            (a.label || a.agentName).localeCompare(b.label || b.agentName) ||
            a.paneTitle.localeCompare(b.paneTitle) ||
            a.blockId.localeCompare(b.blockId)
    );
}

export function agentEntryLabel(agent: ShareAgent): string {
    const label = agent.label || agent.agentName;
    return agent.paneTitle ? `${label} — ${agent.paneTitle}` : label;
}

// Why a tab cannot be shared at all, or "" when it can (AC8): a page handed off to an installed browser (or bridged
// from it) is not in MoltenTerm's engine, where the agents act.
export function unshareableReason(tab: BrowserTab, engineLabel: string): string {
    if (tab == null) {
        return t("browser.share.tabGone");
    }
    if (tab.engine) {
        return t("browser.share.openElsewhere", { browser: engineLabel || t("browser.share.anotherBrowser") });
    }
    return "";
}

// Share and tell types into the agent's prompt: only while it waits for the user's next message, never while it works
// or waits for an answer to its own question (AC6).
export function tellReason(agent: ShareAgent): string {
    if (!agent.sessionId) {
        return setupReason(agent.agentKind || agent.agentName);
    }
    if (agent.state === "working") {
        return t("browser.share.working", { name: agent.agentName });
    }
    if (agent.state === "waiting") {
        return t("browser.share.waiting", { name: agent.agentName });
    }
    if (agent.state === "error") {
        return t("browser.share.error", { name: agent.agentName });
    }
    return "";
}

// The reason the whole control is unavailable, "" when it opens its list (AC2, AC8).
export function shareControlReason(tab: BrowserTab, engineLabel: string, agents: ShareAgent[]): string {
    return unshareableReason(tab, engineLabel) || ((agents ?? []).length === 0 ? noAgentReason() : "");
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
            label: t("browser.share.stop", { name: agentName(holder) }),
            icon: "link-slash",
            click: () => actions.stopSharing(),
        });
    }
    const reason = shareControlReason(tab, engineLabel, agents);
    if (reason) {
        menu.push({ label: shareLabel(), icon: "share-nodes", enabled: false, sublabel: reason });
        return menu;
    }
    const holderName = holder != null ? agentName(holder) : null;
    const shareEntries: ContextMenuItem[] = agents.map((agent) => {
        if (!agent.sessionId) {
            return {
                label: agentEntryLabel(agent),
                enabled: false,
                sublabel: setupReason(agent.agentKind || agent.agentName),
            };
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
            { label: t("browser.share.integrationSettings"), icon: "gear", click: () => actions.openAgentSettings() },
        ];
        shareEntries.push(...settings);
        tellEntries.push(...settings);
    }
    menu.push(
        {
            label: holderName ? t("browser.share.shareNow", { name: holderName }) : shareLabel(),
            icon: "share-nodes",
            type: "submenu",
            submenu: shareEntries,
        },
        {
            label: shareTellLabel(),
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
        title: t("browser.share.moveTitle", { target }),
        message: t("browser.share.moveMessage", { holder }),
    };
}
