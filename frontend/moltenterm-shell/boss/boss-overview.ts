// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the bubble tells (FR-BOSS-001, AC5, AC7): the agents that wait or failed in every workspace, who works where, a
// plan usage reading when one exists and the latest notification. Built from what every window already holds (the
// agent states, the durable sessions, the notifications, the usage readings the companions publish), so the badge and
// the peek change with those and nothing is polled. Pure, so the rules are tested without a window.

import { agentCallName, AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { GaugeLevel, GaugeRow, gaugeRows, UsageSnapshot } from "../companion/companion-gauges-model";
import { t, tCount } from "../i18n/i18n";
import { badgeCount } from "../notification-rules";
import { MoltentermNotification, notificationMessage, notificationTitle } from "../notifications-model";
import { DurableSession } from "../sessions/sessions-model";
import { workspaceShownName } from "../workspace-default-name";

// The peek names this many agents that wait, then says how many more.
export const PeekWaitingLimit = 3;
// Names listed per workspace at work, and workspaces listed.
export const PeekNamesLimit = 3;
export const PeekWorkplaceLimit = 3;

export type AttentionState = "waiting" | "error";

export function isAttentionState(state: string): state is AttentionState {
    return state === "waiting" || state === "error";
}

// The agents the developer is needed for, in every workspace and window: failed first, then waiting, the oldest first.
export function attentionAgents(data: AgentStatesData): AgentStateInfo[] {
    const rank = (info: AgentStateInfo) => (info.state === "error" ? 1 : 0);
    return Object.values(data?.states ?? {})
        .filter((info) => info != null && isAttentionState(info.state))
        .sort(
            (a, b) =>
                rank(b) - rank(a) || (a.since ?? 0) - (b.since ?? 0) || (a.blockid ?? "").localeCompare(b.blockid ?? "")
        );
}

// The agents at work, in every workspace and window: what puts Brokk's face in its thinking pose (FR-BOSS-007).
export function workingCount(data: AgentStatesData): number {
    return Object.values(data?.states ?? {}).filter((info) => info?.state === "working").length;
}

// Red when one failed, amber otherwise; no badge for nobody.
export type BadgeTone = "error" | "waiting";

export function badgeTone(list: AgentStateInfo[]): BadgeTone {
    return list.some((info) => info.state === "error") ? "error" : "waiting";
}

export type Badge = { count: number; text: string; tone: BadgeTone };

export function makeBadge(list: AgentStateInfo[]): Badge {
    return { count: list.length, text: badgeCount(list.length), tone: badgeTone(list) };
}

// A row the badge counts, listed in the hover card: its name, its place, its tone (red for a failure) and what it says.
export type PeekWaitingRow = {
    id: string;
    name: string;
    workspace: string;
    tone: "error" | "waiting" | "success";
    line: string;
};
export type PeekWorkplace = { workspace: string; names: string[]; more: number };
export type PeekNotification = { id: string; title: string; message: string };

// One provider's plan usage in the peek: its fullest window, with the reset when the reading gives one.
export type PeekUsageLine = {
    agent: string;
    label: string;
    percent: string;
    resets: string;
    level: GaugeLevel;
};

export type BossPeek = {
    waiting: PeekWaitingRow[];
    waitingMore: number;
    working: PeekWorkplace[];
    workingMore: number;
    usage: PeekUsageLine[];
    latest: PeekNotification;
};

export type PeekInput = {
    states: AgentStatesData;
    // The rows the badge counts (To handle, FR-BOSS-003), hand-off requests included: the hover card lists the same.
    toHandle: PeekWaitingRow[];
    sessions: DurableSession[];
    // The names of the workspaces of the agents listed, by workspace id (the workspace objects of this window), when known.
    workspaceNames?: Record<string, string>;
    notifications: MoltentermNotification[];
    // The latest plan usage reading per agent id (usage-readings.ts).
    usage: Record<string, UsageSnapshot>;
    now: number;
};

type Workspaces = { byBlock: Map<string, string>; byId: Map<string, string>; order: Map<string, number> };

// The workspaces' names: the workspace objects' first, then the durable sessions', which carry them for every terminal
// they hold and give the rail's order.
function workspacesOf(sessions: DurableSession[], names: Record<string, string>): Workspaces {
    const rtn: Workspaces = { byBlock: new Map(), byId: new Map(), order: new Map() };
    for (const [id, name] of Object.entries(names ?? {})) {
        const shown = name ? workspaceShownName(name, t) : "";
        if (shown) {
            rtn.byId.set(id, shown);
        }
    }
    for (const s of sessions ?? []) {
        if (!s.workspaceid || !s.shown) {
            continue;
        }
        const name = workspaceShownName(s.workspacename, t) || "";
        if (!rtn.byId.has(s.workspaceid)) {
            rtn.byId.set(s.workspaceid, name);
        }
        rtn.order.set(s.workspaceid, s.workspaceorder ?? 0);
        if (s.blockid) {
            rtn.byBlock.set(s.blockid, name);
        }
    }
    return rtn;
}

function workspaceOfAgent(info: AgentStateInfo, workspaces: Workspaces): string {
    return workspaces.byId.get(info.workspaceid) || workspaces.byBlock.get(info.blockid) || "";
}

// The names of the workspaces whose agents the peek may list (those waiting, failed or working), read from the workspace
// objects: they are the app's own record, and cover the agents no durable session shows.
export function workspaceNamesOf(
    data: AgentStatesData,
    workspaceOf: (workspaceId: string) => { name?: string }
): Record<string, string> {
    const rtn: Record<string, string> = {};
    for (const info of Object.values(data?.states ?? {})) {
        if (!info?.workspaceid || rtn[info.workspaceid] != null) {
            continue;
        }
        if (isAttentionState(info.state) || info.state === "working") {
            rtn[info.workspaceid] = workspaceOf(info.workspaceid)?.name ?? "";
        }
    }
    return rtn;
}

export function latestNotification(list: MoltentermNotification[]): PeekNotification {
    let latest: MoltentermNotification = null;
    for (const n of list ?? []) {
        if (n.archived != null) {
            continue;
        }
        if (latest == null || (n.updated ?? n.time) > (latest.updated ?? latest.time)) {
            latest = n;
        }
    }
    if (latest == null) {
        return null;
    }
    return { id: latest.id, title: notificationTitle(latest), message: notificationMessage(latest) };
}

// One line per provider that gave a reading, its fullest window, the fullest provider first (FR-SHELL-027). Several
// agents of one provider share its plan, so the provider takes its latest reading.
export function usageLine(
    usage: Record<string, UsageSnapshot>,
    agentNames: Map<string, string>,
    now: number
): PeekUsageLine[] {
    const latest = new Map<string, UsageSnapshot>();
    for (const [agent, snapshot] of Object.entries(usage ?? {})) {
        if (snapshot == null) {
            continue;
        }
        const provider = snapshot.agent || agent;
        const held = latest.get(provider);
        if (held == null || (snapshot.readat ?? 0) > (held.readat ?? 0)) {
            latest.set(provider, snapshot);
        }
    }
    const ranked: { bar: number; line: PeekUsageLine }[] = [];
    for (const [provider, snapshot] of latest) {
        let best: GaugeRow = null;
        for (const row of gaugeRows(snapshot, now)) {
            if (best == null || row.bar > best.bar) {
                best = row;
            }
        }
        if (best == null) {
            continue;
        }
        ranked.push({
            bar: best.bar,
            line: {
                agent: agentNames.get(provider) || provider,
                label: best.label,
                percent: best.percent,
                resets: best.resetsShort,
                level: best.level,
            },
        });
    }
    return ranked.sort((a, b) => b.bar - a.bar).map((entry) => entry.line);
}

export function usageText(line: PeekUsageLine): string {
    const values = { agent: line.agent, label: line.label, used: line.percent, resets: line.resets };
    return line.resets ? t("boss.peek.usageResets", values) : t("boss.peek.usage", values);
}

export function makePeek(input: PeekInput): BossPeek {
    const workspaces = workspacesOf(input.sessions, input.workspaceNames);
    const waiting = input.toHandle ?? [];
    const agentPrefix = "agent:";
    // An agent's place is the workspace it works in, known from the workspace objects when no durable session names it.
    const rows = waiting.slice(0, PeekWaitingLimit).map((row) => {
        const info = row.id.startsWith(agentPrefix) ? input.states?.states?.[row.id.slice(agentPrefix.length)] : null;
        return row.workspace || info == null ? row : { ...row, workspace: workspaceOfAgent(info, workspaces) };
    });

    const working = Object.values(input.states?.states ?? {})
        .filter((info) => info?.state === "working")
        .sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || (a.blockid ?? "").localeCompare(b.blockid ?? ""));
    const byWorkspace = new Map<string, { workspace: string; order: number; names: string[] }>();
    for (const info of working) {
        const key = info.workspaceid || workspaceOfAgent(info, workspaces);
        let place = byWorkspace.get(key);
        if (place == null) {
            place = {
                workspace: workspaceOfAgent(info, workspaces),
                order: workspaces.order.get(info.workspaceid) ?? Number.MAX_SAFE_INTEGER,
                names: [],
            };
            byWorkspace.set(key, place);
        }
        place.names.push(agentCallName(info));
    }
    const places = [...byWorkspace.values()].sort(
        (a, b) => a.order - b.order || a.workspace.localeCompare(b.workspace)
    );

    const agentNames = new Map<string, string>();
    for (const info of Object.values(input.states?.states ?? {})) {
        if (info?.agent && info.agentname) {
            agentNames.set(info.agent, info.agentname);
        }
    }

    return {
        waiting: rows,
        waitingMore: Math.max(0, waiting.length - rows.length),
        working: places.slice(0, PeekWorkplaceLimit).map((p) => ({
            workspace: p.workspace,
            names: p.names.slice(0, PeekNamesLimit),
            more: Math.max(0, p.names.length - PeekNamesLimit),
        })),
        workingMore: Math.max(0, places.length - PeekWorkplaceLimit),
        usage: usageLine(input.usage, agentNames, input.now),
        latest: latestNotification(input.notifications),
    };
}

// "Léa, Jérôme and 2 more".
export function workplaceNames(place: PeekWorkplace): string {
    const names = place.names.join(", ");
    return place.more > 0 ? `${names} ${tCount("boss.peek.more", place.more)}` : names;
}

// The button's name and its description's source (AC10): "{name}, {count} waiting". Nothing waiting reads his name
// alone: a screen reader saying "0 waiting" announces a count that is no news (#2155).
export function bubbleLabel(name: string, count: number): string {
    if (!(count > 0)) {
        return name;
    }
    return t("boss.label", { name, count });
}

// The same while he holds something back to tell (the soft cue): the count only when there is one.
export function bubbleCueLabel(name: string, count: number): string {
    if (!(count > 0)) {
        return t("boss.avatar.labelCueAlone", { name });
    }
    return t("boss.avatar.labelCue", { name, count });
}
