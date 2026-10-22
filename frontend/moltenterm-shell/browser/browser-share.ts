// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Share with agent (FR-BRW-011, DS-BRW-017): a tab the user opened can be given to one of the agents running in the
// panes of the browser panel's own tab (#594). The agents are the tab's agent states (the companion's and the command
// panel's source), joined with the agents connected to MoltenTerm's browser server (wavesrv's sessions). Sharing,
// moving and the Share and tell line all happen in wavesrv (pkg/molten/browseragent/share.go); these rules only build
// the menu.

import { runsByBlock, type AgentIntegrationRun } from "../agent-integration-runs";
import { agentCallName, agentLabel, type AgentStateInfo } from "../agent-state-model";
import { integrationSetting } from "../companion/companion-integration-model";
import { t } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { agentName, AgentSession, AgentTab, OriginShared } from "./browser-agent";
import type { BrowserTab } from "./browser-model";

export type ShareSession = AgentSession;

// Why an agent has no browser session (#947), each with its own words and fix: the integration is off now for every
// agent or for this one, the run got the browser and lost its connection (MoltenTerm restarted, the MCP server
// stopped), the run started without it (before the integration, or launched another way), the launcher left it out,
// or MoltenTerm cannot tell.
export type BrowserLink = "offall" | "offagent" | "lost" | "without" | "skipped" | "unknown";

// One agent of the workspace the tab can be shared with.
export type ShareAgent = {
    blockId: string;
    // agentName: how a sentence names the agent, its first name when it has one (FR-CONT-014); label: how the menu lists
    // it ("Jérôme · Claude Code").
    agentName: string;
    label?: string;
    // agentKind: the agent itself ("Claude Code"), for what concerns the agent rather than the session; agentId: its
    // id ("claude").
    agentKind?: string;
    agentId?: string;
    paneTitle: string;
    // The agent's browser session; absent when it is not connected to MoltenTerm's browser server.
    sessionId?: string;
    state?: string;
    // Without a session: why, and the launcher's reason when it left the browser out.
    link?: BrowserLink;
    linkReason?: string;
};

export type ShareActions = {
    share: (agent: ShareAgent, tell: boolean) => void;
    stopSharing: () => void;
    openAgentSettings: () => void;
};

// What the menu knows of the agents' launch: the running agents' integration and the settings now.
export type ShareIntegration = {
    runs?: AgentIntegrationRun[];
    settings?: Record<string, unknown>;
};

export function noAgentReason(): string {
    return t("browser.share.noAgent");
}
export function shareLabel(): string {
    return t("browser.share.share");
}

export function isSharedTab(tab: AgentTab): boolean {
    return tab?.origin === OriginShared;
}

// The tab's sharing state, always said in the menu and on the toolbar button (#947): shared with X, opened by X (an
// agent's own tab), or not shared.
export function shareStateText(holder: AgentTab): string {
    if (holder == null) {
        return t("browser.share.stateNone");
    }
    if (isSharedTab(holder)) {
        return t("browser.share.stateShared", { name: agentName(holder) });
    }
    return t("browser.share.stateOpened", { name: agentName(holder) });
}

// Only the agents beside the browser panel, in the panes of its tab, are offered the page (#594): an agent of another
// tab is out of sight. Used for the agent states and the browser sessions alike; wavesrv refuses the rest anyway.
export function ofTab<T extends { blockid?: string }>(items: T[], tabBlockIds: string[]): T[] {
    const inTab = new Set(tabBlockIds ?? []);
    return (items ?? []).filter((item) => item?.blockid != null && inTab.has(item.blockid));
}

// Why an agent without a session has none: the settings now come first (restarting would not help), then what its
// run got at launch.
export function browserLink(agentId: string, run: AgentIntegrationRun, settings: Record<string, unknown>): BrowserLink {
    if (agentId) {
        const setting = integrationSetting(settings, agentId);
        if (setting === "alloff") {
            return "offall";
        }
        if (setting === "agentoff") {
            return "offagent";
        }
    }
    switch (run?.browser) {
        case "added":
            return "lost";
        case "skipped":
            return "skipped";
        case "none":
            return "without";
    }
    return "unknown";
}

// The agents of the workspace: one per pane running an agent, then the connected panes MoltenTerm detected no agent
// in (an MCP client of its own), by name and pane.
export function shareAgents(
    states: AgentStateInfo[],
    sessions: ShareSession[],
    paneTitle: (blockId: string) => string,
    integration?: ShareIntegration
): ShareAgent[] {
    const byBlock = new Map<string, ShareSession>();
    for (const s of sessions ?? []) {
        if (s?.blockid && s.sessionid) {
            byBlock.set(s.blockid, s);
        }
    }
    const runs = runsByBlock(integration?.runs);
    const rtn: ShareAgent[] = [];
    const seen = new Set<string>();
    for (const info of states ?? []) {
        if (info?.blockid == null || seen.has(info.blockid) || !(info.agent || info.agentname)) {
            continue;
        }
        seen.add(info.blockid);
        const agent: ShareAgent = {
            blockId: info.blockid,
            agentName: agentCallName(info),
            label: agentLabel(info),
            agentKind: info.agentname || info.agent,
            agentId: info.agent,
            paneTitle: paneTitle(info.blockid),
            sessionId: byBlock.get(info.blockid)?.sessionid,
            state: info.state,
        };
        if (!agent.sessionId) {
            const run = runs.get(info.blockid);
            agent.link = browserLink(info.agent, run, integration?.settings);
            if (agent.link === "skipped") {
                agent.linkReason = serverText(run.browserreasontext, run.browserreason ?? "");
            }
        }
        rtn.push(agent);
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

// Why the agent cannot take the tab, in the user's terms and with its fix, or "" when it can (FR-BRW-011 AC2, #947).
export function unconnectedReason(agent: ShareAgent): string {
    if (agent.sessionId) {
        return "";
    }
    const name = agent.agentName;
    switch (agent.link) {
        case "offall":
            return t("browser.share.offAll", { name });
        case "offagent":
            return t("browser.share.offAgent", { agent: agent.agentKind || name, name });
        case "lost":
            return agent.agentId === "claude"
                ? t("browser.share.lostMcp", { name })
                : t("browser.share.lost", { name });
        case "without":
            return t("browser.share.startedWithout", { name });
        case "skipped":
            return agent.linkReason
                ? t("browser.share.skipped", { name, reason: agent.linkReason })
                : t("browser.share.startedWithout", { name });
    }
    return t("browser.share.notConnected", { name });
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
        return unconnectedReason(agent);
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

// One agent's entries: the share itself, then its "and tell" right under it (#947: one list, never two). An agent
// without a browser session is one disabled entry saying why and how to fix it.
function agentEntries(agent: ShareAgent, actions: ShareActions): ContextMenuItem[] {
    const label = agentEntryLabel(agent);
    const why = unconnectedReason(agent);
    if (why) {
        return [{ label, enabled: false, sublabel: why }];
    }
    const tell: ContextMenuItem = { label: t("browser.share.andTell", { name: agent.agentName }) };
    const tellWhy = tellReason(agent);
    if (tellWhy) {
        tell.enabled = false;
        tell.sublabel = tellWhy;
    } else {
        tell.click = () => actions.share(agent, true);
    }
    return [{ label, click: () => actions.share(agent, false) }, tell];
}

// The tab menu's and the toolbar button's items (AC1, #947): the tab's sharing state, Stop sharing on a shared tab,
// then one Share with… submenu listing each agent by name and pane with its "and tell" entry. Unavailable entries stay,
// disabled with their reason (AC2); the integration settings follow when the settings are the reason.
export function shareMenuItems(
    tab: BrowserTab,
    holder: AgentTab,
    agents: ShareAgent[],
    engineLabel: string,
    actions: ShareActions
): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [
        { label: shareStateText(holder), icon: isSharedTab(holder) ? "share-nodes" : undefined, enabled: false },
    ];
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
    const entries: ContextMenuItem[] = [];
    for (const agent of agents) {
        if (entries.length > 0) {
            entries.push({ type: "separator" });
        }
        entries.push(...agentEntries(agent, actions));
    }
    if (agents.some((a) => a.link === "offall" || a.link === "offagent")) {
        entries.push(
            { type: "separator" },
            { label: t("browser.share.integrationSettings"), icon: "gear", click: () => actions.openAgentSettings() }
        );
    }
    menu.push({ type: "submenu", label: shareLabel(), icon: "share-nodes", submenu: entries });
    return menu;
}

// The question before a tab moves from the agent that holds it (AC5).
export function moveQuestion(holder: string, target: string): { title: string; message: string } {
    return {
        title: t("browser.share.moveTitle", { target }),
        message: t("browser.share.moveMessage", { holder }),
    };
}
