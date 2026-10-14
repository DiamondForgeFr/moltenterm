// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The companion's recap (#555): the recent topics of the session and the agents at work, from what wavesrv read of
// the transcript (pkg/molten/companion/topics.go) and the pane's agent state. Nothing here is written by a model: a
// line the data cannot support is left out. Pure, so it is tested without a window.

import { agentLabel, AgentStateInfo, agentStateLabel } from "../agent-state-model";
import { CompanionSubagent, CompanionTopic, CompanionView, relativeTime } from "./companion-model";
import { modelDisplayName, ProportionHint, proportionHint } from "./companion-proportion";

// The branch naming of the workflow (feature/{N}-…, fix/{N}-…): the number is the ticket.
const BranchTicketRegex = /^(?:feature|fix)\/(\d+)(?:-|$)/;
const MaxWorkLines = 3;

export function branchTicket(branch: string): string {
    const m = BranchTicketRegex.exec(branch ?? "");
    return m == null ? "" : `#${m[1]}`;
}

export type TopicRow = { key: string; text: string; facts: string[]; title: string };

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Each topic is the user's own prompt; its facts are the ticket of its branch, the files it changed, the PRs it
// opened and when it was last worked on.
export function topicRows(topics: CompanionTopic[], now: number): TopicRow[] {
    return (topics ?? []).map((t, i) => {
        const ticket = branchTicket(t.branch);
        const facts = [
            ticket,
            t.files > 0 ? plural(t.files, "file") : "",
            ...(t.prs ?? []).map((pr) => `PR #${pr.number}`),
            relativeTime(t.last || t.at, now),
        ].filter((s) => !!s);
        return {
            key: `${t.at ?? 0}:${i}`,
            text: t.text,
            facts,
            title: [t.text, t.branch ? `Branch: ${t.branch}` : ""].filter((s) => !!s).join("\n"),
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
    portrait?: string;
    capabilities?: string[];
};

function activityLine(view: CompanionView): string {
    const a = view.activity;
    if (a == null || !a.tool) {
        return "";
    }
    return a.target ? `Now: ${a.tool} · ${a.target}` : `Now: ${a.tool}`;
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
    return inherited ? `${modelName} · ${effort} (inherited)` : `${modelName} · ${effort}`;
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
    const task = (view?.todos ?? []).find((t) => t.status === "in_progress");
    if (task) {
        lines.push(`Task: ${task.text}`);
    }
    const topic = view?.topics?.[0];
    if (topic && !task) {
        lines.push(`Topic: ${topic.text}`);
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
        state,
        stateLabel: ended ? "exited" : agentStateLabel(state),
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
    if (sub.background) {
        return true;
    }
    const state = agentState?.state;
    return state === "working" || state === "waiting";
}

// A sub-agent's model and effort: its own, else its parent's, marked inherited (#601).
export function subagentRow(sub: CompanionSubagent, now: number, parent?: ModelEffort): AgentRow {
    const started = relativeTime(sub.started, now);
    const what = [sub.kind, sub.background ? "background" : "", started ? `started ${started}` : ""].filter((s) => !!s);
    const ownModel = modelDisplayName(sub.model) ? (sub.model ?? "").trim() : "";
    const model = ownModel || parent?.model || "";
    const modelName = ownModel ? modelDisplayName(ownModel) : parent?.modelName || "";
    const ownEffort = (sub.effort ?? "").trim();
    const effort = ownEffort || parent?.effort || "";
    const inheritedModel = !ownModel && !!modelName;
    const inheritedEffort = !ownEffort && !!effort;
    const titleParts = [
        model ? `Model: ${model}${inheritedModel ? " (its parent's)" : ""}` : "",
        effort ? `Effort: ${effort}${inheritedEffort ? " (its parent's)" : ""}` : "",
        sub.branch ? `Branch: ${sub.branch}` : "",
    ].filter((s) => !!s);
    return {
        id: sub.id,
        main: false,
        name: sub.description || sub.kind || "Sub-agent",
        state: "running",
        stateLabel: "running",
        config: configLabel(modelName, effort, inheritedEffort),
        configTitle: titleParts.join("\n"),
        lines: what.length > 0 ? [what.join(" · ")] : [],
        background: sub.background,
        ...ticketFacts(sub.ticket, sub.complexity, model, effort),
    };
}

export type AgentsView = { rows: AgentRow[]; finished: number; failed: number };

// The agents at work: the main session first, then the sub-agents it started that still run, newest first; those
// that ended are counted.
export function agentsView(view: CompanionView, agentState: AgentStateInfo, now: number): AgentsView {
    const subs = view?.subagents ?? [];
    const parent = mainModelEffort(view, agentState);
    const running = subs
        .filter((s) => stillRunning(s, view, agentState))
        .sort((a, b) => (b.started ?? 0) - (a.started ?? 0))
        .map((s) => subagentRow(s, now, parent));
    return {
        rows: [mainAgentRow(view, agentState), ...running],
        finished: subs.filter((s) => s.state === "done").length,
        failed: subs.filter((s) => s.state === "failed").length,
    };
}

export function finishedLabel(finished: number, failed: number): string {
    return [finished > 0 ? `${finished} finished` : "", failed > 0 ? `${failed} failed` : ""]
        .filter((s) => !!s)
        .join(" · ");
}
