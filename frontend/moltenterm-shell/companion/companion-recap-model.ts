// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's recap (#555): the recent topics of the session and the agents at work, from what wavesrv read of
// the transcript (pkg/molten/companion/topics.go) and the pane's agent state. Nothing here is written by a model: a
// line the data cannot support is left out. Pure, so it is tested without a window.

import { JobsView, jobsView } from "../activity/job-words";
import {
    agentLabel,
    AgentStateInfo,
    agentStateLabel,
    agentStateMessage,
    stateWithSubagents,
} from "../agent-state-model";
import { t } from "../i18n/i18n";
import { CompanionSubagent, CompanionTopic, CompanionView, relativeTime } from "./companion-model";
import { modelDisplayName, ProportionHint, proportionHint } from "./companion-proportion";

// The branch naming of the workflow (feature/{N}-…, fix/{N}-…): the number is the ticket.
const BranchTicketRegex = /^(?:feature|fix)\/(\d+)(?:-|$)/;
const MaxWorkLines = 3;

export function branchTicket(branch: string): string {
    const m = BranchTicketRegex.exec(branch ?? "");
    return m == null ? "" : `#${m[1]}`;
}

// at: when the prompt was typed, which tells a pasted image's chip which message holds it (#2455).
export type TopicRow = { key: string; text: string; facts: string[]; title: string; at: number };

// Each topic is the user's own prompt; its facts are the ticket of its branch, the files it changed, the PRs it
// opened and when it was last worked on.
export function topicRows(topics: CompanionTopic[], now: number): TopicRow[] {
    return (topics ?? []).map((topic, i) => {
        const ticket = branchTicket(topic.branch);
        const facts = [
            ticket,
            topic.files > 0
                ? t(topic.files === 1 ? "companion.topics.filesOne" : "companion.topics.filesOther", {
                      count: topic.files,
                  })
                : "",
            ...(topic.prs ?? []).map((pr) => `PR #${pr.number}`),
            relativeTime(topic.last || topic.at, now),
        ].filter((s) => !!s);
        return {
            key: `${topic.at ?? 0}:${i}`,
            text: topic.text,
            at: topic.at ?? 0,
            facts,
            title: [topic.text, topic.branch ? t("companion.branch", { branch: topic.branch }) : ""]
                .filter((s) => !!s)
                .join("\n"),
        };
    });
}

export type AgentRowState = "working" | "waiting" | "idle" | "done" | "error" | "exited" | "running";

// One agent of the instance. name, portrait and capabilities are left for named agents and their loaded skills
// (#550, #552): the row shows them once the data carries them.
export type AgentRow = {
    id: string;
    main: boolean;
    name: string;
    // The main agent's first name and its tool, which name is made of: the work area draws them apart (#2418).
    first?: string;
    tool?: string;
    state: AgentRowState;
    stateLabel: string;
    config: string;
    configTitle?: string;
    lines: string[];
    // The ticket it works on and its complexity ("#601 · medium"), when its label is known (#601), and the hint when
    // its model and effort are out of proportion with it.
    ticket?: string;
    complexity?: string;
    hint?: ProportionHint;
    background?: boolean;
    // A sub-agent whose turn ended on background work of its own, which it waits for (#2498, #2502): its row stays at
    // the top and says what for. job is the oldest of its jobs, worded; absent when its files name none.
    waiting?: boolean;
    job?: JobsView;
    // A sub-agent's own branch, read from its folder (#967).
    branch?: string;
    // How deep a sub-agent's sub-agent sits under the session's own (#2587): 1 under one of them, absent for those.
    depth?: number;
    portrait?: string;
    capabilities?: string[];
};

function activityLine(view: CompanionView): string {
    const a = view.activity;
    if (a == null || !a.tool) {
        return "";
    }
    return t("companion.agents.now", { what: a.target ? `${a.tool} · ${a.target}` : a.tool });
}

// An agent's model and effort: the model's id (for the proportion) and how a row names it.
export type ModelEffort = { model: string; modelName: string; effort: string };

// The main agent's: the status line's (#549), else what its transcript records.
export function mainModelEffort(view: CompanionView, agentState: AgentStateInfo): ModelEffort {
    const reported = (agentState?.model || agentState?.modelname || "").trim();
    const model = reported || (view?.session?.model ?? "").trim();
    const modelName = (agentState?.modelname || "").trim() || modelDisplayName(model);
    const effort = (agentState?.effort || "").trim() || (view?.session?.effort ?? "").trim();
    return { model, modelName, effort };
}

function configLabel(modelName: string, effort: string, inherited: boolean): string {
    if (!modelName) {
        return "";
    }
    if (!effort) {
        return modelName;
    }
    return inherited ? t("companion.agents.configInherited", { model: modelName, effort }) : `${modelName} · ${effort}`;
}

type TicketFacts = Pick<AgentRow, "ticket" | "complexity" | "hint">;

// A ticket shows only with its complexity label: a project without the workflow's labels shows nothing.
function ticketFacts(ticket: number, complexity: string, model: string, effort: string): TicketFacts {
    if (!(ticket > 0) || !complexity) {
        return {};
    }
    return {
        ticket: `#${ticket}`,
        complexity,
        hint: proportionHint(model, effort, complexity) ?? undefined,
    };
}

// The main session: its state, its model and effort (#549), and what it works on: the task in progress, the topic,
// what it runs now (only while it works).
export function mainAgentRow(view: CompanionView, agentState: AgentStateInfo): AgentRow {
    const ended = view?.ended === true;
    const state: AgentRowState = ended ? "exited" : ((agentState?.state as AgentRowState) ?? "idle");
    const lines: string[] = [];
    if (!ended && agentState?.messagetext != null) {
        // MoltenTerm holds the state (#896): it says what the run waits for, "waiting for the CI of #12".
        lines.push(agentStateMessage(agentState));
    }
    const task = (view?.todos ?? []).find((todo) => todo.status === "in_progress");
    if (task) {
        lines.push(t("companion.agents.task", { text: task.text }));
    }
    const topic = view?.topics?.[0];
    if (topic && !task) {
        lines.push(t("companion.agents.topic", { text: topic.text }));
    }
    if (state === "working") {
        const now = activityLine(view);
        if (now) {
            lines.push(now);
        }
    }
    const me = mainModelEffort(view, agentState);
    return {
        id: "main",
        main: true,
        name: agentState?.firstname ? agentLabel(agentState) : view?.agentname || agentState?.agentname || "Agent",
        first: (agentState?.firstname ?? "").trim(),
        tool: (agentState?.agentname || view?.agentname || "").trim(),
        state,
        stateLabel: ended ? t("companion.agents.exited") : agentStateLabel(state),
        config: ended ? "" : configLabel(me.modelName, me.effort, false),
        lines: lines.slice(0, MaxWorkLines),
        ...(ended ? {} : ticketFacts(view?.session?.ticket, view?.session?.complexity, me.model, me.effort)),
    };
}

// A foreground sub-agent lives within its parent's turn: once the main agent stops working, or exits, one still
// marked running lost its end (an interrupted run) and is not shown as at work. Nothing outlives an exited agent.
function stillRunning(sub: CompanionSubagent, view: CompanionView, agentState: AgentStateInfo): boolean {
    if (sub.state !== "running" || view?.ended) {
        return false;
    }
    // One that waits on its own tests or build lives on its own work, whatever its lead's turn does (#2498).
    if (sub.background || sub.waiting) {
        return true;
    }
    const state = agentState?.state;
    return state === "working" || state === "waiting";
}

// A sub-agent's model and effort: its own, else its parent's, marked inherited (#601).
export function subagentRow(sub: CompanionSubagent, now: number, parent?: ModelEffort): AgentRow {
    const started = relativeTime(sub.started, now);
    const what = [
        sub.kind,
        sub.background ? t("companion.agents.background") : "",
        started ? t("companion.started", { time: started }) : "",
    ].filter((s) => !!s);
    const ownModel = modelDisplayName(sub.model) ? (sub.model ?? "").trim() : "";
    const model = ownModel || parent?.model || "";
    const modelName = ownModel ? modelDisplayName(ownModel) : parent?.modelName || "";
    const ownEffort = (sub.effort ?? "").trim();
    const effort = ownEffort || parent?.effort || "";
    const inheritedModel = !ownModel && !!modelName;
    const inheritedEffort = !ownEffort && !!effort;
    const titleParts = [
        model ? t(inheritedModel ? "companion.agents.modelParent" : "agent.modelTitle", { model }) : "",
        effort ? t(inheritedEffort ? "companion.agents.effortParent" : "agent.effortTitle", { effort }) : "",
        sub.branch ? t("companion.branch", { branch: sub.branch }) : "",
    ].filter((s) => !!s);
    return {
        id: sub.id,
        main: false,
        name: sub.description || sub.kind || t("companion.agents.subagent"),
        state: "running",
        stateLabel: t("companion.agents.running"),
        config: configLabel(modelName, effort, inheritedEffort),
        configTitle: titleParts.join("\n"),
        lines: what.length > 0 ? [what.join(" · ")] : [],
        background: sub.background,
        waiting: sub.waiting === true,
        job: jobsView(t, sub.jobs) ?? undefined,
        branch: sub.branch || undefined,
        ...ticketFacts(sub.ticket, sub.complexity, model, effort),
    };
}

export type AgentsView = { rows: AgentRow[]; finished: number; failed: number };

// The most levels of sub-agents' sub-agents drawn under each other (pkg/molten/companion/topics.go maxSubagentDepth).
const MaxNestDepth = 8;

// Each sub-agent's own sub-agents right under it (#2587), in the order given, with their depth; the others keep their
// place. A sub-agent whose parent is not at work, or a loop in the records, stays at the first level.
export function nestRows(subs: CompanionSubagent[], rows: AgentRow[]): AgentRow[] {
    const byId = new Map((subs ?? []).map((s) => [s.id, s]));
    const rowOfAgent = new Map<string, AgentRow>();
    for (const row of rows) {
        const agentId = byId.get(row.id)?.agentid;
        if (agentId) {
            rowOfAgent.set(agentId, row);
        }
    }
    const children = new Map<string, AgentRow[]>();
    const roots: AgentRow[] = [];
    for (const row of rows) {
        const parentId = byId.get(row.id)?.parentid;
        const parent = parentId ? rowOfAgent.get(parentId) : null;
        if (parent == null || parent === row) {
            roots.push(row);
            continue;
        }
        children.set(parent.id, [...(children.get(parent.id) ?? []), row]);
    }
    const out: AgentRow[] = [];
    const seen = new Set<string>();
    const visit = (row: AgentRow, depth: number) => {
        if (seen.has(row.id)) {
            return;
        }
        seen.add(row.id);
        out.push(depth > 0 ? { ...row, depth } : row);
        for (const child of children.get(row.id) ?? []) {
            visit(child, Math.min(depth + 1, MaxNestDepth));
        }
    };
    roots.forEach((row) => visit(row, 0));
    for (const row of rows) {
        if (!seen.has(row.id)) {
            seen.add(row.id);
            out.push(row);
        }
    }
    return out;
}

// The agents at work: the main session first, then the sub-agents it started that still run, the ones that wait on
// their own work first (#2502), then the newest first, each with its own sub-agents under it (#2587); those that ended
// are counted.
export function agentsView(view: CompanionView, agentState: AgentStateInfo, now: number): AgentsView {
    const subs = view?.subagents ?? [];
    const parent = mainModelEffort(view, agentState);
    const sorted = subs
        .filter((s) => stillRunning(s, view, agentState))
        .sort((a, b) => Number(b.waiting === true) - Number(a.waiting === true) || (b.started ?? 0) - (a.started ?? 0));
    const running = nestRows(
        sorted,
        sorted.map((s) => subagentRow(s, now, parent))
    );
    // The main session reads as working in the background while its sub-agents work, not as finished above them (#2294).
    return {
        rows: [mainAgentRow(view, stateWithSubagents(agentState, running.length)), ...running],
        finished: subs.filter((s) => s.state === "done").length,
        failed: subs.filter((s) => s.state === "failed").length,
    };
}

// The most finished sub-agents the quiet line lists when it is opened.
export const MaxFinishedRows = 12;

// The sub-agents that finished or failed, the last to end first: what "N finished · see" opens (#2502).
export function finishedSubagents(view: CompanionView): CompanionSubagent[] {
    return (view?.subagents ?? [])
        .filter((s) => s.state === "done" || s.state === "failed")
        .sort((a, b) => (b.ended ?? b.started ?? 0) - (a.ended ?? a.started ?? 0))
        .slice(0, MaxFinishedRows);
}

export function finishedLabel(finished: number, failed: number): string {
    return [
        finished > 0 ? t("companion.agents.finished", { count: finished }) : "",
        failed > 0 ? t("companion.agents.failed", { count: failed }) : "",
    ]
        .filter((s) => !!s)
        .join(" · ");
}
