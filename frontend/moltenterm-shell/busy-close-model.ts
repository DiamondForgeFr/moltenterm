// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a close would stop (FR-SHELL-061, DS-SHELL-106): a close that stops something running in a terminal asks first,
// so a coding agent or a command is never stopped by accident. The rule only reads signals MoltenTerm already has: the
// controller status, the shell integration's runtime info (as the update dialog's terminal summary does) and the agent
// states. Kept apart from the store and the dialog so the rule can be tested without the app.

import { AgentStateInfo, agentStateLabel, AgentStateName } from "./agent-state-model";

export type BusyCloseAction = "pane" | "replace" | "tab";

// What one terminal block says of itself. Unknown fields stay null: a read that failed counts as no signal.
export type RunningSource = {
    blockId: string;
    view?: string;
    controller?: string;
    // The block's own command (controller cmd).
    cmd?: string;
    // The controller status's shellprocstatus: running, done, init.
    procStatus?: string;
    integration?: boolean;
    // shell:state: ready (at its prompt) or running-command.
    shellState?: string;
    lastCmd?: string;
    agent?: AgentStateInfo;
    workspace?: string;
    tab?: string;
};

export type RunningItem = {
    blockId: string;
    kind: "agent" | "command";
    // The agent's name, or the command line.
    label: string;
    state?: AgentStateName;
    workspace?: string;
    tab?: string;
};

export const MaxRunningRows = 8;

const AnyCommand = "a command";

// Stopping a working agent loses its turn, a waiting one what it asked: the riskiest come first.
const AgentRisk: Record<string, number> = { working: 0, waiting: 1, done: 2, idle: 3, error: 4 };

function agentItem(src: RunningSource): RunningItem {
    const agent = src.agent;
    return {
        blockId: src.blockId,
        kind: "agent",
        label: agent.agentname || agent.agent || "An agent",
        state: agent.state ?? "idle",
        workspace: src.workspace,
        tab: src.tab,
    };
}

function commandItem(src: RunningSource, command: string): RunningItem {
    return {
        blockId: src.blockId,
        kind: "command",
        label: (command ?? "").trim() || AnyCommand,
        workspace: src.workspace,
        tab: src.tab,
    };
}

// The shell integration is authoritative when the terminal has it: at its prompt nothing runs, whatever an agent
// state says. Without it, an agent state (an agent started before the integration, or as a block's own command) and a
// block's own command are the only signals; a terminal with neither never asks (no false prompt).
export function runningInTerminal(src: RunningSource): RunningItem {
    if (src == null || src.view !== "term") {
        return null;
    }
    if (src.procStatus != null && src.procStatus !== "" && src.procStatus !== "running") {
        return null;
    }
    const atPrompt = !!src.integration && src.shellState === "ready";
    if (atPrompt) {
        return null;
    }
    const runningCommand = !!src.integration && src.shellState === "running-command";
    const ownCommand = src.controller === "cmd";
    const agent = src.agent;
    // An error state outlives the agent that exited with it: it only counts while a command still runs.
    if (agent?.state != null && (agent.state !== "error" || runningCommand || ownCommand)) {
        return agentItem(src);
    }
    if (runningCommand) {
        return commandItem(src, src.lastCmd);
    }
    if (ownCommand) {
        return commandItem(src, src.cmd);
    }
    return null;
}

// Agents first, by risk, then commands; the sources' order (the tab's) otherwise.
export function sortRunning(items: RunningItem[]): RunningItem[] {
    const rank = (item: RunningItem) => (item.kind === "agent" ? (AgentRisk[item.state] ?? 4) : 10);
    return (items ?? [])
        .map((item, index) => ({ item, index }))
        .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
        .map((e) => e.item);
}

export function runningOf(sources: RunningSource[]): RunningItem[] {
    return sortRunning((sources ?? []).map(runningInTerminal).filter((item) => item != null));
}

export function visibleRunning(items: RunningItem[], max = MaxRunningRows): { shown: RunningItem[]; more: number } {
    const list = items ?? [];
    if (list.length <= max) {
        return { shown: list, more: 0 };
    }
    return { shown: list.slice(0, max), more: list.length - max };
}

export function runningStateText(item: RunningItem): string {
    if (item.kind === "command") {
        return "running";
    }
    return agentStateLabel(item.state);
}

export function runningPlace(item: RunningItem): string {
    return [item.workspace, item.tab].filter((s) => !!s).join(" · ");
}

export type BusyCloseText = { title: string; subtitle: string; confirm: string };

export function busyCloseText(action: BusyCloseAction, tabName?: string): BusyCloseText {
    if (action === "replace") {
        return {
            title: "Replace this terminal?",
            subtitle: "Replacing it stops what runs in it.",
            confirm: "Replace anyway",
        };
    }
    if (action === "tab") {
        const title = tabName ? `Close the tab “${tabName}”?` : "Close this tab?";
        return { title, subtitle: "Closing it stops what runs in its terminals.", confirm: "Close anyway" };
    }
    return { title: "Close this terminal?", subtitle: "Closing it stops what runs in it.", confirm: "Close anyway" };
}
