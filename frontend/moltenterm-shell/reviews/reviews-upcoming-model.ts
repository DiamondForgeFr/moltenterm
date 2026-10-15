// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's upcoming work and the agents on each branch (#712, FR-REV-022, DS-REV-015): wavesrv places the
// agents on branches (pkg/molten/mission/upcoming.go), the window adds what its agent-state store knows now (state,
// first name), so a bar turns from working to waiting at once. Kept apart from the components to be tested alone.

import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { TFunction } from "../i18n/i18n";
import { dateLocale } from "../mission/time-format";
import type { ReviewsAnswer } from "./reviews-model";

// must match the names in pkg/molten/mission/upcoming.go
export const UpcomingCommand = "moltenmissionupcoming";

// must match UpcomingBranch in pkg/molten/mission/upcoming.go
export type UpcomingBranch = {
    branch: string;
    ticket: number;
    ahead: number;
    remote?: boolean;
    worktree?: string;
    commitat?: number;
    title?: string;
    url?: string;
    status?: string;
};

// must match BranchAgent in pkg/molten/mission/upcoming.go
export type BranchAgent = {
    branch: string;
    worktree: string;
    kind: "panel" | "background";
    blockid?: string;
    agent?: string;
    firstname?: string;
    started?: number;
    activeat?: number;
    parentblockid?: string;
    parentfirstname?: string;
};

// must match UpcomingAnswer in pkg/molten/mission/upcoming.go
export type UpcomingAnswer = {
    dir: string;
    target?: string;
    branches: UpcomingBranch[];
    agents: BranchAgent[];
    error?: string;
    ticketserror?: string;
    at: number;
};

export type BarState = "working" | "waiting" | "done" | "idle" | "background";

// What the bar under a tile shows of the agent on the row's branch.
export type AgentBarFacts = {
    kind: "panel" | "background";
    blockId?: string;
    agent?: string;
    name: string;
    state: BarState;
    // Since when the agent is on it (a panel), or its last sign of activity (a background agent), in ms.
    since: number;
    parentBlockId?: string;
    parentName?: string;
};

// The upcoming rows: a branch whose PR the Reviews list now shows leaves at once, without waiting for wavesrv.
export function upcomingRows(upcoming: UpcomingAnswer, reviews: ReviewsAnswer): UpcomingBranch[] {
    if (upcoming?.branches == null) {
        return [];
    }
    const withPr = new Set<string>();
    for (const pr of [...(reviews?.ready ?? []), ...(reviews?.drafts ?? [])]) {
        withPr.add(pr.branch);
    }
    return upcoming.branches.filter((b) => !withPr.has(b.branch));
}

function barState(info: AgentStateInfo): BarState {
    switch (info?.state) {
        case "working":
        case "waiting":
        case "done":
            return info.state;
        case "error":
            return "waiting";
    }
    return "idle";
}

// branchAgent: the agent the bar under the branch's tile shows. A panel agent whose terminal the windows no longer
// know is gone (closed since wavesrv answered); the most urgent panel wins over a background one.
export function branchAgent(upcoming: UpcomingAnswer, states: AgentStatesData, branch: string): AgentBarFacts {
    if (upcoming?.agents == null || !branch) {
        return null;
    }
    let best: AgentBarFacts = null;
    for (const a of upcoming.agents) {
        if (a.branch !== branch) {
            continue;
        }
        if (a.kind === "background") {
            if (best == null) {
                best = {
                    kind: "background",
                    agent: a.agent,
                    name: "",
                    state: "background",
                    since: a.activeat ?? 0,
                    parentBlockId: a.parentblockid,
                    parentName: states?.states?.[a.parentblockid]?.firstname || a.parentfirstname,
                };
            }
            continue;
        }
        const info = states?.states?.[a.blockid];
        if (info == null) {
            continue;
        }
        const facts: AgentBarFacts = {
            kind: "panel",
            blockId: a.blockid,
            agent: info.agent || a.agent,
            name: (info.firstname || a.firstname || "").trim() || info.agentname || info.agent || a.agent || "",
            state: barState(info),
            since: a.started ?? 0,
        };
        if (best == null || best.kind === "background" || BarUrgency[facts.state] > BarUrgency[best.state]) {
            best = facts;
        }
    }
    return best;
}

const BarUrgency: Record<BarState, number> = { waiting: 4, working: 3, done: 2, idle: 1, background: 0 };

// A draft is the developer's to validate when no agent is on its branch (AC3).
export function draftIsYours(draft: boolean, agent: AgentBarFacts): boolean {
    return draft && agent == null;
}

const ClockFormats = new Map<string, Intl.DateTimeFormat>();

function clockFormat(): Intl.DateTimeFormat {
    const locale = dateLocale();
    let f = ClockFormats.get(locale);
    if (f == null) {
        f = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
        ClockFormats.set(locale, f);
    }
    return f;
}

// "12 min", "2 h 05", "3 d": how long, at minute granularity.
export function durationText(t: TFunction, ms: number): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 1) {
        return t("reviewsAgents.duration.lessThanMinute");
    }
    if (minutes < 60) {
        return t("reviewsAgents.duration.minutes", { count: minutes });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return t("reviewsAgents.duration.hours", { hours, minutes: String(minutes % 60).padStart(2, "0") });
    }
    return t("reviewsAgents.duration.days", { count: Math.floor(hours / 24) });
}

// When: the clock time today, the day and time before.
export function sinceText(since: number, now: number): string {
    const date = new Date(since);
    const clock = clockFormat().format(date);
    if (new Date(now).toDateString() === date.toDateString()) {
        return clock;
    }
    return `${new Intl.DateTimeFormat(dateLocale(), { day: "numeric", month: "short" }).format(date)} ${clock}`;
}

// The bar's time line: "for 12 min · since 20:41", or for a background agent "last change 3 min ago".
export function barTimeText(t: TFunction, facts: AgentBarFacts, now: number): string {
    if (facts == null || !facts.since) {
        return "";
    }
    const elapsed = durationText(t, now - facts.since);
    if (facts.kind === "background") {
        return t("reviewsAgents.lastChange", { duration: elapsed });
    }
    return t("reviewsAgents.forSince", { duration: elapsed, since: sinceText(facts.since, now) });
}

export function barStateText(t: TFunction, state: BarState): string {
    return t(`reviewsAgents.state.${state}`);
}

// "3 commits ahead", for the upcoming row.
export function aheadText(t: TFunction, ahead: number): string {
    if (!ahead) {
        return t("reviewsAgents.upcoming.noCommit");
    }
    if (ahead === 1) {
        return t("reviewsAgents.upcoming.aheadOne");
    }
    return t("reviewsAgents.upcoming.ahead", { count: ahead });
}
