// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// MoltenTerm's keep-awake as the windows see it (FR-SHELL-023, DS-SHELL-062; indicator parts of FR-SHELL-022,
// DS-SHELL-063): the sleep policy, the coffees of the rail, the blocks the shims reported. wavesrv decides
// (pkg/molten/keepawake); this file holds the rules the views need, apart from the components so they can be tested.

import { t, tCount } from "./i18n/i18n";
import { ServerText, serverText, serverTexts } from "./i18n/server-text";
import { workspaceShownName } from "./workspace-default-name";
import { viewNameText } from "./workspace-views/workspace-views-model";

export const KeepAwakeRoute = "molten:keepawake";
export const KeepAwakeEvent = "molten:keepawake";
export const KeepAwakeStateCommand = "keepawakestate";
export const KeepAwakeCoffeeCommand = "keepawakecoffee";
export const KeepAwakeOverrideCommand = "keepawakeoverride";
export const KeepAwakeStopCommand = "keepawakestop";
// The ask-once notification's actions run this gesture with the chosen answer.
export const SleepPolicyGesture = "molten:sleeppolicy";
// The settings of the two activation modes and of what a terminal's request gets (FR-SHELL-023 AC14, AC15, #2089).
export const AutomaticSetting = "power:automatic";
export const TerminalRequestsSetting = "power:terminalrequests";

// The three answers of the ask-once notification, worded as the policy they replace.
export type AskAnswer = "allow" | "untilworkends" | "letsleep";

// The settings an answer of the ask-once notification writes.
export function askAnswerSettings(answer: string): Record<string, boolean | string> {
    switch (answer) {
        case "allow":
            return { [TerminalRequestsSetting]: "always" };
        case "untilworkends":
            return { [AutomaticSetting]: true, [TerminalRequestsSetting]: "always" };
        case "letsleep":
            return { [TerminalRequestsSetting]: "never" };
        default:
            return null;
    }
}

// must match Coffee in pkg/molten/keepawake/keepawake.go: a workspace's Manual switch.
export type KeepAwakeCoffee = {
    workspaceid: string;
    workspacename?: string;
    since: number;
    working: boolean;
    // What works in the workspace now, the most telling first ("Claude Code: background work"), while working.
    reasons?: string[];
    reasonstext?: ServerText[];
};

// must match Attempt in pkg/molten/keepawake/keepawake.go
export type KeepAwakeAttempt = {
    id: string;
    blockid: string;
    workspaceid?: string;
    workspacename?: string;
    tabname?: string;
    tool: string;
    args?: string[];
    pid: number;
    parentpid?: number;
    parentname?: string;
    since: number;
    outcome: "allowed" | "neutralised";
    // When the tool ends by itself (a bare caffeinate's -t), and whether ending it stops only the keep-awake (#1780).
    endsat?: number;
    stoppable?: boolean;
};

// must match Override in pkg/molten/keepawake/keepawake.go
export type KeepAwakeOverride = {
    blockid: string;
    workspaceid?: string;
    workspacename?: string;
    tabname?: string;
    policy: "allow" | "letsleep";
};

// must match State in pkg/molten/keepawake/keepawake.go
export type KeepAwakeState = {
    version: number;
    hold: boolean;
    // The Automatic mode is on; requests is what a terminal's request gets ("always", "never", empty while it asks).
    automatic: boolean;
    requests?: string;
    // Automatic holds the blocker: work runs, or it is in its grace until automaticendsat.
    automaticholding?: boolean;
    automaticworking?: boolean;
    automaticendsat?: number;
    automaticreasons?: string[];
    automaticreasonstext?: ServerText[];
    coffees: KeepAwakeCoffee[];
    attempts: KeepAwakeAttempt[];
    overrides: KeepAwakeOverride[];
    autoapprove: KeepAwakeAutoApprove[];
    approvals: KeepAwakeApproval[];
};

// must match AutoApproveSession in pkg/molten/keepawake/approve.go (FR-SHELL-063)
export type KeepAwakeAutoApprove = {
    workspaceid: string;
    blockid: string;
    tabname?: string;
    agent: string;
    agentname: string;
    approved: boolean;
    reason?: string;
    reasontext?: ServerText;
};

// must match Approval in pkg/molten/keepawake/approve.go
export type KeepAwakeApproval = {
    id: string;
    at: number;
    workspaceid?: string;
    workspacename?: string;
    tabname?: string;
    blockid: string;
    agent?: string;
    sessionid?: string;
    tool: string;
    detail?: string;
    outcome: "approved" | "asked";
    reason?: string;
    reasontext?: ServerText;
};

export const EmptyKeepAwakeState: KeepAwakeState = {
    version: -1,
    hold: false,
    automatic: false,
    coffees: [],
    attempts: [],
    overrides: [],
    autoapprove: [],
    approvals: [],
};

// The newer state wins: events and the first read may cross.
export function applyKeepAwakeState(current: KeepAwakeState, next: KeepAwakeState): KeepAwakeState {
    if (next == null || typeof next.version !== "number" || next.version < current.version) {
        return current;
    }
    return {
        ...next,
        coffees: next.coffees ?? [],
        attempts: next.attempts ?? [],
        overrides: next.overrides ?? [],
        autoapprove: next.autoapprove ?? [],
        approvals: next.approvals ?? [],
    };
}

// The coffee bud exists where MoltenTerm can keep the system awake and the shims run: macOS and Linux (DS-SHELL-062).
export function coffeeSupported(platform: string): boolean {
    return platform === "darwin" || platform === "linux";
}

// Never the machine's brand (#628): "this computer" on every platform. platform is kept for the callers.
export function computerName(_platform?: string): string {
    return t("keepawake.computer");
}

export function coffeeOf(state: KeepAwakeState, workspaceId: string): KeepAwakeCoffee {
    return state.coffees.find((c) => c.workspaceid === workspaceId) ?? null;
}

export function railCoffeeLabel(name: string, on: boolean, _platform: string): string {
    if (on) {
        return t("keepawake.railStop", { name });
    }
    return t("keepawake.railStart", { name });
}

// m:ss, never below 0:00.
export function formatCountdown(endsAt: number, now: number): string {
    const left = Math.max(0, Math.ceil((endsAt - now) / 1000));
    const minutes = Math.floor(left / 60);
    const seconds = left % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// The condition of a coffee, the Manual switch, in a few words: it holds until the developer turns it off (#2089).
export function coffeeCondition(): string {
    return t("keepawake.untilTurnedOff");
}

// Why the computer is kept awake, in one line: the reasons wavesrv sent, joined (#493), worded by their codes (#656).
export function reasonsText(reasons: string[], texts?: ServerText[]): string {
    return serverTexts(texts, reasons ?? [])
        .filter((r) => r)
        .join(", ");
}

// What keeps a coffee on now; "" in its grace.
export function coffeeReason(coffee: KeepAwakeCoffee): string {
    return coffee.working ? reasonsText(coffee.reasons, coffee.reasonstext) : "";
}

// Why a session's prompts still ask the person, or why a request was left to them; "" without a reason.
export function approvalReasonText(item: { reason?: string; reasontext?: ServerText }): string {
    return item?.reason ? serverText(item.reasontext, item.reason) : "";
}

// The coffee bud's tooltip while on (DS-SHELL-062), and the one line the rail item adds.
export function coffeeTooltip(coffee: KeepAwakeCoffee, name: string): string {
    const base = t("keepawake.tooltip", { name });
    const why = coffeeReason(coffee);
    return why ? `${base}\n${t("keepawake.now", { why })}` : base;
}

// What Automatic holds right now, in a few words; "" while it holds nothing.
export function automaticHoldingLine(state: KeepAwakeState, now: number): string {
    if (!state.automaticholding) {
        return "";
    }
    if (state.automaticworking || !state.automaticendsat) {
        const why = state.automaticworking ? reasonsText(state.automaticreasons, state.automaticreasonstext) : "";
        return why ? t("keepawake.holdingWhy", { why }) : t("keepawake.holding");
    }
    return t("keepawake.holdingEnding", { time: formatCountdown(state.automaticendsat, now) });
}

export function attemptAlive(attempt: KeepAwakeAttempt): boolean {
    return attempt.outcome === "allowed";
}

// One reason keeping the computer awake, as the cup's menu lists it (#1780): a terminal whose block went through, a
// workspace kept awake at the user's request (coffee mode), or the Until work ends setting while it holds.
export type KeepAwakeHold = {
    kind: "terminal" | "coffee" | "work";
    key: string;
    label: string;
    detail: string;
    blockid?: string;
    workspaceid?: string;
    // Stop ends the hold: a terminal's bare keep-awake process, or a coffee. The setting has no Stop: the menu's
    // options right below change it.
    canStop: boolean;
};

// "2 h 40", "12 min", "45 s": how long a hold still lasts, rounded up so it never reads 0 before it ends.
export function formatTimeLeft(endsAt: number, now: number): string {
    const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
    if (seconds < 60) {
        return t("keepawake.left.seconds", { count: seconds });
    }
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) {
        return t("keepawake.left.minutes", { count: minutes });
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return t("keepawake.left.hours", { hours, minutes: rest.toString().padStart(2, "0") });
}

function terminalHold(blockid: string, attempts: KeepAwakeAttempt[], now: number): KeepAwakeHold {
    const latest = attempts[attempts.length - 1];
    const tab = viewNameText(latest.tabname, t);
    const where = workspaceShownName(latest.workspacename, t);
    const label = tab ? t("keepawake.row.terminal", { name: tab }) : t("keepawake.aTerminal");
    const ends = attempts.map((a) => a.endsat ?? 0);
    const endsAt = ends.every((e) => e > 0) ? Math.max(...ends) : 0;
    const command = describeAttempt(latest) + (attempts.length > 1 ? ` (+${attempts.length - 1})` : "");
    const parts = [command];
    if (endsAt > 0 && now != null) {
        parts.push(t("keepawake.row.left", { time: formatTimeLeft(endsAt, now) }));
    }
    if (where) {
        parts.push(where);
    }
    return {
        kind: "terminal",
        key: `terminal:${blockid}`,
        label,
        detail: parts.join(" · "),
        blockid,
        canStop: attempts.some((a) => a.stoppable),
    };
}

function coffeeHold(coffee: KeepAwakeCoffee): KeepAwakeHold {
    const name = workspaceShownName(coffee.workspacename, t) || t("keepawake.workspace");
    const why = coffeeReason(coffee);
    const detail = why ? t("keepawake.row.coffeeWhy", { why }) : t("keepawake.row.coffee");
    return {
        kind: "coffee",
        key: `coffee:${coffee.workspaceid}`,
        label: name,
        detail,
        workspaceid: coffee.workspaceid,
        canStop: true,
    };
}

function workHold(state: KeepAwakeState, now: number): KeepAwakeHold {
    let detail: string;
    if (state.automaticworking || !state.automaticendsat || now == null) {
        const why = state.automaticworking ? reasonsText(state.automaticreasons, state.automaticreasonstext) : "";
        detail = why ? t("keepawake.row.workWhy", { why }) : t("keepawake.row.work");
    } else {
        detail = t("keepawake.row.workEnding", { time: formatCountdown(state.automaticendsat, now) });
    }
    return { kind: "work", key: "work", label: t("keepawake.row.automaticLabel"), detail, canStop: false };
}

// The reasons keeping the computer awake, one per row (#1780): each terminal whose block went through (a neutralised
// attempt blocks nothing), each coffee (a Manual switch), then Automatic while it holds. The cup's count, its tooltip
// and its menu all read this list, so they never disagree. Without a clock the rows leave out what time left they
// would show.
export function keepAwakeHolds(state: KeepAwakeState, now?: number): KeepAwakeHold[] {
    const holds: KeepAwakeHold[] = [];
    const byBlock = new Map<string, KeepAwakeAttempt[]>();
    for (const attempt of state.attempts.filter(attemptAlive)) {
        const list = byBlock.get(attempt.blockid) ?? [];
        list.push(attempt);
        byBlock.set(attempt.blockid, list);
    }
    for (const [blockid, attempts] of byBlock) {
        holds.push(terminalHold(blockid, attempts, now));
    }
    for (const coffee of state.coffees) {
        holds.push(coffeeHold(coffee));
    }
    if (state.automaticholding) {
        holds.push(workHold(state, now));
    }
    if (state.hold && state.coffees.length === 0 && !state.automaticholding) {
        holds.push({ kind: "work", key: "hold", label: t("keepawake.row.workLabel"), detail: "", canStop: false });
    }
    return holds;
}

// The cup's count: the number of reasons the menu lists (#1780).
export function keepAwakeCount(state: KeepAwakeState): number {
    return keepAwakeHolds(state).length;
}

// "2 reasons keep this computer awake", for the cup's tooltip and the menu's heading.
export function keepAwakeCountLabel(count: number): string {
    return tCount("keepawake.reasonsCount", count);
}

export type KeepAwakeStatus = {
    awake: boolean;
    headline: string;
    // Who keeps it awake, mode by mode, or what the two modes are while nothing does: the line under the headline.
    cause: string;
};

function automaticCause(state: KeepAwakeState, now: number): string {
    if (state.automaticworking || !state.automaticendsat || now == null) {
        const why = state.automaticworking ? reasonsText(state.automaticreasons, state.automaticreasonstext) : "";
        return why ? t("keepawake.status.automaticWhy", { why }) : t("keepawake.status.automatic");
    }
    return t("keepawake.status.automaticEnding", { time: formatCountdown(state.automaticendsat, now) });
}

// What the person reads first about the keep-awake (#2089): whether this computer is kept awake and what by, mode by
// mode, never the state of a switch. The switches come after it. Its answer is keepAwakeActive's, which the face's mark
// and the rail's dot read too.
export function keepAwakeStatus(state: KeepAwakeState, now?: number): KeepAwakeStatus {
    const holds = keepAwakeHolds(state, now);
    if (holds.length === 0) {
        return {
            awake: false,
            headline: t("keepawake.cupIdle"),
            cause: t(state.automatic ? "keepawake.status.idleAutomatic" : "keepawake.status.idleOff"),
        };
    }
    const causes: string[] = [];
    if (state.automaticholding) {
        causes.push(automaticCause(state, now));
    }
    const coffees = holds.filter((h) => h.kind === "coffee");
    if (coffees.length > 0) {
        causes.push(t("keepawake.status.manual", { names: coffees.map((h) => h.label).join(", ") }));
    }
    const terminals = holds.filter((h) => h.kind === "terminal").length;
    if (terminals > 0) {
        causes.push(tCount("keepawake.status.terminals", terminals));
    }
    return { awake: true, headline: t("keepawake.status.awake"), cause: causes.join(" · ") };
}

export type KeepAwakeSession = {
    blockid: string;
    label: string;
    attempts: KeepAwakeAttempt[];
    override: KeepAwakeOverride;
};

function sessionLabel(tabname: string, workspacename: string): string {
    const parts = [viewNameText(tabname, t), workspaceShownName(workspacename, t)].filter((p) => p);
    return parts.length > 0 ? parts.join(" · ") : t("keepawake.aTerminal");
}

// The sessions the list shows: those with a reported block, then those with an override and no block now.
export function keepAwakeSessions(state: KeepAwakeState): KeepAwakeSession[] {
    const sessions = new Map<string, KeepAwakeSession>();
    for (const attempt of state.attempts) {
        let session = sessions.get(attempt.blockid);
        if (session == null) {
            session = {
                blockid: attempt.blockid,
                label: sessionLabel(attempt.tabname, attempt.workspacename),
                attempts: [],
                override: null,
            };
            sessions.set(attempt.blockid, session);
        }
        session.attempts.push(attempt);
    }
    for (const override of state.overrides) {
        let session = sessions.get(override.blockid);
        if (session == null) {
            session = {
                blockid: override.blockid,
                label: sessionLabel(override.tabname, override.workspacename),
                attempts: [],
                override,
            };
            sessions.set(override.blockid, session);
        }
        session.override = override;
    }
    return [...sessions.values()];
}

// The indicator shows only while something keeps the computer awake (FR-SHELL-103-AC1).
export function keepAwakeActive(state: KeepAwakeState): boolean {
    return keepAwakeCount(state) > 0;
}

// One line per reason for the cup's tooltip: "Terminal “Scoping” · caffeinate -i -t 600 · 9 min left".
export function holdLine(hold: KeepAwakeHold): string {
    return hold.detail ? `${hold.label} · ${hold.detail}` : hold.label;
}

export function describeAttempt(attempt: KeepAwakeAttempt): string {
    const args = (attempt.args ?? []).join(" ");
    return args ? `${attempt.tool} ${args}` : attempt.tool;
}

// The coffee approvals (FR-SHELL-063, DS-SHELL-112): which agent sessions a coffee answers for, and its decisions.
export function approvalLogText(): string {
    return t("keepawake.approvalLog", { path: "molten/coffee-approvals.jsonl" });
}

export function coffeeSessions(state: KeepAwakeState, workspaceId: string): KeepAwakeAutoApprove[] {
    return (state.autoapprove ?? []).filter((s) => s.workspaceid === workspaceId);
}

export function sessionWhere(session: KeepAwakeAutoApprove): string {
    return t("keepawake.sessionWhere", {
        agent: session.agentname || session.agent,
        where: viewNameText(session.tabname, t) || t("keepawake.aTerminalLower"),
    });
}

// The lines the coffee bud's tooltip adds: who gets approved, who still asks and why.
export function coffeeApprovalLines(state: KeepAwakeState, workspaceId: string): string[] {
    const sessions = coffeeSessions(state, workspaceId);
    const approved = sessions.filter((s) => s.approved);
    const asking = sessions.filter((s) => !s.approved);
    const lines: string[] = [];
    if (approved.length > 0) {
        lines.push(t("keepawake.approves", { sessions: approved.map(sessionWhere).join(", ") }));
    }
    for (const s of asking) {
        const reason = approvalReasonText(s);
        const where = `${sessionWhere(s)}${reason ? ` (${reason})` : ""}`;
        lines.push(t("keepawake.stillAsks", { where }));
    }
    return lines;
}

export function coffeeApprovals(state: KeepAwakeState, workspaceId: string): KeepAwakeApproval[] {
    return (state.approvals ?? []).filter((a) => a.workspaceid === workspaceId);
}

export function approvalCounts(approvals: KeepAwakeApproval[]): { approved: number; asked: number } {
    const approved = approvals.filter((a) => a.outcome === "approved").length;
    return { approved, asked: approvals.length - approved };
}

export function describeApproval(approval: KeepAwakeApproval): string {
    return approval.detail ? `${approval.tool}: ${approval.detail}` : approval.tool;
}

// One line per counted outcome, "" when nothing was decided yet.
export function approvalSummary(approvals: KeepAwakeApproval[]): string {
    const { approved, asked } = approvalCounts(approvals);
    const parts: string[] = [];
    if (approved > 0) {
        parts.push(tCount("keepawake.approvedCount", approved));
    }
    if (asked > 0) {
        parts.push(tCount("keepawake.askedCount", asked));
    }
    return parts.join(" · ");
}
