// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Agent section of the command panel (FR-SHELL-048, DS-SHELL-088): the commands of the coding agent running in a
// terminal, typed by wavesrv's guarded moltenagentinput (pkg/molten/termupdate/agentinput.go), and what the panel
// says when a command is refused. wavesrv holds the authoritative tables and checks every action against them; this
// copy gives the labels and the order. Nothing is greyed out: a refusal explains itself.

import { AgentStateInfo, agentStateLabel } from "../agent-state-model";
import {
    PanelActionResult,
    PanelChoice,
    PanelChoiceOption,
    PanelItem,
    PanelSection,
    PanelSuggestion,
} from "./panel-types";

// must match pkg/molten/termupdate/agentinput.go
export const AgentInputRoute = "molten:termupdate";
export const AgentInputCommand = "moltenagentinput";
export const AgentInputInfoCommand = "moltenagentinputinfo";

export type AgentInputRequest = {
    blockid: string;
    agent: string;
    action: string;
    mode?: string;
    confirmeddraft?: boolean;
};

export type AgentInputReason =
    | "working"
    | "waiting"
    | "notforeground"
    | "draft"
    | "unknownaction"
    | "noagent"
    | "busy"
    | "unavailable";

export type AgentInputResult = {
    result: "sent" | "refused";
    reason?: AgentInputReason;
    offer?: "interrupt" | "goto";
    message: string;
    agent?: string;
    agentname?: string;
    program?: string;
    mode?: string;
    presses?: number;
};

export type AgentInputInfo = {
    blockid: string;
    agent?: string;
    mode?: string;
    modes?: string[];
    draft?: boolean;
};

// must match pkg/molten/agentcontinuity/commands.go
export const PermissionModeAction = "permissionmode";
export const InterruptAction = "interrupt";

export type AgentCommandDef = {
    action: string;
    label: string;
    icon: string;
    // What is typed, shown in mono on the right.
    command: string;
    keywords?: string[];
};

const Interrupt: AgentCommandDef = {
    action: InterruptAction,
    label: "Interrupt",
    icon: "hand",
    command: "Esc",
    keywords: ["stop", "cancel", "escape"],
};

export const ClaudeCommands: AgentCommandDef[] = [
    { action: "clear", label: "New conversation", icon: "plus", command: "/clear", keywords: ["clear", "reset"] },
    { action: "compact", label: "Compact", icon: "compress", command: "/compact", keywords: ["summarize", "context"] },
    { action: "model", label: "Model", icon: "microchip", command: "/model" },
    { action: "resume", label: "Resume", icon: "clock-rotate-left", command: "/resume", keywords: ["session"] },
    { action: "copy", label: "Copy last answer", icon: "copy", command: "/copy", keywords: ["response"] },
    { action: "status", label: "Status", icon: "circle-info", command: "/status" },
    { action: "review", label: "Review", icon: "code-pull-request", command: "/review", keywords: ["pull request"] },
    Interrupt,
    { action: "quit", label: "Quit", icon: "right-from-bracket", command: "/exit", keywords: ["exit"] },
];

export const CodexCommands: AgentCommandDef[] = [
    {
        action: "approvals",
        label: "Approvals",
        icon: "shield-halved",
        command: "/approvals",
        keywords: ["permissions", "sandbox"],
    },
    { action: "new", label: "New conversation", icon: "plus", command: "/new", keywords: ["clear", "reset"] },
    { action: "compact", label: "Compact", icon: "compress", command: "/compact", keywords: ["summarize", "context"] },
    { action: "model", label: "Model", icon: "microchip", command: "/model" },
    { action: "status", label: "Status", icon: "circle-info", command: "/status" },
    { action: "diff", label: "Diff", icon: "code-compare", command: "/diff", keywords: ["changes"] },
    Interrupt,
    { action: "quit", label: "Quit", icon: "right-from-bracket", command: "/exit", keywords: ["exit"] },
];

const Tables: Record<string, { commands: AgentCommandDef[]; modes: boolean }> = {
    claude: { commands: ClaudeCommands, modes: true },
    codex: { commands: CodexCommands, modes: false },
};

export function agentCommandTable(agent: string): AgentCommandDef[] {
    return Tables[agent]?.commands ?? null;
}

export function hasAgentCommands(agent: AgentStateInfo): boolean {
    return agent?.agent != null && Tables[agent.agent] != null;
}

// Claude Code's permission modes in its Shift+Tab order; the last two show only once the agent drew them (they
// depend on how it was started).
export const PermissionModes: { id: string; label: string; optional?: boolean }[] = [
    { id: "default", label: "Default" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan" },
    { id: "auto", label: "Auto", optional: true },
    { id: "bypassPermissions", label: "Bypass permissions", optional: true },
];

export function permissionModeLabel(mode: string): string {
    return PermissionModes.find((m) => m.id === mode)?.label ?? mode ?? "";
}

export function agentName(agent: AgentStateInfo): string {
    return agent?.agentname || agent?.agent || "Agent";
}

// What the section's commands do; the provider binds them to wavesrv.
export type AgentCommandHandlers = {
    run: (action: string) => Promise<PanelActionResult>;
    setMode: (mode: string) => Promise<PanelActionResult>;
};

export function permissionModeItem(info: AgentInputInfo, handlers: AgentCommandHandlers): PanelChoice {
    const current = info?.mode ?? "";
    const seen = new Set(info?.modes ?? []);
    let options: PanelChoiceOption[];
    if (current === "") {
        // The mode was never drawn in this run: each press moves to the next mode (FR-SHELL-048-AC3).
        options = [
            {
                id: "mode:next",
                label: "Next mode",
                detail: "Shift+Tab",
                checked: false,
                run: () => handlers.setMode(""),
            },
        ];
    } else {
        options = PermissionModes.filter((m) => !m.optional || seen.has(m.id) || m.id === current).map((m) => ({
            id: `mode:${m.id}`,
            label: m.label,
            checked: m.id === current,
            run: () => handlers.setMode(m.id),
        }));
    }
    return {
        id: "agent:permissionmode",
        type: "choice",
        label: "Permission mode",
        icon: "shield-halved",
        keywords: ["plan", "accept edits", "shift+tab", "auto"],
        awaitResult: true,
        options,
    };
}

export function agentSection(
    agent: AgentStateInfo,
    info: AgentInputInfo,
    handlers: AgentCommandHandlers
): PanelSection {
    const table = Tables[agent?.agent];
    if (table == null) {
        return null;
    }
    const items: PanelItem[] = [];
    if (table.modes) {
        items.push(permissionModeItem(info, handlers));
    }
    for (const def of table.commands) {
        items.push({
            id: `agent:${def.action}`,
            type: "action",
            label: def.label,
            icon: def.icon,
            shortcut: def.command,
            keywords: [def.command, ...(def.keywords ?? [])],
            awaitResult: true,
            run: () => handlers.run(def.action),
        });
    }
    const state = agent.state && agent.state !== "idle" ? agentStateLabel(agent.state) : null;
    return {
        id: "agent",
        kind: "agent",
        title: `Agent · ${agentName(agent)}`,
        state,
        stateTone: agent.state === "waiting" || agent.state === "error" ? "warning" : "muted",
        items,
    };
}

// A waiting agent's question, with Go, which closes the panel and focuses the terminal (FR-SHELL-048-AC8).
export function agentSuggestions(agent: AgentStateInfo): PanelSuggestion[] {
    if (!hasAgentCommands(agent) || agent.state !== "waiting") {
        return [];
    }
    const question = (agent.message ?? "").trim() || `${agentName(agent)} is waiting for your answer`;
    return [
        {
            id: "agent:question",
            label: question,
            icon: "circle-question",
            tone: "warning",
            action: "Go",
            run: () => {},
        },
    ];
}

export type FeedbackHandlers = {
    interrupt: () => Promise<PanelActionResult>;
    confirmDraft: () => Promise<PanelActionResult>;
};

// What the panel does with wavesrv's answer: close on a command sent, or say why nothing was typed and offer what
// fits (FR-SHELL-048-AC4, AC5, AC6).
export function feedbackFor(
    result: AgentInputResult,
    action: string,
    handlers: FeedbackHandlers,
    opts?: { mode?: string }
): PanelActionResult {
    if (result == null) {
        return {
            id: "agent:error",
            tone: "danger",
            role: "alert",
            message: "MoltenTerm could not reach the terminal.",
        };
    }
    if (result.result === "sent") {
        if (action !== PermissionModeAction) {
            return "close";
        }
        if (opts?.mode && result.mode === opts.mode) {
            return "close";
        }
        // One press with the mode unseen, or a target not reached: the panel stays on the modes with the outcome.
        return { id: "agent:mode", tone: "muted", role: "alert", message: result.message };
    }
    switch (result.reason) {
        case "working":
            return {
                id: "agent:working",
                tone: "warning",
                role: "alert",
                message: result.message,
                actions: [{ id: "interrupt", label: "Interrupt", primary: true, run: handlers.interrupt }],
            };
        case "waiting":
            return {
                id: "agent:waiting",
                tone: "warning",
                role: "alert",
                message: result.message,
                actions: [{ id: "goto", label: "Go to the question", primary: true, run: () => "close" }],
            };
        case "draft":
            return {
                id: "agent:draft",
                tone: "warning",
                role: "alertdialog",
                message: result.message,
                actions: [
                    { id: "cancel", label: "Cancel", run: () => "dismiss" },
                    { id: "confirm", label: "Clear and send", primary: true, run: handlers.confirmDraft },
                ],
            };
        default:
            return {
                id: `agent:${result.reason ?? "refused"}`,
                tone: "danger",
                role: "alert",
                message: result.message,
            };
    }
}
