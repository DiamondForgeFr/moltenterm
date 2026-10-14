// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm's keep-awake as the windows see it (FR-SHELL-023, DS-SHELL-062; indicator parts of FR-SHELL-022,
// DS-SHELL-063): the sleep policy, the coffees of the rail, the blocks the shims reported. wavesrv decides
// (pkg/molten/keepawake); this file holds the rules the views need, apart from the components so they can be tested.

import { t } from "./i18n/i18n";

export const KeepAwakeRoute = "molten:keepawake";
export const KeepAwakeEvent = "molten:keepawake";
export const KeepAwakeStateCommand = "keepawakestate";
export const KeepAwakeCoffeeCommand = "keepawakecoffee";
export const KeepAwakeOverrideCommand = "keepawakeoverride";
// The ask-once notification's actions run this gesture with the chosen policy.
export const SleepPolicyGesture = "molten:sleeppolicy";
export const SleepPolicySetting = "power:sleeppolicy";

export type SleepPolicy = "allow" | "untilworkends" | "letsleep";

// must match Coffee in pkg/molten/keepawake/keepawake.go
export type KeepAwakeCoffee = {
    workspaceid: string;
    workspacename?: string;
    since: number;
    working: boolean;
    endsat?: number;
    // What works in the workspace now, the most telling first ("Claude Code: background work"), while working.
    reasons?: string[];
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
    policy: string;
    policyholding?: boolean;
    policyworking?: boolean;
    policyendsat?: number;
    policyreasons?: string[];
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
};

export const EmptyKeepAwakeState: KeepAwakeState = {
    version: -1,
    hold: false,
    policy: "",
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

// The condition of a coffee, in a few words: "until its work ends" while work runs, the time left in its grace
// otherwise (DS-SHELL-063).
export function coffeeCondition(coffee: KeepAwakeCoffee, now: number): string {
    if (coffee.working || !coffee.endsat) {
        return t("keepawake.untilWorkEnds");
    }
    return t("keepawake.endingIn", { time: formatCountdown(coffee.endsat, now) });
}

// Why the computer is kept awake, in one line: the reasons wavesrv sent, joined (#493).
export function reasonsText(reasons: string[]): string {
    return (reasons ?? []).filter((r) => r).join(", ");
}

// What keeps a coffee on now; "" in its grace.
export function coffeeReason(coffee: KeepAwakeCoffee): string {
    return coffee.working ? reasonsText(coffee.reasons) : "";
}

// The coffee bud's tooltip while on (DS-SHELL-062), and the one line the rail item adds.
export function coffeeTooltip(coffee: KeepAwakeCoffee, name: string, platform: string, now: number): string {
    const base = t("keepawake.tooltip", { name });
    if (coffee.working || !coffee.endsat) {
        const why = coffeeReason(coffee);
        return why ? `${base}\n${t("keepawake.now", { why })}` : base;
    }
    return `${base}\n${t("keepawake.nothingRuns", { time: formatCountdown(coffee.endsat, now) })}`;
}

// What the policy holds right now, in a few words; "" while it holds nothing.
export function policyHoldingLine(state: KeepAwakeState, platform: string, now: number): string {
    if (!state.policyholding) {
        return "";
    }
    if (state.policyworking || !state.policyendsat) {
        const why = state.policyworking ? reasonsText(state.policyreasons) : "";
        return why ? t("keepawake.holdingWhy", { why }) : t("keepawake.holding");
    }
    return t("keepawake.holdingEnding", { time: formatCountdown(state.policyendsat, now) });
}

export function attemptAlive(attempt: KeepAwakeAttempt): boolean {
    return attempt.outcome === "allowed";
}

// The status bar's count: MoltenTerm's own block once, whatever the number of coffees, plus each session whose
// reported block was let through (FR-SHELL-022-AC7). A neutralised attempt blocks nothing.
export function keepAwakeCount(state: KeepAwakeState): number {
    const sessions = new Set(state.attempts.filter(attemptAlive).map((a) => a.blockid));
    return (state.hold ? 1 : 0) + sessions.size;
}

export type KeepAwakeSession = {
    blockid: string;
    label: string;
    attempts: KeepAwakeAttempt[];
    override: KeepAwakeOverride;
};

function sessionLabel(tabname: string, workspacename: string): string {
    const parts = [tabname, workspacename].filter((p) => p);
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

export type SleepPolicyChoice = { policy: SleepPolicy; label: string; detail: string };

// The popover's one sentence (DS-SHELL-101): the segmented control of the policies completes it.
export function sleepPolicySentence(_platform: string): string {
    return t("keepawake.policySentence");
}

// The labels answer that sentence; each detail is its segment's tooltip.
export function sleepPolicyChoices(_platform: string): SleepPolicyChoice[] {
    return [
        { policy: "allow", label: t("keepawake.policy.allow"), detail: t("keepawake.policy.allowDetail") },
        {
            policy: "untilworkends",
            label: t("keepawake.policy.untilWorkEnds"),
            detail: t("keepawake.policy.untilWorkEndsDetail"),
        },
        {
            policy: "letsleep",
            label: t("keepawake.policy.letSleep"),
            detail: t("keepawake.policy.letSleepDetail"),
        },
    ];
}

export function cleanSleepPolicy(value: string): SleepPolicy {
    if (value === "allow" || value === "untilworkends" || value === "letsleep") {
        return value;
    }
    return null;
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
        where: session.tabname || t("keepawake.aTerminalLower"),
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
        const where = `${sessionWhere(s)}${s.reason ? ` (${s.reason})` : ""}`;
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
        parts.push(t("keepawake.approvedCount", { count: approved }));
    }
    if (asked > 0) {
        parts.push(t("keepawake.askedCount", { count: asked }));
    }
    return parts.join(" · ");
}
