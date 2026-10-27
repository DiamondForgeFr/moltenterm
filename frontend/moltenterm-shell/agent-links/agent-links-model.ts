// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The connections of a terminal's agents (FR-CONT-022, DS-CONT-031): what wavesrv's link registry
// (pkg/molten/agentlinks) and handoff route say, and what the header icon and its menu make of it. Provider-agnostic:
// agents are told apart by what MoltenTerm detected and by their MCP client's name; the per-agent steps (what to type
// to restart an MCP server) are adapters below, with a generic fallback for any other agent.

// must match pkg/molten/agentlinkwire/agentlinkwire.go
export const AgentLinksRouteId = "molten:agentlinks";
export const AgentLinksStateCommand = "moltenagentlinkstate";
export const AgentLinksControlCommand = "moltenagentlinkcontrol";
export const AgentLinksEvent = "molten:agentlinks";
// must match pkg/molten/handoffwire/handoffwire.go
export const HandoffRouteId = "molten:agenthandoff";
export const HandoffPairsCommand = "moltenagenthandoffpairs";
export const HandoffForgetCommand = "moltenagenthandoffforget";
export const HandoffHistoryCommand = "moltenagenthandoffhistory";
export const HandoffHistoryEvent = "molten:agenthandoffs";
export const HandoffNotificationKeyPrefix = "agenthandoff:";
export const AgentLinksGesture = "molten:agentlinks";

export const BrowserServer = "molten-browser";
export const ReviewServer = "molten-review";

export type LinkState = "connected" | "reconnecting" | "broken" | "stopped" | "legacy";
export type LinkAction = "reconnect" | "stop";

export type LinkInfo = {
    key: string;
    server: string;
    state: LinkState;
    since?: number;
    pid?: number;
    agentpid?: number;
    clientname?: string;
    clientversion?: string;
    version?: string;
    outdated?: boolean;
    updatepending?: boolean;
    updateblocked?: string;
    failed?: number;
    lasterror?: string;
    lasterrorat?: number;
    controllable?: boolean;
};

export type AgentLinkInfo = {
    main?: boolean;
    pid?: number;
    agent?: string;
    agentname?: string;
    firstname?: string;
    model?: string;
    clientname?: string;
    links: LinkInfo[];
};

export type BlockLinks = {
    blockid: string;
    version: string;
    agents: AgentLinkInfo[];
};

export type PairDecision = "" | "always" | "block";

export type PairEntry = {
    blockid: string;
    firstname: string;
    agent?: string;
    agentname?: string;
    project?: string;
    decision?: PairDecision;
};

export type PendingEntry = {
    requestid: string;
    fromblockid: string;
    toblockid: string;
    from: string;
    to: string;
    goal?: string;
};

export type PairsResult = { agents: PairEntry[]; pending: PendingEntry[] };

// must match HistoryEntry in pkg/molten/handoffwire/handoffwire.go: a handoff passed on since MoltenTerm started.
export type HandoffHistoryEntry = {
    fromblockid: string;
    toblockid: string;
    from?: string;
    to?: string;
    goal?: string;
    at: number;
};

export type HeaderBadge = "broken" | "waiting" | null;

// A link that needs the developer: its agent's MoltenTerm tools fail, or it runs a version it could not leave.
export function linkNeedsRepair(link: LinkInfo): boolean {
    if (link.state === "broken" || link.state === "reconnecting") {
        return true;
    }
    return link.state === "connected" && !!link.outdated && !!link.updateblocked;
}

export function blockHasLinks(links: BlockLinks): boolean {
    return (links?.agents ?? []).some((a) => (a.links ?? []).length > 0);
}

// The header icon's badge: a request waiting for the developer first (an agent is held on it), then a link to repair.
export function headerBadge(links: BlockLinks, waitingRequests: number): HeaderBadge {
    if (waitingRequests > 0) {
        return "waiting";
    }
    for (const agent of links?.agents ?? []) {
        if ((agent.links ?? []).some(linkNeedsRepair)) {
            return "broken";
        }
    }
    return null;
}

// The icon shows on a terminal holding an agent, or a MoltenTerm MCP link (an agent MoltenTerm did not detect).
export function showLinksIcon(hasAgent: boolean, links: BlockLinks): boolean {
    return hasAgent || blockHasLinks(links);
}

type NotificationLike = { key?: string; blockid?: string; resolved?: number; archived?: number };

// The handoff requests of a pane waiting in the notifications: the asking agent's pane is the notification's.
export function waitingHandoffs(entries: NotificationLike[], blockId: string): number {
    let rtn = 0;
    for (const e of entries ?? []) {
        if (!e.key?.startsWith(HandoffNotificationKeyPrefix) || e.blockid !== blockId) {
            continue;
        }
        if (e.resolved != null || e.archived != null) {
            continue;
        }
        rtn++;
    }
    return rtn;
}

// What restarts an MCP server when MoltenTerm cannot reach it: only the agent can. "typemcp": MoltenTerm may type
// the agent's own command (Claude Code's /mcp, its table row in pkg/molten/agentcontinuity/commands.go).
export type RepairHint = { key: string; vars?: Record<string, string>; typeMcp?: boolean };

export function repairHint(agent: string, main: boolean): RepairHint {
    switch (agent) {
        case "claude":
            return { key: "agentLinks.hint.claude", typeMcp: main };
        case "codex":
            return { key: "agentLinks.hint.codex" };
    }
    return { key: "agentLinks.hint.generic" };
}

// How to give an agent the molten-browser server it does not have.
export function addServerHint(agent: string): { key: string; command: string } {
    switch (agent) {
        case "claude":
            return { key: "agentLinks.add.claude", command: "claude mcp add molten-browser -- molten mcp browser" };
        case "codex":
            return { key: "agentLinks.add.codex", command: "codex mcp add molten-browser -- molten mcp browser" };
    }
    return { key: "agentLinks.add.generic", command: "molten mcp browser" };
}

// The links of one agent, with a "not started" molten-browser row when it has none.
export type LinkRow = { link: LinkInfo; notStarted?: boolean };

export function agentLinkRows(agent: AgentLinkInfo): LinkRow[] {
    const links = agent.links ?? [];
    const rows: LinkRow[] = links.map((link) => ({ link }));
    if (!links.some((l) => l.server === BrowserServer)) {
        rows.unshift({ link: { key: "notstarted", server: BrowserServer, state: null }, notStarted: true });
    }
    return rows;
}

// What a link's row offers: Reconnect and Stop when MoltenTerm reaches the server, Reconnect alone on a stopped one,
// the agent's own step otherwise.
export function linkActions(link: LinkInfo): LinkAction[] {
    if (link.state === "stopped") {
        return link.controllable ? ["reconnect"] : [];
    }
    if (link.state === "connected" && link.controllable) {
        return ["reconnect", "stop"];
    }
    return [];
}

export function needsAgentStep(row: LinkRow): boolean {
    if (row.notStarted) {
        return false;
    }
    const link = row.link;
    if (link.state === "broken" || link.state === "legacy") {
        return true;
    }
    if (link.state === "stopped" && !link.controllable) {
        return true;
    }
    return link.state === "connected" && !!link.outdated && !!link.updateblocked;
}

// The state's sentence key and its vars; since is shown relative to now by the caller.
export function linkStateKey(link: LinkInfo): string {
    return `agentLinks.state.${link.state}`;
}

export function versionNoteKey(link: LinkInfo): string {
    if (!link.outdated) {
        return null;
    }
    if (link.updatepending) {
        return "agentLinks.version.pending";
    }
    if (link.updateblocked) {
        return "agentLinks.version.blocked";
    }
    return "agentLinks.version.older";
}

// The agent's title: "Valentin · Claude Code · Opus", an undetected one by its MCP client's name.
export function agentTitle(agent: AgentLinkInfo): string {
    const parts: string[] = [];
    if (agent.firstname) {
        parts.push(agent.firstname);
    }
    const name = agent.agentname || agent.clientname;
    if (name) {
        parts.push(name);
    }
    if (agent.model) {
        parts.push(agent.model);
    }
    return parts.join(" · ");
}

export function agentCallName(agent: AgentLinkInfo): string {
    return agent.firstname || agent.agentname || agent.clientname || "";
}

export type SiteEntry = { site: string; decision: "allow" | "block" };

export function siteEntries(sites: Record<string, string>): SiteEntry[] {
    const rtn: SiteEntry[] = [];
    for (const [site, decision] of Object.entries(sites ?? {})) {
        if (decision === "allow" || decision === "block") {
            rtn.push({ site, decision });
        }
    }
    rtn.sort((a, b) => a.site.localeCompare(b.site));
    return rtn;
}

export type LinksPlace = { workspaceid?: string; tabid?: string; blockid: string };

// The #1029 notice's action carries where the agent is.
export function readLinksGestureArgs(args: Record<string, any>): LinksPlace {
    const blockid = typeof args?.blockid === "string" ? args.blockid : "";
    if (!blockid) {
        return null;
    }
    return {
        blockid,
        tabid: typeof args.tabid === "string" && args.tabid ? args.tabid : undefined,
        workspaceid: typeof args.workspaceid === "string" && args.workspaceid ? args.workspaceid : undefined,
    };
}

// An open request from a notification stays valid this long: the terminal's header may mount after the switch.
export const OpenRequestMs = 15000;

export function openRequestFor(request: { blockid: string; at: number }, blockId: string, now: number): boolean {
    return request != null && request.blockid === blockId && now - request.at <= OpenRequestMs;
}
