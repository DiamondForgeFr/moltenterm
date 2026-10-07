// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace task checkpoint (FR-CONT-007, DS-CONT-008): what wavesrv keeps of a workspace's task
// (pkg/molten/agentcontinuity/checkpoint), and the pure rules of the companion's "Workspace task" section.

// must match pkg/molten/agenttask.go
export const TaskRoute = "molten:task";
export const TaskEvent = "molten:task";
export const TaskReadCommand = "moltentaskread";
export const TaskHistoryCommand = "moltentaskhistory";
export const TaskRestoreCommand = "moltentaskrestore";
export const TaskClearCommand = "moltentaskclear";

// must match pkg/molten/agentcontinuity/checkpoint/format.go
export const SectionGoal = "Goal";
export const SectionTicket = "Ticket";
export const SectionPlan = "Plan and progress";
export const SectionFiles = "Files touched";
export const SectionNext = "Next steps";
export const OwnerAuto = "auto";
export const OwnerUser = "user";

export type TaskTranscript = { agent?: string; session?: string; path?: string };

export type TaskSection = { name: string; owner?: string; at?: number; text: string; extra?: boolean };

export type TaskView = {
    workspaceid: string;
    path: string;
    exists: boolean;
    started?: number;
    updated?: number;
    updatedby?: string;
    transcript?: TaskTranscript;
    redactions: number;
    versions: number;
    sections?: TaskSection[];
    markdown?: string;
};

export type TaskChanged = { workspaceid: string; updated: number; updatedby?: string };

const AgentNames: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    gemini: "Gemini CLI",
    kimi: "Kimi Code",
    opencode: "OpenCode",
};

export function agentName(agent: string): string {
    if (!agent) {
        return "";
    }
    return AgentNames[agent] ?? agent;
}

// Who wrote a version or a section: auto (with the agent its session was), the user, or an agent (<agent>:<session>).
export function authorLabel(owner: string, transcript?: TaskTranscript): string {
    if (!owner) {
        return "";
    }
    if (owner === OwnerUser) {
        return "you";
    }
    if (owner === OwnerAuto) {
        const name = agentName(transcript?.agent);
        return name ? `MoltenTerm, from ${name}` : "MoltenTerm";
    }
    const agent = owner.split(":")[0];
    return agentName(agent);
}

export function sectionText(view: TaskView, name: string): string {
    const sec = view?.sections?.find((s) => s.name === name);
    return sec?.text?.trim() ?? "";
}

// The first line of a section, without its Markdown list or checkbox marks.
export function firstLine(text: string): string {
    const line = (text ?? "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "");
    if (!line) {
        return "";
    }
    return line.replace(/^[-*]\s+(\[[ xX]\]\s+)?/, "");
}

// The plan's checkboxes: "- [x]" done, "- [ ]" not yet.
export function planCounts(text: string): { done: number; total: number } {
    let done = 0;
    let total = 0;
    for (const line of (text ?? "").split("\n")) {
        const m = /^\s*[-*]\s+\[([ xX])\]/.exec(line);
        if (!m) {
            continue;
        }
        total++;
        if (m[1] !== " ") {
            done++;
        }
    }
    return { done, total };
}

export function filesCount(text: string): number {
    return (text ?? "").split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
}

export type TaskSummary = {
    empty: boolean;
    goal: string;
    ticket: string;
    plan: { done: number; total: number };
    files: number;
    next: string;
    by: string;
    agent: string;
    redactions: number;
    versions: number;
};

export function taskSummary(view: TaskView): TaskSummary {
    const goal = firstLine(sectionText(view, SectionGoal));
    const ticket = firstLine(sectionText(view, SectionTicket));
    const plan = planCounts(sectionText(view, SectionPlan));
    const files = filesCount(sectionText(view, SectionFiles));
    const next = firstLine(sectionText(view, SectionNext));
    const empty = !view?.exists || (view.sections ?? []).every((s) => !s.text?.trim());
    return {
        empty,
        goal,
        ticket,
        plan,
        files,
        next,
        by: authorLabel(view?.updatedby, view?.transcript),
        agent: agentName(view?.transcript?.agent),
        redactions: view?.redactions ?? 0,
        versions: view?.versions ?? 0,
    };
}

export function redactionLabel(count: number): string {
    if (!count) {
        return "";
    }
    return count === 1 ? "1 secret redacted" : `${count} secrets redacted`;
}

// A newer read replaces the one shown; an older answer arriving late does not.
export function newerTask(cur: TaskView, next: TaskView): TaskView {
    if (next == null) {
        return cur;
    }
    if (cur == null || cur.workspaceid !== next.workspaceid) {
        return next;
    }
    return (next.updated ?? 0) >= (cur.updated ?? 0) ? next : cur;
}
